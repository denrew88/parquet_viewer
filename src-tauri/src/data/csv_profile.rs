use crate::domain::{
    ColumnSchema, CsvColumnInference, CsvColumnProfile, CsvConversionFailurePolicy,
    CsvParsingProfile, CsvProfileMode, CsvTargetType, CsvTimezonePolicy, DataError, DataValue,
    ValueKind,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SUPPORTED_DATE_FORMATS: &[&str] = &["YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY"];
const SUPPORTED_TIMESTAMP_FORMATS: &[&str] = &[
    "YYYY-MM-DDTHH:mm:ss",
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DDTHH:mm:ssZ",
    "YYYY-MM-DD HH:mm:ssZ",
];

pub fn infer_columns(columns: &[ColumnSchema], rows: &[Vec<String>]) -> Vec<CsvColumnInference> {
    columns
        .iter()
        .enumerate()
        .map(|(source_index, column)| {
            let values = rows
                .iter()
                .filter_map(|row| row.get(source_index))
                .map(String::as_str)
                .filter(|value| !value.is_empty() && !matches!(*value, "NULL" | "N/A"))
                .collect::<Vec<_>>();
            infer_column(source_index, column.name.clone(), &values)
        })
        .collect()
}

pub fn default_profile(
    mode: CsvProfileMode,
    generation: u64,
    columns: &[ColumnSchema],
) -> CsvParsingProfile {
    let target = match mode {
        CsvProfileMode::Auto => CsvTargetType::Auto,
        CsvProfileMode::AllText => CsvTargetType::Text,
        CsvProfileMode::Custom => CsvTargetType::Auto,
    };
    CsvParsingProfile {
        mode,
        generation,
        columns: columns
            .iter()
            .enumerate()
            .map(|(index, column)| CsvColumnProfile::new(index, column.name.clone(), target))
            .collect(),
    }
}

pub fn normalize_profile(
    profile: &CsvParsingProfile,
    columns: &[ColumnSchema],
) -> Result<CsvParsingProfile, DataError> {
    if profile.generation == 0 {
        return Err(DataError::invalid_request(
            "CSV profile generation must be positive.",
        ));
    }
    if profile.columns.len() != columns.len() {
        return Err(DataError::invalid_request(format!(
            "CSV profile has {} columns but the source has {}.",
            profile.columns.len(),
            columns.len()
        )));
    }
    for (index, (profile_column, source_column)) in profile.columns.iter().zip(columns).enumerate()
    {
        if profile_column.source_index != index || profile_column.source_name != source_column.name
        {
            return Err(DataError::invalid_request(format!(
                "CSV profile column {index} does not match the active source schema."
            )));
        }
        validate_column_options(profile_column)?;
    }
    Ok(profile.clone())
}

pub fn resolved_type(
    mode: CsvProfileMode,
    column: &CsvColumnProfile,
    inference: &CsvColumnInference,
) -> CsvTargetType {
    match mode {
        CsvProfileMode::AllText => CsvTargetType::Text,
        CsvProfileMode::Auto if column.target_type == CsvTargetType::Auto => {
            inference.recommended_type
        }
        _ if column.target_type == CsvTargetType::Auto => inference.recommended_type,
        _ => column.target_type,
    }
}

pub fn validate_resolved_profile(
    profile: &CsvParsingProfile,
    inferences: &[CsvColumnInference],
) -> Result<(), DataError> {
    for (column, inference) in profile.columns.iter().zip(inferences) {
        let target = resolved_type(profile.mode, column, inference);
        if matches!(target, CsvTargetType::Float64 | CsvTargetType::Decimal)
            && separators_conflict(column)
        {
            return Err(DataError::invalid_request(format!(
                "Decimal and thousand separators must differ for column '{}'.",
                column.source_name
            )));
        }
    }
    Ok(())
}

pub fn convert_value(raw: &str, target: CsvTargetType, options: &CsvColumnProfile) -> DataValue {
    convert_value_with_display(raw, target, options, true)
}

pub(crate) fn convert_value_for_query(
    raw: &str,
    target: CsvTargetType,
    options: &CsvColumnProfile,
) -> DataValue {
    convert_value_with_display(raw, target, options, false)
}

fn convert_value_with_display(
    raw: &str,
    target: CsvTargetType,
    options: &CsvColumnProfile,
    format_display: bool,
) -> DataValue {
    let value = if options.trim { raw.trim() } else { raw };
    if options.null_tokens.iter().any(|token| token == value) {
        return DataValue::converted_null(raw);
    }
    if value.is_empty() {
        return DataValue::empty(raw);
    }

    let converted = match target {
        CsvTargetType::Auto | CsvTargetType::Text => {
            return DataValue::converted(ValueKind::String, value, raw);
        }
        CsvTargetType::Skip => {
            return DataValue::invalid(
                ValueKind::Unsupported,
                raw,
                "csvSkippedColumn",
                "Skipped columns cannot be converted.",
            );
        }
        CsvTargetType::Boolean => {
            parse_boolean(value, options).map(|value| (ValueKind::Boolean, value.to_string()))
        }
        CsvTargetType::Int64 => normalize_integer(value, options)
            .and_then(|value| value.parse::<i64>().ok().map(|_| value))
            .map(|value| (ValueKind::Int, value)),
        CsvTargetType::UInt64 => normalize_integer(value, options)
            .and_then(|value| value.parse::<u64>().ok().map(|_| value))
            .map(|value| (ValueKind::Int, value)),
        CsvTargetType::Float64 => normalize_decimal(value, options)
            .filter(|value| value.parse::<f64>().is_ok_and(f64::is_finite))
            .map(|value| (ValueKind::Float, value)),
        CsvTargetType::Decimal => normalize_decimal(value, options)
            .filter(|value| is_decimal(value))
            .map(|value| (ValueKind::Decimal, value)),
        CsvTargetType::Date => parse_date_with_formats(value, &options.temporal_formats)
            .map(|value| (ValueKind::Date, value)),
        CsvTargetType::Timestamp => parse_timestamp_with_formats(
            value,
            &options.temporal_formats,
            options.timezone_policy,
            options.timezone_offset_minutes,
        )
        .map(|value| (ValueKind::Timestamp, value)),
    };

    converted.map_or_else(
        || match options.failure_policy {
            CsvConversionFailurePolicy::AsNull => DataValue::converted_null(raw),
            CsvConversionFailurePolicy::PreserveInvalid | CsvConversionFailurePolicy::Fail => {
                DataValue::invalid(
                    value_kind(target),
                    raw,
                    "csvConversionFailed",
                    format!("Value cannot be converted to {target:?}."),
                )
            }
        },
        |(kind, normalized)| {
            let display = if format_display {
                format_numeric_display(&normalized, kind, options)
            } else {
                normalized.clone()
            };
            DataValue::converted(kind, display, raw).with_source(normalized)
        },
    )
}

pub(crate) fn format_numeric_display(
    normalized: &str,
    kind: ValueKind,
    options: &CsvColumnProfile,
) -> String {
    if !matches!(kind, ValueKind::Int | ValueKind::Float | ValueKind::Decimal) {
        return normalized.to_owned();
    }
    let exponent_index = normalized.find(['e', 'E']).unwrap_or(normalized.len());
    let (mantissa, exponent) = normalized.split_at(exponent_index);
    let (sign, unsigned) = mantissa
        .strip_prefix('-')
        .map_or_else(|| ("", mantissa), |value| ("-", value));
    let (sign, unsigned) = unsigned
        .strip_prefix('+')
        .map_or((sign, unsigned), |value| ("+", value));
    let (integer, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(integer, fraction)| {
            (integer, Some(fraction))
        });
    if integer.is_empty() || !integer.chars().all(|character| character.is_ascii_digit()) {
        return normalized.to_owned();
    }

    let grouped = options.thousand_separator.as_deref().map_or_else(
        || integer.to_owned(),
        |separator| {
            let mut groups = Vec::new();
            let mut end = integer.len();
            while end > 3 {
                groups.push(&integer[end - 3..end]);
                end -= 3;
            }
            groups.push(&integer[..end]);
            groups.reverse();
            groups.join(separator)
        },
    );
    let decimal = if matches!(kind, ValueKind::Float | ValueKind::Decimal) {
        options.decimal_separator.as_str()
    } else {
        "."
    };
    fraction.map_or_else(
        || format!("{sign}{grouped}{exponent}"),
        |fraction| format!("{sign}{grouped}{decimal}{fraction}{exponent}"),
    )
}

fn infer_column(source_index: usize, source_name: String, values: &[&str]) -> CsvColumnInference {
    if values.is_empty() {
        return CsvColumnInference {
            source_index,
            source_name,
            recommended_type: CsvTargetType::Text,
            confidence: 0.0,
            non_null_samples: 0,
            ambiguous: true,
        };
    }

    let leading_zero = values
        .iter()
        .any(|value| has_significant_leading_zero(value));
    let unsafe_integer = values.iter().any(|value| {
        value
            .trim_start_matches(['+', '-'])
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > MAX_SAFE_INTEGER)
    });
    let candidates = [
        (
            CsvTargetType::Boolean,
            success_ratio(values, |value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "true" | "false" | "0" | "1"
                )
            }),
        ),
        (
            CsvTargetType::Int64,
            success_ratio(values, |value| value.parse::<i64>().is_ok()),
        ),
        (
            CsvTargetType::UInt64,
            success_ratio(values, |value| value.parse::<u64>().is_ok()),
        ),
        (CsvTargetType::Decimal, success_ratio(values, is_decimal)),
        (
            CsvTargetType::Float64,
            success_ratio(values, |value| {
                value.parse::<f64>().is_ok_and(f64::is_finite)
            }),
        ),
        (
            CsvTargetType::Date,
            success_ratio(values, |value| {
                parse_date_with_formats(value, &[]).is_some()
            }),
        ),
        (
            CsvTargetType::Timestamp,
            success_ratio(values, |value| {
                parse_timestamp_with_formats(value, &[], CsvTimezonePolicy::Preserve, None)
                    .is_some()
            }),
        ),
    ];
    let exact = candidates
        .iter()
        .filter(|(_, confidence)| *confidence == 1.0)
        .map(|(candidate, _)| *candidate)
        .collect::<Vec<_>>();
    let mut recommended_type = exact.first().copied().unwrap_or(CsvTargetType::Text);
    let mut confidence = candidates
        .iter()
        .map(|(_, confidence)| *confidence)
        .fold(0.0_f64, f64::max);
    let mut ambiguous = exact.len() > 1 || (confidence > 0.0 && confidence < 1.0);

    if leading_zero || unsafe_integer {
        recommended_type = CsvTargetType::Text;
        confidence = 0.55;
        ambiguous = true;
    } else if exact.is_empty() {
        recommended_type = CsvTargetType::Text;
        confidence = if confidence == 0.0 { 1.0 } else { confidence };
    } else if exact.contains(&CsvTargetType::Timestamp) {
        recommended_type = CsvTargetType::Timestamp;
    } else if exact.contains(&CsvTargetType::Date) {
        recommended_type = CsvTargetType::Date;
    } else if exact.contains(&CsvTargetType::Boolean) {
        recommended_type = CsvTargetType::Boolean;
    } else if exact.contains(&CsvTargetType::Int64)
        && values.iter().any(|value| value.starts_with('-'))
    {
        recommended_type = CsvTargetType::Int64;
    } else if exact.contains(&CsvTargetType::UInt64) {
        recommended_type = CsvTargetType::UInt64;
    } else if exact.contains(&CsvTargetType::Int64) {
        recommended_type = CsvTargetType::Int64;
    } else if exact.contains(&CsvTargetType::Decimal) {
        recommended_type = CsvTargetType::Decimal;
    }

    CsvColumnInference {
        source_index,
        source_name,
        recommended_type,
        confidence,
        non_null_samples: values.len(),
        ambiguous,
    }
}

