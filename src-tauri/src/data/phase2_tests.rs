use super::ParquetSource;
use crate::domain::{DataErrorCode, ValueKind};
use arrow_array::builder::{Int64Builder, ListBuilder, MapBuilder, StringBuilder, StructBuilder};
use arrow_array::{
    ArrayRef, BinaryArray, Date32Array, Decimal128Array, Float64Array, Int32Array, Int64Array,
    RecordBatch, StringArray, TimestampNanosecondArray, UInt64Array,
};
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::{arrow_reader::ParquetRecordBatchReaderBuilder, ArrowWriter};
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

fn write_batches(
    path: &Path,
    schema: Arc<Schema>,
    batches: Vec<RecordBatch>,
    properties: Option<WriterProperties>,
) {
    let mut writer = ArrowWriter::try_new(
        File::create(path).expect("fixture file"),
        schema,
        properties,
    )
    .expect("fixture writer");
    for batch in batches {
        writer.write(&batch).expect("fixture batch");
        writer.flush().expect("fixture row group");
    }
    writer.close().expect("fixture close");
}

fn boundary_fixture() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("row-groups.parquet");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("label", DataType::Utf8, false),
        Field::new("score", DataType::Float64, false),
    ]));
    let mut start = 0_i32;
    let batches = [3_i32, 4, 2, 5]
        .into_iter()
        .map(|length| {
            let end = start + length;
            let ids = (start..end).collect::<Vec<_>>();
            let labels = ids.iter().map(|id| format!("row-{id}")).collect::<Vec<_>>();
            let scores = ids
                .iter()
                .map(|id| f64::from(*id) + 0.25)
                .collect::<Vec<_>>();
            start = end;
            RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(Int32Array::from(ids)) as ArrayRef,
                    Arc::new(StringArray::from(labels)),
                    Arc::new(Float64Array::from(scores)),
                ],
            )
            .expect("boundary batch")
        })
        .collect::<Vec<_>>();
    write_batches(&path, schema, batches, None);
    (directory, path)
}

fn wide_fixture() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("wide.parquet");
    let fields = (0..65)
        .map(|index| Field::new(format!("c{index:02}"), DataType::Int32, false))
        .collect::<Vec<_>>();
    let schema = Arc::new(Schema::new(fields));
    let arrays = (0..65)
        .map(|index| Arc::new(Int32Array::from(vec![index, index + 100])) as ArrayRef)
        .collect::<Vec<_>>();
    let batch = RecordBatch::try_new(schema.clone(), arrays).expect("wide batch");
    write_batches(&path, schema, vec![batch], None);
    (directory, path)
}

fn page_cap_fixture() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("page-cap.parquet");
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
    let batches = [0_i32, 80, 160]
        .into_iter()
        .map(|start| {
            RecordBatch::try_new(
                schema.clone(),
                vec![Arc::new(Int32Array::from_iter_values(start..start + 80)) as ArrayRef],
            )
            .expect("page cap batch")
        })
        .collect::<Vec<_>>();
    write_batches(&path, schema, batches, None);
    (directory, path)
}

