use crate::{
    data::{
        duration_unit_from_logical_type, parse_query_duration, query_invalid_name as invalid_name,
        query_quote_identifier as quote_identifier, query_quote_literal as quote_literal,
        QuerySourceSpec,
    },
    domain::{
        scalar_type_for_column, DataError, FilterOperator, QueryPlan, QueryScalarType,
        QuerySearchMode, QuerySortDirection,
    },
};

pub const SCALAR_LOWER_FUNCTION: &str = "dv_scalar_lower";

pub fn scalar_lower_sql(expression: &str) -> String {
    format!("{SCALAR_LOWER_FUNCTION}({expression})")
}

#[derive(Debug)]
pub struct MaterializeSql {
    pub sql: String,
    pub parameters: Vec<String>,
    pub columns: Vec<usize>,
}

pub fn find_matches_sql(
    source: &QuerySourceSpec,
    plan: &QueryPlan,
) -> Option<(String, Vec<String>)> {
    let search = plan.search.as_ref()?;
    if search.mode != QuerySearchMode::Find {
        return None;
    }
    let targets = if search.target_column_ids.is_empty() {
        source
            .columns
            .iter()
            .filter(|column| scalar_type_for_column(column) != QueryScalarType::Other)
            .map(|column| column.name.clone())
            .collect::<Vec<_>>()
    } else {
        search.target_column_ids.clone()
    };
    let selects = targets
        .iter()
        .enumerate()
        .map(|(target_order, target)| {
            let column = format!("s.{}", quote_identifier(target));
            let predicate = match (search.case_sensitive, search.exact) {
                (true, true) => format!("CAST({column} AS VARCHAR) = ?"),
                (false, true) => format!(
                    "{} = {}",
                    scalar_lower_sql(&format!("CAST({column} AS VARCHAR)")),
                    scalar_lower_sql("?")
                ),
                (true, false) => format!("contains(CAST({column} AS VARCHAR), ?)"),
                (false, false) => format!(
                    "contains({}, {})",
                    scalar_lower_sql(&format!("CAST({column} AS VARCHAR)")),
                    scalar_lower_sql("?")
                ),
            };
            format!(
                "SELECT q.rowid AS __dv_result_position, {target_order} AS target_order, {} AS column_id FROM query_result q JOIN dv_source s USING (__dv_row_id) WHERE {predicate}",
                quote_literal(target)
            )
        })
        .collect::<Vec<_>>();
    let body = if selects.is_empty() {
        String::from("SELECT 0::UBIGINT AS __dv_result_position, 0 AS target_order, '' AS column_id WHERE false")
    } else {
        selects.join(" UNION ALL ")
    };
    Some((format!(
        "CREATE TABLE query_find_matches AS SELECT __dv_result_position, column_id, row_number() OVER (ORDER BY __dv_result_position, target_order) - 1 AS match_index FROM ({body}) matches ORDER BY __dv_result_position, target_order"
    ), targets.iter().map(|_| search.text.clone()).collect()))
}

