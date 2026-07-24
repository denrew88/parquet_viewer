use std::{
    collections::HashMap,
    io::Write,
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
    AccessMode, Config, Connection, InterruptHandle, OptionalExt,
};
use serde::Serialize;

use crate::{
    data::{
        query_invalid_name as invalid_name, query_quote_identifier as quote_identifier,
        query_quote_literal as quote_literal, query_raw_name as raw_name, resolve_boundary,
        QueryPrepareContext, QuerySourceSpec,
    },
    domain::{
        BoundarySearchRequest, BoundarySearchResult, ColumnSchema, DataBoundaryDirection,
        DataBoundaryMode, DataError, DataErrorCode, DataPage, DataValue, DistinctValue,
        DistinctValuesRequest, DistinctValuesResponse, ExecuteQueryRequest, FindDirection,
        FindQueryMatch, FindQueryMatchRequest, FindQueryMatchResponse, QueryProgress, QueryStatus,
        QueryTaskState, ReadQueryPageRequest, ReadQueryPageResponse, ValueKind,
        COPY_MAX_BATCH_CELLS, COPY_MAX_BATCH_ESTIMATED_BYTES,
    },
    storage::{
        CsvCacheIdentity, CsvPersistentCache, CsvPersistentCacheLease, QueryTempCleanupResult,
        QueryTempLease, QueryTempManager, QueryTempUsage,
    },
};

use super::sql::{find_matches_sql, materialize_sql, scalar_lower_sql, SCALAR_LOWER_FUNCTION};

