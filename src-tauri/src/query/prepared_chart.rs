//! Sequential projected reads over the committed prepared CSV artifact.
use std::{fs::File, path::PathBuf, sync::OnceLock, time::Duration};

use arrow_array::{
    Array, BooleanArray, Float64Array, Int64Array, RecordBatch, StringViewArray, UInt64Array,
};
use arrow_schema::{DataType, Schema};
use parquet::{
    arrow::{
        arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder},
        ProjectionMask,
    },
    basic::Encoding,
    file::metadata::ParquetMetaData,
};

use super::*;
use crate::query::chart::{ChartCell, ChartRowVisitor, ProjectedChartSource};

const CANDIDATE_ROWS: usize = 262_144;
const CANCEL_ROWS: usize = 4_096;
const BATCH_BYTES: usize = COPY_MAX_BATCH_ESTIMATED_BYTES;
const DECODER_GROUP_BYTES: usize = 16 * 1024 * 1024;
const MAX_ROW_GROUP_ROWS: usize = 65_536;
const ARRAY_OVERHEAD_BYTES: usize = 1_024;
const MAX_COLUMNS: usize = 64;

struct PreparedChartSource {
    task: Arc<CsvPreparation>,
    path: PathBuf,
    columns: HashMap<String, Option<PhysicalColumn>>,
    artifact: OnceLock<PinnedArtifact>,
}

struct PinnedArtifact {
    path: PathBuf,
    fingerprint: SourceFingerprint,
    _artifact: Arc<CsvPreparedArtifact>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Integer,
    Unsigned,
    Float,
    Boolean,
    Text,
}

struct PhysicalColumn {
    field: String,
    source_index: usize,
    kind: Kind,
}

impl QueryService {
    pub(crate) fn prepared_chart_source(
        &self,
        document_id: &str,
        session_id: &str,
        source: QuerySourceSpec,
    ) -> Result<Option<Arc<dyn ProjectedChartSource>>, DataError> {
        let Some(identity) = source.provider.reusable_source_identity() else {
            return Ok(None);
        };
        let Some(source_width) = source.provider.csv_source_column_count() else {
            return Ok(None);
        };
        let key = (document_id.to_owned(), session_id.to_owned());
        let Some(task) = self
            .csv_preparations
            .lock()
            .map_err(|_| registry_error())?
            .get(&key)
            .filter(|task| task.identity == identity)
            .cloned()
        else {
            return Ok(None);
        };
        if !matches!(
            preparation_status(&task)?.state,
            CsvPreparationState::Preparing | CsvPreparationState::Ready
        ) {
            return Ok(None);
        }
        let sql_columns = source.provider.sql_input_columns(&source)?;
        if sql_columns.len() != source.columns.len() {
            return Ok(None);
        }
        let physical = source.provider.csv_prepared_physical_columns();
        let columns = source
            .columns
            .iter()
            .zip(sql_columns)
            .map(|(column, sql)| {
                let mapping = (sql.source_index < source_width)
                    .then(|| physical_column(column, &sql, &physical))
                    .flatten();
                (column.name.clone(), mapping)
            })
            .collect::<HashMap<_, _>>();
        if !columns.values().any(Option::is_some) {
            return Ok(None);
        }
        if !csv_preparation_is_current(self, &key, &task)? {
            return Err(DataError::task_cancelled());
        }
        Ok(Some(Arc::new(PreparedChartSource {
            task,
            path: source.path,
            columns,
            artifact: OnceLock::new(),
        })))
    }
}

