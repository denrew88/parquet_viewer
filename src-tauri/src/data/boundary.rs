use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
};

use crate::domain::{
    BoundarySearchRequest, BoundarySearchResult, ColumnSchema, DataBoundaryDirection,
    DataBoundaryMode, DataError, DataPage, DataValueState,
};

const BOUNDARY_ROW_BATCH: usize = 200;
const BOUNDARY_COLUMN_BATCH: usize = 64;

pub(crate) fn find_boundary(
    columns: &[ColumnSchema],
    known_row_count: Option<u64>,
    request: &BoundarySearchRequest,
    cancel: &AtomicBool,
    read: impl FnMut(u64, usize, &[String]) -> Result<DataPage, DataError>,
) -> Result<BoundarySearchResult, DataError> {
    find_boundary_batched(
        columns,
        known_row_count,
        request,
        cancel,
        BOUNDARY_ROW_BATCH,
        read,
    )
}

pub(crate) fn find_boundary_batched(
    columns: &[ColumnSchema],
    known_row_count: Option<u64>,
    request: &BoundarySearchRequest,
    cancel: &AtomicBool,
    row_batch: usize,
    mut read: impl FnMut(u64, usize, &[String]) -> Result<DataPage, DataError>,
) -> Result<BoundarySearchResult, DataError> {
    validate_request(columns, known_row_count, request)?;
    check_cancel(cancel)?;

    let current_column = request
        .visible_column_ids
        .iter()
        .position(|column| column == &request.column_id)
        .expect("validated current column");

    if request.mode == DataBoundaryMode::TableBoundary {
        return match request.direction {
            DataBoundaryDirection::Up => {
                Ok(result(request, 0, &request.column_id, known_row_count))
            }
            DataBoundaryDirection::Left => Ok(result(
                request,
                request.row,
                &request.visible_column_ids[0],
                known_row_count,
            )),
            DataBoundaryDirection::Right => Ok(result(
                request,
                request.row,
                request
                    .visible_column_ids
                    .last()
                    .expect("non-empty columns"),
                known_row_count,
            )),
            DataBoundaryDirection::Down => {
                if let Some(total) = known_row_count {
                    Ok(result(request, total - 1, &request.column_id, Some(total)))
                } else {
                    let (last, total) =
                        find_eof(request.row, &request.column_id, cancel, &mut read)?;
                    Ok(result(request, last, &request.column_id, Some(total)))
                }
            }
        };
    }

    match request.direction {
        DataBoundaryDirection::Up | DataBoundaryDirection::Down => {
            find_vertical(known_row_count, request, cancel, row_batch, &mut read)
        }
        DataBoundaryDirection::Left | DataBoundaryDirection::Right => {
            find_horizontal(known_row_count, request, current_column, cancel, &mut read)
        }
    }
}

pub(crate) fn validate_request(
    columns: &[ColumnSchema],
    known_row_count: Option<u64>,
    request: &BoundarySearchRequest,
) -> Result<(), DataError> {
    if columns.is_empty() || request.visible_column_ids.is_empty() {
        return Err(DataError::invalid_request(
            "Boundary navigation requires at least one visible column.",
        ));
    }
    if known_row_count == Some(0) || known_row_count.is_some_and(|total| request.row >= total) {
        return Err(DataError::invalid_request(
            "Boundary navigation row is outside the data table.",
        ));
    }
    let available = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let mut visible = HashSet::with_capacity(request.visible_column_ids.len());
    for column in &request.visible_column_ids {
        if !available.contains(column.as_str()) {
            return Err(DataError::invalid_request(format!(
                "Unknown visible boundary column: {column}"
            )));
        }
        if !visible.insert(column.as_str()) {
            return Err(DataError::invalid_request(
                "Visible boundary columns must be unique.",
            ));
        }
    }
    if !visible.contains(request.column_id.as_str()) {
        return Err(DataError::invalid_request(
            "The active boundary column must be visible.",
        ));
    }
    Ok(())
}

