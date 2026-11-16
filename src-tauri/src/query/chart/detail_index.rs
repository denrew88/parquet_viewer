//! Bounded private chart projection partitions. No data or labels are used as paths.

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    fs::{File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use crate::{
    domain::{DataError, DataErrorCode},
    storage::QueryTempLease,
};

use super::{ChartPointDetails, Job};

pub(super) const MAX_INDEX_BYTES: u64 = 256 * 1024 * 1024;
const WRITE_BUFFER: usize = 16 * 1024;
const READ_BUFFER: usize = 32 * 1024;
const MAX_TEXT_BYTES: usize = 128;
const RECORD_BYTES: usize = 32;
const ALLOCATION_UNIT: u64 = 64 * 1024;
const CHECK_ROWS: usize = 4096;

pub(super) struct Record {
    pub xy: [f64; 2],
    pub row: u64,
    pub count: u64,
    pub details: Option<ChartPointDetails>,
}

pub(super) struct IndexWriter {
    lease: QueryTempLease,
    partitions: Vec<Partition>,
    charged: u64,
    scatter: bool,
}

#[derive(Default)]
struct Partition {
    buffered: Vec<u8>,
    len: u64,
}

pub(super) struct DiskIndex {
    lease: QueryTempLease,
    sizes: Vec<u64>,
    scatter: bool,
    #[cfg(test)]
    audit: IndexAudit,
}

#[cfg(test)]
#[derive(Default)]
struct IndexAudit {
    tiles: AtomicU64,
    bytes: AtomicU64,
    rows: AtomicU64,
}

impl IndexWriter {
    pub(super) fn new(lease: QueryTempLease, partitions: usize, scatter: bool) -> Self {
        Self {
            lease,
            partitions: (0..partitions).map(|_| Partition::default()).collect(),
            charged: 0,
            scatter,
        }
    }

    pub(super) fn add(&mut self, tile: usize, record: Record) -> Result<(), DataError> {
        let bytes = record.details.as_ref().map_or(RECORD_BYTES, |details| {
            RECORD_BYTES
                + 3
                + details.x.len()
                + details.y.len()
                + details.label.as_ref().map_or(0, String::len)
        });
        if self.partitions[tile].buffered.len() + bytes > WRITE_BUFFER {
            self.flush(tile)?;
        }
        let buffer = &mut self.partitions[tile].buffered;
        if buffer.capacity() == 0 {
            *buffer = Vec::with_capacity(WRITE_BUFFER);
        }
        for coordinate in record.xy {
            buffer.extend(coordinate.to_bits().to_le_bytes());
        }
        buffer.extend(record.row.to_le_bytes());
        buffer.extend(record.count.to_le_bytes());
        if let Some(details) = record.details {
            write_text(buffer, &details.x)?;
            write_text(buffer, &details.y)?;
            if let Some(label) = details.label {
                write_text(buffer, &label)?;
            } else {
                buffer.push(u8::MAX);
            }
        }
        Ok(())
    }

    fn flush(&mut self, tile: usize) -> Result<(), DataError> {
        let partition = &mut self.partitions[tile];
        if partition.buffered.is_empty() {
            return Ok(());
        }
        let len = partition
            .len
            .saturating_add(partition.buffered.len() as u64);
        let charge = |bytes: u64| bytes.div_ceil(ALLOCATION_UNIT) * ALLOCATION_UNIT;
        let charged = self
            .charged
            .saturating_sub(charge(partition.len))
            .saturating_add(charge(len));
        if charged > self.lease.allowance_bytes().min(MAX_INDEX_BYTES) {
            return Err(DataError::query_temp_limit(
                "Chart detail exceeds the temporary storage allowance. Filter the source or reduce the selected data.",
            ));
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(tile_path(self.lease.path(), tile))
            .map_err(index_io)?;
        file.write_all(&partition.buffered).map_err(index_io)?;
        partition.len = len;
        partition.buffered.clear();
        self.charged = charged;
        Ok(())
    }

    pub(super) fn finish(mut self, job: &Job<'_>) -> Result<DiskIndex, DataError> {
        for tile in 0..self.partitions.len() {
            job.check()?;
            self.flush(tile)?;
        }
        self.lease.commit_usage();
        Ok(DiskIndex {
            lease: self.lease,
            sizes: self.partitions.into_iter().map(|part| part.len).collect(),
            scatter: self.scatter,
            #[cfg(test)]
            audit: IndexAudit::default(),
        })
    }
}

impl DiskIndex {
    pub(super) fn visit(
        &self,
        tiles: impl IntoIterator<Item = usize>,
        job: &Job<'_>,
        visit: impl FnMut(Record) -> Result<(), DataError>,
    ) -> Result<(), DataError> {
        self.visit_matching(tiles, job, |_| true, visit)
    }

    pub(super) fn visit_matching(
        &self,
        tiles: impl IntoIterator<Item = usize>,
        job: &Job<'_>,
        matches: impl Fn([f64; 2]) -> bool,
        mut visit: impl FnMut(Record) -> Result<(), DataError>,
    ) -> Result<(), DataError> {
        for tile in tiles {
            job.check()?;
            let len = self.sizes[tile];
            if len == 0 {
                continue;
            }
            let file = File::open(tile_path(self.lease.path(), tile)).map_err(index_io)?;
            if file.metadata().map_err(index_io)?.len() != len {
                return Err(corrupt());
            }
            #[cfg(test)]
            {
                self.audit.tiles.fetch_add(1, Ordering::Relaxed);
                self.audit.bytes.fetch_add(len, Ordering::Relaxed);
            }
            let mut reader = BufReader::with_capacity(READ_BUFFER, file);
            let mut remaining = len;
            let mut rows = 0;
            while remaining != 0 {
                if rows % CHECK_ROWS == 0 {
                    job.check()?;
                }
                let mut header = [0; RECORD_BYTES];
                read_exact(&mut reader, &mut remaining, &mut header)?;
                let read_u64 = |i: usize| {
                    let mut bytes = [0; 8];
                    bytes.copy_from_slice(&header[i..i + 8]);
                    u64::from_le_bytes(bytes)
                };
                let [x, y, row, count] = [read_u64(0), read_u64(8), read_u64(16), read_u64(24)];
                let xy = [f64::from_bits(x), f64::from_bits(y)];
                if !xy.iter().all(|value| value.is_finite()) || count == 0 {
                    return Err(corrupt());
                }
                rows += 1;
                if !matches(xy) {
                    if self.scatter {
                        skip_text(&mut reader, &mut remaining)?;
                        skip_text(&mut reader, &mut remaining)?;
                        skip_text(&mut reader, &mut remaining)?;
                    }
                    continue;
                }
                let details = if self.scatter {
                    let x = read_text(&mut reader, &mut remaining)?.ok_or_else(corrupt)?;
                    let y = read_text(&mut reader, &mut remaining)?.ok_or_else(corrupt)?;
                    let label = read_text(&mut reader, &mut remaining)?;
                    Some(ChartPointDetails { row, x, y, label })
                } else {
                    None
                };
                visit(Record {
                    xy,
                    row,
                    count,
                    details,
                })?;
            }
            #[cfg(test)]
            self.audit.rows.fetch_add(rows as u64, Ordering::Relaxed);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn audit(&self) -> (u64, u64, u64) {
        (
            self.audit.tiles.load(Ordering::Relaxed),
            self.audit.bytes.load(Ordering::Relaxed),
            self.audit.rows.load(Ordering::Relaxed),
        )
    }
}

fn tile_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("tile-{index}.bin"))
}

fn write_text(buffer: &mut Vec<u8>, text: &str) -> Result<(), DataError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(corrupt());
    }
    buffer.push(text.len() as u8);
    buffer.extend(text.as_bytes());
    Ok(())
}