fn validate_column_options(column: &CsvColumnProfile) -> Result<(), DataError> {
    single_character(&column.decimal_separator, "decimal separator")?;
    column
        .thousand_separator
        .as_deref()
        .map(|separator| single_character(separator, "thousand separator"))
        .transpose()?;
    if matches!(
        column.target_type,
        CsvTargetType::Float64 | CsvTargetType::Decimal
    ) && separators_conflict(column)
    {
        return Err(DataError::invalid_request(
            "Decimal and thousand separators must differ.",
        ));
    }
    if column.timezone_policy == CsvTimezonePolicy::FixedOffset
        && !column
            .timezone_offset_minutes
            .is_some_and(|offset| (-1_439..=1_439).contains(&offset))
    {
        return Err(DataError::invalid_request(
            "Fixed timezone offset must be between -1439 and 1439 minutes.",
        ));
    }
    if column
        .temporal_formats
        .iter()
        .any(|format| !is_supported_temporal_format(format))
    {
        return Err(DataError::invalid_request(
            "CSV temporal format is not supported.",
        ));
    }
    if column.true_tokens.iter().any(|true_token| {
        column
            .false_tokens
            .iter()
            .any(|false_token| false_token.eq_ignore_ascii_case(true_token))
    }) {
        return Err(DataError::invalid_request(
            "Boolean true and false token lists must not overlap.",
        ));
    }
    Ok(())
}

