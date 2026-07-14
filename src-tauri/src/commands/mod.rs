use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    sync::{Condvar, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    data::DataSource,
    domain::{DataError, DataErrorCode, DataPage, FileSummary, HeaderMode},
    platform::{
        pick_data_file, pick_data_files, DocumentAccessError, DocumentRef, DocumentRegistry,
        PageCacheKey, PathReservation, PendingOpenQueue, ReservePath,
    },
};

const MAX_PAGE_ROWS: usize = 200;
const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_OPEN_BATCH: usize = 32;
const COMPLETED_REQUEST_CAPACITY: usize = 256;
const MAX_CONCURRENT_SOURCE_PREPARES: usize = 4;

#[derive(Debug)]
enum OpenPlan {
    Failed(DataError),
    Existing {
        canonical: PathBuf,
        document: DocumentRef<DataSource>,
    },
    Reserved {
        canonical: PathBuf,
        reservation: PathReservation,
    },
    Duplicate {
        canonical: PathBuf,
        first_index: usize,
    },
}

struct PreparedSource {
    source: DataSource,
    summary: FileSummary,
    initial_page: DataPage,
}

#[derive(Default)]
struct SourcePrepareLimiter {
    active: Mutex<usize>,
    changed: Condvar,
    max_observed: AtomicUsize,
}

struct SourcePreparePermit(&'static SourcePrepareLimiter);

impl Drop for SourcePreparePermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.changed.notify_one();
        }
    }
}

fn source_prepare_limiter() -> &'static SourcePrepareLimiter {
    static LIMITER: OnceLock<SourcePrepareLimiter> = OnceLock::new();
    LIMITER.get_or_init(SourcePrepareLimiter::default)
}

fn acquire_source_prepare_permit() -> Result<SourcePreparePermit, DataError> {
    let limiter = source_prepare_limiter();
    let mut active = limiter.active.lock().map_err(|_| DataError {
        code: DataErrorCode::Io,
        message: String::from("The source-prepare limiter is unavailable."),
    })?;
    while *active >= MAX_CONCURRENT_SOURCE_PREPARES {
        active = limiter.changed.wait(active).map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The source-prepare limiter is unavailable."),
        })?;
    }
    *active += 1;
    limiter.max_observed.fetch_max(*active, Ordering::Relaxed);
    Ok(SourcePreparePermit(limiter))
}