fn find_vertical(
    known_row_count: Option<u64>,
    request: &BoundarySearchRequest,
    cancel: &AtomicBool,
    row_batch: usize,
    read: &mut impl FnMut(u64, usize, &[String]) -> Result<DataPage, DataError>,
) -> Result<BoundarySearchResult, DataError> {
    let projection = [request.column_id.clone()];
    let current_page = read(request.row, 1, &projection)?;
    let current = current_page
        .rows
        .first()
        .and_then(|row| row.first())
        .ok_or_else(|| {
            DataError::invalid_request("Boundary navigation row is outside the data table.")
        })?;
    let mut resolved = known_row_count.or(current_page.total_rows);
    let current_occupied = occupied(current.state);

    let mut target = request.row;
    let mut first_neighbor = true;
    let mut seek_occupied = false;
    let mut offset = match request.direction {
        DataBoundaryDirection::Down => request.row.saturating_add(1),
        DataBoundaryDirection::Up => request.row,
        _ => unreachable!(),
    };

    loop {
        check_cancel(cancel)?;
        let (page_offset, limit, reverse) = match request.direction {
            DataBoundaryDirection::Down => {
                if resolved.is_some_and(|total| offset >= total) {
                    return Ok(result(request, target, &request.column_id, resolved));
                }
                let limit = resolved
                    .map(|total| total.saturating_sub(offset).min(row_batch as u64) as usize)
                    .unwrap_or(row_batch);
                (offset, limit.max(1), false)
            }
            DataBoundaryDirection::Up => {
                if offset == 0 {
                    return Ok(result(request, target, &request.column_id, resolved));
                }
                let start = offset.saturating_sub(row_batch as u64);
                (start, (offset - start) as usize, true)
            }
            _ => unreachable!(),
        };
        let page = read(page_offset, limit, &projection)?;
        resolved = resolved.or(page.total_rows);
        if page.rows.is_empty() {
            let total = page_offset;
            resolved = Some(total);
            let last = total.saturating_sub(1);
            return Ok(result(
                request,
                target.min(last),
                &request.column_id,
                resolved,
            ));
        }

        let indices: Box<dyn Iterator<Item = usize>> = if reverse {
            Box::new((0..page.rows.len()).rev())
        } else {
            Box::new(0..page.rows.len())
        };
        for index in indices {
            let row_number = page.offset.saturating_add(index as u64);
            let is_occupied = page.rows[index]
                .first()
                .is_some_and(|value| occupied(value.state));
            if first_neighbor {
                seek_occupied = !(current_occupied && is_occupied);
                first_neighbor = false;
            }
            if seek_occupied {
                if is_occupied {
                    return Ok(result(request, row_number, &request.column_id, resolved));
                }
                target = row_number;
            } else if is_occupied {
                target = row_number;
            } else {
                return Ok(result(request, target, &request.column_id, resolved));
            }
        }

        match request.direction {
            DataBoundaryDirection::Down => {
                offset = page.offset.saturating_add(page.rows.len() as u64);
                if !page.has_more {
                    let total = offset;
                    resolved = Some(total);
                    return Ok(result(request, target, &request.column_id, resolved));
                }
            }
            DataBoundaryDirection::Up => offset = page.offset,
            _ => unreachable!(),
        }
    }
}

