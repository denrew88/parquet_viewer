//! Bounded chart computation over typed, projected source rows.

mod axis;
mod bar;
mod line;
mod scatter_svg;
mod statistics;

pub(crate) use scatter_svg::{ChartImageProgress, ScatterSvgFrame};

use std::{
    collections::{HashMap, HashSet, VecDeque},
    mem::size_of,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use serde::{Deserialize, Serialize};

use crate::{
    copy::CopyRowReader,
    domain::{
        CopySelectionSnapshot, DataError, DataErrorCode, DataValue, COPY_MAX_BATCH_CELLS,
        COPY_MAX_BATCH_ESTIMATED_BYTES,
    },
};

use statistics::compute_chart;

const MAX_BATCH_ROWS: usize = 4_096;
const MAX_JOBS: usize = 4;
const MAX_CANCELLED_IDS: usize = 128;
const MAX_BLOCKS: usize = 32;
const MAX_BLOCK_CELLS: u64 = 100_000;
const MAX_BLOCK_BYTES: usize = 16 * 1024 * 1024;
const MAX_STORED_BLOCK_BYTES: usize = 64 * 1024 * 1024;
const MAX_BINS: usize = 48;
const MAX_GROUPS: usize = 32;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChartSource {
    File {
        document_id: String,
        session_id: String,
        query_id: Option<String>,
    },
    Sql {
        run_id: String,
        result_id: String,
        view_id: Option<String>,
    },
    Block {
        block_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChartKind {
    Scatter,
    Violin,
    Histogram,
    Box,
    Line,
    Bar,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChartScale {
    #[default]
    Linear,
    Log,
    Log10,
    Log1p,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum HistogramOptions {
    Count { count: usize },
    Width { width: f64 },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistogramRange {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineAggregate {
    #[default]
    Raw,
    Mean,
    Sum,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineOptions {
    pub aggregate: LineAggregate,
    pub bucket_seconds: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhiskerMode {
    Iqr,
    Minmax,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarAggregate {
    Count,
    Sum,
    Mean,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarSort {
    Category,
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BarOptions {
    pub aggregate: BarAggregate,
    pub sort: BarSort,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartFilter {
    pub column_id: String,
    pub equals: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartRequest {
    pub request_id: String,
    pub source: ChartSource,
    pub kind: ChartKind,
    pub x: String,
    pub y: Option<String>,
    pub filter: Option<ChartFilter>,
    #[serde(default)]
    pub x_scale: ChartScale,
    #[serde(default)]
    pub y_scale: ChartScale,
    pub histogram: Option<HistogramOptions>,
    pub violin_bandwidth: Option<f64>,
    pub scatter_label: Option<String>,
    pub line: Option<LineOptions>,
    pub histogram_range: Option<HistogramRange>,
    pub whiskers: Option<WhiskerMode>,
    pub bar: Option<BarOptions>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub total_rows: u64,
    pub valid_rows: u64,
    pub excluded_rows: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub scale_excluded_rows: u64,
    pub filtered_rows: u64,
    pub sampled: bool,
    pub groups_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_unit: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_unit: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<[f64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scatter_extent: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_details: Option<Vec<ChartPointDetails>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bins: Option<Vec<ChartBin>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub histogram_outside: Option<HistogramOutside>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<ChartGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bar_total: Option<f64>,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartBin {
    pub start: f64,
    pub end: f64,
    pub count: u64,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramOutside {
    pub below: u64,
    pub above: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartPointDetails {
    pub row: u64,
    pub x: String,
    pub y: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartGroup {
    pub label: String,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<[f64; 5]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<Vec<[f64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whiskers: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outlier_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outliers: Option<Vec<f64>>,
}

struct Projection {
    columns: Vec<String>,
    y: Option<usize>,
    filter: Option<usize>,
    scatter_label: Option<usize>,
}

impl ChartRequest {
    fn projection(&self) -> Result<Projection, DataError> {
        self.validate_options()?;
        let y_required = matches!(
            self.kind,
            ChartKind::Scatter | ChartKind::Line | ChartKind::Violin | ChartKind::Box
        ) || self
            .bar
            .is_some_and(|bar| bar.aggregate != BarAggregate::Count);
        if (y_required && self.y.is_none())
            || (self.kind == ChartKind::Histogram && self.y.is_some())
        {
            return Err(invalid(
                "The chart requires a different set of axis columns.",
            ));
        }
        let mut columns = vec![self.x.clone()];
        let mut add = |column: &str| {
            if let Some(index) = columns.iter().position(|id| id == column) {
                index
            } else {
                columns.push(column.to_owned());
                columns.len() - 1
            }
        };
        let y = if self
            .bar
            .is_some_and(|bar| bar.aggregate == BarAggregate::Count)
        {
            None
        } else {
            self.y.as_deref().map(&mut add)
        };
        let filter = self
            .filter
            .as_ref()
            .map(|filter| add(filter.column_id.as_str()));
        let scatter_label = self.scatter_label.as_deref().map(&mut add);
        if self
            .filter
            .as_ref()
            .is_some_and(|filter| filter.equals.len() > 4_096)
        {
            return Err(invalid(
                "A chart filter value can contain at most 4096 bytes.",
            ));
        }
        validate_columns(&columns)?;
        Ok(Projection {
            columns,
            y,
            filter,
            scatter_label,
        })
    }

    fn validate_options(&self) -> Result<(), DataError> {
        if self.scatter_label.is_some() && self.kind != ChartKind::Scatter {
            return Err(invalid("Point labels apply only to scatter charts."));
        }
        if let Some(line) = self.line {
            if self.kind != ChartKind::Line {
                return Err(invalid("Line aggregation applies only to line charts."));
            }
            if let Some(seconds) = line.bucket_seconds {
                if line.aggregate == LineAggregate::Raw || self.x_scale != ChartScale::Linear {
                    return Err(invalid(
                        "Time buckets require an aggregated line with a linear X axis.",
                    ));
                }
                axis::bucket_nanoseconds(seconds)?;
            }
        }
        if let Some(range) = self.histogram_range {
            if self.kind != ChartKind::Histogram {
                return Err(invalid(
                    "A fixed histogram range applies only to histograms.",
                ));
            }
            if !range.min.is_finite() || !range.max.is_finite() || range.min >= range.max {
                return Err(invalid(
                    "The histogram range must have finite bounds with minimum below maximum.",
                ));
            }
        }
        if self.whiskers.is_some() && self.kind != ChartKind::Box {
            return Err(invalid("Whisker options apply only to box plots."));
        }
        if let Some(bar) = self.bar {
            if self.kind != ChartKind::Bar {
                return Err(invalid("Bar options apply only to bar charts."));
            }
            if !(1..=MAX_GROUPS).contains(&bar.limit) {
                return Err(invalid("Bar chart limit must be from 1 to 32."));
            }
        }
        let x_supported = matches!(
            self.kind,
            ChartKind::Scatter | ChartKind::Line | ChartKind::Histogram
        );
        let y_supported = matches!(
            self.kind,
            ChartKind::Scatter | ChartKind::Line | ChartKind::Violin | ChartKind::Box
        );
        if (!x_supported && self.x_scale != ChartScale::Linear)
            || (!y_supported && self.y_scale != ChartScale::Linear)
        {
            return Err(invalid(
                "A logarithmic scale is unavailable for this chart axis.",
            ));
        }
        if let Some(histogram) = self.histogram {
            if self.kind != ChartKind::Histogram {
                return Err(invalid("Bin options apply only to histograms."));
            }
            match histogram {
                HistogramOptions::Count { count } if !(1..=MAX_BINS).contains(&count) => {
                    return Err(invalid("Histogram bin count must be from 1 to 48."));
                }
                HistogramOptions::Width { width } if !width.is_finite() || width <= 0.0 => {
                    return Err(invalid("Histogram bin width must be finite and positive."));
                }
                _ => {}
            }
        }
        if let Some(bandwidth) = self.violin_bandwidth {
            if self.kind != ChartKind::Violin {
                return Err(invalid("Bandwidth applies only to violin charts."));
            }
            if !(0.25..=4.0).contains(&bandwidth) {
                return Err(invalid(
                    "Violin bandwidth multiplier must be from 0.25 to 4.",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct ChartStore {
    state: Mutex<StoreState>,
}

#[derive(Default)]
struct StoreState {
    jobs: HashMap<String, Arc<AtomicBool>>,
    cancelled_ids: VecDeque<String>,
    blocks: HashMap<String, Arc<Block>>,
    block_bytes: usize,
    closed: bool,
}

struct Block {
    columns: Vec<String>,
    rows: Vec<Vec<DataValue>>,
    bytes: usize,
    row_start: u64,
}

pub(crate) struct Job<'a> {
    store: &'a ChartStore,
    id: &'a str,
    cancelled: Arc<AtomicBool>,
}

impl Job<'_> {
    pub(crate) fn check(&self) -> Result<(), DataError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(DataError::task_cancelled())
        } else {
            Ok(())
        }
    }
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.store.state.lock() {
            state.jobs.remove(self.id);
        }
    }
}

impl ChartStore {
    pub fn capture(
        &self,
        request_id: &str,
        reader: Arc<dyn CopyRowReader>,
        selection: &CopySelectionSnapshot,
    ) -> Result<(), DataError> {
        let row_count = selection
            .row_end_exclusive
            .saturating_sub(selection.row_start);
        let column_count = selection.column_ids.len();
        if row_count == 0
            || column_count == 0
            || column_count > 64
            || row_count.saturating_mul(column_count as u64) > MAX_BLOCK_CELLS
        {
            return Err(invalid(
                "A chart selection must contain 1–100,000 cells and at most 64 columns.",
            ));
        }
        validate_columns(&selection.column_ids)?;
        let job = self.begin(request_id, true)?;
        let mut rows = Vec::new();
        let mut bytes = selection.column_ids.iter().map(String::len).sum::<usize>();
        visit_live(
            reader.as_ref(),
            &selection.column_ids,
            selection.row_start,
            Some(selection.row_end_exclusive),
            &job,
            |row| {
                bytes = bytes.saturating_add(row_bytes(&row));
                if bytes > MAX_BLOCK_BYTES {
                    return Err(invalid(
                        "A chart selection exceeds the 16 MiB snapshot limit.",
                    ));
                }
                rows.push(row);
                Ok(())
            },
        )?;
        if rows.len() as u64 != row_count {
            return Err(invalid("The selected chart range is no longer available."));
        }
        let mut state = self.lock()?;
        job.check()?;
        if state.blocks.len() >= MAX_BLOCKS
            || state.block_bytes.saturating_add(bytes) > MAX_STORED_BLOCK_BYTES
        {
            return Err(invalid(
                "The chart selection storage is full. Remove another selected-range chart.",
            ));
        }
        state.block_bytes += bytes;
        state.blocks.insert(
            request_id.to_owned(),
            Arc::new(Block {
                columns: selection.column_ids.clone(),
                rows,
                bytes,
                row_start: selection.row_start,
            }),
        );
        Ok(())
    }

    pub fn compute(
        &self,
        request: &ChartRequest,
        reader: Option<Arc<dyn CopyRowReader>>,
    ) -> Result<ChartData, DataError> {
        let projection = request.projection()?;
        let job = self.begin(&request.request_id, false)?;
        let input = self.input(&request.source, &projection, reader)?;
        let output = compute_chart(request, &projection, &input, &job)?;
        job.check()?;
        Ok(output)
    }

    fn input(
        &self,
        source: &ChartSource,
        projection: &Projection,
        reader: Option<Arc<dyn CopyRowReader>>,
    ) -> Result<Input, DataError> {
        match source {
            ChartSource::Block { block_id } => {
                validate_id(block_id)?;
                let block =
                    self.lock()?.blocks.get(block_id).cloned().ok_or_else(|| {
                        invalid("The selected chart range is no longer available.")
                    })?;
                let indices = projection
                    .columns
                    .iter()
                    .map(|column| {
                        block
                            .columns
                            .iter()
                            .position(|name| name == column)
                            .ok_or_else(|| invalid("A chart column is outside the selected range."))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(Input::Block { block, indices })
            }
            ChartSource::File { .. } | ChartSource::Sql { .. } => reader
                .map(Input::Live)
                .ok_or_else(|| invalid("The chart source is unavailable.")),
        }
    }

    pub fn release(&self, block_id: &str) -> Result<(), DataError> {
        validate_id(block_id)?;
        let mut state = self.lock()?;
        if let Some(block) = state.blocks.remove(block_id) {
            state.block_bytes -= block.bytes;
        } else {
            state.mark_cancelled(block_id);
        }
        Ok(())
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), DataError> {
        validate_id(request_id)?;
        self.lock()?.mark_cancelled(request_id);
        Ok(())
    }

    pub fn cancel_all(&self) {
        if let Ok(mut state) = self.lock() {
            state.closed = true;
            for job in state.jobs.values() {
                job.store(true, Ordering::Release);
            }
            state.blocks.clear();
            state.block_bytes = 0;
        }
    }

    fn begin<'a>(&'a self, id: &'a str, capture: bool) -> Result<Job<'a>, DataError> {
        validate_id(id)?;
        let mut state = self.lock()?;
        if state.closed {
            return Err(DataError::task_cancelled());
        }
        if let Some(index) = state.cancelled_ids.iter().position(|item| item == id) {
            state.cancelled_ids.remove(index);
            return Err(DataError::task_cancelled());
        }
        if state.jobs.contains_key(id) || (capture && state.blocks.contains_key(id)) {
            return Err(invalid("The chart operation ID is already in use."));
        }
        if state.jobs.len() >= MAX_JOBS {
            return Err(invalid(
                "Too many chart operations are running. Try again shortly.",
            ));
        }
        if capture
            && (state.blocks.len() >= MAX_BLOCKS || state.block_bytes >= MAX_STORED_BLOCK_BYTES)
        {
            return Err(invalid(
                "The chart selection storage is full. Remove another selected-range chart.",
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.jobs.insert(id.to_owned(), Arc::clone(&cancelled));
        Ok(Job {
            store: self,
            id,
            cancelled,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, StoreState>, DataError> {
        self.state.lock().map_err(|_| DataError {
            code: DataErrorCode::Io,
            message: "The chart registry is unavailable.".to_owned(),
        })
    }
}

impl StoreState {
    fn mark_cancelled(&mut self, id: &str) {
        if let Some(job) = self.jobs.get(id) {
            job.store(true, Ordering::Release);
        } else if !self.cancelled_ids.iter().any(|pending| pending == id) {
            if self.cancelled_ids.len() == MAX_CANCELLED_IDS {
                self.cancelled_ids.pop_front();
            }
            self.cancelled_ids.push_back(id.to_owned());
        }
    }
}

enum Input {
    Live(Arc<dyn CopyRowReader>),
    Block {
        block: Arc<Block>,
        indices: Vec<usize>,
    },
}

impl Input {
    fn row_start(&self) -> u64 {
        match self {
            Self::Live(_) => 0,
            Self::Block { block, .. } => block.row_start,
        }
    }

    fn visit(
        &self,
        columns: &[String],
        job: &Job<'_>,
        mut visit: impl FnMut(&[DataValue], &[usize]) -> Result<(), DataError>,
    ) -> Result<(), DataError> {
        match self {
            Self::Live(reader) => {
                let indices = (0..columns.len()).collect::<Vec<_>>();
                visit_live(reader.as_ref(), columns, 0, None, job, |row| {
                    visit(&row, &indices)
                })
            }
            Self::Block { block, indices } => {
                for rows in block.rows.chunks(MAX_BATCH_ROWS) {
                    job.check()?;
                    for row in rows {
                        visit(row, indices)?;
                    }
                }
                Ok(())
            }
        }
    }
}

fn visit_live(
    reader: &dyn CopyRowReader,
    columns: &[String],
    mut offset: u64,
    end: Option<u64>,
    job: &Job<'_>,
    mut visit: impl FnMut(Vec<DataValue>) -> Result<(), DataError>,
) -> Result<(), DataError> {
    let max_rows = MAX_BATCH_ROWS.min(COPY_MAX_BATCH_CELLS / columns.len());
    // Probe the projected row width before asking the provider for large batches.
    let mut batch_rows = max_rows.min(16);
    loop {
        job.check()?;
        let limit = end.map_or(batch_rows, |end| {
            end.saturating_sub(offset).min(batch_rows as u64) as usize
        });
        if limit == 0 {
            break;
        }
        let page = reader.read_rows(offset, limit, columns)?;
        job.check()?;
        if page.offset != offset || page.columns != columns || page.rows.len() > limit {
            return Err(invalid("The chart source returned an inconsistent page."));
        }
        if page.rows.is_empty() && page.has_more {
            return Err(invalid(
                "The chart source could not advance to the next row.",
            ));
        }
        let next = offset
            .checked_add(page.rows.len() as u64)
            .ok_or_else(|| invalid("The chart source row range is too large."))?;
        let mut observed_bytes = 0_usize;
        for row in &page.rows {
            if row.len() != columns.len() {
                return Err(invalid(
                    "The chart source returned an inconsistent projection.",
                ));
            }
            observed_bytes = observed_bytes.saturating_add(row_bytes(row));
        }
        if observed_bytes > COPY_MAX_BATCH_ESTIMATED_BYTES {
            if limit == 1 {
                return Err(invalid(
                    "A chart source row exceeds the 8 MiB read limit. Choose fewer columns.",
                ));
            }
            batch_rows = (limit / 2).max(1);
            continue;
        }
        if !page.rows.is_empty() {
            let observed_row_bytes = observed_bytes.div_ceil(page.rows.len()).max(1);
            batch_rows = (COPY_MAX_BATCH_ESTIMATED_BYTES / observed_row_bytes)
                .clamp(1, max_rows)
                .min(batch_rows * 4);
        }
        for row in page.rows {
            visit(row)?;
        }
        offset = next;
        if !page.has_more {
            break;
        }
    }
    reader.validate_current()?;
    job.check()
}

fn row_bytes(row: &[DataValue]) -> usize {
    let strings = row.iter().map(|value| {
        [
            &value.display,
            &value.source_display,
            &value.raw_display,
            &value.unit,
            &value.timezone,
        ]
        .into_iter()
        .flatten()
        .map(String::capacity)
        .sum::<usize>()
            + value.diagnostic.as_ref().map_or(0, |diagnostic| {
                diagnostic.code.capacity() + diagnostic.message.capacity()
            })
    });
    size_of::<Vec<DataValue>>() + size_of_val(row) + strings.sum::<usize>()
}

fn validate_id(id: &str) -> Result<(), DataError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(invalid("Invalid chart operation ID."));
    }
    Ok(())
}

fn validate_columns(columns: &[String]) -> Result<(), DataError> {
    let mut seen = HashSet::new();
    if columns
        .iter()
        .any(|column| column.trim().is_empty() || column.len() > 4_096 || !seen.insert(column))
    {
        return Err(invalid("Invalid or duplicate chart column."));
    }
    Ok(())
}

fn invalid(message: &str) -> DataError {
    DataError::invalid_request(message)
}

#[cfg(test)]
mod tests;
