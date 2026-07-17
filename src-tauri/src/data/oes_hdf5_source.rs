use std::{
    collections::{HashMap, HashSet},
    fs::{self, File as StdFile},
    io::Read,
    mem,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use hdf5::{
    filters::{Blosc, Filter},
    types::{FloatSize, IntSize, TypeDescriptor, VarLenUnicode},
    Dataset, File, LinkType,
};
use ndarray::s;

use crate::domain::{
    ColumnSchema, DataError, DataFormat, DataPage, DataValue, FileSummary, FormatDescriptor,
    FormatDetailsContent, FormatDetailsSection, MetadataEntry, RowCountState, RowCountStatus,
    SourceCapability, ValueKind,
};

use super::{FormatHandler, TabularSource};

const HDF5_SIGNATURE: &[u8; 8] = b"\x89HDF\r\n\x1a\n";
const MAX_PAGE_SIZE: usize = 200;
const MAX_PROJECTION_COLUMNS: usize = 64;
const MAX_WAVELENGTHS: usize = 4_096;
const MAX_AXIS_BYTES_PER_FILE: usize = 128 * 1024 * 1024;
const MAX_AXIS_BYTES_PER_PROCESS: usize = 256 * 1024 * 1024;
const MAX_AXIS_ELEMENT_BYTES: usize = 1024 * 1024;
const MAX_DECODED_CHUNK_BYTES: usize = 64 * 1024 * 1024;
const MAX_WAVELENGTH_METADATA_ROWS: usize = 100;

static AXIS_BYTES_IN_USE: AtomicUsize = AtomicUsize::new(0);
static VLEN_AXIS_READ_LOCK: Mutex<()> = Mutex::new(());

pub const OES_HDF5_FORMAT_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    id: DataFormat::OesHdf5,
    display_name: "OES HDF5",
    extensions: &["h5", "hdf5"],
    mime_types: &["application/x-hdf5"],
    capabilities: &[
        SourceCapability::TypedSchema,
        SourceCapability::ColumnProjection,
    ],
};

#[derive(Debug)]
pub(crate) struct OesHdf5FormatHandler;

pub(crate) static OES_HDF5_FORMAT_HANDLER: OesHdf5FormatHandler = OesHdf5FormatHandler;

impl FormatHandler for OesHdf5FormatHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &OES_HDF5_FORMAT_DESCRIPTOR
    }

    fn open(&self, path: &Path) -> Result<Box<dyn TabularSource>, DataError> {
        OesHdf5Source::open(path).map(|source| Box::new(source) as Box<dyn TabularSource>)
    }
}

#[derive(Debug)]
pub struct OesHdf5Source {
    path: PathBuf,
    summary: FileSummary,
    _file: File,
    intensity: Dataset,
    time: AxisValues,
    datetime_time: bool,
    time_timezone: Option<String>,
    _wavelength: AxisValues,
    bindings: Vec<OesColumnBinding>,
    _axis_lease: AxisBudgetLease,
    #[cfg(test)]
    intensity_reads: AtomicUsize,
}

impl OesHdf5Source {
    pub(crate) fn open(path: impl AsRef<Path>) -> Result<Self, DataError> {
        let path = path.as_ref();
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
        if !has_oes_hdf5_extension(path) {
            return Err(DataError::unsupported_format(path));
        }
        validate_signature(path, metadata.len())?;
        crate::platform::initialize_hdf5_runtime()?;

        let file = File::open(path)
            .map_err(|_| DataError::invalid_oes_hdf5(path, "could not open the HDF5 container"))?;
        validate_axis_locations(path, &file)?;
        validate_intensity_link(path, &file)?;
        let intensity = file.dataset("intensity").map_err(|_| {
            DataError::invalid_oes_hdf5(path, "missing required /intensity dataset")
        })?;
        let intensity_layout = validate_intensity(path, &intensity)?;

        let time_attr = file.attr("time").map_err(|_| {
            DataError::invalid_oes_hdf5(path, "missing required root time attribute")
        })?;
        let wavelength_attr = file.attr("wavelength").map_err(|_| {
            DataError::invalid_oes_hdf5(path, "missing required root wavelength attribute")
        })?;
        validate_axis_shape(path, "time", &time_attr, intensity_layout.rows)?;
        validate_axis_shape(
            path,
            "wavelength",
            &wavelength_attr,
            intensity_layout.columns,
        )?;
        if intensity_layout.columns == 0 {
            return Err(DataError::invalid_oes_hdf5(
                path,
                "wavelength axis must contain at least one value",
            ));
        }
        if intensity_layout.columns > MAX_WAVELENGTHS {
            return Err(DataError::oes_hdf5_limit(
                path,
                format!(
                    "wavelength count {} exceeds the {MAX_WAVELENGTHS} column limit",
                    intensity_layout.columns
                ),
            ));
        }

        let time_descriptor = attribute_descriptor(path, "time", &time_attr)?;
        let wavelength_descriptor = attribute_descriptor(path, "wavelength", &wavelength_attr)?;
        let preflight = axis_preflight(
            path,
            [
                (&time_descriptor, intensity_layout.rows),
                (&wavelength_descriptor, intensity_layout.columns),
            ],
        )?;
        let vlen_read_guard = preflight
            .has_vlen
            .then(|| {
                VLEN_AXIS_READ_LOCK.lock().map_err(|_| {
                    DataError::oes_hdf5_runtime("the variable-length axis read lock is unavailable")
                })
            })
            .transpose()?;
        let mut axis_lease = AxisBudgetLease::acquire(path, preflight.reservation_bytes)?;

        let time = read_axis(path, "time", &time_attr, &time_descriptor)?;
        let wavelength = read_axis(path, "wavelength", &wavelength_attr, &wavelength_descriptor)?;
        validate_wavelength_values(path, &wavelength)?;
        let bindings = build_column_bindings(path, &wavelength)?;
        let decoded_axis_bytes = decoded_axis_bytes(path, &time, &wavelength, &bindings)?;
        if decoded_axis_bytes > MAX_AXIS_BYTES_PER_FILE {
            return Err(DataError::oes_hdf5_limit(
                path,
                format!(
                    "decoded time and wavelength data require {decoded_axis_bytes} bytes; the per-file limit is {MAX_AXIS_BYTES_PER_FILE}"
                ),
            ));
        }
        axis_lease.grow_to(path, decoded_axis_bytes)?;
        axis_lease.shrink_to(decoded_axis_bytes);
        drop(vlen_read_guard);

        let time_kind = optional_string_attr(&file, "time_kind", metadata.len());
        let time_timezone =
            optional_string_attr(&file, "time_timezone", metadata.len()).unwrap_or_default();
        let datetime_time =
            time_kind.as_deref() == Some("datetime64ns") && matches!(time, AxisValues::I64(_));
        let columns = build_schema(&time, datetime_time, &time_timezone, &bindings);
        let row_count = u64::try_from(intensity_layout.rows).map_err(|_| {
            DataError::oes_hdf5_limit(path, "intensity row count does not fit the viewer model")
        })?;
        let summary = FileSummary {
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            format: DataFormat::OesHdf5,
            format_descriptor: OES_HDF5_FORMAT_DESCRIPTOR,
            file_size: metadata.len(),
            row_count: Some(row_count),
            row_count_status: RowCountStatus {
                state: RowCountState::Complete,
                rows_scanned: row_count,
                bytes_scanned: metadata.len(),
                total_bytes: metadata.len(),
                generation: 1,
                message: None,
            },
            column_count: columns.len(),
            row_group_count: 0,
            columns,
            row_groups: Vec::new(),
            csv_metadata: None,
            format_details: oes_format_details(
                &intensity_layout,
                &time,
                &wavelength,
                &bindings,
                decoded_axis_bytes,
            ),
        };

        Ok(Self {
            path: path.to_path_buf(),
            summary,
            _file: file,
            intensity,
            time,
            datetime_time,
            time_timezone: (!time_timezone.is_empty()).then_some(time_timezone),
            _wavelength: wavelength,
            bindings,
            _axis_lease: axis_lease,
            #[cfg(test)]
            intensity_reads: AtomicUsize::new(0),
        })
    }

