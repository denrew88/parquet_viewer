//! Chart detail reuses the overview's coordinate frame and prepares a bounded
//! projection index once per chart configuration. Raw source rows are not
//! retained in memory or read again by a warm range or group request.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, TryLockError},
    thread,
    time::Duration,
};

use crate::{domain::DataError, storage::QueryTempManager};

use super::{
    axis::{group_label, Axis},
    detail_index::{DiskIndex, IndexWriter, Record, MAX_INDEX_BYTES},
    invalid,
    line::{self, Envelope, LinePoint},
    statistics::{
        bounded_detail, compute_chart, detail_text, group_detail, matches_filter, point, ratio,
        scatter_point, Histogram, Reservoir, ScatterTiles, MAX_GROUP_LABEL_BYTES, MAX_POINTS,
    },
    BarOptions, BarSort, ChartBin, ChartData, ChartDetail, ChartGroup, ChartGroupDirectory,
    ChartGroupEntry, ChartKind, ChartPointDetails, ChartRequest, ChartSource, HistogramOptions,
    Input, Job, LineAggregate, Projection,
};

#[cfg(test)]
mod tests;

const MAX_OVERVIEWS: usize = 4;
const MAX_INDEXES: usize = 2;
const TILE_SIDE: usize = 32;
const X_TILES: usize = 256;
const GROUP_TILES: usize = 256;
const DIRECTORY_PAGE: usize = 32;
const MAX_DIRECTORY_GROUPS: usize = 65_536;
const MAX_DETAIL_OBSERVATIONS: u64 = 2_048;

type Bounds = [f64; 2];

#[derive(Default)]
pub(super) struct DetailCache {
    state: Mutex<CacheState>,
}

#[derive(Default)]
struct CacheState {
    overviews: VecDeque<(String, Arc<Overview>)>,
    indexes: VecDeque<(String, Arc<IndexSlot>)>,
}

struct IndexSlot {
    source: ChartSource,
    index: Mutex<Option<Arc<DiskIndex>>>,
}

struct Overview {
    source: ChartSource,
    x: Option<Bounds>,
    y: Option<Bounds>,
    x_origin: Option<String>,
    y_origin: Option<String>,
    x_unit: Option<&'static str>,
    y_unit: Option<&'static str>,
    fixed_bins: Option<Vec<ChartBin>>,
    directory: Vec<ChartGroupEntry>,
    bar_total: Option<f64>,
    bar_summary: Option<BarSummary>,
}

struct BarSummary {
    total_rows: u64,
    valid_rows: u64,
    excluded_rows: u64,
    scale_excluded_rows: u64,
    filtered_rows: u64,
    groups_truncated: bool,
}

impl Overview {
    fn from_output(request: &ChartRequest, output: &mut ChartData) -> Self {
        let (x, y) = if let Some([x_min, x_max, y_min, y_max]) = output.scatter_extent {
            (Some([x_min, x_max]), Some([y_min, y_max]))
        } else if let Some(bins) = &output.bins {
            (
                bins.first().zip(bins.last()).map(|(a, b)| [a.start, b.end]),
                None,
            )
        } else if let Some(points) = &output.points {
            // Both line modes preserve the first and last X, even when reduced.
            (
                points.first().zip(points.last()).map(|(a, b)| [a[0], b[0]]),
                None,
            )
        } else {
            (None, None)
        };
        Self {
            source: request.source.clone(),
            x,
            y,
            x_origin: output.x_origin.clone(),
            y_origin: output.y_origin.clone(),
            x_unit: output.x_unit,
            y_unit: output.y_unit,
            fixed_bins: matches!(request.histogram, Some(HistogramOptions::Width { .. }))
                .then(|| output.bins.clone().unwrap_or_default()),
            directory: output.all_groups.take().unwrap_or_default(),
            bar_total: output.bar_total,
            bar_summary: (request.kind == ChartKind::Bar && request.bar.is_some()).then_some(
                BarSummary {
                    total_rows: output.total_rows,
                    valid_rows: output.valid_rows,
                    excluded_rows: output.excluded_rows,
                    scale_excluded_rows: output.scale_excluded_rows,
                    filtered_rows: output.filtered_rows,
                    groups_truncated: output.groups_truncated,
                },
            ),
        }
    }