fn separators_conflict(column: &CsvColumnProfile) -> bool {
    column
        .thousand_separator
        .as_deref()
        .is_some_and(|separator| separator == column.decimal_separator)
}

fn single_character(value: &str, label: &str) -> Result<char, DataError> {
    let mut characters = value.chars();
    let character = characters
        .next()
        .filter(|character| *character != '\r' && *character != '\n')
        .ok_or_else(|| DataError::invalid_request(format!("CSV {label} must be one character.")))?;
    if characters.next().is_some() {
        return Err(DataError::invalid_request(format!(
            "CSV {label} must be one character."
        )));
    }
    Ok(character)
}

fn parse_boolean(value: &str, options: &CsvColumnProfile) -> Option<bool> {
    if options
        .true_tokens
        .iter()
        .any(|token| token.eq_ignore_ascii_case(value))
    {
        Some(true)
    } else if options
        .false_tokens
        .iter()
        .any(|token| token.eq_ignore_ascii_case(value))
    {
        Some(false)
    } else {
        None
    }
}

fn normalize_integer(value: &str, options: &CsvColumnProfile) -> Option<String> {
    let normalized = remove_thousands(value, options)?;
    let digits = normalized.trim_start_matches(['+', '-']);
    (!digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit()))
        .then_some(normalized)
}

