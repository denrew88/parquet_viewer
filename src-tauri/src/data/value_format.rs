use crate::domain::{
    DataError, DataValue, DateDisplayFormat, DisplayFormats, DurationDisplayStyle,
    DurationUnitSuffix, TimestampDateTimeSeparator, TimestampFractionalDigits, TimestampTimeFormat,
    TimestampTimezoneSuffix, ValueKind,
};
use arrow_array::{
    Array, BinaryArray, BooleanArray, Date32Array, Date64Array, Decimal128Array, Decimal256Array,
    DurationMicrosecondArray, DurationMillisecondArray, DurationNanosecondArray,
    DurationSecondArray, FixedSizeBinaryArray, FixedSizeListArray, Float32Array, Float64Array,
    Int16Array, Int32Array, Int64Array, Int8Array, LargeBinaryArray, LargeListArray,
    LargeStringArray, ListArray, MapArray, StringArray, StructArray, TimestampMicrosecondArray,
    TimestampMillisecondArray, TimestampNanosecondArray, TimestampSecondArray, UInt16Array,
    UInt32Array, UInt64Array, UInt8Array,
};
use arrow_schema::{DataType, TimeUnit};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use chrono_tz::Tz;
use std::path::Path;

pub(crate) fn format_data_value_display(value: &DataValue, formats: &DisplayFormats) -> DataValue {
    if value.display.is_none() || value.state == crate::domain::DataValueState::Invalid {
        return value.clone();
    }
    let display = match value.kind {
        ValueKind::Timestamp => format_timestamp_display(value, formats),
        ValueKind::Duration => format_duration_display(value, formats),
        _ => value.display.clone().unwrap_or_default(),
    };
    if value.display.as_deref() == Some(display.as_str()) {
        value.clone()
    } else {
        let mut formatted = value.clone();
        formatted.raw_display = formatted.raw_display.or_else(|| formatted.display.clone());
        formatted.display = Some(display);
        formatted
    }
}