pub(crate) fn type_fixture() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("types.parquet");

    let int64 = Arc::new(Int64Array::from(vec![
        Some(i64::MIN),
        Some(9_007_199_254_740_993),
        Some(i64::MAX),
    ])) as ArrayRef;
    let uint64 = Arc::new(UInt64Array::from(vec![
        Some(0),
        Some(9_007_199_254_740_993),
        Some(u64::MAX),
    ])) as ArrayRef;
    let decimal = Arc::new(
        Decimal128Array::from(vec![
            Some(-12_345_678_901_234_567_890_123_456_789_i128),
            Some(1_230_000_000),
            None,
        ])
        .with_precision_and_scale(38, 9)
        .expect("decimal metadata"),
    ) as ArrayRef;
    let date = Arc::new(Date32Array::from(vec![Some(-1), Some(11_016), None])) as ArrayRef;
    let timestamp = Arc::new(
        TimestampNanosecondArray::from(vec![Some(1_700_000_000_123_456_789), None, Some(-1)])
            .with_timezone("Asia/Seoul"),
    ) as ArrayRef;
    let binary_values: Vec<Option<&[u8]>> = vec![Some(&[0, 255, 9, 10, 65]), None, Some(&[])];
    let binary = Arc::new(BinaryArray::from(binary_values)) as ArrayRef;

    let mut list_builder = ListBuilder::new(Int64Builder::new());
    list_builder.values().append_value(1);
    list_builder.values().append_null();
    list_builder.values().append_value(9_007_199_254_740_993);
    list_builder.append(true);
    list_builder.append(false);
    list_builder.values().append_value(i64::MIN);
    list_builder.append(true);
    let list = Arc::new(list_builder.finish()) as ArrayRef;

    let details_fields = vec![
        Field::new("code", DataType::Int64, true),
        Field::new("note", DataType::Utf8, true),
    ];
    let struct_fields = vec![
        Field::new("name", DataType::Utf8, true),
        Field::new(
            "details",
            DataType::Struct(details_fields.clone().into()),
            true,
        ),
    ];
    let mut struct_builder = StructBuilder::from_fields(struct_fields, 3);

    struct_builder
        .field_builder::<StringBuilder>(0)
        .expect("name builder")
        .append_value("alpha");
    {
        let details = struct_builder
            .field_builder::<StructBuilder>(1)
            .expect("details builder");
        details
            .field_builder::<Int64Builder>(0)
            .expect("code builder")
            .append_value(9_007_199_254_740_993);
        details
            .field_builder::<StringBuilder>(1)
            .expect("note builder")
            .append_null();
        details.append(true);
    }
    struct_builder.append(true);

    struct_builder
        .field_builder::<StringBuilder>(0)
        .expect("name builder")
        .append_null();
    {
        let details = struct_builder
            .field_builder::<StructBuilder>(1)
            .expect("details builder");
        details
            .field_builder::<Int64Builder>(0)
            .expect("code builder")
            .append_null();
        details
            .field_builder::<StringBuilder>(1)
            .expect("note builder")
            .append_null();
        details.append(false);
    }
    struct_builder.append(false);

    struct_builder
        .field_builder::<StringBuilder>(0)
        .expect("name builder")
        .append_value("omega");
    {
        let details = struct_builder
            .field_builder::<StructBuilder>(1)
            .expect("details builder");
        details
            .field_builder::<Int64Builder>(0)
            .expect("code builder")
            .append_null();
        details
            .field_builder::<StringBuilder>(1)
            .expect("note builder")
            .append_null();
        details.append(false);
    }
    struct_builder.append(true);
    let struct_value = Arc::new(struct_builder.finish()) as ArrayRef;

    let mut map_builder = MapBuilder::new(None, StringBuilder::new(), Int64Builder::new());
    map_builder.keys().append_value("left");
    map_builder.values().append_value(9_007_199_254_740_993);
    map_builder.keys().append_value("right");
    map_builder.values().append_null();
    map_builder.append(true).expect("valid map");
    map_builder.append(false).expect("null map");
    map_builder.append(true).expect("empty map");
    let map = Arc::new(map_builder.finish()) as ArrayRef;

    let arrays = vec![
        int64,
        uint64,
        decimal,
        date,
        timestamp,
        binary,
        list,
        struct_value,
        map,
    ];
    let names = [
        "signed",
        "unsigned",
        "decimal",
        "date",
        "timestamp",
        "binary",
        "list",
        "struct",
        "map",
    ];
    let fields = names
        .into_iter()
        .zip(arrays.iter())
        .map(|(name, array)| Field::new(name, array.data_type().clone(), true))
        .collect::<Vec<_>>();
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new(schema.clone(), arrays).expect("type batch");
    write_batches(&path, schema, vec![batch], None);
    (directory, path)
}

