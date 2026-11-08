//! Viewer query plans applied to immutable SQL result chunks.
use super::*;
use crate::data::{QueryExactValues, QueryInputProvider};
use arrow_array::{
    types::TimestampMillisecondType, Array, ArrayRef, Int64Array, TimestampMicrosecondArray,
    TimestampSecondArray,
};
use arrow_schema::{DataType, TimeUnit};
use parquet::arrow::{arrow_reader::RowSelection, ProjectionMask};
use std::collections::BTreeMap;

pub(crate) const VIEW_DOCUMENT: &str = "sql-result-view";
const PUBLIC_DOCUMENT: &str = "sql-workspace";
const MAX_VIEWS_PER_RESULT: usize = 3;
const PAGE_LIMIT_ERROR: &str = "SQL result view page exceeds 8 MiB. Select fewer columns.";

pub(crate) fn sql_view_temp_cap(process_limit: u64) -> u64 {
    (process_limit / 4).min(256 * 1024 * 1024)
}

pub(super) struct SqlResultView {
    session: String,
    alive: AtomicBool,
}

impl SqlResult {
    fn view(&self, id: &str) -> Result<Arc<SqlResultView>, DataError> {
        validate_sql_identity(id)?;
        self.views
            .lock()
            .map_err(|_| registry_error())?
            .get(id)
            .filter(|view| view.alive.load(Ordering::Acquire))
            .cloned()
            .ok_or_else(|| DataError::query_not_found(id))
    }

    pub(super) fn invalidate_views(&self) {
        if let Ok(mut views) = self.views.lock() {
            for view in views.drain().map(|(_, view)| view) {
                view.alive.store(false, Ordering::Release);
            }
        }
    }

    fn schema_path(&self) -> PathBuf {
        self._lease.path().join(self.schema_file())
    }

    fn schema_file(&self) -> &str {
        self.chunks
            .first()
            .map_or("schema.parquet", |chunk| &chunk.file)
    }

    fn view_columns(&self) -> Vec<ColumnSchema> {
        self.columns
            .iter()
            .map(|column| ColumnSchema {
                name: column.id.clone(),
                nullable: column.nullable,
                logical_type: column.logical_type.clone(),
                // The viewer's scalar classifier uses Arrow spellings for text.
                value_logical_type: if column.logical_type.contains("CHAR") {
                    "Utf8".to_owned()
                } else {
                    column.logical_type.clone()
                },
                physical_type: column.logical_type.clone(),
            })
            .collect()
    }
}

fn public_status(mut status: QueryStatus, result: &str, view: &str) -> QueryStatus {
    status.document_id = PUBLIC_DOCUMENT.to_owned();
    status.session_id = result.to_owned();
    status.query_id = view.to_owned();
    status.task_id = view.to_owned();
    status
}

impl QueryService {
    pub fn start_sql_result_view(
        self: &Arc<Self>,
        run: &str,
        id: &str,
        view_id: &str,
        mut plan: QueryPlan,
    ) -> Result<QueryStatus, DataError> {
        validate_sql_identity(view_id)?;
        let result = self.sql_result(run, id)?;
        let columns = result.view_columns();
        plan.validate(&columns)?;
        // Result projection is request-scoped. Hidden columns remain available
        // for page/copy/export operations without building a different view.
        plan.projection.clear();
        let mut views = result.views.lock().map_err(|_| registry_error())?;
        if !result.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if views.contains_key(view_id) || views.len() >= MAX_VIEWS_PER_RESULT {
            return Err(invalid(
                "SQL result view identity is in use or the view limit was reached.",
            ));
        }
        let session = format!(
            "sql-view-{}",
            self.next_distinct_id.fetch_add(1, Ordering::Relaxed)
        );
        let request = ExecuteQueryRequest {
            document_id: VIEW_DOCUMENT.to_owned(),
            session_id: session.clone(),
            query_id: session.clone(),
            task_id: session.clone(),
            plan,
        };
        let path = result.schema_path();
        let source = QuerySourceSpec {
            path: path.clone(),
            total_rows: Some(result.rows),
            columns,
            provider: Arc::new(SqlSnapshotProvider {
                result: Arc::clone(&result),
                path,
            }),
        };
        let status = match self.execute(request, source) {
            Ok(status) => status,
            Err(error) => {
                let _ = self.close_sql_view_session(&session);
                return Err(error);
            }
        };
        views.insert(
            view_id.to_owned(),
            Arc::new(SqlResultView {
                session,
                alive: AtomicBool::new(true),
            }),
        );
        Ok(public_status(status, id, view_id))
    }