fn format_timestamp_display(value: &DataValue, formats: &DisplayFormats) -> String {
    let source = value.display.as_deref().unwrap_or_default();
    let normalized = source.replace('T', " ");
    let Some((date, clock)) = normalized.split_once(' ') else {
        return source.to_owned();
    };
    let date_parts = date.split('-').collect::<Vec<_>>();
    if date_parts.len() != 3 {
        return source.to_owned();
    }
    let (clock, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let clock_parts = clock.split(':').collect::<Vec<_>>();
    if clock_parts.len() != 3 {
        return source.to_owned();
    }
    let date = display_date(
        date_parts[0],
        date_parts[1],
        date_parts[2],
        formats.timestamp.date_format,
    );
    if formats.timestamp.time_format == TimestampTimeFormat::Hidden {
        return date;
    }
    let separator = match formats.timestamp.date_time_separator {
        TimestampDateTimeSeparator::Space => " ",
        TimestampDateTimeSeparator::T => "T",
    };
    let mut time = match formats.timestamp.time_format {
        TimestampTimeFormat::HourMinuteSecond => {
            format!("{}:{}:{}", clock_parts[0], clock_parts[1], clock_parts[2])
        }
        TimestampTimeFormat::HourMinute => format!("{}:{}", clock_parts[0], clock_parts[1]),
        TimestampTimeFormat::Hidden => unreachable!(),
    };
    if formats.timestamp.time_format == TimestampTimeFormat::HourMinuteSecond {
        let digits = match formats.timestamp.fractional_digits {
            TimestampFractionalDigits::Preserve => fraction.len(),
            TimestampFractionalDigits::Fixed { digits } => usize::from(digits),
        };
        if digits > 0 {
            let mut adjusted = fraction.to_owned();
            adjusted.truncate(digits);
            while adjusted.len() < digits {
                adjusted.push('0');
            }
            time.push('.');
            time.push_str(&adjusted);
        }
    }
    let suffix = match formats.timestamp.timezone_suffix {
        TimestampTimezoneSuffix::Hidden => String::new(),
        TimestampTimezoneSuffix::Name => value
            .timezone
            .as_deref()
            .map(|timezone| format!(" [{timezone}]"))
            .unwrap_or_default(),
        TimestampTimezoneSuffix::Offset => timestamp_offset_suffix(value).unwrap_or_default(),
    };
    format!("{date}{separator}{time}{suffix}")
}

fn display_date(year: &str, month: &str, day: &str, format: DateDisplayFormat) -> String {
    match format {
        DateDisplayFormat::YearMonthDayDash => format!("{year}-{month}-{day}"),
        DateDisplayFormat::YearMonthDaySlash => format!("{year}/{month}/{day}"),
        DateDisplayFormat::DayMonthYearDash => format!("{day}-{month}-{year}"),
        DateDisplayFormat::MonthDayYearDash => format!("{month}-{day}-{year}"),
    }
}

fn timestamp_offset_suffix(value: &DataValue) -> Option<String> {
    use chrono::Offset;

    let raw = value.source_display.as_deref()?.parse::<i64>().ok()?;
    let unit = value.unit.as_deref()?;
    let (seconds, nanos) = match unit {
        "s" => (raw, 0),
        "ms" => (raw.div_euclid(1_000), raw.rem_euclid(1_000) * 1_000_000),
        "us" => (raw.div_euclid(1_000_000), raw.rem_euclid(1_000_000) * 1_000),
        "ns" => (raw.div_euclid(1_000_000_000), raw.rem_euclid(1_000_000_000)),
        _ => return None,
    };
    let utc = DateTime::<Utc>::from_timestamp(seconds, nanos as u32)?;
    let timezone = value.timezone.as_deref()?;
    let seconds = if timezone == "UTC" || timezone == "Etc/UTC" {
        0
    } else if let Ok(zone) = timezone.parse::<Tz>() {
        utc.with_timezone(&zone).offset().fix().local_minus_utc()
    } else {
        parse_fixed_offset(timezone)?.local_minus_utc()
    };
    let sign = if seconds < 0 { '-' } else { '+' };
    let seconds = seconds.abs();
    Some(format!(
        "{sign}{:02}:{:02}",
        seconds / 3_600,
        seconds % 3_600 / 60
    ))
}

fn format_duration_display(value: &DataValue, formats: &DisplayFormats) -> String {
    let Some(source) = value.source_display.as_deref() else {
        return value.display.clone().unwrap_or_default();
    };
    let Ok(count) = source.parse::<i64>() else {
        return value.display.clone().unwrap_or_default();
    };
    let Some(unit) = value.unit.as_deref() else {
        return value.display.clone().unwrap_or_default();
    };
    let multiplier = match unit {
        "s" => 1_000_000_000_i128,
        "ms" => 1_000_000_i128,
        "us" => 1_000_i128,
        "ns" => 1_i128,
        _ => return value.display.clone().unwrap_or_default(),
    };
    let negative = count < 0;
    let nanoseconds = i128::from(count).abs().saturating_mul(multiplier);
    let seconds = nanoseconds / 1_000_000_000;
    let fraction = nanoseconds % 1_000_000_000;
    let preserve = match unit {
        "s" => 0,
        "ms" => 3,
        "us" => 6,
        "ns" => 9,
        _ => 0,
    };
    let digits = match formats.duration.fractional_digits {
        TimestampFractionalDigits::Preserve => preserve,
        TimestampFractionalDigits::Fixed { digits } => usize::from(digits),
    };
    let fraction = if digits == 0 {
        String::new()
    } else {
        let full = format!("{fraction:09}");
        format!(".{}", &full[..digits])
    };
    let sign = if negative { "-" } else { "" };
    let display = match formats.duration.style {
        DurationDisplayStyle::TotalSeconds => format!("{sign}{seconds}{fraction} s"),
        DurationDisplayStyle::TotalHours => format!(
            "{sign}{:02}:{:02}:{:02}{fraction}",
            seconds / 3_600,
            seconds % 3_600 / 60,
            seconds % 60
        ),
        DurationDisplayStyle::DaysClock => {
            let days = seconds / 86_400;
            let clock = format!(
                "{:02}:{:02}:{:02}{fraction}",
                seconds % 86_400 / 3_600,
                seconds % 3_600 / 60,
                seconds % 60
            );
            if days == 0 {
                format!("{sign}{clock}")
            } else {
                format!("{sign}{days}d {clock}")
            }
        }
    };
    if formats.duration.unit_suffix == DurationUnitSuffix::Source {
        format!("{display} [unit={unit}]")
    } else {
        display
    }
}

const MAX_BINARY_PREVIEW_BYTES: usize = 256;
const MAX_NESTED_COLLECTION_ITEMS: usize = 32;
const MAX_NESTED_DEPTH: usize = 8;
const MAX_NESTED_SCALAR_BYTES: usize = 1_024;
const MAX_NESTED_DISPLAY_BYTES: usize = 16 * 1_024;
const MAX_FULL_VALUE_INPUT_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn value_at(array: &dyn Array, index: usize) -> Result<DataValue, DataError> {
    if array.is_null(index) {
        return Ok(DataValue::null());
    }

    macro_rules! display_value {
        ($array_type:ty, $kind:expr) => {{
            let values = downcast::<$array_type>(array)?;
            DataValue::displayed($kind, values.value(index).to_string())
        }};
    }

    let value = match array.data_type() {
        DataType::Boolean => display_value!(BooleanArray, ValueKind::Boolean),
        DataType::Int8 => display_value!(Int8Array, ValueKind::Int),
        DataType::Int16 => display_value!(Int16Array, ValueKind::Int),
        DataType::Int32 => display_value!(Int32Array, ValueKind::Int),
        DataType::Int64 => display_value!(Int64Array, ValueKind::Int),
        DataType::UInt8 => display_value!(UInt8Array, ValueKind::Int),
        DataType::UInt16 => display_value!(UInt16Array, ValueKind::Int),
        DataType::UInt32 => display_value!(UInt32Array, ValueKind::Int),
        DataType::UInt64 => display_value!(UInt64Array, ValueKind::Int),
        DataType::Float32 => display_value!(Float32Array, ValueKind::Float),
        DataType::Float64 => display_value!(Float64Array, ValueKind::Float),
        DataType::Utf8 => display_value!(StringArray, ValueKind::String),
        DataType::LargeUtf8 => display_value!(LargeStringArray, ValueKind::String),
        DataType::Binary => binary_value(downcast::<BinaryArray>(array)?.value(index)),
        DataType::LargeBinary => binary_value(downcast::<LargeBinaryArray>(array)?.value(index)),
        DataType::FixedSizeBinary(_) => {
            binary_value(downcast::<FixedSizeBinaryArray>(array)?.value(index))
        }
        DataType::Decimal128(_, scale) => {
            let raw = downcast::<Decimal128Array>(array)?.value(index).to_string();
            DataValue::displayed(ValueKind::Decimal, format_decimal(raw, *scale))
        }
        DataType::Decimal256(_, scale) => {
            let raw = downcast::<Decimal256Array>(array)?.value(index).to_string();
            DataValue::displayed(ValueKind::Decimal, format_decimal(raw, *scale))
        }
        DataType::Date32 => {
            let days = i64::from(downcast::<Date32Array>(array)?.value(index));
            DataValue::displayed(ValueKind::Date, format_date(days))
        }
        DataType::Date64 => {
            let millis = downcast::<Date64Array>(array)?.value(index);
            DataValue::displayed(ValueKind::Date, format_date(millis.div_euclid(86_400_000)))
        }
        DataType::Timestamp(unit, timezone) => {
            let raw = timestamp_raw(array, index, unit)?;
            let display = format_timestamp(raw, unit, timezone.as_deref());
            let unit_name = match unit {
                TimeUnit::Second => "s",
                TimeUnit::Millisecond => "ms",
                TimeUnit::Microsecond => "us",
                TimeUnit::Nanosecond => "ns",
            };
            let timezone_suffix = timezone
                .as_deref()
                .map(|value| format!(", timezone={value}"))
                .unwrap_or_default();
            DataValue::converted(
                ValueKind::Timestamp,
                display,
                format!("{raw} [unit={unit_name}{timezone_suffix}]"),
            )
            .with_source(raw.to_string())
            .with_temporal_metadata(unit_name, timezone.as_deref())
        }
        DataType::Duration(unit) => {
            let raw = duration_raw(array, index, unit)?;
            let unit_name = time_unit_name(unit);
            DataValue::converted(
                ValueKind::Duration,
                format_duration(raw, unit),
                format!("{raw} [unit={unit_name}]"),
            )
            .with_source(raw.to_string())
            .with_temporal_metadata(unit_name, None)
        }
        DataType::List(_) => DataValue::displayed(
            ValueKind::List,
            list_display(downcast::<ListArray>(array)?.value(index).as_ref())?,
        ),
        DataType::LargeList(_) => DataValue::displayed(
            ValueKind::List,
            list_display(downcast::<LargeListArray>(array)?.value(index).as_ref())?,
        ),
        DataType::FixedSizeList(_, _) => DataValue::displayed(
            ValueKind::List,
            list_display(downcast::<FixedSizeListArray>(array)?.value(index).as_ref())?,
        ),
        DataType::Struct(_) => DataValue::displayed(
            ValueKind::Struct,
            struct_display(downcast::<StructArray>(array)?, index)?,
        ),
        DataType::Map(_, _) => DataValue::displayed(
            ValueKind::Map,
            map_display(downcast::<MapArray>(array)?, index)?,
        ),
        data_type => DataValue::displayed(
            ValueKind::Unsupported,
            format!("Unsupported value ({data_type})"),
        ),
    };

    Ok(value)
}

pub(crate) fn full_value_at(array: &dyn Array, index: usize) -> Result<DataValue, DataError> {
    if array.is_null(index) {
        return Ok(DataValue::null());
    }
    match array.data_type() {
        DataType::Binary => full_binary_value(downcast::<BinaryArray>(array)?.value(index)),
        DataType::LargeBinary => {
            full_binary_value(downcast::<LargeBinaryArray>(array)?.value(index))
        }
        DataType::FixedSizeBinary(_) => {
            full_binary_value(downcast::<FixedSizeBinaryArray>(array)?.value(index))
        }
        DataType::List(_)
        | DataType::LargeList(_)
        | DataType::FixedSizeList(_, _)
        | DataType::Struct(_)
        | DataType::Map(_, _) => {
            if array.get_buffer_memory_size() > MAX_FULL_VALUE_INPUT_BYTES {
                return Err(DataError::invalid_request(format!(
                    "The full nested value exceeds the {MAX_FULL_VALUE_INPUT_BYTES}-byte safety limit."
                )));
            }
            let display = canonical_full(array, index, 0)?;
            Ok(DataValue::displayed(
                value_kind_for_nested(array.data_type()),
                display,
            ))
        }
        _ => value_at(array, index),
    }
}

fn value_kind_for_nested(data_type: &DataType) -> ValueKind {
    match data_type {
        DataType::List(_) | DataType::LargeList(_) | DataType::FixedSizeList(_, _) => {
            ValueKind::List
        }
        DataType::Struct(_) => ValueKind::Struct,
        DataType::Map(_, _) => ValueKind::Map,
        _ => ValueKind::Unsupported,
    }
}

fn downcast<T: 'static>(array: &dyn Array) -> Result<&T, DataError> {
    array.as_any().downcast_ref::<T>().ok_or_else(|| {
        DataError::invalid_parquet(Path::new("<memory>"), "Arrow array type mismatch")
    })
}

