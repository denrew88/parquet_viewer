use std::{borrow::Cow, collections::BTreeMap};

use crate::domain::DataError;

use super::{
    axis::{canonical, group_label, is_temporal, kind, Axis, AxisExclusion},
    bar, invalid, line, ChartBin, ChartCell, ChartData, ChartGroup, ChartGroupDirectory,
    ChartGroupEntry, ChartKind, ChartPointDetails, ChartRequest, HistogramOptions,
    HistogramOutside, HistogramRange, Input, Job, Projection, WhiskerMode, MAX_BINS, MAX_GROUPS,
};

mod occupancy;
pub(super) use occupancy::ScatterTiles;

pub(super) const MAX_POINTS: usize = 20_000;
pub(super) const MAX_GROUP_LABEL_BYTES: usize = 256;
pub(super) const MAX_GROUP_CATEGORIES: usize = 65_536;
const MAX_POINT_DETAIL_BYTES: usize = 128;
const MAX_GROUP_SAMPLES: usize = 2_048;
const MAX_GROUP_OUTLIERS: usize = 128;
const MAX_GROUP_OBSERVATIONS: usize = 128;
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
        ChartKind::Histogram => return compute_histogram(request, projection, input, job),
        _ => {}
    }
    let mut x_axis = Axis::default();
    let mut y_axis = Axis::default();
    let mut output = ChartData::default();
    let mut points = Reservoir::<([f64; 2], ChartPointDetails)>::new(MAX_POINTS);
    let mut tiles = None;
    let mut groups = BTreeMap::<String, GroupState>::new();

    input.visit(&projection.columns, job, |row| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row) {
            output.filtered_rows += 1;
            return Ok(());
        }
        let x = row[0];
        let y = projection.y.map(|slot| row[slot]);
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
                    if points.seen >= MAX_POINTS as u64 {
                        let occupancy = tiles.get_or_insert_with(|| {
                            let mut occupancy = ScatterTiles::default();
                            for (retained, _) in &points.values {
                                occupancy.add(*retained);
                            }
                            occupancy
                        });
                        occupancy.add(point);
                    }
                    points.add_with(|| {
                        let label = projection
                            .scatter_label
                            .and_then(|index| detail_text(row[index]))
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
                        let group = if let Some(group) = groups.get_mut(label.as_ref()) {
                            group
                        } else {
                            let known = groups.len();
                            if known >= MAX_GROUP_CATEGORIES {
                                return Err(invalid(
                                    "A distribution supports at most 65,536 groups. Filter the data or group categories first.",
                                ));
                            }
                            groups.entry(label.into_owned()).or_insert_with(|| GroupState {
                                count: 0,
                                distribution: (known < MAX_GROUPS)
                                    .then(|| Distribution::new(MAX_GROUP_SAMPLES)),
                            })
                        };
                        group.count += 1;
                        if let Some(distribution) = &mut group.distribution {
                            distribution.add(value);
                        }
                        Ok(())
                    }
                    Err(excluded) => Err(excluded),
                }
            }
            ChartKind::Line | ChartKind::Bar | ChartKind::Histogram => {
                unreachable!("handled before visiting")
            }
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
            output.scatter_tiles = tiles.map(ScatterTiles::finish);
            let (points, details) = points.values.into_iter().unzip();
            output.points = Some(points);
            output.point_details = Some(details);
        }
        ChartKind::Box | ChartKind::Violin => {
            output.groups_truncated = groups.len() > MAX_GROUPS;
            let mut entries = Vec::with_capacity(groups.len());
            let mut distributions = BTreeMap::new();
            for (label, group) in groups {
                if let Some(distribution) = group.distribution {
                    distributions.insert(label.clone(), distribution);
                }
                entries.push(ChartGroupEntry {
                    label,
                    count: group.count,
                    value: None,
                });
            }
            populate_group_directory(&mut output, entries);
            finish_distributions(
                request,
                projection,
                input,
                job,
                &mut y_axis,
                distributions,
                &mut output,
            )?;
        }
        ChartKind::Line | ChartKind::Bar | ChartKind::Histogram => {
            unreachable!("handled before visiting")
        }
    }
    (output.x_origin, output.x_unit) = x_axis.metadata();
    (output.y_origin, output.y_unit) = y_axis.metadata();
    Ok(output)
}

