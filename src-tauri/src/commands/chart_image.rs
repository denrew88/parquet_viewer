//! Native chart-image destinations and bounded image transfer from the renderer.
mod passive_svg;

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use tauri::{ipc::Channel, AppHandle, Manager, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use super::{canonical_path_key, chart::reader, document_error, AppState};
use crate::{
    domain::{DataError, DataErrorCode},
    query::chart::{ChartImageProgress, ChartKind, ChartRequest, ScatterSvgFrame},
};

const MAX_PIXELS: usize = 4_194_304;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCATTER_SVG_BYTES: usize = 512 * 1024 * 1024;
static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
static PUBLISH_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChartClipboardRequest {
    width: u32,
    height: u32,
    rgba: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChartImageRequest {
    title: String,
    image: ChartImage,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum ChartImage {
    Png {
        data: String,
    },
    Svg {
        data: String,
        scatter: Option<Box<ScatterImage>>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScatterImage {
    chart: ChartRequest,
    frame: ScatterSvgFrame,
}

enum PreparedImage {
    Png(Vec<u8>),
    Svg {
        data: String,
        closing_tag: usize,
        scatter: Option<Box<ScatterImage>>,
    },
}

impl ChartImage {
    fn prepare(self) -> Result<PreparedImage, DataError> {
        match self {
            Self::Png { data } => {
                let bytes = decode(&data, MAX_IMAGE_BYTES)?;
                validate_png(&bytes)?;
                Ok(PreparedImage::Png(bytes))
            }
            Self::Svg { data, scatter } => {
                if data.len() > MAX_IMAGE_BYTES {
                    return Err(invalid("The chart SVG exceeds the image transfer limit."));
                }
                if let Some(scatter) = &scatter {
                    if scatter.chart.kind != ChartKind::Scatter {
                        return Err(invalid("Only a scatter chart can export all its points."));
                    }
                    scatter.frame.validate()?;
                }
                let closing_tag = passive_svg::closing_tag(&data).ok_or_else(|| {
                    invalid("The chart SVG is malformed or contains unsupported markup.")
                })?;
                Ok(PreparedImage::Svg {
                    data,
                    closing_tag,
                    scatter,
                })
            }
        }
    }
}

#[tauri::command]
pub async fn copy_chart_image(
    request: ChartClipboardRequest,
    app: AppHandle,
) -> Result<(), DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let length = pixels(request.width, request.height)? * 4;
        let rgba = decode(&request.rgba, length.div_ceil(3) * 4)?;
        if rgba.len() != length {
            return Err(invalid(
                "The chart image dimensions do not match the pixel data.",
            ));
        }
        let image = tauri::image::Image::new_owned(rgba, request.width, request.height);
        app.clipboard().write_image(&image).map_err(|error| {
            io_error(format!(
                "The chart image could not be copied to the clipboard: {error}"
            ))
        })
    })
    .await
    .map_err(|_| io_error("The chart clipboard operation did not finish."))?
}

#[tauri::command]
pub async fn save_chart_image(
    request: ChartImageRequest,
    progress: Channel<ChartImageProgress>,
    app: AppHandle,
    window: Window,
) -> Result<bool, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = request.image.prepare()?;
        let (label, extension, scatter) = match &image {
            PreparedImage::Png(_) => ("PNG", "png", None),
            PreparedImage::Svg { scatter, .. } => ("SVG", "svg", scatter.as_deref()),
        };
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        // Resolve the exact displayed SQL result before the modal dialog. The
        // reader owns its snapshot if that tab succeeds again while saving.
        let source = scatter
            .map(|scatter| reader(&state, &app, &scatter.chart.source))
            .transpose()?
            .flatten();
        let dialog = app
            .dialog()
            .file()
            .set_title(format!("Save chart as {label}"))
            .set_file_name(default_name(&request.title, extension))
            .add_filter(label, &[extension]);
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|_| invalid("Choose a local file to save the chart image."))?;
        let destination = destination_path(&path, extension)?;
        let ensure_allowed = |path: &Path| {
            let canonical = match fs::canonicalize(path) {
                Ok(canonical) => canonical,
                Err(error) if error.kind() == io::ErrorKind::NotFound => path.to_path_buf(),
                Err(error) => return Err(DataError::io(path, error)),
            };
            if state
                .documents
                .has_open_or_reserved_path(&canonical_path_key(&canonical))
                .map_err(document_error)?
            {
                return Err(invalid(
                    "An open source file cannot be replaced by a chart image.",
                ));
            }
            Ok(())
        };
        let limit = if scatter.is_some() {
            MAX_SCATTER_SVG_BYTES
        } else {
            MAX_IMAGE_BYTES
        };
        write_staged(
            &destination,
            limit,
            ensure_allowed,
            |writer| match &image {
                PreparedImage::Png(bytes) => {
                    writer
                        .write_all(bytes)
                        .map_err(|error| DataError::io(&destination, error))?;
                    Ok(None)
                }
                PreparedImage::Svg {
                    data,
                    closing_tag,
                    scatter,
                } => {
                    let (prefix, suffix) = data.as_bytes().split_at(*closing_tag);
                    writer
                        .write_all(prefix)
                        .map_err(|error| DataError::io(&destination, error))?;
                    let job = scatter
                        .as_ref()
                        .map(|scatter| {
                            state.charts.write_scatter_svg_points(
                                &scatter.chart,
                                source,
                                &scatter.frame,
                                writer,
                                |status| {
                                    let _ = progress.send(status);
                                },
                            )
                        })
                        .transpose()?;
                    writer
                        .write_all(suffix)
                        .map_err(|error| DataError::io(&destination, error))?;
                    Ok(job)
                }
            },
            |job| job.as_ref().map_or(Ok(()), |job| job.check()),
        )?;
        Ok(true)
    })
    .await
    .map_err(|_| io_error("The chart image save operation did not finish."))?
}

