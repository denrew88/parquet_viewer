use std::cmp::Ordering;

use chrono::{DateTime, NaiveDateTime};

use crate::domain::{DataError, DataValue, DataValueState, ValueKind};

use super::{invalid, ChartScale};

const MAX_DECIMAL_DIGITS: usize = 256;
const EXACT_INTEGER_MAGNITUDE: i128 = 1 << 52;
const MAX_TEMPORAL_LABEL_BYTES: usize = 128;
const NANOS_PER_DAY: i128 = 86_400_000_000_000;

#[derive(Default)]
pub(super) struct Axis {
    origin: Option<Origin>,
}

pub(super) enum AxisExclusion {
    Invalid,
    OutsideScale,
}

enum Origin {
    Absolute,
    Integer {
        value: i128,
        label: String,
    },
    Decimal(String),
    Temporal {
        value: i128,
        kind: ValueKind,
        zoned: bool,
        label: String,
        unit: &'static str,
    },
}

enum Scalar<'a> {
    Float(f64),
    Integer(i128),
    Decimal { raw: &'a str, parts: Decimal<'a> },
    Temporal { value: i128, zoned: bool },
}

#[derive(PartialEq, Eq, Hash)]
pub(super) enum LineKey {
    Float(u64),
    Integer(i128),
    Decimal(String),
    Temporal(i128),
}

impl Axis {
    pub(super) fn coordinate(
        &mut self,
        cell: &DataValue,
        scale: ChartScale,
    ) -> Result<f64, AxisExclusion> {
        let raw = canonical(cell).ok_or(AxisExclusion::Invalid)?;
        let scalar = parse_scalar(cell, raw).ok_or(AxisExclusion::Invalid)?;
        if scale == ChartScale::Linear {
            self.linear_coordinate(cell, raw, scalar)
                .ok_or(AxisExclusion::Invalid)
        } else {
            scalar.scaled(scale)
        }
    }

    fn linear_coordinate(
        &mut self,
        cell: &DataValue,
        raw: &str,
        scalar: Scalar<'_>,
    ) -> Option<f64> {
        let origin = self.origin.get_or_insert_with(|| match &scalar {
            Scalar::Integer(value) if value.abs() >= EXACT_INTEGER_MAGNITUDE => Origin::Integer {
                value: *value,
                label: raw.to_owned(),
            },
            Scalar::Decimal { raw, parts } if parts.significant_digits() > 15 => {
                Origin::Decimal((*raw).to_owned())
            }
            Scalar::Temporal { value, zoned } => {
                let unit = if cell.kind == ValueKind::Date {
                    "days"
                } else {
                    "ns"
                };
                let label = match cell.kind {
                    ValueKind::Duration => value.to_string(),
                    ValueKind::Timestamp if cell.unit.is_some() => {
                        let label = bounded_label(cell.display.as_deref().unwrap_or(raw));
                        cell.timezone.as_ref().map_or_else(
                            || label.to_owned(),
                            |timezone| format!("{label} [{}]", bounded_label(timezone)),
                        )
                    }
                    _ => raw.to_owned(),
                };
                Origin::Temporal {
                    value: *value,
                    kind: cell.kind,
                    zoned: *zoned,
                    label,
                    unit,
                }
            }
            _ => Origin::Absolute,
        });
        let coordinate = match (origin, scalar) {
            (Origin::Absolute, scalar) => scalar.absolute()?,
            (Origin::Integer { value, .. }, Scalar::Integer(integer)) => {
                integer.checked_sub(*value)? as f64
            }
            (Origin::Decimal(origin), Scalar::Decimal { parts, .. }) => {
                parts.relative_to(Decimal::parse(origin)?)?
            }
            (
                Origin::Temporal {
                    value, kind, zoned, ..
                },
                Scalar::Temporal {
                    value: temporal,
                    zoned: temporal_zoned,
                },
            ) if *kind == cell.kind && *zoned == temporal_zoned => {
                temporal.checked_sub(*value)? as f64
            }
            _ => return None,
        };
        coordinate.is_finite().then_some(coordinate)
    }

