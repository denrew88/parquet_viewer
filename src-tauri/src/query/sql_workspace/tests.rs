use super::*;

fn lifecycle_request(run: &str, sql: &str) -> StartSqlRequest {
    StartSqlRequest {
        run_id: run.into(),
        sql: sql.into(),
        action: SqlAction::Execute,
        tables: ["a", "b"]
            .into_iter()
            .map(|alias| SqlTableBinding {
                document_id: format!("document-{alias}"),
                session_id: format!("session-{alias}"),
                alias: alias.into(),
                column_mode: SqlColumnMode::Ordinal,
            })
            .collect(),
    }
}

#[test]
fn sql_workspace_abandon_discards_only_undisclosed_completed_result() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let complete = |run: &str| {
        service
            .start_sql(
                lifecycle_request(run, "SELECT 42 AS answer"),
                vec![],
                DEFAULT_SQL_TEMP_LIMIT_BYTES,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = service.sql_status(run).unwrap();
            if terminal(status.state) {
                assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
                break status.result_id.unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let retained = complete("retained-before-admission");
    let undisclosed = complete("closed-during-admission");
    let path = service
        .sql_result("closed-during-admission", &undisclosed)
        .unwrap()
        ._lease
        .path()
        .to_path_buf();
    service.abandon_sql("closed-during-admission").unwrap();
    assert!(service
        .read_sql_cell("closed-during-admission", &undisclosed, 0, "r0")
        .is_err());
    let status = service.sql_status("closed-during-admission").unwrap();
    assert_eq!(status.state, SqlState::Cancelled);
    assert!(status.result_id.is_none());
    assert_eq!(status.error.unwrap().code, DataErrorCode::TaskCancelled);
    assert_eq!(
        service
            .read_sql_cell("retained-before-admission", &retained, 0, "r0")
            .unwrap()
            .display
            .as_deref(),
        Some("42")
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        !path.exists(),
        "Abandoned undisclosed result must release its lease"
    );
    service
        .release_sql_result("retained-before-admission", &retained)
        .unwrap();
}

#[test]
fn sql_chart_pins_keep_one_snapshot_after_its_tab_releases_it() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let run = "chart-pin-source";
    service
        .start_sql(
            lifecycle_request(run, "SELECT 42 AS answer"),
            vec![],
            DEFAULT_SQL_TEMP_LIMIT_BYTES,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let result = loop {
        let status = service.sql_status(run).unwrap();
        if terminal(status.state) {
            assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
            break status.result_id.unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    };
    let path = service
        .sql_result(run, &result)
        .unwrap()
        ._lease
        .path()
        .to_path_buf();
    assert!(service
        .retain_chart_sql_result("wrong-run", &result)
        .is_err());
    service.retain_chart_sql_result(run, &result).unwrap();
    service.retain_chart_sql_result(run, &result).unwrap();
    service.release_sql_result(run, &result).unwrap();
    service.release_sql_result(run, &result).unwrap();
    service.release_chart_sql_result(run, &result).unwrap();
    assert!(path.exists());
    let reader = service.sql_chart_reader(run, &result, None).unwrap();
    let page = reader.read_rows(0, 1, &["r0".to_owned()]).unwrap();
    assert_eq!(page.rows[0][0].display.as_deref(), Some("42"));
    service.release_chart_sql_result(run, &result).unwrap();
    assert!(reader.validate_current().is_err());
    assert!(service.sql_chart_reader(run, &result, None).is_err());
    assert!(
        path.exists(),
        "A reader still owns the physical temp lease."
    );
    drop(reader);
    assert!(
        !path.exists(),
        "The final reader releases the physical lease."
    );
}

#[test]
fn sql_workspace_abandon_before_worker_admission_prevents_publication() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let mut permits = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while permits.len() < MAX_CONCURRENT_QUERIES {
        if let Some(permit) = acquire_sql_permit(&service.query_limiter) {
            permits.push(permit);
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    service
        .start_sql(
            lifecycle_request("abandoned-active", "SELECT 42"),
            vec![],
            DEFAULT_SQL_TEMP_LIMIT_BYTES,
        )
        .unwrap();
    service.abandon_sql("abandoned-active").unwrap();
    assert!(
        service.sql_workspace.tasks.lock().unwrap()["abandoned-active"]
            .cancel
            .load(Ordering::Acquire)
    );
    drop(permits);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = service.sql_status("abandoned-active").unwrap();
        if terminal(status.state) {
            assert_eq!(status.state, SqlState::Cancelled);
            assert!(status.result_id.is_none());
            assert_eq!(status.error.unwrap().code, DataErrorCode::TaskCancelled);
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(service.sql_workspace.results.lock().unwrap().is_empty());
}

#[test]
fn sql_workspace_reference_discovery_uses_binder_dependencies() {
    for (sql, expected) in [
        ("SELECT * FROM a", vec!["document-a"]),
        (
            "SELECT * FROM \"A\" JOIN b ON true",
            vec!["document-a", "document-b"],
        ),
        ("SELECT * FROM a x JOIN a y ON true", vec!["document-a"]),
        (
            "SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b)",
            vec!["document-a", "document-b"],
        ),
        (
            "WITH used AS (SELECT * FROM b) SELECT * FROM used",
            vec!["document-b"],
        ),
        ("WITH a AS (SELECT 1 AS x) SELECT * FROM a", vec![]),
        (
            "WITH unused AS (SELECT * FROM b) SELECT * FROM a",
            vec!["document-a"],
        ),
        (
            "SELECT 'b' AS literal FROM a -- b is not a source",
            vec!["document-a"],
        ),
        ("SELECT 42 /* FROM b */", vec![]),
        ("SELECT * FROM a WHERE false", vec!["document-a"]),
    ] {
        for action in [SqlAction::Execute, SqlAction::Explain, SqlAction::Analyze] {
            let mut request = lifecycle_request("references", sql);
            request.action = action;
            let actual = QueryService::referenced_sql_sources(&request)
                .unwrap()
                .into_iter()
                .map(|source| source.document_id)
                .collect::<Vec<_>>();
            assert_eq!(actual, expected, "{sql}, {action:?}");
        }
    }
    for sql in [
        "SELECT * FROM unknown",
        "SELECT * FROM 'canary.parquet'",
        "SELECT * FROM read_parquet('canary.parquet')",
        "SELECT 1; COPY (SELECT 1) TO 'canary.csv'",
    ] {
        assert!(
            QueryService::referenced_sql_sources(&lifecycle_request("denied", sql)).is_err(),
            "{sql}"
        );
    }
}

#[test]
fn sql_workspace_source_close_cancels_only_referenced_queued_task() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let source = crate::data::builtin_format_registry()
        .open(&fixture_path("customers.parquet"))
        .unwrap();
    let mut permits = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while permits.len() < MAX_CONCURRENT_QUERIES {
        if let Some(permit) = acquire_sql_permit(&service.query_limiter) {
            permits.push(permit);
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    // Simulate the close command's first sweep preceding registration. The
    // source is still attached at this point, so admission can pass its check.
    service.cancel_source_sql("document-a", "session-a");
    assert!(service.sql_workspace.tasks.lock().unwrap().is_empty());
    service
        .start_sql(
            lifecycle_request("close-source", "SELECT * FROM a"),
            vec![source.query_source_spec().unwrap()],
            DEFAULT_SQL_TEMP_LIMIT_BYTES,
        )
        .unwrap();
    let task = service.sql_workspace.tasks.lock().unwrap()["close-source"].clone();
    assert_eq!(task.request.tables.len(), 1);
    assert!(!task.cancel.load(Ordering::Acquire));
    service.cancel_source_sql("document-b", "session-b");
    assert!(!task.cancel.load(Ordering::Acquire));
    // The post-detach sweep catches registration after the first sweep.
    service.cancel_source_sql("document-a", "session-a");
    assert!(task.cancel.load(Ordering::Acquire));
    drop(permits);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = service.sql_status("close-source").unwrap();
        if terminal(status.state) {
            assert_eq!(status.state, SqlState::Cancelled);
            let error = status.error.unwrap();
            assert_eq!(error.code, DataErrorCode::TaskCancelled);
            assert!(error
                .message
                .contains("referenced source was closed or replaced"));
            assert!(status.result_id.is_none());
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn sql_workspace_storage_cap_shared_boundaries() {
    let corpus: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture_path("sql-storage-boundaries.json")).unwrap())
            .unwrap();
    assert_eq!(
        corpus["minimumBytes"].as_u64().unwrap(),
        MIN_SQL_TEMP_LIMIT_BYTES
    );
    assert_eq!(
        corpus["maximumBytes"].as_u64().unwrap(),
        MAX_SQL_TEMP_LIMIT_BYTES
    );
    assert_eq!(
        corpus["defaultBytes"].as_u64().unwrap(),
        DEFAULT_SQL_TEMP_LIMIT_BYTES
    );
    for case in corpus["byteCases"].as_array().unwrap() {
        let valid = serde_json::from_value::<u64>(case["value"].clone())
            .ok()
            .is_some_and(|bytes| validate_sql_temp_limit(bytes).is_ok());
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}", case["id"]);
    }
}

#[test]
fn sql_workspace_storage_cap_is_snapshotted_and_uses_remaining_shared_budget() {
    let directory = tempfile::tempdir().unwrap();
    let service = Arc::new(QueryService::open(directory.path(), 1024 * 1024 * 1024).unwrap());
    let request = |run: &str| StartSqlRequest {
        run_id: run.into(),
        sql: "SELECT 42 AS answer".into(),
        action: SqlAction::Execute,
        tables: vec![SqlTableBinding {
            document_id: "d-cap".into(),
            session_id: "s-cap".into(),
            alias: "customers".into(),
            column_mode: SqlColumnMode::Ordinal,
        }],
    };
    for invalid_cap in [MIN_SQL_TEMP_LIMIT_BYTES - 1, MAX_SQL_TEMP_LIMIT_BYTES + 1] {
        assert!(service
            .start_sql(request("invalid-cap"), vec![], invalid_cap)
            .is_err());
    }
    let finish = |run: &str, cap| {
        service.start_sql(request(run), vec![], cap).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = service.sql_status(run).unwrap();
            if terminal(status.state) {
                assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
                break status;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    let old = finish("minimum-cap", MIN_SQL_TEMP_LIMIT_BYTES);
    let old_id = old.result_id.unwrap();
    let old_result = service.sql_result("minimum-cap", &old_id).unwrap();
    let old_job: WorkerJob = read_json(&old_result._lease.path().join("job.json")).unwrap();
    assert_eq!(old_job.allowance, MIN_SQL_TEMP_LIMIT_BYTES);
    let larger_cap = 768 * 1024 * 1024;
    let newer = finish("larger-cap", larger_cap);
    let newer_id = newer.result_id.unwrap();
    let newer_result = service.sql_result("larger-cap", &newer_id).unwrap();
    let newer_job: WorkerJob = read_json(&newer_result._lease.path().join("job.json")).unwrap();
    assert_eq!(newer_job.allowance, larger_cap);
    assert!(
        newer_job.allowance > DEFAULT_SQL_TEMP_LIMIT_BYTES,
        "No hidden 512MiB cap"
    );
    assert_eq!(
        service.sql_workspace.tasks.lock().unwrap()["minimum-cap"].sql_temp_limit_bytes,
        MIN_SQL_TEMP_LIMIT_BYTES
    );
    assert_eq!(
        service
            .read_sql_cell("minimum-cap", &old_id, 0, "r0")
            .unwrap()
            .display
            .as_deref(),
        Some("42")
    );
    service.release_sql_result("larger-cap", &newer_id).unwrap();
    drop(newer_result);
    let bounded = finish("maximum-cap", MAX_SQL_TEMP_LIMIT_BYTES);
    let bounded_id = bounded.result_id.unwrap();
    let bounded_result = service.sql_result("maximum-cap", &bounded_id).unwrap();
    let bounded_job: WorkerJob = read_json(&bounded_result._lease.path().join("job.json")).unwrap();
    assert!(bounded_job.allowance > 0 && bounded_job.allowance <= service.temp.configured_limit());
    assert!(
        bounded_job.allowance < MAX_SQL_TEMP_LIMIT_BYTES,
        "Shared remaining budget bounds configured SQL cap"
    );
    assert_eq!(
        service.sql_workspace.tasks.lock().unwrap()["maximum-cap"].sql_temp_limit_bytes,
        MAX_SQL_TEMP_LIMIT_BYTES
    );
    service
        .release_sql_result("maximum-cap", &bounded_id)
        .unwrap();
    service.release_sql_result("minimum-cap", &old_id).unwrap();
}

#[test]
fn sql_workspace_raw_duckdb_errors_preserve_resource_classification() {
    let disk = duckdb_message_error("Out of Memory Error: failed to offload data block (63 MiB/64 MiB used). This limit was set by max_temp_directory_size. PRAGMA max_temp_directory_size='10GiB'".to_owned());
    assert_eq!(
        disk.code,
        crate::domain::DataErrorCode::QueryTempLimitExceeded
    );
    assert!(!disk.message.contains("PRAGMA"));
    let memory = duckdb_message_error(
        "Out of Memory Error: failed to allocate data of size 128 MiB (255 MiB/256 MiB used)"
            .to_owned(),
    );
    assert_eq!(memory.code, crate::domain::DataErrorCode::QueryFailed);
    assert!(memory.message.contains("failed to allocate"));
    assert_eq!(
        duckdb_message_error("INTERRUPT Error: Interrupted!".to_owned()).code,
        crate::domain::DataErrorCode::TaskCancelled
    );
}

#[test]
fn sql_workspace_accounts_open_spill_writer_growth() {
    use std::io::Write;
    let directory = tempfile::tempdir().unwrap();
    let spill = directory.path().join("spill");
    fs::create_dir(&spill).unwrap();
    let mut writer = File::create(spill.join("open.tmp")).unwrap();
    let original = fs::read_dir(&spill)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .metadata()
        .unwrap();
    writer.write_all(&vec![7; 8 * 1024 * 1024]).unwrap();
    assert_eq!(original.len(), 0);
    assert_eq!(directory_bytes(directory.path()).unwrap(), 8 * 1024 * 1024);
    writer.write_all(&vec![9; 1024 * 1024]).unwrap();
    assert_eq!(directory_bytes(directory.path()).unwrap(), 9 * 1024 * 1024);
    assert_eq!(writer.metadata().unwrap().len(), 9 * 1024 * 1024);
}

#[test]
#[cfg(windows)]
fn sql_workspace_accounts_exclusively_locked_database_metadata() {
    use std::{io::Write, os::windows::fs::OpenOptionsExt};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("prepared.duckdb");
    let mut writer = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    writer.write_all(&vec![1; 1024 * 1024]).unwrap();
    assert!(File::open(&path).is_err());
    assert_eq!(directory_bytes(directory.path()).unwrap(), 1024 * 1024);
    assert_eq!(writer.metadata().unwrap().len(), 1024 * 1024);
}

fn job(directory: &Path, sql: &str, action: SqlAction) -> WorkerJob {
    WorkerJob {
        sql: sql.to_owned(),
        action,
        tables: vec![WorkerTable {
            alias: "numbers".to_owned(),
            mode: SqlColumnMode::Ordinal,
            path: fixture_path("types.parquet"),
            columns: vec![SqlInputColumn {
                source_index: 0,
                original_name: "value".to_owned(),
                sql_type: "BIGINT".to_owned(),
                nullable: true,
                expression: "p.\"__sql_pos_0\"".to_owned(),
                warning: None,
            }],
            csv: false,
            physical_columns: 6,
        }],
        directory: directory.to_path_buf(),
        allowance: DEFAULT_SQL_TEMP_LIMIT_BYTES,
        parent_pid: std::process::id(),
    }
}

#[test]
fn sql_workspace_request_boundaries_and_canonical_ids() {
    let source = SqlTableBinding {
        document_id: "d".to_owned(),
        session_id: "s".to_owned(),
        alias: "table".to_owned(),
        column_mode: SqlColumnMode::Ordinal,
    };
    let mut request = StartSqlRequest {
        run_id: "r".to_owned(),
        sql: "SELECT 1".to_owned(),
        action: SqlAction::Execute,
        tables: vec![source],
    };
    assert!(request.validate().is_ok());
    request.sql = "x".repeat(SQL_MAX_TEXT_BYTES + 1);
    assert!(request.validate().is_err());
    let mut page = SqlPageRequest {
        run_id: "r".to_owned(),
        result_id: "result".to_owned(),
        offset: 0,
        limit: 200,
        columns: vec!["r0".to_owned()],
    };
    assert!(page.validate().is_ok());
    for name in ["r+1", "r01", "r-1", "r4096", ""] {
        page.columns = vec![name.to_owned()];
        assert!(page.validate().is_err(), "{name}");
    }
}

#[test]
fn sql_workspace_native_extraction_precedes_side_effects() {
    let database = security::Database::open().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("forbidden.csv");
    let sql = format!(
        "COPY (SELECT 1) TO '{}'; SELECT FROM",
        path.to_string_lossy().replace('\\', "/")
    );
    assert!(database.validate(&sql, &[]).is_err());
    assert!(!path.exists());
    assert!(database
        .validate("CREATE TABLE forbidden_probe(n INT); SELECT 1", &[])
        .is_err());
    let count: u64 = database
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM duckdb_tables() WHERE table_name='forbidden_probe'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn sql_workspace_security_corpus_real_canary() {
    let database = security::Database::open().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let canary = dir.path().join("canary.txt");
    fs::write(&canary, b"private-canary").unwrap();
    let corpus: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture_path("security-cases.json")).unwrap()).unwrap();
    for case in corpus["allowed"].as_array().unwrap() {
        let sql = case["sql"].as_str().unwrap();
        assert!(
            database.validate(sql, &[]).is_ok(),
            "{}: {:?}",
            case["id"],
            database.validate(sql, &[])
        );
    }
    for case in corpus["denied"].as_array().unwrap() {
        let sql = case["sql"]
            .as_str()
            .unwrap()
            .replace("{canary}", &canary.to_string_lossy().replace('\\', "/"))
            .replace("{input}", &canary.to_string_lossy().replace('\\', "/"))
            .replace(
                "{output}",
                &dir.path()
                    .join("output.csv")
                    .to_string_lossy()
                    .replace('\\', "/"),
            )
            .replace("{url}", "http://127.0.0.1:1/canary");
        assert!(
            database.validate(&sql, &[]).is_err(),
            "{}: {sql}",
            case["id"]
        );
        assert!(
            database.referenced_tables(&sql, &[]).is_err(),
            "Parent metadata admission: {}",
            case["id"]
        );
    }
    assert_eq!(fs::read(&canary).unwrap(), b"private-canary");
    assert!(!dir.path().join("output.csv").exists());
}

#[test]
fn sql_workspace_function_alias_syntax_cannot_bypass_guard() {
    let database = security::Database::open().unwrap();
    for sql in [
        "WITH x(sql) AS (VALUES ('SELECT 1')) SELECT * FROM x, query(sql) AS t",
        "WITH x(c1) AS (SELECT 'threads') SELECT current_setting(c1) AS x FROM x",
        "WITH x(path) AS (VALUES ('existing')) SELECT * FROM x, read_text(path) AS t",
    ] {
        assert!(database.validate(sql, &[]).is_err(), "{sql}");
    }
}

#[test]
fn sql_workspace_quoted_catalog_names_cannot_impersonate_input() {
    let database = security::Database::open().unwrap();
    for sql in [
        "SELECT * FROM \"information_schema\".\"tables\"",
        "SELECT * FROM \"pg_catalog\".\"pg_class\"",
        "SELECT * FROM \"main\".sqlite_master",
    ] {
        assert!(
            database
                .validate(
                    sql,
                    &["tables".into(), "pg_class".into(), "sqlite_master".into()]
                )
                .is_err(),
            "{sql}"
        );
    }
}

#[test]
fn sql_workspace_packs_stream_batches_without_changing_order() {
    let dir = tempfile::tempdir().unwrap();
    let output = worker::execute_for_test(&job(
        dir.path(),
        "SELECT i FROM range(70000) AS t(i) ORDER BY i",
        SqlAction::Execute,
    ))
    .unwrap();
    assert_eq!(output.rows, 70_000);
    assert_eq!(
        output
            .chunks
            .iter()
            .map(|chunk| (chunk.offset, chunk.rows))
            .collect::<Vec<_>>(),
        [(0, 32_768), (32_768, 32_768), (65_536, 4_464)]
    );
    let mut expected = 0;
    for chunk in output.chunks {
        let reader = ParquetRecordBatchReaderBuilder::try_new(
            File::open(dir.path().join(chunk.file)).unwrap(),
        )
        .unwrap()
        .build()
        .unwrap();
        for batch in reader {
            let batch = batch.unwrap();
            let values = batch
                .column(0)
                .as_any()
                .downcast_ref::<arrow_array::Int64Array>()
                .unwrap();
            for value in values.values() {
                assert_eq!(*value, expected);
                expected += 1;
            }
        }
    }
    assert_eq!(expected, 70_000);
}

#[test]
fn sql_workspace_metadata_result_and_analyze() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = job(
        dir.path(),
        "SELECT 9223372036854775807::BIGINT AS same, 18446744073709551615::UBIGINT AS same",
        SqlAction::Execute,
    );
    j.tables[0].path = fixture_path("types.parquet");
    let physical = ParquetRecordBatchReaderBuilder::try_new(File::open(&j.tables[0].path).unwrap())
        .unwrap()
        .schema()
        .fields()
        .len();
    j.tables[0].physical_columns = physical;
    let output = worker::execute_for_test(&j).unwrap();
    assert_eq!(output.rows, 1);
    assert_eq!(output.columns[0].name, "same");
    assert_eq!(output.columns[1].name, "same");
    let batch = ParquetRecordBatchReaderBuilder::try_new(
        File::open(dir.path().join(&output.chunks[0].file)).unwrap(),
    )
    .unwrap()
    .build()
    .unwrap()
    .next()
    .unwrap()
    .unwrap();
    assert_eq!(
        crate::data::value_format::full_value_at(batch.column(0).as_ref(), 0)
            .unwrap()
            .display
            .as_deref(),
        Some("9223372036854775807")
    );
    assert_eq!(
        crate::data::value_format::full_value_at(batch.column(1).as_ref(), 0)
            .unwrap()
            .display
            .as_deref(),
        Some("18446744073709551615")
    );
    let plan_dir = tempfile::tempdir().unwrap();
    j.directory = plan_dir.path().to_path_buf();
    j.action = SqlAction::Analyze;
    let output = worker::execute_for_test(&j).unwrap();
    assert!(output.plan_text.is_some());
    assert!(output.chunks.is_empty());
}

fn fixture_path(name: &str) -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = path.join("fixtures/phase-22").join(name);
        if candidate.exists() {
            return candidate;
        }
        assert!(path.pop(), "fixture not found");
    }
}

#[test]
fn sql_workspace_shared_dto_fixture_parity() {
    let fixture: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture_path("dto-boundaries.json")).unwrap()).unwrap();
    fn text(case: &serde_json::Value) -> String {
        case["literal"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "{}{}{}",
                    case["prefix"].as_str().unwrap_or(""),
                    case["unit"]
                        .as_str()
                        .unwrap_or("")
                        .repeat(case["repeat"].as_u64().unwrap_or(0) as usize),
                    case["suffix"].as_str().unwrap_or("")
                )
            })
    }
    fn binding(index: usize, alias: String) -> SqlTableBinding {
        SqlTableBinding {
            document_id: format!("d{index}"),
            session_id: format!("s{index}"),
            alias,
            column_mode: SqlColumnMode::Ordinal,
        }
    }
    fn request() -> StartSqlRequest {
        StartSqlRequest {
            run_id: "run".into(),
            sql: "SELECT 1".into(),
            action: SqlAction::Execute,
            tables: vec![binding(0, "table".into())],
        }
    }
    for c in fixture["blank"].as_array().unwrap() {
        assert_eq!(
            sql_text_is_blank(c["text"].as_str().unwrap()),
            c["expectedBlank"].as_bool().unwrap()
        );
    }
    for c in fixture["identities"].as_array().unwrap() {
        assert_eq!(
            validate_sql_identity(&text(c)).is_ok(),
            c["expectedValid"].as_bool().unwrap(),
            "{c}"
        );
    }
    for c in fixture["aliases"].as_array().unwrap() {
        let mut r = request();
        r.tables[0].alias = text(c);
        assert_eq!(
            r.validate().is_ok(),
            c["expectedValid"].as_bool().unwrap(),
            "{c}"
        );
    }
    for c in fixture["aliasPairs"].as_array().unwrap() {
        let mut r = request();
        r.tables = c["values"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, s)| binding(i, s.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(
            r.validate().is_ok(),
            c["expectedValid"].as_bool().unwrap(),
            "{c}"
        );
    }
    for c in fixture["sqlText"].as_array().unwrap() {
        let mut r = request();
        r.sql = text(c);
        assert_eq!(
            r.validate().is_ok(),
            c["expectedValid"].as_bool().unwrap(),
            "{c}"
        );
    }
    for c in fixture["sourceCounts"].as_array().unwrap() {
        let mut r = request();
        r.tables = (0..c["value"].as_u64().unwrap())
            .map(|i| binding(i as usize, format!("table{i}")))
            .collect();
        assert_eq!(
            r.validate().is_ok(),
            c["expectedValid"].as_bool().unwrap(),
            "{c}"
        );
    }
    for section in [
        "pageOffsets",
        "pageLimits",
        "projections",
        "projectionCounts",
    ] {
        for c in fixture[section].as_array().unwrap() {
            let mut p = SqlPageRequest {
                run_id: "r".into(),
                result_id: "result".into(),
                offset: 0,
                limit: 1,
                columns: vec!["r0".into()],
            };
            match section {
                "pageOffsets" => p.offset = c["value"].as_u64().unwrap(),
                "pageLimits" => p.limit = c["value"].as_u64().unwrap() as usize,
                "projections" => {
                    p.columns = c["columns"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().to_owned())
                        .collect()
                }
                _ => {
                    p.columns = (0..c["value"].as_u64().unwrap())
                        .map(|i| format!("r{i}"))
                        .collect()
                }
            }
            assert_eq!(
                p.validate().is_ok(),
                c["expectedValid"].as_bool().unwrap(),
                "{section}: {c}"
            );
        }
    }
}