    fn annotate(&self, result: &mut ChartData) {
        result.x_origin.clone_from(&self.x_origin);
        result.y_origin.clone_from(&self.y_origin);
        result.x_unit = self.x_unit;
        result.y_unit = self.y_unit;
    }
}

impl DetailCache {
    pub(super) fn overview(
        &self,
        request: &ChartRequest,
        projection: &Projection,
        input: &Input,
        job: &Job<'_>,
    ) -> Result<ChartData, DataError> {
        let key = cache_key(request)?;
        if request.kind == ChartKind::Bar {
            if let (Some(options), Some(overview)) = (request.bar, self.get_overview(&key)?) {
                if let Some(result) = bar_overview(&overview, options) {
                    job.check()?;
                    if let Err(error) = input.validate_current() {
                        self.forget(&key);
                        return Err(error);
                    }
                    return Ok(result);
                }
            }
        }
        let mut output = compute_chart(request, projection, input, job)?;
        job.check()?;
        input.validate_current()?;
        self.remember_overview(key, Arc::new(Overview::from_output(request, &mut output)))?;
        Ok(output)
    }

    pub(super) fn compute(
        &self,
        request: &ChartRequest,
        projection: &Projection,
        input: &Input,
        job: &Job<'_>,
        detail: &ChartDetail,
        temp: Option<&QueryTempManager>,
    ) -> Result<ChartData, DataError> {
        validate_detail(request.kind, detail)?;
        let key = cache_key(request)?;
        if let Err(error) = input.validate_current() {
            self.forget(&key);
            return Err(error);
        }
        let overview = match self.get_overview(&key)? {
            Some(overview) => overview,
            None => {
                let mut output = compute_chart(request, projection, input, job)?;
                job.check()?;
                input.validate_current()?;
                let overview = Arc::new(Overview::from_output(request, &mut output));
                self.remember_overview(key.clone(), Arc::clone(&overview))?;
                overview
            }
        };
        let mut result = match detail {
            ChartDetail::Groups { offset, search } => directory_page(
                &overview,
                *offset,
                search.as_deref(),
                request.bar.map(|options| options.sort),
            ),
            ChartDetail::Group { label } => {
                let id = overview
                    .directory
                    .iter()
                    .position(|entry| &entry.label == label)
                    .ok_or_else(|| invalid("The chart group is no longer available."))?;
                let entry = &overview.directory[id];
                if request.kind == ChartKind::Bar {
                    ChartData {
                        total_rows: entry.count,
                        valid_rows: entry.count,
                        group_count: Some(1),
                        bar_total: overview.bar_total,
                        groups: Some(vec![bar_group(entry)]),
                        ..ChartData::default()
                    }
                } else {
                    let slot = self.slot(&key, &request.source)?;
                    let index = index_for(&slot, request, projection, input, job, &overview, temp)?;
                    let mut replay =
                        |visitor: &mut super::statistics::DistributionValueVisitor<'_>| {
                            index.visit([group_tile(id)], job, |record| {
                                if record.row == id as u64 {
                                    visitor(record.xy[1])?;
                                }
                                Ok(())
                            })
                        };
                    let mut result = group_detail(request, label, &mut replay, job)?;
                    if result.valid_rows != entry.count {
                        return Err(invalid("The chart group changed while preparing detail."));
                    }
                    if entry.count <= MAX_DETAIL_OBSERVATIONS {
                        if let Some(group) =
                            result.groups.as_mut().and_then(|groups| groups.first_mut())
                        {
                            if group.observations.is_none() {
                                let mut observations = Vec::with_capacity(entry.count as usize);
                                replay(&mut |value| {
                                    observations.push(value);
                                    Ok(())
                                })?;
                                group.observations = Some(observations);
                            }
                        }
                    }
                    result
                }
            }
            ChartDetail::Range { x, y } => {
                if let Some(bins) = &overview.fixed_bins {
                    // The fixed-width view presents complete bins with their
                    // original edges and exact full-bin counts.
                    fixed_histogram_range(bins, *x)
                } else if let Some(x_extent) = overview.x.filter(|extent| {
                    intersects(*extent, *x)
                        && y.zip(overview.y)
                            .is_none_or(|(range, extent)| intersects(range, extent))
                }) {
                    let slot = self.slot(&key, &request.source)?;
                    let index = index_for(&slot, request, projection, input, job, &overview, temp)?;
                    let y_extent = overview.y;
                    match request.kind {
                        ChartKind::Scatter => {
                            let y_extent = y_extent
                                .ok_or_else(|| invalid("The scatter Y range is unavailable."))?;
                            scatter_range(
                                &index,
                                job,
                                x_extent,
                                y_extent,
                                *x,
                                y.unwrap_or(y_extent),
                            )?
                        }
                        ChartKind::Line => line_range(&index, job, x_extent, *x)?,
                        ChartKind::Histogram => {
                            histogram_range(&index, job, request, x_extent, *x)?
                        }
                        _ => {
                            return Err(invalid(
                                "This chart does not support a numeric detail range.",
                            ))
                        }
                    }
                } else {
                    empty_range(request.kind)
                }
            }
        };
        job.check()?;
        if let Err(error) = input.validate_current() {
            self.forget(&key);
            return Err(error);
        }
        overview.annotate(&mut result);
        Ok(result)
    }

    fn lock(&self) -> Result<MutexGuard<'_, CacheState>, DataError> {
        self.state
            .lock()
            .map_err(|_| invalid("The chart detail cache is unavailable."))
    }

    fn get_overview(&self, key: &str) -> Result<Option<Arc<Overview>>, DataError> {
        let mut state = self.lock()?;
        if let Some(pos) = state.overviews.iter().position(|(name, _)| name == key) {
            if let Some(item) = state.overviews.remove(pos) {
                let overview = Arc::clone(&item.1);
                state.overviews.push_front(item);
                return Ok(Some(overview));
            }
        }
        Ok(None)
    }

    fn remember_overview(&self, key: String, overview: Arc<Overview>) -> Result<(), DataError> {
        let mut state = self.lock()?;
        state.overviews.retain(|(name, _)| name != &key);
        state.overviews.push_front((key, overview));
        // Keep metadata alive as long as the corresponding disk index.
        while state.overviews.len() > MAX_OVERVIEWS {
            let evict = state
                .overviews
                .iter()
                .rposition(|(name, _)| !state.indexes.iter().any(|(index, _)| index == name))
                .ok_or_else(|| invalid("The chart overview cache is full."))?;
            state.overviews.remove(evict);
        }
        Ok(())
    }

    fn slot(&self, key: &str, source: &ChartSource) -> Result<Arc<IndexSlot>, DataError> {
        let mut state = self.lock()?;
        if let Some(pos) = state.indexes.iter().position(|(name, _)| name == key) {
            if let Some(item) = state.indexes.remove(pos) {
                let slot = Arc::clone(&item.1);
                state.indexes.push_front(item);
                return Ok(slot);
            }
        }
        let evicted = if state.indexes.len() >= MAX_INDEXES {
            let evict = state
                .indexes
                .iter()
                .rposition(|(_, slot)| Arc::strong_count(slot) == 1)
                .ok_or_else(|| invalid("Chart detail indexes are busy. Try again shortly."))?;
            state.indexes.remove(evict)
        } else {
            None
        };
        let slot = Arc::new(IndexSlot {
            source: source.clone(),
            index: Mutex::new(None),
        });
        state
            .indexes
            .push_front((key.to_owned(), Arc::clone(&slot)));
        drop(state);
        drop(evicted);
        Ok(slot)
    }

    fn forget(&self, key: &str) {
        if let Ok(mut state) = self.state.lock() {
            let evicted = state
                .indexes
                .iter()
                .position(|(name, _)| name == key)
                .and_then(|pos| state.indexes.remove(pos));
            state.overviews.retain(|(name, _)| name != key);
            drop(state);
            drop(evicted);
        }
    }

    pub(super) fn invalidate_block(&self, block_id: &str) {
        self.invalidate(
            |source| matches!(source, ChartSource::Block { block_id: id } if id == block_id),
        );
    }

    pub(super) fn invalidate(&self, matches: impl Fn(&ChartSource) -> bool) {
        if let Ok(mut state) = self.state.lock() {
            let (evicted, kept): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut state.indexes)
                .into_iter()
                .partition(|(_, slot)| matches(&slot.source));
            state.indexes = kept;
            state
                .overviews
                .retain(|(_, overview)| !matches(&overview.source));
            drop(state);
            drop(evicted);
        }
    }

    pub(super) fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            let evicted = std::mem::take(&mut *state);
            drop(state);
            drop(evicted);
        }
    }
}

