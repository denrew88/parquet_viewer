// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = data_viewer_lib::try_run_sql_worker_from_args() {
        std::process::exit(code);
    }
    if data_viewer_lib::try_run_polars_csv_worker_from_args() {
        return;
    }
    data_viewer_lib::run()
}