#[test]
fn sql_workspace_id_unicode_and_page_offset_parity() {
    for (value, valid) in [("\u{85}", false), ("\u{feff}", false), ("🙂", true)] {
        assert_eq!(validate_sql_identity(value).is_ok(), valid);
    }
    assert!(validate_sql_identity(&"🙂".repeat(32)).is_ok());
    assert!(validate_sql_identity(&"🙂".repeat(33)).is_err());
    let mut page = SqlPageRequest {
        run_id: "r".into(),
        result_id: "result".into(),
        offset: SQL_MAX_ROWS,
        limit: 1,
        columns: vec!["r0".into()],
    };
    assert!(page.validate().is_ok());
    page.offset += 1;
    assert!(page.validate().is_err());
}

#[test]
fn sql_workspace_timezone_nanoseconds_rejected_before_loss() {
    let dir = tempfile::tempdir().unwrap();
    let source = crate::data::builtin_format_registry()
        .open(&fixture_path("temporal-extra.parquet"))
        .unwrap();
    let spec = source.query_source_spec().unwrap();
    let j = WorkerJob {
        sql: "SELECT * FROM temporal".into(),
        action: SqlAction::Execute,
        tables: vec![WorkerTable {
            alias: "temporal".into(),
            mode: SqlColumnMode::Ordinal,
            path: spec.path.clone(),
            columns: spec.provider.sql_input_columns(&spec).unwrap(),
            csv: false,
            physical_columns: spec.columns.len(),
        }],
        directory: dir.path().into(),
        allowance: DEFAULT_SQL_TEMP_LIMIT_BYTES,
        parent_pid: std::process::id(),
    };
    let e = worker::execute_for_test(&j).unwrap_err();
    assert!(
        e.message.contains("nanosecond timestamps with a timezone"),
        "{}",
        e.message
    );
}