fn cache_key(request: &ChartRequest) -> Result<String, DataError> {
    let mut key = request.clone();
    if let Some(bar) = key.bar.as_mut() {
        // Sorting and the displayed category limit do not change aggregates.
        bar.sort = BarSort::Category;
        bar.limit = super::MAX_GROUPS;
    }
    serde_json::to_string(&key).map_err(|_| invalid("The chart settings cannot be cached."))
}

fn validate_detail(kind: ChartKind, detail: &ChartDetail) -> Result<(), DataError> {
    let valid_range = |range: &Bounds| range.iter().all(|x| x.is_finite()) && range[0] <= range[1];
    let valid_text = |text: &str| text.len() <= MAX_GROUP_LABEL_BYTES && !text.contains('\0');
    match detail {
        ChartDetail::Range { x, y }
            if matches!(
                kind,
                ChartKind::Scatter | ChartKind::Line | ChartKind::Histogram
            ) && valid_range(x)
                && y.as_ref()
                    .is_none_or(|y| kind == ChartKind::Scatter && valid_range(y)) =>
        {
            Ok(())
        }
        ChartDetail::Groups { offset, search }
            if matches!(kind, ChartKind::Bar | ChartKind::Box | ChartKind::Violin)
                && *offset <= MAX_DIRECTORY_GROUPS
                && search.as_deref().is_none_or(valid_text) =>
        {
            Ok(())
        }
        ChartDetail::Group { label }
            if matches!(kind, ChartKind::Bar | ChartKind::Box | ChartKind::Violin)
                && valid_text(label) =>
        {
            Ok(())
        }
        _ => Err(invalid("The chart detail request is invalid.")),
    }
}

