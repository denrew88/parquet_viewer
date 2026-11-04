use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::Instant;

use polars_arrow::array::{
    Array, BooleanArray, MutableBinaryViewArray, PrimitiveArray, Utf8ViewArray,
};
use polars_arrow::datatypes::{ArrowDataType as D, ArrowSchema, Field};
use polars_error::PolarsResult;
use polars_parquet::write::{
    CompressedPage, CompressionOptions, Compressor, DynIter, DynStreamingIterator, FileWriter,
    StatisticsOptions, Version, WriteOptions, array_to_columns, fallible_streaming_iterator,
    get_dtype_encoding,
};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, String>;
const ROWS: usize = 65_536;
const BATCH_BYTES: usize = 32 * 1024 * 1024;
const RECORD_BYTES: usize = 8 * 1024 * 1024;
// At most 2x decoded bytes for escaped quotes, plus quoting/delimiters for 256 fields.
const RAW_RECORD_BYTES: usize = 2 * RECORD_BYTES + 3 * 256 + 2;

// csv intentionally accepts unterminated quotes. The admitted Polars input contract does not.
// Validate default-dialect quote structure while bytes are read, without a separate source pass.
struct StrictQuotes<R> {
    inner: R,
    field_start: bool,
    quoted: bool,
    after_quote: bool,
    record_bytes: usize,
    grammar_prefix_bytes: usize,
}
impl<R> StrictQuotes<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            field_start: true,
            quoted: false,
            after_quote: false,
            record_bytes: 0,
            grammar_prefix_bytes: 0,
        }
    }
}
impl<R: Read> Read for StrictQuotes<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if cancelled() {
            return Err(std::io::Error::other("cancelled"));
        }
        let n = self.inner.read(out)?;
        if n == 0 && self.quoted && !self.after_quote {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unterminated CSV quote",
            ));
        }
        for &b in &out[..n] {
            // The CSV parser must see the original BOM and remove it exactly once.
            if self.grammar_prefix_bytes > 0 {
                self.grammar_prefix_bytes -= 1;
                continue;
            }
            self.record_bytes += 1;
            if self.record_bytes > RAW_RECORD_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "raw record byte limit exceeded",
                ));
            }
            let record_end = matches!(b, b'\r' | b'\n') && (!self.quoted || self.after_quote);
            if self.quoted {
                if self.after_quote {
                    if b == b'"' {
                        self.after_quote = false;
                    } else if matches!(b, b',' | b'\r' | b'\n') {
                        self.quoted = false;
                        self.after_quote = false;
                        self.field_start = true;
                    } else {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "characters after closing CSV quote",
                        ));
                    }
                } else if b == b'"' {
                    self.after_quote = true;
                }
            } else if self.field_start && b == b'"' {
                self.quoted = true;
                self.field_start = false;
            } else {
                self.field_start = matches!(b, b',' | b'\r' | b'\n');
            }
            if record_end {
                self.record_bytes = 0;
            }
        }
        Ok(n)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Target {
    Auto,
    Text,
    Boolean,
    Int64,
    #[serde(rename = "uint64")]
    UInt64,
    Float64,
    Decimal,
    Skip,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Profile {
    profile: ProfileBody,
    resolved_targets: Vec<Target>,
    header_used: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileBody {
    mode: String,
    generation: u64,
    columns: Vec<Column>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Column {
    source_index: usize,
    #[serde(rename = "sourceName")]
    _source_name: String,
    target_type: Target,
    trim: bool,
    null_tokens: Vec<String>,
    true_tokens: Vec<String>,
    false_tokens: Vec<String>,
    decimal_separator: String,
    thousand_separator: Option<String>,
    temporal_formats: Vec<String>,
    timezone_policy: String,
    timezone_offset_minutes: Option<i32>,
    duration_unit: Option<String>,
    duration_input_format: Option<String>,
    failure_policy: String,
}

fn validate(p: &Profile) -> Result<Vec<Target>> {
    if !matches!(p.profile.mode.as_str(), "auto" | "allText" | "custom")
        || p.profile.generation == 0
    {
        return Err("invalid profile mode or generation".into());
    }
    if p.profile.columns.is_empty() || p.profile.columns.len() > 256 {
        return Err("columns must be 1..256".into());
    }
    let mut resolved = p.resolved_targets.iter();
    let mut out = Vec::new();
    for (i, c) in p.profile.columns.iter().enumerate() {
        if c.source_index != i
            || c.trim
            || c.null_tokens != ["NULL", "N/A"]
            || c.true_tokens != ["true", "TRUE", "1"]
            || c.false_tokens != ["false", "FALSE", "0"]
            || c.decimal_separator != "."
            || c.thousand_separator.is_some()
            || !c.temporal_formats.is_empty()
            || c.timezone_policy != "preserve"
            || c.timezone_offset_minutes.is_some()
            || c.duration_unit.is_some()
            || c.duration_input_format.is_some()
            || c.failure_policy != "preserveInvalid"
        {
            return Err("experiment supports only contiguous default-token/no-trim profile".into());
        }
        let target = if c.target_type == Target::Skip {
            Target::Skip
        } else {
            let target = *resolved.next().ok_or("missing resolved target")?;
            if matches!(target, Target::Auto | Target::Skip) {
                return Err("resolved targets must be concrete value types".into());
            }
            target
        };
        out.push(target);
    }
    if resolved.next().is_some() {
        return Err("extra resolved target".into());
    }
    Ok(out)
}

fn dtype(t: Target) -> D {
    match t {
        Target::Boolean => D::Boolean,
        Target::Int64 => D::Int64,
        Target::UInt64 => D::UInt64,
        Target::Float64 => D::Float64,
        _ => D::Utf8View,
    }
}
fn schema(targets: &[Target]) -> ArrowSchema {
    let mut fields = vec![Field::new("__dv_row_id".into(), D::UInt64, true)];
    fields.extend(
        (0..targets.len())
            .map(|i| Field::new(format!("__dv_base_raw_{i}").into(), D::Utf8View, true)),
    );
    fields.extend(
        targets
            .iter()
            .enumerate()
            .filter(|(_, t)| !matches!(t, Target::Text | Target::Skip))
            .map(|(i, t)| Field::new(format!("__dv_value_{i}").into(), dtype(*t), true)),
    );
    fields.extend(
        (0..targets.len().div_ceil(32))
            .map(|i| Field::new(format!("__dv_state_word_{i}").into(), D::UInt64, true)),
    );
    fields.into_iter().collect()
}

struct Batch {
    start: u64,
    len: usize,
    raw: Vec<Utf8ViewArray>,
}
struct Encoded {
    len: usize,
    pages: Vec<Vec<CompressedPage>>,
}

fn cancelled() -> bool {
    std::env::var_os("CSV_NATIVE_CANCEL_FILE").is_some_and(|p| Path::new(&p).exists())
}
fn detect_utf8_bom<R: Read + Seek>(reader: &mut R) -> std::io::Result<usize> {
    let mut prefix = [0_u8; 3];
    let bom = match reader.read_exact(&mut prefix) {
        Ok(()) => prefix == [0xef, 0xbb, 0xbf],
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => false,
        Err(e) => return Err(e),
    };
    reader.seek(SeekFrom::Start(0))?;
    Ok(if bom { 3 } else { 0 })
}
fn produce(source: &Path, header: bool, width: usize, tx: mpsc::SyncSender<Result<Batch>>) {
    let result = (|| -> Result<()> {
        let mut file = File::open(source).map_err(|e| e.to_string())?;
        let bom_bytes = detect_utf8_bom(&mut file).map_err(|e| e.to_string())?;
        let mut reader = StrictQuotes::new(file);
        reader.grammar_prefix_bytes = bom_bytes;
        let mut csv = csv::ReaderBuilder::new()
            .buffer_capacity(256 * 1024)
            .has_headers(header)
            .from_reader(reader);
        if header {
            let fields = csv.byte_headers().map_err(|e| e.to_string())?;
            if fields.len() != width || fields.as_slice().len() > RECORD_BYTES {
                return Err("CSV header differs from profile or exceeds record limit".into());
            }
        }
        let mut record = csv::ByteRecord::new();
        let mut start = 0u64;
        loop {
            if cancelled() {
                return Err("cancelled".into());
            }
            let mut builders: Vec<_> = (0..width)
                .map(|_| MutableBinaryViewArray::<str>::with_capacity(ROWS))
                .collect();
            let mut len = 0;
            let mut bytes = 0;
            while len < ROWS
                && bytes < BATCH_BYTES
                && csv
                    .read_byte_record(&mut record)
                    .map_err(|e| e.to_string())?
            {
                if record.len() != width {
                    return Err("CSV width differs from profile".into());
                }
                if record.as_slice().len() > RECORD_BYTES {
                    return Err("record byte limit exceeded".into());
                }
                for (b, v) in builders.iter_mut().zip(record.iter()) {
                    b.push_value(std::str::from_utf8(v).map_err(|e| e.to_string())?);
                }
                bytes += record.as_slice().len();
                len += 1;
                if len % 4096 == 0 && cancelled() {
                    return Err("cancelled".into());
                }
            }
            if len == 0 {
                break;
            }
            let raw = builders.into_iter().map(|b| b.freeze()).collect();
            if tx.send(Ok(Batch { start, len, raw })).is_err() {
                return Ok(());
            }
            start += len as u64;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = tx.send(Err(e));
    }
}

fn boolean(s: &str) -> Option<bool> {
    match s {
        "true" | "TRUE" | "1" => Some(true),
        "false" | "FALSE" | "0" => Some(false),
        _ => None,
    }
}
fn state(raw: &str, t: Target, valid: bool) -> u8 {
    if raw.is_empty() {
        2
    } else if t == Target::Skip {
        0
    } else if raw == "NULL" || raw == "N/A" {
        1
    } else if valid {
        0
    } else {
        3
    }
}

fn convert_column(raw: &Utf8ViewArray, target: Target) -> (Option<Box<dyn Array>>, Vec<u8>) {
    let mut states = Vec::with_capacity(raw.len());
    macro_rules! numeric {
        ($ty:ty) => {{
            let mut values = Vec::with_capacity(raw.len());
            for v in raw.values_iter() {
                let parsed = v.parse::<$ty>().ok();
                states.push(state(v, target, parsed.is_some()));
                values.push(parsed);
            }
            Some(Box::new(PrimitiveArray::<$ty>::from(values)) as Box<dyn Array>)
        }};
    }
    let typed = match target {
        Target::Int64 => numeric!(i64),
        Target::UInt64 => numeric!(u64),
        Target::Float64 => numeric!(f64),
        Target::Boolean => {
            let values: Vec<_> = raw
                .values_iter()
                .map(|v| {
                    let p = boolean(v);
                    states.push(state(v, target, p.is_some()));
                    p
                })
                .collect();
            Some(Box::new(BooleanArray::from(values)) as Box<dyn Array>)
        }
        Target::Decimal => {
            states.extend(raw.values_iter().map(|v| state(v, target, true)));
            Some(Box::new(raw.clone()) as Box<dyn Array>)
        }
        _ => {
            states.extend(raw.values_iter().map(|v| state(v, target, true)));
            None
        }
    };
    (typed, states)
}

fn encode_with_schema(
    batch: Batch,
    targets: &[Target],
    schema: &polars_parquet::write::SchemaDescriptor,
    options: WriteOptions,
) -> Result<Encoded> {
    let converted: Vec<_> = batch
        .raw
        .par_iter()
        .zip(targets.par_iter())
        .map(|(r, t)| convert_column(r, *t))
        .collect();
    let mut arrays: Vec<Box<dyn Array>> = Vec::new();
    arrays.push(Box::new(PrimitiveArray::<u64>::from_vec(
        (batch.start..batch.start + batch.len as u64).collect(),
    )));
    arrays.extend(batch.raw.into_iter().map(|a| Box::new(a) as Box<dyn Array>));
    let mut states = Vec::new();
    for (typed, s) in converted {
        if let Some(a) = typed {
            arrays.push(a);
        }
        states.push(s);
    }
    for word in states.chunks(32) {
        let mut packed = vec![0u64; batch.len];
        for (lane, column) in word.iter().enumerate() {
            for (dest, s) in packed.iter_mut().zip(column) {
                *dest |= (*s as u64) << (lane * 2);
            }
        }
        arrays.push(Box::new(PrimitiveArray::<u64>::from_vec(packed)));
    }
    let fields = schema.fields();
    let encoded: Result<Vec<_>> = arrays
        .into_par_iter()
        .enumerate()
        .map(|(i, a)| {
            if cancelled() {
                return Err("cancelled".into());
            }
            let encodings = get_dtype_encoding(a.dtype());
            let mut columns = Vec::new();
            for pages in array_to_columns(a, fields[i].clone(), options, &encodings)
                .map_err(|e| e.to_string())?
            {
                let pages = pages.map(|r| {
                    r.map_err(|e| {
                        polars_parquet::parquet::error::ParquetError::FeatureNotSupported(
                            e.to_string(),
                        )
                    })
                });
                let compressed = Compressor::new_from_vec(pages, options.compression, vec![])
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                columns.push(compressed);
            }
            Ok(columns)
        })
        .collect();
    Ok(Encoded {
        len: batch.len,
        pages: encoded?.into_iter().flatten().collect(),
    })
}

fn write_group(writer: &mut FileWriter<BufWriter<File>>, group: &Encoded) -> Result<()> {
    let columns = DynIter::new(group.pages.iter().map(|pages| {
        PolarsResult::Ok(DynStreamingIterator::new(
            fallible_streaming_iterator::convert(pages.iter().map(PolarsResult::Ok)),
        ))
    }));
    writer
        .write(group.len as u64, columns)
        .map_err(|e| e.to_string())
}

fn convert(args: &[String]) -> Result<Value> {
    if args.len() != 7 || args[0] != "--csv-engine-compare" || args[1] != "native" {
        return Err(
            "usage: --csv-engine-compare native SOURCE OUTPUT PROFILE THREADS MEMORY_MIB".into(),
        );
    }
    let started = Instant::now();
    let source = fs::canonicalize(&args[2]).map_err(|e| e.to_string())?;
    let output = PathBuf::from(&args[3]);
    if output.exists() {
        return Err("output already exists".into());
    }
    if fs::metadata(&args[4]).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("profile limit".into());
    }
    let profile: Profile = serde_json::from_slice(&fs::read(&args[4]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let targets = validate(&profile)?;
    let threads: usize = args[5].parse::<usize>().map_err(|e| e.to_string())?;
    if !(1..=8).contains(&threads) {
        return Err("threads must be 1..8".into());
    }
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .map_err(|e| e.to_string())?;
    let partial = output.with_extension("parquet.partial");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|e| e.to_string())?;
    let options = WriteOptions {
        statistics: StatisticsOptions::default(),
        version: Version::V1,
        compression: CompressionOptions::Zstd(None),
        data_page_size: None,
    };
    let mut writer = FileWriter::try_new(
        BufWriter::with_capacity(1024 * 1024, file),
        schema(&targets),
        options,
    )
    .map_err(|e| e.to_string())?;
    // Only schema metadata is used by the compute stage; it never writes to this handle.
    let compute_schema = Arc::new(writer.parquet_schema().clone());
    let sink_started = Instant::now();
    let result = std::thread::scope(|scope| -> Result<(u64, usize)> {
        let (batch_tx, batch_rx) = mpsc::sync_channel(1);
        let (encoded_tx, encoded_rx) = mpsc::sync_channel::<Result<Encoded>>(1);
        let producer =
            scope.spawn(|| produce(&source, profile.header_used, targets.len(), batch_tx));
        let consumer = scope.spawn(move || -> Result<(u64, usize)> {
            let mut rows = 0u64;
            let mut groups = 0;
            for group in encoded_rx {
                let group = group?;
                write_group(&mut writer, &group)?;
                rows += group.len as u64;
                groups += 1;
            }
            if cancelled() {
                return Err("cancelled".into());
            }
            writer.end(None).map_err(|e| e.to_string())?;
            let mut file = writer.into_inner();
            std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
            file.get_ref().sync_all().map_err(|e| e.to_string())?;
            Ok((rows, groups))
        });
        let compute = (|| -> Result<()> {
            for batch in batch_rx {
                let batch = batch?;
                let group =
                    pool.install(|| encode_with_schema(batch, &targets, &compute_schema, options))?;
                encoded_tx
                    .send(Ok(group))
                    .map_err(|_| "writer disconnected".to_string())?;
            }
            Ok(())
        })();
        if let Err(e) = &compute {
            let _ = encoded_tx.send(Err(e.clone()));
        }
        drop(encoded_tx);
        producer
            .join()
            .map_err(|_| "producer panicked".to_string())?;
        let consumed = consumer.join().map_err(|_| "writer panicked".to_string())?;
        compute?;
        consumed
    });
    let (rows, groups) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&partial);
            return Err(e);
        }
    };
    let sink_ms = sink_started.elapsed().as_secs_f64() * 1000.0;
    if let Err(e) = fs::hard_link(&partial, &output) {
        let _ = fs::remove_file(&partial);
        return Err(e.to_string());
    }
    fs::remove_file(&partial).map_err(|e| e.to_string())?;
    Ok(
        json!({"engine":"native", "rows":rows, "physicalColumns":schema(&targets).len(),
        "rowGroups":groups,"threads":threads,"sinkMs":sink_ms,"totalMs":started.elapsed().as_secs_f64()*1000.0,
        "outputBytes":fs::metadata(output).map_err(|e|e.to_string())?.len(),
        "rowGroupTarget":ROWS,"batchFieldBytesTarget":BATCH_BYTES,"inputQueue":1,"outputQueue":1}),
    )
}

fn main() {
    match convert(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(value) => println!("{value}"),
        Err(e) => {
            eprintln!("{}", json!({"error":e}));
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use polars_arrow::array::StaticArray;
    #[test]
    fn states_preserve_skip_and_null_order() {
        assert_eq!(state("", Target::Skip, true), 2);
        assert_eq!(state("NULL", Target::Skip, true), 0);
        assert_eq!(state("NULL", Target::Int64, false), 1);
        assert_eq!(state("bad", Target::Int64, false), 3);
    }
    #[test]
    fn bool_tokens_are_exact() {
        assert_eq!(boolean("TRUE"), Some(true));
        assert_eq!(boolean("False"), None);
    }
    #[test]
    fn integer_precision_and_invalid() {
        let mut b = MutableBinaryViewArray::<str>::new();
        for s in [
            "9223372036854775807",
            "9223372036854775808",
            "-1",
            "",
            "NULL",
        ] {
            b.push_value(s);
        }
        let (a, s) = convert_column(&b.freeze(), Target::Int64);
        let a = a.unwrap();
        let a = a.as_any().downcast_ref::<PrimitiveArray<i64>>().unwrap();
        assert_eq!(a.get(0), Some(i64::MAX));
        assert_eq!(a.get(1), None);
        assert_eq!(s, [0, 3, 0, 2, 1]);
    }
    #[test]
    fn negative_zero_preserved() {
        let mut b = MutableBinaryViewArray::<str>::new();
        b.push_value("-0");
        let (a, _) = convert_column(&b.freeze(), Target::Float64);
        let a = a.unwrap();
        assert_eq!(
            a.as_any()
                .downcast_ref::<PrimitiveArray<f64>>()
                .unwrap()
                .value(0)
                .to_bits(),
            (-0.0f64).to_bits()
        );
    }
    #[test]
    fn quoted_newlines_and_escaped_quotes() {
        for bytes in [
            b"a,b\r\n1,\"x\r\ny\"\r\n".as_slice(),
            b"a\n\"x\"\"y\"\n".as_slice(),
        ] {
            let mut r = StrictQuotes::new(bytes);
            let mut out = Vec::new();
            r.read_to_end(&mut out).unwrap();
            assert_eq!(out, bytes);
        }
        let mut r = StrictQuotes::new(b"a\n\"oops\n".as_slice());
        assert!(r.read_to_end(&mut Vec::new()).is_err());
    }
    #[test]
    fn quote_state_survives_small_reads_and_bounds_unterminated_records() {
        let input = b"\"a\"\"b\nc\",x\r\n";
        let mut r = StrictQuotes::new(input.as_slice());
        let mut out = Vec::new();
        let mut byte = [0u8; 1];
        while r.read(&mut byte).unwrap() != 0 {
            out.push(byte[0]);
        }
        assert_eq!(out, input);
        let mut limited = StrictQuotes::new(std::io::repeat(b'x'));
        let mut buffer = [0u8; 256 * 1024];
        let mut total = 0;
        while limited.read(&mut buffer).is_ok() {
            total += buffer.len();
        }
        assert!(total <= RAW_RECORD_BYTES);
        let mut open = StrictQuotes::new(b"\"x".as_slice());
        open.read_exact(&mut [0; 2]).unwrap();
        assert_eq!(open.read(&mut []).unwrap(), 0);
    }
    #[test]
    fn bom_is_ignored_by_quote_state_and_short_inputs_rewind() {
        for bytes in [
            b"\xef\xbb\xbf\"a\nb\",1\n".as_slice(),
            b"x".as_slice(),
            b"".as_slice(),
        ] {
            let mut reader = std::io::Cursor::new(bytes);
            let bom_bytes = detect_utf8_bom(&mut reader).unwrap();
            let mut reader = StrictQuotes::new(reader);
            reader.grammar_prefix_bytes = bom_bytes;
            let mut out = Vec::new();
            reader.read_to_end(&mut out).unwrap();
            assert_eq!(out, bytes);
        }
        let bytes = b"\xef\xbb\xbf\xef\xbb\xbfa\n";
        let mut input = std::io::Cursor::new(bytes);
        let prefix = detect_utf8_bom(&mut input).unwrap();
        let mut input = StrictQuotes::new(input);
        input.grammar_prefix_bytes = prefix;
        let mut csv = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_reader(input);
        let record = csv.byte_records().next().unwrap().unwrap();
        assert_eq!(&record[0], "\u{feff}a".as_bytes());
    }
    #[test]
    fn source_auto_is_allowed_but_resolved_auto_and_settings_are_rejected() {
        let mut p: Value = serde_json::from_slice(include_bytes!(
            "../../csv-engine-compare/fixtures/main-profile.json"
        ))
        .unwrap();
        p["profile"]["columns"][0]["targetType"] = json!("auto");
        assert!(validate(&serde_json::from_value::<Profile>(p.clone()).unwrap()).is_ok());
        p["resolvedTargets"][0] = json!("auto");
        assert!(validate(&serde_json::from_value::<Profile>(p.clone()).unwrap()).is_err());
        p["resolvedTargets"][0] = json!("int64");
        p["profile"]["columns"][0]["failurePolicy"] = json!("asNull");
        assert!(validate(&serde_json::from_value::<Profile>(p).unwrap()).is_err());
    }
}