fn binary_value(bytes: &[u8]) -> DataValue {
    let preview = &bytes[..bytes.len().min(MAX_BINARY_PREVIEW_BYTES)];
    DataValue::displayed(
        ValueKind::Binary,
        format!(
            "base64:{} ({} bytes)",
            STANDARD.encode(preview),
            bytes.len()
        ),
    )
}

fn full_binary_value(bytes: &[u8]) -> Result<DataValue, DataError> {
    if bytes.len() > MAX_FULL_VALUE_INPUT_BYTES {
        return Err(DataError::invalid_request(format!(
            "The full binary value exceeds the {MAX_FULL_VALUE_INPUT_BYTES}-byte safety limit."
        )));
    }
    Ok(DataValue::displayed(
        ValueKind::Binary,
        format!("base64:{} ({} bytes)", STANDARD.encode(bytes), bytes.len()),
    ))
}

fn format_decimal(mut raw: String, scale: i8) -> String {
    let negative = raw.starts_with('-');
    if negative {
        raw.remove(0);
    }

    let formatted = if scale == 0 {
        raw
    } else if scale < 0 {
        format!("{raw}{}", "0".repeat((-scale) as usize))
    } else {
        let scale = scale as usize;
        if raw.len() <= scale {
            format!("0.{}{raw}", "0".repeat(scale - raw.len()))
        } else {
            let split = raw.len() - scale;
            format!("{}.{}", &raw[..split], &raw[split..])
        }
    };

    if negative {
        format!("-{formatted}")
    } else {
        formatted
    }
}

