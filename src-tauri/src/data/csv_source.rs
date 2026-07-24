use crate::domain::{
    BoundarySearchRequest, BoundarySearchResult, ColumnSchema, CsvColumnInference,
    CsvColumnValidation, CsvHeaderIssue, CsvHeaderIssueReason, CsvMetadata, CsvParsingProfile,
    CsvPreviewCell, CsvPreviewColumn, CsvPreviewRow, CsvPreviewStage, CsvProfileMode,
    CsvProfilePreview, CsvStructureIssue, CsvTargetType, CsvValidationErrorSample,
    DataBoundaryDirection, DataBoundaryMode, DataError, DataFormat, DataPage, DataValue,
    DataValueState, FileSummary, FormatDescriptor, FormatDetailsContent, FormatDetailsSection,
    HeaderMode, MetadataEntry, RowCountState, RowCountStatus, SourceCapability, ValueKind,
};
use arrow_array::{
    builder::{BooleanBuilder, Float64Builder, Int64Builder, StringBuilder, UInt64Builder},
    Array, ArrayRef, RecordBatch,
};
use arrow_schema::{DataType, Field, Schema};
use csv::{ByteRecord, Position, Reader, ReaderBuilder};
use parquet::{
    arrow::ArrowWriter,
    basic::{Compression, ZstdLevel},
    file::properties::WriterProperties,
};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(test)]
use std::time::Instant;

use super::csv_prepare::{
    classify_csv_preparation, CsvDialectSnapshot, CsvEligibilityDecision, CsvEligibilityInput,
    CsvInvalidReason,
};
use super::csv_profile::{
    convert_value, convert_value_for_query, default_profile, infer_columns, normalize_profile,
    resolved_type, validate_resolved_profile,
};
use super::{
    cell_state_bitmap::CellStateBitmap, CsvHeaderConfigurable, CsvPreparedPhysicalColumn,
    CsvProfileConfigurable, CsvQuerySpec, CsvValidationProgress, FormatHandler, QueryExactValues,
    QueryInputProvider, QueryPreparationMetrics, QueryPrepareContext, QuerySourceSpec,
    TabularSource,
};

pub const MAX_PAGE_SIZE: usize = 200;
pub const MAX_COLUMNS: usize = 4_096;
pub const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_PROFILE_SAMPLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_INITIAL_INFERENCE_RECORDS: usize = 10_000;
const MAX_INITIAL_INFERENCE_DECODED_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALIDATION_SAMPLE_CHARS: usize = 256;
pub const MAX_RECORD_BYTES: u64 = 8 * 1024 * 1024;
pub const CHECKPOINT_INTERVAL: u64 = 4_096;
pub const MAX_CHECKPOINTS: usize = 4_096;
pub const MAX_CONCURRENT_INDEX_WORKERS: usize = 4;
const MAX_STRUCTURE_ISSUES: usize = 100;
const MAX_HEADER_AUDIT_ITEMS: usize = 100;
const MAX_HEADER_AUDIT_CHARS: usize = 256;
const BOUNDARY_CANCEL_INTERVAL: u64 = 4_096;
const MAX_BOUNDARY_CACHE_ENTRIES: usize = 128;
const PREPARATION_COORDINATOR_FILE_THRESHOLD: u64 = 64 * 1024 * 1024;
const PREPARED_BATCH_INITIAL_ROWS: usize = 16_384;
const PREPARED_BATCH_MAX_ROWS: usize = 65_536;
const PREPARED_BATCH_ESTIMATED_BYTES: usize = 24 * 1024 * 1024;
const PREPARED_BATCH_HARD_BYTES: usize = 64 * 1024 * 1024;
const PREPARED_BATCH_GROW_BYTES: usize = 12 * 1024 * 1024;

pub const CSV_FORMAT_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    id: DataFormat::Csv,
    display_name: "CSV",
    extensions: &["csv"],
    mime_types: &["text/csv"],
    capabilities: &[
        SourceCapability::ColumnProjection,
        SourceCapability::QueryProvider,
        SourceCapability::ParsingProfile,
        SourceCapability::BackgroundRowCount,
    ],
};

#[derive(Debug)]
pub(crate) struct CsvFormatHandler;

pub(crate) static CSV_FORMAT_HANDLER: CsvFormatHandler = CsvFormatHandler;

impl FormatHandler for CsvFormatHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &CSV_FORMAT_DESCRIPTOR
    }

    fn open(&self, path: &Path) -> Result<Box<dyn TabularSource>, DataError> {
        CsvSource::open(path, HeaderMode::Auto)
            .map(|source| Box::new(source) as Box<dyn TabularSource>)
    }
}

#[derive(Debug, Clone)]
struct Checkpoint {
    row: u64,
    position: Position,
}

#[derive(Debug)]
struct IndexState {
    status: RowCountStatus,
    checkpoints: Vec<Checkpoint>,
    structure_issue_count: u64,
    structure_issues: Vec<CsvStructureIssue>,
    max_columns: usize,
}

#[derive(Debug, Default)]
struct WorkerLimiter {
    active: Mutex<usize>,
    changed: Condvar,
}

struct WorkerPermit(&'static WorkerLimiter);

impl Drop for WorkerPermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.changed.notify_one();
        }
    }
}

fn acquire_worker_permit(cancel: &AtomicBool) -> Option<WorkerPermit> {
    static LIMITER: OnceLock<WorkerLimiter> = OnceLock::new();
    let limiter = LIMITER.get_or_init(WorkerLimiter::default);
    let mut active = limiter.active.lock().ok()?;
    loop {
        if cancel.load(Ordering::Acquire) {
            return None;
        }
        if *active < MAX_CONCURRENT_INDEX_WORKERS {
            *active += 1;
            return Some(WorkerPermit(limiter));
        }
        let (next, _) = limiter
            .changed
            .wait_timeout(active, Duration::from_millis(25))
            .ok()?;
        active = next;
    }
}

#[derive(Debug)]
pub struct CsvSource {
    path: PathBuf,
    file_name: String,
    file_size: u64,
    header_mode: HeaderMode,
    suggested_header: Option<bool>,
    header_used: bool,
    header_values: Vec<String>,
    preview_max_columns: usize,
    profile: CsvParsingProfile,
    inferences: Vec<CsvColumnInference>,
    generation: u64,
    state: Arc<Mutex<IndexState>>,
    cancel: Arc<AtomicBool>,
    preparation_takeover: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    boundary_cache: Mutex<VecDeque<(BoundaryCacheKey, BoundarySearchResult)>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BoundaryCacheKey {
    row: u64,
    column_id: String,
    visible_column_ids: Vec<String>,
    direction: DataBoundaryDirection,
    mode: DataBoundaryMode,
}

impl From<&BoundarySearchRequest> for BoundaryCacheKey {
    fn from(request: &BoundarySearchRequest) -> Self {
        Self {
            row: request.row,
            column_id: request.column_id.clone(),
            visible_column_ids: request.visible_column_ids.clone(),
            direction: request.direction,
            mode: request.mode,
        }
    }
}

impl CsvSource {
    pub fn open(path: impl AsRef<Path>, header_mode: HeaderMode) -> Result<Self, DataError> {
        Self::open_generation(path.as_ref(), header_mode, 1)
    }

    fn open_generation(
        path: &Path,
        header_mode: HeaderMode,
        generation: u64,
    ) -> Result<Self, DataError> {
        let metadata = fs::metadata(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DataError::file_not_found(path)
            } else {
                DataError::io(path, error)
            }
        })?;
        if !metadata.is_file() {
            return Err(DataError::io(path, "path does not identify a regular file"));
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("csv")
        {
            return Err(DataError::unsupported_format(path));
        }
        validate_bom(path)?;

        let preview = scan_preview(path, header_mode)?;
        let suggested_header = preview.suggested_header;
        let header_used = preview.header_used;
        let header_values = if header_used {
            preview.records.first().cloned().unwrap_or_default()
        } else {
            Vec::new()
        };
        let preview_max_columns = preview
            .records
            .iter()
            .skip(usize::from(header_used))
            .map(Vec::len)
            .max()
            .unwrap_or(header_values.len());
        let schema_columns = header_values.len().max(preview_max_columns);
        let expected_columns = if header_used {
            header_values.len()
        } else {
            preview.records.first().map(Vec::len).unwrap_or(0)
        };
        if schema_columns > MAX_COLUMNS {
            return Err(DataError::csv_limit_exceeded(
                path,
                format!("record has {schema_columns} columns; maximum is {MAX_COLUMNS}"),
            ));
        }
        let (initial_columns, _) = build_columns(&header_values, schema_columns);
        let sample_rows = &preview.records[usize::from(header_used)..];
        let inferences = infer_columns(&initial_columns, sample_rows);
        let profile = default_profile(CsvProfileMode::Auto, generation, &initial_columns);

        let initial_status = RowCountStatus {
            state: RowCountState::Calculating,
            rows_scanned: 0,
            bytes_scanned: 0,
            total_bytes: metadata.len(),
            generation,
            message: None,
        };
        let state = Arc::new(Mutex::new(IndexState {
            status: initial_status,
            checkpoints: Vec::new(),
            structure_issue_count: 0,
            structure_issues: Vec::new(),
            max_columns: schema_columns,
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        let preparation_takeover = Arc::new(AtomicBool::new(false));
        let worker = (metadata.len() < PREPARATION_COORDINATOR_FILE_THRESHOLD).then(|| {
            spawn_index_worker(
                path.to_path_buf(),
                header_used,
                expected_columns,
                generation,
                Arc::clone(&state),
                Arc::clone(&cancel),
                Arc::clone(&preparation_takeover),
            )
        });

        Ok(Self {
            path: path.to_path_buf(),
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            file_size: metadata.len(),
            header_mode,
            suggested_header,
            header_used,
            header_values,
            preview_max_columns,
            profile,
            inferences,
            generation,
            state,
            cancel,
            preparation_takeover,
            worker,
            boundary_cache: Mutex::new(VecDeque::new()),
        })
    }

    fn raw_summary(&self) -> FileSummary {
        let state = self.state.lock().expect("CSV index state poisoned");
        let column_count = state
            .max_columns
            .max(self.preview_max_columns)
            .max(self.header_values.len());
        let row_count =
            (state.status.state == RowCountState::Complete).then_some(state.status.rows_scanned);
        let (columns, header_audit) = build_columns(&self.header_values, column_count);
        let csv_metadata = CsvMetadata {
            delimiter: String::from(","),
            encoding: if has_utf8_bom(&self.path) {
                String::from("utf-8-bom")
            } else {
                String::from("utf-8")
            },
            header_mode: self.header_mode,
            suggested_header: self.suggested_header,
            header_used: self.header_used,
            structure_issue_count: state.structure_issue_count,
            structure_issues: state.structure_issues.clone(),
            raw_header_count: self.header_values.len(),
            raw_headers: header_audit.raw_headers,
            raw_headers_truncated: header_audit.raw_headers_truncated,
            header_issue_count: header_audit.header_issue_count,
            header_issues: header_audit.header_issues,
        };
        let format_details = csv_format_details(&csv_metadata);
        FileSummary {
            file_name: self.file_name.clone(),
            path: self.path.to_string_lossy().into_owned(),
            format: DataFormat::Csv,
            format_descriptor: CSV_FORMAT_DESCRIPTOR,
            file_size: self.file_size,
            row_count,
            row_count_status: state.status.clone(),
            column_count,
            row_group_count: 0,
            columns,
            row_groups: Vec::new(),
            csv_metadata: Some(csv_metadata),
            format_details,
        }
    }

    pub fn summary(&self) -> FileSummary {
        let mut summary = self.raw_summary();
        let (profile, inferences) = self.effective_profile_and_inferences(&summary.columns);
        let mut columns = Vec::new();
        for (column, inference) in profile.columns.iter().zip(&inferences) {
            let target = resolved_type(profile.mode, column, inference);
            if target == CsvTargetType::Skip {
                continue;
            }
            let raw = &summary.columns[column.source_index];
            columns.push(ColumnSchema {
                name: raw.name.clone(),
                logical_type: csv_logical_type(target, column),
                nullable: !column.null_tokens.is_empty()
                    || matches!(
                        column.failure_policy,
                        crate::domain::CsvConversionFailurePolicy::AsNull
                    ),
                physical_type: raw.physical_type.clone(),
            });
        }
        summary.column_count = columns.len();
        summary.columns = columns;
        if let Some(FormatDetailsSection {
            content: FormatDetailsContent::KeyValue { entries },
            ..
        }) = summary.format_details.first_mut()
        {
            entries.push(MetadataEntry {
                label: String::from("Profile mode"),
                value: format!("{:?}", profile.mode),
            });
        }
        summary
    }

    pub fn active_profile(&self) -> CsvParsingProfile {
        let raw = self.raw_summary();
        self.effective_profile_and_inferences(&raw.columns).0
    }

    pub fn preview_profile(
        &self,
        profile: &CsvParsingProfile,
        generation: u64,
        cancel: &AtomicBool,
    ) -> Result<CsvProfilePreview, DataError> {
        if generation != profile.generation {
            return Err(DataError::invalid_request(
                "Preview generation must match the CSV profile generation.",
            ));
        }
        let raw_summary = self.raw_summary();
        let profile = normalize_profile(profile, &raw_summary.columns)?;
        let mut sampled = Vec::new();
        for offset in [0_u64, 200] {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let page = self.raw_read_page_projected(offset, 200, None)?;
            sampled.extend(
                page.rows
                    .into_iter()
                    .enumerate()
                    .map(|(index, row)| (offset.saturating_add(index as u64), row)),
            );
            if !page.has_more {
                break;
            }
        }
        let mut stage = CsvPreviewStage::Leading;
        if let Some(total_rows) = raw_summary.row_count {
            stage = CsvPreviewStage::Distributed;
            let count = total_rows.min(600);
            if count == 1 {
                self.push_sample_row(0, &mut sampled)?;
            } else if count > 1 {
                for index in 0..count {
                    if cancel.load(Ordering::Acquire) {
                        return Err(DataError::task_cancelled());
                    }
                    let row = index.saturating_mul(total_rows.saturating_sub(1))
                        / count.saturating_sub(1);
                    self.push_sample_row(row, &mut sampled)?;
                }
            }
        }
        sampled.sort_by_key(|(row, _)| *row);
        sampled.dedup_by_key(|(row, _)| *row);
        sampled.truncate(1_000);
        let mut sample_bytes = 0_usize;
        sampled.retain(|(_, row)| {
            let row_bytes = row
                .iter()
                .map(|value| value.display.as_ref().map_or(0, String::len))
                .sum::<usize>();
            let keep = sample_bytes.saturating_add(row_bytes) <= MAX_PROFILE_SAMPLE_BYTES;
            if keep {
                sample_bytes = sample_bytes.saturating_add(row_bytes);
            }
            keep
        });

        let raw_rows = sampled
            .iter()
            .map(|(_, row)| raw_strings(row))
            .collect::<Vec<_>>();
        let inferences = infer_columns(&raw_summary.columns, &raw_rows);
        validate_resolved_profile(&profile, &inferences)?;
        let mut columns = profile
            .columns
            .iter()
            .zip(&inferences)
            .map(|(column, inference)| CsvPreviewColumn {
                source_index: column.source_index,
                source_name: column.source_name.clone(),
                recommended_type: inference.recommended_type,
                confidence: inference.confidence,
                target_type: resolved_type(profile.mode, column, inference),
                success_count: 0,
                null_count: 0,
                invalid_count: 0,
            })
            .collect::<Vec<_>>();
        let rows = sampled
            .into_iter()
            .map(|(source_row, raw_row)| {
                let cells = raw_strings(&raw_row)
                    .into_iter()
                    .take(profile.columns.len())
                    .enumerate()
                    .map(|(index, raw)| {
                        let target = resolved_type(
                            profile.mode,
                            &profile.columns[index],
                            &inferences[index],
                        );
                        let converted = convert_value(&raw, target, &profile.columns[index]);
                        match converted.state {
                            DataValueState::Null => columns[index].null_count += 1,
                            DataValueState::Invalid => columns[index].invalid_count += 1,
                            DataValueState::Valid | DataValueState::Empty => {
                                columns[index].success_count += 1;
                            }
                        }
                        CsvPreviewCell { raw, converted }
                    })
                    .collect();
                CsvPreviewRow { source_row, cells }
            })
            .collect();
        Ok(CsvProfilePreview {
            generation,
            stage,
            profile,
            columns,
            rows,
        })
    }

    pub fn validate_profile(
        &self,
        profile: &CsvParsingProfile,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64, Option<u64>, &[CsvColumnValidation]),
    ) -> Result<Vec<CsvColumnValidation>, DataError> {
        let raw_summary = self.raw_summary();
        let profile = normalize_profile(profile, &raw_summary.columns)?;
        let (_, inferences) = self.effective_profile_and_inferences(&raw_summary.columns);
        validate_resolved_profile(&profile, &inferences)?;
        let mut columns = profile
            .columns
            .iter()
            .map(|column| CsvColumnValidation {
                source_index: column.source_index,
                source_name: column.source_name.clone(),
                success_count: 0,
                null_count: 0,
                invalid_count: 0,
                first_error_row: None,
                error_samples: Vec::new(),
            })
            .collect::<Vec<_>>();
        let mut offset = 0_u64;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let page = self.raw_read_page_projected(offset, MAX_PAGE_SIZE, None)?;
            for (row_offset, row) in page.rows.iter().enumerate() {
                if row.len() != profile.columns.len() {
                    return Err(DataError::invalid_request(
                        "CSV schema changed while the parsing profile was being validated.",
                    ));
                }
                let source_row = offset.saturating_add(row_offset as u64);
                for (index, raw) in raw_strings(row).into_iter().enumerate() {
                    let target =
                        resolved_type(profile.mode, &profile.columns[index], &inferences[index]);
                    let converted = convert_value(&raw, target, &profile.columns[index]);
                    match converted.state {
                        DataValueState::Null => columns[index].null_count += 1,
                        DataValueState::Invalid => {
                            columns[index].invalid_count += 1;
                            columns[index].first_error_row.get_or_insert(source_row);
                            if columns[index].error_samples.len() < 20 {
                                columns[index].error_samples.push(CsvValidationErrorSample {
                                    source_row,
                                    raw: truncate_chars(&raw, MAX_VALIDATION_SAMPLE_CHARS),
                                    message: converted.diagnostic.as_ref().map_or_else(
                                        || String::from("Conversion failed."),
                                        |error| error.message.clone(),
                                    ),
                                });
                            }
                        }
                        DataValueState::Valid | DataValueState::Empty => {
                            columns[index].success_count += 1
                        }
                    }
                }
            }
            offset = offset.saturating_add(page.rows.len() as u64);
            progress(offset, raw_summary.row_count, &columns);
            if !page.has_more || page.rows.is_empty() {
                break;
            }
        }
        Ok(columns)
    }

    pub fn prepare_profile(&self, profile: &CsvParsingProfile) -> Result<Self, DataError> {
        let mut replacement = Self::open_generation(
            &self.path,
            self.header_mode,
            self.generation.saturating_add(1),
        )?;
        let raw_summary = replacement.raw_summary();
        replacement.profile = normalize_profile(profile, &raw_summary.columns)?;
        let cancel = AtomicBool::new(false);
        let validation =
            replacement.validate_profile(&replacement.profile, &cancel, |_, _, _| {})?;
        let fail_columns = replacement
            .profile
            .columns
            .iter()
            .zip(&validation)
            .filter(|(profile, validation)| {
                profile.failure_policy == crate::domain::CsvConversionFailurePolicy::Fail
                    && validation.invalid_count > 0
            })
            .map(|(_, validation)| validation.source_name.as_str())
            .collect::<Vec<_>>();
        if !fail_columns.is_empty() {
            return Err(DataError::invalid_request(format!(
                "CSV profile conversion failed for columns: {}",
                fail_columns.join(", ")
            )));
        }
        Ok(replacement)
    }

    #[cfg(test)]
    pub fn configure_header(&mut self, mode: HeaderMode) -> Result<(), DataError> {
        if self.header_mode == mode {
            return Ok(());
        }
        let replacement =
            Self::open_generation(&self.path, mode, self.generation.saturating_add(1))?;
        self.shutdown_worker();
        *self = replacement;
        Ok(())
    }

    pub fn prepare_header(&self, mode: HeaderMode) -> Result<Option<Self>, DataError> {
        if self.header_mode == mode {
            return Ok(None);
        }
        Self::open_generation(&self.path, mode, self.generation.saturating_add(1)).map(Some)
    }

    pub fn cancel_index(&self, generation: u64) -> Result<FileSummary, DataError> {
        if generation != self.generation {
            return Err(DataError::invalid_request(
                "CSV task generation does not match the active generation.",
            ));
        }
        self.cancel.store(true, Ordering::Release);
        let mut state = self
            .state
            .lock()
            .map_err(|_| DataError::io(&self.path, "CSV index state is unavailable"))?;
        if state.status.state == RowCountState::Calculating {
            state.status.state = RowCountState::Cancelled;
            state.status.message = Some(String::from("CSV indexing was cancelled."));
        }
        drop(state);
        Ok(self.summary())
    }

    fn raw_read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        requested: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        self.raw_read_projected_bounded(offset, limit, requested, MAX_PAGE_SIZE)
    }

