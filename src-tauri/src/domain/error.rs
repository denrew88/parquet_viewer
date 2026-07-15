use serde::Serialize;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DataErrorCode {
    FileNotFound,
    UnsupportedFormat,
    InvalidParquet,
    InvalidCsv,
    InvalidEncoding,
    UnsupportedEncoding,
    CsvLimitExceeded,
    TaskCancelled,
    InvalidRequest,
    TooManyOpenDocuments,
    DocumentNotFound,
    DocumentClosed,
    StaleSession,
    DuplicateOpenRequest,
    OpenRequestCancelled,
    SettingsInvalid,
    QueryNotFound,
    QueryFailed,
    QueryTempLimitExceeded,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct DataError {
    pub code: DataErrorCode,
    pub message: String,
}

impl DataError {
    pub fn file_not_found(path: &Path) -> Self {
        Self::new(
            DataErrorCode::FileNotFound,
            format!("File not found: {}", path.display()),
        )
    }

    pub fn unsupported_format(path: &Path) -> Self {
        Self::new(
            DataErrorCode::UnsupportedFormat,
            format!("Unsupported data file format: {}", path.display()),
        )
    }

    pub fn invalid_csv(path: &Path, reason: impl std::fmt::Display) -> Self {
        Self::new(
            DataErrorCode::InvalidCsv,
            format!("Invalid CSV file {}: {reason}", path.display()),
        )
    }

    pub fn invalid_encoding(path: &Path, byte_offset: u64) -> Self {
        Self::new(
            DataErrorCode::InvalidEncoding,
            format!(
                "CSV file {} is not valid UTF-8 near byte offset {byte_offset}.",
                path.display()
            ),
        )
    }

    pub fn unsupported_encoding(path: &Path, encoding: &str) -> Self {
        Self::new(
            DataErrorCode::UnsupportedEncoding,
            format!(
                "CSV file {} uses unsupported encoding {encoding}; use UTF-8 or UTF-8 BOM.",
                path.display()
            ),
        )
    }

    pub fn csv_limit_exceeded(path: &Path, reason: impl std::fmt::Display) -> Self {
        Self::new(
            DataErrorCode::CsvLimitExceeded,
            format!("CSV safety limit exceeded in {}: {reason}", path.display()),
        )
    }

    pub fn task_cancelled() -> Self {
        Self::new(DataErrorCode::TaskCancelled, "The data task was cancelled.")
    }

    pub fn invalid_parquet(path: &Path, reason: impl std::fmt::Display) -> Self {
        Self::new(
            DataErrorCode::InvalidParquet,
            format!("Invalid Parquet file {}: {reason}", path.display()),
        )
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(DataErrorCode::InvalidRequest, message)
    }

    pub fn settings_invalid(message: impl Into<String>) -> Self {
        Self::new(DataErrorCode::SettingsInvalid, message)
    }

    pub fn query_not_found(query_id: &str) -> Self {
        Self::new(
            DataErrorCode::QueryNotFound,
            format!("Query result not found: {query_id}"),
        )
    }

    pub fn query_failed(message: impl Into<String>) -> Self {
        Self::new(DataErrorCode::QueryFailed, message)
    }

    pub fn query_temp_limit(message: impl Into<String>) -> Self {
        Self::new(DataErrorCode::QueryTempLimitExceeded, message)
    }

    pub fn too_many_open_documents(limit: usize, open: usize, reserved: usize) -> Self {
        Self::new(
            DataErrorCode::TooManyOpenDocuments,
            format!(
                "Cannot open another document; the process limit is {limit} (open: {open}, opening: {reserved})."
            ),
        )
    }

    pub fn document_not_found(document_id: &str) -> Self {
        Self::new(
            DataErrorCode::DocumentNotFound,
            format!("Document not found: {document_id}"),
        )
    }

    pub fn document_closed(document_id: &str) -> Self {
        Self::new(
            DataErrorCode::DocumentClosed,
            format!("Document is closed: {document_id}"),
        )
    }

    pub fn stale_session(document_id: &str, session_id: &str) -> Self {
        Self::new(
            DataErrorCode::StaleSession,
            format!("Session {session_id} is no longer active for document {document_id}."),
        )
    }

    pub fn duplicate_open_request(request_id: &str) -> Self {
        Self::new(
            DataErrorCode::DuplicateOpenRequest,
            format!("Open request ID has already been used: {request_id}"),
        )
    }

    pub fn open_request_cancelled(request_id: &str) -> Self {
        Self::new(
            DataErrorCode::OpenRequestCancelled,
            format!("Open request was cancelled: {request_id}"),
        )
    }

    pub fn io(path: &Path, reason: impl std::fmt::Display) -> Self {
        Self::new(
            DataErrorCode::Io,
            format!("Could not read {}: {reason}", path.display()),
        )
    }

    fn new(code: DataErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