fn invalid(message: &str) -> DataError {
    DataError::invalid_request(message)
}

fn io_error(message: impl Into<String>) -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: message.into(),
    }
}

fn pixels(width: u32, height: u32) -> Result<usize, DataError> {
    let count = u64::from(width) * u64::from(height);
    if count == 0 || count > MAX_PIXELS as u64 {
        return Err(invalid(
            "The chart image exceeds the 4,194,304 pixel limit.",
        ));
    }
    Ok(count as usize)
}

fn decode(data: &str, limit: usize) -> Result<Vec<u8>, DataError> {
    if data.len() > limit {
        return Err(invalid("The chart image exceeds the image transfer limit."));
    }
    STANDARD
        .decode(data)
        .map_err(|_| invalid("The chart image is not valid base64."))
}

fn validate_png(bytes: &[u8]) -> Result<(), DataError> {
    let invalid_png = || invalid("The chart image is not a complete PNG.");
    let mut rest = bytes
        .strip_prefix(b"\x89PNG\r\n\x1a\n")
        .ok_or_else(invalid_png)?;
    let mut header = false;
    let mut image_data = false;
    while let Some(chunk_header) = rest.get(..8) {
        let length =
            u32::from_be_bytes(chunk_header[..4].try_into().map_err(|_| invalid_png())?) as usize;
        let (chunk, tail) = rest[8..].split_at_checked(length).ok_or_else(invalid_png)?;
        let (checksum, next) = tail.split_at_checked(4).ok_or_else(invalid_png)?;
        let kind = &chunk_header[4..];
        if !kind.iter().all(u8::is_ascii_alphabetic)
            || crc32(kind.iter().chain(chunk).copied()).to_be_bytes() != checksum
        {
            return Err(invalid_png());
        }
        rest = next;
        if !header {
            if kind != b"IHDR"
                || chunk.len() != 13
                || chunk[8] != 8
                || !matches!(chunk[9], 2 | 6)
                || chunk[10..] != [0, 0, 0]
            {
                return Err(invalid_png());
            }
            let width = u32::from_be_bytes(chunk[..4].try_into().map_err(|_| invalid_png())?);
            let height = u32::from_be_bytes(chunk[4..8].try_into().map_err(|_| invalid_png())?);
            pixels(width, height)?;
            header = true;
        } else {
            match kind {
                b"IDAT" => image_data |= !chunk.is_empty(),
                b"IEND" if image_data && chunk.is_empty() && rest.is_empty() => return Ok(()),
                b"IHDR" | b"IEND" => return Err(invalid_png()),
                _ => {}
            }
        }
    }
    Err(invalid_png())
}

