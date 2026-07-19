use serde::{Deserialize, Serialize};

pub const APP_SETTINGS_SCHEMA_VERSION: u8 = 2;
pub const DEFAULT_QUERY_TEMP_LIMIT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const MIN_QUERY_TEMP_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_QUERY_TEMP_LIMIT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
pub const DEFAULT_COPY_MAX_CELLS: u64 = 1_000_000;
pub const MIN_COPY_MAX_CELLS: u64 = 1_000;
pub const MAX_COPY_MAX_CELLS: u64 = 10_000_000;
pub const DEFAULT_COPY_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MIN_COPY_MAX_BYTES: u64 = 1024 * 1024;
pub const MAX_COPY_MAX_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyPreset {
    Excel,
    Tsv,
    Csv,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyQuoteMode {
    Minimal,
    Always,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyEscapeMode {
    Double,
    Backslash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyLineEnding {
    Crlf,
    Lf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmptyStringRepresentation {
    Empty,
    QuotedEmpty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BooleanRepresentation {
    Lowercase,
    Uppercase,
    Numeric,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum DateTimeRepresentation {
    Display,
    Iso8601,
    Custom { format: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyOptions {
    pub preset: CopyPreset,
    pub delimiter: String,
    pub include_headers: bool,
    pub quote_mode: CopyQuoteMode,
    pub quote_character: String,
    pub escape_mode: CopyEscapeMode,
    pub line_ending: CopyLineEnding,
    pub null_representation: String,
    pub empty_string_representation: EmptyStringRepresentation,
    pub boolean_representation: BooleanRepresentation,
    pub date_time_representation: DateTimeRepresentation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvDefaultParsingMode {
    Auto,
    AllText,
    AskEveryTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyLimits {
    pub max_cells: u64,
    pub max_bytes: u64,
}

impl Default for CopyLimits {
    fn default() -> Self {
        Self {
            max_cells: DEFAULT_COPY_MAX_CELLS,
            max_bytes: DEFAULT_COPY_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettingsV1 {
    pub schema_version: u8,
    pub copy_preset: CopyPreset,
    pub copy_custom_options: CopyOptions,
    pub csv_default_parsing_mode: CsvDefaultParsingMode,
    pub query_temp_limit_bytes: u64,
    pub copy_limits: CopyLimits,
}

impl Default for AppSettingsV1 {
    fn default() -> Self {
        Self {
            schema_version: APP_SETTINGS_SCHEMA_VERSION,
            copy_preset: CopyPreset::Excel,
            copy_custom_options: CopyOptions {
                preset: CopyPreset::Custom,
                delimiter: String::from("|"),
                include_headers: false,
                quote_mode: CopyQuoteMode::Minimal,
                quote_character: String::from("\""),
                escape_mode: CopyEscapeMode::Double,
                line_ending: CopyLineEnding::Crlf,
                null_representation: String::from("NULL"),
                empty_string_representation: EmptyStringRepresentation::QuotedEmpty,
                boolean_representation: BooleanRepresentation::Lowercase,
                date_time_representation: DateTimeRepresentation::Display,
            },
            csv_default_parsing_mode: CsvDefaultParsingMode::Auto,
            query_temp_limit_bytes: DEFAULT_QUERY_TEMP_LIMIT_BYTES,
            copy_limits: CopyLimits::default(),
        }
    }
}

impl AppSettingsV1 {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != APP_SETTINGS_SCHEMA_VERSION {
            return Err(String::from("settings.schemaVersion is unsupported."));
        }
        if self.copy_custom_options.preset != CopyPreset::Custom {
            return Err(String::from(
                "settings.copyCustomOptions.preset must be custom.",
            ));
        }
        validate_structural_character(
            &self.copy_custom_options.delimiter,
            "settings.copyCustomOptions.delimiter",
        )?;
        validate_structural_character(
            &self.copy_custom_options.quote_character,
            "settings.copyCustomOptions.quoteCharacter",
        )?;
        if self.copy_custom_options.delimiter == self.copy_custom_options.quote_character {
            return Err(String::from(
                "settings.copyCustomOptions delimiter and quoteCharacter must differ.",
            ));
        }
        if matches!(
            &self.copy_custom_options.date_time_representation,
            DateTimeRepresentation::Custom { format } if format.trim().is_empty()
        ) {
            return Err(String::from(
                "settings.copyCustomOptions.dateTimeRepresentation.format cannot be empty.",
            ));
        }
        if !(MIN_QUERY_TEMP_LIMIT_BYTES..=MAX_QUERY_TEMP_LIMIT_BYTES)
            .contains(&self.query_temp_limit_bytes)
        {
            return Err(format!(
                "settings.queryTempLimitBytes must be between {MIN_QUERY_TEMP_LIMIT_BYTES} and {MAX_QUERY_TEMP_LIMIT_BYTES}."
            ));
        }
        if !(MIN_COPY_MAX_CELLS..=MAX_COPY_MAX_CELLS).contains(&self.copy_limits.max_cells) {
            return Err(format!(
                "settings.copyLimits.maxCells must be between {MIN_COPY_MAX_CELLS} and {MAX_COPY_MAX_CELLS}."
            ));
        }
        if !(MIN_COPY_MAX_BYTES..=MAX_COPY_MAX_BYTES).contains(&self.copy_limits.max_bytes) {
            return Err(format!(
                "settings.copyLimits.maxBytes must be between {MIN_COPY_MAX_BYTES} and {MAX_COPY_MAX_BYTES}."
            ));
        }
        Ok(())
    }
}

fn validate_structural_character(value: &str, path: &str) -> Result<(), String> {
    if value.chars().count() != 1 || matches!(value, "\r" | "\n" | "\0") {
        return Err(format!(
            "{path} must be one Unicode character other than CR, LF, or NUL."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_matches_frontend_contract() {
        let value = serde_json::to_value(AppSettingsV1::default()).unwrap();
        assert_eq!(value["schemaVersion"], 2);
        assert_eq!(value["copyPreset"], "excel");
        assert_eq!(value["copyCustomOptions"]["preset"], "custom");
        assert_eq!(value["csvDefaultParsingMode"], "auto");
        assert_eq!(value["queryTempLimitBytes"], DEFAULT_QUERY_TEMP_LIMIT_BYTES);
        assert_eq!(value["copyLimits"]["maxCells"], DEFAULT_COPY_MAX_CELLS);
        assert_eq!(value["copyLimits"]["maxBytes"], DEFAULT_COPY_MAX_BYTES);
    }

    #[test]
    fn settings_reject_unknown_and_structurally_invalid_values() {
        let mut value = serde_json::to_value(AppSettingsV1::default()).unwrap();
        value["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<AppSettingsV1>(value).is_err());
        let mut value = serde_json::to_value(AppSettingsV1::default()).unwrap();
        value["copyLimits"]["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<AppSettingsV1>(value).is_err());
        let mut settings = AppSettingsV1::default();
        settings.copy_custom_options.delimiter = String::from("||");
        assert!(settings.validate().is_err());
    }

    #[test]
    fn copy_limits_accept_inclusive_bounds() {
        for (max_cells, max_bytes) in [
            (MIN_COPY_MAX_CELLS, MIN_COPY_MAX_BYTES),
            (MAX_COPY_MAX_CELLS, MAX_COPY_MAX_BYTES),
        ] {
            let settings = AppSettingsV1 {
                copy_limits: CopyLimits {
                    max_cells,
                    max_bytes,
                },
                ..AppSettingsV1::default()
            };
            assert_eq!(settings.validate(), Ok(()));
        }
    }

    #[test]
    fn copy_limits_reject_values_outside_bounds_with_wire_paths() {
        for (limits, expected) in [
            (
                CopyLimits {
                    max_cells: MIN_COPY_MAX_CELLS - 1,
                    max_bytes: DEFAULT_COPY_MAX_BYTES,
                },
                format!(
                    "settings.copyLimits.maxCells must be between {MIN_COPY_MAX_CELLS} and {MAX_COPY_MAX_CELLS}."
                ),
            ),
            (
                CopyLimits {
                    max_cells: MAX_COPY_MAX_CELLS + 1,
                    max_bytes: DEFAULT_COPY_MAX_BYTES,
                },
                format!(
                    "settings.copyLimits.maxCells must be between {MIN_COPY_MAX_CELLS} and {MAX_COPY_MAX_CELLS}."
                ),
            ),
            (
                CopyLimits {
                    max_cells: DEFAULT_COPY_MAX_CELLS,
                    max_bytes: MIN_COPY_MAX_BYTES - 1,
                },
                format!(
                    "settings.copyLimits.maxBytes must be between {MIN_COPY_MAX_BYTES} and {MAX_COPY_MAX_BYTES}."
                ),
            ),
            (
                CopyLimits {
                    max_cells: DEFAULT_COPY_MAX_CELLS,
                    max_bytes: MAX_COPY_MAX_BYTES + 1,
                },
                format!(
                    "settings.copyLimits.maxBytes must be between {MIN_COPY_MAX_BYTES} and {MAX_COPY_MAX_BYTES}."
                ),
            ),
        ] {
            let settings = AppSettingsV1 {
                copy_limits: limits,
                ..AppSettingsV1::default()
            };
            assert_eq!(settings.validate(), Err(expected));
        }
    }
}