fn metadata_fixture() -> (TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("metadata.parquet");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("label", DataType::Utf8, true),
    ]));
    let mut start = 0_i32;
    let batches = [2_i32, 3, 1]
        .into_iter()
        .map(|length| {
            let end = start + length;
            let ids = (start..end).collect::<Vec<_>>();
            let labels = ids
                .iter()
                .map(|id| format!("value-{id}"))
                .collect::<Vec<_>>();
            start = end;
            RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(Int32Array::from(ids)) as ArrayRef,
                    Arc::new(StringArray::from(labels)),
                ],
            )
            .expect("metadata batch")
        })
        .collect::<Vec<_>>();
    let properties = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .build();
    write_batches(&path, schema, batches, Some(properties));
    (directory, path)
}

fn displays(page: &crate::domain::DataPage, column: usize) -> Vec<Option<&str>> {
    page.rows
        .iter()
        .map(|row| row[column].display.as_deref())
        .collect()
}

#[test]
fn t_p2_001_003_pages_start_at_and_around_every_row_group_boundary() {
    let (_directory, path) = boundary_fixture();
    let source = ParquetSource::open(path).expect("open boundary fixture");
    for (offset, expected) in [
        (0, vec!["0", "1"]),
        (3, vec!["3", "4"]),
        (7, vec!["7", "8"]),
        (9, vec!["9", "10"]),
        (6, vec!["6", "7"]),
        (8, vec!["8", "9"]),
    ] {
        let page = source.read_page(offset, 2).expect("boundary page");
        assert_eq!(
            displays(&page, 0),
            expected.into_iter().map(Some).collect::<Vec<_>>()
        );
    }
}

#[test]
fn t_p2_002_crosses_a_row_group_without_gaps_or_duplicates() {
    let (_directory, path) = boundary_fixture();
    let page = ParquetSource::open(path)
        .expect("open boundary fixture")
        .read_page(2, 4)
        .expect("cross-boundary page");
    assert_eq!(
        displays(&page, 0),
        vec![Some("2"), Some("3"), Some("4"), Some("5")]
    );
}

#[test]
fn t_p2_004_returns_last_row_and_normal_empty_pages_at_or_after_eof() {
    let (_directory, path) = boundary_fixture();
    let source = ParquetSource::open(path).expect("open boundary fixture");
    let last = source.read_page(13, 200).expect("last page");
    assert_eq!(displays(&last, 0), vec![Some("13")]);
    for offset in [14, 99] {
        let page = source.read_page(offset, 200).expect("empty EOF page");
        assert_eq!(page.offset, offset);
        assert_eq!(page.total_rows, Some(14));
        assert!(page.rows.is_empty());
    }
}

#[test]
fn t_p2_005_actual_reader_decodes_only_selected_row_groups_and_projection() {
    let (_directory, path) = boundary_fixture();
    let source = ParquetSource::open(path).expect("open boundary fixture");
    let projection = vec![String::from("label")];
    let page = source
        .read_page_projected(7, 2, Some(&projection))
        .expect("projected row group read");
    assert_eq!(page.columns, projection);
    assert_eq!(displays(&page, 0), vec![Some("row-7"), Some("row-8")]);

    let audit = source.take_decode_audit();
    assert_eq!(audit.reader_builds, 1);
    assert_eq!(audit.selected_row_groups, vec![2]);
    assert_eq!(audit.projected_root_columns, 1);
    assert_eq!(audit.decoded_batches, 1);
    assert_eq!(audit.decoded_rows, 2);
    assert_eq!(audit.decoded_columns, 1);

    let eof = source.read_page(14, 200).expect("EOF page");
    assert!(eof.rows.is_empty());
    assert_eq!(source.take_decode_audit(), Default::default());
}

#[test]
fn t_p2_006_007_projection_preserves_requested_order_across_boundaries() {
    let (_directory, path) = boundary_fixture();
    let source = ParquetSource::open(path).expect("open boundary fixture");
    let projection = vec![String::from("label"), String::from("id")];
    let page = source
        .read_page_projected(2, 4, Some(&projection))
        .expect("projected page");
    assert_eq!(page.columns, projection);
    assert_eq!(page.rows[0][0].display.as_deref(), Some("row-2"));
    assert_eq!(page.rows[0][1].display.as_deref(), Some("2"));
    assert_eq!(page.rows[3][0].display.as_deref(), Some("row-5"));
    assert_eq!(page.rows[3][1].display.as_deref(), Some("5"));
}