    pub(crate) fn summary(&self) -> &FileSummary {
        &self.summary
    }

    pub(crate) fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        requested: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        if !(1..=MAX_PAGE_SIZE).contains(&limit) {
            return Err(DataError::invalid_request(format!(
                "Page limit must be between 1 and {MAX_PAGE_SIZE} rows."
            )));
        }
        let requested_end = offset
            .checked_add(limit as u64)
            .ok_or_else(|| DataError::invalid_request("Page offset and limit overflow."))?;
        let projection = self.validate_projection(requested)?;
        let total_rows = self.summary.row_count.unwrap_or_default();
        if offset >= total_rows {
            return Ok(DataPage {
                offset,
                limit,
                total_rows: Some(total_rows),
                has_more: false,
                columns: projection.names,
                rows: Vec::new(),
            });
        }

        let end = requested_end.min(total_rows);
        let row_start = usize::try_from(offset).map_err(|_| {
            DataError::invalid_request("Page offset does not fit the platform address space.")
        })?;
        let row_end = usize::try_from(end).map_err(|_| {
            DataError::invalid_request("Page end does not fit the platform address space.")
        })?;
        let plans = plan_hyperslabs(&projection.intensity_columns)?;
        let mut decoded: Vec<Option<Vec<i32>>> = std::iter::repeat_with(|| None)
            .take(projection.names.len())
            .collect();
        for plan in plans {
            #[cfg(test)]
            self.intensity_reads.fetch_add(1, Ordering::Relaxed);
            let values = self
                .intensity
                .read_slice_2d::<i32, _>(s![
                    row_start..row_end,
                    plan.start_column..plan.start_column + plan.column_count
                ])
                .map_err(|_| {
                    DataError::invalid_oes_hdf5(
                        &self.path,
                        "could not decode a bounded intensity hyperslab",
                    )
                })?;
            for output in plan.outputs {
                decoded[output.projection_position] =
                    Some(values.column(output.slice_column).iter().copied().collect());
            }
        }

        let mut rows = Vec::with_capacity(row_end - row_start);
        for local_row in 0..(row_end - row_start) {
            let mut row = Vec::with_capacity(projection.columns.len());
            for column in &projection.columns {
                match column {
                    ProjectedColumn::Time => row.push(self.time.data_value(
                        row_start + local_row,
                        self.datetime_time,
                        self.time_timezone.as_deref(),
                    )),
                    ProjectedColumn::Intensity {
                        projection_position,
                    } => {
                        let value = decoded[*projection_position]
                            .as_ref()
                            .and_then(|column| column.get(local_row))
                            .copied()
                            .ok_or_else(|| {
                                DataError::invalid_oes_hdf5(
                                    &self.path,
                                    "intensity hyperslab result did not match its projection",
                                )
                            })?;
                        row.push(DataValue::displayed(ValueKind::Int, value.to_string()));
                    }
                }
            }
            rows.push(row);
        }

        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(total_rows),
            has_more: end < total_rows,
            columns: projection.names,
            rows,
        })
    }

    fn validate_projection(
        &self,
        requested: Option<&[String]>,
    ) -> Result<ProjectionPlan, DataError> {
        let names = match requested {
            None => self
                .summary
                .columns
                .iter()
                .take(MAX_PROJECTION_COLUMNS)
                .map(|column| column.name.clone())
                .collect::<Vec<_>>(),
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
                columns.to_vec()
            }
        };
        let mut seen = HashSet::with_capacity(names.len());
        let mut columns = Vec::with_capacity(names.len());
        let mut intensity_columns = Vec::new();
        for (projection_position, name) in names.iter().enumerate() {
            if !seen.insert(name.as_str()) {
                return Err(DataError::invalid_request(format!(
                    "Column projection contains duplicate column: {name}"
                )));
            }
            if name == "time" {
                columns.push(ProjectedColumn::Time);
                continue;
            }
            let binding = self
                .bindings
                .iter()
                .find(|binding| binding.public_name == *name)
                .ok_or_else(|| {
                    DataError::invalid_request(format!("Unknown projected column: {name}"))
                })?;
            columns.push(ProjectedColumn::Intensity {
                projection_position,
            });
            intensity_columns.push((projection_position, binding.wavelength_index));
        }
        Ok(ProjectionPlan {
            names,
            columns,
            intensity_columns,
        })
    }

    #[cfg(test)]
    fn take_intensity_read_count(&self) -> usize {
        self.intensity_reads.swap(0, Ordering::Relaxed)
    }
}

impl TabularSource for OesHdf5Source {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &OES_HDF5_FORMAT_DESCRIPTOR
    }

    fn summary(&self) -> FileSummary {
        OesHdf5Source::summary(self).clone()
    }

    fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        OesHdf5Source::read_page_projected(self, offset, limit, columns)
    }
}

#[derive(Debug)]
struct IntensityLayout {
    rows: usize,
    columns: usize,
    chunk_rows: usize,
    chunk_columns: usize,
    compression_level: u8,
    shuffle: String,
}

#[derive(Debug)]
enum AxisValues {
    I8(Vec<i8>),
    I16(Vec<i16>),
    I32(Vec<i32>),
    I64(Vec<i64>),
    U8(Vec<u8>),
    U16(Vec<u16>),
    U32(Vec<u32>),
    U64(Vec<u64>),
    F32(Vec<f32>),
    F64(Vec<f64>),
    Utf8(Vec<String>),
}

