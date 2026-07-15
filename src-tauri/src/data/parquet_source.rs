use crate::domain::{
    ColumnSchema, DataError, DataFormat, DataPage, DataValue, FileSummary, FormatDescriptor,
    FormatDetailsContent, FormatDetailsSection, RowCountState, RowCountStatus, RowGroupSummary,
    SourceCapability,
};
use arrow_array::RecordBatch;
use parquet::arrow::{arrow_reader::ParquetRecordBatchReaderBuilder, ProjectionMask};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

use super::{
    query_invalid_name, query_quote_identifier, query_quote_literal, query_raw_name, FormatHandler,
    QueryInputProvider, QueryPrepareContext, QuerySourceSpec, TabularSource,
};

const PARQUET_MAGIC: &[u8; 4] = b"PAR1";
pub const MAX_PAGE_SIZE: usize = 200;
pub const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_GENERIC_ROW_GROUPS: usize = 100;

pub const PARQUET_FORMAT_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    id: DataFormat::Parquet,
    display_name: "Parquet",
    extensions: &["parquet"],
    mime_types: &["application/vnd.apache.parquet"],
    capabilities: &[
        SourceCapability::TypedSchema,
        SourceCapability::ColumnProjection,
        SourceCapability::QueryProvider,
        SourceCapability::RowGroups,
    ],
};

#[derive(Debug)]
pub(crate) struct ParquetFormatHandler;

pub(crate) static PARQUET_FORMAT_HANDLER: ParquetFormatHandler = ParquetFormatHandler;

impl FormatHandler for ParquetFormatHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &PARQUET_FORMAT_DESCRIPTOR
    }

    fn open(&self, path: &Path) -> Result<Box<dyn TabularSource>, DataError> {
        ParquetSource::open(path).map(|source| Box::new(source) as Box<dyn TabularSource>)
    }
}

#[derive(Debug, Clone)]
pub struct ParquetSource {
    path: PathBuf,
    summary: FileSummary,
    row_group_offsets: Vec<(u64, u64)>,
    #[cfg(test)]
    decode_audit: Arc<Mutex<DecodeAudit>>,
}

#[cfg(test)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DecodeAudit {
    pub reader_builds: usize,
    pub selected_row_groups: Vec<usize>,
    pub projected_root_columns: usize,
    pub decoded_batches: usize,
    pub decoded_rows: usize,
    pub decoded_columns: usize,
}

