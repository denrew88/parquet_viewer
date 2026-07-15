use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::domain::{AppSettingsV1, DataError, DataErrorCode};

#[derive(Debug, Clone)]
pub struct SettingsStore {
    directory: PathBuf,
}

impl SettingsStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn load(&self) -> Result<AppSettingsV1, DataError> {
        let path = self.path();
        if !path.exists() {
            return Ok(AppSettingsV1::default());
        }
        let result = fs::read(&path)
            .map_err(|error| io_error(&path, error))
            .and_then(|bytes| {
                serde_json::from_slice::<AppSettingsV1>(&bytes).map_err(|error| {
                    DataError::invalid_request(format!("Invalid settings.json: {error}"))
                })
            })
            .and_then(|settings| {
                settings
                    .validate()
                    .map_err(DataError::invalid_request)
                    .map(|()| settings)
            });
        match result {
            Ok(settings) => Ok(settings),
            Err(error) => {
                self.preserve_corrupt(&path)?;
                let settings = AppSettingsV1::default();
                self.save(&settings)?;
                Err(DataError::settings_invalid(format!(
                    "The invalid settings file was preserved and defaults were restored: {error}"
                )))
            }
        }
    }

    pub fn save(&self, settings: &AppSettingsV1) -> Result<AppSettingsV1, DataError> {
        settings.validate().map_err(DataError::invalid_request)?;
        fs::create_dir_all(&self.directory).map_err(|error| io_error(&self.directory, error))?;
        let encoded = serde_json::to_vec_pretty(settings).map_err(|error| DataError {
            code: DataErrorCode::Io,
            message: format!("Settings serialization failed: {error}"),
        })?;
        let temporary = self.unique_path("settings.tmp", "json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| io_error(&temporary, error))?;
        if let Err(error) = file.write_all(&encoded).and_then(|()| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(io_error(&temporary, error));
        }
        drop(file);
        let path = self.path();
        if path.exists() {
            let backup = self.unique_path("settings.previous", "json");
            fs::rename(&path, &backup).map_err(|error| io_error(&path, error))?;
            if let Err(error) = fs::rename(&temporary, &path) {
                let _ = fs::rename(&backup, &path);
                let _ = fs::remove_file(&temporary);
                return Err(io_error(&path, error));
            }
            let _ = fs::remove_file(backup);
        } else {
            fs::rename(&temporary, &path).map_err(|error| io_error(&path, error))?;
        }
        sync_directory(&self.directory);
        Ok(settings.clone())
    }

    fn path(&self) -> PathBuf {
        self.directory.join("settings.json")
    }

    fn preserve_corrupt(&self, path: &Path) -> Result<(), DataError> {
        fs::create_dir_all(&self.directory).map_err(|error| io_error(&self.directory, error))?;
        let destination = self.unique_path("settings.corrupt", "json");
        fs::rename(path, &destination).map_err(|error| io_error(path, error))
    }

    fn unique_path(&self, stem: &str, extension: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let value = NEXT.fetch_add(1, Ordering::Relaxed);
        self.directory
            .join(format!("{stem}-{}-{value}.{extension}", std::process::id()))
    }
}

fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: format!("Settings I/O failed at {}: {error}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        BooleanRepresentation, CopyEscapeMode, CopyLineEnding, CopyPreset, CopyQuoteMode,
        CsvDefaultParsingMode, DateTimeRepresentation, EmptyStringRepresentation,
    };

    #[test]
    fn settings_round_trip_is_whole_object_and_leaves_no_temp_file() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(directory.path());
        let expected = AppSettingsV1 {
            query_temp_limit_bytes: 512 * 1024 * 1024,
            ..AppSettingsV1::default()
        };
        store.save(&expected).unwrap();
        assert_eq!(store.load().unwrap(), expected);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn copy_and_csv_default_settings_round_trip_as_complete_backend_objects() {
        for (index, (preset, delimiter, csv_mode)) in [
            (CopyPreset::Excel, "\t", CsvDefaultParsingMode::Auto),
            (CopyPreset::Tsv, ";", CsvDefaultParsingMode::AllText),
            (CopyPreset::Csv, ",", CsvDefaultParsingMode::AskEveryTime),
            (CopyPreset::Custom, "|", CsvDefaultParsingMode::Auto),
        ]
        .into_iter()
        .enumerate()
        {
            let directory = tempfile::tempdir().unwrap();
            let store = SettingsStore::new(directory.path());
            let defaults = AppSettingsV1::default();
            let mut custom = defaults.copy_custom_options;
            custom.delimiter = delimiter.to_owned();
            custom.include_headers = index % 2 == 0;
            custom.quote_mode = CopyQuoteMode::Always;
            custom.quote_character = String::from("'");
            custom.escape_mode = CopyEscapeMode::Backslash;
            custom.line_ending = CopyLineEnding::Lf;
            custom.null_representation = String::from("<null>");
            custom.empty_string_representation = EmptyStringRepresentation::Empty;
            custom.boolean_representation = BooleanRepresentation::Numeric;
            custom.date_time_representation = DateTimeRepresentation::Custom {
                format: String::from("YYYY-MM-DD HH:mm:ss"),
            };
            let expected = AppSettingsV1 {
                copy_preset: preset,
                copy_custom_options: custom,
                csv_default_parsing_mode: csv_mode,
                ..defaults
            };

            assert_eq!(store.save(&expected).unwrap(), expected);
            assert_eq!(store.load().unwrap(), expected);
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn corrupt_settings_are_preserved_before_default_recovery() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("settings.json"), "{broken").unwrap();
        let store = SettingsStore::new(directory.path());
        let error = store.load().unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::SettingsInvalid);
        assert_eq!(store.load().unwrap(), AppSettingsV1::default());
        let names = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(names
            .iter()
            .any(|name| name.starts_with("settings.corrupt-")));
        assert!(names.iter().any(|name| name == "settings.json"));
    }
}
