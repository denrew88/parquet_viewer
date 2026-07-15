use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
};

use duckdb::{
    core::{DataChunkHandle, Inserter, LogicalTypeId},
    ffi::duckdb_string_t,
    params, params_from_iter,
    types::DuckString,
    vscalar::{ScalarFunctionSignature, VScalar},
    vtab::arrow::WritableVector,
    Config, Connection, InterruptHandle, OptionalExt,
};

use crate::{
    data::{
        query_invalid_name as invalid_name, query_quote_identifier as quote_identifier,
        query_quote_literal as quote_literal, query_raw_name as raw_name, QueryPrepareContext,
        QuerySourceSpec,
    },
    domain::{
        DataError, DataErrorCode, DataPage, DataValue, DistinctValue, DistinctValuesRequest,
        DistinctValuesResponse, ExecuteQueryRequest, FindDirection, FindQueryMatch,
        FindQueryMatchRequest, FindQueryMatchResponse, QueryProgress, QueryStatus, QueryTaskState,
        ReadQueryPageRequest, ReadQueryPageResponse, ValueKind,
    },
    storage::{QueryTempCleanupResult, QueryTempLease, QueryTempManager, QueryTempUsage},
};

use super::sql::{
    find_matches_sql, materialize_sql, output_invalid_name, output_raw_name, scalar_lower_sql,
    SCALAR_LOWER_FUNCTION,
};

const MAX_QUERY_TASKS: usize = 128;
const MAX_QUERY_RESULTS: usize = 64;
const MAX_CONCURRENT_QUERIES: usize = 2;

struct ScalarLower;

impl VScalar for ScalarLower {
    type State = ();

    fn invoke(
        _: &Self::State,
        input: &mut DataChunkHandle,
        output: &mut dyn WritableVector,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let len = input.len();
        let values = input.flat_vector(0);
        let strings = unsafe { values.as_slice_with_len::<duckdb_string_t>(len) };
        let mut output = output.flat_vector();

        for (index, string) in strings.iter().enumerate() {
            if values.row_is_null(index as u64) {
                output.set_null(index);
                continue;
            }
            let mut string = *string;
            let value = DuckString::new(&mut string).as_str();
            let lowered = value
                .chars()
                .flat_map(char::to_lowercase)
                .collect::<String>();
            output.insert(index, &lowered);
        }
        Ok(())
    }

    fn signatures() -> Vec<ScalarFunctionSignature> {
        vec![ScalarFunctionSignature::exact(
            vec![LogicalTypeId::Varchar.into()],
            LogicalTypeId::Varchar.into(),
        )]
    }
}

#[derive(Debug, Default)]
struct QueryLimiter {
    active: Mutex<usize>,
    changed: Condvar,
}

struct QueryPermit(&'static QueryLimiter);

struct QueryBudgetMonitor {
    stop: Arc<AtomicBool>,
    violation: Arc<Mutex<Option<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl QueryBudgetMonitor {
    fn start(temp: Arc<QueryTempManager>, interrupt: Arc<InterruptHandle>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let violation = Arc::new(Mutex::new(None));
        let worker_stop = Arc::clone(&stop);
        let worker_violation = Arc::clone(&violation);
        let worker = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                if let Ok(Some(message)) = temp.budget_violation() {
                    if let Ok(mut violation) = worker_violation.lock() {
                        *violation = Some(message);
                    }
                    interrupt.interrupt();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        Self {
            stop,
            violation,
            worker: Some(worker),
        }
    }

    fn check(&self) -> Result<(), DataError> {
        if let Some(message) = self.violation.lock().map_err(|_| registry_error())?.clone() {
            Err(DataError::query_temp_limit(message))
        } else {
            Ok(())
        }
    }

    fn violated(&self) -> bool {
        self.violation.lock().is_ok_and(|value| value.is_some())
    }
}

impl Drop for QueryBudgetMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for QueryPermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.changed.notify_one();
        }
    }
}

struct QueryTask {
    status: Mutex<QueryStatus>,
    cancel: AtomicBool,
    interrupt: Mutex<Option<Arc<InterruptHandle>>>,
    started: std::time::Instant,
}

#[derive(Debug)]
struct ResultColumn {
    name: String,
    kind: ValueKind,
}

#[derive(Debug)]
struct QueryResult {
    document_id: String,
    session_id: String,
    columns: Vec<ResultColumn>,
    row_count: u64,
    find_match_count: Option<u64>,
    provider: Arc<dyn crate::data::QueryInputProvider>,
    connection: Mutex<Connection>,
    _lease: QueryTempLease,
}

pub struct QueryService {
    tasks: Mutex<HashMap<(String, String, String), Arc<QueryTask>>>,
    statuses: Mutex<HashMap<(String, String, String), QueryStatus>>,
    results: Mutex<HashMap<(String, String, String), Arc<QueryResult>>>,
    next_distinct_id: AtomicU64,
    shutting_down: AtomicBool,
    // Drop after result connections and leases have released their files.
    temp: Arc<QueryTempManager>,
}

impl QueryService {
    pub fn open(local_data: impl Into<std::path::PathBuf>, limit: u64) -> Result<Self, DataError> {
        Ok(Self {
            tasks: Mutex::new(HashMap::new()),
            statuses: Mutex::new(HashMap::new()),
            results: Mutex::new(HashMap::new()),
            next_distinct_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            temp: Arc::new(QueryTempManager::open(local_data, limit)?),
        })
    }

    pub fn set_temp_limit(&self, limit: u64) {
        self.temp.set_limit(limit);
    }