fn directory_page(
    overview: &Overview,
    offset: usize,
    search: Option<&str>,
    sort: Option<BarSort>,
) -> ChartData {
    let search = search.unwrap_or_default().to_lowercase();
    let mut total = 0;
    let mut entries = Vec::with_capacity(DIRECTORY_PAGE);
    for entry in directory_order(overview, sort) {
        if search.is_empty() || entry.label.to_lowercase().contains(&search) {
            if total >= offset && entries.len() < DIRECTORY_PAGE {
                entries.push(entry.clone());
            }
            total += 1;
        }
    }
    ChartData {
        group_count: Some(overview.directory.len()),
        group_directory: Some(ChartGroupDirectory {
            total,
            offset,
            entries,
        }),
        bar_total: overview.bar_total,
        ..ChartData::default()
    }
}

fn directory_order(overview: &Overview, sort: Option<BarSort>) -> Vec<&ChartGroupEntry> {
    let mut entries = overview.directory.iter().collect::<Vec<_>>();
    if let Some(sort) = sort {
        entries.sort_unstable_by(|a, b| {
            let a_value = a.value.unwrap_or(a.count as f64);
            let b_value = b.value.unwrap_or(b.count as f64);
            match sort {
                BarSort::Category => a.label.cmp(&b.label),
                BarSort::Asc => a_value
                    .total_cmp(&b_value)
                    .then_with(|| a.label.cmp(&b.label)),
                BarSort::Desc => b_value
                    .total_cmp(&a_value)
                    .then_with(|| a.label.cmp(&b.label)),
            }
        });
    }
    entries
}

