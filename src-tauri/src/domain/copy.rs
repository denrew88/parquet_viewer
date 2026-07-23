use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::{
    BooleanRepresentation, CopyEscapeMode, CopyLineEnding, CopyQuoteMode, DataError, DataValue,
    DateTimeRepresentation, EmptyStringRepresentation,
};

pub const COPY_HISTORY_CAPACITY: usize = 5;
pub const COPY_MAX_BATCH_CELLS: usize = 64_000;
pub const COPY_MAX_BATCH_ESTIMATED_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyRepresentation {
    Display,
    RawCanonical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyOptionsSnapshot {
    pub delimiter: String,
    pub include_headers: bool,
    pub quote_mode: CopyQuoteMode,
    pub quote_character: String,
    pub escape_mode: CopyEscapeMode,
    pub line_ending: CopyLineEnding,
    pub null_representation: String,
    pub empty_string_representation: EmptyStringRepresentation,
    pub boolean_representation: BooleanRepresentation,
    pub date_time_representation: DateTimeRepresentation,
    pub representation: CopyRepresentation,
}

impl CopyOptionsSnapshot {
    pub fn validate(&self) -> Result<(), DataError> {
        if !one_safe_character(&self.delimiter)
            || !one_safe_character(&self.quote_character)
            || self.delimiter == self.quote_character
            || self.null_representation.contains(['\r', '\n', '\0'])
            || self.null_representation.contains(&self.delimiter)
            || matches!(
                &self.date_time_representation,
                DateTimeRepresentation::Custom { format } if format.trim().is_empty() || format.len() > 256
            )
        {
            return Err(DataError::invalid_request(
                "The copy formatting snapshot is invalid.",
            ));
        }
        Ok(())
    }
}

fn one_safe_character(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(character) if !matches!(character, '\r' | '\n' | '\0'))
        && characters.next().is_none()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopySelectionSnapshot {
    pub row_start: u64,
    pub row_end_exclusive: u64,
    pub column_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartCopyRequest {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub selection: CopySelectionSnapshot,
    pub options: CopyOptionsSnapshot,
    pub max_cells: u64,
    pub max_bytes: u64,
}

impl StartCopyRequest {
    pub fn validate(&self) -> Result<(), DataError> {
        if self.operation_id.trim().is_empty()
            || self.operation_id.len() > 128
            || !self.operation_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
            || self.document_id.trim().is_empty()
            || self.session_id.trim().is_empty()
            || self
                .query_id
                .as_ref()
                .is_some_and(|query_id| query_id.trim().is_empty() || query_id.len() > 128)
            || self.selection.row_start >= self.selection.row_end_exclusive
            || self.selection.column_ids.is_empty()
            || self.selection.column_ids.len() > 16_384
            || self
                .selection
                .column_ids
                .iter()
                .any(|column| column.trim().is_empty())
            || self.max_cells == 0
            || self.max_bytes == 0
        {
            return Err(DataError::invalid_request(
                "The copy operation identity, selection, or limits are invalid.",
            ));
        }
        let unique = self
            .selection
            .column_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        if unique.len() != self.selection.column_ids.len() {
            return Err(DataError::invalid_request(
                "Copy selection columns must be unique.",
            ));
        }
        self.options.validate()
    }

    pub fn selected_cell_count(&self) -> Option<u64> {
        self.selection
            .row_end_exclusive
            .checked_sub(self.selection.row_start)?
            .checked_mul(self.selection.column_ids.len() as u64)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyOperationState {
    Queued,
    Running,
    Cancelling,
    Committing,
    Complete,
    Cancelled,
    Failed,
}

impl CopyOperationState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Complete | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyOperationStage {
    Preparing,
    SourceRead,
    Serialize,
    ClipboardWrite,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyFailureReason {
    SelectionLimit,
    ByteLimit,
    SourceRead,
    QueryStale,
    Cancelled,
    Serialize,
    ClipboardWrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFailure {
    pub reason: CopyFailureReason,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub rows_processed: u64,
    pub total_rows: u64,
    pub cells_processed: u64,
    pub bytes_serialized: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOperationStatus {
    pub operation_id: String,
    pub started_at: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub selection: CopySelectionSnapshot,
    pub options: CopyOptionsSnapshot,
    pub state: CopyOperationState,
    pub stage: CopyOperationStage,
    pub progress: CopyProgress,
    pub failure: Option<CopyFailure>,
}

impl CopyOperationStatus {
    pub fn queued(request: &StartCopyRequest) -> Self {
        Self {
            operation_id: request.operation_id.clone(),
            started_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            document_id: request.document_id.clone(),
            session_id: request.session_id.clone(),
            query_id: request.query_id.clone(),
            selection: request.selection.clone(),
            options: request.options.clone(),
            state: CopyOperationState::Queued,
            stage: CopyOperationStage::Preparing,
            progress: CopyProgress {
                rows_processed: 0,
                total_rows: request
                    .selection
                    .row_end_exclusive
                    .saturating_sub(request.selection.row_start),
                cells_processed: 0,
                bytes_serialized: 0,
            },
            failure: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOperationHistory {
    pub current: Option<CopyOperationStatus>,
    pub previous: Vec<CopyOperationStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyOperationIdentity {
    pub operation_id: String,
    pub document_id: String,
    pub session_id: String,
}

impl CopyOperationIdentity {
    pub fn validate(&self) -> Result<(), DataError> {
        if self.operation_id.trim().is_empty()
            || self.document_id.trim().is_empty()
            || self.session_id.trim().is_empty()
        {
            Err(DataError::invalid_request(
                "The copy operation identity is invalid.",
            ))
        } else {
            Ok(())
        }
    }
}

pub fn copy_value_text(value: &DataValue, representation: CopyRepresentation) -> String {
    match representation {
        CopyRepresentation::Display => value.display.clone().unwrap_or_default(),
        CopyRepresentation::RawCanonical => value
            .raw_display
            .clone()
            .or_else(|| value.source_display.clone())
            .or_else(|| value.display.clone())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> StartCopyRequest {
        StartCopyRequest {
            operation_id: String::from("copy-1"),
            document_id: String::from("document-1"),
            session_id: String::from("session-1"),
            query_id: Some(String::from("query-1")),
            selection: CopySelectionSnapshot {
                row_start: 2,
                row_end_exclusive: 5,
                column_ids: vec![String::from("b"), String::from("a")],
            },
            options: CopyOptionsSnapshot {
                delimiter: String::from("\t"),
                include_headers: false,
                quote_mode: CopyQuoteMode::Minimal,
                quote_character: String::from("\""),
                escape_mode: CopyEscapeMode::Double,
                line_ending: CopyLineEnding::Crlf,
                null_representation: String::new(),
                empty_string_representation: EmptyStringRepresentation::Empty,
                boolean_representation: BooleanRepresentation::Lowercase,
                date_time_representation: DateTimeRepresentation::Display,
                representation: CopyRepresentation::Display,
            },
            max_cells: 10,
            max_bytes: 1024,
        }
    }

    #[test]
    fn validates_ordered_query_selection_and_counts_cells() {
        let request = request();
        assert_eq!(request.validate(), Ok(()));
        assert_eq!(request.selected_cell_count(), Some(6));
    }

    #[test]
    fn rejects_duplicate_columns_and_unknown_wire_fields() {
        let mut duplicate_request = request();
        duplicate_request.selection.column_ids = vec![String::from("a"), String::from("a")];
        assert!(duplicate_request.validate().is_err());

        let mut value = serde_json::to_value(request()).unwrap();
        value["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<StartCopyRequest>(value).is_err());
    }

    #[test]
    fn preserves_raw_canonical_value_without_changing_display() {
        let value = DataValue::converted(super::super::ValueKind::Timestamp, "shown", "raw");
        assert_eq!(
            copy_value_text(&value, CopyRepresentation::Display),
            "shown"
        );
        assert_eq!(
            copy_value_text(&value, CopyRepresentation::RawCanonical),
            "raw"
        );
    }
}
