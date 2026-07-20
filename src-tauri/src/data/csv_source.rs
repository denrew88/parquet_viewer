use crate::domain::{
    BoundarySearchRequest, BoundarySearchResult, ColumnSchema, CsvColumnInference,
    CsvColumnValidation, CsvHeaderIssue, CsvHeaderIssueReason, CsvMetadata, CsvParsingProfile,
    CsvPreviewCell, CsvPreviewColumn, CsvPreviewRow, CsvPreviewStage, CsvProfileMode,
    CsvProfilePreview, CsvStructureIssue, CsvTargetType, CsvValidationErrorSample,
    DataBoundaryDirection, DataBoundaryMode, DataError, DataFormat, DataPage, DataValue,
    DataValueState, FileSummary, FormatDescriptor, FormatDetailsContent, FormatDetailsSection,
    HeaderMode, MetadataEntry, RowCountState, RowCountStatus, SourceCapability, ValueKind,
};
use csv::{ByteRecord, Position, Reader, ReaderBuilder};
use duckdb::{appender_params_from_iter, types::Value};
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use super::csv_profile::{
    convert_value, convert_value_for_query, default_profile, format_numeric_display, infer_columns,
    normalize_profile, resolved_type, validate_resolved_profile,
};
use super::{
    query_invalid_name, query_quote_identifier, query_raw_name, CsvHeaderConfigurable,
    CsvProfileConfigurable, CsvQuerySpec, CsvValidationProgress, FormatHandler, QueryInputProvider,
    QueryPrepareContext, QuerySourceSpec, TabularSource,
};

