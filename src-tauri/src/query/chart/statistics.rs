use std::collections::BTreeMap;

use crate::domain::{DataError, DataValue};

use super::{
    axis::{canonical, group_label, is_temporal, Axis, AxisExclusion},
    bar, invalid, line, ChartBin, ChartData, ChartGroup, ChartKind, ChartPointDetails,
    ChartRequest, HistogramOptions, HistogramOutside, HistogramRange, Input, Job, Projection,
    WhiskerMode, MAX_BINS, MAX_GROUPS,
};

pub(super) const MAX_POINTS: usize = 20_000;
pub(super) const MAX_GROUP_LABEL_BYTES: usize = 256;
const MAX_POINT_DETAIL_BYTES: usize = 128;
const MAX_GROUP_SAMPLES: usize = 2_048;
const MAX_GROUP_OUTLIERS: usize = 128;
const DENSITY_POINTS: usize = 41;

pub(super) fn compute_chart(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    match request.kind {
        ChartKind::Line => return line::compute(request, projection, input, job),
        ChartKind::Bar => return bar::compute(request, projection, input, job),
        _ => {}
    }
    let mut x_axis = Axis::default();
    let mut y_axis = Axis::default();
    let mut output = ChartData {
        histogram_outside: request.histogram_range.map(|_| HistogramOutside::default()),
        ..ChartData::default()
    };
    let mut points = Reservoir::<([f64; 2], ChartPointDetails)>::new(MAX_POINTS);
    let mut histogram = Distribution::new(MAX_POINTS);
    let mut groups = BTreeMap::<String, Distribution>::new();

    input.visit(&projection.columns, job, |row, indices| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row, indices) {
            output.filtered_rows += 1;
            return Ok(());
        }
        let x = &row[indices[0]];
        let y = projection.y.map(|slot| &row[indices[slot]]);
        let valid = match request.kind {
            ChartKind::Scatter => {
                scatter_point(request, &mut x_axis, &mut y_axis, x, y).map(|point| {
                    let [x_coordinate, y_coordinate] = point;
                    let extent = output.scatter_extent.get_or_insert([
                        x_coordinate,
                        x_coordinate,
                        y_coordinate,
                        y_coordinate,
                    ]);
                    extent[0] = extent[0].min(x_coordinate);
                    extent[1] = extent[1].max(x_coordinate);
                    extent[2] = extent[2].min(y_coordinate);
                    extent[3] = extent[3].max(y_coordinate);
                    points.add_with(|| {
                        let label = projection
                            .scatter_label
                            .and_then(|index| detail_text(&row[indices[index]]))
                            .map(bounded_detail);
                        (
                            point,
                            ChartPointDetails {
                                row: input.row_start() + output.total_rows,
                                x: bounded_detail(detail_text(x).unwrap_or_default()),
                                y: bounded_detail(y.and_then(detail_text).unwrap_or_default()),
                                label,
                            },
                        )
                    });
                })
            }
            ChartKind::Histogram => match x_axis.coordinate(x, request.x_scale) {
                Ok(value) => {
                    if let Some((range, outside)) = request
                        .histogram_range
                        .zip(output.histogram_outside.as_mut())
                    {
                        if x_axis.has_offset() {
                            return Err(invalid(
                                "A fixed histogram range requires an absolute X axis.",
                            ));
                        }
                        if value < range.min {
                            outside.below += 1;
                            output.excluded_rows += 1;
                            return Ok(());
                        }
                        if value > range.max {
                            outside.above += 1;
                            output.excluded_rows += 1;
                            return Ok(());
                        }
                    }
                    histogram.add(value);
                    Ok(())
                }
                Err(excluded) => Err(excluded),
            },
            ChartKind::Box | ChartKind::Violin => {
                let Some(label) =
                    group_label(x).filter(|label| label.len() <= MAX_GROUP_LABEL_BYTES)
                else {
                    output.excluded_rows += 1;
                    return Ok(());
                };
                let number = y
                    .ok_or(AxisExclusion::Invalid)
                    .and_then(|y| y_axis.coordinate(y, request.y_scale));
                match number {
                    Ok(value) => {
                        let group = if let Some(group) = groups.get_mut(label) {
                            group
                        } else if groups.len() < MAX_GROUPS {
                            groups
                                .entry(label.to_owned())
                                .or_insert_with(|| Distribution::new(MAX_GROUP_SAMPLES))
                        } else {
                            output.groups_truncated = true;
                            output.excluded_rows += 1;
                            return Ok(());
                        };
                        group.add(value);
                        Ok(())
                    }
                    Err(excluded) => Err(excluded),
                }
            }
            ChartKind::Line | ChartKind::Bar => unreachable!("handled by separate chart modules"),
        };
        match valid {
            Ok(()) => output.valid_rows += 1,
            Err(excluded) => record_exclusion(&mut output, excluded),
        }
        Ok(())
    })?;

    match request.kind {
        ChartKind::Scatter => {
            output.sampled = points.sampled();
            let (points, details) = points.values.into_iter().unzip();
            output.points = Some(points);
            output.point_details = Some(details);
        }
        ChartKind::Histogram => {
            let mut bins = Histogram::new(&histogram, request.histogram, request.histogram_range)?;
            if histogram.values.sampled() {
                // Re-read bounded projections once the exact range is known. This keeps
                // histogram counts exact without storing every source row.
                input.visit(&projection.columns, job, |row, indices| {
                    if matches_filter(request, projection, row, indices) {
                        if let Ok(value) = x_axis.coordinate(&row[indices[0]], request.x_scale) {
                            if request
                                .histogram_range
                                .is_some_and(|range| value < range.min || value > range.max)
                            {
                                return Ok(());
                            }
                            if !(histogram.min..=histogram.max).contains(&value) {
                                return Err(invalid(
                                    "The source changed while computing the histogram.",
                                ));
                            }
                            bins.add(value);
                        }
                    }
                    Ok(())
                })?;
                if bins.count() != output.valid_rows {
                    return Err(invalid("The source changed while computing the histogram."));
                }
            } else {
                for value in histogram.values.values {
                    bins.add(value);
                }
            }
            output.bins = Some(bins.finish());
        }
        ChartKind::Box | ChartKind::Violin => {
            finish_distributions(
                request,
                projection,
                input,
                job,
                &mut y_axis,
                groups,
                &mut output,
            )?;
        }
        ChartKind::Line | ChartKind::Bar => unreachable!("handled by separate chart modules"),
    }
    (output.x_origin, output.x_unit) = x_axis.metadata();
    (output.y_origin, output.y_unit) = y_axis.metadata();
    Ok(output)
}