impl AxisValues {
    fn len(&self) -> usize {
        match self {
            Self::I8(values) => values.len(),
            Self::I16(values) => values.len(),
            Self::I32(values) => values.len(),
            Self::I64(values) => values.len(),
            Self::U8(values) => values.len(),
            Self::U16(values) => values.len(),
            Self::U32(values) => values.len(),
            Self::U64(values) => values.len(),
            Self::F32(values) => values.len(),
            Self::F64(values) => values.len(),
            Self::Utf8(values) => values.len(),
        }
    }

    fn logical_type(&self) -> &'static str {
        match self {
            Self::I8(_) => "Int8",
            Self::I16(_) => "Int16",
            Self::I32(_) => "Int32",
            Self::I64(_) => "Int64",
            Self::U8(_) => "UInt8",
            Self::U16(_) => "UInt16",
            Self::U32(_) => "UInt32",
            Self::U64(_) => "UInt64",
            Self::F32(_) => "Float32",
            Self::F64(_) => "Float64",
            Self::Utf8(_) => "Utf8",
        }
    }

    fn physical_type(&self) -> &'static str {
        match self {
            Self::I8(_) => "HDF5 signed 8-bit integer",
            Self::I16(_) => "HDF5 signed 16-bit integer",
            Self::I32(_) => "HDF5 signed 32-bit integer",
            Self::I64(_) => "HDF5 signed 64-bit integer",
            Self::U8(_) => "HDF5 unsigned 8-bit integer",
            Self::U16(_) => "HDF5 unsigned 16-bit integer",
            Self::U32(_) => "HDF5 unsigned 32-bit integer",
            Self::U64(_) => "HDF5 unsigned 64-bit integer",
            Self::F32(_) => "HDF5 32-bit float",
            Self::F64(_) => "HDF5 64-bit float",
            Self::Utf8(_) => "HDF5 UTF-8 string",
        }
    }

    fn value_kind(&self) -> ValueKind {
        match self {
            Self::I8(_) | Self::I16(_) | Self::I32(_) | Self::I64(_) => ValueKind::Int,
            Self::U8(_) | Self::U16(_) | Self::U32(_) | Self::U64(_) => ValueKind::Int,
            Self::F32(_) | Self::F64(_) => ValueKind::Float,
            Self::Utf8(_) => ValueKind::String,
        }
    }

    fn canonical_label(&self, index: usize) -> String {
        match self {
            Self::I8(values) => values[index].to_string(),
            Self::I16(values) => values[index].to_string(),
            Self::I32(values) => values[index].to_string(),
            Self::I64(values) => values[index].to_string(),
            Self::U8(values) => values[index].to_string(),
            Self::U16(values) => values[index].to_string(),
            Self::U32(values) => values[index].to_string(),
            Self::U64(values) => values[index].to_string(),
            Self::F32(values) => values[index].to_string(),
            Self::F64(values) => values[index].to_string(),
            Self::Utf8(values) => values[index].clone(),
        }
    }

    fn data_value(&self, index: usize, datetime_time: bool, timezone: Option<&str>) -> DataValue {
        if datetime_time {
            if let Self::I64(values) = self {
                return DataValue::displayed(
                    ValueKind::Timestamp,
                    format_timestamp_ns(values[index], timezone),
                );
            }
        }
        DataValue::displayed(self.value_kind(), self.canonical_label(index))
    }

    fn retained_bytes(&self) -> Option<usize> {
        match self {
            Self::I8(values) => values.len().checked_mul(mem::size_of::<i8>()),
            Self::I16(values) => values.len().checked_mul(mem::size_of::<i16>()),
            Self::I32(values) => values.len().checked_mul(mem::size_of::<i32>()),
            Self::I64(values) => values.len().checked_mul(mem::size_of::<i64>()),
            Self::U8(values) => values.len().checked_mul(mem::size_of::<u8>()),
            Self::U16(values) => values.len().checked_mul(mem::size_of::<u16>()),
            Self::U32(values) => values.len().checked_mul(mem::size_of::<u32>()),
            Self::U64(values) => values.len().checked_mul(mem::size_of::<u64>()),
            Self::F32(values) => values.len().checked_mul(mem::size_of::<f32>()),
            Self::F64(values) => values.len().checked_mul(mem::size_of::<f64>()),
            Self::Utf8(values) => values.iter().try_fold(
                values.len().checked_mul(mem::size_of::<String>())?,
                |total, value| total.checked_add(value.len()),
            ),
        }
    }
}

#[derive(Debug)]
struct OesColumnBinding {
    public_name: String,
    original_label: String,
    wavelength_index: usize,
}

#[derive(Debug)]
struct ProjectionPlan {
    names: Vec<String>,
    columns: Vec<ProjectedColumn>,
    intensity_columns: Vec<(usize, usize)>,
}

#[derive(Debug)]
enum ProjectedColumn {
    Time,
    Intensity { projection_position: usize },
}

#[derive(Debug, PartialEq, Eq)]
struct HyperslabPlan {
    start_column: usize,
    column_count: usize,
    outputs: Vec<HyperslabOutput>,
}

#[derive(Debug, PartialEq, Eq)]
struct HyperslabOutput {
    projection_position: usize,
    slice_column: usize,
}

#[derive(Debug)]
struct AxisPreflight {
    reservation_bytes: usize,
    has_vlen: bool,
}

#[derive(Debug)]
struct AxisBudgetLease {
    bytes: usize,
}

impl AxisBudgetLease {
    fn acquire(path: &Path, bytes: usize) -> Result<Self, DataError> {
        let mut current = AXIS_BYTES_IN_USE.load(Ordering::Acquire);
        loop {
            let next = current.checked_add(bytes).ok_or_else(|| {
                DataError::oes_hdf5_limit(path, "process axis memory accounting overflow")
            })?;
            if next > MAX_AXIS_BYTES_PER_PROCESS {
                return Err(DataError::oes_hdf5_limit(
                    path,
                    format!(
                        "axis data would require {next} process bytes; the limit is {MAX_AXIS_BYTES_PER_PROCESS}"
                    ),
                ));
            }
            match AXIS_BYTES_IN_USE.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Self { bytes }),
                Err(observed) => current = observed,
            }
        }
    }

    fn shrink_to(&mut self, bytes: usize) {
        if bytes < self.bytes {
            AXIS_BYTES_IN_USE.fetch_sub(self.bytes - bytes, Ordering::AcqRel);
            self.bytes = bytes;
        }
    }

    fn grow_to(&mut self, path: &Path, bytes: usize) -> Result<(), DataError> {
        if bytes <= self.bytes {
            return Ok(());
        }
        let additional = bytes - self.bytes;
        let mut current = AXIS_BYTES_IN_USE.load(Ordering::Acquire);
        loop {
            let next = current.checked_add(additional).ok_or_else(|| {
                DataError::oes_hdf5_limit(path, "process axis memory accounting overflow")
            })?;
            if next > MAX_AXIS_BYTES_PER_PROCESS {
                return Err(DataError::oes_hdf5_limit(
                    path,
                    format!(
                        "axis data would require {next} process bytes; the limit is {MAX_AXIS_BYTES_PER_PROCESS}"
                    ),
                ));
            }
            match AXIS_BYTES_IN_USE.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.bytes = bytes;
                    return Ok(());
                }
                Err(observed) => current = observed,
            }
        }
    }
}

