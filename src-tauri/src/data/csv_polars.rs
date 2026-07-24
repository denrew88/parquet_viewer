use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use polars::prelude::*;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::domain::{CsvParsingProfile, CsvTargetType, DataError};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);
const CELLS_PER_STATE_WORD: usize = 32;
const WORKER_MARKER: &str = "--data-viewer-internal-worker";
const WORKER_MODE: &str = "csv-prepare-v1";
const WORKER_REQUEST_FLAG: &str = "--request";
const WORKER_REQUEST_NAME: &str = "polars-worker-request.json";
const WORKER_RESULT_NAME: &str = "polars-worker-result.json";
const WORKER_RESULT_PARTIAL_NAME: &str = "polars-worker-result.json.partial";
const WORKER_PROTOCOL_VERSION: u32 = 1;
const PREPARED_PARTIAL_NAME: &str = "prepared.parquet.partial";
pub(super) const SOURCE_SNAPSHOT_NAME: &str = "polars-source.snapshot.csv";
const WORKER_JSON_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct PolarsWorkerRequest {
    schema_version: u32,
    nonce: String,
    source: PathBuf,
    staging_root: PathBuf,
    header_used: bool,
    profile: CsvParsingProfile,
    resolved_targets: Vec<CsvTargetType>,
    source_length: u64,
    source_modified_ns: u128,
    thread_limit: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct PolarsWorkerResult {
    schema_version: u32,
    nonce: String,
    source_length: u64,
    source_modified_ns: u128,
    output_bytes: u64,
    physical_columns: usize,
    thread_limit: usize,
}

pub(super) struct PolarsPreparedSinkSpec<'a> {
    pub source: &'a Path,
    pub output_partial: &'a Path,
    pub header_used: bool,
    pub resolved_targets: &'a [CsvTargetType],
    pub profile: &'a CsvParsingProfile,
}

/// Build the compact-v3 physical product. This is deliberately separate from
/// `collect_cancellable`: the Rust structure/state pass must finish before a
/// caller is allowed to start this sink, and a Polars failure must never fall
/// through to a second full Rust preparation scan.
pub(super) fn build_product_sink(spec: PolarsPreparedSinkSpec<'_>) -> Result<LazyFrame, DataError> {
    validate_product_shape(spec.resolved_targets, spec.profile)?;

    let mut schema = Schema::with_capacity(spec.profile.columns.len());
    // Source headers can be blank, duplicated, or inside the reserved `__dv_`
    // namespace. Parse positionally under private unique names instead of
    // exposing untrusted headers to Polars' expression namespace.
    for source_index in 0..spec.profile.columns.len() {
        schema.with_column(input_field(source_index).into(), DataType::String);
    }
    let source = spec.source.to_string_lossy();
    let output = spec.output_partial.to_string_lossy();
    let frame = LazyCsvReader::new(PlRefPath::new(source.as_ref()))
        .with_has_header(spec.header_used)
        .with_schema(Some(Arc::new(schema)))
        .with_cache(false)
        .with_missing_is_null(false)
        .with_low_memory(true)
        .finish()
        .map_err(polars_error)?
        .with_row_index("__dv_row_id", None);

    let expressions = product_expressions(spec.resolved_targets, spec.profile)?;
    let write_options = ParquetWriteOptions {
        compression: ParquetCompression::Zstd(None),
        row_group_size: Some(65_536),
        ..Default::default()
    };
    frame
        .select(expressions)
        .sink(
            SinkDestination::File {
                target: SinkTarget::Path(PlRefPath::new(output.as_ref())),
            },
            FileWriteFormat::Parquet(write_options.into()),
            UnifiedSinkArgs {
                mkdir: true,
                maintain_order: true,
                ..Default::default()
            },
        )
        .map_err(polars_error)
}

