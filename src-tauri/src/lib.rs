use serde::Serialize;
use tauri::Manager;

mod commands;
mod copy;
mod data;
mod domain;
mod platform;
mod query;
mod storage;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckResponse {
    status: &'static str,
    app_version: &'static str,
}

#[tauri::command]
fn health_check() -> HealthCheckResponse {
    HealthCheckResponse {
        status: "ok",
        app_version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(feature = "polars-csv-provider")]
pub fn try_run_polars_csv_worker_from_args() -> bool {
    data::csv_polars::try_run_worker_from_args()
}

#[cfg(not(feature = "polars-csv-provider"))]
pub fn try_run_polars_csv_worker_from_args() -> bool {
    false
}

pub fn try_run_sql_worker_from_args() -> Option<i32> {
    query::try_run_sql_worker_from_args()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let state = app.state::<commands::AppState>();
            state.initialize_query_temp(app.handle())?;
            if let Some(request) = platform::startup_request(state.next_request_id("startup")) {
                state.enqueue_open(request);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            commands::list_supported_formats,
            commands::get_settings,
            commands::sql_workspace::describe_sql_tables,
            commands::sql_workspace::start_sql_query,
            commands::sql_workspace::get_sql_query_status,
            commands::sql_workspace::cancel_sql_query,
            commands::sql_workspace::read_sql_query_page,
            commands::sql_workspace::read_sql_query_cell,
            commands::sql_workspace::release_sql_result,
            commands::sql_workspace::start_sql_copy,
            commands::sql_workspace::export_sql_result,
            commands::sql_workspace::start_sql_result_view,
            commands::sql_workspace::get_sql_result_view_status,
            commands::sql_workspace::cancel_sql_result_view,
            commands::sql_workspace::release_sql_result_view,
            commands::sql_workspace::find_sql_result_view_match,
            commands::update_settings,
            commands::execute_query,
            commands::get_query_status,
            commands::read_query_page,
            commands::start_copy,
            commands::get_copy_status,
            commands::cancel_copy,
            commands::get_copy_history,
            commands::list_distinct_values,
            commands::column_values::start_column_values,
            commands::column_values::get_column_values_status,
            commands::column_values::read_column_values_page,
            commands::column_values::cancel_column_values,
            commands::column_values::release_column_values,
            commands::column_values::start_column_values_copy,
            commands::cache_migration::choose_csv_cache_location,
            commands::cache_migration::start_csv_cache_migration,
            commands::cache_migration::get_csv_cache_migration_status,
            commands::cache_migration::cancel_csv_cache_migration,
            commands::cancel_query,
            commands::find_query_match,
            commands::find_data_boundary,
            commands::cancel_data_boundary_navigation,
            commands::get_query_temp_usage,
            commands::clear_query_temp,
            commands::clear_csv_cache,
            commands::select_data_file,
            commands::select_data_file_paths,
            commands::open_data_file,
            commands::open_data_paths,
            commands::take_pending_open_requests,
            commands::read_page,
            commands::read_cell_value,
            commands::configure_csv,
            commands::get_csv_profile,
            commands::preview_csv_profile,
            commands::validate_csv_profile,
            commands::get_csv_profile_validation_status,
            commands::cancel_csv_profile_validation,
            commands::apply_csv_profile,
            commands::prepare_csv_session,
            commands::get_csv_preparation_status,
            commands::cancel_csv_preparation,
            commands::get_data_file_status,
            commands::cancel_data_file_task,
            commands::close_data_file,
            commands::close_document,
            commands::cancel_open_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_check_reports_ok_and_the_package_version() {
        let response = health_check();

        assert_eq!(response.status, "ok");
        assert_eq!(response.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn health_check_serializes_with_camel_case_fields() {
        let value = serde_json::to_value(health_check()).expect("health response must serialize");

        assert_eq!(value["status"], "ok");
        assert_eq!(value["appVersion"], env!("CARGO_PKG_VERSION"));
        assert!(value.get("app_version").is_none());
    }
}
