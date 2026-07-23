use std::{
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use crate::domain::{
    BoundarySearchRequest, BoundarySearchResult, DataBoundaryDirection, DataBoundaryMode,
    DataError, DataValueState,
};

const CELLS_PER_WORD: usize = 32;
const EVEN_BITS: u64 = 0x5555_5555_5555_5555;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum CellState {
    Valid = 0b00,
    Null = 0b01,
    Empty = 0b10,
    Invalid = 0b11,
}

impl CellState {
    pub(crate) fn occupied(self) -> bool {
        matches!(self, Self::Valid | Self::Invalid)
    }
}

impl From<DataValueState> for CellState {
    fn from(value: DataValueState) -> Self {
        match value {
            DataValueState::Valid => Self::Valid,
            DataValueState::Null => Self::Null,
            DataValueState::Empty => Self::Empty,
            DataValueState::Invalid => Self::Invalid,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CellStateBitmap {
    columns: Vec<Vec<u64>>,
    rows: u64,
}

impl CellStateBitmap {
    pub(crate) fn new(column_count: usize) -> Self {
        Self {
            columns: vec![Vec::new(); column_count],
            rows: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn rows(&self) -> u64 {
        self.rows
    }

    #[cfg(test)]
    pub(crate) fn column_count(&self) -> usize {
        self.columns.len()
    }

    pub(crate) fn payload_bytes(&self) -> usize {
        self.columns
            .iter()
            .map(|column| column.len() * std::mem::size_of::<u64>())
            .sum()
    }

    pub(crate) fn write_file(&self, path: &Path) -> Result<u64, DataError> {
        let mut file = std::fs::File::create(path).map_err(|error| DataError::io(path, error))?;
        file.write_all(b"DVST\x01\0\0\0")
            .and_then(|()| file.write_all(&self.rows.to_le_bytes()))
            .and_then(|()| file.write_all(&(self.columns.len() as u64).to_le_bytes()))
            .map_err(|error| DataError::io(path, error))?;
        for column in &self.columns {
            for word in column {
                file.write_all(&word.to_le_bytes())
                    .map_err(|error| DataError::io(path, error))?;
            }
        }
        file.sync_all()
            .map_err(|error| DataError::io(path, error))?;
        file.metadata()
            .map(|metadata| metadata.len())
            .map_err(|error| DataError::io(path, error))
    }

    pub(crate) fn read_file(
        path: &Path,
        expected_rows: u64,
        expected_columns: usize,
    ) -> Result<Self, DataError> {
        let mut file = std::fs::File::open(path).map_err(|error| DataError::io(path, error))?;
        let mut header = [0_u8; 24];
        file.read_exact(&mut header)
            .map_err(|error| DataError::io(path, error))?;
        let rows = u64::from_le_bytes(header[8..16].try_into().unwrap());
        let columns = u64::from_le_bytes(header[16..24].try_into().unwrap());
        if &header[..8] != b"DVST\x01\0\0\0"
            || rows != expected_rows
            || columns != expected_columns as u64
        {
            return Err(DataError::query_failed(
                "Cached CSV state bitmap identity is invalid.",
            ));
        }
        let words_per_column = usize::try_from(rows.saturating_add(31) / 32)
            .map_err(|_| DataError::query_failed("Cached CSV state bitmap is too large."))?;
        let expected_words = words_per_column
            .checked_mul(expected_columns)
            .ok_or_else(|| DataError::query_failed("Cached CSV state bitmap is too large."))?;
        let mut words = vec![0_u8; expected_words.saturating_mul(8)];
        file.read_exact(&mut words)
            .map_err(|error| DataError::io(path, error))?;
        let mut trailing = [0_u8; 1];
        if file
            .read(&mut trailing)
            .map_err(|error| DataError::io(path, error))?
            != 0
        {
            return Err(DataError::query_failed(
                "Cached CSV state bitmap has trailing data.",
            ));
        }
        let mut packed = vec![Vec::with_capacity(words_per_column); expected_columns];
        for (column_index, column) in packed.iter_mut().enumerate() {
            for word_index in 0..words_per_column {
                let offset = (column_index * words_per_column + word_index) * 8;
                column.push(u64::from_le_bytes(
                    words[offset..offset + 8].try_into().unwrap(),
                ));
            }
        }
        Ok(Self {
            columns: packed,
            rows,
        })
    }

    pub(crate) fn push_row(&mut self, states: &[DataValueState]) -> Result<(), DataError> {
        if states.len() != self.columns.len() {
            return Err(DataError::query_failed(
                "A CSV state row does not match the visible column count.",
            ));
        }
        let word_index = usize::try_from(self.rows / CELLS_PER_WORD as u64)
            .map_err(|_| DataError::query_failed("The CSV state bitmap is too large."))?;
        let shift = ((self.rows as usize) % CELLS_PER_WORD) * 2;
        for (column, state) in self.columns.iter_mut().zip(states) {
            if column.len() == word_index {
                column.push(0);
            }
            column[word_index] |= u64::from(CellState::from(*state) as u8) << shift;
        }
        self.rows = self.rows.saturating_add(1);
        Ok(())
    }

    pub(crate) fn state(&self, row: u64, column: usize) -> Result<CellState, DataError> {
        if row >= self.rows || column >= self.columns.len() {
            return Err(DataError::invalid_request(
                "CSV state bitmap coordinates are outside the data table.",
            ));
        }
        let word = self.columns[column][row as usize / CELLS_PER_WORD];
        let code = ((word >> ((row as usize % CELLS_PER_WORD) * 2)) & 0b11) as u8;
        Ok(match code {
            0b00 => CellState::Valid,
            0b01 => CellState::Null,
            0b10 => CellState::Empty,
            0b11 => CellState::Invalid,
            _ => unreachable!(),
        })
    }

    pub(crate) fn occupancy(&self, row: u64, column: usize) -> Result<bool, DataError> {
        self.state(row, column).map(CellState::occupied)
    }

    pub(crate) fn find_boundary(
        &self,
        column_names: &[String],
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if self.rows == 0 || request.row >= self.rows {
            return Err(DataError::invalid_request(
                "Boundary navigation row is outside the data table.",
            ));
        }
        let column = column_names
            .iter()
            .position(|name| name == &request.column_id)
            .ok_or_else(|| DataError::invalid_request("Unknown CSV boundary column."))?;
        if request.mode == DataBoundaryMode::TableBoundary {
            let (target_row, target_column_id) = match request.direction {
                DataBoundaryDirection::Up => (0, request.column_id.clone()),
                DataBoundaryDirection::Down => (self.rows - 1, request.column_id.clone()),
                DataBoundaryDirection::Left => (
                    request.row,
                    request
                        .visible_column_ids
                        .first()
                        .cloned()
                        .ok_or_else(|| DataError::invalid_request("No visible CSV columns."))?,
                ),
                DataBoundaryDirection::Right => (
                    request.row,
                    request
                        .visible_column_ids
                        .last()
                        .cloned()
                        .ok_or_else(|| DataError::invalid_request("No visible CSV columns."))?,
                ),
            };
            return Ok(BoundarySearchResult {
                target_row,
                target_column_id,
                resolved_row_count: Some(self.rows),
            });
        }

        let (target_row, target_column_id) = match request.direction {
            DataBoundaryDirection::Up | DataBoundaryDirection::Down => (
                self.find_vertical(column, request.row, request.direction, cancel)?,
                request.column_id.clone(),
            ),
            DataBoundaryDirection::Left | DataBoundaryDirection::Right => (
                request.row,
                self.find_horizontal(column_names, request, cancel)?,
            ),
        };
        Ok(BoundarySearchResult {
            target_row,
            target_column_id,
            resolved_row_count: Some(self.rows),
        })
    }

    fn find_vertical(
        &self,
        column: usize,
        row: u64,
        direction: DataBoundaryDirection,
        cancel: &AtomicBool,
    ) -> Result<u64, DataError> {
        let current_occupied = self.occupancy(row, column)?;
        match direction {
            DataBoundaryDirection::Down => {
                let Some(neighbor) = row.checked_add(1).filter(|next| *next < self.rows) else {
                    return Ok(row);
                };
                let neighbor_occupied = self.occupancy(neighbor, column)?;
                if current_occupied && neighbor_occupied {
                    Ok(self
                        .find_next(column, neighbor, false, cancel)?
                        .map_or(self.rows - 1, |empty| empty - 1))
                } else {
                    Ok(self
                        .find_next(column, neighbor, true, cancel)?
                        .unwrap_or(self.rows - 1))
                }
            }
            DataBoundaryDirection::Up => {
                let Some(neighbor) = row.checked_sub(1) else {
                    return Ok(row);
                };
                let neighbor_occupied = self.occupancy(neighbor, column)?;
                if current_occupied && neighbor_occupied {
                    Ok(self
                        .find_previous(column, neighbor, false, cancel)?
                        .map_or(0, |empty| empty + 1))
                } else {
                    Ok(self
                        .find_previous(column, neighbor, true, cancel)?
                        .unwrap_or(0))
                }
            }
            _ => unreachable!(),
        }
    }

    fn find_horizontal(
        &self,
        column_names: &[String],
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<String, DataError> {
        let current = request
            .visible_column_ids
            .iter()
            .position(|name| name == &request.column_id)
            .ok_or_else(|| DataError::invalid_request("The active CSV column is not visible."))?;
        let current_occupied = self.occupancy(
            request.row,
            column_names
                .iter()
                .position(|name| name == &request.column_id)
                .ok_or_else(|| DataError::invalid_request("Unknown CSV boundary column."))?,
        )?;
        let mut cursor = current;
        let mut first = true;
        let mut seek_occupied = false;
        let mut target = current;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            cursor = match request.direction {
                DataBoundaryDirection::Left => match cursor.checked_sub(1) {
                    Some(next) => next,
                    None => break,
                },
                DataBoundaryDirection::Right => {
                    let next = cursor + 1;
                    if next >= request.visible_column_ids.len() {
                        break;
                    }
                    next
                }
                _ => unreachable!(),
            };
            let physical = column_names
                .iter()
                .position(|name| name == &request.visible_column_ids[cursor])
                .ok_or_else(|| DataError::invalid_request("Unknown visible CSV column."))?;
            let occupied = self.occupancy(request.row, physical)?;
            if first {
                seek_occupied = !(current_occupied && occupied);
                first = false;
            }
            if seek_occupied {
                if occupied {
                    return Ok(request.visible_column_ids[cursor].clone());
                }
                target = cursor;
            } else if occupied {
                target = cursor;
            } else {
                return Ok(request.visible_column_ids[target].clone());
            }
        }
        Ok(request.visible_column_ids[target].clone())
    }

    fn find_next(
        &self,
        column: usize,
        start: u64,
        occupied: bool,
        cancel: &AtomicBool,
    ) -> Result<Option<u64>, DataError> {
        let words = &self.columns[column];
        let mut word_index = start as usize / CELLS_PER_WORD;
        let mut bit = start as usize % CELLS_PER_WORD;
        while word_index < words.len() {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let mut mask = occupancy_mask(words[word_index]);
            if !occupied {
                mask = !mask;
            }
            mask &= valid_rows_mask(self.rows, word_index);
            mask &= u32::MAX << bit;
            if mask != 0 {
                return Ok(Some(
                    (word_index * CELLS_PER_WORD + mask.trailing_zeros() as usize) as u64,
                ));
            }
            word_index += 1;
            bit = 0;
        }
        Ok(None)
    }

    fn find_previous(
        &self,
        column: usize,
        start: u64,
        occupied: bool,
        cancel: &AtomicBool,
    ) -> Result<Option<u64>, DataError> {
        let words = &self.columns[column];
        let mut word_index = start as usize / CELLS_PER_WORD;
        let mut bit = start as usize % CELLS_PER_WORD;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            let mut mask = occupancy_mask(words[word_index]);
            if !occupied {
                mask = !mask;
            }
            mask &= valid_rows_mask(self.rows, word_index);
            mask &= if bit == 31 {
                u32::MAX
            } else {
                (1_u32 << (bit + 1)) - 1
            };
            if mask != 0 {
                let lane = 31 - mask.leading_zeros() as usize;
                return Ok(Some((word_index * CELLS_PER_WORD + lane) as u64));
            }
            if word_index == 0 {
                return Ok(None);
            }
            word_index -= 1;
            bit = 31;
        }
    }
}

fn occupancy_mask(word: u64) -> u32 {
    let mut packed = (!(word ^ (word >> 1))) & EVEN_BITS;
    packed = (packed | (packed >> 1)) & 0x3333_3333_3333_3333;
    packed = (packed | (packed >> 2)) & 0x0f0f_0f0f_0f0f_0f0f;
    packed = (packed | (packed >> 4)) & 0x00ff_00ff_00ff_00ff;
    packed = (packed | (packed >> 8)) & 0x0000_ffff_0000_ffff;
    packed = (packed | (packed >> 16)) & 0x0000_0000_ffff_ffff;
    packed as u32
}

fn valid_rows_mask(rows: u64, word_index: usize) -> u32 {
    let first = word_index as u64 * CELLS_PER_WORD as u64;
    let remaining = rows.saturating_sub(first).min(CELLS_PER_WORD as u64) as u32;
    if remaining == 32 {
        u32::MAX
    } else if remaining == 0 {
        0
    } else {
        (1_u32 << remaining) - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(row: u64, direction: DataBoundaryDirection) -> BoundarySearchRequest {
        BoundarySearchRequest {
            row,
            column_id: String::from("a"),
            visible_column_ids: vec![String::from("a")],
            direction,
            mode: DataBoundaryMode::DataBoundary,
        }
    }

    #[test]
    fn state_encoding_is_column_major_and_exact_for_partial_words() {
        let states = [
            DataValueState::Valid,
            DataValueState::Null,
            DataValueState::Empty,
            DataValueState::Invalid,
        ];
        for rows in 0..=65 {
            for columns in 1..=17 {
                let mut bitmap = CellStateBitmap::new(columns);
                for row in 0..rows {
                    let values = (0..columns)
                        .map(|column| states[(row + column) % states.len()])
                        .collect::<Vec<_>>();
                    bitmap.push_row(&values).unwrap();
                }
                assert_eq!(bitmap.rows(), rows as u64);
                assert_eq!(bitmap.column_count(), columns);
                assert_eq!(
                    bitmap.payload_bytes(),
                    columns * rows.div_ceil(CELLS_PER_WORD) * 8
                );
                for row in 0..rows {
                    for column in 0..columns {
                        let expected = CellState::from(states[(row + column) % states.len()]);
                        assert_eq!(bitmap.state(row as u64, column).unwrap(), expected);
                        assert_eq!(
                            bitmap.occupancy(row as u64, column).unwrap(),
                            expected.occupied()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn word_scanner_matches_linear_oracle_across_every_boundary_lane() {
        for rows in [1_usize, 31, 32, 33, 63, 64, 65, 127] {
            for transition in 0..rows {
                let mut bitmap = CellStateBitmap::new(1);
                for row in 0..rows {
                    let state = if row < transition {
                        DataValueState::Valid
                    } else {
                        DataValueState::Empty
                    };
                    bitmap.push_row(&[state]).unwrap();
                }
                for start in 0..rows {
                    for wanted in [false, true] {
                        let next = (start..rows)
                            .find(|row| bitmap.occupancy(*row as u64, 0).unwrap() == wanted);
                        let previous = (0..=start)
                            .rev()
                            .find(|row| bitmap.occupancy(*row as u64, 0).unwrap() == wanted);
                        assert_eq!(
                            bitmap
                                .find_next(0, start as u64, wanted, &AtomicBool::new(false))
                                .unwrap(),
                            next.map(|row| row as u64)
                        );
                        assert_eq!(
                            bitmap
                                .find_previous(0, start as u64, wanted, &AtomicBool::new(false))
                                .unwrap(),
                            previous.map(|row| row as u64)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn vertical_boundary_matches_excel_region_rules() {
        let mut bitmap = CellStateBitmap::new(1);
        for state in [
            DataValueState::Valid,
            DataValueState::Invalid,
            DataValueState::Null,
            DataValueState::Empty,
            DataValueState::Valid,
            DataValueState::Valid,
        ] {
            bitmap.push_row(&[state]).unwrap();
        }
        let names = vec![String::from("a")];
        let find = |row, direction| {
            bitmap
                .find_boundary(&names, &request(row, direction), &AtomicBool::new(false))
                .unwrap()
                .target_row
        };
        assert_eq!(find(0, DataBoundaryDirection::Down), 1);
        assert_eq!(find(1, DataBoundaryDirection::Down), 4);
        assert_eq!(find(2, DataBoundaryDirection::Down), 4);
        assert_eq!(find(5, DataBoundaryDirection::Up), 4);
        assert_eq!(find(4, DataBoundaryDirection::Up), 1);
    }

    #[test]
    fn horizontal_boundary_uses_visible_order_and_all_four_states() {
        let mut bitmap = CellStateBitmap::new(5);
        bitmap
            .push_row(&[
                DataValueState::Valid,
                DataValueState::Invalid,
                DataValueState::Null,
                DataValueState::Empty,
                DataValueState::Valid,
            ])
            .unwrap();
        let names = ["a", "b", "c", "d", "e"].map(String::from).to_vec();
        let request = BoundarySearchRequest {
            row: 0,
            column_id: String::from("a"),
            visible_column_ids: ["a", "c", "d", "e"].map(String::from).to_vec(),
            direction: DataBoundaryDirection::Right,
            mode: DataBoundaryMode::DataBoundary,
        };
        assert_eq!(
            bitmap
                .find_boundary(&names, &request, &AtomicBool::new(false))
                .unwrap()
                .target_column_id,
            "e"
        );
    }

    #[test]
    fn cancellation_and_out_of_range_are_typed_errors() {
        let mut bitmap = CellStateBitmap::new(1);
        bitmap.push_row(&[DataValueState::Valid]).unwrap();
        let names = vec![String::from("a")];
        let cancelled = bitmap
            .find_boundary(
                &names,
                &request(0, DataBoundaryDirection::Down),
                &AtomicBool::new(true),
            )
            .unwrap_err();
        assert_eq!(cancelled.code, crate::domain::DataErrorCode::TaskCancelled);
        assert!(bitmap.state(1, 0).is_err());
        assert!(bitmap.state(0, 1).is_err());
    }
}