fn detail_text(cell: &DataValue) -> Option<&str> {
    if is_temporal(cell.kind) {
        group_label(cell)
    } else {
        canonical(cell)
    }
}

fn bounded_detail(text: &str) -> String {
    if text.len() <= MAX_POINT_DETAIL_BYTES {
        return text.to_owned();
    }
    let end = text.floor_char_boundary(MAX_POINT_DETAIL_BYTES - '…'.len_utf8());
    format!("{}…", &text[..end])
}

pub(super) fn record_exclusion(output: &mut ChartData, excluded: AxisExclusion) {
    output.excluded_rows += 1;
    if matches!(excluded, AxisExclusion::OutsideScale) {
        output.scale_excluded_rows += 1;
    }
}

pub(super) fn point(
    x: Result<f64, AxisExclusion>,
    y: Result<f64, AxisExclusion>,
) -> Result<[f64; 2], AxisExclusion> {
    match (x, y) {
        (Ok(x), Ok(y)) => Ok([x, y]),
        (Err(AxisExclusion::Invalid), _) | (_, Err(AxisExclusion::Invalid)) => {
            Err(AxisExclusion::Invalid)
        }
        _ => Err(AxisExclusion::OutsideScale),
    }
}

pub(super) fn scatter_point(
    request: &ChartRequest,
    x_axis: &mut Axis,
    y_axis: &mut Axis,
    x: &DataValue,
    y: Option<&DataValue>,
) -> Result<[f64; 2], AxisExclusion> {
    // Evaluate both coordinates even if one is excluded. The first readable
    // value of each linear axis determines its offset for the entire scan.
    point(
        x_axis.coordinate(x, request.x_scale),
        y.ok_or(AxisExclusion::Invalid)
            .and_then(|y| y_axis.coordinate(y, request.y_scale)),
    )
}

