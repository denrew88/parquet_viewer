use std::path::PathBuf;

use crate::{data::builtin_format_registry, domain::FormatDescriptor};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

#[derive(Debug, Clone, PartialEq, Eq)]
struct DialogFilter {
    name: String,
    extensions: Vec<&'static str>,
}

fn dialog_filters(descriptors: &[FormatDescriptor]) -> Vec<DialogFilter> {
    let all_extensions = descriptors
        .iter()
        .flat_map(|descriptor| descriptor.extensions.iter().copied())
        .collect();
    let mut filters = vec![DialogFilter {
        name: String::from("Data files"),
        extensions: all_extensions,
    }];
    filters.extend(descriptors.iter().map(|descriptor| DialogFilter {
        name: descriptor.display_name.to_owned(),
        extensions: descriptor.extensions.to_vec(),
    }));
    filters
}

fn add_format_filters<R: Runtime>(dialog: FileDialogBuilder<R>) -> FileDialogBuilder<R> {
    dialog_filters(&builtin_format_registry().descriptors())
        .into_iter()
        .fold(dialog, |dialog, filter| {
            dialog.add_filter(filter.name, &filter.extensions)
        })
}

/// Opens a single-file native picker limited to supported data files.
///
/// Closing the native dialog is a normal `None` result, not an error.
pub fn pick_data_file<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    selected_path(add_format_filters(app.dialog().file()).blocking_pick_file())
}

/// Opens the native multi-select picker. The returned order is the order
/// provided by the platform dialog and is preserved by the batch-open API.
pub fn pick_data_files<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Vec<PathBuf>>, String> {
    selected_paths(add_format_filters(app.dialog().file()).blocking_pick_files())
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

    #[test]
    fn dialog_filters_follow_the_builtin_registry() {
        let descriptors = builtin_format_registry().descriptors();
        let filters = dialog_filters(&descriptors);

        assert_eq!(filters[0].name, "Data files");
        assert_eq!(filters[0].extensions, vec!["csv", "parquet"]);
        assert_eq!(filters[1].name, "CSV");
        assert_eq!(filters[1].extensions, vec!["csv"]);
        assert_eq!(filters[2].name, "Parquet");
        assert_eq!(filters[2].extensions, vec!["parquet"]);
    }

    #[test]
    fn installer_associations_are_registered_formats() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let registered = builtin_format_registry()
            .descriptors()
            .into_iter()
            .flat_map(|descriptor| descriptor.extensions.iter().copied())
            .collect::<std::collections::HashSet<_>>();
        let associations = config["bundle"]["fileAssociations"].as_array().unwrap();

        for extension in associations
            .iter()
            .flat_map(|association| association["ext"].as_array().unwrap())
            .map(|extension| extension.as_str().unwrap())
        {
            assert!(registered.contains(extension));
        }
    }
}
