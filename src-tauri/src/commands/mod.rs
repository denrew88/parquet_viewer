use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    sync::{Arc, Condvar, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{
    copy::{CopyManager, CopyRowReader, QueryCopyReader, SourceCopyReader, TauriClipboardWriter},
    data::{builtin_format_registry, DataSource},
    domain::{
        AppSettingsV1, BoundarySearchRequest, CancelDataBoundaryNavigationRequest,
        CopyOperationHistory, CopyOperationIdentity, CopyOperationStatus, CsvColumnValidation,
        CsvParsingProfile, CsvProfilePreview, CsvValidationState, CsvValidationStatus, DataError,
        DataErrorCode, DataPage, DataValue, DistinctValuesRequest, DistinctValuesResponse,
        ExecuteQueryRequest, FileSummary, FindBoundaryRequest, FindBoundaryResponse,
        FindQueryMatchRequest, FindQueryMatchResponse, FormatDescriptor, HeaderMode, QueryStatus,
        ReadQueryPageRequest, ReadQueryPageResponse, StartCopyRequest,
    },
    platform::{
        pick_data_file, pick_data_files, DocumentAccessError, DocumentRef, DocumentRegistry,
        PageCacheKey, PathReservation, PendingOpenQueue, ReservePath,
    },
    query::{CsvPreparationStatus, QueryService},
    storage::SettingsStore,
    storage::{QueryTempCleanupResult, QueryTempUsage},
};

const MAX_PAGE_ROWS: usize = 200;
const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_OPEN_BATCH: usize = 32;
const COMPLETED_REQUEST_CAPACITY: usize = 256;
const MAX_CONCURRENT_SOURCE_PREPARES: usize = 4;
const MAX_CSV_VALIDATION_TASKS: usize = 64;
const TEST_DATA_ROOT_ENV: &str = "DATA_VIEWER_TEST_DATA_ROOT";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ApplicationDirectoryKind {
    LocalData,
    Config,
}

fn test_data_directory(
    debug_assertions: bool,
    root: Option<std::ffi::OsString>,
    kind: ApplicationDirectoryKind,
) -> Option<PathBuf> {
    if !debug_assertions {
        return None;
    }
    let root = root.map(PathBuf::from)?;
    if root.as_os_str().is_empty() {
        return None;
    }
    Some(root.join(match kind {
        ApplicationDirectoryKind::LocalData => "local",
        ApplicationDirectoryKind::Config => "config",
    }))
}

fn application_directory(
    app: &AppHandle,
    kind: ApplicationDirectoryKind,
) -> Result<PathBuf, DataError> {
    if let Some(directory) = test_data_directory(
        cfg!(debug_assertions),
        std::env::var_os(TEST_DATA_ROOT_ENV),
        kind,
    ) {
        return Ok(directory);
    }
    let resolved = match kind {
        ApplicationDirectoryKind::LocalData => app.path().app_local_data_dir(),
        ApplicationDirectoryKind::Config => app.path().app_config_dir(),
    };
    resolved.map_err(|error| DataError {
        code: DataErrorCode::Io,
        message: format!(
            "The application {} directory is unavailable: {error}",
            match kind {
                ApplicationDirectoryKind::LocalData => "local data",
                ApplicationDirectoryKind::Config => "settings",
            }
        ),
    })
}

#[derive(Debug)]
struct CsvPreviewControl {
    generation: u64,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug)]
struct CsvValidationTask {
    status: CsvValidationStatus,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug)]
struct BoundaryNavigationTask {
    query_id: Option<String>,
    cancel: Arc<AtomicBool>,
}

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
    initial_projection: Option<Vec<String>>,
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
    std::thread::sleep(std::time::Duration::from_millis(25));
    let source = DataSource::open(path)?;
    let summary = source.summary();
    let initial_projection = initial_projection(&summary);
    let initial_page =
        source.read_page_projected(0, MAX_PAGE_ROWS, initial_projection.as_deref())?;
    Ok(PreparedSource {
        source,
        summary,
        initial_projection,
        initial_page,
    })
}