pub(super) fn run_product_worker(
    source: &Path,
    pinned_source: &File,
    staging_root: &Path,
    header_used: bool,
    profile: &CsvParsingProfile,
    resolved_targets: &[CsvTargetType],
    cancel: &AtomicBool,
) -> Result<(), DataError> {
    if cancel.load(Ordering::Acquire) {
        return Err(DataError::task_cancelled());
    }
    let staging_root =
        fs::canonicalize(staging_root).map_err(|error| DataError::io(staging_root, error))?;
    let output = staging_root.join(PREPARED_PARTIAL_NAME);
    let source_snapshot = staging_root.join(SOURCE_SNAPSHOT_NAME);
    let request_path = staging_root.join(WORKER_REQUEST_NAME);
    let result_path = staging_root.join(WORKER_RESULT_NAME);
    for path in [&output, &source_snapshot, &request_path, &result_path] {
        if path.exists() {
            return Err(DataError::query_failed(format!(
                "Polars worker staging output already exists: {}",
                path.display()
            )));
        }
    }
    let mut staging_guard = WorkerStagingGuard::new(staging_root.clone());
    create_pinned_source_snapshot(source, pinned_source, &source_snapshot)?;
    let (source_length, source_modified_ns) = source_fingerprint(&source_snapshot)?;
    let thread_limit = polars_worker_thread_limit();
    let request = PolarsWorkerRequest {
        schema_version: WORKER_PROTOCOL_VERSION,
        nonce: worker_nonce(),
        source: source_snapshot,
        staging_root: staging_root.clone(),
        header_used,
        profile: profile.clone(),
        resolved_targets: resolved_targets.to_vec(),
        source_length,
        source_modified_ns,
        thread_limit,
    };
    write_json_sync(&request_path, &request)?;
    let mut command = worker_command(&request_path, thread_limit)?;
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_worker_files(&staging_root);
            return Err(DataError::io(&request_path, error));
        }
    };
    let job = match WorkerJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_worker_files(&staging_root);
            return Err(error);
        }
    };
    let status = match wait_for_worker(&mut child, &job, cancel, &staging_root) {
        Ok(status) => status,
        Err(error) => {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            cleanup_worker_files(&staging_root);
            return Err(error);
        }
    };
    drop(job);
    if !status.success() {
        cleanup_worker_files(&staging_root);
        return Err(DataError::query_failed(format!(
            "Polars CSV worker exited with status {status}."
        )));
    }
    let result: PolarsWorkerResult = read_bounded_json(&result_path, "result")?;
    let current_fingerprint = source_fingerprint(source)?;
    let output_bytes = fs::metadata(&output)
        .map_err(|error| DataError::io(&output, error))?
        .len();
    let expected_columns = product_physical_column_names(resolved_targets, profile)?.len();
    if result.schema_version != WORKER_PROTOCOL_VERSION
        || result.nonce != request.nonce
        || (result.source_length, result.source_modified_ns) != current_fingerprint
        || current_fingerprint != (request.source_length, request.source_modified_ns)
        || result.output_bytes != output_bytes
        || result.physical_columns != expected_columns
        || result.thread_limit != request.thread_limit
    {
        cleanup_worker_files(&staging_root);
        return Err(DataError::query_failed(
            "Polars CSV worker result did not match its parent request.",
        ));
    }
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&result_path);
    staging_guard.preserve_output = true;
    Ok(())
}

pub(super) fn product_physical_column_names(
    resolved_targets: &[CsvTargetType],
    profile: &CsvParsingProfile,
) -> Result<Vec<String>, DataError> {
    validate_product_shape(resolved_targets, profile)?;
    let mut names = Vec::with_capacity(
        1 + profile.columns.len() + resolved_targets.len() + profile.columns.len().div_ceil(32),
    );
    names.push(String::from("__dv_row_id"));
    names.extend((0..profile.columns.len()).map(|index| format!("__dv_base_raw_{index}")));
    let mut visible_index = 0_usize;
    for source in &profile.columns {
        if source.target_type == CsvTargetType::Skip {
            continue;
        }
        let target = resolved_targets[visible_index];
        if target != CsvTargetType::Text || source.trim {
            names.push(format!("__dv_value_{}", source.source_index));
        }
        visible_index += 1;
    }
    names.extend(
        (0..profile.columns.len().div_ceil(CELLS_PER_STATE_WORD))
            .map(|word| format!("__dv_state_word_{word}")),
    );
    Ok(names)
}

fn product_expressions(
    resolved_targets: &[CsvTargetType],
    profile: &CsvParsingProfile,
) -> Result<Vec<Expr>, DataError> {
    let names = product_physical_column_names(resolved_targets, profile)?;
    let mut expressions = Vec::with_capacity(names.len());
    expressions.push(
        col("__dv_row_id")
            .cast(DataType::UInt64)
            .alias("__dv_row_id"),
    );
    for source in &profile.columns {
        expressions.push(
            col(input_field(source.source_index))
                .alias(format!("__dv_base_raw_{}", source.source_index)),
        );
    }

    let mut visible_index = 0_usize;
    for source in &profile.columns {
        if source.target_type == CsvTargetType::Skip {
            continue;
        }
        let target = resolved_targets[visible_index];
        if target != CsvTargetType::Text || source.trim {
            expressions.push(
                typed_value_expr(source.source_index, target)
                    .alias(format!("__dv_value_{}", source.source_index)),
            );
        }
        visible_index += 1;
    }

    for word in 0..profile.columns.len().div_ceil(CELLS_PER_STATE_WORD) {
        let mut packed = lit(0_u64);
        for lane in 0..CELLS_PER_STATE_WORD {
            let source_index = word * CELLS_PER_STATE_WORD + lane;
            let Some(source) = profile.columns.get(source_index) else {
                break;
            };
            let target = if source.target_type == CsvTargetType::Skip {
                CsvTargetType::Skip
            } else {
                let visible_index = profile.columns[..source_index]
                    .iter()
                    .filter(|column| column.target_type != CsvTargetType::Skip)
                    .count();
                resolved_targets[visible_index]
            };
            let lane_state = state_expr(source, target).cast(DataType::UInt64);
            packed = packed + lane_state * lit(1_u64 << (lane * 2));
        }
        expressions.push(packed.alias(format!("__dv_state_word_{word}")));
    }
    Ok(expressions)
}