impl ParquetSource {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DataError> {
        let path = path.as_ref();
        let file_metadata = fs::metadata(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DataError::file_not_found(path)
            } else {
                DataError::io(path, error)
            }
        })?;

        if !file_metadata.is_file() {
            return Err(DataError::io(path, "path does not identify a regular file"));
        }

        if !has_parquet_extension(path) {
            return Err(DataError::unsupported_format(path));
        }

        let mut file = File::open(path).map_err(|error| DataError::io(path, error))?;
        validate_magic(path, &mut file, file_metadata.len())?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| DataError::io(path, error))?;

        let builder = ParquetRecordBatchReaderBuilder::try_new(file)
            .map_err(|error| DataError::invalid_parquet(path, error))?;
        let arrow_schema = builder.schema().clone();
        let parquet_metadata = builder.metadata();
        let row_count = u64::try_from(parquet_metadata.file_metadata().num_rows())
            .map_err(|_| DataError::invalid_parquet(path, "negative row count"))?;
        let schema_descriptor = parquet_metadata.file_metadata().schema_descr();
        let physical_columns = schema_descriptor.columns();
        let columns = arrow_schema
            .fields()
            .iter()
            .enumerate()
            .map(|(index, field)| ColumnSchema {
                name: field.name().clone(),
                logical_type: field.data_type().to_string(),
                nullable: field.is_nullable(),
                physical_type: {
                    let mut types = physical_columns
                        .iter()
                        .enumerate()
                        .filter(|(leaf_index, _)| {
                            schema_descriptor.get_column_root_idx(*leaf_index) == index
                        })
                        .map(|(_, column)| format!("{:?}", column.physical_type()))
                        .collect::<Vec<_>>();
                    types.dedup();
                    if types.is_empty() {
                        String::from("UNKNOWN")
                    } else {
                        types.join(" | ")
                    }
                },
            })
            .collect::<Vec<_>>();
        let mut row_start = 0_u64;
        let mut row_group_offsets = Vec::with_capacity(parquet_metadata.num_row_groups());
        let row_groups = parquet_metadata
            .row_groups()
            .iter()
            .enumerate()
            .map(|(index, row_group)| {
                let row_count = u64::try_from(row_group.num_rows()).map_err(|_| {
                    DataError::invalid_parquet(path, "negative row group row count")
                })?;
                let row_end = row_start.checked_add(row_count).ok_or_else(|| {
                    DataError::invalid_parquet(path, "row group row count overflow")
                })?;
                row_group_offsets.push((row_start, row_end));
                row_start = row_end;

                let mut compression = Vec::new();
                let mut compressed_size = 0_u64;
                let mut statistics_column_count = 0_usize;
                for column in row_group.columns() {
                    let codec = format!("{:?}", column.compression());
                    if !compression.contains(&codec) {
                        compression.push(codec);
                    }
                    compressed_size = compressed_size.saturating_add(
                        u64::try_from(column.compressed_size()).unwrap_or_default(),
                    );
                    statistics_column_count += usize::from(column.statistics().is_some());
                }

                Ok(RowGroupSummary {
                    index,
                    row_count,
                    total_byte_size: u64::try_from(row_group.total_byte_size()).unwrap_or_default(),
                    compressed_size,
                    compression,
                    statistics_column_count,
                })
            })
            .collect::<Result<Vec<_>, DataError>>()?;
        if row_start != row_count {
            return Err(DataError::invalid_parquet(
                path,
                "row group counts do not match the file row count",
            ));
        }

        let summary = FileSummary {
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            format: DataFormat::Parquet,
            format_descriptor: PARQUET_FORMAT_DESCRIPTOR,
            file_size: file_metadata.len(),
            row_count: Some(row_count),
            row_count_status: RowCountStatus {
                state: RowCountState::Complete,
                rows_scanned: row_count,
                bytes_scanned: file_metadata.len(),
                total_bytes: file_metadata.len(),
                generation: 1,
                message: None,
            },
            column_count: columns.len(),
            row_group_count: parquet_metadata.num_row_groups(),
            columns,
            format_details: parquet_format_details(&row_groups),
            row_groups,
            csv_metadata: None,
        };

        Ok(Self {
            path: path.to_path_buf(),
            summary,
            row_group_offsets,
            #[cfg(test)]
            decode_audit: Arc::new(Mutex::new(DecodeAudit::default())),
        })
    }

    pub fn summary(&self) -> &FileSummary {
        &self.summary
    }

    #[cfg(test)]
    pub fn read_page(&self, offset: u64, limit: usize) -> Result<DataPage, DataError> {
        self.read_page_projected(offset, limit, None)
    }

    pub fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        validate_page_request(limit)?;
        let projection = self.validate_projection(columns)?;
        let (row_groups, first_row) = self.row_groups_for_page(offset, limit);

        if row_groups.is_empty() {
            return Ok(DataPage {
                offset,
                limit,
                total_rows: self.summary.row_count,
                has_more: false,
                columns: projection.names,
                rows: Vec::new(),
            });
        }

        #[cfg(test)]
        self.record_reader_build(&row_groups, projection.sorted_indices.len());

        let file = File::open(&self.path).map_err(|error| DataError::io(&self.path, error))?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file)
            .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
        let mask = ProjectionMask::roots(builder.parquet_schema(), projection.sorted_indices);
        let reader = builder
            .with_batch_size(MAX_PAGE_SIZE)
            .with_row_groups(row_groups)
            .with_projection(mask)
            .build()
            .map_err(|error| DataError::invalid_parquet(&self.path, error))?;

        let mut rows = Vec::with_capacity(limit);
        let mut selected_row = 0_u64;
        let skip_rows = offset.saturating_sub(first_row);
        for batch in reader {
            let batch = batch.map_err(|error| DataError::invalid_parquet(&self.path, error))?;
            #[cfg(test)]
            self.record_decoded_batch(batch.num_rows(), batch.num_columns());
            append_batch_rows(
                &batch,
                skip_rows,
                limit,
                &projection.batch_positions,
                &mut selected_row,
                &mut rows,
            )?;
            if rows.len() == limit {
                break;
            }
        }

        Ok(DataPage {
            offset,
            limit,
            total_rows: self.summary.row_count,
            has_more: offset.saturating_add(rows.len() as u64)
                < self.summary.row_count.unwrap_or_default(),
            columns: projection.names,
            rows,
        })
    }

    fn validate_projection(
        &self,
        requested: Option<&[String]>,
    ) -> Result<ProjectionPlan, DataError> {
        let (names, requested_indices) = match requested {
            None => (
                self.summary
                    .columns
                    .iter()
                    .map(|column| column.name.clone())
                    .collect::<Vec<_>>(),
                (0..self.summary.columns.len()).collect::<Vec<_>>(),
            ),
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
                let mut indices = Vec::with_capacity(columns.len());
                for name in columns {
                    if !seen.insert(name.as_str()) {
                        return Err(DataError::invalid_request(format!(
                            "Column projection contains duplicate column: {name}"
                        )));
                    }
                    let index = self
                        .summary
                        .columns
                        .iter()
                        .position(|column| column.name == *name)
                        .ok_or_else(|| {
                            DataError::invalid_request(format!("Unknown projected column: {name}"))
                        })?;
                    indices.push(index);
                }
                (columns.to_vec(), indices)
            }
        };

        let mut sorted_indices = requested_indices.clone();
        sorted_indices.sort_unstable();
        let batch_positions = requested_indices
            .iter()
            .map(|index| {
                sorted_indices
                    .binary_search(index)
                    .expect("requested projection index is present")
            })
            .collect();

        Ok(ProjectionPlan {
            names,
            sorted_indices,
            batch_positions,
        })
    }

    fn row_groups_for_page(&self, offset: u64, limit: usize) -> (Vec<usize>, u64) {
        let row_count = self.summary.row_count.unwrap_or_default();
        if offset >= row_count {
            return (Vec::new(), offset);
        }
        let end = offset.saturating_add(limit as u64).min(row_count);
        let row_groups = self
            .row_group_offsets
            .iter()
            .enumerate()
            .filter_map(|(index, (start, group_end))| {
                (*start < end && *group_end > offset).then_some(index)
            })
            .collect::<Vec<_>>();
        let first_row = row_groups
            .first()
            .map(|index| self.row_group_offsets[*index].0)
            .unwrap_or(offset);
        (row_groups, first_row)
    }

    #[cfg(test)]
    pub(crate) fn take_decode_audit(&self) -> DecodeAudit {
        let mut audit = self.decode_audit.lock().expect("decode audit lock");
        std::mem::take(&mut *audit)
    }

    #[cfg(test)]
    fn record_reader_build(&self, row_groups: &[usize], projected_root_columns: usize) {
        let mut audit = self.decode_audit.lock().expect("decode audit lock");
        audit.reader_builds += 1;
        audit.selected_row_groups = row_groups.to_vec();
        audit.projected_root_columns = projected_root_columns;
    }

    #[cfg(test)]
    fn record_decoded_batch(&self, rows: usize, columns: usize) {
        let mut audit = self.decode_audit.lock().expect("decode audit lock");
        audit.decoded_batches += 1;
        audit.decoded_rows += rows;
        audit.decoded_columns = audit.decoded_columns.max(columns);
    }
}