    pub(super) fn metadata(self) -> (Option<String>, Option<&'static str>) {
        match self.origin {
            Some(Origin::Temporal { label, unit, .. }) => (Some(label), Some(unit)),
            Some(Origin::Integer { label, .. } | Origin::Decimal(label)) => (Some(label), None),
            _ => (None, None),
        }
    }

    pub(super) fn has_offset(&self) -> bool {
        self.origin
            .as_ref()
            .is_some_and(|origin| !matches!(origin, Origin::Absolute))
    }

    pub(super) fn line_key(
        &self,
        cell: &DataValue,
        coordinate: f64,
        bucket: Option<i128>,
    ) -> Result<(LineKey, f64), DataError> {
        let scalar = canonical(cell)
            .and_then(|raw| parse_scalar(cell, raw))
            .ok_or_else(|| invalid("The line X value cannot be grouped."))?;
        if let Some(bucket) = bucket {
            let (Scalar::Temporal { value, .. }, Some(Origin::Temporal { value: origin, .. })) =
                (scalar, &self.origin)
            else {
                return Err(invalid("Time buckets require a temporal X column."));
            };
            let units = if cell.kind == ValueKind::Date {
                NANOS_PER_DAY
            } else {
                1
            };
            let value = value * units;
            let bucket = value
                .div_euclid(bucket)
                .checked_mul(bucket)
                .ok_or_else(|| invalid("The time bucket is outside the supported range."))?;
            let relative = bucket
                .checked_sub(origin * units)
                .ok_or_else(|| invalid("The time bucket is outside the supported range."))?;
            return Ok((LineKey::Temporal(bucket), relative as f64 / units as f64));
        }
        let key = match scalar {
            Scalar::Float(value) => LineKey::Float(if value == 0.0 { 0 } else { value.to_bits() }),
            Scalar::Integer(value) => LineKey::Integer(value),
            Scalar::Decimal { parts, .. } => LineKey::Decimal(parts.key()),
            Scalar::Temporal { value, .. } => LineKey::Temporal(value),
        };
        Ok((key, coordinate))
    }
}

pub(super) fn bucket_nanoseconds(seconds: f64) -> Result<i128, DataError> {
    let nanos = seconds * 1_000_000_000.0;
    let rounded = nanos.round();
    if !nanos.is_finite()
        || rounded < 1.0
        || rounded >= i128::MAX as f64
        || (nanos - rounded).abs() > nanos * f64::EPSILON * 2.0
    {
        return Err(invalid(
            "The time bucket must be a positive whole number of nanoseconds.",
        ));
    }
    Ok(rounded as i128)
}

pub(super) fn is_temporal(kind: ValueKind) -> bool {
    matches!(
        kind,
        ValueKind::Date | ValueKind::Timestamp | ValueKind::Duration
    )
}

pub(super) fn scaled_number(absolute: f64, scale: ChartScale) -> Result<f64, AxisExclusion> {
    if !absolute.is_finite() {
        return Err(AxisExclusion::Invalid);
    }
    match scale {
        ChartScale::Linear => Ok(absolute),
        ChartScale::Log if absolute > 0.0 => Ok(absolute.ln()),
        ChartScale::Log10 if absolute > 0.0 => Ok(absolute.log10()),
        ChartScale::Log1p if absolute > -1.0 => Ok(absolute.ln_1p()),
        _ => Err(AxisExclusion::OutsideScale),
    }
}

impl Scalar<'_> {
    fn absolute(self) -> Option<f64> {
        match self {
            Self::Float(value) => Some(value),
            Self::Integer(value) => Some(value as f64),
            Self::Decimal { raw, .. } => raw.parse::<f64>().ok().filter(|value| value.is_finite()),
            Self::Temporal { .. } => None,
        }
    }

    fn scaled(self, scale: ChartScale) -> Result<f64, AxisExclusion> {
        // A precise decimal just above -1 can round to -1 as f64. Compute the
        // distance from the log1p boundary exactly in that neighborhood.
        if let (ChartScale::Log1p, Self::Decimal { raw, parts }) = (scale, &self) {
            if raw.parse::<f64>().is_ok_and(|value| value <= -0.5) {
                let delta = Decimal::parse("-1")
                    .and_then(|boundary| parts.relative_to(boundary))
                    .ok_or(AxisExclusion::Invalid)?;
                return if delta > 0.0 {
                    Ok(delta.ln())
                } else {
                    Err(AxisExclusion::OutsideScale)
                };
            }
        }
        let absolute = self.absolute().ok_or(AxisExclusion::Invalid)?;
        scaled_number(absolute, scale)
    }
}