fn normalize_decimal(value: &str, options: &CsvColumnProfile) -> Option<String> {
    let mut normalized = remove_thousands(value, options)?;
    let decimal = single_character(&options.decimal_separator, "decimal separator").ok()?;
    if options
        .thousand_separator
        .as_deref()
        .and_then(|separator| single_character(separator, "thousand separator").ok())
        == Some(decimal)
    {
        return None;
    }
    if decimal != '.' {
        normalized = normalized.replace(decimal, ".");
    }
    Some(normalized)
}

fn remove_thousands(value: &str, options: &CsvColumnProfile) -> Option<String> {
    match options.thousand_separator.as_deref() {
        Some(separator) => {
            let separator = single_character(separator, "thousand separator").ok()?;
            Some(value.replace(separator, ""))
        }
        None => Some(value.to_owned()),
    }
}

fn is_decimal(value: &str) -> bool {
    let value = value.trim_start_matches(['+', '-']);
    if value.is_empty() {
        return false;
    }
    let mut parts = value.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();
    parts.next().is_none()
        && (!integer.is_empty() || fraction.is_some_and(|value| !value.is_empty()))
        && integer.chars().all(|character| character.is_ascii_digit())
        && fraction.is_none_or(|value| {
            !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
        })
}

fn parse_date_with_formats(value: &str, formats: &[String]) -> Option<String> {
    let formats = if formats.is_empty() {
        SUPPORTED_DATE_FORMATS.to_vec()
    } else {
        formats
            .iter()
            .filter(|format| SUPPORTED_DATE_FORMATS.contains(&format.as_str()))
            .map(String::as_str)
            .collect()
    };
    for format in formats {
        let parsed = match format {
            "YYYY-MM-DD" => parse_date_parts(value, '-', false),
            "YYYY/MM/DD" => parse_date_parts(value, '/', false),
            "DD-MM-YYYY" => parse_date_parts(value, '-', true),
            _ => None,
        };
        if let Some((year, month, day)) =
            parsed.filter(|(year, month, day)| valid_date(*year, *month, *day))
        {
            return Some(format!("{year:04}-{month:02}-{day:02}"));
        }
    }
    None
}

