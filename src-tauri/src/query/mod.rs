//! Bounded DuckDB query execution and result lifecycle.

mod engine;
#[cfg(test)]
mod phase13_large_tests;
mod sql;

#[allow(unused_imports)]
pub use engine::{CsvPreparationState, CsvPreparationStatus, QueryService};
