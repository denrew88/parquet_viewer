use serde::{Deserialize, Serialize};

use super::{DataError, DataValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvProfileMode {
    Auto,
    AllText,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvTargetType {
    Auto,
    Text,
    Boolean,
    #[serde(rename = "int64")]
    Int64,
    #[serde(rename = "uint64", alias = "uInt64")]
    UInt64,
    #[serde(rename = "float64")]
    Float64,
    Decimal,
    Date,
    Timestamp,
    Duration,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DurationUnit {
    S,
    Ms,
    Us,
    Ns,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvDurationInputFormat {
    RawInteger,
    DaysClock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvConversionFailurePolicy {
    PreserveInvalid,
    Fail,
    AsNull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvTimezonePolicy {
    Preserve,
    AssumeUtc,
    FixedOffset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumnProfile {
    pub source_index: usize,
    pub source_name: String,
    pub target_type: CsvTargetType,
    pub trim: bool,
    pub null_tokens: Vec<String>,
    pub true_tokens: Vec<String>,
    pub false_tokens: Vec<String>,
    pub decimal_separator: String,
    pub thousand_separator: Option<String>,
    pub temporal_formats: Vec<String>,
    pub timezone_policy: CsvTimezonePolicy,
    pub timezone_offset_minutes: Option<i32>,
    pub duration_unit: Option<DurationUnit>,
    pub duration_input_format: Option<CsvDurationInputFormat>,
    pub failure_policy: CsvConversionFailurePolicy,
}

impl CsvColumnProfile {
    pub fn new(source_index: usize, source_name: String, target_type: CsvTargetType) -> Self {
        Self {
            source_index,
            source_name,
            target_type,
            trim: false,
            null_tokens: vec![String::from("NULL"), String::from("N/A")],
            true_tokens: vec![
                String::from("true"),
                String::from("TRUE"),
                String::from("1"),
            ],
            false_tokens: vec![
                String::from("false"),
                String::from("FALSE"),
                String::from("0"),
            ],
            decimal_separator: String::from("."),
            thousand_separator: None,
            temporal_formats: Vec::new(),
            timezone_policy: CsvTimezonePolicy::Preserve,
            timezone_offset_minutes: None,
            duration_unit: None,
            duration_input_format: None,
            failure_policy: CsvConversionFailurePolicy::PreserveInvalid,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvParsingProfile {
    pub mode: CsvProfileMode,
    pub generation: u64,
    pub columns: Vec<CsvColumnProfile>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumnInference {
    pub source_index: usize,
    pub source_name: String,
    pub recommended_type: CsvTargetType,
    pub confidence: f64,
    pub non_null_samples: usize,
    pub ambiguous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvPreviewStage {
    Leading,
    Distributed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewCell {
    pub raw: String,
    pub converted: DataValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewRow {
    pub source_row: u64,
    pub cells: Vec<CsvPreviewCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewColumn {
    pub source_index: usize,
    pub source_name: String,
    pub recommended_type: CsvTargetType,
    pub confidence: f64,
    pub target_type: CsvTargetType,
    pub success_count: u64,
    pub null_count: u64,
    pub invalid_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfilePreview {
    pub generation: u64,
    pub stage: CsvPreviewStage,
    pub profile: CsvParsingProfile,
    pub columns: Vec<CsvPreviewColumn>,
    pub rows: Vec<CsvPreviewRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvValidationErrorSample {
    pub source_row: u64,
    pub raw: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumnValidation {
    pub source_index: usize,
    pub source_name: String,
    pub success_count: u64,
    pub null_count: u64,
    pub invalid_count: u64,
    pub first_error_row: Option<u64>,
    pub error_samples: Vec<CsvValidationErrorSample>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvValidationState {
    Queued,
    Running,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvValidationStatus {
    pub task_id: String,
    pub document_id: String,
    pub session_id: String,
    pub generation: u64,
    pub state: CsvValidationState,
    pub rows_scanned: u64,
    pub total_rows: Option<u64>,
    pub columns: Vec<CsvColumnValidation>,
    pub error: Option<DataError>,
}

#[cfg(test)]
mod tests {
    use super::CsvTargetType;

    #[test]
    fn csv_target_type_numeric_wire_names_are_stable() {
        assert_eq!(serde_json::to_value(CsvTargetType::Int64).unwrap(), "int64");
        assert_eq!(
            serde_json::to_value(CsvTargetType::UInt64).unwrap(),
            "uint64"
        );
        assert_eq!(
            serde_json::to_value(CsvTargetType::Float64).unwrap(),
            "float64"
        );
        assert_eq!(
            serde_json::from_str::<CsvTargetType>("\"uInt64\"").unwrap(),
            CsvTargetType::UInt64
        );
    }
}
