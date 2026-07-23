use crate::domain::{CsvDurationInputFormat, DurationUnit};

pub(crate) fn parse_csv_duration(
    value: &str,
    unit: DurationUnit,
    input_format: CsvDurationInputFormat,
) -> Option<i64> {
    match input_format {
        CsvDurationInputFormat::RawInteger => value.parse::<i64>().ok(),
        CsvDurationInputFormat::DaysClock => parse_days_clock(value, unit),
    }
}

pub(crate) fn parse_query_duration(value: &str, target_unit: DurationUnit) -> Option<i64> {
    for (suffix, source_unit) in [
        ("ms", DurationUnit::Ms),
        ("us", DurationUnit::Us),
        ("ns", DurationUnit::Ns),
        ("s", DurationUnit::S),
    ] {
        if let Some(count) = value.strip_suffix(suffix) {
            return convert_exact(count.parse::<i64>().ok()?, source_unit, target_unit);
        }
    }
    parse_days_clock(value, target_unit)
}

pub(crate) fn duration_unit_from_logical_type(logical_type: &str) -> Option<DurationUnit> {
    let normalized = logical_type.to_ascii_lowercase();
    if !normalized.contains("duration") {
        return None;
    }
    if normalized.contains("nanosecond") || normalized.contains("duration(ns") {
        Some(DurationUnit::Ns)
    } else if normalized.contains("microsecond") || normalized.contains("duration(us") {
        Some(DurationUnit::Us)
    } else if normalized.contains("millisecond") || normalized.contains("duration(ms") {
        Some(DurationUnit::Ms)
    } else {
        Some(DurationUnit::S)
    }
}

pub(crate) fn duration_unit_name(unit: DurationUnit) -> &'static str {
    match unit {
        DurationUnit::S => "s",
        DurationUnit::Ms => "ms",
        DurationUnit::Us => "us",
        DurationUnit::Ns => "ns",
    }
}

fn convert_exact(value: i64, source: DurationUnit, target: DurationUnit) -> Option<i64> {
    let nanoseconds = i128::from(value).checked_mul(unit_nanoseconds(source))?;
    let divisor = unit_nanoseconds(target);
    if nanoseconds % divisor != 0 {
        return None;
    }
    i64::try_from(nanoseconds / divisor).ok()
}

fn parse_days_clock(value: &str, unit: DurationUnit) -> Option<i64> {
    let (negative, unsigned) = value.strip_prefix('-').map_or_else(
        || (false, value.strip_prefix('+').unwrap_or(value)),
        |rest| (true, rest),
    );
    let (days, clock) =
        unsigned
            .split_once("d ")
            .map_or(Some((0_i128, unsigned)), |(days, clock)| {
                if days.is_empty() || !days.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                Some((days.parse::<i128>().ok()?, clock))
            })?;
    let parts = clock.split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 {
        return None;
    }
    let hours = parts[0].parse::<i128>().ok()?;
    let minutes = parts[1].parse::<i128>().ok()?;
    let (seconds_text, fraction) = parts[2]
        .split_once('.')
        .map_or((parts[2], None), |(seconds, fraction)| {
            (seconds, Some(fraction))
        });
    if seconds_text.len() != 2 || hours > 23 || minutes > 59 {
        return None;
    }
    let seconds = seconds_text.parse::<i128>().ok()?;
    if seconds > 59
        || fraction.is_some_and(|fraction| {
            fraction.is_empty()
                || fraction.len() > 9
                || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return None;
    }
    let fraction_ns = fraction.map_or(Some(0_i128), |fraction| {
        Some(fraction.parse::<i128>().ok()? * 10_i128.pow((9 - fraction.len()) as u32))
    })?;
    let total_ns = days
        .checked_mul(86_400)?
        .checked_add(hours.checked_mul(3_600)?)?
        .checked_add(minutes.checked_mul(60)?)?
        .checked_add(seconds)?
        .checked_mul(1_000_000_000)?
        .checked_add(fraction_ns)?;
    let signed_ns = if negative {
        total_ns.checked_neg()?
    } else {
        total_ns
    };
    let divisor = unit_nanoseconds(unit);
    if signed_ns % divisor != 0 {
        return None;
    }
    i64::try_from(signed_ns / divisor).ok()
}

fn unit_nanoseconds(unit: DurationUnit) -> i128 {
    match unit {
        DurationUnit::S => 1_000_000_000,
        DurationUnit::Ms => 1_000_000,
        DurationUnit::Us => 1_000,
        DurationUnit::Ns => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dur_csv_days_clock_requires_exact_target_unit() {
        assert_eq!(
            parse_days_clock("1d 02:03:04.005", DurationUnit::Ms),
            Some(93_784_005)
        );
        assert_eq!(
            parse_days_clock("-00:00:00.001", DurationUnit::Ms),
            Some(-1)
        );
        assert_eq!(parse_days_clock("00:00:00.000001", DurationUnit::Ms), None);
        assert_eq!(parse_days_clock("2:03:04", DurationUnit::S), None);
    }

    #[test]
    fn dur_query_suffix_conversion_is_exact_and_overflow_checked() {
        assert_eq!(parse_query_duration("2s", DurationUnit::Ms), Some(2_000));
        assert_eq!(parse_query_duration("1ms", DurationUnit::S), None);
        assert_eq!(
            parse_query_duration("9223372036854775807s", DurationUnit::Ns),
            None
        );
        assert_eq!(
            parse_query_duration("+00:00:01.5", DurationUnit::Ms),
            Some(1_500)
        );
    }

    #[test]
    fn dur_arrow_logical_type_recognizes_all_units() {
        assert_eq!(
            duration_unit_from_logical_type("Duration(Second)"),
            Some(DurationUnit::S)
        );
        assert_eq!(
            duration_unit_from_logical_type("Duration(Millisecond)"),
            Some(DurationUnit::Ms)
        );
        assert_eq!(
            duration_unit_from_logical_type("Duration(Microsecond)"),
            Some(DurationUnit::Us)
        );
        assert_eq!(
            duration_unit_from_logical_type("Duration(Nanosecond)"),
            Some(DurationUnit::Ns)
        );
        assert_eq!(duration_unit_from_logical_type("Int64"), None);
    }
}