fn bar_group(entry: &ChartGroupEntry) -> ChartGroup {
    ChartGroup {
        label: entry.label.clone(),
        count: entry.count,
        value: entry.value,
        ..ChartGroup::default()
    }
}

fn bar_overview(overview: &Overview, options: BarOptions) -> Option<ChartData> {
    let counts = overview.bar_summary.as_ref()?;
    let groups = directory_order(overview, Some(options.sort))
        .into_iter()
        .take(options.limit)
        .map(bar_group)
        .collect();
    let directory = directory_page(overview, 0, None, Some(options.sort));
    Some(ChartData {
        total_rows: counts.total_rows,
        valid_rows: counts.valid_rows,
        excluded_rows: counts.excluded_rows,
        scale_excluded_rows: counts.scale_excluded_rows,
        filtered_rows: counts.filtered_rows,
        groups_truncated: counts.groups_truncated,
        group_count: directory.group_count,
        group_directory: directory.group_directory,
        bar_total: overview.bar_total,
        groups: Some(groups),
        ..ChartData::default()
    })
}

fn index_for(
    slot: &IndexSlot,
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
    overview: &Overview,
    temp: Option<&QueryTempManager>,
) -> Result<Arc<DiskIndex>, DataError> {
    // The first request builds the index. Waiters remain cancellable instead
    // of issuing concurrent full-source scans for the same chart.
    loop {
        job.check()?;
        match slot.index.try_lock() {
            Ok(mut index) => {
                if let Some(index) = index.as_ref() {
                    return Ok(Arc::clone(index));
                }
                let temp =
                    temp.ok_or_else(|| invalid("Chart detail temporary storage is unavailable."))?;
                let prepared = Arc::new(build_index(
                    request, projection, input, job, overview, temp,
                )?);
                *index = Some(Arc::clone(&prepared));
                return Ok(prepared);
            }
            Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(10)),
            Err(TryLockError::Poisoned(_)) => {
                return Err(invalid("The chart detail index is unavailable."))
            }
        }
    }
}

