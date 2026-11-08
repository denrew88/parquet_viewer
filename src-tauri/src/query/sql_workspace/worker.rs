use super::*;
use arrow_schema::{DataType, Field, Schema};
use std::sync::atomic::AtomicBool;

pub fn try_run_sql_worker_from_args() -> Option<i32> {
    let mut args = std::env::args_os();
    args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--data-viewer-sql-worker")) {
        return None;
    }
    let Some(path) = args.next() else {
        return Some(2);
    };
    let path = PathBuf::from(path);
    if args.next().is_some() {
        return Some(2);
    }
    let job = match read_json::<WorkerJob>(&path) {
        Ok(job) => job,
        Err(_) => return Some(2),
    };
    if path.file_name() != Some(std::ffi::OsStr::new("job.json"))
        || path.parent() != Some(job.directory.as_path())
    {
        return Some(2);
    }
    run_and_write(job);
    Some(0)
}
pub(super) fn run_and_write(job: WorkerJob) {
    let directory = job.directory.clone();
    let output = match execute(&job) {
        Ok(output) => output,
        Err(e) => WorkerOutput {
            columns: vec![],
            chunks: vec![],
            rows: 0,
            plan_text: None,
            plan_json: None,
            warnings: vec![],
            error: Some(e),
        },
    };
    let _ = write_json(&directory.join("output.json"), &output);
}
#[cfg(windows)]
fn parent_alive(pid: u32) -> bool {
    unsafe {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, millis: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = OpenProcess(0x00100000, 0, pid);
        if handle.is_null() {
            return false;
        }
        let alive = WaitForSingleObject(handle, 0) == 258;
        CloseHandle(handle);
        alive
    }
}
#[cfg(not(windows))]
fn parent_alive(_pid: u32) -> bool {
    true
}
struct Watcher {
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    violation: Arc<Mutex<Option<DataError>>>,
}
impl Watcher {
    fn start(job: &WorkerJob, interrupt: Arc<InterruptHandle>, raw_connection: usize) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let violation = Arc::new(Mutex::new(None));
        let s = Arc::clone(&stop);
        let v = Arc::clone(&violation);
        let dir = job.directory.clone();
        let allowance = job.allowance;
        let parent = job.parent_pid;
        let worker = std::thread::spawn(move || {
            let started = Instant::now();
            while !s.load(Ordering::Acquire) {
                let e = if !parent_alive(parent) || dir.join("cancel").exists() {
                    Some(DataError::task_cancelled())
                } else if started.elapsed() > MAX_JOB_TIME {
                    Some(error("SQL exceeded its execution deadline."))
                } else if directory_bytes(&dir).is_ok_and(|bytes| bytes > allowance) {
                    Some(DataError::query_temp_limit(
                        "SQL temporary data and result exceeded their allowance.",
                    ))
                } else if fs2::available_space(&dir)
                    .is_ok_and(|free| free <= crate::storage::QUERY_TEMP_SAFETY_RESERVE_BYTES)
                {
                    Some(DataError::query_temp_limit(
                        "SQL working drive reached its safety reserve.",
                    ))
                } else {
                    None
                };
                if let Some(e) = e {
                    if let Ok(mut value) = v.lock() {
                        *value = Some(e);
                    }
                    interrupt.interrupt();
                    unsafe {
                        duckdb::ffi::duckdb_interrupt(
                            raw_connection as duckdb::ffi::duckdb_connection,
                        );
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        Self {
            stop,
            worker: Some(worker),
            violation,
        }
    }
    fn check(&self) -> Result<(), DataError> {
        if let Some(e) = self.violation.lock().map_err(|_| registry_error())?.clone() {
            Err(e)
        } else {
            Ok(())
        }
    }
}
impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn execute(job: &WorkerJob) -> Result<WorkerOutput, DataError> {
    if job.allowance == 0
        || job.allowance > MAX_SQL_TEMP_LIMIT_BYTES
        || job.tables.len() > SQL_MAX_SOURCES
        || job.sql.len() > SQL_MAX_TEXT_BYTES
    {
        return Err(invalid("Invalid SQL worker bounds."));
    }
    let db = security::Database::open()?;
    let connection = db.conn()?;
    let interrupt = connection.interrupt_handle();
    let watchdog = Watcher::start(job, interrupt, db.raw as usize);
    let allowed = job
        .tables
        .iter()
        .map(|t| quote_literal(&t.path.to_string_lossy().replace('\\', "/")))
        .collect::<Vec<_>>()
        .join(",");
    let spill = job.directory.join("spill");
    fs::create_dir(&spill).map_err(|e| io(&spill, e))?;
    connection.execute_batch(&format!("SET allowed_paths=[{allowed}]; SET temp_directory={}; SET max_temp_directory_size='{}B'; SET preserve_insertion_order=true; SET default_null_order='NULLS_LAST';",quote_literal(&spill.to_string_lossy().replace('\\',"/")),job.allowance)).map_err(duckdb_error)?;
    let mut warnings = Vec::new();
    for table in &job.tables {
        watchdog.check()?;
        if !table.csv {
            let builder = ParquetRecordBatchReaderBuilder::try_new(
                File::open(&table.path).map_err(|e| io(&table.path, e))?,
            )
            .map_err(|e| error(e.to_string()))?;
            for field in builder.schema().fields() {
                if matches!(field.data_type(), DataType::Decimal256(precision, _) if *precision > 38)
                {
                    return Err(invalid(format!(
                        "Parquet decimal {} exceeds the SQL engine's 38 digit precision limit.",
                        field.name()
                    )));
                }
                if matches!(
                    field.data_type(),
                    DataType::Timestamp(arrow_schema::TimeUnit::Nanosecond, Some(_))
                ) {
                    return Err(invalid(format!("Parquet column {} has nanosecond timestamps with a timezone, which this SQL engine cannot represent exactly.",field.name())));
                }
            }
        }
        let parquet = quote_literal(&table.path.to_string_lossy().replace('\\', "/"));
        let relation = if table.csv {
            format!("read_parquet({parquet}) AS p")
        } else {
            let columns = (0..table.physical_columns)
                .map(|i| quote_identifier(&format!("__sql_pos_{i}")))
                .collect::<Vec<_>>()
                .join(",");
            format!("read_parquet({parquet}) AS p({columns})")
        };
        let mut expressions = Vec::new();
        for column in &table.columns {
            if let Some(warning) = &column.warning {
                warnings.push(warning.clone());
            }
            let name = if table.mode == SqlColumnMode::Name {
                column.original_name.clone()
            } else {
                format!("c{}", column.source_index + 1)
            };
            let value = if table.csv {
                csv_expression(connection, column, &relation)?
            } else {
                column.expression.clone()
            };
            expressions.push(format!("{value} AS {}", quote_identifier(&name)));
        }
        if expressions.is_empty() {
            return Err(invalid("SQL table has no exposed columns."));
        }
        connection
            .execute_batch(&format!(
                "CREATE VIEW {} AS SELECT {} FROM {relation}",
                quote_identifier(&table.alias),
                expressions.join(",")
            ))
            .map_err(duckdb_error)?;
        if table.csv {
            warnings.push(format!("{}: CSV values marked invalid are SQL NULL; inspect the source parsing profile for original values and conversion diagnostics.",table.alias));
        }
    }
    // No user statement has been prepared/executed before this boundary. The
    // configuration can no longer be changed; source access is exact-file only.
    connection
        .execute_batch("SET enable_external_access=false; SET lock_configuration=true;")
        .map_err(duckdb_error)?;
    db.validate(
        &job.sql,
        &job.tables
            .iter()
            .map(|t| t.alias.clone())
            .collect::<Vec<_>>(),
    )?;
    watchdog.check()?;
    let sql = security::query_body(&job.sql)?;
    if job.action != SqlAction::Execute {
        let explain = if job.action == SqlAction::Analyze {
            "EXPLAIN (ANALYZE, FORMAT JSON)"
        } else {
            "EXPLAIN (FORMAT JSON)"
        };
        let text = connection
            .query_row(&format!("{explain} {sql}"), [], |row| {
                row.get::<_, String>(1)
            })
            .map_err(duckdb_error)?;
        watchdog.check()?;
        let json = serde_json::from_str(&text).ok();
        if text.len() > PAGE_BYTES {
            return Err(invalid(
                "SQL execution plan exceeds its response allowance.",
            ));
        }
        return Ok(WorkerOutput {
            columns: vec![],
            chunks: vec![],
            rows: 0,
            plan_text: Some(text),
            plan_json: json,
            warnings,
            error: None,
        });
    }
    let mut description = connection
        .prepare(&format!("DESCRIBE {sql}"))
        .map_err(duckdb_error)?;
    let columns = description
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(duckdb_error)?
        .enumerate()
        .map(|(index, row)| {
            let (name, logical_type, nullable) = row.map_err(duckdb_error)?;
            Ok(SqlResultColumn {
                id: format!("r{index}"),
                name,
                logical_type,
                nullable: nullable != "NO",
            })
        })
        .collect::<Result<Vec<_>, DataError>>()?;
    if columns.is_empty() || columns.len() > SQL_MAX_COLUMNS {
        return Err(invalid("SQL result must have 1..4096 columns."));
    }
    if columns
        .iter()
        .any(|c| c.name.chars().count() > 4096 || c.name.len() > 16384 || c.name.contains('\0'))
        || serde_json::to_vec(&columns)
            .map_err(|e| error(e.to_string()))?
            .len()
            > 2 * 1024 * 1024
    {
        return Err(invalid(
            "SQL result column metadata exceeds its name or 2MiB schema allowance.",
        ));
    }
    // LIMIT0 is metadata-only and does not materialize the user's query result.
    // Preserve DESCRIBE labels separately: subquery schemas may deduplicate names.
    let schema = connection
        .prepare(&format!("SELECT * FROM ({sql}\n) AS metadata_only LIMIT 0"))
        .map_err(duckdb_error)?
        .query_arrow([])
        .map_err(duckdb_error)?
        .get_schema();
    for field in schema.fields() {
        validate_result_type(field.data_type())?;
    }
    let stored_schema = Arc::new(Schema::new(
        schema
            .fields()
            .iter()
            .enumerate()
            .map(|(i, f)| Field::new(format!("r{i}"), f.data_type().clone(), f.is_nullable()))
            .collect::<Vec<_>>(),
    ));
    let mut stream = db.stream(&sql, schema)?;
    let mut rows = 0u64;
    let mut chunks = Vec::new();
    let mut pending: Option<PendingChunk> = None;
    let properties = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_max_row_group_row_count(Some(2048))
        .build();
    while let Some(batch) = stream.next_batch()? {
        watchdog.check()?;
        let bytes = batch.get_array_memory_size();
        if bytes > MAX_BATCH_BYTES {
            return Err(invalid("A SQL result batch exceeds the 16MiB decoded limit; reduce selected columns or value sizes."));
        }
        if rows.saturating_add(batch.num_rows() as u64) > SQL_MAX_ROWS {
            return Err(invalid(
                "SQL result exceeds 1000000 rows; add a condition or LIMIT.",
            ));
        }
        if let Some(chunk) = pending.take() {
            if chunk.rows + batch.num_rows() > RESULT_CHUNK_ROWS
                || chunk.decoded_bytes + bytes > MAX_BATCH_BYTES
            {
                finish_chunk(chunk, job, &mut chunks)?;
            } else {
                pending = Some(chunk);
            }
        }
        let chunk = match &mut pending {
            Some(chunk) => chunk,
            None => {
                let file = format!("chunk-{:06}.parquet", chunks.len());
                let path = job.directory.join(&file);
                let writer = ArrowWriter::try_new(
                    File::create(&path).map_err(|e| io(&path, e))?,
                    Arc::clone(&stored_schema),
                    Some(properties.clone()),
                )
                .map_err(|e| error(e.to_string()))?;
                pending.insert(PendingChunk {
                    writer,
                    file,
                    offset: rows,
                    rows: 0,
                    decoded_bytes: 0,
                })
            }
        };
        let batch = RecordBatch::try_new(Arc::clone(&stored_schema), batch.columns().to_vec())
            .map_err(|e| error(e.to_string()))?;
        chunk
            .writer
            .write(&batch)
            .map_err(|e| error(e.to_string()))?;
        chunk.rows += batch.num_rows();
        chunk.decoded_bytes += bytes;
        rows += batch.num_rows() as u64;
    }
    if let Some(chunk) = pending {
        finish_chunk(chunk, job, &mut chunks)?;
    }
    watchdog.check()?;
    if job.directory.join("cancel").exists() {
        return Err(DataError::task_cancelled());
    }
    if chunks.is_empty() {
        // An empty result has no data chunks from which to recover its Arrow
        // schema. Keep the same typed schema available for Parquet export.
        let path = job.directory.join("schema.parquet");
        ArrowWriter::try_new(
            File::create(&path).map_err(|e| io(&path, e))?,
            stored_schema,
            None,
        )
        .and_then(ArrowWriter::close)
        .map_err(|e| error(e.to_string()))?;
        if directory_bytes(&job.directory)? > job.allowance {
            return Err(DataError::query_temp_limit(
                "SQL output and spill exceeded their shared allowance.",
            ));
        }
        watchdog.check()?;
    }
    Ok(WorkerOutput {
        columns,
        chunks,
        rows,
        plan_text: None,
        plan_json: None,
        warnings,
        error: None,
    })
}

// Keep files large enough to amortize metadata checks while limiting each
// file's decoded size and retaining small Parquet row groups for point reads.
const RESULT_CHUNK_ROWS: usize = 32_768;

struct PendingChunk {
    writer: ArrowWriter<File>,
    file: String,
    offset: u64,
    rows: usize,
    decoded_bytes: usize,
}

fn finish_chunk(
    chunk: PendingChunk,
    job: &WorkerJob,
    chunks: &mut Vec<ResultChunk>,
) -> Result<(), DataError> {
    chunk.writer.close().map_err(|e| error(e.to_string()))?;
    if directory_bytes(&job.directory)? > job.allowance {
        return Err(DataError::query_temp_limit(
            "SQL output and spill exceeded their shared allowance.",
        ));
    }
    let rows = chunk.rows as u64;
    write_json(&job.directory.join("progress.json"), &(chunk.offset + rows))?;
    chunks.push(ResultChunk {
        file: chunk.file,
        offset: chunk.offset,
        rows,
    });
    Ok(())
}

#[cfg(test)]
pub(super) fn execute_for_test(job: &WorkerJob) -> Result<WorkerOutput, DataError> {
    execute(job)
}

fn csv_expression(
    connection: &Connection,
    column: &SqlInputColumn,
    relation: &str,
) -> Result<String, DataError> {
    let value = &column.expression;
    let sql_type = match column.sql_type.as_str() {
        "DECIMAL" => {
            let query=format!("SELECT max(length(ltrim(split_part(ltrim(CAST(v AS VARCHAR), '+-'), '.', 1), '0'))), max(length(split_part(CAST(v AS VARCHAR), '.', 2))) FROM (SELECT {value} AS v FROM {relation}) WHERE v IS NOT NULL");
            let (digits, scale): (Option<u64>, Option<u64>) = connection
                .query_row(&query, [], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(duckdb_error)?;
            let digits = digits.unwrap_or(0);
            let scale = scale.unwrap_or(0);
            if digits + scale > 38 {
                return Err(invalid(format!("CSV decimal {} needs more than 38 exact digits; SQL conversion is unsupported.",column.original_name)));
            }
            format!("DECIMAL(38,{scale})")
        }
        "TIMESTAMP_NS" => {
            let query=format!("SELECT count(*) FROM (SELECT CAST({value} AS VARCHAR) AS v FROM {relation}) WHERE v IS NOT NULL AND regexp_matches(v, '(Z|[+-][0-9]{{2}}:[0-9]{{2}})$')");
            let zoned: u64 = connection
                .query_row(&query, [], |r| r.get(0))
                .map_err(duckdb_error)?;
            if zoned > 0 {
                return Err(invalid(format!("CSV timestamp {} includes a timezone. SQL nanosecond+timezone conversion is not supported; select a profile with an exact supported representation.",column.original_name)));
            }
            "TIMESTAMP_NS".to_owned()
        }
        other => other.to_owned(),
    };
    Ok(format!("CAST(({value}) AS {sql_type})"))
}
fn validate_result_type(ty: &DataType) -> Result<(), DataError> {
    match ty {
        DataType::Boolean
        | DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64
        | DataType::Float32
        | DataType::Float64
        | DataType::Utf8
        | DataType::LargeUtf8
        | DataType::Utf8View
        | DataType::Binary
        | DataType::LargeBinary
        | DataType::FixedSizeBinary(_)
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _)
        | DataType::Date32
        | DataType::Date64
        | DataType::Timestamp(_, _)
        | DataType::Null => Ok(()),
        other => Err(invalid(format!(
            "SQL result type {other} is not supported without losing its logical representation."
        ))),
    }
}