    pub fn execute(
        self: &Arc<Self>,
        request: ExecuteQueryRequest,
        source: QuerySourceSpec,
    ) -> Result<QueryStatus, DataError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(DataError::query_failed(
                "The query service is shutting down.",
            ));
        }
        validate_id("query", &request.query_id)?;
        validate_id("task", &request.task_id)?;
        self.drop_session_results(&request.document_id, &request.session_id, true)?;
        let projected = projected_columns(&source, &request.plan.projection);
        let status = QueryStatus {
            document_id: request.document_id.clone(),
            session_id: request.session_id.clone(),
            query_id: request.query_id.clone(),
            task_id: request.task_id.clone(),
            state: QueryTaskState::Queued,
            progress: QueryProgress {
                rows_scanned: 0,
                total_rows: source.total_rows,
                result_rows: 0,
            },
            columns: projected.iter().map(|column| column.name.clone()).collect(),
            elapsed_ms: 0,
            find_match_count: None,
            error: None,
        };
        let task = Arc::new(QueryTask {
            status: Mutex::new(status.clone()),
            cancel: AtomicBool::new(false),
            interrupt: Mutex::new(None),
            started: std::time::Instant::now(),
        });
        {
            let mut tasks = self.tasks.lock().map_err(|_| registry_error())?;
            tasks.retain(|_, task| {
                task.status.lock().is_ok_and(|status| {
                    matches!(
                        status.state,
                        QueryTaskState::Queued
                            | QueryTaskState::Running
                            | QueryTaskState::Cancelling
                    )
                })
            });
            if tasks.len() >= MAX_QUERY_TASKS {
                return Err(DataError::invalid_request(
                    "Too many query tasks are retained.",
                ));
            }
            let key = task_key(&request.document_id, &request.session_id, &request.task_id);
            if tasks.contains_key(&key) {
                return Err(DataError::invalid_request(format!(
                    "Query task ID has already been used: {}",
                    request.task_id
                )));
            }
            tasks.insert(key, Arc::clone(&task));
        }
        let service = Arc::clone(self);
        std::thread::spawn(move || service.run_query(request, source, task));
        Ok(status)
    }

    pub fn status(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
        task_id: &str,
    ) -> Result<QueryStatus, DataError> {
        let key = task_key(document_id, session_id, task_id);
        let tasks = self.tasks.lock().map_err(|_| registry_error())?;
        let status = if let Some(task) = tasks.get(&key) {
            let mut status = task.status.lock().map_err(|_| registry_error())?.clone();
            status.elapsed_ms = elapsed_ms(task.started);
            status
        } else {
            drop(tasks);
            self.statuses
                .lock()
                .map_err(|_| registry_error())?
                .get(&key)
                .cloned()
                .ok_or_else(|| DataError::query_not_found(query_id))?
        };
        require_identity(&status, document_id, session_id, query_id)?;
        Ok(status)
    }

    pub fn cancel(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
        task_id: &str,
    ) -> Result<QueryStatus, DataError> {
        let task = {
            let key = task_key(document_id, session_id, task_id);
            let tasks = self.tasks.lock().map_err(|_| registry_error())?;
            if let Some(task) = tasks.get(&key) {
                Arc::clone(task)
            } else {
                drop(tasks);
                return self
                    .statuses
                    .lock()
                    .map_err(|_| registry_error())?
                    .get(&key)
                    .cloned()
                    .ok_or_else(|| DataError::query_not_found(query_id));
            }
        };
        {
            let mut status = task.status.lock().map_err(|_| registry_error())?;
            require_identity(&status, document_id, session_id, query_id)?;
            if matches!(
                status.state,
                QueryTaskState::Queued | QueryTaskState::Running
            ) {
                status.state = QueryTaskState::Cancelling;
            }
        }
        task.cancel.store(true, Ordering::Release);
        if let Some(interrupt) = task
            .interrupt
            .lock()
            .map_err(|_| registry_error())?
            .as_ref()
        {
            interrupt.interrupt();
        }
        let status = task.status.lock().map_err(|_| registry_error())?.clone();
        Ok(status)
    }

    pub fn read_page(
        &self,
        request: ReadQueryPageRequest,
    ) -> Result<ReadQueryPageResponse, DataError> {
        if request.offset < 0 || !(1..=200).contains(&request.limit) {
            return Err(DataError::invalid_request(
                "Query page offset must be non-negative and limit must be 1 to 200.",
            ));
        }
        let result = self.result(&request.document_id, &request.session_id, &request.query_id)?;
        let page = result.read_page(request.offset as u64, request.limit)?;
        Ok(ReadQueryPageResponse {
            document_id: request.document_id,
            session_id: request.session_id,
            query_id: request.query_id,
            page,
        })
    }

    pub fn distinct(
        &self,
        request: DistinctValuesRequest,
        source: Option<QuerySourceSpec>,
    ) -> Result<DistinctValuesResponse, DataError> {
        if !(1..=200).contains(&request.limit)
            || request
                .search
                .as_ref()
                .is_some_and(|search| search.len() > 4096)
        {
            return Err(DataError::invalid_request(
                "Distinct limit must be 1 to 200 and search at most 4096 characters.",
            ));
        }
        match &request.query_id {
            Some(query_id) => self
                .result(&request.document_id, &request.session_id, query_id)?
                .distinct(&request),
            None => self.distinct_source(
                request,
                source.ok_or_else(|| {
                    DataError::invalid_request("A source is required for source distinct values.")
                })?,
            ),
        }
    }

    pub fn find_match(
        &self,
        request: FindQueryMatchRequest,
    ) -> Result<FindQueryMatchResponse, DataError> {
        self.result(&request.document_id, &request.session_id, &request.query_id)?
            .find_match(request)
    }

    pub fn drop_session(&self, document_id: &str, session_id: &str) -> Result<(), DataError> {
        self.drop_session_results(document_id, session_id, true)
    }

    pub fn usage(&self) -> Result<QueryTempUsage, DataError> {
        self.temp.usage()
    }

    pub fn clear_temp(&self) -> Result<QueryTempCleanupResult, DataError> {
        self.temp.clear_inactive()
    }

    pub fn shutdown(&self) {
        self.shutdown_with_timeout(std::time::Duration::from_secs(3));
    }

    #[cfg(test)]
    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    fn shutdown_with_timeout(&self, timeout: std::time::Duration) {
        self.shutting_down.store(true, Ordering::Release);
        let deadline = std::time::Instant::now() + timeout;
        let mut tasks_stopped = false;
        loop {
            let tasks = match self.tasks.lock() {
                Ok(tasks) => tasks.values().cloned().collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            };
            if tasks.is_empty() {
                tasks_stopped = true;
                break;
            }
            for task in tasks {
                task.cancel.store(true, Ordering::Release);
                if let Ok(interrupt) = task.interrupt.lock() {
                    if let Some(interrupt) = interrupt.as_ref() {
                        interrupt.interrupt();
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if let Ok(mut results) = self.results.lock() {
            results.clear();
        }
        if tasks_stopped {
            self.temp
                .shutdown_cleanup(deadline.saturating_duration_since(std::time::Instant::now()));
        }
    }

    fn run_query(
        &self,
        request: ExecuteQueryRequest,
        source: QuerySourceSpec,
        task: Arc<QueryTask>,
    ) {
        let Some(_permit) = acquire_query_permit(&task.cancel) else {
            set_task_state(&task, QueryTaskState::Cancelled, None);
            self.finish_task(&request, &task);
            return;
        };
        set_task_state(&task, QueryTaskState::Running, None);
        let result = self.build_result(&request, &source, &task);
        match result {
            Ok(result) if !task.cancel.load(Ordering::Acquire) => {
                let row_count = result.row_count;
                let find_match_count = result.find_match_count;
                match self.results.lock() {
                    Ok(mut results) => {
                        if results.len() >= MAX_QUERY_RESULTS {
                            if let Some(key) = results.keys().next().cloned() {
                                results.remove(&key);
                            }
                        }
                        results.insert(
                            result_key(
                                &request.document_id,
                                &request.session_id,
                                &request.query_id,
                            ),
                            Arc::new(result),
                        );
                        if let Ok(mut status) = task.status.lock() {
                            status.state = QueryTaskState::Complete;
                            status.progress.rows_scanned = source.total_rows.unwrap_or(row_count);
                            status.progress.result_rows = row_count;
                            status.find_match_count = find_match_count;
                            status.elapsed_ms = elapsed_ms(task.started);
                        }
                    }
                    Err(_) => set_task_state(&task, QueryTaskState::Failed, Some(registry_error())),
                }
            }
            Ok(_) => set_task_state(&task, QueryTaskState::Cancelled, None),
            Err(error)
                if task.cancel.load(Ordering::Acquire)
                    || error.code == DataErrorCode::TaskCancelled =>
            {
                set_task_state(&task, QueryTaskState::Cancelled, None)
            }
            Err(error) => set_task_state(&task, QueryTaskState::Failed, Some(error)),
        }
        self.finish_task(&request, &task);
    }

    fn build_result(
        &self,
        request: &ExecuteQueryRequest,
        source: &QuerySourceSpec,
        task: &QueryTask,
    ) -> Result<QueryResult, DataError> {
        let lease = self
            .temp
            .allocate(&request.document_id, &request.query_id)?;
        let connection = open_connection(
            source,
            lease.path(),
            self.temp.usage()?.limit_bytes / MAX_CONCURRENT_QUERIES as u64,
        )?;
        let interrupt = connection.interrupt_handle();
        *task.interrupt.lock().map_err(|_| registry_error())? = Some(interrupt.clone());
        if task.cancel.load(Ordering::Acquire) {
            interrupt.interrupt();
            return Err(DataError::task_cancelled());
        }
        let budget = QueryBudgetMonitor::start(Arc::clone(&self.temp), interrupt);
        let prepared = prepare_source(&connection, source, &task.cancel, Some(task), &budget);
        if prepared.is_err() && budget.violated() {
            budget.check()?;
        }
        prepared?;
        let materialized = materialize_sql(source, &request.plan);
        let materialized_result = connection
            .execute(
                &materialized.sql,
                params_from_iter(materialized.parameters.iter()),
            )
            .map_err(duckdb_error);
        if materialized_result.is_err() && budget.violated() {
            budget.check()?;
        }
        materialized_result?;
        let find_match_count =
            if let Some((sql, parameters)) = find_matches_sql(source, &request.plan) {
                connection
                    .execute(&sql, params_from_iter(parameters.iter()))
                    .map_err(duckdb_error)?;
                Some(
                    connection
                        .query_row("SELECT count(*) FROM query_find_matches", [], |row| {
                            row.get(0)
                        })
                        .map_err(duckdb_error)?,
                )
            } else {
                None
            };
        budget.check()?;
        let row_count = connection
            .query_row("SELECT count(*) FROM query_result", [], |row| row.get(0))
            .map_err(duckdb_error)?;
        let columns = materialized
            .columns
            .iter()
            .map(|index| ResultColumn {
                name: source.columns[*index].name.clone(),
                kind: value_kind(&source.columns[*index]),
            })
            .collect();
        Ok(QueryResult {
            document_id: request.document_id.clone(),
            session_id: request.session_id.clone(),
            columns,
            row_count,
            find_match_count,
            provider: Arc::clone(&source.provider),
            connection: Mutex::new(connection),
            _lease: lease,
        })
    }

    fn finish_task(&self, request: &ExecuteQueryRequest, task: &QueryTask) {
        if let Ok(mut interrupt) = task.interrupt.lock() {
            interrupt.take();
        }
        let key = task_key(&request.document_id, &request.session_id, &request.task_id);
        if let Ok(status) = task.status.lock().map(|status| status.clone()) {
            if let Ok(mut statuses) = self.statuses.lock() {
                if statuses.len() >= MAX_QUERY_TASKS {
                    if let Some(oldest) = statuses.keys().next().cloned() {
                        statuses.remove(&oldest);
                    }
                }
                statuses.insert(key.clone(), status);
            }
        }
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(&key);
        }
    }

    fn result(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
    ) -> Result<Arc<QueryResult>, DataError> {
        let results = self.results.lock().map_err(|_| registry_error())?;
        let result = Arc::clone(
            results
                .get(&result_key(document_id, session_id, query_id))
                .ok_or_else(|| DataError::query_not_found(query_id))?,
        );
        if result.document_id != document_id || result.session_id != session_id {
            return Err(DataError::query_not_found(query_id));
        }
        Ok(result)
    }

    fn distinct_source(
        &self,
        request: DistinctValuesRequest,
        source: QuerySourceSpec,
    ) -> Result<DistinctValuesResponse, DataError> {
        if !source
            .columns
            .iter()
            .any(|column| column.name == request.column_id)
        {
            return Err(DataError::invalid_request(format!(
                "Unknown distinct column: {}",
                request.column_id
            )));
        }
        let id = format!(
            "distinct-{}",
            self.next_distinct_id.fetch_add(1, Ordering::Relaxed)
        );
        let lease = self.temp.allocate(&request.document_id, &id)?;
        let connection = open_connection(
            &source,
            lease.path(),
            self.temp.usage()?.limit_bytes / MAX_CONCURRENT_QUERIES as u64,
        )?;
        let monitor =
            QueryBudgetMonitor::start(Arc::clone(&self.temp), connection.interrupt_handle());
        prepare_source(
            &connection,
            &source,
            &AtomicBool::new(false),
            None,
            &monitor,
        )?;
        let index = source
            .columns
            .iter()
            .position(|column| column.name == request.column_id)
            .expect("validated distinct column");
        distinct_query(
            &connection,
            &request,
            &quote_identifier(&request.column_id),
            &raw_name(index),
            &invalid_name(index),
        )
    }

    fn drop_session_results(
        &self,
        document_id: &str,
        session_id: &str,
        cancel_tasks: bool,
    ) -> Result<(), DataError> {
        if cancel_tasks {
            let tasks = self.tasks.lock().map_err(|_| registry_error())?;
            for task in tasks.values() {
                let matches = task.status.lock().is_ok_and(|status| {
                    status.document_id == document_id && status.session_id == session_id
                });
                if matches {
                    task.cancel.store(true, Ordering::Release);
                    if let Ok(interrupt) = task.interrupt.lock() {
                        if let Some(interrupt) = interrupt.as_ref() {
                            interrupt.interrupt();
                        }
                    }
                }
            }
        }
        self.results
            .lock()
            .map_err(|_| registry_error())?
            .retain(|_, result| {
                !(result.document_id == document_id && result.session_id == session_id)
            });
        self.statuses
            .lock()
            .map_err(|_| registry_error())?
            .retain(|(document, session, _), _| document != document_id || session != session_id);
        Ok(())
    }
}

impl QueryResult {
    fn read_page(&self, offset: u64, limit: usize) -> Result<DataPage, DataError> {
        let connection = self.connection.lock().map_err(|_| registry_error())?;
        let select = self
            .columns
            .iter()
            .enumerate()
            .flat_map(|(index, column)| {
                [
                    quote_identifier(&column.name),
                    output_raw_name(index),
                    output_invalid_name(index),
                ]
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection
            .prepare(&format!(
                "SELECT {select} FROM query_result WHERE __dv_result_position >= ? ORDER BY __dv_result_position LIMIT ?"
            ))
            .map_err(duckdb_error)?;
        let mut query = statement
            .query(params![offset, limit as u64])
            .map_err(duckdb_error)?;
        let mut rows = Vec::new();
        while let Some(row) = query.next().map_err(duckdb_error)? {
            let mut values = Vec::with_capacity(self.columns.len());
            for (index, column) in self.columns.iter().enumerate() {
                let display: Option<String> = row
                    .get::<_, Option<String>>(index * 3)
                    .map_err(duckdb_error)?
                    .map(|value| {
                        self.provider
                            .format_query_display(&column.name, column.kind, &value)
                    });
                let raw: Option<String> = row.get(index * 3 + 1).map_err(duckdb_error)?;
                let invalid: bool = row.get(index * 3 + 2).map_err(duckdb_error)?;
                values.push(result_value(column.kind, display, raw, invalid));
            }
            rows.push(values);
        }
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(self.row_count),
            has_more: offset.saturating_add(rows.len() as u64) < self.row_count,
            columns: self
                .columns
                .iter()
                .map(|column| column.name.clone())
                .collect(),
            rows,
        })
    }

    fn distinct(
        &self,
        request: &DistinctValuesRequest,
    ) -> Result<DistinctValuesResponse, DataError> {
        let index = self
            .columns
            .iter()
            .position(|column| column.name == request.column_id)
            .ok_or_else(|| {
                DataError::invalid_request(format!(
                    "Unknown query result column: {}",
                    request.column_id
                ))
            })?;
        let connection = self.connection.lock().map_err(|_| registry_error())?;
        distinct_query(
            &connection,
            request,
            &quote_identifier(&request.column_id),
            &output_raw_name(index),
            &output_invalid_name(index),
        )
    }

    fn find_match(
        &self,
        request: FindQueryMatchRequest,
    ) -> Result<FindQueryMatchResponse, DataError> {
        let total_matches = self.find_match_count.unwrap_or(0);
        if total_matches == 0 {
            return Ok(FindQueryMatchResponse {
                document_id: request.document_id,
                session_id: request.session_id,
                query_id: request.query_id,
                matched: None,
            });
        }
        let connection = self.connection.lock().map_err(|_| registry_error())?;
        let (comparison, order) = match request.direction {
            FindDirection::Next => (">", "ASC"),
            FindDirection::Previous => ("<", "DESC"),
        };
        let (seek_column, seek_value) = request.from_match_index.map_or(
            ("__dv_result_position", request.from_result_offset),
            |index| ("match_index", index),
        );
        let sql = format!("SELECT __dv_result_position, column_id, match_index FROM query_find_matches WHERE {seek_column} {comparison} ? ORDER BY match_index {order} LIMIT 1");
        let direct = connection
            .query_row(&sql, params![seek_value], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })
            .optional()
            .map_err(duckdb_error)?;
        let (found, wrapped) = if direct.is_some() || !request.wrap {
            (direct, false)
        } else {
            let found = connection
                .query_row(
                    &format!("SELECT __dv_result_position, column_id, match_index FROM query_find_matches ORDER BY __dv_result_position {order}, match_index {order} LIMIT 1"),
                    [],
                    |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?)),
                )
                .optional()
                .map_err(duckdb_error)?;
            (found, true)
        };
        Ok(FindQueryMatchResponse {
            document_id: request.document_id,
            session_id: request.session_id,
            query_id: request.query_id,
            matched: found.map(|(row_offset, column_id, match_index)| FindQueryMatch {
                row_offset,
                column_id,
                match_index,
                total_matches,
                wrapped,
            }),
        })
    }
}