#[derive(Debug)]
struct ParquetQueryProvider;

impl QueryInputProvider for ParquetQueryProvider {
    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError> {
        if context.cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let path = query_quote_literal(&context.source.path.to_string_lossy().replace('\\', "/"));
        let expressions = context
            .source
            .columns
            .iter()
            .enumerate()
            .flat_map(|(index, column)| {
                let identifier = query_quote_identifier(&column.name);
                [
                    identifier.clone(),
                    format!("CAST({identifier} AS VARCHAR) AS {}", query_raw_name(index)),
                    format!("false AS {}", query_invalid_name(index)),
                ]
            })
            .collect::<Vec<_>>()
            .join(", ");
        context
            .connection
            .execute_batch(&format!(
                "CREATE VIEW dv_source AS SELECT row_number() OVER () - 1 AS __dv_row_id, {expressions} FROM read_parquet({path})"
            ))
            .map_err(|error| DataError::query_failed(error.to_string()))?;
        (context.progress)(0)
    }
}

impl TabularSource for ParquetSource {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &PARQUET_FORMAT_DESCRIPTOR
    }

    fn query_source_spec(&self) -> Result<QuerySourceSpec, DataError> {
        let path =
            fs::canonicalize(&self.path).map_err(|error| DataError::io(&self.path, error))?;
        Ok(QuerySourceSpec {
            path,
            columns: self.summary.columns.clone(),
            total_rows: self.summary.row_count,
            provider: Arc::new(ParquetQueryProvider),
        })
    }

    fn summary(&self) -> FileSummary {
        ParquetSource::summary(self).clone()
    }

    fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        ParquetSource::read_page_projected(self, offset, limit, columns)
    }
}

