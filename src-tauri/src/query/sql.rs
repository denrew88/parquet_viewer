use crate::{
    data::{
        query_invalid_name as invalid_name, query_quote_identifier as quote_identifier,
        query_quote_literal as quote_literal, query_raw_name as raw_name, QuerySourceSpec,
    },
    domain::{
        scalar_type_for_column, FilterOperator, QueryPlan, QueryScalarType, QuerySearchMode,
        QuerySortDirection,
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
                "SELECT q.__dv_result_position, {target_order} AS target_order, {} AS column_id FROM query_result q JOIN dv_source s USING (__dv_row_id) WHERE {predicate}",
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

pub fn materialize_sql(source: &QuerySourceSpec, plan: &QueryPlan) -> MaterializeSql {
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
    let mut select = Vec::new();
    for (output_index, source_index) in projected.iter().copied().enumerate() {
        let column = &source.columns[source_index];
        select.push(format!(
            "CAST({} AS VARCHAR) AS {}, CAST({} AS VARCHAR) AS {}, {} AS {}",
            quote_identifier(&column.name),
            quote_identifier(&column.name),
            raw_name(source_index),
            output_raw_name(output_index),
            invalid_name(source_index),
            output_invalid_name(output_index)
        ));
    }
    select.push(String::from("__dv_row_id"));

    let mut parameters = Vec::new();
    let mut predicates = Vec::new();
    for filter in &plan.filters {
        let column_index = source
            .columns
            .iter()
            .position(|column| column.name == filter.column_id)
            .expect("validated filter column");
        let column = typed_column(&quote_identifier(&filter.column_id), filter.scalar_type);
        let invalid = invalid_name(column_index);
        predicates.push(filter_predicate(
            &column,
            &invalid,
            filter.scalar_type,
            filter.operator,
            &filter.values,
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
                typed_column(
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
    MaterializeSql {
        sql: format!(
            "CREATE TABLE query_result AS SELECT {}, row_number() OVER (ORDER BY {}) - 1 AS __dv_result_position FROM dv_source{} ORDER BY {}",
            select.join(", "),
            order_sql,
            where_clause,
            order_sql
        ),
        parameters,
        columns: projected,
    }
}

fn filter_predicate(
    column: &str,
    invalid: &str,
    scalar: QueryScalarType,
    operator: FilterOperator,
    values: &[String],
    parameters: &mut Vec<String>,
) -> String {
    let placeholder = || format!("TRY_CAST(? AS {})", scalar_sql_type(scalar));
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

pub fn output_raw_name(index: usize) -> String {
    quote_identifier(&format!("__dv_result_raw_{index}"))
}

pub fn output_invalid_name(index: usize) -> String {
    quote_identifier(&format!("__dv_result_invalid_{index}"))
}

pub fn scalar_sql_type(scalar: QueryScalarType) -> &'static str {
    match scalar {
        QueryScalarType::Text | QueryScalarType::Other => "VARCHAR",
        QueryScalarType::Number => "DOUBLE",
        QueryScalarType::Decimal => "DECIMAL(38, 9)",
        QueryScalarType::Date => "DATE",
        QueryScalarType::Timestamp => "TIMESTAMPTZ",
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
        let sql = materialize_sql(&source, &plan);
        assert!(!sql.sql.contains("OR true"));
        assert_eq!(sql.parameters, ["x' OR true --"]);
        assert!(sql.sql.contains("\"odd\"\"name\""));
    }
}