fn distinct_query(
    connection: &Connection,
    request: &DistinctValuesRequest,
    value: &str,
    raw: &str,
    invalid: &str,
) -> Result<DistinctValuesResponse, DataError> {
    let mut parameters = Vec::new();
    let predicate = request.search.as_ref().map_or_else(String::new, |search| {
        parameters.push(search.clone());
        format!(
            "WHERE contains({}, {})",
            scalar_lower_sql(&format!("coalesce({raw}, CAST({value} AS VARCHAR))")),
            scalar_lower_sql("?")
        )
    });
    parameters.push((request.limit + 1).to_string());
    parameters.push(request.offset.to_string());
    let table = if request.query_id.is_some() {
        "query_result"
    } else {
        "dv_source"
    };
    let sql = format!(
        "SELECT CAST({value} AS VARCHAR), CAST({raw} AS VARCHAR), {invalid}, count(*) FROM {table} {predicate} GROUP BY ALL ORDER BY count(*) DESC, CAST({value} AS VARCHAR) NULLS LAST LIMIT CAST(? AS BIGINT) OFFSET CAST(? AS BIGINT)"
    );
    let mut statement = connection.prepare(&sql).map_err(duckdb_error)?;
    let mapped = statement
        .query_map(params_from_iter(parameters.iter()), |row| {
            let value: Option<String> = row.get(0)?;
            let raw: Option<String> = row.get(1)?;
            let is_invalid: bool = row.get(2)?;
            let is_null = !is_invalid && value.is_none();
            Ok(DistinctValue {
                value: if is_invalid { raw } else { value },
                is_null,
                is_invalid,
                count: row.get(3)?,
            })
        })
        .map_err(duckdb_error)?;
    let mut values = mapped
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(duckdb_error)?;
    let has_more = values.len() > request.limit;
    values.truncate(request.limit);
    Ok(DistinctValuesResponse {
        document_id: request.document_id.clone(),
        session_id: request.session_id.clone(),
        query_id: request.query_id.clone(),
        column_id: request.column_id.clone(),
        values,
        has_more,
    })
}