    fn raw_read_projected_bounded(
        &self,
        offset: u64,
        limit: usize,
        requested: Option<&[String]>,
        max_limit: usize,
    ) -> Result<DataPage, DataError> {
        if !(1..=max_limit).contains(&limit) {
            return Err(DataError::invalid_request(format!(
                "CSV projected read limit must be between 1 and {max_limit} rows."
            )));
        }
        let summary = self.raw_summary();
        let selected = projection_indices(&summary.columns, requested)?;
        let columns = selected
            .iter()
            .map(|index| summary.columns[*index].name.clone())
            .collect::<Vec<_>>();
        let checkpoint = {
            let state = self
                .state
                .lock()
                .map_err(|_| DataError::io(&self.path, "CSV index state is unavailable"))?;
            state
                .checkpoints
                .iter()
                .rev()
                .find(|checkpoint| checkpoint.row <= offset)
                .cloned()
        };
        let (mut reader, mut current_row) = reader_at(&self.path, checkpoint.as_ref())?;
        if checkpoint.is_none() && self.header_used {
            let mut header = ByteRecord::new();
            read_record_checked(&self.path, &mut reader, &mut header)?;
        }
        let mut record = ByteRecord::new();
        while current_row < offset {
            if !read_record_checked(&self.path, &mut reader, &mut record)? {
                break;
            }
            current_row += 1;
        }
        let mut rows = Vec::with_capacity(limit);
        while rows.len() < limit && read_record_checked(&self.path, &mut reader, &mut record)? {
            let decoded = decode_record(&self.path, &record, reader.position().byte())?;
            if decoded.len() > MAX_COLUMNS {
                return Err(DataError::csv_limit_exceeded(
                    &self.path,
                    format!(
                        "record has {} columns; maximum is {MAX_COLUMNS}",
                        decoded.len()
                    ),
                ));
            }
            rows.push(
                selected
                    .iter()
                    .map(|index| {
                        DataValue::displayed(
                            ValueKind::String,
                            decoded.get(*index).cloned().unwrap_or_default(),
                        )
                    })
                    .collect(),
            );
        }
        let total_rows = summary.row_count;
        let has_more = total_rows.map_or(rows.len() == limit, |total| {
            offset.saturating_add(rows.len() as u64) < total
        });
        Ok(DataPage {
            offset,
            limit,
            total_rows,
            has_more,
            columns,
            rows,
        })
    }

    pub fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        requested: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        self.read_projected_bounded(
            offset,
            limit,
            requested,
            MAX_PAGE_SIZE,
            MAX_PROJECTION_COLUMNS,
        )
    }

    fn read_projected_bounded(
        &self,
        offset: u64,
        limit: usize,
        requested: Option<&[String]>,
        max_limit: usize,
        max_columns: usize,
    ) -> Result<DataPage, DataError> {
        let raw_summary = self.raw_summary();
        let (profile, inferences) = self.effective_profile_and_inferences(&raw_summary.columns);
        let visible = profile
            .columns
            .iter()
            .zip(&inferences)
            .filter(|(column, inference)| {
                resolved_type(profile.mode, column, inference) != CsvTargetType::Skip
            })
            .collect::<Vec<_>>();
        let visible_schema = visible
            .iter()
            .map(|(column, _)| raw_summary.columns[column.source_index].clone())
            .collect::<Vec<_>>();
        let selected = projection_indices_bounded(&visible_schema, requested, max_columns)?;
        let selected_profiles = selected
            .iter()
            .map(|index| visible[*index])
            .collect::<Vec<_>>();
        let raw_names = selected_profiles
            .iter()
            .map(|(column, _)| column.source_name.clone())
            .collect::<Vec<_>>();
        let read_all_raw = requested.is_none();
        let mut page = self.raw_read_projected_bounded(
            offset,
            limit,
            (!read_all_raw).then_some(raw_names.as_slice()),
            max_limit,
        )?;
        for row in &mut page.rows {
            let mut converted_row = Vec::with_capacity(selected_profiles.len());
            for (selected_position, (column, inference)) in selected_profiles.iter().enumerate() {
                let raw_position = if read_all_raw {
                    column.source_index
                } else {
                    selected_position
                };
                let raw = row
                    .get(raw_position)
                    .and_then(|value| value.display.clone())
                    .unwrap_or_default();
                let target = resolved_type(profile.mode, column, inference);
                converted_row.push(convert_value(&raw, target, column));
            }
            *row = converted_row;
        }
        page.columns = raw_names;
        Ok(page)
    }

    fn find_boundary_sequential(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        let summary = self.summary();
        super::boundary::validate_request(&summary.columns, summary.row_count, request)?;
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }

        if matches!(
            request.direction,
            DataBoundaryDirection::Left | DataBoundaryDirection::Right
        ) || (request.direction == DataBoundaryDirection::Up
            && request.mode == DataBoundaryMode::TableBoundary)
        {
            return super::boundary::find_boundary(
                &summary.columns,
                summary.row_count,
                request,
                cancel,
                |offset, limit, columns| self.read_page_projected(offset, limit, Some(columns)),
            );
        }

        let raw_summary = self.raw_summary();
        let (profile, inferences) = self.effective_profile_and_inferences(&raw_summary.columns);
        let selected = profile
            .columns
            .iter()
            .zip(&inferences)
            .find(|(column, inference)| {
                column.source_name == request.column_id
                    && resolved_type(profile.mode, column, inference) != CsvTargetType::Skip
            })
            .ok_or_else(|| {
                DataError::invalid_request(format!(
                    "Unknown CSV boundary column: {}",
                    request.column_id
                ))
            })?;
        let selected_index = selected.0.source_index;
        let selected_type = resolved_type(profile.mode, selected.0, selected.1);
        let mut reader = new_reader(&self.path)?;
        let mut record = ByteRecord::new();
        if self.header_used {
            read_record_checked(&self.path, &mut reader, &mut record)?;
        }

        let mut row = 0_u64;
        let mut previous_occupied = false;
        let mut occupied_run_start = None;
        let mut last_occupied = None;
        let mut found_current = false;
        let mut target = request.row;
        let mut seek_occupied = false;
        let mut first_neighbor = true;

        while read_record_checked(&self.path, &mut reader, &mut record)? {
            if row.is_multiple_of(BOUNDARY_CANCEL_INTERVAL) && cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            if record.len() > MAX_COLUMNS {
                return Err(DataError::csv_limit_exceeded(
                    &self.path,
                    format!(
                        "record has {} columns; maximum is {MAX_COLUMNS}",
                        record.len()
                    ),
                ));
            }
            let raw = std::str::from_utf8(record.get(selected_index).unwrap_or_default())
                .map_err(|_| DataError::invalid_encoding(&self.path, reader.position().byte()))?;
            let is_occupied = csv_boundary_occupied(raw, selected_type, selected.0);

            if request.direction == DataBoundaryDirection::Up {
                if row == request.row {
                    target = if is_occupied && previous_occupied {
                        occupied_run_start.unwrap_or(0)
                    } else {
                        last_occupied.unwrap_or(0)
                    };
                    return Ok(BoundarySearchResult {
                        target_row: target,
                        target_column_id: request.column_id.clone(),
                        resolved_row_count: summary.row_count,
                    });
                }
                if is_occupied {
                    if !previous_occupied {
                        occupied_run_start = Some(row);
                    }
                    last_occupied = Some(row);
                }
                previous_occupied = is_occupied;
                row = row.saturating_add(1);
                continue;
            }

            if request.mode == DataBoundaryMode::TableBoundary {
                found_current |= row == request.row;
                target = row;
                row = row.saturating_add(1);
                continue;
            }

            if row < request.row {
                row = row.saturating_add(1);
                continue;
            }
            if row == request.row {
                found_current = true;
                previous_occupied = is_occupied;
                target = row;
                row = row.saturating_add(1);
                continue;
            }
            if first_neighbor {
                seek_occupied = !(previous_occupied && is_occupied);
                first_neighbor = false;
            }
            if seek_occupied {
                if is_occupied {
                    return Ok(BoundarySearchResult {
                        target_row: row,
                        target_column_id: request.column_id.clone(),
                        resolved_row_count: summary.row_count,
                    });
                }
                target = row;
            } else if is_occupied {
                target = row;
            } else {
                return Ok(BoundarySearchResult {
                    target_row: target,
                    target_column_id: request.column_id.clone(),
                    resolved_row_count: summary.row_count,
                });
            }
            row = row.saturating_add(1);
        }

        if !found_current {
            return Err(DataError::invalid_request(
                "Boundary navigation row is outside the data table.",
            ));
        }
        Ok(BoundarySearchResult {
            target_row: target,
            target_column_id: request.column_id.clone(),
            resolved_row_count: Some(row),
        })
    }

    fn effective_profile_and_inferences(
        &self,
        columns: &[ColumnSchema],
    ) -> (CsvParsingProfile, Vec<CsvColumnInference>) {
        let mut profile = self.profile.clone();
        let mut inferences = self.inferences.clone();
        for (index, column) in columns.iter().enumerate().skip(profile.columns.len()) {
            let target = match profile.mode {
                CsvProfileMode::AllText => CsvTargetType::Text,
                CsvProfileMode::Auto | CsvProfileMode::Custom => CsvTargetType::Auto,
            };
            profile.columns.push(crate::domain::CsvColumnProfile::new(
                index,
                column.name.clone(),
                target,
            ));
            inferences.push(CsvColumnInference {
                source_index: index,
                source_name: column.name.clone(),
                recommended_type: CsvTargetType::Text,
                confidence: 0.0,
                non_null_samples: 0,
                ambiguous: true,
            });
        }
        (profile, inferences)
    }

    fn push_sample_row(
        &self,
        source_row: u64,
        sampled: &mut Vec<(u64, Vec<DataValue>)>,
    ) -> Result<(), DataError> {
        if sampled.iter().any(|(known, _)| *known == source_row) {
            return Ok(());
        }
        let page = self.raw_read_page_projected(source_row, 1, None)?;
        if let Some(row) = page.rows.into_iter().next() {
            sampled.push((source_row, row));
        }
        Ok(())
    }

    fn shutdown_worker(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn csv_boundary_occupied(
    raw: &str,
    target: CsvTargetType,
    options: &crate::domain::CsvColumnProfile,
) -> bool {
    let value = if options.trim { raw.trim() } else { raw };
    if value.is_empty() || options.null_tokens.iter().any(|token| token == value) {
        return false;
    }
    if matches!(target, CsvTargetType::Auto | CsvTargetType::Text) {
        return true;
    }
    super::boundary::occupied(convert_value(raw, target, options).state)
}

impl Drop for CsvSource {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

impl CsvHeaderConfigurable for CsvSource {
    fn prepare_header(
        &self,
        mode: HeaderMode,
    ) -> Result<Option<Box<dyn TabularSource>>, DataError> {
        CsvSource::prepare_header(self, mode)
            .map(|source| source.map(|source| Box::new(source) as Box<dyn TabularSource>))
    }
}

impl CsvProfileConfigurable for CsvSource {
    fn active_profile(&self) -> CsvParsingProfile {
        CsvSource::active_profile(self)
    }

    fn preview_profile(
        &self,
        profile: &CsvParsingProfile,
        generation: u64,
        cancel: &AtomicBool,
    ) -> Result<CsvProfilePreview, DataError> {
        CsvSource::preview_profile(self, profile, generation, cancel)
    }

    fn validate_profile(
        &self,
        profile: &CsvParsingProfile,
        cancel: &AtomicBool,
        progress: &mut CsvValidationProgress<'_>,
    ) -> Result<Vec<CsvColumnValidation>, DataError> {
        CsvSource::validate_profile(self, profile, cancel, progress)
    }

    fn prepare_profile(
        &self,
        profile: &CsvParsingProfile,
    ) -> Result<Box<dyn TabularSource>, DataError> {
        CsvSource::prepare_profile(self, profile)
            .map(|source| Box::new(source) as Box<dyn TabularSource>)
    }
}

#[derive(Debug)]
struct CsvQueryProvider {
    path: PathBuf,
    columns: Vec<ColumnSchema>,
    spec: CsvQuerySpec,
    checkpoints: Mutex<Vec<Checkpoint>>,
    states: Mutex<Option<CellStateBitmap>>,
    metrics: Mutex<QueryPreparationMetrics>,
    index_state: Arc<Mutex<IndexState>>,
    index_cancel: Arc<AtomicBool>,
    preparation_takeover: Arc<AtomicBool>,
    expected_columns: usize,
    unsafe_headers: bool,
    polars_value_compatible: AtomicBool,
    index_generation: u64,
    deferred_index_worker: bool,
    fallback_index_started: AtomicBool,
}

struct CsvPreparedBatchBuilder {
    schema: Arc<Schema>,
    row_ids: UInt64Builder,
    base_raw: Vec<StringBuilder>,
    values: Vec<Option<PreparedValueBuilder>>,
    state_words: Vec<UInt64Builder>,
    rows: usize,
    estimated_bytes: usize,
}

enum PreparedValueBuilder {
    Text(StringBuilder),
    Boolean(BooleanBuilder),
    Int64(Int64Builder),
    UInt64(UInt64Builder),
    Float64(Float64Builder),
}

struct PreparedBatch {
    batch: RecordBatch,
    estimated_bytes: usize,
}

#[derive(Debug)]
struct AdaptivePreparedBatchSizer {
    target_rows: usize,
}

impl Default for AdaptivePreparedBatchSizer {
    fn default() -> Self {
        Self {
            target_rows: PREPARED_BATCH_INITIAL_ROWS,
        }
    }
}

impl AdaptivePreparedBatchSizer {
    fn observe(
        &mut self,
        rows: usize,
        actual_bytes: usize,
        estimated_bytes: usize,
    ) -> std::cmp::Ordering {
        let previous = self.target_rows;
        if actual_bytes >= PREPARED_BATCH_ESTIMATED_BYTES
            || estimated_bytes >= PREPARED_BATCH_ESTIMATED_BYTES
            || actual_bytes >= PREPARED_BATCH_HARD_BYTES.saturating_mul(3) / 4
        {
            self.target_rows = (self.target_rows / 2).max(PREPARED_BATCH_INITIAL_ROWS);
        } else if rows >= self.target_rows
            && actual_bytes <= PREPARED_BATCH_GROW_BYTES
            && estimated_bytes <= PREPARED_BATCH_GROW_BYTES
        {
            self.target_rows = self
                .target_rows
                .saturating_mul(2)
                .min(PREPARED_BATCH_MAX_ROWS);
        }
        self.target_rows.cmp(&previous)
    }
}

struct CsvIndexTakeoverGuard<'a> {
    state: &'a Mutex<IndexState>,
    task_cancel: &'a AtomicBool,
    complete: bool,
}

impl Drop for CsvIndexTakeoverGuard<'_> {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        if let Ok(mut index) = self.state.lock() {
            index.status.state = if self.task_cancel.load(Ordering::Acquire) {
                RowCountState::Cancelled
            } else {
                RowCountState::Failed
            };
            if index.status.message.is_none() {
                index.status.message = Some(String::from(
                    "CSV preparation stopped before the shared index was committed.",
                ));
            }
        }
    }
}

