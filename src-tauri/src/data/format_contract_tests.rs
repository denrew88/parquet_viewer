use std::{fs::File, path::Path, sync::Arc};

use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::ArrowWriter;

use super::{builtin_format_registry, DataSource, FormatHandler, FormatRegistry, TabularSource};
use crate::{
    domain::{
        ColumnSchema, DataError, DataErrorCode, DataFormat, DataPage, DataValue, FileSummary,
        FormatDescriptor, FormatDetailsContent, FormatDetailsSection, MetadataEntry, RowCountState,
        RowCountStatus, SourceCapability, ValueKind,
    },
    platform::{DocumentRegistry, PageCacheKey, ReservePath},
};

const STUB_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    id: DataFormat::new("dvtest"),
    display_name: "Registry Stub",
    extensions: &["dvtest"],
    mime_types: &["application/x-data-viewer-test"],
    capabilities: &[SourceCapability::ColumnProjection],
};

#[derive(Debug)]
struct StubHandler;

static STUB_HANDLER: StubHandler = StubHandler;

impl FormatHandler for StubHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &STUB_DESCRIPTOR
    }

    fn open(&self, _path: &Path) -> Result<Box<dyn TabularSource>, DataError> {
        Ok(Box::new(StubSource))
    }
}

#[derive(Debug)]
struct StubSource;

impl TabularSource for StubSource {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &STUB_DESCRIPTOR
    }

    fn summary(&self) -> FileSummary {
        FileSummary {
            file_name: String::from("fixture.dvtest"),
            path: String::from("fixture.dvtest"),
            format: STUB_DESCRIPTOR.id,
            format_descriptor: STUB_DESCRIPTOR,
            file_size: 1,
            row_count: Some(2),
            row_count_status: RowCountStatus {
                state: RowCountState::Complete,
                rows_scanned: 2,
                bytes_scanned: 1,
                total_bytes: 1,
                generation: 1,
                message: None,
            },
            column_count: 1,
            row_group_count: 0,
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("Utf8"),
                nullable: false,
                physical_type: String::from("UTF8"),
            }],
            row_groups: Vec::new(),
            csv_metadata: None,
            format_details: vec![FormatDetailsSection {
                id: String::from("stub"),
                title: String::from("Stub details"),
                content: FormatDetailsContent::KeyValue {
                    entries: vec![MetadataEntry {
                        label: String::from("Provider"),
                        value: String::from("in-memory"),
                    }],
                },
            }],
        }
    }

    fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        if !(1..=200).contains(&limit) {
            return Err(DataError::invalid_request("Invalid page limit."));
        }
        if let Some(columns) = columns {
            if columns != [String::from("value")] {
                return Err(DataError::invalid_request("Unknown projection column."));
            }
        }
        let values = ["first", "second"];
        let rows = values
            .iter()
            .skip(offset as usize)
            .take(limit)
            .map(|value| vec![DataValue::displayed(ValueKind::String, *value)])
            .collect::<Vec<_>>();
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(2),
            has_more: offset.saturating_add(rows.len() as u64) < 2,
            columns: vec![String::from("value")],
            rows,
        })
    }
}

fn write_parquet(path: &Path) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from(vec![1, 2])) as ArrayRef,
            Arc::new(StringArray::from(vec!["alpha", "beta"])),
        ],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
}

fn write_empty_parquet(path: &Path) {
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false)]));
    ArrowWriter::try_new(File::create(path).unwrap(), schema, None)
        .unwrap()
        .close()
        .unwrap();
}

fn assert_common_source_contract(source: &DataSource) {
    let summary = source.summary();
    assert_eq!(summary.format, summary.format_descriptor.id);
    assert_eq!(summary.column_count, summary.columns.len());
    assert!(!summary.columns.is_empty());

    let first = source.read_page_projected(0, 1, None).unwrap();
    assert_eq!(first.offset, 0);
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.columns.len(), summary.column_count);

    let last = source.read_page_projected(1, 1, None).unwrap();
    assert_eq!(last.rows.len(), 1);
    let beyond = source.read_page_projected(2, 1, None).unwrap();
    assert!(beyond.rows.is_empty());

    let projected_name = summary.columns[0].name.clone();
    let projected = source
        .read_page_projected(0, 2, Some(std::slice::from_ref(&projected_name)))
        .unwrap();
    assert_eq!(projected.columns, [projected_name]);
    assert!(projected.rows.iter().all(|row| row.len() == 1));
    assert_eq!(
        source
            .read_page_projected(0, 1, Some(&[String::from("missing")]))
            .unwrap_err()
            .code,
        DataErrorCode::InvalidRequest
    );
}

