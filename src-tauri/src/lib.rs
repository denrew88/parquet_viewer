use serde::Serialize;
use tauri::Manager;

mod commands;
mod data;
mod domain;
mod platform;

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
            if let Some(request) = platform::startup_request(state.next_request_id("startup")) {
                state.enqueue_open(request);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            commands::select_data_file,
            commands::select_data_file_paths,
            commands::open_data_file,
            commands::open_data_paths,
            commands::take_pending_open_requests,
            commands::read_page,
            commands::configure_csv,
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
