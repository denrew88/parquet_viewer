use super::DataSource;
use crate::{
    domain::{DataErrorCode, DataFormat, HeaderMode},
    platform::{SessionAccessError, SessionSlot},
};
use arrow_array::{ArrayRef, Int32Array, RecordBatch};
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::ArrowWriter;
use std::{fs, fs::File, path::Path, sync::Arc};

fn write_parquet(path: &Path) {
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![Arc::new(Int32Array::from(vec![1, 2])) as ArrayRef],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
}

#[test]
fn t_p3_032_csv_worker_is_torn_down_when_parquet_replaces_the_session() {
    let directory = tempfile::tempdir().unwrap();
    let csv_path = directory.path().join("active.csv");
    let parquet_path = directory.path().join("replacement.parquet");
    fs::write(
        &csv_path,
        (0..200_000)
            .map(|row| format!("{row},value-{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
    write_parquet(&parquet_path);

    let mut sessions = SessionSlot::default();
    let csv_id = sessions.replace(DataSource::open(&csv_path).unwrap());
    let parquet_id = sessions.replace(DataSource::open(&parquet_path).unwrap());
    assert_ne!(csv_id, parquet_id);
    assert_eq!(
        sessions.with_source(&csv_id, DataSource::summary),
        Err(SessionAccessError::NotFound {
            requested_id: csv_id,
        })
    );
    assert_eq!(
        sessions
            .with_source(&parquet_id, DataSource::summary)
            .unwrap()
            .format,
        DataFormat::Parquet
    );
}

#[test]
fn t_p3_033_failed_csv_open_preserves_session_and_successful_csv_replaces_it() {
    let directory = tempfile::tempdir().unwrap();
    let first_path = directory.path().join("first.csv");
    let invalid_path = directory.path().join("invalid.csv");
    let second_path = directory.path().join("second.csv");
    fs::write(&first_path, "1,A\n2,B\n").unwrap();
    fs::write(&invalid_path, [0xff, 0xfe, b'x', 0]).unwrap();
    fs::write(&second_path, "3,C\n4,D\n").unwrap();

    let mut sessions = SessionSlot::default();
    let first_id = sessions.replace(DataSource::open(&first_path).unwrap());
    assert_eq!(
        DataSource::open(&invalid_path).unwrap_err().code,
        DataErrorCode::UnsupportedEncoding
    );
    assert!(sessions.with_source(&first_id, DataSource::summary).is_ok());

    let second_id = sessions.replace(DataSource::open(&second_path).unwrap());
    assert_eq!(
        sessions.with_source(&first_id, DataSource::summary),
        Err(SessionAccessError::NotFound {
            requested_id: first_id,
        })
    );
    assert_eq!(
        sessions
            .with_source(&second_id, DataSource::summary)
            .unwrap()
            .format,
        DataFormat::Csv
    );
}

#[test]
fn t_p3_035_non_csv_header_configuration_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.parquet");
    write_parquet(&path);
    let mut source = DataSource::open(&path).unwrap();
    assert_eq!(
        source.configure_csv(HeaderMode::Present).unwrap_err().code,
        DataErrorCode::InvalidRequest
    );
}