fn initial_projection(summary: &FileSummary) -> Option<Vec<String>> {
    let columns = summary
        .columns
        .iter()
        .take(MAX_PROJECTION_COLUMNS)
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    (!columns.is_empty()).then_some(columns)
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfilePreviewRequest {
    document_id: String,
    session_id: String,
    generation: u64,
    profile: CsvParsingProfile,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfilePreviewResponse {
    document_id: String,
    session_id: String,
    preview: CsvProfilePreview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfileResponse {
    document_id: String,
    session_id: String,
    profile: CsvParsingProfile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfileValidationRequest {
    task_id: String,
    document_id: String,
    session_id: String,
    generation: u64,
    profile: CsvParsingProfile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCsvProfileRequest {
    document_id: String,
    session_id: String,
    profile: CsvParsingProfile,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCellValueRequest {
    document_id: String,
    session_id: String,
    query_id: Option<String>,
    row: i64,
    column_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCellValueResponse {
    document_id: String,
    session_id: String,
    query_id: Option<String>,
    value: DataValue,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDocumentResponse {
    document_id: String,
    session_id: String,
}

#[derive(Default)]
pub struct AppState {
    documents: Arc<DocumentRegistry<DataSource>>,
    pending_opens: PendingOpenQueue,
    next_request_id: AtomicU64,
    completed_requests: Mutex<VecDeque<String>>,
    cancelled_requests: Mutex<VecDeque<String>>,
    csv_preview_tasks: Mutex<HashMap<(String, String), CsvPreviewControl>>,
    csv_validation_tasks: Arc<Mutex<HashMap<String, CsvValidationTask>>>,
    boundary_navigation_tasks: Mutex<HashMap<(String, String, String), BoundaryNavigationTask>>,
    query_service: Mutex<Option<Arc<QueryService>>>,
    copy_manager: Arc<CopyManager>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.copy_manager.cancel_all();
        if let Ok(service) = self.query_service.get_mut() {
            if let Some(service) = service.take() {
                service.shutdown();
            }
        }
    }
}

impl AppState {
    fn begin_boundary_navigation(
        &self,
        request: &FindBoundaryRequest,
    ) -> Result<Arc<AtomicBool>, DataError> {
        let key = (
            request.document_id.clone(),
            request.session_id.clone(),
            request.navigation_id.clone(),
        );
        let mut tasks = self
            .boundary_navigation_tasks
            .lock()
            .map_err(|_| DataError {
                code: DataErrorCode::Io,
                message: String::from("The boundary-navigation registry is unavailable."),
            })?;
        if tasks.contains_key(&key) {
            return Err(DataError::invalid_request(format!(
                "Boundary navigation ID is already active: {}",
                request.navigation_id
            )));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        tasks.insert(
            key,
            BoundaryNavigationTask {
                query_id: request.query_id.clone(),
                cancel: Arc::clone(&cancel),
            },
        );
        Ok(cancel)
    }

    fn finish_boundary_navigation(&self, request: &FindBoundaryRequest, cancel: &Arc<AtomicBool>) {
        if let Ok(mut tasks) = self.boundary_navigation_tasks.lock() {
            let key = (
                request.document_id.clone(),
                request.session_id.clone(),
                request.navigation_id.clone(),
            );
            if tasks
                .get(&key)
                .is_some_and(|task| Arc::ptr_eq(&task.cancel, cancel))
            {
                tasks.remove(&key);
            }
        }
    }

    fn cancel_boundary_navigation(
        &self,
        request: &CancelDataBoundaryNavigationRequest,
    ) -> Result<(), DataError> {
        validate_boundary_identity(
            &request.navigation_id,
            &request.document_id,
            &request.session_id,
            request.query_id.as_deref(),
        )?;
        self.documents
            .with_source(&request.document_id, &request.session_id, |_| ())
            .map_err(document_error)?;
        let tasks = self
            .boundary_navigation_tasks
            .lock()
            .map_err(|_| DataError {
                code: DataErrorCode::Io,
                message: String::from("The boundary-navigation registry is unavailable."),
            })?;
        let key = (
            request.document_id.clone(),
            request.session_id.clone(),
            request.navigation_id.clone(),
        );
        if let Some(task) = tasks.get(&key) {
            if task.query_id != request.query_id {
                return Err(DataError::invalid_request(
                    "Boundary navigation query identity does not match the active task.",
                ));
            }
            task.cancel.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub(crate) fn initialize_query_temp(&self, app: &AppHandle) -> Result<(), DataError> {
        let local_data = application_directory(app, ApplicationDirectoryKind::LocalData)?;
        let mut service = self.query_service.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The query service registry is unavailable."),
        })?;
        if service.is_none() {
            *service = Some(Arc::new(QueryService::open(
                local_data,
                crate::domain::DEFAULT_QUERY_TEMP_LIMIT_BYTES,
            )?));
        }
        Ok(())
    }

    fn query_service(&self, app: &AppHandle) -> Result<Arc<QueryService>, DataError> {
        let config = application_directory(app, ApplicationDirectoryKind::Config)?;
        let limit = match SettingsStore::new(config).load() {
            Ok(settings) => settings.query_temp_limit_bytes,
            Err(error) if error.code == DataErrorCode::SettingsInvalid => {
                crate::domain::DEFAULT_QUERY_TEMP_LIMIT_BYTES
            }
            Err(error) => return Err(error),
        };
        let mut service = self.query_service.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The query service registry is unavailable."),
        })?;
        if let Some(service) = service.as_ref() {
            service.set_temp_limit(limit);
            return Ok(Arc::clone(service));
        }
        let local_data = application_directory(app, ApplicationDirectoryKind::LocalData)?;
        let opened = Arc::new(QueryService::open(local_data, limit)?);
        *service = Some(Arc::clone(&opened));
        Ok(opened)
    }

    fn drop_queries_if_initialized(&self, document_id: &str, session_id: &str) {
        if let Ok(service) = self.query_service.lock() {
            if let Some(service) = service.as_ref() {
                let _ = service.drop_session(document_id, session_id);
            }
        }
    }

    fn initialized_query_service(&self) -> Option<Arc<QueryService>> {
        self.query_service
            .lock()
            .ok()
            .and_then(|service| service.as_ref().map(Arc::clone))
    }

    fn prepare_csv_if_initialized(
        &self,
        document_id: &str,
        session_id: &str,
    ) -> Result<Option<CsvPreparationStatus>, DataError> {
        let Some(service) = self.initialized_query_service() else {
            return Ok(None);
        };
        let source = self
            .documents
            .with_source(document_id, session_id, |source| source.query_source_spec())
            .map_err(document_error)??;
        if source.provider.reusable_source_identity().is_none() {
            return Ok(None);
        }
        service
            .prepare_csv_session(document_id, session_id, source)
            .map(Some)
    }

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
                    let _ = self.prepare_csv_if_initialized(&item.document_id, &item.session_id);
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
        let projection = initial_projection(&summary);
        let initial_page = self
            .documents
            .get_or_load_page(
                document_id,
                session_id,
                PageCacheKey::new(0, MAX_PAGE_ROWS, projection.clone()),
                |source| source.read_page_projected(0, MAX_PAGE_ROWS, projection.as_deref()),
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
                PageCacheKey::new(0, MAX_PAGE_ROWS, prepared.initial_projection),
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
        if let Some(service) = self.initialized_query_service() {
            let source = self
                .documents
                .with_source(&request.document_id, &request.session_id, |source| {
                    source.query_source_spec().ok()
                })
                .map_err(document_error)?;
            if let Some(source) = source {
                let implicit_columns = (projection.is_none()
                    && source.columns.len() <= MAX_PROJECTION_COLUMNS)
                    .then(|| {
                        source
                            .columns
                            .iter()
                            .map(|column| column.name.clone())
                            .collect::<Vec<_>>()
                    });
                let prepared_columns = projection.as_deref().or(implicit_columns.as_deref());
                if let Some(columns) = prepared_columns {
                    if let Some(page) = service.read_prepared_csv_page(
                        &request.document_id,
                        &request.session_id,
                        source,
                        offset,
                        request.limit,
                        columns,
                    )? {
                        return Ok(ReadPageResponse {
                            document_id: request.document_id,
                            session_id: request.session_id,
                            page,
                        });
                    }
                }
            }
        }
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
        self.copy_manager
            .cancel_session(document_id, session_id, false);
        self.drop_queries_if_initialized(document_id, session_id);
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
        self.drop_queries_if_initialized(document_id, session_id);
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

    fn active_csv_profile(
        &self,
        document_id: &str,
        session_id: &str,
    ) -> Result<CsvProfileResponse, DataError> {
        let profile = self
            .documents
            .with_source(document_id, session_id, DataSource::active_csv_profile)
            .map_err(document_error)??;
        Ok(CsvProfileResponse {
            document_id: document_id.to_owned(),
            session_id: session_id.to_owned(),
            profile,
        })
    }

    fn begin_csv_preview(
        &self,
        request: &CsvProfilePreviewRequest,
    ) -> Result<Arc<AtomicBool>, DataError> {
        if request.generation == 0 || request.generation != request.profile.generation {
            return Err(DataError::invalid_request(
                "CSV preview and profile generations must match and be positive.",
            ));
        }
        self.documents
            .with_source(&request.document_id, &request.session_id, |source| {
                source.active_csv_profile()
            })
            .map_err(document_error)??;
        let key = (request.document_id.clone(), request.session_id.clone());
        let mut tasks = self.csv_preview_tasks.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The CSV preview task registry is unavailable."),
        })?;
        if let Some(active) = tasks.get(&key) {
            if request.generation <= active.generation {
                return Err(DataError::invalid_request(
                    "CSV preview generation must increase for the active document session.",
                ));
            }
            active.cancel.store(true, Ordering::Release);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        tasks.insert(
            key,
            CsvPreviewControl {
                generation: request.generation,
                cancel: Arc::clone(&cancel),
            },
        );
        Ok(cancel)
    }

    fn finish_csv_preview(&self, request: &CsvProfilePreviewRequest) -> Result<(), DataError> {
        let key = (request.document_id.clone(), request.session_id.clone());
        let mut tasks = self.csv_preview_tasks.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The CSV preview task registry is unavailable."),
        })?;
        match tasks.get(&key) {
            Some(active) if active.generation == request.generation => {
                tasks.remove(&key);
                Ok(())
            }
            _ => Err(DataError::task_cancelled()),
        }
    }

    fn start_csv_validation(
        &self,
        request: CsvProfileValidationRequest,
    ) -> Result<CsvValidationStatus, DataError> {
        if request.task_id.trim().is_empty() || request.task_id.len() > 128 {
            return Err(DataError::invalid_request(
                "CSV validation task ID must contain 1 to 128 characters.",
            ));
        }
        if request.generation == 0 || request.generation != request.profile.generation {
            return Err(DataError::invalid_request(
                "CSV validation and profile generations must match and be positive.",
            ));
        }
        self.documents
            .with_source(&request.document_id, &request.session_id, |source| {
                source.active_csv_profile()
            })
            .map_err(document_error)??;
        let columns = request
            .profile
            .columns
            .iter()
            .map(|column| CsvColumnValidation {
                source_index: column.source_index,
                source_name: column.source_name.clone(),
                success_count: 0,
                null_count: 0,
                invalid_count: 0,
                first_error_row: None,
                error_samples: Vec::new(),
            })
            .collect();
        let status = CsvValidationStatus {
            task_id: request.task_id.clone(),
            document_id: request.document_id.clone(),
            session_id: request.session_id.clone(),
            generation: request.generation,
            state: CsvValidationState::Queued,
            rows_scanned: 0,
            total_rows: None,
            columns,
            error: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut tasks = self.csv_validation_tasks.lock().map_err(|_| DataError {
                code: DataErrorCode::Io,
                message: String::from("The CSV validation task registry is unavailable."),
            })?;
            if tasks.contains_key(&request.task_id) {
                return Err(DataError::invalid_request(format!(
                    "CSV validation task ID has already been used: {}",
                    request.task_id
                )));
            }
            if tasks.len() >= MAX_CSV_VALIDATION_TASKS {
                tasks.retain(|_, task| {
                    matches!(
                        task.status.state,
                        CsvValidationState::Queued | CsvValidationState::Running
                    )
                });
            }
            if tasks.len() >= MAX_CSV_VALIDATION_TASKS {
                return Err(DataError::invalid_request(format!(
                    "At most {MAX_CSV_VALIDATION_TASKS} CSV validation tasks may be retained."
                )));
            }
            tasks.insert(
                request.task_id.clone(),
                CsvValidationTask {
                    status: status.clone(),
                    cancel: Arc::clone(&cancel),
                },
            );
        }

        let documents = Arc::clone(&self.documents);
        let tasks = Arc::clone(&self.csv_validation_tasks);
        std::thread::spawn(move || {
            update_validation_task(&tasks, &request.task_id, |status| {
                status.state = CsvValidationState::Running;
            });
            let result = documents
                .with_source(&request.document_id, &request.session_id, |source| {
                    let mut progress =
                        |rows_scanned: u64,
                         total_rows: Option<u64>,
                         columns: &[CsvColumnValidation]| {
                            update_validation_task(&tasks, &request.task_id, |status| {
                                status.rows_scanned = rows_scanned;
                                status.total_rows = total_rows;
                                status.columns = columns.to_vec();
                            });
                        };
                    source.validate_csv_profile(&request.profile, &cancel, &mut progress)
                })
                .map_err(document_error)
                .and_then(|result| result);
            update_validation_task(&tasks, &request.task_id, |status| match result {
                Ok(columns) => {
                    status.columns = columns;
                    status.state = CsvValidationState::Complete;
                }
                Err(error) if error.code == DataErrorCode::TaskCancelled => {
                    status.state = CsvValidationState::Cancelled;
                    status.error = None;
                }
                Err(error) => {
                    status.state = CsvValidationState::Failed;
                    status.error = Some(error);
                }
            });
        });
        Ok(status)
    }

    fn csv_validation_status(
        &self,
        document_id: &str,
        session_id: &str,
        task_id: &str,
    ) -> Result<CsvValidationStatus, DataError> {
        self.documents
            .with_source(document_id, session_id, |_| ())
            .map_err(document_error)?;
        let tasks = self.csv_validation_tasks.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The CSV validation task registry is unavailable."),
        })?;
        let task = tasks.get(task_id).ok_or_else(|| {
            DataError::invalid_request(format!("CSV validation task not found: {task_id}"))
        })?;
        if task.status.document_id != document_id || task.status.session_id != session_id {
            return Err(DataError::invalid_request(
                "CSV validation task does not belong to the requested document session.",
            ));
        }
        Ok(task.status.clone())
    }

    fn cancel_csv_validation(
        &self,
        document_id: &str,
        session_id: &str,
        task_id: &str,
    ) -> Result<CsvValidationStatus, DataError> {
        let status = self.csv_validation_status(document_id, session_id, task_id)?;
        let tasks = self.csv_validation_tasks.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The CSV validation task registry is unavailable."),
        })?;
        if let Some(task) = tasks.get(task_id) {
            task.cancel.store(true, Ordering::Release);
        }
        Ok(status)
    }

    fn cancel_task(
        &self,
        document_id: &str,
        session_id: &str,
        generation: u64,
    ) -> Result<OpenFileResponse, DataError> {
        let summary = self
            .documents
            .with_source(document_id, session_id, |source| {
                source.cancel_task(generation)
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

fn update_validation_task(
    tasks: &Mutex<HashMap<String, CsvValidationTask>>,
    task_id: &str,
    update: impl FnOnce(&mut CsvValidationStatus),
) {
    if let Ok(mut tasks) = tasks.lock() {
        if let Some(task) = tasks.get_mut(task_id) {
            update(&mut task.status);
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

fn validate_boundary_identity(
    navigation_id: &str,
    document_id: &str,
    session_id: &str,
    query_id: Option<&str>,
) -> Result<(), DataError> {
    for (label, value) in [
        ("navigation", navigation_id),
        ("document", document_id),
        ("session", session_id),
    ] {
        if value.trim().is_empty() || value.len() > 128 {
            return Err(DataError::invalid_request(format!(
                "Boundary {label} ID must contain 1 to 128 characters."
            )));
        }
    }
    if query_id.is_some_and(|value| value.trim().is_empty() || value.len() > 128) {
        return Err(DataError::invalid_request(
            "Boundary query ID must contain 1 to 128 characters.",
        ));
    }
    Ok(())
}

fn validate_boundary_request(request: &FindBoundaryRequest) -> Result<(), DataError> {
    validate_boundary_identity(
        &request.navigation_id,
        &request.document_id,
        &request.session_id,
        request.query_id.as_deref(),
    )?;
    if request.row < 0 {
        return Err(DataError::invalid_request(
            "Boundary navigation row cannot be negative.",
        ));
    }
    if request.column_id.trim().is_empty() || request.column_id.len() > 16_384 {
        return Err(DataError::invalid_request(
            "Boundary column ID must contain 1 to 16384 characters.",
        ));
    }
    if request.visible_column_ids.is_empty() || request.visible_column_ids.len() > 8_192 {
        return Err(DataError::invalid_request(
            "Boundary navigation requires 1 to 8192 visible columns.",
        ));
    }
    if request
        .visible_column_ids
        .iter()
        .any(|column| column.is_empty() || column.len() > 16_384)
    {
        return Err(DataError::invalid_request(
            "Visible boundary column IDs must contain 1 to 16384 characters.",
        ));
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
pub fn list_supported_formats() -> Vec<FormatDescriptor> {
    builtin_format_registry().descriptors()
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<AppSettingsV1, DataError> {
    let directory = application_directory(&app, ApplicationDirectoryKind::Config)?;
    SettingsStore::new(directory).load()
}

#[tauri::command]
pub fn update_settings(
    settings: AppSettingsV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppSettingsV1, DataError> {
    let directory = application_directory(&app, ApplicationDirectoryKind::Config)?;
    let saved = SettingsStore::new(directory).save(&settings)?;
    if let Ok(service) = state.query_service.lock() {
        if let Some(service) = service.as_ref() {
            service.set_temp_limit(saved.query_temp_limit_bytes);
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn execute_query(
    request: ExecuteQueryRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<QueryStatus, DataError> {
    let source = state
        .documents
        .with_source(&request.document_id, &request.session_id, |source| {
            source.query_source_spec()
        })
        .map_err(document_error)??;
    request.plan.validate(&source.columns)?;
    state
        .copy_manager
        .cancel_session(&request.document_id, &request.session_id, true);
    state.query_service(&app)?.execute(request, source)
}

#[tauri::command]
pub fn start_copy(
    request: StartCopyRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CopyOperationStatus, DataError> {
    request.validate()?;
    let settings = get_settings(app.clone())?;
    if request.max_cells > settings.copy_limits.max_cells
        || request.max_bytes > settings.copy_limits.max_bytes
    {
        return Err(DataError::invalid_request(
            "Copy limits cannot exceed the active application settings snapshot.",
        ));
    }
    state
        .documents
        .with_source(&request.document_id, &request.session_id, |_| ())
        .map_err(document_error)?;
    let query_service = state.query_service(&app)?;
    let reader: Arc<dyn CopyRowReader> = if let Some(query_id) = request.query_id.clone() {
        Arc::new(QueryCopyReader::new(
            Arc::clone(&query_service),
            request.document_id.clone(),
            request.session_id.clone(),
            query_id,
        ))
    } else {
        Arc::new(SourceCopyReader::new(
            Arc::clone(&state.documents),
            Arc::clone(&query_service),
            request.document_id.clone(),
            request.session_id.clone(),
        ))
    };
    let staging_directory = query_service.copy_staging_directory();
    state.copy_manager.start_with_display_formats(
        request,
        reader,
        Arc::new(TauriClipboardWriter::new(app)),
        staging_directory,
        settings.display_formats,
    )
}

#[tauri::command]
pub fn get_copy_status(
    request: CopyOperationIdentity,
    state: State<'_, AppState>,
) -> Result<CopyOperationStatus, DataError> {
    state.copy_manager.status(&request)
}

#[tauri::command]
pub fn cancel_copy(
    request: CopyOperationIdentity,
    state: State<'_, AppState>,
) -> Result<CopyOperationStatus, DataError> {
    state.copy_manager.cancel(&request)
}

#[tauri::command]
pub fn get_copy_history(
    document_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<CopyOperationHistory, DataError> {
    state.copy_manager.history(&document_id, &session_id)
}

#[tauri::command]
pub fn get_query_status(
    document_id: String,
    session_id: String,
    query_id: String,
    task_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<QueryStatus, DataError> {
    state
        .documents
        .with_source(&document_id, &session_id, |_| ())
        .map_err(document_error)?;
    state
        .query_service(&app)?
        .status(&document_id, &session_id, &query_id, &task_id)
}

#[tauri::command]
pub fn read_query_page(
    request: ReadQueryPageRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReadQueryPageResponse, DataError> {
    state
        .documents
        .with_source(&request.document_id, &request.session_id, |_| ())
        .map_err(document_error)?;
    state.query_service(&app)?.read_page(request)
}

#[tauri::command]
pub fn list_distinct_values(
    request: DistinctValuesRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DistinctValuesResponse, DataError> {
    let source = state
        .documents
        .with_source(&request.document_id, &request.session_id, |source| {
            source.query_source_spec()
        })
        .map_err(document_error)??;
    state.query_service(&app)?.distinct(
        request.clone(),
        request.query_id.is_none().then_some(source),
    )
}

#[tauri::command]
pub fn cancel_query(
    document_id: String,
    session_id: String,
    query_id: String,
    task_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<QueryStatus, DataError> {
    state
        .documents
        .with_source(&document_id, &session_id, |_| ())
        .map_err(document_error)?;
    state
        .query_service(&app)?
        .cancel(&document_id, &session_id, &query_id, &task_id)
}

#[tauri::command]
pub fn find_query_match(
    request: FindQueryMatchRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<FindQueryMatchResponse, DataError> {
    state
        .documents
        .with_source(&request.document_id, &request.session_id, |_| ())
        .map_err(document_error)?;
    state.query_service(&app)?.find_match(request)
}

#[tauri::command]
pub async fn find_data_boundary(
    request: FindBoundaryRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<FindBoundaryResponse, DataError> {
    validate_boundary_request(&request)?;
    state
        .documents
        .with_source(&request.document_id, &request.session_id, |_| ())
        .map_err(document_error)?;
    let query_service = state.query_service(&app)?;
    let cancel = state.begin_boundary_navigation(&request)?;
    let search = BoundarySearchRequest {
        row: request.row as u64,
        column_id: request.column_id.clone(),
        visible_column_ids: request.visible_column_ids.clone(),
        direction: request.direction,
        mode: request.mode,
    };
    let documents = Arc::clone(&state.documents);
    let worker_request = request.clone();
    let worker_cancel = Arc::clone(&cancel);
    let resolved =
        tauri::async_runtime::spawn_blocking(move || match worker_request.query_id.as_deref() {
            Some(query_id) => query_service.find_boundary(
                &worker_request.document_id,
                &worker_request.session_id,
                query_id,
                &search,
                &worker_cancel,
            ),
            None => documents
                .with_source(
                    &worker_request.document_id,
                    &worker_request.session_id,
                    |source| {
                        if let Ok(spec) = source.query_source_spec() {
                            if let Some(result) = query_service.find_prepared_csv_boundary(
                                &worker_request.document_id,
                                &worker_request.session_id,
                                spec,
                                &search,
                                &worker_cancel,
                            )? {
                                return Ok(result);
                            }
                        }
                        source.find_boundary(&search, &worker_cancel)
                    },
                )
                .map_err(document_error)
                .and_then(|result| result),
        })
        .await
        .map_err(|error| DataError {
            code: DataErrorCode::Io,
            message: format!("The boundary-navigation worker failed: {error}"),
        });
    state.finish_boundary_navigation(&request, &cancel);
    let resolved = resolved??;
    Ok(FindBoundaryResponse {
        navigation_id: request.navigation_id,
        document_id: request.document_id,
        session_id: request.session_id,
        query_id: request.query_id,
        target_row: resolved.target_row,
        target_column_id: resolved.target_column_id,
        resolved_row_count: resolved.resolved_row_count,
    })
}

#[tauri::command]
pub fn cancel_data_boundary_navigation(
    request: CancelDataBoundaryNavigationRequest,
    state: State<'_, AppState>,
) -> Result<(), DataError> {
    state.cancel_boundary_navigation(&request)
}

#[tauri::command]
pub fn get_query_temp_usage(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<QueryTempUsage, DataError> {
    state.query_service(&app)?.usage()
}

#[tauri::command]
pub fn clear_query_temp(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<QueryTempCleanupResult, DataError> {
    state.query_service(&app)?.clear_temp()
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
pub fn read_cell_value(
    request: ReadCellValueRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReadCellValueResponse, DataError> {
    let row = u64::try_from(request.row)
        .map_err(|_| DataError::invalid_request("Cell row must be non-negative."))?;
    let value = if let Some(query_id) = request.query_id.as_deref() {
        state
            .documents
            .with_source(&request.document_id, &request.session_id, |_| ())
            .map_err(document_error)?;
        state.query_service(&app)?.read_cell_value(
            &request.document_id,
            &request.session_id,
            query_id,
            row,
            &request.column_id,
        )?
    } else {
        state
            .documents
            .with_source(&request.document_id, &request.session_id, |source| {
                source.read_cell_value(row, &request.column_id)
            })
            .map_err(document_error)??
    };
    Ok(ReadCellValueResponse {
        document_id: request.document_id,
        session_id: request.session_id,
        query_id: request.query_id,
        value,
    })
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, DataError> {
    let response = state.configure_csv(&document_id, &session_id, header_mode)?;
    if let Ok(source) = state
        .documents
        .with_source(&response.document_id, &response.session_id, |source| {
            source.query_source_spec()
        })
        .map_err(document_error)
        .and_then(|source| source)
    {
        if let Ok(service) = state.query_service(&app) {
            let _ =
                service.prepare_csv_session(&response.document_id, &response.session_id, source);
        }
    }
    Ok(response)
}

#[tauri::command]
pub fn get_csv_profile(
    document_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<CsvProfileResponse, DataError> {
    state.active_csv_profile(&document_id, &session_id)
}

#[tauri::command]
pub async fn preview_csv_profile(
    request: CsvProfilePreviewRequest,
    state: State<'_, AppState>,
) -> Result<CsvProfilePreviewResponse, DataError> {
    let cancel = state.begin_csv_preview(&request)?;
    let documents = Arc::clone(&state.documents);
    let worker_request = request.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        documents
            .with_source(
                &worker_request.document_id,
                &worker_request.session_id,
                |source| {
                    source.preview_csv_profile(
                        &worker_request.profile,
                        worker_request.generation,
                        &cancel,
                    )
                },
            )
            .map_err(document_error)?
    })
    .await
    .map_err(|error| DataError {
        code: DataErrorCode::Io,
        message: format!("The CSV preview worker failed: {error}"),
    })?;
    state.finish_csv_preview(&request)?;
    Ok(CsvProfilePreviewResponse {
        document_id: request.document_id,
        session_id: request.session_id,
        preview: result?,
    })
}

#[tauri::command]
pub fn validate_csv_profile(
    request: CsvProfileValidationRequest,
    state: State<'_, AppState>,
) -> Result<CsvValidationStatus, DataError> {
    state.start_csv_validation(request)
}

#[tauri::command]
pub fn get_csv_profile_validation_status(
    document_id: String,
    session_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> Result<CsvValidationStatus, DataError> {
    state.csv_validation_status(&document_id, &session_id, &task_id)
}

#[tauri::command]
pub fn cancel_csv_profile_validation(
    document_id: String,
    session_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> Result<CsvValidationStatus, DataError> {
    state.cancel_csv_validation(&document_id, &session_id, &task_id)
}

#[tauri::command]
pub async fn apply_csv_profile(
    request: ApplyCsvProfileRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OpenFileResponse, DataError> {
    let documents = Arc::clone(&state.documents);
    let worker_request = request.clone();
    let source = tauri::async_runtime::spawn_blocking(move || {
        documents
            .with_source(
                &worker_request.document_id,
                &worker_request.session_id,
                |source| source.prepare_csv_profile(&worker_request.profile),
            )
            .map_err(document_error)?
    })
    .await
    .map_err(|error| DataError {
        code: DataErrorCode::Io,
        message: format!("The CSV profile apply worker failed: {error}"),
    })??;
    let summary = source.summary();
    state.drop_queries_if_initialized(&request.document_id, &request.session_id);
    let session_id = state
        .documents
        .replace_source(&request.document_id, &request.session_id, source)
        .map_err(document_error)?;
    let response = OpenFileResponse {
        document_id: request.document_id,
        session_id,
        summary,
    };
    if let Ok(source) = state
        .documents
        .with_source(&response.document_id, &response.session_id, |source| {
            source.query_source_spec()
        })
        .map_err(document_error)
        .and_then(|source| source)
    {
        if let Ok(service) = state.query_service(&app) {
            let _ =
                service.prepare_csv_session(&response.document_id, &response.session_id, source);
        }
    }
    Ok(response)
}

#[tauri::command]
pub fn prepare_csv_session(
    document_id: String,
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CsvPreparationStatus, DataError> {
    let source = state
        .documents
        .with_source(&document_id, &session_id, |source| {
            source.query_source_spec()
        })
        .map_err(document_error)??;
    state
        .query_service(&app)?
        .prepare_csv_session(&document_id, &session_id, source)
}

#[tauri::command]
pub fn get_csv_preparation_status(
    document_id: String,
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<CsvPreparationStatus>, DataError> {
    state
        .documents
        .with_source(&document_id, &session_id, |_| ())
        .map_err(document_error)?;
    state
        .query_service(&app)?
        .csv_preparation_status(&document_id, &session_id)
}

#[tauri::command]
pub fn cancel_csv_preparation(
    document_id: String,
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<CsvPreparationStatus>, DataError> {
    state
        .documents
        .with_source(&document_id, &session_id, |_| ())
        .map_err(document_error)?;
    state
        .query_service(&app)?
        .cancel_csv_preparation(&document_id, &session_id)
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
    use std::{
        fs::File,
        sync::Arc,
        time::{Duration, Instant},
    };

    use crate::domain::{
        CsvConversionFailurePolicy, CsvProfileMode, CsvTargetType, CsvValidationState,
        DataValueState, SourceCapability, ValueKind,
    };

    #[test]
    fn debug_test_data_root_separates_local_and_config_directories() {
        let root = std::ffi::OsString::from("C:/workspace/.tmp/phase13-native-data");
        assert_eq!(
            test_data_directory(
                true,
                Some(root.clone()),
                ApplicationDirectoryKind::LocalData,
            ),
            Some(PathBuf::from(&root).join("local"))
        );
        assert_eq!(
            test_data_directory(true, Some(root.clone()), ApplicationDirectoryKind::Config),
            Some(PathBuf::from(root).join("config"))
        );
        assert_eq!(
            test_data_directory(
                true,
                Some(std::ffi::OsString::new()),
                ApplicationDirectoryKind::LocalData,
            ),
            None
        );
    }

    #[test]
    fn release_build_contract_ignores_test_data_root() {
        let root = std::ffi::OsString::from("C:/must-not-be-used-by-release");
        assert_eq!(
            test_data_directory(false, Some(root), ApplicationDirectoryKind::LocalData),
            None,
            "release behavior must ignore DATA_VIEWER_TEST_DATA_ROOT completely"
        );
    }

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

    #[test]
    fn supported_formats_command_serializes_registry_descriptors() {
        let formats = list_supported_formats();
        let json = serde_json::to_value(formats).unwrap();

        assert_eq!(json.as_array().unwrap().len(), 3);
        assert_eq!(json[0]["id"], "csv");
        assert_eq!(json[0]["extensions"][0], "csv");
        assert_eq!(json[1]["id"], "parquet");
        assert_eq!(json[1]["extensions"][0], "parquet");
        assert_eq!(json[2]["id"], "oesHdf5");
        assert_eq!(json[2]["extensions"], serde_json::json!(["h5", "hdf5"]));
        assert_eq!(
            json[2]["capabilities"],
            serde_json::json!(["typedSchema", "columnProjection"])
        );
        assert!(list_supported_formats()[0]
            .capabilities
            .contains(&SourceCapability::ParsingProfile));
    }

    fn open_profile_csv(state: &AppState, path: &Path) -> OpenFileResponse {
        std::fs::write(
            path,
            "id,amount,flag,event_date\n001,12.50,true,2024-02-29\n002,bad,false,2024-03-01\n003,NULL,true,2024-03-02\n",
        )
        .unwrap();
        state.open_path(path).unwrap()
    }

    fn custom_profile(
        state: &AppState,
        opened: &OpenFileResponse,
        generation: u64,
    ) -> CsvParsingProfile {
        let mut profile = state
            .active_csv_profile(&opened.document_id, &opened.session_id)
            .unwrap()
            .profile;
        profile.mode = CsvProfileMode::Custom;
        profile.generation = generation;
        profile.columns[0].target_type = CsvTargetType::Text;
        profile.columns[1].target_type = CsvTargetType::Decimal;
        profile.columns[2].target_type = CsvTargetType::Boolean;
        profile.columns[3].target_type = CsvTargetType::Date;
        profile
    }

    fn wait_validation(
        state: &AppState,
        document_id: &str,
        session_id: &str,
        task_id: &str,
    ) -> CsvValidationStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = state
                .csv_validation_status(document_id, session_id, task_id)
                .unwrap();
            if !matches!(
                status.state,
                CsvValidationState::Queued | CsvValidationState::Running
            ) {
                return status;
            }
            assert!(Instant::now() < deadline, "CSV validation timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn csv_004_009_011_preview_exposes_typed_null_invalid_and_latest_generation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preview.csv");
        let state = AppState::default();
        let opened = open_profile_csv(&state, &path);
        let profile = custom_profile(&state, &opened, 2);
        let request = CsvProfilePreviewRequest {
            document_id: opened.document_id.clone(),
            session_id: opened.session_id.clone(),
            generation: 2,
            profile: profile.clone(),
        };
        let cancel = state.begin_csv_preview(&request).unwrap();
        let preview = state
            .documents
            .with_source(&opened.document_id, &opened.session_id, |source| {
                source.preview_csv_profile(&profile, 2, &cancel)
            })
            .unwrap()
            .unwrap();
        state.finish_csv_preview(&request).unwrap();

        assert!(preview.rows.len() <= 1_000);
        assert_eq!(preview.columns[1].invalid_count, 1);
        assert_eq!(preview.columns[1].null_count, 1);
        let invalid = &preview.rows[1].cells[1].converted;
        assert_eq!(invalid.state, DataValueState::Invalid);
        assert_eq!(invalid.raw_display.as_deref(), Some("bad"));
        assert!(invalid.diagnostic.is_some());
        assert_eq!(
            preview.rows[2].cells[1].converted.state,
            DataValueState::Null
        );

        let older = CsvProfilePreviewRequest {
            generation: 3,
            profile: CsvParsingProfile {
                generation: 3,
                ..profile.clone()
            },
            ..request.clone()
        };
        let old_cancel = state.begin_csv_preview(&older).unwrap();
        let newest = CsvProfilePreviewRequest {
            generation: 4,
            profile: CsvParsingProfile {
                generation: 4,
                ..profile
            },
            ..request
        };
        state.begin_csv_preview(&newest).unwrap();
        assert!(old_cancel.load(Ordering::Acquire));
        assert_eq!(
            state.finish_csv_preview(&older).unwrap_err().code,
            DataErrorCode::TaskCancelled
        );
        state.finish_csv_preview(&newest).unwrap();
    }

    #[test]
    fn csv_query_small_preview_serializes_the_frontend_wire_contract() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/phase-9/query-small.csv");
        let state = AppState::default();
        let opened = state.open_path(&path).unwrap();
        let mut profile = state
            .active_csv_profile(&opened.document_id, &opened.session_id)
            .unwrap()
            .profile;
        profile.generation += 1;
        let request = CsvProfilePreviewRequest {
            document_id: opened.document_id.clone(),
            session_id: opened.session_id.clone(),
            generation: profile.generation,
            profile: profile.clone(),
        };
        let cancel = state.begin_csv_preview(&request).unwrap();
        let preview = state
            .documents
            .with_source(&opened.document_id, &opened.session_id, |source| {
                source.preview_csv_profile(&profile, profile.generation, &cancel)
            })
            .unwrap()
            .unwrap();
        state.finish_csv_preview(&request).unwrap();
        let json = serde_json::to_value(CsvProfilePreviewResponse {
            document_id: opened.document_id,
            session_id: opened.session_id,
            preview,
        })
        .unwrap();

        assert_eq!(json["preview"]["columns"][0]["recommendedType"], "uint64");
        assert!(json["preview"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|column| column["recommendedType"] != "uInt64"));
        let column_count = json["preview"]["columns"].as_array().unwrap().len();
        assert_eq!(column_count, 8);
        assert!(json["preview"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["cells"].as_array().unwrap().len() == column_count));
        assert_eq!(
            json["preview"]["rows"][0]["cells"][0]["converted"]["state"],
            "valid"
        );
    }

    #[test]
    fn csv_014_015_validation_reports_all_rows_and_can_be_cancelled() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("validate.csv");
        let state = AppState::default();
        let opened = open_profile_csv(&state, &path);
        let profile = custom_profile(&state, &opened, 2);
        let accepted = state
            .start_csv_validation(CsvProfileValidationRequest {
                task_id: String::from("validation-1"),
                document_id: opened.document_id.clone(),
                session_id: opened.session_id.clone(),
                generation: 2,
                profile,
            })
            .unwrap();
        assert_eq!(accepted.state, CsvValidationState::Queued);
        let complete = wait_validation(
            &state,
            &opened.document_id,
            &opened.session_id,
            "validation-1",
        );
        assert_eq!(complete.state, CsvValidationState::Complete);
        assert_eq!(complete.rows_scanned, 3);
        assert_eq!(complete.columns[1].invalid_count, 1);
        assert_eq!(complete.columns[1].first_error_row, Some(1));
        assert_eq!(complete.columns[1].error_samples.len(), 1);

        let mut cancel_profile = state
            .active_csv_profile(&opened.document_id, &opened.session_id)
            .unwrap()
            .profile;
        cancel_profile.generation = 3;
        state
            .start_csv_validation(CsvProfileValidationRequest {
                task_id: String::from("validation-cancel"),
                document_id: opened.document_id.clone(),
                session_id: opened.session_id.clone(),
                generation: 3,
                profile: cancel_profile,
            })
            .unwrap();
        state
            .cancel_csv_validation(&opened.document_id, &opened.session_id, "validation-cancel")
            .unwrap();
        let cancelled = wait_validation(
            &state,
            &opened.document_id,
            &opened.session_id,
            "validation-cancel",
        );
        assert!(matches!(
            cancelled.state,
            CsvValidationState::Cancelled | CsvValidationState::Complete
        ));
    }

    #[test]
    fn csv_016_019_020_apply_is_atomic_source_preserving_and_document_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first.csv");
        let second_path = directory.path().join("second.csv");
        let state = AppState::default();
        let first = open_profile_csv(&state, &first_path);
        let second = open_profile_csv(&state, &second_path);
        let original = std::fs::read(&first_path).unwrap();

        let mut all_text = state
            .active_csv_profile(&second.document_id, &second.session_id)
            .unwrap()
            .profile;
        all_text.mode = CsvProfileMode::AllText;
        all_text.generation = 2;
        for column in &mut all_text.columns {
            column.target_type = CsvTargetType::Boolean;
        }
        let all_text_source = state
            .documents
            .with_source(&second.document_id, &second.session_id, |source| {
                source.prepare_csv_profile(&all_text)
            })
            .unwrap()
            .unwrap();
        let all_text_page = all_text_source.read_page_projected(0, 3, None).unwrap();
        assert!(all_text_page
            .rows
            .iter()
            .flatten()
            .filter(|value| value.state != DataValueState::Null)
            .all(|value| value.kind == ValueKind::String));

        let profile = custom_profile(&state, &first, 2);
        let source = state
            .documents
            .with_source(&first.document_id, &first.session_id, |source| {
                source.prepare_csv_profile(&profile)
            })
            .unwrap()
            .unwrap();
        let new_session = state
            .documents
            .replace_source(&first.document_id, &first.session_id, source)
            .unwrap();

        assert_ne!(new_session, first.session_id);
        assert_eq!(std::fs::read(&first_path).unwrap(), original);
        assert_eq!(
            state
                .read(request(&first.document_id, &first.session_id, 0))
                .unwrap_err()
                .code,
            DataErrorCode::StaleSession
        );
        let page = state
            .read(request(&first.document_id, &new_session, 0))
            .unwrap()
            .page;
        assert_eq!(page.rows[0][1].kind, ValueKind::Decimal);
        assert_eq!(page.rows[1][1].state, DataValueState::Invalid);
        assert_eq!(
            state
                .active_csv_profile(&second.document_id, &second.session_id)
                .unwrap()
                .profile
                .mode,
            CsvProfileMode::Auto
        );

        let mut fail_profile = state
            .active_csv_profile(&first.document_id, &new_session)
            .unwrap()
            .profile;
        fail_profile.generation = 3;
        fail_profile.columns[1].failure_policy = CsvConversionFailurePolicy::Fail;
        assert_eq!(
            state
                .documents
                .with_source(&first.document_id, &new_session, |source| {
                    source.prepare_csv_profile(&fail_profile)
                })
                .unwrap()
                .unwrap_err()
                .code,
            DataErrorCode::InvalidRequest
        );
        assert_eq!(std::fs::read(&first_path).unwrap(), original);
        assert_eq!(
            state
                .read(request(&first.document_id, &new_session, 0))
                .unwrap()
                .page
                .rows[1][1]
                .state,
            DataValueState::Invalid
        );
    }

    #[test]
    fn csv_numeric_profile_matrix_reaches_preview_apply_new_session_and_page() {
        let cases = [
            ("auto", CsvTargetType::Auto),
            ("int64", CsvTargetType::Int64),
            ("uint64", CsvTargetType::UInt64),
            ("float64", CsvTargetType::Float64),
            ("decimal", CsvTargetType::Decimal),
        ]
        .into_iter()
        .flat_map(|(target_name, target)| {
            [
                ("none", None, ".", "10001"),
                ("comma", Some(","), ".", "10,001"),
                ("dot", Some("."), ",", "10.001"),
                ("space", Some(" "), ".", "10 001"),
            ]
            .into_iter()
            .map(move |(separator_name, separator, decimal, expected)| {
                (
                    format!("{target_name}_{separator_name}"),
                    target,
                    separator,
                    decimal,
                    expected,
                )
            })
        })
        .collect::<Vec<_>>();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("numeric-profile-matrix.csv");
        let header = cases
            .iter()
            .map(|(name, ..)| name.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let row = |value: &str| vec![value; cases.len()].join(",");
        let mixed_invalid = cases
            .iter()
            .map(|(_, target, ..)| {
                if *target == CsvTargetType::Auto {
                    "3"
                } else {
                    "bad"
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        std::fs::write(
            &path,
            format!(
                "{header}\n{}\n{}\n{mixed_invalid}\n{}\n{}\n",
                row("10001"),
                row("2"),
                row("NULL"),
                row("")
            ),
        )
        .unwrap();

        let state = AppState::default();
        let opened = state.open_path(&path).unwrap();
        let mut profile = state
            .active_csv_profile(&opened.document_id, &opened.session_id)
            .unwrap()
            .profile;
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        for (column, (_, target, separator, decimal, _)) in profile.columns.iter_mut().zip(&cases) {
            column.target_type = *target;
            column.thousand_separator = separator.map(str::to_owned);
            column.decimal_separator = (*decimal).to_owned();
        }

        let preview = state
            .documents
            .with_source(&opened.document_id, &opened.session_id, |source| {
                source.preview_csv_profile(&profile, profile.generation, &AtomicBool::new(false))
            })
            .unwrap()
            .unwrap();
        for (index, (_, target, _, _, expected)) in cases.iter().enumerate() {
            let resolved = if *target == CsvTargetType::Auto {
                CsvTargetType::UInt64
            } else {
                *target
            };
            assert_eq!(preview.columns[index].target_type, resolved);
            assert_eq!(
                preview.rows[0].cells[index].converted.display.as_deref(),
                Some(*expected)
            );
            let mixed_state = preview.rows[2].cells[index].converted.state;
            assert_eq!(
                mixed_state,
                if *target == CsvTargetType::Auto {
                    DataValueState::Valid
                } else {
                    DataValueState::Invalid
                }
            );
            assert_eq!(
                preview.rows[3].cells[index].converted.state,
                DataValueState::Null
            );
            assert_eq!(
                preview.rows[4].cells[index].converted.state,
                DataValueState::Empty
            );
        }

        let source = state
            .documents
            .with_source(&opened.document_id, &opened.session_id, |source| {
                source.prepare_csv_profile(&profile)
            })
            .unwrap()
            .unwrap();
        let new_session = state
            .documents
            .replace_source(&opened.document_id, &opened.session_id, source)
            .unwrap();
        assert_ne!(new_session, opened.session_id);
        assert_eq!(
            state
                .read(request(&opened.document_id, &opened.session_id, 0))
                .unwrap_err()
                .code,
            DataErrorCode::StaleSession
        );
        let page = state
            .read(request(&opened.document_id, &new_session, 0))
            .unwrap()
            .page;
        for (index, (_, target, _, _, expected)) in cases.iter().enumerate() {
            assert_eq!(page.rows[0][index].display.as_deref(), Some(*expected));
            assert_eq!(
                page.rows[2][index].state,
                if *target == CsvTargetType::Auto {
                    DataValueState::Valid
                } else {
                    DataValueState::Invalid
                }
            );
            assert_eq!(page.rows[3][index].state, DataValueState::Null);
            assert_eq!(page.rows[4][index].state, DataValueState::Empty);
        }
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

    #[test]
    fn app_state_drop_shuts_down_query_service_within_contract() {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(
            QueryService::open(
                directory.path(),
                crate::domain::DEFAULT_QUERY_TEMP_LIMIT_BYTES,
            )
            .unwrap(),
        );
        let state = AppState::default();
        *state.query_service.lock().unwrap() = Some(Arc::clone(&service));

        let started = std::time::Instant::now();
        drop(state);

        assert!(service.is_shutting_down());
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }
}
