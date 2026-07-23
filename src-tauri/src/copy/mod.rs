use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    data::DataSource,
    domain::{
        copy_value_text, BooleanRepresentation, CopyEscapeMode, CopyFailure, CopyFailureReason,
        CopyLineEnding, CopyOperationHistory, CopyOperationIdentity, CopyOperationStage,
        CopyOperationState, CopyOperationStatus, CopyOptionsSnapshot, CopyQuoteMode, DataError,
        DataErrorCode, DataPage, DataValue, DateTimeRepresentation, DisplayFormats,
        EmptyStringRepresentation, StartCopyRequest, ValueKind, COPY_HISTORY_CAPACITY,
        COPY_MAX_BATCH_CELLS, COPY_MAX_BATCH_ESTIMATED_BYTES,
    },
    platform::{DocumentAccessError, DocumentRegistry},
    query::QueryService,
};

pub trait ClipboardWriter: Send + Sync + 'static {
    fn write_text(&self, text: String) -> Result<(), String>;
}

#[derive(Clone)]
pub struct TauriClipboardWriter {
    app: AppHandle,
}

impl TauriClipboardWriter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ClipboardWriter for TauriClipboardWriter {
    fn write_text(&self, text: String) -> Result<(), String> {
        self.app
            .clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())
    }
}

/// Copy owns a bulk row reader rather than a frontend page callback. Providers can
/// replace this adapter with a format-specific hyperslab/row-group implementation
/// without changing operation, staging, cancellation, or clipboard atomicity.
pub trait CopyRowReader: Send + Sync + 'static {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError>;

    fn validate_current(&self) -> Result<(), DataError> {
        Ok(())
    }
}

pub struct SourceCopyReader {
    documents: Arc<DocumentRegistry<DataSource>>,
    // Keep the process-owned temp directory (and its owner lock) alive for the
    // entire source-copy task, just as QueryCopyReader does for query copies.
    query_service: Arc<QueryService>,
    document_id: String,
    session_id: String,
}

impl SourceCopyReader {
    pub fn new(
        documents: Arc<DocumentRegistry<DataSource>>,
        temp_owner: Arc<QueryService>,
        document_id: String,
        session_id: String,
    ) -> Self {
        Self {
            documents,
            query_service: temp_owner,
            document_id,
            session_id,
        }
    }
}

impl CopyRowReader for SourceCopyReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.documents
            .with_source(&self.document_id, &self.session_id, |source| {
                if let Ok(spec) = source.query_source_spec() {
                    if let Some(page) = self.query_service.read_prepared_csv_copy(
                        &self.document_id,
                        &self.session_id,
                        spec,
                        offset,
                        limit,
                        columns,
                    )? {
                        return Ok(page);
                    }
                }
                source.read_copy_projected(offset, limit, columns)
            })
            .map_err(document_error)?
    }

    fn validate_current(&self) -> Result<(), DataError> {
        self.documents
            .with_source(&self.document_id, &self.session_id, |_| ())
            .map_err(document_error)
    }
}

pub struct QueryCopyReader {
    service: Arc<QueryService>,
    document_id: String,
    session_id: String,
    query_id: String,
}

impl QueryCopyReader {
    pub fn new(
        service: Arc<QueryService>,
        document_id: String,
        session_id: String,
        query_id: String,
    ) -> Self {
        Self {
            service,
            document_id,
            session_id,
            query_id,
        }
    }
}

impl CopyRowReader for QueryCopyReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.service.read_copy_rows(
            &self.document_id,
            &self.session_id,
            &self.query_id,
            offset,
            limit,
            columns,
        )
    }

    fn validate_current(&self) -> Result<(), DataError> {
        self.service
            .validate_result_identity(&self.document_id, &self.session_id, &self.query_id)
    }
}

#[derive(Default)]
pub struct CopyManager {
    state: Arc<Mutex<CopyRegistry>>,
    commit_gate: Arc<Mutex<()>>,
}

#[derive(Default)]
struct CopyRegistry {
    operations: HashMap<String, CopyEntry>,
    current: HashMap<(String, String), String>,
    previous: HashMap<(String, String), VecDeque<String>>,
}

struct CopyEntry {
    status: CopyOperationStatus,
    cancel: Arc<AtomicBool>,
}

impl CopyManager {
    #[cfg(test)]
    pub fn start(
        &self,
        request: StartCopyRequest,
        reader: Arc<dyn CopyRowReader>,
        clipboard: Arc<dyn ClipboardWriter>,
        staging_directory: PathBuf,
    ) -> Result<CopyOperationStatus, DataError> {
        self.start_with_display_formats(
            request,
            reader,
            clipboard,
            staging_directory,
            DisplayFormats::default(),
        )
    }