    pub fn sql_result_view_status(
        &self,
        run: &str,
        id: &str,
        view_id: &str,
    ) -> Result<QueryStatus, DataError> {
        let view = self.sql_result(run, id)?.view(view_id)?;
        self.status(VIEW_DOCUMENT, &view.session, &view.session, &view.session)
            .map(|status| public_status(status, id, view_id))
    }

    pub fn cancel_sql_result_view(
        &self,
        run: &str,
        id: &str,
        view_id: &str,
    ) -> Result<QueryStatus, DataError> {
        let view = self.sql_result(run, id)?.view(view_id)?;
        self.cancel(VIEW_DOCUMENT, &view.session, &view.session, &view.session)
            .map(|status| public_status(status, id, view_id))
    }

    pub fn release_sql_result_view(
        &self,
        run: &str,
        id: &str,
        view_id: &str,
    ) -> Result<(), DataError> {
        validate_sql_identity(view_id)?;
        let result = self.sql_result(run, id)?;
        let view = result
            .views
            .lock()
            .map_err(|_| registry_error())?
            .remove(view_id);
        if let Some(view) = view {
            view.alive.store(false, Ordering::Release);
            self.close_sql_view_session(&view.session)?;
        }
        Ok(())
    }

    fn close_sql_view_session(&self, session: &str) -> Result<(), DataError> {
        if let Some(epoch) = self
            .query_epochs
            .lock()
            .map_err(|_| registry_error())?
            .remove(&(VIEW_DOCUMENT.to_owned(), session.to_owned()))
        {
            epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.drop_session_results(VIEW_DOCUMENT, session, true)?;
        self.wait_session_query_tasks(VIEW_DOCUMENT, session, Duration::from_secs(3))?;
        self.drop_session_results(VIEW_DOCUMENT, session, false)
    }

    pub(super) fn close_sql_result_views(&self, result: &SqlResult) -> Result<(), DataError> {
        let views = std::mem::take(&mut *result.views.lock().map_err(|_| registry_error())?);
        for view in views.values() {
            view.alive.store(false, Ordering::Release);
        }
        let mut outcome = Ok(());
        for view in views.into_values() {
            outcome = outcome.and(self.close_sql_view_session(&view.session));
        }
        outcome
    }

    fn sql_view_result(&self, view: &SqlResultView) -> Result<Arc<QueryResult>, DataError> {
        self.result(VIEW_DOCUMENT, &view.session, &view.session)
    }

    pub fn read_sql_result_view_page(
        &self,
        request: &SqlPageRequest,
        view_id: &str,
    ) -> Result<DataPage, DataError> {
        request.validate()?;
        let result = self.sql_result(&request.run_id, &request.result_id)?;
        let view = result.view(view_id)?;
        let indexed = self.sql_view_result(&view)?;
        let mut limit = request.limit;
        loop {
            check_view_current(&result, &view)?;
            match indexed.read_page_projected(request.offset, limit, &request.columns) {
                Err(error) if error.message == PAGE_LIMIT_ERROR && limit > 1 => {
                    // The generic provider must return every requested row.
                    // Retry with a smaller prefix before publishing the page.
                    limit /= 2;
                }
                Ok(mut page) => {
                    check_view_current(&result, &view)?;
                    page.limit = request.limit;
                    return Ok(page);
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn read_sql_result_view_cell(
        &self,
        run: &str,
        id: &str,
        view_id: &str,
        row: u64,
        column: &str,
    ) -> Result<DataValue, DataError> {
        let result = self.sql_result(run, id)?;
        let view = result.view(view_id)?;
        let mut page =
            self.sql_view_result(&view)?
                .read_copy_projected(row, 1, &[column.to_owned()])?;
        check_view_current(&result, &view)?;
        page.rows
            .pop()
            .and_then(|mut row| row.pop())
            .ok_or_else(|| invalid("SQL cell is outside the result view."))
    }

    pub fn find_sql_result_view_match(
        &self,
        run: &str,
        id: &str,
        view_id: &str,
        mut request: FindQueryMatchRequest,
    ) -> Result<FindQueryMatchResponse, DataError> {
        if request.document_id != PUBLIC_DOCUMENT
            || request.session_id != id
            || request.query_id != view_id
        {
            return Err(invalid("SQL result view Find identity does not match."));
        }
        let result = self.sql_result(run, id)?;
        let view = result.view(view_id)?;
        request.document_id = VIEW_DOCUMENT.to_owned();
        request.session_id = view.session.clone();
        request.query_id = view.session.clone();
        let matched = self.find_match(request)?.matched;
        check_view_current(&result, &view)?;
        Ok(FindQueryMatchResponse {
            document_id: PUBLIC_DOCUMENT.to_owned(),
            session_id: id.to_owned(),
            query_id: view_id.to_owned(),
            matched,
        })
    }

    pub fn sql_result_view_copy_context(
        self: &Arc<Self>,
        run: &str,
        id: &str,
        view_id: &str,
        operation: &str,
        max_bytes: u64,
    ) -> Result<(Arc<dyn CopyRowReader>, PathBuf), DataError> {
        let result = self.sql_result(run, id)?;
        let view = result.view(view_id)?;
        let indexed = self.sql_view_result(&view)?;
        let (reader, path) = self.sql_copy_reader(result, operation, max_bytes)?;
        Ok((
            Arc::new(SqlViewCopyReader {
                reader,
                view,
                indexed,
            }),
            path,
        ))
    }

    pub fn export_sql_result_view(
        &self,
        run: &str,
        id: &str,
        view_id: &str,
        format: SqlExportFormat,
        path: &Path,
    ) -> Result<(), DataError> {
        let result = self.sql_result(run, id)?;
        let view = result.view(view_id)?;
        let indexed = self.sql_view_result(&view)?;
        check_view_current(&result, &view)?;
        // Pin both the index and its source lease for the entire file write.
        export::export_batches(&result, format, path, |visit| {
            self.stream_sql_view(&result, &indexed, visit)
        })
    }

    fn stream_sql_view(
        &self,
        result: &SqlResult,
        indexed: &QueryResult,
        visit: &mut dyn FnMut(RecordBatch) -> Result<(), DataError>,
    ) -> Result<(), DataError> {
        if indexed.row_count == 0 {
            return Ok(());
        }
        let stored = export::reader_builder(result, result.schema_file())?
            .schema()
            .clone();
        let columns = result
            .columns
            .iter()
            .map(|column| format!("s.{}", quote_identifier(&column.id)))
            .collect::<Vec<_>>()
            .join(", ");
        let connection = indexed.connection.lock().map_err(|_| registry_error())?;
        self.csv_cache.refresh_usage()?;
        let operation = format!(
            "sql-view-export-{}",
            self.next_distinct_id.fetch_add(1, Ordering::Relaxed)
        );
        let extra = self.temp.allocate_bounded(
            VIEW_DOCUMENT,
            &operation,
            sql_view_temp_cap(self.temp.configured_limit()),
        )?;
        indexed._lease.commit_usage();
        let spill_limit = indexed
            ._lease
            .allowance_bytes()
            .saturating_add(extra.allowance_bytes());
        let _reservation = ViewSpillReservation {
            index: &indexed._lease,
            _extra: extra,
        };
        connection
            .execute_batch(&format!("SET max_temp_directory_size = '{spill_limit}B'"))
            .map_err(duckdb_error)?;
        let budget = QueryBudgetMonitor::start(
            Arc::clone(&self.temp),
            Some(Arc::clone(&self.csv_cache)),
            connection.interrupt_handle(),
        );
        let body = format!("SELECT {columns} FROM query_result q JOIN dv_source s USING (__dv_row_id) ORDER BY q.rowid");
        let mut meta = connection
            .prepare(&format!("SELECT * FROM ({body}) LIMIT 0"))
            .map_err(duckdb_error)?;
        let schema = meta.query_arrow([]).map_err(duckdb_error)?.get_schema();
        let mut statement = connection.prepare(&body).map_err(duckdb_error)?;
        let mut rows = 0_u64;
        for batch in statement.stream_arrow([], schema).map_err(duckdb_error)? {
            budget.check()?;
            let columns = batch
                .columns()
                .iter()
                .zip(stored.fields())
                .map(|(array, field)| restore_export_column(array, field.data_type()))
                .collect::<Result<Vec<_>, _>>()?;
            let batch = RecordBatch::try_new(Arc::clone(&stored), columns)
                .map_err(|err| error(err.to_string()))?;
            rows += batch.num_rows() as u64;
            visit(batch)?;
        }
        budget.check()?;
        if rows != indexed.row_count {
            return Err(error(
                "SQL result export ended before all rows were written.",
            ));
        }
        Ok(())
    }
}

fn restore_export_column(array: &ArrayRef, stored: &DataType) -> Result<ArrayRef, DataError> {
    if array.data_type() == stored {
        return Ok(Arc::clone(array));
    }
    match (array.data_type(), stored) {
        (DataType::Int64, DataType::Timestamp(TimeUnit::Second, None)) => {
            // Parquet stores second timestamps as unannotated INT64 values.
            let seconds = array
                .as_any()
                .downcast_ref::<Int64Array>()
                .ok_or_else(|| error("Invalid SQL export seconds array."))?;
            Ok(Arc::new(TimestampSecondArray::new(
                seconds.values().clone(),
                seconds.nulls().cloned(),
            )))
        }
        (
            DataType::Timestamp(TimeUnit::Microsecond, None),
            DataType::Timestamp(TimeUnit::Millisecond, None),
        ) => {
            let micros = array
                .as_any()
                .downcast_ref::<TimestampMicrosecondArray>()
                .ok_or_else(|| error("Invalid SQL export microseconds array."))?;
            let millis = micros.try_unary::<_, TimestampMillisecondType, DataError>(|value| {
                if value % 1000 == 0 {
                    Ok(value / 1000)
                } else {
                    Err(error(
                        "SQL export timestamp is not exactly representable in milliseconds.",
                    ))
                }
            })?;
            Ok(Arc::new(millis))
        }
        (read, stored) => Err(error(format!(
            "SQL export cannot preserve the stored type {stored} from {read}."
        ))),
    }
}

struct ViewSpillReservation<'a> {
    index: &'a QueryTempLease,
    _extra: QueryTempLease,
}

impl Drop for ViewSpillReservation<'_> {
    fn drop(&mut self) {
        self.index.commit_usage();
    }
}

fn check_view_current(result: &SqlResult, view: &SqlResultView) -> Result<(), DataError> {
    if !result.alive.load(Ordering::Acquire) || !view.alive.load(Ordering::Acquire) {
        return Err(DataError::task_cancelled());
    }
    Ok(())
}

struct SqlViewCopyReader {
    reader: SqlCopyReader,
    view: Arc<SqlResultView>,
    indexed: Arc<QueryResult>,
}

impl CopyRowReader for SqlViewCopyReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.validate_current()?;
        self.indexed
            .read_copy_projected(offset, limit.min(4096), columns)
    }
    fn validate_current(&self) -> Result<(), DataError> {
        check_view_current(&self.reader.result, &self.view)?;
        self.reader.validate_current()
    }
    fn validate_staging_bytes(&self, total: u64) -> Result<(), DataError> {
        check_view_current(&self.reader.result, &self.view)?;
        self.reader.validate_staging_bytes(total)
    }
    fn column_headers(&self, columns: &[String]) -> Result<Vec<String>, DataError> {
        self.reader.column_headers(columns)
    }
}

struct SqlSnapshotProvider {
    result: Arc<SqlResult>,
    path: PathBuf,
}

impl std::fmt::Debug for SqlSnapshotProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SqlSnapshotProvider")
            .field("rows", &self.result.rows)
            .finish()
    }
}