fn decimal_job(directory: &Path, values: &[&str]) -> WorkerJob {
    let path = directory.join("input.parquet");
    let schema = Arc::new(arrow_schema::Schema::new(vec![arrow_schema::Field::new(
        "amount",
        arrow_schema::DataType::Utf8,
        true,
    )]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![Arc::new(arrow_array::StringArray::from(values.to_vec()))],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    WorkerJob {
        sql: "SELECT sum(amount) AS total FROM orders".into(),
        action: SqlAction::Execute,
        tables: vec![WorkerTable {
            alias: "orders".into(),
            mode: SqlColumnMode::Name,
            path,
            columns: vec![SqlInputColumn {
                source_index: 0,
                original_name: "amount".into(),
                sql_type: "DECIMAL".into(),
                nullable: true,
                expression: "p.amount".into(),
                warning: None,
            }],
            csv: true,
            physical_columns: 1,
        }],
        directory: directory.into(),
        allowance: DEFAULT_SQL_TEMP_LIMIT_BYTES,
        parent_pid: std::process::id(),
    }
}

#[test]
fn sql_workspace_decimal_scale_exact_and_overflow_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let j = decimal_job(dir.path(), &["0.12345678901234567890123456789012345678"]);
    let result = worker::execute_for_test(&j).unwrap();
    let batch = ParquetRecordBatchReaderBuilder::try_new(
        File::open(dir.path().join(&result.chunks[0].file)).unwrap(),
    )
    .unwrap()
    .build()
    .unwrap()
    .next()
    .unwrap()
    .unwrap();
    assert_eq!(
        crate::data::value_format::full_value_at(batch.column(0).as_ref(), 0)
            .unwrap()
            .display
            .as_deref(),
        Some("0.12345678901234567890123456789012345678")
    );
    let dir2 = tempfile::tempdir().unwrap();
    let j2 = decimal_job(dir2.path(), &["123456789012345678901234567890123456.789"]);
    assert!(worker::execute_for_test(&j2)
        .unwrap_err()
        .message
        .contains("38 exact digits"));
}

#[test]
fn sql_workspace_pre_cancel_produces_no_result() {
    let directory = tempfile::tempdir().unwrap();
    let mut j = job(
        directory.path(),
        "SELECT i FROM range(1000000) AS t(i)",
        SqlAction::Execute,
    );
    j.tables[0].path = fixture_path("types.parquet");
    j.tables[0].physical_columns =
        ParquetRecordBatchReaderBuilder::try_new(File::open(&j.tables[0].path).unwrap())
            .unwrap()
            .schema()
            .fields()
            .len();
    fs::write(directory.path().join("cancel"), []).unwrap();
    assert!(worker::execute_for_test(&j).is_err());
    assert!(!directory.path().join("output.json").exists());
}

#[test]
fn sql_workspace_original_headers_not_display_aliases() {
    let directory = tempfile::tempdir().unwrap();
    let service = QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap();
    for (file, allowed) in [
        ("headers/duplicates.csv", false),
        ("headers/duplicates.parquet", false),
        ("headers/case-duplicates.csv", false),
        ("headers/blank.csv", false),
        ("headers/late-duplicate.csv", false),
        ("headers/collisions.csv", true),
    ] {
        let mut source = crate::data::builtin_format_registry()
            .open(&fixture_path(file))
            .unwrap();
        if file.ends_with(".csv") {
            source.configure_csv(HeaderMode::Present).unwrap();
        }
        let descriptor = service
            .describe_sql_tables(vec![(
                SqlSourceIdentity {
                    document_id: "d".into(),
                    session_id: "s".into(),
                },
                source.query_source_spec().unwrap(),
            )])
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(descriptor.name_mode_allowed, allowed, "{file}");
        if !allowed {
            assert_eq!(descriptor.default_column_mode, SqlColumnMode::Ordinal);
        }
    }
}

#[test]
fn sql_workspace_mode_exclusivity_by_position() {
    let directory = tempfile::tempdir().unwrap();
    let path = fixture_path("customers.parquet");
    let source = crate::data::builtin_format_registry().open(&path).unwrap();
    let spec = source.query_source_spec().unwrap();
    let mut j = WorkerJob {
        sql: "SELECT c1 FROM customers".into(),
        action: SqlAction::Execute,
        tables: vec![WorkerTable {
            alias: "customers".into(),
            mode: SqlColumnMode::Ordinal,
            path,
            columns: spec.provider.sql_input_columns(&spec).unwrap(),
            csv: false,
            physical_columns: spec.columns.len(),
        }],
        directory: directory.path().into(),
        allowance: DEFAULT_SQL_TEMP_LIMIT_BYTES,
        parent_pid: std::process::id(),
    };
    assert!(worker::execute_for_test(&j).is_ok());
    let other = tempfile::tempdir().unwrap();
    j.directory = other.path().into();
    j.tables[0].mode = SqlColumnMode::Name;
    assert!(worker::execute_for_test(&j).is_err());
    j.sql = format!(
        "SELECT {} FROM customers",
        quote_identifier(&j.tables[0].columns[0].original_name)
    );
    let another = tempfile::tempdir().unwrap();
    j.directory = another.path().into();
    assert!(worker::execute_for_test(&j).is_ok());
}

#[test]
fn sql_workspace_stream_error_is_not_successful_partial_result() {
    let directory = tempfile::tempdir().unwrap();
    let mut j = job(
        directory.path(),
        "SELECT CAST(CASE WHEN i=9000 THEN 'bad' ELSE '1' END AS BIGINT) FROM range(10000) AS t(i)",
        SqlAction::Execute,
    );
    j.tables[0].path = fixture_path("types.parquet");
    j.tables[0].physical_columns =
        ParquetRecordBatchReaderBuilder::try_new(File::open(&j.tables[0].path).unwrap())
            .unwrap()
            .schema()
            .fields()
            .len();
    assert!(worker::execute_for_test(&j).is_err());
}

#[test]
fn sql_workspace_small_allowance_fails_instead_of_truncating() {
    let directory = tempfile::tempdir().unwrap();
    let mut j = job(directory.path(), "SELECT 1 AS value", SqlAction::Execute);
    j.tables[0].path = fixture_path("types.parquet");
    j.tables[0].physical_columns =
        ParquetRecordBatchReaderBuilder::try_new(File::open(&j.tables[0].path).unwrap())
            .unwrap()
            .schema()
            .fields()
            .len();
    j.allowance = 1;
    assert!(worker::execute_for_test(&j).is_err());
}

#[test]
fn sql_workspace_service_result_copy_and_release() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let source = crate::data::builtin_format_registry()
        .open(&fixture_path("customers.parquet"))
        .unwrap();
    let spec = source.query_source_spec().unwrap();
    let request = StartSqlRequest {
        run_id: "service-test".into(),
        sql: "SELECT 1 AS same, 2 AS same FROM customers LIMIT 1".into(),
        action: SqlAction::Execute,
        tables: vec![SqlTableBinding {
            document_id: "d".into(),
            session_id: "s".into(),
            alias: "customers".into(),
            column_mode: SqlColumnMode::Ordinal,
        }],
    };
    service
        .start_sql(request, vec![spec], DEFAULT_SQL_TEMP_LIMIT_BYTES)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        let status = service.sql_status("service-test").unwrap();
        if terminal(status.state) {
            break status;
        }
        assert!(Instant::now() < deadline, "SQL job did not finish");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
    let id = status.result_id.unwrap();
    assert!(service.has_live_sql_state());
    service.cancel_source_sql("d", "s");
    drop(source);
    assert!(
        service.has_live_sql_state(),
        "Closing the source must preserve its completed independent result"
    );
    let (reader, staging) = service
        .sql_copy_context("service-test", &id, "bounded-copy", 1024)
        .unwrap();
    assert!(staging.is_dir());
    assert!(reader.validate_staging_bytes(1024).is_ok());
    assert!(reader.validate_staging_bytes(1025).is_err());
    assert_eq!(
        reader.column_headers(&["r0".into(), "r1".into()]).unwrap(),
        vec!["same", "same"]
    );
    let page = service
        .read_sql_page(&SqlPageRequest {
            run_id: "service-test".into(),
            result_id: id.clone(),
            offset: 0,
            limit: 1,
            columns: vec!["r1".into(), "r0".into()],
        })
        .unwrap();
    assert_eq!(page.rows[0][0].display.as_deref(), Some("2"));
    assert_eq!(page.rows[0][1].display.as_deref(), Some("1"));
    service.release_sql_result("service-test", &id).unwrap();
    assert!(!service.has_live_sql_state());
    assert!(reader.validate_current().is_err());
    let service_weak = Arc::downgrade(&service);
    drop(service);
    assert!(
        service_weak.upgrade().is_some(),
        "Copy reader must retain its service and budget owner"
    );
    assert!(
        staging.is_dir(),
        "Copy reader must own its staging lease until drop"
    );
    drop(reader);
    assert!(!staging.exists());
    let deadline = Instant::now() + Duration::from_secs(2);
    while service_weak.upgrade().is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(service_weak.upgrade().is_none());
}
