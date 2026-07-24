use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use polars::prelude::*;
use serde::Serialize;

const COLUMNS: [&str; 15] = [
    "row_id",
    "group_id",
    "category",
    "active",
    "optional_value",
    "event_time",
    "amount",
    "label",
    "code",
    "metric_00",
    "metric_01",
    "metric_02",
    "metric_03",
    "metric_04",
    "metric_05",
];

const STRING_COLUMNS: [&str; 3] = ["category", "label", "code"];
const CELLS_PER_WORD: usize = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PocResult {
    source: String,
    output_directory: String,
    rows: u64,
    columns: usize,
    physical_columns: usize,
    structure_and_state_ms: f64,
    parquet_sink_ms: f64,
    total_ms: f64,
    parquet_bytes: u64,
    state_bytes: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let source = PathBuf::from(args.next().ok_or("source CSV path is required")?);
    let output_directory = PathBuf::from(args.next().ok_or("output directory is required")?);
    if args.next().is_some() {
        return Err("expected exactly source and output directory arguments".into());
    }
    std::fs::create_dir_all(&output_directory)?;
    let parquet_path = output_directory.join("prepared.parquet");
    let state_path = output_directory.join("states.bin");

    let total_started = Instant::now();
    let structure_started = Instant::now();
    let state = scan_states(&source)?;
    write_states(&state_path, &state)?;
    let structure_and_state_ms = structure_started.elapsed().as_secs_f64() * 1_000.0;

    let sink_started = Instant::now();
    sink_compact_parquet(&source, &parquet_path)?;
    OpenOptions::new()
        .write(true)
        .open(&parquet_path)?
        .sync_all()?;
    let parquet_sink_ms = sink_started.elapsed().as_secs_f64() * 1_000.0;

    let result = PocResult {
        source: source.display().to_string(),
        output_directory: output_directory.display().to_string(),
        rows: state.rows,
        columns: COLUMNS.len(),
        physical_columns: 1 + COLUMNS.len() + (COLUMNS.len() - STRING_COLUMNS.len()),
        structure_and_state_ms,
        parquet_sink_ms,
        total_ms: total_started.elapsed().as_secs_f64() * 1_000.0,
        parquet_bytes: std::fs::metadata(&parquet_path)?.len(),
        state_bytes: std::fs::metadata(&state_path)?.len(),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

struct StateWords {
    columns: Vec<Vec<u64>>,
    rows: u64,
}

fn scan_states(source: &Path) -> Result<StateWords, Box<dyn std::error::Error>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_path(source)?;
    let headers = reader.headers()?.clone();
    if headers.len() != COLUMNS.len()
        || headers
            .iter()
            .zip(COLUMNS)
            .any(|(actual, expected)| actual != expected)
    {
        return Err("the Phase 15 POC requires the canonical 15-column fixture schema".into());
    }
    let mut columns = vec![Vec::<u64>::new(); COLUMNS.len()];
    let mut rows = 0_u64;
    for record in reader.byte_records() {
        let record = record?;
        let word_index = usize::try_from(rows / CELLS_PER_WORD as u64)?;
        let shift = (rows as usize % CELLS_PER_WORD) * 2;
        for (column_index, field) in record.iter().enumerate() {
            let column = &mut columns[column_index];
            if column.len() == word_index {
                column.push(0);
            }
            if field.is_empty() {
                column[word_index] |= 0b10_u64 << shift;
            }
        }
        rows += 1;
    }
    Ok(StateWords { columns, rows })
}

fn write_states(path: &Path, state: &StateWords) -> Result<(), Box<dyn std::error::Error>> {
    let mut writer = BufWriter::with_capacity(4 * 1024 * 1024, File::create(path)?);
    writer.write_all(b"DVST\x01\0\0\0")?;
    writer.write_all(&state.rows.to_le_bytes())?;
    writer.write_all(&(state.columns.len() as u64).to_le_bytes())?;
    let mut chunk = Vec::with_capacity(4 * 1024 * 1024);
    for column in &state.columns {
        for word in column {
            chunk.extend_from_slice(&word.to_le_bytes());
            if chunk.len() == chunk.capacity() {
                writer.write_all(&chunk)?;
                chunk.clear();
            }
        }
    }
    if !chunk.is_empty() {
        writer.write_all(&chunk)?;
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(())
}

fn sink_compact_parquet(source: &Path, output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut schema = Schema::with_capacity(COLUMNS.len());
    for name in COLUMNS {
        schema.with_column(name.into(), DataType::String);
    }
    let source_text = source.to_string_lossy();
    let output_text = output.to_string_lossy();
    let frame = LazyCsvReader::new(PlRefPath::new(source_text.as_ref()))
        .with_has_header(true)
        .with_schema(Some(Arc::new(schema)))
        .with_cache(false)
        .with_missing_is_null(false)
        .with_low_memory(true)
        .finish()?
        .with_row_index("__dv_row_id", None);

    let mut expressions = Vec::with_capacity(1 + COLUMNS.len() * 2);
    expressions.push(col("__dv_row_id"));
    for name in COLUMNS {
        let raw = col(name);
        if STRING_COLUMNS.contains(&name) {
            expressions.push(raw.alias(name));
            continue;
        }
        let typed = if name == "active" {
            when(raw.clone().eq(lit("true")))
                .then(lit(true))
                .when(raw.clone().eq(lit("false")))
                .then(lit(false))
                .otherwise(lit(NULL))
        } else {
            when(raw.clone().eq(lit("")))
                .then(lit(NULL))
                .otherwise(raw.clone())
                .cast(target_dtype(name))
        };
        expressions.push(typed.alias(name));
        expressions.push(raw.alias(format!("__dv_raw_{name}")));
    }

    let mut write_options = ParquetWriteOptions::default();
    write_options.compression = ParquetCompression::Zstd(None);
    write_options.row_group_size = Some(65_536);
    let sink = frame.select(expressions).sink(
        SinkDestination::File {
            target: SinkTarget::Path(PlRefPath::new(output_text.as_ref())),
        },
        FileWriteFormat::Parquet(write_options.into()),
        UnifiedSinkArgs {
            mkdir: true,
            maintain_order: true,
            ..Default::default()
        },
    )?;
    sink.collect()?;
    Ok(())
}

fn target_dtype(name: &str) -> DataType {
    match name {
        "active" => DataType::Boolean,
        "optional_value" => DataType::Int32,
        "amount" => DataType::Float64,
        _ => DataType::Int64,
    }
}