pub const MAX_PAGE_SIZE: usize = 200;
pub const MAX_COLUMNS: usize = 4_096;
pub const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_PROFILE_SAMPLE_BYTES: usize = 4 * 1024 * 1024;
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

        let preview = scan_preview(path)?;
        let suggested_header = suggest_header(preview.records.first(), preview.records.get(1));
        let header_used = match header_mode {
            HeaderMode::Auto => suggested_header.unwrap_or(false),
            HeaderMode::Present => !preview.records.is_empty(),
            HeaderMode::Absent => false,
        };
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
        let sample_rows = preview
            .records
            .iter()
            .skip(usize::from(header_used))
            .cloned()
            .collect::<Vec<_>>();
        let inferences = infer_columns(&initial_columns, &sample_rows);
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
        let worker = spawn_index_worker(
            path.to_path_buf(),
            header_used,
            expected_columns,
            generation,
            Arc::clone(&state),
            Arc::clone(&cancel),
        );

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
            worker: Some(worker),
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
                logical_type: format!("{target:?}"),
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
        if !(1..=MAX_PAGE_SIZE).contains(&limit) {
            return Err(DataError::invalid_request(
                "Page limit must be between 1 and 200 rows.",
            ));
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
            current_row += 1;
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
        let selected = projection_indices(&visible_schema, requested)?;
        let selected_profiles = selected
            .iter()
            .map(|index| visible[*index])
            .collect::<Vec<_>>();
        let raw_names = selected_profiles
            .iter()
            .map(|(column, _)| column.source_name.clone())
            .collect::<Vec<_>>();
        let read_all_raw = requested.is_none();
        let mut page = self.raw_read_page_projected(
            offset,
            limit,
            (!read_all_raw).then_some(raw_names.as_slice()),
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
            if row % BOUNDARY_CANCEL_INTERVAL == 0 && cancel.load(Ordering::Acquire) {
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
    spec: CsvQuerySpec,
}

impl QueryInputProvider for CsvQueryProvider {
    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
        let mut schema = vec![String::from("__dv_row_id UBIGINT")];
        for (index, column) in context.source.columns.iter().enumerate() {
            schema.push(format!("{} VARCHAR", query_quote_identifier(&column.name)));
            schema.push(format!("{} VARCHAR", query_raw_name(index)));
            schema.push(format!("{} BOOLEAN", query_invalid_name(index)));
        }
        context
            .connection
            .execute_batch(&format!("CREATE TABLE dv_source ({})", schema.join(", ")))
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        let mut reader = ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_path(&context.source.path)
            .map_err(|error| DataError::invalid_csv(&context.source.path, error))?;
        let mut appender = context
            .connection
            .appender("dv_source")
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        let mut source_row = 0_u64;
        for (physical_row, record) in reader.byte_records().enumerate() {
            if context.cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            if physical_row % CHECKPOINT_INTERVAL as usize == 0 {
                (context.progress)(source_row)?;
            }
            let record =
                record.map_err(|error| DataError::invalid_csv(&context.source.path, error))?;
            if self.spec.header_used && physical_row == 0 {
                continue;
            }
            let mut values = Vec::with_capacity(1 + context.source.columns.len() * 3);
            values.push(Value::UBigInt(source_row));
            let mut visible_index = 0_usize;
            for profile in &self.spec.profile.columns {
                if profile.target_type == CsvTargetType::Skip {
                    continue;
                }
                let column = context.source.columns.get(visible_index).ok_or_else(|| {
                    DataError::query_failed("CSV query profile does not match its visible schema.")
                })?;
                let raw_bytes = record.get(profile.source_index).unwrap_or_default();
                let raw = std::str::from_utf8(raw_bytes)
                    .map_err(|error| DataError::invalid_csv(&context.source.path, error))?;
                let converted = convert_value_for_query(raw, query_target_type(column), profile);
                values.push(converted.display.clone().map_or(Value::Null, Value::Text));
                values.push(
                    converted
                        .raw_display
                        .clone()
                        .map_or(Value::Null, Value::Text),
                );
                values.push(Value::Boolean(converted.state == DataValueState::Invalid));
                visible_index += 1;
            }
            if visible_index != context.source.columns.len() {
                return Err(DataError::query_failed(
                    "CSV query profile does not cover its visible schema.",
                ));
            }
            appender
                .append_row(appender_params_from_iter(values.iter()))
                .map_err(|error| DataError::query_failed(error.to_string()))?;
            source_row = source_row.saturating_add(1);
        }
        appender
            .flush()
            .map_err(|error| DataError::query_failed(error.to_string()))
    }

    fn format_query_display(&self, column: &str, kind: ValueKind, value: &str) -> String {
        self.spec
            .profile
            .columns
            .iter()
            .find(|profile| profile.source_name == column)
            .map_or_else(
                || value.to_owned(),
                |profile| format_numeric_display(value, kind, profile),
            )
    }
}

fn query_target_type(column: &ColumnSchema) -> CsvTargetType {
    match column.logical_type.as_str() {
        "Boolean" => CsvTargetType::Boolean,
        "Int64" => CsvTargetType::Int64,
        "UInt64" => CsvTargetType::UInt64,
        "Float64" => CsvTargetType::Float64,
        "Decimal" => CsvTargetType::Decimal,
        "Date" => CsvTargetType::Date,
        "Timestamp" => CsvTargetType::Timestamp,
        _ => CsvTargetType::Text,
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
        Ok(QuerySourceSpec {
            path,
            columns: summary.columns,
            total_rows: summary.row_count,
            provider: Arc::new(CsvQueryProvider { spec: csv }),
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
}

fn scan_preview(path: &Path) -> Result<Preview, DataError> {
    let mut reader = new_reader(path)?;
    let mut records = Vec::new();
    let mut record = ByteRecord::new();
    while records.len() < MAX_PAGE_SIZE + 1 && read_record_checked(path, &mut reader, &mut record)?
    {
        let decoded = decode_record(path, &record, reader.position().byte())?;
        if decoded.len() > MAX_COLUMNS {
            return Err(DataError::csv_limit_exceeded(
                path,
                format!(
                    "record has {} columns; maximum is {MAX_COLUMNS}",
                    decoded.len()
                ),
            ));
        }
        records.push(decoded);
    }
    Ok(Preview { records })
}

fn spawn_index_worker(
    path: PathBuf,
    header_used: bool,
    initial_columns: usize,
    generation: u64,
    state: Arc<Mutex<IndexState>>,
    cancel: Arc<AtomicBool>,
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
    if row % *stride != 0 {
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
    Ok(ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(BufReader::new(file)))
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
        Some(columns) => {
            if columns.is_empty() {
                return Err(DataError::invalid_request(
                    "Column projection must contain at least one column.",
                ));
            }
            if columns.len() > MAX_PROJECTION_COLUMNS {
                return Err(DataError::invalid_request(format!(
                    "Column projection cannot exceed {MAX_PROJECTION_COLUMNS} columns."
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
    fn invalid_data_after_preview_transitions_worker_to_failed_without_losing_preview() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("background-failure.csv");
        let mut bytes = (0..250)
            .map(|row| format!("{row},valid\n"))
            .collect::<String>()
            .into_bytes();
        bytes.extend_from_slice(b"251,\xff\n");
        fs::write(&path, bytes).unwrap();
        let source = CsvSource::open(&path, HeaderMode::Absent).unwrap();
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
}