#[test]
fn t_p2_008_rejects_empty_duplicate_and_unknown_projections() {
    let (_directory, path) = boundary_fixture();
    let source = ParquetSource::open(path).expect("open boundary fixture");
    for projection in [
        vec![],
        vec![String::from("id"), String::from("id")],
        vec![String::from("missing")],
    ] {
        assert_eq!(
            source
                .read_page_projected(0, 10, Some(&projection))
                .expect_err("invalid projection")
                .code,
            DataErrorCode::InvalidRequest
        );
    }
}

#[test]
fn t_p2_009_allows_64_projection_columns_and_rejects_65() {
    let (_directory, path) = wide_fixture();
    let source = ParquetSource::open(path).expect("open wide fixture");
    let sixty_four = (0..64)
        .map(|index| format!("c{index:02}"))
        .collect::<Vec<_>>();
    let page = source
        .read_page_projected(0, 1, Some(&sixty_four))
        .expect("64 columns");
    assert_eq!(page.columns.len(), 64);
    assert_eq!(page.rows[0].len(), 64);
    let sixty_five = (0..65)
        .map(|index| format!("c{index:02}"))
        .collect::<Vec<_>>();
    assert_eq!(
        source
            .read_page_projected(0, 1, Some(&sixty_five))
            .expect_err("65 columns")
            .code,
        DataErrorCode::InvalidRequest
    );
}

#[test]
fn t_p2_010_enforces_the_200_row_page_cap() {
    let (_directory, path) = page_cap_fixture();
    let source = ParquetSource::open(path).expect("open page cap fixture");
    for limit in [0, 201] {
        assert_eq!(
            source.read_page(0, limit).expect_err("invalid limit").code,
            DataErrorCode::InvalidRequest
        );
    }
    assert_eq!(source.read_page(0, 1).expect("one row").rows.len(), 1);
    assert_eq!(
        source.read_page(0, 200).expect("maximum page").rows.len(),
        200
    );
    assert_eq!(
        source
            .read_page(200, 200)
            .expect("final bounded page")
            .rows
            .len(),
        40
    );
}

#[test]
fn t_p2_011_018_preserves_precision_and_structured_value_displays() {
    let (_directory, path) = type_fixture();
    let page = ParquetSource::open(path)
        .expect("open type fixture")
        .read_page(0, 3)
        .expect("type page");

    assert_eq!(
        page.rows[0][0].display.as_deref(),
        Some("-9223372036854775808")
    );
    assert_eq!(page.rows[1][0].display.as_deref(), Some("9007199254740993"));
    assert_eq!(
        page.rows[2][0].display.as_deref(),
        Some("9223372036854775807")
    );
    assert_eq!(
        page.rows[2][1].display.as_deref(),
        Some("18446744073709551615")
    );
    assert_eq!(page.rows[0][2].kind, ValueKind::Decimal);
    assert_eq!(
        page.rows[0][2].display.as_deref(),
        Some("-12345678901234567890.123456789")
    );
    assert_eq!(page.rows[1][2].display.as_deref(), Some("1.230000000"));
    assert_eq!(page.rows[0][3].kind, ValueKind::Date);
    assert_eq!(page.rows[0][3].display.as_deref(), Some("1969-12-31"));
    assert_eq!(page.rows[1][3].display.as_deref(), Some("2000-02-29"));
    assert_eq!(page.rows[0][4].kind, ValueKind::Timestamp);
    assert_eq!(
        page.rows[0][4].display.as_deref(),
        Some("2023-11-15 07:13:20.123456789")
    );
    assert_eq!(
        page.rows[0][4].raw_display.as_deref(),
        Some("1700000000123456789 [unit=ns, timezone=Asia/Seoul]")
    );
    assert_eq!(page.rows[0][5].kind, ValueKind::Binary);
    assert_eq!(
        page.rows[0][5].display.as_deref(),
        Some("base64:AP8JCkE= (5 bytes)")
    );
    assert_eq!(page.rows[0][6].kind, ValueKind::List);
    assert_eq!(
        page.rows[0][6].display.as_deref(),
        Some("[\"1\",null,\"9007199254740993\"]")
    );
    assert_eq!(page.rows[0][7].kind, ValueKind::Struct);
    assert_eq!(
        page.rows[0][7].display.as_deref(),
        Some("{\"name\":\"alpha\",\"details\":{\"code\":\"9007199254740993\",\"note\":null}}")
    );
    assert_eq!(page.rows[1][6].kind, ValueKind::Null);
    assert_eq!(page.rows[1][7].kind, ValueKind::Null);
    assert_eq!(
        page.rows[2][7].display.as_deref(),
        Some("{\"name\":\"omega\",\"details\":null}")
    );
    assert_eq!(page.rows[0][8].kind, ValueKind::Map);
    assert_eq!(
        page.rows[0][8].display.as_deref(),
        Some(
            "[{\"key\":\"left\",\"value\":\"9007199254740993\"},{\"key\":\"right\",\"value\":null}]"
        )
    );
    assert_eq!(page.rows[1][8].kind, ValueKind::Null);
    assert_eq!(page.rows[2][8].display.as_deref(), Some("[]"));
}