pub(super) fn absolute_number(cell: &DataValue) -> Option<f64> {
    parse_scalar(cell, canonical(cell)?)?.absolute()
}

pub(super) fn canonical(cell: &DataValue) -> Option<&str> {
    match cell.state {
        DataValueState::Valid => cell.source_display.as_deref().or(cell.display.as_deref()),
        DataValueState::Empty if cell.kind == ValueKind::String => Some(""),
        _ => None,
    }
}

pub(super) fn group_label(cell: &DataValue) -> Option<&str> {
    let value = canonical(cell)?;
    match cell.kind {
        ValueKind::String
        | ValueKind::Boolean
        | ValueKind::Int
        | ValueKind::Decimal
        | ValueKind::Date => Some(value),
        ValueKind::Float => absolute_number(cell).map(|_| value),
        ValueKind::Timestamp | ValueKind::Duration => cell.display.as_deref(),
        _ => None,
    }
}

fn parse_scalar<'a>(cell: &DataValue, raw: &'a str) -> Option<Scalar<'a>> {
    match cell.kind {
        ValueKind::Float => raw
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(Scalar::Float),
        // Source integers are limited to 64 bits. The wider subtraction preserves unsigned
        // values and differences crossing zero before conversion to the display coordinate.
        ValueKind::Int => Some(Scalar::Integer(
            raw.parse::<i64>()
                .map(i128::from)
                .or_else(|_| raw.parse::<u64>().map(i128::from))
                .ok()?,
        )),
        ValueKind::Decimal => Some(Scalar::Decimal {
            raw,
            parts: Decimal::parse(raw)?,
        }),
        ValueKind::Date => Some(Scalar::Temporal {
            value: days_since_epoch(raw)?,
            zoned: false,
        }),
        ValueKind::Timestamp => {
            let (value, zoned) = match cell.unit.as_deref() {
                Some(unit) => (temporal_count(raw, unit)?, cell.timezone.is_some()),
                None => timestamp_nanos(raw)?,
            };
            Some(Scalar::Temporal { value, zoned })
        }
        ValueKind::Duration => Some(Scalar::Temporal {
            value: temporal_count(raw, cell.unit.as_deref()?)?,
            zoned: false,
        }),
        _ => None,
    }
}

fn bounded_label(label: &str) -> &str {
    &label[..label.floor_char_boundary(MAX_TEMPORAL_LABEL_BYTES)]
}

fn temporal_count(raw: &str, unit: &str) -> Option<i128> {
    let count = i128::from(raw.parse::<i64>().ok()?);
    let multiplier = match unit {
        "s" => 1_000_000_000,
        "ms" => 1_000_000,
        "us" => 1_000,
        "ns" => 1,
        _ => return None,
    };
    Some(count * multiplier)
}

fn timestamp_nanos(raw: &str) -> Option<(i128, bool)> {
    let (timestamp, zoned) = if let Ok(timestamp) = DateTime::parse_from_rfc3339(raw) {
        (timestamp.to_utc(), true)
    } else {
        let timestamp = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
            .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f"))
            .ok()?;
        // This is arithmetic on a wall clock, independent of the system time zone.
        // Axis only compares it to other naive values.
        (timestamp.and_utc(), false)
    };
    let nanos = i128::from(timestamp.timestamp()) * 1_000_000_000
        + i128::from(timestamp.timestamp_subsec_nanos());
    Some((nanos, zoned))
}

fn days_since_epoch(raw: &str) -> Option<i128> {
    // Arrow Date32 can represent years outside chrono's range. Invert the Gregorian
    // calendar conversion used for the canonical Arrow date representation.
    let mut parts = raw.rsplitn(3, '-');
    let day = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let year = i64::from(parts.next()?.parse::<i32>().ok()?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let last_day = match month {
        2 => 28 + i64::from(leap),
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return None,
    };
    if !(1..=last_day).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_in_era = year.rem_euclid(400);
    let march_month = if month > 2 { month - 3 } else { month + 9 };
    let day_in_year = (153 * march_month + 2) / 5 + day - 1;
    let day_in_era = 365 * year_in_era + year_in_era / 4 - year_in_era / 100 + day_in_year;
    Some(i128::from(era * 146_097 + day_in_era - 719_468))
}

#[derive(Clone, Copy)]
struct Decimal<'a> {
    negative: bool,
    integer: &'a [u8],
    fraction: &'a [u8],
}

