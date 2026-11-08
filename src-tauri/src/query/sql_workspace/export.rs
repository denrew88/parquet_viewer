use super::*;
use arrow_schema::Schema;
use std::io::{BufWriter, Write};
use std::path::Path;

static NEXT_EXPORT_STAGE: AtomicU64 = AtomicU64::new(0);

impl QueryService {
    pub fn export_sql_result(
        &self,
        run_id: &str,
        result_id: &str,
        format: SqlExportFormat,
        path: &Path,
    ) -> Result<(), DataError> {
        let result = self.sql_result(run_id, result_id)?;
        export_batches(&result, format, path, |visit| {
            for_each_batch(&result, visit)
        })
    }
}

type BatchVisitor<'a> = dyn FnMut(RecordBatch) -> Result<(), DataError> + 'a;

pub(super) fn export_batches(
    result: &SqlResult,
    format: SqlExportFormat,
    path: &Path,
    batches: impl FnOnce(&mut BatchVisitor<'_>) -> Result<(), DataError>,
) -> Result<(), DataError> {
    let existing = existing_export(path)?;
    if let Some(target) = &existing {
        if result.source_fingerprints.iter().any(|source| {
            source.canonical_path == target.canonical_path
                || source.file_identity == target.file_identity
        }) {
            return Err(invalid(
                "A SQL input file cannot be replaced by its export.",
            ));
        }
        let snapshot =
            fs::canonicalize(result._lease.path()).map_err(|err| io(result._lease.path(), err))?;
        if target.canonical_path.starts_with(snapshot) {
            return Err(invalid("A SQL export cannot replace its result snapshot."));
        }
    }
    write_export(path, existing, |file| match format {
        SqlExportFormat::Csv => export_text(result, file, b',', batches),
        SqlExportFormat::Tsv => export_text(result, file, b'\t', batches),
        SqlExportFormat::Parquet => export_parquet(result, file, batches),
    })
}

fn existing_export(path: &Path) -> Result<Option<SourceFingerprint>, DataError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => source_fingerprint(path).map(Some),
        Ok(_) => Err(invalid("Choose a regular file for the SQL export.")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io(path, err)),
    }
}

fn write_export(
    path: &Path,
    existing: Option<SourceFingerprint>,
    write: impl FnOnce(&mut File) -> Result<(), DataError>,
) -> Result<(), DataError> {
    let staged = existing.as_ref().map(|_| {
        let sequence = NEXT_EXPORT_STAGE.fetch_add(1, Ordering::Relaxed);
        path.with_file_name(format!(
            ".data-viewer-export-{}-{sequence}.tmp",
            std::process::id()
        ))
    });
    let output = staged.as_deref().unwrap_or(path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|err| io(output, err))?;
    let outcome = write(&mut file).and_then(|()| file.sync_all().map_err(|err| io(output, err)));
    drop(file);
    let outcome = outcome.and_then(|()| {
        if let Some(staged) = &staged {
            if existing_export(path)? != existing {
                return Err(invalid(
                    "The export destination changed while saving. Choose it again.",
                ));
            }
            fs::rename(staged, path).map_err(|err| io(path, err))?;
        }
        Ok(())
    });
    if let Err(err) = outcome {
        if let Err(cleanup) = fs::remove_file(output) {
            return Err(error(format!(
                "{} Partial output could not be removed: {}",
                err.message,
                io(output, cleanup).message
            )));
        }
        return Err(err);
    }
    Ok(())
}

pub(super) fn reader_builder(
    result: &SqlResult,
    file_name: &str,
) -> Result<ParquetRecordBatchReaderBuilder<File>, DataError> {
    let path = result._lease.path().join(file_name);
    ParquetRecordBatchReaderBuilder::try_new(File::open(&path).map_err(|err| io(&path, err))?)
        .map_err(|err| error(err.to_string()))
}

