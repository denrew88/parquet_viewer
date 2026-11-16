use super::*;
use crate::query::chart::ChartStore;

fn snapshot(service: &Arc<QueryService>, run: &str, sql: &str) -> String {
    service
        .start_sql(
            StartSqlRequest {
                run_id: run.to_owned(),
                sql: sql.to_owned(),
                action: SqlAction::Execute,
                tables: vec![SqlTableBinding {
                    document_id: "unused-document".into(),
                    session_id: "unused-session".into(),
                    alias: "unused_table".into(),
                    column_mode: SqlColumnMode::Ordinal,
                }],
            },
            vec![],
            DEFAULT_SQL_TEMP_LIMIT_BYTES,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let status = service.sql_status(run).unwrap();
        if terminal(status.state) {
            assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
            return status.result_id.unwrap();
        }
        assert!(Instant::now() < deadline, "SQL snapshot timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn p25_large_sql_result_has_exact_pages_and_metadata_only_chart_selection() {
    let dir = tempfile::tempdir().unwrap();
    let service = Arc::new(QueryService::open(dir.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let id = snapshot(&service, "large", "SELECT i, 9007199254740993::BIGINT+i AS precise, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' AS note FROM range(1000257) t(i)");
    let result = service.sql_result("large", &id).unwrap();
    assert_eq!(result.rows, 1_000_257);
    let path = result._lease.path().to_owned();
    let selection = CopySelectionSnapshot {
        row_start: 0,
        row_end_exclusive: result.rows,
        column_ids: vec!["r1".into(), "r0".into(), "r2".into()],
    };
    let charts = ChartStore::default();
    let reader = service
        .sql_selection_chart_reader("large", &id, None, &selection)
        .unwrap();
    charts
        .capture_reference("large-reference", reader, &selection)
        .unwrap();
    assert_eq!(
        result.read_count.load(Ordering::Relaxed),
        0,
        "Capture must not read any selected cells"
    );
    let page = service
        .read_sql_page(&SqlPageRequest {
            run_id: "large".into(),
            result_id: id.clone(),
            offset: 1_000_000,
            limit: 200,
            columns: vec!["r1".into(), "r0".into()],
        })
        .unwrap();
    assert_eq!(page.rows[0][0].display.as_deref(), Some("9007199255740993"));
    assert_eq!(page.rows[0][1].display.as_deref(), Some("1000000"));
    assert!(page.has_more);
    let last = service
        .read_sql_page(&SqlPageRequest {
            run_id: "large".into(),
            result_id: id.clone(),
            offset: 1_000_256,
            limit: 200,
            columns: vec!["r0".into()],
        })
        .unwrap();
    assert_eq!(last.rows.len(), 1);
    assert_eq!(last.rows[0][0].display.as_deref(), Some("1000256"));
    assert!(!last.has_more);
    let boundary = service
        .find_sql_result_boundary(
            "large",
            &id,
            None,
            &BoundarySearchRequest {
                row: 1_000_000,
                column_id: "r0".into(),
                visible_column_ids: vec!["r0".into()],
                direction: DataBoundaryDirection::Down,
                mode: DataBoundaryMode::DataBoundary,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(boundary.target_row, 1_000_256);
    assert_eq!(boundary.resolved_row_count, Some(1_000_257));

    let export_path = dir.path().join("all-million-plus.parquet");
    service
        .export_sql_result("large", &id, SqlExportFormat::Parquet, &export_path)
        .unwrap();
    let exported =
        ParquetRecordBatchReaderBuilder::try_new(File::open(&export_path).unwrap()).unwrap();
    assert_eq!(exported.metadata().file_metadata().num_rows(), 1_000_257);
    assert_eq!(exported.schema().field(0).data_type(), &DataType::Int64);
    assert_eq!(exported.schema().field(1).data_type(), &DataType::Int64);
    assert_eq!(exported.schema().field(0).name(), "i");
    assert_eq!(exported.schema().field(1).name(), "precise");
    let projection = ProjectionMask::roots(exported.parquet_schema(), [0, 1]);
    // Read only the first and last exported rows, never collect the full result.
    let rows =
        RowSelection::from_consecutive_ranges([0..1, 1_000_256..1_000_257].into_iter(), 1_000_257);
    let mut exported = exported
        .with_projection(projection)
        .with_row_selection(rows)
        .with_batch_size(1)
        .build()
        .unwrap();
    let first = exported.next().unwrap().unwrap();
    let last = exported.next().unwrap().unwrap();
    assert!(exported.next().is_none());
    for (batch, id, precise) in [
        (&first, 0, 9_007_199_254_740_993_i64),
        (&last, 1_000_256, 9_007_199_255_741_249_i64),
    ] {
        assert_eq!(batch.num_rows(), 1);
        assert_eq!(
            batch
                .column(0)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap()
                .value(0),
            id
        );
        assert_eq!(
            batch
                .column(1)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap()
                .value(0),
            precise
        );
    }
    service.release_sql_result("large", &id).unwrap();
    let preview = charts
        .preview_block("large-reference", 2, &["r1".into(), "r0".into()])
        .unwrap();
    assert_eq!(preview.total_rows, Some(1_000_257));
    assert_eq!(
        preview.rows[0][0].display.as_deref(),
        Some("9007199254740993")
    );
    assert_eq!(preview.rows[0][1].display.as_deref(), Some("0"));
    charts.release("large-reference").unwrap();
    assert!(service.sql_result("large", &id).is_err());
    drop(result);
    assert!(
        !path.exists(),
        "Final chart release must reclaim the snapshot"
    );
}

#[test]
fn p25_selection_keeps_sorted_view_after_rerun_release_and_last_owner() {
    let dir = tempfile::tempdir().unwrap();
    let service = Arc::new(QueryService::open(dir.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let id = snapshot(
        &service,
        "run",
        "SELECT i, 9007199254740993::BIGINT+i AS precise FROM range(40) t(i)",
    );
    let mut plan = QueryPlan {
        filters: vec![],
        search: None,
        sort: vec![],
        projection: vec![],
    };
    plan.filters.push(QueryFilter {
        id: "under-thirty".into(),
        column_id: "r0".into(),
        scalar_type: QueryScalarType::Number,
        operator: FilterOperator::LessThan,
        values: vec!["30".into()],
    });
    plan.sort.push(QuerySort {
        column_id: "r0".into(),
        direction: QuerySortDirection::Descending,
        nulls_last: true,
    });
    service
        .start_sql_result_view("run", &id, "selected-view", plan)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let state = service
            .sql_result_view_status("run", &id, "selected-view")
            .unwrap();
        if state.state == QueryTaskState::Complete {
            break;
        }
        assert!(
            !matches!(
                state.state,
                QueryTaskState::Failed | QueryTaskState::Cancelled
            ),
            "{:?}",
            state.error
        );
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let result = service.sql_result("run", &id).unwrap();
    let view = result.view("selected-view").unwrap();
    let indexed = service.sql_view_result(&view).unwrap();
    let path = result._lease.path().to_owned();
    let index_path = indexed._lease.path().to_owned();
    let selection = CopySelectionSnapshot {
        row_start: 2,
        row_end_exclusive: 7,
        column_ids: vec!["r1".into(), "r0".into()],
    };
    let charts = ChartStore::default();
    let before = indexed.page_trace.lock().unwrap().len();
    let reader = service
        .sql_selection_chart_reader("run", &id, Some("selected-view"), &selection)
        .unwrap();
    charts
        .capture_reference("view-reference", Arc::clone(&reader), &selection)
        .unwrap();
    assert_eq!(
        indexed.page_trace.lock().unwrap().len(),
        before,
        "Capture must not read selected view cells"
    );
    service
        .release_sql_result_view("run", &id, "selected-view")
        .unwrap();
    service.release_sql_result("run", &id).unwrap();
    let newer = snapshot(&service, "new-run", "SELECT 777 AS replacement");
    let preview = charts
        .preview_block("view-reference", 6, &["r1".into(), "r0".into()])
        .unwrap();
    assert_eq!(preview.rows.len(), 5);
    assert_eq!(preview.total_rows, Some(5));
    assert_eq!(
        preview.rows[0][0].display.as_deref(),
        Some("9007199254741020")
    );
    assert_eq!(preview.rows[0][1].display.as_deref(), Some("27"));
    assert_eq!(preview.rows[4][1].display.as_deref(), Some("23"));
    assert!(path.exists() && index_path.exists());
    charts.release("view-reference").unwrap();
    assert!(
        reader.validate_current().is_ok(),
        "An in-flight owner keeps the snapshot live"
    );
    drop(reader);
    assert!(service.sql_result("run", &id).is_err());
    assert!(!view.alive.load(Ordering::Acquire));
    drop(indexed);
    drop(view);
    drop(result);
    assert!(!path.exists() && !index_path.exists());
    service.release_sql_result("new-run", &newer).unwrap();
}

#[test]
fn p25_invalid_selection_never_retains_result_or_view() {
    let dir = tempfile::tempdir().unwrap();
    let service = Arc::new(QueryService::open(dir.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
    let id = snapshot(&service, "invalid", "SELECT 1 AS x");
    let result = service.sql_result("invalid", &id).unwrap();
    for selection in [
        CopySelectionSnapshot {
            row_start: 0,
            row_end_exclusive: 2,
            column_ids: vec!["r0".into()],
        },
        CopySelectionSnapshot {
            row_start: 1,
            row_end_exclusive: 0,
            column_ids: vec!["r0".into()],
        },
        CopySelectionSnapshot {
            row_start: 0,
            row_end_exclusive: 1,
            column_ids: vec!["r1".into()],
        },
        CopySelectionSnapshot {
            row_start: 0,
            row_end_exclusive: 1,
            column_ids: vec!["r0".into(), "r0".into()],
        },
    ] {
        assert!(service
            .sql_selection_chart_reader("invalid", &id, None, &selection)
            .is_err());
        assert_eq!(result.chart_owners.load(Ordering::Acquire), 0);
    }
    service.release_sql_result("invalid", &id).unwrap();
}