impl<'a> Decimal<'a> {
    fn parse(raw: &'a str) -> Option<Self> {
        let (unsigned, negative) = raw
            .strip_prefix('-')
            .map_or((raw.strip_prefix('+').unwrap_or(raw), false), |v| (v, true));
        let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
        let length = integer.len().checked_add(fraction.len())?;
        if length == 0
            || length > MAX_DECIMAL_DIGITS
            || !integer
                .bytes()
                .chain(fraction.bytes())
                .all(|v| v.is_ascii_digit())
        {
            return None;
        }
        let integer = integer.trim_start_matches('0').as_bytes();
        let fraction = fraction.trim_end_matches('0').as_bytes();
        Some(Self {
            negative: negative && !(integer.is_empty() && fraction.is_empty()),
            integer,
            fraction,
        })
    }

    fn significant_digits(self) -> usize {
        if self.integer.is_empty() {
            self.fraction
                .iter()
                .skip_while(|digit| **digit == b'0')
                .count()
        } else {
            self.integer.len() + self.fraction.len()
        }
    }

    fn key(self) -> String {
        let mut output = String::with_capacity(self.integer.len() + self.fraction.len() + 2);
        if self.negative {
            output.push('-');
        }
        output.extend(self.integer.iter().copied().map(char::from));
        if !self.fraction.is_empty() {
            output.push('.');
            output.extend(self.fraction.iter().copied().map(char::from));
        }
        output
    }

    fn relative_to(self, origin: Self) -> Option<f64> {
        if self.negative != origin.negative {
            return Some(
                self.unsigned_float() * self.sign() - origin.unsigned_float() * origin.sign(),
            );
        }
        let order = self
            .integer
            .len()
            .cmp(&origin.integer.len())
            .then_with(|| self.integer.cmp(origin.integer))
            .then_with(|| self.fraction.cmp(origin.fraction));
        let (larger, smaller, sign) = match order {
            Ordering::Equal => return Some(0.0),
            Ordering::Greater => (self, origin, self.sign()),
            Ordering::Less => (origin, self, -self.sign()),
        };
        // Subtract base-ten digits before converting to f64. This preserves small
        // differences even across a borrow at the decimal or integer boundary.
        let fraction = larger.fraction.len().max(smaller.fraction.len());
        let mut borrow = 0;
        let mut result = 0.0;
        for position in (0..fraction).rev() {
            let digit = subtract_digit(
                larger.fraction.get(position),
                smaller.fraction.get(position),
                &mut borrow,
            );
            result += f64::from(digit) * 10_f64.powi(-((position + 1) as i32));
        }
        let mut right = smaller.integer.iter().rev();
        for (position, digit) in larger.integer.iter().rev().enumerate() {
            let digit = subtract_digit(Some(digit), right.next(), &mut borrow);
            result += f64::from(digit) * 10_f64.powi(position as i32);
        }
        Some(result * sign)
    }

    fn unsigned_float(self) -> f64 {
        let integer = self
            .integer
            .iter()
            .fold(0.0, |value, digit| value * 10.0 + f64::from(digit - b'0'));
        let fraction = self
            .fraction
            .iter()
            .rev()
            .fold(0.0, |value, digit| (value + f64::from(digit - b'0')) / 10.0);
        integer + fraction
    }

    fn sign(self) -> f64 {
        if self.negative {
            -1.0
        } else {
            1.0
        }
    }
}

fn subtract_digit(left: Option<&u8>, right: Option<&u8>, borrow: &mut i16) -> i16 {
    let left = i16::from(left.copied().unwrap_or(b'0') - b'0');
    let right = i16::from(right.copied().unwrap_or(b'0') - b'0');
    let difference = left - right - *borrow;
    *borrow = i16::from(difference < 0);
    if difference < 0 {
        difference + 10
    } else {
        difference
    }
}
