//! Projected occupancy reads for SQL result navigation.
use std::{collections::BTreeMap, ops::Range};

use arrow_array::{Array, LargeStringArray, StringArray, StringViewArray};
use arrow_schema::DataType;
use parquet::arrow::{arrow_reader::RowSelection, ProjectionMask};

use super::{result_view::check_view_current, *};
use crate::data::{resolve_boundary_batched, value_format::resolve_dictionary_value};

const ROW_BATCH: usize = 4_096;

impl QueryService {
    pub fn find_sql_result_boundary(
        &self,
        run_id: &str,
        result_id: &str,
        view_id: Option<&str>,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        let result = self.sql_result(run_id, result_id)?;
        result.check_boundary_current(cancel)?;
        let target = if let Some(view_id) = view_id {
            let view = result.view(view_id)?;
            let indexed = self.sql_view_result(&view)?;
            let target = if request.mode == DataBoundaryMode::DataBoundary
                && matches!(
                    request.direction,
                    DataBoundaryDirection::Left | DataBoundaryDirection::Right
                ) {
                let mut source_row = None;
                resolve_boundary_batched(
                    &result.view_columns(),
                    Some(indexed.row_count),
                    request,
                    cancel,
                    ROW_BATCH,
                    |offset, limit, columns| {
                        check_view_current(&result, &view)?;
                        let row = if let Some(row) = source_row {
                            row
                        } else {
                            let row = indexed
                                .connection
                                .lock()
                                .map_err(|_| registry_error())?
                                .query_row(
                                    "SELECT q.__dv_row_id FROM query_result q WHERE q.rowid = ?",
                                    params![offset],
                                    |record| record.get::<_, u64>(0),
                                )
                                .map_err(duckdb_error)?;
                            source_row = Some(row);
                            row
                        };
                        let mut page = result.boundary_page(row, limit, columns, cancel)?;
                        page.offset = offset;
                        page.total_rows = Some(indexed.row_count);
                        page.has_more = offset + 1 < indexed.row_count;
                        Ok(page)
                    },
                )?
            } else {
                indexed.find_boundary(request, cancel)?
            };
            check_view_current(&result, &view)?;
            target
        } else {
            resolve_boundary_batched(
                &result.view_columns(),
                Some(result.rows),
                request,
                cancel,
                ROW_BATCH,
                |offset, limit, columns| result.boundary_page(offset, limit, columns, cancel),
            )?
        };
        result.check_boundary_current(cancel)?;
        Ok(target)
    }
}

impl SqlResult {
    fn check_boundary_current(&self, cancel: &AtomicBool) -> Result<(), DataError> {
        if cancel.load(Ordering::Acquire)
            || !self.alive.load(Ordering::Acquire)
            || !self.tab_owned.load(Ordering::Acquire)
        {
            return Err(DataError::task_cancelled());
        }
        Ok(())
    }