fn typed_value_expr(source_index: usize, target: CsvTargetType) -> Expr {
    let raw = col(input_field(source_index));
    match target {
        CsvTargetType::Boolean => when(raw.clone().eq(lit("true")))
            .then(lit(true))
            .when(raw.clone().eq(lit("TRUE")))
            .then(lit(true))
            .when(raw.clone().eq(lit("1")))
            .then(lit(true))
            .when(raw.clone().eq(lit("false")))
            .then(lit(false))
            .when(raw.clone().eq(lit("FALSE")))
            .then(lit(false))
            .when(raw.eq(lit("0")))
            .then(lit(false))
            .otherwise(lit(NULL)),
        CsvTargetType::Int64 => raw.cast(DataType::Int64),
        CsvTargetType::UInt64 => raw.cast(DataType::UInt64),
        CsvTargetType::Float64 => raw.cast(DataType::Float64),
        CsvTargetType::Text | CsvTargetType::Decimal => raw,
        _ => lit(NULL),
    }
}

fn state_expr(profile: &crate::domain::CsvColumnProfile, target: CsvTargetType) -> Expr {
    let raw = col(input_field(profile.source_index));
    let empty = raw.clone().eq(lit(""));
    if target == CsvTargetType::Skip {
        return when(empty).then(lit(2_u64)).otherwise(lit(0_u64));
    }
    let null_token = raw.clone().eq(lit("NULL")).or(raw.clone().eq(lit("N/A")));
    let invalid = match target {
        CsvTargetType::Text => lit(false),
        CsvTargetType::Boolean => raw
            .clone()
            .eq(lit("true"))
            .or(raw.clone().eq(lit("TRUE")))
            .or(raw.clone().eq(lit("1")))
            .or(raw.clone().eq(lit("false")))
            .or(raw.clone().eq(lit("FALSE")))
            .or(raw.clone().eq(lit("0")))
            .not(),
        CsvTargetType::Int64 | CsvTargetType::UInt64 | CsvTargetType::Float64 => {
            typed_value_expr(profile.source_index, target).is_null()
        }
        // Pass A admits Decimal only after exact lexical validation. The
        // worker preserves the original decimal string and therefore does not
        // perform a second, precision-losing numeric cast.
        CsvTargetType::Decimal => lit(false),
        _ => lit(true),
    };
    when(empty)
        .then(lit(2_u64))
        .when(null_token)
        .then(lit(1_u64))
        .when(invalid)
        .then(lit(3_u64))
        .otherwise(lit(0_u64))
}

fn input_field(source_index: usize) -> String {
    format!("__dv_input_{source_index}")
}

fn validate_product_shape(
    resolved_targets: &[CsvTargetType],
    profile: &CsvParsingProfile,
) -> Result<(), DataError> {
    if profile
        .columns
        .iter()
        .enumerate()
        .any(|(index, column)| column.source_index != index)
    {
        return Err(DataError::query_failed(
            "The Polars CSV profile source indexes are not contiguous.",
        ));
    }
    let visible = profile
        .columns
        .iter()
        .filter(|column| column.target_type != CsvTargetType::Skip)
        .count();
    if visible != resolved_targets.len() {
        return Err(DataError::query_failed(
            "The Polars CSV product shape does not match the visible schema.",
        ));
    }
    Ok(())
}

pub(crate) fn try_run_worker_from_args() -> bool {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let request_path = match parse_worker_arguments(&arguments) {
        Ok(None) => return false,
        Ok(Some(path)) => path,
        Err(()) => std::process::exit(64),
    };
    let exit_code = match run_worker_request(&request_path) {
        Ok(()) => 0,
        Err(_) => 70,
    };
    std::process::exit(exit_code);
}

fn parse_worker_arguments(arguments: &[std::ffi::OsString]) -> Result<Option<PathBuf>, ()> {
    if arguments.first().and_then(|value| value.to_str()) != Some(WORKER_MARKER) {
        return Ok(None);
    }
    if arguments.len() != 4
        || arguments.get(1).and_then(|value| value.to_str()) != Some(WORKER_MODE)
        || arguments.get(2).and_then(|value| value.to_str()) != Some(WORKER_REQUEST_FLAG)
    {
        return Err(());
    }
    let request = PathBuf::from(&arguments[3]);
    if !request.is_absolute() {
        return Err(());
    }
    Ok(Some(request))
}