    pub fn start_with_display_formats(
        &self,
        request: StartCopyRequest,
        reader: Arc<dyn CopyRowReader>,
        clipboard: Arc<dyn ClipboardWriter>,
        staging_directory: PathBuf,
        display_formats: DisplayFormats,
    ) -> Result<CopyOperationStatus, DataError> {
        request.validate()?;
        let key = (request.document_id.clone(), request.session_id.clone());
        let cancel = Arc::new(AtomicBool::new(false));
        let mut status = CopyOperationStatus::queued(&request);
        {
            let mut registry = self.registry()?;
            if registry.operations.contains_key(&request.operation_id) {
                return Err(DataError::invalid_request(format!(
                    "Copy operation ID has already been used: {}",
                    request.operation_id
                )));
            }
            if let Some(active_id) = registry.current.get(&key) {
                if registry
                    .operations
                    .get(active_id)
                    .is_some_and(|entry| !entry.status.state.is_terminal())
                {
                    return Err(DataError::invalid_request(
                        "A copy operation is already active for this document session.",
                    ));
                }
            }
            if let Some(previous_current) = registry
                .current
                .insert(key.clone(), request.operation_id.clone())
            {
                let history = registry.previous.entry(key.clone()).or_default();
                history.push_front(previous_current);
                let mut expired_operations = Vec::new();
                while history.len() > COPY_HISTORY_CAPACITY {
                    if let Some(expired) = history.pop_back() {
                        expired_operations.push(expired);
                    }
                }
                for expired in expired_operations {
                    registry.operations.remove(&expired);
                }
            }
            if request
                .selected_cell_count()
                .is_none_or(|cells| cells > request.max_cells)
            {
                status.state = CopyOperationState::Failed;
                status.failure = Some(CopyFailure {
                    reason: CopyFailureReason::SelectionLimit,
                    message: format!(
                        "The selection exceeds the configured {}-cell copy limit.",
                        request.max_cells
                    ),
                });
            }
            registry.operations.insert(
                request.operation_id.clone(),
                CopyEntry {
                    status: status.clone(),
                    cancel: Arc::clone(&cancel),
                },
            );
        }
        if status.state.is_terminal() {
            return Ok(status);
        }

        let state = Arc::clone(&self.state);
        let commit_gate = Arc::clone(&self.commit_gate);
        std::thread::spawn(move || {
            run_copy(
                request,
                cancel,
                CopyRuntime {
                    state,
                    commit_gate,
                    display_formats,
                    reader,
                    clipboard,
                    staging_directory,
                },
            );
        });
        Ok(status)
    }

    pub fn status(
        &self,
        identity: &CopyOperationIdentity,
    ) -> Result<CopyOperationStatus, DataError> {
        identity.validate()?;
        let registry = self.registry()?;
        let entry = registry
            .operations
            .get(&identity.operation_id)
            .ok_or_else(|| DataError::invalid_request("Copy operation was not found."))?;
        ensure_identity(identity, &entry.status)?;
        Ok(entry.status.clone())
    }

    pub fn cancel(
        &self,
        identity: &CopyOperationIdentity,
    ) -> Result<CopyOperationStatus, DataError> {
        let _commit = self.commit_gate.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The copy commit gate is unavailable."),
        })?;
        identity.validate()?;
        let mut registry = self.registry()?;
        let entry = registry
            .operations
            .get_mut(&identity.operation_id)
            .ok_or_else(|| DataError::invalid_request("Copy operation was not found."))?;
        ensure_identity(identity, &entry.status)?;
        if matches!(
            entry.status.state,
            CopyOperationState::Queued | CopyOperationState::Running
        ) {
            entry.cancel.store(true, Ordering::Release);
            entry.status.state = CopyOperationState::Cancelling;
        }
        Ok(entry.status.clone())
    }

    pub fn history(
        &self,
        document_id: &str,
        session_id: &str,
    ) -> Result<CopyOperationHistory, DataError> {
        if document_id.trim().is_empty() || session_id.trim().is_empty() {
            return Err(DataError::invalid_request(
                "The copy history identity is invalid.",
            ));
        }
        let registry = self.registry()?;
        let key = (document_id.to_owned(), session_id.to_owned());
        let current = registry
            .current
            .get(&key)
            .and_then(|id| registry.operations.get(id))
            .map(|entry| entry.status.clone());
        let previous = registry
            .previous
            .get(&key)
            .into_iter()
            .flatten()
            .filter_map(|id| registry.operations.get(id))
            .map(|entry| entry.status.clone())
            .collect();
        Ok(CopyOperationHistory { current, previous })
    }

    pub fn cancel_session(&self, document_id: &str, session_id: &str, query_only: bool) {
        let Ok(_commit) = self.commit_gate.lock() else {
            return;
        };
        if let Ok(mut registry) = self.state.lock() {
            for entry in registry.operations.values_mut() {
                if entry.status.document_id == document_id
                    && entry.status.session_id == session_id
                    && (!query_only || entry.status.query_id.is_some())
                    && matches!(
                        entry.status.state,
                        CopyOperationState::Queued | CopyOperationState::Running
                    )
                {
                    entry.cancel.store(true, Ordering::Release);
                    entry.status.state = CopyOperationState::Cancelling;
                }
            }
        }
    }

    pub fn cancel_all(&self) {
        let Ok(_commit) = self.commit_gate.lock() else {
            return;
        };
        if let Ok(mut registry) = self.state.lock() {
            for entry in registry.operations.values_mut() {
                if matches!(
                    entry.status.state,
                    CopyOperationState::Queued | CopyOperationState::Running
                ) {
                    entry.cancel.store(true, Ordering::Release);
                    entry.status.state = CopyOperationState::Cancelling;
                }
            }
        }
    }

    fn registry(&self) -> Result<std::sync::MutexGuard<'_, CopyRegistry>, DataError> {
        self.state.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: String::from("The copy operation registry is unavailable."),
        })
    }
}

