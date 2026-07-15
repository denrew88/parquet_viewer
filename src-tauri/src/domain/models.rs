use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct DataFormat(&'static str);

#[allow(non_upper_case_globals)]
impl DataFormat {
    pub const Csv: Self = Self("csv");
    pub const Parquet: Self = Self("parquet");

    #[allow(dead_code)]
    pub const fn new(id: &'static str) -> Self {
        Self(id)
    }

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceCapability {
    TypedSchema,
    ColumnProjection,
    FilterPushdown,
    RowGroups,
    ParsingProfile,
    BackgroundRowCount,
    MultipleDatasets,
    QueryProvider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDescriptor {
    pub id: DataFormat,
    pub display_name: &'static str,
    pub extensions: &'static [&'static str],
    pub mime_types: &'static [&'static str],
    pub capabilities: &'static [SourceCapability],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeaderMode {
    Auto,
    Present,
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RowCountState {
    Calculating,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCountStatus {
    pub state: RowCountState,
    pub rows_scanned: u64,
    pub bytes_scanned: u64,
    pub total_bytes: u64,
    pub generation: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvStructureIssue {
    pub row: u64,
    pub expected_columns: usize,
    pub actual_columns: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvHeaderIssueReason {
    Blank,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvHeaderIssue {
    pub column_index: usize,
    pub raw_name: String,
    pub resolved_name: String,
    pub reason: CsvHeaderIssueReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMetadata {
    pub delimiter: String,
    pub encoding: String,
    pub header_mode: HeaderMode,
    pub suggested_header: Option<bool>,
    pub header_used: bool,
    pub structure_issue_count: u64,
    pub structure_issues: Vec<CsvStructureIssue>,
    pub raw_header_count: usize,
    pub raw_headers: Vec<String>,
    pub raw_headers_truncated: bool,
    pub header_issue_count: usize,
    pub header_issues: Vec<CsvHeaderIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    pub name: String,
    pub logical_type: String,
    pub nullable: bool,
    pub physical_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub file_name: String,
    pub path: String,
    pub format: DataFormat,
    pub format_descriptor: FormatDescriptor,
    pub file_size: u64,
    pub row_count: Option<u64>,
    pub row_count_status: RowCountStatus,
    pub column_count: usize,
    pub row_group_count: usize,
    pub columns: Vec<ColumnSchema>,
    pub row_groups: Vec<RowGroupSummary>,
    pub csv_metadata: Option<CsvMetadata>,
    pub format_details: Vec<FormatDetailsSection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEntry {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FormatDetailsContent {
    KeyValue {
        entries: Vec<MetadataEntry>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        truncated: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDetailsSection {
    pub id: String,
    pub title: String,
    #[serde(flatten)]
    pub content: FormatDetailsContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowGroupSummary {
    pub index: usize,
    pub row_count: u64,
    pub total_byte_size: u64,
    pub compressed_size: u64,
    pub compression: Vec<String>,
    pub statistics_column_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Null,
    String,
    Int,
    Float,
    Boolean,
    Binary,
    Decimal,
    Date,
    Timestamp,
    List,
    Struct,
    Map,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataValueState {
    Valid,
    Null,
    Empty,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataValue {
    pub kind: ValueKind,
    pub display: Option<String>,
    pub state: DataValueState,
    pub raw_display: Option<String>,
    pub diagnostic: Option<CellDiagnostic>,
}

impl DataValue {
    pub fn null() -> Self {
        Self {
            kind: ValueKind::Null,
            display: None,
            state: DataValueState::Null,
            raw_display: None,
            diagnostic: None,
        }
    }

    pub fn displayed(kind: ValueKind, display: impl Into<String>) -> Self {
        let display = display.into();
        let state = if kind == ValueKind::String && display.is_empty() {
            DataValueState::Empty
        } else {
            DataValueState::Valid
        };
        Self {
            kind,
            display: Some(display),
            state,
            raw_display: None,
            diagnostic: None,
        }
    }

    pub fn converted(kind: ValueKind, display: impl Into<String>, raw: impl Into<String>) -> Self {
        Self {
            kind,
            display: Some(display.into()),
            state: DataValueState::Valid,
            raw_display: Some(raw.into()),
            diagnostic: None,
        }
    }

    pub fn empty(raw: impl Into<String>) -> Self {
        Self {
            kind: ValueKind::String,
            display: Some(String::new()),
            state: DataValueState::Empty,
            raw_display: Some(raw.into()),
            diagnostic: None,
        }
    }

    pub fn converted_null(raw: impl Into<String>) -> Self {
        Self {
            kind: ValueKind::Null,
            display: None,
            state: DataValueState::Null,
            raw_display: Some(raw.into()),
            diagnostic: None,
        }
    }

    pub fn invalid(
        kind: ValueKind,
        raw: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        let raw = raw.into();
        Self {
            kind,
            display: Some(raw.clone()),
            state: DataValueState::Invalid,
            raw_display: Some(raw),
            diagnostic: Some(CellDiagnostic {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPage {
    pub offset: u64,
    pub limit: usize,
    pub total_rows: Option<u64>,
    pub has_more: bool,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<DataValue>>,
}