impl CsvPreparedBatchBuilder {
    fn new(columns: &[ColumnSchema], profile: &CsvParsingProfile) -> Self {
        let mut fields = Vec::with_capacity(
            1 + profile.columns.len() + columns.len() + profile.columns.len().div_ceil(32),
        );
        fields.push(Field::new("__dv_row_id", DataType::UInt64, false));
        for source_index in 0..profile.columns.len() {
            fields.push(Field::new(
                format!("__dv_base_raw_{source_index}"),
                DataType::Utf8,
                false,
            ));
        }
        let visible_profiles = profile
            .columns
            .iter()
            .filter(|column| column.target_type != CsvTargetType::Skip);
        let values = columns
            .iter()
            .zip(visible_profiles)
            .map(|(column, profile)| match query_target_type(column) {
                // An untrimmed text value is identical to base_raw and does not
                // need another physical Parquet column. A trimmed value must be
                // materialized by Rust: DuckDB trim() does not have parity with
                // str::trim() for TAB/LF/NBSP and other Unicode whitespace.
                CsvTargetType::Text if !profile.trim => None,
                CsvTargetType::Text => Some(PreparedValueBuilder::Text(StringBuilder::new())),
                CsvTargetType::Boolean => {
                    Some(PreparedValueBuilder::Boolean(BooleanBuilder::new()))
                }
                CsvTargetType::Int64 => Some(PreparedValueBuilder::Int64(Int64Builder::new())),
                CsvTargetType::UInt64 => Some(PreparedValueBuilder::UInt64(UInt64Builder::new())),
                CsvTargetType::Float64 => {
                    Some(PreparedValueBuilder::Float64(Float64Builder::new()))
                }
                _ => Some(PreparedValueBuilder::Text(StringBuilder::new())),
            })
            .collect::<Vec<_>>();
        for (profile, value) in profile
            .columns
            .iter()
            .filter(|column| column.target_type != CsvTargetType::Skip)
            .zip(&values)
        {
            let Some(value) = value else {
                continue;
            };
            let data_type = match value {
                PreparedValueBuilder::Text(_) => DataType::Utf8,
                PreparedValueBuilder::Boolean(_) => DataType::Boolean,
                PreparedValueBuilder::Int64(_) => DataType::Int64,
                PreparedValueBuilder::UInt64(_) => DataType::UInt64,
                PreparedValueBuilder::Float64(_) => DataType::Float64,
            };
            fields.push(Field::new(
                format!("__dv_value_{}", profile.source_index),
                data_type,
                true,
            ));
        }
        for word in 0..profile.columns.len().div_ceil(32) {
            fields.push(Field::new(
                format!("__dv_state_word_{word}"),
                DataType::UInt64,
                false,
            ));
        }
        Self {
            schema: Arc::new(Schema::new(fields)),
            row_ids: UInt64Builder::new(),
            base_raw: (0..profile.columns.len())
                .map(|_| StringBuilder::new())
                .collect(),
            values,
            state_words: (0..profile.columns.len().div_ceil(32))
                .map(|_| UInt64Builder::new())
                .collect(),
            rows: 0,
            estimated_bytes: 0,
        }
    }

    fn append(
        &mut self,
        row_id: u64,
        raw_values: &[&str],
        values: &[DataValue],
        states: &[DataValueState],
    ) -> Result<(), DataError> {
        if values.len() != self.values.len()
            || raw_values.len() != self.base_raw.len()
            || states.len() != self.base_raw.len()
        {
            return Err(DataError::query_failed(
                "A prepared CSV row does not match its visible schema.",
            ));
        }
        self.row_ids.append_value(row_id);
        self.estimated_bytes = self.estimated_bytes.saturating_add(8);
        for (builder, raw) in self.base_raw.iter_mut().zip(raw_values) {
            builder.append_value(raw);
            self.estimated_bytes = self.estimated_bytes.saturating_add(raw.len() + 4);
        }
        for (index, value) in values.iter().enumerate() {
            if let Some(builder) = &mut self.values[index] {
                builder.append(value)?;
                self.estimated_bytes = self.estimated_bytes.saturating_add(
                    value.display.as_ref().map_or(0, String::len) + std::mem::size_of::<u64>(),
                );
            }
        }
        for (word_index, builder) in self.state_words.iter_mut().enumerate() {
            let mut word = 0_u64;
            for lane in 0..32 {
                let source_index = word_index * 32 + lane;
                let Some(state) = states.get(source_index) else {
                    break;
                };
                let bits = match state {
                    DataValueState::Valid => 0_u64,
                    DataValueState::Null => 1,
                    DataValueState::Empty => 2,
                    DataValueState::Invalid => 3,
                };
                word |= bits << (lane * 2);
            }
            builder.append_value(word);
            self.estimated_bytes = self.estimated_bytes.saturating_add(8);
        }
        self.rows += 1;
        Ok(())
    }

    fn should_flush(&self, target_rows: usize) -> bool {
        self.rows >= target_rows.min(PREPARED_BATCH_MAX_ROWS)
            || self.estimated_bytes >= PREPARED_BATCH_ESTIMATED_BYTES
    }

    fn finish(&mut self) -> Result<Option<PreparedBatch>, DataError> {
        if self.rows == 0 {
            return Ok(None);
        }
        let mut arrays = Vec::with_capacity(
            1 + self.base_raw.len()
                + self.values.iter().filter(|value| value.is_some()).count()
                + self.state_words.len(),
        );
        arrays.push(Arc::new(self.row_ids.finish()) as ArrayRef);
        for builder in &mut self.base_raw {
            arrays.push(Arc::new(builder.finish()) as ArrayRef);
        }
        for builder in self.values.iter_mut().flatten() {
            arrays.push(builder.finish());
        }
        for builder in &mut self.state_words {
            arrays.push(Arc::new(builder.finish()) as ArrayRef);
        }
        let batch = RecordBatch::try_new(Arc::clone(&self.schema), arrays)
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        let estimated_bytes = self.estimated_bytes;
        self.rows = 0;
        self.estimated_bytes = 0;
        Ok(Some(PreparedBatch {
            batch,
            estimated_bytes,
        }))
    }
}

impl PreparedValueBuilder {
    fn append(&mut self, value: &DataValue) -> Result<(), DataError> {
        let valid = value.state == DataValueState::Valid;
        let normalized = value.source_display.as_deref().or(value.display.as_deref());
        match self {
            Self::Text(builder) => builder.append_option(if valid { normalized } else { None }),
            Self::Boolean(builder) => builder.append_option(
                valid
                    .then(|| normalized.and_then(|value| value.parse::<bool>().ok()))
                    .flatten(),
            ),
            Self::Int64(builder) => builder.append_option(
                valid
                    .then(|| normalized.and_then(|value| value.parse::<i64>().ok()))
                    .flatten(),
            ),
            Self::UInt64(builder) => builder.append_option(
                valid
                    .then(|| normalized.and_then(|value| value.parse::<u64>().ok()))
                    .flatten(),
            ),
            Self::Float64(builder) => builder.append_option(
                valid
                    .then(|| normalized.and_then(|value| value.parse::<f64>().ok()))
                    .flatten(),
            ),
        }
        Ok(())
    }

    fn finish(&mut self) -> ArrayRef {
        match self {
            Self::Text(builder) => Arc::new(builder.finish()),
            Self::Boolean(builder) => Arc::new(builder.finish()),
            Self::Int64(builder) => Arc::new(builder.finish()),
            Self::UInt64(builder) => Arc::new(builder.finish()),
            Self::Float64(builder) => Arc::new(builder.finish()),
        }
    }
}

fn write_prepared_batch(
    writer: &mut ArrowWriter<File>,
    prepared: PreparedBatch,
    metrics: &Mutex<QueryPreparationMetrics>,
) -> Result<(usize, usize, usize), DataError> {
    let rows = prepared.batch.num_rows();
    if rows > PREPARED_BATCH_MAX_ROWS {
        return Err(DataError::query_failed(format!(
            "A prepared CSV Arrow batch has {rows} rows; the limit is {PREPARED_BATCH_MAX_ROWS}."
        )));
    }
    let decoded_bytes = prepared
        .batch
        .columns()
        .iter()
        .map(|array| array.get_array_memory_size())
        .sum::<usize>();
    if decoded_bytes > PREPARED_BATCH_HARD_BYTES {
        return Err(DataError::query_failed(format!(
            "A prepared CSV Arrow batch requires {decoded_bytes} bytes; the limit is {PREPARED_BATCH_HARD_BYTES} bytes."
        )));
    }
    if let Ok(mut metrics) = metrics.lock() {
        metrics.peak_decoded_batch_bytes =
            metrics.peak_decoded_batch_bytes.max(decoded_bytes as u64);
        metrics.record_batches_accepted = metrics.record_batches_accepted.saturating_add(1);
        metrics.max_accepted_batch_rows = metrics.max_accepted_batch_rows.max(rows as u64);
    }
    writer
        .write(&prepared.batch)
        .map_err(|error| DataError::query_failed(error.to_string()))?;
    Ok((rows, decoded_bytes, prepared.estimated_bytes))
}

type CsvSparseGroups = BTreeMap<u64, (Option<Checkpoint>, Vec<(u64, usize)>)>;

#[cfg(feature = "polars-csv-provider")]
impl CsvQueryProvider {
    fn prepare_with_polars(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
        self.preparation_takeover.store(true, Ordering::Release);
        self.index_cancel.store(true, Ordering::Release);
        if let Ok(mut index) = self.index_state.lock() {
            index.status.state = RowCountState::Calculating;
            index.status.rows_scanned = 0;
            index.status.bytes_scanned = 0;
            index.status.message = None;
            index.checkpoints.clear();
            index.structure_issue_count = 0;
            index.structure_issues.clear();
        }
        let mut takeover_guard = CsvIndexTakeoverGuard {
            state: &self.index_state,
            task_cancel: context.cancel,
            complete: false,
        };

        // Pass A remains the csv-crate oracle. It validates exact record
        // structure, builds navigation checkpoints, and creates the visible
        // cell-state bitmap before Polars is allowed to create an artifact.
        let mut reader = match context.source_file {
            Some(file) => new_reader_from_file(
                file.try_clone()
                    .map_err(|error| DataError::io(&context.source.path, error))?,
            ),
            None => new_reader(&context.source.path)?,
        };
        let mut source_row = 0_u64;
        let mut physical_row = 0_usize;
        let mut record = ByteRecord::new();
        let mut checkpoints = Vec::new();
        let mut checkpoint_stride = CHECKPOINT_INTERVAL;
        let mut states = CellStateBitmap::new(context.source.columns.len());
        let mut max_columns = self.expected_columns;
        let mut structure_issue_count = 0_u64;
        let mut structure_issues = Vec::new();
        let mut row_states = Vec::with_capacity(context.source.columns.len());
        let mut value_parity_mismatch = false;
        let visible_columns = polars_visible_columns(&self.spec.profile, &context.source.columns)?;
        loop {
            if context.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let position = reader.position().clone();
            if !read_record_checked(&context.source.path, &mut reader, &mut record)? {
                break;
            }
            if self.spec.header_used && physical_row == 0 {
                physical_row += 1;
                continue;
            }
            let width = record.len();
            if width > MAX_COLUMNS {
                return Err(DataError::csv_limit_exceeded(
                    &context.source.path,
                    format!("record has {width} columns; maximum is {MAX_COLUMNS}"),
                ));
            }
            max_columns = max_columns.max(width);
            if width != self.expected_columns {
                structure_issue_count = structure_issue_count.saturating_add(1);
                if structure_issues.len() < MAX_STRUCTURE_ISSUES {
                    structure_issues.push(CsvStructureIssue {
                        row: source_row + 1,
                        expected_columns: self.expected_columns,
                        actual_columns: width,
                    });
                }
            }
            if source_row.is_multiple_of(CHECKPOINT_INTERVAL) {
                if let Ok(mut metrics) = self.metrics.lock() {
                    metrics.source_read_bytes = position.byte();
                }
                if let Ok(mut index) = self.index_state.lock() {
                    index.status.rows_scanned = source_row;
                    index.status.bytes_scanned = position.byte();
                    index.max_columns = max_columns;
                    index.structure_issue_count = structure_issue_count;
                    index.structure_issues.clone_from(&structure_issues);
                }
                (context.progress)(source_row)?;
            }
            record_checkpoint(
                &mut checkpoints,
                &mut checkpoint_stride,
                source_row,
                position,
            );
            row_states.clear();
            for &(source_index, target) in &visible_columns {
                let raw = std::str::from_utf8(record.get(source_index).unwrap_or_default())
                    .map_err(|error| DataError::invalid_csv(&context.source.path, error))?;
                match polars_fast_lane_state(raw, target) {
                    Some(state) => row_states.push(state),
                    None => {
                        value_parity_mismatch = true;
                        row_states.push(DataValueState::Invalid);
                    }
                }
            }
            states.push_row(&row_states)?;
            source_row = source_row.saturating_add(1);
            physical_row += 1;
        }
        if value_parity_mismatch {
            self.polars_value_compatible.store(false, Ordering::Release);
        }
        if structure_issue_count > 0 || value_parity_mismatch {
            // Structure or value parity can close the gate during Pass A. This
            // is a pre-sink eligibility correction, not a Polars runtime
            // fallback: no worker or partial artifact exists yet.
            if let Ok(mut index) = self.index_state.lock() {
                index.status.state = RowCountState::Complete;
                index.status.rows_scanned = source_row;
                index.status.bytes_scanned = reader.position().byte();
                index.checkpoints = checkpoints.clone();
                index.max_columns = max_columns;
                index.structure_issue_count = structure_issue_count;
                index.structure_issues.clone_from(&structure_issues);
            }
            takeover_guard.complete = true;
            drop(reader);
            return QueryInputProvider::prepare(self, context);
        }
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }

        let parquet_partial = context.artifact_directory.join("prepared.parquet.partial");
        let parquet_path = context.artifact_directory.join("prepared.parquet");
        let resolved_targets = context
            .source
            .columns
            .iter()
            .map(query_target_type)
            .collect::<Vec<_>>();
        let pinned_source = context.source_file.ok_or_else(|| {
            DataError::query_failed("Polars CSV preparation requires a pinned source handle.")
        })?;
        super::csv_polars::run_product_worker(
            &context.source.path,
            pinned_source,
            context.artifact_directory,
            self.spec.header_used,
            &self.spec.profile,
            &resolved_targets,
            context.cancel,
        )?;
        if context.cancel.load(Ordering::Acquire) {
            let _ = fs::remove_file(&parquet_partial);
            return Err(DataError::task_cancelled());
        }
        std::fs::OpenOptions::new()
            .write(true)
            .open(&parquet_partial)
            .and_then(|file| file.sync_all())
            .map_err(|error| DataError::io(&parquet_partial, error))?;
        fs::rename(&parquet_partial, &parquet_path)
            .map_err(|error| DataError::io(&parquet_partial, error))?;

        let states_partial = context.artifact_directory.join("states.bin.partial");
        let states_path = context.artifact_directory.join("states.bin");
        let state_file_bytes = states.write_file(&states_partial)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        fs::rename(&states_partial, &states_path)
            .map_err(|error| DataError::io(&states_partial, error))?;

        let offsets_partial = context.artifact_directory.join("offsets.idx.partial");
        let offsets_path = context.artifact_directory.join("offsets.idx");
        let mut offsets = File::create(&offsets_partial)
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        offsets
            .write_all(b"DVOF\x01\0\0\0")
            .and_then(|()| offsets.write_all(&(checkpoints.len() as u64).to_le_bytes()))
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        for checkpoint in &checkpoints {
            offsets
                .write_all(&checkpoint.row.to_le_bytes())
                .and_then(|()| offsets.write_all(&checkpoint.position.byte().to_le_bytes()))
                .map_err(|error| DataError::io(&offsets_partial, error))?;
        }
        offsets
            .sync_all()
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        drop(offsets);
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        fs::rename(&offsets_partial, &offsets_path)
            .map_err(|error| DataError::io(&offsets_partial, error))?;

        let parquet = parquet_path.to_string_lossy().replace('\\', "/");
        let view = self.prepared_view_sql(&super::query_quote_literal(&parquet));
        context
            .connection
            .execute_batch(&format!("CREATE VIEW dv_source AS {view}"))
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        (context.progress)(source_row)?;

        let offsets_file_bytes = fs::metadata(&offsets_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.source_read_bytes = reader.position().byte().saturating_add(
                fs::metadata(&context.source.path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
            );
            metrics.navigation_frontier_row = source_row;
            metrics.state_bitmap_bytes = states.payload_bytes() as u64;
            metrics.cache_output_bytes = fs::metadata(&parquet_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0)
                .saturating_add(state_file_bytes)
                .saturating_add(offsets_file_bytes);
        }
        let prepared_checkpoints = checkpoints.clone();
        *self.checkpoints.lock().map_err(|_| {
            DataError::query_failed("CSV sparse checkpoint index is unavailable.")
        })? = checkpoints;
        if let Ok(mut index) = self.index_state.lock() {
            index.status.state = RowCountState::Complete;
            index.status.rows_scanned = source_row;
            index.status.bytes_scanned = index.status.total_bytes;
            index.checkpoints = prepared_checkpoints;
            index.max_columns = max_columns;
            index.structure_issue_count = 0;
            index.structure_issues.clear();
        }
        *self
            .states
            .lock()
            .map_err(|_| DataError::query_failed("CSV state bitmap is unavailable."))? =
            Some(states);
        takeover_guard.complete = true;
        Ok(())
    }
}

impl QueryInputProvider for CsvQueryProvider {
    fn reusable_source_identity(&self) -> Option<String> {
        let profile = serde_json::to_string(&self.spec.profile).ok()?;
        Some(format!(
            "{}|header={}|{profile}",
            self.path.to_string_lossy(),
            self.spec.header_used
        ))
    }

    fn csv_prepared_physical_columns(&self) -> Vec<CsvPreparedPhysicalColumn> {
        self.columns
            .iter()
            .zip(
                self.spec
                    .profile
                    .columns
                    .iter()
                    .filter(|column| column.target_type != CsvTargetType::Skip),
            )
            .filter_map(|(column, profile)| {
                let physical_kind = match query_target_type(column) {
                    CsvTargetType::Text if !profile.trim => return None,
                    CsvTargetType::Text => "normalizedText",
                    CsvTargetType::Boolean
                    | CsvTargetType::Int64
                    | CsvTargetType::UInt64
                    | CsvTargetType::Float64 => "nativeValue",
                    _ => "fallbackValue",
                };
                Some(CsvPreparedPhysicalColumn {
                    source_index: profile.source_index,
                    field: format!("__dv_value_{}", profile.source_index),
                    physical_kind: physical_kind.to_owned(),
                })
            })
            .collect()
    }

    fn csv_source_column_count(&self) -> Option<usize> {
        Some(self.spec.profile.columns.len())
    }