fn physical_column(
    column: &ColumnSchema,
    sql: &crate::data::SqlInputColumn,
    physical: &[crate::data::CsvPreparedPhysicalColumn],
) -> Option<PhysicalColumn> {
    let stored = physical
        .iter()
        .find(|entry| entry.source_index == sql.source_index);
    let kind = match (value_kind(column), sql.sql_type.as_str()) {
        (ValueKind::Int, "BIGINT") => Kind::Integer,
        (ValueKind::Int, "UBIGINT") => Kind::Unsigned,
        (ValueKind::Float, "DOUBLE") => Kind::Float,
        (ValueKind::Boolean, "BOOLEAN") => Kind::Boolean,
        (ValueKind::String, "VARCHAR") => Kind::Text,
        _ => return None,
    };
    let field = match (kind, stored) {
        (Kind::Text, None) => format!("__dv_base_raw_{}", sql.source_index),
        (Kind::Text, Some(stored)) if stored.physical_kind == "normalizedText" => {
            stored.field.clone()
        }
        (kind, Some(stored)) if kind != Kind::Text && stored.physical_kind == "nativeValue" => {
            stored.field.clone()
        }
        _ => return None,
    };
    Some(PhysicalColumn {
        field,
        source_index: sql.source_index,
        kind,
    })
}

impl PreparedChartSource {
    fn check_current(&self, check: &dyn Fn() -> Result<(), DataError>) -> Result<(), DataError> {
        check()?;
        if self.task.cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        Ok(())
    }

    fn ready_artifact(
        &self,
        check: &dyn Fn() -> Result<(), DataError>,
    ) -> Result<Option<&PinnedArtifact>, DataError> {
        check()?;
        if let Some(artifact) = self.artifact.get() {
            self.check_current(check)?;
            return Ok(Some(artifact));
        }
        loop {
            check()?;
            if self.task.cancel.load(Ordering::Acquire) {
                return Ok(None);
            }
            let status = self.task.status.lock().map_err(|_| registry_error())?;
            if status.state != CsvPreparationState::Preparing {
                if status.state != CsvPreparationState::Ready {
                    return Ok(None);
                }
                break;
            }
            let (guard, _) = self
                .task
                .terminal
                .wait_timeout(status, Duration::from_millis(25))
                .map_err(|_| registry_error())?;
            // The caller may check the document registry. Never take that
            // lock while the preparation status lock is held.
            drop(guard);
        }
        check()?;
        if self.task.cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        let artifact = self
            .task
            .artifact
            .lock()
            .map_err(|_| registry_error())?
            .as_ref()
            .cloned()
            .ok_or_else(DataError::task_cancelled)?;
        // A restored catalog is temporary, but its Parquet stays in the
        // persistent cache. A non-published preparation has both in its lease.
        let directory = artifact
            ._persistent_lease
            .as_ref()
            .map_or_else(|| artifact._lease.path(), |lease| lease.path());
        let path = directory.join("prepared.parquet");
        let fingerprint = source_fingerprint(&path)?;
        Ok(Some(self.artifact.get_or_init(|| PinnedArtifact {
            path,
            fingerprint,
            _artifact: artifact,
        })))
    }
}

