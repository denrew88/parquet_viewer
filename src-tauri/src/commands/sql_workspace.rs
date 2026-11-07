//! Thin IPC boundary for the read-only SQL workspace.
use super::*;
use crate::data::QuerySourceSpec;
use crate::domain::{
    validate_sql_identity, SqlExportFormat, SqlExportRequest, SqlPageRequest, SqlSourceIdentity,
    SqlStatus, SqlTableDescriptor, StartSqlRequest,
};
use tauri_plugin_dialog::DialogExt;

fn source_specs(
    state: &AppState,
    sources: &[SqlSourceIdentity],
) -> Result<Vec<(SqlSourceIdentity, QuerySourceSpec)>, DataError> {
    if sources.len() > 32 {
        return Err(DataError::invalid_request(
            "SQL supports at most 32 registered files.",
        ));
    }
    sources
        .iter()
        .map(|identity| {
            state
                .documents
                .with_source(&identity.document_id, &identity.session_id, |source| {
                    source.query_source_spec()
                })
                .map_err(document_error)?
                .map(|source| (identity.clone(), source))
        })
        .collect()
}

#[tauri::command]
pub async fn describe_sql_tables(
    sources: Vec<SqlSourceIdentity>,
    app: AppHandle,
) -> Result<Vec<SqlTableDescriptor>, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let sources = source_specs(&state, &sources)?;
        state.query_service(&app)?.describe_sql_tables(sources)
    })
    .await
    .map_err(|_| DataError::query_failed("SQL source inspection did not finish."))?
}

#[tauri::command]
pub async fn start_sql_query(
    request: StartSqlRequest,
    app: AppHandle,
) -> Result<SqlStatus, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        // Inspect the parsed SQL before resolving sessions: an unrelated closed
        // tab must neither invalidate this run nor trigger CSV preparation.
        let identities = crate::query::QueryService::referenced_sql_sources(&request)?;
        let sources = source_specs(&state, &identities)?
            .into_iter()
            .map(|(_, source)| source)
            .collect();
        let run_id = request.run_id.clone();
        let service = state.query_service(&app)?;
        let sql_limit = get_settings(app.clone())?.sql_temp_limit_bytes;
        let status = service.start_sql(request, sources, sql_limit)?;
        // A close/profile replacement after source collection must not leave
        // a newly registered job running against a detached session.
        for identity in identities {
            if let Err(error) =
                state
                    .documents
                    .with_source(&identity.document_id, &identity.session_id, |_| ())
            {
                // The worker may already have finished before this failed
                // admission check. Reclaim only this undisclosed run/result.
                service.abandon_sql(&run_id)?;
                return Err(document_error(error));
            }
        }
        Ok(status)
    })
    .await
    .map_err(|_| DataError::query_failed("SQL execution could not be started."))?
}

#[tauri::command]
pub fn get_sql_query_status(
    run_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SqlStatus, DataError> {
    state.query_service(&app)?.sql_status(&run_id)
}

#[tauri::command]
pub fn cancel_sql_query(
    run_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SqlStatus, DataError> {
    state.query_service(&app)?.cancel_sql(&run_id)
}

#[tauri::command]
pub async fn read_sql_query_page(
    request: SqlPageRequest,
    app: AppHandle,
) -> Result<DataPage, DataError> {
    let service = app.state::<AppState>().query_service(&app)?;
    tauri::async_runtime::spawn_blocking(move || service.read_sql_page(&request))
        .await
        .map_err(|_| DataError::query_failed("SQL result page could not be read."))?
}

#[tauri::command]
pub async fn read_sql_query_cell(
    run_id: String,
    result_id: String,
    row: u64,
    column_id: String,
    app: AppHandle,
) -> Result<DataValue, DataError> {
    let service = app.state::<AppState>().query_service(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        service.read_sql_cell(&run_id, &result_id, row, &column_id)
    })
    .await
    .map_err(|_| DataError::query_failed("SQL result value could not be read."))?
}

#[tauri::command]
pub async fn release_sql_result(
    run_id: String,
    result_id: String,
    app: AppHandle,
) -> Result<(), DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state
            .copy_manager
            .cancel_session("sql-workspace", &result_id, true);
        state
            .query_service(&app)?
            .release_sql_result(&run_id, &result_id)
    })
    .await
    .map_err(|_| DataError::query_failed("SQL result could not be released."))?
}

#[tauri::command]
pub async fn export_sql_result(
    request: SqlExportRequest,
    app: AppHandle,
    window: tauri::Window,
) -> Result<bool, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_sql_identity(&request.run_id)?;
        validate_sql_identity(&request.result_id)?;
        let (label, extension) = match request.format {
            SqlExportFormat::Csv => ("CSV", "csv"),
            SqlExportFormat::Tsv => ("TSV", "tsv"),
            SqlExportFormat::Parquet => ("Parquet", "parquet"),
        };
        let dialog = app
            .dialog()
            .file()
            .set_title(format!("Export SQL result as {label}"))
            .set_file_name(format!("query-result.{extension}"))
            .add_filter(label, &[extension]);
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|_| DataError::invalid_request("Choose a local file for the SQL export."))?;
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        state.query_service(&app)?.export_sql_result(
            &request.run_id,
            &request.result_id,
            request.format,
            &path,
        )?;
        Ok(true)
    })
    .await
    .map_err(|_| DataError::query_failed("SQL result export did not finish."))?
}

#[tauri::command]
pub async fn start_sql_copy(
    run_id: String,
    result_id: String,
    request: StartCopyRequest,
    app: AppHandle,
) -> Result<CopyOperationStatus, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        request.validate()?;
        if request.document_id != "sql-workspace"
            || request.session_id != result_id
            || request.query_id.as_deref() != Some(run_id.as_str())
        {
            return Err(DataError::invalid_request(
                "SQL copy result identity does not match.",
            ));
        }
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let settings = get_settings(app.clone())?;
        if request.max_cells > settings.copy_limits.max_cells
            || request.max_bytes > settings.copy_limits.max_bytes
        {
            return Err(DataError::invalid_request(
                "Copy limits exceed the active settings.",
            ));
        }
        let service = state.query_service(&app)?;
        let (reader, staging_directory) = service.sql_copy_context(
            &run_id,
            &result_id,
            &request.operation_id,
            request.max_bytes,
        )?;
        state.copy_manager.start_with_display_formats(
            request,
            reader,
            Arc::new(TauriClipboardWriter::new(app.clone())),
            staging_directory,
            settings.display_formats,
        )
    })
    .await
    .map_err(|_| DataError::query_failed("SQL result copy could not be started."))?
}
