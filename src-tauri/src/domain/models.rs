use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataFormat {
    Parquet,
    Csv,
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
    pub file_size: u64,
    pub row_count: Option<u64>,
    pub row_count_status: RowCountStatus,
    pub column_count: usize,
    pub row_group_count: usize,
    pub columns: Vec<ColumnSchema>,
    pub row_groups: Vec<RowGroupSummary>,
    pub csv_metadata: Option<CsvMetadata>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataValue {
    pub kind: ValueKind,
    pub display: Option<String>,
}

impl DataValue {
    pub fn null() -> Self {
        Self {
            kind: ValueKind::Null,
            display: None,
        }
    }

    pub fn displayed(kind: ValueKind, display: impl Into<String>) -> Self {
        Self {
            kind,
            display: Some(display.into()),
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
