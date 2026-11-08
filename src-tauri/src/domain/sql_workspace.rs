use super::DataError;
use serde::{Deserialize, Serialize};

pub const SQL_MAX_TEXT_BYTES: usize = 65_536;
pub const SQL_MAX_SOURCES: usize = 32;
pub const SQL_MAX_COLUMNS: usize = 4096;
pub const SQL_MAX_ROWS: u64 = 1_000_000;
pub fn sql_text_is_blank(value: &str) -> bool {
    value.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlSourceIdentity {
    pub document_id: String,
    pub session_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlColumnMode {
    Name,
    Ordinal,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlTableBinding {
    pub document_id: String,
    pub session_id: String,
    pub alias: String,
    pub column_mode: SqlColumnMode,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSourceColumn {
    pub id: String,
    pub source_index: usize,
    pub original_name: String,
    pub sql_type: String,
    pub nullable: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlTableDescriptor {
    pub document_id: String,
    pub session_id: String,
    pub file_name: String,
    pub path: String,
    pub default_column_mode: SqlColumnMode,
    pub name_mode_allowed: bool,
    pub name_mode_reason: Option<String>,
    pub columns: Vec<SqlSourceColumn>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlAction {
    Execute,
    Explain,
    Analyze,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSqlRequest {
    pub run_id: String,
    pub sql: String,
    pub action: SqlAction,
    pub tables: Vec<SqlTableBinding>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlState {
    Queued,
    Running,
    Complete,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlResultColumn {
    pub id: String,
    pub name: String,
    pub logical_type: String,
    pub nullable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatus {
    pub run_id: String,
    pub state: SqlState,
    pub phase: String,
    pub elapsed_ms: u64,
    pub rows_produced: u64,
    pub result_id: Option<String>,
    pub columns: Vec<SqlResultColumn>,
    pub row_count: Option<u64>,
    pub plan_text: Option<String>,
    pub plan_json: Option<serde_json::Value>,
    pub warnings: Vec<String>,
    pub error: Option<DataError>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlPageRequest {
    pub run_id: String,
    pub result_id: String,
    pub offset: u64,
    pub limit: usize,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SqlExportFormat {
    Csv,
    Tsv,
    Parquet,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlExportRequest {
    pub run_id: String,
    pub result_id: String,
    pub view_id: Option<String>,
    pub format: SqlExportFormat,
}

pub fn validate_sql_identity(value: &str) -> Result<(), DataError> {
    if sql_text_is_blank(value) || value.len() > 128 || value.contains('\0') {
        return Err(DataError::invalid_request(
            "SQL identity must be nonempty, at most 128 UTF-8 bytes, without NUL.",
        ));
    }
    Ok(())
}
impl StartSqlRequest {
    pub fn validate(&self) -> Result<(), DataError> {
        validate_sql_identity(&self.run_id)?;
        if sql_text_is_blank(&self.sql)
            || self.sql.len() > SQL_MAX_TEXT_BYTES
            || self.sql.contains('\0')
        {
            return Err(DataError::invalid_request(
                "SQL must contain one query, at most 65536 UTF-8 bytes, without NUL.",
            ));
        }
        if self.tables.is_empty() || self.tables.len() > SQL_MAX_SOURCES {
            return Err(DataError::invalid_request(
                "Register between 1 and 32 SQL tables.",
            ));
        }
        let mut aliases = std::collections::HashSet::new();
        let mut sources = std::collections::HashSet::new();
        for table in &self.tables {
            validate_sql_identity(&table.document_id)?;
            validate_sql_identity(&table.session_id)?;
            if sql_text_is_blank(&table.alias)
                || table.alias.chars().count() > 128
                || table.alias.len() > 512
                || table.alias.contains('\0')
            {
                return Err(DataError::invalid_request("A table alias must be nonempty, at most 128 characters and 512 UTF-8 bytes, without NUL."));
            }
            if !aliases.insert(table.alias.to_ascii_lowercase())
                || !sources.insert((&table.document_id, &table.session_id))
            {
                return Err(DataError::invalid_request(
                    "SQL table aliases and source identities must be unique.",
                ));
            }
        }
        Ok(())
    }
}
impl SqlPageRequest {
    pub fn validate(&self) -> Result<(), DataError> {
        validate_sql_identity(&self.run_id)?;
        validate_sql_identity(&self.result_id)?;
        if self.offset > SQL_MAX_ROWS
            || self.limit == 0
            || self.limit > 200
            || self.columns.is_empty()
            || self.columns.len() > 64
        {
            return Err(DataError::invalid_request(
                "SQL page requires offset <=1000000, 1..200 rows and 1..64 columns.",
            ));
        }
        let mut used = std::collections::HashSet::new();
        if self.columns.iter().any(|id| {
            !used.insert(id)
                || id
                    .strip_prefix('r')
                    .and_then(|s| s.parse::<usize>().ok())
                    .is_none_or(|n| id != &format!("r{n}") || n >= SQL_MAX_COLUMNS)
        }) {
            return Err(DataError::invalid_request(
                "SQL result projections require unique canonical result column IDs.",
            ));
        }
        Ok(())
    }
}