fn run_worker_request(request_path: &Path) -> Result<(), DataError> {
    if !request_path.is_absolute() {
        return Err(DataError::query_failed(
            "Polars worker request path must be absolute.",
        ));
    }
    let request: PolarsWorkerRequest = read_bounded_json(request_path, "request")?;
    if request.schema_version != WORKER_PROTOCOL_VERSION {
        return Err(DataError::query_failed(
            "Unsupported Polars worker request schema version.",
        ));
    }
    if !request.source.is_absolute() || !request.staging_root.is_absolute() {
        return Err(DataError::query_failed(
            "Polars worker source and staging paths must be absolute.",
        ));
    }
    let environment_limit = std::env::var("POLARS_MAX_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok());
    if environment_limit != Some(request.thread_limit) || !(1..=8).contains(&request.thread_limit) {
        return Err(DataError::query_failed(
            "Polars worker thread limit does not match its parent request.",
        ));
    }
    let staging_root = fs::canonicalize(&request.staging_root)
        .map_err(|error| DataError::io(&request.staging_root, error))?;
    let request_parent = fs::canonicalize(request_path.parent().unwrap_or(Path::new(".")))
        .map_err(|error| DataError::io(request_path, error))?;
    if staging_root != request_parent
        || request_path.file_name() != Some(WORKER_REQUEST_NAME.as_ref())
    {
        return Err(DataError::query_failed(
            "Polars worker request is outside its assigned staging root.",
        ));
    }
    let source = canonical_worker_source(&request.source, &staging_root)?;
    let output = staging_root.join(PREPARED_PARTIAL_NAME);
    let result = staging_root.join(WORKER_RESULT_NAME);
    let result_partial = staging_root.join(WORKER_RESULT_PARTIAL_NAME);
    if output.exists() || result.exists() || result_partial.exists() {
        return Err(DataError::query_failed(
            "Polars worker staging outputs must not exist before start.",
        ));
    }
    let start_fingerprint = source_fingerprint(&source)?;
    if start_fingerprint != (request.source_length, request.source_modified_ns) {
        return Err(DataError::query_failed(
            "CSV source changed before the Polars worker started.",
        ));
    }
    let sink = build_product_sink(PolarsPreparedSinkSpec {
        source: &source,
        output_partial: &output,
        header_used: request.header_used,
        resolved_targets: &request.resolved_targets,
        profile: &request.profile,
    })?;
    sink.collect().map_err(polars_error)?;
    let end_fingerprint = source_fingerprint(&source)?;
    if end_fingerprint != start_fingerprint {
        let _ = fs::remove_file(&output);
        return Err(DataError::query_failed(
            "CSV source changed while the Polars worker was reading it.",
        ));
    }
    let output_bytes = fs::metadata(&output)
        .map_err(|error| DataError::io(&output, error))?
        .len();
    let result_body = PolarsWorkerResult {
        schema_version: WORKER_PROTOCOL_VERSION,
        nonce: request.nonce,
        source_length: end_fingerprint.0,
        source_modified_ns: end_fingerprint.1,
        output_bytes,
        physical_columns: product_physical_column_names(
            &request.resolved_targets,
            &request.profile,
        )?
        .len(),
        thread_limit: request.thread_limit,
    };
    write_json_sync(&result_partial, &result_body)?;
    fs::rename(&result_partial, &result).map_err(|error| DataError::io(&result_partial, error))?;
    Ok(())
}

fn canonical_worker_source(source: &Path, staging_root: &Path) -> Result<PathBuf, DataError> {
    let canonical_source =
        fs::canonicalize(source).map_err(|error| DataError::io(source, error))?;
    let expected = staging_root.join(SOURCE_SNAPSHOT_NAME);
    let canonical_expected =
        fs::canonicalize(&expected).map_err(|error| DataError::io(&expected, error))?;
    if canonical_source != canonical_expected {
        return Err(DataError::query_failed(
            "Polars worker source is not its assigned pinned snapshot.",
        ));
    }
    Ok(canonical_source)
}

fn worker_command(request_path: &Path, thread_limit: usize) -> Result<Command, DataError> {
    let executable = std::env::current_exe().map_err(|error| {
        DataError::query_failed(format!("Cannot locate viewer executable: {error}"))
    })?;
    let mut command = Command::new(executable);
    #[cfg(not(test))]
    command.args([
        std::ffi::OsStr::new(WORKER_MARKER),
        std::ffi::OsStr::new(WORKER_MODE),
        std::ffi::OsStr::new(WORKER_REQUEST_FLAG),
        request_path.as_os_str(),
    ]);
    #[cfg(test)]
    command
        .args([
            "--exact",
            "data::csv_polars::tests::polars_worker_subprocess_entry",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("DV_POLARS_WORKER_TEST_REQUEST", request_path);
    command
        .env("POLARS_MAX_THREADS", thread_limit.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}

fn polars_worker_thread_limit() -> usize {
    clamp_polars_worker_threads(
        std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(1),
    )
}

fn clamp_polars_worker_threads(available: usize) -> usize {
    available.clamp(1, 8)
}

fn wait_for_worker(
    child: &mut Child,
    job: &WorkerJob,
    cancel: &AtomicBool,
    staging_root: &Path,
) -> Result<std::process::ExitStatus, DataError> {
    loop {
        if cancel.load(Ordering::Acquire) {
            job.terminate();
            let _ = child.kill();
            let waited = child.wait().map_err(|error| {
                DataError::query_failed(format!("Cannot reap Polars worker: {error}"))
            })?;
            let _ = waited;
            cleanup_worker_files(staging_root);
            return Err(DataError::task_cancelled());
        }
        if let Some(status) = child.try_wait().map_err(|error| {
            DataError::query_failed(format!("Cannot poll Polars worker: {error}"))
        })? {
            return Ok(status);
        }
        thread::sleep(CANCEL_POLL_INTERVAL);
    }
}

fn cleanup_worker_files(staging_root: &Path) {
    for name in [
        PREPARED_PARTIAL_NAME,
        SOURCE_SNAPSHOT_NAME,
        WORKER_REQUEST_NAME,
        WORKER_RESULT_NAME,
        WORKER_RESULT_PARTIAL_NAME,
    ] {
        let _ = fs::remove_file(staging_root.join(name));
    }
}

struct WorkerStagingGuard {
    root: PathBuf,
    preserve_output: bool,
}

impl WorkerStagingGuard {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            preserve_output: false,
        }
    }
}

impl Drop for WorkerStagingGuard {
    fn drop(&mut self) {
        for name in [
            SOURCE_SNAPSHOT_NAME,
            WORKER_REQUEST_NAME,
            WORKER_RESULT_NAME,
            WORKER_RESULT_PARTIAL_NAME,
        ] {
            let _ = fs::remove_file(self.root.join(name));
        }
        if !self.preserve_output {
            let _ = fs::remove_file(self.root.join(PREPARED_PARTIAL_NAME));
        }
    }
}

fn create_pinned_source_snapshot(
    source: &Path,
    pinned_source: &File,
    snapshot: &Path,
) -> Result<(), DataError> {
    fs::hard_link(source, snapshot).map_err(|error| {
        DataError::query_failed(format!(
            "Cannot create pinned CSV source snapshot {}: {error}",
            snapshot.display()
        ))
    })?;
    let snapshot_file = File::open(snapshot).map_err(|error| DataError::io(snapshot, error))?;
    let pinned_metadata = pinned_source
        .metadata()
        .map_err(|error| DataError::io(source, error))?;
    let snapshot_metadata = snapshot_file
        .metadata()
        .map_err(|error| DataError::io(snapshot, error))?;
    if file_identity(pinned_source)? != file_identity(&snapshot_file)?
        || pinned_metadata.len() != snapshot_metadata.len()
        || modified_ns(&pinned_metadata)? != modified_ns(&snapshot_metadata)?
    {
        return Err(DataError::query_failed(
            "Pinned CSV source handle does not match its hardlink snapshot.",
        ));
    }
    Ok(())
}

/// Confirms that this staging directory can host the pinned hardlink before
/// Pass A starts. Callers deliberately treat every failure as a Rust-provider
/// fallback so a cross-volume cache directory or restricted hardlink policy
/// cannot make otherwise-readable large CSV input fail.
pub(super) fn probe_pinned_source_snapshot(
    source: &Path,
    pinned_source: &File,
    staging_root: &Path,
) -> Result<(), DataError> {
    probe_pinned_source_snapshot_with(source, pinned_source, staging_root, |source, probe| {
        fs::hard_link(source, probe)
    })
}

fn probe_pinned_source_snapshot_with<F>(
    source: &Path,
    pinned_source: &File,
    staging_root: &Path,
    hard_link: F,
) -> Result<(), DataError>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let probe = staging_root.join(format!("polars-source.probe-{}.csv", worker_nonce()));
    let _guard = SnapshotProbeGuard(probe.clone());
    hard_link(source, &probe).map_err(|error| {
        DataError::query_failed(format!(
            "Cannot create pinned CSV source probe {}: {error}",
            probe.display()
        ))
    })?;
    let probe_file = File::open(&probe).map_err(|error| DataError::io(&probe, error))?;
    let pinned_metadata = pinned_source
        .metadata()
        .map_err(|error| DataError::io(source, error))?;
    let probe_metadata = probe_file
        .metadata()
        .map_err(|error| DataError::io(&probe, error))?;
    if file_identity(pinned_source)? != file_identity(&probe_file)?
        || pinned_metadata.len() != probe_metadata.len()
        || modified_ns(&pinned_metadata)? != modified_ns(&probe_metadata)?
    {
        return Err(DataError::query_failed(
            "Pinned CSV source handle does not match its hardlink probe.",
        ));
    }
    Ok(())
}

struct SnapshotProbeGuard(PathBuf);

impl Drop for SnapshotProbeGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<(u64, u64), DataError> {
    use std::os::windows::io::AsRawHandle;
    let mut information: ByHandleFileInformation = unsafe { std::mem::zeroed() };
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if succeeded == 0 {
        return Err(DataError::query_failed(
            "CSV source file identity is unavailable.",
        ));
    }
    Ok((
        u64::from(information.volume_serial_number),
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low),
    ))
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<(u64, u64), DataError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|error| {
        DataError::query_failed(format!("CSV source identity is unavailable: {error}"))
    })?;
    Ok((metadata.dev(), metadata.ino()))
}