fn parse_timestamp_with_formats(
    value: &str,
    formats: &[String],
    timezone_policy: CsvTimezonePolicy,
    timezone_offset_minutes: Option<i32>,
) -> Option<String> {
    let allowed = if formats.is_empty() {
        SUPPORTED_TIMESTAMP_FORMATS.to_vec()
    } else {
        formats
            .iter()
            .filter(|format| SUPPORTED_TIMESTAMP_FORMATS.contains(&format.as_str()))
            .map(String::as_str)
            .collect()
    };
    let (base, zone) = split_timezone(value)?;
    let separator = if base.as_bytes().get(10) == Some(&b'T') {
        'T'
    } else {
        ' '
    };
    let requires_zone = zone.is_some();
    let format = if separator == 'T' {
        if requires_zone {
            "YYYY-MM-DDTHH:mm:ssZ"
        } else {
            "YYYY-MM-DDTHH:mm:ss"
        }
    } else if requires_zone {
        "YYYY-MM-DD HH:mm:ssZ"
    } else {
        "YYYY-MM-DD HH:mm:ss"
    };
    if !allowed.contains(&format) || base.len() < 19 {
        return None;
    }
    let date = parse_date_with_formats(base.get(..10)?, &[])?;
    let time = base.get(11..)?;
    let (clock, fraction) = time
        .split_once('.')
        .map_or((time, None), |(clock, fraction)| (clock, Some(fraction)));
    let mut parts = clock.split(':');
    let hour = parts.next()?.parse::<u32>().ok()?;
    let minute = parts.next()?.parse::<u32>().ok()?;
    let second = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some()
        || hour > 23
        || minute > 59
        || second > 59
        || fraction.is_some_and(|fraction| {
            fraction.is_empty()
                || fraction.len() > 9
                || !fraction.chars().all(|character| character.is_ascii_digit())
        })
    {
        return None;
    }
    let fraction = fraction.map_or(String::new(), |value| format!(".{value}"));
    let zone = match zone {
        Some(zone) => zone,
        None => match timezone_policy {
            CsvTimezonePolicy::Preserve => String::new(),
            CsvTimezonePolicy::AssumeUtc => String::from("Z"),
            CsvTimezonePolicy::FixedOffset => format_offset(timezone_offset_minutes?),
        },
    };
    Some(format!(
        "{date}T{hour:02}:{minute:02}:{second:02}{fraction}{zone}"
    ))
}

fn split_timezone(value: &str) -> Option<(&str, Option<String>)> {
    if let Some(base) = value.strip_suffix('Z') {
        return Some((base, Some(String::from("Z"))));
    }
    if value.len() >= 25 {
        let zone = value.get(value.len() - 6..)?;
        let bytes = zone.as_bytes();
        if matches!(bytes[0], b'+' | b'-')
            && bytes[3] == b':'
            && zone[1..3].parse::<u32>().is_ok_and(|hour| hour <= 23)
            && zone[4..6].parse::<u32>().is_ok_and(|minute| minute <= 59)
        {
            return Some((value.get(..value.len() - 6)?, Some(zone.to_owned())));
        }
    }
    Some((value, None))
}

fn parse_date_parts(value: &str, separator: char, day_first: bool) -> Option<(i32, u32, u32)> {
    let parts = value.split(separator).collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    if day_first {
        Some((
            parts[2].parse().ok()?,
            parts[1].parse().ok()?,
            parts[0].parse().ok()?,
        ))
    } else {
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    }
}