impl ProjectedChartSource for PreparedChartSource {
    fn visit(
        &self,
        columns: &[String],
        requires_exact_text: &[bool],
        check: &dyn Fn() -> Result<(), DataError>,
        visit: &mut ChartRowVisitor<'_>,
    ) -> Result<bool, DataError> {
        check()?;
        if columns.is_empty()
            || columns.len() > MAX_COLUMNS
            || columns.len() != requires_exact_text.len()
        {
            return Err(DataError::invalid_request(
                "Invalid prepared chart projection.",
            ));
        }
        let Some(columns) = columns
            .iter()
            .zip(requires_exact_text)
            .map(|(name, exact)| {
                self.columns
                    .get(name)?
                    .as_ref()
                    .filter(|column| column.kind != Kind::Float || !exact)
            })
            .collect::<Option<Vec<_>>>()
        else {
            return Ok(false);
        };
        if source_fingerprint(&self.path)? != self.task.source_fingerprint {
            return Err(csv_changed());
        }
        let Some(artifact) = self.ready_artifact(check)? else {
            check()?;
            if source_fingerprint(&self.path)? != self.task.source_fingerprint {
                return Err(csv_changed());
            }
            return Ok(false);
        };
        if source_fingerprint(&self.path)? != self.task.source_fingerprint {
            return Err(csv_changed());
        }
        let file =
            File::open(&artifact.path).map_err(|error| DataError::io(&artifact.path, error))?;
        if source_fingerprint_pinned(&artifact.path, Some(&file))? != artifact.fingerprint {
            return Err(artifact_changed());
        }
        let metadata =
            ArrowReaderMetadata::load(&file, ArrowReaderOptions::new()).map_err(parquet_error)?;
        let Some(scan) = Scan::plan(metadata, &columns, CANDIDATE_ROWS)? else {
            self.check_current(check)?;
            return Ok(false);
        };
        if scan.row_count != artifact._artifact.row_count {
            return Err(artifact_changed());
        }
        let scan_file = file
            .try_clone()
            .map_err(|error| DataError::io(&artifact.path, error))?;
        let complete = scan.visit(scan_file, &|| self.check_current(check), visit)?;
        self.check_current(check)?;
        if source_fingerprint(&self.path)? != self.task.source_fingerprint {
            return Err(csv_changed());
        }
        if !source_fingerprint_matches(&artifact.path, Some(&file), &artifact.fingerprint)? {
            return Err(artifact_changed());
        }
        self.check_current(check)?;
        Ok(complete)
    }
}

struct ColumnSlot {
    value: usize,
    state: usize,
    shift: usize,
    kind: Kind,
}

struct Scan {
    metadata: ArrowReaderMetadata,
    projection: ProjectionMask,
    columns: Vec<ColumnSlot>,
    row_id: usize,
    row_count: u64,
    batch_rows: usize,
}