    fn boundary_page(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
        cancel: &AtomicBool,
    ) -> Result<DataPage, DataError> {
        let mut indices = columns
            .iter()
            .map(|column| self.boundary_column(column))
            .collect::<Result<Vec<_>, _>>()?;
        let projected_order = indices.clone();
        indices.sort_unstable();
        let projected_order = projected_order
            .into_iter()
            .map(|column| {
                indices
                    .binary_search(&column)
                    .map_err(|_| error("SQL boundary projection is invalid."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let end = offset.saturating_add(limit as u64).min(self.rows);
        let expected = end.saturating_sub(offset) as usize;
        let mut rows = Vec::with_capacity(expected);
        let first = self.boundary_chunk_at(offset);
        for chunk in self
            .chunks
            .iter()
            .skip(first)
            .take_while(|chunk| chunk.offset < end)
        {
            self.check_boundary_current(cancel)?;
            let start = offset.saturating_sub(chunk.offset) as usize;
            let stop = (end - chunk.offset).min(chunk.rows) as usize;
            self.visit_boundary_batches(chunk, &indices, std::iter::once(start..stop), |batch| {
                self.check_boundary_current(cancel)?;
                for row in 0..batch.num_rows() {
                    let states = projected_order
                        .iter()
                        .map(|&index| {
                            // The shared navigation resolver only inspects the state. These
                            // values never leave the boundary search or carry display text.
                            array_occupied(batch.column(index).as_ref(), row).map(|occupied| {
                                if occupied {
                                    DataValue::displayed(ValueKind::Boolean, String::new())
                                } else {
                                    DataValue::null()
                                }
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    rows.push(states);
                }
                Ok(())
            })?;
        }
        self.check_boundary_current(cancel)?;
        if rows.len() != expected {
            return Err(error(
                "SQL boundary read did not return every requested row.",
            ));
        }
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(self.rows),
            has_more: end < self.rows,
            columns: columns.to_vec(),
            rows,
        })
    }

    pub(super) fn boundary_occupancy(
        &self,
        ids: &[u64],
        column: &str,
    ) -> Result<Vec<bool>, DataError> {
        let column = self.boundary_column(column)?;
        let mut groups: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
        for (output, &id) in ids.iter().enumerate() {
            let index = self.boundary_chunk_at(id);
            let chunk = self
                .chunks
                .get(index)
                .filter(|chunk| chunk.offset <= id)
                .ok_or_else(|| error("SQL boundary view contains an invalid row identity."))?;
            groups
                .entry(index)
                .or_default()
                .push(((id - chunk.offset) as usize, output));
        }
        let mut states = vec![false; ids.len()];
        for (index, mut group) in groups {
            group.sort_unstable();
            let chunk = &self.chunks[index];
            let mut ranges = group.iter().map(|&(row, _)| row).peekable();
            let ranges = std::iter::from_fn(move || {
                let row = ranges.next()?;
                while ranges.next_if_eq(&row).is_some() {}
                Some(row..row + 1)
            });
            let mut positions = group.iter().copied().peekable();
            self.visit_boundary_batches(chunk, &[column], ranges, |batch| {
                if !self.alive.load(Ordering::Acquire) || !self.tab_owned.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
                for row in 0..batch.num_rows() {
                    let (position, output) = positions
                        .next()
                        .ok_or_else(|| error("SQL boundary read returned an unexpected row."))?;
                    let occupied = array_occupied(batch.column(0).as_ref(), row)?;
                    states[output] = occupied;
                    while let Some((_, output)) = positions.next_if(|(row, _)| *row == position) {
                        states[output] = occupied;
                    }
                }
                Ok(())
            })?;
            if positions.next().is_some() {
                return Err(error(
                    "SQL boundary read did not return every requested row.",
                ));
            }
        }
        Ok(states)
    }

    fn boundary_column(&self, column: &str) -> Result<usize, DataError> {
        self.columns
            .iter()
            .position(|candidate| candidate.id == column)
            .ok_or_else(|| invalid("Unknown SQL boundary column."))
    }

    fn boundary_chunk_at(&self, row: u64) -> usize {
        self.chunks
            .partition_point(|chunk| chunk.offset + chunk.rows <= row)
    }

    fn visit_boundary_batches(
        &self,
        chunk: &ResultChunk,
        indices: &[usize],
        ranges: impl Iterator<Item = Range<usize>>,
        mut visit: impl FnMut(RecordBatch) -> Result<(), DataError>,
    ) -> Result<(), DataError> {
        let builder = export::reader_builder(self, &chunk.file)?;
        let mask = ProjectionMask::roots(builder.parquet_schema(), indices.iter().copied());
        let selection = RowSelection::from_consecutive_ranges(ranges, chunk.rows as usize);
        let reader = builder
            .with_projection(mask)
            .with_row_selection(selection)
            .with_batch_size(256)
            .build()
            .map_err(|err| error(err.to_string()))?;
        for batch in reader {
            visit(batch.map_err(|err| error(err.to_string()))?)?;
        }
        Ok(())
    }
}

fn array_occupied(array: &dyn Array, row: usize) -> Result<bool, DataError> {
    let (array, row) = resolve_dictionary_value(array, row)?;
    if array.is_null(row) || array.data_type() == &DataType::Null {
        return Ok(false);
    }
    let text = match array.data_type() {
        DataType::Utf8 => array
            .as_any()
            .downcast_ref::<StringArray>()
            .map(|a| a.value(row)),
        DataType::LargeUtf8 => array
            .as_any()
            .downcast_ref::<LargeStringArray>()
            .map(|a| a.value(row)),
        DataType::Utf8View => array
            .as_any()
            .downcast_ref::<StringViewArray>()
            .map(|a| a.value(row)),
        _ => return Ok(true),
    };
    text.map(|value| !value.is_empty())
        .ok_or_else(|| error("SQL boundary read returned an invalid string array."))
}
