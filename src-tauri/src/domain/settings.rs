use serde::{Deserialize, Serialize};

pub const APP_SETTINGS_SCHEMA_VERSION: u8 = 4;
pub const DEFAULT_QUERY_TEMP_LIMIT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const MIN_QUERY_TEMP_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_QUERY_TEMP_LIMIT_BYTES: u64 = DEFAULT_QUERY_TEMP_LIMIT_BYTES;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DigitGrouping {
    None,
    Comma,
    Dot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FloatingNotation {
    General,
    Fixed,
    Scientific,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum DecimalScale {
    Preserve,
    Fixed { digits: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateDisplayFormat {
    #[serde(rename = "YYYY-MM-DD")]
    YearMonthDayDash,
    #[serde(rename = "YYYY/MM/DD")]
    YearMonthDaySlash,
    #[serde(rename = "DD-MM-YYYY")]
    DayMonthYearDash,
    #[serde(rename = "MM-DD-YYYY")]
    MonthDayYearDash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum TimestampFractionalDigits {
    Preserve,
    Fixed { digits: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimestampDateTimeSeparator {
    Space,
    T,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimestampTimeFormat {
    HourMinuteSecond,
    HourMinute,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimestampTimezoneSuffix {
    Hidden,
    Offset,
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DurationDisplayStyle {
    DaysClock,
    TotalHours,
    TotalSeconds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DurationUnitSuffix {
    Hidden,
    Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BinaryDisplayEncoding {
    Hex,
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NestedDisplayFormat {
    Compact,
    Pretty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegerDisplayFormat {
    pub grouping: DigitGrouping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FloatingPointDisplayFormat {
    pub notation: FloatingNotation,
    pub precision: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecimalDisplayFormat {
    pub scale: DecimalScale,
    pub grouping: DigitGrouping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DateDisplaySettings {
    pub format: DateDisplayFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimestampDisplayFormat {
    pub date_format: DateDisplayFormat,
    pub date_time_separator: TimestampDateTimeSeparator,
    pub time_format: TimestampTimeFormat,
    pub fractional_digits: TimestampFractionalDigits,
    pub timezone_suffix: TimestampTimezoneSuffix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurationDisplayFormat {
    pub style: DurationDisplayStyle,
    pub fractional_digits: TimestampFractionalDigits,
    pub unit_suffix: DurationUnitSuffix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BooleanDisplayFormat {
    pub representation: BooleanRepresentation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BinaryDisplayFormat {
    pub encoding: BinaryDisplayEncoding,
    pub preview_bytes: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StringDisplayFormat {
    pub render_line_breaks: bool,
    pub wrap_long_lines: bool,
    pub maximum_visible_lines: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NestedValueDisplayFormat {
    pub format: NestedDisplayFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayFormats {
    pub integer: IntegerDisplayFormat,
    pub floating_point: FloatingPointDisplayFormat,
    pub decimal: DecimalDisplayFormat,
    pub date: DateDisplaySettings,
    pub timestamp: TimestampDisplayFormat,
    pub duration: DurationDisplayFormat,
    pub boolean: BooleanDisplayFormat,
    pub binary: BinaryDisplayFormat,
    pub string: StringDisplayFormat,
    pub nested: NestedValueDisplayFormat,
}

impl Default for DisplayFormats {
    fn default() -> Self {
        Self {
            integer: IntegerDisplayFormat {
                grouping: DigitGrouping::None,
            },
            floating_point: FloatingPointDisplayFormat {
                notation: FloatingNotation::General,
                precision: 17,
            },
            decimal: DecimalDisplayFormat {
                scale: DecimalScale::Preserve,
                grouping: DigitGrouping::None,
            },
            date: DateDisplaySettings {
                format: DateDisplayFormat::YearMonthDayDash,
            },
            timestamp: TimestampDisplayFormat {
                date_format: DateDisplayFormat::YearMonthDayDash,
                date_time_separator: TimestampDateTimeSeparator::Space,
                time_format: TimestampTimeFormat::HourMinuteSecond,
                fractional_digits: TimestampFractionalDigits::Preserve,
                timezone_suffix: TimestampTimezoneSuffix::Hidden,
            },
            duration: DurationDisplayFormat {
                style: DurationDisplayStyle::DaysClock,
                fractional_digits: TimestampFractionalDigits::Preserve,
                unit_suffix: DurationUnitSuffix::Hidden,
            },
            boolean: BooleanDisplayFormat {
                representation: BooleanRepresentation::Lowercase,
            },
            binary: BinaryDisplayFormat {
                encoding: BinaryDisplayEncoding::Hex,
                preview_bytes: 32,
            },
            string: StringDisplayFormat {
                render_line_breaks: true,
                wrap_long_lines: true,
                maximum_visible_lines: 2,
            },
            nested: NestedValueDisplayFormat {
                format: NestedDisplayFormat::Compact,
            },
        }
    }
}

impl DisplayFormats {
    fn validate(&self) -> Result<(), String> {
        if !(1..=17).contains(&self.floating_point.precision) {
            return Err(String::from(
                "settings.displayFormats.floatingPoint.precision must be between 1 and 17.",
            ));
        }
        if matches!(self.decimal.scale, DecimalScale::Fixed { digits } if digits > 38) {
            return Err(String::from(
                "settings.displayFormats.decimal.scale.digits must be between 0 and 38.",
            ));
        }
        if matches!(self.timestamp.fractional_digits, TimestampFractionalDigits::Fixed { digits } if digits > 9)
        {
            return Err(String::from(
                "settings.displayFormats.timestamp.fractionalDigits.digits must be between 0 and 9.",
            ));
        }
        if matches!(self.duration.fractional_digits, TimestampFractionalDigits::Fixed { digits } if digits > 9)
        {
            return Err(String::from(
                "settings.displayFormats.duration.fractionalDigits.digits must be between 0 and 9.",
            ));
        }
        if !(1..=256).contains(&self.binary.preview_bytes) {
            return Err(String::from(
                "settings.displayFormats.binary.previewBytes must be between 1 and 256.",
            ));
        }
        if self.string.maximum_visible_lines != 2 {
            return Err(String::from(
                "settings.displayFormats.string.maximumVisibleLines must be 2.",
            ));
        }
        Ok(())
    }
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
    pub display_formats: DisplayFormats,
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
            display_formats: DisplayFormats::default(),
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
        self.display_formats.validate()?;
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
        assert_eq!(value["schemaVersion"], APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["copyPreset"], "excel");
        assert_eq!(value["copyCustomOptions"]["preset"], "custom");
        assert_eq!(value["csvDefaultParsingMode"], "auto");
        assert_eq!(value["queryTempLimitBytes"], DEFAULT_QUERY_TEMP_LIMIT_BYTES);
        assert_eq!(value["copyLimits"]["maxCells"], DEFAULT_COPY_MAX_CELLS);
        assert_eq!(value["copyLimits"]["maxBytes"], DEFAULT_COPY_MAX_BYTES);
        assert_eq!(value["displayFormats"]["integer"]["grouping"], "none");
        assert_eq!(
            value["displayFormats"]["floatingPoint"]["notation"],
            "general"
        );
        assert_eq!(
            value["displayFormats"]["timestamp"]["fractionalDigits"]["mode"],
            "preserve"
        );
        assert_eq!(value["displayFormats"]["binary"]["previewBytes"], 32);
        assert_eq!(value["displayFormats"]["string"]["maximumVisibleLines"], 2);
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

    #[test]
    fn display_formats_accept_documented_inclusive_bounds() {
        for (precision, decimal_digits, timestamp_digits, preview_bytes) in
            [(1, 0, 0, 1), (17, 38, 9, 256)]
        {
            let settings = AppSettingsV1 {
                display_formats: DisplayFormats {
                    floating_point: FloatingPointDisplayFormat {
                        notation: FloatingNotation::Scientific,
                        precision,
                    },
                    decimal: DecimalDisplayFormat {
                        scale: DecimalScale::Fixed {
                            digits: decimal_digits,
                        },
                        grouping: DigitGrouping::Comma,
                    },
                    timestamp: TimestampDisplayFormat {
                        fractional_digits: TimestampFractionalDigits::Fixed {
                            digits: timestamp_digits,
                        },
                        ..DisplayFormats::default().timestamp
                    },
                    binary: BinaryDisplayFormat {
                        encoding: BinaryDisplayEncoding::Base64,
                        preview_bytes,
                    },
                    ..DisplayFormats::default()
                },
                ..AppSettingsV1::default()
            };
            assert_eq!(settings.validate(), Ok(()));
        }
    }

    #[test]
    fn display_formats_reject_out_of_range_values_with_wire_paths() {
        let cases = [
            (
                DisplayFormats {
                    floating_point: FloatingPointDisplayFormat {
                        precision: 0,
                        ..DisplayFormats::default().floating_point
                    },
                    ..DisplayFormats::default()
                },
                "settings.displayFormats.floatingPoint.precision",
            ),
            (
                DisplayFormats {
                    decimal: DecimalDisplayFormat {
                        scale: DecimalScale::Fixed { digits: 39 },
                        ..DisplayFormats::default().decimal
                    },
                    ..DisplayFormats::default()
                },
                "settings.displayFormats.decimal.scale.digits",
            ),
            (
                DisplayFormats {
                    timestamp: TimestampDisplayFormat {
                        fractional_digits: TimestampFractionalDigits::Fixed { digits: 10 },
                        ..DisplayFormats::default().timestamp
                    },
                    ..DisplayFormats::default()
                },
                "settings.displayFormats.timestamp.fractionalDigits.digits",
            ),
            (
                DisplayFormats {
                    binary: BinaryDisplayFormat {
                        preview_bytes: 0,
                        ..DisplayFormats::default().binary
                    },
                    ..DisplayFormats::default()
                },
                "settings.displayFormats.binary.previewBytes",
            ),
            (
                DisplayFormats {
                    string: StringDisplayFormat {
                        maximum_visible_lines: 3,
                        ..DisplayFormats::default().string
                    },
                    ..DisplayFormats::default()
                },
                "settings.displayFormats.string.maximumVisibleLines",
            ),
        ];

        for (display_formats, expected_path) in cases {
            let error = AppSettingsV1 {
                display_formats,
                ..AppSettingsV1::default()
            }
            .validate()
            .unwrap_err();
            assert!(error.starts_with(expected_path), "{error}");
        }
    }
}