fn format_date(days_since_epoch: i64) -> String {
    let (year, month, day) = civil_from_days(days_since_epoch);
    format!("{year:04}-{month:02}-{day:02}")
}

// Gregorian calendar conversion adapted from Howard Hinnant's civil calendar algorithm.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month as u32, day as u32)
}

fn timestamp_raw(array: &dyn Array, index: usize, unit: &TimeUnit) -> Result<i64, DataError> {
    match unit {
        TimeUnit::Second => Ok(downcast::<TimestampSecondArray>(array)?.value(index)),
        TimeUnit::Millisecond => Ok(downcast::<TimestampMillisecondArray>(array)?.value(index)),
        TimeUnit::Microsecond => Ok(downcast::<TimestampMicrosecondArray>(array)?.value(index)),
        TimeUnit::Nanosecond => Ok(downcast::<TimestampNanosecondArray>(array)?.value(index)),
    }
}

fn duration_raw(array: &dyn Array, index: usize, unit: &TimeUnit) -> Result<i64, DataError> {
    match unit {
        TimeUnit::Second => Ok(downcast::<DurationSecondArray>(array)?.value(index)),
        TimeUnit::Millisecond => Ok(downcast::<DurationMillisecondArray>(array)?.value(index)),
        TimeUnit::Microsecond => Ok(downcast::<DurationMicrosecondArray>(array)?.value(index)),
        TimeUnit::Nanosecond => Ok(downcast::<DurationNanosecondArray>(array)?.value(index)),
    }
}