fn find_horizontal(
    known_row_count: Option<u64>,
    request: &BoundarySearchRequest,
    current_column: usize,
    cancel: &AtomicBool,
    read: &mut impl FnMut(u64, usize, &[String]) -> Result<DataPage, DataError>,
) -> Result<BoundarySearchResult, DataError> {
    let current_projection = [request.column_id.clone()];
    let current_page = read(request.row, 1, &current_projection)?;
    let current = current_page
        .rows
        .first()
        .and_then(|row| row.first())
        .ok_or_else(|| {
            DataError::invalid_request("Boundary navigation row is outside the data table.")
        })?;
    let resolved = known_row_count.or(current_page.total_rows);
    let current_occupied = occupied(current.state);
    let mut target = current_column;
    let mut first_neighbor = true;
    let mut seek_occupied = false;
    let mut cursor = current_column;

    loop {
        check_cancel(cancel)?;
        let indices = match request.direction {
            DataBoundaryDirection::Left => {
                if cursor == 0 {
                    break;
                }
                let start = cursor.saturating_sub(BOUNDARY_COLUMN_BATCH);
                let values = (start..cursor).rev().collect::<Vec<_>>();
                cursor = start;
                values
            }
            DataBoundaryDirection::Right => {
                let start = cursor.saturating_add(1);
                if start >= request.visible_column_ids.len() {
                    break;
                }
                let end = start
                    .saturating_add(BOUNDARY_COLUMN_BATCH)
                    .min(request.visible_column_ids.len());
                cursor = end - 1;
                (start..end).collect::<Vec<_>>()
            }
            _ => unreachable!(),
        };
        let projection = indices
            .iter()
            .map(|index| request.visible_column_ids[*index].clone())
            .collect::<Vec<_>>();
        let page = read(request.row, 1, &projection)?;
        let row = page.rows.first().ok_or_else(|| {
            DataError::invalid_request("Boundary navigation row is outside the data table.")
        })?;
        if row.len() != projection.len() {
            return Err(DataError::invalid_request(
                "Boundary navigation projection did not return every requested column.",
            ));
        }
        for (position, index) in indices.iter().enumerate() {
            let is_occupied = occupied(row[position].state);
            if first_neighbor {
                seek_occupied = !(current_occupied && is_occupied);
                first_neighbor = false;
            }
            if seek_occupied {
                if is_occupied {
                    return Ok(result(
                        request,
                        request.row,
                        &request.visible_column_ids[*index],
                        resolved,
                    ));
                }
                target = *index;
            } else if is_occupied {
                target = *index;
            } else {
                return Ok(result(
                    request,
                    request.row,
                    &request.visible_column_ids[target],
                    resolved,
                ));
            }
        }
    }
    Ok(result(
        request,
        request.row,
        &request.visible_column_ids[target],
        resolved,
    ))
}

fn find_eof(
    start: u64,
    column_id: &str,
    cancel: &AtomicBool,
    read: &mut impl FnMut(u64, usize, &[String]) -> Result<DataPage, DataError>,
) -> Result<(u64, u64), DataError> {
    let projection = [column_id.to_owned()];
    let mut offset = start;
    loop {
        check_cancel(cancel)?;
        let page = read(offset, BOUNDARY_ROW_BATCH, &projection)?;
        if page.rows.is_empty() {
            return if offset == start {
                Err(DataError::invalid_request(
                    "Boundary navigation row is outside the data table.",
                ))
            } else {
                Ok((offset - 1, offset))
            };
        }
        offset = page.offset.saturating_add(page.rows.len() as u64);
        if !page.has_more {
            return Ok((offset - 1, offset));
        }
    }
}

fn result(
    _request: &BoundarySearchRequest,
    target_row: u64,
    target_column_id: &str,
    resolved_row_count: Option<u64>,
) -> BoundarySearchResult {
    BoundarySearchResult {
        target_row,
        target_column_id: target_column_id.to_owned(),
        resolved_row_count,
    }
}