fn modified_ns(metadata: &fs::Metadata) -> Result<u128, DataError> {
    metadata
        .modified()
        .map_err(|error| {
            DataError::query_failed(format!("CSV modification time is unavailable: {error}"))
        })?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| DataError::query_failed(format!("Invalid CSV modification time: {error}")))
        .map(|duration| duration.as_nanos())
}

fn write_json_sync<T: Serialize>(path: &Path, value: &T) -> Result<(), DataError> {
    write_json_sync_with_limit(path, value, WORKER_JSON_MAX_BYTES)
}

fn write_json_sync_with_limit<T: Serialize>(
    path: &Path,
    value: &T,
    limit: u64,
) -> Result<(), DataError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        DataError::query_failed(format!("Cannot encode Polars worker JSON: {error}"))
    })?;
    if bytes.len() as u64 > limit {
        return Err(DataError::query_failed(format!(
            "Polars worker JSON exceeds the {limit} byte limit."
        )));
    }
    let mut file = File::create(path).map_err(|error| DataError::io(path, error))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| DataError::io(path, error))
}

fn read_bounded_json<T: DeserializeOwned>(path: &Path, kind: &str) -> Result<T, DataError> {
    read_bounded_json_with_limit(path, kind, WORKER_JSON_MAX_BYTES)
}

