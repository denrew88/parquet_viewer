//! Independent, bounded, read-only SQL snapshots. User SQL only reaches the worker.
use super::*;
use crate::{copy::CopyRowReader, data::SqlInputColumn, domain::*};
use arrow_array::RecordBatch;
use parquet::{
    arrow::{arrow_reader::ParquetRecordBatchReaderBuilder, ArrowWriter},
    basic::Compression,
    file::properties::WriterProperties,
};
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use std::process::{Child, Command, Stdio};
use std::{
    collections::VecDeque,
    fs::{self, File},
    path::PathBuf,
    time::{Duration, Instant},
};

mod export;
mod result_view;
pub(super) use result_view::{sql_view_temp_cap, VIEW_DOCUMENT};
mod security;
mod worker;
pub use worker::try_run_sql_worker_from_args;

const MAX_STATUSES: usize = 16;
const MAX_RESULTS: usize = 2;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_JOB_TIME: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(crate) struct SqlRegistry {
    tasks: Mutex<HashMap<String, Arc<SqlTask>>>,
    order: Mutex<VecDeque<String>>,
    results: Mutex<HashMap<String, Arc<SqlResult>>>,
}
struct SqlTask {
    request: StartSqlRequest,
    sql_temp_limit_bytes: u64,
    status: Mutex<SqlStatus>,
    cancel: AtomicBool,
    source_cancel_reason: Mutex<Option<String>>,
    started: Instant,
}
struct SqlResult {
    run_id: String,
    source_fingerprints: Vec<SourceFingerprint>,
    columns: Vec<SqlResultColumn>,
    chunks: Vec<ResultChunk>,
    rows: u64,
    alive: AtomicBool,
    views: Mutex<HashMap<String, Arc<result_view::SqlResultView>>>,
    _lease: Arc<QueryTempLease>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResultChunk {
    file: String,
    offset: u64,
    rows: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkerTable {
    alias: String,
    mode: SqlColumnMode,
    path: PathBuf,
    columns: Vec<SqlInputColumn>,
    csv: bool,
    physical_columns: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkerJob {
    sql: String,
    action: SqlAction,
    tables: Vec<WorkerTable>,
    directory: PathBuf,
    allowance: u64,
    parent_pid: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkerOutput {
    columns: Vec<SqlResultColumn>,
    chunks: Vec<ResultChunk>,
    rows: u64,
    plan_text: Option<String>,
    plan_json: Option<serde_json::Value>,
    warnings: Vec<String>,
    error: Option<DataError>,
}

fn error(message: impl Into<String>) -> DataError {
    DataError::query_failed(message)
}
fn invalid(message: impl Into<String>) -> DataError {
    DataError::invalid_request(message)
}
fn validate_sql_temp_limit(bytes: u64) -> Result<(), DataError> {
    if !(MIN_SQL_TEMP_LIMIT_BYTES..=MAX_SQL_TEMP_LIMIT_BYTES).contains(&bytes) {
        return Err(invalid("SQL working storage must be within 64MiB..10GiB."));
    }
    Ok(())
}
fn io(path: &Path, e: impl std::fmt::Display) -> DataError {
    DataError::io(path, e)
}
fn terminal(state: SqlState) -> bool {
    matches!(
        state,
        SqlState::Complete | SqlState::Failed | SqlState::Cancelled
    )
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DataError> {
    let bytes = serde_json::to_vec(value).map_err(|e| error(e.to_string()))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(invalid(
            "SQL metadata exceeds its bounded manifest allowance.",
        ));
    }
    let partial = path.with_extension("partial");
    fs::write(&partial, bytes).map_err(|e| io(&partial, e))?;
    fs::rename(&partial, path).map_err(|e| io(path, e))
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, DataError> {
    if fs::metadata(path).map_err(|e| io(path, e))?.len() > MAX_MANIFEST_BYTES {
        return Err(invalid("SQL worker metadata exceeds its bound."));
    }
    serde_json::from_reader(File::open(path).map_err(|e| io(path, e))?)
        .map_err(|e| error(format!("SQL worker metadata is invalid: {e}")))
}
fn directory_bytes(path: &Path) -> Result<u64, DataError> {
    let mut total = 0u64;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(io(path, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io(path, e))?;
        let ty = match entry.file_type() {
            Ok(ty) => ty,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io(&entry.path(), e)),
        };
        if ty.is_symlink() {
            return Err(invalid("SQL workspace cannot contain symlinks."));
        }
        total = total.saturating_add(if ty.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            // An open Windows spill writer need not update directory-entry
            // lengths yet. Read current length through a fresh shared handle.
            match crate::storage::open_temp_accounting_file(&entry.path())
                .and_then(|file| file.metadata())
            {
                Ok(metadata) => metadata.len(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                Err(e) => return Err(io(&entry.path(), e)),
            }
        });
    }
    Ok(total)
}
fn sql_type_label(value: &str) -> String {
    match value {
        "Int64" => "BIGINT",
        "UInt64" => "UBIGINT",
        "Int32" => "INTEGER",
        "UInt32" => "UINTEGER",
        "Float64" => "DOUBLE",
        "Float32" => "FLOAT",
        "Boolean" => "BOOLEAN",
        "Utf8" | "LargeUtf8" | "Utf8View" | "String" => "VARCHAR",
        other => other,
    }
    .to_owned()
}

fn validate_input_columns(columns: &[SqlInputColumn]) -> Result<(), DataError> {
    if columns.is_empty() || columns.len() > SQL_MAX_COLUMNS {
        return Err(invalid("SQL supports 1..4096 exposed source columns."));
    }
    if columns.iter().any(|c| {
        c.original_name.chars().count() > 4096
            || c.original_name.len() > 16384
            || c.original_name.contains('\0')
    }) {
        return Err(invalid("A SQL source column name exceeds 4096 characters/16384 UTF-8 bytes or contains NUL. Ordinary file viewing remains available."));
    }
    if columns
        .iter()
        .map(|c| c.original_name.len() + c.sql_type.len() + 128)
        .sum::<usize>()
        > 2 * 1024 * 1024
    {
        return Err(invalid(
            "SQL source schema exceeds its 2MiB metadata allowance; expose fewer columns.",
        ));
    }
    Ok(())
}
fn validate_source_format(source: &QuerySourceSpec) -> Result<(), DataError> {
    if !source
        .path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("csv") || e.eq_ignore_ascii_case("parquet"))
    {
        return Err(invalid(
            "The SQL workspace supports registered CSV and Parquet inputs only.",
        ));
    }
    Ok(())
}

impl QueryService {
    /// Discover syntactic base-table dependencies without touching source files
    /// or preparing/executing the user's statement in the parent process.
    pub fn referenced_sql_sources(
        request: &StartSqlRequest,
    ) -> Result<Vec<SqlSourceIdentity>, DataError> {
        request.validate()?;
        let db = security::Database::open()?;
        db.conn()?
            .execute_batch("SET enable_external_access=false; SET lock_configuration=true;")
            .map_err(duckdb_error)?;
        let aliases = request
            .tables
            .iter()
            .map(|table| table.alias.clone())
            .collect::<Vec<_>>();
        let names = db.referenced_tables(&request.sql, &aliases)?;
        Ok(request
            .tables
            .iter()
            .filter(|table| {
                names
                    .iter()
                    .any(|name| table.alias.eq_ignore_ascii_case(name))
            })
            .map(|table| SqlSourceIdentity {
                document_id: table.document_id.clone(),
                session_id: table.session_id.clone(),
            })
            .collect())
    }
    pub fn has_live_sql_state(&self) -> bool {
        self.sql_workspace
            .results
            .lock()
            .map(|results| !results.is_empty())
            .unwrap_or(true)
            || self
                .sql_workspace
                .tasks
                .lock()
                .map(|tasks| {
                    tasks
                        .values()
                        .any(|t| t.status.lock().map(|s| !terminal(s.state)).unwrap_or(true))
                })
                .unwrap_or(true)
    }
    pub fn describe_sql_tables(
        &self,
        sources: Vec<(SqlSourceIdentity, QuerySourceSpec)>,
    ) -> Result<Vec<SqlTableDescriptor>, DataError> {
        if sources.len() > SQL_MAX_SOURCES {
            return Err(invalid("SQL supports at most 32 input tables."));
        }
        let descriptors = sources
            .into_iter()
            .map(|(identity, source)| {
                validate_source_format(&source)?;
                validate_sql_identity(&identity.document_id)?;
                validate_sql_identity(&identity.session_id)?;
                let columns = source.provider.sql_input_columns(&source)?;
                validate_input_columns(&columns)?;
                let reason = source.provider.sql_name_mode_issue(&source);
                Ok(SqlTableDescriptor {
                    document_id: identity.document_id,
                    session_id: identity.session_id,
                    file_name: source
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    path: source.path.to_string_lossy().into_owned(),
                    default_column_mode: if reason.is_none() {
                        SqlColumnMode::Name
                    } else {
                        SqlColumnMode::Ordinal
                    },
                    name_mode_allowed: reason.is_none(),
                    name_mode_reason: reason,
                    columns: columns
                        .into_iter()
                        .map(|c| SqlSourceColumn {
                            id: format!("s{}", c.source_index),
                            source_index: c.source_index,
                            original_name: c.original_name,
                            sql_type: sql_type_label(&c.sql_type),
                            nullable: c.nullable,
                        })
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, DataError>>()?;
        if serde_json::to_vec(&descriptors)
            .map_err(|e| error(e.to_string()))?
            .len()
            > 2 * 1024 * 1024
        {
            return Err(invalid(
                "Registered SQL schemas exceed the 2MiB response allowance; register fewer inputs.",
            ));
        }
        Ok(descriptors)
    }
    pub fn start_sql(
        self: &Arc<Self>,
        mut request: StartSqlRequest,
        sources: Vec<QuerySourceSpec>,
        sql_temp_limit_bytes: u64,
    ) -> Result<SqlStatus, DataError> {
        request.validate()?;
        validate_sql_temp_limit(sql_temp_limit_bytes)?;
        let references = Self::referenced_sql_sources(&request)?;
        request.tables.retain(|table| {
            references.iter().any(|source| {
                source.document_id == table.document_id && source.session_id == table.session_id
            })
        });
        if sources.len() != request.tables.len() {
            return Err(invalid("SQL bindings do not match the registered sources."));
        }
        let schema_bytes = sources
            .iter()
            .map(|source| {
                source.provider.sql_input_columns(source).map(|columns| {
                    columns
                        .iter()
                        .map(|c| c.original_name.len() + c.sql_type.len() + 128)
                        .sum::<usize>()
                })
            })
            .collect::<Result<Vec<_>, DataError>>()?
            .into_iter()
            .sum::<usize>();
        if schema_bytes > 2 * 1024 * 1024 {
            return Err(invalid(
                "Registered SQL schemas exceed the 2MiB metadata allowance.",
            ));
        }
        let mut tasks = self
            .sql_workspace
            .tasks
            .lock()
            .map_err(|_| registry_error())?;
        if tasks
            .values()
            .any(|t| t.status.lock().map(|s| !terminal(s.state)).unwrap_or(true))
        {
            return Err(invalid(
                "A SQL query is already running. Cancel it before starting another.",
            ));
        }
        if tasks.contains_key(&request.run_id) {
            return Err(invalid("SQL run IDs cannot be reused."));
        }
        if self
            .sql_workspace
            .results
            .lock()
            .map_err(|_| registry_error())?
            .len()
            >= MAX_RESULTS
        {
            return Err(invalid(
                "Release an older SQL result before starting another result.",
            ));
        }
        for (binding, source) in request.tables.iter().zip(&sources) {
            validate_source_format(source)?;
            if binding.column_mode == SqlColumnMode::Name {
                if let Some(reason) = source.provider.sql_name_mode_issue(source) {
                    return Err(invalid(reason));
                }
            }
            validate_input_columns(&source.provider.sql_input_columns(source)?)?;
        }
        let status = SqlStatus {
            run_id: request.run_id.clone(),
            state: SqlState::Queued,
            phase: "preparingInputs".to_owned(),
            elapsed_ms: 0,
            rows_produced: 0,
            result_id: None,
            columns: vec![],
            row_count: None,
            plan_text: None,
            plan_json: None,
            warnings: vec![],
            error: None,
        };
        let task = Arc::new(SqlTask {
            request: request.clone(),
            sql_temp_limit_bytes,
            status: Mutex::new(status.clone()),
            cancel: AtomicBool::new(false),
            source_cancel_reason: Mutex::new(None),
            started: Instant::now(),
        });
        tasks.insert(request.run_id.clone(), Arc::clone(&task));
        drop(tasks);
        let mut order = self
            .sql_workspace
            .order
            .lock()
            .map_err(|_| registry_error())?;
        order.push_back(request.run_id.clone());
        while order.len() > MAX_STATUSES {
            if let Some(old) = order.pop_front() {
                self.sql_workspace
                    .tasks
                    .lock()
                    .map_err(|_| registry_error())?
                    .remove(&old);
            }
        }
        drop(order);
        let service = Arc::clone(self);
        std::thread::spawn(move || {
            let result = service.run_sql_task(&task, sources);
            if let Err(e) = result {
                if let Ok(mut s) = task.status.lock() {
                    s.state = if task.cancel.load(Ordering::Acquire)
                        || e.code == DataErrorCode::TaskCancelled
                    {
                        SqlState::Cancelled
                    } else {
                        SqlState::Failed
                    };
                    s.phase = if s.state == SqlState::Cancelled {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .to_owned();
                    s.error = Some(
                        match task
                            .source_cancel_reason
                            .lock()
                            .ok()
                            .and_then(|reason| reason.clone())
                        {
                            Some(reason) => DataError {
                                code: DataErrorCode::TaskCancelled,
                                message: reason,
                            },
                            None => e,
                        },
                    );
                    s.elapsed_ms = elapsed_ms(task.started);
                }
            }
        });
        Ok(status)
    }
    fn run_sql_task(
        self: &Arc<Self>,
        task: &Arc<SqlTask>,
        sources: Vec<QuerySourceSpec>,
    ) -> Result<(), DataError> {
        let _permit = loop {
            if task.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            if let Some(p) = acquire_sql_permit(&self.query_limiter) {
                break p;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut tables = Vec::new();
        let mut guards = Vec::new();
        let mut fingerprints = Vec::new();
        for (binding, source) in task.request.tables.iter().zip(sources) {
            if task.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            fingerprints.push((source.path.clone(), source_fingerprint(&source.path)?));
            let source = self.source_with_ready_csv_artifact(
                &binding.document_id,
                &binding.session_id,
                source,
            )?;
            let columns = source.provider.sql_input_columns(&source)?;
            let csv = source.provider.reusable_source_identity().is_some();
            let path = if csv {
                let preparation = self
                    .csv_preparations
                    .lock()
                    .map_err(|_| registry_error())?
                    .get(&(binding.document_id.clone(), binding.session_id.clone()))
                    .cloned()
                    .ok_or_else(|| {
                        invalid("Wait for CSV preparation to finish before executing SQL.")
                    })?;
                if preparation_status(&preparation)?.state != CsvPreparationState::Ready {
                    return Err(invalid(
                        "Wait for CSV preparation to finish before executing SQL.",
                    ));
                }
                let artifact = preparation
                    .artifact
                    .lock()
                    .map_err(|_| registry_error())?
                    .clone()
                    .ok_or_else(|| invalid("CSV preparation has no valid SQL artifact."))?;
                let path = artifact
                    ._persistent_lease
                    .as_ref()
                    .map(|l| l.path())
                    .unwrap_or_else(|| artifact._lease.path())
                    .join("prepared.parquet");
                guards.push(artifact);
                path
            } else {
                source.path.clone()
            };
            tables.push(WorkerTable {
                alias: binding.alias.clone(),
                mode: binding.column_mode,
                path,
                columns,
                csv,
                physical_columns: source.columns.len(),
            });
        }
        self.csv_cache
            .reclaim_for_query(task.sql_temp_limit_bytes.min(self.temp.configured_limit()))?;
        let lease = Arc::new(self.temp.allocate_bounded(
            "sql-workspace",
            &task.request.run_id,
            task.sql_temp_limit_bytes,
        )?);
        let dir = lease.path().to_path_buf();
        let allowance = lease.allowance_bytes().min(task.sql_temp_limit_bytes);
        let job = WorkerJob {
            sql: task.request.sql.clone(),
            action: task.request.action,
            tables,
            directory: dir.clone(),
            allowance,
            parent_pid: std::process::id(),
        };
        write_json(&dir.join("job.json"), &job)?;
        {
            let mut status = task.status.lock().map_err(|_| registry_error())?;
            status.state = SqlState::Running;
            status.phase = "executing".to_owned();
        }
        let mut process = spawn_worker(&job)?;
        let mut cancelled_at = None;
        loop {
            let cancelled = task.cancel.load(Ordering::Acquire);
            if (cancelled || task.started.elapsed() > MAX_JOB_TIME) && cancelled_at.is_none() {
                fs::write(dir.join("cancel"), []).map_err(|e| io(&dir, e))?;
                cancelled_at = Some(Instant::now());
            }
            if let Some(message) = self.temp.budget_violation()? {
                fs::write(dir.join("cancel"), []).map_err(|e| io(&dir, e))?;
                process.stop();
                return Err(DataError::query_temp_limit(message));
            }
            if directory_bytes(&dir)? > allowance {
                process.stop();
                return Err(DataError::query_temp_limit(
                    "SQL result and temporary files exceeded their shared allowance.",
                ));
            }
            if process.finished()? {
                process.validate_exit()?;
                break;
            }
            if cancelled_at.is_some_and(|t| t.elapsed() > Duration::from_secs(2)) {
                process.stop();
                return Err(if cancelled {
                    DataError::task_cancelled()
                } else {
                    error("SQL exceeded its 300 second execution deadline.")
                });
            }
            if let Ok(progress) = read_json::<u64>(&dir.join("progress.json")) {
                if let Ok(mut s) = task.status.lock() {
                    s.rows_produced = progress;
                    s.elapsed_ms = elapsed_ms(task.started);
                    s.phase = "savingResult".to_owned();
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if task.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if task.started.elapsed() > MAX_JOB_TIME {
            return Err(error("SQL exceeded its execution deadline."));
        }
        let output: WorkerOutput = read_json(&dir.join("output.json")).map_err(|cause| {
            error(format!("SQL worker exited without a readable result manifest: {}. No result was published; check available working-drive space and retry.", cause.message))
        })?;
        if let Some(e) = output.error {
            return Err(e);
        }
        for (path, before) in &fingerprints {
            if source_fingerprint(path)? != *before {
                return Err(error(
                    "A SQL source changed during execution; reopen it and retry.",
                ));
            }
        }
        let _publication = self
            .sql_workspace
            .tasks
            .lock()
            .map_err(|_| registry_error())?;
        if self.shutting_down.load(Ordering::Acquire) || task.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let result_id = if task.request.action == SqlAction::Execute {
            Some(format!(
                "sql-result-{}",
                self.next_distinct_id.fetch_add(1, Ordering::Relaxed)
            ))
        } else {
            None
        };
        if let Some(id) = &result_id {
            validate_sql_identity(id)?;
            lease.commit_usage();
            let result = Arc::new(SqlResult {
                run_id: task.request.run_id.clone(),
                source_fingerprints: fingerprints.into_iter().map(|(_, source)| source).collect(),
                columns: output.columns.clone(),
                chunks: output.chunks,
                rows: output.rows,
                alive: AtomicBool::new(true),
                views: Mutex::new(HashMap::new()),
                _lease: Arc::clone(&lease),
            });
            self.sql_workspace
                .results
                .lock()
                .map_err(|_| registry_error())?
                .insert(id.clone(), result);
        }
        let mut status = task.status.lock().map_err(|_| registry_error())?;
        status.state = SqlState::Complete;
        status.phase = "complete".to_owned();
        status.elapsed_ms = elapsed_ms(task.started);
        status.rows_produced = output.rows;
        status.row_count = if result_id.is_some() {
            Some(output.rows)
        } else {
            None
        };
        status.result_id = result_id;
        status.columns = output.columns;
        status.plan_text = output.plan_text;
        status.plan_json = output.plan_json;
        status.warnings = output.warnings;
        drop(guards);
        Ok(())
    }
    pub fn sql_status(&self, run: &str) -> Result<SqlStatus, DataError> {
        validate_sql_identity(run)?;
        let task = self
            .sql_workspace
            .tasks
            .lock()
            .map_err(|_| registry_error())?
            .get(run)
            .cloned()
            .ok_or_else(|| invalid("SQL run was not found."))?;
        let mut s = task.status.lock().map_err(|_| registry_error())?.clone();
        if !terminal(s.state) {
            s.elapsed_ms = elapsed_ms(task.started);
        }
        Ok(s)
    }
    pub fn cancel_sql(&self, run: &str) -> Result<SqlStatus, DataError> {
        validate_sql_identity(run)?;
        if let Some(task) = self
            .sql_workspace
            .tasks
            .lock()
            .map_err(|_| registry_error())?
            .get(run)
        {
            task.cancel.store(true, Ordering::Release);
        }
        self.sql_status(run)
    }
    pub fn cancel_source_sql(&self, document: &str, session: &str) {
        if let Ok(tasks) = self.sql_workspace.tasks.lock() {
            for t in tasks.values() {
                if t.request
                    .tables
                    .iter()
                    .any(|s| s.document_id == document && s.session_id == session)
                {
                    if t.status
                        .lock()
                        .map(|status| terminal(status.state))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    if let Ok(mut reason) = t.source_cancel_reason.lock() {
                        *reason = Some("SQL was cancelled because a referenced source was closed or replaced. Reopen the source and run the query again.".to_owned());
                    }
                    t.cancel.store(true, Ordering::Release);
                }
            }
        }
    }
    /// Compensate a failed admission recheck. Unlike ordinary source close,
    /// this also discards a result completed before the command returned it.
    pub fn abandon_sql(&self, run: &str) -> Result<(), DataError> {
        validate_sql_identity(run)?;
        let tasks = self
            .sql_workspace
            .tasks
            .lock()
            .map_err(|_| registry_error())?;
        let task = tasks
            .get(run)
            .ok_or_else(|| invalid("SQL run is no longer available."))?;
        let reason = "SQL was cancelled because a referenced source closed or changed before query admission finished. Reopen the source and run the query again.".to_owned();
        *task
            .source_cancel_reason
            .lock()
            .map_err(|_| registry_error())? = Some(reason.clone());
        // Publication takes this same tasks mutex, so it must either precede
        // this cleanup or observe cancellation before inserting any result.
        task.cancel.store(true, Ordering::Release);
        let mut discarded = Vec::new();
        self.sql_workspace
            .results
            .lock()
            .map_err(|_| registry_error())?
            .retain(|_, result| {
                if result.run_id == run {
                    result.alive.store(false, Ordering::Release);
                    discarded.push(Arc::clone(result));
                    false
                } else {
                    true
                }
            });
        let mut status = task.status.lock().map_err(|_| registry_error())?;
        status.result_id = None;
        if terminal(status.state) {
            status.state = SqlState::Cancelled;
            status.phase = "cancelled".to_owned();
            status.error = Some(DataError {
                code: DataErrorCode::TaskCancelled,
                message: reason,
            });
            status.columns.clear();
            status.row_count = None;
            status.plan_text = None;
            status.plan_json = None;
        }
        drop(status);
        drop(tasks);
        for result in discarded {
            self.close_sql_result_views(&result)?;
        }
        // An active worker reports terminal state only after stop/wait and
        // execution-lease cleanup in the existing control thread.
        Ok(())
    }
    fn sql_result(&self, run: &str, id: &str) -> Result<Arc<SqlResult>, DataError> {
        validate_sql_identity(run)?;
        validate_sql_identity(id)?;
        let r = self
            .sql_workspace
            .results
            .lock()
            .map_err(|_| registry_error())?
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("SQL result is no longer available."))?;
        if r.run_id != run || !r.alive.load(Ordering::Acquire) {
            return Err(invalid("SQL result identity does not match this run."));
        }
        Ok(r)
    }
    pub fn read_sql_page(&self, request: &SqlPageRequest) -> Result<DataPage, DataError> {
        request.validate()?;
        self.sql_result(&request.run_id, &request.result_id)?.read(
            request.offset,
            request.limit,
            &request.columns,
            false,
        )
    }
    pub fn read_sql_cell(
        &self,
        run: &str,
        id: &str,
        row: u64,
        column: &str,
    ) -> Result<DataValue, DataError> {
        self.sql_result(run, id)?
            .read(row, 1, &[column.to_owned()], true)?
            .rows
            .into_iter()
            .next()
            .and_then(|mut r| r.pop())
            .ok_or_else(|| invalid("SQL cell is outside the result."))
    }
    pub fn release_sql_result(&self, run: &str, id: &str) -> Result<(), DataError> {
        let result = self.sql_result(run, id)?;
        result.alive.store(false, Ordering::Release);
        self.sql_workspace
            .results
            .lock()
            .map_err(|_| registry_error())?
            .remove(id);
        self.close_sql_result_views(&result)
    }
    pub fn sql_copy_context(
        self: &Arc<Self>,
        run: &str,
        id: &str,
        operation: &str,
        max_bytes: u64,
    ) -> Result<(Arc<dyn CopyRowReader>, PathBuf), DataError> {
        let result = self.sql_result(run, id)?;
        let (reader, path) = self.sql_copy_reader(result, operation, max_bytes)?;
        Ok((Arc::new(reader), path))
    }
    fn sql_copy_reader(
        self: &Arc<Self>,
        result: Arc<SqlResult>,
        operation: &str,
        max_bytes: u64,
    ) -> Result<(SqlCopyReader, PathBuf), DataError> {
        validate_sql_identity(operation)?;
        if max_bytes == 0 || max_bytes > 256 * 1024 * 1024 {
            return Err(invalid("SQL copy bytes must be within 1..256MiB."));
        }
        self.csv_cache.refresh_usage()?;
        let lease = Arc::new(
            self.temp
                .allocate_bounded("sql-copy", operation, max_bytes)?,
        );
        let path = lease.path().to_path_buf();
        let reader = SqlCopyReader {
            result,
            service: Arc::clone(self),
            lease,
        };
        Ok((reader, path))
    }
    pub(super) fn shutdown_sql(&self) {
        if let Ok(tasks) = self.sql_workspace.tasks.lock() {
            for task in tasks.values() {
                task.cancel.store(true, Ordering::Release);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let stopped = self
                .sql_workspace
                .tasks
                .lock()
                .map(|tasks| {
                    tasks
                        .values()
                        .all(|t| t.status.lock().map(|s| terminal(s.state)).unwrap_or(false))
                })
                .unwrap_or(false);
            if stopped || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Ok(mut results) = self.sql_workspace.results.lock() {
            for result in results.values() {
                result.alive.store(false, Ordering::Release);
                result.invalidate_views();
            }
            results.clear();
        }
    }
}

fn acquire_sql_permit(limiter: &Arc<QueryLimiter>) -> Option<QueryPermit> {
    let mut running = limiter.active.lock().ok()?;
    if *running >= MAX_CONCURRENT_QUERIES {
        return None;
    }
    *running += 1;
    Some(QueryPermit(Arc::clone(limiter)))
}
struct SqlCopyReader {
    result: Arc<SqlResult>,
    service: Arc<QueryService>,
    lease: Arc<QueryTempLease>,
}
impl CopyRowReader for SqlCopyReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.validate_current()?;
        self.result.read(offset, limit.min(4096), columns, true)
    }
    fn validate_current(&self) -> Result<(), DataError> {
        if !self.result.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        self.service.csv_cache.refresh_usage()?;
        if let Some(message) = self.service.temp.budget_violation()? {
            return Err(DataError::query_temp_limit(message));
        }
        Ok(())
    }
    fn validate_staging_bytes(&self, total: u64) -> Result<(), DataError> {
        if !self.result.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if total > self.lease.allowance_bytes() {
            return Err(DataError::query_temp_limit(
                "SQL copy staging would exceed the remaining managed storage allowance.",
            ));
        }
        Ok(())
    }
    fn column_headers(&self, columns: &[String]) -> Result<Vec<String>, DataError> {
        columns
            .iter()
            .map(|id| {
                self.result
                    .columns
                    .iter()
                    .find(|c| c.id == *id)
                    .map(|c| c.name.clone())
                    .ok_or_else(|| invalid("Unknown SQL result column."))
            })
            .collect()
    }
}
impl SqlResult {
    fn read(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
        full: bool,
    ) -> Result<DataPage, DataError> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if limit == 0 || limit > 4096 || columns.is_empty() || columns.len() > 4096 {
            return Err(invalid("Invalid SQL result read bounds."));
        }
        let mut indices = Vec::new();
        let mut used = std::collections::HashSet::new();
        for name in columns {
            if !used.insert(name) {
                return Err(invalid("Duplicate SQL result projection."));
            }
            indices.push(
                self.columns
                    .iter()
                    .position(|c| c.id == *name)
                    .ok_or_else(|| invalid("Unknown SQL result column."))?,
            );
        }
        let end = offset.saturating_add(limit as u64).min(self.rows);
        let mut rows = Vec::new();
        let mut bytes = 0usize;
        'chunks: for chunk in &self.chunks {
            if offset >= end || chunk.offset + chunk.rows <= offset || chunk.offset >= end {
                continue;
            }
            let path = self._lease.path().join(&chunk.file);
            let builder = ParquetRecordBatchReaderBuilder::try_new(
                File::open(&path).map_err(|e| io(&path, e))?,
            )
            .map_err(|e| error(e.to_string()))?;
            let mask =
                parquet::arrow::ProjectionMask::roots(builder.parquet_schema(), indices.clone());
            let sorted = {
                let mut v = indices.clone();
                v.sort_unstable();
                v
            };
            let start = offset.saturating_sub(chunk.offset) as usize;
            let stop = (end - chunk.offset).min(chunk.rows) as usize;
            let selection = parquet::arrow::arrow_reader::RowSelection::from_consecutive_ranges(
                std::iter::once(start..stop),
                chunk.rows as usize,
            );
            let reader = builder
                .with_projection(mask)
                .with_row_selection(selection)
                .with_batch_size(256)
                .build()
                .map_err(|e| error(e.to_string()))?;
            for batch in reader {
                let batch = batch.map_err(|e| error(e.to_string()))?;
                for r in 0..batch.num_rows() {
                    let mut row = Vec::new();
                    let mut row_bytes = 0;
                    for index in &indices {
                        let position = sorted
                            .iter()
                            .position(|v| v == index)
                            .ok_or_else(|| error("SQL projection is invalid."))?;
                        let a = batch.column(position);
                        let value = if full {
                            crate::data::value_format::full_value_at(a.as_ref(), r)?
                        } else {
                            crate::data::value_format::value_at(a.as_ref(), r)?
                        };
                        row_bytes += value.display.as_ref().map_or(0, String::len)
                            + value.source_display.as_ref().map_or(0, String::len)
                            + value.raw_display.as_ref().map_or(0, String::len)
                            + 128;
                        row.push(value);
                    }
                    if bytes.saturating_add(row_bytes) > PAGE_BYTES {
                        if rows.is_empty() {
                            return Err(invalid("A SQL result row exceeds the page response limit; select fewer columns."));
                        }
                        break 'chunks;
                    }
                    bytes += row_bytes;
                    rows.push(row);
                }
            }
        }
        if !self.alive.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(self.rows),
            has_more: offset.saturating_add(rows.len() as u64) < self.rows,
            columns: columns.to_vec(),
            rows,
        })
    }
}
enum WorkerProcess {
    #[cfg(not(test))]
    Child(Child),
    #[cfg(test)]
    Thread(Option<std::thread::JoinHandle<()>>, PathBuf),
}
impl WorkerProcess {
    fn validate_exit(&mut self) -> Result<(), DataError> {
        match self {
            #[cfg(not(test))]
            Self::Child(child) => {
                let status = child
                    .try_wait()
                    .map_err(|e| error(format!("SQL worker exit status could not be read: {e}")))?
                    .ok_or_else(|| error("SQL worker has not exited."))?;
                if status.success() {
                    Ok(())
                } else {
                    let code = status
                        .code()
                        .map(|code| format!("{code} (0x{:08X})", code as u32))
                        .unwrap_or_else(|| "unknown exit status".to_owned());
                    Err(error(format!("SQL worker exited unsuccessfully: {code}. Its result was not published; retry or report this worker failure.")))
                }
            }
            #[cfg(test)]
            Self::Thread(thread, _) => {
                if let Some(thread) = thread.take() {
                    thread.join().map_err(|_| {
                        error("SQL worker thread panicked; its result was not published.")
                    })?;
                }
                Ok(())
            }
        }
    }
    fn finished(&mut self) -> Result<bool, DataError> {
        match self {
            #[cfg(not(test))]
            Self::Child(c) => c
                .try_wait()
                .map(|v| v.is_some())
                .map_err(|e| error(e.to_string())),
            #[cfg(test)]
            Self::Thread(t, _) => Ok(t.as_ref().is_none_or(|t| t.is_finished())),
        }
    }
    fn stop(&mut self) {
        match self {
            #[cfg(not(test))]
            Self::Child(c) => {
                let _ = c.kill();
                let _ = c.wait();
            }
            #[cfg(test)]
            Self::Thread(t, directory) => {
                if let Some(thread) = t.take() {
                    if !thread.is_finished() {
                        let _ = fs::write(directory.join("cancel"), []);
                    }
                    let _ = thread.join();
                }
            }
        }
    }
}
impl Drop for WorkerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}
fn spawn_worker(job: &WorkerJob) -> Result<WorkerProcess, DataError> {
    #[cfg(test)]
    {
        let job = job.clone();
        let directory = job.directory.clone();
        Ok(WorkerProcess::Thread(
            Some(std::thread::spawn(move || worker::run_and_write(job))),
            directory,
        ))
    }
    #[cfg(not(test))]
    {
        let mut cmd = Command::new(std::env::current_exe().map_err(|e| error(e.to_string()))?);
        cmd.arg("--data-viewer-sql-worker")
            .arg(job.directory.join("job.json"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.spawn()
            .map(WorkerProcess::Child)
            .map_err(|e| error(format!("SQL worker could not start: {e}")))
    }
}

#[cfg(test)]
mod tests;