impl Drop for AxisBudgetLease {
    fn drop(&mut self) {
        AXIS_BYTES_IN_USE.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

fn has_oes_hdf5_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("h5") || extension.eq_ignore_ascii_case("hdf5")
        })
}

fn validate_signature(path: &Path, file_size: u64) -> Result<(), DataError> {
    if file_size < HDF5_SIGNATURE.len() as u64 {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "file is too short to contain an HDF5 signature",
        ));
    }
    let mut file = StdFile::open(path).map_err(|error| DataError::io(path, error))?;
    let mut signature = [0_u8; HDF5_SIGNATURE.len()];
    file.read_exact(&mut signature)
        .map_err(|error| DataError::invalid_oes_hdf5(path, error))?;
    if &signature != HDF5_SIGNATURE {
        return Err(DataError::invalid_oes_hdf5(path, "missing HDF5 signature"));
    }
    Ok(())
}

fn validate_axis_locations(path: &Path, file: &File) -> Result<(), DataError> {
    for name in ["time", "wavelength"] {
        if file.link_exists(name) {
            return Err(DataError::invalid_oes_hdf5(
                path,
                format!("{name} must be a root attribute, not an HDF5 object"),
            ));
        }
    }
    Ok(())
}

fn validate_intensity_link(path: &Path, file: &File) -> Result<(), DataError> {
    let link_type = file
        .iter_visit_default(None, |_, name, info, found| {
            if name == "intensity" {
                *found = Some(info.link_type);
                false
            } else {
                true
            }
        })
        .map_err(|_| DataError::invalid_oes_hdf5(path, "could not inspect root HDF5 links"))?;
    match link_type {
        Some(LinkType::Hard) => Ok(()),
        Some(LinkType::Soft) => Err(DataError::invalid_oes_hdf5(
            path,
            "/intensity must not be a soft link",
        )),
        Some(LinkType::External) => Err(DataError::invalid_oes_hdf5(
            path,
            "/intensity must not be an external link",
        )),
        None => Err(DataError::invalid_oes_hdf5(
            path,
            "missing required /intensity dataset",
        )),
    }
}

fn validate_intensity(path: &Path, dataset: &Dataset) -> Result<IntensityLayout, DataError> {
    if dataset.ndim() != 2 {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "intensity dataset must have rank 2",
        ));
    }
    let descriptor = dataset
        .dtype()
        .and_then(|datatype| datatype.to_descriptor())
        .map_err(|_| DataError::invalid_oes_hdf5(path, "could not inspect intensity datatype"))?;
    if descriptor != TypeDescriptor::Integer(IntSize::U4) {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "intensity datatype must be signed int32",
        ));
    }
    let create_plist = dataset.create_plist().map_err(|_| {
        DataError::invalid_oes_hdf5(path, "could not inspect intensity storage properties")
    })?;
    if !create_plist.external().is_empty() {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "intensity external storage is not supported",
        ));
    }
    if !dataset.is_chunked() {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "intensity must use local chunked storage; contiguous and virtual layouts are unsupported",
        ));
    }
    let filters = dataset.filters();
    let (compression_level, shuffle) = match filters.as_slice() {
        [Filter::Blosc(Blosc::ZStd, level, shuffle)] => (*level, format!("{shuffle:?}")),
        _ => {
            return Err(DataError::invalid_oes_hdf5(
                path,
                "intensity must use only Blosc v1 filter 32001 with Zstd",
            ))
        }
    };
    let shape = dataset.shape();
    let chunk = dataset
        .chunk()
        .ok_or_else(|| DataError::invalid_oes_hdf5(path, "intensity chunk shape is unavailable"))?;
    if shape.len() != 2 || chunk.len() != 2 || chunk.contains(&0) {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "intensity shape and chunk shape must both be two-dimensional",
        ));
    }
    let chunk_elements = chunk[0]
        .checked_mul(chunk[1])
        .ok_or_else(|| DataError::oes_hdf5_limit(path, "decoded chunk element overflow"))?;
    let chunk_bytes = chunk_elements
        .checked_mul(mem::size_of::<i32>())
        .ok_or_else(|| DataError::oes_hdf5_limit(path, "decoded chunk byte overflow"))?;
    if chunk_bytes > MAX_DECODED_CHUNK_BYTES {
        return Err(DataError::oes_hdf5_limit(
            path,
            format!(
                "decoded intensity chunk requires {chunk_bytes} bytes; the limit is {MAX_DECODED_CHUNK_BYTES}"
            ),
        ));
    }
    Ok(IntensityLayout {
        rows: shape[0],
        columns: shape[1],
        chunk_rows: chunk[0],
        chunk_columns: chunk[1],
        compression_level,
        shuffle,
    })
}

fn validate_axis_shape(
    path: &Path,
    name: &str,
    attribute: &hdf5::Attribute,
    expected: usize,
) -> Result<(), DataError> {
    let shape = attribute.shape();
    if shape.as_slice() != [expected] {
        return Err(DataError::invalid_oes_hdf5(
            path,
            format!(
                "{name} attribute shape {shape:?} does not match the expected length {expected}"
            ),
        ));
    }
    Ok(())
}

fn attribute_descriptor(
    path: &Path,
    name: &str,
    attribute: &hdf5::Attribute,
) -> Result<TypeDescriptor, DataError> {
    let descriptor = attribute
        .dtype()
        .and_then(|datatype| datatype.to_descriptor())
        .map_err(|_| {
            DataError::invalid_oes_hdf5(path, format!("could not inspect {name} datatype"))
        })?;
    if matches!(
        descriptor,
        TypeDescriptor::Integer(_)
            | TypeDescriptor::Unsigned(_)
            | TypeDescriptor::Float(_)
            | TypeDescriptor::FixedUnicode(_)
            | TypeDescriptor::VarLenUnicode
    ) {
        Ok(descriptor)
    } else {
        Err(DataError::invalid_oes_hdf5(
            path,
            format!("{name} must use a numeric primitive or UTF-8 string datatype"),
        ))
    }
}