fn time_unit_name(unit: &TimeUnit) -> &'static str {
    match unit {
        TimeUnit::Second => "s",
        TimeUnit::Millisecond => "ms",
        TimeUnit::Microsecond => "us",
        TimeUnit::Nanosecond => "ns",
    }
}

fn format_duration(raw: i64, unit: &TimeUnit) -> String {
    let negative = raw < 0;
    let absolute = i128::from(raw).abs();
    let multiplier = match unit {
        TimeUnit::Second => 1_000_000_000_i128,
        TimeUnit::Millisecond => 1_000_000_i128,
        TimeUnit::Microsecond => 1_000_i128,
        TimeUnit::Nanosecond => 1_i128,
    };
    let digits = match unit {
        TimeUnit::Second => 0,
        TimeUnit::Millisecond => 3,
        TimeUnit::Microsecond => 6,
        TimeUnit::Nanosecond => 9,
    };
    let nanoseconds = absolute * multiplier;
    let seconds = nanoseconds / 1_000_000_000;
    let fraction = nanoseconds % 1_000_000_000;
    let days = seconds / 86_400;
    let hours = seconds % 86_400 / 3_600;
    let minutes = seconds % 3_600 / 60;
    let remainder = seconds % 60;
    let sign = if negative { "-" } else { "" };
    let fraction = if digits == 0 {
        String::new()
    } else {
        let fraction = format!("{fraction:09}");
        format!(".{}", &fraction[..digits])
    };
    if days == 0 {
        format!("{sign}{hours:02}:{minutes:02}:{remainder:02}{fraction}")
    } else {
        format!("{sign}{days}d {hours:02}:{minutes:02}:{remainder:02}{fraction}")
    }
}