const CRC_TABLE: [u32; 256] = {
    let mut table = [0; 256];
    let mut index = 0;
    while index < table.len() {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ (0xedb88320 & 0_u32.wrapping_sub(value & 1));
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
};

fn crc32(bytes: impl Iterator<Item = u8>) -> u32 {
    !bytes.fold(u32::MAX, |checksum, byte| {
        (checksum >> 8) ^ CRC_TABLE[((checksum as u8) ^ byte) as usize]
    })
}

fn invalid_file_char(c: char) -> bool {
    c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
}

fn reserved_device(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

fn default_name(title: &str, extension: &str) -> String {
    let name: String = title
        .trim()
        .chars()
        .take(80)
        .map(|c| if invalid_file_char(c) { '_' } else { c })
        .collect();
    let name = name.trim_end_matches(['.', ' ']);
    if name.is_empty() || reserved_device(name) {
        format!("chart.{extension}")
    } else {
        format!("{name}.{extension}")
    }
}

fn destination_path(path: &Path, extension: &str) -> Result<PathBuf, DataError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.chars().any(invalid_file_char) && !reserved_device(name))
        .ok_or_else(|| invalid("Choose a regular file for the chart image."))?;
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
    {
        return Err(DataError::invalid_request(format!(
            "Choose a .{extension} file to save this chart image."
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Choose an image destination folder."))?;
    let parent = fs::canonicalize(parent).map_err(|error| DataError::io(parent, error))?;
    Ok(parent.join(file_name))
}

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    identity: Option<(u64, u128)>,
}

fn regular_file(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // A reparse point can redirect an apparently ordinary file path.
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata.is_file()
}

fn destination_stamp(path: &Path) -> Result<Option<FileStamp>, DataError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if regular_file(&metadata) => {}
        Ok(_) => return Err(invalid("Choose a regular file for the chart image.")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(DataError::io(path, error)),
    }
    let file = File::open(path).map_err(|error| DataError::io(path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| DataError::io(path, error))?;
    if !regular_file(&metadata) {
        return Err(invalid("Choose a regular file for the chart image."));
    }
    Ok(Some(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        identity: file_identity(&file, &metadata),
    }))
}

#[cfg(windows)]
fn file_identity(file: &File, _metadata: &Metadata) -> Option<(u64, u128)> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct FileIdInfo {
        volume: u64,
        id: [u8; 16],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            file: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }
    let mut info = FileIdInfo::default();
    // SAFETY: file owns the handle and info is a writable FILE_ID_INFO buffer.
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle().cast(),
            18,
            (&mut info as *mut FileIdInfo).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    };
    (result != 0).then_some((info.volume, u128::from_ne_bytes(info.id)))
}

#[cfg(unix)]
fn file_identity(_file: &File, metadata: &Metadata) -> Option<(u64, u128)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), u128::from(metadata.ino())))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File, _metadata: &Metadata) -> Option<(u64, u128)> {
    None
}

struct Stage(PathBuf);

impl Drop for Stage {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.0);
        }
    }
}