fn read_bounded_json_with_limit<T: DeserializeOwned>(
    path: &Path,
    kind: &str,
    limit: u64,
) -> Result<T, DataError> {
    let metadata = fs::metadata(path).map_err(|error| DataError::io(path, error))?;
    if metadata.len() > limit {
        return Err(DataError::query_failed(format!(
            "Polars worker {kind} JSON exceeds the {limit} byte limit."
        )));
    }
    let file = File::open(path).map_err(|error| DataError::io(path, error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| DataError::io(path, error))?;
    if bytes.len() as u64 > limit {
        return Err(DataError::query_failed(format!(
            "Polars worker {kind} JSON exceeded the {limit} byte limit while reading."
        )));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        DataError::query_failed(format!("Invalid Polars worker {kind} JSON: {error}"))
    })
}

fn source_fingerprint(path: &Path) -> Result<(u64, u128), DataError> {
    let metadata = fs::metadata(path).map_err(|error| DataError::io(path, error))?;
    let modified = metadata
        .modified()
        .map_err(|error| DataError::io(path, error))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            DataError::query_failed(format!("Invalid CSV modification time: {error}"))
        })?
        .as_nanos();
    Ok((metadata.len(), modified))
}

fn worker_nonce() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}-{now}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(not(windows))]
struct WorkerJob;

#[cfg(not(windows))]
impl WorkerJob {
    fn assign(_child: &Child) -> Result<Self, DataError> {
        Ok(Self)
    }
    fn terminate(&self) {}
}

#[cfg(windows)]
struct WorkerJob(*mut std::ffi::c_void);

#[cfg(windows)]
impl WorkerJob {
    fn assign(child: &Child) -> Result<Self, DataError> {
        use std::os::windows::io::AsRawHandle;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(DataError::query_failed(
                "Cannot create Polars worker job object.",
            ));
        }
        let mut limits: JobObjectExtendedLimitInformation = unsafe { std::mem::zeroed() };
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&limits as *const JobObjectExtendedLimitInformation).cast(),
                std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
            )
        };
        let assigned = configured != 0
            && unsafe { AssignProcessToJobObject(handle, child.as_raw_handle().cast()) } != 0;
        if !assigned {
            unsafe { CloseHandle(handle) };
            return Err(DataError::query_failed(
                "Cannot assign Polars worker to its kill-on-close job object.",
            ));
        }
        Ok(Self(handle))
    }

    fn terminate(&self) {
        unsafe { TerminateJobObject(self.0, 1) };
    }
}