fn prepare_source(path: &Path) -> Result<PreparedSource, DataError> {
    let _permit = acquire_source_prepare_permit()?;
    #[cfg(test)]
    std::thread::sleep(std::time::Duration::from_millis(5));
    let source = DataSource::open(path)?;
    let summary = source.summary();
    let initial_page = source.read_page_projected(0, MAX_PAGE_ROWS, None)?;
    Ok(PreparedSource {
        source,
        summary,
        initial_page,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileResponse {
    document_id: String,
    session_id: String,
    summary: FileSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenOrigin {
    Dialog,
    DragDrop,
    StartupArg,
    FileAssociation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathsRequest {
    pub request_id: String,
    pub origin: OpenOrigin,
    pub paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenDisposition {
    Opened,
    Existing,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPath {
    item_index: usize,
    path: String,
    disposition: OpenDisposition,
    document_id: String,
    session_id: String,
    summary: FileSummary,
    initial_page: DataPage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathFailure {
    item_index: usize,
    path: String,
    error: DataError,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathsResponse {
    request_id: String,
    origin: OpenOrigin,
    opened: Vec<OpenedPath>,
    failures: Vec<OpenPathFailure>,
    active_document_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequestFailure {
    request_id: String,
    origin: OpenOrigin,
    error: DataError,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPageResponse {
    document_id: String,
    session_id: String,
    page: DataPage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPageRequest {
    document_id: String,
    session_id: String,
    offset: i64,
    limit: usize,
    columns: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDocumentResponse {
    document_id: String,
    session_id: String,
}

#[derive(Default)]
pub struct AppState {
    documents: DocumentRegistry<DataSource>,
    pending_opens: PendingOpenQueue,
    next_request_id: AtomicU64,
    completed_requests: Mutex<VecDeque<String>>,
    cancelled_requests: Mutex<VecDeque<String>>,
}

impl AppState {
    fn open_path(&self, path: impl AsRef<Path>) -> Result<OpenFileResponse, DataError> {
        let response = self.open_paths(OpenPathsRequest {
            request_id: self.next_request_id("legacy"),
            origin: OpenOrigin::Dialog,
            paths: vec![path.as_ref().to_path_buf()],
        })?;
        let opened = response.opened.into_iter().next().ok_or_else(|| {
            response.failures.into_iter().next().map_or_else(
                || DataError::invalid_request("No file was opened."),
                |failure| failure.error,
            )
        })?;
        Ok(OpenFileResponse {
            document_id: opened.document_id,
            session_id: opened.session_id,
            summary: opened.summary,
        })
    }

    fn open_paths(&self, mut request: OpenPathsRequest) -> Result<OpenPathsResponse, DataError> {
        validate_open_request(&request)?;
        self.register_request(&request.request_id)?;

        let cwd = std::env::current_dir().map_err(|error| DataError {
            code: DataErrorCode::Io,
            message: format!("The current working directory is unavailable: {error}"),
        })?;
        for path in &mut request.paths {
            if path.is_relative() {
                *path = cwd.join(&*path);
            }
        }

        let mut first_by_path = HashMap::new();
        let mut plans = Vec::with_capacity(request.paths.len());
        for (item_index, path) in request.paths.iter().enumerate() {
            let canonical = match canonicalize_open_path(path) {
                Ok(canonical) => canonical,
                Err(error) => {
                    plans.push(OpenPlan::Failed(error));
                    continue;
                }
            };
            let key = canonical_path_key(&canonical);
            if let Some(first_index) = first_by_path.get(&key).copied() {
                plans.push(OpenPlan::Duplicate {
                    canonical,
                    first_index,
                });
                continue;
            }
            first_by_path.insert(key.clone(), item_index);
            match self.documents.reserve_path(key).map_err(document_error) {
                Ok(ReservePath::Existing(document)) => plans.push(OpenPlan::Existing {
                    canonical,
                    document,
                }),
                Ok(ReservePath::Reserved(reservation)) => plans.push(OpenPlan::Reserved {
                    canonical,
                    reservation,
                }),
                Err(error) => plans.push(OpenPlan::Failed(error)),
            }
        }

        let jobs: Vec<_> = plans
            .iter()
            .enumerate()
            .filter_map(|(index, plan)| match plan {
                OpenPlan::Reserved { canonical, .. } => Some((index, canonical.clone())),
                _ => None,
            })
            .collect();
        let mut prepared: Vec<Option<Result<PreparedSource, DataError>>> =
            std::iter::repeat_with(|| None).take(plans.len()).collect();
        std::thread::scope(|scope| {
            for chunk in jobs.chunks(MAX_CONCURRENT_SOURCE_PREPARES) {
                let handles: Vec<_> = chunk
                    .iter()
                    .cloned()
                    .map(|(index, path)| scope.spawn(move || (index, prepare_source(&path))))
                    .collect();
                for handle in handles {
                    match handle.join() {
                        Ok((index, result)) => prepared[index] = Some(result),
                        Err(_) => {
                            // A source-specific panic is converted into an item failure;
                            // other reservations are still committed deterministically.
                        }
                    }
                }
            }
        });

        let mut opened = Vec::with_capacity(request.paths.len());
        let mut failures = Vec::new();
        let mut outcomes: Vec<Option<Result<(String, String), DataError>>> =
            std::iter::repeat_with(|| None).take(plans.len()).collect();
        for (item_index, plan) in plans.into_iter().enumerate() {
            let result = match plan {
                OpenPlan::Failed(error) => Err(error),
                OpenPlan::Existing {
                    canonical,
                    document,
                } => self.open_existing(item_index, canonical, document),
                OpenPlan::Reserved {
                    canonical,
                    reservation,
                } => {
                    let prepared = prepared[item_index].take().unwrap_or_else(|| {
                        Err(DataError::invalid_request(
                            "The source prepare task failed.",
                        ))
                    });
                    match prepared {
                        Err(error) => {
                            self.documents.cancel_reservation(&reservation);
                            Err(error)
                        }
                        Ok(prepared) if self.is_request_cancelled(&request.request_id) => {
                            self.documents.cancel_reservation(&reservation);
                            drop(prepared);
                            Err(DataError::open_request_cancelled(&request.request_id))
                        }
                        Ok(prepared) => {
                            self.commit_prepared(item_index, canonical, reservation, prepared)
                        }
                    }
                }
                OpenPlan::Duplicate {
                    canonical,
                    first_index,
                } => match outcomes[first_index].as_ref() {
                    Some(Ok((document_id, session_id))) => {
                        self.open_existing_identity(item_index, canonical, document_id, session_id)
                    }
                    Some(Err(error)) => Err(error.clone()),
                    None => Err(DataError::invalid_request(
                        "The first duplicate path has no open result.",
                    )),
                },
            };
            match result {
                Ok(item) => {
                    outcomes[item_index] =
                        Some(Ok((item.document_id.clone(), item.session_id.clone())));
                    opened.push(item);
                }
                Err(error) => {
                    outcomes[item_index] = Some(Err(error.clone()));
                    failures.push(OpenPathFailure {
                        item_index,
                        path: request.paths[item_index].to_string_lossy().into_owned(),
                        error,
                    });
                }
            }
        }
        self.clear_request_cancellation(&request.request_id);
        let active_document_id = opened.first().map(|item| item.document_id.clone());
        Ok(OpenPathsResponse {
            request_id: request.request_id,
            origin: request.origin,
            opened,
            failures,
            active_document_id,
        })
    }

    fn open_existing(
        &self,
        item_index: usize,
        canonical: PathBuf,
        document: DocumentRef<DataSource>,
    ) -> Result<OpenedPath, DataError> {
        let (document_id, session_id) =
            self.documents.identity(&document).map_err(document_error)?;
        self.open_existing_identity(item_index, canonical, &document_id, &session_id)
    }

    fn open_existing_identity(
        &self,
        item_index: usize,
        canonical: PathBuf,
        document_id: &str,
        session_id: &str,
    ) -> Result<OpenedPath, DataError> {
        let summary = self
            .documents
            .with_source(document_id, session_id, DataSource::summary)
            .map_err(document_error)?;
        let initial_page = self
            .documents
            .get_or_load_page(
                document_id,
                session_id,
                PageCacheKey::new(0, MAX_PAGE_ROWS, None),
                |source| source.read_page_projected(0, MAX_PAGE_ROWS, None),
            )
            .map_err(document_error)??;
        Ok(OpenedPath {
            item_index,
            path: canonical.to_string_lossy().into_owned(),
            disposition: OpenDisposition::Existing,
            document_id: document_id.to_owned(),
            session_id: session_id.to_owned(),
            summary,
            initial_page,
        })
    }

    fn commit_prepared(
        &self,
        item_index: usize,
        canonical: PathBuf,
        reservation: PathReservation,
        prepared: PreparedSource,
    ) -> Result<OpenedPath, DataError> {
        let (document_id, session_id) = self
            .documents
            .commit(
                reservation,
                prepared.source,
                PageCacheKey::new(0, MAX_PAGE_ROWS, None),
                prepared.initial_page.clone(),
            )
            .map_err(document_error)?;
        Ok(OpenedPath {
            item_index,
            path: canonical.to_string_lossy().into_owned(),
            disposition: OpenDisposition::Opened,
            document_id,
            session_id,
            summary: prepared.summary,
            initial_page: prepared.initial_page,
        })
    }

    pub(crate) fn next_request_id(&self, prefix: &str) -> String {
        let value = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{prefix}-{value}")
    }

    pub(crate) fn enqueue_open(&self, request: OpenPathsRequest) {
        self.pending_opens.push(request);
    }

    fn take_pending_opens(&self) -> Vec<OpenPathsRequest> {
        self.pending_opens.drain()
    }

    fn read(&self, request: ReadPageRequest) -> Result<ReadPageResponse, DataError> {
        if request.offset < 0 {
            return Err(invalid_request("Page offset cannot be negative."));
        }
        if !(1..=MAX_PAGE_ROWS).contains(&request.limit) {
            return Err(invalid_request(
                "Page limit must be between 1 and 200 rows.",
            ));
        }
        let projection = validate_projection(request.columns)?;
        let offset = request.offset as u64;
        let page = self
            .documents
            .get_or_load_page(
                &request.document_id,
                &request.session_id,
                PageCacheKey::new(offset, request.limit, projection.clone()),
                |source| source.read_page_projected(offset, request.limit, projection.as_deref()),
            )
            .map_err(document_error)??;
        Ok(ReadPageResponse {
            document_id: request.document_id,
            session_id: request.session_id,
            page,
        })
    }

    fn close(&self, document_id: &str, session_id: &str) -> Result<(), DataError> {
        self.documents
            .close(document_id, session_id)
            .map_err(document_error)
    }

    fn summary(&self, document_id: &str, session_id: &str) -> Result<OpenFileResponse, DataError> {
        let summary = self
            .documents
            .with_source(document_id, session_id, DataSource::summary)
            .map_err(document_error)?;
        Ok(OpenFileResponse {
            document_id: document_id.to_owned(),
            session_id: session_id.to_owned(),
            summary,
        })
    }

    fn configure_csv(
        &self,
        document_id: &str,
        session_id: &str,
        header_mode: HeaderMode,
    ) -> Result<OpenFileResponse, DataError> {
        let candidate = self
            .documents
            .with_source(document_id, session_id, |source| {
                source.prepare_configured_csv(header_mode)
            })
            .map_err(document_error)??;
        let Some(source) = candidate else {
            return self.summary(document_id, session_id);
        };
        let summary = source.summary();
        let new_session_id = self
            .documents
            .replace_source(document_id, session_id, source)
            .map_err(document_error)?;
        Ok(OpenFileResponse {
            document_id: document_id.to_owned(),
            session_id: new_session_id,
            summary,
        })
    }

    fn cancel_task(
        &self,
        document_id: &str,
        session_id: &str,
        generation: u64,
    ) -> Result<OpenFileResponse, DataError> {
        let summary = self
            .documents
            .with_source(document_id, session_id, |source| match source {
                DataSource::Csv(csv) => csv.cancel_index(generation),
                DataSource::Parquet(_) => Err(DataError::invalid_request(
                    "Parquet files do not have a CSV indexing task.",
                )),
            })
            .map_err(document_error)??;
        Ok(OpenFileResponse {
            document_id: document_id.to_owned(),
            session_id: session_id.to_owned(),
            summary,
        })
    }

    fn register_request(&self, request_id: &str) -> Result<(), DataError> {
        let mut requests = self.completed_requests.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The open-request registry is unavailable."),
        })?;
        if requests.iter().any(|known| known == request_id) {
            return Err(DataError::duplicate_open_request(request_id));
        }
        requests.push_back(request_id.to_owned());
        while requests.len() > COMPLETED_REQUEST_CAPACITY {
            requests.pop_front();
        }
        Ok(())
    }

    fn is_request_cancelled(&self, request_id: &str) -> bool {
        self.cancelled_requests
            .lock()
            .is_ok_and(|requests| requests.iter().any(|known| known == request_id))
    }

    fn cancel_open(&self, request_id: &str) {
        if let Ok(mut requests) = self.cancelled_requests.lock() {
            requests.retain(|known| known != request_id);
            requests.push_back(request_id.to_owned());
            while requests.len() > COMPLETED_REQUEST_CAPACITY {
                requests.pop_front();
            }
        }
    }

    fn clear_request_cancellation(&self, request_id: &str) {
        if let Ok(mut requests) = self.cancelled_requests.lock() {
            requests.retain(|known| known != request_id);
        }
    }
}

fn validate_open_request(request: &OpenPathsRequest) -> Result<(), DataError> {
    if request.request_id.trim().is_empty() {
        return Err(DataError::invalid_request(
            "Open request ID cannot be empty.",
        ));
    }
    if request.paths.is_empty() || request.paths.len() > MAX_OPEN_BATCH {
        return Err(DataError::invalid_request(format!(
            "Open requests must contain between 1 and {MAX_OPEN_BATCH} paths; received {}.",
            request.paths.len()
        )));
    }
    Ok(())
}

fn canonicalize_open_path(path: &Path) -> Result<PathBuf, DataError> {
    std::fs::canonicalize(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DataError::file_not_found(path)
        } else {
            DataError::io(path, error)
        }
    })
}

fn canonical_path_key(path: &Path) -> String {
    let key = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        key.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        key
    }
}

fn validate_projection(columns: Option<Vec<String>>) -> Result<Option<Vec<String>>, DataError> {
    let Some(columns) = columns else {
        return Ok(None);
    };
    if columns.is_empty() {
        return Err(invalid_request(
            "Column projection must contain at least one column.",
        ));
    }
    if columns.len() > MAX_PROJECTION_COLUMNS {
        return Err(invalid_request(
            "Column projection cannot contain more than 64 columns.",
        ));
    }
    if columns.iter().any(|column| column.trim().is_empty()) {
        return Err(invalid_request(
            "Column projection cannot contain an empty column name.",
        ));
    }
    let mut unique = HashSet::with_capacity(columns.len());
    if columns.iter().any(|column| !unique.insert(column.as_str())) {
        return Err(invalid_request(
            "Column projection cannot contain duplicate column names.",
        ));
    }
    Ok(Some(columns))
}

fn invalid_request(message: impl Into<String>) -> DataError {
    DataError::invalid_request(message)
}

fn document_error(error: DocumentAccessError) -> DataError {
    match error {
        DocumentAccessError::NotFound { document_id } => {
            DataError::document_not_found(&document_id)
        }
        DocumentAccessError::Closed { document_id } => DataError::document_closed(&document_id),
        DocumentAccessError::StaleSession {
            document_id,
            requested_session_id,
        } => DataError::stale_session(&document_id, &requested_session_id),
        DocumentAccessError::LimitReached {
            limit,
            open,
            reserved,
        } => DataError::too_many_open_documents(limit, open, reserved),
        DocumentAccessError::Unavailable => DataError {
            code: DataErrorCode::Io,
            message: String::from("The document registry is unavailable."),
        },
    }
}

#[tauri::command]
pub fn open_data_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, DataError> {
    state.open_path(path)
}

#[tauri::command]
pub fn open_data_paths(
    request: OpenPathsRequest,
    state: State<'_, AppState>,
) -> Result<OpenPathsResponse, OpenRequestFailure> {
    let request_id = request.request_id.clone();
    let origin = request.origin;
    state
        .open_paths(request)
        .map_err(|error| OpenRequestFailure {
            request_id,
            origin,
            error,
        })
}

#[tauri::command]
pub fn take_pending_open_requests(state: State<'_, AppState>) -> Vec<OpenPathsRequest> {
    state.take_pending_opens()
}

#[tauri::command]
pub async fn select_data_file(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OpenFileResponse>, DataError> {
    let selected = pick_data_file(&app).map_err(invalid_request)?;
    selected.map(|path| state.open_path(path)).transpose()
}

#[tauri::command]
pub async fn select_data_file_paths(
    request_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OpenPathsResponse>, OpenRequestFailure> {
    let origin = OpenOrigin::Dialog;
    let selected = pick_data_files(&app).map_err(|message| OpenRequestFailure {
        request_id: request_id.clone(),
        origin,
        error: invalid_request(message),
    })?;
    selected
        .map(|paths| {
            state
                .open_paths(OpenPathsRequest {
                    request_id: request_id.clone(),
                    origin,
                    paths,
                })
                .map_err(|error| OpenRequestFailure {
                    request_id,
                    origin,
                    error,
                })
        })
        .transpose()
}

#[tauri::command]
pub fn read_page(
    request: ReadPageRequest,
    state: State<'_, AppState>,
) -> Result<ReadPageResponse, DataError> {
    state.read(request)
}

#[tauri::command]
pub fn close_document(
    document_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<CloseDocumentResponse, DataError> {
    state.close(&document_id, &session_id)?;
    Ok(CloseDocumentResponse {
        document_id,
        session_id,
    })
}

#[tauri::command]
pub fn close_data_file(session_id: String, state: State<'_, AppState>) -> Result<(), DataError> {
    let (document_id, active_session_id) = state
        .documents
        .find_by_session(&session_id)
        .map_err(document_error)?;
    state.close(&document_id, &active_session_id)
}

#[tauri::command]
pub fn configure_csv(
    document_id: String,
    session_id: String,
    header_mode: HeaderMode,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, DataError> {
    state.configure_csv(&document_id, &session_id, header_mode)
}

#[tauri::command]
pub fn get_data_file_status(
    document_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, DataError> {
    state.summary(&document_id, &session_id)
}

#[tauri::command]
pub fn cancel_data_file_task(
    document_id: String,
    session_id: String,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, DataError> {
    state.cancel_task(&document_id, &session_id, generation)
}

#[tauri::command]
pub fn cancel_open_request(request_id: String, state: State<'_, AppState>) {
    state.cancel_open(&request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{ArrayRef, Int32Array, RecordBatch};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use std::{fs::File, sync::Arc};

    fn write_fixture(path: &Path, values: Vec<i32>) {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int32Array::from(values)) as ArrayRef],
        )
        .expect("fixture batch");
        let mut writer =
            ArrowWriter::try_new(File::create(path).expect("fixture file"), schema, None)
                .expect("fixture writer");
        writer.write(&batch).expect("fixture write");
        writer.close().expect("fixture close");
    }

    fn request(document_id: &str, session_id: &str, offset: i64) -> ReadPageRequest {
        ReadPageRequest {
            document_id: document_id.to_owned(),
            session_id: session_id.to_owned(),
            offset,
            limit: 200,
            columns: None,
        }
    }

    #[test]
    fn batch_open_preserves_order_and_partial_success() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.parquet");
        let invalid = directory.path().join("invalid.parquet");
        let second = directory.path().join("second.parquet");
        write_fixture(&first, vec![1]);
        std::fs::write(&invalid, b"invalid").unwrap();
        write_fixture(&second, vec![2]);
        let state = AppState::default();
        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("batch-1"),
                origin: OpenOrigin::DragDrop,
                paths: vec![first, invalid, second],
            })
            .unwrap();
        assert_eq!(response.opened.len(), 2);
        assert_eq!(response.opened[0].item_index, 0);
        assert_eq!(response.opened[1].item_index, 2);
        assert_eq!(response.failures.len(), 1);
        assert_eq!(response.failures[0].item_index, 1);
        assert_eq!(state.documents.len(), 2);
    }

    #[test]
    fn canonical_duplicate_reuses_document_and_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("same.parquet");
        write_fixture(&path, vec![7]);
        let state = AppState::default();
        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("dedupe-1"),
                origin: OpenOrigin::DragDrop,
                paths: vec![path.clone(), path],
            })
            .unwrap();
        assert_eq!(response.opened.len(), 2);
        assert_eq!(response.opened[0].disposition, OpenDisposition::Opened);
        assert_eq!(response.opened[1].disposition, OpenDisposition::Existing);
        assert_eq!(
            response.opened[0].document_id,
            response.opened[1].document_id
        );
        assert_eq!(response.opened[0].session_id, response.opened[1].session_id);
        assert_eq!(state.documents.len(), 1);
    }

    #[test]
    fn documents_read_and_close_independently() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.parquet");
        let second = directory.path().join("second.parquet");
        write_fixture(&first, vec![10]);
        write_fixture(&second, vec![20]);
        let state = AppState::default();
        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("independent-1"),
                origin: OpenOrigin::Dialog,
                paths: vec![first, second],
            })
            .unwrap();
        let a = &response.opened[0];
        let b = &response.opened[1];
        assert_eq!(
            state
                .read(request(&a.document_id, &a.session_id, 0))
                .unwrap()
                .page
                .rows[0][0]
                .display
                .as_deref(),
            Some("10")
        );
        state.close(&a.document_id, &a.session_id).unwrap();
        assert_eq!(
            state
                .read(request(&a.document_id, &a.session_id, 0))
                .unwrap_err()
                .code,
            DataErrorCode::DocumentClosed
        );
        assert!(state
            .read(request(&b.document_id, &b.session_id, 0))
            .is_ok());
    }

    #[test]
    fn csv_configure_changes_only_its_session_generation() {
        let directory = tempfile::tempdir().unwrap();
        let csv = directory.path().join("data.csv");
        let parquet = directory.path().join("data.parquet");
        std::fs::write(&csv, "name\nAlice\n").unwrap();
        write_fixture(&parquet, vec![1]);
        let state = AppState::default();
        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("configure-1"),
                origin: OpenOrigin::Dialog,
                paths: vec![csv, parquet],
            })
            .unwrap();
        let csv = &response.opened[0];
        let parquet = &response.opened[1];
        let configured = state
            .configure_csv(&csv.document_id, &csv.session_id, HeaderMode::Absent)
            .unwrap();
        assert_ne!(configured.session_id, csv.session_id);
        assert_eq!(
            state
                .read(request(&csv.document_id, &csv.session_id, 0))
                .unwrap_err()
                .code,
            DataErrorCode::StaleSession
        );
        assert!(state
            .read(request(&parquet.document_id, &parquet.session_id, 0))
            .is_ok());
    }

    #[test]
    fn batch_bounds_and_request_ids_are_validated_before_io() {
        let state = AppState::default();
        for paths in [Vec::new(), vec![PathBuf::from("missing.csv"); 33]] {
            let error = state
                .open_paths(OpenPathsRequest {
                    request_id: format!("bounds-{}", paths.len()),
                    origin: OpenOrigin::Dialog,
                    paths,
                })
                .unwrap_err();
            assert_eq!(error.code, DataErrorCode::InvalidRequest);
        }
        let request = OpenPathsRequest {
            request_id: String::from("duplicate-request"),
            origin: OpenOrigin::Dialog,
            paths: vec![PathBuf::from("missing.csv")],
        };
        state.open_paths(request.clone()).unwrap();
        assert_eq!(
            state.open_paths(request).unwrap_err().code,
            DataErrorCode::DuplicateOpenRequest
        );
    }

    #[test]
    fn response_serializes_the_phase8_batch_contract() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("contract.parquet");
        write_fixture(&path, vec![3]);
        let state = AppState::default();
        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("contract-1"),
                origin: OpenOrigin::StartupArg,
                paths: vec![path],
            })
            .unwrap();
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["requestId"], "contract-1");
        assert_eq!(json["opened"][0]["itemIndex"], 0);
        assert_eq!(json["opened"][0]["disposition"], "opened");
        assert!(json["opened"][0]["documentId"].is_string());
        assert!(json["opened"][0]["sessionId"].is_string());
        assert!(json["opened"][0]["summary"].is_object());
        assert!(json["opened"][0]["initialPage"].is_object());
    }

    #[test]
    fn bounded_parallel_prepare_preserves_input_order() {
        let directory = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..8)
            .map(|index| {
                let path = directory.path().join(format!("ordered-{index}.parquet"));
                write_fixture(&path, vec![index]);
                path
            })
            .collect();
        let state = AppState::default();
        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("parallel-order-1"),
                origin: OpenOrigin::Dialog,
                paths,
            })
            .unwrap();

        assert!(response.failures.is_empty());
        for (index, item) in response.opened.iter().enumerate() {
            assert_eq!(item.item_index, index);
            assert_eq!(
                item.initial_page.rows[0][0].display.as_deref(),
                Some(index.to_string().as_str())
            );
        }
        let max = source_prepare_limiter()
            .max_observed
            .load(Ordering::Relaxed);
        assert!((2..=MAX_CONCURRENT_SOURCE_PREPARES).contains(&max));
    }

    #[test]
    fn stale_generation_close_is_idempotent_and_releases_configured_csv() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("close-configure.csv");
        std::fs::write(&path, "name\nAlice\n").unwrap();
        let state = AppState::default();
        let opened = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("close-configure-1"),
                origin: OpenOrigin::Dialog,
                paths: vec![path],
            })
            .unwrap()
            .opened
            .remove(0);
        let configured = state
            .configure_csv(&opened.document_id, &opened.session_id, HeaderMode::Absent)
            .unwrap();

        state
            .close(&opened.document_id, &opened.session_id)
            .unwrap();
        state
            .close(&opened.document_id, &configured.session_id)
            .unwrap();
        assert_eq!(
            state
                .read(request(&opened.document_id, &configured.session_id, 0,))
                .unwrap_err()
                .code,
            DataErrorCode::DocumentClosed
        );
    }

    #[test]
    fn completed_close_then_same_path_open_creates_a_fresh_document() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("close-reopen.parquet");
        write_fixture(&path, vec![9]);
        let state = AppState::default();
        let first = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("close-reopen-1"),
                origin: OpenOrigin::Dialog,
                paths: vec![path.clone()],
            })
            .unwrap()
            .opened
            .remove(0);
        state.close(&first.document_id, &first.session_id).unwrap();
        let second = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("close-reopen-2"),
                origin: OpenOrigin::Dialog,
                paths: vec![path],
            })
            .unwrap()
            .opened
            .remove(0);

        assert_eq!(second.disposition, OpenDisposition::Opened);
        assert_ne!(second.document_id, first.document_id);
        assert_ne!(second.session_id, first.session_id);
    }

    #[test]
    fn late_open_cancellations_are_deduplicated_and_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("late-cancel.parquet");
        write_fixture(&path, vec![1]);
        let state = AppState::default();
        state
            .open_paths(OpenPathsRequest {
                request_id: String::from("completed-before-cancel"),
                origin: OpenOrigin::Dialog,
                paths: vec![path],
            })
            .unwrap();

        state.cancel_open("completed-before-cancel");
        state.cancel_open("completed-before-cancel");
        for index in 0..(COMPLETED_REQUEST_CAPACITY * 4) {
            state.cancel_open(&format!("late-cancel-{index}"));
        }

        let requests = state.cancelled_requests.lock().unwrap();
        assert_eq!(requests.len(), COMPLETED_REQUEST_CAPACITY);
        assert_eq!(
            requests.front().map(String::as_str),
            Some("late-cancel-768")
        );
        assert_eq!(
            requests.back().map(String::as_str),
            Some("late-cancel-1023")
        );
        assert!(!requests
            .iter()
            .any(|request| request == "completed-before-cancel"));
    }

    #[test]
    fn active_open_cancellation_is_consumed_after_the_batch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("active-cancel.parquet");
        write_fixture(&path, vec![1]);
        let state = AppState::default();
        state.cancel_open("active-cancel");

        let response = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("active-cancel"),
                origin: OpenOrigin::Dialog,
                paths: vec![path],
            })
            .unwrap();
        assert!(response.opened.is_empty());
        assert_eq!(response.failures.len(), 1);
        assert_eq!(
            response.failures[0].error.code,
            DataErrorCode::OpenRequestCancelled
        );
        assert!(state.cancelled_requests.lock().unwrap().is_empty());
    }

    #[test]
    fn read_response_serializes_page_as_a_nested_object() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("read-contract.parquet");
        write_fixture(&path, vec![11, 12]);
        let state = AppState::default();
        let opened = state
            .open_paths(OpenPathsRequest {
                request_id: String::from("read-contract-1"),
                origin: OpenOrigin::Dialog,
                paths: vec![path],
            })
            .unwrap()
            .opened
            .remove(0);
        let response = state
            .read(request(&opened.document_id, &opened.session_id, 0))
            .unwrap();
        let json = serde_json::to_value(response).unwrap();

        assert_eq!(json["documentId"], opened.document_id);
        assert_eq!(json["sessionId"], opened.session_id);
        assert!(json["page"].is_object());
        assert_eq!(json["page"]["offset"], 0);
        assert_eq!(json["page"]["rows"].as_array().unwrap().len(), 2);
        assert!(json.get("offset").is_none());
        assert!(json.get("rows").is_none());
    }
}