pub(super) fn matches_filter(
    request: &ChartRequest,
    projection: &Projection,
    row: &[DataValue],
    indices: &[usize],
) -> bool {
    request
        .filter
        .as_ref()
        .zip(projection.filter)
        .is_none_or(|(filter, index)| {
            canonical(&row[indices[index]]) == Some(filter.equals.as_str())
        })
}

struct Reservoir<T> {
    cap: usize,
    seen: u64,
    values: Vec<T>,
}

impl<T> Reservoir<T> {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            seen: 0,
            values: Vec::new(),
        }
    }

    fn add(&mut self, value: T) {
        self.add_with(|| value);
    }

    fn add_with(&mut self, value: impl FnOnce() -> T) {
        self.seen += 1;
        if self.values.len() < self.cap {
            self.values.push(value());
        } else {
            let slot = sample_hash(self.seen) % self.seen;
            if slot < self.cap as u64 {
                self.values[slot as usize] = value();
            }
        }
    }

    fn sampled(&self) -> bool {
        self.seen > self.values.len() as u64
    }
}

fn sample_hash(mut value: u64) -> u64 {
    // SplitMix64 mixing. Sampling depends on logical row order, never on batch sizes.
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

struct Distribution {
    min: f64,
    max: f64,
    values: Reservoir<f64>,
}

impl Distribution {
    fn new(cap: usize) -> Self {
        Self {
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            values: Reservoir::new(cap),
        }
    }

    fn add(&mut self, value: f64) {
        self.min = self.min.min(value);
        self.max = self.max.max(value);
        self.values.add(value);
    }

    fn quartiles(&mut self) -> [f64; 5] {
        self.values.values.sort_unstable_by(f64::total_cmp);
        [
            self.min,
            percentile(&self.values.values, 0.25),
            percentile(&self.values.values, 0.5),
            percentile(&self.values.values, 0.75),
            self.max,
        ]
    }

    fn density(
        &self,
        bandwidth_multiplier: f64,
        job: &Job<'_>,
    ) -> Result<Option<Vec<[f64; 2]>>, DataError> {
        if self.values.values.len() < 2 || self.min == self.max {
            return Ok(None);
        }
        let sample = self
            .values
            .values
            .iter()
            .map(|value| ratio(*value, self.min, self.max))
            .collect::<Vec<_>>();
        let count = sample.len() as f64;
        let mean = sample.iter().sum::<f64>() / count;
        let sigma = (sample.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (count - 1.0)).sqrt();
        let bandwidth = (1.06 * sigma * count.powf(-0.2)).max(1.0 / 128.0) * bandwidth_multiplier;
        let mut density = Vec::with_capacity(DENSITY_POINTS);
        let mut peak = 0.0_f64;
        for i in 0..DENSITY_POINTS {
            job.check()?;
            let position = i as f64 / (DENSITY_POINTS - 1) as f64;
            let height: f64 = sample
                .iter()
                .map(|value| (-0.5 * ((position - value) / bandwidth).powi(2)).exp())
                .sum();
            density.push([interpolate(self.min, self.max, position), height]);
            peak = peak.max(height);
        }
        if peak > 0.0 {
            for item in &mut density {
                item[1] /= peak;
            }
        }
        Ok(Some(density))
    }
}

#[derive(Default)]
pub(super) struct CompensatedSum {
    sum: f64,
    correction: f64,
    scaled: bool,
}

impl CompensatedSum {
    pub(super) fn add(&mut self, mut value: f64) -> Result<(), DataError> {
        if self.scaled {
            value /= f64::MAX;
        } else if !(self.sum + value).is_finite() {
            // An overflowing intermediate need not imply that a final sum or
            // mean over these finite inputs is out of range.
            self.scaled = true;
            self.sum /= f64::MAX;
            self.correction /= f64::MAX;
            value /= f64::MAX;
        }
        let total = self.sum + value;
        // Neumaier summation also compensates when the next value is larger
        // in magnitude than the partial total.
        self.correction += if self.sum.abs() >= value.abs() {
            (self.sum - total) + value
        } else {
            (value - total) + self.sum
        };
        self.sum = total;
        if total.is_finite() && self.correction.is_finite() {
            Ok(())
        } else {
            Err(invalid(
                "A chart aggregate is outside the supported numeric range.",
            ))
        }
    }

    pub(super) fn total(&self) -> Result<f64, DataError> {
        self.finish(1.0)
    }

    pub(super) fn mean(&self, count: u64) -> Result<f64, DataError> {
        self.finish(count as f64)
    }

    fn finish(&self, divisor: f64) -> Result<f64, DataError> {
        let value = self.sum / divisor + self.correction / divisor;
        let value = if self.scaled { value * f64::MAX } else { value };
        if value.is_finite() {
            Ok(value)
        } else {
            Err(invalid(
                "A chart aggregate is outside the supported numeric range.",
            ))
        }
    }
}

struct Whiskers {
    fences: [f64; 2],
    endpoints: [f64; 2],
    outliers: Reservoir<f64>,
    observed: u64,
}

impl Whiskers {
    fn add(&mut self, value: f64) {
        self.observed += 1;
        if value < self.fences[0] || value > self.fences[1] {
            self.outliers.add(value);
        } else {
            self.endpoints[0] = self.endpoints[0].min(value);
            self.endpoints[1] = self.endpoints[1].max(value);
        }
    }
}

fn finish_distributions(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
    y_axis: &mut Axis,
    groups: BTreeMap<String, Distribution>,
    output: &mut ChartData,
) -> Result<(), DataError> {
    let use_iqr = request.whiskers != Some(WhiskerMode::Minmax);
    let mut calculated = BTreeMap::new();
    let mut requires_rescan = false;
    for (label, mut group) in groups {
        job.check()?;
        output.sampled |= group.values.sampled();
        let summary = group.quartiles();
        let density = if request.kind == ChartKind::Violin {
            group.density(request.violin_bandwidth.unwrap_or(1.0), job)?
        } else {
            None
        };
        let radius = 1.5 * (summary[3] - summary[1]);
        let fences = [summary[1] - radius, summary[3] + radius];
        // Global extrema are exact even when quartiles use a sample. If both
        // extrema are inside the fences there can be no outliers to scan for.
        let whiskers =
            (use_iqr && (summary[0] < fences[0] || summary[4] > fences[1])).then(|| Whiskers {
                fences,
                endpoints: [f64::INFINITY, f64::NEG_INFINITY],
                outliers: Reservoir::new(MAX_GROUP_OUTLIERS),
                observed: 0,
            });
        requires_rescan |= whiskers.is_some();
        let result = ChartGroup {
            label: String::new(),
            count: group.values.seen,
            summary: Some(summary),
            density,
            sample_count: Some(group.values.values.len()),
            whiskers: Some([summary[0], summary[4]]),
            outlier_count: Some(0),
            outliers: Some(Vec::new()),
            ..ChartGroup::default()
        };
        calculated.insert(label, (result, whiskers));
    }
    if requires_rescan {
        let y = projection
            .y
            .ok_or_else(|| invalid("A distribution requires a Y column."))?;
        input.visit(&projection.columns, job, |row, indices| {
            if !matches_filter(request, projection, row, indices) {
                return Ok(());
            }
            if let Some((_, Some(whiskers))) =
                group_label(&row[indices[0]]).and_then(|label| calculated.get_mut(label))
            {
                if let Ok(value) = y_axis.coordinate(&row[indices[y]], request.y_scale) {
                    whiskers.add(value);
                }
            }
            Ok(())
        })?;
    }
    let mut results = Vec::with_capacity(calculated.len());
    for (label, (mut result, whiskers)) in calculated {
        result.label = label;
        if let Some(mut whiskers) = whiskers {
            if whiskers.observed != result.count || whiskers.endpoints[0] > whiskers.endpoints[1] {
                return Err(invalid(
                    "The source changed while computing distribution whiskers.",
                ));
            }
            output.sampled |= whiskers.outliers.sampled();
            result.whiskers = Some(whiskers.endpoints);
            result.outlier_count = Some(whiskers.outliers.seen);
            whiskers.outliers.values.sort_unstable_by(f64::total_cmp);
            result.outliers = Some(whiskers.outliers.values);
        }
        results.push(result);
    }
    output.groups = Some(results);
    Ok(())
}

struct Histogram {
    edges: Vec<f64>,
    counts: Vec<u64>,
}

impl Histogram {
    fn new(
        distribution: &Distribution,
        options: Option<HistogramOptions>,
        range: Option<HistogramRange>,
    ) -> Result<Self, DataError> {
        let count = distribution.values.seen;
        let (min, max) = range.map_or((distribution.min, distribution.max), |range| {
            (range.min, range.max)
        });
        let edges = if count == 0 && range.is_none() {
            Vec::new()
        } else {
            match options {
                Some(HistogramOptions::Width { width }) => {
                    width_edges(min, max, width, range.is_some())?
                }
                _ if min == max => vec![min, max],
                Some(HistogramOptions::Count { count }) => count_edges(min, max, count, true)?,
                None => count_edges(
                    min,
                    max,
                    ((count as f64).sqrt().ceil() as usize).clamp(1, MAX_BINS),
                    false,
                )?,
            }
        };
        let counts = vec![0; edges.len().saturating_sub(1)];
        Ok(Self { edges, counts })
    }

    fn add(&mut self, value: f64) {
        // Interior ranges are [start, end); the last range includes the maximum.
        let bin = self
            .edges
            .partition_point(|edge| *edge <= value)
            .saturating_sub(1)
            .min(self.counts.len() - 1);
        self.counts[bin] += 1;
    }

    fn count(&self) -> u64 {
        self.counts.iter().sum()
    }

    fn finish(self) -> Vec<ChartBin> {
        self.edges
            .windows(2)
            .zip(self.counts)
            .map(|(edges, count)| ChartBin {
                start: edges[0],
                end: edges[1],
                count,
            })
            .collect()
    }
}

fn count_edges(min: f64, max: f64, count: usize, exact: bool) -> Result<Vec<f64>, DataError> {
    let mut edges = (0..=count)
        .map(|edge| interpolate(min, max, edge as f64 / count as f64))
        .collect::<Vec<_>>();
    edges.dedup();
    if exact && edges.len() != count + 1 {
        return Err(invalid(
            "The histogram bin count is too high for the axis precision. Choose fewer bins.",
        ));
    }
    Ok(edges)
}

fn width_edges(min: f64, max: f64, width: f64, clip_last: bool) -> Result<Vec<f64>, DataError> {
    let mut edges = vec![min];
    let mut previous = min;
    for index in 1..=MAX_BINS {
        let edge = width.mul_add(index as f64, min);
        if clip_last && edge >= max {
            edges.push(max);
            return Ok(edges);
        }
        if !edge.is_finite() || edge <= previous {
            return Err(invalid(
                "The histogram bin width cannot represent finite, increasing bin edges.",
            ));
        }
        if edge >= max {
            edges.push(edge);
            return Ok(edges);
        }
        // A decimal input can round the last computed edge just below the
        // observed maximum. Avoid a spurious extra bin at an integral ratio.
        if edge.next_up() == max && max - edge <= width * (4.0 * f64::EPSILON) {
            edges.push(max);
            return Ok(edges);
        }
        edges.push(edge);
        previous = edge;
    }
    Err(invalid(
        "The histogram bin width requires more than 48 bins. Choose a wider bin.",
    ))
}

pub(super) fn ratio(value: f64, min: f64, max: f64) -> f64 {
    if min == max {
        return 0.0;
    }
    let width = max - min;
    if width.is_finite() {
        ((value - min) / width).clamp(0.0, 1.0)
    } else {
        ((value * 0.5 - min * 0.5) / (max * 0.5 - min * 0.5)).clamp(0.0, 1.0)
    }
}

fn interpolate(a: f64, b: f64, fraction: f64) -> f64 {
    if fraction == 0.0 || a == b {
        a
    } else if fraction == 1.0 {
        b
    } else if (b - a).is_finite() {
        (b - a).mul_add(fraction, a).clamp(a.min(b), a.max(b))
    } else {
        a * (1.0 - fraction) + b * fraction
    }
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    let at = (values.len() - 1) as f64 * percentile;
    let lower = at.floor() as usize;
    let upper = at.ceil() as usize;
    interpolate(values[lower], values[upper], at.fract())
}
