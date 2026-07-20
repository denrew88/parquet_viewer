use std::{
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

use serde::Deserialize;

use crate::domain::{
    AppSettingsV1, CopyLimits, CopyOptions, CopyPreset, CsvDefaultParsingMode, DataError,
    DataErrorCode, DisplayFormats, APP_SETTINGS_SCHEMA_VERSION, MAX_QUERY_TEMP_LIMIT_BYTES,
};

const LEGACY_SETTINGS_SCHEMA_VERSION: u8 = 1;
const PREVIOUS_SETTINGS_SCHEMA_VERSION: u8 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyAppSettingsV1 {
    schema_version: u8,
    copy_preset: CopyPreset,
    copy_custom_options: CopyOptions,
    csv_default_parsing_mode: CsvDefaultParsingMode,
    query_temp_limit_bytes: u64,
}

impl LegacyAppSettingsV1 {
    fn migrate(self) -> Result<AppSettingsV1, String> {
        if self.schema_version != LEGACY_SETTINGS_SCHEMA_VERSION {
            return Err(String::from("settings.schemaVersion is unsupported."));
        }
        let settings = AppSettingsV1 {
            schema_version: APP_SETTINGS_SCHEMA_VERSION,
            copy_preset: self.copy_preset,
            copy_custom_options: self.copy_custom_options,
            csv_default_parsing_mode: self.csv_default_parsing_mode,
            query_temp_limit_bytes: self.query_temp_limit_bytes.min(MAX_QUERY_TEMP_LIMIT_BYTES),
            copy_limits: CopyLimits::default(),
            display_formats: DisplayFormats::default(),
        };
        settings.validate()?;
        Ok(settings)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyAppSettingsV2 {
    schema_version: u8,
    copy_preset: CopyPreset,
    copy_custom_options: CopyOptions,
    csv_default_parsing_mode: CsvDefaultParsingMode,
    query_temp_limit_bytes: u64,
    copy_limits: CopyLimits,
}

impl LegacyAppSettingsV2 {
    fn migrate(self) -> Result<AppSettingsV1, String> {
        if self.schema_version != PREVIOUS_SETTINGS_SCHEMA_VERSION {
            return Err(String::from("settings.schemaVersion is unsupported."));
        }
        let settings = AppSettingsV1 {
            schema_version: APP_SETTINGS_SCHEMA_VERSION,
            copy_preset: self.copy_preset,
            copy_custom_options: self.copy_custom_options,
            csv_default_parsing_mode: self.csv_default_parsing_mode,
            query_temp_limit_bytes: self.query_temp_limit_bytes.min(MAX_QUERY_TEMP_LIMIT_BYTES),
            copy_limits: self.copy_limits,
            display_formats: DisplayFormats::default(),
        };
        settings.validate()?;
        Ok(settings)
    }
}

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
        if !path.exists() && !self.restore_interrupted_save(&path)? {
            return Ok(AppSettingsV1::default());
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => return self.recover_invalid(&path, io_error(&path, error)),
        };

        let current_result = serde_json::from_slice::<AppSettingsV1>(&bytes)
            .map_err(|error| DataError::invalid_request(format!("Invalid settings.json: {error}")))
            .and_then(|settings| {
                settings
                    .validate()
                    .map_err(DataError::invalid_request)
                    .map(|()| settings)
            });
        if let Ok(settings) = current_result {
            return Ok(settings);
        }

        let previous_result = serde_json::from_slice::<LegacyAppSettingsV2>(&bytes)
            .map_err(|error| format!("Invalid V2 settings.json: {error}"))
            .and_then(LegacyAppSettingsV2::migrate);
        if let Ok(settings) = previous_result {
            return self.save(&settings);
        }

        let legacy_result = serde_json::from_slice::<LegacyAppSettingsV1>(&bytes)
            .map_err(|error| format!("Invalid legacy settings.json: {error}"))
            .and_then(LegacyAppSettingsV1::migrate);
        if let Ok(settings) = legacy_result {
            return self.save(&settings);
        }

        self.recover_invalid(&path, current_result.unwrap_err())
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
            sync_directory(&self.directory);
            if let Err(error) = fs::rename(&temporary, &path) {
                let _ = fs::rename(&backup, &path);
                let _ = fs::remove_file(&temporary);
                sync_directory(&self.directory);
                return Err(io_error(&path, error));
            }
            let _ = fs::remove_file(backup);
        } else {
            fs::rename(&temporary, &path).map_err(|error| io_error(&path, error))?;
        }
        sync_directory(&self.directory);
        Ok(settings.clone())
    }

    fn restore_interrupted_save(&self, path: &Path) -> Result<bool, DataError> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(&self.directory, error)),
        };
        let mut backups = Vec::new();
        let mut stale_temporaries = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&self.directory, error))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let entry_path = entry.path();
            if name.starts_with("settings.previous-") && name.ends_with(".json") {
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(UNIX_EPOCH);
                backups.push((modified, entry_path));
            } else if name.starts_with("settings.tmp-") && name.ends_with(".json") {
                stale_temporaries.push(entry_path);
            }
        }
        let Some((_, backup)) = backups.into_iter().max_by_key(|(modified, _)| *modified) else {
            return Ok(false);
        };
        fs::rename(&backup, path).map_err(|error| io_error(&backup, error))?;
        for temporary in stale_temporaries {
            let _ = fs::remove_file(temporary);
        }
        sync_directory(&self.directory);
        Ok(true)
    }

    fn path(&self) -> PathBuf {
        self.directory.join("settings.json")
    }

    fn preserve_corrupt(&self, path: &Path) -> Result<(), DataError> {
        fs::create_dir_all(&self.directory).map_err(|error| io_error(&self.directory, error))?;
        let destination = self.unique_path("settings.corrupt", "json");
        fs::rename(path, &destination).map_err(|error| io_error(path, error))
    }

    fn recover_invalid(
        &self,
        path: &Path,
        error: impl std::fmt::Display,
    ) -> Result<AppSettingsV1, DataError> {
        self.preserve_corrupt(path)?;
        let settings = AppSettingsV1::default();
        self.save(&settings)?;
        Err(DataError::settings_invalid(format!(
            "The invalid settings file was preserved and defaults were restored: {error}"
        )))
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
        DEFAULT_COPY_MAX_BYTES, DEFAULT_COPY_MAX_CELLS,
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

    #[test]
    fn valid_v1_settings_are_migrated_atomically_and_preserve_existing_values() {
        let directory = tempfile::tempdir().unwrap();
        let defaults = AppSettingsV1::default();
        let mut legacy = serde_json::to_value(&defaults).unwrap();
        legacy["schemaVersion"] = serde_json::json!(1);
        legacy.as_object_mut().unwrap().remove("copyLimits");
        legacy.as_object_mut().unwrap().remove("displayFormats");
        legacy["copyPreset"] = serde_json::json!("custom");
        legacy["copyCustomOptions"]["delimiter"] = serde_json::json!(";");
        legacy["copyCustomOptions"]["includeHeaders"] = serde_json::json!(true);
        legacy["copyCustomOptions"]["quoteMode"] = serde_json::json!("always");
        legacy["csvDefaultParsingMode"] = serde_json::json!("allText");
        legacy["queryTempLimitBytes"] = serde_json::json!(512 * 1024 * 1024_u64);
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let store = SettingsStore::new(directory.path());
        let migrated = store.load().unwrap();
        assert_eq!(migrated.schema_version, APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(migrated.copy_preset, CopyPreset::Custom);
        assert_eq!(migrated.copy_custom_options.delimiter, ";");
        assert!(migrated.copy_custom_options.include_headers);
        assert_eq!(
            migrated.copy_custom_options.quote_mode,
            CopyQuoteMode::Always
        );
        assert_eq!(
            migrated.csv_default_parsing_mode,
            CsvDefaultParsingMode::AllText
        );
        assert_eq!(migrated.query_temp_limit_bytes, 512 * 1024 * 1024);
        assert_eq!(migrated.copy_limits.max_cells, DEFAULT_COPY_MAX_CELLS);
        assert_eq!(migrated.copy_limits.max_bytes, DEFAULT_COPY_MAX_BYTES);
        assert_eq!(migrated.display_formats, DisplayFormats::default());
        assert_eq!(store.load().unwrap(), migrated);

        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["schemaVersion"], APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(persisted["copyLimits"]["maxCells"], DEFAULT_COPY_MAX_CELLS);
        assert_eq!(persisted["copyLimits"]["maxBytes"], DEFAULT_COPY_MAX_BYTES);
        assert_eq!(persisted["displayFormats"]["binary"]["previewBytes"], 32);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn interrupted_v1_replacement_restores_backup_then_repeats_migration() {
        let directory = tempfile::tempdir().unwrap();
        let defaults = AppSettingsV1::default();
        let mut legacy = serde_json::to_value(&defaults).unwrap();
        legacy["schemaVersion"] = serde_json::json!(1);
        legacy.as_object_mut().unwrap().remove("copyLimits");
        legacy.as_object_mut().unwrap().remove("displayFormats");
        legacy["copyPreset"] = serde_json::json!("custom");
        legacy["copyCustomOptions"]["delimiter"] = serde_json::json!(";");
        fs::write(
            directory.path().join("settings.previous-crashed-1.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.path().join("settings.tmp-crashed-2.json"),
            b"incomplete replacement",
        )
        .unwrap();

        let store = SettingsStore::new(directory.path());
        let restored = store.load().unwrap();
        assert_eq!(restored.schema_version, APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(restored.copy_preset, CopyPreset::Custom);
        assert_eq!(restored.copy_custom_options.delimiter, ";");
        assert_eq!(restored.copy_limits, CopyLimits::default());
        assert_eq!(store.load().unwrap(), restored);

        let names = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![String::from("settings.json")]);
    }

    #[test]
    fn invalid_v1_settings_follow_corrupt_preservation_path() {
        let directory = tempfile::tempdir().unwrap();
        let mut legacy = serde_json::to_value(AppSettingsV1::default()).unwrap();
        legacy["schemaVersion"] = serde_json::json!(1);
        legacy.as_object_mut().unwrap().remove("copyLimits");
        legacy.as_object_mut().unwrap().remove("displayFormats");
        legacy["queryTempLimitBytes"] = serde_json::json!(1);
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();

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

    #[test]
    fn valid_v2_settings_migrate_atomically_and_preserve_all_existing_values() {
        let directory = tempfile::tempdir().unwrap();
        let defaults = AppSettingsV1::default();
        let mut legacy = serde_json::to_value(&defaults).unwrap();
        legacy["schemaVersion"] = serde_json::json!(2);
        legacy.as_object_mut().unwrap().remove("displayFormats");
        legacy["copyPreset"] = serde_json::json!("custom");
        legacy["copyCustomOptions"]["delimiter"] = serde_json::json!(";");
        legacy["copyLimits"]["maxCells"] = serde_json::json!(42_000);
        legacy["copyLimits"]["maxBytes"] = serde_json::json!(8 * 1024 * 1024);
        legacy["csvDefaultParsingMode"] = serde_json::json!("askEveryTime");
        legacy["queryTempLimitBytes"] = serde_json::json!(512 * 1024 * 1024_u64);
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let store = SettingsStore::new(directory.path());
        let migrated = store.load().unwrap();
        assert_eq!(migrated.schema_version, APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(migrated.copy_preset, CopyPreset::Custom);
        assert_eq!(migrated.copy_custom_options.delimiter, ";");
        assert_eq!(migrated.copy_limits.max_cells, 42_000);
        assert_eq!(migrated.copy_limits.max_bytes, 8 * 1024 * 1024);
        assert_eq!(
            migrated.csv_default_parsing_mode,
            CsvDefaultParsingMode::AskEveryTime
        );
        assert_eq!(migrated.query_temp_limit_bytes, 512 * 1024 * 1024);
        assert_eq!(migrated.display_formats, DisplayFormats::default());
        assert_eq!(store.load().unwrap(), migrated);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn interrupted_v2_replacement_restores_backup_then_repeats_migration() {
        let directory = tempfile::tempdir().unwrap();
        let mut legacy = serde_json::to_value(AppSettingsV1::default()).unwrap();
        legacy["schemaVersion"] = serde_json::json!(2);
        legacy.as_object_mut().unwrap().remove("displayFormats");
        legacy["copyPreset"] = serde_json::json!("custom");
        legacy["copyCustomOptions"]["delimiter"] = serde_json::json!(";");
        legacy["copyLimits"]["maxCells"] = serde_json::json!(42_000);
        fs::write(
            directory.path().join("settings.previous-crashed-v2.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.path().join("settings.tmp-crashed-v3.json"),
            b"incomplete replacement",
        )
        .unwrap();

        let store = SettingsStore::new(directory.path());
        let migrated = store.load().unwrap();
        assert_eq!(migrated.schema_version, APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(migrated.copy_preset, CopyPreset::Custom);
        assert_eq!(migrated.copy_custom_options.delimiter, ";");
        assert_eq!(migrated.copy_limits.max_cells, 42_000);
        assert_eq!(migrated.display_formats, DisplayFormats::default());
        assert_eq!(store.load().unwrap(), migrated);
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            vec![std::ffi::OsString::from("settings.json")]
        );
    }

    #[test]
    fn v2_migration_caps_only_the_obsolete_temp_limit_and_preserves_other_values() {
        let directory = tempfile::tempdir().unwrap();
        let mut legacy = serde_json::to_value(AppSettingsV1::default()).unwrap();
        legacy["schemaVersion"] = serde_json::json!(2);
        legacy.as_object_mut().unwrap().remove("displayFormats");
        legacy["copyPreset"] = serde_json::json!("custom");
        legacy["copyCustomOptions"]["delimiter"] = serde_json::json!(";");
        legacy["copyLimits"]["maxCells"] = serde_json::json!(42_000);
        legacy["queryTempLimitBytes"] = serde_json::json!(20 * 1024 * 1024 * 1024_u64);
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let migrated = SettingsStore::new(directory.path()).load().unwrap();
        assert_eq!(migrated.query_temp_limit_bytes, MAX_QUERY_TEMP_LIMIT_BYTES);
        assert_eq!(migrated.copy_preset, CopyPreset::Custom);
        assert_eq!(migrated.copy_custom_options.delimiter, ";");
        assert_eq!(migrated.copy_limits.max_cells, 42_000);
    }
}