fn parquet_format_details(row_groups: &[RowGroupSummary]) -> Vec<FormatDetailsSection> {
    let rows = row_groups
        .iter()
        .take(MAX_GENERIC_ROW_GROUPS)
        .map(|row_group| {
            vec![
                row_group.index.to_string(),
                row_group.row_count.to_string(),
                row_group.compressed_size.to_string(),
                row_group.total_byte_size.to_string(),
                row_group.compression.join(", "),
            ]
        })
        .collect();
    vec![FormatDetailsSection {
        id: String::from("parquet-row-groups"),
        title: String::from("Row groups"),
        content: FormatDetailsContent::Table {
            columns: [
                "Index",
                "Rows",
                "Compressed bytes",
                "Total bytes",
                "Compression",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            rows,
            truncated: row_groups.len() > MAX_GENERIC_ROW_GROUPS,
        },
    }]
}

struct ProjectionPlan {
    names: Vec<String>,
    sorted_indices: Vec<usize>,
    batch_positions: Vec<usize>,
}

fn has_parquet_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("parquet"))
}

fn validate_magic(path: &Path, file: &mut File, length: u64) -> Result<(), DataError> {
    if length < 8 {
        return Err(DataError::invalid_parquet(path, "file is too short"));
    }

    let mut header = [0_u8; 4];
    file.read_exact(&mut header)
        .map_err(|error| DataError::invalid_parquet(path, error))?;
    if &header != PARQUET_MAGIC {
        return Err(DataError::invalid_parquet(path, "missing header magic"));
    }

    file.seek(SeekFrom::End(-4))
        .map_err(|error| DataError::invalid_parquet(path, error))?;
    let mut footer = [0_u8; 4];
    file.read_exact(&mut footer)
        .map_err(|error| DataError::invalid_parquet(path, error))?;
    if &footer != PARQUET_MAGIC {
        return Err(DataError::invalid_parquet(path, "missing footer magic"));
    }

    Ok(())
}

fn validate_page_request(limit: usize) -> Result<(), DataError> {
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(DataError::invalid_request(format!(
            "Page limit must be between 1 and {MAX_PAGE_SIZE}; received {limit}"
        )));
    }
    Ok(())
}