struct CopyRuntime {
    state: Arc<Mutex<CopyRegistry>>,
    commit_gate: Arc<Mutex<()>>,
    display_formats: DisplayFormats,
    reader: Arc<dyn CopyRowReader>,
    clipboard: Arc<dyn ClipboardWriter>,
    staging_directory: PathBuf,
}

fn ensure_identity(
    identity: &CopyOperationIdentity,
    status: &CopyOperationStatus,
) -> Result<(), DataError> {
    if identity.document_id != status.document_id || identity.session_id != status.session_id {
        Err(DataError::invalid_request(
            "Copy operation identity does not match its document session.",
        ))
    } else {
        Ok(())
    }
}

fn run_copy(request: StartCopyRequest, cancel: Arc<AtomicBool>, runtime: CopyRuntime) {
    update_status(&runtime.state, &request.operation_id, |status| {
        status.state = CopyOperationState::Running;
        status.stage = CopyOperationStage::SourceRead;
    });
    let result = execute_copy(&runtime, &request, &cancel);
    match result {
        Ok(()) => update_status(&runtime.state, &request.operation_id, |status| {
            status.state = CopyOperationState::Complete;
            status.stage = CopyOperationStage::Complete;
            status.failure = None;
        }),
        Err(failure) => update_status(&runtime.state, &request.operation_id, |status| {
            status.state = if failure.reason == CopyFailureReason::Cancelled {
                CopyOperationState::Cancelled
            } else {
                CopyOperationState::Failed
            };
            status.failure = Some(failure);
        }),
    }
}

