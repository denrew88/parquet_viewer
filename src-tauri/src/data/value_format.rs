use crate::domain::{DataError, DataValue, ValueKind};
use arrow_array::{
    Array, BinaryArray, BooleanArray, Date32Array, Date64Array, Decimal128Array, Decimal256Array,
    FixedSizeBinaryArray, FixedSizeListArray, Float32Array, Float64Array, Int16Array, Int32Array,
    Int64Array, Int8Array, LargeBinaryArray, LargeListArray, LargeStringArray, ListArray, MapArray,
    StringArray, StructArray, TimestampMicrosecondArray, TimestampMillisecondArray,
    TimestampNanosecondArray, TimestampSecondArray, UInt16Array, UInt32Array, UInt64Array,
    UInt8Array,
};
use arrow_schema::{DataType, TimeUnit};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;

pub(super) fn value_at(array: &dyn Array, index: usize) -> Result<DataValue, DataError> {
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
            DataValue::displayed(
                ValueKind::Timestamp,
                format_timestamp(raw, unit, timezone.as_deref()),
            )
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

fn downcast<T: 'static>(array: &dyn Array) -> Result<&T, DataError> {
    array.as_any().downcast_ref::<T>().ok_or_else(|| {
        DataError::invalid_parquet(Path::new("<memory>"), "Arrow array type mismatch")
    })
}

fn binary_value(bytes: &[u8]) -> DataValue {
    DataValue::displayed(
        ValueKind::Binary,
        format!("base64:{} ({} bytes)", STANDARD.encode(bytes), bytes.len()),
    )
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

fn format_timestamp(raw: i64, unit: &TimeUnit, timezone: Option<&str>) -> String {
    let (seconds, nanos, precision, unit_name) = match unit {
        TimeUnit::Second => (raw, 0, 0, "s"),
        TimeUnit::Millisecond => (
            raw.div_euclid(1_000),
            raw.rem_euclid(1_000) * 1_000_000,
            3,
            "ms",
        ),
        TimeUnit::Microsecond => (
            raw.div_euclid(1_000_000),
            raw.rem_euclid(1_000_000) * 1_000,
            6,
            "us",
        ),
        TimeUnit::Nanosecond => (
            raw.div_euclid(1_000_000_000),
            raw.rem_euclid(1_000_000_000),
            9,
            "ns",
        ),
    };
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = seconds_of_day % 3_600 / 60;
    let second = seconds_of_day % 60;
    let fraction = if precision == 0 {
        String::new()
    } else {
        let divisor = 10_i64.pow(9 - precision);
        format!(".{:0width$}", nanos / divisor, width = precision as usize)
    };
    let timezone = timezone
        .map(|value| format!(", timezone={value}"))
        .unwrap_or_default();
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}{fraction}Z [unit={unit_name}{timezone}]"
    )
}

fn list_display(values: &dyn Array) -> Result<String, DataError> {
    let items = (0..values.len())
        .map(|index| canonical_value(values, index))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(format!("[{}]", items.join(",")))
}

fn struct_display(values: &StructArray, index: usize) -> Result<String, DataError> {
    let fields = values.fields();
    let items = fields
        .iter()
        .enumerate()
        .map(|(column_index, field)| {
            let name = serde_json::to_string(field.name()).expect("field names serialize");
            let value = canonical_value(values.column(column_index).as_ref(), index)?;
            Ok(format!("{name}:{value}"))
        })
        .collect::<Result<Vec<_>, DataError>>()?;
    Ok(format!("{{{}}}", items.join(",")))
}

fn map_display(values: &MapArray, index: usize) -> Result<String, DataError> {
    let entries = values.value(index);
    let items = (0..entries.len())
        .map(|entry_index| {
            let key = canonical_value(entries.column(0).as_ref(), entry_index)?;
            let value = canonical_value(entries.column(1).as_ref(), entry_index)?;
            Ok(format!("{{\"key\":{key},\"value\":{value}}}"))
        })
        .collect::<Result<Vec<_>, DataError>>()?;
    Ok(format!("[{}]", items.join(",")))
}

fn canonical_value(array: &dyn Array, index: usize) -> Result<String, DataError> {
    if array.is_null(index) {
        return Ok(String::from("null"));
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
        DataType::Utf8 => Ok(
            serde_json::to_string(downcast::<StringArray>(array)?.value(index))
                .expect("strings serialize"),
        ),
        DataType::LargeUtf8 => Ok(serde_json::to_string(
            downcast::<LargeStringArray>(array)?.value(index),
        )
        .expect("strings serialize")),
        DataType::List(_) => list_display(downcast::<ListArray>(array)?.value(index).as_ref()),
        DataType::LargeList(_) => {
            list_display(downcast::<LargeListArray>(array)?.value(index).as_ref())
        }
        DataType::FixedSizeList(_, _) => {
            list_display(downcast::<FixedSizeListArray>(array)?.value(index).as_ref())
        }
        DataType::Struct(_) => struct_display(downcast::<StructArray>(array)?, index),
        DataType::Map(_, _) => map_display(downcast::<MapArray>(array)?, index),
        _ => {
            let value = value_at(array, index)?;
            Ok(
                serde_json::to_string(value.display.as_deref().unwrap_or(""))
                    .expect("display strings serialize"),
            )
        }
    }
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
}
