mod boundary;
mod csv_profile;
mod csv_source;
mod oes_hdf5_source;
mod parquet_source;
mod registry;
mod source;
pub(crate) mod value_format;

#[cfg(test)]
mod format_contract_tests;
#[cfg(test)]
mod phase2_tests;
#[cfg(test)]
pub(crate) use phase2_tests::type_fixture as phase2_type_fixture;
#[cfg(test)]
mod phase3_tests;

pub(crate) use boundary::find_boundary as resolve_boundary;
pub(crate) use boundary::validate_request as validate_boundary_request;
#[cfg(test)]
pub use parquet_source::ParquetSource;
pub use registry::builtin_format_registry;
#[cfg(test)]
pub use registry::FormatRegistry;
pub(crate) use source::{
    query_invalid_name, query_quote_identifier, query_quote_literal, query_raw_name,
};
pub use source::{
    CsvHeaderConfigurable, CsvProfileConfigurable, CsvQuerySpec, CsvValidationProgress, DataSource,
    FormatHandler, QueryExactValues, QueryInputProvider, QueryPrepareContext, QuerySourceSpec,
    TabularSource,
};