fn read_text(reader: &mut impl Read, remaining: &mut u64) -> Result<Option<String>, DataError> {
    let mut len = [0];
    read_exact(reader, remaining, &mut len)?;
    if len[0] == u8::MAX {
        return Ok(None);
    }
    let len = usize::from(len[0]);
    if len > MAX_TEXT_BYTES {
        return Err(corrupt());
    }
    let mut text = vec![0; len];
    read_exact(reader, remaining, &mut text)?;
    String::from_utf8(text).map(Some).map_err(|_| corrupt())
}

fn skip_text(reader: &mut impl Read, remaining: &mut u64) -> Result<(), DataError> {
    let mut len = [0];
    read_exact(reader, remaining, &mut len)?;
    if len[0] == u8::MAX {
        return Ok(());
    }
    let len = usize::from(len[0]);
    if len > MAX_TEXT_BYTES {
        return Err(corrupt());
    }
    read_exact(reader, remaining, &mut [0; MAX_TEXT_BYTES][..len])
}

fn read_exact(
    reader: &mut impl Read,
    remaining: &mut u64,
    buffer: &mut [u8],
) -> Result<(), DataError> {
    *remaining = remaining
        .checked_sub(buffer.len() as u64)
        .ok_or_else(corrupt)?;
    reader.read_exact(buffer).map_err(index_io)
}

fn index_io(_: io::Error) -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: "Could not read or write chart detail temporary data.".to_owned(),
    }
}

fn corrupt() -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: "Chart detail temporary data is inconsistent. Reopen the chart to retry."
            .to_owned(),
    }
}