fn build_index(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
    overview: &Overview,
    temp: &QueryTempManager,
) -> Result<DiskIndex, DataError> {
    let scatter = request.kind == ChartKind::Scatter;
    let partitions = match request.kind {
        ChartKind::Scatter => TILE_SIDE * TILE_SIDE,
        ChartKind::Line | ChartKind::Histogram => X_TILES,
        ChartKind::Box | ChartKind::Violin => GROUP_TILES,
        ChartKind::Bar => {
            return Err(invalid(
                "Bar chart detail uses its existing category aggregates.",
            ))
        }
    };
    let lease = temp.allocate_bounded("chart-detail", &request.request_id, MAX_INDEX_BYTES)?;
    let mut writer = IndexWriter::new(lease, partitions, scatter);
    let mut x_axis = Axis::default();
    let mut y_axis = Axis::default();
    let mut row_number = input.row_start();
    let x_extent = overview.x.unwrap_or_default();
    let y_extent = overview.y.unwrap_or_default();
    if request.kind == ChartKind::Line
        && request
            .line
            .is_some_and(|options| options.aggregate != LineAggregate::Raw)
    {
        line::visit_aggregated_points(request, projection, input, job, |xy, row, count| {
            writer.add(
                tile(xy[0], x_extent, X_TILES),
                Record {
                    xy,
                    row,
                    count,
                    details: None,
                },
            )
        })?;
    } else {
        let group_ids = overview
            .directory
            .iter()
            .enumerate()
            .map(|(i, group)| (group.label.as_str(), i))
            .collect::<HashMap<_, _>>();
        input.visit(&projection.columns, job, |row| {
            row_number += 1;
            if !matches_filter(request, projection, row) {
                return Ok(());
            }
            let x = row[0];
            let y = projection.y.map(|slot| row[slot]);
            let (xy, row_number, index, details) = match request.kind {
                ChartKind::Scatter => {
                    let Ok(xy) = scatter_point(request, &mut x_axis, &mut y_axis, x, y) else {
                        return Ok(());
                    };
                    let details = ChartPointDetails {
                        row: row_number,
                        x: bounded_detail(detail_text(x).unwrap_or_default()),
                        y: bounded_detail(y.and_then(detail_text).unwrap_or_default()),
                        label: projection
                            .scatter_label
                            .and_then(|slot| detail_text(row[slot]))
                            .map(bounded_detail),
                    };
                    let index = tile(xy[1], y_extent, TILE_SIDE) * TILE_SIDE
                        + tile(xy[0], x_extent, TILE_SIDE);
                    (xy, row_number, index, Some(details))
                }
                ChartKind::Line => {
                    let y = y.ok_or_else(|| invalid("The line Y column is unavailable."))?;
                    let Ok(xy) = point(
                        x_axis.coordinate(x, request.x_scale),
                        y_axis.coordinate(y, request.y_scale),
                    ) else {
                        return Ok(());
                    };
                    (xy, row_number, tile(xy[0], x_extent, X_TILES), None)
                }
                ChartKind::Histogram => {
                    let Ok(x) = x_axis.coordinate(x, request.x_scale) else {
                        return Ok(());
                    };
                    if request
                        .histogram_range
                        .is_some_and(|range| x < range.min || x > range.max)
                    {
                        return Ok(());
                    }
                    ([x, 0.0], row_number, tile(x, x_extent, X_TILES), None)
                }
                ChartKind::Box | ChartKind::Violin => {
                    let Some(label) =
                        group_label(x).filter(|label| label.len() <= MAX_GROUP_LABEL_BYTES)
                    else {
                        return Ok(());
                    };
                    let y = y.ok_or_else(|| invalid("The chart Y column is unavailable."))?;
                    let Ok(y) = y_axis.coordinate(y, request.y_scale) else {
                        return Ok(());
                    };
                    let id = *group_ids.get(label.as_ref()).ok_or_else(|| {
                        invalid("The chart groups changed while preparing detail.")
                    })?;
                    ([0.0, y], id as u64, group_tile(id), None)
                }
                ChartKind::Bar => return Err(invalid("The bar detail mode is unavailable.")),
            };
            writer.add(
                index,
                Record {
                    xy,
                    row: row_number,
                    count: 1,
                    details,
                },
            )
        })?;
    }
    input.validate_current()?;
    writer.finish(job)
}

fn group_tile(id: usize) -> usize {
    id % GROUP_TILES
}

fn tile(value: f64, extent: Bounds, width: usize) -> usize {
    ((ratio(value, extent[0], extent[1]) * width as f64) as usize).min(width - 1)
}

fn intersects(a: Bounds, b: Bounds) -> bool {
    a[0] <= b[1] && b[0] <= a[1]
}

fn contains(bounds: Bounds, value: f64) -> bool {
    (bounds[0]..=bounds[1]).contains(&value)
}

fn candidate_tiles(extent: Bounds, request: Bounds, width: usize) -> impl Iterator<Item = usize> {
    intersects(extent, request)
        .then(|| tile(request[0], extent, width)..=tile(request[1], extent, width))
        .into_iter()
        .flatten()
}