fn open_connection(
    source: &QuerySourceSpec,
    temp: &Path,
    temp_limit: u64,
) -> Result<Connection, DataError> {
    let threads = std::thread::available_parallelism()
        .map(|value| value.get().min(4))
        .unwrap_or(1) as i64;
    let config = Config::default()
        .enable_autoload_extension(false)
        .and_then(|config| config.with("allow_unsigned_extensions", "false"))
        .and_then(|config| config.max_memory("1GiB"))
        .and_then(|config| config.threads(threads))
        .map_err(duckdb_error)?;
    let connection = Connection::open_in_memory_with_flags(config).map_err(duckdb_error)?;
    connection
        .register_scalar_function::<ScalarLower>(SCALAR_LOWER_FUNCTION)
        .map_err(duckdb_error)?;
    let source_path = source.path.to_string_lossy().replace('\\', "/");
    let temp_path = temp.to_string_lossy().replace('\\', "/");
    connection
        .execute_batch(&format!(
            "SET allowed_paths = [{}]; SET allowed_directories = [{}]; SET temp_directory = {}; SET max_temp_directory_size = '{}B'; SET preserve_insertion_order = true; SET default_null_order = 'NULLS_LAST';",
            quote_literal(&source_path),
            quote_literal(&temp_path),
            quote_literal(&temp_path),
            temp_limit
        ))
        .map_err(duckdb_error)?;
    Ok(connection)
}

fn prepare_source(
    connection: &Connection,
    source: &QuerySourceSpec,
    cancel: &AtomicBool,
    task: Option<&QueryTask>,
    budget: &QueryBudgetMonitor,
) -> Result<(), DataError> {
    let mut progress = |rows_scanned| {
        budget.check()?;
        if let Some(task) = task {
            if let Ok(mut status) = task.status.lock() {
                status.progress.rows_scanned = rows_scanned;
                status.elapsed_ms = elapsed_ms(task.started);
            }
        }
        Ok(())
    };
    source.provider.prepare(QueryPrepareContext {
        connection,
        source,
        cancel,
        progress: &mut progress,
    })
}

fn projected_columns<'a>(
    source: &'a QuerySourceSpec,
    projection: &[String],
) -> Vec<&'a crate::domain::ColumnSchema> {
    if projection.is_empty() {
        source.columns.iter().collect()
    } else {
        projection
            .iter()
            .filter_map(|name| source.columns.iter().find(|column| &column.name == name))
            .collect()
    }
}