struct BoundedWriter<W> {
    inner: W,
    remaining: usize,
    exceeded: bool,
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            self.exceeded = true;
            return Err(io::Error::other(
                "The chart SVG exceeds the 512 MiB export limit.",
            ));
        }
        let count = self.inner.write(bytes)?;
        self.remaining -= count;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn open_stage(destination: &Path) -> Result<(Stage, File), DataError> {
    for _ in 0..64 {
        let number = NEXT_STAGE.fetch_add(1, Ordering::Relaxed);
        let path = destination.with_file_name(format!(
            ".data-viewer-chart-{}-{number}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((Stage(path), file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(DataError::io(&path, error)),
        }
    }
    Err(io_error(
        "A temporary chart image file could not be created.",
    ))
}

fn write_staged<T>(
    destination: &Path,
    limit: usize,
    ensure_allowed: impl Fn(&Path) -> Result<(), DataError>,
    write: impl FnOnce(&mut BoundedWriter<BufWriter<&mut File>>) -> Result<T, DataError>,
    check_before_commit: impl FnOnce(&T) -> Result<(), DataError>,
) -> Result<(), DataError> {
    ensure_allowed(destination)?;
    let expected = destination_stamp(destination)?;
    let (mut stage, mut file) = open_stage(destination)?;
    let outcome = (|| {
        let mut writer = BoundedWriter {
            inner: BufWriter::new(&mut file),
            remaining: limit,
            exceeded: false,
        };
        let result = write(&mut writer);
        if writer.exceeded {
            return Err(invalid("The chart SVG exceeds the 512 MiB export limit."));
        }
        let guard = result?;
        writer
            .flush()
            .map_err(|error| DataError::io(destination, error))?;
        drop(writer);
        file.sync_all()
            .map_err(|error| DataError::io(destination, error))?;
        drop(file);
        let _publish = PUBLISH_LOCK
            .lock()
            .map_err(|_| io_error("Chart image publishing is unavailable."))?;
        ensure_allowed(destination)?;
        if destination_stamp(destination)? != expected {
            return Err(invalid(
                "The chart image destination changed while saving. Choose it again.",
            ));
        }
        check_before_commit(&guard)?;
        publish(&stage.0, destination, expected.is_some())
            .map_err(|error| DataError::io(destination, error))
    })();
    if let Err(error) = outcome {
        if let Err(cleanup) = fs::remove_file(&stage.0) {
            return Err(io_error(format!(
                "{} The temporary image could not be removed: {cleanup}",
                error.message
            )));
        }
        stage.0.clear();
        return Err(error);
    }
    stage.0.clear();
    Ok(())
}

#[cfg(windows)]
fn publish(stage: &Path, destination: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    const REPLACE_EXISTING: u32 = 0x1;
    const WRITE_THROUGH: u32 = 0x8;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>()
    };
    let stage = wide(stage);
    let destination = wide(destination);
    let flags = WRITE_THROUGH | if replace { REPLACE_EXISTING } else { 0 };
    // SAFETY: both buffers are NUL-terminated and live for the synchronous call.
    if unsafe { MoveFileExW(stage.as_ptr(), destination.as_ptr(), flags) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish(stage: &Path, destination: &Path, replace: bool) -> io::Result<()> {
    if replace {
        fs::rename(stage, destination)
    } else {
        fs::hard_link(stage, destination)?;
        fs::remove_file(stage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn validates_image_transfer_limits_and_png_integrity() {
        fn chunk(bytes: &mut Vec<u8>, kind: &[u8; 4], value: &[u8]) {
            bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(value);
            bytes.extend_from_slice(&crc32(kind.iter().chain(value).copied()).to_be_bytes());
        }

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut png, b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
        chunk(
            &mut png,
            b"IDAT",
            &[0x78, 0x9c, 0x63, 0x60, 0, 2, 0, 0, 5, 0, 1],
        );
        chunk(&mut png, b"IEND", &[]);
        assert!(validate_png(&png).is_ok());
        assert!(validate_png(&png[..png.len() - 1]).is_err());
        png[45] ^= 1;
        assert!(validate_png(&png).is_err());
        assert_eq!(pixels(2048, 2048).unwrap(), MAX_PIXELS);
        assert!(pixels(2049, 2048).is_err());
        assert!(pixels(0, 2048).is_err());
        assert!(decode("AAAA", 3).is_err());
        assert!(decode("****", 4).is_err());
    }

    #[test]
    fn sanitizes_the_default_filename_and_checks_the_destination_extension() {
        assert_eq!(
            default_name(" 한글/원본:<abc>  ", "svg"),
            "한글_원본__abc_.svg"
        );
        assert_eq!(default_name("  .  ", "png"), "chart.png");
        assert_eq!(default_name("NUL.txt", "png"), "chart.png");
        assert_eq!(default_name("COM¹", "svg"), "chart.svg");
        let directory = tempfile::tempdir().unwrap();
        assert!(destination_path(&directory.path().join("chart.SVG"), "svg").is_ok());
        assert!(destination_path(&directory.path().join("chart.parquet"), "svg").is_err());
        assert!(destination_path(&directory.path().join("bad:stream.svg"), "svg").is_err());
        let output = directory.path().join("folder.svg");
        fs::create_dir(&output).unwrap();
        assert!(destination_stamp(&output).is_err());
    }

    fn write_example<W: Write>(writer: &mut W) -> Result<(), DataError> {
        writer
            .write_all(b"chart")
            .map_err(|error| io_error(error.to_string()))
    }

    fn assert_only_file(directory: &Path, file: &Path, expected: &[u8]) {
        assert_eq!(fs::read(file).unwrap(), expected);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    }

    #[test]
    fn stages_new_and_overwritten_images_without_leaving_partials() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("chart.svg");
        for previous in [None, Some(b"prior".as_slice())] {
            if let Some(previous) = previous {
                fs::write(&output, previous).unwrap();
            }
            write_staged(
                &output,
                32,
                |_| Ok(()),
                |writer| {
                    assert_eq!(fs::read(&output).ok().as_deref(), previous);
                    write_example(writer)
                },
                |_| Ok(()),
            )
            .unwrap();
            assert_only_file(directory.path(), &output, b"chart");
        }
    }

    #[test]
    fn cancellation_limits_and_protection_leave_the_destination_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("chart.svg");
        fs::write(&output, b"prior").unwrap();
        let cancelled = write_staged(
            &output,
            32,
            |_| Ok(()),
            |writer| write_example(writer),
            |_| Err(DataError::task_cancelled()),
        )
        .unwrap_err();
        assert_eq!(cancelled.code, DataErrorCode::TaskCancelled);
        assert_only_file(directory.path(), &output, b"prior");

        let limited = write_staged(
            &output,
            3,
            |_| Ok(()),
            |writer| write_example(writer),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(limited.code, DataErrorCode::InvalidRequest);
        assert_only_file(directory.path(), &output, b"prior");

        let checked = Cell::new(false);
        let denied = write_staged(
            &output,
            32,
            |_| {
                if checked.replace(true) {
                    return Err(invalid("The destination is now open as a source."));
                }
                Ok(())
            },
            |writer| write_example(writer),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(denied.code, DataErrorCode::InvalidRequest);
        assert_only_file(directory.path(), &output, b"prior");

        let absent = directory.path().join("new.svg");
        assert!(write_staged(
            &absent,
            32,
            |_| Ok(()),
            |_| Err(DataError::task_cancelled()),
            |_: &()| Ok(())
        )
        .is_err());
        assert_only_file(directory.path(), &output, b"prior");
    }

    #[test]
    fn checks_file_identity_again_and_never_clobbers_an_unconfirmed_new_destination() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("chart.svg");
        fs::write(&output, b"prior").unwrap();
        let changed = write_staged(
            &output,
            32,
            |_| Ok(()),
            |writer| {
                write_example(writer)?;
                fs::write(&output, b"external replacement").unwrap();
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(changed.message.contains("destination changed"));
        assert_only_file(directory.path(), &output, b"external replacement");

        let stage = directory.path().join("stage");
        fs::write(&stage, b"new").unwrap();
        assert!(publish(&stage, &output, false).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"external replacement");
        assert_eq!(fs::read(&stage).unwrap(), b"new");
    }
}
