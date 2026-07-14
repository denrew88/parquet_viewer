#[path = "../../../src-tauri/src/data/mod.rs"]
mod data;
#[path = "../../../src-tauri/src/domain/mod.rs"]
mod domain;
#[path = "../../../src-tauri/src/platform/session.rs"]
mod session;

use data::DataSource;
use serde::Serialize;
use session::{DocumentRegistry, PageCacheKey, ReservePath};
use std::{
    env,
    path::{Path, PathBuf},
    process,
    time::Instant,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    iteration: usize,
    open_ms: f64,
    first_page_ms: f64,
    cached_page_ms: f64,
    random_page_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSnapshot {
    working_set_bytes: Option<u64>,
    handle_count: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkResult {
    schema_version: u32,
    command: &'static str,
    fixture_name: String,
    fixture_bytes: u64,
    declared_rows: u64,
    runs: usize,
    samples: Vec<Sample>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoakIteration {
    iteration: usize,
    fixture_name: String,
    elapsed_ms: f64,
    resource: ResourceSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoakResult {
    schema_version: u32,
    command: &'static str,
    iterations: usize,
    successful_iterations: usize,
    failures: Vec<String>,
    start_resource: ResourceSnapshot,
    end_resource: ResourceSnapshot,
    samples: Vec<SoakIteration>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    path_name: String,
    outcome: &'static str,
    error_code: Option<String>,
    message: Option<String>,
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn benchmark(path: &Path, declared_rows: u64, runs: usize) -> Result<BenchmarkResult, String> {
    if runs == 0 {
        return Err("runs must be at least one".to_owned());
    }
    let mut samples = Vec::with_capacity(runs);
    for iteration in 1..=runs {
        let started = Instant::now();
        let source = DataSource::open(path).map_err(|error| error.to_string())?;
        let open_ms = elapsed_ms(started);

        let registry = DocumentRegistry::default();
        let reservation = match registry
            .reserve_path(path.to_string_lossy().into_owned())
            .map_err(|error| format!("{error:?}"))?
        {
            ReservePath::Reserved(reservation) => reservation,
            ReservePath::Existing(_) => return Err("unexpected existing document".to_owned()),
        };
        let first_key = PageCacheKey::new(0, 200, None);
        let started = Instant::now();
        let first_page = source
            .read_page_projected(0, 200, None)
            .map_err(|error| format!("{error:?}"))?;
        let first_page_ms = elapsed_ms(started);
        let (document_id, session_id) = registry
            .commit(reservation, source, first_key.clone(), first_page)
            .map_err(|error| format!("{error:?}"))?;

        let started = Instant::now();
        registry
            .get_or_load_page(&document_id, &session_id, first_key, |source| {
                source.read_page_projected(0, 200, None)
            })
            .map_err(|error| format!("{error:?}"))?
            .map_err(|error| error.to_string())?;
        let cached_page_ms = elapsed_ms(started);

        let random_offset = declared_rows.saturating_sub(200) / 2;
        let random_key = PageCacheKey::new(random_offset, 200, None);
        let started = Instant::now();
        registry
            .get_or_load_page(&document_id, &session_id, random_key, |source| {
                source.read_page_projected(random_offset, 200, None)
            })
            .map_err(|error| format!("{error:?}"))?
            .map_err(|error| format!("{error:?}"))?;
        let random_page_ms = elapsed_ms(started);
        registry
            .close(&document_id, &session_id)
            .map_err(|error| format!("{error:?}"))?;

        samples.push(Sample {
            iteration,
            open_ms,
            first_page_ms,
            cached_page_ms,
            random_page_ms,
        });
    }

    Ok(BenchmarkResult {
        schema_version: 1,
        command: "benchmark",
        fixture_name: file_name(path),
        fixture_bytes: path.metadata().map_err(|error| error.to_string())?.len(),
        declared_rows,
        runs,
        samples,
    })
}

fn soak(paths: &[PathBuf], iterations: usize) -> Result<SoakResult, String> {
    if paths.is_empty() || iterations == 0 {
        return Err("soak requires at least one fixture and iteration".to_owned());
    }
    let start_resource = resource_snapshot();
    let registry = DocumentRegistry::default();
    let mut active_id: Option<(String, String)> = None;
    let mut failures = Vec::new();
    let mut samples = Vec::with_capacity(iterations);

    for iteration in 1..=iterations {
        let path = &paths[(iteration - 1) % paths.len()];
        let started = Instant::now();
        let outcome = (|| -> Result<(), String> {
            let source = DataSource::open(path).map_err(|error| error.to_string())?;
            let key = PageCacheKey::new(0, 200, None);
            let first_page = source
                .read_page_projected(0, 200, None)
                .map_err(|error| error.to_string())?;
            let reservation = match registry
                .reserve_path(path.to_string_lossy().into_owned())
                .map_err(|error| format!("{error:?}"))?
            {
                ReservePath::Reserved(reservation) => reservation,
                ReservePath::Existing(_) => return Err("unexpected existing document".to_owned()),
            };
            let next_id = registry
                .commit(reservation, source, key, first_page)
                .map_err(|error| format!("{error:?}"))?;
            active_id = Some(next_id.clone());
            registry
                .close(&next_id.0, &next_id.1)
                .map_err(|error| format!("{error:?}"))?;
            active_id = None;
            Ok(())
        })();
        if let Err(error) = outcome {
            failures.push(format!("iteration {iteration}: {error}"));
            if let Some((document_id, session_id)) = active_id.take() {
                let _ = registry.close(&document_id, &session_id);
            }
        }
        samples.push(SoakIteration {
            iteration,
            fixture_name: file_name(path),
            elapsed_ms: elapsed_ms(started),
            resource: resource_snapshot(),
        });
    }

    Ok(SoakResult {
        schema_version: 1,
        command: "soak",
        iterations,
        successful_iterations: iterations.saturating_sub(failures.len()),
        failures,
        start_resource,
        end_resource: resource_snapshot(),
        samples,
    })
}

fn probe(path: &Path) -> ProbeResult {
    match std::panic::catch_unwind(|| DataSource::open(path)) {
        Ok(Ok(source)) => match source.read_page_projected(0, 200, None) {
            Ok(_) => ProbeResult {
                path_name: file_name(path),
                outcome: "accepted",
                error_code: None,
                message: None,
            },
            Err(error) => ProbeResult {
                path_name: file_name(path),
                outcome: "rejected",
                error_code: Some(format!("{:?}", error.code)),
                message: Some(error.message),
            },
        },
        Ok(Err(error)) => ProbeResult {
            path_name: file_name(path),
            outcome: "rejected",
            error_code: Some(format!("{:?}", error.code)),
            message: Some(error.message),
        },
        Err(_) => ProbeResult {
            path_name: file_name(path),
            outcome: "panic",
            error_code: None,
            message: Some("panic while opening hostile input".to_owned()),
        },
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("<non-utf8-name>")
        .to_owned()
}

#[cfg(windows)]
fn resource_snapshot() -> ResourceSnapshot {
    use std::{ffi::c_void, mem};

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetProcessHandleCount(process: *mut c_void, count: *mut u32) -> i32;
        fn K32GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    let mut counters: ProcessMemoryCounters = unsafe { mem::zeroed() };
    counters.cb = mem::size_of::<ProcessMemoryCounters>() as u32;
    let mut handles = 0_u32;
    let process = unsafe { GetCurrentProcess() };
    let memory_ok = unsafe {
        K32GetProcessMemoryInfo(process, &mut counters, mem::size_of_val(&counters) as u32)
    } != 0;
    let handles_ok = unsafe { GetProcessHandleCount(process, &mut handles) } != 0;
    ResourceSnapshot {
        working_set_bytes: memory_ok.then_some(counters.working_set_size as u64),
        handle_count: handles_ok.then_some(handles),
    }
}

#[cfg(not(windows))]
fn resource_snapshot() -> ResourceSnapshot {
    ResourceSnapshot {
        working_set_bytes: None,
        handle_count: None,
    }
}

fn usage() -> ! {
    eprintln!(
        "usage:\n  phase7-data-runner benchmark <path> <declared-rows> <runs>\n  phase7-data-runner soak <iterations> <path>...\n  phase7-data-runner probe <path>..."
    );
    process::exit(2)
}

fn parse_usize(value: Option<String>, label: &str) -> usize {
    value
        .unwrap_or_else(|| usage())
        .parse()
        .unwrap_or_else(|_| panic!("{label} must be an unsigned integer"))
}

fn parse_u64(value: Option<String>, label: &str) -> u64 {
    value
        .unwrap_or_else(|| usage())
        .parse()
        .unwrap_or_else(|_| panic!("{label} must be an unsigned integer"))
}

fn main() {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| usage());
    let result = match command.as_str() {
        "benchmark" => {
            let path = PathBuf::from(arguments.next().unwrap_or_else(|| usage()));
            let rows = parse_u64(arguments.next(), "declared rows");
            let runs = parse_usize(arguments.next(), "runs");
            benchmark(&path, rows, runs).and_then(|result| {
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())
            })
        }
        "soak" => {
            let iterations = parse_usize(arguments.next(), "iterations");
            let paths = arguments.map(PathBuf::from).collect::<Vec<_>>();
            soak(&paths, iterations).and_then(|result| {
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())
            })
        }
        "probe" => {
            let paths = arguments.map(PathBuf::from).collect::<Vec<_>>();
            if paths.is_empty() {
                usage();
            }
            serde_json::to_string_pretty(&paths.iter().map(|path| probe(path)).collect::<Vec<_>>())
                .map_err(|error| error.to_string())
        }
        _ => usage(),
    };

    match result {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("phase7 runner failed: {error}");
            process::exit(1);
        }
    }
}