impl QueryInputProvider for SqlSnapshotProvider {
    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
        if context.cancel.load(Ordering::Acquire) || !self.result.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let (paths, offsets): (Vec<_>, Vec<_>) = if self.result.chunks.is_empty() {
            (
                vec![quote_literal(
                    &self.path.to_string_lossy().replace('\\', "/"),
                )],
                vec!["('schema.parquet', 0::UBIGINT)".to_owned()],
            )
        } else {
            self.result
                .chunks
                .iter()
                .map(|chunk| {
                    let path = self.result._lease.path().join(&chunk.file);
                    (
                        quote_literal(&path.to_string_lossy().replace('\\', "/")),
                        format!(
                            "({}, {}::UBIGINT)",
                            quote_literal(&chunk.file),
                            chunk.offset
                        ),
                    )
                })
                .unzip()
        };
        let invalid = (0..self.result.columns.len())
            .map(|index| format!("false AS {}", invalid_name(index)))
            .collect::<Vec<_>>()
            .join(", ");
        context.connection.execute_batch(&format!(
            "CREATE VIEW dv_source AS SELECT (c.first_row + p.file_row_number)::UBIGINT AS __dv_row_id, p.* EXCLUDE (filename, file_row_number), {invalid} FROM read_parquet([{}], filename=true, file_row_number=true) p JOIN (VALUES {}) c(file_name, first_row) ON right(p.filename, length(c.file_name)) = c.file_name",
            paths.join(", "), offsets.join(", ")
        )).map_err(duckdb_error)?;
        (context.progress)(0)
    }
    fn native_query_types(&self) -> bool {
        true
    }
    fn prepared_artifact_path(&self) -> Option<&Path> {
        // The engine authorizes the containing private result lease directory.
        Some(&self.path)
    }
    fn sparse_query_values(
        &self,
        ids: &[u64],
        columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        self.read_rows(ids, columns, false)
    }
    fn copy_query_values(
        &self,
        ids: &[u64],
        columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        self.read_rows(ids, columns, true)
    }
}

