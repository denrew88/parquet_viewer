use crate::domain::{
    BoundarySearchRequest, BoundarySearchResult, ColumnSchema, DataBoundaryDirection,
    DataBoundaryMode, DataError, DataFormat, DataPage, DataValue, DataValueState, FileSummary,
    FormatDescriptor, FormatDetailsContent, FormatDetailsSection, RowCountState, RowCountStatus,
    RowGroupSummary, SourceCapability,
};
use arrow_array::{Array, LargeStringArray, RecordBatch, StringArray};
use arrow_schema::DataType;
use parquet::arrow::{
    arrow_reader::{ParquetRecordBatchReaderBuilder, RowSelection},
    ProjectionMask,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use super::{
    query_invalid_name, query_quote_identifier, query_quote_literal, query_raw_name, FormatHandler,
    QueryExactValues, QueryInputProvider, QueryPrepareContext, QuerySourceSpec, TabularSource,
};

const PARQUET_MAGIC: &[u8; 4] = b"PAR1";
pub const MAX_PAGE_SIZE: usize = 200;
pub const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_GENERIC_ROW_GROUPS: usize = 100;
const BOUNDARY_PAGE_SIZE: usize = 65_536;
// This is the hard limit for Arrow arrays accepted and inspected by the
// occupancy provider after parquet-rs returns a batch. parquet-rs may allocate
// transient compressed/decompressed page buffers internally; its public reader
// API does not expose a byte-budgeted allocator for those private buffers.
const QUERY_OCCUPANCY_DECODED_BYTE_CAP: usize = 8 * 1024 * 1024;
const QUERY_OCCUPANCY_MAX_BATCH_ROWS: usize = 4_096;

enum OccupancyScan {
    Unsupported,
    Complete(Option<u64>),
}

enum OccupancyChunkRead {
    Values(Vec<bool>),
    Split,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowGroupOccupancy {
    AllOccupied,
    AllEmpty,
    Unknown,
}

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
    row_group_occupancy: Vec<Vec<RowGroupOccupancy>>,
    row_group_occupancy_bytes_per_row: Vec<Vec<usize>>,
    #[cfg(test)]
    decode_audit: Arc<Mutex<DecodeAudit>>,
}

#[cfg(test)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DecodeAudit {
    pub reader_builds: usize,
    pub selected_row_groups: Vec<usize>,
    pub selected_row_groups_union: Vec<usize>,
    pub projected_root_columns: usize,
    pub decoded_batches: usize,
    pub decoded_rows: usize,
    pub decoded_columns: usize,
    pub occupancy_decode_chunks: usize,
    pub occupancy_decode_splits: usize,
    pub occupancy_max_observed_decoded_bytes: usize,
    pub occupancy_max_accepted_decoded_bytes: usize,
    pub occupancy_oversized_batches: usize,
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
        let row_group_occupancy = parquet_metadata
            .row_groups()
            .iter()
            .map(|row_group| {
                let row_count = u64::try_from(row_group.num_rows()).unwrap_or_default();
                columns
                    .iter()
                    .enumerate()
                    .map(|(root_index, column)| {
                        let mut leaves =
                            row_group
                                .columns()
                                .iter()
                                .enumerate()
                                .filter(|(leaf_index, _)| {
                                    schema_descriptor.get_column_root_idx(*leaf_index) == root_index
                                });
                        let first = leaves.next();
                        if leaves.next().is_some() {
                            RowGroupOccupancy::Unknown
                        } else {
                            occupancy_from_statistics(
                                column,
                                row_count,
                                first.and_then(|(_, leaf)| leaf.statistics()),
                            )
                        }
                    })
                    .collect()
            })
            .collect();
        let row_group_occupancy_bytes_per_row = parquet_metadata
            .row_groups()
            .iter()
            .map(|row_group| {
                let row_count = usize::try_from(row_group.num_rows()).unwrap_or(1).max(1);
                columns
                    .iter()
                    .enumerate()
                    .map(|(root_index, _)| {
                        let leaves =
                            row_group
                                .columns()
                                .iter()
                                .enumerate()
                                .filter(|(leaf_index, _)| {
                                    schema_descriptor.get_column_root_idx(*leaf_index) == root_index
                                });
                        let (encoded_bytes, statistic_bytes) =
                            leaves.fold((0_usize, 0_usize), |(encoded, statistic), (_, leaf)| {
                                let encoded = encoded.saturating_add(
                                    usize::try_from(leaf.uncompressed_size()).unwrap_or(usize::MAX),
                                );
                                let statistic = leaf.statistics().map_or(statistic, |statistics| {
                                    statistic.max(
                                        statistics
                                            .min_bytes_opt()
                                            .map_or(0, <[u8]>::len)
                                            .max(statistics.max_bytes_opt().map_or(0, <[u8]>::len)),
                                    )
                                });
                                (encoded, statistic)
                            });
                        encoded_bytes
                            .div_ceil(row_count)
                            .saturating_mul(2)
                            .max(statistic_bytes.saturating_add(16))
                            .max(16)
                    })
                    .collect()
            })
            .collect();
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
            row_group_occupancy,
            row_group_occupancy_bytes_per_row,
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
        self.read_projected(
            offset,
            limit,
            columns,
            MAX_PAGE_SIZE,
            MAX_PROJECTION_COLUMNS,
        )
    }

    fn read_cell_value_full(&self, row: u64, column: &str) -> Result<DataValue, DataError> {
        let projection =
            self.validate_projection(Some(&[column.to_owned()]), MAX_PROJECTION_COLUMNS)?;
        let (row_groups, first_row) = self.row_groups_for_page(row, 1);
        if row_groups.is_empty() {
            return Err(DataError::invalid_request(
                "The requested cell is outside the data table.",
            ));
        }
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
        let mut skip = row.saturating_sub(first_row);
        for batch in reader {
            let batch = batch.map_err(|error| DataError::invalid_parquet(&self.path, error))?;
            if skip >= batch.num_rows() as u64 {
                skip -= batch.num_rows() as u64;
                continue;
            }
            return super::value_format::full_value_at(batch.column(0).as_ref(), skip as usize);
        }
        Err(DataError::invalid_request(
            "The requested cell is outside the data table.",
        ))
    }

    fn read_rows_exact(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<Vec<Vec<DataValue>>, DataError> {
        self.read_rows_exact_bounded(row_ids, columns, MAX_PROJECTION_COLUMNS)
    }

    fn read_occupancy_states_exact(
        &self,
        row_ids: &[u64],
        column: &str,
    ) -> Result<Vec<bool>, DataError> {
        if row_ids.is_empty() {
            return Ok(Vec::new());
        }
        let column_index = self
            .summary
            .columns
            .iter()
            .position(|candidate| candidate.name == column)
            .ok_or_else(|| {
                DataError::invalid_request(format!("Unknown Parquet column: {column}"))
            })?;
        let estimated_bytes_per_row = row_ids.iter().try_fold(16_usize, |maximum, row| {
            let group = self
                .row_group_offsets
                .iter()
                .position(|(start, end)| *start <= *row && *row < *end)
                .ok_or_else(|| {
                    DataError::invalid_request("A query source row is outside the Parquet file.")
                })?;
            Ok::<_, DataError>(
                maximum.max(self.row_group_occupancy_bytes_per_row[group][column_index]),
            )
        })?;
        let initial_rows = (QUERY_OCCUPANCY_DECODED_BYTE_CAP / estimated_bytes_per_row.max(1))
            .clamp(1, QUERY_OCCUPANCY_MAX_BATCH_ROWS);
        let mut output = Vec::with_capacity(row_ids.len());
        for rows in row_ids.chunks(initial_rows) {
            self.read_occupancy_states_adaptive(rows, column, &mut output)?;
        }
        Ok(output)
    }

    fn read_occupancy_states_adaptive(
        &self,
        row_ids: &[u64],
        column: &str,
        output: &mut Vec<bool>,
    ) -> Result<(), DataError> {
        match self.read_occupancy_states_chunk(row_ids, column)? {
            OccupancyChunkRead::Values(values) => {
                output.extend(values);
                Ok(())
            }
            OccupancyChunkRead::Split if row_ids.len() > 1 => {
                #[cfg(test)]
                self.record_occupancy_split();
                let middle = row_ids.len() / 2;
                self.read_occupancy_states_adaptive(&row_ids[..middle], column, output)?;
                self.read_occupancy_states_adaptive(&row_ids[middle..], column, output)
            }
            OccupancyChunkRead::Split => Err(DataError::invalid_request(format!(
                "A Parquet occupancy value exceeds the {QUERY_OCCUPANCY_DECODED_BYTE_CAP}-byte decode limit."
            ))),
        }
    }

    fn read_occupancy_states_chunk(
        &self,
        row_ids: &[u64],
        column: &str,
    ) -> Result<OccupancyChunkRead, DataError> {
        let projection = self.validate_projection(Some(&[column.to_owned()]), 1)?;
        let mut grouped: BTreeMap<usize, Vec<(u64, usize)>> = BTreeMap::new();
        for (output_index, row) in row_ids.iter().copied().enumerate() {
            let group = self
                .row_group_offsets
                .iter()
                .position(|(start, end)| *start <= row && row < *end)
                .ok_or_else(|| {
                    DataError::invalid_request("A query source row is outside the Parquet file.")
                })?;
            grouped.entry(group).or_default().push((row, output_index));
        }
        let row_groups = grouped.keys().copied().collect::<Vec<_>>();
        let mut group_bases = HashMap::with_capacity(row_groups.len());
        let mut base = 0_u64;
        for group in &row_groups {
            group_bases.insert(*group, base);
            let (start, end) = self.row_group_offsets[*group];
            base = base.saturating_add(end - start);
        }
        let mut targets: BTreeMap<u64, Vec<usize>> = BTreeMap::new();
        for (group, rows) in grouped {
            let group_start = self.row_group_offsets[group].0;
            let group_base = group_bases[&group];
            for (row, output_index) in rows {
                targets
                    .entry(group_base + row - group_start)
                    .or_default()
                    .push(output_index);
            }
        }
        let selected_rows = targets.keys().copied().collect::<Vec<_>>();
        let total_selected_group_rows = usize::try_from(base)
            .map_err(|_| DataError::invalid_request("Parquet occupancy row range overflow."))?;
        let ranges = selected_rows
            .iter()
            .map(|row| {
                let start = usize::try_from(*row).map_err(|_| {
                    DataError::invalid_request("Parquet occupancy row offset overflow.")
                })?;
                Ok(start..start.saturating_add(1))
            })
            .collect::<Result<Vec<_>, DataError>>()?;
        let selection =
            RowSelection::from_consecutive_ranges(ranges.into_iter(), total_selected_group_rows);
        #[cfg(test)]
        {
            self.record_reader_build(&row_groups, 1);
            self.record_occupancy_chunk();
        }
        let file = File::open(&self.path).map_err(|error| DataError::io(&self.path, error))?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file)
            .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
        let mask = ProjectionMask::roots(builder.parquet_schema(), projection.sorted_indices);
        let reader = builder
            .with_batch_size(row_ids.len().min(QUERY_OCCUPANCY_MAX_BATCH_ROWS))
            .with_row_groups(row_groups)
            .with_projection(mask)
            .with_row_selection(selection)
            .build()
            .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
        let mut output = vec![None; row_ids.len()];
        let mut selected_index = 0_usize;
        for batch in reader {
            let batch = batch.map_err(|error| DataError::invalid_parquet(&self.path, error))?;
            let decoded_bytes = batch
                .column(projection.batch_positions[0])
                .get_array_memory_size();
            #[cfg(test)]
            self.record_occupancy_decoded_batch(batch.num_rows(), decoded_bytes);
            if decoded_bytes > QUERY_OCCUPANCY_DECODED_BYTE_CAP {
                // Do not inspect a value or copy a state out of an oversized
                // batch. Release it immediately, then retry smaller slices.
                drop(batch);
                return Ok(OccupancyChunkRead::Split);
            }
            let array = batch.column(projection.batch_positions[0]).as_ref();
            for row_index in 0..batch.num_rows() {
                let target = selected_rows.get(selected_index).ok_or_else(|| {
                    DataError::query_failed("Parquet occupancy read returned too many rows.")
                })?;
                let occupied = arrow_value_occupied(array, row_index).ok_or_else(|| {
                    DataError::query_failed("Parquet occupancy type is unsupported.")
                })?;
                for output_index in targets.get(target).expect("selected target exists") {
                    output[*output_index] = Some(occupied);
                }
                selected_index += 1;
            }
        }
        if selected_index != selected_rows.len() {
            return Err(DataError::query_failed(
                "Parquet occupancy read did not return every requested row.",
            ));
        }
        output
            .into_iter()
            .map(|state| {
                state.ok_or_else(|| {
                    DataError::query_failed("A Parquet occupancy row is unavailable.")
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(OccupancyChunkRead::Values)
    }

    fn read_rows_exact_bounded(
        &self,
        row_ids: &[u64],
        columns: &[String],
        max_columns: usize,
    ) -> Result<Vec<Vec<DataValue>>, DataError> {
        if row_ids.is_empty() {
            return Ok(Vec::new());
        }
        let projection = self.validate_projection(Some(columns), max_columns)?;
        let mut grouped: BTreeMap<usize, Vec<(u64, usize)>> = BTreeMap::new();
        for (output_index, row) in row_ids.iter().copied().enumerate() {
            let group = self
                .row_group_offsets
                .iter()
                .position(|(start, end)| *start <= row && row < *end)
                .ok_or_else(|| {
                    DataError::invalid_request("A query source row is outside the Parquet file.")
                })?;
            grouped.entry(group).or_default().push((row, output_index));
        }
        let row_groups = grouped.keys().copied().collect::<Vec<_>>();
        let mut group_bases = HashMap::with_capacity(row_groups.len());
        let mut base = 0_u64;
        for group in &row_groups {
            group_bases.insert(*group, base);
            let (start, end) = self.row_group_offsets[*group];
            base = base.saturating_add(end - start);
        }
        let mut targets: BTreeMap<u64, Vec<usize>> = BTreeMap::new();
        for (group, rows) in grouped {
            let group_start = self.row_group_offsets[group].0;
            let group_base = group_bases[&group];
            for (row, output_index) in rows {
                targets
                    .entry(group_base + row - group_start)
                    .or_default()
                    .push(output_index);
            }
        }

        let selected_rows = targets.keys().copied().collect::<Vec<_>>();
        let total_selected_group_rows = usize::try_from(base)
            .map_err(|_| DataError::invalid_request("Parquet sparse row range overflow."))?;
        let ranges = selected_rows
            .iter()
            .map(|row| {
                let start = usize::try_from(*row).map_err(|_| {
                    DataError::invalid_request("Parquet sparse row offset overflow.")
                })?;
                let end = start.checked_add(1).ok_or_else(|| {
                    DataError::invalid_request("Parquet sparse row offset overflow.")
                })?;
                Ok(start..end)
            })
            .collect::<Result<Vec<_>, DataError>>()?;
        let selection =
            RowSelection::from_consecutive_ranges(ranges.into_iter(), total_selected_group_rows);

        #[cfg(test)]
        self.record_reader_build(&row_groups, projection.sorted_indices.len());

        let file = File::open(&self.path).map_err(|error| DataError::io(&self.path, error))?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file)
            .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
        let mask = ProjectionMask::roots(builder.parquet_schema(), projection.sorted_indices);
        let reader = builder
            .with_batch_size(4_096)
            .with_row_groups(row_groups)
            .with_projection(mask)
            .with_row_selection(selection)
            .build()
            .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
        let mut output = vec![None; row_ids.len()];
        let mut selected_index = 0_usize;
        for batch in reader {
            let batch = batch.map_err(|error| DataError::invalid_parquet(&self.path, error))?;
            #[cfg(test)]
            self.record_decoded_batch(batch.num_rows(), batch.num_columns());
            for row_index in 0..batch.num_rows() {
                let target = selected_rows.get(selected_index).ok_or_else(|| {
                    DataError::query_failed("Parquet sparse read returned too many rows.")
                })?;
                let output_indices = targets.get(target).expect("selected target exists");
                let values = projection
                    .batch_positions
                    .iter()
                    .map(|position| {
                        super::value_format::value_at(batch.column(*position).as_ref(), row_index)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                for output_index in output_indices {
                    output[*output_index] = Some(values.clone());
                }
                selected_index += 1;
            }
        }
        if selected_index != selected_rows.len() {
            return Err(DataError::query_failed(
                "Parquet sparse read did not return every requested row.",
            ));
        }
        output
            .into_iter()
            .map(|row| {
                row.ok_or_else(|| {
                    DataError::invalid_request("A query source row could not be decoded.")
                })
            })
            .collect()
    }

    fn read_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
        batch_size: usize,
        max_columns: usize,
    ) -> Result<DataPage, DataError> {
        let projection = self.validate_projection(columns, max_columns)?;
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
            .with_batch_size(batch_size)
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
        max_columns: usize,
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
                if columns.len() > max_columns {
                    return Err(DataError::invalid_request(format!(
                        "Column projection cannot exceed {max_columns} columns."
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

    fn find_vertical_boundary_vector(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<Option<BoundarySearchResult>, DataError> {
        if request.mode != DataBoundaryMode::DataBoundary
            || !matches!(
                request.direction,
                DataBoundaryDirection::Up | DataBoundaryDirection::Down
            )
        {
            return Ok(None);
        }
        let row_count = self.summary.row_count.expect("validated Parquet row count");
        let neighbor_row = match request.direction {
            DataBoundaryDirection::Down if request.row + 1 < row_count => request.row + 1,
            DataBoundaryDirection::Up if request.row > 0 => request.row - 1,
            _ => {
                return Ok(Some(BoundarySearchResult {
                    target_row: request.row,
                    target_column_id: request.column_id.clone(),
                    resolved_row_count: Some(row_count),
                }));
            }
        };
        let offset = request.row.min(neighbor_row);
        let projection = [request.column_id.clone()];
        let adjacent =
            self.read_projected(offset, 2, Some(&projection), 2, MAX_PROJECTION_COLUMNS)?;
        let current_index = usize::from(request.direction == DataBoundaryDirection::Up);
        let neighbor_index = 1 - current_index;
        let current_occupied = adjacent.rows[current_index]
            .first()
            .is_some_and(|value| boundary_value_occupied(value.state));
        let neighbor_occupied = adjacent.rows[neighbor_index]
            .first()
            .is_some_and(|value| boundary_value_occupied(value.state));
        let seek_occupied = !(current_occupied && neighbor_occupied);
        let column_index = self
            .summary
            .columns
            .iter()
            .position(|column| column.name == request.column_id)
            .expect("validated Parquet boundary column");
        let scan = self.scan_occupancy(
            column_index,
            request.row,
            request.direction,
            seek_occupied,
            cancel,
        )?;
        let OccupancyScan::Complete(found) = scan else {
            return Ok(None);
        };
        let edge = if request.direction == DataBoundaryDirection::Up {
            0
        } else {
            row_count - 1
        };
        let target_row = match (found, seek_occupied, request.direction) {
            (Some(row), true, _) => row,
            (Some(row), false, DataBoundaryDirection::Down) => row - 1,
            (Some(row), false, DataBoundaryDirection::Up) => row + 1,
            (None, _, _) => edge,
            _ => unreachable!(),
        };
        Ok(Some(BoundarySearchResult {
            target_row,
            target_column_id: request.column_id.clone(),
            resolved_row_count: Some(row_count),
        }))
    }

    fn scan_occupancy(
        &self,
        column_index: usize,
        current_row: u64,
        direction: DataBoundaryDirection,
        seek_occupied: bool,
        cancel: &AtomicBool,
    ) -> Result<OccupancyScan, DataError> {
        let mut row_groups = self
            .row_group_offsets
            .iter()
            .enumerate()
            .filter_map(|(index, (start, end))| match direction {
                DataBoundaryDirection::Down => (*end > current_row + 1).then_some(index),
                DataBoundaryDirection::Up => (*start < current_row).then_some(index),
                _ => None,
            })
            .collect::<Vec<_>>();
        if direction == DataBoundaryDirection::Up {
            row_groups.reverse();
        }
        if row_groups.is_empty() {
            return Ok(OccupancyScan::Complete(None));
        }
        for row_group in row_groups {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let (group_start, group_end) = self.row_group_offsets[row_group];
            let hint = self.row_group_occupancy[row_group][column_index];
            let hint_occupied = match hint {
                RowGroupOccupancy::AllOccupied => Some(true),
                RowGroupOccupancy::AllEmpty => Some(false),
                RowGroupOccupancy::Unknown => None,
            };
            if let Some(occupied) = hint_occupied {
                if occupied != seek_occupied {
                    continue;
                }
                let target = match direction {
                    DataBoundaryDirection::Down => group_start.max(current_row + 1),
                    DataBoundaryDirection::Up => (group_end - 1).min(current_row - 1),
                    _ => unreachable!(),
                };
                return Ok(OccupancyScan::Complete(Some(target)));
            }

            let file = File::open(&self.path).map_err(|error| DataError::io(&self.path, error))?;
            let builder = ParquetRecordBatchReaderBuilder::try_new(file)
                .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
            let mask = ProjectionMask::roots(builder.parquet_schema(), [column_index]);
            let reader = builder
                .with_batch_size(BOUNDARY_PAGE_SIZE)
                .with_row_groups(vec![row_group])
                .with_projection(mask)
                .build()
                .map_err(|error| DataError::invalid_parquet(&self.path, error))?;
            #[cfg(test)]
            self.record_reader_build(&[row_group], 1);
            let mut batch_start = group_start;
            let mut latest = None;
            for batch in reader {
                if cancel.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
                let batch = batch.map_err(|error| DataError::invalid_parquet(&self.path, error))?;
                #[cfg(test)]
                self.record_decoded_batch(batch.num_rows(), batch.num_columns());
                let array = batch.column(0).as_ref();
                for index in 0..batch.num_rows() {
                    let row = batch_start + index as u64;
                    let in_direction = match direction {
                        DataBoundaryDirection::Down => row > current_row,
                        DataBoundaryDirection::Up => row < current_row,
                        _ => false,
                    };
                    if !in_direction {
                        continue;
                    }
                    let Some(occupied) = arrow_value_occupied(array, index) else {
                        return Ok(OccupancyScan::Unsupported);
                    };
                    if occupied == seek_occupied {
                        if direction == DataBoundaryDirection::Down {
                            return Ok(OccupancyScan::Complete(Some(row)));
                        }
                        latest = Some(row);
                    }
                }
                batch_start += batch.num_rows() as u64;
            }
            if latest.is_some() {
                return Ok(OccupancyScan::Complete(latest));
            }
        }
        Ok(OccupancyScan::Complete(None))
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
        for row_group in row_groups {
            if !audit.selected_row_groups_union.contains(row_group) {
                audit.selected_row_groups_union.push(*row_group);
            }
        }
        audit.selected_row_groups_union.sort_unstable();
        audit.projected_root_columns = projected_root_columns;
    }

    #[cfg(test)]
    fn record_decoded_batch(&self, rows: usize, columns: usize) {
        let mut audit = self.decode_audit.lock().expect("decode audit lock");
        audit.decoded_batches += 1;
        audit.decoded_rows += rows;
        audit.decoded_columns = audit.decoded_columns.max(columns);
    }

    #[cfg(test)]
    fn record_occupancy_chunk(&self) {
        self.decode_audit
            .lock()
            .expect("decode audit lock")
            .occupancy_decode_chunks += 1;
    }

    #[cfg(test)]
    fn record_occupancy_split(&self) {
        self.decode_audit
            .lock()
            .expect("decode audit lock")
            .occupancy_decode_splits += 1;
    }

    #[cfg(test)]
    fn record_occupancy_decoded_batch(&self, rows: usize, bytes: usize) {
        let mut audit = self.decode_audit.lock().expect("decode audit lock");
        audit.decoded_batches += 1;
        audit.decoded_rows += rows;
        audit.decoded_columns = audit.decoded_columns.max(1);
        audit.occupancy_max_observed_decoded_bytes =
            audit.occupancy_max_observed_decoded_bytes.max(bytes);
        if bytes > QUERY_OCCUPANCY_DECODED_BYTE_CAP {
            audit.occupancy_oversized_batches += 1;
        } else {
            audit.occupancy_max_accepted_decoded_bytes =
                audit.occupancy_max_accepted_decoded_bytes.max(bytes);
        }
    }
}

#[derive(Debug)]
struct ParquetQueryProvider {
    source: ParquetSource,
}

impl QueryInputProvider for ParquetQueryProvider {
    fn native_query_types(&self) -> bool {
        true
    }

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
                    format!(
                        "{} AS {}",
                        parquet_query_raw_expression(&identifier, &column.logical_type),
                        query_raw_name(index)
                    ),
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

    fn sparse_query_values(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        let rows = self.source.read_rows_exact(row_ids, columns)?;
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
        let rows = self.source.read_rows_exact_bounded(
            row_ids,
            columns,
            self.source.summary.column_count,
        )?;
        Ok(QueryExactValues {
            columns: columns.to_vec(),
            rows,
        })
    }

    fn occupancy_states(&self, row_ids: &[u64], column: &str) -> Result<Vec<bool>, DataError> {
        self.source.read_occupancy_states_exact(row_ids, column)
    }

    fn uniform_occupancy(&self, column: &str) -> Option<bool> {
        let column_index = self
            .source
            .summary
            .columns
            .iter()
            .position(|candidate| candidate.name == column)?;
        let mut groups = self
            .source
            .row_group_occupancy
            .iter()
            .map(|columns| columns[column_index]);
        let first = groups.next()?;
        if groups.any(|state| state != first) {
            return None;
        }
        match first {
            RowGroupOccupancy::AllOccupied => Some(true),
            RowGroupOccupancy::AllEmpty => Some(false),
            RowGroupOccupancy::Unknown => None,
        }
    }
}

fn parquet_query_raw_expression(identifier: &str, _logical_type: &str) -> String {
    format!("CAST({identifier} AS VARCHAR)")
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
            provider: Arc::new(ParquetQueryProvider {
                source: self.clone(),
            }),
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
                "Parquet copy batches must contain 1 to 64,000 cells.",
            ));
        }
        self.read_projected(
            offset,
            limit,
            Some(columns),
            limit.min(4_096),
            self.summary.column_count,
        )
    }

    fn read_cell_value(&self, row: u64, column: &str) -> Result<DataValue, DataError> {
        self.read_cell_value_full(row, column)
    }

    fn find_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        super::validate_boundary_request(&self.summary.columns, self.summary.row_count, request)?;
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if request.mode == DataBoundaryMode::DataBoundary
            && matches!(
                request.direction,
                DataBoundaryDirection::Up | DataBoundaryDirection::Down
            )
        {
            let column = self
                .summary
                .columns
                .iter()
                .find(|column| column.name == request.column_id)
                .expect("validated Parquet boundary column");
            let logical_type = column.logical_type.to_ascii_lowercase();
            let can_contain_empty_string =
                logical_type.contains("utf8") || logical_type.contains("string");
            if !column.nullable && !can_contain_empty_string {
                let row_count = self.summary.row_count.expect("validated Parquet row count");
                return Ok(BoundarySearchResult {
                    target_row: if request.direction == DataBoundaryDirection::Up {
                        0
                    } else {
                        row_count - 1
                    },
                    target_column_id: request.column_id.clone(),
                    resolved_row_count: Some(row_count),
                });
            }
        }
        if let Some(result) = self.find_vertical_boundary_vector(request, cancel)? {
            return Ok(result);
        }
        super::boundary::find_boundary_batched(
            &self.summary.columns,
            self.summary.row_count,
            request,
            cancel,
            BOUNDARY_PAGE_SIZE,
            |offset, limit, columns| {
                self.read_projected(
                    offset,
                    limit,
                    Some(columns),
                    BOUNDARY_PAGE_SIZE,
                    MAX_PROJECTION_COLUMNS,
                )
            },
        )
    }
}

fn boundary_value_occupied(state: DataValueState) -> bool {
    matches!(state, DataValueState::Valid | DataValueState::Invalid)
}

fn occupancy_from_statistics(
    column: &ColumnSchema,
    row_count: u64,
    statistics: Option<&parquet::file::statistics::Statistics>,
) -> RowGroupOccupancy {
    let Some(statistics) = statistics else {
        return RowGroupOccupancy::Unknown;
    };
    if statistics.null_count_opt() == Some(row_count) {
        return RowGroupOccupancy::AllEmpty;
    }
    let logical_type = column.logical_type.to_ascii_lowercase();
    let is_string = logical_type.contains("utf8") || logical_type.contains("string");
    if is_string {
        if statistics.max_is_exact() && statistics.max_bytes_opt() == Some(b"".as_slice()) {
            return RowGroupOccupancy::AllEmpty;
        }
        let has_no_nulls = !column.nullable || statistics.null_count_opt() == Some(0);
        if has_no_nulls
            && statistics.min_is_exact()
            && statistics
                .min_bytes_opt()
                .is_some_and(|minimum| !minimum.is_empty())
        {
            return RowGroupOccupancy::AllOccupied;
        }
        return RowGroupOccupancy::Unknown;
    }
    match statistics.null_count_opt() {
        Some(0) => RowGroupOccupancy::AllOccupied,
        Some(nulls) if nulls == row_count => RowGroupOccupancy::AllEmpty,
        _ => RowGroupOccupancy::Unknown,
    }
}

fn arrow_value_occupied(array: &dyn Array, index: usize) -> Option<bool> {
    if array.is_null(index) {
        return Some(false);
    }
    match array.data_type() {
        DataType::Utf8 => array
            .as_any()
            .downcast_ref::<StringArray>()
            .map(|values| !values.value(index).is_empty()),
        DataType::LargeUtf8 => array
            .as_any()
            .downcast_ref::<LargeStringArray>()
            .map(|values| !values.value(index).is_empty()),
        DataType::Dictionary(_, value)
            if matches!(value.as_ref(), DataType::Utf8 | DataType::LargeUtf8) =>
        {
            None
        }
        _ => Some(true),
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
    use parquet::file::properties::{EnabledStatistics, WriterProperties};
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

    fn write_string_statistics_fixture(path: &Path) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "category",
            DataType::Utf8,
            false,
        )]));
        let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema.clone(), None)
            .expect("string statistics fixture writer");
        for values in [vec!["alpha", "alpha"], vec!["", ""], vec!["beta", "beta"]] {
            writer
                .write(
                    &RecordBatch::try_new(
                        schema.clone(),
                        vec![Arc::new(StringArray::from(values)) as ArrayRef],
                    )
                    .unwrap(),
                )
                .unwrap();
            writer.flush().unwrap();
        }
        writer.close().unwrap();
    }

    fn write_long_string_occupancy_fixture(path: &Path) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "payload",
            DataType::Utf8,
            true,
        )]));
        let values = (0..4_096)
            .map(|index| format!("{}-{index:05}", "x".repeat(4_090)))
            .collect::<Vec<_>>();
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![Arc::new(StringArray::from(values)) as ArrayRef],
        )
        .unwrap();
        let properties = WriterProperties::builder()
            .set_dictionary_enabled(false)
            .build();
        let mut writer =
            ArrowWriter::try_new(File::create(path).unwrap(), schema, Some(properties)).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
    }

    fn write_skewed_string_occupancy_fixture(path: &Path) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "payload",
            DataType::Utf8,
            true,
        )]));
        let huge = "a".repeat(5 * 1024 * 1024);
        let mut values = Vec::with_capacity(2_048);
        values.push(huge.clone());
        values.push(huge);
        values.extend((2..2_048).map(|index| format!("z-{index}")));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![Arc::new(StringArray::from(values)) as ArrayRef],
        )
        .unwrap();
        let properties = WriterProperties::builder()
            .set_dictionary_enabled(false)
            .set_statistics_enabled(EnabledStatistics::None)
            .build();
        let mut writer =
            ArrowWriter::try_new(File::create(path).unwrap(), schema, Some(properties)).unwrap();
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
    fn non_nullable_non_string_boundary_uses_schema_invariants_without_decoding() {
        let (_directory, path) = fixture();
        let source = ParquetSource::open(path).unwrap();
        let result = source
            .find_boundary(
                &BoundarySearchRequest {
                    row: 1,
                    column_id: String::from("id"),
                    visible_column_ids: vec![String::from("id")],
                    direction: DataBoundaryDirection::Down,
                    mode: DataBoundaryMode::DataBoundary,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(result.target_row, 3);
        assert_eq!(source.take_decode_audit().reader_builds, 0);
    }

    #[test]
    fn nullable_and_string_boundaries_scan_arrow_vectors_without_display_state_drift() {
        let (_directory, path) = fixture();
        let source = ParquetSource::open(path).unwrap();
        let find = |row, column: &str, direction| {
            source
                .find_boundary(
                    &BoundarySearchRequest {
                        row,
                        column_id: column.to_owned(),
                        visible_column_ids: vec![column.to_owned()],
                        direction,
                        mode: DataBoundaryMode::DataBoundary,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap()
                .target_row
        };

        assert_eq!(find(0, "name", DataBoundaryDirection::Down), 3);
        assert_eq!(find(3, "name", DataBoundaryDirection::Up), 0);
        assert_eq!(find(0, "score", DataBoundaryDirection::Down), 1);
        assert_eq!(find(3, "score", DataBoundaryDirection::Up), 1);
        let audit = source.take_decode_audit();
        assert_eq!(audit.projected_root_columns, 1);
        assert!(audit.decoded_rows <= 24);
    }

    #[test]
    fn query_occupancy_splits_long_strings_under_the_actual_arrow_byte_cap() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("long-string-occupancy.parquet");
        write_long_string_occupancy_fixture(&path);
        let source = ParquetSource::open(path).unwrap();
        let row_ids = (0..4_096).collect::<Vec<_>>();

        let states = source
            .read_occupancy_states_exact(&row_ids, "payload")
            .unwrap();
        assert_eq!(states, vec![true; row_ids.len()]);
        let audit = source.take_decode_audit();
        assert!(audit.occupancy_decode_chunks >= 2, "{audit:?}");
        assert_eq!(audit.occupancy_oversized_batches, 0, "{audit:?}");
        assert!(
            audit.occupancy_max_accepted_decoded_bytes <= QUERY_OCCUPANCY_DECODED_BYTE_CAP,
            "{audit:?}"
        );
        assert_eq!(audit.decoded_rows, row_ids.len());
    }

    #[test]
    fn skewed_occupancy_discards_an_initial_oversize_batch_then_splits_below_cap() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("skewed-string-occupancy.parquet");
        write_skewed_string_occupancy_fixture(&path);
        let source = ParquetSource::open(path).unwrap();
        let row_ids = (0..2_048).collect::<Vec<_>>();

        let states = source
            .read_occupancy_states_exact(&row_ids, "payload")
            .unwrap();
        assert_eq!(states, vec![true; row_ids.len()]);
        let audit = source.take_decode_audit();
        assert!(audit.occupancy_oversized_batches >= 1, "{audit:?}");
        assert!(audit.occupancy_decode_splits >= 1, "{audit:?}");
        assert!(
            audit.occupancy_max_observed_decoded_bytes > QUERY_OCCUPANCY_DECODED_BYTE_CAP,
            "{audit:?}"
        );
        assert!(
            audit.occupancy_max_accepted_decoded_bytes <= QUERY_OCCUPANCY_DECODED_BYTE_CAP,
            "{audit:?}"
        );
    }

    #[test]
    fn string_boundary_uses_exact_row_group_statistics_before_decoding() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("string-statistics.parquet");
        write_string_statistics_fixture(&path);
        let source = ParquetSource::open(path).unwrap();
        let find = |row, direction| {
            source
                .find_boundary(
                    &BoundarySearchRequest {
                        row,
                        column_id: String::from("category"),
                        visible_column_ids: vec![String::from("category")],
                        direction,
                        mode: DataBoundaryMode::DataBoundary,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap()
                .target_row
        };

        assert_eq!(find(0, DataBoundaryDirection::Down), 1);
        assert_eq!(find(1, DataBoundaryDirection::Down), 4);
        assert_eq!(find(5, DataBoundaryDirection::Up), 4);
        assert_eq!(find(4, DataBoundaryDirection::Up), 1);
        let audit = source.take_decode_audit();
        assert_eq!(
            audit.reader_builds, 4,
            "only the four adjacent probes decode"
        );
    }

    #[test]
    #[ignore = "requires PHASE11_LARGE_FIXTURE"]
    fn phase11_large_category_boundary_uses_statistics() {
        let path = std::env::var_os("PHASE11_LARGE_FIXTURE")
            .map(PathBuf::from)
            .expect("set PHASE11_LARGE_FIXTURE to the 5.85M Parquet fixture");
        let source = ParquetSource::open(path).unwrap();
        let row_count = source.summary.row_count.unwrap();
        let find = |row, direction| {
            let started = std::time::Instant::now();
            let result = source
                .find_boundary(
                    &BoundarySearchRequest {
                        row,
                        column_id: String::from("category"),
                        visible_column_ids: vec![String::from("category")],
                        direction,
                        mode: DataBoundaryMode::DataBoundary,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap();
            (result, started.elapsed())
        };

        let (down, down_elapsed) = find(0, DataBoundaryDirection::Down);
        let (up, up_elapsed) = find(row_count - 1, DataBoundaryDirection::Up);
        assert_eq!(down.target_row, row_count - 1);
        assert_eq!(up.target_row, 0);
        assert_eq!(
            source.take_decode_audit().reader_builds,
            2,
            "only the adjacent two-row probes may decode"
        );
        println!("phase11 category boundary: down={down_elapsed:?}, up={up_elapsed:?}");
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
    fn page_005_sparse_rows_use_projection_selection_and_restore_query_order() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sparse-selection.parquet");
        write_page_cap_fixture(&path);
        let source = ParquetSource::open(path).unwrap();
        let rows = source
            .read_rows_exact(&[204, 0, 100], &[String::from("id")])
            .unwrap();

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][0].display.as_deref(), Some("204"));
        assert_eq!(rows[1][0].display.as_deref(), Some("0"));
        assert_eq!(rows[2][0].display.as_deref(), Some("100"));
        let audit = source.take_decode_audit();
        assert_eq!(audit.projected_root_columns, 1);
        assert_eq!(audit.decoded_rows, 3);
        assert_eq!(audit.decoded_columns, 1);
    }

    #[test]
    fn copy_projection_reads_more_than_a_public_page_in_one_bounded_batch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("copy-bulk.parquet");
        write_page_cap_fixture(&path);
        let source = ParquetSource::open(path).unwrap();

        let page = source
            .read_copy_projected(0, 205, &[String::from("id")])
            .unwrap();
        assert_eq!(page.rows.len(), 205);
        assert_eq!(page.rows[0][0].display.as_deref(), Some("0"));
        assert_eq!(page.rows[204][0].display.as_deref(), Some("204"));
        let audit = source.take_decode_audit();
        assert_eq!(audit.projected_root_columns, 1);
        assert_eq!(audit.decoded_rows, 205);
        assert_eq!(audit.decoded_columns, 1);

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