fn valid_date(year: i32, month: u32, day: u32) -> bool {
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

fn format_offset(minutes: i32) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let minutes = minutes.unsigned_abs();
    format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

fn is_supported_temporal_format(format: &str) -> bool {
    SUPPORTED_DATE_FORMATS.contains(&format) || SUPPORTED_TIMESTAMP_FORMATS.contains(&format)
}

fn has_significant_leading_zero(value: &str) -> bool {
    let unsigned = value.trim_start_matches(['+', '-']);
    unsigned.len() > 1
        && unsigned.starts_with('0')
        && unsigned.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
}

fn success_ratio(values: &[&str], predicate: impl Fn(&str) -> bool) -> f64 {
    values.iter().filter(|value| predicate(value)).count() as f64 / values.len() as f64
}

fn value_kind(target: CsvTargetType) -> ValueKind {
    match target {
        CsvTargetType::Text | CsvTargetType::Auto => ValueKind::String,
        CsvTargetType::Boolean => ValueKind::Boolean,
        CsvTargetType::Int64 | CsvTargetType::UInt64 => ValueKind::Int,
        CsvTargetType::Float64 => ValueKind::Float,
        CsvTargetType::Decimal => ValueKind::Decimal,
        CsvTargetType::Date => ValueKind::Date,
        CsvTargetType::Timestamp => ValueKind::Timestamp,
        CsvTargetType::Skip => ValueKind::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::DataValueState;

    fn columns(names: &[&str]) -> Vec<ColumnSchema> {
        names
            .iter()
            .map(|name| ColumnSchema {
                name: (*name).to_owned(),
                logical_type: String::from("Utf8"),
                nullable: false,
                physical_type: String::from("UTF8"),
            })
            .collect()
    }

    #[test]
    fn csv_002_infers_supported_scalar_types() {
        let schema = columns(&["bool", "int", "uint", "float", "decimal", "date", "ts"]);
        let rows = vec![
            vec![
                "true",
                "-2",
                "2",
                "1e3",
                "1.20",
                "2026-07-15",
                "2026-07-15T12:30:00Z",
            ],
            vec![
                "false",
                "-3",
                "3",
                "2e3",
                "2.30",
                "2024-02-29",
                "2026-07-16T01:02:03Z",
            ],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(String::from).collect())
        .collect::<Vec<_>>();
        let inferred = infer_columns(&schema, &rows);
        let types = inferred
            .iter()
            .map(|column| column.recommended_type)
            .collect::<Vec<_>>();
        assert_eq!(
            types,
            [
                CsvTargetType::Boolean,
                CsvTargetType::Int64,
                CsvTargetType::UInt64,
                CsvTargetType::Float64,
                CsvTargetType::Decimal,
                CsvTargetType::Date,
                CsvTargetType::Timestamp,
            ]
        );
    }

    #[test]
    fn csv_003_leading_zero_and_unsafe_integer_are_conservative_text() {
        let schema = columns(&["code", "account"]);
        let rows = vec![
            vec![String::from("0012"), String::from("9007199254740993")],
            vec![String::from("0013"), String::from("9007199254740994")],
        ];
        let inferred = infer_columns(&schema, &rows);
        assert!(inferred.iter().all(|column| {
            column.recommended_type == CsvTargetType::Text
                && column.ambiguous
                && column.confidence < 1.0
        }));
    }

    #[test]
    fn csv_008_009_options_preserve_null_empty_invalid_and_raw() {
        let mut options = CsvColumnProfile::new(0, String::from("amount"), CsvTargetType::Decimal);
        options.trim = true;
        options.decimal_separator = String::from(",");
        options.thousand_separator = Some(String::from("."));
        options.null_tokens = vec![String::from("NULL")];

        let valid = convert_value(" 1.234,50 ", CsvTargetType::Decimal, &options);
        assert_eq!(valid.display.as_deref(), Some("1.234,50"));
        assert_eq!(valid.raw_display.as_deref(), Some(" 1.234,50 "));
        assert_eq!(valid.state, DataValueState::Valid);
        assert_eq!(
            convert_value("NULL", CsvTargetType::Decimal, &options).state,
            DataValueState::Null
        );
        assert_eq!(
            convert_value("", CsvTargetType::Decimal, &options).state,
            DataValueState::Empty
        );
        let invalid = convert_value("bad", CsvTargetType::Decimal, &options);
        assert_eq!(invalid.state, DataValueState::Invalid);
        assert_eq!(invalid.display.as_deref(), Some("bad"));
        assert!(invalid.diagnostic.is_some());
    }

    #[test]
    fn csv_numeric_separators_cover_supported_locale_combinations() {
        let cases = [
            (
                "1,234.50",
                ".",
                Some(","),
                CsvTargetType::Decimal,
                "1,234.50",
                "1234.50",
            ),
            (
                "1.234,50",
                ",",
                Some("."),
                CsvTargetType::Decimal,
                "1.234,50",
                "1234.50",
            ),
            (
                "1 234,50",
                ",",
                Some(" "),
                CsvTargetType::Float64,
                "1 234,50",
                "1234.50",
            ),
            (
                "1234,50",
                ",",
                None,
                CsvTargetType::Decimal,
                "1234,50",
                "1234.50",
            ),
            (
                "-9,876",
                ".",
                Some(","),
                CsvTargetType::Int64,
                "-9,876",
                "-9876",
            ),
            (
                "9 876",
                ".",
                Some(" "),
                CsvTargetType::UInt64,
                "9 876",
                "9876",
            ),
        ];

        for (raw, decimal, thousands, target, expected, normalized) in cases {
            let mut options = CsvColumnProfile::new(0, String::from("amount"), target);
            options.decimal_separator = decimal.to_owned();
            options.thousand_separator = thousands.map(str::to_owned);

            let converted = convert_value(raw, target, &options);
            assert_eq!(converted.state, DataValueState::Valid, "raw value: {raw}");
            assert_eq!(
                converted.display.as_deref(),
                Some(expected),
                "raw value: {raw}"
            );
            let query_value = convert_value_for_query(raw, target, &options);
            assert_eq!(
                query_value.display.as_deref(),
                Some(normalized),
                "raw value: {raw}"
            );
        }
    }

    #[test]
    fn csv_profile_rejects_identical_decimal_and_thousands_separators() {
        let schema = columns(&["amount"]);
        for target in [CsvTargetType::Float64, CsvTargetType::Decimal] {
            let mut profile = default_profile(CsvProfileMode::Custom, 1, &schema);
            profile.columns[0].target_type = target;
            profile.columns[0].decimal_separator = String::from(",");
            profile.columns[0].thousand_separator = Some(String::from(","));

            let error = normalize_profile(&profile, &schema).unwrap_err();
            assert_eq!(error.code, crate::domain::DataErrorCode::InvalidRequest);
            assert!(error
                .to_string()
                .contains("Decimal and thousand separators must differ"));
        }
    }

    #[test]
    fn csv_integer_grouping_formats_display_without_changing_query_value() {
        let schema = columns(&["amount"]);
        let mut profile = default_profile(CsvProfileMode::Custom, 1, &schema);
        profile.columns[0].target_type = CsvTargetType::UInt64;
        profile.columns[0].thousand_separator = Some(String::from(","));
        let normalized = normalize_profile(&profile, &schema).unwrap();

        let display = convert_value("10001", CsvTargetType::UInt64, &normalized.columns[0]);
        let query = convert_value_for_query("10001", CsvTargetType::UInt64, &normalized.columns[0]);
        assert_eq!(display.display.as_deref(), Some("10,001"));
        assert_eq!(query.display.as_deref(), Some("10001"));

        profile.columns[0].thousand_separator = Some(String::from("."));
        let dot_profile = normalize_profile(&profile, &schema).unwrap();
        let dot_display = convert_value("10001", CsvTargetType::UInt64, &dot_profile.columns[0]);
        assert_eq!(dot_display.display.as_deref(), Some("10.001"));
    }

    #[test]
    fn csv_008_boolean_date_timestamp_and_failure_policy_are_applied() {
        let mut boolean = CsvColumnProfile::new(0, String::from("flag"), CsvTargetType::Boolean);
        boolean.true_tokens = vec![String::from("Y")];
        boolean.false_tokens = vec![String::from("N")];
        assert_eq!(
            convert_value("Y", CsvTargetType::Boolean, &boolean)
                .display
                .as_deref(),
            Some("true")
        );

        let mut date = CsvColumnProfile::new(0, String::from("date"), CsvTargetType::Date);
        date.temporal_formats = vec![String::from("DD-MM-YYYY")];
        assert_eq!(
            convert_value("29-02-2024", CsvTargetType::Date, &date)
                .display
                .as_deref(),
            Some("2024-02-29")
        );

        let mut timestamp =
            CsvColumnProfile::new(0, String::from("timestamp"), CsvTargetType::Timestamp);
        timestamp.timezone_policy = CsvTimezonePolicy::FixedOffset;
        timestamp.timezone_offset_minutes = Some(540);
        assert_eq!(
            convert_value("2026-07-15 12:30:00", CsvTargetType::Timestamp, &timestamp)
                .display
                .as_deref(),
            Some("2026-07-15T12:30:00+09:00")
        );

        boolean.failure_policy = CsvConversionFailurePolicy::AsNull;
        assert_eq!(
            convert_value("?", CsvTargetType::Boolean, &boolean).state,
            DataValueState::Null
        );
    }
}