pub(crate) fn occupied(state: DataValueState) -> bool {
    matches!(state, DataValueState::Valid | DataValueState::Invalid)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), DataError> {
    if cancel.load(Ordering::Acquire) {
        Err(DataError::task_cancelled())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{DataValue, ValueKind};

    fn schema() -> Vec<ColumnSchema> {
        ["a", "b", "c", "d", "e"]
            .into_iter()
            .map(|name| ColumnSchema {
                name: name.to_owned(),
                logical_type: String::from("Utf8"),
                nullable: true,
                physical_type: String::from("BYTE_ARRAY"),
            })
            .collect()
    }

    fn value(state: DataValueState) -> DataValue {
        match state {
            DataValueState::Valid => DataValue::displayed(ValueKind::String, "x"),
            DataValueState::Invalid => DataValue::invalid(ValueKind::String, "x", "bad", "bad"),
            DataValueState::Null => DataValue::null(),
            DataValueState::Empty => DataValue::empty(""),
        }
    }

    fn resolve(
        rows: &[Vec<DataValueState>],
        row: u64,
        column: &str,
        direction: DataBoundaryDirection,
        mode: DataBoundaryMode,
    ) -> BoundarySearchResult {
        let columns = schema();
        let names = columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        let request = BoundarySearchRequest {
            row,
            column_id: column.to_owned(),
            visible_column_ids: names.clone(),
            direction,
            mode,
        };
        find_boundary(
            &columns,
            Some(rows.len() as u64),
            &request,
            &AtomicBool::new(false),
            |offset, limit, projection| {
                let selected = projection
                    .iter()
                    .map(|name| {
                        names
                            .iter()
                            .position(|candidate| candidate == name)
                            .unwrap()
                    })
                    .collect::<Vec<_>>();
                let page_rows = rows
                    .iter()
                    .skip(offset as usize)
                    .take(limit)
                    .map(|row| selected.iter().map(|index| value(row[*index])).collect())
                    .collect::<Vec<_>>();
                Ok(DataPage {
                    offset,
                    limit,
                    total_rows: Some(rows.len() as u64),
                    has_more: offset + (page_rows.len() as u64) < rows.len() as u64,
                    columns: projection.to_vec(),
                    rows: page_rows,
                })
            },
        )
        .unwrap()
    }

    #[test]
    fn vertical_data_boundary_matches_excel_region_rules_and_state_parity() {
        use DataValueState::{Empty as E, Invalid as I, Null as N, Valid as V};
        let rows = vec![
            vec![V, N, N, N, N],
            vec![I, N, N, N, N],
            vec![N, N, N, N, N],
            vec![E, N, N, N, N],
            vec![V, N, N, N, N],
            vec![V, N, N, N, N],
        ];
        assert_eq!(
            resolve(
                &rows,
                0,
                "a",
                DataBoundaryDirection::Down,
                DataBoundaryMode::DataBoundary
            )
            .target_row,
            1
        );
        assert_eq!(
            resolve(
                &rows,
                1,
                "a",
                DataBoundaryDirection::Down,
                DataBoundaryMode::DataBoundary
            )
            .target_row,
            4
        );
        assert_eq!(
            resolve(
                &rows,
                2,
                "a",
                DataBoundaryDirection::Down,
                DataBoundaryMode::DataBoundary
            )
            .target_row,
            4
        );
        assert_eq!(
            resolve(
                &rows,
                5,
                "a",
                DataBoundaryDirection::Up,
                DataBoundaryMode::DataBoundary
            )
            .target_row,
            4
        );
        assert_eq!(
            resolve(
                &rows,
                4,
                "a",
                DataBoundaryDirection::Up,
                DataBoundaryMode::DataBoundary
            )
            .target_row,
            1
        );
    }

    #[test]
    fn horizontal_uses_only_visible_column_order() {
        use DataValueState::{Null as N, Valid as V};
        let rows = [vec![V, V, N, V, V]];
        let columns = schema();
        let visible = vec![String::from("a"), String::from("c"), String::from("e")];
        let request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("a"),
            visible_column_ids: visible.clone(),
            direction: DataBoundaryDirection::Right,
            mode: DataBoundaryMode::DataBoundary,
        };
        let result = find_boundary(
            &columns,
            Some(1),
            &request,
            &AtomicBool::new(false),
            |offset, limit, projection| {
                let all = ["a", "b", "c", "d", "e"];
                let projected = projection
                    .iter()
                    .map(|name| {
                        let index = all.iter().position(|candidate| candidate == name).unwrap();
                        value(rows[0][index])
                    })
                    .collect();
                Ok(DataPage {
                    offset,
                    limit,
                    total_rows: Some(1),
                    has_more: false,
                    columns: projection.to_vec(),
                    rows: vec![projected],
                })
            },
        )
        .unwrap();
        assert_eq!(result.target_column_id, "e");
    }

    #[test]
    fn cancellation_is_checked_before_each_batch() {
        let cancel = AtomicBool::new(true);
        let request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("a"),
            visible_column_ids: vec![String::from("a")],
            direction: DataBoundaryDirection::Down,
            mode: DataBoundaryMode::DataBoundary,
        };
        let error = find_boundary(
            &schema(),
            Some(1),
            &request,
            &cancel,
            |_, _, _| unreachable!(),
        )
        .expect_err("cancelled navigation");
        assert_eq!(error.code, crate::domain::DataErrorCode::TaskCancelled);
    }
}