pub fn materialize_sql(
    source: &QuerySourceSpec,
    plan: &QueryPlan,
) -> Result<MaterializeSql, DataError> {
    let projected = if plan.projection.is_empty() {
        (0..source.columns.len()).collect::<Vec<_>>()
    } else {
        plan.projection
            .iter()
            .map(|name| {
                source
                    .columns
                    .iter()
                    .position(|column| &column.name == name)
                    .expect("validated projection")
            })
            .collect()
    };
    let mut parameters = Vec::new();
    let mut predicates = Vec::new();
    for filter in &plan.filters {
        let column_index = source
            .columns
            .iter()
            .position(|column| column.name == filter.column_id)
            .expect("validated filter column");
        let column = typed_source_column(
            source,
            &quote_identifier(&filter.column_id),
            filter.scalar_type,
        );
        let invalid = invalid_name(column_index);
        let values = normalized_filter_values(&source.columns[column_index], filter)?;
        predicates.push(filter_predicate(
            &column,
            &invalid,
            filter.scalar_type,
            source.provider.native_query_types(),
            filter.operator,
            &values,
            &mut parameters,
        ));
    }
    if let Some(search) = &plan.search {
        if search.mode == QuerySearchMode::Filter {
            let targets = if search.target_column_ids.is_empty() {
                source
                    .columns
                    .iter()
                    .filter(|column| scalar_type_for_column(column) != QueryScalarType::Other)
                    .map(|column| column.name.clone())
                    .collect::<Vec<_>>()
            } else {
                search.target_column_ids.clone()
            };
            let mut terms = Vec::new();
            for target in targets {
                let column = quote_identifier(&target);
                parameters.push(search.text.clone());
                let term = match (search.case_sensitive, search.exact) {
                    (true, true) => format!("CAST({column} AS VARCHAR) = ?"),
                    (false, true) => format!(
                        "{} = {}",
                        scalar_lower_sql(&format!("CAST({column} AS VARCHAR)")),
                        scalar_lower_sql("?")
                    ),
                    (true, false) => format!("contains(CAST({column} AS VARCHAR), ?)"),
                    (false, false) => format!(
                        "contains({}, {})",
                        scalar_lower_sql(&format!("CAST({column} AS VARCHAR)")),
                        scalar_lower_sql("?")
                    ),
                };
                terms.push(term);
            }
            if !terms.is_empty() {
                predicates.push(format!("({})", terms.join(" OR ")));
            }
        }
    }
    let where_clause = if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", predicates.join(" AND "))
    };
    let mut order = plan
        .sort
        .iter()
        .map(|sort| {
            let column = source
                .columns
                .iter()
                .find(|column| column.name == sort.column_id)
                .expect("validated sort column");
            format!(
                "{} {} NULLS LAST",
                typed_source_column(
                    source,
                    &quote_identifier(&sort.column_id),
                    scalar_type_for_column(column)
                ),
                match sort.direction {
                    QuerySortDirection::Ascending => "ASC",
                    QuerySortDirection::Descending => "DESC",
                }
            )
        })
        .collect::<Vec<_>>();
    order.push(String::from("__dv_row_id ASC"));
    let order_sql = order.join(", ");
    Ok(MaterializeSql {
        sql: format!(
            "INSERT INTO query_result SELECT __dv_row_id FROM dv_source{where_clause} ORDER BY {order_sql}"
        ),
        parameters,
        columns: projected,
    })
}

fn normalized_filter_values(
    column: &crate::domain::ColumnSchema,
    filter: &crate::domain::QueryFilter,
) -> Result<Vec<String>, DataError> {
    if filter.scalar_type != QueryScalarType::Duration {
        return Ok(filter.values.clone());
    }
    let unit = duration_unit_from_logical_type(&column.logical_type).ok_or_else(|| {
        DataError::invalid_request(format!(
            "Duration column '{}' does not declare a supported source unit.",
            column.name
        ))
    })?;
    filter
        .values
        .iter()
        .map(|value| {
            parse_query_duration(value, unit)
                .map(|count| count.to_string())
                .ok_or_else(|| {
                    DataError::invalid_request(format!(
                        "Duration literal cannot be represented exactly in {}: {value}",
                        column.logical_type
                    ))
                })
        })
        .collect()
}