impl Scan {
    fn plan(
        metadata: ArrowReaderMetadata,
        columns: &[&PhysicalColumn],
        candidate_rows: usize,
    ) -> Result<Option<Self>, DataError> {
        let schema = metadata.schema();
        if schema.fields().len() != metadata.parquet_schema().num_columns() {
            return Ok(None);
        }
        let Ok(row_id) = schema.index_of("__dv_row_id") else {
            return Ok(None);
        };
        if schema.field(row_id).data_type() != &DataType::UInt64 {
            return Ok(None);
        }
        let mut projection = vec![row_id];
        let mut text = Vec::new();
        let mut slots = Vec::with_capacity(columns.len());
        for column in columns {
            let Ok(value) = schema.index_of(&column.field) else {
                return Ok(None);
            };
            let Ok(state) =
                schema.index_of(&format!("__dv_state_word_{}", column.source_index / 32))
            else {
                return Ok(None);
            };
            let supported = match column.kind {
                Kind::Integer => schema.field(value).data_type() == &DataType::Int64,
                Kind::Unsigned => schema.field(value).data_type() == &DataType::UInt64,
                Kind::Float => schema.field(value).data_type() == &DataType::Float64,
                Kind::Boolean => schema.field(value).data_type() == &DataType::Boolean,
                Kind::Text => matches!(
                    schema.field(value).data_type(),
                    DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View
                ),
            };
            if !supported || schema.field(state).data_type() != &DataType::UInt64 {
                return Ok(None);
            }
            projection.extend([value, state]);
            if column.kind == Kind::Text {
                text.push(value);
            }
            slots.push(ColumnSlot {
                value,
                state,
                shift: (column.source_index % 32) * 2,
                kind: column.kind,
            });
        }
        projection.sort_unstable();
        projection.dedup();
        text.sort_unstable();
        text.dedup();
        let Some(batch_rows) = admit_batch(
            metadata.metadata(),
            &projection,
            &text,
            schema.as_ref(),
            candidate_rows,
        ) else {
            return Ok(None);
        };
        let position = |index| {
            projection
                .binary_search(&index)
                .expect("projected chart slot")
        };
        for slot in &mut slots {
            slot.value = position(slot.value);
            slot.state = position(slot.state);
        }
        let row_id = position(row_id);
        let row_count = u64::try_from(metadata.metadata().file_metadata().num_rows())
            .map_err(|_| artifact_changed())?;
        let mask = ProjectionMask::roots(metadata.parquet_schema(), projection);
        let metadata = if text.is_empty() {
            metadata
        } else {
            // StringView reuses Plain, dictionary and delta-length page data
            // rather than repeating decoded dictionary strings for each row.
            let fields = schema
                .fields()
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    if text.binary_search(&index).is_ok() {
                        Arc::new(field.as_ref().clone().with_data_type(DataType::Utf8View))
                    } else {
                        Arc::clone(field)
                    }
                })
                .collect::<Vec<_>>();
            let options = ArrowReaderOptions::new().with_schema(Arc::new(Schema::new(fields)));
            ArrowReaderMetadata::try_new(Arc::clone(metadata.metadata()), options)
                .map_err(parquet_error)?
        };
        Ok(Some(Self {
            metadata,
            projection: mask,
            columns: slots,
            row_id,
            row_count,
            batch_rows,
        }))
    }

    fn visit(
        self,
        file: File,
        check: &dyn Fn() -> Result<(), DataError>,
        visit: &mut ChartRowVisitor<'_>,
    ) -> Result<bool, DataError> {
        let mut reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, self.metadata)
            .with_projection(self.projection)
            .with_batch_size(self.batch_rows)
            .build()
            .map_err(parquet_error)?;
        let mut row_id = 0_u64;
        loop {
            check()?;
            let Some(batch) = reader.next() else {
                break;
            };
            let batch = batch.map_err(parquet_error)?;
            if batch.get_array_memory_size() > BATCH_BYTES {
                if row_id == 0 {
                    return Ok(false);
                }
                return Err(DataError::query_failed(
                    "A prepared chart batch exceeded its 8 MiB decoded limit.",
                ));
            }
            let ids = downcast::<UInt64Array>(&batch, self.row_id)?;
            let columns = self
                .columns
                .iter()
                .map(|slot| DecodedColumn::new(&batch, slot))
                .collect::<Result<Vec<_>, _>>()?;
            let mut row = vec![ChartCell::Missing; columns.len()];
            for index in 0..batch.num_rows() {
                if index.is_multiple_of(CANCEL_ROWS) {
                    check()?;
                }
                if ids.is_null(index) || ids.value(index) != row_id {
                    return Err(artifact_changed());
                }
                for (cell, column) in row.iter_mut().zip(&columns) {
                    *cell = column.cell(index)?;
                }
                visit(&row)?;
                row_id += 1;
            }
        }
        check()?;
        if row_id != self.row_count {
            return Err(artifact_changed());
        }
        Ok(true)
    }
}