#[test]
fn t_p2_019_serializes_precision_sensitive_values_as_json_strings() {
    let (_directory, path) = type_fixture();
    let page = ParquetSource::open(path)
        .expect("open type fixture")
        .read_page(0, 3)
        .expect("type page");
    let json = serde_json::to_value(page).expect("page JSON");
    for column in [0, 1, 2, 4] {
        assert!(json["rows"][0][column]["display"].is_string());
        assert!(!json["rows"][0][column]["display"].is_number());
    }
}

#[test]
fn t_p2_020_021_exposes_row_group_size_compression_and_statistics_metadata() {
    let (_directory, path) = metadata_fixture();
    let source = ParquetSource::open(&path).expect("open metadata fixture");
    let summary = source.summary();
    let builder = ParquetRecordBatchReaderBuilder::try_new(
        File::open(&path).expect("open fixture footer for independent comparison"),
    )
    .expect("read fixture footer");
    let parquet_metadata = builder.metadata();
    assert_eq!(summary.row_group_count, 3);
    assert_eq!(
        summary
            .row_groups
            .iter()
            .map(|group| group.row_count)
            .collect::<Vec<_>>(),
        vec![2, 3, 1]
    );
    for (index, (group, footer_group)) in summary
        .row_groups
        .iter()
        .zip(parquet_metadata.row_groups())
        .enumerate()
    {
        let expected_compressed_size = footer_group
            .columns()
            .iter()
            .map(|column| u64::try_from(column.compressed_size()).expect("compressed size"))
            .sum::<u64>();
        let mut expected_compression = Vec::new();
        for column in footer_group.columns() {
            let codec = format!("{:?}", column.compression());
            if !expected_compression.contains(&codec) {
                expected_compression.push(codec);
            }
        }
        let expected_statistics_columns = footer_group
            .columns()
            .iter()
            .filter(|column| column.statistics().is_some())
            .count();

        assert_eq!(group.index, index);
        assert_eq!(
            group.total_byte_size,
            u64::try_from(footer_group.total_byte_size()).expect("total byte size")
        );
        assert_eq!(group.compressed_size, expected_compressed_size);
        assert_eq!(group.compression, expected_compression);
        assert_eq!(group.compression, vec![String::from("SNAPPY")]);
        assert_eq!(group.statistics_column_count, expected_statistics_columns);
        assert_eq!(group.statistics_column_count, 2);
    }
    let json = serde_json::to_value(summary).expect("summary JSON");
    assert_eq!(json["rowGroups"][1]["rowCount"], 3);
    assert_eq!(json["rowGroups"][1]["compression"][0], "SNAPPY");
    assert_eq!(json["rowGroups"][1]["statisticsColumnCount"], 2);
}