#[test]
fn fmt_001_builtin_descriptors_are_unique_and_serializable() {
    let descriptors = builtin_format_registry().descriptors();
    assert_eq!(descriptors.len(), 3);
    assert_eq!(descriptors[0].id, DataFormat::Csv);
    assert_eq!(descriptors[1].id, DataFormat::Parquet);
    assert_eq!(descriptors[2].id, DataFormat::OesHdf5);
    assert!(descriptors
        .iter()
        .all(|descriptor| !descriptor.capabilities.is_empty()));

    let json = serde_json::to_value(descriptors).unwrap();
    assert_eq!(json[0]["id"], "csv");
    assert_eq!(json[0]["displayName"], "CSV");
    assert_eq!(json[0]["capabilities"][0], "columnProjection");

    let duplicate = FormatRegistry::new(vec![&STUB_HANDLER, &STUB_HANDLER]).unwrap_err();
    assert_eq!(duplicate.code, DataErrorCode::InvalidRequest);
}

#[test]
fn fmt_002_registry_resolves_case_insensitive_extensions_and_unicode_paths() {
    let registry = builtin_format_registry();
    assert_eq!(
        registry
            .resolve(Path::new("C:/자료 폴더/INPUT.CSV"))
            .unwrap()
            .descriptor()
            .id,
        DataFormat::Csv
    );
    assert_eq!(
        registry
            .resolve(Path::new("C:/자료 폴더/INPUT.PaRqUeT"))
            .unwrap()
            .descriptor()
            .id,
        DataFormat::Parquet
    );
    assert_eq!(
        registry
            .resolve(Path::new("C:/자료 폴더/INPUT.OES.H5"))
            .unwrap()
            .descriptor()
            .id,
        DataFormat::OesHdf5
    );
    assert_eq!(
        registry
            .resolve(Path::new("C:/자료 폴더/INPUT.HdF5"))
            .unwrap()
            .descriptor()
            .id,
        DataFormat::OesHdf5
    );
    assert!(registry.resolve(Path::new("unknown.txt")).is_none());
}

#[test]
fn fmt_003_004_csv_and_parquet_share_page_and_projection_contracts() {
    let directory = tempfile::tempdir().unwrap();
    let csv = directory.path().join("contract.csv");
    let parquet = directory.path().join("contract.parquet");
    std::fs::write(&csv, "id,name\n1,alpha\n2,beta\n").unwrap();
    write_parquet(&parquet);

    assert_common_source_contract(&DataSource::open(csv).unwrap());
    assert_common_source_contract(&DataSource::open(parquet).unwrap());
}

#[test]
fn fmt_004_empty_files_and_invalid_page_limits_are_typed() {
    let directory = tempfile::tempdir().unwrap();
    let csv = directory.path().join("empty.csv");
    let parquet = directory.path().join("empty.parquet");
    std::fs::write(&csv, "").unwrap();
    write_empty_parquet(&parquet);

    for source in [
        DataSource::open(csv).unwrap(),
        DataSource::open(parquet).unwrap(),
    ] {
        let page = source.read_page_projected(0, 1, None).unwrap();
        assert!(page.rows.is_empty());
        assert_eq!(
            source.read_page_projected(0, 0, None).unwrap_err().code,
            DataErrorCode::InvalidRequest
        );
    }
}

#[test]
fn fmt_005_display_values_preserve_precision_and_nested_text_byte_for_byte() {
    let values = vec![
        DataValue::displayed(ValueKind::Int, i64::MIN.to_string()),
        DataValue::displayed(ValueKind::Int, u64::MAX.to_string()),
        DataValue::displayed(ValueKind::Decimal, "12345678901234567890.123400"),
        DataValue::displayed(ValueKind::Timestamp, "2026-07-15T12:34:56.123456789Z"),
        DataValue::null(),
        DataValue::displayed(ValueKind::List, "[1, null, 3]"),
    ];
    let json = serde_json::to_value(values).unwrap();

    assert_eq!(json[0]["display"], i64::MIN.to_string());
    assert_eq!(json[1]["display"], u64::MAX.to_string());
    assert_eq!(json[2]["display"], "12345678901234567890.123400");
    assert_eq!(json[3]["display"], "2026-07-15T12:34:56.123456789Z");
    assert!(json[4]["display"].is_null());
    assert_eq!(json[5]["display"], "[1, null, 3]");
}

#[test]
fn fmt_008_test_handler_uses_registry_and_document_registry_without_core_branches() {
    let formats = FormatRegistry::new(vec![&STUB_HANDLER]).unwrap();
    let source = formats.open(Path::new("virtual.dvtest")).unwrap();
    let summary = source.summary();
    let first_page = source.read_page_projected(0, 1, None).unwrap();
    assert_eq!(summary.format.as_str(), "dvtest");
    assert_eq!(summary.format_details[0].id, "stub");

    let documents = DocumentRegistry::default();
    let reservation = match documents
        .reserve_path(String::from("virtual.dvtest"))
        .unwrap()
    {
        ReservePath::Reserved(reservation) => reservation,
        ReservePath::Existing(_) => panic!("test path must be new"),
    };
    let (document_id, session_id) = documents
        .commit(
            reservation,
            source,
            PageCacheKey::new(0, 1, None),
            first_page,
        )
        .unwrap();
    let page = documents
        .get_or_load_page(
            &document_id,
            &session_id,
            PageCacheKey::new(1, 1, None),
            |source| source.read_page_projected(1, 1, None),
        )
        .unwrap()
        .unwrap();
    assert_eq!(page.rows[0][0].display.as_deref(), Some("second"));
}