fn admit_batch(
    metadata: &ParquetMetaData,
    projection: &[usize],
    text: &[usize],
    schema: &Schema,
    candidate_rows: usize,
) -> Option<usize> {
    let mut row_offsets = vec![0_usize];
    let mut text_offsets = vec![0_usize];
    for group in metadata.row_groups() {
        let rows = usize::try_from(group.num_rows()).ok()?;
        if rows > MAX_ROW_GROUP_ROWS {
            return None;
        }
        if rows == 0 {
            continue;
        }
        let mut decoder_bytes = 0_usize;
        let mut text_bytes = 0_usize;
        for &column in projection {
            let chunk = group.columns().get(column)?;
            let descriptor = chunk.column_descr();
            if descriptor.max_def_level() > 1 || descriptor.max_rep_level() != 0 {
                return None;
            }
            let uncompressed = usize::try_from(chunk.uncompressed_size()).ok()?;
            decoder_bytes = decoder_bytes
                .checked_add(uncompressed)?
                .checked_add(usize::try_from(chunk.compressed_size()).ok()?)?
                // A dictionary or length/definition decoder can also hold
                // fixed-width scratch for each row in the active group.
                .checked_add(rows.checked_mul(16)?)?;
            if text.binary_search(&column).is_ok() {
                // Prefix-compressed strings can expand beyond the metadata's
                // uncompressed byte count even when using string views.
                if chunk.encodings().any(|encoding| {
                    !matches!(
                        encoding,
                        Encoding::PLAIN
                            | Encoding::PLAIN_DICTIONARY
                            | Encoding::RLE_DICTIONARY
                            | Encoding::RLE
                            | Encoding::DELTA_LENGTH_BYTE_ARRAY
                    )
                }) {
                    return None;
                }
                // Count space for the Arrow view buffers and a conservative
                // reserve for shared page buffers' reported capacities.
                text_bytes = text_bytes.checked_add(uncompressed.checked_mul(2)?)?;
            }
        }
        // One active Parquet page/decoder per projected leaf may keep both
        // encoded and decoded input. Bound that separately from Arrow output.
        if decoder_bytes > DECODER_GROUP_BYTES {
            return None;
        }
        row_offsets.push(row_offsets.last()?.checked_add(rows)?);
        text_offsets.push(text_offsets.last()?.checked_add(text_bytes)?);
    }
    let row_bits: usize = projection
        .iter()
        .map(|&column| match schema.field(column).data_type() {
            DataType::Boolean => 2, // value and validity bitmaps
            DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => 129, // view and validity
            _ => 65,                // 64-bit scalar and validity
        })
        .sum();
    let overhead = ARRAY_OVERHEAD_BYTES * projection.len();
    let total_rows = *row_offsets.last()?;
    if total_rows != usize::try_from(metadata.file_metadata().num_rows()).ok()? {
        return None;
    }
    let fixed_limit = (BATCH_BYTES.checked_sub(overhead)? * 8) / row_bits;
    let mut rows = candidate_rows.min(fixed_limit).min(total_rows.max(1));
    if rows == 0 {
        return None;
    }
    if rows >= CANCEL_ROWS && rows < total_rows {
        rows -= rows % CANCEL_ROWS;
    }
    loop {
        let fixed_bytes = rows
            .checked_mul(row_bits)?
            .div_ceil(8)
            .checked_add(overhead)?;
        if fixed_bytes.saturating_add(max_text_payload(&row_offsets, &text_offsets, rows))
            <= BATCH_BYTES
        {
            return Some(rows);
        }
        if rows == 1 {
            return None;
        }
        rows /= 2;
    }
}

fn max_text_payload(row_offsets: &[usize], text_offsets: &[usize], rows: usize) -> usize {
    if text_offsets.last() == Some(&0) {
        return 0;
    }
    let starts = &row_offsets[..row_offsets.len() - 1];
    starts
        .iter()
        .enumerate()
        .map(|(index, _)| {
            // A batch can start on the last row of this group. Charge all
            // retained text pages for every group it can touch, including partials.
            let end = if rows == 1 {
                index + 1
            } else {
                let last_possible_start = row_offsets[index + 1].saturating_add(rows - 2);
                starts.partition_point(|start| *start <= last_possible_start)
            };
            text_offsets[end] - text_offsets[index]
        })
        .max()
        .unwrap_or(0)
}

struct DecodedColumn<'a> {
    state: &'a UInt64Array,
    shift: usize,
    value: ValueArray<'a>,
}

