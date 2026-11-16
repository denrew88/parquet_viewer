use std::{cmp::Ordering, collections::HashMap};

use crate::domain::DataError;

use super::{
    axis::{
        absolute_number, bucket_nanoseconds, has_value, is_temporal, kind, scaled_number, Axis,
        LineKey,
    },
    invalid,
    statistics::{
        interpolate, matches_filter, point, ratio, record_exclusion, CompensatedSum, MAX_POINTS,
    },
    ChartData, ChartRequest, Input, Job, LineAggregate, Projection,
};

const MAX_AGGREGATE_KEYS: usize = 65_536;

#[derive(Clone, Copy)]
pub(super) struct LinePoint {
    pub(super) row: u64,
    pub(super) xy: [f64; 2],
    pub(super) count: u64,
}

impl LinePoint {
    pub(super) fn cmp_x(&self, other: &Self) -> Ordering {
        self.xy[0]
            .total_cmp(&other.xy[0])
            .then_with(|| self.row.cmp(&other.row))
    }
}

#[derive(Clone, Copy)]
struct Extrema {
    first: LinePoint,
    last: LinePoint,
    min: LinePoint,
    max: LinePoint,
    count: u64,
}

impl Extrema {
    fn new(point: LinePoint) -> Self {
        Self {
            first: point,
            last: point,
            min: point,
            max: point,
            count: point.count,
        }
    }

    fn add(&mut self, point: LinePoint) {
        self.count += point.count;
        if point.cmp_x(&self.first).is_lt() {
            self.first = point;
        }
        if point.cmp_x(&self.last).is_gt() {
            self.last = point;
        }
        if point.xy[1] < self.min.xy[1] {
            self.min = point;
        }
        if point.xy[1] > self.max.xy[1] {
            self.max = point;
        }
    }
}

pub(super) struct Envelope {
    min_x: f64,
    max_x: f64,
    slots: Vec<Option<Extrema>>,
}

impl Envelope {
    pub(super) fn new(min_x: f64, max_x: f64) -> Self {
        Self::with_slots(min_x, max_x, MAX_POINTS / 4)
    }

    fn with_slots(min_x: f64, max_x: f64, slots: usize) -> Self {
        Self {
            min_x,
            max_x,
            slots: vec![None; slots],
        }
    }

    pub(super) fn add(&mut self, point: LinePoint) {
        let index = (ratio(point.xy[0], self.min_x, self.max_x) * self.slots.len() as f64) as usize;
        let index = index.min(self.slots.len() - 1);
        if let Some(extrema) = &mut self.slots[index] {
            extrema.add(point);
        } else {
            self.slots[index] = Some(Extrema::new(point));
        }
    }

    pub(super) fn buckets(&self) -> Vec<[f64; 5]> {
        let width = self.slots.len() as f64;
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(index, extrema)| {
                extrema.map(|extrema| {
                    [
                        interpolate(self.min_x, self.max_x, index as f64 / width),
                        interpolate(self.min_x, self.max_x, (index + 1) as f64 / width),
                        extrema.min.xy[1],
                        extrema.max.xy[1],
                        extrema.count as f64,
                    ]
                })
            })
            .collect()
    }

    pub(super) fn finish(self) -> Vec<LinePoint> {
        let mut points = self
            .slots
            .into_iter()
            .flatten()
            .flat_map(|extrema| [extrema.first, extrema.last, extrema.min, extrema.max])
            .collect::<Vec<_>>();
        points.sort_unstable_by(LinePoint::cmp_x);
        points.dedup_by_key(|point| point.row);
        points
    }
}

struct Axes {
    x: Axis,
    y: Axis,
}

impl Axes {
    fn new() -> Self {
        Self {
            x: Axis::default(),
            y: Axis::default(),
        }
    }

    fn annotate(self, data: &mut ChartData) {
        (data.x_origin, data.x_unit) = self.x.metadata();
        (data.y_origin, data.y_unit) = self.y.metadata();
    }
}

pub(super) fn compute(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    if request.line.unwrap_or_default().aggregate == LineAggregate::Raw {
        raw_line(request, projection, input, job)
    } else {
        aggregated_line(request, projection, input, job)
    }
}

fn raw_line(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    let mut axes = Axes::new();
    let mut points = Vec::new();
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut output = scan_raw(request, projection, input, job, &mut axes, |point| {
        min_x = min_x.min(point.xy[0]);
        max_x = max_x.max(point.xy[0]);
        if points.len() < MAX_POINTS {
            points.push(point);
        }
        Ok(())
    })?;
    if output.valid_rows > MAX_POINTS as u64 {
        let mut envelope = Envelope::new(min_x, max_x);
        let second = scan_raw(request, projection, input, job, &mut axes, |point| {
            if !(min_x..=max_x).contains(&point.xy[0]) {
                return Err(invalid("The source changed while reducing the line."));
            }
            envelope.add(point);
            Ok(())
        })?;
        if second != output {
            return Err(invalid("The source changed while reducing the line."));
        }
        output.sampled = true;
        output.line_buckets = Some(envelope.buckets());
        points = envelope.finish();
    } else {
        points.sort_unstable_by(LinePoint::cmp_x);
        set_line_buckets(&mut output, &points);
    }
    output.points = Some(points.into_iter().map(|point| point.xy).collect());
    axes.annotate(&mut output);
    Ok(output)
}

