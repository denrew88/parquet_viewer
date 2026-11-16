//! IPC for bounded chart calculation and typed selection snapshots.
use super::*;
use crate::{
    domain::CopySelectionSnapshot,
    query::chart::{ChartData, ChartDetail, ChartRequest, ChartSource},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartCaptureRequest {
    request_id: String,
    source: ChartSource,
    selection: CopySelectionSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartBlockPreview {
    session_id: String,
    #[serde(flatten)]
    page: DataPage,
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
pub async fn compute_chart(
    request: ChartRequest,
    detail: Option<ChartDetail>,
    app: AppHandle,
) -> Result<ChartData, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let source = reader(&state, &app, &request.source)?;
        let projected = if let ChartSource::File {
            document_id,
            session_id,
            query_id: None,
        } = &request.source
        {
            let spec = state
                .documents
                .with_source(document_id, session_id, |source| source.query_source_spec())
                .map_err(document_error)?;
            if let Ok(spec) = spec {
                state
                    .query_service(&app)?
                    .prepared_chart_source(document_id, session_id, spec)?
            } else {
                None
            }
        } else {
            None
        };
        if let Some(detail) = detail.as_ref() {
            let service = state.query_service(&app)?;
            return state.charts.compute_with_detail(
                &request,
                source,
                projected,
                Some(detail),
                Some(service.chart_detail_temp()),
            );
        }
        match projected {
            Some(stream) => state
                .charts
                .compute_with_stream(&request, source, Some(stream)),
            None => state.charts.compute(&request, source),
        }
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
        if let ChartSource::Sql {
            run_id,
            result_id,
            view_id,
        } = &request.source
        {
            let source = state.query_service(&app)?.sql_selection_chart_reader(
                run_id,
                result_id,
                view_id.as_deref(),
                &request.selection,
            )?;
            return state
                .charts
                .capture_reference(&request.request_id, source, &request.selection);
        }
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
pub async fn read_chart_block_preview(
    block_id: String,
    limit: usize,
    columns: Vec<String>,
    app: AppHandle,
) -> Result<ChartBlockPreview, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let page = state.charts.preview_block(&block_id, limit, &columns)?;
        Ok(ChartBlockPreview {
            session_id: block_id,
            page,
        })
    })
    .await
    .map_err(|_| DataError::query_failed("Chart selection preview did not finish."))?
}

#[tauri::command]
pub fn cancel_chart(request_id: String, state: State<'_, AppState>) -> Result<(), DataError> {
    state.charts.cancel(&request_id)
}

#[tauri::command]
pub async fn release_chart_block(block_id: String, app: AppHandle) -> Result<(), DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.charts.release(&block_id)
    })
    .await
    .map_err(|_| DataError::query_failed("Chart selection could not be released."))?
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
    let service = state.query_service(&app)?;
    service.release_chart_sql_result(&run_id, &result_id)?;
    if service.sql_chart_reader(&run_id, &result_id, None).is_err() {
        state
            .charts
            .invalidate_sql_detail(&run_id, &result_id, None, false);
    }
    Ok(())
}