#[cfg(windows)]
impl Drop for WorkerJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[repr(C)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(windows)]
#[repr(C)]
struct ByHandleFileInformation {
    file_attributes: u32,
    creation_time: FileTime,
    last_access_time: FileTime,
    last_write_time: FileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(
        attributes: *const std::ffi::c_void,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn SetInformationJobObject(
        job: *mut std::ffi::c_void,
        class: i32,
        info: *const std::ffi::c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
    fn TerminateJobObject(job: *mut std::ffi::c_void, exit_code: u32) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
}

fn polars_error(error: PolarsError) -> DataError {
    DataError::query_failed(format!("Polars CSV preparation failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CsvColumnProfile, CsvProfileMode};

    fn profile(targets: &[CsvTargetType]) -> CsvParsingProfile {
        CsvParsingProfile {
            mode: CsvProfileMode::Custom,
            generation: 1,
            columns: targets
                .iter()
                .enumerate()
                .map(|(index, target)| {
                    CsvColumnProfile::new(index, format!("source_{index}"), *target)
                })
                .collect(),
        }
    }

    #[test]
    fn compact_v3_names_include_every_raw_needed_value_and_state_word() {
        let mut targets = vec![CsvTargetType::Text; 3];
        targets.extend(std::iter::repeat_n(CsvTargetType::Int64, 12));
        let profile = profile(&targets);
        let names = product_physical_column_names(&targets, &profile).unwrap();
        assert_eq!(names.len(), 29);
        assert_eq!(names.first().map(String::as_str), Some("__dv_row_id"));
        assert!(names.contains(&String::from("__dv_base_raw_14")));
        assert!(!names.contains(&String::from("__dv_value_0")));
        assert!(!names.contains(&String::from("__dv_value_2")));
        assert!(names.contains(&String::from("__dv_value_14")));
        assert_eq!(names.last().map(String::as_str), Some("__dv_state_word_0"));
    }

    #[test]
    fn row_identity_expression_is_explicitly_uint64() {
        let profile = profile(&[CsvTargetType::Int64]);
        let expressions = product_expressions(&[CsvTargetType::Int64], &profile).unwrap();
        let debug = format!("{:?}", expressions[0]);
        assert!(
            debug.contains("UInt64"),
            "unexpected row-id expression: {debug}"
        );
    }

    #[test]
    fn cancellation_before_collection_starts_no_worker() {
        let cancel = AtomicBool::new(true);
        let profile = profile(&[CsvTargetType::Text]);
        let pinned = tempfile::tempfile().unwrap();
        let error = run_product_worker(
            Path::new("unused.csv"),
            &pinned,
            Path::new("unused-cache"),
            true,
            &profile,
            &[CsvTargetType::Text],
            &cancel,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::TaskCancelled);
    }

    #[test]
    fn internal_worker_arguments_are_strict_and_do_not_capture_file_operands() {
        assert_eq!(
            parse_worker_arguments(&[std::ffi::OsString::from("data.csv")]),
            Ok(None)
        );
        assert_eq!(
            parse_worker_arguments(&[
                WORKER_MARKER.into(),
                WORKER_MODE.into(),
                WORKER_REQUEST_FLAG.into(),
                std::ffi::OsString::from("relative.json"),
            ]),
            Err(())
        );
        let absolute = std::env::current_dir().unwrap().join("request.json");
        assert_eq!(
            parse_worker_arguments(&[
                WORKER_MARKER.into(),
                WORKER_MODE.into(),
                WORKER_REQUEST_FLAG.into(),
                absolute.clone().into_os_string(),
            ]),
            Ok(Some(absolute))
        );
    }

    #[test]
    fn worker_thread_limit_is_deterministically_clamped_to_eight() {
        assert_eq!(clamp_polars_worker_threads(0), 1);
        assert_eq!(clamp_polars_worker_threads(1), 1);
        assert_eq!(clamp_polars_worker_threads(4), 4);
        assert_eq!(clamp_polars_worker_threads(8), 8);
        assert_eq!(clamp_polars_worker_threads(16), 8);
    }

    #[test]
    fn worker_json_reader_rejects_oversize_files_before_decoding() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversize.json");
        std::fs::write(&path, vec![b' '; 33]).unwrap();
        let error =
            read_bounded_json_with_limit::<PolarsWorkerResult>(&path, "result", 32).unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::QueryFailed);
        assert!(error.message.contains("exceeds"));
    }

    #[test]
    fn worker_json_writer_rejects_oversize_before_creating_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversize.json");
        let error = write_json_sync_with_limit(&path, &"0123456789", 4).unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::QueryFailed);
        assert!(error.message.contains("exceeds"));
        assert!(!path.exists());
    }