fn filter_predicate(
    column: &str,
    invalid: &str,
    scalar: QueryScalarType,
    native_query_types: bool,
    operator: FilterOperator,
    values: &[String],
    parameters: &mut Vec<String>,
) -> String {
    let placeholder = || {
        if native_query_types {
            format!("cast_to_type(?, {column})")
        } else {
            format!("TRY_CAST(? AS {})", scalar_sql_type(scalar))
        }
    };
    match operator {
        FilterOperator::IsNull => format!("({column} IS NULL AND NOT {invalid})"),
        FilterOperator::IsNotNull => format!("({column} IS NOT NULL OR {invalid})"),
        FilterOperator::IsInvalid => invalid.to_owned(),
        FilterOperator::IsNotInvalid => format!("NOT {invalid}"),
        FilterOperator::IsTrue => format!("{column} = true"),
        FilterOperator::IsFalse => format!("{column} = false"),
        FilterOperator::OneOf => {
            parameters.extend(values.iter().cloned());
            let marks = values
                .iter()
                .map(|_| {
                    if scalar == QueryScalarType::Text {
                        String::from("?")
                    } else {
                        placeholder()
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("{column} IN ({marks})")
        }
        FilterOperator::Between => {
            parameters.extend(values.iter().cloned());
            format!("{column} BETWEEN {} AND {}", placeholder(), placeholder())
        }
        FilterOperator::Contains | FilterOperator::StartsWith | FilterOperator::EndsWith => {
            parameters.push(values[0].clone());
            match operator {
                FilterOperator::Contains => format!("contains({column}, ?)"),
                FilterOperator::StartsWith => format!("starts_with({column}, ?)"),
                FilterOperator::EndsWith => format!("ends_with({column}, ?)"),
                _ => unreachable!(),
            }
        }
        operator => {
            parameters.push(values[0].clone());
            let mark = if scalar == QueryScalarType::Text {
                String::from("?")
            } else {
                placeholder()
            };
            let comparison = match operator {
                FilterOperator::Equals => "=",
                FilterOperator::NotEquals => "<>",
                FilterOperator::GreaterThan => ">",
                FilterOperator::GreaterThanOrEqual => ">=",
                FilterOperator::LessThan => "<",
                FilterOperator::LessThanOrEqual => "<=",
                _ => unreachable!(),
            };
            format!("{column} {comparison} {mark}")
        }
    }
}

pub fn scalar_sql_type(scalar: QueryScalarType) -> &'static str {
    match scalar {
        QueryScalarType::Text | QueryScalarType::Other => "VARCHAR",
        QueryScalarType::Number => "DOUBLE",
        QueryScalarType::Decimal => "DECIMAL(38, 9)",
        QueryScalarType::Date => "DATE",
        QueryScalarType::Timestamp => "TIMESTAMPTZ",
        QueryScalarType::Duration => "BIGINT",
        QueryScalarType::Boolean => "BOOLEAN",
    }
}

fn typed_column(identifier: &str, scalar: QueryScalarType) -> String {
    if matches!(scalar, QueryScalarType::Text | QueryScalarType::Other) {
        identifier.to_owned()
    } else {
        format!("TRY_CAST({identifier} AS {})", scalar_sql_type(scalar))
    }
}

fn typed_source_column(
    source: &QuerySourceSpec,
    identifier: &str,
    scalar: QueryScalarType,
) -> String {
    if source.provider.native_query_types() {
        identifier.to_owned()
    } else {
        typed_column(identifier, scalar)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{QueryInputProvider, QueryPrepareContext};
    use crate::domain::{ColumnSchema, FilterOperator, QueryFilter, QueryPlan, QueryScalarType};
    use std::{path::PathBuf, sync::Arc};

    #[derive(Debug)]
    struct UnusedProvider;

    impl QueryInputProvider for UnusedProvider {
        fn prepare(
            &self,
            _context: QueryPrepareContext<'_>,
        ) -> Result<(), crate::domain::DataError> {
            unreachable!("SQL construction tests do not prepare query inputs")
        }
    }

    #[derive(Debug)]
    struct NativeTypedProvider;

    impl QueryInputProvider for NativeTypedProvider {
        fn prepare(
            &self,
            _context: QueryPrepareContext<'_>,
        ) -> Result<(), crate::domain::DataError> {
            unreachable!("SQL construction tests do not prepare query inputs")
        }

        fn native_query_types(&self) -> bool {
            true
        }
    }

    #[test]
    fn qry_identifiers_are_quoted_and_literals_are_bound() {
        let source = QuerySourceSpec {
            path: PathBuf::from("C:/data/o'malley.parquet"),
            columns: vec![ColumnSchema {
                name: String::from("odd\"name"),
                logical_type: String::from("String"),
                nullable: true,
                physical_type: String::from("BYTE_ARRAY"),
            }],
            total_rows: Some(1),
            provider: Arc::new(UnusedProvider),
        };
        assert_eq!(quote_literal("o'malley"), "'o''malley'");
        let plan = QueryPlan {
            filters: vec![QueryFilter {
                id: String::from("f"),
                column_id: String::from("odd\"name"),
                scalar_type: QueryScalarType::Text,
                operator: FilterOperator::Equals,
                values: vec![String::from("x' OR true --")],
            }],
            search: None,
            sort: Vec::new(),
            projection: Vec::new(),
        };
        let sql = materialize_sql(&source, &plan).unwrap();
        assert!(!sql.sql.contains("OR true"));
        assert_eq!(sql.parameters, ["x' OR true --"]);
        assert!(sql.sql.contains("\"odd\"\"name\""));
    }

    #[test]
    fn idx_001_materialization_writes_only_ordered_source_identity() {
        let source = QuerySourceSpec {
            path: PathBuf::from("C:/data/source.parquet"),
            columns: vec![ColumnSchema {
                name: String::from("value"),
                logical_type: String::from("Int64"),
                nullable: false,
                physical_type: String::from("INT64"),
            }],
            total_rows: Some(3),
            provider: Arc::new(UnusedProvider),
        };
        let sql = materialize_sql(
            &source,
            &QueryPlan {
                filters: Vec::new(),
                search: None,
                sort: Vec::new(),
                projection: Vec::new(),
            },
        )
        .unwrap();

        assert!(sql
            .sql
            .starts_with("INSERT INTO query_result SELECT __dv_row_id"));
        assert!(sql.sql.ends_with("ORDER BY __dv_row_id ASC"));
        assert!(!sql.sql.contains("row_number"));
        assert!(!sql.sql.contains("__dv_result_position"));
        assert!(!sql.sql.contains("JOIN dv_source"));
    }

    #[test]
    fn parquet_native_numeric_sort_and_filter_do_not_cast_to_double() {
        let source = QuerySourceSpec {
            path: PathBuf::from("C:/data/source.parquet"),
            columns: vec![ColumnSchema {
                name: String::from("group_id"),
                logical_type: String::from("Int64"),
                nullable: false,
                physical_type: String::from("INT64"),
            }],
            total_rows: Some(3),
            provider: Arc::new(NativeTypedProvider),
        };
        let sql = materialize_sql(
            &source,
            &QueryPlan {
                filters: vec![QueryFilter {
                    id: String::from("f"),
                    column_id: String::from("group_id"),
                    scalar_type: QueryScalarType::Number,
                    operator: FilterOperator::GreaterThanOrEqual,
                    values: vec![String::from("1")],
                }],
                search: None,
                sort: vec![crate::domain::QuerySort {
                    column_id: String::from("group_id"),
                    direction: crate::domain::QuerySortDirection::Ascending,
                    nulls_last: true,
                }],
                projection: Vec::new(),
            },
        )
        .unwrap();

        assert!(sql
            .sql
            .contains("\"group_id\" >= cast_to_type(?, \"group_id\")"));
        assert!(sql.sql.contains("ORDER BY \"group_id\" ASC NULLS LAST"));
        assert!(!sql.sql.contains("TRY_CAST(\"group_id\" AS DOUBLE)"));
    }

    #[test]
    fn parquet_native_filter_parameter_preserves_integer_precision_above_2_pow_53() {
        let connection = duckdb::Connection::open_in_memory().unwrap();
        let exact_matches: i64 = connection
            .query_row(
                "SELECT count(*) FROM (VALUES (9007199254740992::BIGINT), (9007199254740993::BIGINT)) values_table(value) WHERE value = cast_to_type(?, value)",
                duckdb::params!["9007199254740993"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(exact_matches, 1);
    }

    #[test]
    fn dur_filter_literals_are_normalized_exactly_to_source_unit() {
        let source = QuerySourceSpec {
            path: PathBuf::from("C:/data/source.parquet"),
            columns: vec![ColumnSchema {
                name: String::from("elapsed"),
                logical_type: String::from("Duration(Millisecond)"),
                nullable: false,
                physical_type: String::from("INT64"),
            }],
            total_rows: Some(3),
            provider: Arc::new(NativeTypedProvider),
        };
        let plan = QueryPlan {
            filters: vec![QueryFilter {
                id: String::from("duration"),
                column_id: String::from("elapsed"),
                scalar_type: QueryScalarType::Duration,
                operator: FilterOperator::Between,
                values: vec![String::from("1s"), String::from("00:00:02.500")],
            }],
            search: None,
            sort: Vec::new(),
            projection: Vec::new(),
        };
        let materialized = materialize_sql(&source, &plan).unwrap();
        assert_eq!(materialized.parameters, ["1000", "2500"]);

        let mut inexact = plan;
        inexact.filters[0].values[0] = String::from("1us");
        assert_eq!(
            materialize_sql(&source, &inexact).unwrap_err().code,
            crate::domain::DataErrorCode::InvalidRequest
        );
    }
}
