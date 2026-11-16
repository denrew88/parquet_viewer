use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    domain::DataError,
    storage::{validate_existing_csv_cache_directory, validate_existing_storage_directory},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StorageFolderKind {
    CsvCache,
    QueryTemp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageLocation {
    path: String,
    available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageLocations {
    csv_cache: StorageLocation,
    query_temp: StorageLocation,
}

fn managed_path(
    local_data: &Path,
    configured_cache: Option<&Path>,
    kind: StorageFolderKind,
) -> PathBuf {
    match kind {
        StorageFolderKind::CsvCache => configured_cache
            .map(Path::to_path_buf)
            .unwrap_or_else(|| local_data.join("csv-cache-v1")),
        StorageFolderKind::QueryTemp => local_data.join("query-temp"),
    }
}

fn validate_target(kind: StorageFolderKind, path: &Path) -> Result<(), DataError> {
    match kind {
        StorageFolderKind::CsvCache => validate_existing_csv_cache_directory(path),
        StorageFolderKind::QueryTemp => validate_existing_storage_directory(path),
    }
}

pub(crate) fn describe_storage_locations(
    local_data: &Path,
    configured_cache: Option<&Path>,
) -> Result<StorageLocations, DataError> {
    let describe = |kind| {
        let path = managed_path(local_data, configured_cache, kind);
        let display = path.to_str().ok_or_else(|| {
            DataError::invalid_request("The storage folder path cannot be displayed as Unicode.")
        })?;
        Ok::<_, DataError>(StorageLocation {
            path: display.to_owned(),
            available: validate_target(kind, &path).is_ok(),
        })
    };
    Ok(StorageLocations {
        csv_cache: describe(StorageFolderKind::CsvCache)?,
        query_temp: describe(StorageFolderKind::QueryTemp)?,
    })
}

pub(crate) fn open_managed_storage_folder(
    local_data: &Path,
    configured_cache: Option<&Path>,
    kind: StorageFolderKind,
) -> Result<(), DataError> {
    open_with(local_data, configured_cache, kind, launch_folder)
}

fn open_with(
    local_data: &Path,
    configured_cache: Option<&Path>,
    kind: StorageFolderKind,
    opener: impl FnOnce(&Path) -> Result<(), DataError>,
) -> Result<(), DataError> {
    let path = managed_path(local_data, configured_cache, kind);
    validate_target(kind, &path)?;
    opener(&path)
}

#[cfg(windows)]
fn windows_shell_path(path: &Path) -> Result<PathBuf, DataError> {
    use std::path::{Component, Prefix};
    let text = path.to_str().ok_or_else(|| {
        DataError::invalid_request("The storage folder path cannot be displayed as Unicode.")
    })?;
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) | Prefix::UNC(_, _) => Ok(path.to_path_buf()),
            Prefix::VerbatimDisk(_) => Ok(PathBuf::from(&text[4..])),
            Prefix::VerbatimUNC(_, _) => Ok(PathBuf::from(format!("\\\\{}", &text[8..]))),
            _ => Err(DataError::invalid_request(
                "Only filesystem folders can be opened from Storage settings.",
            )),
        },
        _ => Err(DataError::invalid_request(
            "The storage folder must be an absolute local directory.",
        )),
    }
}