    fn prepared_view_sql(&self, parquet_literal: &str) -> String {
        let mut expressions = vec![String::from("p.__dv_row_id")];
        let mut visible_index = 0_usize;
        for profile in &self.spec.profile.columns {
            if profile.target_type == CsvTargetType::Skip {
                continue;
            }
            let column = &self.columns[visible_index];
            let identifier = super::query_quote_identifier(&column.name);
            let word = super::query_quote_identifier(&format!(
                "__dv_state_word_{}",
                profile.source_index / 32
            ));
            let shift = (profile.source_index % 32) * 2;
            let state = format!("((p.{word} >> {shift}) & 3)");
            let raw = format!(
                "p.{}",
                super::query_quote_identifier(&format!("__dv_base_raw_{}", profile.source_index))
            );
            let value = if query_target_type(column) == CsvTargetType::Text {
                let valid = if profile.trim {
                    format!(
                        "p.{}",
                        super::query_quote_identifier(&format!(
                            "__dv_value_{}",
                            profile.source_index
                        ))
                    )
                } else {
                    raw.clone()
                };
                format!(
                    "CASE {state} WHEN 0 THEN {valid} WHEN 2 THEN '' WHEN 3 THEN {raw} ELSE NULL END AS {identifier}"
                )
            } else {
                let physical_value =
                    super::query_quote_identifier(&format!("__dv_value_{}", profile.source_index));
                format!(
                    "CASE {state} WHEN 1 THEN NULL WHEN 2 THEN '' WHEN 3 THEN {raw} ELSE CAST(p.{physical_value} AS VARCHAR) END AS {identifier}"
                )
            };
            expressions.push(value);
            expressions.push(format!(
                "p.{} AS {}",
                super::query_quote_identifier(&format!("__dv_base_raw_{}", profile.source_index)),
                super::query_quote_identifier(&format!("__dv_raw_{visible_index}"))
            ));
            expressions.push(format!(
                "({state} = 3) AS {}",
                super::query_quote_identifier(&format!("__dv_invalid_{visible_index}"))
            ));
            visible_index += 1;
        }
        format!(
            "SELECT {} FROM read_parquet({parquet_literal}) AS p",
            expressions.join(", ")
        )
    }

    fn source_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<Option<BoundarySearchResult>, DataError> {
        let states = self
            .states
            .lock()
            .map_err(|_| DataError::query_failed("CSV state bitmap is unavailable."))?;
        let Some(states) = states.as_ref() else {
            return Ok(None);
        };
        let names = self
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        states.find_boundary(&names, request, cancel).map(Some)
    }

    fn preparation_metrics(&self) -> QueryPreparationMetrics {
        self.metrics
            .lock()
            .map(|metrics| *metrics)
            .unwrap_or_default()
    }

    fn preparation_aborted(&self) {
        if !self.deferred_index_worker
            || self
                .fallback_index_started
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        self.preparation_takeover.store(false, Ordering::Release);
        self.index_cancel.store(false, Ordering::Release);
        drop(spawn_index_worker(
            self.path.clone(),
            self.spec.header_used,
            self.expected_columns,
            self.index_generation,
            Arc::clone(&self.index_state),
            Arc::clone(&self.index_cancel),
            Arc::clone(&self.preparation_takeover),
        ));
    }

    fn occupancy_states(&self, row_ids: &[u64], column: &str) -> Result<Vec<bool>, DataError> {
        if row_ids.len() > 65_536 {
            return Err(DataError::invalid_request(
                "CSV occupancy reads exceed 65,536 rows.",
            ));
        }
        let column_index = self
            .columns
            .iter()
            .position(|candidate| candidate.name == column)
            .ok_or_else(|| DataError::invalid_request(format!("Unknown CSV column: {column}")))?;
        let states = self
            .states
            .lock()
            .map_err(|_| DataError::query_failed("CSV state bitmap is unavailable."))?;
        let states = states.as_ref().ok_or_else(|| {
            DataError::query_failed("CSV state bitmap is not ready for occupancy reads.")
        })?;
        row_ids
            .iter()
            .map(|row| states.occupancy(*row, column_index))
            .collect()
    }

