use super::*;
use crate::domain::{
    BooleanRepresentation, CopyEscapeMode, CopyLineEnding, CopyOptionsSnapshot, CopyQuoteMode,
    CopyRepresentation, CopySelectionSnapshot, DateTimeRepresentation, EmptyStringRepresentation,
};
use crate::query::{
    ColumnValuesCopyRequest, ColumnValuesPageRequest, ColumnValuesPageResponse, ColumnValuesStatus,
    StartColumnValuesRequest,
};

#[tauri::command]
pub fn start_column_values(
    request: StartColumnValuesRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ColumnValuesStatus, DataError> {
    let _admission = state.cache_migration.enter()?;
    let source = state
        .documents
        .with_source(&request.document_id, &request.session_id, |source| {
            source.query_source_spec()
        })
        .map_err(document_error)??;
    state
        .query_service(&app)?
        .start_column_values(request, Some(source))
}

#[tauri::command]
pub fn get_column_values_status(
    document_id: String,
    session_id: String,
    operation_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ColumnValuesStatus, DataError> {
    state
        .documents
        .with_source(&document_id, &session_id, |_| ())
        .map_err(document_error)?;
    state
        .query_service(&app)?
        .column_values_status(&document_id, &session_id, &operation_id)
}

#[tauri::command]
pub async fn read_column_values_page(
    request: ColumnValuesPageRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ColumnValuesPageResponse, DataError> {
    state
        .documents
        .with_source(&request.document_id, &request.session_id, |_| ())
        .map_err(document_error)?;
    let service = state.query_service(&app)?;
    tauri::async_runtime::spawn_blocking(move || service.read_column_values_page(request))
        .await
        .map_err(|error| DataError::query_failed(error.to_string()))?
}

#[tauri::command]
pub fn cancel_column_values(
    document_id: String,
    session_id: String,
    operation_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ColumnValuesStatus, DataError> {
    state
        .query_service(&app)?
        .cancel_column_values(&document_id, &session_id, &operation_id)
}

#[tauri::command]
pub fn release_column_values(
    document_id: String,
    session_id: String,
    operation_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), DataError> {
    state
        .query_service(&app)?
        .release_column_values(&document_id, &session_id, &operation_id)
}

#[tauri::command]
pub async fn start_column_values_copy(
    request: ColumnValuesCopyRequest,
    app: AppHandle,
) -> Result<CopyOperationStatus, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_column_values_copy_inner(request, app.clone(), &state)
    })
    .await
    .map_err(|error| DataError::query_failed(error.to_string()))?
}

fn start_column_values_copy_inner(
    request: ColumnValuesCopyRequest,
    app: AppHandle,
    state: &AppState,
) -> Result<CopyOperationStatus, DataError> {
    let _admission = state.cache_migration.enter()?;
    state
        .documents
        .with_source(&request.document_id, &request.session_id, |_| ())
        .map_err(document_error)?;
    let service = state.query_service(&app)?;
    let status = service.column_values_status(
        &request.document_id,
        &request.session_id,
        &request.operation_id,
    )?;
    let source = service.column_values_copy_reader(request.clone())?;
    if source.row_count == 0 {
        return Err(DataError::invalid_request(
            "There are no matching column values to copy.",
        ));
    }
    let settings = get_settings(app.clone())?;
    let clipboard = source.wrap_clipboard(Arc::new(TauriClipboardWriter::new(app)));
    let copy = StartCopyRequest {
        operation_id: format!(
            "column-values-copy-{}",
            state.next_request_id.fetch_add(1, Ordering::Relaxed)
        ),
        document_id: request.document_id,
        session_id: request.session_id,
        query_id: status.query_id,
        selection: CopySelectionSnapshot {
            row_start: 0,
            row_end_exclusive: source.row_count,
            column_ids: source.column_ids,
        },
        options: CopyOptionsSnapshot {
            delimiter: "\t".to_owned(),
            include_headers: true,
            quote_mode: CopyQuoteMode::Minimal,
            quote_character: "\"".to_owned(),
            escape_mode: CopyEscapeMode::Double,
            line_ending: CopyLineEnding::Crlf,
            null_representation: "NULL".to_owned(),
            empty_string_representation: EmptyStringRepresentation::QuotedEmpty,
            boolean_representation: BooleanRepresentation::Lowercase,
            date_time_representation: DateTimeRepresentation::Display,
            representation: CopyRepresentation::RawCanonical,
        },
        max_cells: settings.copy_limits.max_cells,
        max_bytes: settings.copy_limits.max_bytes,
    };
    copy.validate()?;
    state.copy_manager.start_with_display_formats(
        copy,
        source.reader,
        clipboard,
        service.copy_staging_directory(),
        settings.display_formats,
    )
}