fn format_timestamp(raw: i64, unit: &TimeUnit, timezone: Option<&str>) -> String {
    let (seconds, nanos, precision) = match unit {
        TimeUnit::Second => (raw, 0, 0),
        TimeUnit::Millisecond => (raw.div_euclid(1_000), raw.rem_euclid(1_000) * 1_000_000, 3),
        TimeUnit::Microsecond => (
            raw.div_euclid(1_000_000),
            raw.rem_euclid(1_000_000) * 1_000,
            6,
        ),
        TimeUnit::Nanosecond => (
            raw.div_euclid(1_000_000_000),
            raw.rem_euclid(1_000_000_000),
            9,
        ),
    };
    let utc = DateTime::<Utc>::from_timestamp(seconds, nanos as u32);
    let local = utc.map(|value| {
        timezone
            .and_then(|name| {
                name.parse::<Tz>()
                    .ok()
                    .map(|zone| value.with_timezone(&zone).naive_local())
            })
            .or_else(|| {
                timezone
                    .and_then(parse_fixed_offset)
                    .map(|offset| value.with_timezone(&offset).naive_local())
            })
            .unwrap_or_else(|| value.naive_utc())
    });
    let Some(local) = local else {
        return raw.to_string();
    };
    let fraction = if precision == 0 {
        String::new()
    } else {
        let divisor = 10_i64.pow(9 - precision);
        format!(".{:0width$}", nanos / divisor, width = precision as usize)
    };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}{fraction}",
        local.year(),
        local.month(),
        local.day(),
        local.hour(),
        local.minute(),
        local.second()
    )
}

fn parse_fixed_offset(value: &str) -> Option<FixedOffset> {
    let value = value.strip_prefix("UTC").unwrap_or(value);
    let sign = match value.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let (hours, minutes) = value[1..].split_once(':')?;
    let seconds = sign * (hours.parse::<i32>().ok()? * 3_600 + minutes.parse::<i32>().ok()? * 60);
    FixedOffset::east_opt(seconds)
}

fn list_display(values: &dyn Array) -> Result<String, DataError> {
    list_display_at(values, 0)
}

fn list_display_at(values: &dyn Array, depth: usize) -> Result<String, DataError> {
    let items = (0..values.len().min(MAX_NESTED_COLLECTION_ITEMS))
        .map(|index| canonical_value_at(values, index, depth + 1))
        .collect::<Result<Vec<_>, _>>()?;
    let mut items = items;
    if values.len() > MAX_NESTED_COLLECTION_ITEMS {
        items.push(format!(
            "\"… {} more items\"",
            values.len() - MAX_NESTED_COLLECTION_ITEMS
        ));
    }
    Ok(truncate_nested(format!("[{}]", items.join(","))))
}

fn struct_display(values: &StructArray, index: usize) -> Result<String, DataError> {
    struct_display_at(values, index, 0)
}

fn struct_display_at(
    values: &StructArray,
    index: usize,
    depth: usize,
) -> Result<String, DataError> {
    let fields = values.fields();
    let items = fields
        .iter()
        .take(MAX_NESTED_COLLECTION_ITEMS)
        .enumerate()
        .map(|(column_index, field)| {
            let name = serde_json::to_string(field.name()).expect("field names serialize");
            let value = canonical_value_at(values.column(column_index).as_ref(), index, depth + 1)?;
            Ok(format!("{name}:{value}"))
        })
        .collect::<Result<Vec<_>, DataError>>()?;
    Ok(truncate_nested(format!("{{{}}}", items.join(","))))
}

fn map_display(values: &MapArray, index: usize) -> Result<String, DataError> {
    map_display_at(values, index, 0)
}

fn map_display_at(values: &MapArray, index: usize, depth: usize) -> Result<String, DataError> {
    let entries = values.value(index);
    let items = (0..entries.len().min(MAX_NESTED_COLLECTION_ITEMS))
        .map(|entry_index| {
            let key = canonical_value_at(entries.column(0).as_ref(), entry_index, depth + 1)?;
            let value = canonical_value_at(entries.column(1).as_ref(), entry_index, depth + 1)?;
            Ok(format!("{{\"key\":{key},\"value\":{value}}}"))
        })
        .collect::<Result<Vec<_>, DataError>>()?;
    Ok(truncate_nested(format!("[{}]", items.join(","))))
}