    fn restore_prepared_state(
        &self,
        states_path: &Path,
        rows: u64,
        columns: usize,
    ) -> Result<(), DataError> {
        if columns != self.columns.len() {
            return Err(DataError::query_failed(
                "Cached CSV state bitmap column count does not match the source schema.",
            ));
        }
        let restored = CellStateBitmap::read_file(states_path, rows, columns)?;
        *self
            .states
            .lock()
            .map_err(|_| DataError::query_failed("CSV state bitmap is unavailable."))? =
            Some(restored);
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.navigation_frontier_row = rows;
            metrics.state_bitmap_bytes = fs::metadata(states_path)
                .map(|metadata| metadata.len().saturating_sub(24))
                .unwrap_or(0);
        }
        Ok(())
    }

    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
        let known_inconsistent_width = self
            .index_state
            .lock()
            .map(|index| {
                index.status.state == RowCountState::Complete && index.structure_issue_count > 0
            })
            .unwrap_or(false);
        let resolved_targets = self
            .columns
            .iter()
            .map(query_target_type)
            .collect::<Vec<_>>();
        let preparation = classify_csv_preparation(
            CsvEligibilityInput {
                dialect: CsvDialectSnapshot {
                    delimiter: b',',
                    quote: b'"',
                    double_quote: true,
                    utf8: true,
                    known_inconsistent_width,
                },
                profile: &self.spec.profile,
                resolved_targets: &resolved_targets,
                unsafe_header: self.unsafe_headers,
                source_bytes: fs::metadata(&context.source.path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
                value_compatible: self.polars_value_compatible.load(Ordering::Acquire),
            },
            cfg!(feature = "polars-csv-provider"),
        );
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.csv_preparation_provider = preparation
                .backend()
                .map(|backend| backend.diagnostic_name());
            metrics.csv_classifier_reason = preparation.diagnostic_reason();
        }
        match preparation {
            CsvEligibilityDecision::RustRequired(_) => {}
            CsvEligibilityDecision::Invalid(CsvInvalidReason::InvalidEncoding) => {
                return Err(DataError::invalid_encoding(&context.source.path, 0));
            }
            CsvEligibilityDecision::PolarsEligible => {
                #[cfg(feature = "polars-csv-provider")]
                {
                    let snapshot_available = context.source_file.is_some_and(|source_file| {
                        super::csv_polars::probe_pinned_source_snapshot(
                            &context.source.path,
                            source_file,
                            context.artifact_directory,
                        )
                        .is_ok()
                    });
                    if snapshot_available {
                        return self.prepare_with_polars(context);
                    }
                    // The Rust provider reads the already-pinned handle and
                    // therefore remains safe when a cross-volume cache root or
                    // OS policy prevents creating the Polars hardlink snapshot.
                    if let Ok(mut metrics) = self.metrics.lock() {
                        metrics.csv_preparation_provider = Some("rust");
                        metrics.csv_classifier_reason = Some("snapshotUnavailable");
                    }
                }
                #[cfg(not(feature = "polars-csv-provider"))]
                return Err(DataError::query_failed(
                    "The Polars CSV provider was selected without its Cargo feature.",
                ));
            }
        }
        #[cfg(test)]
        let provider_started = Instant::now();
        #[cfg(test)]
        let mut csv_read_ns = 0_u128;
        #[cfg(test)]
        let mut convert_ns = 0_u128;
        #[cfg(test)]
        let mut state_ns = 0_u128;
        #[cfg(test)]
        let mut batch_append_ns = 0_u128;
        #[cfg(test)]
        let mut batch_finish_ns = 0_u128;
        #[cfg(test)]
        let mut parquet_write_ns = 0_u128;
        self.preparation_takeover.store(true, Ordering::Release);
        self.index_cancel.store(true, Ordering::Release);
        if let Ok(mut index) = self.index_state.lock() {
            index.status.state = RowCountState::Calculating;
            index.status.rows_scanned = 0;
            index.status.bytes_scanned = 0;
            index.status.message = None;
            index.checkpoints.clear();
            index.structure_issue_count = 0;
            index.structure_issues.clear();
        }
        let mut takeover_guard = CsvIndexTakeoverGuard {
            state: &self.index_state,
            task_cancel: context.cancel,
            complete: false,
        };
        let parquet_partial = context.artifact_directory.join("prepared.parquet.partial");
        let parquet_path = context.artifact_directory.join("prepared.parquet");
        let batch_schema =
            CsvPreparedBatchBuilder::new(&context.source.columns, &self.spec.profile).schema;
        let properties = WriterProperties::builder()
            .set_compression(Compression::ZSTD(
                ZstdLevel::try_new(1)
                    .map_err(|error| DataError::query_failed(error.to_string()))?,
            ))
            .set_max_row_group_row_count(Some(65_536))
            .build();
        let mut writer = ArrowWriter::try_new(
            File::create(&parquet_partial)
                .map_err(|error| DataError::io(&parquet_partial, error))?,
            batch_schema,
            Some(properties),
        )
        .map_err(|error| DataError::query_failed(error.to_string()))?;
        let mut batch = CsvPreparedBatchBuilder::new(&context.source.columns, &self.spec.profile);
        let mut batch_sizer = AdaptivePreparedBatchSizer::default();
        let mut reader = match context.source_file {
            Some(file) => new_reader_from_file(
                file.try_clone()
                    .map_err(|error| DataError::io(&context.source.path, error))?,
            ),
            None => new_reader(&context.source.path)?,
        };
        let mut source_row = 0_u64;
        let mut physical_row = 0_usize;
        let mut record = ByteRecord::new();
        let mut checkpoints = Vec::new();
        let mut checkpoint_stride = CHECKPOINT_INTERVAL;
        let mut states = CellStateBitmap::new(context.source.columns.len());
        let mut max_columns = self.expected_columns;
        let mut structure_issue_count = 0_u64;
        let mut structure_issues = Vec::new();
        loop {
            if context.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let position = reader.position().clone();
            #[cfg(test)]
            let stage_started = Instant::now();
            let has_record = read_record_checked(&context.source.path, &mut reader, &mut record)?;
            #[cfg(test)]
            {
                csv_read_ns = csv_read_ns.saturating_add(stage_started.elapsed().as_nanos());
            }
            if !has_record {
                break;
            }
            if self.spec.header_used && physical_row == 0 {
                physical_row += 1;
                continue;
            }
            let width = record.len();
            if width > MAX_COLUMNS {
                return Err(DataError::csv_limit_exceeded(
                    &context.source.path,
                    format!("record has {width} columns; maximum is {MAX_COLUMNS}"),
                ));
            }
            max_columns = max_columns.max(width);
            if width != self.expected_columns {
                structure_issue_count = structure_issue_count.saturating_add(1);
                if structure_issues.len() < MAX_STRUCTURE_ISSUES {
                    structure_issues.push(CsvStructureIssue {
                        row: source_row + 1,
                        expected_columns: self.expected_columns,
                        actual_columns: width,
                    });
                }
            }
            if source_row.is_multiple_of(CHECKPOINT_INTERVAL) {
                if let Ok(mut metrics) = self.metrics.lock() {
                    metrics.source_read_bytes = position.byte();
                    metrics.navigation_frontier_row = 0;
                }
                if let Ok(mut index) = self.index_state.lock() {
                    index.status.rows_scanned = source_row;
                    index.status.bytes_scanned = position.byte();
                    index.max_columns = max_columns;
                    index.structure_issue_count = structure_issue_count;
                    index.structure_issues.clone_from(&structure_issues);
                }
                (context.progress)(source_row)?;
            }
            record_checkpoint(
                &mut checkpoints,
                &mut checkpoint_stride,
                source_row,
                position,
            );
            #[cfg(test)]
            let stage_started = Instant::now();
            let mut values = Vec::with_capacity(context.source.columns.len());
            let mut row_states = Vec::with_capacity(context.source.columns.len());
            let mut source_states = Vec::with_capacity(self.spec.profile.columns.len());
            let mut raw_values = Vec::with_capacity(self.spec.profile.columns.len());
            let mut visible_index = 0_usize;
            for profile in &self.spec.profile.columns {
                let raw_bytes = record.get(profile.source_index).unwrap_or_default();
                let raw = std::str::from_utf8(raw_bytes)
                    .map_err(|error| DataError::invalid_csv(&context.source.path, error))?;
                raw_values.push(raw);
                if profile.target_type == CsvTargetType::Skip {
                    source_states.push(if raw.is_empty() {
                        DataValueState::Empty
                    } else {
                        DataValueState::Valid
                    });
                    continue;
                }
                let column = context.source.columns.get(visible_index).ok_or_else(|| {
                    DataError::query_failed("CSV query profile does not match its visible schema.")
                })?;
                let converted = convert_value_for_query(raw, query_target_type(column), profile);
                row_states.push(converted.state);
                source_states.push(converted.state);
                values.push(converted);
                visible_index += 1;
            }
            if visible_index != context.source.columns.len() {
                return Err(DataError::query_failed(
                    "CSV query profile does not cover its visible schema.",
                ));
            }
            #[cfg(test)]
            {
                convert_ns = convert_ns.saturating_add(stage_started.elapsed().as_nanos());
            }
            #[cfg(test)]
            let stage_started = Instant::now();
            states.push_row(&row_states)?;
            #[cfg(test)]
            {
                state_ns = state_ns.saturating_add(stage_started.elapsed().as_nanos());
            }
            #[cfg(test)]
            let stage_started = Instant::now();
            batch.append(source_row, &raw_values, &values, &source_states)?;
            #[cfg(test)]
            {
                batch_append_ns =
                    batch_append_ns.saturating_add(stage_started.elapsed().as_nanos());
            }
            if batch.should_flush(batch_sizer.target_rows) {
                (context.progress)(source_row)?;
                if context.cancel.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
                #[cfg(test)]
                let stage_started = Instant::now();
                let finished_batch = batch.finish()?;
                #[cfg(test)]
                {
                    batch_finish_ns =
                        batch_finish_ns.saturating_add(stage_started.elapsed().as_nanos());
                }
                if let Some(batch) = finished_batch {
                    #[cfg(test)]
                    let stage_started = Instant::now();
                    let (rows, actual, estimated) =
                        write_prepared_batch(&mut writer, batch, &self.metrics)?;
                    #[cfg(test)]
                    {
                        parquet_write_ns =
                            parquet_write_ns.saturating_add(stage_started.elapsed().as_nanos());
                    }
                    match batch_sizer.observe(rows, actual, estimated) {
                        std::cmp::Ordering::Greater => {
                            if let Ok(mut metrics) = self.metrics.lock() {
                                metrics.adaptive_batch_growths =
                                    metrics.adaptive_batch_growths.saturating_add(1);
                            }
                        }
                        std::cmp::Ordering::Less => {
                            if let Ok(mut metrics) = self.metrics.lock() {
                                metrics.adaptive_batch_shrinks =
                                    metrics.adaptive_batch_shrinks.saturating_add(1);
                            }
                        }
                        std::cmp::Ordering::Equal => {}
                    }
                }
                (context.progress)(source_row.saturating_add(1))?;
                if context.cancel.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
            }
            source_row = source_row.saturating_add(1);
            physical_row += 1;
        }
        #[cfg(test)]
        let stage_started = Instant::now();
        let finished_batch = batch.finish()?;
        #[cfg(test)]
        {
            batch_finish_ns = batch_finish_ns.saturating_add(stage_started.elapsed().as_nanos());
        }
        if let Some(batch) = finished_batch {
            (context.progress)(source_row)?;
            if context.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            #[cfg(test)]
            let stage_started = Instant::now();
            let (rows, actual, estimated) =
                write_prepared_batch(&mut writer, batch, &self.metrics)?;
            #[cfg(test)]
            {
                parquet_write_ns =
                    parquet_write_ns.saturating_add(stage_started.elapsed().as_nanos());
            }
            match batch_sizer.observe(rows, actual, estimated) {
                std::cmp::Ordering::Greater => {
                    if let Ok(mut metrics) = self.metrics.lock() {
                        metrics.adaptive_batch_growths =
                            metrics.adaptive_batch_growths.saturating_add(1);
                    }
                }
                std::cmp::Ordering::Less => {
                    if let Ok(mut metrics) = self.metrics.lock() {
                        metrics.adaptive_batch_shrinks =
                            metrics.adaptive_batch_shrinks.saturating_add(1);
                    }
                }
                std::cmp::Ordering::Equal => {}
            }
            (context.progress)(source_row)?;
            if context.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
        }
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.parquet_close_budget_checks =
                metrics.parquet_close_budget_checks.saturating_add(1);
        }
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        #[cfg(test)]
        let close_started = Instant::now();
        writer
            .close()
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        #[cfg(test)]
        let parquet_close_ns = close_started.elapsed().as_nanos();
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.parquet_close_budget_checks =
                metrics.parquet_close_budget_checks.saturating_add(1);
        }
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        #[cfg(test)]
        let sync_started = Instant::now();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&parquet_partial)
            .and_then(|file| file.sync_all())
            .map_err(|error| DataError::io(&parquet_partial, error))?;
        #[cfg(test)]
        let parquet_sync_ns = sync_started.elapsed().as_nanos();
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.parquet_close_budget_checks =
                metrics.parquet_close_budget_checks.saturating_add(1);
        }
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        fs::rename(&parquet_partial, &parquet_path)
            .map_err(|error| DataError::io(&parquet_partial, error))?;
        let states_partial = context.artifact_directory.join("states.bin.partial");
        let states_path = context.artifact_directory.join("states.bin");
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        #[cfg(test)]
        let state_file_started = Instant::now();
        let state_file_bytes = states.write_file(&states_partial)?;
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        fs::rename(&states_partial, &states_path)
            .map_err(|error| DataError::io(&states_partial, error))?;
        #[cfg(test)]
        let state_file_ns = state_file_started.elapsed().as_nanos();
        let offsets_partial = context.artifact_directory.join("offsets.idx.partial");
        let offsets_path = context.artifact_directory.join("offsets.idx");
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        #[cfg(test)]
        let offset_file_started = Instant::now();
        let mut offsets = File::create(&offsets_partial)
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        offsets
            .write_all(b"DVOF\x01\0\0\0")
            .and_then(|()| offsets.write_all(&(checkpoints.len() as u64).to_le_bytes()))
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        for checkpoint in &checkpoints {
            offsets
                .write_all(&checkpoint.row.to_le_bytes())
                .and_then(|()| offsets.write_all(&checkpoint.position.byte().to_le_bytes()))
                .map_err(|error| DataError::io(&offsets_partial, error))?;
        }
        offsets
            .sync_all()
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        (context.progress)(source_row)?;
        if context.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        drop(offsets);
        fs::rename(&offsets_partial, &offsets_path)
            .map_err(|error| DataError::io(&offsets_partial, error))?;
        #[cfg(test)]
        let offset_file_ns = offset_file_started.elapsed().as_nanos();
        let offsets_file_bytes = fs::metadata(&offsets_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let parquet = parquet_path.to_string_lossy().replace('\\', "/");
        #[cfg(test)]
        let view_started = Instant::now();
        let view = self.prepared_view_sql(&super::query_quote_literal(&parquet));
        context
            .connection
            .execute_batch(&format!("CREATE VIEW dv_source AS {view}"))
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        #[cfg(test)]
        let duckdb_view_ns = view_started.elapsed().as_nanos();
        (context.progress)(source_row)?;
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.source_read_bytes = reader.position().byte();
            metrics.navigation_frontier_row = source_row;
            metrics.state_bitmap_bytes = states.payload_bytes() as u64;
            metrics.cache_output_bytes = fs::metadata(&parquet_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0)
                .saturating_add(state_file_bytes)
                .saturating_add(offsets_file_bytes);
            #[cfg(test)]
            {
                let ns = |value: u128| value.min(u128::from(u64::MAX)) as u64;
                metrics.profile_total_ns = ns(provider_started.elapsed().as_nanos());
                metrics.profile_csv_read_ns = ns(csv_read_ns);
                metrics.profile_convert_ns = ns(convert_ns);
                metrics.profile_state_ns = ns(state_ns);
                metrics.profile_batch_append_ns = ns(batch_append_ns);
                metrics.profile_batch_finish_ns = ns(batch_finish_ns);
                metrics.profile_parquet_write_ns = ns(parquet_write_ns);
                metrics.profile_parquet_close_ns = ns(parquet_close_ns);
                metrics.profile_parquet_sync_ns = ns(parquet_sync_ns);
                metrics.profile_state_file_ns = ns(state_file_ns);
                metrics.profile_offset_file_ns = ns(offset_file_ns);
                metrics.profile_duckdb_view_ns = ns(duckdb_view_ns);
            }
        }
        let prepared_checkpoints = checkpoints.clone();
        *self.checkpoints.lock().map_err(|_| {
            DataError::query_failed("CSV sparse checkpoint index is unavailable.")
        })? = checkpoints;
        if let Ok(mut index) = self.index_state.lock() {
            index.status.state = RowCountState::Complete;
            index.status.rows_scanned = source_row;
            index.status.bytes_scanned = index.status.total_bytes;
            index.checkpoints = prepared_checkpoints;
            index.max_columns = max_columns;
            index.structure_issue_count = structure_issue_count;
            index.structure_issues = structure_issues;
        }
        *self
            .states
            .lock()
            .map_err(|_| DataError::query_failed("CSV state bitmap is unavailable."))? =
            Some(states);
        takeover_guard.complete = true;
        Ok(())
    }

    fn sparse_query_values(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        if row_ids.is_empty() {
            return Ok(QueryExactValues {
                columns: columns.to_vec(),
                rows: Vec::new(),
            });
        }
        let visible_profiles = self
            .spec
            .profile
            .columns
            .iter()
            .filter(|profile| profile.target_type != CsvTargetType::Skip)
            .collect::<Vec<_>>();
        let selected = columns
            .iter()
            .map(|name| {
                let visible_index = self
                    .columns
                    .iter()
                    .position(|column| column.name == *name)
                    .ok_or_else(|| {
                        DataError::invalid_request(format!("Unknown projected column: {name}"))
                    })?;
                let profile = visible_profiles.get(visible_index).ok_or_else(|| {
                    DataError::query_failed("CSV query profile does not match its visible schema.")
                })?;
                Ok((visible_index, *profile))
            })
            .collect::<Result<Vec<_>, DataError>>()?;
        let checkpoints = self
            .checkpoints
            .lock()
            .map_err(|_| DataError::query_failed("CSV sparse checkpoint index is unavailable."))?
            .clone();
        let mut grouped = CsvSparseGroups::new();
        for (output_index, row_id) in row_ids.iter().copied().enumerate() {
            let checkpoint = checkpoints
                .iter()
                .rev()
                .find(|checkpoint| checkpoint.row <= row_id)
                .cloned();
            let key = checkpoint.as_ref().map_or(0, |value| value.row);
            grouped
                .entry(key)
                .or_insert_with(|| (checkpoint, Vec::new()))
                .1
                .push((row_id, output_index));
        }
        let mut output = vec![None; row_ids.len()];
        for (_, (checkpoint, mut targets)) in grouped {
            targets.sort_unstable_by_key(|(row, _)| *row);
            let (mut reader, mut current_row) = reader_at(&self.path, checkpoint.as_ref())?;
            if checkpoint.is_none() && self.spec.header_used {
                let mut header = ByteRecord::new();
                read_record_checked(&self.path, &mut reader, &mut header)?;
            }
            let mut record = ByteRecord::new();
            let mut target_index = 0_usize;
            while target_index < targets.len() {
                let target_row = targets[target_index].0;
                while current_row <= target_row {
                    if !read_record_checked(&self.path, &mut reader, &mut record)? {
                        return Err(DataError::invalid_request(
                            "A query source row is outside the CSV file.",
                        ));
                    }
                    if current_row == target_row {
                        break;
                    }
                    current_row += 1;
                }
                let values = selected
                    .iter()
                    .map(|(visible_index, profile)| {
                        let raw = std::str::from_utf8(
                            record.get(profile.source_index).unwrap_or_default(),
                        )
                        .map_err(|_| {
                            DataError::invalid_encoding(&self.path, reader.position().byte())
                        })?;
                        let mut value = convert_value(
                            raw,
                            query_target_type(&self.columns[*visible_index]),
                            profile,
                        );
                        if value.raw_display == value.source_display {
                            value.raw_display = None;
                        }
                        Ok(value)
                    })
                    .collect::<Result<Vec<_>, DataError>>()?;
                while target_index < targets.len() && targets[target_index].0 == target_row {
                    output[targets[target_index].1] = Some(values.clone());
                    target_index += 1;
                }
                current_row += 1;
            }
        }
        let rows = output
            .into_iter()
            .map(|row| {
                row.ok_or_else(|| DataError::query_failed("A CSV sparse row was not decoded."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(QueryExactValues {
            columns: columns.to_vec(),
            rows,
        })
    }

    fn copy_query_values(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        self.sparse_query_values(row_ids, columns)
    }
}

pub(super) fn query_target_type(column: &ColumnSchema) -> CsvTargetType {
    match column.logical_type.split('(').next().unwrap_or_default() {
        "Boolean" => CsvTargetType::Boolean,
        "Int64" => CsvTargetType::Int64,
        "UInt64" => CsvTargetType::UInt64,
        "Float64" => CsvTargetType::Float64,
        "Decimal" => CsvTargetType::Decimal,
        "Date" => CsvTargetType::Date,
        "Timestamp" => CsvTargetType::Timestamp,
        "Duration" => CsvTargetType::Duration,
        _ => CsvTargetType::Text,
    }
}

#[cfg(feature = "polars-csv-provider")]
fn polars_visible_columns(
    profile: &CsvParsingProfile,
    columns: &[ColumnSchema],
) -> Result<Vec<(usize, CsvTargetType)>, DataError> {
    let mut resolved = Vec::with_capacity(columns.len());
    let mut visible_columns = columns.iter();
    for profile in &profile.columns {
        if profile.target_type == CsvTargetType::Skip {
            continue;
        }
        let Some(column) = visible_columns.next() else {
            return Err(DataError::query_failed(
                "CSV query profile does not match its visible schema.",
            ));
        };
        resolved.push((profile.source_index, query_target_type(column)));
    }
    if visible_columns.next().is_some() {
        return Err(DataError::query_failed(
            "CSV query profile does not match its visible schema.",
        ));
    }
    Ok(resolved)
}

#[cfg(feature = "polars-csv-provider")]
fn polars_fast_lane_state(raw: &str, target: CsvTargetType) -> Option<DataValueState> {
    if matches!(raw, "NULL" | "N/A") {
        return Some(DataValueState::Null);
    }
    if raw.is_empty() {
        return Some(DataValueState::Empty);
    }
    match target {
        CsvTargetType::Auto | CsvTargetType::Text => Some(DataValueState::Valid),
        CsvTargetType::Boolean => matches!(raw, "true" | "TRUE" | "1" | "false" | "FALSE" | "0")
            .then_some(DataValueState::Valid),
        CsvTargetType::Int64 => raw.parse::<i64>().is_ok().then_some(DataValueState::Valid),
        CsvTargetType::UInt64 => raw.parse::<u64>().is_ok().then_some(DataValueState::Valid),
        CsvTargetType::Float64 => raw
            .parse::<f64>()
            .is_ok_and(f64::is_finite)
            .then_some(DataValueState::Valid),
        CsvTargetType::Decimal => exact_default_decimal(raw).then_some(DataValueState::Valid),
        CsvTargetType::Date
        | CsvTargetType::Timestamp
        | CsvTargetType::Duration
        | CsvTargetType::Skip => None,
    }
}

#[cfg(feature = "polars-csv-provider")]
fn exact_default_decimal(raw: &str) -> bool {
    let unsigned = raw.trim_start_matches(['+', '-']);
    if unsigned.is_empty() {
        return false;
    }
    let mut parts = unsigned.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();
    parts.next().is_none()
        && (!integer.is_empty() || fraction.is_some_and(|value| !value.is_empty()))
        && integer.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.is_none_or(|value| {
            !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn csv_logical_type(target: CsvTargetType, profile: &crate::domain::CsvColumnProfile) -> String {
    if target == CsvTargetType::Duration {
        let unit = profile
            .duration_unit
            .map(super::duration_unit_name)
            .unwrap_or("unknown");
        format!("Duration({unit})")
    } else {
        format!("{target:?}")
    }
}

impl TabularSource for CsvSource {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &CSV_FORMAT_DESCRIPTOR
    }

    fn query_source_spec(&self) -> Result<QuerySourceSpec, DataError> {
        let path =
            fs::canonicalize(&self.path).map_err(|error| DataError::io(&self.path, error))?;
        let summary = self.summary();
        let csv = CsvQuerySpec {
            header_used: self.header_used,
            profile: self.active_profile(),
        };
        let unsafe_headers = summary
            .csv_metadata
            .as_ref()
            .is_some_and(|metadata| metadata.header_issue_count > 0);
        let columns = summary.columns;
        Ok(QuerySourceSpec {
            path,
            columns: columns.clone(),
            total_rows: summary.row_count,
            provider: Arc::new(CsvQueryProvider {
                path: self.path.clone(),
                columns,
                spec: csv,
                checkpoints: Mutex::new(Vec::new()),
                states: Mutex::new(None),
                metrics: Mutex::new(QueryPreparationMetrics::default()),
                index_state: Arc::clone(&self.state),
                index_cancel: Arc::clone(&self.cancel),
                preparation_takeover: Arc::clone(&self.preparation_takeover),
                expected_columns: if self.header_used {
                    self.header_values.len()
                } else {
                    self.preview_max_columns
                },
                unsafe_headers,
                polars_value_compatible: AtomicBool::new(true),
                index_generation: self.generation,
                deferred_index_worker: self.file_size >= PREPARATION_COORDINATOR_FILE_THRESHOLD,
                fallback_index_started: AtomicBool::new(false),
            }),
        })
    }

    fn summary(&self) -> FileSummary {
        CsvSource::summary(self)
    }

    fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        CsvSource::read_page_projected(self, offset, limit, columns)
    }

    fn read_copy_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        if limit == 0
            || limit
                .checked_mul(columns.len())
                .is_none_or(|cells| cells > crate::domain::COPY_MAX_BATCH_CELLS)
        {
            return Err(DataError::invalid_request(
                "CSV copy batches must contain 1 to 64,000 cells.",
            ));
        }
        self.read_projected_bounded(
            offset,
            limit,
            Some(columns),
            crate::domain::COPY_MAX_BATCH_CELLS,
            self.summary().column_count,
        )
    }

    fn find_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        let key = BoundaryCacheKey::from(request);
        if let Some((_, result)) = self
            .boundary_cache
            .lock()
            .map_err(|_| DataError::io(&self.path, "CSV boundary cache is unavailable"))?
            .iter()
            .find(|(candidate, _)| candidate == &key)
        {
            return Ok(result.clone());
        }
        let result = self.find_boundary_sequential(request, cancel)?;
        if !cancel.load(Ordering::Acquire) {
            let mut cache = self
                .boundary_cache
                .lock()
                .map_err(|_| DataError::io(&self.path, "CSV boundary cache is unavailable"))?;
            if cache.len() == MAX_BOUNDARY_CACHE_ENTRIES {
                cache.pop_front();
            }
            cache.push_back((key, result.clone()));
        }
        Ok(result)
    }

    fn cancel_task(&self, generation: u64) -> Result<FileSummary, DataError> {
        self.cancel_index(generation)
    }

    fn csv_header_configurable(&self) -> Option<&dyn CsvHeaderConfigurable> {
        Some(self)
    }

    fn csv_profile_configurable(&self) -> Option<&dyn CsvProfileConfigurable> {
        Some(self)
    }
}

fn raw_strings(row: &[DataValue]) -> Vec<String> {
    row.iter()
        .map(|value| value.display.clone().unwrap_or_default())
        .collect()
}

fn csv_format_details(metadata: &CsvMetadata) -> Vec<FormatDetailsSection> {
    let suggested_header = metadata
        .suggested_header
        .map_or_else(|| String::from("unknown"), |value| value.to_string());
    vec![FormatDetailsSection {
        id: String::from("csv-parsing"),
        title: String::from("CSV parsing"),
        content: FormatDetailsContent::KeyValue {
            entries: vec![
                MetadataEntry {
                    label: String::from("Delimiter"),
                    value: metadata.delimiter.clone(),
                },
                MetadataEntry {
                    label: String::from("Encoding"),
                    value: metadata.encoding.clone(),
                },
                MetadataEntry {
                    label: String::from("Header mode"),
                    value: format!("{:?}", metadata.header_mode),
                },
                MetadataEntry {
                    label: String::from("Suggested header"),
                    value: suggested_header,
                },
                MetadataEntry {
                    label: String::from("Header used"),
                    value: metadata.header_used.to_string(),
                },
                MetadataEntry {
                    label: String::from("Structure issues"),
                    value: metadata.structure_issue_count.to_string(),
                },
            ],
        },
    }]
}

struct Preview {
    records: Vec<Vec<String>>,
    suggested_header: Option<bool>,
    header_used: bool,
}

fn scan_preview(path: &Path, header_mode: HeaderMode) -> Result<Preview, DataError> {
    let mut reader = new_reader(path)?;
    let mut record = ByteRecord::new();
    let mut first_records = Vec::with_capacity(2);
    while first_records.len() < 2 && read_record_checked(path, &mut reader, &mut record)? {
        let decoded = decode_record(path, &record, reader.position().byte())?;
        validate_preview_width(path, &decoded)?;
        first_records.push(decoded);
    }

    let suggested_header = suggest_header(first_records.first(), first_records.get(1));
    let header_used = match header_mode {
        HeaderMode::Auto => suggested_header.unwrap_or(false),
        HeaderMode::Present => !first_records.is_empty(),
        HeaderMode::Absent => false,
    };
    let mut records = Vec::new();
    let mut sample_records = 0_usize;
    let mut sample_bytes = 0_usize;
    let mut logical_records_read = first_records.len();
    for (index, decoded) in first_records.into_iter().enumerate() {
        if header_used && index == 0 {
            records.push(decoded);
        } else if !push_initial_inference_record(
            &mut records,
            decoded,
            &mut sample_records,
            &mut sample_bytes,
        ) {
            return Ok(Preview {
                records,
                suggested_header,
                header_used,
            });
        }
    }

    while sample_records < MAX_INITIAL_INFERENCE_RECORDS
        && sample_bytes < MAX_INITIAL_INFERENCE_DECODED_BYTES
    {
        let preserve_original_preview_error = logical_records_read < MAX_PAGE_SIZE + 1;
        let has_record = match read_record_checked(path, &mut reader, &mut record) {
            Ok(has_record) => has_record,
            Err(error) if preserve_original_preview_error => return Err(error),
            Err(_) => break,
        };
        if !has_record {
            break;
        }
        let decoded = match decode_record(path, &record, reader.position().byte()) {
            Ok(decoded) => decoded,
            Err(error) if preserve_original_preview_error => return Err(error),
            Err(_) => break,
        };
        if let Err(error) = validate_preview_width(path, &decoded) {
            if preserve_original_preview_error {
                return Err(error);
            }
            break;
        }
        logical_records_read += 1;
        if !push_initial_inference_record(
            &mut records,
            decoded,
            &mut sample_records,
            &mut sample_bytes,
        ) {
            break;
        }
    }
    Ok(Preview {
        records,
        suggested_header,
        header_used,
    })
}

fn validate_preview_width(path: &Path, decoded: &[String]) -> Result<(), DataError> {
    if decoded.len() > MAX_COLUMNS {
        return Err(DataError::csv_limit_exceeded(
            path,
            format!(
                "record has {} columns; maximum is {MAX_COLUMNS}",
                decoded.len()
            ),
        ));
    }
    Ok(())
}

fn push_initial_inference_record(
    records: &mut Vec<Vec<String>>,
    decoded: Vec<String>,
    sample_records: &mut usize,
    sample_bytes: &mut usize,
) -> bool {
    if *sample_records >= MAX_INITIAL_INFERENCE_RECORDS {
        return false;
    }
    let decoded_bytes = decoded
        .iter()
        .fold(0_usize, |total, field| total.saturating_add(field.len()));
    if sample_bytes.saturating_add(decoded_bytes) > MAX_INITIAL_INFERENCE_DECODED_BYTES {
        return false;
    }
    *sample_bytes = sample_bytes.saturating_add(decoded_bytes);
    *sample_records += 1;
    records.push(decoded);
    true
}

fn spawn_index_worker(
    path: PathBuf,
    header_used: bool,
    initial_columns: usize,
    generation: u64,
    state: Arc<Mutex<IndexState>>,
    cancel: Arc<AtomicBool>,
    preparation_takeover: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        // Keep the preview response observably first even for tiny files.
        thread::sleep(std::time::Duration::from_millis(5));
        let result = match acquire_worker_permit(&cancel) {
            Some(_permit) => index_file(&path, header_used, initial_columns, &state, &cancel),
            None => Err(DataError::task_cancelled()),
        };
        let Ok(mut current) = state.lock() else {
            return;
        };
        if preparation_takeover.load(Ordering::Acquire) {
            return;
        }
        if current.status.generation != generation
            || current.status.state == RowCountState::Cancelled
        {
            return;
        }
        match result {
            Ok(()) => {
                current.status.state = RowCountState::Complete;
                current.status.bytes_scanned = current.status.total_bytes;
            }
            Err(error) => {
                current.status.state = if error.code == crate::domain::DataErrorCode::TaskCancelled
                {
                    RowCountState::Cancelled
                } else {
                    RowCountState::Failed
                };
                current.status.message = Some(error.message);
            }
        }
    })
}