fn scan_raw(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
    axes: &mut Axes,
    mut visit: impl FnMut(LinePoint) -> Result<(), DataError>,
) -> Result<ChartData, DataError> {
    let mut output = ChartData::default();
    let y = projection
        .y
        .ok_or_else(|| invalid("A line requires a Y column."))?;
    input.visit(&projection.columns, job, |row| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row) {
            output.filtered_rows += 1;
            return Ok(());
        }
        match point(
            axes.x.coordinate(row[0], request.x_scale),
            axes.y.coordinate(row[y], request.y_scale),
        ) {
            Ok(xy) => {
                visit(LinePoint {
                    row: output.total_rows,
                    xy,
                    count: 1,
                })?;
                output.valid_rows += 1;
            }
            Err(excluded) => record_exclusion(&mut output, excluded),
        }
        Ok(())
    })?;
    Ok(output)
}

struct Aggregate {
    x: f64,
    first_row: u64,
    count: u64,
    sum: CompensatedSum,
}

fn aggregated_line(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    let mut points = Vec::new();
    let mut output = visit_aggregated_points(request, projection, input, job, |xy, row, count| {
        points.push(LinePoint { row, xy, count });
        Ok(())
    })?;
    points.sort_unstable_by(LinePoint::cmp_x);
    if points.len() > MAX_POINTS {
        let mut envelope = Envelope::new(points[0].xy[0], points[points.len() - 1].xy[0]);
        for point in points {
            envelope.add(point);
        }
        output.sampled = true;
        output.line_buckets = Some(envelope.buckets());
        points = envelope.finish();
    } else {
        set_line_buckets(&mut output, &points);
    }
    output.points = Some(points.into_iter().map(|point| point.xy).collect());
    Ok(output)
}

fn set_line_buckets(output: &mut ChartData, points: &[LinePoint]) {
    if let (Some(first), Some(last)) = (points.first(), points.last()) {
        let mut envelope =
            Envelope::with_slots(first.xy[0], last.xy[0], points.len().min(MAX_POINTS / 4));
        for &point in points {
            envelope.add(point);
        }
        output.line_buckets = Some(envelope.buckets());
    }
}

pub(super) fn visit_aggregated_points(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
    mut visit: impl FnMut([f64; 2], u64, u64) -> Result<(), DataError>,
) -> Result<ChartData, DataError> {
    let options = request.line.unwrap_or_default();
    let mut axes = Axes::new();
    let mut output = ChartData::default();
    let mut groups = HashMap::<LineKey, Aggregate>::new();
    let bucket = options.bucket_seconds.map(bucket_nanoseconds).transpose()?;
    let y = projection
        .y
        .ok_or_else(|| invalid("A line requires a Y column."))?;
    input.visit(&projection.columns, job, |row| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row) {
            output.filtered_rows += 1;
            return Ok(());
        }
        let x_cell = row[0];
        if bucket.is_some() && has_value(x_cell) && !kind(x_cell).is_some_and(is_temporal) {
            return Err(invalid("Time buckets require a temporal X column."));
        }
        let xy = point(
            axes.x.coordinate(x_cell, request.x_scale),
            absolute_number(row[y]).ok_or(super::axis::AxisExclusion::Invalid),
        );
        match xy {
            Ok([x, y]) => {
                let (key, x) = axes.x.line_key(x_cell, x, bucket)?;
                if groups.len() >= MAX_AGGREGATE_KEYS && !groups.contains_key(&key) {
                    return Err(invalid(
                        "A line can aggregate at most 65,536 X values. Use time buckets or filter the data.",
                    ));
                }
                let group = groups.entry(key).or_insert(Aggregate {
                    x,
                    first_row: output.total_rows,
                    count: 0,
                    sum: CompensatedSum::default(),
                });
                group.count += 1;
                group.sum.add(y)?;
            }
            Err(excluded) => record_exclusion(&mut output, excluded),
        }
        Ok(())
    })?;

    for group in groups.into_values() {
        job.check()?;
        let y = if options.aggregate == LineAggregate::Mean {
            group.sum.mean(group.count)?
        } else {
            group.sum.total()?
        };
        match scaled_number(y, request.y_scale) {
            Ok(y) => {
                output.valid_rows += group.count;
                visit([group.x, y], group.first_row, group.count)?;
            }
            Err(excluded) => {
                output.excluded_rows += group.count;
                if matches!(excluded, super::axis::AxisExclusion::OutsideScale) {
                    output.scale_excluded_rows += group.count;
                }
            }
        }
    }
    axes.annotate(&mut output);
    Ok(output)
}
