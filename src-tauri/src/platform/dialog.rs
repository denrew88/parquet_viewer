use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Opens a single-file native picker limited to supported data files.
///
/// Closing the native dialog is a normal `None` result, not an error.
pub fn pick_data_file<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    selected_path(
        app.dialog()
            .file()
            .add_filter("Data files", &["csv", "parquet"])
            .add_filter("CSV", &["csv"])
            .add_filter("Parquet", &["parquet"])
            .blocking_pick_file(),
    )
}

/// Opens the native multi-select picker. The returned order is the order
/// provided by the platform dialog and is preserved by the batch-open API.
pub fn pick_data_files<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Vec<PathBuf>>, String> {
    selected_paths(
        app.dialog()
            .file()
            .add_filter("Data files", &["csv", "parquet"])
            .add_filter("CSV", &["csv"])
            .add_filter("Parquet", &["parquet"])
            .blocking_pick_files(),
    )
}

fn selected_path(selected: Option<FilePath>) -> Result<Option<PathBuf>, String> {
    selected
        .map(|selected| {
            selected
                .into_path()
                .map_err(|error| format!("The selected location is not a local file: {error}"))
        })
        .transpose()
}

fn selected_paths(selected: Option<Vec<FilePath>>) -> Result<Option<Vec<PathBuf>>, String> {
    selected
        .map(|selected| {
            selected
                .into_iter()
                .map(|path| {
                    path.into_path().map_err(|error| {
                        format!("The selected location is not a local file: {error}")
                    })
                })
                .collect()
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_cancellation_is_represented_as_none() {
        assert_eq!(selected_path(None), Ok(None));
    }

    #[test]
    fn a_local_dialog_selection_is_returned_as_a_path() {
        let path = PathBuf::from("fixture.parquet");
        assert_eq!(
            selected_path(Some(FilePath::Path(path.clone()))),
            Ok(Some(path))
        );
    }

    #[test]
    fn multiple_dialog_selections_preserve_order() {
        let first = PathBuf::from("first.csv");
        let second = PathBuf::from("second.parquet");
        assert_eq!(
            selected_paths(Some(vec![
                FilePath::Path(first.clone()),
                FilePath::Path(second.clone()),
            ])),
            Ok(Some(vec![first, second]))
        );
    }
}