fn index_file(
    path: &Path,
    header_used: bool,
    initial_columns: usize,
    state: &Arc<Mutex<IndexState>>,
    cancel: &AtomicBool,
) -> Result<(), DataError> {
    let mut reader = new_reader(path)?;
    let mut record = ByteRecord::new();
    if header_used {
        read_record_checked(path, &mut reader, &mut record)?;
    }
    let mut row = 0_u64;
    let mut stride = CHECKPOINT_INTERVAL;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let position = reader.position().clone();
        if !read_record_checked(path, &mut reader, &mut record)? {
            break;
        }
        let width = record.len();
        if width > MAX_COLUMNS {
            return Err(DataError::csv_limit_exceeded(
                path,
                format!("record has {width} columns; maximum is {MAX_COLUMNS}"),
            ));
        }
        for field in record.iter() {
            std::str::from_utf8(field)
                .map_err(|_| DataError::invalid_encoding(path, position.byte()))?;
        }
        let mut current = state
            .lock()
            .map_err(|_| DataError::io(path, "CSV index state is unavailable"))?;
        record_checkpoint(&mut current.checkpoints, &mut stride, row, position);
        current.max_columns = current.max_columns.max(width);
        if width != initial_columns {
            current.structure_issue_count = current.structure_issue_count.saturating_add(1);
            if current.structure_issues.len() < MAX_STRUCTURE_ISSUES {
                current.structure_issues.push(CsvStructureIssue {
                    row: row + 1,
                    expected_columns: initial_columns,
                    actual_columns: width,
                });
            }
        }
        row += 1;
        current.status.rows_scanned = row;
        current.status.bytes_scanned = reader.position().byte();
    }
    Ok(())
}

fn record_checkpoint(
    checkpoints: &mut Vec<Checkpoint>,
    stride: &mut u64,
    row: u64,
    position: Position,
) {
    if !row.is_multiple_of(*stride) {
        return;
    }
    checkpoints.push(Checkpoint { row, position });
    if checkpoints.len() > MAX_CHECKPOINTS {
        *checkpoints = checkpoints.iter().step_by(2).cloned().collect();
        *stride = stride.saturating_mul(2);
    }
}

fn new_reader(path: &Path) -> Result<Reader<BufReader<File>>, DataError> {
    let file = File::open(path).map_err(|error| DataError::io(path, error))?;
    Ok(new_reader_from_file(file))
}

fn new_reader_from_file(file: File) -> Reader<BufReader<File>> {
    ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(BufReader::new(file))
}

fn reader_at(
    path: &Path,
    checkpoint: Option<&Checkpoint>,
) -> Result<(Reader<BufReader<File>>, u64), DataError> {
    let mut reader = new_reader(path)?;
    let row = if let Some(checkpoint) = checkpoint {
        reader
            .seek(checkpoint.position.clone())
            .map_err(|error| DataError::invalid_csv(path, error))?;
        checkpoint.row
    } else {
        0
    };
    Ok((reader, row))
}

fn read_record_checked(
    path: &Path,
    reader: &mut Reader<BufReader<File>>,
    record: &mut ByteRecord,
) -> Result<bool, DataError> {
    let start = reader.position().byte();
    let has_record = reader
        .read_byte_record(record)
        .map_err(|error| DataError::invalid_csv(path, error))?;
    let bytes = reader.position().byte().saturating_sub(start);
    if bytes > MAX_RECORD_BYTES {
        return Err(DataError::csv_limit_exceeded(
            path,
            format!("logical record is {bytes} bytes; maximum is {MAX_RECORD_BYTES}"),
        ));
    }
    Ok(has_record)
}

fn decode_record(
    path: &Path,
    record: &ByteRecord,
    byte_offset: u64,
) -> Result<Vec<String>, DataError> {
    record
        .iter()
        .map(|field| {
            std::str::from_utf8(field)
                .map(str::to_owned)
                .map_err(|_| DataError::invalid_encoding(path, byte_offset))
        })
        .collect()
}

fn validate_bom(path: &Path) -> Result<(), DataError> {
    let mut prefix = [0_u8; 3];
    let count = File::open(path)
        .map_err(|error| DataError::io(path, error))?
        .read(&mut prefix)
        .map_err(|error| DataError::io(path, error))?;
    if count >= 2 && prefix[..2] == [0xff, 0xfe] {
        return Err(DataError::unsupported_encoding(path, "UTF-16LE"));
    }
    if count >= 2 && prefix[..2] == [0xfe, 0xff] {
        return Err(DataError::unsupported_encoding(path, "UTF-16BE"));
    }
    Ok(())
}

fn has_utf8_bom(path: &Path) -> bool {
    let mut prefix = [0_u8; 3];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut prefix))
        .is_ok()
        && prefix == [0xef, 0xbb, 0xbf]
}

fn suggest_header(first: Option<&Vec<String>>, second: Option<&Vec<String>>) -> Option<bool> {
    let first = first?;
    if first.is_empty() {
        return Some(false);
    }
    let mut unique = std::collections::HashSet::new();
    if first
        .iter()
        .any(|value| value.is_empty() || !unique.insert(value))
    {
        return Some(false);
    }
    let identifiers = first.iter().all(|value| {
        value
            .chars()
            .next()
            .is_some_and(|ch| ch.is_alphabetic() || ch == '_')
            && value
                .chars()
                .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == ' ' || ch == '-')
    });
    if !identifiers {
        return Some(false);
    }
    let second_looks_data =
        second.is_some_and(|record| record.iter().any(|value| value.parse::<f64>().is_ok()));
    Some(
        second_looks_data
            || first.iter().any(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "id" | "name" | "age" | "city" | "date" | "timestamp" | "value"
                )
            }),
    )
}

struct HeaderAudit {
    raw_headers: Vec<String>,
    raw_headers_truncated: bool,
    header_issue_count: usize,
    header_issues: Vec<CsvHeaderIssue>,
}

