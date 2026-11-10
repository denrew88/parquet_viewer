//! IPC for bounded chart calculation and typed selection snapshots.
use super::*;
use crate::{
    domain::CopySelectionSnapshot,
    query::chart::{ChartData, ChartRequest, ChartSource},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartCaptureRequest {
    request_id: String,
    source: ChartSource,
    selection: CopySelectionSnapshot,
}

pub(super) fn reader(
    state: &AppState,
    app: &AppHandle,
    source: &ChartSource,
) -> Result<Option<Arc<dyn CopyRowReader>>, DataError> {
    match source {
        ChartSource::File {
            document_id,
            session_id,
            query_id,
        } => {
            state
                .documents
                .with_source(document_id, session_id, |_| ())
                .map_err(document_error)?;
            let service = state.query_service(app)?;
            match query_id {
                Some(id) => Ok(Some(Arc::new(QueryCopyReader::new(
                    service,
                    document_id.clone(),
                    session_id.clone(),
                    id.clone(),
                )))),
                None => Ok(Some(Arc::new(SourceCopyReader::new(
                    Arc::clone(&state.documents),
                    service,
                    document_id.clone(),
                    session_id.clone(),
                )))),
            }
        }
        ChartSource::Sql {
            run_id,
            result_id,
            view_id,
        } => Ok(Some(state.query_service(app)?.sql_chart_reader(
            run_id,
            result_id,
            view_id.as_deref(),
        )?)),
        ChartSource::Block { .. } => Ok(None),
    }
}

#[tauri::command]
pub async fn compute_chart(request: ChartRequest, app: AppHandle) -> Result<ChartData, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let source = reader(&state, &app, &request.source)?;
        state.charts.compute(&request, source)
    })
    .await
    .map_err(|_| DataError::query_failed("Chart computation did not finish."))?
}

#[tauri::command]
pub async fn capture_chart_selection(
    request: ChartCaptureRequest,
    app: AppHandle,
) -> Result<(), DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let source = reader(&state, &app, &request.source)?
            .ok_or_else(|| DataError::invalid_request("Select rows in a file or SQL grid."))?;
        state
            .charts
            .capture(&request.request_id, source, &request.selection)
    })
    .await
    .map_err(|_| DataError::query_failed("Chart selection could not be captured."))?
}

#[tauri::command]
pub fn cancel_chart(request_id: String, state: State<'_, AppState>) -> Result<(), DataError> {
    state.charts.cancel(&request_id)
}

#[tauri::command]
pub fn release_chart_block(block_id: String, state: State<'_, AppState>) -> Result<(), DataError> {
    state.charts.release(&block_id)
}

#[tauri::command]
pub fn retain_chart_sql_result(
    run_id: String,
    result_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), DataError> {
    state
        .query_service(&app)?
        .retain_chart_sql_result(&run_id, &result_id)
}

#[tauri::command]
pub fn release_chart_sql_result(
    run_id: String,
    result_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), DataError> {
    state
        .query_service(&app)?
        .release_chart_sql_result(&run_id, &result_id)
}
