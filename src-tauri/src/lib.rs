use serde::Serialize;
use tauri::Manager;

mod commands;
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
            commands::update_settings,
            commands::execute_query,
            commands::get_query_status,
            commands::read_query_page,
            commands::list_distinct_values,
            commands::cancel_query,
            commands::find_query_match,
            commands::find_data_boundary,
            commands::cancel_data_boundary_navigation,
            commands::get_query_temp_usage,
            commands::clear_query_temp,
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
