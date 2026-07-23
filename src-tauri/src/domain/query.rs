use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::{ColumnSchema, DataError, DataPage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryScalarType {
    Text,
    Number,
    Decimal,
    Date,
    Timestamp,
    Duration,
    Boolean,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperator {
    Equals,
    NotEquals,
    Contains,
    StartsWith,
    EndsWith,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    Between,
    OneOf,
    IsTrue,
    IsFalse,
    IsNull,
    IsNotNull,
    IsInvalid,
    IsNotInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryFilter {
    pub id: String,
    pub column_id: String,
    pub scalar_type: QueryScalarType,
    pub operator: FilterOperator,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuerySearch {
    pub text: String,
    pub mode: QuerySearchMode,
    pub case_sensitive: bool,
    pub exact: bool,
    pub target_column_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuerySearchMode {
    Find,
    Filter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuerySort {
    pub column_id: String,
    pub direction: QuerySortDirection,
    pub nulls_last: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuerySortDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryPlan {
    pub filters: Vec<QueryFilter>,
    pub search: Option<QuerySearch>,
    pub sort: Vec<QuerySort>,
    pub projection: Vec<String>,
}

impl QueryPlan {
    pub fn validate(&self, columns: &[ColumnSchema]) -> Result<(), DataError> {
        if self.filters.len() > 256 || self.sort.len() > 64 || self.projection.len() > 64 {
            return Err(DataError::invalid_request(
                "Query plan exceeds its size limits.",
            ));
        }
        let available = columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        let mut filter_ids = HashSet::new();
        let mut filter_columns = HashSet::new();
        for filter in &self.filters {
            if filter.id.trim().is_empty() || !filter_ids.insert(filter.id.as_str()) {
                return Err(DataError::invalid_request(
                    "Query filter IDs must be non-empty and unique.",
                ));
            }
            require_column(&available, &filter.column_id)?;
            if !filter_columns.insert(filter.column_id.as_str()) {
                return Err(DataError::invalid_request(
                    "Use oneOf for same-column OR; duplicate filter columns are not allowed.",
                ));
            }
            let column = columns
                .iter()
                .find(|column| column.name == filter.column_id)
                .expect("validated query column exists");
            let actual = scalar_type_for_column(column);
            if actual != filter.scalar_type {
                return Err(DataError::invalid_request(format!(
                    "Query scalarType for {} does not match its source schema.",
                    filter.column_id
                )));
            }
            validate_filter(filter)?;
            for value in &filter.values {
                validate_literal(filter.scalar_type, value)?;
            }
        }
        if let Some(search) = &self.search {
            if search.text.trim().is_empty() || search.text.len() > 16_384 {
                return Err(DataError::invalid_request(
                    "Query search text must contain 1 to 16384 characters.",
                ));
            }
            let mut targets = HashSet::new();
            for column_id in &search.target_column_ids {
                require_column(&available, column_id)?;
                if !targets.insert(column_id.as_str()) {
                    return Err(DataError::invalid_request(
                        "Query search target columns must be unique.",
                    ));
                }
                let column = columns
                    .iter()
                    .find(|column| column.name == *column_id)
                    .expect("validated query column exists");
                if scalar_type_for_column(column) == QueryScalarType::Other {
                    return Err(DataError::invalid_request(format!(
                        "Column {column_id} cannot be searched."
                    )));
                }
            }
        }
        let mut sort_columns = HashSet::new();
        for sort in &self.sort {
            require_column(&available, &sort.column_id)?;
            if !sort.nulls_last || !sort_columns.insert(sort.column_id.as_str()) {
                return Err(DataError::invalid_request(
                    "Query sorts must be unique and use nullsLast=true.",
                ));
            }
        }
        let mut projection = HashSet::new();
        for column in &self.projection {
            require_column(&available, column)?;
            if !projection.insert(column.as_str()) {
                return Err(DataError::invalid_request(
                    "Query projection columns must be unique.",
                ));
            }
        }
        Ok(())
    }
}

pub fn scalar_type_for_column(column: &ColumnSchema) -> QueryScalarType {
    let logical = column.logical_type.to_ascii_lowercase();
    if logical.contains("timestamp") {
        QueryScalarType::Timestamp
    } else if logical.contains("duration") {
        QueryScalarType::Duration
    } else if logical == "date" || logical.contains("date32") || logical.contains("date64") {
        QueryScalarType::Date
    } else if logical.contains("decimal") {
        QueryScalarType::Decimal
    } else if logical.contains("bool") {
        QueryScalarType::Boolean
    } else if logical.contains("int")
        || logical.contains("float")
        || logical.contains("double")
        || logical.contains("number")
    {
        QueryScalarType::Number
    } else if logical.contains("string") || logical.contains("utf8") || logical == "text" {
        QueryScalarType::Text
    } else {
        QueryScalarType::Other
    }
}

fn require_column(available: &HashSet<&str>, column: &str) -> Result<(), DataError> {
    if column.is_empty() || !available.contains(column) {
        return Err(DataError::invalid_request(format!(
            "Unknown query column: {column}"
        )));
    }
    Ok(())
}

fn validate_filter(filter: &QueryFilter) -> Result<(), DataError> {
    let valid_operator = match filter.scalar_type {
        QueryScalarType::Text => matches!(
            filter.operator,
            FilterOperator::Equals
                | FilterOperator::NotEquals
                | FilterOperator::OneOf
                | FilterOperator::Contains
                | FilterOperator::StartsWith
                | FilterOperator::EndsWith
                | FilterOperator::IsNull
                | FilterOperator::IsNotNull
                | FilterOperator::IsInvalid
                | FilterOperator::IsNotInvalid
        ),
        QueryScalarType::Number
        | QueryScalarType::Decimal
        | QueryScalarType::Date
        | QueryScalarType::Timestamp
        | QueryScalarType::Duration => matches!(
            filter.operator,
            FilterOperator::Equals
                | FilterOperator::NotEquals
                | FilterOperator::GreaterThan
                | FilterOperator::GreaterThanOrEqual
                | FilterOperator::LessThan
                | FilterOperator::LessThanOrEqual
                | FilterOperator::Between
                | FilterOperator::OneOf
                | FilterOperator::IsNull
                | FilterOperator::IsNotNull
                | FilterOperator::IsInvalid
                | FilterOperator::IsNotInvalid
        ),
        QueryScalarType::Boolean => matches!(
            filter.operator,
            FilterOperator::IsTrue
                | FilterOperator::IsFalse
                | FilterOperator::OneOf
                | FilterOperator::IsNull
                | FilterOperator::IsNotNull
                | FilterOperator::IsInvalid
                | FilterOperator::IsNotInvalid
        ),
        QueryScalarType::Other => matches!(
            filter.operator,
            FilterOperator::IsNull
                | FilterOperator::IsNotNull
                | FilterOperator::IsInvalid
                | FilterOperator::IsNotInvalid
        ),
    };
    if !valid_operator {
        return Err(DataError::invalid_request(format!(
            "Filter operator is not valid for {:?}.",
            filter.scalar_type
        )));
    }
    let expected = match filter.operator {
        FilterOperator::IsTrue
        | FilterOperator::IsFalse
        | FilterOperator::IsNull
        | FilterOperator::IsNotNull
        | FilterOperator::IsInvalid
        | FilterOperator::IsNotInvalid => 0,
        FilterOperator::Between => 2,
        FilterOperator::OneOf => {
            if filter.values.is_empty() || filter.values.len() > 10_000 {
                return Err(DataError::invalid_request(
                    "oneOf requires 1 to 10000 values.",
                ));
            }
            usize::MAX
        }
        _ => 1,
    };
    if expected != usize::MAX && filter.values.len() != expected {
        return Err(DataError::invalid_request(
            "Filter value count does not match its operator.",
        ));
    }
    if filter.values.iter().any(|value| value.trim().is_empty()) {
        return Err(DataError::invalid_request("Filter values cannot be empty."));
    }
    Ok(())
}

fn validate_literal(scalar: QueryScalarType, value: &str) -> Result<(), DataError> {
    let valid = match scalar {
        QueryScalarType::Text => true,
        QueryScalarType::Number | QueryScalarType::Decimal => {
            value.parse::<f64>().is_ok_and(f64::is_finite)
        }
        QueryScalarType::Boolean => {
            value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false")
        }
        QueryScalarType::Date => valid_date_literal(value),
        QueryScalarType::Timestamp => {
            let value = value.strip_suffix('Z').unwrap_or(value);
            value
                .split_once('T')
                .or_else(|| value.split_once(' '))
                .is_some_and(|(date, time)| {
                    valid_date_literal(date)
                        && time.split(':').take(3).collect::<Vec<_>>().len() == 3
                })
        }
        QueryScalarType::Duration => valid_duration_literal(value),
        QueryScalarType::Other => false,
    };
    if valid {
        Ok(())
    } else {
        Err(DataError::invalid_request(format!(
            "Filter literal is invalid for {scalar:?}: {value}"
        )))
    }
}

fn valid_duration_literal(value: &str) -> bool {
    for suffix in ["ms", "us", "ns", "s"] {
        if let Some(count) = value.strip_suffix(suffix) {
            return !count.is_empty() && count.parse::<i64>().is_ok();
        }
    }
    let unsigned = value
        .strip_prefix('+')
        .or_else(|| value.strip_prefix('-'))
        .unwrap_or(value);
    let clock = if let Some((days, clock)) = unsigned.split_once("d ") {
        if days.is_empty() || days.parse::<u64>().is_err() {
            return false;
        }
        clock
    } else {
        unsigned
    };
    let (clock, fraction) = clock
        .split_once('.')
        .map_or((clock, None), |(clock, fraction)| (clock, Some(fraction)));
    if fraction.is_some_and(|digits| {
        digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return false;
    }
    let parts = clock.split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.len() != 2) {
        return false;
    }
    let parsed = parts
        .iter()
        .map(|part| part.parse::<u8>())
        .collect::<Result<Vec<_>, _>>();
    parsed.is_ok_and(|parts| parts[0] <= 23 && parts[1] <= 59 && parts[2] <= 59)
}

fn valid_date_literal(value: &str) -> bool {
    let parts = value
        .split('-')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else { return false };
    if parts.len() != 3 || parts[0] < 1 || !(1..=12).contains(&parts[1]) {
        return false;
    }
    let leap = parts[0] % 4 == 0 && (parts[0] % 100 != 0 || parts[0] % 400 == 0);
    let days = match parts[1] {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&parts[2])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecuteQueryRequest {
    pub document_id: String,
    pub session_id: String,
    pub query_id: String,
    pub task_id: String,
    pub plan: QueryPlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryProgress {
    pub rows_scanned: u64,
    pub total_rows: Option<u64>,
    pub result_rows: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryTaskState {
    Queued,
    Running,
    Complete,
    Cancelling,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStatus {
    pub document_id: String,
    pub session_id: String,
    pub query_id: String,
    pub task_id: String,
    pub state: QueryTaskState,
    pub progress: QueryProgress,
    pub columns: Vec<String>,
    pub elapsed_ms: u64,
    pub find_match_count: Option<u64>,
    pub error: Option<DataError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadQueryPageRequest {
    pub document_id: String,
    pub session_id: String,
    pub query_id: String,
    pub offset: i64,
    pub limit: usize,
    pub columns: Vec<String>,
}

impl ReadQueryPageRequest {
    pub fn validate(&self) -> Result<(), DataError> {
        if self.document_id.trim().is_empty()
            || self.session_id.trim().is_empty()
            || self.query_id.trim().is_empty()
            || self.offset < 0
            || !(1..=200).contains(&self.limit)
            || !(1..=64).contains(&self.columns.len())
            || self.columns.iter().any(|column| column.trim().is_empty())
        {
            return Err(DataError::invalid_request(
                "Query page identity, offset, limit, or projection is invalid.",
            ));
        }
        let unique = self
            .columns
            .iter()
            .collect::<std::collections::HashSet<_>>();
        if unique.len() != self.columns.len() {
            return Err(DataError::invalid_request(
                "Query page projection columns must be unique.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadQueryPageResponse {
    pub document_id: String,
    pub session_id: String,
    pub query_id: String,
    pub page: DataPage,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistinctValuesRequest {
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub column_id: String,
    pub search: Option<String>,
    pub offset: u64,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistinctValue {
    pub value: Option<String>,
    pub is_null: bool,
    pub is_invalid: bool,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistinctValuesResponse {
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub column_id: String,
    pub values: Vec<DistinctValue>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindDirection {
    Next,
    Previous,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindQueryMatchRequest {
    pub document_id: String,
    pub session_id: String,
    pub query_id: String,
    pub from_result_offset: u64,
    pub from_match_index: Option<u64>,
    pub direction: FindDirection,
    pub wrap: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindQueryMatch {
    pub row_offset: u64,
    pub column_id: String,
    pub match_index: u64,
    pub total_matches: u64,
    pub wrapped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindQueryMatchResponse {
    pub document_id: String,
    pub session_id: String,
    pub query_id: String,
    #[serde(rename = "match")]
    pub matched: Option<FindQueryMatch>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns() -> Vec<ColumnSchema> {
        vec![ColumnSchema {
            name: String::from("city"),
            logical_type: String::from("String"),
            nullable: true,
            physical_type: String::from("UTF8"),
        }]
    }

    #[test]
    fn qry_contract_rejects_claimed_type_and_duplicate_same_column() {
        let mut filter = QueryFilter {
            id: String::from("f1"),
            column_id: String::from("city"),
            scalar_type: QueryScalarType::Number,
            operator: FilterOperator::GreaterThan,
            values: vec![String::from("10")],
        };
        let mut plan = QueryPlan {
            filters: vec![filter.clone()],
            search: None,
            sort: Vec::new(),
            projection: Vec::new(),
        };
        assert!(plan.validate(&columns()).is_err());
        filter.scalar_type = QueryScalarType::Text;
        filter.operator = FilterOperator::Equals;
        plan.filters = vec![
            filter.clone(),
            QueryFilter {
                id: String::from("f2"),
                ..filter
            },
        ];
        assert!(plan.validate(&columns()).is_err());
    }

    #[test]
    fn qry_contract_rejects_invalid_typed_literals_before_duckdb() {
        assert!(validate_literal(QueryScalarType::Number, "not-a-number").is_err());
        assert!(validate_literal(QueryScalarType::Date, "2025-02-29").is_err());
        assert!(validate_literal(QueryScalarType::Date, "2024-02-29").is_ok());
    }

    #[test]
    fn qry_contract_accepts_one_of_and_rejects_wrong_operator_or_arity() {
        let filter = QueryFilter {
            id: String::from("f1"),
            column_id: String::from("city"),
            scalar_type: QueryScalarType::Text,
            operator: FilterOperator::OneOf,
            values: vec![String::from("Seoul"), String::from("Busan")],
        };
        let plan = QueryPlan {
            filters: vec![filter.clone()],
            search: None,
            sort: Vec::new(),
            projection: Vec::new(),
        };
        assert!(plan.validate(&columns()).is_ok());
        let mut invalid = plan;
        invalid.filters[0].operator = FilterOperator::Between;
        assert!(invalid.validate(&columns()).is_err());
    }

    #[test]
    fn page_002_query_page_projection_boundaries_match_wire_contract() {
        let valid = ReadQueryPageRequest {
            document_id: String::from("document-1"),
            session_id: String::from("session-1"),
            query_id: String::from("query-1"),
            offset: 0,
            limit: 200,
            columns: vec![String::from("value")],
        };
        assert!(valid.validate().is_ok());

        let mut invalid = valid.clone();
        invalid.columns.clear();
        assert!(invalid.validate().is_err());
        invalid.columns = vec![String::from("value"), String::from("value")];
        assert!(invalid.validate().is_err());
        invalid.columns = (0..65).map(|index| format!("column-{index}")).collect();
        assert!(invalid.validate().is_err());
        invalid.columns = vec![String::from(" ")];
        assert!(invalid.validate().is_err());
    }
}