fn value_kind(column: &crate::domain::ColumnSchema) -> ValueKind {
    let logical = column.logical_type.to_ascii_lowercase();
    if logical.contains("timestamp") {
        ValueKind::Timestamp
    } else if logical == "date" || logical.contains("date32") || logical.contains("date64") {
        ValueKind::Date
    } else if logical.contains("decimal") {
        ValueKind::Decimal
    } else if logical.contains("bool") {
        ValueKind::Boolean
    } else if logical.contains("int") {
        ValueKind::Int
    } else if logical.contains("float") || logical.contains("double") {
        ValueKind::Float
    } else if logical.contains("string") || logical.contains("utf8") || logical == "text" {
        ValueKind::String
    } else {
        ValueKind::Unsupported
    }
}

fn result_value(
    kind: ValueKind,
    display: Option<String>,
    raw: Option<String>,
    invalid: bool,
) -> DataValue {
    if invalid {
        return DataValue::invalid(
            kind,
            raw.unwrap_or_default(),
            "CsvConversionFailed",
            "The raw CSV value could not be converted by the active profile.",
        );
    }
    match (display, raw) {
        (None, Some(raw)) => DataValue::converted_null(raw),
        (None, None) => DataValue::null(),
        (Some(_), Some(raw)) if raw.is_empty() => DataValue::empty(raw),
        (Some(display), Some(raw)) => DataValue::converted(kind, display, raw),
        (Some(display), None) => DataValue::displayed(kind, display),
    }
}

fn validate_id(label: &str, value: &str) -> Result<(), DataError> {
    if value.trim().is_empty() || value.len() > 128 {
        return Err(DataError::invalid_request(format!(
            "Query {label} ID must contain 1 to 128 characters."
        )));
    }
    Ok(())
}

fn elapsed_ms(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn acquire_query_permit(cancel: &AtomicBool) -> Option<QueryPermit> {
    static LIMITER: OnceLock<QueryLimiter> = OnceLock::new();
    let limiter = LIMITER.get_or_init(QueryLimiter::default);
    let mut active = limiter.active.lock().ok()?;
    loop {
        if cancel.load(Ordering::Acquire) {
            return None;
        }
        if *active < MAX_CONCURRENT_QUERIES {
            *active += 1;
            return Some(QueryPermit(limiter));
        }
        let (next, _) = limiter
            .changed
            .wait_timeout(active, std::time::Duration::from_millis(25))
            .ok()?;
        active = next;
    }
}

fn task_key(document_id: &str, session_id: &str, task_id: &str) -> (String, String, String) {
    (
        document_id.to_owned(),
        session_id.to_owned(),
        task_id.to_owned(),
    )
}

fn result_key(document_id: &str, session_id: &str, query_id: &str) -> (String, String, String) {
    (
        document_id.to_owned(),
        session_id.to_owned(),
        query_id.to_owned(),
    )
}

fn require_identity(
    status: &QueryStatus,
    document_id: &str,
    session_id: &str,
    query_id: &str,
) -> Result<(), DataError> {
    if status.document_id != document_id
        || status.session_id != session_id
        || status.query_id != query_id
    {
        return Err(DataError::query_not_found(query_id));
    }
    Ok(())
}

fn set_task_state(task: &QueryTask, state: QueryTaskState, error: Option<DataError>) {
    if let Ok(mut status) = task.status.lock() {
        status.state = state;
        status.error = error;
    }
}

fn registry_error() -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: String::from("The query registry is unavailable."),
    }
}