fn execute_copy(
    runtime: &CopyRuntime,
    request: &StartCopyRequest,
    cancel: &AtomicBool,
) -> Result<(), CopyFailure> {
    fs::create_dir_all(&runtime.staging_directory)
        .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    let staging_path = runtime
        .staging_directory
        .join(format!("copy-{}.tmp", safe_id(&request.operation_id)));
    let staging = StagingGuard::create(staging_path)
        .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    let file = staging
        .open()
        .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    let mut writer = BufWriter::new(file);
    let line_ending = match request.options.line_ending {
        CopyLineEnding::Crlf => "\r\n",
        CopyLineEnding::Lf => "\n",
    };
    let mut bytes = 0_u64;
    let mut has_content = false;

    if request.options.include_headers {
        let line = request
            .selection
            .column_ids
            .iter()
            .map(|header| serialize_text(header, false, &request.options))
            .collect::<Result<Vec<_>, _>>()?
            .join(&request.options.delimiter);
        write_piece(
            &mut writer,
            &mut bytes,
            request.max_bytes,
            &line,
            false,
            line_ending,
        )?;
        has_content = true;
    }

    let column_count = request.selection.column_ids.len();
    let max_rows_by_cells = (COPY_MAX_BATCH_CELLS / column_count).max(1);
    let mut batch_rows = max_rows_by_cells.min(4096);
    let mut cursor = request.selection.row_start;
    while cursor < request.selection.row_end_exclusive {
        if cancel.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let remaining = request.selection.row_end_exclusive - cursor;
        let take = usize::try_from(remaining.min(batch_rows as u64)).unwrap_or(batch_rows);
        let page = runtime
            .reader
            .read_rows(cursor, take, &request.selection.column_ids)
            .map_err(source_failure)?;
        if page.offset != cursor || page.columns != request.selection.column_ids {
            return Err(failure(
                CopyFailureReason::SourceRead,
                "The copy source returned a stale range or projection.",
            ));
        }
        if page.rows.is_empty() {
            return Err(failure(
                CopyFailureReason::SourceRead,
                "The copy selection extends beyond the available rows.",
            ));
        }
        update_status(&runtime.state, &request.operation_id, |status| {
            status.stage = CopyOperationStage::Serialize;
        });
        let before = bytes;
        for row in &page.rows {
            if row.len() != column_count {
                return Err(failure(
                    CopyFailureReason::SourceRead,
                    "The copy source returned a row with a different projection width.",
                ));
            }
            let line = serialize_row(row, &request.options, &runtime.display_formats)?;
            write_piece(
                &mut writer,
                &mut bytes,
                request.max_bytes,
                &line,
                has_content,
                line_ending,
            )?;
            has_content = true;
        }
        let row_count = page.rows.len() as u64;
        cursor = cursor.saturating_add(row_count);
        update_status(&runtime.state, &request.operation_id, |status| {
            status.stage = CopyOperationStage::SourceRead;
            status.progress.rows_processed = cursor.saturating_sub(request.selection.row_start);
            status.progress.cells_processed = status
                .progress
                .rows_processed
                .saturating_mul(column_count as u64);
            status.progress.bytes_serialized = bytes;
        });
        let serialized = bytes.saturating_sub(before);
        if serialized > 0 {
            let observed_per_row = serialized.div_ceil(row_count.max(1));
            let rows_by_bytes = (COPY_MAX_BATCH_ESTIMATED_BYTES as u64 / observed_per_row.max(1))
                .clamp(1, max_rows_by_cells as u64) as usize;
            batch_rows = rows_by_bytes;
        }
        if row_count < take as u64 && cursor < request.selection.row_end_exclusive {
            return Err(failure(
                CopyFailureReason::SourceRead,
                "The copy selection extends beyond the available rows.",
            ));
        }
    }
    writer
        .flush()
        .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    drop(writer);
    if cancel.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    let text = fs::read_to_string(staging.path())
        .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    let _commit = runtime.commit_gate.lock().map_err(|_| {
        failure(
            CopyFailureReason::ClipboardWrite,
            "The copy commit gate is unavailable.",
        )
    })?;
    if cancel.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    runtime
        .reader
        .validate_current()
        .map_err(|error| CopyFailure {
            reason: CopyFailureReason::QueryStale,
            message: error.message,
        })?;
    update_status(&runtime.state, &request.operation_id, |status| {
        status.state = CopyOperationState::Committing;
        status.stage = CopyOperationStage::ClipboardWrite;
    });
    runtime
        .clipboard
        .write_text(text)
        .map_err(|message| failure(CopyFailureReason::ClipboardWrite, message))?;
    Ok(())
}