fn append_batch_rows(
    batch: &RecordBatch,
    skip_rows: u64,
    limit: usize,
    batch_positions: &[usize],
    selected_row: &mut u64,
    rows: &mut Vec<Vec<DataValue>>,
) -> Result<(), DataError> {
    for row_index in 0..batch.num_rows() {
        if *selected_row >= skip_rows && rows.len() < limit {
            let row = batch_positions
                .iter()
                .map(|column_index| {
                    super::value_format::value_at(batch.column(*column_index).as_ref(), row_index)
                })
                .collect::<Result<Vec<_>, _>>()?;
            rows.push(row);
        }
        *selected_row = selected_row.saturating_add(1);
        if rows.len() == limit {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{DataErrorCode, ValueKind};
    use arrow_array::{ArrayRef, BooleanArray, Float64Array, Int32Array, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn write_primitive_fixture(path: &Path) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("score", DataType::Float64, true),
            Field::new("active", DataType::Boolean, true),
        ]));
        let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema.clone(), None)
            .expect("fixture writer");
        let first = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int32Array::from(vec![1, 2])) as ArrayRef,
                Arc::new(StringArray::from(vec![Some("alpha"), None])),
                Arc::new(Float64Array::from(vec![Some(1.5), Some(2.25)])),
                Arc::new(BooleanArray::from(vec![Some(true), None])),
            ],
        )
        .unwrap();
        writer.write(&first).unwrap();
        writer.flush().unwrap();

        let second = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int32Array::from(vec![3, 4])) as ArrayRef,
                Arc::new(StringArray::from(vec![Some(""), Some("delta")])),
                Arc::new(Float64Array::from(vec![None, Some(4.5)])),
                Arc::new(BooleanArray::from(vec![Some(false), Some(true)])),
            ],
        )
        .unwrap();
        writer.write(&second).unwrap();
        writer.close().unwrap();
    }

    fn write_page_cap_fixture(path: &Path) {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int32Array::from_iter_values(0..205)) as ArrayRef],
        )
        .unwrap();
        let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
    }

    fn fixture() -> (TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("primitive-null.parquet");
        write_primitive_fixture(&path);
        (directory, path)
    }

    #[test]
    fn t_p1_001_reads_summary_schema_and_row_groups() {
        let (_directory, path) = fixture();
        let source = ParquetSource::open(&path).unwrap();
        let summary = source.summary();

        assert_eq!(summary.file_name, "primitive-null.parquet");
        assert_eq!(summary.row_count, Some(4));
        assert_eq!(summary.column_count, 4);
        assert_eq!(summary.row_group_count, 2);
        assert!(summary.file_size > 0);
        assert_eq!(summary.columns[0].name, "id");
        assert_eq!(summary.columns[0].logical_type, "Int32");
        assert!(!summary.columns[0].nullable);
        assert_eq!(summary.columns[0].physical_type, "INT32");
        assert_eq!(summary.columns[1].logical_type, "Utf8");
        assert!(summary.columns[1].nullable);
    }

    #[test]
    fn t_p1_002_reads_the_first_page_in_source_order() {
        let (_directory, path) = fixture();
        let page = ParquetSource::open(path)
            .unwrap()
            .read_page(0, 200)
            .unwrap();

        assert_eq!(page.columns, ["id", "name", "score", "active"]);
        assert_eq!(page.rows.len(), 4);
        assert_eq!(page.rows[0][0].display.as_deref(), Some("1"));
        assert_eq!(page.rows[1][0].display.as_deref(), Some("2"));
        assert_eq!(page.rows[2][0].display.as_deref(), Some("3"));
        assert_eq!(page.rows[3][0].display.as_deref(), Some("4"));
        assert_eq!(page.total_rows, Some(4));
    }

    #[test]
    fn t_p1_003_preserves_null_empty_and_primitive_kinds() {
        let (_directory, path) = fixture();
        let rows = ParquetSource::open(path)
            .unwrap()
            .read_page(0, 200)
            .unwrap()
            .rows;

        assert_eq!(rows[1][1], DataValue::null());
        assert_eq!(rows[2][1], DataValue::displayed(ValueKind::String, ""));
        assert_eq!(rows[0][0].kind, ValueKind::Int);
        assert_eq!(rows[0][2].kind, ValueKind::Float);
        assert_eq!(rows[0][3].kind, ValueKind::Boolean);
    }

    #[test]
    fn t_p1_004_enforces_the_page_limit_table() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("page-cap.parquet");
        write_page_cap_fixture(&path);
        let source = ParquetSource::open(path).unwrap();

        assert_eq!(source.read_page(0, 1).unwrap().rows.len(), 1);
        assert_eq!(source.read_page(0, 200).unwrap().rows.len(), 200);
        assert_eq!(source.read_page(200, 200).unwrap().rows.len(), 5);
        assert_eq!(
            source.read_page(0, 0).unwrap_err().code,
            DataErrorCode::InvalidRequest
        );
        assert_eq!(
            source.read_page(0, 201).unwrap_err().code,
            DataErrorCode::InvalidRequest
        );
    }

    #[test]
    fn t_p1_005_validates_extension_and_parquet_magic() {
        let (directory, path) = fixture();
        let renamed = directory.path().join("valid.txt");
        fs::copy(&path, &renamed).unwrap();
        assert_eq!(
            ParquetSource::open(&renamed).unwrap_err().code,
            DataErrorCode::UnsupportedFormat
        );

        let fake = directory.path().join("fake.parquet");
        fs::write(&fake, b"not parquet data").unwrap();
        assert_eq!(
            ParquetSource::open(&fake).unwrap_err().code,
            DataErrorCode::InvalidParquet
        );
    }

    #[test]
    fn t_p1_006_returns_typed_errors_for_hostile_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.parquet");
        assert_eq!(
            ParquetSource::open(&missing).unwrap_err().code,
            DataErrorCode::FileNotFound
        );

        let truncated = directory.path().join("truncated.parquet");
        fs::write(&truncated, b"PAR1metadataxxxx").unwrap();
        let error = ParquetSource::open(&truncated).unwrap_err();
        assert_eq!(error.code, DataErrorCode::InvalidParquet);
        assert!(!error.message.is_empty());
    }

    #[test]
    fn t_p1_007_failed_replacement_candidate_does_not_affect_open_source() {
        let (directory, path) = fixture();
        let current = ParquetSource::open(path).unwrap();
        let invalid = directory.path().join("replacement.parquet");
        fs::write(&invalid, b"invalid replacement").unwrap();

        assert!(ParquetSource::open(invalid).is_err());
        assert_eq!(
            current.read_page(0, 1).unwrap().rows[0][0]
                .display
                .as_deref(),
            Some("1")
        );
    }

    #[test]
    fn t_p1_008_successful_replacement_is_independent_and_releases_handles() {
        let (directory, original_path) = fixture();
        let replacement_path = directory.path().join("replacement.parquet");
        write_page_cap_fixture(&replacement_path);
        let original = ParquetSource::open(&original_path).unwrap();
        let replacement = ParquetSource::open(&replacement_path).unwrap();

        assert_eq!(original.summary().column_count, 4);
        assert_eq!(replacement.summary().column_count, 1);
        drop(original);
        fs::remove_file(original_path).expect("source must not retain an open file handle");
    }

    #[test]
    fn t_p1_009_serializes_camel_case_dtos_and_stable_errors() {
        let (_directory, path) = fixture();
        let source = ParquetSource::open(path).unwrap();
        let summary = serde_json::to_value(source.summary()).unwrap();
        let page = serde_json::to_value(source.read_page(0, 1).unwrap()).unwrap();
        let error = serde_json::to_value(DataError::invalid_request("bad limit")).unwrap();

        assert_eq!(summary["format"], "parquet");
        assert_eq!(summary["formatDescriptor"]["id"], "parquet");
        assert_eq!(summary["formatDescriptor"]["displayName"], "Parquet");
        assert_eq!(summary["formatDetails"][0]["kind"], "table");
        assert_eq!(summary["rowCount"], 4);
        assert_eq!(summary["columns"][0]["logicalType"], "Int32");
        assert!(summary.get("row_count").is_none());
        assert_eq!(page["rows"][0][0]["kind"], "int");
        assert_eq!(page["rows"][0][0]["display"], "1");
        assert_eq!(error["code"], "InvalidRequest");
        assert_eq!(error["message"], "bad limit");
    }
}