fn duckdb_error(error: duckdb::Error) -> DataError {
    let message = error.to_string();
    if message.contains("maximum amount of data stored")
        || message.contains("max_temp_directory_size")
    {
        DataError::query_temp_limit(message)
    } else if message.to_ascii_lowercase().contains("interrupt") {
        DataError::task_cancelled()
    } else {
        DataError::query_failed(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        data::{DataSource, QueryInputProvider, QueryPrepareContext},
        domain::{
            ColumnSchema, CsvProfileMode, CsvTargetType, DataValueState, FilterOperator,
            QueryFilter, QueryPlan, QueryScalarType, QuerySearch, QuerySearchMode, QuerySort,
            QuerySortDirection, DEFAULT_QUERY_TEMP_LIMIT_BYTES,
        },
    };

    #[derive(Debug)]
    struct SyntheticQueryProvider {
        called: Arc<AtomicBool>,
    }

    impl QueryInputProvider for SyntheticQueryProvider {
        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            self.called.store(true, Ordering::Release);
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source (__dv_row_id UBIGINT, value VARCHAR, __dv_raw_0 VARCHAR, __dv_invalid_0 BOOLEAN); INSERT INTO dv_source VALUES (0, 'provider-value', 'provider-value', false);",
                )
                .map_err(duckdb_error)?;
            (context.progress)(1)
        }
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/phase-9")
            .join(name)
    }

    fn phase7_fixture(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/phase-7")
            .join(name)
    }

    fn service() -> (tempfile::TempDir, Arc<QueryService>) {
        service_with_limit(256 * 1024 * 1024)
    }

    fn service_with_limit(limit: u64) -> (tempfile::TempDir, Arc<QueryService>) {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(QueryService::open(directory.path(), limit).unwrap());
        (directory, service)
    }

    fn request(task: &str, query: &str, plan: QueryPlan) -> ExecuteQueryRequest {
        ExecuteQueryRequest {
            document_id: String::from("document-test"),
            session_id: String::from("session-test"),
            query_id: query.to_owned(),
            task_id: task.to_owned(),
            plan,
        }
    }

    fn wait_complete(service: &QueryService, request: &ExecuteQueryRequest) -> QueryStatus {
        for _ in 0..500 {
            let status = service
                .status(
                    &request.document_id,
                    &request.session_id,
                    &request.query_id,
                    &request.task_id,
                )
                .unwrap();
            if matches!(
                status.state,
                QueryTaskState::Complete | QueryTaskState::Cancelled | QueryTaskState::Failed
            ) {
                return status;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("query task did not finish");
    }

    fn category_plan() -> QueryPlan {
        QueryPlan {
            filters: vec![QueryFilter {
                id: String::from("category"),
                column_id: String::from("category"),
                scalar_type: QueryScalarType::Text,
                operator: FilterOperator::OneOf,
                values: vec![String::from("beta"), String::from("gamma")],
            }],
            search: None,
            sort: vec![
                QuerySort {
                    column_id: String::from("group_id"),
                    direction: QuerySortDirection::Ascending,
                    nulls_last: true,
                },
                QuerySort {
                    column_id: String::from("amount"),
                    direction: QuerySortDirection::Descending,
                    nulls_last: true,
                },
            ],
            projection: vec![String::from("row_id"), String::from("category")],
        }
    }

    fn run_fixture(name: &str, query: &str) -> (Vec<Vec<DataValue>>, QueryStatus) {
        let (_directory, service) = service();
        let source = DataSource::open(fixture(name)).unwrap();
        let spec = source.query_source_spec().unwrap();
        let request = request(&format!("task-{query}"), query, category_plan());
        request.plan.validate(&spec.columns).unwrap();
        service.execute(request.clone(), spec).unwrap();
        let status = wait_complete(&service, &request);
        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        let page = service
            .read_page(ReadQueryPageRequest {
                document_id: request.document_id,
                session_id: request.session_id,
                query_id: request.query_id,
                offset: 0,
                limit: 200,
            })
            .unwrap()
            .page;
        (page.rows, status)
    }

    #[test]
    fn csv_numeric_profile_matrix_preserves_typed_filter_sort_and_display() {
        let (_directory, service) = service();
        for (target_name, target) in [
            ("auto", CsvTargetType::Auto),
            ("int64", CsvTargetType::Int64),
            ("uint64", CsvTargetType::UInt64),
            ("float64", CsvTargetType::Float64),
            ("decimal", CsvTargetType::Decimal),
        ] {
            for (separator_name, separator, decimal, expected) in [
                ("none", None, ".", "10001"),
                ("comma", Some(","), ".", "10,001"),
                ("dot", Some("."), ",", "10.001"),
                ("space", Some(" "), ".", "10 001"),
            ] {
                let case = format!("{target_name}-{separator_name}");
                let source_directory = tempfile::tempdir().unwrap();
                let path = source_directory.path().join("grouped.csv");
                std::fs::write(&path, "amount\n10001\n2\n3\nNULL\n\n").unwrap();
                let source = DataSource::open(path).unwrap();
                let mut profile = source.active_csv_profile().unwrap();
                profile.mode = CsvProfileMode::Custom;
                profile.generation += 1;
                profile.columns[0].target_type = target;
                profile.columns[0].thousand_separator = separator.map(str::to_owned);
                profile.columns[0].decimal_separator = decimal.to_owned();
                let source = source.prepare_csv_profile(&profile).unwrap();
                let spec = source.query_source_spec().unwrap();
                let plan = QueryPlan {
                    filters: vec![QueryFilter {
                        id: format!("filter-{case}"),
                        column_id: String::from("amount"),
                        scalar_type: if target == CsvTargetType::Decimal {
                            QueryScalarType::Decimal
                        } else {
                            QueryScalarType::Number
                        },
                        operator: FilterOperator::GreaterThan,
                        values: vec![String::from("2")],
                    }],
                    search: None,
                    sort: vec![QuerySort {
                        column_id: String::from("amount"),
                        direction: QuerySortDirection::Ascending,
                        nulls_last: true,
                    }],
                    projection: Vec::new(),
                };
                plan.validate(&spec.columns).unwrap();
                let request = request(
                    &format!("task-grouped-{case}"),
                    &format!("query-grouped-{case}"),
                    plan,
                );
                service.execute(request.clone(), spec).unwrap();
                let status = wait_complete(&service, &request);
                assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);

                let page = service
                    .read_page(ReadQueryPageRequest {
                        document_id: request.document_id,
                        session_id: request.session_id,
                        query_id: request.query_id,
                        offset: 0,
                        limit: 200,
                    })
                    .unwrap()
                    .page;
                let values = page
                    .rows
                    .iter()
                    .map(|row| row[0].display.as_deref().unwrap())
                    .collect::<Vec<_>>();
                assert_eq!(values, ["3", expected], "case: {case}");
            }
        }
    }

    #[test]
    fn qry_csv_and_parquet_have_identical_stable_filtered_projection() {
        let (csv, _) = run_fixture("query-small.csv", "csv-equivalent");
        let (parquet, _) = run_fixture("query-small.parquet", "parquet-equivalent");
        assert_eq!(csv, parquet);
        assert!(!csv.is_empty());
    }

    #[test]
    #[ignore = "uses the 149 MiB Phase 7 CSV regression fixture"]
    fn qry_large_phase7_csv_sorts_first_column() {
        let source = DataSource::open(phase7_fixture("large-csv.csv")).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_directory, service) = service_with_limit(DEFAULT_QUERY_TEMP_LIMIT_BYTES);
        let request = request(
            "large-csv-sort-task",
            "large-csv-sort-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: vec![QuerySort {
                    column_id: String::from("column_000"),
                    direction: QuerySortDirection::Ascending,
                    nulls_last: true,
                }],
                projection: Vec::new(),
            },
        );
        request.plan.validate(&spec.columns).unwrap();
        service.execute(request.clone(), spec).unwrap();

        let status = (0..1_800)
            .find_map(|_| {
                let status = service
                    .status(
                        &request.document_id,
                        &request.session_id,
                        &request.query_id,
                        &request.task_id,
                    )
                    .unwrap();
                if matches!(
                    status.state,
                    QueryTaskState::Complete | QueryTaskState::Cancelled | QueryTaskState::Failed
                ) {
                    Some(status)
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    None
                }
            })
            .expect("large CSV sort did not finish within three minutes");

        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        let page = service
            .read_page(ReadQueryPageRequest {
                document_id: request.document_id,
                session_id: request.session_id,
                query_id: request.query_id,
                offset: 0,
                limit: 3,
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][0].display.as_deref(), Some("0"));
        assert_eq!(page.rows[1][0].display.as_deref(), Some("10000019"));
        assert_eq!(page.rows[2][0].display.as_deref(), Some("20000038"));
    }

    #[test]
    fn qry_009_unicode_search_uses_scalar_lowercase_without_normalization() {
        let source_directory = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("unicode-search.csv");
        std::fs::write(
            &path,
            "value\nAlpha\n한글\nİ\ni\u{307}\nß\nSS\nÉ\nE\u{301}\n",
        )
        .unwrap();
        let source = DataSource::open(path).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_temp_directory, service) = service();
        let mut sequence = 0_u64;
        let mut search = |text: &str, case_sensitive: bool, exact: bool| {
            sequence += 1;
            let plan = QueryPlan {
                filters: Vec::new(),
                search: Some(QuerySearch {
                    text: text.to_owned(),
                    mode: QuerySearchMode::Filter,
                    case_sensitive,
                    exact,
                    target_column_ids: vec![String::from("value")],
                }),
                sort: Vec::new(),
                projection: vec![String::from("value")],
            };
            plan.validate(&spec.columns).unwrap();
            let request = request(
                &format!("unicode-task-{sequence}"),
                &format!("unicode-query-{sequence}"),
                plan,
            );
            service.execute(request.clone(), spec.clone()).unwrap();
            let status = wait_complete(&service, &request);
            assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
            service
                .read_page(ReadQueryPageRequest {
                    document_id: request.document_id,
                    session_id: request.session_id,
                    query_id: request.query_id,
                    offset: 0,
                    limit: 200,
                })
                .unwrap()
                .page
                .rows
                .into_iter()
                .map(|row| row[0].display.clone().unwrap())
                .collect::<Vec<_>>()
        };

        assert_eq!(search("alpha", false, true), ["Alpha"]);
        assert_eq!(search("LPH", false, false), ["Alpha"]);
        assert_eq!(search("한글", false, true), ["한글"]);
        assert_eq!(search("i\u{307}", false, true), ["İ", "i\u{307}"]);
        assert!(search("i", false, true).is_empty());
        assert_eq!(search("ß", false, true), ["ß"]);
        assert_eq!(search("ss", false, true), ["SS"]);
        assert_eq!(search("é", false, true), ["É"]);
        assert_eq!(search("e\u{301}", false, true), ["E\u{301}"]);
        assert_eq!(search("İ", true, true), ["İ"]);
        assert_eq!(search("É", true, true), ["É"]);
        assert!(search("é", true, true).is_empty());
    }

    #[test]
    fn qry_016_empty_zero_match_all_null_and_all_invalid_are_explicit() {
        let source_directory = tempfile::tempdir().unwrap();

        let empty_path = source_directory.path().join("empty.csv");
        std::fs::write(&empty_path, b"").unwrap();
        let empty_spec = DataSource::open(empty_path)
            .unwrap()
            .query_source_spec()
            .unwrap();
        let (_empty_temp, empty_service) = service();
        let empty_request = request(
            "empty-task",
            "empty-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: Vec::new(),
            },
        );
        empty_service
            .execute(empty_request.clone(), empty_spec)
            .unwrap();
        let empty_status = wait_complete(&empty_service, &empty_request);
        assert_eq!(empty_status.state, QueryTaskState::Complete);
        assert_eq!(empty_status.progress.result_rows, 0);

        let null_path = source_directory.path().join("all-null.csv");
        std::fs::write(&null_path, "value\nNULL\nNULL\n").unwrap();
        let null_source = DataSource::open(null_path).unwrap();
        let null_spec = null_source.query_source_spec().unwrap();
        let (_null_temp, null_service) = service();
        let null_request = request(
            "null-task",
            "null-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: vec![String::from("value")],
            },
        );
        null_service
            .execute(null_request.clone(), null_spec.clone())
            .unwrap();
        assert_eq!(
            wait_complete(&null_service, &null_request)
                .progress
                .result_rows,
            2
        );
        let null_rows = null_service
            .read_page(ReadQueryPageRequest {
                document_id: null_request.document_id.clone(),
                session_id: null_request.session_id.clone(),
                query_id: null_request.query_id.clone(),
                offset: 0,
                limit: 200,
            })
            .unwrap()
            .page
            .rows;
        assert!(null_rows
            .iter()
            .all(|row| row[0].state == DataValueState::Null));

        let zero_match_request = request(
            "zero-match-task",
            "zero-match-query",
            QueryPlan {
                filters: Vec::new(),
                search: Some(QuerySearch {
                    text: String::from("absent"),
                    mode: QuerySearchMode::Filter,
                    case_sensitive: false,
                    exact: false,
                    target_column_ids: vec![String::from("value")],
                }),
                sort: Vec::new(),
                projection: vec![String::from("value")],
            },
        );
        null_service
            .execute(zero_match_request.clone(), null_spec)
            .unwrap();
        assert_eq!(
            wait_complete(&null_service, &zero_match_request)
                .progress
                .result_rows,
            0
        );

        let invalid_path = source_directory.path().join("all-invalid.csv");
        std::fs::write(&invalid_path, "value\nbad\nworse\n").unwrap();
        let invalid_source = DataSource::open(invalid_path).unwrap();
        let mut invalid_profile = invalid_source.active_csv_profile().unwrap();
        invalid_profile.mode = CsvProfileMode::Custom;
        invalid_profile.generation += 1;
        invalid_profile.columns[0].target_type = CsvTargetType::Int64;
        let invalid_spec = invalid_source
            .prepare_csv_profile(&invalid_profile)
            .unwrap()
            .query_source_spec()
            .unwrap();
        let (_invalid_temp, invalid_service) = service();
        let invalid_request = request(
            "invalid-task",
            "invalid-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: vec![String::from("value")],
            },
        );
        invalid_service
            .execute(invalid_request.clone(), invalid_spec)
            .unwrap();
        assert_eq!(
            wait_complete(&invalid_service, &invalid_request)
                .progress
                .result_rows,
            2
        );
        let invalid_rows = invalid_service
            .read_page(ReadQueryPageRequest {
                document_id: invalid_request.document_id,
                session_id: invalid_request.session_id,
                query_id: invalid_request.query_id,
                offset: 0,
                limit: 200,
            })
            .unwrap()
            .page
            .rows;
        assert!(invalid_rows
            .iter()
            .all(|row| row[0].state == DataValueState::Invalid));
    }

    #[test]
    fn qry_find_is_non_filtering_and_supports_bounded_next_and_wrap() {
        let (_directory, service) = service();
        let source = DataSource::open(fixture("query-small.parquet")).unwrap();
        let spec = source.query_source_spec().unwrap();
        let source_rows = spec.total_rows.unwrap();
        let mut plan = category_plan();
        plan.filters.clear();
        plan.sort.clear();
        plan.projection.clear();
        plan.search = Some(QuerySearch {
            text: String::from("needle"),
            mode: QuerySearchMode::Find,
            case_sensitive: false,
            exact: false,
            target_column_ids: vec![String::from("label")],
        });
        let request = request("task-find", "query-find", plan);
        service.execute(request.clone(), spec).unwrap();
        let status = wait_complete(&service, &request);
        assert_eq!(status.progress.result_rows, source_rows);
        assert!(status.find_match_count.is_some_and(|count| count > 0));
        let matched = service
            .find_match(FindQueryMatchRequest {
                document_id: request.document_id,
                session_id: request.session_id,
                query_id: request.query_id,
                from_result_offset: 0,
                from_match_index: None,
                direction: FindDirection::Next,
                wrap: true,
            })
            .unwrap()
            .matched
            .unwrap();
        assert_eq!(matched.column_id, "label");
        assert!(matched.total_matches > 0);
    }

    #[test]
    fn qry_queued_cancel_is_cooperative_and_releases_temp_lifecycle() {
        let (_directory, service) = service();
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        let permit_one = acquire_query_permit(&first).unwrap();
        let permit_two = acquire_query_permit(&second).unwrap();
        let source = DataSource::open(fixture("query-small.parquet")).unwrap();
        let spec = source.query_source_spec().unwrap();
        let request = request("task-cancel", "query-cancel", category_plan());
        service.execute(request.clone(), spec).unwrap();
        service
            .cancel(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                &request.task_id,
            )
            .unwrap();
        drop(permit_one);
        drop(permit_two);
        assert_eq!(
            wait_complete(&service, &request).state,
            QueryTaskState::Cancelled
        );
        service
            .drop_session(&request.document_id, &request.session_id)
            .unwrap();
        assert_eq!(service.usage().unwrap().active_queries, 0);
    }

    #[test]
    fn qry_csv_invalid_null_and_distinct_are_separate() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = source_dir.path().join("invalid.csv");
        std::fs::write(&path, "amount\n1\nbad\nNULL\n\n").unwrap();
        let source = DataSource::open(&path).unwrap();
        let mut profile = source.active_csv_profile().unwrap();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        profile.columns[0].target_type = CsvTargetType::Int64;
        let source = source.prepare_csv_profile(&profile).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_directory, service) = service();
        let values = service
            .distinct(
                DistinctValuesRequest {
                    document_id: String::from("document-test"),
                    session_id: String::from("session-test"),
                    query_id: None,
                    column_id: String::from("amount"),
                    search: None,
                    offset: 0,
                    limit: 20,
                },
                Some(spec.clone()),
            )
            .unwrap()
            .values;
        assert!(values
            .iter()
            .any(|value| value.is_invalid && value.value.as_deref() == Some("bad")));
        assert!(values.iter().any(|value| value.is_null));

        let request = request(
            "task-invalid",
            "query-invalid",
            QueryPlan {
                filters: vec![QueryFilter {
                    id: String::from("invalid"),
                    column_id: String::from("amount"),
                    scalar_type: QueryScalarType::Number,
                    operator: FilterOperator::IsInvalid,
                    values: Vec::new(),
                }],
                search: None,
                sort: Vec::new(),
                projection: Vec::new(),
            },
        );
        service.execute(request.clone(), spec).unwrap();
        assert_eq!(wait_complete(&service, &request).progress.result_rows, 1);
        let page = service
            .read_page(ReadQueryPageRequest {
                document_id: request.document_id,
                session_id: request.session_id,
                query_id: request.query_id,
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][0].state, DataValueState::Invalid);
    }

    #[test]
    fn query_input_provider_is_dispatched_without_a_format_branch() {
        let (directory, service) = service();
        let source_path = directory.path().join("synthetic.input");
        std::fs::write(&source_path, b"provider-owned").unwrap();
        let called = Arc::new(AtomicBool::new(false));
        let source = QuerySourceSpec {
            path: std::fs::canonicalize(source_path).unwrap(),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: false,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(1),
            provider: Arc::new(SyntheticQueryProvider {
                called: Arc::clone(&called),
            }),
        };
        let request = request(
            "provider-task",
            "provider-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: Vec::new(),
            },
        );

        service.execute(request.clone(), source).unwrap();
        assert_eq!(
            wait_complete(&service, &request).state,
            QueryTaskState::Complete
        );
        assert!(called.load(Ordering::Acquire));
        let page = service
            .read_page(ReadQueryPageRequest {
                document_id: request.document_id,
                session_id: request.session_id,
                query_id: request.query_id,
                offset: 0,
                limit: 1,
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][0].display.as_deref(), Some("provider-value"));
    }

    #[test]
    fn shutdown_interrupts_tasks_and_obeys_its_deadline() {
        let (_directory, service) = service();
        let status = QueryStatus {
            document_id: String::from("shutdown-document"),
            session_id: String::from("shutdown-session"),
            query_id: String::from("shutdown-query"),
            task_id: String::from("shutdown-task"),
            state: QueryTaskState::Running,
            progress: QueryProgress {
                rows_scanned: 0,
                total_rows: None,
                result_rows: 0,
            },
            columns: Vec::new(),
            elapsed_ms: 0,
            find_match_count: None,
            error: None,
        };
        let task = Arc::new(QueryTask {
            status: Mutex::new(status),
            cancel: AtomicBool::new(false),
            interrupt: Mutex::new(None),
            started: std::time::Instant::now(),
        });
        service.tasks.lock().unwrap().insert(
            task_key("shutdown-document", "shutdown-session", "shutdown-task"),
            Arc::clone(&task),
        );

        let started = std::time::Instant::now();
        service.shutdown_with_timeout(std::time::Duration::from_millis(75));

        assert!(task.cancel.load(Ordering::Acquire));
        assert!(service.shutting_down.load(Ordering::Acquire));
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
    }

    #[test]
    #[ignore = "requires generated 10M Phase 9 low/high fixtures"]
    fn perf_product_query_service_10m_low_high() {
        let root = std::env::var_os("PHASE9_LARGE_FIXTURE_DIR")
            .map(std::path::PathBuf::from)
            .expect("set PHASE9_LARGE_FIXTURE_DIR to the generated fixture directory");
        for cardinality in ["low", "high"] {
            let path = root.join(format!("query-{cardinality}-10m-40c.parquet"));
            assert!(path.is_file(), "missing fixture: {}", path.display());
            let source = DataSource::open(&path).unwrap();
            let spec = source.query_source_spec().unwrap();
            let (_directory, service) = service_with_limit(DEFAULT_QUERY_TEMP_LIMIT_BYTES);
            let process_temp_limit = service.usage().unwrap().limit_bytes;
            let query_temp_limit = process_temp_limit / MAX_CONCURRENT_QUERIES as u64;
            assert_eq!(process_temp_limit, DEFAULT_QUERY_TEMP_LIMIT_BYTES);
            let plan = QueryPlan {
                filters: vec![QueryFilter {
                    id: String::from("upper-half"),
                    column_id: String::from("row_id"),
                    scalar_type: QueryScalarType::Number,
                    operator: FilterOperator::GreaterThanOrEqual,
                    values: vec![String::from("5000000")],
                }],
                search: None,
                sort: vec![
                    QuerySort {
                        column_id: String::from("optional_value"),
                        direction: QuerySortDirection::Ascending,
                        nulls_last: true,
                    },
                    QuerySort {
                        column_id: String::from("amount"),
                        direction: QuerySortDirection::Descending,
                        nulls_last: true,
                    },
                ],
                projection: vec![String::from("row_id"), String::from("category")],
            };
            plan.validate(&spec.columns).unwrap();
            let perf_request = request(
                &format!("perf-task-{cardinality}"),
                &format!("perf-query-{cardinality}"),
                plan,
            );
            let started = std::time::Instant::now();
            service.execute(perf_request.clone(), spec).unwrap();
            let status = loop {
                let status = service
                    .status(
                        &perf_request.document_id,
                        &perf_request.session_id,
                        &perf_request.query_id,
                        &perf_request.task_id,
                    )
                    .unwrap();
                if matches!(
                    status.state,
                    QueryTaskState::Complete | QueryTaskState::Failed
                ) {
                    break status;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            };
            assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
            let rows = status.progress.result_rows;
            let offsets = [0, rows / 2, rows.saturating_sub(200), rows / 3];
            let mut page_ms = Vec::new();
            for offset in offsets {
                let page_started = std::time::Instant::now();
                let page = service
                    .read_page(ReadQueryPageRequest {
                        document_id: perf_request.document_id.clone(),
                        session_id: perf_request.session_id.clone(),
                        query_id: perf_request.query_id.clone(),
                        offset: offset as i64,
                        limit: 200,
                    })
                    .unwrap()
                    .page;
                assert!(!page.rows.is_empty());
                page_ms.push(page_started.elapsed().as_secs_f64() * 1000.0);
            }
            println!(
                "PERF9 cardinality={cardinality} rows={rows} queryMs={:.3} pageMs={:?} tempBytes={} processTempLimitBytes={process_temp_limit} queryTempLimitBytes={query_temp_limit}",
                started.elapsed().as_secs_f64() * 1000.0,
                page_ms,
                service.usage().unwrap().process_bytes
            );

            let cancel_request = request(
                &format!("cancel-task-{cardinality}"),
                &format!("cancel-query-{cardinality}"),
                QueryPlan {
                    filters: Vec::new(),
                    search: None,
                    sort: vec![QuerySort {
                        column_id: String::from("label"),
                        direction: QuerySortDirection::Ascending,
                        nulls_last: true,
                    }],
                    projection: vec![String::from("row_id")],
                },
            );
            let cancel_source = DataSource::open(&path)
                .unwrap()
                .query_source_spec()
                .unwrap();
            service
                .execute(cancel_request.clone(), cancel_source)
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            service
                .cancel(
                    &cancel_request.document_id,
                    &cancel_request.session_id,
                    &cancel_request.query_id,
                    &cancel_request.task_id,
                )
                .unwrap();
            assert_eq!(
                wait_complete(&service, &cancel_request).state,
                QueryTaskState::Cancelled
            );
        }
    }
}
