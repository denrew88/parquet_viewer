use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::engine::{CsvPreparationState, CsvPreparationStatus, QueryService};
use crate::{
    data::DataSource,
    domain::{
        BoundarySearchRequest, DataBoundaryDirection, DataBoundaryMode, ExecuteQueryRequest,
        FilterOperator, HeaderMode, QueryFilter, QueryPlan, QueryScalarType, QuerySort,
        QuerySortDirection, QueryStatus, QueryTaskState, ReadQueryPageRequest,
        DEFAULT_QUERY_TEMP_LIMIT_BYTES,
    },
};

const ROWS: u64 = 5_850_000;
const FILTERED_ROWS: u64 = ROWS / 2;
const RSS_CAP_BYTES: u64 = 1_500 * 1024 * 1024;

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn manifest() -> Value {
    serde_json::from_slice(
        &std::fs::read(repository_root().join("artifacts/phase-13/fixture-manifest.json"))
            .expect("read Phase 13 fixture manifest"),
    )
    .expect("parse Phase 13 fixture manifest")
}

fn fixture<'a>(manifest: &'a Value, id: &str) -> &'a Value {
    manifest["fixtures"]
        .as_array()
        .expect("fixture manifest array")
        .iter()
        .find(|fixture| fixture["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("missing Phase 13 fixture {id}"))
}

fn fixture_path(fixture: &Value) -> PathBuf {
    let path = PathBuf::from(fixture["path"].as_str().expect("fixture path"));
    assert!(path.is_file(), "missing large fixture: {}", path.display());
    assert_eq!(
        std::fs::metadata(&path).expect("fixture metadata").len(),
        fixture["bytes"].as_u64().expect("fixture bytes"),
        "fixture size no longer matches the SHA-256 manifest entry"
    );
    path
}

fn service() -> (tempfile::TempDir, Arc<QueryService>) {
    let directory = tempfile::tempdir().expect("large harness temp directory");
    let service = Arc::new(
        QueryService::open(directory.path(), DEFAULT_QUERY_TEMP_LIMIT_BYTES)
            .expect("large harness query service"),
    );
    (directory, service)
}

fn filtered_sorted_plan() -> QueryPlan {
    QueryPlan {
        filters: vec![QueryFilter {
            id: String::from("active-only"),
            column_id: String::from("active"),
            scalar_type: QueryScalarType::Boolean,
            operator: FilterOperator::IsTrue,
            values: Vec::new(),
        }],
        search: None,
        sort: vec![
            QuerySort {
                column_id: String::from("row_id"),
                direction: QuerySortDirection::Descending,
                nulls_last: true,
            },
            QuerySort {
                column_id: String::from("group_id"),
                direction: QuerySortDirection::Ascending,
                nulls_last: true,
            },
            QuerySort {
                column_id: String::from("category"),
                direction: QuerySortDirection::Ascending,
                nulls_last: true,
            },
        ],
        projection: vec![
            String::from("row_id"),
            String::from("optional_value"),
            String::from("group_id"),
            String::from("category"),
        ],
    }
}

fn execute_request(label: &str) -> ExecuteQueryRequest {
    ExecuteQueryRequest {
        document_id: format!("phase13-document-{label}"),
        session_id: format!("phase13-session-{label}"),
        query_id: format!("phase13-query-{label}"),
        task_id: format!("phase13-task-{label}"),
        plan: filtered_sorted_plan(),
    }
}

fn wait_query(
    service: &QueryService,
    request: &ExecuteQueryRequest,
    timeout: Duration,
) -> QueryStatus {
    let deadline = Instant::now() + timeout;
    loop {
        let status = service
            .status(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                &request.task_id,
            )
            .expect("large query status");
        if matches!(
            status.state,
            QueryTaskState::Complete | QueryTaskState::Cancelled | QueryTaskState::Failed
        ) {
            return status;
        }
        assert!(Instant::now() < deadline, "large query timed out");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn wait_preparation(
    service: &QueryService,
    document_id: &str,
    session_id: &str,
    timeout: Duration,
    peak_rss: &mut u64,
    temp_high_water: &mut u64,
) -> CsvPreparationStatus {
    let deadline = Instant::now() + timeout;
    loop {
        let status = service
            .csv_preparation_status(document_id, session_id)
            .expect("CSV preparation status call")
            .expect("CSV preparation status");
        if let Ok((rss, _)) = process_snapshot() {
            *peak_rss = (*peak_rss).max(rss);
        }
        *temp_high_water = (*temp_high_water).max(
            service
                .usage()
                .expect("CSV preparation temp usage")
                .process_bytes,
        );
        if status.state != CsvPreparationState::Preparing {
            return status;
        }
        assert!(Instant::now() < deadline, "CSV preparation timed out");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn displayed_u64(value: &crate::domain::DataValue) -> u64 {
    value
        .display
        .as_deref()
        .expect("displayed integer")
        .parse()
        .expect("integer display")
}

fn assert_filtered_page(service: &QueryService, request: &ExecuteQueryRequest, offset: u64) -> f64 {
    let started = Instant::now();
    let page = service
        .read_page(ReadQueryPageRequest {
            document_id: request.document_id.clone(),
            session_id: request.session_id.clone(),
            query_id: request.query_id.clone(),
            offset: offset as i64,
            limit: 200,
            columns: vec![String::from("row_id"), String::from("optional_value")],
        })
        .expect("filtered/sorted large page")
        .page;
    for (index, row) in page.rows.iter().enumerate() {
        assert_eq!(
            displayed_u64(&row[0]),
            ROWS - 2 - 2 * (offset + index as u64),
            "filtered/sorted logical row identity mismatch"
        );
    }
    started.elapsed().as_secs_f64() * 1_000.0
}

fn percentile95(samples: &[f64]) -> f64 {
    let mut ordered = samples.to_vec();
    ordered.sort_by(f64::total_cmp);
    ordered[((ordered.len() * 95).div_ceil(100)).saturating_sub(1)]
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create Phase 13 evidence directory");
    }
    let mut bytes = serde_json::to_vec_pretty(value).expect("serialize Phase 13 evidence");
    bytes.push(b'\n');
    std::fs::write(path, bytes).expect("write Phase 13 evidence");
}

#[cfg(windows)]
fn process_snapshot() -> Result<(u64, u32), String> {
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

    let process = unsafe { GetCurrentProcess() };
    let mut counters: ProcessMemoryCounters = unsafe { mem::zeroed() };
    counters.cb = mem::size_of::<ProcessMemoryCounters>() as u32;
    let memory_ok = unsafe {
        K32GetProcessMemoryInfo(process, &mut counters, mem::size_of_val(&counters) as u32)
    } != 0;
    let mut handles = 0_u32;
    let handles_ok = unsafe { GetProcessHandleCount(process, &mut handles) } != 0;
    if memory_ok && handles_ok {
        Ok((counters.working_set_size as u64, handles))
    } else {
        Err(String::from("Windows process metrics unavailable"))
    }
}

#[cfg(not(windows))]
fn process_snapshot() -> Result<(u64, u32), String> {
    Err(String::from("process metrics require Windows"))
}

#[test]
#[ignore = "requires generated Phase 13 low/high 5.85M Parquet fixtures and release execution"]
fn phase13_release_large_parquet_product_paths() {
    let manifest = manifest();
    let mut cases = Vec::new();
    for cardinality in ["low", "high"] {
        let fixture = fixture(&manifest, &format!("boundary-5850000-{cardinality}"));
        let path = fixture_path(fixture);
        let source = DataSource::open(path).expect("open Phase 13 Parquet fixture");
        let spec = source.query_source_spec().expect("Parquet query source");
        let (_temp, service) = service();
        let request = execute_request(&format!("parquet-{cardinality}"));
        request
            .plan
            .validate(&spec.columns)
            .expect("large query plan");
        let query_started = Instant::now();
        service
            .execute(request.clone(), spec)
            .expect("execute filtered/sorted Parquet query");
        let status = wait_query(&service, &request, Duration::from_secs(300));
        let query_ms = query_started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        assert_eq!(status.progress.result_rows, FILTERED_ROWS);

        let page_offsets = [0, 986_803, FILTERED_ROWS - 200];
        let page_ms = page_offsets
            .into_iter()
            .map(|offset| assert_filtered_page(&service, &request, offset))
            .collect::<Vec<_>>();
        let boundary_request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("optional_value"),
            visible_column_ids: vec![String::from("optional_value")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        let cold_started = Instant::now();
        let cold = service
            .find_boundary(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                &boundary_request,
                &AtomicBool::new(false),
            )
            .expect("cold filtered boundary");
        let cold_ms = cold_started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(cold.target_row, 60);
        assert!(cold_ms <= 2_000.0, "cold boundary exceeded 2 s: {cold_ms}");
        let warm_ms = (0..5)
            .map(|_| {
                let started = Instant::now();
                let result = service
                    .find_boundary(
                        &request.document_id,
                        &request.session_id,
                        &request.query_id,
                        &boundary_request,
                        &AtomicBool::new(false),
                    )
                    .expect("warm filtered boundary");
                assert_eq!(result.target_row, 60);
                started.elapsed().as_secs_f64() * 1_000.0
            })
            .collect::<Vec<_>>();
        assert!(
            percentile95(&warm_ms) <= 250.0,
            "warm boundary exceeded 250 ms: {warm_ms:?}"
        );
        let none_request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("category"),
            visible_column_ids: vec![String::from("category")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        let none_started = Instant::now();
        let none = service
            .find_boundary(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                &none_request,
                &AtomicBool::new(false),
            )
            .expect("state-only no-transition boundary");
        let none_ms = none_started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(none.target_row, FILTERED_ROWS - 1);
        assert!(none_ms <= 2_000.0, "far boundary exceeded 2 s: {none_ms}");
        cases.push(json!({
            "fixtureId": fixture["id"],
            "fixtureSha256": fixture["sha256"],
            "queryMs": query_ms,
            "resultRows": status.progress.result_rows,
            "pageOffsets": page_offsets,
            "pageLatencyMs": page_ms,
            "boundary": {
                "column": "optional_value",
                "expectedTarget": 60,
                "coldMs": cold_ms,
                "warmMs": warm_ms,
                "warmP95Ms": percentile95(&warm_ms),
                "noTransitionTarget": none.target_row,
                "noTransitionColdMs": none_ms,
                "stateRead": "bounded query row-id slices plus Parquet boolean occupancy reads; source-wide metadata invariant used when provable; no DataValue materialization",
            },
        }));
        service
            .drop_session(&request.document_id, &request.session_id)
            .expect("drop Parquet session");
    }
    let output = std::env::var_os("PHASE13_PARQUET_RESULTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| repository_root().join("artifacts/phase-13/rust-large-parquet.json"));
    write_json(
        &output,
        &json!({
            "schemaVersion": 1,
            "profile": "release ignored product-path integration/performance",
            "rows": ROWS,
            "cases": cases,
            "gates": {"coldBoundaryMs": 2000, "warmBoundaryP95Ms": 250},
            "status": "PASS",
        }),
    );
}

#[test]
#[ignore = "requires generated Phase 13 5.85M CSV fixtures and release execution"]
fn phase13_release_large_csv_prepared_product_paths() {
    let manifest = manifest();
    let low_fixture = fixture(&manifest, "csv-5850000-low");
    let low_path = fixture_path(low_fixture);
    let (rss_before, handles_before) = process_snapshot().expect("initial process metrics");
    let mut peak_rss = rss_before;
    let mut temp_high_water = 0_u64;
    let (_temp, service) = service();
    let temp_baseline = service
        .usage()
        .expect("initial query temp usage")
        .process_bytes;
    let mut source = DataSource::open(low_path).expect("open Phase 13 large CSV");
    source
        .configure_csv(HeaderMode::Present)
        .expect("configure large CSV header");
    let spec = source.query_source_spec().expect("large CSV query source");
    let document_id = "phase13-document-csv-low";
    let session_id = "phase13-session-csv-low";
    let prepare_started = Instant::now();
    service
        .prepare_csv_session(document_id, session_id, spec.clone())
        .expect("start large CSV preparation");
    let prepared = wait_preparation(
        &service,
        document_id,
        session_id,
        Duration::from_secs(900),
        &mut peak_rss,
        &mut temp_high_water,
    );
    let prepare_ms = prepare_started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(
        prepared.state,
        CsvPreparationState::Ready,
        "{:?}",
        prepared.error
    );
    assert_eq!(prepared.total_rows, Some(ROWS));

    let page_offsets = [0, 1, 986_803, ROWS / 2, ROWS - 200];
    let mut page_ms = Vec::new();
    for offset in page_offsets {
        let started = Instant::now();
        let page = service
            .read_prepared_csv_page(
                document_id,
                session_id,
                spec.clone(),
                offset,
                200,
                &[String::from("row_id"), String::from("optional_value")],
            )
            .expect("prepared CSV page call")
            .expect("ready prepared CSV page");
        page_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        assert_eq!(page.rows.len(), 200);
        assert_eq!(displayed_u64(&page.rows[0][0]), offset);
        assert_eq!(displayed_u64(&page.rows[199][0]), offset + 199);
    }

    let copy_offsets = [0, 800_000, 1_600_000, 3_200_000, ROWS - 64_000];
    let mut copy_ms = Vec::new();
    for offset in copy_offsets {
        let started = Instant::now();
        let page = service
            .read_prepared_csv_copy(
                document_id,
                session_id,
                spec.clone(),
                offset,
                64_000,
                &[String::from("row_id")],
            )
            .expect("prepared CSV copy call")
            .expect("ready prepared CSV copy");
        copy_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        assert_eq!(page.rows.len(), 64_000);
        assert_eq!(displayed_u64(&page.rows[0][0]), offset);
        assert_eq!(displayed_u64(&page.rows[63_999][0]), offset + 63_999);
    }

    let source_boundary = BoundarySearchRequest {
        row: 1,
        column_id: String::from("optional_value"),
        visible_column_ids: vec![String::from("optional_value")],
        direction: DataBoundaryDirection::Down,
        mode: DataBoundaryMode::DataBoundary,
    };
    let boundary_started = Instant::now();
    let boundary = service
        .find_prepared_csv_boundary(
            document_id,
            session_id,
            spec.clone(),
            &source_boundary,
            &AtomicBool::new(false),
        )
        .expect("prepared CSV source boundary call")
        .expect("ready prepared CSV source boundary");
    let source_boundary_ms = boundary_started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(boundary.target_row, 96);

    let request = ExecuteQueryRequest {
        document_id: document_id.to_owned(),
        session_id: session_id.to_owned(),
        query_id: String::from("phase13-query-csv-low"),
        task_id: String::from("phase13-task-csv-low"),
        plan: filtered_sorted_plan(),
    };
    request
        .plan
        .validate(&spec.columns)
        .expect("CSV query plan");
    let query_started = Instant::now();
    service
        .execute(request.clone(), spec.clone())
        .expect("execute prepared CSV query");
    let query_status = wait_query(&service, &request, Duration::from_secs(600));
    let query_ms = query_started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(
        query_status.state,
        QueryTaskState::Complete,
        "{:?}",
        query_status.error
    );
    assert_eq!(query_status.progress.result_rows, FILTERED_ROWS);
    let query_page_ms = [0, 986_803, FILTERED_ROWS - 200]
        .into_iter()
        .map(|offset| assert_filtered_page(&service, &request, offset))
        .collect::<Vec<_>>();
    let query_boundary_request = BoundarySearchRequest {
        row: 0,
        column_id: String::from("optional_value"),
        visible_column_ids: vec![String::from("optional_value")],
        direction: DataBoundaryDirection::Down,
        mode: DataBoundaryMode::DataBoundary,
    };
    let query_boundary_started = Instant::now();
    let query_boundary = service
        .find_boundary(
            document_id,
            session_id,
            &request.query_id,
            &query_boundary_request,
            &AtomicBool::new(false),
        )
        .expect("prepared filtered boundary");
    let query_boundary_ms = query_boundary_started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(query_boundary.target_row, 60);

    service
        .drop_session(document_id, session_id)
        .expect("drop ready CSV session");
    let cleanup = service.clear_temp().expect("clear ready CSV temp");
    let usage_after_ready = service.usage().expect("usage after ready cleanup");
    assert_eq!(usage_after_ready.active_queries, 0);
    assert_eq!(usage_after_ready.process_bytes, temp_baseline);

    let high_fixture = fixture(&manifest, "csv-5850000-high");
    let high_path = fixture_path(high_fixture);
    let mut high_source = DataSource::open(high_path).expect("open high-cardinality CSV");
    high_source
        .configure_csv(HeaderMode::Present)
        .expect("configure high CSV header");
    let high_spec = high_source
        .query_source_spec()
        .expect("high CSV query source");
    let cancel_document = "phase13-document-csv-cancel";
    let cancel_session = "phase13-session-csv-cancel";
    service
        .prepare_csv_session(cancel_document, cancel_session, high_spec)
        .expect("start cancellable CSV preparation");
    let progress_deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let status = service
            .csv_preparation_status(cancel_document, cancel_session)
            .expect("cancellable preparation status")
            .expect("cancellable preparation");
        if status.rows_scanned > 0 {
            break;
        }
        assert!(
            Instant::now() < progress_deadline,
            "CSV prepare made no progress"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    let cancel_started = Instant::now();
    service
        .cancel_csv_preparation(cancel_document, cancel_session)
        .expect("cancel CSV preparation");
    let cancelled = wait_preparation(
        &service,
        cancel_document,
        cancel_session,
        Duration::from_secs(2),
        &mut peak_rss,
        &mut temp_high_water,
    );
    let cancel_ms = cancel_started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(cancelled.state, CsvPreparationState::Cancelled);
    assert!(cancel_ms <= 2_000.0);
    service
        .drop_session(cancel_document, cancel_session)
        .expect("drop cancelled CSV session");
    service.clear_temp().expect("clear cancelled CSV temp");
    let usage_final = service.usage().expect("final CSV temp usage");
    drop(spec);
    drop(source);
    drop(high_source);
    std::thread::sleep(Duration::from_millis(100));
    let (rss_after, handles_after) = process_snapshot().expect("final process metrics");
    peak_rss = peak_rss.max(rss_after);
    assert!(peak_rss <= RSS_CAP_BYTES, "peak RSS exceeded 1.5 GiB");
    assert_eq!(usage_final.active_queries, 0);
    assert_eq!(usage_final.process_bytes, temp_baseline);
    assert!(
        handles_after <= handles_before.saturating_add(2),
        "process handles did not return near their initial baseline"
    );

    let output = std::env::var_os("PHASE13_CSV_RESULTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| repository_root().join("artifacts/phase-13/rust-large-csv.json"));
    write_json(
        &output,
        &json!({
            "schemaVersion": 1,
            "profile": "release ignored prepared CSV product-path integration/performance",
            "fixtureId": low_fixture["id"],
            "fixtureSha256": low_fixture["sha256"],
            "prepare": {
                "elapsedMs": prepare_ms,
                "rows": prepared.total_rows,
                "rowsPerSecond": ROWS as f64 / (prepare_ms / 1000.0),
            },
            "page": {"offsets": page_offsets, "latencyMs": page_ms, "p95Ms": percentile95(&page_ms)},
            "copyOneColumn64000Rows": {
                "implementation": "parameterized contiguous __dv_row_id range",
                "offsets": copy_offsets,
                "latencyMs": copy_ms,
                "p95Ms": percentile95(&copy_ms),
                "rowsPerSecondAtP95": 64000.0 / (percentile95(&copy_ms) / 1000.0),
            },
            "sourceBoundary": {"expectedTarget": 96, "elapsedMs": source_boundary_ms},
            "filteredSortedQuery": {
                "elapsedMs": query_ms,
                "resultRows": query_status.progress.result_rows,
                "pageLatencyMs": query_page_ms,
                "boundaryExpectedTarget": 60,
                "boundaryElapsedMs": query_boundary_ms,
            },
            "cancel": {
                "fixtureId": high_fixture["id"],
                "fixtureSha256": high_fixture["sha256"],
                "terminal": "cancelled",
                "elapsedMs": cancel_ms,
            },
            "resource": {
                "rssBeforeBytes": rss_before,
                "rssAfterBytes": rss_after,
                "sampledPeakRssBytes": peak_rss,
                "rssCapBytes": RSS_CAP_BYTES,
                "handlesBefore": handles_before,
                "handlesAfter": handles_after,
                "tempHighWaterBytes": temp_high_water,
                "processTempBaselineBytes": temp_baseline,
                "finalProcessTempBytes": usage_final.process_bytes,
                "finalActiveQueries": usage_final.active_queries,
                "inactiveBytesDeleted": cleanup.deleted_bytes,
            },
            "status": "PASS",
        }),
    );
}

#[test]
#[ignore = "requires generated Phase 13 5.85M low-cardinality CSV and release execution"]
fn phase13_release_large_csv_direct_page_baseline() {
    let manifest = manifest();
    let fixture = fixture(&manifest, "csv-5850000-low");
    let path = fixture_path(fixture);
    let mut source = DataSource::open(path).expect("open direct baseline CSV");
    source
        .configure_csv(HeaderMode::Present)
        .expect("configure direct baseline CSV");
    let offsets = [0_u64, 986_803, ROWS - 200];
    let mut latency_ms = Vec::new();
    for offset in offsets {
        let started = Instant::now();
        let page = source
            .read_page_projected(
                offset,
                200,
                Some(&[String::from("row_id"), String::from("optional_value")]),
            )
            .expect("direct CSV projected page");
        latency_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        assert_eq!(page.rows.len(), 200);
        assert_eq!(displayed_u64(&page.rows[0][0]), offset);
        assert_eq!(displayed_u64(&page.rows[199][0]), offset + 199);
    }

    let output = std::env::var_os("PHASE13_CSV_RESULTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| repository_root().join("artifacts/phase-13/rust-large-csv.json"));
    let mut evidence: Value = serde_json::from_slice(
        &std::fs::read(&output).expect("prepared CSV evidence must exist before direct baseline"),
    )
    .expect("parse prepared CSV evidence");
    let prepared_p95 = evidence["page"]["p95Ms"]
        .as_f64()
        .expect("prepared page p95");
    let direct_p95 = percentile95(&latency_ms);
    evidence["directCsvPageBaseline"] = json!({
        "fixtureId": fixture["id"],
        "fixtureSha256": fixture["sha256"],
        "offsets": offsets,
        "latencyMs": latency_ms,
        "p95Ms": direct_p95,
        "preparedP95Ms": prepared_p95,
        "preparedSpeedupAtRecordedP95": direct_p95 / prepared_p95,
        "note": "Direct source pages use the same DataSource product path without a prepared artifact."
    });
    write_json(&output, &evidence);
}

#[test]
#[ignore = "requires generated Phase 13 5.85M low-cardinality CSV and release execution"]
fn phase14_release_5850000_csv_persistent_hit_is_under_one_second() {
    let manifest = manifest();
    let fixture = fixture(&manifest, "csv-5850000-low");
    let path = fixture_path(fixture);
    let local_data = tempfile::tempdir().expect("persistent hit benchmark local data");
    let make_spec = || {
        let mut source = DataSource::open(&path).expect("open 5.85M CSV");
        source
            .configure_csv(HeaderMode::Present)
            .expect("configure 5.85M CSV header");
        source.query_source_spec().expect("5.85M CSV query source")
    };
    let cold_started = Instant::now();
    {
        let service = Arc::new(
            QueryService::open(local_data.path(), DEFAULT_QUERY_TEMP_LIMIT_BYTES)
                .expect("cold persistent benchmark service"),
        );
        service
            .prepare_csv_session("phase14-cold-document", "phase14-cold-session", make_spec())
            .expect("start cold 5.85M preparation");
        let mut peak_rss = 0;
        let mut temp_high_water = 0;
        let ready = wait_preparation(
            &service,
            "phase14-cold-document",
            "phase14-cold-session",
            Duration::from_secs(900),
            &mut peak_rss,
            &mut temp_high_water,
        );
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
        assert_eq!(ready.rows_scanned, ROWS);
        service
            .drop_session("phase14-cold-document", "phase14-cold-session")
            .expect("drop cold preparation");
        service.shutdown();
    }
    let cold_elapsed_seconds = cold_started.elapsed().as_secs_f64();

    let mut hit_ms = Vec::with_capacity(20);
    let mut checks = Vec::with_capacity(20);
    for sample in 0..20 {
        let service = Arc::new(
            QueryService::open(local_data.path(), DEFAULT_QUERY_TEMP_LIMIT_BYTES)
                .expect("warm persistent benchmark service"),
        );
        let document_id = format!("phase14-hit-document-{sample}");
        let session_id = format!("phase14-hit-session-{sample}");
        let started = Instant::now();
        let hit = service
            .prepare_csv_session(&document_id, &session_id, make_spec())
            .expect("open persistent 5.85M cache hit");
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(hit.state, CsvPreparationState::Ready, "{:?}", hit.error);
        assert_eq!(hit.rows_scanned, ROWS);
        assert_eq!(hit.source_read_bytes, 0);
        assert!(
            elapsed_ms < 1_000.0,
            "5.85M persistent cache hit took {elapsed_ms:.3} ms"
        );
        checks.push(json!({
            "sample": sample + 1,
            "latencyMs": elapsed_ms,
            "state": "ready",
            "sourceReadBytes": hit.source_read_bytes
        }));
        hit_ms.push(elapsed_ms);
        service
            .drop_session(&document_id, &session_id)
            .expect("drop persistent hit session");
        service.shutdown();
    }
    let mut ordered = hit_ms.clone();
    ordered.sort_by(f64::total_cmp);
    let p50_ms = ordered[9];
    let p95_ms = ordered[18];
    let max_ms = ordered[19];
    let output = repository_root().join("artifacts/phase-14/rust-persistent-cache-benchmark.json");
    write_json(
        &output,
        &json!({
            "measuredAt": "2026-07-23",
            "command": "cargo test --release phase14_release_5850000_csv_persistent_hit_is_under_one_second -- --ignored --nocapture --test-threads=1",
            "fixtureId": fixture["id"],
            "rows": ROWS,
            "profile": "release",
            "coldPreparationSeconds": cold_elapsed_seconds,
            "persistentHitSampleCount": hit_ms.len(),
            "persistentHitLatencyMs": hit_ms,
            "p50Ms": p50_ms,
            "p95Ms": p95_ms,
            "maxMs": max_ms,
            "limitMilliseconds": 1_000,
            "checks": checks,
            "allReady": true,
            "allSourceReadBytesZero": true,
            "result": "PASS"
        }),
    );
    eprintln!(
        "phase14 5.85M persistent cache hits (n=20): p50={p50_ms:.3} ms, p95={p95_ms:.3} ms, max={max_ms:.3} ms"
    );
}