fn canonical_value_at(array: &dyn Array, index: usize, depth: usize) -> Result<String, DataError> {
    if array.is_null(index) {
        return Ok(String::from("null"));
    }
    if depth >= MAX_NESTED_DEPTH {
        return Ok(String::from("\"… nested value truncated\""));
    }
    match array.data_type() {
        DataType::Boolean => Ok(downcast::<BooleanArray>(array)?.value(index).to_string()),
        DataType::Int8 => Ok(downcast::<Int8Array>(array)?.value(index).to_string()),
        DataType::Int16 => Ok(downcast::<Int16Array>(array)?.value(index).to_string()),
        DataType::Int32 => Ok(downcast::<Int32Array>(array)?.value(index).to_string()),
        DataType::UInt8 => Ok(downcast::<UInt8Array>(array)?.value(index).to_string()),
        DataType::UInt16 => Ok(downcast::<UInt16Array>(array)?.value(index).to_string()),
        DataType::UInt32 => Ok(downcast::<UInt32Array>(array)?.value(index).to_string()),
        DataType::Float32 => Ok(downcast::<Float32Array>(array)?.value(index).to_string()),
        DataType::Float64 => Ok(downcast::<Float64Array>(array)?.value(index).to_string()),
        DataType::Utf8 => Ok(serde_json::to_string(truncate_scalar(
            downcast::<StringArray>(array)?.value(index),
        ))
        .expect("strings serialize")),
        DataType::LargeUtf8 => Ok(serde_json::to_string(truncate_scalar(
            downcast::<LargeStringArray>(array)?.value(index),
        ))
        .expect("strings serialize")),
        DataType::List(_) => {
            list_display_at(downcast::<ListArray>(array)?.value(index).as_ref(), depth)
        }
        DataType::LargeList(_) => list_display_at(
            downcast::<LargeListArray>(array)?.value(index).as_ref(),
            depth,
        ),
        DataType::FixedSizeList(_, _) => list_display_at(
            downcast::<FixedSizeListArray>(array)?.value(index).as_ref(),
            depth,
        ),
        DataType::Struct(_) => struct_display_at(downcast::<StructArray>(array)?, index, depth),
        DataType::Map(_, _) => map_display_at(downcast::<MapArray>(array)?, index, depth),
        _ => {
            let value = value_at(array, index)?;
            Ok(
                serde_json::to_string(value.display.as_deref().unwrap_or(""))
                    .expect("display strings serialize"),
            )
        }
    }
}

fn canonical_full(array: &dyn Array, index: usize, depth: usize) -> Result<String, DataError> {
    if depth >= 64 {
        return Err(DataError::invalid_request(
            "The nested value exceeds the depth limit.",
        ));
    }
    if array.is_null(index) {
        return Ok(String::from("null"));
    }
    match array.data_type() {
        DataType::List(_) => {
            canonical_full_list(downcast::<ListArray>(array)?.value(index).as_ref(), depth)
        }
        DataType::LargeList(_) => canonical_full_list(
            downcast::<LargeListArray>(array)?.value(index).as_ref(),
            depth,
        ),
        DataType::FixedSizeList(_, _) => canonical_full_list(
            downcast::<FixedSizeListArray>(array)?.value(index).as_ref(),
            depth,
        ),
        DataType::Struct(_) => {
            let values = downcast::<StructArray>(array)?;
            let mut items = Vec::with_capacity(values.num_columns());
            for (column_index, field) in values.fields().iter().enumerate() {
                items.push(format!(
                    "{}:{}",
                    serde_json::to_string(field.name()).expect("field names serialize"),
                    canonical_full(values.column(column_index).as_ref(), index, depth + 1)?
                ));
            }
            Ok(format!("{{{}}}", items.join(",")))
        }
        DataType::Map(_, _) => {
            let entries = downcast::<MapArray>(array)?.value(index);
            let mut items = Vec::with_capacity(entries.len());
            for entry_index in 0..entries.len() {
                items.push(format!(
                    "{{\"key\":{},\"value\":{}}}",
                    canonical_full(entries.column(0).as_ref(), entry_index, depth + 1)?,
                    canonical_full(entries.column(1).as_ref(), entry_index, depth + 1)?
                ));
            }
            Ok(format!("[{}]", items.join(",")))
        }
        DataType::Utf8 => Ok(
            serde_json::to_string(downcast::<StringArray>(array)?.value(index))
                .expect("strings serialize"),
        ),
        DataType::LargeUtf8 => Ok(serde_json::to_string(
            downcast::<LargeStringArray>(array)?.value(index),
        )
        .expect("strings serialize")),
        _ => canonical_value_at(array, index, depth),
    }
}