fn axis_preflight(
    path: &Path,
    axes: [(&TypeDescriptor, usize); 2],
) -> Result<AxisPreflight, DataError> {
    let mut bytes = 0_usize;
    let mut has_vlen = false;
    for (descriptor, count) in axes {
        let element_bytes = match descriptor {
            TypeDescriptor::VarLenUnicode => {
                has_vlen = true;
                mem::size_of::<VarLenUnicode>()
                    .checked_add(mem::size_of::<String>())
                    .ok_or_else(|| {
                        DataError::oes_hdf5_limit(path, "axis element preflight overflow")
                    })?
            }
            TypeDescriptor::FixedUnicode(size) => {
                size.checked_add(mem::size_of::<String>()).ok_or_else(|| {
                    DataError::oes_hdf5_limit(path, "axis element preflight overflow")
                })?
            }
            _ => descriptor.size(),
        };
        bytes =
            bytes
                .checked_add(count.checked_mul(element_bytes).ok_or_else(|| {
                    DataError::oes_hdf5_limit(path, "axis byte preflight overflow")
                })?)
                .ok_or_else(|| DataError::oes_hdf5_limit(path, "axis byte preflight overflow"))?;
    }
    let wavelength_count = axes[1].1;
    let binding_overhead = wavelength_count
        .checked_mul(mem::size_of::<OesColumnBinding>() + 128)
        .ok_or_else(|| DataError::oes_hdf5_limit(path, "axis binding preflight overflow"))?;
    bytes = bytes
        .checked_add(binding_overhead)
        .ok_or_else(|| DataError::oes_hdf5_limit(path, "axis binding preflight overflow"))?;
    if bytes > MAX_AXIS_BYTES_PER_FILE {
        return Err(DataError::oes_hdf5_limit(
            path,
            format!(
                "axis preflight requires {bytes} bytes; the per-file limit is {MAX_AXIS_BYTES_PER_FILE}"
            ),
        ));
    }
    Ok(AxisPreflight {
        reservation_bytes: if has_vlen {
            MAX_AXIS_BYTES_PER_FILE
        } else {
            bytes
        },
        has_vlen,
    })
}