enum ValueArray<'a> {
    Integer(&'a Int64Array),
    Unsigned(&'a UInt64Array),
    Float(&'a Float64Array),
    Boolean(&'a BooleanArray),
    Text(&'a StringViewArray),
}

impl<'a> DecodedColumn<'a> {
    fn new(batch: &'a RecordBatch, slot: &ColumnSlot) -> Result<Self, DataError> {
        let value = match slot.kind {
            Kind::Integer => ValueArray::Integer(downcast(batch, slot.value)?),
            Kind::Unsigned => ValueArray::Unsigned(downcast(batch, slot.value)?),
            Kind::Float => ValueArray::Float(downcast(batch, slot.value)?),
            Kind::Boolean => ValueArray::Boolean(downcast(batch, slot.value)?),
            Kind::Text => ValueArray::Text(downcast(batch, slot.value)?),
        };
        Ok(Self {
            state: downcast(batch, slot.state)?,
            shift: slot.shift,
            value,
        })
    }

    fn cell(&self, row: usize) -> Result<ChartCell<'a>, DataError> {
        if self.state.is_null(row) {
            return Err(artifact_changed());
        }
        match (self.state.value(row) >> self.shift) & 3 {
            0 => {}
            2 => return Ok(ChartCell::Text("")),
            _ => return Ok(ChartCell::Missing),
        }
        match self.value {
            ValueArray::Integer(a) if !a.is_null(row) => {
                Ok(ChartCell::Integer(a.value(row).into()))
            }
            ValueArray::Unsigned(a) if !a.is_null(row) => {
                Ok(ChartCell::Integer(a.value(row).into()))
            }
            ValueArray::Float(a) if !a.is_null(row) => {
                let value = a.value(row);
                Ok(if value.is_finite() {
                    ChartCell::Float(value)
                } else {
                    ChartCell::Missing
                })
            }
            ValueArray::Boolean(a) if !a.is_null(row) => Ok(ChartCell::Boolean(a.value(row))),
            ValueArray::Text(a) if !a.is_null(row) => Ok(ChartCell::Text(a.value(row))),
            _ => Err(artifact_changed()),
        }
    }
}

fn downcast<T: 'static>(batch: &RecordBatch, index: usize) -> Result<&T, DataError> {
    batch
        .columns()
        .get(index)
        .and_then(|column| column.as_any().downcast_ref())
        .ok_or_else(artifact_changed)
}

fn artifact_changed() -> DataError {
    DataError::query_failed(
        "The prepared CSV data changed while scanning the chart. Reopen the source and retry.",
    )
}

fn csv_changed() -> DataError {
    DataError::query_failed(
        "The CSV source changed while scanning the chart. Reopen the source and retry.",
    )
}

fn parquet_error(error: impl std::fmt::Display) -> DataError {
    DataError::query_failed(format!("Could not read prepared CSV chart data: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::ArrayRef;
    use parquet::{arrow::ArrowWriter, basic::Compression, file::properties::WriterProperties};

    fn source_spec(path: &Path) -> QuerySourceSpec {
        use crate::{
            data::DataSource,
            domain::{CsvTargetType, HeaderMode},
        };

        let mut source = DataSource::open(path).unwrap();
        source.configure_csv(HeaderMode::Present).unwrap();
        let mut profile = source.active_csv_profile().unwrap();
        for (column, target) in profile.columns.iter_mut().zip([
            CsvTargetType::Int64,
            CsvTargetType::Skip,
            CsvTargetType::Text,
            CsvTargetType::UInt64,
            CsvTargetType::Boolean,
            CsvTargetType::Float64,
        ]) {
            column.target_type = target;
        }
        profile.columns[2].trim = true;
        source
            .prepare_csv_profile(&profile)
            .unwrap()
            .query_source_spec()
            .unwrap()
    }

    #[derive(Debug, PartialEq)]
    enum Observed {
        Integer(i128),
        Float(f64),
        Text(String),
        Boolean(bool),
        Missing,
    }

    fn observe(cell: &ChartCell<'_>) -> Observed {
        match cell {
            ChartCell::Integer(value) => Observed::Integer(*value),
            ChartCell::Float(value) => Observed::Float(*value),
            ChartCell::Text(value) => Observed::Text((*value).to_owned()),
            ChartCell::Boolean(value) => Observed::Boolean(*value),
            ChartCell::Missing => Observed::Missing,
            ChartCell::Legacy(_) => panic!("Expected a projected Arrow value"),
        }
    }

    #[test]
    fn prepared_chart_projection_matches_cold_and_persistent_csv_states() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("typed.csv");
        std::fs::write(
            &path,
            concat!(
                "signed,unused,category,unsigned,flag,fraction\n",
                "-12,ignored,\u{a0}Yoga\u{a0},18446744073709551615,TRUE,1.25\n",
                "bad,ignored,NULL,0,false,2.5\n",
                ",ignored,\"\",,1,3.0\n",
                "NULL,ignored,\u{a0},10,0,bad\n",
            ),
        )
        .unwrap();
        let local = tempfile::tempdir().unwrap();
        let persistent = tempfile::tempdir().unwrap();
        const CAP: u64 = 256 * 1024 * 1024;
        let columns = ["category", "signed", "unsigned", "flag", "fraction"].map(str::to_owned);
        let expected = vec![
            vec![
                Observed::Text("Yoga".into()),
                Observed::Integer(-12),
                Observed::Integer(u64::MAX.into()),
                Observed::Boolean(true),
                Observed::Float(1.25),
            ],
            vec![
                Observed::Missing,
                Observed::Missing,
                Observed::Integer(0),
                Observed::Boolean(false),
                Observed::Float(2.5),
            ],
            vec![
                Observed::Text("".into()),
                Observed::Text("".into()),
                Observed::Text("".into()),
                Observed::Boolean(true),
                Observed::Float(3.0),
            ],
            vec![
                Observed::Text("".into()),
                Observed::Missing,
                Observed::Integer(10),
                Observed::Boolean(false),
                Observed::Missing,
            ],
        ];
        for (directory, cache_cap, warm) in [
            (local.path(), 1, false),
            (persistent.path(), CAP, false),
            (persistent.path(), CAP, true),
        ] {
            let service =
                Arc::new(QueryService::open_with_cache(directory, CAP, None, cache_cap).unwrap());
            let spec = source_spec(&path);
            let status = service
                .prepare_csv_session("chart-document", "chart-session", spec.clone())
                .unwrap();
            if warm {
                assert_eq!(status.state, CsvPreparationState::Ready);
                assert_eq!(status.source_read_bytes, 0);
            }
            let stream = service
                .prepared_chart_source("chart-document", "chart-session", spec)
                .unwrap()
                .unwrap();
            assert!(!stream
                .visit(
                    &columns,
                    &[false, false, false, false, true],
                    &|| Ok(()),
                    &mut |_| { panic!("Float canonical-text fallback must happen before reading") }
                )
                .unwrap());
            let mut actual = Vec::new();
            assert!(stream
                .visit(
                    &columns,
                    &[true, true, true, true, false],
                    &|| Ok(()),
                    &mut |row| {
                        actual.push(row.iter().map(observe).collect::<Vec<_>>());
                        Ok(())
                    }
                )
                .unwrap());
            assert_eq!(actual, expected);
            if warm {
                let mut changed = false;
                let error = stream
                    .visit(
                        &columns,
                        &[true, true, true, true, false],
                        &|| Ok(()),
                        &mut |_| {
                            if !changed {
                                use std::io::Write;
                                std::fs::OpenOptions::new()
                                    .append(true)
                                    .open(&path)
                                    .unwrap()
                                    .write_all(b"\n")
                                    .unwrap();
                                changed = true;
                            }
                            Ok(())
                        },
                    )
                    .unwrap_err();
                assert!(error.message.contains("CSV source changed"));
            }
            service
                .drop_session("chart-document", "chart-session")
                .unwrap();
            if !warm {
                assert_eq!(
                    stream
                        .visit(
                            &columns,
                            &[true, true, true, true, false],
                            &|| Ok(()),
                            &mut |_| panic!("Dropped chart session")
                        )
                        .unwrap_err()
                        .code,
                    DataErrorCode::TaskCancelled,
                );
            }
            drop(stream);
            service.shutdown();
        }
    }

    fn numeric_parquet(path: &Path, rows: usize) {
        let group_rows = MAX_ROW_GROUP_ROWS.min(rows);
        let batch = |start, end| {
            RecordBatch::try_from_iter([
                (
                    "__dv_row_id",
                    Arc::new(UInt64Array::from_iter_values(start as u64..end as u64)) as ArrayRef,
                ),
                (
                    "__dv_value_0",
                    Arc::new(Int64Array::from_iter_values(start as i64..end as i64)) as ArrayRef,
                ),
                (
                    "__dv_state_word_0",
                    Arc::new(UInt64Array::from_value(0, end - start)) as ArrayRef,
                ),
            ])
            .unwrap()
        };
        let properties = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_max_row_group_row_count(Some(group_rows))
            .build();
        let mut writer = ArrowWriter::try_new(
            File::create(path).unwrap(),
            batch(0, 1).schema(),
            Some(properties),
        )
        .unwrap();
        for start in (0..rows).step_by(group_rows) {
            writer
                .write(&batch(start, (start + group_rows).min(rows)))
                .unwrap();
        }
        writer.close().unwrap();
    }

    fn numeric_plan(file: &File, candidate: usize) -> Scan {
        let metadata = ArrowReaderMetadata::load(file, ArrowReaderOptions::new()).unwrap();
        Scan::plan(
            metadata,
            &[&PhysicalColumn {
                field: "__dv_value_0".to_owned(),
                source_index: 0,
                kind: Kind::Integer,
            }],
            candidate,
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn prepared_chart_cancellation_checks_between_bounded_row_intervals() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("prepared.parquet");
        numeric_parquet(&path, 9_000);
        let file = File::open(path).unwrap();
        let scan = numeric_plan(&file, CANDIDATE_ROWS);
        let cancelled = AtomicBool::new(false);
        let mut count = 0;
        let error = scan
            .visit(
                file,
                &|| {
                    if cancelled.load(Ordering::Relaxed) {
                        Err(DataError::task_cancelled())
                    } else {
                        Ok(())
                    }
                },
                &mut |_| {
                    count += 1;
                    cancelled.store(true, Ordering::Relaxed);
                    Ok(())
                },
            )
            .unwrap_err();
        assert_eq!(error.code, DataErrorCode::TaskCancelled);
        assert_eq!(count, CANCEL_ROWS);
    }

    #[test]
    #[ignore = "release timing audit for prepared chart batch candidates"]
    fn prepared_chart_batch_candidate_audit() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("prepared.parquet");
        numeric_parquet(&path, 1_048_576);
        for requested in [262_144, 524_288, 524_288, 262_144] {
            let file = File::open(&path).unwrap();
            let scan = numeric_plan(&file, requested);
            let admitted = scan.batch_rows;
            let reader =
                ParquetRecordBatchReaderBuilder::new_with_metadata(file, scan.metadata.clone())
                    .with_projection(scan.projection.clone())
                    .with_batch_size(scan.batch_rows)
                    .build()
                    .unwrap();
            let max_bytes = reader
                .map(|batch| batch.unwrap().get_array_memory_size())
                .max()
                .unwrap();
            assert!(max_bytes <= BATCH_BYTES);
            let mut total = 0_i128;
            let start = std::time::Instant::now();
            assert!(scan
                .visit(File::open(&path).unwrap(), &|| Ok(()), &mut |row| {
                    if let [ChartCell::Integer(value)] = row {
                        total += value;
                    }
                    Ok(())
                })
                .unwrap());
            assert_eq!(total, 1_048_575 * 1_048_576 / 2);
            eprintln!("preparedChartBatch requested={requested} admitted={admitted} maxDecodedBytes={max_bytes} elapsedMs={}", start.elapsed().as_secs_f64() * 1000.0);
        }
    }
}