    #[test]
    fn worker_json_reader_rejects_malformed_bounded_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("malformed.json");
        std::fs::write(&path, br#"{"nonce": "unterminated"#).unwrap();
        let error = read_bounded_json::<PolarsWorkerResult>(&path, "result").unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::QueryFailed);
        assert!(error.message.contains("Invalid Polars worker result JSON"));
    }

    #[test]
    fn hardlink_snapshot_keeps_pinned_content_after_same_fingerprint_path_replace() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.csv");
        let replacement = directory.path().join("replacement.csv");
        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(&source, b"AAAA").unwrap();
        let pinned = File::open(&source).unwrap();
        let modified = pinned.metadata().unwrap().modified().unwrap();
        let snapshot = staging.join(SOURCE_SNAPSHOT_NAME);
        let guard = WorkerStagingGuard::new(staging.clone());
        create_pinned_source_snapshot(&source, &pinned, &snapshot).unwrap();

        std::fs::write(&replacement, b"BBBB").unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        std::fs::remove_file(&source).unwrap();
        std::fs::rename(&replacement, &source).unwrap();

        assert_eq!(std::fs::read(&source).unwrap(), b"BBBB");
        assert_eq!(std::fs::read(&snapshot).unwrap(), b"AAAA");
        assert_eq!(
            source_fingerprint(&source).unwrap(),
            source_fingerprint(&snapshot).unwrap()
        );
        drop(guard);
        assert!(!snapshot.exists());
    }

    #[test]
    fn hardlink_probe_is_removed_after_success() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.csv");
        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(&source, b"value\n1\n").unwrap();
        let pinned = File::open(&source).unwrap();

        probe_pinned_source_snapshot(&source, &pinned, &staging).unwrap();

        assert!(std::fs::read_dir(&staging).unwrap().next().is_none());
    }

    #[test]
    fn injected_hardlink_probe_failure_leaves_no_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.csv");
        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(&source, b"value\n1\n").unwrap();
        let pinned = File::open(&source).unwrap();

        let error = probe_pinned_source_snapshot_with(
            &source,
            &pinned,
            &staging,
            |_source, destination| {
                std::fs::write(destination, b"partial")?;
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected hardlink denial",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(error.code, crate::domain::DataErrorCode::QueryFailed);
        assert!(std::fs::read_dir(&staging).unwrap().next().is_none());
    }

    #[test]
    fn worker_source_must_be_the_canonical_assigned_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        let snapshot = staging.join(SOURCE_SNAPSHOT_NAME);
        let other = staging.join("other.csv");
        std::fs::write(&snapshot, b"snapshot").unwrap();
        std::fs::write(&other, b"other---").unwrap();
        let canonical_staging = std::fs::canonicalize(&staging).unwrap();

        assert_eq!(
            canonical_worker_source(&snapshot, &canonical_staging).unwrap(),
            std::fs::canonicalize(&snapshot).unwrap()
        );
        let error = canonical_worker_source(&other, &canonical_staging).unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::QueryFailed);
        assert!(error.message.contains("assigned pinned snapshot"));
    }

    #[test]
    fn sink_preserves_null_invalid_raw_and_reserved_duplicate_headers() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.csv");
        let output = directory.path().join("prepared.parquet.partial");
        std::fs::write(
            &source,
            "dup,dup,__dv_row_id,amount\nNULL,N/A,x,+000.1200\n7,bad,y,-123456789012345678901234567890.123456789\n",
        )
        .unwrap();
        let mut profile = profile(&[
            CsvTargetType::Int64,
            CsvTargetType::Int64,
            CsvTargetType::Text,
            CsvTargetType::Decimal,
        ]);
        profile.columns[0].source_name = String::from("dup");
        profile.columns[1].source_name = String::from("dup");
        profile.columns[2].source_name = String::from("__dv_row_id");
        profile.columns[3].source_name = String::from("amount");
        let resolved = [
            CsvTargetType::Int64,
            CsvTargetType::Int64,
            CsvTargetType::Text,
            CsvTargetType::Decimal,
        ];
        let sink = build_product_sink(PolarsPreparedSinkSpec {
            source: &source,
            output_partial: &output,
            header_used: true,
            resolved_targets: &resolved,
            profile: &profile,
        })
        .unwrap();
        sink.collect().unwrap();

        let connection = duckdb::Connection::open_in_memory().unwrap();
        let path = output.to_string_lossy().replace('\\', "/");
        let sql = format!(
            "SELECT CAST(__dv_row_id AS VARCHAR), __dv_base_raw_0, __dv_base_raw_1, \
             CAST(__dv_value_0 AS VARCHAR), CAST(__dv_value_1 AS VARCHAR), \
             CAST(__dv_state_word_0 AS VARCHAR), __dv_base_raw_3, __dv_value_3 \
             FROM read_parquet('{}') ORDER BY __dv_row_id",
            path.replace('\'', "''")
        );
        let mut statement = connection.prepare(&sql).unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (
                    String::from("0"),
                    String::from("NULL"),
                    String::from("N/A"),
                    None,
                    None,
                    String::from("5"),
                    String::from("+000.1200"),
                    String::from("+000.1200"),
                ),
                (
                    String::from("1"),
                    String::from("7"),
                    String::from("bad"),
                    Some(String::from("7")),
                    None,
                    String::from("12"),
                    String::from("-123456789012345678901234567890.123456789"),
                    String::from("-123456789012345678901234567890.123456789"),
                ),
            ]
        );
    }

    #[test]
    #[ignore = "requires PHASE15_LARGE_CSV; measured cancellation spike"]
    fn large_sink_reaches_terminal_state_within_cancel_budget() {
        let source = std::env::var_os("PHASE15_LARGE_CSV")
            .map(std::path::PathBuf::from)
            .expect("PHASE15_LARGE_CSV is required");
        let mut reader = csv::Reader::from_path(&source).unwrap();
        let headers = reader.headers().unwrap().clone();
        let targets = vec![CsvTargetType::Text; headers.len()];
        let mut profile = profile(&targets);
        for (column, header) in profile.columns.iter_mut().zip(headers.iter()) {
            column.source_name = header.to_owned();
        }
        let directory = tempfile::tempdir().unwrap();
        let pinned = File::open(&source).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = Arc::clone(&cancel);
        let partial = directory.path().join(PREPARED_PARTIAL_NAME);
        let watched_partial = partial.clone();
        let (cancelled_tx, cancelled_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while !watched_partial.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(CANCEL_POLL_INTERVAL);
            }
            let _ = cancelled_tx.send(std::time::Instant::now());
            trigger.store(true, Ordering::Release);
        });
        let error = run_product_worker(
            &source,
            &pinned,
            directory.path(),
            true,
            &profile,
            &targets,
            &cancel,
        )
        .unwrap_err();
        let cancelled_at = cancelled_rx.recv().unwrap();
        assert_eq!(error.code, crate::domain::DataErrorCode::TaskCancelled);
        assert!(cancelled_at.elapsed() < Duration::from_millis(1_000));
        assert!(!partial.exists());
        assert!(!directory.path().join(WORKER_REQUEST_NAME).exists());
        assert!(!directory.path().join(WORKER_RESULT_NAME).exists());
        assert!(!directory.path().join(SOURCE_SNAPSHOT_NAME).exists());
    }

    #[test]
    #[ignore = "subprocess entry; launched by parent tests"]
    fn polars_worker_subprocess_entry() {
        let request = std::env::var_os("DV_POLARS_WORKER_TEST_REQUEST")
            .map(PathBuf::from)
            .expect("worker request env is required");
        run_worker_request(&request).unwrap();
    }
}