fn serialize_row(
    row: &[DataValue],
    options: &CopyOptionsSnapshot,
    display_formats: &DisplayFormats,
) -> Result<String, CopyFailure> {
    row.iter()
        .map(|value| {
            let formatted;
            let value = if options.representation == crate::domain::CopyRepresentation::Display {
                formatted = crate::data::format_data_value_display(value, display_formats);
                &formatted
            } else {
                value
            };
            let mut text = copy_value_text(value, options.representation);
            let mut force_quote = false;
            let never_quote = value.kind == ValueKind::Null;
            if value.kind == ValueKind::Null {
                text = options.null_representation.clone();
            } else if value.kind == ValueKind::String && text.is_empty() {
                force_quote =
                    options.empty_string_representation == EmptyStringRepresentation::QuotedEmpty;
            } else if value.kind == ValueKind::String
                && !options.null_representation.is_empty()
                && text == options.null_representation
            {
                force_quote = true;
            } else if options.representation == crate::domain::CopyRepresentation::Display
                && value.kind == ValueKind::Boolean
            {
                text = match options.boolean_representation {
                    BooleanRepresentation::Lowercase => text.to_ascii_lowercase(),
                    BooleanRepresentation::Uppercase => text.to_ascii_uppercase(),
                    BooleanRepresentation::Numeric => match text.to_ascii_lowercase().as_str() {
                        "true" => String::from("1"),
                        "false" => String::from("0"),
                        _ => {
                            return Err(failure(
                                CopyFailureReason::Serialize,
                                "Boolean copy value is not true or false.",
                            ))
                        }
                    },
                };
            } else if options.representation == crate::domain::CopyRepresentation::Display
                && matches!(value.kind, ValueKind::Date | ValueKind::Timestamp)
            {
                text = format_temporal(&text, &options.date_time_representation)?;
            }
            serialize_text_with_flags(&text, force_quote, never_quote, options)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|fields| fields.join(&options.delimiter))
}

fn format_temporal(
    text: &str,
    representation: &DateTimeRepresentation,
) -> Result<String, CopyFailure> {
    match representation {
        DateTimeRepresentation::Display | DateTimeRepresentation::Iso8601 => Ok(text.to_owned()),
        DateTimeRepresentation::Custom { format } => {
            let normalized = text.replace('T', " ");
            let (date, time) = normalized.split_once(' ').ok_or_else(|| {
                failure(
                    CopyFailureReason::Serialize,
                    "Custom date/time formatting requires a date and time value.",
                )
            })?;
            let date_parts = date.split('-').collect::<Vec<_>>();
            let time = time.trim_end_matches('Z');
            let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
            let clock_parts = clock.split(':').collect::<Vec<_>>();
            if date_parts.len() != 3 || clock_parts.len() != 3 {
                return Err(failure(
                    CopyFailureReason::Serialize,
                    "Custom date/time formatting requires an ISO-like value.",
                ));
            }
            let padded_fraction = format!("{fraction:0<3}");
            Ok(format
                .replace("YYYY", date_parts[0])
                .replace("MM", date_parts[1])
                .replace("DD", date_parts[2])
                .replace("HH", clock_parts[0])
                .replace("mm", clock_parts[1])
                .replace("ss", clock_parts[2])
                .replace("SSS", &padded_fraction[..3])
                .replace('S', fraction))
        }
    }
}

fn serialize_text(
    text: &str,
    force_quote: bool,
    options: &CopyOptionsSnapshot,
) -> Result<String, CopyFailure> {
    serialize_text_with_flags(text, force_quote, false, options)
}

fn serialize_text_with_flags(
    text: &str,
    force_quote: bool,
    never_quote: bool,
    options: &CopyOptionsSnapshot,
) -> Result<String, CopyFailure> {
    let unsafe_text = text.contains(&options.delimiter) || text.contains(['\r', '\n']);
    if never_quote && unsafe_text {
        return Err(failure(
            CopyFailureReason::Serialize,
            "Null representation cannot contain a delimiter or line break.",
        ));
    }
    if options.quote_mode == CopyQuoteMode::None {
        if unsafe_text || force_quote || text.contains(&options.quote_character) {
            return Err(failure(
                CopyFailureReason::Serialize,
                "A copy value requires quoting, but quoting is disabled.",
            ));
        }
        return Ok(text.to_owned());
    }
    let quoted = !never_quote
        && (options.quote_mode == CopyQuoteMode::Always
            || force_quote
            || unsafe_text
            || text.contains(&options.quote_character));
    if !quoted {
        return Ok(text.to_owned());
    }
    let escaped = match options.escape_mode {
        CopyEscapeMode::Double => {
            text.replace(&options.quote_character, &options.quote_character.repeat(2))
        }
        CopyEscapeMode::Backslash => text.replace('\\', "\\\\").replace(
            &options.quote_character,
            &format!("\\{}", options.quote_character),
        ),
    };
    Ok(format!(
        "{}{}{}",
        options.quote_character, escaped, options.quote_character
    ))
}

fn write_piece(
    writer: &mut BufWriter<File>,
    bytes: &mut u64,
    max_bytes: u64,
    text: &str,
    prepend_line_ending: bool,
    line_ending: &str,
) -> Result<(), CopyFailure> {
    let added = text.len() as u64
        + if prepend_line_ending {
            line_ending.len() as u64
        } else {
            0
        };
    if bytes.checked_add(added).is_none_or(|next| next > max_bytes) {
        return Err(failure(
            CopyFailureReason::ByteLimit,
            format!("The copy output exceeds the configured {max_bytes}-byte limit."),
        ));
    }
    if prepend_line_ending {
        writer
            .write_all(line_ending.as_bytes())
            .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    }
    writer
        .write_all(text.as_bytes())
        .map_err(|error| failure(CopyFailureReason::Serialize, error))?;
    *bytes += added;
    Ok(())
}

fn update_status(
    state: &Arc<Mutex<CopyRegistry>>,
    operation_id: &str,
    update: impl FnOnce(&mut CopyOperationStatus),
) {
    if let Ok(mut registry) = state.lock() {
        if let Some(entry) = registry.operations.get_mut(operation_id) {
            update(&mut entry.status);
        }
    }
}

fn source_failure(error: DataError) -> CopyFailure {
    let reason = if matches!(
        error.code,
        DataErrorCode::QueryNotFound
            | DataErrorCode::DocumentClosed
            | DataErrorCode::StaleSession
            | DataErrorCode::DocumentNotFound
    ) {
        CopyFailureReason::QueryStale
    } else if error.code == DataErrorCode::TaskCancelled {
        CopyFailureReason::Cancelled
    } else {
        CopyFailureReason::SourceRead
    };
    CopyFailure {
        reason,
        message: error.message,
    }
}

fn failure(reason: CopyFailureReason, message: impl std::fmt::Display) -> CopyFailure {
    CopyFailure {
        reason,
        message: message.to_string(),
    }
}

fn cancelled() -> CopyFailure {
    failure(
        CopyFailureReason::Cancelled,
        "The copy operation was cancelled.",
    )
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

fn safe_id(operation_id: &str) -> String {
    // StartCopyRequest restricts this to a collision-free portable filename set.
    operation_id.to_owned()
}

struct StagingGuard {
    path: PathBuf,
}

impl StagingGuard {
    fn create(path: PathBuf) -> std::io::Result<Self> {
        if path.exists() {
            fs::remove_file(&path)?;
        }
        Ok(Self { path })
    }

    fn open(&self) -> std::io::Result<File> {
        File::options()
            .create_new(true)
            .write(true)
            .open(&self.path)
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CopyOptionsSnapshot, CopyRepresentation, CopySelectionSnapshot, DataValue,
        DurationDisplayStyle, DurationUnitSuffix, TimestampDateTimeSeparator,
        TimestampFractionalDigits, TimestampTimeFormat, TimestampTimezoneSuffix,
    };
    use std::{
        sync::Barrier,
        time::{Duration, Instant},
    };

    #[derive(Default)]
    struct MemoryClipboard {
        writes: Mutex<Vec<String>>,
        fail: bool,
    }

    impl ClipboardWriter for MemoryClipboard {
        fn write_text(&self, text: String) -> Result<(), String> {
            if self.fail {
                return Err(String::from("sentinel clipboard failure"));
            }
            self.writes.lock().unwrap().push(text);
            Ok(())
        }
    }

    struct MemoryReader {
        rows: Vec<Vec<DataValue>>,
    }

    impl CopyRowReader for MemoryReader {
        fn read_rows(
            &self,
            offset: u64,
            limit: usize,
            columns: &[String],
        ) -> Result<DataPage, DataError> {
            let start = offset as usize;
            let end = (start + limit).min(self.rows.len());
            Ok(DataPage {
                offset,
                limit,
                total_rows: Some(self.rows.len() as u64),
                has_more: end < self.rows.len(),
                columns: columns.to_vec(),
                rows: self.rows[start..end].to_vec(),
            })
        }
    }

    struct SlowReader(MemoryReader);

    impl CopyRowReader for SlowReader {
        fn read_rows(
            &self,
            offset: u64,
            limit: usize,
            columns: &[String],
        ) -> Result<DataPage, DataError> {
            std::thread::sleep(Duration::from_millis(50));
            self.0.read_rows(offset, limit, columns)
        }
    }

    struct CommitBarrierReader {
        inner: MemoryReader,
        validation_entered: Arc<Barrier>,
        validation_release: Arc<Barrier>,
    }

    struct StaleAtCommitReader(MemoryReader);

    impl CopyRowReader for StaleAtCommitReader {
        fn read_rows(
            &self,
            offset: u64,
            limit: usize,
            columns: &[String],
        ) -> Result<DataPage, DataError> {
            self.0.read_rows(offset, limit, columns)
        }

        fn validate_current(&self) -> Result<(), DataError> {
            Err(DataError::query_not_found("stale-query"))
        }
    }

    impl CopyRowReader for CommitBarrierReader {
        fn read_rows(
            &self,
            offset: u64,
            limit: usize,
            columns: &[String],
        ) -> Result<DataPage, DataError> {
            self.inner.read_rows(offset, limit, columns)
        }

        fn validate_current(&self) -> Result<(), DataError> {
            self.validation_entered.wait();
            self.validation_release.wait();
            Ok(())
        }
    }

    fn options() -> CopyOptionsSnapshot {
        CopyOptionsSnapshot {
            delimiter: String::from("\t"),
            include_headers: false,
            quote_mode: CopyQuoteMode::Minimal,
            quote_character: String::from("\""),
            escape_mode: CopyEscapeMode::Double,
            line_ending: CopyLineEnding::Crlf,
            null_representation: String::new(),
            empty_string_representation: EmptyStringRepresentation::Empty,
            boolean_representation: BooleanRepresentation::Lowercase,
            date_time_representation: DateTimeRepresentation::Display,
            representation: CopyRepresentation::Display,
        }
    }

    fn request(id: &str, max_bytes: u64) -> StartCopyRequest {
        StartCopyRequest {
            operation_id: id.to_owned(),
            document_id: String::from("document-1"),
            session_id: String::from("session-1"),
            query_id: None,
            selection: CopySelectionSnapshot {
                row_start: 0,
                row_end_exclusive: 2,
                column_ids: vec![String::from("a")],
            },
            options: options(),
            max_cells: 10,
            max_bytes,
        }
    }

    fn wait_terminal(manager: &CopyManager, operation_id: &str) -> CopyOperationStatus {
        let identity = CopyOperationIdentity {
            operation_id: operation_id.to_owned(),
            document_id: String::from("document-1"),
            session_id: String::from("session-1"),
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let status = manager.status(&identity).unwrap();
            if status.state.is_terminal() {
                return status;
            }
            assert!(Instant::now() < deadline, "copy operation timed out");
            std::thread::yield_now();
        }
    }

    #[test]
    fn stages_tsv_and_commits_clipboard_exactly_once() {
        let directory = tempfile::tempdir().unwrap();
        let manager = CopyManager::default();
        let clipboard = Arc::new(MemoryClipboard::default());
        manager
            .start(
                request("copy-success", 1024),
                Arc::new(MemoryReader {
                    rows: vec![
                        vec![DataValue::displayed(ValueKind::String, "alpha")],
                        vec![DataValue::displayed(ValueKind::String, "beta")],
                    ],
                }),
                clipboard.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        let status = wait_terminal(&manager, "copy-success");
        assert_eq!(status.state, CopyOperationState::Complete);
        assert_eq!(
            clipboard.writes.lock().unwrap().as_slice(),
            ["alpha\r\nbeta"]
        );
        assert!(directory.path().read_dir().unwrap().next().is_none());
    }

    #[test]
    fn raw_canonical_copy_ignores_display_only_temporal_and_boolean_formats() {
        let mut raw_options = options();
        raw_options.representation = CopyRepresentation::RawCanonical;
        raw_options.boolean_representation = BooleanRepresentation::Uppercase;
        raw_options.date_time_representation = DateTimeRepresentation::Custom {
            format: String::from("YYYY/MM/DD"),
        };
        let timestamp = DataValue::converted(
            ValueKind::Timestamp,
            "2025-12-18 01:23:34.111111111",
            "1766021014111111111 [unit=ns, timezone=UTC]",
        )
        .with_source("1766021014111111111");
        let boolean = DataValue::displayed(ValueKind::Boolean, "true");

        assert_eq!(
            serialize_row(
                &[timestamp, boolean],
                &raw_options,
                &DisplayFormats::default(),
            )
            .unwrap(),
            "1766021014111111111 [unit=ns, timezone=UTC]\ttrue"
        );
    }

    #[test]
    fn display_copy_uses_the_start_snapshot_for_timestamp_and_duration() {
        let timestamp = DataValue::converted(
            ValueKind::Timestamp,
            "2025-12-18 01:23:34.111111111",
            "1766021014111111111 [unit=ns, timezone=UTC]",
        )
        .with_source("1766021014111111111")
        .with_temporal_metadata("ns", Some("UTC"));
        let duration =
            DataValue::converted(ValueKind::Duration, "1d 01:01:01.001", "90061001 [unit=ms]")
                .with_source("90061001")
                .with_temporal_metadata("ms", None);
        let mut formats = DisplayFormats::default();
        formats.timestamp.date_time_separator = TimestampDateTimeSeparator::T;
        formats.timestamp.time_format = TimestampTimeFormat::HourMinuteSecond;
        formats.timestamp.fractional_digits = TimestampFractionalDigits::Fixed { digits: 3 };
        formats.timestamp.timezone_suffix = TimestampTimezoneSuffix::Name;
        formats.duration.style = DurationDisplayStyle::TotalSeconds;
        formats.duration.fractional_digits = TimestampFractionalDigits::Fixed { digits: 3 };
        formats.duration.unit_suffix = DurationUnitSuffix::Source;

        assert_eq!(
            serialize_row(&[timestamp, duration], &options(), &formats).unwrap(),
            "2025-12-18T01:23:34.111 [UTC]\t90061.001 s [unit=ms]"
        );
    }

    #[test]
    fn byte_limit_and_clipboard_failure_never_partially_write() {
        let directory = tempfile::tempdir().unwrap();
        let manager = CopyManager::default();
        let clipboard = Arc::new(MemoryClipboard::default());
        manager
            .start(
                request("copy-limit", 3),
                Arc::new(MemoryReader {
                    rows: vec![
                        vec![DataValue::displayed(ValueKind::String, "alpha")],
                        vec![DataValue::displayed(ValueKind::String, "beta")],
                    ],
                }),
                clipboard.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        let status = wait_terminal(&manager, "copy-limit");
        assert_eq!(status.failure.unwrap().reason, CopyFailureReason::ByteLimit);
        assert!(clipboard.writes.lock().unwrap().is_empty());

        let failing = Arc::new(MemoryClipboard {
            writes: Mutex::new(Vec::new()),
            fail: true,
        });
        manager
            .start(
                request("copy-clipboard-fail", 1024),
                Arc::new(MemoryReader {
                    rows: vec![
                        vec![DataValue::displayed(ValueKind::String, "alpha")],
                        vec![DataValue::displayed(ValueKind::String, "beta")],
                    ],
                }),
                failing.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        let status = wait_terminal(&manager, "copy-clipboard-fail");
        assert_eq!(
            status.failure.unwrap().reason,
            CopyFailureReason::ClipboardWrite
        );
        assert!(failing.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn cancellation_and_selection_limit_preserve_the_previous_clipboard() {
        let directory = tempfile::tempdir().unwrap();
        let manager = CopyManager::default();
        let clipboard = Arc::new(MemoryClipboard::default());
        manager
            .start(
                request("copy-cancel", 1024),
                Arc::new(SlowReader(MemoryReader {
                    rows: vec![
                        vec![DataValue::displayed(ValueKind::String, "alpha")],
                        vec![DataValue::displayed(ValueKind::String, "beta")],
                    ],
                })),
                clipboard.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        manager
            .cancel(&CopyOperationIdentity {
                operation_id: String::from("copy-cancel"),
                document_id: String::from("document-1"),
                session_id: String::from("session-1"),
            })
            .unwrap();
        let cancelled = wait_terminal(&manager, "copy-cancel");
        assert_eq!(cancelled.state, CopyOperationState::Cancelled);
        assert_eq!(
            cancelled.failure.unwrap().reason,
            CopyFailureReason::Cancelled
        );
        assert!(clipboard.writes.lock().unwrap().is_empty());

        let mut limited = request("copy-selection-limit", 1024);
        limited.max_cells = 1;
        let failed = manager
            .start(
                limited,
                Arc::new(MemoryReader { rows: Vec::new() }),
                clipboard.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        assert_eq!(failed.state, CopyOperationState::Failed);
        assert_eq!(
            failed.failure.unwrap().reason,
            CopyFailureReason::SelectionLimit
        );
        assert!(clipboard.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn commit_gate_linearizes_clipboard_write_before_a_later_session_cancel() {
        let directory = tempfile::tempdir().unwrap();
        let manager = Arc::new(CopyManager::default());
        let clipboard = Arc::new(MemoryClipboard::default());
        let validation_entered = Arc::new(Barrier::new(2));
        let validation_release = Arc::new(Barrier::new(2));
        manager
            .start(
                request("copy-commit-linearized", 1024),
                Arc::new(CommitBarrierReader {
                    inner: MemoryReader {
                        rows: vec![
                            vec![DataValue::displayed(ValueKind::String, "alpha")],
                            vec![DataValue::displayed(ValueKind::String, "beta")],
                        ],
                    },
                    validation_entered: Arc::clone(&validation_entered),
                    validation_release: Arc::clone(&validation_release),
                }),
                clipboard.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        validation_entered.wait();

        let cancel_finished = Arc::new(AtomicBool::new(false));
        let cancel_manager = Arc::clone(&manager);
        let cancel_finished_worker = Arc::clone(&cancel_finished);
        let cancel_worker = std::thread::spawn(move || {
            cancel_manager.cancel_session("document-1", "session-1", false);
            cancel_finished_worker.store(true, Ordering::Release);
        });
        std::thread::sleep(Duration::from_millis(20));
        assert!(!cancel_finished.load(Ordering::Acquire));

        validation_release.wait();
        cancel_worker.join().unwrap();
        let status = wait_terminal(&manager, "copy-commit-linearized");
        assert_eq!(status.state, CopyOperationState::Complete);
        assert_eq!(
            clipboard.writes.lock().unwrap().as_slice(),
            ["alpha\r\nbeta"]
        );
    }

    #[test]
    fn stale_reader_is_rejected_at_commit_without_touching_the_clipboard() {
        let directory = tempfile::tempdir().unwrap();
        let manager = CopyManager::default();
        let clipboard = Arc::new(MemoryClipboard::default());
        manager
            .start(
                request("copy-stale-at-commit", 1024),
                Arc::new(StaleAtCommitReader(MemoryReader {
                    rows: vec![
                        vec![DataValue::displayed(ValueKind::String, "alpha")],
                        vec![DataValue::displayed(ValueKind::String, "beta")],
                    ],
                })),
                clipboard.clone(),
                directory.path().to_path_buf(),
            )
            .unwrap();
        let status = wait_terminal(&manager, "copy-stale-at-commit");
        assert_eq!(status.state, CopyOperationState::Failed);
        assert_eq!(
            status.failure.unwrap().reason,
            CopyFailureReason::QueryStale
        );
        assert!(clipboard.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn retains_current_and_only_five_previous_attempts() {
        let directory = tempfile::tempdir().unwrap();
        let manager = CopyManager::default();
        for index in 0..7 {
            let id = format!("copy-history-{index}");
            manager
                .start(
                    request(&id, 1),
                    Arc::new(MemoryReader {
                        rows: vec![
                            vec![DataValue::displayed(ValueKind::String, "alpha")],
                            vec![DataValue::displayed(ValueKind::String, "beta")],
                        ],
                    }),
                    Arc::new(MemoryClipboard::default()),
                    directory.path().to_path_buf(),
                )
                .unwrap();
            wait_terminal(&manager, &id);
        }
        let history = manager.history("document-1", "session-1").unwrap();
        assert_eq!(history.current.unwrap().operation_id, "copy-history-6");
        assert_eq!(history.previous.len(), COPY_HISTORY_CAPACITY);
        assert_eq!(history.previous[0].operation_id, "copy-history-5");
    }
}