fn for_each_batch(
    result: &SqlResult,
    mut visit: impl FnMut(RecordBatch) -> Result<(), DataError>,
) -> Result<(), DataError> {
    // The caller holds a result Arc, which keeps its staging lease pinned even
    // if the workspace releases the result while the user saves it.
    for chunk in &result.chunks {
        let reader = reader_builder(result, &chunk.file)?
            .with_batch_size(256)
            .build()
            .map_err(|err| error(err.to_string()))?;
        for batch in reader {
            visit(batch.map_err(|err| error(err.to_string()))?)?;
        }
    }
    Ok(())
}

fn export_text(
    result: &SqlResult,
    file: &mut File,
    delimiter: u8,
    batches: impl FnOnce(&mut BatchVisitor<'_>) -> Result<(), DataError>,
) -> Result<(), DataError> {
    let mut writer = BufWriter::new(file);
    let output_error = |err: std::io::Error| error(format!("Could not write SQL export: {err}"));
    writer.write_all(b"\xEF\xBB\xBF").map_err(output_error)?;
    for (index, column) in result.columns.iter().enumerate() {
        write_separator(&mut writer, delimiter, index).map_err(output_error)?;
        write_text_field(&mut writer, delimiter, Some(&column.name)).map_err(output_error)?;
    }
    writer.write_all(b"\r\n").map_err(output_error)?;
    batches(&mut |batch| {
        for row in 0..batch.num_rows() {
            for (index, column) in batch.columns().iter().enumerate() {
                write_separator(&mut writer, delimiter, index).map_err(output_error)?;
                let value = crate::data::value_format::full_value_at(column.as_ref(), row)?;
                let text = (value.kind != ValueKind::Null)
                    .then(|| copy_value_text(&value, CopyRepresentation::RawCanonical));
                write_text_field(&mut writer, delimiter, text.as_deref()).map_err(output_error)?;
            }
            writer.write_all(b"\r\n").map_err(output_error)?;
        }
        Ok(())
    })?;
    writer.flush().map_err(output_error)
}

fn write_separator(writer: &mut impl Write, delimiter: u8, index: usize) -> std::io::Result<()> {
    if index != 0 {
        writer.write_all(&[delimiter])?;
    }
    Ok(())
}

fn write_text_field(
    writer: &mut impl Write,
    delimiter: u8,
    value: Option<&str>,
) -> std::io::Result<()> {
    const NULL_MARKER: &str = "\\N";
    let Some(value) = value else {
        return writer.write_all(NULL_MARKER.as_bytes());
    };
    let quote = value.is_empty()
        || value == NULL_MARKER
        || value
            .bytes()
            .any(|byte| matches!(byte, b'"' | b'\r' | b'\n') || byte == delimiter);
    if !quote {
        return writer.write_all(value.as_bytes());
    }
    writer.write_all(b"\"")?;
    for (index, part) in value.split('"').enumerate() {
        if index != 0 {
            writer.write_all(b"\"\"")?;
        }
        writer.write_all(part.as_bytes())?;
    }
    writer.write_all(b"\"")
}

fn export_parquet(
    result: &SqlResult,
    file: &mut File,
    batches: impl FnOnce(&mut BatchVisitor<'_>) -> Result<(), DataError>,
) -> Result<(), DataError> {
    let schema_file = result
        .chunks
        .first()
        .map_or("schema.parquet", |chunk| &chunk.file);
    let builder = reader_builder(result, schema_file)?;
    let stored = builder.schema();
    if stored.fields().len() != result.columns.len() {
        return Err(error(
            "The SQL result schema no longer matches its column labels.",
        ));
    }
    let schema = Arc::new(Schema::new_with_metadata(
        stored
            .fields()
            .iter()
            .zip(&result.columns)
            .map(|(field, column)| field.as_ref().clone().with_name(&column.name))
            .collect::<Vec<_>>(),
        stored.metadata().clone(),
    ));
    let properties = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_max_row_group_row_count(Some(2048))
        .build();
    let mut writer = ArrowWriter::try_new(file, Arc::clone(&schema), Some(properties))
        .map_err(|err| error(err.to_string()))?;
    batches(&mut |batch| {
        let batch = RecordBatch::try_new(Arc::clone(&schema), batch.columns().to_vec())
            .map_err(|err| error(err.to_string()))?;
        writer.write(&batch).map_err(|err| error(err.to_string()))
    })?;
    writer.close().map_err(|err| error(err.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_schema::{DataType, TimeUnit};

    fn complete(service: &Arc<QueryService>, run: &str, sql: &str) -> String {
        service
            .start_sql(
                StartSqlRequest {
                    run_id: run.into(),
                    sql: sql.into(),
                    action: SqlAction::Execute,
                    tables: vec![SqlTableBinding {
                        document_id: "unused-document".into(),
                        session_id: "unused-session".into(),
                        alias: "unused_table".into(),
                        column_mode: SqlColumnMode::Ordinal,
                    }],
                },
                vec![],
                DEFAULT_SQL_TEMP_LIMIT_BYTES,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = service.sql_status(run).unwrap();
            if terminal(status.state) {
                assert_eq!(status.state, SqlState::Complete, "{:?}", status.error);
                return status.result_id.unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn text_uses_original_headers_exact_values_and_selected_separator() {
        let dir = tempfile::tempdir().unwrap();
        let service =
            Arc::new(QueryService::open(dir.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
        let id = complete(
            &service,
            "text",
            r#"SELECT '서울,부산' AS same, 'a"b' AS same, '' AS empty_text, NULL::VARCHAR AS missing, 18446744073709551615::UBIGINT AS exact"#,
        );
        for (format, filename, expected) in [
            (
                SqlExportFormat::Csv,
                "result.csv",
                "\u{feff}same,same,empty_text,missing,exact\r\n\"서울,부산\",\"a\"\"b\",\"\",\\N,18446744073709551615\r\n",
            ),
            (
                SqlExportFormat::Tsv,
                "result.tsv",
                "\u{feff}same\tsame\tempty_text\tmissing\texact\r\n서울,부산\t\"a\"\"b\"\t\"\"\t\\N\t18446744073709551615\r\n",
            ),
        ] {
            let path = dir.path().join(filename);
            service.export_sql_result("text", &id, format, &path).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
            fs::write(&path, b"previous export").unwrap();
            service.export_sql_result("text", &id, format, &path).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        }
    }

    #[test]
    fn parquet_keeps_exact_timestamp_type_even_without_rows() {
        let dir = tempfile::tempdir().unwrap();
        let service =
            Arc::new(QueryService::open(dir.path(), DEFAULT_SQL_TEMP_LIMIT_BYTES).unwrap());
        for (run, suffix, rows) in [("one", "", 1), ("empty", " WHERE false", 0)] {
            let id = complete(
                &service,
                run,
                &format!(
                    "SELECT CAST('2024-07-26T12:20:29.123456789' AS TIMESTAMP_NS) AS ordered_at{suffix}"
                ),
            );
            let path = dir.path().join(format!("{run}.parquet"));
            service
                .export_sql_result(run, &id, SqlExportFormat::Parquet, &path)
                .unwrap();
            let builder =
                ParquetRecordBatchReaderBuilder::try_new(File::open(path).unwrap()).unwrap();
            assert_eq!(builder.schema().field(0).name(), "ordered_at");
            assert_eq!(
                builder.schema().field(0).data_type(),
                &DataType::Timestamp(TimeUnit::Nanosecond, None)
            );
            assert_eq!(builder.metadata().file_metadata().num_rows(), rows);
            if rows == 1 {
                let batch = builder.build().unwrap().next().unwrap().unwrap();
                let time = batch
                    .column(0)
                    .as_any()
                    .downcast_ref::<arrow_array::TimestampNanosecondArray>()
                    .unwrap();
                assert_eq!(time.value(0) % 1_000_000_000, 123_456_789);
            }
        }
    }

    #[test]
    fn failed_write_removes_partial_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("failed.csv");
        assert!(write_export(&path, None, |file| {
            file.write_all(b"partial").unwrap();
            Err(error("injected export failure"))
        })
        .is_err());
        assert!(!path.exists());
    }

    #[test]
    fn failed_replacement_preserves_existing_export_and_removes_staging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.csv");
        fs::write(&path, b"previous export").unwrap();
        assert!(
            write_export(&path, existing_export(&path).unwrap(), |file| {
                file.write_all(b"partial").unwrap();
                Err(error("injected export failure"))
            })
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"previous export");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