fn scatter_range(
    index: &DiskIndex,
    job: &Job<'_>,
    x_extent: Bounds,
    y_extent: Bounds,
    x: Bounds,
    y: Bounds,
) -> Result<ChartData, DataError> {
    let mut density = ScatterTiles::default();
    let mut sample = Reservoir::new(MAX_POINTS);
    let mut count = 0;
    let tiles = candidate_tiles(y_extent, y, TILE_SIDE)
        .flat_map(|j| candidate_tiles(x_extent, x, TILE_SIDE).map(move |i| j * TILE_SIDE + i));
    index.visit_matching(
        tiles,
        job,
        |xy| contains(x, xy[0]) && contains(y, xy[1]),
        |record| {
            count += 1;
            density.add(record.xy);
            let details = record
                .details
                .ok_or_else(|| invalid("A cached scatter point is incomplete."))?;
            sample.add((record.xy, details));
            Ok(())
        },
    )?;
    let sampled = sample.sampled();
    let (points, details) = sample.values.into_iter().unzip();
    Ok(ChartData {
        total_rows: count,
        valid_rows: count,
        sampled,
        points: Some(points),
        point_details: Some(details),
        scatter_extent: Some([x[0], x[1], y[0], y[1]]),
        scatter_tiles: sampled.then(|| density.finish()),
        ..ChartData::default()
    })
}

fn line_range(
    index: &DiskIndex,
    job: &Job<'_>,
    extent: Bounds,
    x: Bounds,
) -> Result<ChartData, DataError> {
    let mut count = 0_u64;
    let mut points = Vec::new();
    let mut envelope = Envelope::new(x[0], x[1]);
    let mut sampled = false;
    index.visit(candidate_tiles(extent, x, X_TILES), job, |record| {
        if contains(x, record.xy[0]) {
            count += record.count;
            let point = LinePoint {
                row: record.row,
                xy: record.xy,
                count: record.count,
            };
            envelope.add(point);
            if points.len() < MAX_POINTS {
                points.push(point);
            } else {
                sampled = true;
            }
        }
        Ok(())
    })?;
    let buckets = envelope.buckets();
    if sampled {
        points = envelope.finish();
    } else {
        points.sort_unstable_by(LinePoint::cmp_x);
    }
    Ok(ChartData {
        total_rows: count,
        valid_rows: count,
        sampled,
        points: Some(points.into_iter().map(|point| point.xy).collect()),
        line_buckets: Some(buckets),
        ..ChartData::default()
    })
}

fn histogram_range(
    index: &DiskIndex,
    job: &Job<'_>,
    request: &ChartRequest,
    extent: Bounds,
    x: Bounds,
) -> Result<ChartData, DataError> {
    if !intersects(extent, x) {
        return Ok(empty_range(ChartKind::Histogram));
    }
    let lo = extent[0].max(x[0]);
    let hi = extent[1].min(x[1]);
    let mut count = 0_u64;
    let visit_values = |visitor: &mut dyn FnMut(f64)| {
        index.visit(candidate_tiles(extent, x, X_TILES), job, |record| {
            if contains(x, record.xy[0]) {
                visitor(record.xy[0]);
            }
            Ok(())
        })
    };
    if request.histogram.is_none() {
        visit_values(&mut |_| count += 1)?;
    }
    let mut histogram = Histogram::new(count, Some((lo, hi)), request.histogram, None)?;
    count = 0;
    visit_values(&mut |value| {
        histogram.add(value);
        count += 1;
    })?;
    Ok(ChartData {
        total_rows: count,
        valid_rows: count,
        bins: Some(histogram.finish()),
        ..ChartData::default()
    })
}

fn fixed_histogram_range(bins: &[ChartBin], x: Bounds) -> ChartData {
    let selected = bins
        .iter()
        .enumerate()
        .filter(|(i, bin)| {
            bin.start <= x[1] && (bin.end > x[0] || (*i + 1 == bins.len() && bin.end == x[0]))
        })
        .map(|(_, bin)| bin.clone())
        .collect::<Vec<_>>();
    let count = selected.iter().map(|bin| bin.count).sum();
    ChartData {
        total_rows: count,
        valid_rows: count,
        bins: Some(selected),
        ..ChartData::default()
    }
}

fn empty_range(kind: ChartKind) -> ChartData {
    ChartData {
        points: matches!(kind, ChartKind::Line | ChartKind::Scatter).then(Vec::new),
        bins: (kind == ChartKind::Histogram).then(Vec::new),
        ..ChartData::default()
    }
}