impl SqlSnapshotProvider {
    fn read_rows(
        &self,
        ids: &[u64],
        columns: &[String],
        full: bool,
    ) -> Result<QueryExactValues, DataError> {
        if !self.result.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let indices = columns
            .iter()
            .map(|column| {
                self.result
                    .columns
                    .iter()
                    .position(|candidate| candidate.id == *column)
                    .ok_or_else(|| invalid("Unknown SQL result projection column."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        let projection = indices
            .iter()
            .map(|index| {
                sorted
                    .binary_search(index)
                    .map_err(|_| invalid("Invalid SQL result projection."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut groups: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
        for (out, row) in ids.iter().copied().enumerate() {
            let chunk = self
                .result
                .chunks
                .partition_point(|chunk| chunk.offset + chunk.rows <= row);
            let source = self
                .result
                .chunks
                .get(chunk)
                .filter(|source| source.offset <= row)
                .ok_or_else(|| error("SQL result view contains an invalid row identity."))?;
            groups
                .entry(chunk)
                .or_default()
                .push(((row - source.offset) as usize, out));
        }
        let mut rows = vec![Vec::new(); ids.len()];
        let mut bytes = 0_usize;
        for (chunk_index, mut group) in groups {
            group.sort_unstable();
            let chunk = &self.result.chunks[chunk_index];
            let builder = export::reader_builder(&self.result, &chunk.file)?;
            let mask = ProjectionMask::roots(builder.parquet_schema(), sorted.clone());
            let selection = RowSelection::from_consecutive_ranges(
                group.iter().map(|(row, _)| *row..*row + 1),
                chunk.rows as usize,
            );
            let reader = builder
                .with_projection(mask)
                .with_row_selection(selection)
                .with_batch_size(128)
                .build()
                .map_err(|err| error(err.to_string()))?;
            let mut positions = group.into_iter();
            for batch in reader {
                let batch = batch.map_err(|err| error(err.to_string()))?;
                for row in 0..batch.num_rows() {
                    let (_, out) = positions
                        .next()
                        .ok_or_else(|| error("Unexpected SQL result view row."))?;
                    let values = projection
                        .iter()
                        .map(|&index| {
                            let array = batch.column(index).as_ref();
                            if full {
                                crate::data::value_format::full_value_at(array, row)
                            } else {
                                crate::data::value_format::value_at(array, row)
                            }
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    bytes =
                        bytes.saturating_add(estimated_page_bytes(std::slice::from_ref(&values)));
                    if bytes > PAGE_BYTES {
                        return Err(invalid(PAGE_LIMIT_ERROR));
                    }
                    rows[out] = values;
                }
            }
            if positions.next().is_some() {
                return Err(error("SQL result view did not return every requested row."));
            }
            if !self.result.alive.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
        }
        Ok(QueryExactValues {
            columns: columns.to_vec(),
            rows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_snapshot(service: &Arc<QueryService>, run: &str, sql: &str) -> String {
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
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = service.sql_status(run).unwrap();
            if terminal(status.state) {
                assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
                return status.result_id.unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_for_view(service: &QueryService, id: &str, view: &str) -> QueryStatus {
        let status = wait_for_terminal_view(service, id, view);
        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        status
    }

    fn wait_for_terminal_view(service: &QueryService, id: &str, view: &str) -> QueryStatus {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = service.sql_result_view_status("run", id, view).unwrap();
            match status.state {
                QueryTaskState::Complete | QueryTaskState::Failed | QueryTaskState::Cancelled => {
                    return status;
                }
                _ => {}
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn empty_plan() -> QueryPlan {
        QueryPlan {
            filters: vec![],
            search: None,
            sort: vec![],
            projection: vec![],
        }
    }

    #[test]
    fn export_type_restoration_preserves_storage_and_rejects_lossy_pairs() {
        let seconds: ArrayRef = Arc::new(Int64Array::from(vec![Some(-1), None, Some(i64::MAX)]));
        let seconds_type = DataType::Timestamp(TimeUnit::Second, None);
        let restored = restore_export_column(&seconds, &seconds_type).unwrap();
        assert_eq!(
            restored
                .as_any()
                .downcast_ref::<TimestampSecondArray>()
                .unwrap(),
            &TimestampSecondArray::from(vec![Some(-1), None, Some(i64::MAX)]),
        );
        assert!(Arc::ptr_eq(
            &restored,
            &restore_export_column(&restored, &seconds_type).unwrap()
        ));

        let micros: ArrayRef = Arc::new(TimestampMicrosecondArray::from(vec![
            Some(-1_001_000),
            None,
            Some(2_003_000),
        ]));
        let millis_type = DataType::Timestamp(TimeUnit::Millisecond, None);
        assert_eq!(
            restore_export_column(&micros, &millis_type)
                .unwrap()
                .as_any()
                .downcast_ref::<arrow_array::TimestampMillisecondArray>()
                .unwrap(),
            &arrow_array::TimestampMillisecondArray::from(vec![Some(-1_001), None, Some(2_003),]),
        );
        let lossy: ArrayRef = Arc::new(TimestampMicrosecondArray::from(vec![Some(-1001)]));
        assert!(restore_export_column(&lossy, &millis_type).is_err());
        assert!(restore_export_column(&seconds, &DataType::UInt64).is_err());
    }

    #[test]
    fn p23_timestamp_seconds_filter_uses_exact_epoch_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
        let id = start_snapshot(
            &service,
            "run",
            "
            SELECT * FROM (VALUES
                (1, '1969-12-31 23:59:59'::TIMESTAMP_S),
                (2, '1970-01-01 00:00:00'::TIMESTAMP_S),
                (3, '1970-01-01 00:00:01'::TIMESTAMP_S),
                (4, '2500-01-01 00:00:00'::TIMESTAMP_S),
                (5, NULL::TIMESTAMP_S)
            ) t(id, event_time) ORDER BY id",
        );
        for (operator, values, expected) in [
            (
                FilterOperator::Equals,
                vec!["1969-12-31 23:59:59Z"],
                vec!["1"],
            ),
            (
                FilterOperator::Equals,
                vec!["1970-01-01 00:00:00.000000001Z"],
                vec![],
            ),
            (
                FilterOperator::Between,
                vec!["1969-12-31 23:59:59.000000001Z", "1970-01-01 00:00:01Z"],
                vec!["2", "3"],
            ),
            (FilterOperator::Equals, vec!["2500-01-01 00:00"], vec!["4"]),
            (FilterOperator::IsNull, vec![], vec!["5"]),
        ] {
            let mut plan = empty_plan();
            plan.filters.push(QueryFilter {
                id: "timestamp".to_owned(),
                column_id: "r1".to_owned(),
                scalar_type: QueryScalarType::Timestamp,
                operator,
                values: values.into_iter().map(str::to_owned).collect(),
            });
            service
                .start_sql_result_view("run", &id, "view", plan)
                .unwrap();
            wait_for_view(&service, &id, "view");
            let page = service
                .read_sql_result_view_page(
                    &SqlPageRequest {
                        run_id: "run".to_owned(),
                        result_id: id.clone(),
                        offset: 0,
                        limit: 10,
                        columns: vec!["r0".to_owned()],
                    },
                    "view",
                )
                .unwrap();
            assert_eq!(
                page.rows
                    .iter()
                    .map(|row| row[0].display.as_deref().unwrap())
                    .collect::<Vec<_>>(),
                expected
            );
            service.release_sql_result_view("run", &id, "view").unwrap();
        }
    }

    #[test]
    fn p23_typed_filter_sort_find_copy_and_export_share_snapshot_order() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
        let id = start_snapshot(&service, "run", "
            SELECT seq AS same, city AS same, n, d, t FROM (
                VALUES
                  (0, '서울', 1::UBIGINT, 1.1001, TIMESTAMP_NS '2024-01-01 00:00:00.123456789'),
                  (1, '서울', 9007199254740993::UBIGINT, 2.2002, TIMESTAMP_NS '2024-01-01 00:00:00.123456789'),
                  (2, '서울', 18446744073709551615::UBIGINT, 3.3003, TIMESTAMP_NS '2024-01-01 00:00:00.123456789'),
                  (3, '부산', 18446744073709551615::UBIGINT, 4.4004, TIMESTAMP_NS '2024-01-01 00:00:00.123456789'),
                  (4, '서울', NULL::UBIGINT, 5.5005, TIMESTAMP_NS '2024-01-01 00:00:00.123456789')
            ) v(seq, city, n, d, t) ORDER BY seq");
        let plan = QueryPlan {
            filters: vec![
                QueryFilter {
                    id: "large".to_owned(),
                    column_id: "r2".to_owned(),
                    scalar_type: QueryScalarType::Number,
                    operator: FilterOperator::GreaterThan,
                    values: vec!["9007199254740992".to_owned()],
                },
                QueryFilter {
                    id: "decimal".to_owned(),
                    column_id: "r3".to_owned(),
                    scalar_type: QueryScalarType::Decimal,
                    operator: FilterOperator::GreaterThan,
                    values: vec!["2.2001".to_owned()],
                },
            ],
            search: Some(QuerySearch {
                text: "서울".to_owned(),
                mode: QuerySearchMode::Find,
                exact: true,
                case_sensitive: false,
                target_column_ids: vec!["r1".to_owned()],
            }),
            sort: vec![QuerySort {
                column_id: "r2".to_owned(),
                direction: QuerySortDirection::Descending,
                nulls_last: true,
            }],
            projection: vec!["r0".to_owned()],
        };
        let started = service
            .start_sql_result_view("run", &id, "view", plan)
            .unwrap();
        assert_eq!(started.document_id, PUBLIC_DOCUMENT);
        assert_eq!(started.session_id, id);
        assert_eq!(started.task_id, "view");
        let status = wait_for_view(&service, &id, "view");
        assert_eq!(status.find_match_count, Some(2));
        assert_eq!(status.progress.result_rows, 3);
        let page = service
            .read_sql_result_view_page(
                &SqlPageRequest {
                    run_id: "run".to_owned(),
                    result_id: id.clone(),
                    offset: 1,
                    limit: 2,
                    columns: vec!["r2".to_owned(), "r0".to_owned()],
                },
                "view",
            )
            .unwrap();
        let display =
            |row: usize, column: usize| page.rows[row][column].display.as_deref().unwrap();
        assert_eq!(display(0, 1), "3");
        assert_eq!(display(1, 1), "1");
        assert_eq!(display(0, 0), "18446744073709551615");
        assert_eq!(display(1, 0), "9007199254740993");
        let matched = service
            .find_sql_result_view_match(
                "run",
                &id,
                "view",
                FindQueryMatchRequest {
                    document_id: PUBLIC_DOCUMENT.to_owned(),
                    session_id: id.clone(),
                    query_id: "view".to_owned(),
                    from_result_offset: 0,
                    from_match_index: None,
                    direction: FindDirection::Next,
                    wrap: true,
                },
            )
            .unwrap()
            .matched
            .unwrap();
        assert_eq!((matched.row_offset, matched.column_id.as_str()), (2, "r1"));
        let (copy, _) = service
            .sql_result_view_copy_context("run", &id, "view", "p23-copy", 1024)
            .unwrap();
        let columns = ["r0".to_owned(), "r1".to_owned()];
        assert_eq!(copy.column_headers(&columns).unwrap(), ["same", "same"]);
        assert_eq!(
            copy.read_rows(0, 1, &columns).unwrap().rows[0][0]
                .display
                .as_deref(),
            Some("2")
        );
        for (format, extension, delimiter) in [
            (SqlExportFormat::Csv, "csv", ','),
            (SqlExportFormat::Tsv, "tsv", '\t'),
        ] {
            let path = directory.path().join(format!("out.{extension}"));
            service
                .export_sql_result_view("run", &id, "view", format, &path)
                .unwrap();
            let text = fs::read_to_string(path).unwrap();
            let lines = text.split("\r\n").collect::<Vec<_>>();
            assert_eq!(
                lines[0],
                ["\u{feff}same", "same", "n", "d", "t"].join(&delimiter.to_string())
            );
            assert!(lines[1].starts_with(&format!(
                "2{delimiter}서울{delimiter}18446744073709551615{delimiter}3.3003{delimiter}"
            )));
            assert!(lines[1].ends_with("1704067200123456789 [unit=ns]"));
            assert!(lines[2].starts_with(&format!("3{delimiter}부산")));
            assert!(lines[3].starts_with(&format!("1{delimiter}서울")));
            assert_eq!(lines.len(), 5);
        }
        let path = directory.path().join("out.parquet");
        service
            .export_sql_result_view("run", &id, "view", SqlExportFormat::Parquet, &path)
            .unwrap();
        let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap()).unwrap();
        assert_eq!(builder.schema().field(0).name(), "same");
        assert_eq!(builder.schema().field(1).name(), "same");
        assert_eq!(
            *builder.schema().field(2).data_type(),
            arrow_schema::DataType::UInt64
        );
        assert_eq!(builder.metadata().file_metadata().num_rows(), 3);
        service.release_sql_result_view("run", &id, "view").unwrap();
        assert!(copy.validate_current().is_err());
        assert!(service.sql_result_view_status("run", &id, "view").is_err());
        assert_eq!(
            service
                .read_sql_cell("run", &id, 0, "r0")
                .unwrap()
                .display
                .as_deref(),
            Some("0")
        );
    }

    #[test]
    fn p23_view_limit_and_parent_release_clean_index_identities() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
        let id = start_snapshot(&service, "run", "SELECT 42 AS answer WHERE false");
        let mut invalid = empty_plan();
        invalid.projection.push("unknown-column".to_owned());
        assert!(service
            .start_sql_result_view("run", &id, "invalid", invalid)
            .is_err());
        assert!(service.query_epochs.lock().unwrap().is_empty());
        for view in ["a", "b", "c"] {
            service
                .start_sql_result_view("run", &id, view, empty_plan())
                .unwrap();
        }
        assert!(service
            .start_sql_result_view("run", &id, "a", empty_plan())
            .is_err());
        assert!(service
            .start_sql_result_view("run", &id, "d", empty_plan())
            .is_err());
        assert!(service.sql_result_view_status("foreign", &id, "a").is_err());
        for view in ["a", "b", "c"] {
            assert_eq!(wait_for_view(&service, &id, view).progress.result_rows, 0);
        }
        let (copy, _) = service
            .sql_result_view_copy_context("run", &id, "a", "p23-room-for-copy", 256 * 1024 * 1024)
            .unwrap();
        copy.validate_staging_bytes(256 * 1024 * 1024).unwrap();
        drop(copy);
        let output = directory.path().join("empty.parquet");
        service
            .export_sql_result_view("run", &id, "a", SqlExportFormat::Parquet, &output)
            .unwrap();
        let reader = ParquetRecordBatchReaderBuilder::try_new(File::open(output).unwrap()).unwrap();
        assert_eq!(reader.metadata().file_metadata().num_rows(), 0);
        assert_eq!(
            *reader.schema().field(0).data_type(),
            arrow_schema::DataType::Int32
        );
        service.release_sql_result("run", &id).unwrap();
        assert!(service.sql_result_view_status("run", &id, "a").is_err());
        assert!(service.query_epochs.lock().unwrap().is_empty());
        assert!(service.results.lock().unwrap().is_empty());
    }

    #[test]
    fn p23_cross_chunk_row_identity_survives_sort_and_failed_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let service =
            Arc::new(QueryService::open(directory.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
        let id = start_snapshot(
            &service,
            "run",
            "SELECT i::UBIGINT AS n FROM range(32870) AS t(i) ORDER BY i",
        );
        assert!(service.sql_result("run", &id).unwrap().chunks.len() > 1);
        let mut sorted = empty_plan();
        sorted.sort.push(QuerySort {
            column_id: "r0".to_owned(),
            direction: QuerySortDirection::Descending,
            nulls_last: true,
        });
        service
            .start_sql_result_view("run", &id, "committed", sorted.clone())
            .unwrap();
        assert_eq!(
            wait_for_view(&service, &id, "committed")
                .progress
                .result_rows,
            32_870
        );
        sorted.filters.push(QueryFilter {
            id: "overflow".to_owned(),
            column_id: "r0".to_owned(),
            scalar_type: QueryScalarType::Number,
            operator: FilterOperator::Equals,
            values: vec!["18446744073709551616".to_owned()],
        });
        service
            .start_sql_result_view("run", &id, "failed", sorted)
            .unwrap();
        let failure = wait_for_terminal_view(&service, &id, "failed");
        assert_eq!(failure.state, QueryTaskState::Failed);
        service
            .release_sql_result_view("run", &id, "failed")
            .unwrap();
        assert_eq!(service.query_epochs.lock().unwrap().len(), 1);
        let page = service
            .read_sql_result_view_page(
                &SqlPageRequest {
                    run_id: "run".to_owned(),
                    result_id: id.clone(),
                    offset: 101,
                    limit: 5,
                    columns: vec!["r0".to_owned()],
                },
                "committed",
            )
            .unwrap();
        let values = page
            .rows
            .iter()
            .map(|row| row[0].display.as_deref().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values, ["32768", "32767", "32766", "32765", "32764"]);
        service.release_sql_result("run", &id).unwrap();
        assert!(service.query_epochs.lock().unwrap().is_empty());
    }
}