fn read_axis(
    path: &Path,
    name: &str,
    attribute: &hdf5::Attribute,
    descriptor: &TypeDescriptor,
) -> Result<AxisValues, DataError> {
    let invalid =
        || DataError::invalid_oes_hdf5(path, format!("could not decode the {name} attribute"));
    let values = match descriptor {
        TypeDescriptor::Integer(IntSize::U1) => {
            AxisValues::I8(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Integer(IntSize::U2) => {
            AxisValues::I16(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Integer(IntSize::U4) => {
            AxisValues::I32(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Integer(IntSize::U8) => {
            AxisValues::I64(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Unsigned(IntSize::U1) => {
            AxisValues::U8(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Unsigned(IntSize::U2) => {
            AxisValues::U16(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Unsigned(IntSize::U4) => {
            AxisValues::U32(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Unsigned(IntSize::U8) => {
            AxisValues::U64(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Float(FloatSize::U4) => {
            AxisValues::F32(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::Float(FloatSize::U8) => {
            AxisValues::F64(attribute.read_raw().map_err(|_| invalid())?)
        }
        TypeDescriptor::FixedUnicode(_) | TypeDescriptor::VarLenUnicode => {
            let raw: Vec<VarLenUnicode> = attribute.read_raw().map_err(|_| invalid())?;
            let mut strings = Vec::with_capacity(raw.len());
            for value in raw {
                if value.len() > MAX_AXIS_ELEMENT_BYTES {
                    return Err(DataError::oes_hdf5_limit(
                        path,
                        format!(
                            "{name} contains a {} byte element; the element limit is {MAX_AXIS_ELEMENT_BYTES}",
                            value.len()
                        ),
                    ));
                }
                strings.push(value.as_str().to_owned());
            }
            AxisValues::Utf8(strings)
        }
        _ => return Err(invalid()),
    };
    if values.len() != attribute.size() {
        return Err(DataError::invalid_oes_hdf5(
            path,
            format!("decoded {name} length does not match its dataspace"),
        ));
    }
    Ok(values)
}

fn validate_wavelength_values(path: &Path, wavelength: &AxisValues) -> Result<(), DataError> {
    let finite = match wavelength {
        AxisValues::F32(values) => values.iter().all(|value| value.is_finite()),
        AxisValues::F64(values) => values.iter().all(|value| value.is_finite()),
        _ => true,
    };
    if !finite {
        return Err(DataError::invalid_oes_hdf5(
            path,
            "wavelength contains NaN or infinite values",
        ));
    }
    Ok(())
}

fn build_column_bindings(
    path: &Path,
    wavelength: &AxisValues,
) -> Result<Vec<OesColumnBinding>, DataError> {
    let mut used = HashSet::from([String::from("time")]);
    let mut next_suffix: HashMap<String, usize> = HashMap::new();
    let mut bindings = Vec::with_capacity(wavelength.len());
    for index in 0..wavelength.len() {
        let original_label = wavelength.canonical_label(index);
        if original_label.len() > MAX_AXIS_ELEMENT_BYTES {
            return Err(DataError::oes_hdf5_limit(
                path,
                format!(
                    "wavelength element {} exceeds the {MAX_AXIS_ELEMENT_BYTES} byte limit",
                    index + 1
                ),
            ));
        }
        let base = if original_label.trim().is_empty() {
            format!("wavelength_{}", index + 1)
        } else {
            original_label.clone()
        };
        let public_name = if used.insert(base.clone()) {
            next_suffix.entry(base.clone()).or_insert(2);
            base
        } else {
            let suffix = next_suffix.entry(base.clone()).or_insert(2);
            loop {
                let candidate = format!("{base} [{}]", *suffix);
                *suffix = suffix.checked_add(1).ok_or_else(|| {
                    DataError::oes_hdf5_limit(path, "wavelength name suffix overflow")
                })?;
                if used.insert(candidate.clone()) {
                    break candidate;
                }
            }
        };
        bindings.push(OesColumnBinding {
            public_name,
            original_label,
            wavelength_index: index,
        });
    }
    Ok(bindings)
}

fn decoded_axis_bytes(
    path: &Path,
    time: &AxisValues,
    wavelength: &AxisValues,
    bindings: &[OesColumnBinding],
) -> Result<usize, DataError> {
    let binding_bytes = bindings.iter().try_fold(
        bindings
            .len()
            .checked_mul(mem::size_of::<OesColumnBinding>())
            .ok_or_else(|| DataError::oes_hdf5_limit(path, "axis binding byte overflow"))?,
        |total, binding| {
            total
                .checked_add(binding.public_name.len())
                .and_then(|value| value.checked_add(binding.original_label.len()))
                .ok_or_else(|| DataError::oes_hdf5_limit(path, "axis binding byte overflow"))
        },
    )?;
    time.retained_bytes()
        .and_then(|bytes| bytes.checked_add(wavelength.retained_bytes()?))
        .and_then(|bytes| bytes.checked_add(binding_bytes))
        .ok_or_else(|| DataError::oes_hdf5_limit(path, "decoded axis byte overflow"))
}

fn build_schema(
    time: &AxisValues,
    datetime_time: bool,
    timezone: &str,
    bindings: &[OesColumnBinding],
) -> Vec<ColumnSchema> {
    let time_logical = if datetime_time {
        if timezone.is_empty() {
            String::from("Timestamp(ns)")
        } else {
            format!("Timestamp(ns, {timezone})")
        }
    } else {
        time.logical_type().to_owned()
    };
    let mut columns = Vec::with_capacity(bindings.len() + 1);
    columns.push(ColumnSchema {
        name: String::from("time"),
        logical_type: time_logical,
        nullable: false,
        physical_type: time.physical_type().to_owned(),
    });
    columns.extend(bindings.iter().map(|binding| ColumnSchema {
        name: binding.public_name.clone(),
        logical_type: String::from("Int32"),
        nullable: false,
        physical_type: String::from("HDF5 signed 32-bit integer"),
    }));
    columns
}

fn oes_format_details(
    layout: &IntensityLayout,
    time: &AxisValues,
    wavelength: &AxisValues,
    bindings: &[OesColumnBinding],
    decoded_axis_bytes: usize,
) -> Vec<FormatDetailsSection> {
    vec![
        FormatDetailsSection {
            id: String::from("oes-hdf5-layout"),
            title: String::from("OES HDF5 layout"),
            content: FormatDetailsContent::KeyValue {
                entries: vec![
                    MetadataEntry {
                        label: String::from("Intensity shape"),
                        value: format!("{} × {}", layout.rows, layout.columns),
                    },
                    MetadataEntry {
                        label: String::from("Intensity dtype"),
                        value: String::from("int32"),
                    },
                    MetadataEntry {
                        label: String::from("Chunk shape"),
                        value: format!("{} × {}", layout.chunk_rows, layout.chunk_columns),
                    },
                    MetadataEntry {
                        label: String::from("Filter"),
                        value: format!(
                            "Blosc v1 (32001), Zstd level {}, {} shuffle",
                            layout.compression_level, layout.shuffle
                        ),
                    },
                    MetadataEntry {
                        label: String::from("Axis storage"),
                        value: String::from("root attributes: time, wavelength"),
                    },
                    MetadataEntry {
                        label: String::from("Time type"),
                        value: time.logical_type().to_owned(),
                    },
                    MetadataEntry {
                        label: String::from("Wavelength type"),
                        value: wavelength.logical_type().to_owned(),
                    },
                    MetadataEntry {
                        label: String::from("Decoded axis bytes"),
                        value: format!("{decoded_axis_bytes} / {MAX_AXIS_BYTES_PER_FILE}"),
                    },
                ],
            },
        },
        FormatDetailsSection {
            id: String::from("oes-hdf5-wavelengths"),
            title: String::from("Wavelength columns"),
            content: FormatDetailsContent::Table {
                columns: vec![
                    String::from("Ordinal"),
                    String::from("Column"),
                    String::from("Original wavelength"),
                ],
                rows: bindings
                    .iter()
                    .take(MAX_WAVELENGTH_METADATA_ROWS)
                    .map(|binding| {
                        vec![
                            (binding.wavelength_index + 1).to_string(),
                            binding.public_name.clone(),
                            binding.original_label.clone(),
                        ]
                    })
                    .collect(),
                truncated: bindings.len() > MAX_WAVELENGTH_METADATA_ROWS,
            },
        },
    ]
}

fn format_timestamp_ns(raw: i64, timezone: Option<&str>) -> String {
    let seconds = raw.div_euclid(1_000_000_000);
    let nanos = raw.rem_euclid(1_000_000_000);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = seconds_of_day % 3_600 / 60;
    let second = seconds_of_day % 60;
    let timezone = timezone
        .map(|value| format!(", timezone={value}"))
        .unwrap_or_default();
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{nanos:09}Z [unit=ns{timezone}]"
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month as u32, day as u32)
}

fn optional_string_attr(file: &File, name: &str, source_file_size: u64) -> Option<String> {
    let attr = file.attr(name).ok()?;
    if !attr.is_scalar() {
        return None;
    }
    let descriptor = attr.dtype().ok()?.to_descriptor().ok()?;
    match descriptor {
        TypeDescriptor::FixedUnicode(size)
            if size <= MAX_AXIS_ELEMENT_BYTES
                && attr.storage_size() <= MAX_AXIS_ELEMENT_BYTES as u64 => {}
        TypeDescriptor::VarLenUnicode if source_file_size <= MAX_AXIS_BYTES_PER_FILE as u64 => {}
        _ => return None,
    }
    let value = attr.read_scalar::<VarLenUnicode>().ok()?;
    (value.len() <= MAX_AXIS_ELEMENT_BYTES).then(|| value.as_str().to_owned())
}

fn plan_hyperslabs(selected: &[(usize, usize)]) -> Result<Vec<HyperslabPlan>, DataError> {
    let mut sorted = selected.to_vec();
    sorted.sort_unstable_by_key(|(_, wavelength_index)| *wavelength_index);
    let mut plans: Vec<HyperslabPlan> = Vec::new();
    for (projection_position, wavelength_index) in sorted {
        if let Some(last) = plans.last_mut() {
            let expected = last
                .start_column
                .checked_add(last.column_count)
                .ok_or_else(|| DataError::invalid_request("Hyperslab column range overflow."))?;
            if wavelength_index == expected {
                last.outputs.push(HyperslabOutput {
                    projection_position,
                    slice_column: last.column_count,
                });
                last.column_count += 1;
                continue;
            }
        }
        plans.push(HyperslabPlan {
            start_column: wavelength_index,
            column_count: 1,
            outputs: vec![HyperslabOutput {
                projection_position,
                slice_column: 0,
            }],
        });
    }
    Ok(plans)
}

#[cfg(test)]
mod tests {
    use std::{env, str::FromStr};

    use hdf5::filters::BloscShuffle;
    use ndarray::arr2;
    use tempfile::TempDir;

    use crate::domain::{DataErrorCode, DataValueState};

    use super::*;

    fn committed_fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/phase-10")
            .join(name)
    }

    fn fixture() -> (TempDir, PathBuf) {
        crate::platform::initialize_hdf5_runtime().expect("HDF5 runtime");
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("numeric.oes.h5");
        let file = File::create(&path).expect("create HDF5 fixture");
        file.new_attr_builder()
            .with_data(&[10_i64, 20, 30, 40])
            .create("time")
            .expect("time attribute");
        file.new_attr_builder()
            .with_data(&[200.0_f64, 300.0, 400.0])
            .create("wavelength")
            .expect("wavelength attribute");
        file.new_dataset_builder()
            .with_data(&arr2(&[
                [1_i32, 2, 3],
                [4, 5, 6],
                [7, 8, 9],
                [i32::MIN, 11, i32::MAX],
            ]))
            .chunk((2, 2))
            .blosc_zstd(5, BloscShuffle::Byte)
            .create("intensity")
            .expect("intensity dataset");
        drop(file);
        (directory, path)
    }

    #[test]
    fn descriptor_exposes_only_bounded_tabular_capabilities() {
        assert_eq!(OES_HDF5_FORMAT_DESCRIPTOR.id, DataFormat::OesHdf5);
        assert_eq!(OES_HDF5_FORMAT_DESCRIPTOR.display_name, "OES HDF5");
        assert_eq!(OES_HDF5_FORMAT_DESCRIPTOR.extensions, &["h5", "hdf5"]);
        assert_eq!(
            OES_HDF5_FORMAT_DESCRIPTOR.capabilities,
            &[
                SourceCapability::TypedSchema,
                SourceCapability::ColumnProjection
            ]
        );
    }

    #[test]
    fn vlen_axis_preflight_reserves_axis_budget_without_using_container_size() {
        let path = Path::new("large-intensity.oes.h5");
        let preflight = axis_preflight(
            path,
            [
                (&TypeDescriptor::VarLenUnicode, 1_000),
                (&TypeDescriptor::Float(FloatSize::U8), 64),
            ],
        )
        .expect("bounded variable-length axis preflight");

        assert!(preflight.has_vlen);
        assert_eq!(preflight.reservation_bytes, MAX_AXIS_BYTES_PER_FILE);
    }

    #[test]
    fn opens_fixture_and_reads_first_middle_last_and_eof_pages() {
        let (_directory, path) = fixture();
        let source = OesHdf5Source::open(&path).expect("open fixture");
        assert_eq!(source.summary().row_count, Some(4));
        assert_eq!(source.summary().column_count, 4);

        let first = source.read_page_projected(0, 1, None).expect("first page");
        assert_eq!(first.columns, ["time", "200", "300", "400"]);
        assert_eq!(first.rows[0][0].display.as_deref(), Some("10"));
        assert_eq!(first.rows[0][3].display.as_deref(), Some("3"));
        assert!(first.has_more);

        let projection = vec![String::from("400"), String::from("time")];
        let middle = source
            .read_page_projected(2, 1, Some(&projection))
            .expect("middle page");
        assert_eq!(middle.columns, projection);
        assert_eq!(middle.rows[0][0].display.as_deref(), Some("9"));
        assert_eq!(middle.rows[0][1].display.as_deref(), Some("30"));

        let last = source.read_page_projected(3, 10, None).expect("last page");
        assert_eq!(last.rows.len(), 1);
        assert_eq!(last.rows[0][1].display.as_deref(), Some("-2147483648"));
        assert_eq!(last.rows[0][3].display.as_deref(), Some("2147483647"));
        assert!(!last.has_more);

        let eof = source.read_page_projected(4, 1, None).expect("EOF page");
        assert!(eof.rows.is_empty());
        assert!(!eof.has_more);
    }

    #[test]
    fn committed_vlen_fixture_decodes_actual_blosc_zstd_payload() {
        let source = OesHdf5Source::open(committed_fixture("oes-core-vlen-time.oes.h5"))
            .expect("open committed vlen fixture");
        assert_eq!(source.summary().row_count, Some(3));
        assert_eq!(source.summary().column_count, 5);
        let page = source
            .read_page_projected(0, 3, None)
            .expect("decode committed fixture");
        assert_eq!(
            page.rows[0][0].display.as_deref(),
            Some("2026-07-17T12:00:00.000+09:00")
        );
        assert_eq!(page.rows[0][1].display.as_deref(), Some("-2147483648"));
        assert_eq!(page.rows[1][3].display.as_deref(), Some("102"));
        assert_eq!(page.rows[2][4].display.as_deref(), Some("203"));
    }

    #[test]
    fn committed_numeric_fixture_preserves_precision_and_int32_boundaries() {
        let source = OesHdf5Source::open(committed_fixture("oes-core-numeric.oes.h5"))
            .expect("open committed numeric fixture");
        let page = source
            .read_page_projected(0, 3, None)
            .expect("numeric page");
        assert_eq!(page.rows[0][0].display.as_deref(), Some("9007199254740993"));
        assert_eq!(page.rows[0][4].display.as_deref(), Some("2147483647"));
        assert_eq!(page.rows[2][1].display.as_deref(), Some("200"));
    }

    #[test]
    fn unknown_root_content_does_not_change_core_semantics() {
        let core = OesHdf5Source::open(committed_fixture("oes-core-vlen-time.oes.h5"))
            .expect("open core fixture");
        let unknown = OesHdf5Source::open(committed_fixture("oes-core-unknown-attrs.oes.h5"))
            .expect("open unknown-content fixture");
        assert_eq!(core.summary().columns, unknown.summary().columns);
        assert_eq!(core.summary().row_count, unknown.summary().row_count);
        assert_eq!(
            core.read_page_projected(0, 3, None).expect("core page"),
            unknown
                .read_page_projected(0, 3, None)
                .expect("unknown-content page")
        );
    }

    #[test]
    fn committed_name_collisions_have_deterministic_projectable_names() {
        let source = OesHdf5Source::open(committed_fixture("oes-name-collisions.oes.h5"))
            .expect("open name-collision fixture");
        assert_eq!(
            source
                .summary()
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            ["time", "wavelength_1", "time [2]", "500", "500 [2]"]
        );
        let projection = vec![String::from("500 [2]"), String::from("wavelength_1")];
        let page = source
            .read_page_projected(0, 1, Some(&projection))
            .expect("collision projection");
        assert_eq!(page.columns, projection);
    }

    #[test]
    fn committed_malformed_and_external_storage_fixtures_are_typed_rejections() {
        for name in [
            "fake.oes.h5",
            "not-oes.h5",
            "oes-truncated.oes.h5",
            "oes-missing-time.oes.h5",
            "oes-missing-wavelength.oes.h5",
            "oes-missing-intensity.oes.h5",
            "oes-axis-datasets.oes.h5",
            "oes-wrong-rank.oes.h5",
            "oes-wrong-dtype.oes.h5",
            "oes-contiguous.oes.h5",
            "oes-wrong-filter.oes.h5",
            "oes-shape-mismatch.oes.h5",
            "oes-soft-link.oes.h5",
            "oes-external-link.oes.h5",
            "oes-vds.oes.h5",
            "oes-external-storage.oes.h5",
            "oes-unknown-filter.oes.h5",
        ] {
            let error =
                OesHdf5Source::open(committed_fixture(name)).expect_err("fixture must be rejected");
            assert_eq!(error.code, DataErrorCode::InvalidOesHdf5, "{name}");
        }
    }

    #[test]
    fn projection_is_bounded_unique_known_and_time_only_skips_intensity() {
        let (_directory, path) = fixture();
        let source = OesHdf5Source::open(&path).expect("open fixture");
        let time = vec![String::from("time")];
        let page = source
            .read_page_projected(0, 2, Some(&time))
            .expect("time-only page");
        assert_eq!(page.rows.len(), 2);
        assert_eq!(source.take_intensity_read_count(), 0);

        for invalid in [
            Vec::<String>::new(),
            vec![String::from("time"), String::from("time")],
            vec![String::from("missing")],
        ] {
            assert_eq!(
                source
                    .read_page_projected(0, 1, Some(&invalid))
                    .expect_err("invalid projection")
                    .code,
                DataErrorCode::InvalidRequest
            );
        }
        let too_wide = (0..65)
            .map(|index| format!("column-{index}"))
            .collect::<Vec<_>>();
        assert_eq!(
            source
                .read_page_projected(0, 1, Some(&too_wide))
                .expect_err("wide projection")
                .code,
            DataErrorCode::InvalidRequest
        );
    }

    #[test]
    fn planner_coalesces_adjacent_columns_and_preserves_output_positions() {
        let plans = plan_hyperslabs(&[(0, 4), (1, 2), (2, 3), (3, 8)]).expect("plan");
        assert_eq!(
            plans,
            vec![
                HyperslabPlan {
                    start_column: 2,
                    column_count: 3,
                    outputs: vec![
                        HyperslabOutput {
                            projection_position: 1,
                            slice_column: 0
                        },
                        HyperslabOutput {
                            projection_position: 2,
                            slice_column: 1
                        },
                        HyperslabOutput {
                            projection_position: 0,
                            slice_column: 2
                        },
                    ]
                },
                HyperslabPlan {
                    start_column: 8,
                    column_count: 1,
                    outputs: vec![HyperslabOutput {
                        projection_position: 3,
                        slice_column: 0
                    }]
                }
            ]
        );
    }

    #[test]
    fn column_binding_is_unique_for_blank_reserved_and_canonical_collisions() {
        let wavelength = AxisValues::Utf8(vec![
            String::new(),
            String::from("time"),
            String::from("x"),
            String::from("x"),
            String::from("x [2]"),
        ]);
        let bindings =
            build_column_bindings(Path::new("fixture.h5"), &wavelength).expect("column bindings");
        assert_eq!(
            bindings
                .iter()
                .map(|binding| binding.public_name.as_str())
                .collect::<Vec<_>>(),
            ["wavelength_1", "time [2]", "x", "x [2]", "x [2] [2]"]
        );
    }

    #[test]
    fn string_axes_and_large_integers_preserve_typed_display() {
        let text = AxisValues::Utf8(vec![String::from("측정-1"), String::new()]);
        assert_eq!(
            text.data_value(0, false, None).display.as_deref(),
            Some("측정-1")
        );
        assert_eq!(text.data_value(1, false, None).state, DataValueState::Empty);
        let integers = AxisValues::I64(vec![9_007_199_254_740_993]);
        assert_eq!(
            integers.data_value(0, false, None).display.as_deref(),
            Some("9007199254740993")
        );
        assert_eq!(integers.data_value(0, false, None).kind, ValueKind::Int);
        let timestamp = AxisValues::I64(vec![1_000_000_123]);
        let value = timestamp.data_value(0, true, Some("Asia/Seoul"));
        assert_eq!(value.kind, ValueKind::Timestamp);
        assert_eq!(
            value.display.as_deref(),
            Some("1970-01-01T00:00:01.000000123Z [unit=ns, timezone=Asia/Seoul]")
        );
    }

    #[test]
    fn rejects_fake_hdf5_and_wrong_layout_without_panicking() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let fake = directory.path().join("fake.h5");
        fs::write(&fake, b"not hdf5").expect("write fake");
        assert_eq!(
            OesHdf5Source::open(&fake).expect_err("fake file").code,
            DataErrorCode::InvalidOesHdf5
        );

        crate::platform::initialize_hdf5_runtime().expect("HDF5 runtime");
        let wrong = directory.path().join("wrong.h5");
        let file = File::create(&wrong).expect("create wrong fixture");
        file.new_attr_builder()
            .with_data(&[1_i64])
            .create("time")
            .expect("time");
        file.new_attr_builder()
            .with_data(&[200_f64])
            .create("wavelength")
            .expect("wavelength");
        file.new_dataset_builder()
            .with_data(&arr2(&[[1_i32]]))
            .chunk((1, 1))
            .create("intensity")
            .expect("unfiltered intensity");
        drop(file);
        assert_eq!(
            OesHdf5Source::open(&wrong).expect_err("wrong filter").code,
            DataErrorCode::InvalidOesHdf5
        );
    }

    #[test]
    fn optional_external_python_fixture_matches_current_rules() {
        let Some(path) = env::var_os("OES_HDF5_SAMPLE_PATH").map(PathBuf::from) else {
            return;
        };
        let source = OesHdf5Source::open(&path).expect("external Python fixture");
        assert_eq!(source.summary().format, DataFormat::OesHdf5);
        assert_eq!(source.summary().row_count, Some(128));
        assert_eq!(source.summary().column_count, 65);
        for (row, wavelength_index, expected) in [
            (0_u64, 0_usize, "6120"),
            (64, 32, "9192"),
            (127, 63, "24971"),
        ] {
            let projection = vec![source.bindings[wavelength_index].public_name.clone()];
            let page = source
                .read_page_projected(row, 1, Some(&projection))
                .expect("golden coordinate page");
            assert_eq!(page.rows[0][0].display.as_deref(), Some(expected));
        }
    }

    #[test]
    fn vlen_utf8_helper_fixture_values_are_valid() {
        let value = VarLenUnicode::from_str("한글 time").expect("vlen UTF-8");
        assert_eq!(value.as_str(), "한글 time");
    }
}