fn compute_histogram(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    let mut x_axis = Axis::default();
    let range = request.histogram_range;
    let mut output = ChartData {
        histogram_outside: range.map(|_| HistogramOutside::default()),
        ..ChartData::default()
    };
    // Keep an edge error until the first scan has checked source identity and
    // established that its axis supports an absolute range.
    let mut fixed = range
        .zip(request.histogram)
        .map(|(range, options)| Histogram::new(0, None, Some(options), Some(range)))
        .transpose();
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut values = Vec::new();
    input.visit(&projection.columns, job, |row| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row) {
            output.filtered_rows += 1;
            return Ok(());
        }
        let value = match x_axis.coordinate(row[0], request.x_scale) {
            Ok(value) => value,
            Err(excluded) => {
                record_exclusion(&mut output, excluded);
                return Ok(());
            }
        };
        if let Some((range, outside)) = range.zip(output.histogram_outside.as_mut()) {
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
        output.valid_rows += 1;
        match &mut fixed {
            Ok(Some(bins)) => bins.add(value),
            Ok(None) => {
                min = min.min(value);
                max = max.max(value);
                // Small inputs can be binned exactly from these values. For larger
                // inputs only the exact extrema and count inform the bin edges.
                if values.len() < MAX_POINTS {
                    values.push(value);
                }
            }
            Err(_) => {}
        }
        Ok(())
    })?;

    let bins = if let Some(bins) = fixed? {
        bins
    } else {
        let observed = (output.valid_rows > 0).then_some((min, max));
        let mut bins = Histogram::new(output.valid_rows, observed, request.histogram, range)?;
        if output.valid_rows <= MAX_POINTS as u64 {
            for value in values {
                bins.add(value);
            }
        } else if min == max {
            bins.add_count(min, output.valid_rows);
        } else {
            // A second scan keeps bin counts exact without retaining all coordinates.
            input.visit(&projection.columns, job, |row| {
                if matches_filter(request, projection, row) {
                    if let Ok(value) = x_axis.coordinate(row[0], request.x_scale) {
                        if range.is_some_and(|range| value < range.min || value > range.max) {
                            return Ok(());
                        }
                        if !(min..=max).contains(&value) {
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
        }
        bins
    };
    output.bins = Some(bins.finish());
    (output.x_origin, output.x_unit) = x_axis.metadata();
    Ok(output)
}

pub(super) fn detail_text(cell: ChartCell<'_>) -> Option<Cow<'_, str>> {
    if kind(cell).is_some_and(is_temporal) {
        group_label(cell)
    } else {
        canonical(cell)
    }
}

pub(super) fn bounded_detail(text: Cow<'_, str>) -> String {
    if text.len() <= MAX_POINT_DETAIL_BYTES {
        return text.into_owned();
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
    x: ChartCell<'_>,
    y: Option<ChartCell<'_>>,
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
    row: &[ChartCell<'_>],
) -> bool {
    request
        .filter
        .as_ref()
        .zip(projection.filter)
        .is_none_or(|(filter, index)| {
            canonical(row[index]).as_deref() == Some(filter.equals.as_str())
        })
}

pub(super) struct Reservoir<T> {
    cap: usize,
    seen: u64,
    pub(super) values: Vec<T>,
}

impl<T> Reservoir<T> {
    pub(super) fn new(cap: usize) -> Self {
        Self {
            cap,
            seen: 0,
            values: Vec::new(),
        }
    }

    pub(super) fn add(&mut self, value: T) {
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

    pub(super) fn sampled(&self) -> bool {
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

struct GroupState {
    count: u64,
    distribution: Option<Distribution>,
}

pub(super) fn populate_group_directory(output: &mut ChartData, entries: Vec<ChartGroupEntry>) {
    output.group_count = Some(entries.len());
    output.group_directory = Some(ChartGroupDirectory {
        total: entries.len(),
        offset: 0,
        entries: entries.iter().take(MAX_GROUPS).cloned().collect(),
    });
    output.all_groups = Some(entries);
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

    fn quartiles(&self, ordered: &[f64]) -> [f64; 5] {
        [
            self.min,
            percentile(ordered, 0.25),
            percentile(ordered, 0.5),
            percentile(ordered, 0.75),
            self.max,
        ]
    }

    fn density(
        &self,
        ordered: &[f64],
        bandwidth_multiplier: f64,
        job: &Job<'_>,
    ) -> Result<Option<Vec<[f64; 2]>>, DataError> {
        if ordered.len() < 2 || self.min == self.max {
            return Ok(None);
        }
        let sample = ordered
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
    outlier_extrema: [f64; 2],
    observed: u64,
}

impl Whiskers {
    fn add(&mut self, value: f64) {
        self.observed += 1;
        if value < self.fences[0] || value > self.fences[1] {
            self.outliers.add(value);
            self.outlier_extrema[0] = self.outlier_extrema[0].min(value);
            self.outlier_extrema[1] = self.outlier_extrema[1].max(value);
        } else {
            self.endpoints[0] = self.endpoints[0].min(value);
            self.endpoints[1] = self.endpoints[1].max(value);
        }
    }

    fn apply(mut self, result: &mut ChartGroup, output: &mut ChartData) -> Result<(), DataError> {
        if self.observed != result.count || self.endpoints[0] > self.endpoints[1] {
            return Err(invalid(
                "The source changed while computing distribution whiskers.",
            ));
        }
        let sampled = self.outliers.sampled();
        output.sampled |= sampled;
        result.whiskers = Some(self.endpoints);
        result.outlier_count = Some(self.outliers.seen);
        self.outliers.values.sort_unstable_by(f64::total_cmp);
        if sampled {
            self.outliers.values[0] = self.outlier_extrema[0];
            let last = self.outliers.values.len() - 1;
            self.outliers.values[last] = self.outlier_extrema[1];
        }
        result.outliers = Some(self.outliers.values);
        Ok(())
    }
}

fn summarize_distribution(
    request: &ChartRequest,
    group: Distribution,
    job: &Job<'_>,
    output: &mut ChartData,
) -> Result<(ChartGroup, Option<Whiskers>), DataError> {
    job.check()?;
    let sampled = group.values.sampled();
    output.sampled |= sampled;
    let mut ordered = group.values.values.clone();
    ordered.sort_unstable_by(f64::total_cmp);
    let summary = group.quartiles(&ordered);
    let density = if request.kind == ChartKind::Violin {
        group.density(&ordered, request.violin_bandwidth.unwrap_or(1.0), job)?
    } else {
        None
    };
    let radius = 1.5 * (summary[3] - summary[1]);
    let fences = [summary[1] - radius, summary[3] + radius];
    // Global extrema are exact even when quartiles use a sample. If both
    // extrema are inside the fences there can be no outliers to scan for.
    let mut whiskers = (request.whiskers != Some(WhiskerMode::Minmax)
        && (summary[0] < fences[0] || summary[4] > fences[1]))
        .then(|| Whiskers {
            fences,
            endpoints: [f64::INFINITY, f64::NEG_INFINITY],
            outliers: Reservoir::new(MAX_GROUP_OUTLIERS),
            outlier_extrema: [f64::INFINITY, f64::NEG_INFINITY],
            observed: 0,
        });
    let mut result = ChartGroup {
        count: group.values.seen,
        summary: Some(summary),
        density,
        sample_count: Some(group.values.values.len()),
        whiskers: Some([summary[0], summary[4]]),
        outlier_count: Some(0),
        outliers: Some(Vec::new()),
        observations: (!sampled && ordered.len() <= MAX_GROUP_OBSERVATIONS).then_some(ordered),
        ..ChartGroup::default()
    };
    if !sampled {
        if let Some(mut whiskers) = whiskers.take() {
            // Exact retained values are already available in source order.
            // Outlier sampling must see that order, not quartile sort order.
            for value in group.values.values {
                whiskers.add(value);
            }
            whiskers.apply(&mut result, output)?;
        }
    }
    Ok((result, whiskers))
}

pub(super) type DistributionValueVisitor<'a> = dyn FnMut(f64) -> Result<(), DataError> + 'a;

pub(super) fn group_detail(
    request: &ChartRequest,
    label: &str,
    visit: &mut dyn FnMut(&mut DistributionValueVisitor<'_>) -> Result<(), DataError>,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    let mut group = Distribution::new(MAX_GROUP_SAMPLES);
    visit(&mut |value| {
        group.add(value);
        Ok(())
    })?;
    let count = group.values.seen;
    if count == 0 {
        return Err(invalid("This group has no valid observations."));
    }
    let mut output = ChartData {
        total_rows: count,
        valid_rows: count,
        group_count: Some(1),
        ..ChartData::default()
    };
    let (mut result, whiskers) = summarize_distribution(request, group, job, &mut output)?;
    if let Some(mut whiskers) = whiskers {
        visit(&mut |value| {
            whiskers.add(value);
            Ok(())
        })?;
        whiskers.apply(&mut result, &mut output)?;
    }
    result.label = label.to_owned();
    output.groups = Some(vec![result]);
    Ok(output)
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
    let mut calculated = BTreeMap::new();
    let mut requires_rescan = false;
    for (label, group) in groups {
        let (result, whiskers) = summarize_distribution(request, group, job, output)?;
        requires_rescan |= whiskers.is_some();
        calculated.insert(label, (result, whiskers));
    }
    if requires_rescan {
        let y = projection
            .y
            .ok_or_else(|| invalid("A distribution requires a Y column."))?;
        input.visit(&projection.columns, job, |row| {
            if !matches_filter(request, projection, row) {
                return Ok(());
            }
            if let Some((_, Some(whiskers))) =
                group_label(row[0]).and_then(|label| calculated.get_mut(label.as_ref()))
            {
                if let Ok(value) = y_axis.coordinate(row[y], request.y_scale) {
                    whiskers.add(value);
                }
            }
            Ok(())
        })?;
    }
    let mut results = Vec::with_capacity(calculated.len());
    for (label, (mut result, whiskers)) in calculated {
        result.label = label;
        if let Some(whiskers) = whiskers {
            whiskers.apply(&mut result, output)?;
        }
        results.push(result);
    }
    output.groups = Some(results);
    Ok(())
}

pub(super) struct Histogram {
    edges: Vec<f64>,
    counts: Vec<u64>,
}

impl Histogram {
    pub(super) fn new(
        count: u64,
        observed: Option<(f64, f64)>,
        options: Option<HistogramOptions>,
        range: Option<HistogramRange>,
    ) -> Result<Self, DataError> {
        let edges = if let Some((min, max)) = range.map(|range| (range.min, range.max)).or(observed)
        {
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
        } else {
            Vec::new()
        };
        let counts = vec![0; edges.len().saturating_sub(1)];
        Ok(Self { edges, counts })
    }

    pub(super) fn add(&mut self, value: f64) {
        self.add_count(value, 1);
    }

    fn add_count(&mut self, value: f64, count: u64) {
        // Interior ranges are [start, end); the last range includes the maximum.
        let bin = self
            .edges
            .partition_point(|edge| *edge <= value)
            .saturating_sub(1)
            .min(self.counts.len() - 1);
        self.counts[bin] += count;
    }

    fn count(&self) -> u64 {
        self.counts.iter().sum()
    }

    pub(super) fn finish(self) -> Vec<ChartBin> {
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

pub(super) fn interpolate(a: f64, b: f64, fraction: f64) -> f64 {
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