fn canonical_full_list(values: &dyn Array, depth: usize) -> Result<String, DataError> {
    let items = (0..values.len())
        .map(|index| canonical_full(values, index, depth + 1))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(format!("[{}]", items.join(",")))
}

fn truncate_scalar(value: &str) -> &str {
    if value.len() <= MAX_NESTED_SCALAR_BYTES {
        return value;
    }
    let mut end = MAX_NESTED_SCALAR_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn truncate_nested(mut value: String) -> String {
    if value.len() <= MAX_NESTED_DISPLAY_BYTES {
        return value;
    }
    let mut end = MAX_NESTED_DISPLAY_BYTES - '…'.len_utf8();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push('…');
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_format_preserves_scale_and_sign() {
        assert_eq!(format_decimal(String::from("1230000000"), 9), "1.230000000");
        assert_eq!(format_decimal(String::from("-1"), 9), "-0.000000001");
        assert_eq!(format_decimal(String::from("42"), -2), "4200");
    }

    #[test]
    fn date_format_handles_epoch_negative_days_and_leap_day() {
        assert_eq!(format_date(0), "1970-01-01");
        assert_eq!(format_date(-1), "1969-12-31");
        assert_eq!(format_date(11_016), "2000-02-29");
    }

    #[test]
    fn timestamp_display_preserves_source_timezone_wall_clock_without_suffix() {
        assert_eq!(
            format_timestamp(0, &TimeUnit::Nanosecond, Some("Asia/Seoul")),
            "1970-01-01 09:00:00.000000000"
        );
        assert_eq!(
            format_timestamp(0, &TimeUnit::Second, Some("+09:00")),
            "1970-01-01 09:00:00"
        );
    }

    #[test]
    fn dur_arrow_value_preserves_signed_count_unit_display_and_raw_copy() {
        let values =
            DurationNanosecondArray::from(vec![Some(-86_400_000_000_001_i64), Some(0_i64), None]);
        let negative = value_at(&values, 0).unwrap();
        assert_eq!(negative.kind, ValueKind::Duration);
        assert_eq!(negative.display.as_deref(), Some("-1d 00:00:00.000000001"));
        assert_eq!(negative.source_display.as_deref(), Some("-86400000000001"));
        assert_eq!(
            negative.raw_display.as_deref(),
            Some("-86400000000001 [unit=ns]")
        );
        assert_eq!(negative.unit.as_deref(), Some("ns"));
        assert_eq!(
            value_at(&values, 1).unwrap().state,
            crate::domain::DataValueState::Valid
        );
        assert_eq!(
            value_at(&values, 2).unwrap().state,
            crate::domain::DataValueState::Null
        );
    }

    #[test]
    fn binary_page_value_is_bounded_but_keeps_total_length() {
        let value = binary_value(&vec![7; 4_096]);
        let display = value.display.expect("binary display");
        assert!(display.len() < 512);
        assert!(display.ends_with("(4096 bytes)"));
    }

    #[test]
    fn explicit_full_binary_value_is_not_limited_to_the_page_preview() {
        let bytes = vec![7_u8; 4_096];
        let array = BinaryArray::from(vec![Some(bytes.as_slice())]);
        let preview = value_at(&array, 0).expect("preview");
        let full = full_value_at(&array, 0).expect("full value");
        assert!(preview.display.unwrap().len() < full.display.unwrap().len());
    }
}