#[cfg(windows)]
fn launch_folder(path: &Path) -> Result<(), DataError> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }

    let target = windows_shell_path(path)?;
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both strings are NUL-terminated and live for the synchronous call.
    // The directory was validated above; no URI, shell command or parameter string is passed.
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            1,
        )
    };
    if result <= 32 {
        return Err(DataError {
            code: crate::domain::DataErrorCode::Io,
            message: format!(
                "Could not open the storage folder in Windows Explorer (system error {result}): {}",
                path.display()
            ),
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn launch_folder(_path: &Path) -> Result<(), DataError> {
    Err(DataError::invalid_request(
        "Opening storage folders is supported on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn owned_cache(path: &Path) {
        fs::create_dir_all(path).unwrap();
        fs::write(
            path.join(".data-viewer-cache.json"),
            b"{\"kind\":\"data-viewer-csv-cache\",\"version\":1}",
        )
        .unwrap();
    }

    #[test]
    fn p25_storage_folder_kind_matches_shared_parity_corpus() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .map(|parent| parent.join("fixtures/phase-25/storage-folder-kinds.json"))
            .find(|candidate| candidate.is_file())
            .expect("canonical storage-folder kind corpus must exist");
        let cases: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        for case in cases {
            let parsed = serde_json::from_value::<StorageFolderKind>(case["value"].clone());
            assert_eq!(parsed.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn p25_storage_folder_inspection_and_failed_open_create_nothing() {
        let fixture = tempfile::tempdir().unwrap();
        let local = fixture.path().join("not-created");
        let locations = describe_storage_locations(&local, None).unwrap();
        assert_eq!(
            locations.csv_cache.path,
            local.join("csv-cache-v1").to_str().unwrap()
        );
        assert_eq!(
            locations.query_temp.path,
            local.join("query-temp").to_str().unwrap()
        );
        assert!(!locations.csv_cache.available);
        assert!(!locations.query_temp.available);
        for kind in [StorageFolderKind::CsvCache, StorageFolderKind::QueryTemp] {
            assert!(open_with(&local, None, kind, |_| panic!("must not launch")).is_err());
        }
        assert!(!local.exists());
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 0);
    }

    #[test]
    fn p25_storage_folder_defaults_use_distinct_literal_roots() {
        let fixture = tempfile::tempdir().unwrap();
        let local = fixture.path().join("앱 data, & $(literal)");
        owned_cache(&local.join("csv-cache-v1"));
        fs::create_dir_all(local.join("query-temp")).unwrap();
        let locations = describe_storage_locations(&local, None).unwrap();
        assert!(locations.csv_cache.available);
        assert!(locations.query_temp.available);
        for (kind, expected) in [
            (StorageFolderKind::CsvCache, local.join("csv-cache-v1")),
            (StorageFolderKind::QueryTemp, local.join("query-temp")),
        ] {
            let mut opened = None;
            open_with(&local, None, kind, |path| {
                opened = Some(path.to_path_buf());
                Ok(())
            })
            .unwrap();
            assert_eq!(opened, Some(expected));
        }
        assert_eq!(fs::read_dir(local.join("query-temp")).unwrap().count(), 0);
    }

    #[test]
    fn p25_storage_folder_custom_cache_is_current_and_does_not_redirect_temp() {
        let fixture = tempfile::tempdir().unwrap();
        let local = fixture.path().join("local");
        fs::create_dir_all(local.join("query-temp")).unwrap();
        let previous = fixture.path().join("previous cache");
        let current = fixture.path().join("현재 캐시, & $(literal)");
        owned_cache(&previous);
        owned_cache(&current);
        let observed = describe_storage_locations(&local, Some(&previous)).unwrap();
        assert_eq!(observed.csv_cache.path, previous.to_str().unwrap());
        let current_locations = describe_storage_locations(&local, Some(&current)).unwrap();
        assert_eq!(current_locations.csv_cache.path, current.to_str().unwrap());
        assert_eq!(
            current_locations.query_temp.path,
            local.join("query-temp").to_str().unwrap()
        );
        let mut opened = Vec::new();
        for kind in [StorageFolderKind::CsvCache, StorageFolderKind::QueryTemp] {
            open_with(&local, Some(&current), kind, |path| {
                opened.push(path.to_path_buf());
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(opened, vec![current, local.join("query-temp")]);
        assert!(!local.join("csv-cache-v1").exists());
    }

    #[test]
    fn p25_storage_folder_missing_custom_cache_keeps_temp_available() {
        let fixture = tempfile::tempdir().unwrap();
        let temp = fixture.path().join("query-temp");
        fs::create_dir(&temp).unwrap();
        let missing = fixture.path().join("offline-or-missing");
        let locations = describe_storage_locations(fixture.path(), Some(&missing)).unwrap();
        assert!(!locations.csv_cache.available);
        assert!(locations.query_temp.available);
        assert!(open_with(
            fixture.path(),
            Some(&missing),
            StorageFolderKind::CsvCache,
            |_| { panic!("must not open a missing cache or fall back") }
        )
        .is_err());
        let mut opened = None;
        open_with(
            fixture.path(),
            Some(&missing),
            StorageFolderKind::QueryTemp,
            |path| {
                opened = Some(path.to_path_buf());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(opened, Some(temp));
        assert!(!missing.exists());
    }

    #[test]
    fn p25_storage_folder_refuses_files_and_foreign_cache_without_launching() {
        let fixture = tempfile::tempdir().unwrap();
        let foreign = fixture.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(fixture.path().join("query-temp"), b"not a directory").unwrap();
        let locations = describe_storage_locations(fixture.path(), Some(&foreign)).unwrap();
        assert!(!locations.csv_cache.available);
        assert!(!locations.query_temp.available);
        for kind in [StorageFolderKind::CsvCache, StorageFolderKind::QueryTemp] {
            assert!(open_with(fixture.path(), Some(&foreign), kind, |_| panic!(
                "must not launch"
            ))
            .is_err());
        }
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
        fs::write(foreign.join(".data-viewer-cache.json"), b"foreign owner").unwrap();
        assert!(
            !describe_storage_locations(fixture.path(), Some(&foreign))
                .unwrap()
                .csv_cache
                .available
        );
    }

    #[test]
    fn p25_storage_folder_rechecks_availability_and_propagates_launch_failure() {
        let fixture = tempfile::tempdir().unwrap();
        let temp = fixture.path().join("query-temp");
        fs::create_dir(&temp).unwrap();
        assert!(
            describe_storage_locations(fixture.path(), None)
                .unwrap()
                .query_temp
                .available
        );
        fs::remove_dir(&temp).unwrap();
        assert!(open_with(
            fixture.path(),
            None,
            StorageFolderKind::QueryTemp,
            |_| panic!("must recheck")
        )
        .is_err());
        fs::create_dir(&temp).unwrap();
        let expected = DataError {
            code: crate::domain::DataErrorCode::Io,
            message: "simulated Explorer failure".to_owned(),
        };
        let failure = open_with(fixture.path(), None, StorageFolderKind::QueryTemp, |path| {
            assert_eq!(path, temp.as_path());
            Err(expected.clone())
        })
        .unwrap_err();
        assert_eq!(failure, expected);
        assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
    }

    #[test]
    fn p25_storage_folder_refuses_relative_root_without_launching() {
        assert!(open_with(
            Path::new("relative"),
            None,
            StorageFolderKind::QueryTemp,
            |_| { panic!("must not launch a relative path") }
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn p25_storage_folder_refuses_symbolic_link_roots() {
        let fixture = tempfile::tempdir().unwrap();
        let actual = fixture.path().join("actual");
        fs::create_dir(&actual).unwrap();
        std::os::unix::fs::symlink(&actual, fixture.path().join("query-temp")).unwrap();
        let locations = describe_storage_locations(fixture.path(), None).unwrap();
        assert!(!locations.query_temp.available);
        assert!(open_with(
            fixture.path(),
            None,
            StorageFolderKind::QueryTemp,
            |_| panic!("must not follow link")
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn p25_storage_folder_windows_shell_paths_preserve_literal_names() {
        let literal = Path::new(r"C:\data\한글, spaces & $(literal)");
        assert_eq!(windows_shell_path(literal).unwrap(), literal);
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\C:\data\한글, spaces & $(literal)")).unwrap(),
            literal
        );
        let unc = Path::new(r"\\server\share\folder, name");
        assert_eq!(windows_shell_path(unc).unwrap(), unc);
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\UNC\server\share\folder, name")).unwrap(),
            unc
        );
        assert!(windows_shell_path(Path::new(r"\\.\pipe\arbitrary")).is_err());
    }
}