const MAX_QUERY_TASKS: usize = 128;
const MAX_QUERY_RESULTS: usize = 64;
const MAX_CONCURRENT_QUERIES: usize = 2;
const MAX_CONCURRENT_CSV_PREPARATIONS: usize = 1;
const OCCUPANCY_BLOCK_STAGES: [usize; 4] = [256, 4_096, 16_384, 65_536];
const OCCUPANCY_MAX_COLUMNS: usize = 8;
const OCCUPANCY_PROCESS_BYTES: usize = 16 * 1024 * 1024;
const OCCUPANCY_DECODED_BLOCK_BYTES: usize = 8 * 1024 * 1024;
const OCCUPANCY_MAX_ROWS: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvPreparationState {
    Preparing,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreparationStatus {
    pub document_id: String,
    pub session_id: String,
    pub state: CsvPreparationState,
    pub rows_scanned: u64,
    pub total_rows: Option<u64>,
    pub elapsed_ms: u64,
    /// Bytes read by the preparation scan only. Preview, the legacy small-file
    /// row-count worker, and foreground direct reads are intentionally excluded.
    pub source_read_bytes: u64,
    pub total_bytes: u64,
    pub cache_output_bytes: u64,
    pub navigation_frontier_row: u64,
    pub error: Option<DataError>,
}

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
struct CsvPreparationPermit(Arc<QueryLimiter>);

struct QueryBudgetMonitor {
    temp: Arc<QueryTempManager>,
    csv_cache: Option<Arc<CsvPersistentCache>>,
    stop: Arc<AtomicBool>,
    violation: Arc<Mutex<Option<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl QueryBudgetMonitor {
    fn start(
        temp: Arc<QueryTempManager>,
        csv_cache: Option<Arc<CsvPersistentCache>>,
        interrupt: Arc<InterruptHandle>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let violation = Arc::new(Mutex::new(None));
        let worker_stop = Arc::clone(&stop);
        let worker_violation = Arc::clone(&violation);
        let worker_temp = Arc::clone(&temp);
        let worker_cache = csv_cache.clone();
        let worker = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                if let Some(cache) = &worker_cache {
                    let _ = cache.refresh_usage();
                }
                if let Ok(Some(message)) = worker_temp.budget_violation() {
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
            temp,
            csv_cache,
            stop,
            violation,
            worker: Some(worker),
        }
    }

    fn check(&self) -> Result<(), DataError> {
        if let Some(cache) = &self.csv_cache {
            cache.refresh_usage()?;
        }
        if let Some(message) = self.temp.budget_violation()? {
            if let Ok(mut violation) = self.violation.lock() {
                *violation = Some(message.clone());
            }
            return Err(DataError::query_temp_limit(message));
        }
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

impl Drop for CsvPreparationPermit {
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
    epoch: Arc<AtomicU64>,
    generation: u64,
    started: std::time::Instant,
}

#[derive(Debug)]
struct CsvPreparedArtifact {
    database_path: std::path::PathBuf,
    row_count: u64,
    provider: Arc<dyn crate::data::QueryInputProvider>,
    connection: Mutex<Connection>,
    #[cfg(test)]
    range_reads: AtomicU64,
    _persistent_lease: Option<CsvPersistentCacheLease>,
    _lease: QueryTempLease,
}

struct CsvPreparation {
    identity: String,
    source_fingerprint: SourceFingerprint,
    status: Mutex<CsvPreparationStatus>,
    cancel: AtomicBool,
    interrupt: Mutex<Option<Arc<InterruptHandle>>>,
    artifact: Mutex<Option<Arc<CsvPreparedArtifact>>>,
    terminal: Condvar,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    started: std::time::Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceFingerprint {
    canonical_path: std::path::PathBuf,
    file_identity: String,
    bytes: u64,
    modified_nanos: Option<u128>,
    created_nanos: Option<u128>,
}

#[derive(Debug)]
struct PreparedQueryProvider {
    inner: Arc<dyn crate::data::QueryInputProvider>,
    columns: Vec<ColumnSchema>,
    artifact: Arc<CsvPreparedArtifact>,
}

impl crate::data::QueryInputProvider for PreparedQueryProvider {
    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let path = quote_literal(
            &self
                .artifact
                .database_path
                .to_string_lossy()
                .replace('\\', "/"),
        );
        context
            .connection
            .execute_batch(&format!(
                "ATTACH {path} AS dv_prepared (READ_ONLY); CREATE VIEW dv_source AS SELECT * FROM dv_prepared.dv_source"
            ))
            .map_err(duckdb_error)?;
        (context.progress)(0)
    }

    fn native_query_types(&self) -> bool {
        self.inner.native_query_types()
    }

    fn reusable_source_identity(&self) -> Option<String> {
        self.inner.reusable_source_identity()
    }

    fn csv_prepared_physical_columns(&self) -> Vec<crate::data::CsvPreparedPhysicalColumn> {
        self.inner.csv_prepared_physical_columns()
    }

    fn csv_source_column_count(&self) -> Option<usize> {
        self.inner.csv_source_column_count()
    }

    fn prepared_artifact_path(&self) -> Option<&Path> {
        Some(&self.artifact.database_path)
    }

    fn source_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<Option<BoundarySearchResult>, DataError> {
        self.inner.source_boundary(request, cancel)
    }

    fn preparation_metrics(&self) -> crate::data::QueryPreparationMetrics {
        self.inner.preparation_metrics()
    }

    fn sparse_query_values(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<crate::data::QueryExactValues, DataError> {
        read_prepared_csv_values(
            &self.artifact,
            &self.columns,
            row_ids,
            columns,
            OCCUPANCY_MAX_ROWS,
        )
    }

    fn copy_query_values(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<crate::data::QueryExactValues, DataError> {
        read_prepared_csv_values(
            &self.artifact,
            &self.columns,
            row_ids,
            columns,
            COPY_MAX_BATCH_CELLS,
        )
    }

    fn contiguous_query_values(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<Option<crate::data::QueryExactValues>, DataError> {
        read_prepared_csv_range(&self.artifact, &self.columns, offset, limit, columns).map(Some)
    }

    fn occupancy_states(&self, row_ids: &[u64], column: &str) -> Result<Vec<bool>, DataError> {
        self.inner.occupancy_states(row_ids, column)
    }
}

#[derive(Debug)]
struct ResultColumn {
    name: String,
    kind: ValueKind,
    nullable: bool,
    source_index: usize,
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
    occupancy: Arc<Mutex<QueryOccupancyCache>>,
    occupancy_key: QueryOccupancyKey,
    epoch: Arc<AtomicU64>,
    generation: u64,
    #[cfg(test)]
    page_trace: Mutex<Vec<QueryPageTraceEvent>>,
    _lease: QueryTempLease,
}

#[derive(Debug, Default)]
struct QueryOccupancyCache {
    columns: std::collections::VecDeque<QueryOccupancyEntry>,
    resident_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryOccupancyKey {
    document_id: String,
    session_id: String,
    query_id: String,
    generation: u64,
    column_id: String,
}

#[derive(Debug)]
struct QueryOccupancyEntry {
    key: QueryOccupancyKey,
    column: Arc<Mutex<QueryOccupancyColumn>>,
    bytes: usize,
    invalidated: bool,
}

#[derive(Debug)]
struct QueryOccupancyColumn {
    column_id: String,
    known: Vec<u64>,
    occupied: Vec<u64>,
}

impl QueryOccupancyColumn {
    fn new(column_id: String, row_count: u64) -> Option<Self> {
        let words = usize::try_from(row_count.saturating_add(63) / 64).ok()?;
        let bytes = words
            .checked_mul(std::mem::size_of::<u64>())?
            .checked_mul(2)?;
        (bytes <= OCCUPANCY_PROCESS_BYTES).then(|| Self {
            column_id,
            known: vec![0; words],
            occupied: vec![0; words],
        })
    }

    fn bytes(&self) -> usize {
        (self.known.len() + self.occupied.len()) * std::mem::size_of::<u64>()
    }

    fn get(&self, row: u64) -> Option<bool> {
        let index = usize::try_from(row).ok()?;
        let word = index / 64;
        let mask = 1_u64 << (index % 64);
        self.known
            .get(word)
            .is_some_and(|known| known & mask != 0)
            .then(|| self.occupied[word] & mask != 0)
    }

    fn set(&mut self, row: u64, value: bool) {
        let Ok(index) = usize::try_from(row) else {
            return;
        };
        let word = index / 64;
        let mask = 1_u64 << (index % 64);
        if let (Some(known), Some(occupied)) =
            (self.known.get_mut(word), self.occupied.get_mut(word))
        {
            *known |= mask;
            if value {
                *occupied |= mask;
            } else {
                *occupied &= !mask;
            }
        }
    }
}

impl QueryOccupancyCache {
    fn column(
        &mut self,
        key: QueryOccupancyKey,
        row_count: u64,
        live_epoch: Option<(&AtomicU64, u64)>,
    ) -> Result<Arc<Mutex<QueryOccupancyColumn>>, DataError> {
        if live_epoch.is_some_and(|(epoch, generation)| epoch.load(Ordering::Acquire) != generation)
        {
            return Err(DataError::query_failed(
                "The query occupancy generation is stale.",
            ));
        }
        if let Some(index) = self
            .columns
            .iter()
            .position(|entry| !entry.invalidated && entry.key == key)
        {
            let entry = self.columns.remove(index).ok_or_else(registry_error)?;
            let column = Arc::clone(&entry.column);
            self.columns.push_back(entry);
            return Ok(column);
        }
        let column =
            QueryOccupancyColumn::new(key.column_id.clone(), row_count).ok_or_else(|| {
                DataError::query_failed("The query occupancy bitmap exceeds its process budget.")
            })?;
        let bytes = column.bytes();
        while self.columns.len() >= OCCUPANCY_MAX_COLUMNS
            || self.resident_bytes.saturating_add(bytes) > OCCUPANCY_PROCESS_BYTES
        {
            let Some(index) = self
                .columns
                .iter()
                .position(|entry| Arc::strong_count(&entry.column) == 1)
            else {
                return Err(DataError::query_failed(
                    "All query occupancy bitmap leases are active; retry navigation.",
                ));
            };
            let evicted = self.columns.remove(index).ok_or_else(registry_error)?;
            self.resident_bytes = self.resident_bytes.saturating_sub(evicted.bytes());
        }
        let column = Arc::new(Mutex::new(column));
        self.resident_bytes = self.resident_bytes.saturating_add(bytes);
        self.columns.push_back(QueryOccupancyEntry {
            key,
            column: Arc::clone(&column),
            bytes,
            invalidated: false,
        });
        Ok(column)
    }

    fn invalidate_session(&mut self, document_id: &str, session_id: &str) {
        let mut retained = std::collections::VecDeque::with_capacity(self.columns.len());
        while let Some(entry) = self.columns.pop_front() {
            let matches =
                entry.key.document_id == document_id && entry.key.session_id == session_id;
            if matches {
                if Arc::strong_count(&entry.column) == 1 {
                    self.resident_bytes = self.resident_bytes.saturating_sub(entry.bytes());
                    continue;
                }
                let mut entry = entry;
                entry.invalidated = true;
                retained.push_back(entry);
            } else {
                retained.push_back(entry);
            }
        }
        self.columns = retained;
    }

    fn invalidate_all(&mut self) {
        let mut retained = std::collections::VecDeque::with_capacity(self.columns.len());
        while let Some(entry) = self.columns.pop_front() {
            if Arc::strong_count(&entry.column) == 1 {
                self.resident_bytes = self.resident_bytes.saturating_sub(entry.bytes());
            } else {
                let mut entry = entry;
                entry.invalidated = true;
                retained.push_back(entry);
            }
        }
        self.columns = retained;
    }

    fn prune_invalidated(&mut self) {
        let mut retained = std::collections::VecDeque::with_capacity(self.columns.len());
        while let Some(entry) = self.columns.pop_front() {
            if entry.invalidated && Arc::strong_count(&entry.column) == 1 {
                self.resident_bytes = self.resident_bytes.saturating_sub(entry.bytes());
            } else {
                retained.push_back(entry);
            }
        }
        self.columns = retained;
    }

    #[cfg(test)]
    fn resident_bytes(&self) -> usize {
        self.resident_bytes
    }
}

impl QueryOccupancyEntry {
    fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
enum QueryPageTraceEvent {
    IdentitySlice {
        rows: usize,
        requested_limit: usize,
        lock_held: bool,
    },
    SparseRead {
        rows: usize,
        columns: usize,
        lock_held: bool,
    },
}

impl Drop for QueryResult {
    fn drop(&mut self) {
        if let Ok(connection) = self.connection.get_mut() {
            let _ = connection.execute_batch("ROLLBACK");
        }
    }
}

pub struct QueryService {
    tasks: Mutex<HashMap<(String, String, String), Arc<QueryTask>>>,
    statuses: Mutex<HashMap<(String, String, String), QueryStatus>>,
    results: Mutex<HashMap<(String, String, String), Arc<QueryResult>>>,
    csv_preparations: Mutex<HashMap<(String, String), Arc<CsvPreparation>>>,
    occupancy: Arc<Mutex<QueryOccupancyCache>>,
    query_epochs: Mutex<HashMap<(String, String), Arc<AtomicU64>>>,
    execute_gate: Mutex<()>,
    next_distinct_id: AtomicU64,
    next_csv_preparation_id: AtomicU64,
    csv_preparation_limiter: Arc<QueryLimiter>,
    shutting_down: AtomicBool,
    // Drop after result connections and leases have released their files.
    csv_cache: Arc<CsvPersistentCache>,
    temp: Arc<QueryTempManager>,
}

impl QueryService {
    pub fn open(local_data: impl Into<std::path::PathBuf>, limit: u64) -> Result<Self, DataError> {
        let local_data = local_data.into();
        let temp = Arc::new(QueryTempManager::open(local_data.clone(), limit)?);
        let csv_cache = Arc::new(CsvPersistentCache::open(&local_data, Arc::clone(&temp))?);
        Ok(Self {
            tasks: Mutex::new(HashMap::new()),
            statuses: Mutex::new(HashMap::new()),
            results: Mutex::new(HashMap::new()),
            csv_preparations: Mutex::new(HashMap::new()),
            occupancy: Arc::new(Mutex::new(QueryOccupancyCache::default())),
            query_epochs: Mutex::new(HashMap::new()),
            execute_gate: Mutex::new(()),
            next_distinct_id: AtomicU64::new(1),
            next_csv_preparation_id: AtomicU64::new(1),
            csv_preparation_limiter: csv_preparation_limiter(),
            shutting_down: AtomicBool::new(false),
            csv_cache,
            temp,
        })
    }

    pub fn set_temp_limit(&self, limit: u64) {
        self.temp.set_limit(limit);
    }

    pub fn copy_staging_directory(&self) -> std::path::PathBuf {
        self.temp.process_directory().join("copy-staging")
    }

    pub fn prepare_csv_session(
        self: &Arc<Self>,
        document_id: &str,
        session_id: &str,
        source: QuerySourceSpec,
    ) -> Result<CsvPreparationStatus, DataError> {
        validate_id("document", document_id)?;
        validate_id("session", session_id)?;
        let identity = source.provider.reusable_source_identity().ok_or_else(|| {
            DataError::invalid_request("Only CSV query sources support reusable preparation.")
        })?;
        let source_file = if source.path.exists() {
            Some(
                std::fs::File::open(&source.path)
                    .map_err(|error| DataError::io(&source.path, error))?,
            )
        } else {
            None
        };
        let initial_fingerprint = source_fingerprint_pinned(&source.path, source_file.as_ref())?;
        let total_bytes = initial_fingerprint.bytes;
        let key = (document_id.to_owned(), session_id.to_owned());
        let preparation_id = self.next_csv_preparation_id.fetch_add(1, Ordering::Relaxed);
        let task = Arc::new(CsvPreparation {
            identity: identity.clone(),
            source_fingerprint: initial_fingerprint,
            status: Mutex::new(CsvPreparationStatus {
                document_id: document_id.to_owned(),
                session_id: session_id.to_owned(),
                state: CsvPreparationState::Preparing,
                rows_scanned: 0,
                total_rows: source.total_rows,
                elapsed_ms: 0,
                source_read_bytes: 0,
                total_bytes,
                cache_output_bytes: 0,
                navigation_frontier_row: 0,
                error: None,
            }),
            cancel: AtomicBool::new(false),
            interrupt: Mutex::new(None),
            artifact: Mutex::new(None),
            terminal: Condvar::new(),
            worker: Mutex::new(None),
            started: std::time::Instant::now(),
        });
        {
            let mut preparations = self.csv_preparations.lock().map_err(|_| registry_error())?;
            if let Some(existing) = preparations.get(&key).cloned() {
                if existing.identity == identity {
                    let status = preparation_status(&existing)?;
                    if matches!(
                        status.state,
                        CsvPreparationState::Preparing | CsvPreparationState::Ready
                    ) {
                        return Ok(status);
                    }
                }
                cancel_csv_preparation_task(&existing);
            }
            preparations.insert(key.clone(), Arc::clone(&task));
        }
        let cache_identity = csv_cache_identity(
            &identity,
            &task.source_fingerprint,
            source.columns.len(),
            source
                .provider
                .csv_source_column_count()
                .unwrap_or(source.columns.len()),
            None,
            source.provider.csv_prepared_physical_columns(),
        );
        let cache_hit = match self.csv_cache.lookup(&cache_identity) {
            Ok(hit) => hit,
            Err(error) => {
                source.provider.preparation_aborted();
                if let Ok(mut preparations) = self.csv_preparations.lock() {
                    if preparations
                        .get(&key)
                        .is_some_and(|known| Arc::ptr_eq(known, &task))
                    {
                        preparations.remove(&key);
                    }
                }
                set_csv_preparation_state(&task, CsvPreparationState::Failed, Some(error.clone()));
                return Err(error);
            }
        };
        let lease = match self
            .temp
            .allocate(document_id, &format!("csv-prepared-{preparation_id}"))
        {
            Ok(lease) => lease,
            Err(error) => {
                source.provider.preparation_aborted();
                if let Ok(mut preparations) = self.csv_preparations.lock() {
                    if preparations
                        .get(&key)
                        .is_some_and(|known| Arc::ptr_eq(known, &task))
                    {
                        preparations.remove(&key);
                    }
                }
                set_csv_preparation_state(&task, CsvPreparationState::Failed, Some(error.clone()));
                return Err(error);
            }
        };
        let database_path = lease.path().join("prepared.duckdb");

        if let Some(hit) = cache_hit {
            let restore = (|| {
                if !source_fingerprint_matches(
                    &source.path,
                    source_file.as_ref(),
                    &task.source_fingerprint,
                )? {
                    return Err(DataError::query_failed(
                        "The CSV source changed while a persistent cache entry was being restored.",
                    ));
                }
                source.provider.restore_prepared_state(
                    &hit.path.join("states.bin"),
                    hit.rows,
                    source.columns.len(),
                )?;
                let parquet_path = hit.path.join("prepared.parquet");
                build_csv_cached_database(
                    &source,
                    &database_path,
                    &parquet_path,
                    self.temp.configured_limit(),
                )?;
                let config = query_connection_config()?
                    .access_mode(AccessMode::ReadOnly)
                    .map_err(duckdb_error)?;
                let connection =
                    Connection::open_with_flags(&database_path, config).map_err(duckdb_error)?;
                if !source_fingerprint_matches(
                    &source.path,
                    source_file.as_ref(),
                    &task.source_fingerprint,
                )? {
                    return Err(DataError::query_failed(
                        "The CSV source changed while a persistent cache entry was being restored.",
                    ));
                }
                Ok::<_, DataError>((connection, hit))
            })();
            match restore {
                Ok((connection, hit)) => {
                    let cache_output_bytes = std::fs::metadata(&database_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0);
                    let artifact = Arc::new(CsvPreparedArtifact {
                        database_path,
                        row_count: hit.rows,
                        provider: Arc::clone(&source.provider),
                        connection: Mutex::new(connection),
                        #[cfg(test)]
                        range_reads: AtomicU64::new(0),
                        _persistent_lease: Some(hit.lease),
                        _lease: lease,
                    });
                    if !commit_csv_preparation_ready(self, &key, &task, artifact)? {
                        set_csv_preparation_state(&task, CsvPreparationState::Cancelled, None);
                        return preparation_status(&task);
                    }
                    if let Ok(mut status) = task.status.lock() {
                        status.rows_scanned = hit.rows;
                        status.total_rows = Some(hit.rows);
                        status.elapsed_ms = elapsed_ms(task.started);
                        status.source_read_bytes = 0;
                        status.cache_output_bytes = cache_output_bytes;
                        status.navigation_frontier_row = hit.rows;
                    }
                    return preparation_status(&task);
                }
                Err(error) => {
                    source.provider.preparation_aborted();
                    set_csv_preparation_state(
                        &task,
                        CsvPreparationState::Failed,
                        Some(error.clone()),
                    );
                    return Err(error);
                }
            }
        }

        let temp = Arc::clone(&self.temp);
        let csv_cache = Arc::clone(&self.csv_cache);
        let csv_preparation_limiter = Arc::clone(&self.csv_preparation_limiter);
        let service = Arc::downgrade(self);
        let worker_key = key.clone();
        let worker_task = Arc::clone(&task);
        let worker = std::thread::spawn(move || {
            let Some(_permit) =
                acquire_csv_preparation_permit(&csv_preparation_limiter, &worker_task.cancel)
            else {
                set_csv_preparation_state(&worker_task, CsvPreparationState::Cancelled, None);
                return;
            };
            let result = build_csv_prepared_artifact(
                &source,
                &database_path,
                &worker_task,
                Arc::clone(&temp),
                Arc::clone(&csv_cache),
                source_file.as_ref(),
            );
            if let Ok(mut interrupt) = worker_task.interrupt.lock() {
                interrupt.take();
            }
            match result {
                Ok(()) if !worker_task.cancel.load(Ordering::Acquire) => {
                    match source_fingerprint_matches(
                        &source.path,
                        source_file.as_ref(),
                        &worker_task.source_fingerprint,
                    ) {
                        Ok(true) => {}
                        Ok(false) => {
                            set_csv_preparation_state(
                                &worker_task,
                                CsvPreparationState::Failed,
                                Some(DataError::query_failed(
                                    "The CSV source changed before the prepared cache was committed.",
                                )),
                            );
                            return;
                        }
                        Err(error) => {
                            set_csv_preparation_state(
                                &worker_task,
                                CsvPreparationState::Failed,
                                Some(error),
                            );
                            return;
                        }
                    }
                    let row_count = worker_task
                        .status
                        .lock()
                        .map(|status| status.rows_scanned)
                        .unwrap_or(0);
                    let publish_identity = csv_cache_identity(
                        &worker_task.identity,
                        &worker_task.source_fingerprint,
                        source.columns.len(),
                        source
                            .provider
                            .csv_source_column_count()
                            .unwrap_or(source.columns.len()),
                        Some(row_count),
                        source.provider.csv_prepared_physical_columns(),
                    );
                    let artifact_directory =
                        database_path.parent().unwrap_or_else(|| Path::new("."));
                    let has_publish_artifacts =
                        match csv_cache.has_publish_artifacts(artifact_directory) {
                            Ok(has_artifacts) => has_artifacts,
                            Err(error) => {
                                set_csv_preparation_state(
                                    &worker_task,
                                    CsvPreparationState::Failed,
                                    Some(error),
                                );
                                return;
                            }
                        };
                    let persistent_lease = if has_publish_artifacts {
                        match csv_cache.publish(&publish_identity, artifact_directory, || {
                            if !source_fingerprint_matches(
                                &source.path,
                                source_file.as_ref(),
                                &worker_task.source_fingerprint,
                            )? {
                                return Err(DataError::query_failed(
                                    "The CSV source changed before persistent cache publication.",
                                ));
                            }
                            let service =
                                service.upgrade().ok_or_else(DataError::task_cancelled)?;
                            if worker_task.cancel.load(Ordering::Acquire)
                                || !csv_preparation_is_current(&service, &worker_key, &worker_task)?
                            {
                                return Err(DataError::task_cancelled());
                            }
                            Ok(())
                        }) {
                            Ok(lease) => Some(lease),
                            Err(error)
                                if worker_task.cancel.load(Ordering::Acquire)
                                    || error.code == DataErrorCode::TaskCancelled =>
                            {
                                set_csv_preparation_state(
                                    &worker_task,
                                    CsvPreparationState::Cancelled,
                                    None,
                                );
                                return;
                            }
                            Err(error) => {
                                set_csv_preparation_state(
                                    &worker_task,
                                    CsvPreparationState::Failed,
                                    Some(error),
                                );
                                return;
                            }
                        }
                    } else {
                        None
                    };
                    if !source_fingerprint_matches(
                        &source.path,
                        source_file.as_ref(),
                        &worker_task.source_fingerprint,
                    )
                    .unwrap_or(false)
                    {
                        set_csv_preparation_state(
                            &worker_task,
                            CsvPreparationState::Failed,
                            Some(DataError::query_failed(
                                "The CSV source changed after persistent cache publication.",
                            )),
                        );
                        return;
                    }
                    let Some(current_service) = service.upgrade() else {
                        set_csv_preparation_state(
                            &worker_task,
                            CsvPreparationState::Cancelled,
                            None,
                        );
                        return;
                    };
                    if worker_task.cancel.load(Ordering::Acquire)
                        || !csv_preparation_is_current(&current_service, &worker_key, &worker_task)
                            .unwrap_or(false)
                    {
                        set_csv_preparation_state(
                            &worker_task,
                            CsvPreparationState::Cancelled,
                            None,
                        );
                        return;
                    }
                    if let Some(lease) = &persistent_lease {
                        if let Err(error) = build_csv_cached_database(
                            &source,
                            &database_path,
                            &lease.path().join("prepared.parquet"),
                            temp.configured_limit(),
                        ) {
                            set_csv_preparation_state(
                                &worker_task,
                                CsvPreparationState::Failed,
                                Some(error),
                            );
                            return;
                        }
                    }
                    let connection = query_connection_config()
                        .and_then(|config| {
                            config
                                .access_mode(AccessMode::ReadOnly)
                                .map_err(duckdb_error)
                        })
                        .and_then(|config| {
                            Connection::open_with_flags(&database_path, config)
                                .map_err(duckdb_error)
                        });
                    if let Ok(connection) = connection {
                        let Some(service) = service.upgrade() else {
                            set_csv_preparation_state(
                                &worker_task,
                                CsvPreparationState::Cancelled,
                                None,
                            );
                            return;
                        };
                        if worker_task.cancel.load(Ordering::Acquire)
                            || !csv_preparation_is_current(&service, &worker_key, &worker_task)
                                .unwrap_or(false)
                        {
                            set_csv_preparation_state(
                                &worker_task,
                                CsvPreparationState::Cancelled,
                                None,
                            );
                            return;
                        }
                        let artifact = Arc::new(CsvPreparedArtifact {
                            database_path,
                            row_count,
                            provider: Arc::clone(&source.provider),
                            connection: Mutex::new(connection),
                            #[cfg(test)]
                            range_reads: AtomicU64::new(0),
                            _persistent_lease: persistent_lease,
                            _lease: lease,
                        });
                        if !commit_csv_preparation_ready(
                            &service,
                            &worker_key,
                            &worker_task,
                            artifact,
                        )
                        .unwrap_or(false)
                        {
                            set_csv_preparation_state(
                                &worker_task,
                                CsvPreparationState::Cancelled,
                                None,
                            );
                        }
                    } else {
                        set_csv_preparation_state(
                            &worker_task,
                            CsvPreparationState::Failed,
                            connection.err(),
                        );
                    }
                }
                Ok(()) => {
                    set_csv_preparation_state(&worker_task, CsvPreparationState::Cancelled, None);
                }
                Err(error)
                    if worker_task.cancel.load(Ordering::Acquire)
                        || error.code == DataErrorCode::TaskCancelled =>
                {
                    set_csv_preparation_state(&worker_task, CsvPreparationState::Cancelled, None);
                }
                Err(error) => set_csv_preparation_state(
                    &worker_task,
                    CsvPreparationState::Failed,
                    Some(error),
                ),
            }
        });
        *task.worker.lock().map_err(|_| registry_error())? = Some(worker);
        preparation_status(&task)
    }

    pub fn csv_preparation_status(
        &self,
        document_id: &str,
        session_id: &str,
    ) -> Result<Option<CsvPreparationStatus>, DataError> {
        let task = self
            .csv_preparations
            .lock()
            .map_err(|_| registry_error())?
            .get(&(document_id.to_owned(), session_id.to_owned()))
            .cloned();
        task.as_ref()
            .map(|task| preparation_status(task))
            .transpose()
    }

    pub fn cancel_csv_preparation(
        &self,
        document_id: &str,
        session_id: &str,
    ) -> Result<Option<CsvPreparationStatus>, DataError> {
        let task = self
            .csv_preparations
            .lock()
            .map_err(|_| registry_error())?
            .get(&(document_id.to_owned(), session_id.to_owned()))
            .cloned();
        if let Some(task) = task {
            cancel_csv_preparation_task(&task);
            Ok(Some(preparation_status(&task)?))
        } else {
            Ok(None)
        }
    }

    pub fn read_prepared_csv_page(
        &self,
        document_id: &str,
        session_id: &str,
        source: QuerySourceSpec,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<Option<DataPage>, DataError> {
        if !(1..=200).contains(&limit) || !(1..=64).contains(&columns.len()) {
            return Err(DataError::invalid_request(
                "Prepared CSV pages require 1 to 200 rows and 1 to 64 columns.",
            ));
        }
        let source = self.source_with_ready_csv_artifact(document_id, session_id, source)?;
        if source.provider.prepared_artifact_path().is_none() {
            return Ok(None);
        }
        prepared_csv_page(&source, offset, limit, columns).map(Some)
    }

    pub fn read_prepared_csv_copy(
        &self,
        document_id: &str,
        session_id: &str,
        source: QuerySourceSpec,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<Option<DataPage>, DataError> {
        if limit == 0
            || columns.is_empty()
            || columns.len() > 64
            || limit
                .checked_mul(columns.len())
                .is_none_or(|cells| cells > COPY_MAX_BATCH_CELLS)
        {
            return Err(DataError::invalid_request(
                "Prepared CSV copy batches must contain 1 to 64,000 cells.",
            ));
        }
        let source = self.source_with_ready_csv_artifact(document_id, session_id, source)?;
        if source.provider.prepared_artifact_path().is_none() {
            return Ok(None);
        }
        prepared_csv_page(&source, offset, limit, columns).map(Some)
    }

    pub fn find_prepared_csv_boundary(
        &self,
        document_id: &str,
        session_id: &str,
        source: QuerySourceSpec,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<Option<BoundarySearchResult>, DataError> {
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if let Some(identity) = source.provider.reusable_source_identity() {
            let task = self
                .csv_preparations
                .lock()
                .map_err(|_| registry_error())?
                .get(&(document_id.to_owned(), session_id.to_owned()))
                .cloned();
            if let Some(task) = task.filter(|task| task.identity == identity) {
                let mut status = task.status.lock().map_err(|_| registry_error())?;
                while status.state == CsvPreparationState::Preparing {
                    if cancel.load(Ordering::Acquire) {
                        return Err(DataError::task_cancelled());
                    }
                    let (next, _) = task
                        .terminal
                        .wait_timeout(status, std::time::Duration::from_millis(25))
                        .map_err(|_| registry_error())?;
                    status = next;
                }
                match status.state {
                    CsvPreparationState::Ready => {}
                    CsvPreparationState::Cancelled | CsvPreparationState::Failed => {
                        if cancel.load(Ordering::Acquire) {
                            return Err(DataError::task_cancelled());
                        }
                        return Ok(None);
                    }
                    CsvPreparationState::Preparing => unreachable!(),
                }
            }
        }
        let source = self.source_with_ready_csv_artifact(document_id, session_id, source)?;
        if source.provider.prepared_artifact_path().is_none() {
            return Ok(None);
        }
        crate::data::validate_boundary_request(&source.columns, source.total_rows, request)?;
        if let Some(result) = source.provider.source_boundary(request, cancel)? {
            return Ok(Some(result));
        }
        resolve_boundary(
            &source.columns,
            source.total_rows,
            request,
            cancel,
            |offset, limit, columns| prepared_csv_page(&source, offset, limit, columns),
        )
        .map(Some)
    }

    pub fn execute(
        self: &Arc<Self>,
        request: ExecuteQueryRequest,
        source: QuerySourceSpec,
    ) -> Result<QueryStatus, DataError> {
        let _execute_gate = self.execute_gate.lock().map_err(|_| registry_error())?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(DataError::query_failed(
                "The query service is shutting down.",
            ));
        }
        validate_id("query", &request.query_id)?;
        validate_id("task", &request.task_id)?;
        let epoch = {
            let mut epochs = self.query_epochs.lock().map_err(|_| registry_error())?;
            Arc::clone(
                epochs
                    .entry((request.document_id.clone(), request.session_id.clone()))
                    .or_insert_with(|| Arc::new(AtomicU64::new(0))),
            )
        };
        let generation = epoch.fetch_add(1, Ordering::AcqRel).saturating_add(1);
        self.drop_session_results(&request.document_id, &request.session_id, true)?;
        let source =
            self.source_with_ready_csv_artifact(&request.document_id, &request.session_id, source)?;
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
            epoch,
            generation,
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
        request.validate()?;
        let result = self.result(&request.document_id, &request.session_id, &request.query_id)?;
        let page =
            result.read_page_projected(request.offset as u64, request.limit, &request.columns)?;
        Ok(ReadQueryPageResponse {
            document_id: request.document_id,
            session_id: request.session_id,
            query_id: request.query_id,
            page,
        })
    }

    pub(crate) fn read_copy_rows(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        if columns.is_empty()
            || limit == 0
            || limit
                .checked_mul(columns.len())
                .is_none_or(|cells| cells > COPY_MAX_BATCH_CELLS)
        {
            return Err(DataError::invalid_request(
                "Query copy batches must contain 1 to 64,000 cells.",
            ));
        }
        let unique = columns.iter().collect::<std::collections::HashSet<_>>();
        if unique.len() != columns.len() {
            return Err(DataError::invalid_request(
                "Query copy projection columns must be unique.",
            ));
        }
        self.result(document_id, session_id, query_id)?
            .read_copy_projected(offset, limit, columns)
    }

    pub(crate) fn validate_result_identity(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
    ) -> Result<(), DataError> {
        self.result(document_id, session_id, query_id).map(|_| ())
    }

    pub fn read_cell_value(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
        row: u64,
        column: &str,
    ) -> Result<DataValue, DataError> {
        self.result(document_id, session_id, query_id)?
            .read_cell_value(row, column)
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

    pub fn find_boundary(
        &self,
        document_id: &str,
        session_id: &str,
        query_id: &str,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        self.result(document_id, session_id, query_id)?
            .find_boundary(request, cancel)
    }

    pub fn drop_session(&self, document_id: &str, session_id: &str) -> Result<(), DataError> {
        if let Some(epoch) = self
            .query_epochs
            .lock()
            .map_err(|_| registry_error())?
            .get(&(document_id.to_owned(), session_id.to_owned()))
            .cloned()
        {
            epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.drop_session_results(document_id, session_id, true)?;
        if let Some(task) = self
            .csv_preparations
            .lock()
            .map_err(|_| registry_error())?
            .remove(&(document_id.to_owned(), session_id.to_owned()))
        {
            cancel_csv_preparation_task(&task);
            wait_csv_preparation_worker(&task, std::time::Duration::from_secs(3))?;
        }
        Ok(())
    }

    pub fn usage(&self) -> Result<QueryTempUsage, DataError> {
        self.csv_cache.refresh_usage()?;
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
        let preparations = self
            .csv_preparations
            .lock()
            .map(|preparations| preparations.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for task in &preparations {
            cancel_csv_preparation_task(task);
        }
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
        let mut preparations_stopped = true;
        for task in &preparations {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if wait_csv_preparation_worker(task, remaining).is_err() {
                preparations_stopped = false;
            }
        }
        if let Ok(mut results) = self.results.lock() {
            results.clear();
        }
        if let Ok(mut occupancy) = self.occupancy.lock() {
            occupancy.invalidate_all();
        }
        if preparations_stopped {
            if let Ok(mut preparations) = self.csv_preparations.lock() {
                preparations.clear();
            }
        }
        if tasks_stopped && preparations_stopped {
            self.temp
                .shutdown_cleanup(deadline.saturating_duration_since(std::time::Instant::now()));
        }
    }

    fn source_with_ready_csv_artifact(
        &self,
        document_id: &str,
        session_id: &str,
        mut source: QuerySourceSpec,
    ) -> Result<QuerySourceSpec, DataError> {
        let Some(identity) = source.provider.reusable_source_identity() else {
            return Ok(source);
        };
        let task = self
            .csv_preparations
            .lock()
            .map_err(|_| registry_error())?
            .get(&(document_id.to_owned(), session_id.to_owned()))
            .cloned();
        let Some(task) = task else {
            return Ok(source);
        };
        if task.identity != identity {
            return Ok(source);
        }
        if source_fingerprint(&source.path)? != task.source_fingerprint {
            cancel_csv_preparation_task(&task);
            if let Ok(mut artifact) = task.artifact.lock() {
                artifact.take();
            }
            return Ok(source);
        }
        if preparation_status(&task)?.state != CsvPreparationState::Ready {
            return Ok(source);
        }
        let artifact = task
            .artifact
            .lock()
            .map_err(|_| registry_error())?
            .as_ref()
            .cloned();
        if let Some(artifact) = artifact {
            source.total_rows = Some(artifact.row_count);
            source.provider = Arc::new(PreparedQueryProvider {
                inner: Arc::clone(&artifact.provider),
                columns: source.columns.clone(),
                artifact,
            });
        }
        Ok(source)
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
                        if task.cancel.load(Ordering::Acquire)
                            || task.epoch.load(Ordering::Acquire) != task.generation
                        {
                            drop(results);
                            set_task_state(&task, QueryTaskState::Cancelled, None);
                            self.finish_task(&request, &task);
                            return;
                        }
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
        self.csv_cache.refresh_usage()?;
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
        let budget = QueryBudgetMonitor::start(
            Arc::clone(&self.temp),
            Some(Arc::clone(&self.csv_cache)),
            interrupt,
        );
        let prepared = prepare_source(
            &connection,
            source,
            lease.path(),
            &task.cancel,
            Some(task),
            &budget,
        );
        if prepared.is_err() && budget.violated() {
            budget.check()?;
        }
        prepared?;
        connection
            .execute_batch("BEGIN TRANSACTION")
            .map_err(duckdb_error)?;
        connection
            .execute_batch("CREATE TABLE query_result (__dv_row_id UBIGINT)")
            .map_err(duckdb_error)?;
        let materialized = materialize_sql(source, &request.plan)?;
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
        connection
            .execute_batch("COMMIT; BEGIN TRANSACTION")
            .map_err(duckdb_error)?;
        let row_count: u64 = connection
            .query_row("SELECT count(*) FROM query_result", [], |row| row.get(0))
            .map_err(duckdb_error)?;
        validate_result_index(&connection, row_count)?;
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
        let columns = materialized
            .columns
            .iter()
            .map(|index| ResultColumn {
                name: source.columns[*index].name.clone(),
                kind: value_kind(&source.columns[*index]),
                nullable: source.columns[*index].nullable,
                source_index: *index,
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
            occupancy: Arc::clone(&self.occupancy),
            occupancy_key: QueryOccupancyKey {
                document_id: request.document_id.clone(),
                session_id: request.session_id.clone(),
                query_id: request.query_id.clone(),
                generation: task.generation,
                column_id: String::new(),
            },
            epoch: Arc::clone(&task.epoch),
            generation: task.generation,
            #[cfg(test)]
            page_trace: Mutex::new(Vec::new()),
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
        let source =
            self.source_with_ready_csv_artifact(&request.document_id, &request.session_id, source)?;
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
        self.csv_cache.refresh_usage()?;
        let lease = self.temp.allocate(&request.document_id, &id)?;
        let connection = open_connection(
            &source,
            lease.path(),
            self.temp.usage()?.limit_bytes / MAX_CONCURRENT_QUERIES as u64,
        )?;
        let monitor = QueryBudgetMonitor::start(
            Arc::clone(&self.temp),
            Some(Arc::clone(&self.csv_cache)),
            connection.interrupt_handle(),
        );
        prepare_source(
            &connection,
            &source,
            lease.path(),
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
        self.occupancy
            .lock()
            .map_err(|_| registry_error())?
            .invalidate_session(document_id, session_id);
        self.statuses
            .lock()
            .map_err(|_| registry_error())?
            .retain(|(document, session, _), _| document != document_id || session != session_id);
        Ok(())
    }
}

impl QueryResult {
    fn find_vertical_boundary_cached(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<Option<BoundarySearchResult>, DataError> {
        let mut key = self.occupancy_key.clone();
        key.column_id = request.column_id.clone();
        let column = self
            .occupancy
            .lock()
            .map_err(|_| registry_error())?
            .column(
                key,
                self.row_count,
                Some((self.epoch.as_ref(), self.generation)),
            )?;
        let result = {
            let mut state = column.lock().map_err(|_| registry_error())?;
            self.find_vertical_with_column(request, cancel, &mut state)
                .map(Some)
        };
        drop(column);
        self.occupancy
            .lock()
            .map_err(|_| registry_error())?
            .prune_invalidated();
        result
    }

    fn find_vertical_with_column(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
        column: &mut QueryOccupancyColumn,
    ) -> Result<BoundarySearchResult, DataError> {
        self.ensure_query_occupancy(column, request.row, 1, cancel)?;
        let current_occupied = column.get(request.row).ok_or_else(|| {
            DataError::query_failed("Current query occupancy state is unavailable.")
        })?;
        let mut cursor = request.row;
        let mut target = request.row;
        let mut first_neighbor = true;
        let mut seek_occupied = false;
        let mut stage = 0_usize;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let block = OCCUPANCY_BLOCK_STAGES[stage.min(OCCUPANCY_BLOCK_STAGES.len() - 1)];
            stage = stage.saturating_add(1);
            let (start, len, reverse) = match request.direction {
                DataBoundaryDirection::Down => {
                    let start = cursor.saturating_add(1);
                    if start >= self.row_count {
                        break;
                    }
                    (
                        start,
                        (self.row_count - start).min(block as u64) as usize,
                        false,
                    )
                }
                DataBoundaryDirection::Up => {
                    if cursor == 0 {
                        break;
                    }
                    let start = cursor.saturating_sub(block as u64);
                    (start, (cursor - start) as usize, true)
                }
                _ => unreachable!(),
            };
            self.ensure_query_occupancy(column, start, len, cancel)?;
            let indices: Box<dyn Iterator<Item = u64>> = if reverse {
                Box::new((start..start + len as u64).rev())
            } else {
                Box::new(start..start + len as u64)
            };
            for row in indices {
                let occupied = column.get(row).ok_or_else(|| {
                    DataError::query_failed("Query occupancy block is incomplete.")
                })?;
                if first_neighbor {
                    seek_occupied = !(current_occupied && occupied);
                    first_neighbor = false;
                }
                if seek_occupied {
                    if occupied {
                        return Ok(BoundarySearchResult {
                            target_row: row,
                            target_column_id: request.column_id.clone(),
                            resolved_row_count: Some(self.row_count),
                        });
                    }
                    target = row;
                } else if occupied {
                    target = row;
                } else {
                    return Ok(BoundarySearchResult {
                        target_row: target,
                        target_column_id: request.column_id.clone(),
                        resolved_row_count: Some(self.row_count),
                    });
                }
            }
            cursor = if reverse {
                start
            } else {
                start + len as u64 - 1
            };
        }
        Ok(BoundarySearchResult {
            target_row: target,
            target_column_id: request.column_id.clone(),
            resolved_row_count: Some(self.row_count),
        })
    }

    fn ensure_query_occupancy(
        &self,
        column: &mut QueryOccupancyColumn,
        offset: u64,
        limit: usize,
        cancel: &AtomicBool,
    ) -> Result<(), DataError> {
        if limit > OCCUPANCY_MAX_ROWS
            || limit > OCCUPANCY_DECODED_BLOCK_BYTES / std::mem::size_of::<bool>()
        {
            return Err(DataError::query_failed(
                "Query occupancy state block exceeds its row or byte cap.",
            ));
        }
        if (offset..offset.saturating_add(limit as u64)).all(|row| column.get(row).is_some()) {
            return Ok(());
        }
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let row_ids = {
            let connection = self.connection.lock().map_err(|_| registry_error())?;
            let mut statement = connection
                .prepare(
                    "SELECT q.__dv_row_id FROM query_result q WHERE q.rowid >= ? ORDER BY q.rowid LIMIT ?",
                )
                .map_err(duckdb_error)?;
            statement
                .query_map(params![offset, limit as u64], |row| row.get::<_, u64>(0))
                .map_err(duckdb_error)?
                .collect::<duckdb::Result<Vec<_>>>()
                .map_err(duckdb_error)?
        };
        let states = self
            .provider
            .occupancy_states(&row_ids, &column.column_id)?;
        if states.len() != limit {
            return Err(DataError::query_failed(
                "Query occupancy state scan returned a mismatched row count.",
            ));
        }
        for (index, occupied) in states.into_iter().enumerate() {
            column.set(offset + index as u64, occupied);
        }
        Ok(())
    }

    fn read_copy_projected(
        &self,
        offset: u64,
        limit: usize,
        projection: &[String],
    ) -> Result<DataPage, DataError> {
        self.read_projected_sparse(offset, limit, projection, true)
    }

    fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        projection: &[String],
    ) -> Result<DataPage, DataError> {
        self.read_projected_sparse(offset, limit, projection, false)
    }

    fn read_projected_sparse(
        &self,
        offset: u64,
        limit: usize,
        projection: &[String],
        copy: bool,
    ) -> Result<DataPage, DataError> {
        projection
            .iter()
            .map(|name| {
                self.columns
                    .iter()
                    .position(|column| column.name == *name)
                    .ok_or_else(|| {
                        DataError::invalid_request(format!(
                            "Unknown query result boundary column: {name}"
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let identities = {
            let connection = self.connection.lock().map_err(|_| registry_error())?;
            let mut statement = connection
                .prepare(
                    "SELECT q.rowid, q.__dv_row_id FROM query_result q WHERE q.rowid >= ? ORDER BY q.rowid LIMIT ?",
                )
                .map_err(duckdb_error)?;
            let identities = statement
                .query_map(params![offset, limit as u64], |row| {
                    Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?))
                })
                .map_err(duckdb_error)?
                .collect::<duckdb::Result<Vec<_>>>()
                .map_err(duckdb_error)?;
            #[cfg(test)]
            self.page_trace.lock().expect("query page trace lock").push(
                QueryPageTraceEvent::IdentitySlice {
                    rows: identities.len(),
                    requested_limit: limit,
                    lock_held: self.connection.try_lock().is_err(),
                },
            );
            identities
        };
        let identity_limit = if copy { COPY_MAX_BATCH_CELLS } else { 200 };
        if identities.len() > limit || identities.len() > identity_limit {
            return Err(DataError::query_failed(
                "Query page identity slice exceeded its bounded limit.",
            ));
        }
        for (index, (position, _)) in identities.iter().enumerate() {
            if *position != offset.saturating_add(index as u64) {
                return Err(DataError::query_failed(
                    "Query result physical position invariant failed while reading a page.",
                ));
            }
        }
        let row_ids = identities
            .iter()
            .map(|(_, source_row)| *source_row)
            .collect::<Vec<_>>();
        #[cfg(test)]
        self.page_trace.lock().expect("query page trace lock").push(
            QueryPageTraceEvent::SparseRead {
                rows: row_ids.len(),
                columns: projection.len(),
                lock_held: self.connection.try_lock().is_err(),
            },
        );
        let sparse = if copy && contiguous_source_rows(&row_ids) {
            if let Some(values) =
                self.provider
                    .contiguous_query_values(row_ids[0], row_ids.len(), projection)?
            {
                values
            } else {
                self.provider.copy_query_values(&row_ids, projection)?
            }
        } else if copy {
            self.provider.copy_query_values(&row_ids, projection)?
        } else {
            self.provider.sparse_query_values(&row_ids, projection)?
        };
        if sparse.columns != projection
            || sparse.rows.len() != row_ids.len()
            || sparse.rows.iter().any(|row| row.len() != projection.len())
        {
            return Err(DataError::query_failed(
                "Sparse source values did not match the query page projection or shape.",
            ));
        }
        let rows = sparse.rows;
        if copy && estimated_page_bytes(&rows) > COPY_MAX_BATCH_ESTIMATED_BYTES {
            return Err(DataError::invalid_request(
                "Query copy batch exceeds the 8 MiB estimated value budget.",
            ));
        }
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(self.row_count),
            has_more: offset.saturating_add(rows.len() as u64) < self.row_count,
            columns: projection.to_vec(),
            rows,
        })
    }

    fn read_cell_value(&self, row: u64, column_name: &str) -> Result<DataValue, DataError> {
        if row >= self.row_count {
            return Err(DataError::invalid_request(
                "The requested query cell is outside the result table.",
            ));
        }
        self.columns
            .iter()
            .find(|column| column.name == column_name)
            .ok_or_else(|| {
                DataError::invalid_request(format!("Unknown query result column: {column_name}"))
            })?;
        let source_row = {
            let connection = self.connection.lock().map_err(|_| registry_error())?;
            connection
                .query_row(
                    "SELECT q.__dv_row_id FROM query_result q WHERE q.rowid = ?",
                    params![row],
                    |record| record.get::<_, u64>(0),
                )
                .map_err(duckdb_error)?
        };
        self.provider
            .sparse_query_values(&[source_row], &[column_name.to_owned()])?
            .rows
            .into_iter()
            .next()
            .and_then(|mut values| values.pop())
            .ok_or_else(|| DataError::query_failed("The sparse query cell is unavailable."))
    }

    fn find_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        let columns = self
            .columns
            .iter()
            .map(|column| ColumnSchema {
                name: column.name.clone(),
                logical_type: format!("{:?}", column.kind),
                nullable: column.nullable,
                physical_type: String::from("queryResult"),
            })
            .collect::<Vec<_>>();
        crate::data::validate_boundary_request(&columns, Some(self.row_count), request)?;
        if request.mode == DataBoundaryMode::DataBoundary
            && matches!(
                request.direction,
                DataBoundaryDirection::Up | DataBoundaryDirection::Down
            )
        {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let column = self
                .columns
                .iter()
                .find(|column| column.name == request.column_id)
                .expect("validated query boundary column");
            if self
                .provider
                .uniform_occupancy(&request.column_id)
                .is_some()
                || (!column.nullable && column.kind != ValueKind::String)
            {
                let target_row = match request.direction {
                    DataBoundaryDirection::Down => self.row_count.saturating_sub(1),
                    DataBoundaryDirection::Up => 0,
                    _ => unreachable!(),
                };
                return Ok(BoundarySearchResult {
                    target_row,
                    target_column_id: request.column_id.clone(),
                    resolved_row_count: Some(self.row_count),
                });
            }
            if let Some(result) = self.find_vertical_boundary_cached(request, cancel)? {
                return Ok(result);
            }
        }
        resolve_boundary(
            &columns,
            Some(self.row_count),
            request,
            cancel,
            |offset, limit, projection| self.read_page_projected(offset, limit, projection),
        )
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
            &format!("s.{}", quote_identifier(&request.column_id)),
            &format!("s.{}", raw_name(self.columns[index].source_index)),
            &format!("s.{}", invalid_name(self.columns[index].source_index)),
        )
    }

    fn find_match(
        &self,
        request: FindQueryMatchRequest,
    ) -> Result<FindQueryMatchResponse, DataError> {
        let total_matches = self.find_match_count.unwrap_or(0);
        if total_matches == 0 {
            return Ok(FindQueryMatchResponse {
                document_id: request.document_id.clone(),
                session_id: request.session_id.clone(),
                query_id: request.query_id.clone(),
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
        "query_result q JOIN dv_source s USING (__dv_row_id)"
    } else {
        "dv_source s"
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

fn validate_result_index(connection: &Connection, row_count: u64) -> Result<(), DataError> {
    let schema = connection
        .prepare("SELECT name FROM pragma_table_info('query_result') ORDER BY cid")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<duckdb::Result<Vec<_>>>()
        })
        .map_err(duckdb_error)?;
    if schema != ["__dv_row_id"] {
        return Err(DataError::query_failed(
            "Query result index must contain only the source row identity column.",
        ));
    }
    let (minimum, maximum): (Option<u64>, Option<u64>) = connection
        .query_row(
            "SELECT min(q.rowid), max(q.rowid) FROM query_result q",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(duckdb_error)?;
    let positions_are_contiguous = if row_count == 0 {
        minimum.is_none() && maximum.is_none()
    } else {
        minimum == Some(0) && maximum == Some(row_count - 1)
    };
    if !positions_are_contiguous {
        return Err(DataError::query_failed(format!(
            "Query result physical position invariant failed (count={row_count}, min={minimum:?}, max={maximum:?})."
        )));
    }
    Ok(())
}

fn open_connection(
    source: &QuerySourceSpec,
    temp: &Path,
    temp_limit: u64,
) -> Result<Connection, DataError> {
    let config = query_connection_config()?;
    let connection = Connection::open_in_memory_with_flags(config).map_err(duckdb_error)?;
    connection
        .register_scalar_function::<ScalarLower>(SCALAR_LOWER_FUNCTION)
        .map_err(duckdb_error)?;
    let source_path = source.path.to_string_lossy().replace('\\', "/");
    let temp_path = temp.to_string_lossy().replace('\\', "/");
    let mut allowed_paths = vec![quote_literal(&source_path)];
    let mut allowed_directories = vec![quote_literal(&temp_path)];
    if let Some(artifact) = source.provider.prepared_artifact_path() {
        let artifact = artifact.to_string_lossy().replace('\\', "/");
        allowed_paths.push(quote_literal(&artifact));
        if let Some(parent) = Path::new(&artifact).parent() {
            allowed_directories.push(quote_literal(&parent.to_string_lossy()));
        }
    }
    connection
        .execute_batch(&format!(
            "SET allowed_paths = [{}]; SET allowed_directories = [{}]; SET temp_directory = {}; SET max_temp_directory_size = '{}B'; SET preserve_insertion_order = true; SET default_null_order = 'NULLS_LAST';",
            allowed_paths.join(", "),
            allowed_directories.join(", "),
            quote_literal(&temp_path),
            temp_limit
        ))
        .map_err(duckdb_error)?;
    Ok(connection)
}

fn query_connection_config() -> Result<Config, DataError> {
    let threads = std::thread::available_parallelism()
        .map(|value| value.get().min(4))
        .unwrap_or(1) as i64;
    Config::default()
        .enable_autoload_extension(false)
        .and_then(|config| config.with("allow_unsigned_extensions", "false"))
        .and_then(|config| config.max_memory("1GiB"))
        .and_then(|config| config.threads(threads))
        .map_err(duckdb_error)
}

fn csv_cache_identity(
    profile_identity: &str,
    fingerprint: &SourceFingerprint,
    columns: usize,
    source_columns: usize,
    rows: Option<u64>,
    physical_columns: Vec<crate::data::CsvPreparedPhysicalColumn>,
) -> CsvCacheIdentity {
    CsvCacheIdentity {
        canonical_path: fingerprint.canonical_path.to_string_lossy().into_owned(),
        file_identity: fingerprint.file_identity.clone(),
        source_bytes: fingerprint.bytes,
        modified_nanos: fingerprint.modified_nanos,
        created_nanos: fingerprint.created_nanos,
        profile_identity: profile_identity.to_owned(),
        rows,
        columns,
        source_columns,
        physical_columns,
    }
}

fn build_csv_cached_database(
    source: &QuerySourceSpec,
    database_path: &Path,
    parquet_path: &Path,
    temp_limit: u64,
) -> Result<(), DataError> {
    let connection = Connection::open_with_flags(database_path, query_connection_config()?)
        .map_err(duckdb_error)?;
    let source_path = source.path.to_string_lossy().replace('\\', "/");
    let parquet_path = parquet_path.to_string_lossy().replace('\\', "/");
    let temp_path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_string_lossy()
        .replace('\\', "/");
    let view = source
        .provider
        .prepared_view_sql(&quote_literal(&parquet_path));
    connection
        .execute_batch(&format!(
            "SET allowed_paths = [{}, {}]; SET allowed_directories = [{}]; SET temp_directory = {}; SET max_temp_directory_size = '{}B'; SET preserve_insertion_order = true; SET default_null_order = 'NULLS_LAST'; CREATE OR REPLACE VIEW dv_source AS {view}; CHECKPOINT;",
            quote_literal(&source_path),
            quote_literal(&parquet_path),
            quote_literal(&temp_path),
            quote_literal(&temp_path),
            temp_limit,
        ))
        .map_err(duckdb_error)
}

fn build_csv_prepared_artifact(
    source: &QuerySourceSpec,
    database_path: &Path,
    task: &CsvPreparation,
    temp: Arc<QueryTempManager>,
    csv_cache: Arc<CsvPersistentCache>,
    source_file: Option<&std::fs::File>,
) -> Result<(), DataError> {
    if !source_fingerprint_matches(&source.path, source_file, &task.source_fingerprint)? {
        return Err(DataError::query_failed(
            "The CSV source changed before preparation started.",
        ));
    }
    let connection = Connection::open_with_flags(database_path, query_connection_config()?)
        .map_err(duckdb_error)?;
    let interrupt = connection.interrupt_handle();
    *task.interrupt.lock().map_err(|_| registry_error())? = Some(interrupt.clone());
    let budget = QueryBudgetMonitor::start(temp, Some(csv_cache), interrupt);
    let source_path = source.path.to_string_lossy().replace('\\', "/");
    let temp_path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_string_lossy()
        .replace('\\', "/");
    connection
        .execute_batch(&format!(
            "SET allowed_paths = [{}]; SET allowed_directories = [{}]; SET temp_directory = {}; SET preserve_insertion_order = true; SET default_null_order = 'NULLS_LAST';",
            quote_literal(&source_path),
            quote_literal(&temp_path),
            quote_literal(&temp_path),
        ))
        .map_err(duckdb_error)?;
    let mut progress = |rows_scanned| {
        budget.check()?;
        if task.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if let Ok(mut status) = task.status.lock() {
            status.rows_scanned = rows_scanned;
            status.elapsed_ms = elapsed_ms(task.started);
            let metrics = source.provider.preparation_metrics();
            status.source_read_bytes = metrics.source_read_bytes;
            status.cache_output_bytes = metrics.cache_output_bytes;
            status.navigation_frontier_row = metrics.navigation_frontier_row;
        }
        Ok(())
    };
    source.provider.prepare(QueryPrepareContext {
        connection: &connection,
        source,
        source_file,
        artifact_directory: database_path.parent().unwrap_or_else(|| Path::new(".")),
        cancel: &task.cancel,
        progress: &mut progress,
    })?;
    if task.cancel.load(Ordering::Acquire) {
        return Err(DataError::task_cancelled());
    }
    if !source_fingerprint_matches(&source.path, source_file, &task.source_fingerprint)? {
        return Err(DataError::query_failed(
            "The CSV source changed while the prepared artifact was being built.",
        ));
    }
    connection
        .execute_batch("CHECKPOINT")
        .map_err(duckdb_error)?;
    let artifact_directory = database_path.parent().unwrap_or_else(|| Path::new("."));
    let manifest_partial = artifact_directory.join("manifest.json.partial");
    let manifest_path = artifact_directory.join("manifest.json");
    let metrics = source.provider.preparation_metrics();
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "sourcePath": task.source_fingerprint.canonical_path.to_string_lossy(),
        "sourceFileIdentity": task.source_fingerprint.file_identity.as_str(),
        "sourceBytes": task.source_fingerprint.bytes,
        "sourceModifiedNanos": task.source_fingerprint.modified_nanos,
        "sourceCreatedNanos": task.source_fingerprint.created_nanos,
        "identity": task.identity.as_str(),
        "rows": metrics.navigation_frontier_row,
        "columns": source.columns.len(),
        "sourceReadBytes": metrics.source_read_bytes,
        "stateBitmapBytes": metrics.state_bitmap_bytes,
        "peakDecodedBatchBytes": metrics.peak_decoded_batch_bytes,
        "artifacts": ["prepared.duckdb", "prepared.parquet", "states.bin", "offsets.idx"]
    }))
    .map_err(|error| DataError::query_failed(error.to_string()))?;
    let mut manifest_file = std::fs::File::create(&manifest_partial)
        .map_err(|error| DataError::io(&manifest_partial, error))?;
    manifest_file
        .write_all(&manifest)
        .and_then(|()| manifest_file.sync_all())
        .map_err(|error| DataError::io(&manifest_partial, error))?;
    drop(manifest_file);
    std::fs::rename(&manifest_partial, &manifest_path)
        .map_err(|error| DataError::io(&manifest_partial, error))?;
    if let Ok(mut status) = task.status.lock() {
        status.source_read_bytes = metrics.source_read_bytes;
        status.navigation_frontier_row = metrics.navigation_frontier_row;
        status.cache_output_bytes = metrics
            .cache_output_bytes
            .saturating_add(
                std::fs::metadata(database_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
            )
            .saturating_add(manifest.len() as u64);
    }
    budget.check()
}

fn source_fingerprint(path: &Path) -> Result<SourceFingerprint, DataError> {
    if !path.exists() {
        return Ok(SourceFingerprint {
            canonical_path: path.to_path_buf(),
            file_identity: String::from("missing"),
            bytes: 0,
            modified_nanos: None,
            created_nanos: None,
        });
    }
    let file = std::fs::File::open(path).map_err(|error| DataError::io(path, error))?;
    source_fingerprint_pinned(path, Some(&file))
}

fn source_fingerprint_pinned(
    path: &Path,
    file: Option<&std::fs::File>,
) -> Result<SourceFingerprint, DataError> {
    let Some(file) = file else {
        return source_fingerprint(path);
    };
    let canonical_path = std::fs::canonicalize(path).map_err(|error| DataError::io(path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| DataError::io(&canonical_path, error))?;
    let file_identity = os_file_identity(file, &metadata);
    let nanos = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
    };
    Ok(SourceFingerprint {
        canonical_path,
        file_identity,
        bytes: metadata.len(),
        modified_nanos: nanos(metadata.modified()),
        created_nanos: nanos(metadata.created()),
    })
}

/// A pinned scan is valid only while both identities remain equal: the handle
/// still describes the bytes that were scanned, and the current source path
/// still resolves to that same file. A rename A→B followed by another B→A
/// therefore fails even when all visible timestamps and lengths are restored.
fn source_fingerprint_matches(
    path: &Path,
    file: Option<&std::fs::File>,
    expected: &SourceFingerprint,
) -> Result<bool, DataError> {
    Ok(source_fingerprint_pinned(path, file)? == *expected
        && source_fingerprint(path)? == *expected)
}

#[cfg(windows)]
fn os_file_identity(file: &std::fs::File, metadata: &std::fs::Metadata) -> String {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ByHandleFileInformation {
        attributes: u32,
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

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = ByHandleFileInformation::default();
    // SAFETY: `file` owns a valid handle for the duration of the call and
    // `information` is a writable value with the Win32 structure layout.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) } != 0 {
        let index =
            (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
        return format!(
            "windows:{:08x}:{index:016x}",
            information.volume_serial_number
        );
    }
    format!("windows-fallback:created={}", metadata.creation_time())
}

#[cfg(unix)]
fn os_file_identity(_file: &std::fs::File, metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;

    format!("unix:{:016x}:{:016x}", metadata.dev(), metadata.ino())
}

#[cfg(not(any(windows, unix)))]
fn os_file_identity(_file: &std::fs::File, metadata: &std::fs::Metadata) -> String {
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    format!("fallback:created={created:?}:len={}", metadata.len())
}

fn read_prepared_csv_values(
    artifact: &CsvPreparedArtifact,
    schema: &[ColumnSchema],
    row_ids: &[u64],
    columns: &[String],
    max_rows: usize,
) -> Result<crate::data::QueryExactValues, DataError> {
    if row_ids.is_empty() {
        return Ok(crate::data::QueryExactValues {
            columns: columns.to_vec(),
            rows: Vec::new(),
        });
    }
    if row_ids.len() > max_rows || columns.len() > 64 {
        return Err(DataError::invalid_request(
            "Prepared CSV reads exceed their row or projection limit.",
        ));
    }
    let selected = columns
        .iter()
        .map(|name| {
            schema
                .iter()
                .position(|column| column.name == *name)
                .ok_or_else(|| {
                    DataError::invalid_request(format!("Unknown prepared CSV column: {name}"))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let expressions = selected
        .iter()
        .flat_map(|index| {
            let identifier = quote_identifier(&schema[*index].name);
            [identifier, raw_name(*index), invalid_name(*index)]
        })
        .collect::<Vec<_>>()
        .join(", ");
    let identities = row_ids
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT __dv_row_id, {expressions} FROM dv_source WHERE __dv_row_id IN ({identities})"
    );
    let connection = artifact.connection.lock().map_err(|_| registry_error())?;
    let mut statement = connection.prepare(&sql).map_err(duckdb_error)?;
    let decoded = statement
        .query_map([], |row| {
            let row_id = row.get::<_, u64>(0)?;
            let mut values = Vec::with_capacity(selected.len());
            for (position, schema_index) in selected.iter().enumerate() {
                let base = 1 + position * 3;
                let normalized = row.get::<_, Option<String>>(base)?;
                let raw = row.get::<_, Option<String>>(base + 1)?;
                let invalid = row.get::<_, bool>(base + 2)?;
                values.push(prepared_csv_value(
                    &schema[*schema_index],
                    normalized,
                    raw,
                    invalid,
                ));
            }
            Ok((row_id, values))
        })
        .map_err(duckdb_error)?
        .collect::<duckdb::Result<HashMap<_, _>>>()
        .map_err(duckdb_error)?;
    let rows = row_ids
        .iter()
        .map(|row_id| {
            decoded
                .get(row_id)
                .cloned()
                .ok_or_else(|| DataError::query_failed("A prepared CSV source row is unavailable."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(crate::data::QueryExactValues {
        columns: columns.to_vec(),
        rows,
    })
}

fn read_prepared_csv_range(
    artifact: &CsvPreparedArtifact,
    schema: &[ColumnSchema],
    offset: u64,
    limit: usize,
    columns: &[String],
) -> Result<crate::data::QueryExactValues, DataError> {
    #[cfg(test)]
    artifact.range_reads.fetch_add(1, Ordering::Relaxed);
    if limit == 0 {
        return Ok(crate::data::QueryExactValues {
            columns: columns.to_vec(),
            rows: Vec::new(),
        });
    }
    if limit > COPY_MAX_BATCH_CELLS || columns.len() > 64 {
        return Err(DataError::invalid_request(
            "Prepared CSV reads exceed their row or projection limit.",
        ));
    }
    let selected = columns
        .iter()
        .map(|name| {
            schema
                .iter()
                .position(|column| column.name == *name)
                .ok_or_else(|| {
                    DataError::invalid_request(format!("Unknown prepared CSV column: {name}"))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let expressions = selected
        .iter()
        .flat_map(|index| {
            let identifier = quote_identifier(&schema[*index].name);
            [identifier, raw_name(*index), invalid_name(*index)]
        })
        .collect::<Vec<_>>()
        .join(", ");
    let upper = offset.saturating_add(limit as u64);
    let sql = format!(
        "SELECT __dv_row_id, {expressions} FROM dv_source \
         WHERE __dv_row_id >= ? AND __dv_row_id < ? ORDER BY __dv_row_id"
    );
    let connection = artifact.connection.lock().map_err(|_| registry_error())?;
    let mut statement = connection.prepare(&sql).map_err(duckdb_error)?;
    let decoded = statement
        .query_map(params![offset, upper], |row| {
            let row_id = row.get::<_, u64>(0)?;
            let mut values = Vec::with_capacity(selected.len());
            for (position, schema_index) in selected.iter().enumerate() {
                let base = 1 + position * 3;
                let normalized = row.get::<_, Option<String>>(base)?;
                let raw = row.get::<_, Option<String>>(base + 1)?;
                let invalid = row.get::<_, bool>(base + 2)?;
                values.push(prepared_csv_value(
                    &schema[*schema_index],
                    normalized,
                    raw,
                    invalid,
                ));
            }
            Ok((row_id, values))
        })
        .map_err(duckdb_error)?
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(duckdb_error)?;
    for (index, (row_id, _)) in decoded.iter().enumerate() {
        if *row_id != offset.saturating_add(index as u64) {
            return Err(DataError::query_failed(
                "A prepared CSV contiguous source range has a missing row identity.",
            ));
        }
    }
    Ok(crate::data::QueryExactValues {
        columns: columns.to_vec(),
        rows: decoded.into_iter().map(|(_, row)| row).collect(),
    })
}

fn contiguous_source_rows(row_ids: &[u64]) -> bool {
    !row_ids.is_empty()
        && row_ids
            .iter()
            .enumerate()
            .all(|(index, row_id)| *row_id == row_ids[0].saturating_add(index as u64))
}

fn prepared_csv_page(
    source: &QuerySourceSpec,
    offset: u64,
    limit: usize,
    columns: &[String],
) -> Result<DataPage, DataError> {
    let total = source
        .total_rows
        .ok_or_else(|| DataError::query_failed("Prepared CSV row count is not available."))?;
    let available = total.saturating_sub(offset).min(limit as u64) as usize;
    let exact = source
        .provider
        .contiguous_query_values(offset, available, columns)?
        .ok_or_else(|| {
            DataError::query_failed("Prepared CSV provider does not support contiguous reads.")
        })?;
    Ok(DataPage {
        offset,
        limit,
        total_rows: Some(total),
        has_more: offset.saturating_add(exact.rows.len() as u64) < total,
        columns: exact.columns,
        rows: exact.rows,
    })
}

fn prepared_csv_value(
    column: &ColumnSchema,
    normalized: Option<String>,
    raw: Option<String>,
    invalid: bool,
) -> DataValue {
    let kind = value_kind(column);
    if invalid {
        return DataValue::invalid(
            kind,
            raw.unwrap_or_default(),
            "csvConversionFailed",
            format!("Value cannot be converted to {}.", column.logical_type),
        );
    }
    let Some(normalized) = normalized else {
        return DataValue::converted_null(raw.unwrap_or_default());
    };
    if normalized.is_empty() {
        return DataValue::empty(raw.unwrap_or_default());
    }
    let mut value = DataValue::converted(
        kind,
        normalized.clone(),
        raw.unwrap_or_else(|| normalized.clone()),
    )
    .with_source(normalized);
    if kind == ValueKind::Duration {
        if let Some(unit) = crate::data::duration_unit_from_logical_type(&column.logical_type) {
            value = value.with_temporal_metadata(crate::data::duration_unit_name(unit), None);
        }
    }
    value
}

fn prepare_source(
    connection: &Connection,
    source: &QuerySourceSpec,
    artifact_directory: &Path,
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
        source_file: None,
        artifact_directory,
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
    } else if logical.contains("duration") {
        ValueKind::Duration
    } else if logical.contains("binary") {
        ValueKind::Binary
    } else if logical.contains("map") {
        ValueKind::Map
    } else if logical.contains("list") || logical.contains("array") {
        ValueKind::List
    } else if logical.contains("struct") {
        ValueKind::Struct
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

fn estimated_page_bytes(rows: &[Vec<DataValue>]) -> usize {
    rows.iter().flatten().fold(0_usize, |total, value| {
        let strings = [
            value.display.as_deref(),
            value.source_display.as_deref(),
            value.raw_display.as_deref(),
            value.unit.as_deref(),
            value.timezone.as_deref(),
        ]
        .into_iter()
        .flatten()
        .fold(0_usize, |bytes, text| bytes.saturating_add(text.len()));
        total.saturating_add(strings).saturating_add(32)
    })
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

fn csv_preparation_limiter() -> Arc<QueryLimiter> {
    #[cfg(test)]
    {
        // Parallel unit tests create independent QueryService instances. Keep
        // the production cap within each instance without allowing unrelated
        // fixtures to queue behind one process-global test permit.
        Arc::new(QueryLimiter::default())
    }
    #[cfg(not(test))]
    {
        static LIMITER: OnceLock<Arc<QueryLimiter>> = OnceLock::new();
        Arc::clone(LIMITER.get_or_init(|| Arc::new(QueryLimiter::default())))
    }
}

fn acquire_csv_preparation_permit(
    limiter: &Arc<QueryLimiter>,
    cancel: &AtomicBool,
) -> Option<CsvPreparationPermit> {
    let mut active = limiter.active.lock().ok()?;
    loop {
        if cancel.load(Ordering::Acquire) {
            return None;
        }
        if *active < MAX_CONCURRENT_CSV_PREPARATIONS {
            *active += 1;
            return Some(CsvPreparationPermit(Arc::clone(limiter)));
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

fn preparation_status(task: &CsvPreparation) -> Result<CsvPreparationStatus, DataError> {
    let mut status = task.status.lock().map_err(|_| registry_error())?;
    if status.state == CsvPreparationState::Preparing {
        status.elapsed_ms = elapsed_ms(task.started);
    }
    Ok(status.clone())
}

fn csv_preparation_is_current(
    service: &QueryService,
    key: &(String, String),
    task: &Arc<CsvPreparation>,
) -> Result<bool, DataError> {
    Ok(service
        .csv_preparations
        .lock()
        .map_err(|_| registry_error())?
        .get(key)
        .is_some_and(|known| Arc::ptr_eq(known, task) && known.identity == task.identity))
}

fn commit_csv_preparation_ready(
    service: &QueryService,
    key: &(String, String),
    task: &Arc<CsvPreparation>,
    artifact: Arc<CsvPreparedArtifact>,
) -> Result<bool, DataError> {
    let preparations = service
        .csv_preparations
        .lock()
        .map_err(|_| registry_error())?;
    if task.cancel.load(Ordering::Acquire)
        || !preparations
            .get(key)
            .is_some_and(|known| Arc::ptr_eq(known, task) && known.identity == task.identity)
    {
        return Ok(false);
    }
    *task.artifact.lock().map_err(|_| registry_error())? = Some(artifact);
    set_csv_preparation_state(task, CsvPreparationState::Ready, None);
    Ok(true)
}

fn set_csv_preparation_state(
    task: &CsvPreparation,
    state: CsvPreparationState,
    error: Option<DataError>,
) {
    if let Ok(mut status) = task.status.lock() {
        status.state = state;
        status.elapsed_ms = elapsed_ms(task.started);
        status.error = error;
        if state == CsvPreparationState::Ready {
            let total = status.total_rows.unwrap_or(status.rows_scanned);
            status.total_rows = Some(total);
            status.rows_scanned = total;
        }
        task.terminal.notify_all();
    }
}

fn cancel_csv_preparation_task(task: &CsvPreparation) {
    task.cancel.store(true, Ordering::Release);
    if let Ok(interrupt) = task.interrupt.lock() {
        if let Some(interrupt) = interrupt.as_ref() {
            interrupt.interrupt();
        }
    }
}

fn wait_csv_preparation_worker(
    task: &CsvPreparation,
    timeout: std::time::Duration,
) -> Result<(), DataError> {
    let deadline = std::time::Instant::now() + timeout;
    let mut status = task.status.lock().map_err(|_| registry_error())?;
    while status.state == CsvPreparationState::Preparing {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(DataError::query_failed(
                "CSV preparation did not stop before the lifecycle deadline.",
            ));
        }
        let (next, wait) = task
            .terminal
            .wait_timeout(status, remaining)
            .map_err(|_| registry_error())?;
        status = next;
        if wait.timed_out() && status.state == CsvPreparationState::Preparing {
            return Err(DataError::query_failed(
                "CSV preparation did not stop before the lifecycle deadline.",
            ));
        }
    }
    drop(status);
    let worker = task.worker.lock().map_err(|_| registry_error())?.take();
    if let Some(worker) = worker {
        worker.join().map_err(|_| {
            DataError::query_failed("CSV preparation worker terminated unexpectedly.")
        })?;
    }
    Ok(())
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
        data::{DataSource, ParquetSource, QueryInputProvider, QueryPrepareContext, TabularSource},
        domain::{
            ColumnSchema, CsvDurationInputFormat, CsvProfileMode, CsvTargetType, DataValueState,
            DurationUnit, FilterOperator, HeaderMode, QueryFilter, QueryPlan, QueryScalarType,
            QuerySearch, QuerySearchMode, QuerySort, QuerySortDirection,
            DEFAULT_QUERY_TEMP_LIMIT_BYTES,
        },
    };

    #[cfg(windows)]
    fn set_windows_file_identity_times(path: &Path, creation: u64, modified: u64) {
        use std::os::windows::io::AsRawHandle;

        #[repr(C)]
        struct FileTime {
            low: u32,
            high: u32,
        }

        impl FileTime {
            fn from_raw(value: u64) -> Self {
                Self {
                    low: value as u32,
                    high: (value >> 32) as u32,
                }
            }
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetFileTime(
                file: *mut std::ffi::c_void,
                creation: *const FileTime,
                access: *const FileTime,
                modified: *const FileTime,
            ) -> i32;
        }

        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        let creation = FileTime::from_raw(creation);
        let modified = FileTime::from_raw(modified);
        // SAFETY: the file handle and both FILETIME pointers remain valid for
        // the duration of the synchronous Win32 call; null preserves access time.
        let changed = unsafe {
            SetFileTime(
                file.as_raw_handle().cast(),
                &creation,
                std::ptr::null(),
                &modified,
            )
        };
        assert_ne!(
            changed,
            0,
            "SetFileTime failed: {}",
            std::io::Error::last_os_error()
        );
    }

    #[allow(clippy::permissions_set_readonly_false)]
    fn make_test_file_writable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(path).unwrap();
            let mode = metadata.permissions().mode() | 0o200;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        {
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    fn manifest_partial_count(entry: &Path) -> usize {
        std::fs::read_dir(entry)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|candidate| {
                candidate
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("cache-manifest.json.partial-"))
            })
            .count()
    }

    #[derive(Debug)]
    struct SyntheticQueryProvider {
        called: Arc<AtomicBool>,
    }

    #[derive(Debug)]
    struct BulkSyntheticQueryProvider {
        copy_calls: Arc<AtomicU64>,
    }

    #[derive(Debug)]
    struct OccupancySyntheticQueryProvider {
        requested_rows: Arc<AtomicU64>,
        row_count: u64,
    }

    #[derive(Debug)]
    struct ControllablePreparationProvider {
        identity: String,
        fail: bool,
    }

    #[derive(Debug)]
    struct CountingPreparationProvider {
        calls: Arc<AtomicU64>,
    }

    #[derive(Debug)]
    struct AbortAwarePreparationProvider {
        aborted: Arc<AtomicBool>,
    }

    #[derive(Debug)]
    struct CommitBarrierPreparationProvider {
        identity: String,
        entered: Arc<std::sync::Barrier>,
        release: Arc<std::sync::Barrier>,
    }

    impl QueryInputProvider for AbortAwarePreparationProvider {
        fn reusable_source_identity(&self) -> Option<String> {
            Some(String::from("abort-aware-preparation"))
        }

        fn prepare(&self, _context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            panic!("allocation failure must prevent preparation from starting")
        }

        fn preparation_aborted(&self) {
            self.aborted.store(true, Ordering::Release);
        }
    }

    impl QueryInputProvider for CommitBarrierPreparationProvider {
        fn reusable_source_identity(&self) -> Option<String> {
            Some(self.identity.clone())
        }

        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source (__dv_row_id UBIGINT, value VARCHAR, __dv_raw_0 VARCHAR, __dv_invalid_0 BOOLEAN); INSERT INTO dv_source VALUES (0, 'value', 'value', false)",
                )
                .map_err(duckdb_error)?;
            (context.progress)(1)?;
            self.entered.wait();
            self.release.wait();
            Ok(())
        }
    }

    #[derive(Debug)]
    struct SameSizeMutatingPreparationProvider;

    impl QueryInputProvider for SameSizeMutatingPreparationProvider {
        fn reusable_source_identity(&self) -> Option<String> {
            Some(String::from("same-size-mutating-preparation"))
        }

        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source (__dv_row_id UBIGINT, value VARCHAR, __dv_raw_0 VARCHAR, __dv_invalid_0 BOOLEAN); INSERT INTO dv_source VALUES (0, 'old', 'old', false);",
                )
                .map_err(duckdb_error)?;
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(&context.source.path, b"bbbb")
                .map_err(|error| DataError::io(&context.source.path, error))?;
            (context.progress)(1)
        }
    }

    #[derive(Debug)]
    struct EpochBarrierQueryProvider {
        entered: Arc<std::sync::Barrier>,
        release: Arc<std::sync::Barrier>,
    }

    impl QueryInputProvider for EpochBarrierQueryProvider {
        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            self.entered.wait();
            self.release.wait();
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source (__dv_row_id UBIGINT, value VARCHAR, __dv_raw_0 VARCHAR, __dv_invalid_0 BOOLEAN); INSERT INTO dv_source VALUES (0, 'old', 'old', false);",
                )
                .map_err(duckdb_error)?;
            (context.progress)(1)
        }

        fn sparse_query_values(
            &self,
            row_ids: &[u64],
            columns: &[String],
        ) -> Result<crate::data::QueryExactValues, DataError> {
            Ok(crate::data::QueryExactValues {
                columns: columns.to_vec(),
                rows: row_ids
                    .iter()
                    .map(|_| vec![DataValue::displayed(ValueKind::String, "old")])
                    .collect(),
            })
        }
    }

    impl QueryInputProvider for CountingPreparationProvider {
        fn reusable_source_identity(&self) -> Option<String> {
            Some(String::from("counting-preparation"))
        }

        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source (__dv_row_id UBIGINT, value VARCHAR, __dv_raw_0 VARCHAR, __dv_invalid_0 BOOLEAN)",
                )
                .map_err(duckdb_error)?;
            for row in 0..20_u64 {
                if context.cancel.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
                (context.progress)(row)?;
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Ok(())
        }
    }

    impl QueryInputProvider for ControllablePreparationProvider {
        fn reusable_source_identity(&self) -> Option<String> {
            Some(self.identity.clone())
        }

        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            if self.fail {
                return Err(DataError::query_failed("synthetic preparation failure"));
            }
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source (__dv_row_id UBIGINT, value VARCHAR, __dv_raw_0 VARCHAR, __dv_invalid_0 BOOLEAN)",
                )
                .map_err(duckdb_error)?;
            for row in 0..200_u64 {
                if context.cancel.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
                (context.progress)(row)?;
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Ok(())
        }
    }

    impl QueryInputProvider for OccupancySyntheticQueryProvider {
        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            context
                .connection
                .execute_batch(&format!(
                    "CREATE TABLE dv_source AS SELECT i::UBIGINT AS __dv_row_id, CASE WHEN i % 1000 = 500 THEN '' ELSE 'x' END::VARCHAR AS value, 'x'::VARCHAR AS __dv_raw_0, false AS __dv_invalid_0 FROM range({}) AS rows(i)",
                    self.row_count
                ))
                .map_err(duckdb_error)?;
            (context.progress)(self.row_count)
        }

        fn sparse_query_values(
            &self,
            row_ids: &[u64],
            columns: &[String],
        ) -> Result<crate::data::QueryExactValues, DataError> {
            self.requested_rows
                .fetch_add(row_ids.len() as u64, Ordering::Relaxed);
            Ok(crate::data::QueryExactValues {
                columns: columns.to_vec(),
                rows: row_ids
                    .iter()
                    .map(|row| {
                        vec![if row % 1_000 == 500 {
                            DataValue::empty("")
                        } else {
                            DataValue::displayed(ValueKind::String, "x")
                        }]
                    })
                    .collect(),
            })
        }

        fn occupancy_states(&self, row_ids: &[u64], _column: &str) -> Result<Vec<bool>, DataError> {
            Ok(row_ids.iter().map(|row| row % 1_000 != 500).collect())
        }
    }

    #[derive(Debug)]
    struct LifecycleSyntheticQueryProvider;

    impl QueryInputProvider for LifecycleSyntheticQueryProvider {
        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source AS SELECT i::UBIGINT AS __dv_row_id, CAST(i AS VARCHAR) AS value, CAST(i AS VARCHAR) AS __dv_raw_0, false AS __dv_invalid_0 FROM range(400) AS rows(i);",
                )
                .map_err(duckdb_error)?;
            (context.progress)(400)
        }

        fn sparse_query_values(
            &self,
            row_ids: &[u64],
            columns: &[String],
        ) -> Result<crate::data::QueryExactValues, DataError> {
            if columns != ["value"] || row_ids.iter().any(|row| *row >= 400) {
                return Err(DataError::invalid_request(
                    "Synthetic lifecycle sparse query request is invalid.",
                ));
            }
            Ok(crate::data::QueryExactValues {
                columns: columns.to_vec(),
                rows: row_ids
                    .iter()
                    .map(|row_id| vec![DataValue::displayed(ValueKind::String, row_id.to_string())])
                    .collect(),
            })
        }
    }

    impl QueryInputProvider for BulkSyntheticQueryProvider {
        fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
            context
                .connection
                .execute_batch(
                    "CREATE TABLE dv_source AS SELECT i::UBIGINT AS __dv_row_id, CAST(i AS VARCHAR) AS value, CAST(i AS VARCHAR) AS __dv_raw_0, false AS __dv_invalid_0 FROM range(64000) AS rows(i);",
                )
                .map_err(duckdb_error)?;
            (context.progress)(64_000)
        }

        fn sparse_query_values(
            &self,
            _row_ids: &[u64],
            _columns: &[String],
        ) -> Result<crate::data::QueryExactValues, DataError> {
            Err(DataError::invalid_request(
                "The bulk provider must use the copy seam.",
            ))
        }

        fn copy_query_values(
            &self,
            row_ids: &[u64],
            columns: &[String],
        ) -> Result<crate::data::QueryExactValues, DataError> {
            if columns != ["value"] {
                return Err(DataError::invalid_request(
                    "Synthetic bulk copy projection is invalid.",
                ));
            }
            self.copy_calls.fetch_add(1, Ordering::AcqRel);
            Ok(crate::data::QueryExactValues {
                columns: columns.to_vec(),
                rows: row_ids
                    .iter()
                    .map(|row_id| vec![DataValue::displayed(ValueKind::String, row_id.to_string())])
                    .collect(),
            })
        }
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

        fn sparse_query_values(
            &self,
            row_ids: &[u64],
            columns: &[String],
        ) -> Result<crate::data::QueryExactValues, DataError> {
            if columns != ["value"] || row_ids.iter().any(|row| *row != 0) {
                return Err(DataError::invalid_request(
                    "Synthetic sparse query request is invalid.",
                ));
            }
            Ok(crate::data::QueryExactValues {
                columns: columns.to_vec(),
                rows: row_ids
                    .iter()
                    .map(|_| vec![DataValue::displayed(ValueKind::String, "provider-value")])
                    .collect(),
            })
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

    #[test]
    fn query_arrow_page_preserves_parquet_typed_values_and_timestamp_metadata() {
        let (_fixture_directory, path) = crate::data::phase2_type_fixture();
        let source = crate::data::DataSource::open(&path).expect("open typed Parquet fixture");
        let direct = source
            .read_page_projected(0, 3, None)
            .expect("direct typed page");
        let spec = source.query_source_spec().expect("typed query source");
        let plan = QueryPlan {
            filters: Vec::new(),
            search: None,
            sort: Vec::new(),
            projection: spec
                .columns
                .iter()
                .map(|column| column.name.clone())
                .collect(),
        };
        let request = request("task-typed", "query-typed", plan);
        let (_directory, service) = service();
        service
            .execute(request.clone(), spec)
            .expect("execute typed query");
        let status = wait_complete(&service, &request);
        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        let page = service
            .read_page(ReadQueryPageRequest {
                document_id: request.document_id.clone(),
                session_id: request.session_id.clone(),
                query_id: request.query_id.clone(),
                offset: 0,
                limit: 3,
                columns: direct.columns.clone(),
            })
            .expect("typed query page")
            .page;
        for (query_row, direct_row) in page.rows.iter().zip(&direct.rows) {
            for (query_value, direct_value) in query_row.iter().zip(direct_row) {
                assert_eq!(query_value.kind, direct_value.kind);
                assert_eq!(query_value.state, direct_value.state);
                assert_eq!(query_value.display, direct_value.display);
                assert_eq!(query_value.source_display, direct_value.source_display);
                assert_eq!(query_value.unit, direct_value.unit);
                assert_eq!(query_value.timezone, direct_value.timezone);
            }
        }
        assert_eq!(page.rows[0][4].unit.as_deref(), Some("ns"));
        assert_eq!(page.rows[0][4].timezone.as_deref(), Some("Asia/Seoul"));
        assert_eq!(page.rows[0][5].kind, ValueKind::Binary);
        assert_eq!(page.rows[0][6].kind, ValueKind::List);
        assert_eq!(page.rows[0][7].kind, ValueKind::Struct);
        assert_eq!(page.rows[0][8].kind, ValueKind::Map);
        let full_binary = service
            .read_cell_value(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                0,
                "binary",
            )
            .expect("full query binary value");
        assert_eq!(full_binary.kind, ValueKind::Binary);
        assert_eq!(full_binary.source_display, direct.rows[0][5].source_display);
    }

    #[test]
    fn newer_session_epoch_rejects_an_old_worker_even_if_its_cancel_flag_is_lost() {
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let columns = vec![ColumnSchema {
            name: String::from("value"),
            logical_type: String::from("String"),
            nullable: false,
            physical_type: String::from("VARCHAR"),
        }];
        let old_spec = QuerySourceSpec {
            path: std::path::PathBuf::from("epoch-old.synthetic"),
            columns: columns.clone(),
            total_rows: Some(1),
            provider: Arc::new(EpochBarrierQueryProvider {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
        };
        let plan = QueryPlan {
            filters: Vec::new(),
            search: None,
            sort: Vec::new(),
            projection: vec![String::from("value")],
        };
        let old = request("task-epoch-old", "query-epoch-old", plan.clone());
        let (_directory, service) = service();
        service.execute(old.clone(), old_spec).unwrap();
        entered.wait();
        let old_task = Arc::clone(
            service
                .tasks
                .lock()
                .unwrap()
                .get(&task_key(&old.document_id, &old.session_id, &old.task_id))
                .unwrap(),
        );

        let called = Arc::new(AtomicBool::new(false));
        let new_spec = QuerySourceSpec {
            path: std::path::PathBuf::from("epoch-new.synthetic"),
            columns,
            total_rows: Some(1),
            provider: Arc::new(SyntheticQueryProvider {
                called: Arc::clone(&called),
            }),
        };
        let new = request("task-epoch-new", "query-epoch-new", plan);
        service.execute(new.clone(), new_spec).unwrap();
        old_task.cancel.store(false, Ordering::Release);
        release.wait();

        assert_eq!(
            wait_complete(&service, &new).state,
            QueryTaskState::Complete
        );
        assert_eq!(
            wait_complete(&service, &old).state,
            QueryTaskState::Cancelled
        );
        assert!(called.load(Ordering::Acquire));
        assert!(service
            .read_page(ReadQueryPageRequest {
                document_id: old.document_id.clone(),
                session_id: old.session_id.clone(),
                query_id: old.query_id.clone(),
                offset: 0,
                limit: 1,
                columns: vec![String::from("value")],
            })
            .is_err());
        assert_eq!(
            service
                .read_page(ReadQueryPageRequest {
                    document_id: new.document_id,
                    session_id: new.session_id,
                    query_id: new.query_id,
                    offset: 0,
                    limit: 1,
                    columns: vec![String::from("value")],
                })
                .unwrap()
                .page
                .rows[0][0]
                .display
                .as_deref(),
            Some("provider-value")
        );
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

    fn wait_csv_preparation(
        service: &QueryService,
        document_id: &str,
        session_id: &str,
    ) -> CsvPreparationStatus {
        for _ in 0..500 {
            let status = service
                .csv_preparation_status(document_id, session_id)
                .unwrap()
                .expect("CSV preparation status");
            if status.state != CsvPreparationState::Preparing {
                return status;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("CSV preparation did not finish");
    }

    #[test]
    fn csv_prepared_session_reuses_exact_identity_for_page_boundary_and_cleanup() {
        let source_directory = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("prepared.csv");
        std::fs::write(&path, "value,numeric\nalpha,1\n\"\",\nbeta,2\n").unwrap();
        let mut source = DataSource::open(&path).unwrap();
        source.configure_csv(HeaderMode::Present).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_directory, service) = service();

        let initial = service
            .prepare_csv_session("document-prepared", "session-prepared", spec.clone())
            .unwrap();
        assert_eq!(initial.state, CsvPreparationState::Preparing);
        let ready = wait_csv_preparation(&service, "document-prepared", "session-prepared");
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
        assert_eq!(ready.rows_scanned, 3);
        assert_eq!(ready.total_rows, Some(3));
        assert!(ready.source_read_bytes > 0);
        assert!(ready.total_bytes >= ready.source_read_bytes);
        assert!(ready.cache_output_bytes > 0);
        assert_eq!(ready.navigation_frontier_row, 3);
        assert!(ready.error.is_none());
        let cache_entry = service.csv_cache.entry_paths().remove(0);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(cache_entry.join("cache-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["cacheSchemaVersion"], 3);
        assert_eq!(
            manifest["physicalLayout"],
            serde_json::json!([
                "__dv_row_id:INT64",
                "__dv_base_raw_0:BYTE_ARRAY",
                "__dv_base_raw_1:BYTE_ARRAY",
                "__dv_value_1:INT64",
                "__dv_state_word_0:INT64"
            ])
        );
        assert_eq!(
            manifest["physicalMapping"],
            serde_json::json!([
                {"field": "__dv_row_id", "physicalKind": "rowId", "sourceIndex": null, "stateWordIndex": null},
                {"field": "__dv_base_raw_0", "physicalKind": "baseRaw", "sourceIndex": 0, "stateWordIndex": null},
                {"field": "__dv_base_raw_1", "physicalKind": "baseRaw", "sourceIndex": 1, "stateWordIndex": null},
                {"field": "__dv_value_1", "physicalKind": "nativeValue", "sourceIndex": 1, "stateWordIndex": null},
                {"field": "__dv_state_word_0", "physicalKind": "stateWord", "sourceIndex": null, "stateWordIndex": 0}
            ])
        );
        assert!(manifest["schemaContract"]
            .as_array()
            .is_some_and(|contract| contract.iter().all(|field| {
                field.as_str().is_some_and(|field| {
                    field.contains("physical=")
                        && field.contains("logical=")
                        && field.contains("converted=")
                        && field.contains("maxDef=")
                        && field.contains("maxRep=")
                })
            })));
        assert!(manifest["schemaFingerprint"]
            .as_str()
            .is_some_and(|value| value.starts_with("fnv1a64:")));

        let columns = vec![String::from("value"), String::from("numeric")];
        let page = service
            .read_prepared_csv_page(
                "document-prepared",
                "session-prepared",
                spec.clone(),
                0,
                3,
                &columns,
            )
            .unwrap()
            .expect("ready prepared page");
        assert_eq!(page.rows.len(), 3);
        assert_eq!(page.rows[0][0].display.as_deref(), Some("alpha"));
        assert_eq!(page.rows[1][0].state, DataValueState::Empty);
        assert_eq!(page.rows[1][1].state, DataValueState::Empty);
        assert_eq!(page.rows[2][0].display.as_deref(), Some("beta"));

        let boundary_request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("value"),
            visible_column_ids: vec![String::from("value")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        let prepared_task = service
            .csv_preparations
            .lock()
            .unwrap()
            .get(&(
                String::from("document-prepared"),
                String::from("session-prepared"),
            ))
            .unwrap()
            .clone();
        let prepared_artifact = prepared_task
            .artifact
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        assert_eq!(
            prepared_artifact
                .provider
                .occupancy_states(&[2, 0, 1], "value")
                .unwrap(),
            [true, true, false]
        );
        prepared_artifact.range_reads.store(0, Ordering::Relaxed);
        let fresh_prepared_source = service
            .source_with_ready_csv_artifact("document-prepared", "session-prepared", spec.clone())
            .unwrap();
        assert!(fresh_prepared_source
            .provider
            .source_boundary(&boundary_request, &AtomicBool::new(false))
            .unwrap()
            .is_some());
        let boundary = service
            .find_prepared_csv_boundary(
                "document-prepared",
                "session-prepared",
                spec.clone(),
                &boundary_request,
                &AtomicBool::new(false),
            )
            .unwrap()
            .expect("ready prepared boundary");
        assert_eq!(boundary.target_row, 2);
        assert_eq!(prepared_artifact.range_reads.load(Ordering::Relaxed), 0);

        let prepared_query = ExecuteQueryRequest {
            document_id: String::from("document-prepared"),
            session_id: String::from("session-prepared"),
            query_id: String::from("query-prepared"),
            task_id: String::from("task-prepared"),
            plan: QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: vec![QuerySort {
                    column_id: String::from("numeric"),
                    direction: QuerySortDirection::Descending,
                    nulls_last: true,
                }],
                projection: vec![String::from("value"), String::from("numeric")],
            },
        };
        service
            .execute(prepared_query.clone(), spec.clone())
            .expect("execute prepared CSV query");
        assert_eq!(
            wait_complete(&service, &prepared_query).state,
            QueryTaskState::Complete
        );
        let query_page = service
            .read_page(ReadQueryPageRequest {
                document_id: prepared_query.document_id.clone(),
                session_id: prepared_query.session_id.clone(),
                query_id: prepared_query.query_id.clone(),
                offset: 0,
                limit: 3,
                columns: vec![String::from("value"), String::from("numeric")],
            })
            .expect("prepared CSV query page")
            .page;
        assert_eq!(query_page.rows[0][1].display.as_deref(), Some("2"));
        assert_eq!(query_page.rows[2][1].state, DataValueState::Empty);
        let numeric_boundary = service
            .find_boundary(
                &prepared_query.document_id,
                &prepared_query.session_id,
                &prepared_query.query_id,
                &BoundarySearchRequest {
                    row: 0,
                    column_id: String::from("numeric"),
                    visible_column_ids: vec![String::from("numeric")],
                    direction: DataBoundaryDirection::Down,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(numeric_boundary.target_row, 1);
        assert_eq!(prepared_artifact.range_reads.load(Ordering::Relaxed), 0);

        std::fs::write(&path, "value,numeric\nalpha,1\n\"\",\nbeta,2\nchanged,3\n").unwrap();
        assert!(service
            .read_prepared_csv_page(
                "document-prepared",
                "session-prepared",
                spec.clone(),
                0,
                1,
                &[String::from("value")],
            )
            .unwrap()
            .is_none());

        let other_path = source_directory.path().join("other.csv");
        std::fs::write(&other_path, "value\nother\n").unwrap();
        let mut other = DataSource::open(&other_path).unwrap();
        other.configure_csv(HeaderMode::Present).unwrap();
        assert!(service
            .read_prepared_csv_page(
                "document-prepared",
                "session-prepared",
                other.query_source_spec().unwrap(),
                0,
                1,
                &[String::from("value")],
            )
            .unwrap()
            .is_none());

        service
            .drop_session("document-prepared", "session-prepared")
            .unwrap();
        assert!(service
            .csv_preparation_status("document-prepared", "session-prepared")
            .unwrap()
            .is_none());
    }

    #[test]
    fn csv_persistent_cache_survives_restart_and_source_mutation_forces_a_miss() {
        let source_directory = tempfile::tempdir().unwrap();
        let local_data = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("reopen.csv");
        std::fs::write(&path, "value,numeric\nalpha,1\n\"\",\nbeta,2\n").unwrap();

        let csv_spec = || {
            let mut source = DataSource::open(&path).unwrap();
            source.configure_csv(HeaderMode::Present).unwrap();
            source.query_source_spec().unwrap()
        };
        let cached_entry;
        {
            let service =
                Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
            let initial = service
                .prepare_csv_session("cache-document-1", "cache-session-1", csv_spec())
                .unwrap();
            assert_eq!(initial.state, CsvPreparationState::Preparing);
            let ready = wait_csv_preparation(&service, "cache-document-1", "cache-session-1");
            assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
            let audit = service.csv_cache.audit();
            assert_eq!(audit.misses, 1);
            assert_eq!(audit.publishes, 1);
            assert!(audit.relocated_bytes > 0);
            assert_eq!(audit.copied_bytes, 0);
            cached_entry = service.csv_cache.entry_paths()[0].clone();
            let manifest_path = cached_entry.join("cache-manifest.json");
            let manifest_before = std::fs::read(&manifest_path).unwrap();
            // The original session deliberately keeps its shared entry lease
            // while two independent startups clean crash-orphaned atomic-write
            // temporaries. Neither the lease nor the valid manifest is touched.
            for round in 0..2 {
                for orphan in 0..3 {
                    std::fs::write(
                        cached_entry.join(format!(
                            "cache-manifest.json.partial-crash-{round}-{orphan}"
                        )),
                        b"incomplete manifest",
                    )
                    .unwrap();
                }
                assert_eq!(manifest_partial_count(&cached_entry), 3);
                let janitor =
                    Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
                assert_eq!(manifest_partial_count(&cached_entry), 0);
                assert_eq!(std::fs::read(&manifest_path).unwrap(), manifest_before);
                let hit = janitor
                    .prepare_csv_session(
                        &format!("cache-janitor-document-{round}"),
                        &format!("cache-janitor-session-{round}"),
                        csv_spec(),
                    )
                    .unwrap();
                assert_eq!(hit.state, CsvPreparationState::Ready);
                assert_eq!(hit.source_read_bytes, 0);
                assert_eq!(janitor.csv_cache.audit().hits, 1);
                janitor
                    .drop_session(
                        &format!("cache-janitor-document-{round}"),
                        &format!("cache-janitor-session-{round}"),
                    )
                    .unwrap();
                janitor.shutdown();
            }
            service
                .drop_session("cache-document-1", "cache-session-1")
                .unwrap();
            service.shutdown();
        }

        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let states = cached_entry.join("states.bin");
            let metadata = std::fs::metadata(&states).unwrap();
            make_test_file_writable(&states);
            set_windows_file_identity_times(
                &states,
                metadata.creation_time(),
                metadata.last_write_time().saturating_add(10_000_000),
            );
            let mut permissions = std::fs::metadata(&states).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&states, permissions).unwrap();
        }

        {
            let service =
                Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
            let reopened = service
                .prepare_csv_session("cache-document-2", "cache-session-2", csv_spec())
                .unwrap();
            assert_eq!(reopened.state, CsvPreparationState::Ready);
            assert_eq!(reopened.rows_scanned, 3);
            assert_eq!(reopened.source_read_bytes, 0);
            assert_eq!(service.csv_cache.audit().hits, 1);
            #[cfg(windows)]
            assert_eq!(service.csv_cache.audit().scrubs, 1);
            #[cfg(windows)]
            {
                let manifest: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(cached_entry.join("cache-manifest.json")).unwrap(),
                )
                .unwrap();
                let modified = std::fs::metadata(cached_entry.join("states.bin"))
                    .unwrap()
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
                    .to_string();
                assert_eq!(manifest["states"]["modifiedNanos"], modified);
            }
            let page = service
                .read_prepared_csv_page(
                    "cache-document-2",
                    "cache-session-2",
                    csv_spec(),
                    0,
                    3,
                    &[String::from("value")],
                )
                .unwrap()
                .expect("persistent cache page");
            assert_eq!(page.rows[1][0].state, DataValueState::Empty);
            service
                .drop_session("cache-document-2", "cache-session-2")
                .unwrap();

            std::thread::sleep(std::time::Duration::from_millis(2));
            std::fs::write(&path, "value,numeric\nalpha,1\n\"\",\nbeta,2\nchanged,3\n").unwrap();
            let changed = service
                .prepare_csv_session("cache-document-3", "cache-session-3", csv_spec())
                .unwrap();
            assert_eq!(changed.state, CsvPreparationState::Preparing);
            let rebuilt = wait_csv_preparation(&service, "cache-document-3", "cache-session-3");
            assert_eq!(
                rebuilt.state,
                CsvPreparationState::Ready,
                "{:?}",
                rebuilt.error
            );
            assert_eq!(rebuilt.rows_scanned, 4);
            assert!(rebuilt.source_read_bytes > 0);
            let audit = service.csv_cache.audit();
            assert_eq!(audit.hits, 1);
            assert_eq!(audit.misses, 1);
            assert_eq!(audit.publishes, 1);
        }
    }

    #[cfg(windows)]
    #[test]
    fn csv_persistent_cache_misses_when_same_path_size_and_times_have_a_new_file_identity() {
        use std::os::windows::fs::MetadataExt;

        let source_directory = tempfile::tempdir().unwrap();
        let local_data = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("file-identity.csv");
        let displaced = source_directory.path().join("file-identity-old.csv");
        let replacement = source_directory
            .path()
            .join("file-identity-replacement.csv");
        std::fs::write(&path, "value\nalpha\n").unwrap();
        let old_metadata = std::fs::metadata(&path).unwrap();
        let old_creation = old_metadata.creation_time();
        let old_modified = old_metadata.last_write_time();
        let pinned_scan_file = std::fs::File::open(&path).unwrap();
        let old_fingerprint = source_fingerprint(&path).unwrap();

        let csv_spec = || {
            let mut source = DataSource::open(&path).unwrap();
            source.configure_csv(HeaderMode::Present).unwrap();
            source.query_source_spec().unwrap()
        };
        {
            let service =
                Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
            service
                .prepare_csv_session("identity-document-1", "identity-session-1", csv_spec())
                .unwrap();
            let ready = wait_csv_preparation(&service, "identity-document-1", "identity-session-1");
            assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
            assert_eq!(service.csv_cache.audit().publishes, 1);
            let manifest: serde_json::Value = serde_json::from_slice(
                &std::fs::read(service.csv_cache.entry_paths()[0].join("cache-manifest.json"))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                manifest["fileIdentity"].as_str(),
                Some(old_fingerprint.file_identity.as_str())
            );
            service
                .drop_session("identity-document-1", "identity-session-1")
                .unwrap();
            service.shutdown();
        }

        std::fs::rename(&path, &displaced).unwrap();
        std::fs::write(&replacement, "value\nbravo\n").unwrap();
        set_windows_file_identity_times(&replacement, old_creation, old_modified);
        std::fs::rename(&replacement, &path).unwrap();
        let replacement_fingerprint = source_fingerprint(&path).unwrap();
        assert_eq!(
            replacement_fingerprint.canonical_path,
            old_fingerprint.canonical_path
        );
        assert_eq!(replacement_fingerprint.bytes, old_fingerprint.bytes);
        assert_eq!(
            replacement_fingerprint.modified_nanos,
            old_fingerprint.modified_nanos
        );
        assert_eq!(
            replacement_fingerprint.created_nanos,
            old_fingerprint.created_nanos
        );
        assert_ne!(
            replacement_fingerprint.file_identity,
            old_fingerprint.file_identity
        );
        assert_eq!(
            source_fingerprint_pinned(&path, Some(&pinned_scan_file))
                .unwrap()
                .file_identity,
            old_fingerprint.file_identity
        );
        assert!(
            !source_fingerprint_matches(&path, Some(&pinned_scan_file), &old_fingerprint).unwrap()
        );

        let service = Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let initial = service
            .prepare_csv_session("identity-document-2", "identity-session-2", csv_spec())
            .unwrap();
        assert_eq!(initial.state, CsvPreparationState::Preparing);
        assert_eq!(service.csv_cache.audit().misses, 1);
        let rebuilt = wait_csv_preparation(&service, "identity-document-2", "identity-session-2");
        assert_eq!(
            rebuilt.state,
            CsvPreparationState::Ready,
            "{:?}",
            rebuilt.error
        );
        assert!(rebuilt.source_read_bytes > 0);
        assert_eq!(service.csv_cache.audit().publishes, 1);
    }

    #[test]
    fn csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging() {
        let source_directory = tempfile::tempdir().unwrap();
        let local_data = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("corrupt.csv");
        std::fs::write(&path, "value\nalpha\nbeta\n").unwrap();
        let csv_spec = || {
            let mut source = DataSource::open(&path).unwrap();
            source.configure_csv(HeaderMode::Present).unwrap();
            source.query_source_spec().unwrap()
        };

        {
            let service =
                Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
            service
                .prepare_csv_session("corrupt-document-1", "corrupt-session-1", csv_spec())
                .unwrap();
            assert_eq!(
                wait_csv_preparation(&service, "corrupt-document-1", "corrupt-session-1").state,
                CsvPreparationState::Ready
            );
            let entries = service.csv_cache.entry_paths();
            assert_eq!(entries.len(), 1);
            service
                .drop_session("corrupt-document-1", "corrupt-session-1")
                .unwrap();
            let states_path = entries[0].join("states.bin");
            let mut states = std::fs::read(&states_path).unwrap();
            let last = states.len() - 1;
            states[last] ^= 0b11;
            #[cfg(windows)]
            let state_times = {
                use std::os::windows::fs::MetadataExt;
                let states_metadata = std::fs::metadata(&states_path).unwrap();
                (
                    states_metadata.creation_time(),
                    states_metadata.last_write_time(),
                )
            };
            make_test_file_writable(&states_path);
            std::fs::write(&states_path, states).unwrap();
            #[cfg(windows)]
            set_windows_file_identity_times(&states_path, state_times.0, state_times.1);
            let mut permissions = std::fs::metadata(&states_path).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&states_path, permissions).unwrap();
            // In-place tampering with restored identity/size/timestamps is the
            // documented fast-path limit. Expiring the bounded scrub interval
            // must still detect it before the next lease is returned.
            let manifest_path = entries[0].join("cache-manifest.json");
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
            manifest["lastFullScrubNanos"] = serde_json::Value::String(String::from("0"));
            std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            service.shutdown();
        }
        let partial = local_data
            .path()
            .join("csv-cache-v1")
            .join("abandoned.partial-test");
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::write(partial.join("junk"), b"junk").unwrap();

        let service = Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        assert!(!partial.exists());
        let initial = service
            .prepare_csv_session("corrupt-document-2", "corrupt-session-2", csv_spec())
            .unwrap();
        assert_eq!(initial.state, CsvPreparationState::Preparing);
        assert_eq!(service.csv_cache.audit().corruptions, 1);
        let rebuilt = wait_csv_preparation(&service, "corrupt-document-2", "corrupt-session-2");
        assert_eq!(
            rebuilt.state,
            CsvPreparationState::Ready,
            "{:?}",
            rebuilt.error
        );
        assert!(rebuilt.source_read_bytes > 0);
        assert_eq!(service.csv_cache.entry_paths().len(), 1);
        let entry = service.csv_cache.entry_paths()[0].clone();
        service
            .drop_session("corrupt-document-2", "corrupt-session-2")
            .unwrap();
        service.shutdown();
        drop(service);

        let parquet_path = entry.join("prepared.parquet");
        let mut parquet = std::fs::read(&parquet_path).unwrap();
        let middle = parquet.len() / 2;
        parquet[middle] ^= 0x5a;
        make_test_file_writable(&parquet_path);
        std::fs::write(&parquet_path, parquet).unwrap();
        let mut permissions = std::fs::metadata(&parquet_path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&parquet_path, permissions).unwrap();
        let service = Arc::new(QueryService::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let initial = service
            .prepare_csv_session("corrupt-document-3", "corrupt-session-3", csv_spec())
            .unwrap();
        assert_eq!(initial.state, CsvPreparationState::Preparing);
        assert_eq!(service.csv_cache.audit().corruptions, 1);
        assert_eq!(
            wait_csv_preparation(&service, "corrupt-document-3", "corrupt-session-3").state,
            CsvPreparationState::Ready
        );
    }

    #[test]
    fn csv_preparation_checks_temp_budget_after_arrow_flush_and_cleans_partial_artifacts() {
        let source_directory = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("budget.csv");
        let mut contents = String::from("value\n");
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        for row in 0..20_000_u64 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(row | 1);
            contents.push_str(&format!(
                "{row:08x}-{state:016x}-{:016x}-{:016x}\n",
                state.rotate_left(17),
                state.rotate_left(41)
            ));
        }
        std::fs::write(&path, contents).unwrap();
        let mut source = DataSource::open(&path).unwrap();
        source.configure_csv(HeaderMode::Present).unwrap();
        let spec = source.query_source_spec().unwrap();
        let metrics_provider = Arc::clone(&spec.provider);
        let (_directory, service) = service_with_limit(64 * 1024);

        service
            .prepare_csv_session("document-budget", "session-budget", spec)
            .unwrap();
        let failed = wait_csv_preparation(&service, "document-budget", "session-budget");
        assert_eq!(failed.state, CsvPreparationState::Failed);
        assert_eq!(
            failed.error.as_ref().map(|error| error.code),
            Some(DataErrorCode::QueryTempLimitExceeded)
        );
        assert_eq!(service.usage().unwrap().active_queries, 0);
        assert!(
            metrics_provider
                .preparation_metrics()
                .parquet_close_budget_checks
                >= 2,
            "the temp limit must be observed on the ArrowWriter close/footer flush path"
        );
        let artifact_root = service.temp.process_directory().join("document-budget");
        assert!(
            !artifact_root.exists() || std::fs::read_dir(&artifact_root).unwrap().next().is_none()
        );
    }

    #[test]
    fn csv_preparation_adapts_small_batches_from_16k_to_32k_and_65k_caps() {
        for high_cardinality in [false, true] {
            let source_directory = tempfile::tempdir().unwrap();
            let path = source_directory.path().join(if high_cardinality {
                "adaptive-high.csv"
            } else {
                "adaptive-low.csv"
            });
            let mut contents = String::from("value\n");
            let mut state = 0x243f_6a88_85a3_08d3_u64;
            for row in 0..70_000_u64 {
                if high_cardinality {
                    state = state
                        .wrapping_mul(2_862_933_555_777_941_757)
                        .wrapping_add(row | 1);
                    contents.push_str(&format!(
                        "{row:08x}-{state:016x}-{:016x}\n",
                        state.rotate_left(29)
                    ));
                } else {
                    contents.push_str("category-a\n");
                }
            }
            std::fs::write(&path, contents).unwrap();
            let mut source = DataSource::open(&path).unwrap();
            source.configure_csv(HeaderMode::Present).unwrap();
            let spec = source.query_source_spec().unwrap();
            let metrics_provider = Arc::clone(&spec.provider);
            let (_directory, service) = service();
            let suffix = if high_cardinality { "high" } else { "low" };
            service
                .prepare_csv_session(
                    &format!("adaptive-document-{suffix}"),
                    &format!("adaptive-session-{suffix}"),
                    spec,
                )
                .unwrap();
            let ready = wait_csv_preparation(
                &service,
                &format!("adaptive-document-{suffix}"),
                &format!("adaptive-session-{suffix}"),
            );
            assert_eq!(ready.state, CsvPreparationState::Ready, "{ready:?}");
            let metrics = metrics_provider.preparation_metrics();
            assert!(metrics.adaptive_batch_growths >= 2, "{metrics:?}");
            assert!(metrics.record_batches_accepted < 5, "{metrics:?}");
            assert!(metrics.max_accepted_batch_rows <= 65_536, "{metrics:?}");
            assert!(
                metrics.peak_decoded_batch_bytes <= 64 * 1024 * 1024,
                "{metrics:?}"
            );
        }
    }

    #[test]
    fn same_size_source_mutation_during_csv_preparation_discards_the_artifact() {
        let source_directory = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("mutating.csv");
        std::fs::write(&path, b"aaaa").unwrap();
        let spec = QuerySourceSpec {
            path: path.clone(),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: false,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(1),
            provider: Arc::new(SameSizeMutatingPreparationProvider),
        };
        let (_directory, service) = service();
        service
            .prepare_csv_session("document-mutating", "session-mutating", spec.clone())
            .unwrap();
        let status = wait_csv_preparation(&service, "document-mutating", "session-mutating");
        assert_eq!(status.state, CsvPreparationState::Failed);
        assert!(status.error.unwrap().message.contains("changed while"));
        assert!(service
            .read_prepared_csv_page(
                "document-mutating",
                "session-mutating",
                spec,
                0,
                1,
                &[String::from("value")],
            )
            .unwrap()
            .is_none());
        service
            .drop_session("document-mutating", "session-mutating")
            .unwrap();
        assert_eq!(service.usage().unwrap().active_queries, 0);
    }

    #[test]
    fn bnd_query_occupancy_uses_adaptive_one_column_blocks_and_reuses_bitmap() {
        let requested_rows = Arc::new(AtomicU64::new(0));
        let row_count = 70_000;
        let spec = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-occupancy.csv"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(row_count),
            provider: Arc::new(OccupancySyntheticQueryProvider {
                requested_rows: Arc::clone(&requested_rows),
                row_count,
            }),
        };
        let plan = QueryPlan {
            filters: Vec::new(),
            search: None,
            sort: Vec::new(),
            projection: vec![String::from("value")],
        };
        let request = request("task-occupancy", "query-occupancy", plan);
        let (_directory, service) = service();
        service.execute(request.clone(), spec).unwrap();
        assert_eq!(
            wait_complete(&service, &request).state,
            QueryTaskState::Complete
        );
        let navigation = BoundarySearchRequest {
            row: 0,
            column_id: String::from("value"),
            visible_column_ids: vec![String::from("value")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        let first = service
            .find_boundary(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                &navigation,
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(first.target_row, 499);
        let first_reads = requested_rows.load(Ordering::Relaxed);
        assert_eq!(
            first_reads, 0,
            "occupancy must not materialize source values"
        );

        let repeated = service
            .find_boundary(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                &navigation,
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(repeated, first);
        assert_eq!(requested_rows.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn bnd_global_lru_counts_active_leases_and_stays_within_process_caps() {
        let mut cache = QueryOccupancyCache::default();
        let key = |index: usize| QueryOccupancyKey {
            document_id: format!("document-{index}"),
            session_id: String::from("session"),
            query_id: String::from("query"),
            generation: 1,
            column_id: String::from("value"),
        };
        let active = cache.column(key(0), 5_850_000, None).unwrap();
        active.lock().unwrap().set(1, true);
        for index in 1..OCCUPANCY_MAX_COLUMNS {
            drop(cache.column(key(index), 5_850_000, None).unwrap());
        }
        assert!(cache.resident_bytes() <= OCCUPANCY_PROCESS_BYTES);
        assert_eq!(cache.columns.len(), OCCUPANCY_MAX_COLUMNS);
        let ninth = cache.column(key(8), 5_850_000, None).unwrap();
        assert!(cache.resident_bytes() <= OCCUPANCY_PROCESS_BYTES);
        assert_eq!(cache.columns.len(), OCCUPANCY_MAX_COLUMNS);
        assert!(active.lock().unwrap().get(1).unwrap());
        drop(ninth);
        drop(active);
    }

    #[test]
    fn invalidated_active_occupancy_lease_stays_counted_until_release_then_prunes() {
        let mut cache = QueryOccupancyCache::default();
        let lease = cache
            .column(
                QueryOccupancyKey {
                    document_id: String::from("document"),
                    session_id: String::from("session"),
                    query_id: String::from("query"),
                    generation: 1,
                    column_id: String::from("value"),
                },
                5_850_000,
                None,
            )
            .unwrap();
        let resident = cache.resident_bytes();
        cache.invalidate_session("document", "session");
        assert_eq!(cache.resident_bytes(), resident);
        assert!(cache.columns[0].invalidated);
        cache.prune_invalidated();
        assert_eq!(cache.resident_bytes(), resident);
        drop(lease);
        cache.prune_invalidated();
        assert_eq!(cache.resident_bytes(), 0);
        assert!(cache.columns.is_empty());
    }

    #[test]
    fn occupancy_generation_isolated_cache_is_cleared_on_query_replace_and_close() {
        let row_count = 70_000;
        let make_spec = || QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-occupancy-generation.csv"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(row_count),
            provider: Arc::new(OccupancySyntheticQueryProvider {
                requested_rows: Arc::new(AtomicU64::new(0)),
                row_count,
            }),
        };
        let plan = QueryPlan {
            filters: Vec::new(),
            search: None,
            sort: Vec::new(),
            projection: vec![String::from("value")],
        };
        let first = request("task-cache-first", "query-cache", plan.clone());
        let (_directory, service) = service();
        service.execute(first.clone(), make_spec()).unwrap();
        assert_eq!(
            wait_complete(&service, &first).state,
            QueryTaskState::Complete
        );
        let navigation = BoundarySearchRequest {
            row: 0,
            column_id: String::from("value"),
            visible_column_ids: vec![String::from("value")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        service
            .find_boundary(
                &first.document_id,
                &first.session_id,
                &first.query_id,
                &navigation,
                &AtomicBool::new(false),
            )
            .unwrap();
        let first_generation = service
            .occupancy
            .lock()
            .unwrap()
            .columns
            .front()
            .unwrap()
            .key
            .generation;
        assert!(service.occupancy.lock().unwrap().resident_bytes() > 0);

        let second = request("task-cache-second", "query-cache", plan);
        service.execute(second.clone(), make_spec()).unwrap();
        assert_eq!(service.occupancy.lock().unwrap().resident_bytes(), 0);
        assert_eq!(
            wait_complete(&service, &second).state,
            QueryTaskState::Complete
        );
        service
            .find_boundary(
                &second.document_id,
                &second.session_id,
                &second.query_id,
                &navigation,
                &AtomicBool::new(false),
            )
            .unwrap();
        let cache = service.occupancy.lock().unwrap();
        assert_eq!(cache.columns.len(), 1);
        assert!(cache.columns[0].key.generation > first_generation);
        assert!(cache.resident_bytes() > 0);
        drop(cache);

        service
            .drop_session(&second.document_id, &second.session_id)
            .unwrap();
        let cache = service.occupancy.lock().unwrap();
        assert_eq!(cache.columns.len(), 0);
        assert_eq!(cache.resident_bytes(), 0);
    }

    #[test]
    fn close_epoch_blocks_an_old_result_from_recreating_cache_after_invalidation() {
        let row_count = 70_000;
        let spec = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-occupancy-close-race.csv"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(row_count),
            provider: Arc::new(OccupancySyntheticQueryProvider {
                requested_rows: Arc::new(AtomicU64::new(0)),
                row_count,
            }),
        };
        let request = request(
            "task-cache-close-race",
            "query-cache-close-race",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: vec![String::from("value")],
            },
        );
        let (_directory, service) = service();
        service.execute(request.clone(), spec).unwrap();
        assert_eq!(
            wait_complete(&service, &request).state,
            QueryTaskState::Complete
        );
        let old_result = service
            .result(&request.document_id, &request.session_id, &request.query_id)
            .unwrap();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let worker_entered = Arc::clone(&entered);
        let worker_release = Arc::clone(&release);
        let worker = std::thread::spawn(move || {
            worker_entered.wait();
            worker_release.wait();
            old_result.find_boundary(
                &BoundarySearchRequest {
                    row: 0,
                    column_id: String::from("value"),
                    visible_column_ids: vec![String::from("value")],
                    direction: DataBoundaryDirection::Down,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &AtomicBool::new(false),
            )
        });
        entered.wait();
        service
            .drop_session(&request.document_id, &request.session_id)
            .unwrap();
        assert_eq!(service.occupancy.lock().unwrap().resident_bytes(), 0);
        release.wait();
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.message.contains("generation is stale"));
        let cache = service.occupancy.lock().unwrap();
        assert!(cache.columns.is_empty());
        assert_eq!(cache.resident_bytes(), 0);
    }

    fn controllable_preparation_spec(identity: &str, fail: bool) -> QuerySourceSpec {
        QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-preparation.csv"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(200),
            provider: Arc::new(ControllablePreparationProvider {
                identity: identity.to_owned(),
                fail,
            }),
        }
    }

    #[test]
    fn csv_preparation_progress_cancel_and_failure_states_have_stable_error_semantics() {
        let (_directory, service) = service();
        service
            .prepare_csv_session(
                "document-cancel",
                "session-cancel",
                controllable_preparation_spec("cancel", false),
            )
            .unwrap();
        // CSV preparation is globally serialized. Parallel tests may already
        // own the permit, so this deadline must include bounded queue time.
        let progress_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let status = service
                .csv_preparation_status("document-cancel", "session-cancel")
                .unwrap()
                .unwrap();
            if status.rows_scanned > 0 {
                break;
            }
            assert!(std::time::Instant::now() < progress_deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        service
            .cancel_csv_preparation("document-cancel", "session-cancel")
            .unwrap();
        let cancelled = wait_csv_preparation(&service, "document-cancel", "session-cancel");
        assert_eq!(cancelled.state, CsvPreparationState::Cancelled);
        assert!(cancelled.error.is_none());
        let boundary_request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("value"),
            visible_column_ids: vec![String::from("value")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        assert!(service
            .find_prepared_csv_boundary(
                "document-cancel",
                "session-cancel",
                controllable_preparation_spec("cancel", false),
                &boundary_request,
                &AtomicBool::new(false),
            )
            .unwrap()
            .is_none());
        assert_eq!(
            service
                .find_prepared_csv_boundary(
                    "document-cancel",
                    "session-cancel",
                    controllable_preparation_spec("cancel", false),
                    &boundary_request,
                    &AtomicBool::new(true),
                )
                .unwrap_err()
                .code,
            DataErrorCode::TaskCancelled
        );

        service
            .prepare_csv_session(
                "document-fail",
                "session-fail",
                controllable_preparation_spec("fail", true),
            )
            .unwrap();
        let failed = wait_csv_preparation(&service, "document-fail", "session-fail");
        assert_eq!(failed.state, CsvPreparationState::Failed);
        assert_eq!(
            failed.error.as_ref().map(|error| error.code),
            Some(DataErrorCode::QueryFailed)
        );
        assert!(service
            .find_prepared_csv_boundary(
                "document-fail",
                "session-fail",
                controllable_preparation_spec("fail", true),
                &boundary_request,
                &AtomicBool::new(false),
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn csv_preparation_same_session_reservation_is_atomic() {
        let (_directory, service) = service();
        let calls = Arc::new(AtomicU64::new(0));
        let spec = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-counting.csv"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(20),
            provider: Arc::new(CountingPreparationProvider {
                calls: Arc::clone(&calls),
            }),
        };
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers = (0..8)
            .map(|_| {
                let service = Arc::clone(&service);
                let spec = spec.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    service
                        .prepare_csv_session("atomic-document", "atomic-session", spec)
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            assert_eq!(worker.join().unwrap().state, CsvPreparationState::Preparing);
        }
        let ready = wait_csv_preparation(&service, "atomic-document", "atomic-session");
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
        assert_eq!(calls.load(Ordering::Acquire), 1);
        service
            .drop_session("atomic-document", "atomic-session")
            .unwrap();
    }

    #[test]
    fn replaced_csv_preparation_cannot_commit_ready_when_its_cancel_flag_is_lost() {
        let (_directory, service) = service();
        let columns = vec![ColumnSchema {
            name: String::from("value"),
            logical_type: String::from("String"),
            nullable: true,
            physical_type: String::from("VARCHAR"),
        }];
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let old_spec = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-stale-commit.csv"),
            columns: columns.clone(),
            total_rows: Some(1),
            provider: Arc::new(CommitBarrierPreparationProvider {
                identity: String::from("old-generation"),
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
        };
        service
            .prepare_csv_session("stale-document", "stale-session", old_spec)
            .unwrap();
        entered.wait();
        let old_task = service
            .csv_preparations
            .lock()
            .unwrap()
            .get(&(
                String::from("stale-document"),
                String::from("stale-session"),
            ))
            .unwrap()
            .clone();
        let new_spec = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-stale-commit.csv"),
            columns,
            total_rows: Some(20),
            provider: Arc::new(CountingPreparationProvider {
                calls: Arc::new(AtomicU64::new(0)),
            }),
        };
        service
            .prepare_csv_session("stale-document", "stale-session", new_spec)
            .unwrap();
        // Simulate a lost cancellation signal: map ownership must still block
        // the obsolete worker at its final commit boundary.
        old_task.cancel.store(false, Ordering::Release);
        release.wait();
        wait_csv_preparation_worker(&old_task, std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(
            preparation_status(&old_task).unwrap().state,
            CsvPreparationState::Cancelled
        );
        let current = wait_csv_preparation(&service, "stale-document", "stale-session");
        assert_eq!(
            current.state,
            CsvPreparationState::Ready,
            "{:?}",
            current.error
        );
    }

    #[test]
    fn csv_preparation_allocation_failure_notifies_provider_abort_hook() {
        let (_directory, service) = service_with_limit(1);
        let aborted = Arc::new(AtomicBool::new(false));
        let spec = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-abort.csv"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: None,
            provider: Arc::new(AbortAwarePreparationProvider {
                aborted: Arc::clone(&aborted),
            }),
        };
        let error = service
            .prepare_csv_session("abort-document", "abort-session", spec)
            .unwrap_err();
        assert_eq!(error.code, DataErrorCode::QueryTempLimitExceeded);
        assert!(aborted.load(Ordering::Acquire));
    }

    #[cfg(windows)]
    fn phase12_process_snapshot() -> Result<(u64, u32), String> {
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
        if !memory_ok || !handles_ok {
            return Err(String::from(
                "Windows process lifecycle metrics could not be measured.",
            ));
        }
        Ok((counters.working_set_size as u64, handles))
    }

    #[cfg(not(windows))]
    fn phase12_process_snapshot() -> Result<(u64, u32), String> {
        Err(String::from(
            "The Phase 12 lifecycle harness currently requires Windows.",
        ))
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
                columns: vec![String::from("row_id"), String::from("category")],
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
                        columns: vec![String::from("amount")],
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
    fn query_data_boundary_uses_materialized_positions_without_paging_the_result() {
        let source_directory = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("boundary.csv");
        std::fs::write(&path, "value\nA\nB\nNULL\nC\nD\nNULL\nE\n").unwrap();
        let source = DataSource::open(path).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_temp_directory, service) = service();
        let execute = request(
            "boundary-task",
            "boundary-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: vec![String::from("value")],
            },
        );
        service.execute(execute.clone(), spec).unwrap();
        assert_eq!(
            wait_complete(&service, &execute).state,
            QueryTaskState::Complete
        );

        let find = |row, direction| {
            service
                .find_boundary(
                    &execute.document_id,
                    &execute.session_id,
                    &execute.query_id,
                    &BoundarySearchRequest {
                        row,
                        column_id: String::from("value"),
                        visible_column_ids: vec![String::from("value")],
                        direction,
                        mode: DataBoundaryMode::DataBoundary,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap()
                .target_row
        };

        assert_eq!(find(0, DataBoundaryDirection::Down), 1);
        assert_eq!(find(1, DataBoundaryDirection::Down), 3);
        assert_eq!(find(3, DataBoundaryDirection::Down), 4);
        assert_eq!(find(4, DataBoundaryDirection::Down), 6);
        assert_eq!(find(6, DataBoundaryDirection::Up), 4);
        assert_eq!(find(4, DataBoundaryDirection::Up), 3);
    }

    #[test]
    fn query_binary_boundary_treats_zero_length_values_as_occupied() {
        let source_directory = tempfile::tempdir().unwrap();
        let path = source_directory.path().join("binary-boundary.parquet");
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(&format!(
                "COPY (SELECT value FROM (VALUES (''::BLOB), ('A'::BLOB), (''::BLOB)) AS values(value)) TO {} (FORMAT PARQUET)",
                quote_literal(&path.to_string_lossy())
            ))
            .unwrap();
        let source = DataSource::open(path).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_temp_directory, service) = service();
        let execute = request(
            "binary-boundary-task",
            "binary-boundary-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: vec![String::from("value")],
            },
        );
        service.execute(execute.clone(), spec).unwrap();
        assert_eq!(
            wait_complete(&service, &execute).state,
            QueryTaskState::Complete
        );
        let result = service
            .find_boundary(
                &execute.document_id,
                &execute.session_id,
                &execute.query_id,
                &BoundarySearchRequest {
                    row: 0,
                    column_id: String::from("value"),
                    visible_column_ids: vec![String::from("value")],
                    direction: DataBoundaryDirection::Down,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(result.target_row, 2);
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
                columns: vec![String::from("column_000")],
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][0].display.as_deref(), Some("0"));
        assert_eq!(page.rows[1][0].display.as_deref(), Some("10000019"));
        assert_eq!(page.rows[2][0].display.as_deref(), Some("20000038"));
    }

    #[test]
    #[ignore = "requires generated Phase 12 low/high 5.85M Parquet fixtures"]
    fn phase12_low_high_oracle_pages_match_sorted_source_identities() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let reference: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("artifacts/phase-12/reference-pages.json")).unwrap(),
        )
        .unwrap();
        for (cardinality, fixture_key) in [
            ("low", "query-low-5850000-rows-15-columns"),
            ("high", "query-high-5850000-rows-15-columns"),
        ] {
            let path = root
                .join(".tmp/phase12-query")
                .join(format!("query-{cardinality}-5850000-15c.parquet"));
            assert!(path.is_file(), "missing fixture: {}", path.display());
            let source = DataSource::open(path).unwrap();
            let spec = source.query_source_spec().unwrap();
            let (_directory, service) = service_with_limit(DEFAULT_QUERY_TEMP_LIMIT_BYTES);
            let execute = request(
                &format!("phase12-{cardinality}-task"),
                &format!("phase12-{cardinality}-query"),
                QueryPlan {
                    filters: Vec::new(),
                    search: None,
                    sort: vec![QuerySort {
                        column_id: String::from("group_id"),
                        direction: QuerySortDirection::Ascending,
                        nulls_last: true,
                    }],
                    projection: vec![String::from("row_id")],
                },
            );
            service.execute(execute.clone(), spec).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
            let status = loop {
                let status = service
                    .status(
                        &execute.document_id,
                        &execute.session_id,
                        &execute.query_id,
                        &execute.task_id,
                    )
                    .unwrap();
                if matches!(
                    status.state,
                    QueryTaskState::Complete | QueryTaskState::Failed
                ) {
                    break status;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "Phase 12 sort timed out"
                );
                std::thread::sleep(std::time::Duration::from_millis(50));
            };
            assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
            assert_eq!(status.progress.result_rows, 5_850_000);

            let pages = reference["fixtures"][fixture_key]["pages"]
                .as_array()
                .unwrap();
            for oracle in pages.iter().filter(|page| {
                matches!(
                    page["label"].as_str(),
                    Some("first" | "reported-986803" | "last")
                )
            }) {
                let offset = oracle["offset"].as_u64().unwrap();
                let expected = oracle["sourceRowIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_u64().unwrap())
                    .collect::<Vec<_>>();
                let page = service
                    .read_page(ReadQueryPageRequest {
                        document_id: execute.document_id.clone(),
                        session_id: execute.session_id.clone(),
                        query_id: execute.query_id.clone(),
                        offset: offset as i64,
                        limit: 200,
                        columns: vec![String::from("row_id")],
                    })
                    .unwrap()
                    .page;
                let actual = page
                    .rows
                    .iter()
                    .map(|row| {
                        row[0]
                            .source_display
                            .as_deref()
                            .unwrap()
                            .parse::<u64>()
                            .unwrap()
                    })
                    .collect::<Vec<_>>();
                assert_eq!(actual, expected, "{cardinality} page at offset {offset}");
            }
        }
    }

    #[test]
    #[ignore = "requires the generated Phase 11 5.85M x 15 Parquet fixture"]
    fn phase11_5850000_row_parquet_sort_filter_and_random_pages_are_complete() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp/phase11-large/query-low-5850000-15c.parquet");
        assert!(path.is_file(), "generate the Phase 11 large fixture first");
        let source = DataSource::open(path).unwrap();
        let boundary_started = std::time::Instant::now();
        let boundary = source
            .find_boundary(
                &BoundarySearchRequest {
                    row: 0,
                    column_id: String::from("row_id"),
                    visible_column_ids: vec![String::from("row_id")],
                    direction: DataBoundaryDirection::Down,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        let boundary_elapsed = boundary_started.elapsed();
        assert_eq!(boundary.target_row, 5_849_999);
        assert!(
            boundary_elapsed < std::time::Duration::from_secs(10),
            "5.85M Parquet boundary took {boundary_elapsed:?}"
        );
        println!("phase11 boundary elapsed: {boundary_elapsed:?}");
        let string_boundary_started = std::time::Instant::now();
        let string_boundary = source
            .find_boundary(
                &BoundarySearchRequest {
                    row: 1,
                    column_id: String::from("label"),
                    visible_column_ids: vec![String::from("label")],
                    direction: DataBoundaryDirection::Down,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        let string_boundary_elapsed = string_boundary_started.elapsed();
        assert_eq!(string_boundary.target_row, 88);
        assert!(string_boundary_elapsed < std::time::Duration::from_secs(2));
        println!("phase11 string boundary elapsed: {string_boundary_elapsed:?}");
        let spec = source.query_source_spec().unwrap();
        assert_eq!(spec.total_rows, Some(5_850_000));
        assert_eq!(spec.columns.len(), 15);
        let (_directory, service) = service_with_limit(2 * 1024 * 1024 * 1024);

        let execute = request(
            "phase11-full-sort-task",
            "phase11-full-sort-query",
            QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: vec![QuerySort {
                    column_id: String::from("row_id"),
                    direction: QuerySortDirection::Descending,
                    nulls_last: true,
                }],
                projection: vec![String::from("row_id"), String::from("label")],
            },
        );
        let sort_started = std::time::Instant::now();
        service.execute(execute.clone(), spec.clone()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let status = loop {
            let status = service
                .status(
                    &execute.document_id,
                    &execute.session_id,
                    &execute.query_id,
                    &execute.task_id,
                )
                .unwrap();
            if matches!(
                status.state,
                QueryTaskState::Complete | QueryTaskState::Cancelled | QueryTaskState::Failed
            ) {
                break status;
            }
            assert!(std::time::Instant::now() < deadline, "5.85M sort timed out");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        assert_eq!(status.progress.result_rows, 5_850_000);
        let sort_elapsed = sort_started.elapsed();
        println!("phase11 full sort elapsed: {sort_elapsed:?}");

        for (offset, expected) in [(0, "5849999"), (986_803, "4863196"), (5_849_999, "0")] {
            let page = service
                .read_page(ReadQueryPageRequest {
                    document_id: execute.document_id.clone(),
                    session_id: execute.session_id.clone(),
                    query_id: execute.query_id.clone(),
                    offset,
                    limit: 1,
                    columns: vec![String::from("row_id"), String::from("label")],
                })
                .unwrap()
                .page;
            assert_eq!(page.rows.len(), 1, "offset {offset}");
            assert_eq!(page.rows[0][0].display.as_deref(), Some(expected));
        }
        let usage = service.usage().unwrap();
        println!("phase11 query temp bytes: {}", usage.process_bytes);
        assert!(usage.process_bytes < 1024 * 1024 * 1024);
        assert_eq!(usage.estimated_temp_bytes, None);

        let filtered = request(
            "phase11-empty-filter-task",
            "phase11-empty-filter-query",
            QueryPlan {
                filters: vec![QueryFilter {
                    id: String::from("empty-label"),
                    column_id: String::from("label"),
                    scalar_type: QueryScalarType::Text,
                    operator: FilterOperator::Equals,
                    values: vec![String::new()],
                }],
                search: None,
                sort: vec![QuerySort {
                    column_id: String::from("row_id"),
                    direction: QuerySortDirection::Descending,
                    nulls_last: true,
                }],
                projection: vec![String::from("row_id"), String::from("label")],
            },
        );
        service.execute(filtered.clone(), spec).unwrap();
        let status = wait_complete(&service, &filtered);
        assert_eq!(status.state, QueryTaskState::Complete, "{:?}", status.error);
        assert_eq!(status.progress.result_rows, 5_850_000_u64.div_ceil(89));
        let page = service
            .read_page(ReadQueryPageRequest {
                document_id: filtered.document_id,
                session_id: filtered.session_id,
                query_id: filtered.query_id,
                offset: 0,
                limit: 1,
                columns: vec![String::from("row_id"), String::from("label")],
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][1].state, DataValueState::Empty);
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
                    columns: vec![String::from("value")],
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
                columns: vec![String::from("value")],
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
                columns: vec![String::from("value")],
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
                document_id: request.document_id.clone(),
                session_id: request.session_id.clone(),
                query_id: request.query_id.clone(),
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
    #[ignore = "Phase 12 release lifecycle soak evidence"]
    fn phase12_lifecycle_soak_100_cycles() {
        let (_directory, service) = service();
        let source = QuerySourceSpec {
            path: std::path::PathBuf::from("synthetic-lifecycle"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: false,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(400),
            provider: Arc::new(LifecycleSyntheticQueryProvider),
        };
        let plan = QueryPlan {
            filters: Vec::new(),
            search: None,
            sort: Vec::new(),
            projection: vec![String::from("value")],
        };

        // Warm DuckDB and the allocator before taking the lifecycle baseline.
        let warmup = request(
            "lifecycle-warmup-task",
            "lifecycle-warmup-query",
            plan.clone(),
        );
        service.execute(warmup.clone(), source.clone()).unwrap();
        assert_eq!(
            wait_complete(&service, &warmup).state,
            QueryTaskState::Complete
        );
        service
            .drop_session(&warmup.document_id, &warmup.session_id)
            .unwrap();

        let (baseline_rss, baseline_handles) = phase12_process_snapshot().unwrap();
        let baseline_temp_bytes = service.usage().unwrap().process_bytes;
        let mut checkpoints = Vec::new();
        for cycle in 0..100_u64 {
            for replacement in 0..2_u64 {
                let request = request(
                    &format!("lifecycle-task-{cycle}-{replacement}"),
                    &format!("lifecycle-query-{cycle}-{replacement}"),
                    plan.clone(),
                );
                service.execute(request.clone(), source.clone()).unwrap();
                assert_eq!(
                    wait_complete(&service, &request).state,
                    QueryTaskState::Complete
                );
                let page = service
                    .read_page(ReadQueryPageRequest {
                        document_id: request.document_id.clone(),
                        session_id: request.session_id.clone(),
                        query_id: request.query_id.clone(),
                        offset: (replacement * 200) as i64,
                        limit: 200,
                        columns: vec![String::from("value")],
                    })
                    .unwrap();
                assert_eq!(page.page.rows.len(), 200);
            }
            service
                .drop_session("document-test", "session-test")
                .unwrap();
            assert!(service.tasks.lock().unwrap().is_empty());
            assert!(service.statuses.lock().unwrap().is_empty());
            assert!(service.results.lock().unwrap().is_empty());
            let usage = service.usage().unwrap();
            assert_eq!(usage.active_queries, 0);
            assert_eq!(usage.process_bytes, baseline_temp_bytes);
            if (cycle + 1) % 10 == 0 {
                let (rss, handles) = phase12_process_snapshot().unwrap();
                checkpoints.push(serde_json::json!({
                    "cycle": cycle + 1,
                    "workingSetBytes": rss,
                    "handleCount": handles,
                }));
            }
        }

        let (final_rss, final_handles) = phase12_process_snapshot().unwrap();
        let midpoint_rss = checkpoints[4]["workingSetBytes"].as_u64().unwrap();
        let tail_growth = final_rss.saturating_sub(midpoint_rss);
        let handle_delta = i64::from(final_handles) - i64::from(baseline_handles);
        assert!(
            tail_growth <= 32 * 1024 * 1024,
            "working set continued to grow after cycle 50: {tail_growth} bytes"
        );
        assert!(
            handle_delta <= 8,
            "process handles did not return near baseline: delta={handle_delta}"
        );

        let evidence = serde_json::json!({
            "schemaVersion": 1,
            "status": "PASS",
            "cycles": 100,
            "queriesExecuted": 201,
            "pagesRead": 200,
            "baseline": {
                "workingSetBytes": baseline_rss,
                "handleCount": baseline_handles,
                "processTempBytes": baseline_temp_bytes,
            },
            "checkpoints": checkpoints,
            "final": {
                "workingSetBytes": final_rss,
                "handleCount": final_handles,
                "handleDelta": handle_delta,
                "workingSetGrowthAfterCycle50Bytes": tail_growth,
                "activeQueries": service.usage().unwrap().active_queries,
                "processTempBytes": service.usage().unwrap().process_bytes,
                "processTempGrowthBytes": service.usage().unwrap().process_bytes.saturating_sub(baseline_temp_bytes),
                "activeTasks": service.tasks.lock().unwrap().len(),
                "retainedStatuses": service.statuses.lock().unwrap().len(),
                "retainedResults": service.results.lock().unwrap().len(),
            },
            "assertions": {
                "activeQueriesZero": true,
                "activeTasksZero": true,
                "queryTempGrowthZero": true,
                "handlesNearWarmBaseline": true,
                "rssGrowthNotSustained": true,
            },
        });
        if let Some(output) = std::env::var_os("PHASE12_LIFECYCLE_OUTPUT") {
            std::fs::write(
                output,
                serde_json::to_vec_pretty(&evidence).expect("serialize lifecycle evidence"),
            )
            .expect("write lifecycle evidence");
        }
        println!("PHASE12_LIFECYCLE={evidence}");
    }

    #[test]
    fn qry_csv_invalid_null_and_distinct_are_separate() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = source_dir.path().join("invalid.csv");
        std::fs::write(&path, "amount\n1\nbad\nNULL\n\n").unwrap();
        let mut source = DataSource::open(&path).unwrap();
        source.configure_csv(HeaderMode::Present).unwrap();
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
                document_id: request.document_id.clone(),
                session_id: request.session_id.clone(),
                query_id: request.query_id.clone(),
                offset: 0,
                limit: 10,
                columns: vec![String::from("amount")],
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][0].state, DataValueState::Invalid);
    }

    #[test]
    fn csv_compact_utf8_fallback_preserves_mixed_raw_normalized_and_states() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = source_dir.path().join("compact-fallback.csv");
        std::fs::write(
            &path,
            "text,decimal,date,ts,duration,skipped\n  alpha  ,1.230,2025-01-02,2025-01-02T03:04:05.123456789Z,1500,keep-a\nNULL,NULL,NULL,NULL,NULL,keep-null\n,,,,,keep-empty\nok,bad,bad,bad,bad,keep-invalid\n",
        )
        .unwrap();
        let source = DataSource::open(&path).unwrap();
        let mut profile = source.active_csv_profile().unwrap();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        profile.columns[0].target_type = CsvTargetType::Text;
        profile.columns[0].trim = true;
        profile.columns[1].target_type = CsvTargetType::Decimal;
        profile.columns[2].target_type = CsvTargetType::Date;
        profile.columns[3].target_type = CsvTargetType::Timestamp;
        profile.columns[4].target_type = CsvTargetType::Duration;
        profile.columns[4].duration_unit = Some(DurationUnit::Ms);
        profile.columns[4].duration_input_format = Some(CsvDurationInputFormat::RawInteger);
        profile.columns[5].target_type = CsvTargetType::Skip;
        let source = source.prepare_csv_profile(&profile).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_directory, service) = service();
        service
            .prepare_csv_session("compact-document", "compact-session", spec.clone())
            .unwrap();
        let ready = wait_csv_preparation(&service, "compact-document", "compact-session");
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
        let columns = spec
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        let page = service
            .read_prepared_csv_page(
                "compact-document",
                "compact-session",
                spec.clone(),
                0,
                4,
                &columns,
            )
            .unwrap()
            .unwrap();
        assert_eq!(page.rows[0][0].display.as_deref(), Some("alpha"));
        assert_eq!(page.rows[0][0].raw_display.as_deref(), Some("  alpha  "));
        assert_eq!(page.rows[0][1].display.as_deref(), Some("1.230"));
        assert_eq!(page.rows[0][4].display.as_deref(), Some("1500"));
        assert!(page.rows[1]
            .iter()
            .all(|value| value.state == DataValueState::Null));
        assert!(page.rows[2]
            .iter()
            .all(|value| value.state == DataValueState::Empty));
        assert_eq!(page.rows[3][0].state, DataValueState::Valid);
        assert!(page.rows[3][1..]
            .iter()
            .all(|value| value.state == DataValueState::Invalid));
        for value in &page.rows[3][1..] {
            assert_eq!(value.raw_display.as_deref(), Some("bad"));
        }
        let copied = service
            .read_prepared_csv_copy("compact-document", "compact-session", spec, 0, 4, &columns)
            .unwrap()
            .unwrap();
        assert_eq!(copied.rows, page.rows);
    }

    #[test]
    fn csv_compact_auto_utf8_fallback_mapping_uses_resolved_types() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = source_dir.path().join("auto-fallback.csv");
        std::fs::write(
            &path,
            "decimal,date,ts\n1.230,2025-01-02,2025-01-02T03:04:05Z\n2.500,2025-01-03,2025-01-03T04:05:06Z\n",
        )
        .unwrap();
        let source = DataSource::open(&path).unwrap();
        let mut profile = source.active_csv_profile().unwrap();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        for column in &mut profile.columns {
            column.target_type = CsvTargetType::Auto;
            column.trim = true;
        }
        let source = source.prepare_csv_profile(&profile).unwrap();
        let spec = source.query_source_spec().unwrap();
        assert_eq!(spec.columns[0].logical_type, "Decimal");
        assert_eq!(spec.columns[1].logical_type, "Date");
        assert_eq!(spec.columns[2].logical_type, "Timestamp");
        assert_eq!(
            spec.provider
                .csv_prepared_physical_columns()
                .iter()
                .map(|column| column.physical_kind.as_str())
                .collect::<Vec<_>>(),
            ["fallbackValue", "fallbackValue", "fallbackValue"]
        );

        let (_directory, service) = service();
        service
            .prepare_csv_session("auto-document", "auto-session", spec)
            .unwrap();
        let ready = wait_csv_preparation(&service, "auto-document", "auto-session");
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
        let cache_entry = service.csv_cache.entry_paths().remove(0);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(cache_entry.join("cache-manifest.json")).unwrap(),
        )
        .unwrap();
        let kinds = manifest["physicalMapping"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| {
                entry["field"]
                    .as_str()
                    .is_some_and(|field| field.starts_with("__dv_value_"))
            })
            .map(|entry| entry["physicalKind"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["fallbackValue", "fallbackValue", "fallbackValue"]);
    }

    #[test]
    fn csv_reserved_internal_headers_are_resolved_before_preparation() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = source_dir.path().join("reserved-headers.csv");
        std::fs::write(
            &path,
            "__dv_row_id,__dv_raw_0,__dv_state_word_0,__dv_value_1\na,b,c,d\n",
        )
        .unwrap();
        let mut source = DataSource::open(&path).unwrap();
        source.configure_csv(HeaderMode::Present).unwrap();
        let spec = source.query_source_spec().unwrap();
        let columns = spec
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            columns,
            [
                "__dv_row_id (source)",
                "__dv_raw_0 (source)",
                "__dv_state_word_0 (source)",
                "__dv_value_1 (source)"
            ]
        );
        let (_directory, service) = service();
        service
            .prepare_csv_session("reserved-document", "reserved-session", spec.clone())
            .unwrap();
        let ready = wait_csv_preparation(&service, "reserved-document", "reserved-session");
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);
        let page = service
            .read_prepared_csv_page(
                "reserved-document",
                "reserved-session",
                spec,
                0,
                1,
                &columns,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            page.rows[0]
                .iter()
                .map(|value| value.display.as_deref())
                .collect::<Vec<_>>(),
            [Some("a"), Some("b"), Some("c"), Some("d")]
        );
    }

    #[test]
    fn csv_compact_trimmed_text_preserves_rust_unicode_whitespace_semantics() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = source_dir.path().join("compact-unicode-trim.csv");
        std::fs::write(
            &path,
            "text\n\"\talpha\t\"\n\"\nbeta\n\"\n\"\u{00a0}gamma\u{00a0}\"\n\"\u{2003}delta\u{3000}\"\n",
        )
        .unwrap();
        let mut source = DataSource::open(&path).unwrap();
        source.configure_csv(HeaderMode::Present).unwrap();
        let mut profile = source.active_csv_profile().unwrap();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        profile.columns[0].target_type = CsvTargetType::Text;
        profile.columns[0].trim = true;
        let source = source.prepare_csv_profile(&profile).unwrap();
        let spec = source.query_source_spec().unwrap();
        let (_directory, service) = service();
        service
            .prepare_csv_session("unicode-document", "unicode-session", spec.clone())
            .unwrap();
        let ready = wait_csv_preparation(&service, "unicode-document", "unicode-session");
        assert_eq!(ready.state, CsvPreparationState::Ready, "{:?}", ready.error);

        let cache_entry = service.csv_cache.entry_paths().remove(0);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(cache_entry.join("cache-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["physicalLayout"],
            serde_json::json!([
                "__dv_row_id:INT64",
                "__dv_base_raw_0:BYTE_ARRAY",
                "__dv_value_0:BYTE_ARRAY",
                "__dv_state_word_0:INT64"
            ])
        );
        assert_eq!(
            manifest["physicalMapping"],
            serde_json::json!([
                {"field": "__dv_row_id", "physicalKind": "rowId", "sourceIndex": null, "stateWordIndex": null},
                {"field": "__dv_base_raw_0", "physicalKind": "baseRaw", "sourceIndex": 0, "stateWordIndex": null},
                {"field": "__dv_value_0", "physicalKind": "normalizedText", "sourceIndex": 0, "stateWordIndex": null},
                {"field": "__dv_state_word_0", "physicalKind": "stateWord", "sourceIndex": null, "stateWordIndex": 0}
            ])
        );

        let columns = vec![String::from("text")];
        let page = service
            .read_prepared_csv_page(
                "unicode-document",
                "unicode-session",
                spec.clone(),
                0,
                4,
                &columns,
            )
            .unwrap()
            .unwrap();
        let expected = [
            ("alpha", "\talpha\t"),
            ("beta", "\nbeta\n"),
            ("gamma", "\u{00a0}gamma\u{00a0}"),
            ("delta", "\u{2003}delta\u{3000}"),
        ];
        for (value, (display, raw)) in page.rows.iter().zip(expected) {
            assert_eq!(value[0].state, DataValueState::Valid);
            assert_eq!(value[0].display.as_deref(), Some(display));
            assert_eq!(value[0].raw_display.as_deref(), Some(raw));
        }

        let distinct = service
            .distinct(
                DistinctValuesRequest {
                    document_id: String::from("unicode-document"),
                    session_id: String::from("unicode-session"),
                    query_id: None,
                    column_id: String::from("text"),
                    search: None,
                    offset: 0,
                    limit: 20,
                },
                Some(spec.clone()),
            )
            .unwrap();
        let distinct_values = distinct
            .values
            .iter()
            .filter_map(|value| value.value.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(distinct_values.len(), 4);
        for expected in ["alpha", "beta", "gamma", "delta"] {
            assert!(distinct_values.contains(&expected));
        }

        let query = request(
            "unicode-task",
            "unicode-query",
            QueryPlan {
                filters: vec![QueryFilter {
                    id: String::from("text-filter"),
                    column_id: String::from("text"),
                    scalar_type: QueryScalarType::Text,
                    operator: FilterOperator::OneOf,
                    values: vec![String::from("beta"), String::from("delta")],
                }],
                search: None,
                sort: vec![QuerySort {
                    column_id: String::from("text"),
                    direction: QuerySortDirection::Ascending,
                    nulls_last: true,
                }],
                projection: columns.clone(),
            },
        );
        service.execute(query.clone(), spec).unwrap();
        assert_eq!(
            wait_complete(&service, &query).state,
            QueryTaskState::Complete
        );
        let filtered = service
            .read_page(ReadQueryPageRequest {
                document_id: query.document_id.clone(),
                session_id: query.session_id.clone(),
                query_id: query.query_id.clone(),
                offset: 0,
                limit: 10,
                columns: columns.clone(),
            })
            .unwrap()
            .page;
        assert_eq!(filtered.rows.len(), 2);
        assert_eq!(filtered.rows[0][0].display.as_deref(), Some("beta"));
        assert_eq!(filtered.rows[0][0].raw_display.as_deref(), Some("\nbeta\n"));
        assert_eq!(filtered.rows[1][0].display.as_deref(), Some("delta"));
        assert_eq!(
            filtered.rows[1][0].raw_display.as_deref(),
            Some("\u{2003}delta\u{3000}")
        );
        let copied = service
            .read_copy_rows(
                &query.document_id,
                &query.session_id,
                &query.query_id,
                0,
                10,
                &columns,
            )
            .unwrap();
        assert_eq!(copied.rows, filtered.rows);
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
                document_id: request.document_id.clone(),
                session_id: request.session_id.clone(),
                query_id: request.query_id.clone(),
                offset: 0,
                limit: 1,
                columns: vec![String::from("value")],
            })
            .unwrap()
            .page;
        assert_eq!(page.rows[0][0].display.as_deref(), Some("provider-value"));
        let result = service
            .result(&request.document_id, &request.session_id, &request.query_id)
            .unwrap();
        assert_eq!(
            *result.page_trace.lock().unwrap(),
            [
                QueryPageTraceEvent::IdentitySlice {
                    rows: 1,
                    requested_limit: 1,
                    lock_held: true,
                },
                QueryPageTraceEvent::SparseRead {
                    rows: 1,
                    columns: 1,
                    lock_held: false,
                },
            ]
        );
    }

    #[test]
    fn copy_reads_64_000_query_rows_with_one_unlocked_sparse_provider_call() {
        let (directory, service) = service();
        let source_path = directory.path().join("synthetic-bulk.input");
        std::fs::write(&source_path, b"provider-owned").unwrap();
        let copy_calls = Arc::new(AtomicU64::new(0));
        let source = QuerySourceSpec {
            path: std::fs::canonicalize(source_path).unwrap(),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("String"),
                nullable: false,
                physical_type: String::from("VARCHAR"),
            }],
            total_rows: Some(64_000),
            provider: Arc::new(BulkSyntheticQueryProvider {
                copy_calls: Arc::clone(&copy_calls),
            }),
        };
        let request = request(
            "provider-bulk-task",
            "provider-bulk-query",
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
        let page = service
            .read_copy_rows(
                &request.document_id,
                &request.session_id,
                &request.query_id,
                0,
                64_000,
                &[String::from("value")],
            )
            .unwrap();
        assert_eq!(page.rows.len(), 64_000);
        assert_eq!(page.rows[0][0].display.as_deref(), Some("0"));
        assert_eq!(page.rows[63_999][0].display.as_deref(), Some("63999"));
        assert_eq!(copy_calls.load(Ordering::Acquire), 1);

        let result = service
            .result(&request.document_id, &request.session_id, &request.query_id)
            .unwrap();
        assert_eq!(
            *result.page_trace.lock().unwrap(),
            [
                QueryPageTraceEvent::IdentitySlice {
                    rows: 64_000,
                    requested_limit: 64_000,
                    lock_held: true,
                },
                QueryPageTraceEvent::SparseRead {
                    rows: 64_000,
                    columns: 1,
                    lock_held: false,
                },
            ]
        );
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
            epoch: Arc::new(AtomicU64::new(1)),
            generation: 1,
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
                        columns: vec![String::from("row_id"), String::from("category")],
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

    const PHASE12_RELEASE_CASES: [&str; 8] = [
        "index-low-group-id-asc",
        "index-low-selective-filter-3-sort",
        "index-low-nonselective-filter-3-sort",
        "prepared-pages-low",
        "index-high-group-id-asc",
        "index-high-selective-filter-3-sort",
        "index-high-nonselective-filter-3-sort",
        "prepared-pages-high",
    ];

    const PHASE12_RELEASE_COUNTERS: [&str; 8] = [
        "identityRows",
        "requestedColumns",
        "sourceReadsBeforeIdentityLimit",
        "selectedRowGroups",
        "decodedRows",
        "decodedColumns",
        "pageValueIpcCalls",
        "frontendValueBatchIpcCalls",
    ];

    fn phase12_benchmark_plan(case_id: &str) -> QueryPlan {
        let ascending = |column_id: &str| QuerySort {
            column_id: column_id.to_owned(),
            direction: QuerySortDirection::Ascending,
            nulls_last: true,
        };
        let descending = |column_id: &str| QuerySort {
            column_id: column_id.to_owned(),
            direction: QuerySortDirection::Descending,
            nulls_last: true,
        };
        let (filters, sort) = if case_id.contains("nonselective-filter") {
            (
                vec![QueryFilter {
                    id: String::from("all-source-rows"),
                    column_id: String::from("row_id"),
                    scalar_type: QueryScalarType::Number,
                    operator: FilterOperator::GreaterThanOrEqual,
                    values: vec![String::from("0")],
                }],
                vec![
                    ascending("group_id"),
                    descending("event_time"),
                    ascending("label"),
                    ascending("row_id"),
                ],
            )
        } else if case_id.contains("selective-filter") {
            (
                vec![
                    QueryFilter {
                        id: String::from("active-true"),
                        column_id: String::from("active"),
                        scalar_type: QueryScalarType::Boolean,
                        operator: FilterOperator::IsTrue,
                        values: Vec::new(),
                    },
                    QueryFilter {
                        id: String::from("optional-not-null"),
                        column_id: String::from("optional_value"),
                        scalar_type: QueryScalarType::Number,
                        operator: FilterOperator::IsNotNull,
                        values: Vec::new(),
                    },
                    QueryFilter {
                        id: String::from("amount-at-least-ten"),
                        column_id: String::from("amount"),
                        scalar_type: QueryScalarType::Number,
                        operator: FilterOperator::GreaterThanOrEqual,
                        values: vec![String::from("10")],
                    },
                ],
                vec![
                    ascending("group_id"),
                    descending("event_time"),
                    ascending("label"),
                    ascending("row_id"),
                ],
            )
        } else {
            (Vec::new(), vec![ascending("group_id"), ascending("row_id")])
        };
        QueryPlan {
            filters,
            search: None,
            sort,
            projection: vec![String::from("row_id")],
        }
    }

    fn phase12_counter_json(
        identity_rows: usize,
        requested_columns: usize,
        source_reads_before_limit: usize,
        selected_row_groups: usize,
        decoded_rows: usize,
        decoded_columns: usize,
        page_calls: usize,
    ) -> serde_json::Value {
        serde_json::json!({
            "identityRows": identity_rows,
            "requestedColumns": requested_columns,
            "sourceReadsBeforeIdentityLimit": source_reads_before_limit,
            "selectedRowGroups": selected_row_groups,
            "decodedRows": decoded_rows,
            "decodedColumns": decoded_columns,
            "pageValueIpcCalls": page_calls,
            "frontendValueBatchIpcCalls": 0,
        })
    }

    #[test]
    fn phase12_release_raw_schema_contract_is_complete() {
        assert_eq!(PHASE12_RELEASE_CASES.len(), 8);
        for case_id in PHASE12_RELEASE_CASES {
            let plan = phase12_benchmark_plan(case_id);
            assert_eq!(plan.projection, ["row_id"]);
            assert!(!plan.sort.is_empty());
            if case_id.contains("nonselective-filter") {
                assert_eq!(plan.filters.len(), 1);
                assert_eq!(plan.filters[0].column_id, "row_id");
            } else if case_id.contains("selective-filter") {
                assert_eq!(plan.filters.len(), 3);
            }
        }
        let counters = phase12_counter_json(200, 1, 0, 2, 200, 1, 1);
        for name in PHASE12_RELEASE_COUNTERS {
            assert!(counters
                .get(name)
                .and_then(serde_json::Value::as_u64)
                .is_some());
        }
    }

    #[cfg(windows)]
    #[test]
    fn phase12_release_child_smoke_uses_a_small_parquet_fixture() {
        let directory = tempfile::tempdir().expect("Phase 12 smoke temp root");
        let path = std::fs::canonicalize(fixture("query-small.parquet"))
            .expect("canonical small Parquet fixture");
        let fixture = serde_json::json!({
            "id": "query-small-parquet",
            "absolutePath": path,
        });
        let measured = phase12_spawn_measurement(
            "index-low-group-id-asc",
            &fixture,
            &path,
            directory.path(),
            "cold",
            1,
            false,
        );
        assert_eq!(measured["run"]["resultRows"], 24);
        assert!(measured["run"]["peakRssBytes"].as_u64().unwrap() > 0);
        assert_eq!(
            measured["plan"]["resultIndexColumns"],
            serde_json::json!(["__dv_row_id"])
        );
        assert_eq!(
            measured["plan"]["assertions"]["physicalRowIdsContiguous"],
            true
        );
    }

    struct Phase12ResourceSampler {
        stop: Arc<AtomicBool>,
        peak_rss_bytes: Arc<AtomicU64>,
        temp_high_water_bytes: Arc<AtomicU64>,
        failure: Arc<Mutex<Option<String>>>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl Phase12ResourceSampler {
        fn start(service: Arc<QueryService>) -> Self {
            let stop = Arc::new(AtomicBool::new(false));
            let peak_rss_bytes = Arc::new(AtomicU64::new(0));
            let temp_high_water_bytes = Arc::new(AtomicU64::new(0));
            let failure = Arc::new(Mutex::new(None));
            let worker = {
                let stop = Arc::clone(&stop);
                let peak_rss_bytes = Arc::clone(&peak_rss_bytes);
                let temp_high_water_bytes = Arc::clone(&temp_high_water_bytes);
                let failure = Arc::clone(&failure);
                std::thread::spawn(move || loop {
                    let sample = phase12_peak_rss_bytes().and_then(|rss| {
                        service
                            .usage()
                            .map(|usage| (rss, usage.process_bytes))
                            .map_err(|error| error.to_string())
                    });
                    match sample {
                        Ok((rss, temp)) => {
                            peak_rss_bytes.fetch_max(rss, Ordering::AcqRel);
                            temp_high_water_bytes.fetch_max(temp, Ordering::AcqRel);
                        }
                        Err(error) => {
                            *failure.lock().expect("resource failure lock") = Some(error);
                            break;
                        }
                    }
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                })
            };
            Self {
                stop,
                peak_rss_bytes,
                temp_high_water_bytes,
                failure,
                worker: Some(worker),
            }
        }

        fn finish(mut self) -> Result<(u64, u64), String> {
            self.stop.store(true, Ordering::Release);
            self.worker
                .take()
                .expect("resource sampler worker")
                .join()
                .map_err(|_| String::from("Phase 12 resource sampler panicked."))?;
            if let Some(error) = self.failure.lock().expect("resource failure lock").take() {
                return Err(error);
            }
            let rss = self.peak_rss_bytes.load(Ordering::Acquire);
            if rss == 0 {
                return Err(String::from(
                    "Windows peak working-set measurement returned no value.",
                ));
            }
            Ok((rss, self.temp_high_water_bytes.load(Ordering::Acquire)))
        }
    }

    #[cfg(windows)]
    fn phase12_peak_rss_bytes() -> Result<u64, String> {
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
            fn K32GetProcessMemoryInfo(
                process: *mut c_void,
                counters: *mut ProcessMemoryCounters,
                size: u32,
            ) -> i32;
        }

        let mut counters: ProcessMemoryCounters = unsafe { mem::zeroed() };
        counters.cb = mem::size_of::<ProcessMemoryCounters>() as u32;
        let process = unsafe { GetCurrentProcess() };
        let ok = unsafe {
            K32GetProcessMemoryInfo(process, &mut counters, mem::size_of_val(&counters) as u32)
        } != 0;
        if !ok {
            return Err(String::from(
                "K32GetProcessMemoryInfo failed; peak RSS cannot be measured.",
            ));
        }
        u64::try_from(counters.peak_working_set_size)
            .map_err(|_| String::from("Peak working-set size does not fit u64."))
    }

    #[cfg(not(windows))]
    fn phase12_peak_rss_bytes() -> Result<u64, String> {
        Err(String::from(
            "Phase 12 release evidence requires a supported peak RSS sampler; this harness currently supports Windows.",
        ))
    }

    fn phase12_wait_for_result(
        service: &QueryService,
        request: &ExecuteQueryRequest,
    ) -> QueryStatus {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1_800);
        loop {
            let status = service
                .status(
                    &request.document_id,
                    &request.session_id,
                    &request.query_id,
                    &request.task_id,
                )
                .expect("Phase 12 benchmark query status");
            if matches!(
                status.state,
                QueryTaskState::Complete | QueryTaskState::Cancelled | QueryTaskState::Failed
            ) {
                return status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Phase 12 benchmark query exceeded 30 minutes"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn phase12_explain(
        connection: &Connection,
        sql: &str,
        parameters: &[String],
    ) -> Result<String, DataError> {
        let mut statement = connection
            .prepare(&format!("EXPLAIN {sql}"))
            .map_err(duckdb_error)?;
        let rows = statement
            .query_map(params_from_iter(parameters.iter()), |row| {
                Ok(format!(
                    "{}\n{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?
                ))
            })
            .map_err(duckdb_error)?
            .collect::<duckdb::Result<Vec<_>>>()
            .map_err(duckdb_error)?;
        Ok(rows.join("\n"))
    }

    fn phase12_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| String::from("JSON output has no parent directory."))?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    }

    fn phase12_run_child(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
        let case_id = spec["caseId"]
            .as_str()
            .ok_or_else(|| String::from("Child spec is missing caseId."))?;
        let fixture_path = std::path::PathBuf::from(
            spec["fixturePath"]
                .as_str()
                .ok_or_else(|| String::from("Child spec is missing fixturePath."))?,
        );
        let temp_root = std::path::PathBuf::from(
            spec["tempRoot"]
                .as_str()
                .ok_or_else(|| String::from("Child spec is missing tempRoot."))?,
        );
        let plan = phase12_benchmark_plan(case_id);
        let source = ParquetSource::open(&fixture_path).map_err(|error| error.to_string())?;
        let source_spec = source
            .query_source_spec()
            .map_err(|error| error.to_string())?;
        plan.validate(&source_spec.columns)
            .map_err(|error| error.to_string())?;
        let materialized =
            materialize_sql(&source_spec, &plan).map_err(|error| error.to_string())?;
        let service = Arc::new(
            QueryService::open(&temp_root, DEFAULT_QUERY_TEMP_LIMIT_BYTES)
                .map_err(|error| error.to_string())?,
        );
        let request = ExecuteQueryRequest {
            document_id: String::from("phase12-bench-document"),
            session_id: String::from("phase12-bench-session"),
            query_id: String::from("phase12-bench-query"),
            task_id: String::from("phase12-bench-task"),
            plan,
        };
        let sampler = Phase12ResourceSampler::start(Arc::clone(&service));
        let prepared_pages = case_id.starts_with("prepared-pages-");
        let started = std::time::Instant::now();
        service
            .execute(request.clone(), source_spec.clone())
            .map_err(|error| error.to_string())?;
        let status = phase12_wait_for_result(&service, &request);
        if status.state != QueryTaskState::Complete {
            return Err(format!(
                "Phase 12 benchmark query did not complete: {:?}",
                status.error
            ));
        }

        let mut page_calls = 0_usize;
        let mut page_checksum = 0_u64;
        let mut page_durations_ms = Vec::new();
        let page_started = std::time::Instant::now();
        if prepared_pages {
            let reference_path = std::path::PathBuf::from(
                spec["referencePath"]
                    .as_str()
                    .ok_or_else(|| String::from("Child spec is missing referencePath."))?,
            );
            let reference: serde_json::Value = serde_json::from_slice(
                &std::fs::read(reference_path).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let fixture_id = spec["fixtureId"]
                .as_str()
                .ok_or_else(|| String::from("Child spec is missing fixtureId."))?;
            let pages = reference["fixtures"][fixture_id]["pages"]
                .as_array()
                .ok_or_else(|| String::from("Reference pages are unavailable."))?;
            for oracle in pages {
                let offset = oracle["offset"]
                    .as_u64()
                    .ok_or_else(|| String::from("Reference offset is invalid."))?;
                let expected = oracle["sourceRowIds"]
                    .as_array()
                    .ok_or_else(|| String::from("Reference sourceRowIds are invalid."))?
                    .iter()
                    .map(|value| {
                        value
                            .as_u64()
                            .ok_or_else(|| String::from("Reference row identity is invalid."))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let single_page_started = std::time::Instant::now();
                let page = service
                    .read_page(ReadQueryPageRequest {
                        document_id: request.document_id.clone(),
                        session_id: request.session_id.clone(),
                        query_id: request.query_id.clone(),
                        offset: i64::try_from(offset)
                            .map_err(|_| String::from("Reference offset exceeds i64."))?,
                        limit: 200,
                        columns: vec![String::from("row_id")],
                    })
                    .map_err(|error| error.to_string())?
                    .page;
                page_durations_ms.push(single_page_started.elapsed().as_secs_f64() * 1_000.0);
                let actual = page
                    .rows
                    .iter()
                    .map(|row| {
                        row[0]
                            .source_display
                            .as_deref()
                            .ok_or_else(|| String::from("Page row identity has no source value."))?
                            .parse::<u64>()
                            .map_err(|error| error.to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if actual != expected {
                    return Err(format!(
                        "{} page oracle mismatch at offset {offset}",
                        oracle["label"].as_str().unwrap_or("unknown")
                    ));
                }
                for identity in actual {
                    page_checksum = page_checksum
                        .checked_add(identity)
                        .ok_or_else(|| String::from("Page identity checksum overflow."))?;
                }
                page_calls += 1;
            }
        } else if case_id.contains("filter-3-sort") {
            let single_page_started = std::time::Instant::now();
            let page = service
                .read_page(ReadQueryPageRequest {
                    document_id: request.document_id.clone(),
                    session_id: request.session_id.clone(),
                    query_id: request.query_id.clone(),
                    offset: 0,
                    limit: 200,
                    columns: vec![String::from("row_id")],
                })
                .map_err(|error| error.to_string())?
                .page;
            page_durations_ms.push(single_page_started.elapsed().as_secs_f64() * 1_000.0);
            for row in page.rows {
                let identity = row[0]
                    .source_display
                    .as_deref()
                    .ok_or_else(|| String::from("First page row identity has no source value."))?
                    .parse::<u64>()
                    .map_err(|error| error.to_string())?;
                page_checksum = page_checksum
                    .checked_add(identity)
                    .ok_or_else(|| String::from("Page identity checksum overflow."))?;
            }
            page_calls = 1;
        }
        let duration = if prepared_pages {
            page_started.elapsed()
        } else {
            started.elapsed()
        };
        let (peak_rss_bytes, temp_high_water_bytes) = sampler.finish()?;
        let result = service
            .result(&request.document_id, &request.session_id, &request.query_id)
            .map_err(|error| error.to_string())?;
        let trace = result
            .page_trace
            .lock()
            .map_err(|_| String::from("Query page trace is unavailable."))?
            .clone();
        let mut identity_rows = 0_usize;
        let mut identity_rows_total = 0_usize;
        let mut requested_columns = 0_usize;
        let mut source_reads_before_limit = 0_usize;
        let mut identity_ready = false;
        let mut query_mutex_held_during_source_decode = false;
        let mut source_read_calls = 0_usize;
        for event in &trace {
            match event {
                QueryPageTraceEvent::IdentitySlice { rows, .. } => {
                    identity_rows = identity_rows.max(*rows);
                    identity_rows_total = identity_rows_total.saturating_add(*rows);
                    identity_ready = true;
                }
                QueryPageTraceEvent::SparseRead {
                    columns, lock_held, ..
                } => {
                    if !identity_ready {
                        source_reads_before_limit += 1;
                    }
                    identity_ready = false;
                    requested_columns = requested_columns.max(*columns);
                    query_mutex_held_during_source_decode |= *lock_held;
                    source_read_calls += 1;
                }
            }
        }
        let decode = source.take_decode_audit();
        let counters = phase12_counter_json(
            identity_rows,
            requested_columns,
            source_reads_before_limit,
            decode.selected_row_groups_union.len(),
            decode.decoded_rows,
            decode.decoded_columns,
            page_calls,
        );

        let connection = result
            .connection
            .lock()
            .map_err(|_| String::from("Query result connection is unavailable."))?;
        let result_index_columns = connection
            .prepare("SELECT name FROM pragma_table_info('query_result') ORDER BY cid")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<duckdb::Result<Vec<_>>>()
            })
            .map_err(|error| error.to_string())?;
        let (minimum_rowid, maximum_rowid): (Option<u64>, Option<u64>) = connection
            .query_row(
                "SELECT min(q.rowid), max(q.rowid) FROM query_result q",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        let duckdb_threads: i64 = connection
            .query_row(
                "SELECT CAST(current_setting('threads') AS BIGINT)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let materialize_plan =
            phase12_explain(&connection, &materialized.sql, &materialized.parameters)
                .map_err(|error| error.to_string())?;
        let page_identity_sql = "SELECT q.rowid, q.__dv_row_id FROM query_result q WHERE q.rowid >= 0 ORDER BY q.rowid LIMIT 200";
        let page_identity_plan = phase12_explain(&connection, page_identity_sql, &[])
            .map_err(|error| error.to_string())?;
        drop(connection);
        let positions_contiguous = if status.progress.result_rows == 0 {
            minimum_rowid.is_none() && maximum_rowid.is_none()
        } else {
            minimum_rowid == Some(0)
                && maximum_rowid == Some(status.progress.result_rows.saturating_sub(1))
        };
        let source_value_columns = result_index_columns
            .iter()
            .filter(|column| column.as_str() != "__dv_row_id")
            .count();
        let ordered_window_position_columns = result_index_columns
            .iter()
            .filter(|column| column.as_str() == "__dv_result_position")
            .count();
        let identity_only_result_index = result_index_columns == ["__dv_row_id"];
        let unbounded_source_join = usize::from(
            page_identity_sql.contains("dv_source")
                || page_identity_plan
                    .to_ascii_lowercase()
                    .contains("dv_source"),
        );
        let plan_audit = serde_json::json!({
            "caseId": case_id,
            "duckDbThreads": duckdb_threads,
            "materializeSql": materialized.sql,
            "materializeParameters": materialized.parameters,
            "materializePhysicalPlan": materialize_plan,
            "pageIdentitySql": page_identity_sql,
            "pageIdentityPhysicalPlan": page_identity_plan,
            "resultIndexColumns": result_index_columns,
            "resultRows": status.progress.result_rows,
            "minimumPhysicalRowId": minimum_rowid,
            "maximumPhysicalRowId": maximum_rowid,
            "assertions": {
                "identityOnlyResultIndex": identity_only_result_index,
                "physicalRowIdsContiguous": positions_contiguous,
                "orderedWindowPositionColumns": ordered_window_position_columns,
                "sourceValueColumnsInIndex": source_value_columns,
                "identityRowsPerGridPageMaximum": identity_rows,
                "projectionColumnsPerGridPageMaximum": requested_columns,
                "sourceReadsBeforeIdentityLimit": source_reads_before_limit,
                "queryMutexHeldDuringSourceDecode": query_mutex_held_during_source_decode,
                "unboundedQueryResultSourceJoin": unbounded_source_join,
            }
        });
        if !identity_only_result_index
            || !positions_contiguous
            || ordered_window_position_columns != 0
            || identity_rows > 200
            || requested_columns > 64
            || source_reads_before_limit != 0
            || query_mutex_held_during_source_decode
            || unbounded_source_join != 0
        {
            return Err(String::from(
                "Phase 12 query index or page-plan invariant failed.",
            ));
        }
        let temperature = spec["temperature"]
            .as_str()
            .ok_or_else(|| String::from("Child spec is missing temperature."))?;
        let sample = spec["sample"]
            .as_u64()
            .ok_or_else(|| String::from("Child spec is missing sample."))?;
        let run = serde_json::json!({
            "caseId": case_id,
            "temperature": temperature,
            "sample": sample,
            "durationMs": duration.as_secs_f64() * 1_000.0,
            "peakRssBytes": peak_rss_bytes,
            "tempHighWaterBytes": temp_high_water_bytes,
            "duckDbThreads": duckdb_threads,
            "resultRows": status.progress.result_rows,
            "pageIdentityChecksum": page_checksum,
            "pageDurationsMs": page_durations_ms,
            "counters": counters,
            "resourceMeasurement": {
                "peakRss": "Windows K32GetProcessMemoryInfo PeakWorkingSetSize",
                "tempHighWater": "QueryTempManager process_bytes sampled every 25 ms",
                "samplingIntervalMs": 25,
            },
            "counterScope": {
                "identityAndProjection": "QueryResult page trace after the bounded physical-rowid slice",
                "selectedRowGroupsAndDecodedValues": "Rust sparse Parquet provider reads after identity limiting; DuckDB materialization is represented by its physical plan and resultRows",
                "ipc": "backend read_page calls made by this release harness; it does not request frontend value batches",
            }
        });
        let counter_audit = serde_json::json!({
            "caseId": case_id,
            "temperature": temperature,
            "sample": sample,
            "identityRowsMaximum": identity_rows,
            "identityRowsTotal": identity_rows_total,
            "sourceReadCalls": source_read_calls,
            "selectedRowGroupIds": decode.selected_row_groups_union,
            "decodedBatches": decode.decoded_batches,
            "projectedRootColumns": decode.projected_root_columns,
            "queryMutexHeldDuringSourceDecode": query_mutex_held_during_source_decode,
            "counters": counters,
        });
        Ok(serde_json::json!({
            "run": run,
            "plan": plan_audit,
            "counterAudit": counter_audit,
        }))
    }

    #[test]
    #[ignore = "spawned only by the Phase 12 release evidence parent test"]
    fn release_benchmark_child_entry() {
        let spec_path = std::env::var_os("PHASE12_BENCH_CHILD_SPEC")
            .map(std::path::PathBuf::from)
            .expect("PHASE12_BENCH_CHILD_SPEC is required");
        let output_path = std::env::var_os("PHASE12_BENCH_CHILD_OUTPUT")
            .map(std::path::PathBuf::from)
            .expect("PHASE12_BENCH_CHILD_OUTPUT is required");
        let spec: serde_json::Value =
            serde_json::from_slice(&std::fs::read(spec_path).expect("read Phase 12 child spec"))
                .expect("parse Phase 12 child spec");
        let result = phase12_run_child(&spec).expect("run Phase 12 child measurement");
        phase12_write_json(&output_path, &result).expect("write Phase 12 child result");
    }

    fn phase12_spawn_measurement(
        case_id: &str,
        fixture: &serde_json::Value,
        reference_path: &Path,
        temp_root: &Path,
        temperature: &str,
        sample: u64,
        warmup: bool,
    ) -> serde_json::Value {
        let run_name = if warmup {
            format!("{case_id}-warmup")
        } else {
            format!("{case_id}-{temperature}-{sample}")
        };
        let run_root = temp_root.join("runs").join(&run_name);
        std::fs::create_dir_all(&run_root).expect("create Phase 12 run root");
        let spec_path = run_root.join("child-spec.json");
        let output_path = run_root.join("child-result.json");
        let spec = serde_json::json!({
            "caseId": case_id,
            "fixtureId": fixture["id"],
            "fixturePath": fixture["absolutePath"],
            "referencePath": reference_path,
            "tempRoot": run_root.join("query-temp-root"),
            "temperature": temperature,
            "sample": sample,
            "warmup": warmup,
        });
        phase12_write_json(&spec_path, &spec).expect("write Phase 12 child spec");
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .args([
                "--ignored",
                "--exact",
                "query::engine::tests::release_benchmark_child_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("PHASE12_BENCH_CHILD_SPEC", &spec_path)
            .env("PHASE12_BENCH_CHILD_OUTPUT", &output_path)
            .output()
            .expect("spawn Phase 12 benchmark child");
        assert!(
            output.status.success() && output_path.is_file(),
            "Phase 12 child failed for {run_name}:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&std::fs::read(output_path).expect("read child result"))
            .expect("parse child result")
    }

    #[test]
    #[ignore = "requires generated Phase 12 low/high 5.85M fixtures and release execution"]
    fn phase12_release_benchmark_evidence() {
        let manifest_path = std::env::var_os("PHASE12_FIXTURE_MANIFEST")
            .map(std::path::PathBuf::from)
            .expect("PHASE12_FIXTURE_MANIFEST is required");
        let reference_path = std::env::var_os("PHASE12_REFERENCE")
            .map(std::path::PathBuf::from)
            .expect("PHASE12_REFERENCE is required");
        let raw_path = std::env::var_os("PHASE12_RAW_RESULTS")
            .map(std::path::PathBuf::from)
            .expect("PHASE12_RAW_RESULTS is required");
        let temp_root = std::env::var_os("PHASE12_TEMP_ROOT")
            .map(std::path::PathBuf::from)
            .expect("PHASE12_TEMP_ROOT is required");
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&manifest_path).expect("read Phase 12 fixture manifest"),
        )
        .expect("parse Phase 12 fixture manifest");
        let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root")
            .to_path_buf();
        let mut fixtures = std::collections::HashMap::new();
        for fixture in manifest["fixtures"]
            .as_array()
            .expect("fixture manifest entries")
        {
            let Some(cardinality) = fixture["cardinality"].as_str() else {
                continue;
            };
            if !matches!(cardinality, "low" | "high") {
                continue;
            }
            let recorded =
                std::path::PathBuf::from(fixture["path"].as_str().expect("fixture recorded path"));
            let absolute = if recorded.is_absolute() {
                recorded
            } else {
                repo_root.join(recorded)
            };
            assert!(
                absolute.is_file(),
                "missing fixture: {}",
                absolute.display()
            );
            let mut fixture = fixture.clone();
            fixture["absolutePath"] = serde_json::Value::String(
                std::fs::canonicalize(absolute)
                    .expect("canonical fixture path")
                    .to_string_lossy()
                    .into_owned(),
            );
            fixtures.insert(cardinality.to_owned(), fixture);
        }
        assert_eq!(
            fixtures.len(),
            2,
            "low/high benchmark fixtures are required"
        );

        let mut runs = Vec::with_capacity(PHASE12_RELEASE_CASES.len() * 10);
        let mut plans = Vec::with_capacity(PHASE12_RELEASE_CASES.len());
        let mut counter_audits = Vec::with_capacity(PHASE12_RELEASE_CASES.len() * 10);
        for case_id in PHASE12_RELEASE_CASES {
            let cardinality = if case_id.contains("-low") {
                "low"
            } else {
                "high"
            };
            let fixture = fixtures.get(cardinality).expect("fixture cardinality");
            for sample in 1..=5_u64 {
                let measured = phase12_spawn_measurement(
                    case_id,
                    fixture,
                    &reference_path,
                    &temp_root,
                    "cold",
                    sample,
                    false,
                );
                if sample == 1 {
                    plans.push(measured["plan"].clone());
                }
                runs.push(measured["run"].clone());
                counter_audits.push(measured["counterAudit"].clone());
            }
            let _warmup = phase12_spawn_measurement(
                case_id,
                fixture,
                &reference_path,
                &temp_root,
                "warm",
                0,
                true,
            );
            for sample in 1..=5_u64 {
                let measured = phase12_spawn_measurement(
                    case_id,
                    fixture,
                    &reference_path,
                    &temp_root,
                    "warm",
                    sample,
                    false,
                );
                runs.push(measured["run"].clone());
                counter_audits.push(measured["counterAudit"].clone());
            }
        }
        assert_eq!(runs.len(), PHASE12_RELEASE_CASES.len() * 10);
        let raw = serde_json::json!({
            "schemaVersion": 1,
            "generatedAtUtc": chrono::Utc::now().to_rfc3339(),
            "protocol": {
                "coldRunsPerCase": 5,
                "warmupRunsBeforeWarm": 1,
                "warmRunsPerCase": 5,
                "coldProcessIsolation": "one fresh child process, connection, result index, and temp root per run",
                "warmProcessIsolation": "one fresh child process, connection, result index, and temp root per run after an unrecorded fixture warmup",
                "osFileCache": "observed; not forcibly purged",
                "rssSampling": "Windows PeakWorkingSetSize sampled every 25 ms",
                "tempSampling": "QueryTempManager process_bytes sampled every 25 ms",
            },
            "runs": runs,
            "plans": plans,
            "counterAudits": counter_audits,
        });
        phase12_write_json(&raw_path, &raw).expect("write Phase 12 raw benchmark evidence");
    }
}
