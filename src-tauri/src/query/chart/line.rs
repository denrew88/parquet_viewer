use std::{cmp::Ordering, collections::HashMap};

use crate::domain::DataError;

use super::{
    axis::{
        absolute_number, bucket_nanoseconds, canonical, is_temporal, scaled_number, Axis, LineKey,
    },
    invalid,
    statistics::{matches_filter, point, ratio, record_exclusion, CompensatedSum, MAX_POINTS},
    ChartData, ChartRequest, Input, Job, LineAggregate, LineOptions, Projection,
};

const MAX_AGGREGATE_KEYS: usize = 65_536;

#[derive(Clone, Copy)]
struct LinePoint {
    row: u64,
    xy: [f64; 2],
}

impl LinePoint {
    fn cmp_x(&self, other: &Self) -> Ordering {
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
}

impl Extrema {
    fn new(point: LinePoint) -> Self {
        Self {
            first: point,
            last: point,
            min: point,
            max: point,
        }
    }

    fn add(&mut self, point: LinePoint) {
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

struct Envelope {
    min_x: f64,
    max_x: f64,
    slots: Vec<Option<Extrema>>,
}

impl Envelope {
    fn new(min_x: f64, max_x: f64) -> Self {
        Self {
            min_x,
            max_x,
            slots: vec![None; MAX_POINTS / 4],
        }
    }

    fn add(&mut self, point: LinePoint) {
        let index = (ratio(point.xy[0], self.min_x, self.max_x) * self.slots.len() as f64) as usize;
        let index = index.min(self.slots.len() - 1);
        if let Some(extrema) = &mut self.slots[index] {
            extrema.add(point);
        } else {
            self.slots[index] = Some(Extrema::new(point));
        }
    }

    fn finish(self) -> Vec<LinePoint> {
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
    let options = request.line.unwrap_or_default();
    if options.aggregate == LineAggregate::Raw {
        raw_line(request, projection, input, job)
    } else {
        aggregated_line(request, projection, input, job, options)
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
        points = envelope.finish();
    } else {
        points.sort_unstable_by(LinePoint::cmp_x);
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
    input.visit(&projection.columns, job, |row, indices| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row, indices) {
            output.filtered_rows += 1;
            return Ok(());
        }
        match point(
            axes.x.coordinate(&row[indices[0]], request.x_scale),
            axes.y.coordinate(&row[indices[y]], request.y_scale),
        ) {
            Ok(xy) => {
                visit(LinePoint {
                    row: output.total_rows,
                    xy,
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
    options: LineOptions,
) -> Result<ChartData, DataError> {
    let mut axes = Axes::new();
    let mut output = ChartData::default();
    let mut groups = HashMap::<LineKey, Aggregate>::new();
    let bucket = options.bucket_seconds.map(bucket_nanoseconds).transpose()?;
    let y = projection
        .y
        .ok_or_else(|| invalid("A line requires a Y column."))?;
    input.visit(&projection.columns, job, |row, indices| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row, indices) {
            output.filtered_rows += 1;
            return Ok(());
        }
        let x_cell = &row[indices[0]];
        if bucket.is_some() && canonical(x_cell).is_some() && !is_temporal(x_cell.kind) {
            return Err(invalid("Time buckets require a temporal X column."));
        }
        let xy = point(
            axes.x.coordinate(x_cell, request.x_scale),
            absolute_number(&row[indices[y]])
                .ok_or(super::axis::AxisExclusion::Invalid),
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

    let mut points = Vec::with_capacity(groups.len());
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
                points.push(LinePoint {
                    row: group.first_row,
                    xy: [group.x, y],
                });
            }
            Err(excluded) => {
                output.excluded_rows += group.count;
                if matches!(excluded, super::axis::AxisExclusion::OutsideScale) {
                    output.scale_excluded_rows += group.count;
                }
            }
        }
    }
    points.sort_unstable_by(LinePoint::cmp_x);
    if points.len() > MAX_POINTS {
        let mut envelope = Envelope::new(points[0].xy[0], points[points.len() - 1].xy[0]);
        for point in points {
            envelope.add(point);
        }
        output.sampled = true;
        points = envelope.finish();
    }
    output.points = Some(points.into_iter().map(|point| point.xy).collect());
    axes.annotate(&mut output);
    Ok(output)
}