fn build_columns(headers: &[String], count: usize) -> (Vec<ColumnSchema>, HeaderAudit) {
    let mut used = std::collections::HashMap::<String, usize>::new();
    let mut header_issue_count = 0;
    let mut header_issues = Vec::new();
    let columns = (0..count)
        .map(|index| {
            let header = headers.get(index);
            let original = header.cloned().unwrap_or_default();
            let blank = header.is_some_and(String::is_empty);
            let raw = if header.is_none() || blank {
                format!("Column {}", index + 1)
            } else {
                original.clone()
            };
            // Compatibility-view internals own the `__dv_*` namespace. Give
            // an untrusted source header a stable visible alias instead of
            // allowing it to shadow row identity, state, raw, or value fields.
            let raw = if raw.starts_with("__dv_") {
                format!("{raw} (source)")
            } else {
                raw
            };
            let occurrence = used
                .entry(raw.clone())
                .and_modify(|value| *value += 1)
                .or_insert(1);
            let name = if *occurrence == 1 {
                raw
            } else {
                format!("{raw} ({occurrence})")
            };
            let reason = if blank {
                Some(CsvHeaderIssueReason::Blank)
            } else if header.is_some() && *occurrence > 1 {
                Some(CsvHeaderIssueReason::Duplicate)
            } else {
                None
            };
            if let Some(reason) = reason {
                header_issue_count += 1;
                if header_issues.len() < MAX_HEADER_AUDIT_ITEMS {
                    header_issues.push(CsvHeaderIssue {
                        column_index: index,
                        raw_name: truncate_chars(&original, MAX_HEADER_AUDIT_CHARS),
                        resolved_name: truncate_chars(&name, MAX_HEADER_AUDIT_CHARS),
                        reason,
                    });
                }
            }
            ColumnSchema {
                name,
                logical_type: String::from("String"),
                nullable: false,
                physical_type: String::from("UTF8"),
            }
        })
        .collect();
    let raw_headers_truncated = headers.len() > MAX_HEADER_AUDIT_ITEMS
        || headers
            .iter()
            .take(MAX_HEADER_AUDIT_ITEMS)
            .any(|header| header.chars().count() > MAX_HEADER_AUDIT_CHARS);
    let raw_headers = headers
        .iter()
        .take(MAX_HEADER_AUDIT_ITEMS)
        .map(|header| truncate_chars(header, MAX_HEADER_AUDIT_CHARS))
        .collect();
    (
        columns,
        HeaderAudit {
            raw_headers,
            raw_headers_truncated,
            header_issue_count,
            header_issues,
        },
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn projection_indices(
    schema: &[ColumnSchema],
    requested: Option<&[String]>,
) -> Result<Vec<usize>, DataError> {
    match requested {
        None => Ok((0..schema.len()).collect()),
        Some(columns) => projection_indices_bounded(schema, Some(columns), MAX_PROJECTION_COLUMNS),
    }
}

fn projection_indices_bounded(
    schema: &[ColumnSchema],
    requested: Option<&[String]>,
    max_columns: usize,
) -> Result<Vec<usize>, DataError> {
    match requested {
        None => Ok((0..schema.len()).collect()),
        Some(columns) => {
            if columns.is_empty() {
                return Err(DataError::invalid_request(
                    "Column projection must contain at least one column.",
                ));
            }
            if columns.len() > max_columns {
                return Err(DataError::invalid_request(format!(
                    "Column projection cannot exceed {max_columns} columns."
                )));
            }
            let mut seen = HashSet::with_capacity(columns.len());
            columns
                .iter()
                .map(|name| {
                    if !seen.insert(name.as_str()) {
                        return Err(DataError::invalid_request(format!(
                            "Column projection contains duplicate column: {name}"
                        )));
                    }
                    schema
                        .iter()
                        .position(|column| column.name == *name)
                        .ok_or_else(|| {
                            DataError::invalid_request(format!("Unknown projection column: {name}"))
                        })
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;
    use std::{
        fs,
        io::{BufWriter, Write},
        time::{Duration, Instant},
    };

    fn wait_complete(source: &CsvSource) -> FileSummary {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let summary = source.summary();
            if summary.row_count_status.state != RowCountState::Calculating {
                return summary;
            }
            assert!(Instant::now() < deadline, "CSV worker timed out");
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn boundary_request(
        row: u64,
        direction: DataBoundaryDirection,
        mode: DataBoundaryMode,
    ) -> BoundarySearchRequest {
        BoundarySearchRequest {
            row,
            column_id: String::from("column_000"),
            visible_column_ids: vec![String::from("column_000")],
            direction,
            mode,
        }
    }

    #[test]
    fn csv_boundary_text_fast_path_matches_converted_value_state() {
        let mut profile = crate::domain::CsvColumnProfile::new(
            0,
            String::from("column_000"),
            CsvTargetType::Text,
        );
        for raw in ["", "NULL", "N/A", "x", "  x  "] {
            assert_eq!(
                csv_boundary_occupied(raw, CsvTargetType::Text, &profile),
                super::super::boundary::occupied(
                    convert_value(raw, CsvTargetType::Text, &profile).state
                ),
                "{raw:?}",
            );
        }
        profile.trim = true;
        for raw in ["   ", " NULL ", " x "] {
            assert_eq!(
                csv_boundary_occupied(raw, CsvTargetType::Text, &profile),
                super::super::boundary::occupied(
                    convert_value(raw, CsvTargetType::Text, &profile).state
                ),
                "{raw:?}",
            );
        }
    }

    #[test]
    fn csv_sequential_boundary_handles_regions_reverse_and_unknown_eof() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("boundary.csv");
        fs::write(
            &path,
            "column_000,column_001,column_002\nx,x,\ny,,x\n\"\"\n\"\"\nx\ny\n",
        )
        .unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        wait_complete(&source);
        let cancel = AtomicBool::new(false);

        let down = source
            .find_boundary_sequential(
                &boundary_request(
                    0,
                    DataBoundaryDirection::Down,
                    DataBoundaryMode::DataBoundary,
                ),
                &cancel,
            )
            .unwrap();
        assert_eq!(down.target_row, 1);
        let cached_request = boundary_request(
            0,
            DataBoundaryDirection::Down,
            DataBoundaryMode::DataBoundary,
        );
        assert_eq!(
            source.find_boundary(&cached_request, &cancel).unwrap(),
            down
        );
        assert_eq!(
            source.find_boundary(&cached_request, &cancel).unwrap(),
            down
        );
        assert_eq!(source.boundary_cache.lock().unwrap().len(), 1);
        let next_region = source
            .find_boundary_sequential(
                &boundary_request(
                    1,
                    DataBoundaryDirection::Down,
                    DataBoundaryMode::DataBoundary,
                ),
                &cancel,
            )
            .unwrap();
        assert_eq!(next_region.target_row, 4);
        let up = source
            .find_boundary_sequential(
                &boundary_request(4, DataBoundaryDirection::Up, DataBoundaryMode::DataBoundary),
                &cancel,
            )
            .unwrap();
        assert_eq!(up.target_row, 1);

        let right = source
            .find_boundary_sequential(
                &BoundarySearchRequest {
                    row: 0,
                    column_id: String::from("column_000"),
                    visible_column_ids: vec![
                        String::from("column_000"),
                        String::from("column_001"),
                        String::from("column_002"),
                    ],
                    direction: DataBoundaryDirection::Right,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &cancel,
            )
            .unwrap();
        assert_eq!(right.target_column_id, "column_001");
        let left = source
            .find_boundary_sequential(
                &BoundarySearchRequest {
                    row: 0,
                    column_id: String::from("column_002"),
                    visible_column_ids: vec![
                        String::from("column_000"),
                        String::from("column_001"),
                        String::from("column_002"),
                    ],
                    direction: DataBoundaryDirection::Left,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &cancel,
            )
            .unwrap();
        assert_eq!(left.target_column_id, "column_001");

        let unknown = CsvSource::open(&path, HeaderMode::Present).unwrap();
        unknown.cancel_index(unknown.generation).unwrap();
        let eof = unknown
            .find_boundary_sequential(
                &boundary_request(
                    0,
                    DataBoundaryDirection::Down,
                    DataBoundaryMode::TableBoundary,
                ),
                &cancel,
            )
            .unwrap();
        assert_eq!(eof.target_row, 5);
        assert_eq!(eof.resolved_row_count, Some(6));
    }

    #[test]
    fn csv_sequential_boundary_finds_250k_last_row_in_one_pass() {
        const ROWS: u64 = 250_000;
        const COLUMNS: usize = 40;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large-csv.csv");
        let file = File::create(&path).unwrap();
        let mut writer = BufWriter::new(file);
        writeln!(
            writer,
            "{}",
            (0..COLUMNS)
                .map(|index| format!("column_{index:03}"))
                .collect::<Vec<_>>()
                .join(",")
        )
        .unwrap();
        let record = vec!["x"; COLUMNS].join(",");
        for _ in 0..ROWS {
            writeln!(writer, "{record}").unwrap();
        }
        writer.flush().unwrap();

        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        source.cancel_index(source.generation).unwrap();
        let started = Instant::now();
        let result = source
            .find_boundary_sequential(
                &boundary_request(
                    0,
                    DataBoundaryDirection::Down,
                    DataBoundaryMode::DataBoundary,
                ),
                &AtomicBool::new(false),
            )
            .unwrap();
        let elapsed = started.elapsed();
        eprintln!("250k x 40 CSV boundary elapsed: {elapsed:?}");
        assert_eq!(result.target_row, ROWS - 1);
        assert_eq!(result.resolved_row_count, Some(ROWS));
        assert!(elapsed < Duration::from_secs(10), "elapsed: {elapsed:?}");

        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_signal = Arc::clone(&cancel);
        let canceller = thread::spawn(move || {
            thread::sleep(Duration::from_millis(1));
            cancel_signal.store(true, Ordering::Release);
        });
        let error = source
            .find_boundary_sequential(
                &boundary_request(
                    0,
                    DataBoundaryDirection::Down,
                    DataBoundaryMode::DataBoundary,
                ),
                &cancel,
            )
            .unwrap_err();
        canceller.join().unwrap();
        assert_eq!(error.code, crate::domain::DataErrorCode::TaskCancelled);
    }

    #[test]
    fn utf8_bom_quotes_empty_values_and_paging_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("values.csv");
        fs::write(&path, b"\xef\xbb\xbfname,note,empty\r\nAlice,\"comma, value\",\r\nBob,\"line1\nline2 and \"\"quote\"\"\",\r\n").unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        let summary = wait_complete(&source);
        assert_eq!(summary.row_count, Some(2));
        assert_eq!(summary.csv_metadata.unwrap().encoding, "utf-8-bom");
        let page = source.read_page_projected(0, 200, None).unwrap();
        assert_eq!(page.rows[0][1].display.as_deref(), Some("comma, value"));
        assert_eq!(
            page.rows[1][1].display.as_deref(),
            Some("line1\nline2 and \"quote\"")
        );
        assert_eq!(page.rows[0][2].display.as_deref(), Some(""));
        assert!(page
            .rows
            .iter()
            .flatten()
            .all(|value| value.kind == ValueKind::String));
    }

    #[test]
    fn integer_thousands_separators_format_applied_pages() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("grouped.csv");
        fs::write(&path, "amount\n10001\n2\n1000\n").unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        wait_complete(&source);
        let mut profile = source.active_profile();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        profile.columns[0].target_type = CsvTargetType::UInt64;
        for (separator, expected) in [
            (",", ["10,001", "2", "1,000"]),
            (".", ["10.001", "2", "1.000"]),
            (" ", ["10 001", "2", "1 000"]),
        ] {
            profile.columns[0].thousand_separator = Some(String::from(separator));
            let prepared = source.prepare_profile(&profile).unwrap();
            let page = prepared.read_page_projected(0, 200, None).unwrap();
            let values = page
                .rows
                .iter()
                .map(|row| row[0].display.as_deref().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(values, expected, "separator: {separator:?}");
        }
    }

    #[test]
    fn absent_header_keeps_the_first_record_and_projection_order() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("no-header.csv");
        fs::write(&path, "1,A\n2,B\n3,C\n").unwrap();
        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        let summary = wait_complete(&source);
        assert_eq!(summary.csv_metadata.unwrap().header_issue_count, 0);
        let columns = vec![String::from("Column 2"), String::from("Column 1")];
        let page = source.read_page_projected(1, 1, Some(&columns)).unwrap();
        assert_eq!(page.columns, columns);
        assert_eq!(page.rows[0][0].display.as_deref(), Some("B"));
        assert_eq!(page.rows[0][1].display.as_deref(), Some("2"));
    }

    #[test]
    fn initial_auto_inference_uses_exactly_10000_data_records_with_or_without_header() {
        let directory = tempfile::tempdir().unwrap();
        for (name, header, expected_header_used) in [
            ("present", Some("bounded,late\n"), true),
            ("absent", None, false),
        ] {
            let path = directory.path().join(format!("initial-{name}.csv"));
            let mut writer = BufWriter::new(File::create(&path).unwrap());
            if let Some(header) = header {
                writer.write_all(header.as_bytes()).unwrap();
            }
            for row in 0..MAX_INITIAL_INFERENCE_RECORDS {
                if row + 1 == MAX_INITIAL_INFERENCE_RECORDS {
                    writer.write_all(b"2,late\n").unwrap();
                } else {
                    writer.write_all(b"2,2\n").unwrap();
                }
            }
            writer.write_all(b"excluded,2\n").unwrap();
            writer.flush().unwrap();

            let source = CsvSource::open(&path, HeaderMode::Auto).unwrap();
            assert_eq!(source.profile.mode, CsvProfileMode::Auto);
            assert_eq!(source.header_used, expected_header_used, "{name}");
            assert_eq!(source.inferences[0].non_null_samples, 10_000, "{name}");
            assert_eq!(source.inferences[1].non_null_samples, 10_000, "{name}");
            assert_eq!(
                source.inferences[0].recommended_type,
                CsvTargetType::UInt64,
                "the 10,001st record must not affect inference ({name})"
            );
            assert_eq!(
                source.inferences[1].recommended_type,
                CsvTargetType::Text,
                "the 10,000th record must affect inference ({name})"
            );
        }
    }

    #[test]
    fn initial_inference_decoded_byte_cap_includes_exact_8_mib_and_excludes_overflow() {
        let directory = tempfile::tempdir().unwrap();
        let half = MAX_INITIAL_INFERENCE_DECODED_BYTES / 2;
        for (name, header_mode, header) in [
            ("present", HeaderMode::Present, Some("value\n")),
            ("absent", HeaderMode::Absent, None),
        ] {
            let path = directory.path().join(format!("byte-cap-{name}.csv"));
            let mut writer = BufWriter::new(File::create(&path).unwrap());
            if let Some(header) = header {
                writer.write_all(header.as_bytes()).unwrap();
            }
            writer.write_all(&vec![b'x'; half]).unwrap();
            writer.write_all(b"\n").unwrap();
            writer.write_all(&vec![b'y'; half]).unwrap();
            writer.write_all(b"\nexcluded\n").unwrap();
            writer.flush().unwrap();

            let preview = scan_preview(&path, header_mode).unwrap();
            let data = &preview.records[usize::from(preview.header_used)..];
            assert_eq!(data.len(), 2, "{name}");
            assert_eq!(
                data.iter()
                    .flat_map(|row| row.iter())
                    .map(String::len)
                    .sum::<usize>(),
                MAX_INITIAL_INFERENCE_DECODED_BYTES,
                "{name}"
            );
        }

        let overflow = directory.path().join("byte-cap-overflow.csv");
        let mut writer = BufWriter::new(File::create(&overflow).unwrap());
        writer
            .write_all(&vec![b'x'; MAX_INITIAL_INFERENCE_DECODED_BYTES - 1])
            .unwrap();
        writer.write_all(b"\nyy\n").unwrap();
        writer.flush().unwrap();
        let preview = scan_preview(&overflow, HeaderMode::Absent).unwrap();
        assert_eq!(preview.records.len(), 1);
        assert_eq!(preview.records[0][0].len(), 8 * 1024 * 1024 - 1);
    }

    #[test]
    fn initial_inference_counts_quoted_newlines_as_one_logical_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("quoted-logical-records.csv");
        let mut writer = BufWriter::new(File::create(&path).unwrap());
        for row in 0..=MAX_INITIAL_INFERENCE_RECORDS {
            writeln!(writer, "\"row-{row}\ncontinued\",2").unwrap();
        }
        writer.flush().unwrap();

        let preview = scan_preview(&path, HeaderMode::Absent).unwrap();
        assert_eq!(preview.records.len(), MAX_INITIAL_INFERENCE_RECORDS);
        assert_eq!(preview.records[9_999][0], "row-9999\ncontinued");
    }

    #[test]
    fn initial_inference_stops_before_unbounded_input_or_later_invalid_data() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bounded-initial-sample.csv");
        let mut writer = BufWriter::new(File::create(&path).unwrap());
        for _ in 0..MAX_INITIAL_INFERENCE_RECORDS {
            writer.write_all(b"2,value\n").unwrap();
        }
        writer.write_all(b"\xff,not-scanned\n").unwrap();
        for _ in 0..100_000 {
            writer.write_all(b"3,later-data\n").unwrap();
        }
        writer.flush().unwrap();

        let preview = scan_preview(&path, HeaderMode::Absent).unwrap();
        assert_eq!(preview.records.len(), MAX_INITIAL_INFERENCE_RECORDS);
        let retained_bytes = preview
            .records
            .iter()
            .flat_map(|row| row.iter())
            .map(String::len)
            .sum::<usize>();
        assert!(retained_bytes < fs::metadata(&path).unwrap().len() as usize / 10);
    }

    #[test]
    fn invalid_and_unsupported_encodings_are_typed() {
        let directory = tempfile::tempdir().unwrap();
        let invalid = directory.path().join("invalid.csv");
        fs::write(&invalid, [b'a', b'\n', 0xff, b'\n']).unwrap();
        assert_eq!(
            CsvSource::open(&invalid, HeaderMode::Absent)
                .unwrap_err()
                .code,
            crate::domain::DataErrorCode::InvalidEncoding
        );
        let utf16 = directory.path().join("utf16.csv");
        fs::write(&utf16, [0xff, 0xfe, b'a', 0]).unwrap();
        assert_eq!(
            CsvSource::open(&utf16, HeaderMode::Absent)
                .unwrap_err()
                .code,
            crate::domain::DataErrorCode::UnsupportedEncoding
        );
    }

    #[test]
    fn inconsistent_width_is_padded_and_reported() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("width.csv");
        fs::write(&path, "a,b\n1\n2,3,4\n").unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        let summary = wait_complete(&source);
        assert_eq!(summary.column_count, 3);
        assert_eq!(summary.csv_metadata.unwrap().structure_issue_count, 2);
        let page = source.read_page_projected(0, 200, None).unwrap();
        assert_eq!(page.rows[0].len(), 3);
        assert_eq!(page.rows[0][2].display.as_deref(), Some(""));
    }

    #[test]
    fn header_reconfigure_increments_generation_and_changes_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("header.csv");
        fs::write(&path, "name,age\nAlice,30\n").unwrap();
        let mut source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        assert_eq!(
            source.read_page_projected(0, 1, None).unwrap().rows[0][0]
                .display
                .as_deref(),
            Some("Alice")
        );
        source.configure_header(HeaderMode::Absent).unwrap();
        assert_eq!(source.summary().row_count_status.generation, 2);
        assert_eq!(
            source.read_page_projected(0, 1, None).unwrap().rows[0][0]
                .display
                .as_deref(),
            Some("name")
        );
    }

    #[test]
    fn empty_file_is_valid_and_completes_with_zero_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.csv");
        fs::write(&path, []).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Auto).unwrap();
        let summary = wait_complete(&source);
        assert_eq!(summary.row_count, Some(0));
        assert_eq!(summary.column_count, 0);
        assert!(source
            .read_page_projected(0, 200, None)
            .unwrap()
            .rows
            .is_empty());
    }

    #[test]
    fn record_and_column_limits_are_typed_errors() {
        let directory = tempfile::tempdir().unwrap();
        let wide = directory.path().join("wide.csv");
        fs::write(
            &wide,
            std::iter::repeat_n("x", MAX_COLUMNS + 1)
                .collect::<Vec<_>>()
                .join(","),
        )
        .unwrap();
        assert_eq!(
            CsvSource::open(&wide, HeaderMode::Absent).unwrap_err().code,
            crate::domain::DataErrorCode::CsvLimitExceeded
        );

        let large = directory.path().join("large.csv");
        fs::write(
            &large,
            format!("{}\n", "x".repeat(MAX_RECORD_BYTES as usize)),
        )
        .unwrap();
        assert_eq!(
            CsvSource::open(&large, HeaderMode::Absent)
                .unwrap_err()
                .code,
            crate::domain::DataErrorCode::CsvLimitExceeded
        );
    }

    #[test]
    fn status_progress_and_cancel_have_one_terminal_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("many.csv");
        let contents = (0..30_000)
            .map(|row| format!("{row},value-{row}\n"))
            .collect::<String>();
        fs::write(&path, contents).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        let initial = source.summary();
        assert_eq!(initial.row_count, None);
        assert_eq!(initial.row_count_status.state, RowCountState::Calculating);
        let cancelled = source
            .cancel_index(initial.row_count_status.generation)
            .unwrap();
        assert!(matches!(
            cancelled.row_count_status.state,
            RowCountState::Cancelled | RowCountState::Complete
        ));
        thread::sleep(Duration::from_millis(20));
        assert!(matches!(
            source.summary().row_count_status.state,
            RowCountState::Cancelled | RowCountState::Complete
        ));
    }

    #[test]
    fn logical_record_limit_accepts_minus_one_and_exact_and_rejects_plus_one() {
        let directory = tempfile::tempdir().unwrap();
        for size in [MAX_RECORD_BYTES - 1, MAX_RECORD_BYTES] {
            let path = directory.path().join(format!("record-{size}.csv"));
            fs::write(&path, vec![b'x'; size as usize]).unwrap();
            let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
            assert_eq!(
                source.read_page_projected(0, 1, None).unwrap().rows.len(),
                1
            );
        }
        let path = directory.path().join("record-too-large.csv");
        fs::write(&path, vec![b'x'; MAX_RECORD_BYTES as usize + 1]).unwrap();
        assert_eq!(
            CsvSource::open(&path, HeaderMode::Absent).unwrap_err().code,
            crate::domain::DataErrorCode::CsvLimitExceeded
        );
    }

    #[test]
    fn column_limit_accepts_minus_one_and_exact_and_rejects_plus_one() {
        let directory = tempfile::tempdir().unwrap();
        for count in [MAX_COLUMNS - 1, MAX_COLUMNS] {
            let path = directory.path().join(format!("columns-{count}.csv"));
            fs::write(
                &path,
                std::iter::repeat_n("x", count)
                    .collect::<Vec<_>>()
                    .join(","),
            )
            .unwrap();
            let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
            assert_eq!(source.summary().column_count, count);
            assert_eq!(
                source.read_page_projected(0, 1, None).unwrap().rows[0].len(),
                count
            );
        }
        let path = directory.path().join("columns-too-wide.csv");
        fs::write(
            &path,
            std::iter::repeat_n("x", MAX_COLUMNS + 1)
                .collect::<Vec<_>>()
                .join(","),
        )
        .unwrap();
        assert_eq!(
            CsvSource::open(&path, HeaderMode::Absent).unwrap_err().code,
            crate::domain::DataErrorCode::CsvLimitExceeded
        );
    }

    #[test]
    fn ambiguous_auto_header_is_data_until_explicitly_overridden() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ambiguous.csv");
        fs::write(&path, "alpha,beta\ngamma,delta\n").unwrap();
        let mut source = CsvSource::open(&path, HeaderMode::Auto).unwrap();
        let metadata = source.summary().csv_metadata.unwrap();
        assert_eq!(metadata.suggested_header, Some(false));
        assert!(!metadata.header_used);
        assert_eq!(
            source.read_page_projected(0, 1, None).unwrap().rows[0][0]
                .display
                .as_deref(),
            Some("alpha")
        );

        source.configure_header(HeaderMode::Present).unwrap();
        assert!(source.summary().csv_metadata.unwrap().header_used);
        assert_eq!(
            source.read_page_projected(0, 1, None).unwrap().rows[0][0]
                .display
                .as_deref(),
            Some("gamma")
        );
    }

    #[test]
    fn raw_blank_duplicate_and_long_headers_are_audited_with_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("header-audit.csv");
        let long = "z".repeat(MAX_HEADER_AUDIT_CHARS + 20);
        fs::write(&path, format!("name,,name,{long}\nA,B,C,D\n")).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        let summary = source.summary();
        assert_eq!(summary.columns[0].name, "name");
        assert_eq!(summary.columns[1].name, "Column 2");
        assert_eq!(summary.columns[2].name, "name (2)");
        let metadata = summary.csv_metadata.unwrap();
        assert_eq!(metadata.raw_header_count, 4);
        assert_eq!(metadata.raw_headers[0], "name");
        assert_eq!(metadata.raw_headers[1], "");
        assert_eq!(metadata.raw_headers[2], "name");
        assert!(metadata.raw_headers_truncated);
        assert_eq!(metadata.header_issue_count, 2);
        assert_eq!(
            metadata.header_issues[0].reason,
            CsvHeaderIssueReason::Blank
        );
        assert_eq!(
            metadata.header_issues[1].reason,
            CsvHeaderIssueReason::Duplicate
        );
        assert_eq!(metadata.header_issues[1].raw_name, "name");
        assert_eq!(metadata.header_issues[1].resolved_name, "name (2)");
        assert!(metadata.raw_headers[3].chars().count() <= MAX_HEADER_AUDIT_CHARS);
    }

    #[test]
    fn progress_is_monotonic_and_complete_reports_exact_totals() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("progress.csv");
        let row_count = 300_000_u64;
        let contents = (0..row_count)
            .map(|row| format!("{row},value-{row}\n"))
            .collect::<String>();
        fs::write(&path, contents).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        let mut snapshots = Vec::new();
        loop {
            let status = source.summary().row_count_status;
            snapshots.push((status.rows_scanned, status.bytes_scanned));
            if status.state != RowCountState::Calculating {
                assert_eq!(status.state, RowCountState::Complete);
                assert_eq!(status.rows_scanned, row_count);
                assert_eq!(status.bytes_scanned, status.total_bytes);
                break;
            }
            thread::yield_now();
        }
        assert!(snapshots
            .windows(2)
            .all(|pair| pair[0].0 <= pair[1].0 && pair[0].1 <= pair[1].1));
        assert!(snapshots
            .iter()
            .any(|(rows, _)| *rows > 0 && *rows < row_count));
    }

    #[test]
    fn page_007_sparse_query_uses_checkpoints_and_preserves_order_profile_and_empty_states() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("query-sparse.csv");
        let mut contents = String::from("amount,text\n");
        for row in 0..5_000_u64 {
            let line = match row {
                0 => String::from("1,alpha\n"),
                2 => String::from("NULL,\n"),
                4_096 => String::from("bad,z\n"),
                4_097 => String::from("4,tail\n"),
                _ => format!("{row},mid\n"),
            };
            contents.push_str(&line);
        }
        fs::write(&path, contents).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        wait_complete(&source);
        let mut profile = source.active_profile();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        profile.columns[0].target_type = CsvTargetType::Int64;
        profile.columns[1].target_type = CsvTargetType::Text;
        let source = source.prepare_profile(&profile).unwrap();
        let spec = source.query_source_spec().unwrap();
        let connection = Connection::open_in_memory().unwrap();
        let cancel = AtomicBool::new(false);
        let mut progress = |_| Ok(());
        spec.provider
            .prepare(QueryPrepareContext {
                connection: &connection,
                source: &spec,
                source_file: None,
                artifact_directory: directory.path(),
                cancel: &cancel,
                progress: &mut progress,
            })
            .unwrap();

        let sparse = spec
            .provider
            .sparse_query_values(
                &[4_097, 0, 2, 4_096],
                &[String::from("amount"), String::from("text")],
            )
            .unwrap();
        assert_eq!(sparse.columns, ["amount", "text"]);
        assert_eq!(sparse.rows[0][0].display.as_deref(), Some("4"));
        assert_eq!(sparse.rows[0][1].display.as_deref(), Some("tail"));
        assert_eq!(sparse.rows[1][0].display.as_deref(), Some("1"));
        assert_eq!(sparse.rows[1][1].display.as_deref(), Some("alpha"));
        assert_eq!(sparse.rows[2][0].state, DataValueState::Null);
        assert_eq!(sparse.rows[2][0].raw_display.as_deref(), Some("NULL"));
        assert_eq!(sparse.rows[2][1].state, DataValueState::Empty);
        assert_eq!(sparse.rows[3][0].state, DataValueState::Invalid);
        assert_eq!(sparse.rows[3][0].raw_display.as_deref(), Some("bad"));
        assert_eq!(sparse.rows[3][1].display.as_deref(), Some("z"));

        let bulk = source
            .read_copy_projected(0, 5_000, &[String::from("amount")])
            .unwrap();
        assert_eq!(bulk.rows.len(), 5_000);
        assert_eq!(bulk.rows[0][0].display.as_deref(), Some("1"));
        assert_eq!(bulk.rows[2][0].state, DataValueState::Null);
        assert_eq!(bulk.rows[4_096][0].state, DataValueState::Invalid);
        assert_eq!(bulk.rows[4_999][0].display.as_deref(), Some("4999"));
        assert_eq!(
            source.read_page_projected(0, 201, None).unwrap_err().code,
            crate::domain::DataErrorCode::InvalidRequest
        );
    }

    #[cfg(feature = "polars-csv-provider")]
    #[test]
    fn polars_visible_columns_precompute_source_indexes_and_resolved_targets() {
        let profile = CsvParsingProfile {
            mode: CsvProfileMode::Custom,
            generation: 1,
            columns: vec![
                crate::domain::CsvColumnProfile::new(
                    0,
                    String::from("count"),
                    CsvTargetType::Int64,
                ),
                crate::domain::CsvColumnProfile::new(
                    1,
                    String::from("ignored"),
                    CsvTargetType::Skip,
                ),
                crate::domain::CsvColumnProfile::new(
                    2,
                    String::from("amount"),
                    CsvTargetType::Decimal,
                ),
            ],
        };
        let columns = vec![
            ColumnSchema {
                name: String::from("count"),
                logical_type: String::from("Int64"),
                nullable: true,
                physical_type: String::from("Int64"),
            },
            ColumnSchema {
                name: String::from("amount"),
                logical_type: String::from("Decimal"),
                nullable: true,
                physical_type: String::from("Utf8"),
            },
        ];
        assert_eq!(
            polars_visible_columns(&profile, &columns).unwrap(),
            vec![(0, CsvTargetType::Int64), (2, CsvTargetType::Decimal)]
        );
    }

    #[cfg(feature = "polars-csv-provider")]
    #[test]
    fn polars_state_only_gate_matches_rust_and_rejects_uncertain_values() {
        let cases = [
            (
                CsvTargetType::Text,
                " any whitespace \n",
                Some(DataValueState::Valid),
            ),
            (CsvTargetType::Boolean, "true", Some(DataValueState::Valid)),
            (CsvTargetType::Boolean, "FALSE", Some(DataValueState::Valid)),
            (CsvTargetType::Boolean, "True", None),
            (CsvTargetType::Boolean, " yes ", None),
            (
                CsvTargetType::Int64,
                "-9223372036854775808",
                Some(DataValueState::Valid),
            ),
            (CsvTargetType::Int64, "9223372036854775808", None),
            (
                CsvTargetType::UInt64,
                "18446744073709551615",
                Some(DataValueState::Valid),
            ),
            (CsvTargetType::UInt64, "-1", None),
            (
                CsvTargetType::Float64,
                "1.25e3",
                Some(DataValueState::Valid),
            ),
            (CsvTargetType::Float64, "NaN", None),
            (CsvTargetType::Float64, "inf", None),
            (CsvTargetType::Float64, "1e9999", None),
            (
                CsvTargetType::Decimal,
                "+0.000",
                Some(DataValueState::Valid),
            ),
            (
                CsvTargetType::Decimal,
                "-123456789012345678901234567890.123456789",
                Some(DataValueState::Valid),
            ),
            (CsvTargetType::Decimal, ".5", Some(DataValueState::Valid)),
            (CsvTargetType::Decimal, "1e3", None),
            (CsvTargetType::Decimal, "1.", None),
            (CsvTargetType::Decimal, "huge", None),
        ];
        for (target, raw, expected) in cases {
            let profile = crate::domain::CsvColumnProfile::new(0, String::from("value"), target);
            let rust_state = convert_value_for_query(raw, target, &profile).state;
            assert_eq!(
                polars_fast_lane_state(raw, target),
                expected,
                "target={target:?} raw={raw:?}"
            );
            if let Some(expected) = expected {
                assert_eq!(rust_state, expected, "target={target:?} raw={raw:?}");
            } else if !(target == CsvTargetType::Boolean && raw == "True") {
                assert_eq!(rust_state, DataValueState::Invalid);
            } else {
                assert_eq!(rust_state, DataValueState::Valid);
            }
            for (special, state) in [
                ("", DataValueState::Empty),
                ("NULL", DataValueState::Null),
                ("N/A", DataValueState::Null),
            ] {
                assert_eq!(polars_fast_lane_state(special, target), Some(state));
            }
        }
    }

    #[cfg(feature = "polars-csv-provider")]
    #[test]
    fn polars_provider_publishes_compact_v3_view_with_rust_state_parity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("polars-provider.csv");
        fs::write(&path, "number,text\nNULL,alpha\nN/A,beta\n5,gamma\n7,\n").unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        wait_complete(&source);
        let mut profile = source.active_profile();
        profile.mode = CsvProfileMode::Custom;
        profile.generation += 1;
        profile.columns[0].target_type = CsvTargetType::Int64;
        profile.columns[1].target_type = CsvTargetType::Text;
        let source = source.prepare_profile(&profile).unwrap();
        let columns = source.summary().columns;
        let provider = Arc::new(CsvQueryProvider {
            path: path.clone(),
            columns: columns.clone(),
            spec: CsvQuerySpec {
                header_used: true,
                profile: source.active_profile(),
            },
            checkpoints: Mutex::new(Vec::new()),
            states: Mutex::new(None),
            metrics: Mutex::new(QueryPreparationMetrics {
                csv_preparation_provider: Some("polars"),
                ..QueryPreparationMetrics::default()
            }),
            index_state: Arc::clone(&source.state),
            index_cancel: Arc::clone(&source.cancel),
            preparation_takeover: Arc::clone(&source.preparation_takeover),
            expected_columns: 2,
            unsafe_headers: false,
            polars_value_compatible: AtomicBool::new(true),
            index_generation: source.generation,
            deferred_index_worker: false,
            fallback_index_started: AtomicBool::new(false),
        });
        let spec = QuerySourceSpec {
            path: fs::canonicalize(&path).unwrap(),
            columns,
            total_rows: Some(4),
            provider: provider.clone(),
        };
        let artifacts = directory.path().join("cache");
        fs::create_dir(&artifacts).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        let pinned = File::open(&path).unwrap();
        let cancel = AtomicBool::new(false);
        let mut progress = |_| Ok(());
        provider
            .prepare_with_polars(QueryPrepareContext {
                connection: &connection,
                source: &spec,
                source_file: Some(&pinned),
                artifact_directory: &artifacts,
                cancel: &cancel,
                progress: &mut progress,
            })
            .unwrap();
        let metrics = provider.preparation_metrics();
        assert_eq!(metrics.csv_preparation_provider, Some("polars"));
        assert!(!artifacts
            .join(crate::data::csv_polars::SOURCE_SNAPSHOT_NAME)
            .exists());
        assert_eq!(
            metrics.source_read_bytes,
            fs::metadata(&path).unwrap().len() * 2
        );

        let mut statement = connection
            .prepare(
                "SELECT __dv_row_id, number, __dv_raw_0, __dv_invalid_0, text \
                 FROM dv_source ORDER BY __dv_row_id",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (0, None, String::from("NULL"), false, String::from("alpha")),
                (1, None, String::from("N/A"), false, String::from("beta")),
                (
                    2,
                    Some(String::from("5")),
                    String::from("5"),
                    false,
                    String::from("gamma")
                ),
                (
                    3,
                    Some(String::from("7")),
                    String::from("7"),
                    false,
                    String::new()
                ),
            ]
        );
        let parquet = artifacts
            .join("prepared.parquet")
            .to_string_lossy()
            .replace('\\', "/");
        let physical_sql = format!(
            "SELECT * FROM read_parquet('{}')",
            parquet.replace('\'', "''")
        );
        let mut physical_statement = connection.prepare(&physical_sql).unwrap();
        let physical_rows = physical_statement.query([]).unwrap();
        let fields = physical_rows.as_ref().unwrap().column_count();
        drop(physical_rows);
        let (count, states): (u64, String) = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*), string_agg(CAST(__dv_state_word_0 AS VARCHAR), ',' ORDER BY __dv_row_id) \
                     FROM read_parquet('{}')",
                    parquet.replace('\'', "''")
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 4);
        assert_eq!(fields, 5);
        assert_eq!(states, "1,1,0,8");
    }

    #[cfg(feature = "polars-csv-provider")]
    #[test]
    #[ignore = "requires PHASE15_LARGE_CSV; classifier/provider routing regression"]
    fn high_decimal_fixture_selects_polars_without_fallback_reason() {
        let path = std::env::var_os("PHASE15_LARGE_CSV")
            .map(PathBuf::from)
            .expect("PHASE15_LARGE_CSV is required");
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        let spec = source.query_source_spec().unwrap();
        let amount = spec
            .columns
            .iter()
            .find(|column| column.name == "amount")
            .expect("high fixture amount column");
        assert_eq!(query_target_type(amount), CsvTargetType::Decimal);

        let artifacts = tempfile::tempdir().unwrap();
        let connection = Connection::open_in_memory().unwrap();
        let cancel = AtomicBool::new(true);
        let mut progress = |_| Ok(());
        let error = spec
            .provider
            .prepare(QueryPrepareContext {
                connection: &connection,
                source: &spec,
                source_file: None,
                artifact_directory: artifacts.path(),
                cancel: &cancel,
                progress: &mut progress,
            })
            .unwrap_err();
        assert_eq!(error.code, crate::domain::DataErrorCode::TaskCancelled);
        let metrics = spec.provider.preparation_metrics();
        assert_eq!(metrics.csv_preparation_provider, Some("polars"));
        assert_eq!(metrics.csv_classifier_reason, None);
    }

    #[test]
    fn csv011_preview_sampling_uses_logical_rows_and_the_distributed_formula() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preview-sampling.csv");
        let logical_row_count = 1_200_u64;
        let contents = (0..logical_row_count)
            .map(|row| format!("\"row-{row}\ncontinued\",value-{row}\n"))
            .collect::<String>();
        fs::write(&path, contents).unwrap();

        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        assert_eq!(wait_complete(&source).row_count, Some(logical_row_count));

        let profile = source.active_profile();
        let preview = source
            .preview_profile(&profile, profile.generation, &AtomicBool::new(false))
            .unwrap();
        let source_rows = preview
            .rows
            .iter()
            .map(|row| row.source_row)
            .collect::<Vec<_>>();

        let distributed_count = logical_row_count.min(600);
        let mut expected = (0_u64..400)
            .chain(
                (0..distributed_count)
                    .map(|index| index * (logical_row_count - 1) / (distributed_count - 1)),
            )
            .collect::<Vec<_>>();
        expected.sort_unstable();
        expected.dedup();
        expected.truncate(1_000);

        assert_eq!(preview.stage, CsvPreviewStage::Distributed);
        assert_eq!(&source_rows[..400], &(0_u64..400).collect::<Vec<_>>());
        assert_eq!(source_rows, expected);
        assert!(preview.rows.len() <= 1_000);
        assert_eq!(preview.rows.len(), 800);
        assert_eq!(preview.rows[399].cells[0].raw, "row-399\ncontinued");
    }

    #[test]
    fn auto_fractional_profile_rejects_conflicting_separators_before_preview_and_apply() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auto-fractional-conflict.csv");
        fs::write(&path, "amount\n1.5\n2.5\n").unwrap();
        let source = CsvSource::open(&path, HeaderMode::Present).unwrap();
        let mut profile = source.active_profile();
        profile.generation += 1;
        profile.mode = CsvProfileMode::Custom;
        profile.columns[0].target_type = CsvTargetType::Auto;
        profile.columns[0].decimal_separator = String::from(".");
        profile.columns[0].thousand_separator = Some(String::from("."));

        for error in [
            source
                .preview_profile(&profile, profile.generation, &AtomicBool::new(false))
                .unwrap_err(),
            source.prepare_profile(&profile).unwrap_err(),
        ] {
            assert_eq!(error.code, crate::domain::DataErrorCode::InvalidRequest);
            assert!(error
                .message
                .contains("Decimal and thousand separators must differ for column 'amount'"));
        }
    }

    #[test]
    fn checkpoint_neighbors_random_access_partial_last_and_eof_are_exact() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("checkpoints.csv");
        let row_count = 20_003_u64;
        fs::write(
            &path,
            (0..row_count)
                .map(|row| format!("{row},row-{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        assert_eq!(wait_complete(&source).row_count, Some(row_count));
        for offset in [
            0, 1, 4_095, 4_096, 4_097, 8_191, 8_192, 16_383, 16_384, 19_999,
        ] {
            let page = source.read_page_projected(offset, 2, None).unwrap();
            assert_eq!(
                page.rows[0][0].display.as_deref(),
                Some(offset.to_string().as_str())
            );
            assert_eq!(
                page.rows[1][0].display.as_deref(),
                Some((offset + 1).to_string().as_str())
            );
        }
        let last = source.read_page_projected(20_000, 200, None).unwrap();
        assert_eq!(last.rows.len(), 3);
        assert!(!last.has_more);
        for offset in [row_count, row_count + 1] {
            let eof = source.read_page_projected(offset, 200, None).unwrap();
            assert!(eof.rows.is_empty());
            assert!(!eof.has_more);
            assert_eq!(eof.columns.len(), 2);
        }
    }

    #[test]
    fn checkpoint_compaction_remains_bounded_and_searchable() {
        let mut checkpoints = Vec::new();
        let mut stride = CHECKPOINT_INTERVAL;
        for candidate in 0..(MAX_CHECKPOINTS as u64 * 4) {
            let row = candidate * CHECKPOINT_INTERVAL;
            let mut position = Position::new();
            position.set_byte(row * 8);
            record_checkpoint(&mut checkpoints, &mut stride, row, position);
            assert!(checkpoints.len() <= MAX_CHECKPOINTS);
        }
        assert!(stride > CHECKPOINT_INTERVAL);
        assert!(checkpoints.windows(2).all(|pair| pair[0].row < pair[1].row));
        let target = checkpoints[checkpoints.len() / 2].row + 1;
        let nearest = checkpoints
            .iter()
            .rev()
            .find(|checkpoint| checkpoint.row <= target)
            .unwrap();
        assert!(nearest.row <= target);
        assert!(target - nearest.row <= stride);
    }

    #[test]
    fn configure_waits_for_the_previous_worker_to_terminate() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("replace-worker.csv");
        fs::write(
            &path,
            (0..200_000)
                .map(|row| format!("{row},v\n"))
                .collect::<String>(),
        )
        .unwrap();
        let mut source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        let previous_state = Arc::clone(&source.state);
        source.configure_header(HeaderMode::Present).unwrap();
        let previous = previous_state.lock().unwrap();
        assert_ne!(previous.status.state, RowCountState::Calculating);
        assert_eq!(source.summary().row_count_status.generation, 2);
    }

    #[test]
    fn invalid_data_in_expanded_inference_keeps_preview_then_worker_reports_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("background-failure.csv");
        let mut bytes = (0..250)
            .map(|row| format!("{row},valid\n"))
            .collect::<String>()
            .into_bytes();
        bytes.extend_from_slice(b"250,\xff\n");
        fs::write(&path, bytes).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
        assert_eq!(source.inferences[0].non_null_samples, 250);
        assert_eq!(source.inferences[1].non_null_samples, 250);
        let preview = source.read_page_projected(0, 200, None).unwrap();
        assert_eq!(preview.rows.len(), 200);
        let failed = wait_complete(&source);
        assert_eq!(failed.row_count_status.state, RowCountState::Failed);
        assert_eq!(failed.row_count, None);
        assert!(failed
            .row_count_status
            .message
            .as_deref()
            .is_some_and(|message| message.contains("UTF-8")));
    }

    #[test]
    fn phase3_generated_fixtures_match_the_expected_golden_contract() {
        let fixture_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/phase-3");
        let golden: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture_root.join("expected-golden.json")).unwrap())
                .unwrap();
        for expected in golden.as_array().unwrap() {
            let file = expected["file"].as_str().unwrap();
            let mode = match expected["headerMode"].as_str().unwrap() {
                "auto" => HeaderMode::Auto,
                "present" => HeaderMode::Present,
                "absent" => HeaderMode::Absent,
                other => panic!("unknown header mode {other}"),
            };
            let opened = CsvSource::open(fixture_root.join(file), mode);
            if let Some(expected_error) = expected
                .get("expectedError")
                .and_then(serde_json::Value::as_str)
            {
                assert_eq!(
                    format!("{:?}", opened.unwrap_err().code),
                    expected_error,
                    "{file}"
                );
                continue;
            }
            let source = opened.unwrap_or_else(|error| panic!("{file}: {error}"));
            let summary = wait_complete(&source);
            let expected_state = expected["state"].as_str().unwrap();
            let actual_state = match summary.row_count_status.state {
                RowCountState::Calculating => "calculating",
                RowCountState::Complete => "complete",
                RowCountState::Cancelled => "cancelled",
                RowCountState::Failed => "failed",
            };
            assert_eq!(actual_state, expected_state, "{file}");
            assert_eq!(summary.row_count, expected["rowCount"].as_u64(), "{file}");
            assert_eq!(
                summary.column_count as u64,
                expected["columnCount"].as_u64().unwrap(),
                "{file}"
            );
            let metadata = summary.csv_metadata.as_ref().unwrap();
            if let Some(value) = expected.get("headerUsed") {
                assert_eq!(metadata.header_used, value.as_bool().unwrap(), "{file}");
            }
            if let Some(value) = expected.get("suggestedHeader") {
                assert_eq!(metadata.suggested_header, value.as_bool(), "{file}");
            }
            if let Some(value) = expected.get("structureIssueCount") {
                assert_eq!(
                    metadata.structure_issue_count,
                    value.as_u64().unwrap(),
                    "{file}"
                );
            }
            if let Some(value) = expected.get("headerIssueCount") {
                assert_eq!(
                    metadata.header_issue_count as u64,
                    value.as_u64().unwrap(),
                    "{file}"
                );
            }
            if let Some(names) = expected
                .get("columnNames")
                .and_then(serde_json::Value::as_array)
            {
                let actual = summary
                    .columns
                    .iter()
                    .map(|column| column.name.as_str())
                    .collect::<Vec<_>>();
                let expected = names
                    .iter()
                    .map(|name| name.as_str().unwrap())
                    .collect::<Vec<_>>();
                assert_eq!(actual, expected, "{file}");
            }
            if let Some(row) = expected
                .get("firstRow")
                .and_then(serde_json::Value::as_array)
            {
                let page = source.read_page_projected(0, 1, None).unwrap();
                let actual = page
                    .rows
                    .first()
                    .map(|values| {
                        values
                            .iter()
                            .map(|value| value.display.as_deref().unwrap())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let expected = row
                    .iter()
                    .map(|value| value.as_str().unwrap())
                    .collect::<Vec<_>>();
                assert_eq!(actual, expected, "{file}");
            }
        }
    }

    #[test]
    fn deferred_index_worker_falls_back_when_preparation_cannot_start() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deferred-index.csv");
        let mut contents = String::from("value\n");
        for row in 0..5_000 {
            contents.push_str(&format!("value-{row}\n"));
        }
        fs::write(&path, contents).unwrap();
        let bytes = fs::metadata(&path).unwrap().len();
        let columns = vec![ColumnSchema {
            name: String::from("value"),
            logical_type: String::from("Utf8"),
            nullable: true,
            physical_type: String::from("BYTE_ARRAY"),
        }];
        let state = Arc::new(Mutex::new(IndexState {
            status: RowCountStatus {
                state: RowCountState::Calculating,
                rows_scanned: 0,
                bytes_scanned: 0,
                total_bytes: bytes,
                generation: 1,
                message: None,
            },
            checkpoints: Vec::new(),
            structure_issue_count: 0,
            structure_issues: Vec::new(),
            max_columns: 1,
        }));
        let provider = CsvQueryProvider {
            path: path.clone(),
            columns: columns.clone(),
            spec: CsvQuerySpec {
                header_used: true,
                profile: default_profile(CsvProfileMode::Auto, 1, &columns),
            },
            checkpoints: Mutex::new(Vec::new()),
            states: Mutex::new(None),
            metrics: Mutex::new(QueryPreparationMetrics::default()),
            index_state: Arc::clone(&state),
            index_cancel: Arc::new(AtomicBool::new(false)),
            preparation_takeover: Arc::new(AtomicBool::new(false)),
            expected_columns: 1,
            unsafe_headers: false,
            polars_value_compatible: AtomicBool::new(true),
            index_generation: 1,
            deferred_index_worker: true,
            fallback_index_started: AtomicBool::new(false),
        };

        provider.preparation_aborted();
        provider.preparation_aborted();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let status = state.lock().unwrap().status.clone();
            if status.state != RowCountState::Calculating {
                assert_eq!(status.state, RowCountState::Complete);
                assert_eq!(status.rows_scanned, 5_000);
                assert_eq!(status.bytes_scanned, bytes);
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn adaptive_prepared_batch_sizer_grows_and_shrinks_at_measured_byte_gates() {
        let mut sizer = AdaptivePreparedBatchSizer::default();
        assert_eq!(sizer.target_rows, 16_384);
        assert_eq!(
            sizer.observe(16_384, 1024 * 1024, 1024 * 1024),
            std::cmp::Ordering::Greater
        );
        assert_eq!(sizer.target_rows, 32_768);
        assert_eq!(
            sizer.observe(32_768, 2 * 1024 * 1024, 2 * 1024 * 1024),
            std::cmp::Ordering::Greater
        );
        assert_eq!(sizer.target_rows, 65_536);
        assert_eq!(
            sizer.observe(20_000, 24 * 1024 * 1024, 23 * 1024 * 1024),
            std::cmp::Ordering::Less
        );
        assert_eq!(sizer.target_rows, 32_768);
        assert_eq!(
            sizer.observe(20_000, 47 * 1024 * 1024, 10 * 1024 * 1024),
            std::cmp::Ordering::Less
        );
        assert_eq!(sizer.target_rows, 16_384);
    }
}
