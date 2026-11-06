//! Cancelable, bounded column-value snapshots shared by paging and copy.
use super::*;
use serde::Deserialize;

const MAX_SNAPSHOTS: usize = 16;
const PREVIEW_CHARACTERS: usize = 1024;
const JS_MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
const MAX_PAGE_CURSORS: usize = 256;
const COPY_BATCH_ROWS: usize = 4096;
const CURSOR_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartColumnValuesRequest {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub column_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnValuesOrder {
    ValueAscending,
    ValueDescending,
    CountDescending,
    CountAscending,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnValuesPageRequest {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub search: Option<String>,
    pub order: ColumnValuesOrder,
    pub offset: u64,
    pub limit: usize,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnValuesCopyRequest {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub search: Option<String>,
    pub order: ColumnValuesOrder,
    pub include_counts: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnValuesState {
    Queued,
    Running,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValuesStatus {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub column_id: String,
    pub state: ColumnValuesState,
    pub stage: String,
    pub total_count: Option<u64>,
    pub matched_count: Option<u64>,
    pub error: Option<DataError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValue {
    pub value: Option<String>,
    pub is_null: bool,
    pub is_empty: bool,
    pub is_invalid: bool,
    pub count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValuesPageResponse {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub column_id: String,
    pub total_count: u64,
    pub matched_count: u64,
    pub values: Vec<ColumnValue>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
}

pub struct ColumnValuesCopySource {
    pub reader: Arc<dyn crate::copy::CopyRowReader>,
    pub row_count: u64,
    pub column_ids: Vec<String>,
    validator: Arc<ColumnValuesReader>,
}

impl ColumnValuesCopySource {
    pub fn wrap_clipboard(
        &self,
        writer: Arc<dyn crate::copy::ClipboardWriter>,
    ) -> Arc<dyn crate::copy::ClipboardWriter> {
        Arc::new(ColumnValuesClipboard {
            reader: Arc::clone(&self.validator),
            writer,
        })
    }
}

struct ColumnValuesClipboard {
    reader: Arc<ColumnValuesReader>,
    writer: Arc<dyn crate::copy::ClipboardWriter>,
}

impl crate::copy::ClipboardWriter for ColumnValuesClipboard {
    fn write_text(&self, text: String) -> Result<(), String> {
        use crate::copy::CopyRowReader;
        let _commit = self
            .reader
            .task
            .commit_gate
            .lock()
            .map_err(|_| "The column-values commit gate is unavailable.".to_owned())?;
        self.reader
            .validate_current()
            .map_err(|error| error.message)?;
        self.writer.write_text(text)
    }
}

#[derive(Default)]
pub(super) struct ColumnValuesRegistry {
    tasks: Mutex<HashMap<String, Arc<ColumnValuesTask>>>,
    live_workers: Arc<std::sync::atomic::AtomicUsize>,
}

struct ColumnValuesWorkerPermit(Arc<std::sync::atomic::AtomicUsize>);

impl ColumnValuesWorkerPermit {
    fn acquire(count: Arc<std::sync::atomic::AtomicUsize>) -> Result<Self, DataError> {
        count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < MAX_SNAPSHOTS).then_some(value + 1)
            })
            .map_err(|_| {
                DataError::invalid_request(
                    "Column-values workers are finishing cancellation. Please retry shortly.",
                )
            })?;
        Ok(Self(count))
    }
}

impl Drop for ColumnValuesWorkerPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct ColumnValuesTask {
    request: StartColumnValuesRequest,
    token: QueryTask,
    status: Mutex<ColumnValuesStatus>,
    snapshot: Mutex<Option<Arc<ColumnValuesSnapshot>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    commit_gate: Mutex<()>,
}

enum SnapshotConnection {
    Owned {
        connection: Box<Mutex<Connection>>,
        _lease: QueryTempLease,
        _provider: Arc<dyn crate::data::QueryInputProvider>,
    },
    Filtered(Arc<QueryResult>),
}

struct ColumnValuesSnapshot {
    database: SnapshotConnection,
    table: String,
    total_count: u64,
    source: Option<SourceFingerprint>,
    cursors: Mutex<PageCursors>,
}

#[derive(Default)]
struct PageCursors {
    sequence: u64,
    entries: std::collections::VecDeque<(String, PageCursor)>,
}

#[derive(Clone)]
struct PageCursor {
    search: Option<String>,
    order: ColumnValuesOrder,
    offset: u64,
    limit: usize,
    take: usize,
    anchor: u64,
    backward: bool,
    created: std::time::Instant,
}

fn normalized_search(search: Option<&str>) -> Option<&str> {
    search.filter(|value| !value.is_empty())
}

impl ColumnValuesSnapshot {
    fn page_cursor(
        &self,
        request: &ColumnValuesPageRequest,
    ) -> Result<Option<PageCursor>, DataError> {
        let Some(cursor) = &request.cursor else {
            return Ok(None);
        };
        let registry = self.cursors.lock().map_err(|_| registry_error())?;
        let binding = registry
            .entries
            .iter()
            .find(|(token, _)| token == cursor)
            .map(|(_, binding)| binding)
            .ok_or_else(|| {
                DataError::invalid_request(
                    "The column-values cursor expired or is no longer available.",
                )
            })?;
        if binding.created.elapsed() >= CURSOR_TTL
            || binding.search.as_deref() != normalized_search(request.search.as_deref())
            || binding.order != request.order
            || binding.offset != request.offset
            || binding.limit != request.limit
        {
            return Err(DataError::invalid_request(
                "The column-values cursor does not match this page request.",
            ));
        }
        Ok(Some(binding.clone()))
    }

    fn register_cursor(&self, mut binding: PageCursor) -> Result<String, DataError> {
        let mut registry = self.cursors.lock().map_err(|_| registry_error())?;
        registry
            .entries
            .retain(|(_, binding)| binding.created.elapsed() < CURSOR_TTL);
        while registry.entries.len() >= MAX_PAGE_CURSORS {
            registry.entries.pop_front();
        }
        registry.sequence = registry
            .sequence
            .checked_add(1)
            .ok_or_else(registry_error)?;
        let token = format!("cv-{}-{}", self.table, registry.sequence);
        binding.created = std::time::Instant::now();
        registry.entries.push_back((token.clone(), binding));
        Ok(token)
    }

    fn with_cancellable_connection<T>(
        &self,
        task: &ColumnValuesTask,
        run: impl FnOnce(&Connection) -> Result<T, DataError>,
    ) -> Result<T, DataError> {
        let mutex = match &self.database {
            SnapshotConnection::Owned { connection, .. } => connection.as_ref(),
            SnapshotConnection::Filtered(result) => &result.connection,
        };
        loop {
            check_task(task)?;
            match mutex.try_lock() {
                Ok(connection) => return run(&connection),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(std::sync::TryLockError::Poisoned(_)) => return Err(registry_error()),
            }
        }
    }

    fn validate_source(&self) -> Result<(), DataError> {
        if let Some(expected) = &self.source {
            if source_fingerprint(&expected.canonical_path)? != *expected {
                return Err(DataError::invalid_request(
                    "The column-values source file changed. Reopen the file and try again.",
                ));
            }
        }
        Ok(())
    }
}

impl Drop for ColumnValuesSnapshot {
    fn drop(&mut self) {
        if let SnapshotConnection::Filtered(result) = &self.database {
            if let Ok(connection) = result.connection.lock() {
                let _ = connection.execute_batch(&format!("DROP TABLE IF EXISTS {}", self.table));
            }
        }
    }
}

impl QueryService {
    fn with_column_values_connection<T>(
        &self,
        task: &Arc<ColumnValuesTask>,
        snapshot: &ColumnValuesSnapshot,
        run: impl FnOnce(&Connection, &QueryBudgetMonitor) -> Result<T, DataError>,
    ) -> Result<T, DataError> {
        let _permit = acquire_query_permit(&self.query_limiter, &task.token.cancel)
            .ok_or_else(DataError::task_cancelled)?;
        snapshot.with_cancellable_connection(task, |connection| {
            check_task(task)?;
            *task.token.interrupt.lock().map_err(|_| registry_error())? =
                Some(connection.interrupt_handle());
            let monitor = QueryBudgetMonitor::start(
                Arc::clone(&self.temp),
                Some(Arc::clone(&self.csv_cache)),
                connection.interrupt_handle(),
            );
            let result = monitor.check().and_then(|()| run(connection, &monitor));
            let budget = monitor.check();
            task.token
                .interrupt
                .lock()
                .map_err(|_| registry_error())?
                .take();
            budget?;
            check_task(task)?;
            snapshot.validate_source()?;
            result
        })
    }
    pub fn start_column_values(
        self: &Arc<Self>,
        request: StartColumnValuesRequest,
        source: Option<QuerySourceSpec>,
    ) -> Result<ColumnValuesStatus, DataError> {
        validate_id("column-values operation", &request.operation_id)?;
        validate_id("document", &request.document_id)?;
        validate_id("session", &request.session_id)?;
        if request.column_id.is_empty()
            || request.column_id.len() > 4096
            || self.shutting_down.load(Ordering::Acquire)
        {
            return Err(DataError::invalid_request(
                "Column values require an open document and a valid column.",
            ));
        }
        let filtered = request
            .query_id
            .as_deref()
            .map(|id| self.result(&request.document_id, &request.session_id, id))
            .transpose()?;
        if filtered.is_none() && source.is_none() {
            return Err(DataError::invalid_request(
                "A source is required for whole-file column values.",
            ));
        }
        let (epoch, generation) = if let Some(result) = &filtered {
            (Arc::clone(&result.epoch), result.generation)
        } else {
            let mut epochs = self.query_epochs.lock().map_err(|_| registry_error())?;
            let epoch = Arc::clone(
                epochs
                    .entry((request.document_id.clone(), request.session_id.clone()))
                    .or_insert_with(|| Arc::new(AtomicU64::new(0))),
            );
            let generation = epoch.load(Ordering::Acquire);
            (epoch, generation)
        };
        let status = ColumnValuesStatus {
            operation_id: request.operation_id.clone(),
            document_id: request.document_id.clone(),
            session_id: request.session_id.clone(),
            query_id: request.query_id.clone(),
            column_id: request.column_id.clone(),
            state: ColumnValuesState::Queued,
            stage: "queued".to_owned(),
            total_count: None,
            matched_count: None,
            error: None,
        };
        let task = Arc::new(ColumnValuesTask {
            token: QueryTask {
                status: Mutex::new(QueryStatus {
                    document_id: request.document_id.clone(),
                    session_id: request.session_id.clone(),
                    query_id: request
                        .query_id
                        .clone()
                        .unwrap_or_else(|| request.operation_id.clone()),
                    task_id: request.operation_id.clone(),
                    state: QueryTaskState::Queued,
                    progress: QueryProgress {
                        rows_scanned: 0,
                        total_rows: None,
                        result_rows: 0,
                    },
                    columns: Vec::new(),
                    elapsed_ms: 0,
                    find_match_count: None,
                    error: None,
                }),
                cancel: AtomicBool::new(false),
                interrupt: Mutex::new(None),
                epoch,
                generation,
                started: std::time::Instant::now(),
            },
            request: request.clone(),
            status: Mutex::new(status.clone()),
            snapshot: Mutex::new(None),
            worker: Mutex::new(None),
            commit_gate: Mutex::new(()),
        });
        let worker_permit = {
            let mut tasks = self
                .column_values
                .tasks
                .lock()
                .map_err(|_| registry_error())?;
            if tasks.contains_key(&request.operation_id) {
                return Err(DataError::invalid_request(
                    "This column-values operation ID is already in use.",
                ));
            }
            tasks.retain(|_, old| {
                !matches!(
                    old.status.lock().map(|s| s.state),
                    Ok(ColumnValuesState::Cancelled | ColumnValuesState::Failed)
                )
            });
            if tasks.len() >= MAX_SNAPSHOTS {
                return Err(DataError::invalid_request(
                    "Close another column-values panel before opening a new one.",
                ));
            }
            let permit =
                ColumnValuesWorkerPermit::acquire(Arc::clone(&self.column_values.live_workers))?;
            tasks.insert(request.operation_id.clone(), Arc::clone(&task));
            permit
        };
        let service = Arc::clone(self);
        let worker_task = Arc::clone(&task);
        let worker = std::thread::Builder::new()
            .name("column-values".to_owned())
            .spawn(move || {
                let _worker_permit = worker_permit;
                let result = service.build_column_values(&worker_task, source, filtered);
                let _commit = worker_task.commit_gate.lock();
                match result {
                    Ok(snapshot) if check_task(&worker_task).is_ok() => {
                        let total = snapshot.total_count;
                        if let Ok(mut current) = worker_task.snapshot.lock() {
                            *current = Some(Arc::new(snapshot));
                        }
                        if let Ok(mut status) = worker_task.status.lock() {
                            status.state = ColumnValuesState::Ready;
                            status.stage = "ready".to_owned();
                            status.total_count = Some(total);
                            status.matched_count = Some(total);
                        }
                    }
                    result => {
                        let cancelled = check_task(&worker_task).is_err();
                        if let Ok(mut status) = worker_task.status.lock() {
                            status.state = if cancelled {
                                ColumnValuesState::Cancelled
                            } else {
                                ColumnValuesState::Failed
                            };
                            status.stage =
                                if cancelled { "cancelled" } else { "failed" }.to_owned();
                            status.error = if cancelled { None } else { result.err() };
                        }
                    }
                }
                if let Ok(mut interrupt) = worker_task.token.interrupt.lock() {
                    interrupt.take();
                }
            })
            .map_err(|error| {
                if let Ok(mut tasks) = self.column_values.tasks.lock() {
                    tasks.remove(&request.operation_id);
                }
                DataError::query_failed(format!("Could not start column-values worker: {error}"))
            })?;
        *task.worker.lock().map_err(|_| registry_error())? = Some(worker);
        Ok(status)
    }

    pub fn column_values_status(
        &self,
        document: &str,
        session: &str,
        operation: &str,
    ) -> Result<ColumnValuesStatus, DataError> {
        let task = self.column_values_task(document, session, operation)?;
        if check_task(&task).is_err() {
            cancel_task(&task);
        }
        let status = task.status.lock().map_err(|_| registry_error())?.clone();
        Ok(status)
    }

    pub fn read_column_values_page(
        &self,
        request: ColumnValuesPageRequest,
    ) -> Result<ColumnValuesPageResponse, DataError> {
        validate_page(&request)?;
        let task = self.column_values_task(
            &request.document_id,
            &request.session_id,
            &request.operation_id,
        )?;
        let snapshot = ready_snapshot(&task)?;
        let cursor = snapshot.page_cursor(&request)?;
        let (rows, matched_count) =
            self.with_column_values_connection(&task, &snapshot, |connection, monitor| {
                let matched =
                    count_matches(connection, &snapshot.table, request.search.as_deref())?;
                let selection = resolve_selection(
                    connection,
                    &snapshot.table,
                    request.search.as_deref(),
                    request.order,
                    ValueSelection {
                        offset: request.offset,
                        limit: cursor.as_ref().map_or(request.limit, |cursor| cursor.take),
                        total: matched,
                        seek: cursor
                            .as_ref()
                            .map(|cursor| (cursor.anchor, cursor.backward)),
                    },
                    || {
                        check_task(&task)?;
                        monitor.check()
                    },
                )?;
                let values = read_selected_values(
                    connection,
                    &snapshot.table,
                    request.search.as_deref(),
                    request.order,
                    selection,
                    true,
                )?;
                Ok((values, matched))
            })?;
        check_task(&task)?;
        let binding = |offset, take, anchor, backward| PageCursor {
            search: normalized_search(request.search.as_deref()).map(str::to_owned),
            order: request.order,
            offset,
            limit: request.limit,
            take,
            anchor,
            backward,
            created: std::time::Instant::now(),
        };
        let end = request.offset.saturating_add(rows.len() as u64);
        let next_cursor = if end < matched_count {
            rows.last()
                .map(|row| snapshot.register_cursor(binding(end, request.limit, row.id, false)))
                .transpose()?
        } else {
            None
        };
        let previous_cursor = if request.offset > 0 {
            rows.first()
                .map(|row| {
                    snapshot.register_cursor(binding(
                        request.offset.saturating_sub(request.limit as u64),
                        request.limit.min(request.offset as usize),
                        row.id,
                        true,
                    ))
                })
                .transpose()?
        } else {
            None
        };
        let values = rows.into_iter().map(|row| row.value).collect::<Vec<_>>();
        Ok(ColumnValuesPageResponse {
            operation_id: request.operation_id,
            document_id: request.document_id,
            session_id: request.session_id,
            query_id: task.request.query_id.clone(),
            column_id: task.request.column_id.clone(),
            total_count: snapshot.total_count,
            matched_count,
            has_more: request.offset.saturating_add(values.len() as u64) < matched_count,
            values,
            next_cursor,
            previous_cursor,
        })
    }

    pub fn cancel_column_values(
        &self,
        document: &str,
        session: &str,
        operation: &str,
    ) -> Result<ColumnValuesStatus, DataError> {
        let task = self.column_values_task(document, session, operation)?;
        cancel_task(&task);
        let status = task.status.lock().map_err(|_| registry_error())?.clone();
        Ok(status)
    }

    pub fn release_column_values(
        &self,
        document: &str,
        session: &str,
        operation: &str,
    ) -> Result<(), DataError> {
        let task = self.column_values_task(document, session, operation)?;
        cancel_task(&task);
        self.column_values
            .tasks
            .lock()
            .map_err(|_| registry_error())?
            .remove(operation);
        Ok(())
    }

    pub fn column_values_copy_reader(
        self: &Arc<Self>,
        request: ColumnValuesCopyRequest,
    ) -> Result<ColumnValuesCopySource, DataError> {
        validate_search(request.search.as_deref())?;
        let task = self.column_values_task(
            &request.document_id,
            &request.session_id,
            &request.operation_id,
        )?;
        let snapshot = ready_snapshot(&task)?;
        let row_count = self.with_column_values_connection(&task, &snapshot, |connection, _| {
            count_matches(connection, &snapshot.table, request.search.as_deref())
        })?;
        let column_ids = if request.include_counts {
            vec!["Value".to_owned(), "Count".to_owned()]
        } else {
            vec!["Value".to_owned()]
        };
        let validator = Arc::new(ColumnValuesReader {
            service: Arc::clone(self),
            task,
            snapshot,
            request,
            row_count,
            anchors: Mutex::new(std::collections::VecDeque::new()),
        });
        Ok(ColumnValuesCopySource {
            reader: Arc::clone(&validator) as Arc<dyn crate::copy::CopyRowReader>,
            row_count,
            column_ids,
            validator,
        })
    }

    fn column_values_task(
        &self,
        document: &str,
        session: &str,
        operation: &str,
    ) -> Result<Arc<ColumnValuesTask>, DataError> {
        self.column_values
            .tasks
            .lock()
            .map_err(|_| registry_error())?
            .get(operation)
            .filter(|task| {
                task.request.document_id == document && task.request.session_id == session
            })
            .cloned()
            .ok_or_else(|| {
                DataError::invalid_request("The column-values operation is no longer available.")
            })
    }

    fn build_column_values(
        &self,
        task: &Arc<ColumnValuesTask>,
        source: Option<QuerySourceSpec>,
        filtered: Option<Arc<QueryResult>>,
    ) -> Result<ColumnValuesSnapshot, DataError> {
        let _permit = acquire_query_permit(&self.query_limiter, &task.token.cancel)
            .ok_or_else(DataError::task_cancelled)?;
        check_task(task)?;
        if let Ok(mut status) = task.status.lock() {
            status.state = ColumnValuesState::Running;
            status.stage = "waitingForCsv".to_owned();
        }
        let fingerprint = source
            .as_ref()
            .map(|s| source_fingerprint(&s.path))
            .transpose()?;
        let table = format!(
            "column_values_{}",
            self.next_distinct_id.fetch_add(1, Ordering::Relaxed)
        );
        let (database, total) = if let Some(result) = filtered {
            let index = result
                .columns
                .iter()
                .position(|c| c.name == task.request.column_id)
                .ok_or_else(|| DataError::invalid_request("Unknown column for column values."))?;
            let total = {
                let connection = result.connection.lock().map_err(|_| registry_error())?;
                *task.token.interrupt.lock().map_err(|_| registry_error())? =
                    Some(connection.interrupt_handle());
                if let Ok(mut status) = task.status.lock() {
                    status.stage = "grouping".to_owned();
                }
                let monitor = QueryBudgetMonitor::start(
                    Arc::clone(&self.temp),
                    Some(Arc::clone(&self.csv_cache)),
                    connection.interrupt_handle(),
                );
                let count = materialize_values(
                    &connection,
                    &table,
                    &format!("s.{}", quote_identifier(&task.request.column_id)),
                    &format!("s.{}", raw_name(result.columns[index].source_index)),
                    &format!("s.{}", invalid_name(result.columns[index].source_index)),
                    "query_result q JOIN dv_source s USING (__dv_row_id)",
                    result.columns[index].kind,
                );
                let checked = monitor.check().and(count);
                if checked.is_err() {
                    let _ = connection.execute_batch(&format!("DROP TABLE IF EXISTS {table}"));
                }
                checked?
            };
            (SnapshotConnection::Filtered(result), total)
        } else {
            let source = self.source_after_csv_preparation(
                &task.request.document_id,
                &task.request.session_id,
                source
                    .ok_or_else(|| DataError::invalid_request("Missing column-values source."))?,
                Some(&task.token),
            )?;
            check_task(task)?;
            let index = source
                .columns
                .iter()
                .position(|c| c.name == task.request.column_id)
                .ok_or_else(|| DataError::invalid_request("Unknown column for column values."))?;
            self.csv_cache.refresh_usage()?;
            let cap = self.temp.configured_limit() / MAX_CONCURRENT_QUERIES as u64;
            self.csv_cache.reclaim_for_query(cap)?;
            let lease = self.temp.allocate_bounded(
                &task.request.document_id,
                &format!("column-values-{}", task.request.operation_id),
                cap,
            )?;
            let connection = open_connection(&source, lease.path(), lease.allowance_bytes())?;
            connection
                .execute_batch("SET memory_limit = '128MiB'")
                .map_err(duckdb_error)?;
            *task.token.interrupt.lock().map_err(|_| registry_error())? =
                Some(connection.interrupt_handle());
            let monitor = QueryBudgetMonitor::start(
                Arc::clone(&self.temp),
                Some(Arc::clone(&self.csv_cache)),
                connection.interrupt_handle(),
            );
            prepare_source(
                &connection,
                &source,
                lease.path(),
                &task.token.cancel,
                Some(&task.token),
                &monitor,
            )?;
            check_task(task)?;
            if let Ok(mut status) = task.status.lock() {
                status.stage = "grouping".to_owned();
            }
            let total = materialize_values(
                &connection,
                &table,
                &format!("s.{}", quote_identifier(&task.request.column_id)),
                &format!("s.{}", raw_name(index)),
                &format!("s.{}", invalid_name(index)),
                "dv_source s",
                value_kind(&source.columns[index]),
            )?;
            monitor.check()?;
            (
                SnapshotConnection::Owned {
                    connection: Box::new(Mutex::new(connection)),
                    _lease: lease,
                    _provider: source.provider,
                },
                total,
            )
        };
        let snapshot = ColumnValuesSnapshot {
            database,
            table,
            total_count: total,
            source: fingerprint,
            cursors: Mutex::new(PageCursors::default()),
        };
        snapshot.validate_source()?;
        check_task(task)?;
        Ok(snapshot)
    }

    pub(super) fn cancel_session_column_values(&self, document: &str, session: &str) {
        let tasks = self
            .column_values
            .tasks
            .lock()
            .map(|tasks| {
                tasks
                    .values()
                    .filter(|t| {
                        t.request.document_id == document && t.request.session_id == session
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for task in tasks {
            cancel_task(&task);
        }
    }

    pub(super) fn shutdown_column_values(&self, deadline: std::time::Instant) -> bool {
        let tasks = self
            .column_values
            .tasks
            .lock()
            .map(|tasks| tasks.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for task in &tasks {
            cancel_task(task);
        }
        loop {
            if tasks.iter().all(|task| {
                task.worker
                    .lock()
                    .map(|worker| {
                        worker
                            .as_ref()
                            .is_none_or(std::thread::JoinHandle::is_finished)
                    })
                    .unwrap_or(false)
            }) {
                if let Ok(mut registry) = self.column_values.tasks.lock() {
                    registry.clear();
                }
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

fn check_task(task: &ColumnValuesTask) -> Result<(), DataError> {
    if query_wait_cancelled(Some(&task.token)) {
        Err(DataError::task_cancelled())
    } else {
        Ok(())
    }
}

fn cancel_task(task: &ColumnValuesTask) {
    let _commit = task.commit_gate.lock();
    task.token.cancel.store(true, Ordering::Release);
    if let Ok(interrupt) = task.token.interrupt.lock() {
        if let Some(interrupt) = interrupt.as_ref() {
            interrupt.interrupt();
        }
    }
    if let Ok(mut status) = task.status.lock() {
        status.state = ColumnValuesState::Cancelled;
        status.stage = "cancelled".to_owned();
        status.error = None;
    }
    if let Ok(mut snapshot) = task.snapshot.lock() {
        snapshot.take();
    }
}

fn ready_snapshot(task: &ColumnValuesTask) -> Result<Arc<ColumnValuesSnapshot>, DataError> {
    check_task(task)?;
    let snapshot = task
        .snapshot
        .lock()
        .map_err(|_| registry_error())?
        .as_ref()
        .cloned()
        .ok_or_else(|| DataError::invalid_request("Column values are not ready yet."))?;
    snapshot.validate_source()?;
    Ok(snapshot)
}

fn validate_search(search: Option<&str>) -> Result<(), DataError> {
    if search.is_some_and(|value| value.len() > 4096 || value.contains('\0')) {
        return Err(DataError::invalid_request(
            "Column-values search must be at most 4096 UTF-8 bytes without NUL.",
        ));
    }
    Ok(())
}

fn validate_page(request: &ColumnValuesPageRequest) -> Result<(), DataError> {
    validate_search(request.search.as_deref())?;
    if request.cursor.as_ref().is_some_and(|cursor| {
        cursor.len() > 128 || cursor.trim().is_empty() || cursor.contains('\0')
    }) {
        return Err(DataError::invalid_request(
            "The column-values cursor must contain 1 to 128 UTF-8 bytes without NUL.",
        ));
    }
    if !(1..=200).contains(&request.limit) || request.offset > JS_MAX_SAFE_COUNT {
        return Err(DataError::invalid_request(
            "Column-values page limit must be 1 to 200 and offset must be a UI-safe integer.",
        ));
    }
    Ok(())
}

fn materialize_values(
    connection: &Connection,
    table: &str,
    value: &str,
    raw: &str,
    invalid: &str,
    source: &str,
    kind: ValueKind,
) -> Result<u64, DataError> {
    let empty = format!("CASE WHEN {invalid} THEN false WHEN CAST({raw} AS VARCHAR) = '' OR CAST({value} AS VARCHAR) = '' THEN true ELSE false END");
    let null = format!("NOT {invalid} AND {value} IS NULL AND NOT ({empty})");
    let typed_sort = logical_sort_expression(value, kind);
    let canonical = match kind {
        ValueKind::Int | ValueKind::Duration => format!("CAST({typed_sort} AS VARCHAR)"),
        _ => format!("CAST({value} AS VARCHAR)"),
    };
    let display = format!(
        "CASE WHEN {invalid} THEN CAST({raw} AS VARCHAR) WHEN {empty} THEN '' ELSE {canonical} END"
    );
    let sort =
        format!("CASE WHEN {invalid} OR {empty} OR ({null}) THEN NULL ELSE {typed_sort} END");
    // Display spelling must not split typed-equal values (1/01, 1.2/1.20,
    // timestamps with equivalent offsets). Invalid values retain raw identity.
    let sql = if kind == ValueKind::String {
        // For strings the group keys already determine the display value.
        // Avoid retaining a second variable-length string in MIN for every group.
        format!("CREATE TEMP TABLE {table} AS SELECT CASE WHEN is_invalid THEN invalid_key WHEN is_empty THEN '' WHEN is_null THEN NULL ELSE sort_value END AS value, is_null, is_empty, is_invalid, count, sort_value FROM (SELECT is_null, is_empty, is_invalid, sort_value, invalid_key, count(*)::UBIGINT AS count FROM (SELECT {null} AS is_null, {empty} AS is_empty, {invalid} AS is_invalid, {sort} AS sort_value, CASE WHEN {invalid} THEN CAST({raw} AS VARCHAR) ELSE NULL END AS invalid_key FROM {source}) categorized GROUP BY is_null, is_empty, is_invalid, sort_value, invalid_key) counted")
    } else {
        format!("CREATE TEMP TABLE {table} AS SELECT min(display_value) AS value, is_null, is_empty, is_invalid, count(*)::UBIGINT AS count, sort_value FROM (SELECT {display} AS display_value, {null} AS is_null, {empty} AS is_empty, {invalid} AS is_invalid, {sort} AS sort_value, CASE WHEN {invalid} THEN CAST({raw} AS VARCHAR) ELSE NULL END AS invalid_key FROM {source}) categorized GROUP BY is_null, is_empty, is_invalid, sort_value, invalid_key")
    };
    connection.execute_batch(&sql).map_err(|error| {
        #[cfg(test)]
        eprintln!("column_values raw DuckDB materialization error: {error}");
        duckdb_error(error)
    })?;
    let count = connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(duckdb_error)?;
    safe_count(count)
}

fn logical_sort_expression(value: &str, kind: ValueKind) -> String {
    // Prepared CSV values may be canonical VARCHARs despite a numeric/temporal
    // logical schema. Keep grouping/display unchanged and construct an exact key.
    match kind {
        ValueKind::Int | ValueKind::Duration => format!("TRY_CAST({value} AS HUGEINT)"),
        ValueKind::Float => format!("TRY_CAST({value} AS DOUBLE)"),
        ValueKind::Boolean => format!("TRY_CAST({value} AS BOOLEAN)"),
        ValueKind::Date => format!("TRY_CAST({value} AS DATE)"),
        ValueKind::Timestamp => {
            let text = format!("CAST({value} AS VARCHAR)");
            // Parse the zone at whole-second precision; retain all nine fractional
            // digits separately instead of passing them through microsecond casts.
            format!("struct_pack(seconds := epoch_us(TRY_CAST(regexp_replace({text}, '\\.[0-9]+', '') AS TIMESTAMPTZ)), nanos := TRY_CAST(rpad(regexp_extract({text}, '\\.([0-9]+)', 1), 9, '0') AS BIGINT))")
        }
        ValueKind::Decimal => {
            // CSV decimal accepts arbitrary digit counts. A fixed DECIMAL scale
            // could round values or overflow. Compare sign, integer magnitude,
            // then digits directly. Trim insignificant zeroes; negative digits
            // are complemented, with ':' reversing the fractional-prefix order.
            let text = format!("CAST({value} AS VARCHAR)");
            let unsigned = format!("ltrim({text}, '+-')");
            let integer = format!("ltrim(split_part({unsigned}, '.', 1), '0')");
            let fraction = format!("rtrim(split_part({unsigned}, '.', 2), '0')");
            let sign = format!("CASE WHEN {integer} = '' AND {fraction} = '' THEN 0 WHEN starts_with({text}, '-') THEN -1 ELSE 1 END");
            format!("struct_pack(sign := {sign}, digits := ({sign}) * length({integer}), integral := CASE WHEN ({sign}) < 0 THEN translate({integer}, '0123456789', '9876543210') ELSE {integer} END, fractional := CASE WHEN ({sign}) < 0 THEN translate({fraction}, '0123456789', '9876543210') || ':' ELSE {fraction} END)")
        }
        _ => value.to_owned(),
    }
}

fn search_clause(search: Option<&str>) -> (&'static str, Vec<String>) {
    match search {
        Some(search) if !search.is_empty() => (
            "WHERE contains(dv_scalar_lower(coalesce(value, '')), dv_scalar_lower(?))",
            vec![search.to_owned()],
        ),
        _ => ("", Vec::new()),
    }
}

fn count_matches(
    connection: &Connection,
    table: &str,
    search: Option<&str>,
) -> Result<u64, DataError> {
    let (predicate, parameters) = search_clause(search);
    let count = connection
        .query_row(
            &format!("SELECT count(*) FROM {table} {predicate}"),
            params_from_iter(parameters.iter()),
            |row| row.get(0),
        )
        .map_err(duckdb_error)?;
    safe_count(count)
}

fn safe_count(value: u64) -> Result<u64, DataError> {
    if value > JS_MAX_SAFE_COUNT {
        Err(DataError::invalid_request(
            "The exact column-values count exceeds the UI integer precision limit.",
        ))
    } else {
        Ok(value)
    }
}

#[cfg(test)]
fn order_sql(order: ColumnValuesOrder) -> &'static str {
    match order {
        ColumnValuesOrder::ValueAscending => "sort_value ASC NULLS LAST, is_null, is_empty, is_invalid, value ASC NULLS LAST",
        ColumnValuesOrder::ValueDescending => "sort_value DESC NULLS LAST, is_null, is_empty, is_invalid, value DESC NULLS LAST",
        ColumnValuesOrder::CountDescending => "count DESC, sort_value ASC NULLS LAST, is_null, is_empty, is_invalid, value ASC NULLS LAST",
        ColumnValuesOrder::CountAscending => "count ASC, sort_value ASC NULLS LAST, is_null, is_empty, is_invalid, value ASC NULLS LAST",
    }
}

#[derive(Clone, Copy)]
struct ValueSelection {
    offset: u64,
    limit: usize,
    total: u64,
    seek: Option<(u64, bool)>,
}

struct ValueRow {
    id: u64,
    value: ColumnValue,
}

fn order_terms(order: ColumnValuesOrder, reverse: bool) -> Vec<(&'static str, bool, bool)> {
    let mut terms = Vec::with_capacity(7);
    if matches!(
        order,
        ColumnValuesOrder::CountAscending | ColumnValuesOrder::CountDescending
    ) {
        terms.push(("count", order == ColumnValuesOrder::CountAscending, true));
    }
    terms.push((
        "sort_value",
        order != ColumnValuesOrder::ValueDescending,
        true,
    ));
    terms.extend([
        ("is_null", true, true),
        ("is_empty", true, true),
        ("is_invalid", true, true),
        // Each valid typed key has one group. Only NULL keys need the raw-value
        // tie break; avoid duplicating every valid long string in sort buffers.
        (
            "CASE WHEN sort_value IS NULL THEN value ELSE NULL END",
            order != ColumnValuesOrder::ValueDescending,
            true,
        ),
        ("__cv_rowid", true, true),
    ]);
    if reverse {
        for (_, ascending, nulls_last) in &mut terms {
            *ascending = !*ascending;
            *nulls_last = !*nulls_last;
        }
    }
    terms
}

fn ordered_terms_sql(terms: &[(&str, bool, bool)]) -> String {
    terms
        .iter()
        .map(|(term, ascending, nulls_last)| {
            format!(
                "{term} {} NULLS {}",
                if *ascending { "ASC" } else { "DESC" },
                if *nulls_last { "LAST" } else { "FIRST" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn anchor_comparison(terms: &[(&str, bool, bool)], prefix: &str) -> (String, String) {
    let anchors = terms
        .iter()
        .enumerate()
        .map(|(i, (term, _, _))| format!("{term} AS {prefix}_{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut equal = Vec::new();
    let mut comparisons = Vec::new();
    for (i, (term, ascending, nulls_last)) in terms.iter().enumerate() {
        let anchor = format!("{prefix}_{i}");
        let null_after = if *nulls_last {
            format!("({term}) IS NULL AND {anchor} IS NOT NULL")
        } else {
            format!("({term}) IS NOT NULL AND {anchor} IS NULL")
        };
        let comparison = format!(
            "(({term}) {} {anchor} OR ({null_after}))",
            if *ascending { ">" } else { "<" }
        );
        comparisons.push(if equal.is_empty() {
            comparison
        } else {
            format!("({} AND {comparison})", equal.join(" AND "))
        });
        equal.push(format!("({term}) IS NOT DISTINCT FROM {anchor}"));
    }
    (anchors, comparisons.join(" OR "))
}

fn rank_range_sql(
    table: &str,
    search: Option<&str>,
    order: ColumnValuesOrder,
    lower: Option<u64>,
    upper: Option<u64>,
    before: Option<u64>,
) -> (String, Vec<String>) {
    let data = format!("(SELECT rowid AS __cv_rowid, * FROM {table})");
    let mut from = format!("FROM {data} d");
    let mut predicates = Vec::new();
    let mut parameters = Vec::new();
    for (anchor, reverse, prefix) in [
        (lower, false, "__lo"),
        (upper, true, "__hi"),
        (before, true, "__pivot"),
    ] {
        if let Some(anchor) = anchor {
            let (fields, comparison) = anchor_comparison(&order_terms(order, reverse), prefix);
            from.push_str(&format!(" CROSS JOIN (SELECT {fields} FROM {data} a WHERE __cv_rowid = CAST(? AS BIGINT)) {prefix}"));
            parameters.push(anchor.to_string());
            predicates.push(format!("({comparison})"));
        }
    }
    let (search, search_parameters) = search_clause(search);
    if let Some(search) = search.strip_prefix("WHERE ") {
        predicates.push(search.to_owned());
    }
    parameters.extend(search_parameters);
    if !predicates.is_empty() {
        from.push_str(&format!(" WHERE {}", predicates.join(" AND ")));
    }
    (from, parameters)
}

fn resolve_selection(
    connection: &Connection,
    table: &str,
    search: Option<&str>,
    order: ColumnValuesOrder,
    mut selection: ValueSelection,
    mut validate: impl FnMut() -> Result<(), DataError>,
) -> Result<ValueSelection, DataError> {
    let take = selection
        .limit
        .min(selection.total.saturating_sub(selection.offset) as usize);
    if selection.seek.is_some()
        || selection.offset == 0
        || take == 0
        || selection
            .total
            .saturating_sub(selection.offset + take as u64)
            <= 4096
    {
        return Ok(selection);
    }
    let mut target = selection.offset - 1;
    let mut remaining = selection.total;
    let mut lower = None;
    let mut upper = None;
    let ordered = ordered_terms_sql(&order_terms(order, false));
    for iteration in 0_u64..64 {
        validate()?;
        let (range, parameters) = rank_range_sql(table, search, order, lower, upper, None);
        if remaining <= 4096 {
            let mut parameters = parameters;
            parameters.push((target + 1).to_string());
            let mut statement = connection
                .prepare(&format!(
                    "SELECT __cv_rowid {range} ORDER BY {ordered} LIMIT CAST(? AS BIGINT)"
                ))
                .map_err(duckdb_error)?;
            let ids = statement
                .query_map(params_from_iter(parameters.iter()), |row| {
                    row.get::<_, u64>(0)
                })
                .map_err(duckdb_error)?
                .collect::<duckdb::Result<Vec<_>>>()
                .map_err(duckdb_error)?;
            if ids.len() as u64 != target + 1 {
                return Err(DataError::query_failed(
                    "The column-values rank range changed during lookup.",
                ));
            }
            let anchor = ids.last().copied().ok_or_else(|| {
                DataError::query_failed("The column-values rank range became unavailable.")
            })?;
            selection.seek = Some((anchor, false));
            return Ok(selection);
        }
        // Only fixed-width row identities enter the sample heap and Rust Vec.
        // Sort at most 257 corresponding typed keys to choose a median pivot.
        let seed = 0x9E37_79B9_u64.wrapping_add(iteration);
        let mut statement = connection
            .prepare(&format!(
                "SELECT __cv_rowid {range} ORDER BY hash(__cv_rowid, {seed}::UBIGINT), __cv_rowid LIMIT 257"
            ))
            .map_err(duckdb_error)?;
        let ids = statement
            .query_map(params_from_iter(parameters.iter()), |row| {
                row.get::<_, u64>(0)
            })
            .map_err(duckdb_error)?
            .collect::<duckdb::Result<Vec<_>>>()
            .map_err(duckdb_error)?;
        if ids.is_empty() {
            return Err(DataError::query_failed(
                "The column-values rank range became unavailable.",
            ));
        }
        let literals = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        validate()?;
        let mut statement = connection.prepare(&format!("SELECT rowid AS __cv_rowid FROM {table} WHERE rowid IN ({literals}) ORDER BY {ordered}")).map_err(duckdb_error)?;
        let pivots = statement
            .query_map([], |row| row.get::<_, u64>(0))
            .map_err(duckdb_error)?
            .collect::<duckdb::Result<Vec<_>>>()
            .map_err(duckdb_error)?;
        let pivot = pivots.get(pivots.len() / 2).copied().ok_or_else(|| {
            DataError::query_failed("The column-values sample became unavailable.")
        })?;
        validate()?;
        let (before, parameters) = rank_range_sql(table, search, order, lower, upper, Some(pivot));
        let count: u64 = connection
            .query_row(
                &format!("SELECT count(*) {before}"),
                params_from_iter(parameters.iter()),
                |row| row.get(0),
            )
            .map_err(duckdb_error)?;
        if count >= remaining {
            return Err(DataError::query_failed(
                "The column-values pivot is outside its rank range.",
            ));
        }
        if count == target {
            selection.seek = Some((pivot, false));
            return Ok(selection);
        }
        if target < count {
            upper = Some(pivot);
            remaining = count;
        } else {
            lower = Some(pivot);
            target -= count + 1;
            remaining -= count + 1;
        }
    }
    Err(DataError::query_failed(
        "The column-values rank lookup exceeded its bounded work limit.",
    ))
}

fn selected_values_sql(
    table: &str,
    search: Option<&str>,
    order: ColumnValuesOrder,
    selection: ValueSelection,
    projection: &str,
) -> Result<(String, Vec<String>, bool), DataError> {
    let data = format!("(SELECT rowid AS __cv_rowid, * FROM {table})");
    let (predicate, mut parameters) = search_clause(search);
    let take = selection
        .limit
        .min(selection.total.saturating_sub(selection.offset) as usize);
    if take == 0 {
        return Ok((
            format!("SELECT {projection} FROM {data} d WHERE false"),
            Vec::new(),
            false,
        ));
    }
    if let Some((anchor, backward)) = selection.seek {
        let terms = order_terms(order, backward);
        let (anchors, comparison) = anchor_comparison(&terms, "__a");
        parameters.insert(0, anchor.to_string());
        parameters.push(take.to_string());
        let filter = if predicate.is_empty() {
            "WHERE".to_owned()
        } else {
            format!("{predicate} AND")
        };
        let sql = format!("WITH anchor AS (SELECT {anchors} FROM {data} d WHERE __cv_rowid = CAST(? AS BIGINT)) SELECT {projection} FROM {data} d CROSS JOIN anchor {filter} ({comparison}) ORDER BY {} LIMIT CAST(? AS BIGINT)", ordered_terms_sql(&terms));
        return Ok((sql, parameters, backward));
    }
    let forward = ordered_terms_sql(&order_terms(order, false));
    if selection.offset == 0 {
        parameters.push(take.to_string());
        return Ok((format!("SELECT {projection} FROM {data} d {predicate} ORDER BY {forward} LIMIT CAST(? AS BIGINT)"), parameters, false));
    }
    let tail = selection
        .total
        .saturating_sub(selection.offset + take as u64);
    if tail <= 4096 {
        let backward = ordered_terms_sql(&order_terms(order, true));
        parameters.push((tail + take as u64).to_string());
        parameters.push(tail.to_string());
        return Ok((format!("SELECT {projection} FROM (SELECT *, row_number() OVER (ORDER BY {backward}) AS __cv_position FROM (SELECT * FROM {data} d {predicate} ORDER BY {backward} LIMIT CAST(? AS BIGINT)) tail) ranked WHERE __cv_position > CAST(? AS BIGINT) ORDER BY __cv_position"), parameters, true));
    }
    Err(DataError::query_failed(
        "The internal column-values rank anchor was not resolved.",
    ))
}

fn read_selected_values(
    connection: &Connection,
    table: &str,
    search: Option<&str>,
    order: ColumnValuesOrder,
    selection: ValueSelection,
    preview: bool,
) -> Result<Vec<ValueRow>, DataError> {
    let selection = resolve_selection(connection, table, search, order, selection, || Ok(()))?;
    let selected = if preview {
        format!("substring(value, 1, {PREVIEW_CHARACTERS})")
    } else {
        "value".to_owned()
    };
    let projection = format!("{selected}, is_null, is_empty, is_invalid, count, length(value) > {PREVIEW_CHARACTERS}, __cv_rowid");
    let (sql, parameters, reverse) =
        selected_values_sql(table, search, order, selection, &projection)?;
    let mut statement = connection.prepare(&sql).map_err(duckdb_error)?;
    let mut rows = statement
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok(ValueRow {
                id: row.get(6)?,
                value: ColumnValue {
                    value: row.get(0)?,
                    is_null: row.get(1)?,
                    is_empty: row.get(2)?,
                    is_invalid: row.get(3)?,
                    count: row.get(4)?,
                    truncated: row.get::<_, Option<bool>>(5)?.unwrap_or(false),
                },
            })
        })
        .map_err(duckdb_error)?
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(duckdb_error)?;
    for row in &rows {
        safe_count(row.value.count)?;
    }
    if reverse {
        rows.reverse();
    }
    Ok(rows)
}

#[cfg(test)]
fn read_values(
    connection: &Connection,
    table: &str,
    search: Option<&str>,
    order: ColumnValuesOrder,
    offset: u64,
    limit: usize,
    preview: bool,
) -> Result<Vec<ColumnValue>, DataError> {
    let total = count_matches(connection, table, search)?;
    Ok(read_selected_values(
        connection,
        table,
        search,
        order,
        ValueSelection {
            offset,
            limit,
            total,
            seek: None,
        },
        preview,
    )?
    .into_iter()
    .map(|row| row.value)
    .collect())
}

struct ColumnValuesReader {
    service: Arc<QueryService>,
    task: Arc<ColumnValuesTask>,
    snapshot: Arc<ColumnValuesSnapshot>,
    request: ColumnValuesCopyRequest,
    row_count: u64,
    anchors: Mutex<std::collections::VecDeque<(u64, u64)>>,
}

impl crate::copy::CopyRowReader for ColumnValuesReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.validate_current()?;
        let expected = if self.request.include_counts {
            vec!["Value".to_owned(), "Count".to_owned()]
        } else {
            vec!["Value".to_owned()]
        };
        if columns != expected
            || limit == 0
            || limit > COPY_MAX_BATCH_CELLS / expected.len()
            || offset > JS_MAX_SAFE_COUNT
        {
            return Err(DataError::invalid_request(
                "Invalid column-values copy batch.",
            ));
        }
        let mut anchors = self.anchors.lock().map_err(|_| registry_error())?;
        let anchor = anchors
            .iter()
            .find(|(position, _)| *position == offset)
            .map(|(_, id)| *id);
        let values = self.service.with_column_values_connection(&self.task, &self.snapshot, |connection, monitor| {
            // CopyManager continues bounded partial pages when has_more is true.
            // Preflight full UTF-8 bytes, including the optional frequency column,
            // before allocating Rust strings; long values reduce the batch further.
            let mut bounded_limit = limit.min(COPY_BATCH_ROWS);
            let mut selection = ValueSelection { offset, limit: bounded_limit, total: self.row_count, seek: anchor.map(|id| (id, false)) };
            loop {
                selection.limit = bounded_limit;
                selection = resolve_selection(connection, &self.snapshot.table, self.request.search.as_deref(), self.request.order, selection, || { check_task(&self.task)?; monitor.check() })?;
                let count_bytes = if self.request.include_counts {
                    "+ octet_length(encode(CAST(count AS VARCHAR)))"
                } else { "" };
                let (selected, parameters, _) = selected_values_sql(&self.snapshot.table, self.request.search.as_deref(), self.request.order, selection, "value, count")?;
                let sql = format!("SELECT CAST(coalesce(sum(coalesce(octet_length(encode(value)), 0) {count_bytes}), 0) AS UBIGINT) FROM ({selected}) batch");
                let bytes: u64 = connection.query_row(&sql, params_from_iter(parameters.iter()), |row| row.get(0)).map_err(duckdb_error)?;
                if bytes <= COPY_MAX_BATCH_ESTIMATED_BYTES as u64 {break read_selected_values(connection, &self.snapshot.table, self.request.search.as_deref(), self.request.order, selection, false);}
                if bounded_limit <= 1 {return Err(DataError::invalid_request("A column value exceeds the copy batch byte limit."));}
                bounded_limit = bounded_limit.div_ceil(2);
                check_task(&self.task)?;
            }
        })?;
        let last_id = values.last().map(|row| row.id);
        let mut estimated = 0_usize;
        let mut rows = Vec::with_capacity(values.len());
        for row in values {
            let value = row.value;
            let cell = if value.is_null {
                DataValue::null()
            } else {
                let mut cell =
                    DataValue::displayed(ValueKind::String, value.value.unwrap_or_default());
                if value.is_invalid {
                    cell.state = crate::domain::DataValueState::Invalid;
                }
                cell
            };
            estimated = estimated.saturating_add(cell.display.as_ref().map_or(0, String::len));
            if estimated > COPY_MAX_BATCH_ESTIMATED_BYTES {
                return Err(DataError::invalid_request(
                    "Column-values copy batch exceeds its byte limit.",
                ));
            }
            let mut row = vec![cell];
            if self.request.include_counts {
                row.push(DataValue::displayed(
                    ValueKind::Int,
                    value.count.to_string(),
                ));
            }
            rows.push(row);
        }
        self.validate_current()?;
        if let Some(last_id) = last_id {
            let end = offset.saturating_add(rows.len() as u64);
            anchors.retain(|(position, _)| *position != end);
            anchors.push_back((end, last_id));
            while anchors.len() > 4 {
                anchors.pop_front();
            }
        }
        let total = self.row_count;
        Ok(DataPage {
            offset,
            limit,
            columns: expected,
            total_rows: Some(total),
            has_more: offset.saturating_add(rows.len() as u64) < total,
            rows,
        })
    }

    fn validate_current(&self) -> Result<(), DataError> {
        let current = self.service.column_values_task(
            &self.request.document_id,
            &self.request.session_id,
            &self.request.operation_id,
        )?;
        if !Arc::ptr_eq(&current, &self.task) {
            return Err(DataError::invalid_request(
                "The column-values snapshot changed.",
            ));
        }
        check_task(&self.task)?;
        self.snapshot.validate_source()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p21_distinct_cancelled_worker_slots_remain_bounded_until_threads_finish() {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut permits = (0..MAX_SNAPSHOTS)
            .map(|_| ColumnValuesWorkerPermit::acquire(Arc::clone(&count)).unwrap())
            .collect::<Vec<_>>();
        assert!(ColumnValuesWorkerPermit::acquire(Arc::clone(&count)).is_err());
        permits.pop();
        let last = ColumnValuesWorkerPermit::acquire(Arc::clone(&count)).unwrap();
        assert_eq!(count.load(Ordering::Acquire), MAX_SNAPSHOTS);
        drop(last);
        drop(permits);
        assert_eq!(count.load(Ordering::Acquire), 0);
    }

    fn grouped() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .register_scalar_function::<ScalarLower>(SCALAR_LOWER_FUNCTION)
            .unwrap();
        connection.execute_batch("CREATE TABLE source(value BIGINT, raw VARCHAR, invalid BOOLEAN); INSERT INTO source VALUES (1, '01', false), (1, '1', false), (10, '10', false), (2, '2', false), (NULL, 'NULL', false), (NULL, '', false), (NULL, 'bad', true), (NULL, 'bad', true)").unwrap();
        assert_eq!(
            materialize_values(
                &connection,
                "grouped",
                "value",
                "raw",
                "invalid",
                "source",
                ValueKind::Int
            )
            .unwrap(),
            6
        );
        connection
    }

    #[test]
    #[ignore = "Focused 5.85M cursor/read/copy selection gate at the production 128MiB/512MiB limits"]
    fn p21_category_cursor_5850000_128m_512m() {
        let fixture = tempfile::tempdir().unwrap();
        let connection =
            Connection::open_in_memory_with_flags(query_connection_config().unwrap()).unwrap();
        connection.execute_batch(&format!("SET memory_limit='128MiB'; SET max_temp_directory_size='512MiB'; SET temp_directory={}", quote_literal(&fixture.path().join("spill").to_string_lossy()))).unwrap();
        let input = if let Some(path) = std::env::var_os("DATA_VIEWER_P21_CATEGORY_PREPARED") {
            format!(
                "read_parquet({})",
                quote_literal(&std::path::PathBuf::from(path).to_string_lossy())
            )
        } else {
            "(SELECT 'category-' || lpad(to_hex(CAST((i::UHUGEINT * 11400714819323198485::UHUGEINT) % 18446744073709551616::UHUGEINT AS UBIGINT)), 16, '0') AS __dv_base_raw_2, (hash(i) % 16)::UBIGINT AS __dv_state_word_0 FROM range(5850000) AS r(i))".to_owned()
        };
        let state = "((p.__dv_state_word_0 >> 4) & 3)";
        let source_sql = format!("SELECT CASE {state} WHEN 0 THEN p.__dv_base_raw_2 WHEN 2 THEN '' WHEN 3 THEN p.__dv_base_raw_2 ELSE NULL END AS value, p.__dv_base_raw_2 AS raw, ({state}=3) AS invalid FROM {input} p");
        let catalog = fixture.path().join("prepared.duckdb");
        {
            let builder =
                Connection::open_with_flags(&catalog, query_connection_config().unwrap()).unwrap();
            builder.execute_batch(&format!("SET max_temp_directory_size='16MiB'; CREATE VIEW dv_source AS {source_sql}; CHECKPOINT")).unwrap();
        }
        let keeper = Connection::open_with_flags(
            &catalog,
            query_connection_config()
                .unwrap()
                .access_mode(AccessMode::ReadOnly)
                .unwrap(),
        )
        .unwrap();
        connection.execute_batch(&format!("ATTACH {} AS dv_prepared (READ_ONLY); CREATE VIEW source AS SELECT * FROM dv_prepared.dv_source", quote_literal(&catalog.to_string_lossy()))).unwrap();
        print_category_settings(&connection, "cursor-gate");
        assert_eq!(
            materialize_values(
                &connection,
                "grouped",
                "value",
                "raw",
                "invalid",
                "source",
                ValueKind::String
            )
            .unwrap(),
            5_850_000
        );
        let mut failures = Vec::new();
        for order in [
            ColumnValuesOrder::ValueAscending,
            ColumnValuesOrder::ValueDescending,
            ColumnValuesOrder::CountAscending,
            ColumnValuesOrder::CountDescending,
        ] {
            for offset in [0_u64, 2_925_000, 5_849_800] {
                let selection = ValueSelection {
                    offset,
                    limit: 200,
                    total: 5_850_000,
                    seek: None,
                };
                let started = std::time::Instant::now();
                let page = match read_selected_values(
                    &connection,
                    "grouped",
                    None,
                    order,
                    selection,
                    false,
                ) {
                    Ok(page) => page,
                    Err(error) => {
                        failures.push(format!("{order:?}@{offset}: {error}"));
                        continue;
                    }
                };
                eprintln!(
                    "cursor-gate {order:?}@{offset}: {:?}, rows={}",
                    started.elapsed(),
                    page.len()
                );
                assert_eq!(page.len(), 200);
                let first = page[0].value.value.as_ref().unwrap();
                let comparison = if order == ColumnValuesOrder::ValueDescending {
                    ">"
                } else {
                    "<"
                };
                let before: u64 = connection
                    .query_row(
                        &format!("SELECT count(*) FROM grouped WHERE value {comparison} ?"),
                        params![first],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(before, offset, "independent rank oracle {order:?}");
                if offset + 200 < selection.total {
                    let next_selection = ValueSelection {
                        offset: offset + 200,
                        seek: Some((page.last().unwrap().id, false)),
                        ..selection
                    };
                    let (sql, parameters, _) =
                        selected_values_sql("grouped", None, order, next_selection, "value, count")
                            .unwrap();
                    assert!(!sql.contains("OFFSET"));
                    let bytes: u64 = connection.query_row(&format!("SELECT CAST(sum(octet_length(encode(value))) AS UBIGINT) FROM ({sql}) batch"), params_from_iter(parameters.iter()), |row| row.get(0)).unwrap();
                    assert_eq!(bytes, 25 * 200);
                    let next = read_selected_values(
                        &connection,
                        "grouped",
                        None,
                        order,
                        next_selection,
                        false,
                    )
                    .unwrap();
                    let previous = read_selected_values(
                        &connection,
                        "grouped",
                        None,
                        order,
                        ValueSelection {
                            seek: Some((next[0].id, true)),
                            ..selection
                        },
                        false,
                    )
                    .unwrap();
                    assert_eq!(
                        previous.iter().map(|row| row.id).collect::<Vec<_>>(),
                        page.iter().map(|row| row.id).collect::<Vec<_>>()
                    );
                }
            }
        }
        drop(connection);
        drop(keeper);
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    #[ignore = "Focused 5.85M high-cardinality string spill regression; run explicitly"]
    fn p21_category_high_cardinality_strings_5850000_bounded_spill() {
        let prepared =
            std::env::var_os("DATA_VIEWER_P21_CATEGORY_PREPARED").map(std::path::PathBuf::from);
        let input = if let Some(prepared) = prepared {
            eprintln!("high-cardinality source: read-only prepared.parquet");
            format!(
                "read_parquet({})",
                quote_literal(&prepared.to_string_lossy())
            )
        } else {
            eprintln!("high-cardinality source: synthetic 5.85M bijective 25-byte labels");
            "(SELECT 'category-' || lpad(to_hex(CAST((i::UHUGEINT * 11400714819323198485::UHUGEINT) % 18446744073709551616::UHUGEINT AS UBIGINT)), 16, '0') AS __dv_base_raw_2, (hash(i) % 16)::UBIGINT AS __dv_state_word_0 FROM range(5850000) AS r(i))".to_owned()
        };
        // Exact untrimmed Text mapping for sourceIndex=2 in CsvSource::prepared_view_sql.
        let state = "((p.__dv_state_word_0 >> 4) & 3)";
        let source_sql = format!("SELECT CASE {state} WHEN 0 THEN p.__dv_base_raw_2 WHEN 2 THEN '' WHEN 3 THEN p.__dv_base_raw_2 ELSE NULL END AS value, p.__dv_base_raw_2 AS raw, ({state} = 3) AS invalid FROM {input} p");
        let mut failures = Vec::new();
        for attached in [false, true] {
            let fixture = tempfile::tempdir().unwrap();
            let spill = fixture.path().join("query-spill");
            let build_spill = fixture.path().join("builder-spill");
            std::fs::create_dir_all(&spill).unwrap();
            std::fs::create_dir_all(&build_spill).unwrap();
            let connection =
                Connection::open_in_memory_with_flags(query_connection_config().unwrap()).unwrap();
            connection.execute_batch(&format!(
                "SET memory_limit = '128MiB'; SET threads = 4; SET max_temp_directory_size = '5GiB'; SET temp_directory = {}",
                quote_literal(&spill.to_string_lossy()))).unwrap();
            print_category_settings(
                &connection,
                if attached { "before-attach" } else { "direct" },
            );
            let keeper = if attached {
                let catalog = fixture.path().join("prepared.duckdb");
                {
                    let builder =
                        Connection::open_with_flags(&catalog, query_connection_config().unwrap())
                            .unwrap();
                    builder.execute_batch(&format!("SET temp_directory = {}; SET max_temp_directory_size = '16MiB'; CREATE VIEW dv_source AS {source_sql}; CHECKPOINT", quote_literal(&build_spill.to_string_lossy()))).unwrap();
                    print_category_settings(&builder, "builder-16MiB");
                }
                let keeper = Connection::open_with_flags(
                    &catalog,
                    query_connection_config()
                        .unwrap()
                        .access_mode(AccessMode::ReadOnly)
                        .unwrap(),
                )
                .unwrap();
                print_category_settings(&keeper, "read-only-keeper");
                connection.execute_batch(&format!("ATTACH {} AS dv_prepared (READ_ONLY); CREATE VIEW source AS SELECT * FROM dv_prepared.dv_source", quote_literal(&catalog.to_string_lossy()))).unwrap();
                print_category_settings(&connection, "after-attach");
                Some(keeper)
            } else {
                connection
                    .execute_batch(&format!("CREATE VIEW source AS {source_sql}"))
                    .unwrap();
                None
            };
            let peak = Arc::new(AtomicU64::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let sampler_peak = Arc::clone(&peak);
            let sampler_stop = Arc::clone(&stop);
            let spill_path = fixture.path().to_path_buf();
            let sampler = std::thread::spawn(move || {
                while !sampler_stop.load(Ordering::Acquire) {
                    let bytes = category_spill_bytes(&spill_path);
                    sampler_peak.fetch_max(bytes, Ordering::AcqRel);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            });
            let start = std::time::Instant::now();
            let result = materialize_values(
                &connection,
                "grouped",
                "value",
                "raw",
                "invalid",
                "source",
                ValueKind::String,
            );
            eprintln!("high-cardinality attached={attached} elapsed={:?}, peak_spill_bytes={}, result={result:?}", start.elapsed(), peak.load(Ordering::Acquire));
            match result {
                Ok(count) => {
                    assert_eq!(count, 5_850_000);
                    assert!(peak.load(Ordering::Acquire) < 5 * 1024 * 1024 * 1024);
                    let rows: u64 = connection
                        .query_row(
                            "SELECT CAST(sum(count) AS UBIGINT) FROM grouped",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(rows, 5_850_000);
                    if attached {
                        failures.extend(category_paging_diagnostics(&connection));
                        connection
                            .execute_batch(
                                "DROP TABLE grouped; SET max_temp_directory_size = '512MiB'",
                            )
                            .unwrap();
                        peak.store(0, Ordering::Release);
                        let started = std::time::Instant::now();
                        let original = materialize_values(
                            &connection,
                            "grouped",
                            "value",
                            "raw",
                            "invalid",
                            "source",
                            ValueKind::Unsupported,
                        );
                        eprintln!(
                            "category 512MiB original MIN: elapsed={:?}, peak_spill_bytes={}, result={original:?}",
                            started.elapsed(), peak.load(Ordering::Acquire)
                        );
                        connection
                            .execute_batch("DROP TABLE IF EXISTS grouped")
                            .unwrap();
                        peak.store(0, Ordering::Release);
                        let started = std::time::Instant::now();
                        let candidate = category_count_only_materialize(&connection);
                        eprintln!("category 512MiB count-only candidate: elapsed={:?}, peak_spill_bytes={}, RAW_RESULT={candidate:?}", started.elapsed(), peak.load(Ordering::Acquire));
                        if candidate.is_ok() {
                            let count: u64 = connection
                                .query_row("SELECT count(*) FROM grouped", [], |row| row.get(0))
                                .unwrap();
                            assert_eq!(count, 5_850_000);
                        } else {
                            failures.push(format!("512MiB count-only: {candidate:?}"));
                        }
                    }
                }
                Err(error) => failures.push(format!("attached={attached}: {error}")),
            }
            stop.store(true, Ordering::Release);
            sampler.join().unwrap();
            eprintln!(
                "category attached={attached} final-phase peak_spill_bytes={}",
                peak.load(Ordering::Acquire)
            );
            drop(connection);
            drop(keeper);
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    fn print_category_settings(connection: &Connection, stage: &str) {
        let settings: String = connection.query_row("SELECT 'memory=' || current_setting('memory_limit') || ',threads=' || current_setting('threads')::VARCHAR || ',temp_cap=' || current_setting('max_temp_directory_size') || ',temp_dir=' || current_setting('temp_directory')", [], |row| row.get(0)).unwrap();
        eprintln!("high-cardinality {stage}: {settings}");
    }

    fn category_spill_bytes(root: &Path) -> u64 {
        let mut pending = vec![root.to_path_buf()];
        let mut bytes = 0_u64;
        while let Some(directory) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else if metadata.is_file() && entry.file_name() != "prepared.duckdb" {
                    bytes = bytes.saturating_add(metadata.len());
                }
            }
        }
        bytes
    }

    fn category_count_only_materialize(connection: &Connection) -> Result<(), DataError> {
        materialize_values(
            connection,
            "grouped",
            "value",
            "raw",
            "invalid",
            "source",
            ValueKind::String,
        )
        .map(|_| ())
    }

    fn category_window_sql(table: &str, order: ColumnValuesOrder) -> String {
        format!("SELECT value FROM (SELECT value, row_number() OVER (ORDER BY {}) AS position FROM {table}) ranked WHERE position > CAST(? AS BIGINT) AND position <= CAST(? AS BIGINT) ORDER BY position", order_sql(order))
    }

    fn category_read_diagnostic(
        connection: &Connection,
        label: &str,
        sql: &str,
        parameters: [u64; 2],
    ) -> Result<Vec<String>, String> {
        let start = std::time::Instant::now();
        let result = (|| {
            let mut statement = connection.prepare(sql)?;
            let rows = statement.query_map(params![parameters[0], parameters[1]], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<duckdb::Result<Vec<_>>>()
        })();
        match result {
            Ok(values) => {
                eprintln!(
                    "category page {label}: elapsed={:?}, rows={}, first={:?}, last={:?}",
                    start.elapsed(),
                    values.len(),
                    values.first(),
                    values.last()
                );
                Ok(values)
            }
            Err(error) => {
                eprintln!(
                    "category page {label}: elapsed={:?}, RAW_DUCKDB_ERROR={error}",
                    start.elapsed()
                );
                Err(error.to_string())
            }
        }
    }

    fn category_paging_diagnostics(connection: &Connection) -> Vec<String> {
        let raw = format!("SELECT value FROM grouped ORDER BY {} LIMIT CAST(? AS BIGINT) OFFSET CAST(? AS BIGINT)", order_sql(ColumnValuesOrder::ValueAscending));
        let window = category_window_sql("grouped", ColumnValuesOrder::ValueAscending);
        for (label, sql, parameters) in [
            ("raw-offset", raw.as_str(), [200_u64, 5_849_800]),
            ("window-rank", window.as_str(), [5_849_800, 5_850_000]),
        ] {
            let mut statement = connection.prepare(&format!("EXPLAIN {sql}")).unwrap();
            let plans = statement
                .query_map(params![parameters[0], parameters[1]], |row| {
                    row.get::<_, String>(1)
                })
                .unwrap()
                .collect::<duckdb::Result<Vec<_>>>()
                .unwrap();
            eprintln!("category EXPLAIN {label}:\n{}", plans.join("\n"));
        }
        for (label, offset) in [("middle", 2_925_000_u64), ("last", 5_849_800)] {
            let _ = category_read_diagnostic(
                connection,
                &format!("raw-valueAscending-{label}"),
                &raw,
                [200, offset],
            );
        }
        let mut failures = Vec::new();
        for order in [
            ColumnValuesOrder::ValueAscending,
            ColumnValuesOrder::CountDescending,
        ] {
            let sql = category_window_sql("grouped", order);
            for (label, offset) in [("middle", 2_925_000_u64), ("last", 5_849_800)] {
                let name = format!("window-{order:?}-{label}-threads4");
                let result =
                    category_read_diagnostic(connection, &name, &sql, [offset, offset + 200]);
                let values = match result {
                    Ok(values) => values,
                    Err(error) => {
                        connection.execute_batch("SET threads = 1").unwrap();
                        let fallback = category_read_diagnostic(
                            connection,
                            &format!("window-{order:?}-{label}-threads1"),
                            &sql,
                            [offset, offset + 200],
                        );
                        connection.execute_batch("SET threads = 4").unwrap();
                        match fallback {
                            Ok(values) => values,
                            Err(fallback) => {
                                failures.push(format!("{name}: {error}; threads1: {fallback}"));
                                continue;
                            }
                        }
                    }
                };
                assert_eq!(values.len(), 200);
                assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
            }
        }
        failures
    }

    #[test]
    fn p21_distinct_groups_typed_equal_values_and_keeps_null_empty_invalid_separate() {
        let connection = grouped();
        let values = read_values(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::ValueAscending,
            0,
            200,
            true,
        )
        .unwrap();
        assert_eq!(
            values
                .iter()
                .take(3)
                .map(|v| v.value.as_deref())
                .collect::<Vec<_>>(),
            [Some("1"), Some("2"), Some("10")]
        );
        assert_eq!(values[0].count, 2);
        assert_eq!(values.iter().filter(|v| v.is_null).count(), 1);
        assert_eq!(values.iter().filter(|v| v.is_empty).count(), 1);
        assert_eq!(values.iter().find(|v| v.is_invalid).unwrap().count, 2);
    }

    #[test]
    fn p21_distinct_string_grouping_reconstructs_exact_values_and_categories() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE source(value VARCHAR, raw VARCHAR, invalid BOOLEAN); INSERT INTO source VALUES ('alpha', ' alpha ', false), ('alpha', 'alpha', false), ('beta', 'beta', false), ('', '', false), ('', '', false), (NULL, 'NULL', false), (NULL, 'N/A', false), (NULL, 'alpha', true), (NULL, 'alpha', true), (NULL, 'bad', true)").unwrap();
        assert_eq!(
            materialize_values(
                &connection,
                "grouped",
                "value",
                "raw",
                "invalid",
                "source",
                ValueKind::Unsupported
            )
            .unwrap(),
            6
        );
        let values = read_values(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::ValueAscending,
            0,
            200,
            false,
        )
        .unwrap();
        assert_eq!(
            values
                .iter()
                .map(|value| (
                    value.value.as_deref(),
                    value.is_null,
                    value.is_empty,
                    value.is_invalid,
                    value.count
                ))
                .collect::<Vec<_>>(),
            [
                (Some("alpha"), false, false, false, 2),
                (Some("beta"), false, false, false, 1),
                (Some("alpha"), false, false, true, 2),
                (Some("bad"), false, false, true, 1),
                (Some(""), false, true, false, 2),
                (None, true, false, false, 2),
            ]
        );
        connection.execute_batch("DROP TABLE grouped").unwrap();
        category_count_only_materialize(&connection).unwrap();
        let candidate = read_values(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::ValueAscending,
            0,
            200,
            false,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(candidate).unwrap(),
            serde_json::to_value(values).unwrap()
        );
    }

    #[test]
    fn p21_distinct_paging_search_and_frequency_order_share_exact_snapshot() {
        let connection = grouped();
        assert_eq!(count_matches(&connection, "grouped", None).unwrap(), 6);
        assert_eq!(count_matches(&connection, "grouped", Some("1")).unwrap(), 2);
        assert_eq!(
            read_values(
                &connection,
                "grouped",
                Some("1"),
                ColumnValuesOrder::ValueAscending,
                1,
                1,
                true
            )
            .unwrap()[0]
                .value
                .as_deref(),
            Some("10")
        );
        let count = read_values(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::CountDescending,
            0,
            2,
            true,
        )
        .unwrap();
        assert!(count.iter().all(|value| value.count == 2));
        let ascending = read_values(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::CountAscending,
            0,
            1,
            true,
        )
        .unwrap();
        assert_eq!(ascending[0].count, 1);
    }

    #[test]
    fn p21_distinct_unicode_preview_is_bounded_but_full_value_is_retained() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .register_scalar_function::<ScalarLower>(SCALAR_LOWER_FUNCTION)
            .unwrap();
        connection
            .execute_batch("CREATE TABLE source(value VARCHAR, raw VARCHAR, invalid BOOLEAN)")
            .unwrap();
        let original = "한글🙂".repeat(1000);
        connection
            .execute(
                "INSERT INTO source VALUES (?, ?, false)",
                params![original, original],
            )
            .unwrap();
        materialize_values(
            &connection,
            "grouped",
            "value",
            "raw",
            "invalid",
            "source",
            ValueKind::String,
        )
        .unwrap();
        let preview = read_values(
            &connection,
            "grouped",
            Some("한글"),
            ColumnValuesOrder::ValueAscending,
            0,
            1,
            true,
        )
        .unwrap();
        assert_eq!(
            preview[0].value.as_ref().unwrap().chars().count(),
            PREVIEW_CHARACTERS
        );
        assert!(preview[0].truncated);
        let full = read_values(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::ValueAscending,
            0,
            1,
            false,
        )
        .unwrap();
        assert_eq!(full[0].value.as_deref(), Some(original.as_str()));
    }

    #[test]
    fn p21_distinct_limits_search_sort_and_wire_counts_are_checked() {
        assert!(safe_count(JS_MAX_SAFE_COUNT).is_ok());
        assert!(safe_count(JS_MAX_SAFE_COUNT + 1).is_err());
        let mut request = ColumnValuesPageRequest {
            operation_id: "op".to_owned(),
            document_id: "doc".to_owned(),
            session_id: "session".to_owned(),
            search: None,
            order: ColumnValuesOrder::ValueAscending,
            offset: 0,
            limit: 1,
            cursor: None,
        };
        assert!(validate_page(&request).is_ok());
        request.limit = 201;
        assert!(validate_page(&request).is_err());
        request.limit = 200;
        request.search = Some("a".repeat(4097));
        assert!(validate_page(&request).is_err());
        request.search = Some("한".repeat(1365));
        assert!(validate_page(&request).is_ok());
        request.search = Some("x\0".to_owned());
        assert!(validate_page(&request).is_err());
        assert!(serde_json::from_str::<ColumnValuesPageRequest>(r#"{"operationId":"op","documentId":"doc","sessionId":"s","search":null,"order":"arbitrarySql","offset":0,"limit":1}"#).is_err());
    }

    fn wait_ready(service: &QueryService, operation: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let status = service
                .column_values_status("document", "session", operation)
                .unwrap();
            if status.state == ColumnValuesState::Ready {
                return;
            }
            assert!(
                !matches!(
                    status.state,
                    ColumnValuesState::Cancelled | ColumnValuesState::Failed
                ),
                "{status:?}"
            );
            assert!(std::time::Instant::now() < deadline, "{status:?}");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[derive(Default)]
    struct Clipboard(Mutex<Vec<String>>);
    impl crate::copy::ClipboardWriter for Clipboard {
        fn write_text(&self, value: String) -> Result<(), String> {
            self.0.lock().unwrap().push(value);
            Ok(())
        }
    }

    #[test]
    fn p21_distinct_source_copy_and_release_reject_stale_clipboard_commit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("values.csv");
        std::fs::write(&path, "value\napple\napple\npear\n").unwrap();
        let mut source = crate::data::DataSource::open(&path).unwrap();
        source
            .configure_csv(crate::domain::HeaderMode::Present)
            .unwrap();
        let spec = source.query_source_spec().unwrap();
        let service =
            Arc::new(QueryService::open(directory.path().join("cache"), 64 * 1024 * 1024).unwrap());
        service
            .start_column_values(
                StartColumnValuesRequest {
                    operation_id: "source-values".to_owned(),
                    document_id: "document".to_owned(),
                    session_id: "session".to_owned(),
                    query_id: None,
                    column_id: "value".to_owned(),
                },
                Some(spec),
            )
            .unwrap();
        wait_ready(&service, "source-values");
        let copy = service
            .column_values_copy_reader(ColumnValuesCopyRequest {
                operation_id: "source-values".to_owned(),
                document_id: "document".to_owned(),
                session_id: "session".to_owned(),
                search: None,
                order: ColumnValuesOrder::CountDescending,
                include_counts: true,
            })
            .unwrap();
        assert_eq!(copy.row_count, 2);
        let page = copy.reader.read_rows(0, 100, &copy.column_ids).unwrap();
        assert_eq!(page.rows[0][0].display.as_deref(), Some("apple"));
        assert_eq!(page.rows[0][1].display.as_deref(), Some("2"));
        let memory = Arc::new(Clipboard::default());
        let clipboard =
            copy.wrap_clipboard(Arc::clone(&memory) as Arc<dyn crate::copy::ClipboardWriter>);
        service
            .release_column_values("document", "session", "source-values")
            .unwrap();
        assert!(copy.reader.validate_current().is_err());
        assert!(clipboard.write_text("must not commit".to_owned()).is_err());
        assert!(memory.0.lock().unwrap().is_empty());
        service.shutdown();
    }

    #[test]
    fn p21_distinct_filtered_scope_is_exact_and_query_replacement_invalidates_snapshot() {
        use crate::domain::{FilterOperator, QueryFilter, QueryPlan, QueryScalarType};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("values.csv");
        std::fs::write(&path, "value\napple\napple\npear\n").unwrap();
        let mut source = crate::data::DataSource::open(&path).unwrap();
        source
            .configure_csv(crate::domain::HeaderMode::Present)
            .unwrap();
        let spec = source.query_source_spec().unwrap();
        let service =
            Arc::new(QueryService::open(directory.path().join("cache"), 64 * 1024 * 1024).unwrap());
        let query = ExecuteQueryRequest {
            document_id: "document".to_owned(),
            session_id: "session".to_owned(),
            query_id: "filtered".to_owned(),
            task_id: "filter-task".to_owned(),
            plan: QueryPlan {
                filters: vec![QueryFilter {
                    id: "only-apple".to_owned(),
                    column_id: "value".to_owned(),
                    scalar_type: QueryScalarType::Text,
                    operator: FilterOperator::Equals,
                    values: vec!["apple".to_owned()],
                }],
                search: None,
                sort: Vec::new(),
                projection: Vec::new(),
            },
        };
        service.execute(query.clone(), spec.clone()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let status = service
                .status("document", "session", "filtered", "filter-task")
                .unwrap();
            if status.state == QueryTaskState::Complete {
                break;
            }
            assert!(
                !matches!(
                    status.state,
                    QueryTaskState::Failed | QueryTaskState::Cancelled
                ),
                "{status:?}"
            );
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        for (operation, query_id, total) in [
            ("source-values", None, 2),
            ("filtered-values", Some("filtered".to_owned()), 1),
        ] {
            service
                .start_column_values(
                    StartColumnValuesRequest {
                        operation_id: operation.to_owned(),
                        document_id: "document".to_owned(),
                        session_id: "session".to_owned(),
                        query_id,
                        column_id: "value".to_owned(),
                    },
                    Some(spec.clone()),
                )
                .unwrap();
            wait_ready(&service, operation);
            assert_eq!(
                service
                    .column_values_status("document", "session", operation)
                    .unwrap()
                    .total_count,
                Some(total)
            );
        }
        let copy = service
            .column_values_copy_reader(ColumnValuesCopyRequest {
                operation_id: "filtered-values".to_owned(),
                document_id: "document".to_owned(),
                session_id: "session".to_owned(),
                search: None,
                order: ColumnValuesOrder::ValueAscending,
                include_counts: true,
            })
            .unwrap();
        let page = copy.reader.read_rows(0, 100, &copy.column_ids).unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0][0].display.as_deref(), Some("apple"));
        assert_eq!(page.rows[0][1].display.as_deref(), Some("2"));
        let mut replacement = query;
        replacement.task_id = "replacement-task".to_owned();
        replacement.query_id = "replacement".to_owned();
        replacement.plan.filters.clear();
        service.execute(replacement, spec).unwrap();
        assert!(copy.reader.validate_current().is_err());
        service.shutdown();
    }

    #[test]
    fn p21_distinct_cancelled_while_queued_does_not_create_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("values.csv");
        std::fs::write(&path, "value\napple\n").unwrap();
        let mut source = crate::data::DataSource::open(&path).unwrap();
        source
            .configure_csv(crate::domain::HeaderMode::Present)
            .unwrap();
        let service =
            Arc::new(QueryService::open(directory.path().join("cache"), 64 * 1024 * 1024).unwrap());
        // Local limiter isolates this deterministic cancellation test from other query tests.
        let limiter = Arc::new(QueryLimiter::default());
        let cancel = AtomicBool::new(false);
        let first = acquire_query_permit(&limiter, &cancel).unwrap();
        let second = acquire_query_permit(&limiter, &cancel).unwrap();
        let mut owned = Arc::try_unwrap(service).ok().unwrap();
        owned.query_limiter = limiter;
        let service = Arc::new(owned);
        service
            .start_column_values(
                StartColumnValuesRequest {
                    operation_id: "queued-values".to_owned(),
                    document_id: "document".to_owned(),
                    session_id: "session".to_owned(),
                    query_id: None,
                    column_id: "value".to_owned(),
                },
                Some(source.query_source_spec().unwrap()),
            )
            .unwrap();
        let status = service
            .cancel_column_values("document", "session", "queued-values")
            .unwrap();
        assert_eq!(status.state, ColumnValuesState::Cancelled);
        drop(first);
        drop(second);
        service.shutdown();
        assert_eq!(service.temp.usage().unwrap().active_queries, 0);
    }

    fn ready_read_fixture(filtered: bool) -> (tempfile::TempDir, Arc<QueryService>) {
        ready_read_fixture_csv(filtered, "value\napple\napple\npear\n")
    }

    fn ready_read_fixture_csv(filtered: bool, csv: &str) -> (tempfile::TempDir, Arc<QueryService>) {
        ready_read_fixture_profile(filtered, csv, None)
    }

    fn ready_read_fixture_profile(
        filtered: bool,
        csv: &str,
        target: Option<crate::domain::CsvTargetType>,
    ) -> (tempfile::TempDir, Arc<QueryService>) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("values.csv");
        std::fs::write(&path, csv).unwrap();
        let mut source = crate::data::DataSource::open(&path).unwrap();
        source
            .configure_csv(crate::domain::HeaderMode::Present)
            .unwrap();
        let source = if let Some(target) = target {
            let mut profile = source.active_csv_profile().unwrap();
            profile.mode = crate::domain::CsvProfileMode::Custom;
            profile.generation += 1;
            profile.columns[0].target_type = target;
            if target == crate::domain::CsvTargetType::Duration {
                profile.columns[0].duration_unit = Some(crate::domain::DurationUnit::Ns);
                profile.columns[0].duration_input_format =
                    Some(crate::domain::CsvDurationInputFormat::RawInteger);
            }
            source.prepare_csv_profile(&profile).unwrap()
        } else {
            source
        };
        let spec = source.query_source_spec().unwrap();
        let mut service =
            QueryService::open(directory.path().join("cache"), 64 * 1024 * 1024).unwrap();
        service.query_limiter = Arc::new(QueryLimiter::default());
        let service = Arc::new(service);
        if filtered {
            service
                .execute(
                    ExecuteQueryRequest {
                        document_id: "document".to_owned(),
                        session_id: "session".to_owned(),
                        query_id: "filtered".to_owned(),
                        task_id: "filtered-task".to_owned(),
                        plan: crate::domain::QueryPlan {
                            filters: Vec::new(),
                            search: None,
                            sort: Vec::new(),
                            projection: Vec::new(),
                        },
                    },
                    spec.clone(),
                )
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let status = service
                    .status("document", "session", "filtered", "filtered-task")
                    .unwrap();
                if status.state == QueryTaskState::Complete {
                    break;
                }
                assert!(
                    !matches!(
                        status.state,
                        QueryTaskState::Cancelled | QueryTaskState::Failed
                    ),
                    "{status:?}"
                );
                assert!(std::time::Instant::now() < deadline, "{status:?}");
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        service
            .start_column_values(
                StartColumnValuesRequest {
                    operation_id: "read-values".to_owned(),
                    document_id: "document".to_owned(),
                    session_id: "session".to_owned(),
                    query_id: filtered.then(|| "filtered".to_owned()),
                    column_id: "value".to_owned(),
                },
                Some(spec),
            )
            .unwrap();
        wait_ready(&service, "read-values");
        (directory, service)
    }

    fn read_request() -> ColumnValuesPageRequest {
        ColumnValuesPageRequest {
            operation_id: "read-values".to_owned(),
            document_id: "document".to_owned(),
            session_id: "session".to_owned(),
            search: None,
            order: ColumnValuesOrder::ValueAscending,
            offset: 0,
            limit: 10,
            cursor: None,
        }
    }

    #[test]
    fn p21_distinct_cursor_wire_shared_parity() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .map(|parent| parent.join("fixtures/phase-21/column-values-cursor-wire.json"))
            .find(|path| path.is_file())
            .unwrap();
        let cases: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for case in cases.as_array().unwrap() {
            let result = serde_json::from_value::<ColumnValuesPageRequest>(case["request"].clone())
                .and_then(|request| {
                    validate_page(&request).map_err(<serde_json::Error as serde::de::Error>::custom)
                });
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {result:?}",
                case["id"]
            );
        }
    }

    #[test]
    fn p21_distinct_seek_matches_independent_complete_order_in_both_directions() {
        let connection = grouped();
        for order in [
            ColumnValuesOrder::ValueAscending,
            ColumnValuesOrder::ValueDescending,
            ColumnValuesOrder::CountAscending,
            ColumnValuesOrder::CountDescending,
        ] {
            let mut statement = connection
                .prepare(&format!(
                    "SELECT rowid FROM grouped ORDER BY {}, rowid ASC",
                    order_sql(order)
                ))
                .unwrap();
            let oracle = statement
                .query_map([], |row| row.get::<_, u64>(0))
                .unwrap()
                .collect::<duckdb::Result<Vec<_>>>()
                .unwrap();
            let total = oracle.len() as u64;
            let mut actual = Vec::new();
            let mut anchor = None;
            let mut offset = 0;
            let mut pages = Vec::new();
            while offset < total {
                let selection = ValueSelection {
                    offset,
                    limit: 2,
                    total,
                    seek: anchor.map(|id| (id, false)),
                };
                let (sql, _, _) =
                    selected_values_sql("grouped", None, order, selection, "value").unwrap();
                assert!(!sql.contains("OFFSET"));
                let rows =
                    read_selected_values(&connection, "grouped", None, order, selection, false)
                        .unwrap();
                assert!(!rows.is_empty());
                let ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
                actual.extend(ids.iter().copied());
                anchor = ids.last().copied();
                offset += ids.len() as u64;
                pages.push(ids);
            }
            assert_eq!(actual, oracle, "{order:?}");
            for index in (1..pages.len()).rev() {
                let rows = read_selected_values(
                    &connection,
                    "grouped",
                    None,
                    order,
                    ValueSelection {
                        offset: ((index - 1) * 2) as u64,
                        limit: 2,
                        total,
                        seek: Some((pages[index][0], true)),
                    },
                    false,
                )
                .unwrap();
                assert_eq!(
                    rows.iter().map(|row| row.id).collect::<Vec<_>>(),
                    pages[index - 1],
                    "backward {order:?}"
                );
            }
            for offset in 0..=total {
                let rows = read_selected_values(
                    &connection,
                    "grouped",
                    None,
                    order,
                    ValueSelection {
                        offset,
                        limit: 2,
                        total,
                        seek: None,
                    },
                    false,
                )
                .unwrap();
                assert_eq!(
                    rows.iter().map(|row| row.id).collect::<Vec<_>>(),
                    oracle[offset as usize..]
                        .iter()
                        .take(2)
                        .copied()
                        .collect::<Vec<_>>()
                );
            }
        }
    }

    #[test]
    fn p21_distinct_bounded_rank_selection_matches_independent_sorted_oracle() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .register_scalar_function::<ScalarLower>(SCALAR_LOWER_FUNCTION)
            .unwrap();
        connection.execute_batch("CREATE TABLE source AS SELECT i::BIGINT AS value, i::VARCHAR AS raw, false AS invalid FROM range(12003) r(i) UNION ALL SELECT i::BIGINT, i::VARCHAR, false FROM range(12003) r(i) WHERE i % 3 = 0; INSERT INTO source VALUES (NULL, 'NULL', false), (NULL, '', false), (NULL, 'bad', true), (NULL, 'worse', true)").unwrap();
        let total = materialize_values(
            &connection,
            "grouped",
            "value",
            "raw",
            "invalid",
            "source",
            ValueKind::Int,
        )
        .unwrap();
        for search in [None, Some("1")] {
            for order in [
                ColumnValuesOrder::ValueAscending,
                ColumnValuesOrder::ValueDescending,
                ColumnValuesOrder::CountAscending,
                ColumnValuesOrder::CountDescending,
            ] {
                let (predicate, parameters) = search_clause(search);
                let mut statement = connection
                    .prepare(&format!(
                        "SELECT rowid FROM grouped {predicate} ORDER BY {}, rowid",
                        order_sql(order)
                    ))
                    .unwrap();
                let oracle = statement
                    .query_map(params_from_iter(parameters.iter()), |row| {
                        row.get::<_, u64>(0)
                    })
                    .unwrap()
                    .collect::<duckdb::Result<Vec<_>>>()
                    .unwrap();
                for offset in [1, oracle.len() as u64 / 3, oracle.len() as u64 / 2] {
                    let selection = ValueSelection {
                        offset,
                        limit: 20,
                        total: oracle.len() as u64,
                        seek: None,
                    };
                    let resolved =
                        resolve_selection(&connection, "grouped", search, order, selection, || {
                            Ok(())
                        })
                        .unwrap();
                    let (sql, _, _) =
                        selected_values_sql("grouped", search, order, resolved, "value").unwrap();
                    assert!(!sql.contains("OFFSET") && !sql.contains("WITH ranked"));
                    let actual = read_selected_values(
                        &connection,
                        "grouped",
                        search,
                        order,
                        resolved,
                        false,
                    )
                    .unwrap();
                    assert_eq!(
                        actual.iter().map(|row| row.id).collect::<Vec<_>>(),
                        oracle[offset as usize..]
                            .iter()
                            .take(20)
                            .copied()
                            .collect::<Vec<_>>(),
                        "{search:?}/{order:?}@{offset}"
                    );
                }
            }
        }
        let mut checks = 0;
        let error = resolve_selection(
            &connection,
            "grouped",
            None,
            ColumnValuesOrder::ValueAscending,
            ValueSelection {
                offset: total / 2,
                limit: 20,
                total,
                seek: None,
            },
            || {
                checks += 1;
                if checks == 2 {
                    Err(DataError::task_cancelled())
                } else {
                    Ok(())
                }
            },
        )
        .err()
        .unwrap();
        assert_eq!(checks, 2);
        assert_eq!(error.code, DataError::task_cancelled().code);
        // Rank values deliberately follow hash(rowid). A second hash argument
        // prevents that input distribution from biasing every sample pivot.
        connection.execute_batch("CREATE TABLE correlated AS SELECT hash(i)::VARCHAR AS value, false AS is_null, false AS is_empty, false AS is_invalid, 1::UBIGINT AS count, hash(i) AS sort_value FROM range(50003) r(i) ORDER BY i").unwrap();
        let mut statement = connection
            .prepare("SELECT rowid FROM correlated ORDER BY sort_value, rowid")
            .unwrap();
        let oracle = statement
            .query_map([], |row| row.get::<_, u64>(0))
            .unwrap()
            .collect::<duckdb::Result<Vec<_>>>()
            .unwrap();
        let rows = read_selected_values(
            &connection,
            "correlated",
            None,
            ColumnValuesOrder::ValueAscending,
            ValueSelection {
                offset: 25001,
                limit: 20,
                total: 50003,
                seek: None,
            },
            false,
        )
        .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            oracle[25001..25021]
        );
    }

    #[test]
    fn p21_distinct_page_cursor_binding_expiry_and_fifo_are_enforced() {
        let (_directory, service) =
            ready_read_fixture_csv(false, "value\nalpha\nbeta\ngamma\ndelta\n");
        let mut request = read_request();
        request.limit = 1;
        let first = service.read_column_values_page(request.clone()).unwrap();
        assert!(first.previous_cursor.is_none());
        let token = first.next_cursor.unwrap();
        request.offset = 1;
        request.cursor = Some(token.clone());
        let second = service.read_column_values_page(request.clone()).unwrap();
        assert_eq!(second.values[0].value.as_deref(), Some("beta"));
        let mut previous = request.clone();
        previous.offset = 0;
        previous.cursor = second.previous_cursor;
        assert_eq!(
            service.read_column_values_page(previous).unwrap().values,
            first.values
        );
        for mismatch in 0..4 {
            let mut changed = request.clone();
            match mismatch {
                0 => changed.search = Some("a".to_owned()),
                1 => changed.order = ColumnValuesOrder::ValueDescending,
                2 => changed.offset = 2,
                _ => changed.limit = 2,
            }
            assert!(service.read_column_values_page(changed).is_err());
        }
        // None and empty search are the same query; token replay is deterministic.
        request.search = Some(String::new());
        assert_eq!(
            service
                .read_column_values_page(request.clone())
                .unwrap()
                .values,
            second.values
        );
        let task = service
            .column_values_task("document", "session", "read-values")
            .unwrap();
        let snapshot = ready_snapshot(&task).unwrap();
        {
            let mut registry = snapshot.cursors.lock().unwrap();
            registry
                .entries
                .iter_mut()
                .find(|(entry, _)| entry == &token)
                .unwrap()
                .1
                .created = std::time::Instant::now() - CURSOR_TTL;
        }
        assert!(service.read_column_values_page(request.clone()).is_err());
        request.cursor = None;
        request.offset = 0;
        let old = service
            .read_column_values_page(request.clone())
            .unwrap()
            .next_cursor
            .unwrap();
        let binding = snapshot
            .cursors
            .lock()
            .unwrap()
            .entries
            .back()
            .unwrap()
            .1
            .clone();
        for _ in 0..MAX_PAGE_CURSORS {
            snapshot.register_cursor(binding.clone()).unwrap();
        }
        assert!(snapshot.cursors.lock().unwrap().entries.len() <= MAX_PAGE_CURSORS);
        request.offset = 1;
        request.cursor = Some(old);
        assert!(service.read_column_values_page(request).is_err());
        service
            .release_column_values("document", "session", "read-values")
            .unwrap();
        service.shutdown();
    }

    #[test]
    fn p21_distinct_typed_category_cursor_pages_round_trip_filtered_and_source() {
        use crate::domain::CsvTargetType;
        for filtered in [false, true] {
            for (target, valid) in [
                (CsvTargetType::Decimal, "-10\n-1.21\n-1.2\n1.20\n1.2\n2.0\n10.00\n"),
                (CsvTargetType::Timestamp, "2026-01-01T01:00:00.123456789+01:00\n2026-01-01T00:00:00.123456789Z\n2026-01-01T00:00:00.123456788Z\n2025-12-31T20:00:00-05:00\n"),
                (CsvTargetType::UInt64, "2\n10\n9007199254740992\n9007199254740993\n18446744073709551614\n18446744073709551615\n"),
            ] {
                let csv = format!("value\n{valid}NULL\n\"\"\nbad\nbad\nworse\n");
                let (_directory, service) = ready_read_fixture_profile(filtered, &csv, Some(target));
                for order in [ColumnValuesOrder::ValueAscending, ColumnValuesOrder::ValueDescending, ColumnValuesOrder::CountAscending, ColumnValuesOrder::CountDescending] {
                    let mut request = read_request(); request.limit = 200; request.order = order;
                    let oracle = service.read_column_values_page(request.clone()).unwrap().values;
                    request.limit = 2;
                    let mut pages = Vec::new();
                    loop {
                        let page = service.read_column_values_page(request.clone()).unwrap();
                        assert_eq!(page.values, oracle[request.offset as usize..].iter().take(2).cloned().collect::<Vec<_>>(), "{target:?}/{filtered}/{order:?}");
                        let offset = request.offset;
                        request.offset += page.values.len() as u64;
                        request.cursor = page.next_cursor.clone();
                        let finished = request.cursor.is_none();
                        pages.push((offset, page));
                        assert!(pages.len() <= oracle.len());
                        if finished { break; }
                    }
                    for index in (1..pages.len()).rev() {
                        request.offset = pages[index - 1].0;
                        request.cursor = pages[index].1.previous_cursor.clone();
                        assert!(request.cursor.is_some());
                        assert_eq!(service.read_column_values_page(request.clone()).unwrap().values, pages[index - 1].1.values);
                    }
                }
                service.shutdown();
            }
        }
    }

    #[test]
    fn p21_distinct_unicode_search_and_truncated_preview_seek_use_full_keys() {
        let prefix = "한".repeat(PREVIEW_CHARACTERS + 10);
        let csv = format!("value\n{prefix}a\n{prefix}b\n{prefix}b\n");
        let (_directory, service) =
            ready_read_fixture_profile(false, &csv, Some(crate::domain::CsvTargetType::Text));
        let mut request = read_request();
        request.limit = 1;
        request.search = Some("한".to_owned());
        let first = service.read_column_values_page(request.clone()).unwrap();
        assert!(first.values[0].truncated);
        assert_eq!(first.values[0].count, 1);
        request.offset = 1;
        request.cursor = first.next_cursor;
        let second = service.read_column_values_page(request.clone()).unwrap();
        assert_eq!(first.values[0].value, second.values[0].value);
        assert_eq!(second.values[0].count, 2);
        assert!(second.next_cursor.is_none());
        request.offset = 0;
        request.cursor = second.previous_cursor;
        assert_eq!(
            service.read_column_values_page(request).unwrap().values,
            first.values
        );
        service.shutdown();
    }

    fn read_copy_request() -> ColumnValuesCopyRequest {
        ColumnValuesCopyRequest {
            operation_id: "read-values".to_owned(),
            document_id: "document".to_owned(),
            session_id: "session".to_owned(),
            search: None,
            order: ColumnValuesOrder::ValueAscending,
            include_counts: true,
        }
    }

    #[test]
    fn p21_distinct_real_csv_profiles_sort_and_group_exact_logical_values() {
        use crate::domain::CsvTargetType;
        let cases = vec![
            (CsvTargetType::Int64,
                "01\n1\n01\n1\n10\n2\n9007199254740993\n9007199254740992\n9223372036854775807\n",
                vec![("1", 4), ("2", 1), ("10", 1), ("9007199254740992", 1), ("9007199254740993", 1), ("9223372036854775807", 1)]),
            (CsvTargetType::UInt64, "10\n2\n18446744073709551615\n9007199254740993\n",
                vec![("2", 1), ("10", 1), ("9007199254740993", 1), ("18446744073709551615", 1)]),
            (CsvTargetType::Decimal,
                "10.0\n2.0\n1.2\n1.20\n-1.2\n-1.21\n-10\n-2\n0\n0.00000000000000000000000000000000000001\n0.00000000000000000000000000000000000002\n",
                vec![("-10", 1), ("-2", 1), ("-1.21", 1), ("-1.2", 1), ("0", 1), ("0.00000000000000000000000000000000000001", 1), ("0.00000000000000000000000000000000000002", 1), ("1.2", 2), ("2.0", 1), ("10.0", 1)]),
            (CsvTargetType::Date, "2026-10-01\n2026-02-01\n2026-01-01\n",
                vec![("2026-01-01", 1), ("2026-02-01", 1), ("2026-10-01", 1)]),
            (CsvTargetType::Boolean, "true\nfalse\ntrue\n",
                vec![("false", 1), ("true", 2)]),
            (CsvTargetType::Duration, "10\n2\n-2\n-10\n9007199254740993\n",
                vec![("-10", 1), ("-2", 1), ("2", 1), ("10", 1), ("9007199254740993", 1)]),
            (CsvTargetType::Timestamp,
                "2026-01-01T01:00:00.123456789+01:00\n2026-01-01T00:00:00.123456789Z\n2026-01-01T00:00:00.123456788Z\n2025-12-31T20:00:00-05:00\n",
                vec![("2026-01-01T00:00:00.123456788Z", 1), ("2026-01-01T00:00:00.123456789Z", 2), ("2025-12-31T20:00:00-05:00", 1)]),
        ];
        for filtered in [false, true] {
            for (target, rows, expected) in &cases {
                let csv = format!("value\n{rows}");
                let (_directory, service) =
                    ready_read_fixture_profile(filtered, &csv, Some(*target));
                for order in [
                    ColumnValuesOrder::ValueAscending,
                    ColumnValuesOrder::ValueDescending,
                ] {
                    let mut request = read_request();
                    request.limit = 200;
                    request.order = order;
                    let page = service.read_column_values_page(request).unwrap();
                    let actual = page
                        .values
                        .iter()
                        .map(|value| (value.value.as_deref().unwrap(), value.count))
                        .collect::<Vec<_>>();
                    let mut expected = expected.clone();
                    if order == ColumnValuesOrder::ValueDescending {
                        expected.reverse();
                    }
                    assert_eq!(
                        actual, expected,
                        "target={target:?}, filtered={filtered}, order={order:?}"
                    );
                    assert_eq!(page.total_count, expected.len() as u64);
                }
                service.shutdown();
            }
            let (_directory, service) = ready_read_fixture_profile(
                filtered,
                "value\n10.0\n2.5\n-10.0\n-2.5\n",
                Some(CsvTargetType::Float64),
            );
            let page = service.read_column_values_page(read_request()).unwrap();
            assert_eq!(
                page.values
                    .iter()
                    .map(|value| value.value.as_ref().unwrap().parse::<f64>().unwrap())
                    .collect::<Vec<_>>(),
                [-10.0, -2.5, 2.5, 10.0]
            );
            service.shutdown();
        }
    }

    #[test]
    fn p21_distinct_real_struct_key_profiles_keep_null_empty_invalid_last() {
        use crate::domain::CsvTargetType;
        let cases = [
            (
                CsvTargetType::Decimal,
                "1.20\n1.2\n10.00\n",
                [("1.2", 2), ("10.00", 1)],
            ),
            (
                CsvTargetType::Timestamp,
                "2026-01-01T01:00:00.123456789+01:00\n2026-01-01T00:00:00.123456789Z\n2026-01-01T00:00:00.123456788Z\n",
                [
                    ("2026-01-01T00:00:00.123456788Z", 1),
                    ("2026-01-01T00:00:00.123456789Z", 2),
                ],
            ),
        ];
        for filtered in [false, true] {
            for (target, valid_rows, expected_valid) in cases {
                // Quoted empty records survive CSV's blank-line skipping.
                let csv = format!("value\n{valid_rows}NULL\nNULL\n\"\"\n\"\"\nbad\nbad\nworse\n");
                let (_directory, service) =
                    ready_read_fixture_profile(filtered, &csv, Some(target));
                for order in [
                    ColumnValuesOrder::ValueAscending,
                    ColumnValuesOrder::ValueDescending,
                ] {
                    let mut request = read_request();
                    request.order = order;
                    let page = service.read_column_values_page(request).unwrap();
                    assert_eq!(
                        page.total_count, 6,
                        "target={target:?}, filtered={filtered}, order={order:?}"
                    );
                    assert_eq!(page.values.len(), 6);
                    let mut expected = expected_valid.to_vec();
                    if order == ColumnValuesOrder::ValueDescending {
                        expected.reverse();
                    }
                    let actual = page.values[..2]
                        .iter()
                        .map(|value| {
                            assert!(!value.is_null && !value.is_empty && !value.is_invalid);
                            (value.value.as_deref().unwrap(), value.count)
                        })
                        .collect::<Vec<_>>();
                    // Decimal scale and canonical timestamp offset/nanoseconds survive
                    // representative selection while equivalent values group once.
                    assert_eq!(
                        actual, expected,
                        "target={target:?}, filtered={filtered}, order={order:?}"
                    );
                    let invalid = &page.values[2..4];
                    assert!(invalid
                        .iter()
                        .all(|value| value.is_invalid && !value.is_empty && !value.is_null));
                    let actual_invalid = invalid
                        .iter()
                        .map(|value| (value.value.as_deref().unwrap(), value.count))
                        .collect::<Vec<_>>();
                    let expected_invalid = if order == ColumnValuesOrder::ValueAscending {
                        vec![("bad", 2), ("worse", 1)]
                    } else {
                        vec![("worse", 1), ("bad", 2)]
                    };
                    assert_eq!(actual_invalid, expected_invalid);
                    let empty = &page.values[4];
                    assert!(empty.is_empty && !empty.is_null && !empty.is_invalid);
                    assert_eq!(empty.value.as_deref(), Some(""));
                    assert_eq!(empty.count, 2);
                    let null = &page.values[5];
                    assert!(null.is_null && !null.is_empty && !null.is_invalid);
                    assert_eq!(null.value, None);
                    assert_eq!(null.count, 2);
                }
                service.shutdown();
            }
        }
    }

    fn run_real_copy(
        service: &Arc<QueryService>,
        copy: ColumnValuesCopySource,
        selected_rows: u64,
        max_bytes: u64,
    ) -> (crate::domain::CopyOperationStatus, Arc<Clipboard>) {
        use crate::domain::{
            BooleanRepresentation, CopyEscapeMode, CopyLineEnding, CopyOperationIdentity,
            CopyOptionsSnapshot, CopyQuoteMode, CopyRepresentation, CopySelectionSnapshot,
            DateTimeRepresentation, EmptyStringRepresentation, StartCopyRequest,
        };
        let manager = crate::copy::CopyManager::default();
        let memory = Arc::new(Clipboard::default());
        let clipboard =
            copy.wrap_clipboard(Arc::clone(&memory) as Arc<dyn crate::copy::ClipboardWriter>);
        manager
            .start(
                StartCopyRequest {
                    operation_id: "real-copy".to_owned(),
                    document_id: "document".to_owned(),
                    session_id: "session".to_owned(),
                    query_id: None,
                    selection: CopySelectionSnapshot {
                        row_start: 0,
                        row_end_exclusive: selected_rows,
                        column_ids: copy.column_ids,
                    },
                    options: CopyOptionsSnapshot {
                        delimiter: "\t".to_owned(),
                        include_headers: true,
                        quote_mode: CopyQuoteMode::Minimal,
                        quote_character: "\"".to_owned(),
                        escape_mode: CopyEscapeMode::Double,
                        line_ending: CopyLineEnding::Lf,
                        null_representation: "NULL".to_owned(),
                        empty_string_representation: EmptyStringRepresentation::Empty,
                        boolean_representation: BooleanRepresentation::Lowercase,
                        date_time_representation: DateTimeRepresentation::Display,
                        representation: CopyRepresentation::RawCanonical,
                    },
                    max_cells: 100_000,
                    max_bytes,
                },
                copy.reader,
                clipboard,
                service.copy_staging_directory(),
            )
            .unwrap();
        let identity = CopyOperationIdentity {
            operation_id: "real-copy".to_owned(),
            document_id: "document".to_owned(),
            session_id: "session".to_owned(),
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let status = manager.status(&identity).unwrap();
            if status.state.is_terminal() {
                return (status, memory);
            }
            assert!(std::time::Instant::now() < deadline, "{status:?}");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn p21_distinct_real_copy_manager_copies_237_512_and_4301_values_atomically() {
        use crate::domain::{CopyFailureReason, CopyOperationState};
        let csv = format!(
            "value\n{}",
            (0..4301)
                .map(|index| format!("value-{index:04}\n"))
                .collect::<String>()
        );
        let (_directory, service) = ready_read_fixture_csv(false, &csv);
        let batches = service
            .column_values_copy_reader(read_copy_request())
            .unwrap();
        let first = batches
            .reader
            .read_rows(0, COPY_BATCH_ROWS + 100, &batches.column_ids)
            .unwrap();
        assert_eq!(first.rows.len(), COPY_BATCH_ROWS);
        assert!(first.has_more);
        assert_eq!(
            batches
                .reader
                .read_rows(0, COPY_BATCH_ROWS + 100, &batches.column_ids)
                .unwrap()
                .rows,
            first.rows
        );
        let second = batches
            .reader
            .read_rows(COPY_BATCH_ROWS as u64, 1000, &batches.column_ids)
            .unwrap();
        assert_eq!(second.rows.len(), 4301 - COPY_BATCH_ROWS);
        assert!(!second.has_more);
        for offset in 0..8 {
            batches
                .reader
                .read_rows(offset, 1, &batches.column_ids)
                .unwrap();
        }
        assert_eq!(batches.validator.anchors.lock().unwrap().len(), 4);
        // An evicted internal anchor still supports an explicit legacy request.
        assert_eq!(
            batches
                .reader
                .read_rows(1, 1, &batches.column_ids)
                .unwrap()
                .rows[0][0]
                .display
                .as_deref(),
            Some("value-0001")
        );
        drop(batches);
        for include_counts in [false, true] {
            for selected_rows in [237, 512, 4301] {
                let mut request = read_copy_request();
                request.include_counts = include_counts;
                let copy = service.column_values_copy_reader(request).unwrap();
                assert_eq!(copy.row_count, 4301);
                let (status, memory) = run_real_copy(&service, copy, selected_rows, 1024 * 1024);
                assert_eq!(status.state, CopyOperationState::Complete, "{status:?}");
                let mut expected = if include_counts {
                    "Value\tCount"
                } else {
                    "Value"
                }
                .to_owned();
                for index in 0..selected_rows {
                    expected.push_str(&format!("\nvalue-{index:04}"));
                    if include_counts {
                        expected.push_str("\t1");
                    }
                }
                assert_eq!(*memory.0.lock().unwrap(), vec![expected]);
                assert_eq!(status.progress.rows_processed, selected_rows);
            }
        }
        let copy = service
            .column_values_copy_reader(read_copy_request())
            .unwrap();
        let (status, memory) = run_real_copy(&service, copy, 4301, 32);
        assert_eq!(status.state, CopyOperationState::Failed);
        assert_eq!(status.failure.unwrap().reason, CopyFailureReason::ByteLimit);
        assert!(memory.0.lock().unwrap().is_empty());
        service.shutdown();
    }

    #[test]
    fn p21_distinct_long_values_use_byte_bounded_partial_pages_and_real_copy() {
        use crate::domain::CopyOperationState;
        let (_directory, service) = ready_read_fixture(false);
        let task = service
            .column_values_task("document", "session", "read-values")
            .unwrap();
        let snapshot = ready_snapshot(&task).unwrap();
        let value_bytes = COPY_MAX_BATCH_ESTIMATED_BYTES / 2;
        service
            .with_column_values_connection(&task, &snapshot, |connection, _| {
                connection
                    .execute_batch(&format!(
                        "UPDATE {} SET value = substring(value, 1, 1) || repeat('x', {})",
                        snapshot.table,
                        value_bytes - 1
                    ))
                    .map_err(duckdb_error)
            })
            .unwrap();
        let copy = service
            .column_values_copy_reader(read_copy_request())
            .unwrap();
        // Two value strings alone fill 8MiB; frequencies put the batch over its cap.
        let first = copy.reader.read_rows(0, 512, &copy.column_ids).unwrap();
        assert_eq!(first.rows.len(), 1);
        assert!(first.has_more);
        assert_eq!(
            first.rows[0][0].display.as_ref().unwrap().len(),
            value_bytes
        );
        let second = copy.reader.read_rows(1, 512, &copy.column_ids).unwrap();
        assert_eq!(second.rows.len(), 1);
        assert!(!second.has_more);
        let (status, memory) = run_real_copy(&service, copy, 2, 32 * 1024 * 1024);
        assert_eq!(status.state, CopyOperationState::Complete, "{status:?}");
        let writes = memory.0.lock().unwrap();
        assert_eq!(writes.len(), 1);
        let lines = writes[0].split('\n').collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "Value\tCount");
        assert_eq!(lines[1].len(), value_bytes + 2);
        assert_eq!(lines[2].len(), value_bytes + 2);
        drop(writes);
        let retry = service
            .column_values_copy_reader(read_copy_request())
            .unwrap();
        assert_eq!(
            retry
                .reader
                .read_rows(0, 1, &retry.column_ids)
                .unwrap()
                .rows
                .len(),
            1
        );
        let before = retry.validator.anchors.lock().unwrap().clone();
        service
            .with_column_values_connection(&task, &snapshot, |connection, _| {
                connection
                    .execute_batch(&format!(
                        "UPDATE {} SET value = 'p' || repeat('x', {}) WHERE sort_value = 'pear'",
                        snapshot.table,
                        COPY_MAX_BATCH_ESTIMATED_BYTES + 1
                    ))
                    .map_err(duckdb_error)
            })
            .unwrap();
        assert!(retry.reader.read_rows(1, 1, &retry.column_ids).is_err());
        assert_eq!(*retry.validator.anchors.lock().unwrap(), before);
        service
            .with_column_values_connection(&task, &snapshot, |connection, _| {
                connection
                    .execute_batch(&format!(
                        "UPDATE {} SET value = 'p' || repeat('x', {}) WHERE sort_value = 'pear'",
                        snapshot.table,
                        value_bytes - 1
                    ))
                    .map_err(duckdb_error)
            })
            .unwrap();
        assert_eq!(
            retry
                .reader
                .read_rows(1, 1, &retry.column_ids)
                .unwrap()
                .rows
                .len(),
            1
        );
        drop(retry);
        drop(snapshot);
        service.shutdown();
    }

    #[test]
    fn p21_distinct_page_and_copy_enforce_budget_after_snapshot_build() {
        for filtered in [false, true] {
            let (_directory, service) = ready_read_fixture(filtered);
            // Create the copy reader while affordable, then exhaust storage before its first batch.
            let copy = service
                .column_values_copy_reader(read_copy_request())
                .unwrap();
            let lease = service
                .temp
                .allocate("document", "budget-pressure")
                .unwrap();
            std::fs::write(lease.path().join("pressure.bin"), [0_u8; 4096]).unwrap();
            service.set_temp_limit(1);
            assert!(service.temp.budget_violation().unwrap().is_some());
            assert_eq!(
                service
                    .read_column_values_page(read_request())
                    .unwrap_err()
                    .code,
                DataErrorCode::QueryTempLimitExceeded
            );
            assert_eq!(
                copy.reader
                    .read_rows(0, 10, &copy.column_ids)
                    .unwrap_err()
                    .code,
                DataErrorCode::QueryTempLimitExceeded
            );
            assert!(
                matches!(service.column_values_copy_reader(read_copy_request()),
                Err(error) if error.code == DataErrorCode::QueryTempLimitExceeded)
            );
            // The checks must release their permit and connection on the failure path.
            service.set_temp_limit(64 * 1024 * 1024);
            assert_eq!(
                service
                    .read_column_values_page(read_request())
                    .unwrap()
                    .values
                    .len(),
                2
            );
            assert_eq!(
                copy.reader
                    .read_rows(0, 10, &copy.column_ids)
                    .unwrap()
                    .rows
                    .len(),
                2
            );
            drop(copy);
            drop(lease);
            service.shutdown();
        }
    }

    static LONG_SQL_ENTERED: AtomicBool = AtomicBool::new(false);

    struct SignalLongSql;
    impl VScalar for SignalLongSql {
        type State = ();
        fn invoke(
            state: &Self::State,
            input: &mut DataChunkHandle,
            output: &mut dyn WritableVector,
        ) -> Result<(), Box<dyn std::error::Error>> {
            // Signal from DuckDB's actual execution, rather than guessing with a sleep.
            LONG_SQL_ENTERED.store(true, Ordering::Release);
            ScalarLower::invoke(state, input, output)
        }
        fn signatures() -> Vec<ScalarFunctionSignature> {
            ScalarLower::signatures()
        }
    }

    #[test]
    fn p21_distinct_active_filtered_sql_is_interrupted_by_cancel() {
        let (_directory, service) = ready_read_fixture(true);
        let task = service
            .column_values_task("document", "session", "read-values")
            .unwrap();
        let snapshot = ready_snapshot(&task).unwrap();
        assert!(matches!(
            &snapshot.database,
            SnapshotConnection::Filtered(_)
        ));
        LONG_SQL_ENTERED.store(false, Ordering::Release);
        let worker_service = Arc::clone(&service);
        let worker_task = Arc::clone(&task);
        let worker_snapshot = Arc::clone(&snapshot);
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = worker_service.with_column_values_connection(&worker_task, &worker_snapshot, |connection, _| {
                connection.register_scalar_function::<SignalLongSql>("p21_signal_long_sql").map_err(duckdb_error)?;
                let _: i64 = connection.query_row(
                    "SELECT CAST(sum(length(p21_signal_long_sql(i::VARCHAR))) AS BIGINT) FROM range(1000000000000) AS r(i)",
                    [], |row| row.get(0)).map_err(duckdb_error)?;
                Ok(())
            });
            send.send(result).unwrap();
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !LONG_SQL_ENTERED.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "SQL never entered its execution phase"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        service
            .cancel_column_values("document", "session", "read-values")
            .unwrap();
        let error = receive
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("active filtered SQL did not respond to cancellation")
            .unwrap_err();
        assert_eq!(error.code, DataError::task_cancelled().code);
        worker.join().unwrap();
        assert!(task.token.interrupt.lock().unwrap().is_none());
        // Proves interruption released the shared filtered-query connection.
        snapshot
            .with_cancellable_connection(&task, |_| Ok(()))
            .unwrap_err();
        if let SnapshotConnection::Filtered(result) = &snapshot.database {
            assert!(result.connection.try_lock().is_ok());
        }
        drop(snapshot);
        service.shutdown();
    }
}
