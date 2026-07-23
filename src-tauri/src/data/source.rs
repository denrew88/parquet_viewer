use std::{
    fmt::Debug,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

use duckdb::Connection;

use crate::domain::{
    BoundarySearchRequest, BoundarySearchResult, ColumnSchema, CsvColumnValidation,
    CsvParsingProfile, CsvProfilePreview, DataError, DataPage, FileSummary, FormatDescriptor,
    HeaderMode,
};

#[derive(Debug, Clone)]
pub struct QuerySourceSpec {
    pub path: std::path::PathBuf,
    pub columns: Vec<ColumnSchema>,
    pub total_rows: Option<u64>,
    pub provider: Arc<dyn QueryInputProvider>,
}

pub struct QueryExactValues {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<crate::domain::DataValue>>,
}

#[derive(Debug, Clone)]
pub struct CsvQuerySpec {
    pub header_used: bool,
    pub profile: CsvParsingProfile,
}

pub type QueryPrepareProgress<'a> = dyn FnMut(u64) -> Result<(), DataError> + 'a;

pub struct QueryPrepareContext<'a> {
    pub connection: &'a Connection,
    pub source: &'a QuerySourceSpec,
    /// Stable handle used by reusable CSV preparation. Providers that do not
    /// scan a local source directly receive `None`.
    pub source_file: Option<&'a std::fs::File>,
    pub artifact_directory: &'a Path,
    pub cancel: &'a AtomicBool,
    pub progress: &'a mut QueryPrepareProgress<'a>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueryPreparationMetrics {
    /// Bytes consumed by this provider's preparation reader. It is not a
    /// process-wide or source-lifetime I/O counter.
    pub source_read_bytes: u64,
    pub cache_output_bytes: u64,
    pub navigation_frontier_row: u64,
    pub state_bitmap_bytes: u64,
    pub peak_decoded_batch_bytes: u64,
    pub record_batches_accepted: u64,
    pub max_accepted_batch_rows: u64,
    pub adaptive_batch_growths: u64,
    pub adaptive_batch_shrinks: u64,
    pub parquet_close_budget_checks: u64,
}

pub trait QueryInputProvider: Debug + Send + Sync {
    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError>;

    /// Whether the visible columns in `dv_source` retain their native logical
    /// types. CSV deliberately stores converted display values as VARCHAR and
    /// therefore still needs typed casts in predicates and ordering.
    fn native_query_types(&self) -> bool {
        false
    }

    /// Stable identity for a session-owned reusable query artifact. Providers
    /// returning `None` always use the direct prepare path.
    fn reusable_source_identity(&self) -> Option<String> {
        None
    }

    /// Extra read-only database path required by a reusable provider wrapper.
    fn prepared_artifact_path(&self) -> Option<&Path> {
        None
    }

    /// Source-order navigation accelerated by a provider-owned state index.
    /// Returning `None` delegates to the generic bounded page reader.
    fn source_boundary(
        &self,
        _request: &BoundarySearchRequest,
        _cancel: &AtomicBool,
    ) -> Result<Option<BoundarySearchResult>, DataError> {
        Ok(None)
    }

    fn preparation_metrics(&self) -> QueryPreparationMetrics {
        QueryPreparationMetrics::default()
    }

    /// Restores provider-owned background metadata work when preparation could
    /// not start (for example, temp lease allocation failed).
    fn preparation_aborted(&self) {}

    fn restore_prepared_state(
        &self,
        _states_path: &Path,
        _rows: u64,
        _columns: usize,
    ) -> Result<(), DataError> {
        Err(DataError::query_failed(
            "The query source cannot restore a persistent preparation state.",
        ))
    }

    fn sparse_query_values(
        &self,
        _row_ids: &[u64],
        _columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        Err(DataError::query_failed(
            "The query source does not support sparse projected reads.",
        ))
    }

    fn occupancy_states(&self, row_ids: &[u64], column: &str) -> Result<Vec<bool>, DataError> {
        let values = self.sparse_query_values(row_ids, &[column.to_owned()])?;
        if values.rows.len() != row_ids.len() || values.rows.iter().any(|row| row.len() != 1) {
            return Err(DataError::query_failed(
                "A source occupancy read returned a mismatched shape.",
            ));
        }
        Ok(values
            .rows
            .into_iter()
            .map(|row| {
                matches!(
                    row[0].state,
                    crate::domain::DataValueState::Valid | crate::domain::DataValueState::Invalid
                )
            })
            .collect())
    }

    /// Returns a source-wide occupancy invariant when metadata can prove that
    /// every value in a column is either occupied (`true`) or empty (`false`).
    /// A filtered/sorted query preserves that invariant, so boundary navigation
    /// can jump to the result edge without reading every source row.
    fn uniform_occupancy(&self, _column: &str) -> Option<bool> {
        None
    }

    fn copy_query_values(
        &self,
        row_ids: &[u64],
        columns: &[String],
    ) -> Result<QueryExactValues, DataError> {
        self.sparse_query_values(row_ids, columns)
    }

    /// Reads a contiguous source-row range without materialising an `IN (...)`
    /// identity list. Providers with an indexed, reusable artifact can override
    /// this for page and source-order copy workloads.
    fn contiguous_query_values(
        &self,
        _offset: u64,
        _limit: usize,
        _columns: &[String],
    ) -> Result<Option<QueryExactValues>, DataError> {
        Ok(None)
    }
}

pub(crate) fn query_quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(crate) fn query_quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(crate) fn query_raw_name(index: usize) -> String {
    query_quote_identifier(&format!("__dv_raw_{index}"))
}

pub(crate) fn query_invalid_name(index: usize) -> String {
    query_quote_identifier(&format!("__dv_invalid_{index}"))
}

pub type CsvValidationProgress<'a> = dyn FnMut(u64, Option<u64>, &[CsvColumnValidation]) + 'a;

pub trait CsvHeaderConfigurable: Send + Sync {
    fn prepare_header(&self, mode: HeaderMode)
        -> Result<Option<Box<dyn TabularSource>>, DataError>;
}

pub trait CsvProfileConfigurable: Send + Sync {
    fn active_profile(&self) -> CsvParsingProfile;

    fn preview_profile(
        &self,
        profile: &CsvParsingProfile,
        generation: u64,
        cancel: &AtomicBool,
    ) -> Result<CsvProfilePreview, DataError>;

    fn validate_profile(
        &self,
        profile: &CsvParsingProfile,
        cancel: &AtomicBool,
        progress: &mut CsvValidationProgress<'_>,
    ) -> Result<Vec<CsvColumnValidation>, DataError>;

    fn prepare_profile(
        &self,
        profile: &CsvParsingProfile,
    ) -> Result<Box<dyn TabularSource>, DataError>;
}

pub trait TabularSource: Debug + Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;

    fn summary(&self) -> FileSummary;

    fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError>;

    fn read_copy_projected(
        &self,
        _offset: u64,
        _limit: usize,
        _columns: &[String],
    ) -> Result<DataPage, DataError> {
        Err(DataError::invalid_request(
            "This source does not support bulk projected copy reads.",
        ))
    }

    fn read_cell_value(
        &self,
        row: u64,
        column: &str,
    ) -> Result<crate::domain::DataValue, DataError> {
        let columns = [column.to_owned()];
        let page = self.read_page_projected(row, 1, Some(&columns))?;
        page.rows
            .into_iter()
            .next()
            .and_then(|mut values| values.pop())
            .ok_or_else(|| {
                DataError::invalid_request("The requested cell is outside the data table.")
            })
    }

    fn find_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        let summary = self.summary();
        super::boundary::find_boundary(
            &summary.columns,
            summary.row_count,
            request,
            cancel,
            |offset, limit, columns| self.read_page_projected(offset, limit, Some(columns)),
        )
    }

    fn query_source_spec(&self) -> Result<QuerySourceSpec, DataError> {
        Err(DataError::invalid_request(
            "This tabular source does not support query execution.",
        ))
    }

    fn cancel_task(&self, _generation: u64) -> Result<FileSummary, DataError> {
        Err(DataError::invalid_request(format!(
            "{} files do not have a cancellable background task.",
            self.descriptor().display_name
        )))
    }

    fn csv_header_configurable(&self) -> Option<&dyn CsvHeaderConfigurable> {
        None
    }

    fn csv_profile_configurable(&self) -> Option<&dyn CsvProfileConfigurable> {
        None
    }
}

pub trait FormatHandler: Debug + Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;

    fn open(&self, path: &Path) -> Result<Box<dyn TabularSource>, DataError>;
}

#[derive(Debug)]
pub struct DataSource {
    inner: Box<dyn TabularSource>,
}

impl DataSource {
    pub(crate) fn from_source(source: Box<dyn TabularSource>) -> Self {
        Self { inner: source }
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, DataError> {
        super::registry::builtin_format_registry().open(path.as_ref())
    }

    pub fn summary(&self) -> FileSummary {
        self.inner.summary()
    }

    pub fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        self.inner.read_page_projected(offset, limit, columns)
    }

    pub(crate) fn read_copy_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.inner.read_copy_projected(offset, limit, columns)
    }

    pub fn read_cell_value(
        &self,
        row: u64,
        column: &str,
    ) -> Result<crate::domain::DataValue, DataError> {
        self.inner.read_cell_value(row, column)
    }

    pub fn query_source_spec(&self) -> Result<QuerySourceSpec, DataError> {
        self.inner.query_source_spec()
    }

    pub fn find_boundary(
        &self,
        request: &BoundarySearchRequest,
        cancel: &AtomicBool,
    ) -> Result<BoundarySearchResult, DataError> {
        self.inner.find_boundary(request, cancel)
    }

    pub fn cancel_task(&self, generation: u64) -> Result<FileSummary, DataError> {
        self.inner.cancel_task(generation)
    }

    #[cfg(test)]
    pub fn configure_csv(&mut self, mode: HeaderMode) -> Result<FileSummary, DataError> {
        if let Some(replacement) = self.prepare_configured_csv(mode)? {
            *self = replacement;
        }
        Ok(self.summary())
    }

    pub fn prepare_configured_csv(&self, mode: HeaderMode) -> Result<Option<Self>, DataError> {
        let configurable = self.inner.csv_header_configurable().ok_or_else(|| {
            DataError::invalid_request("Header mode can only be configured for CSV files.")
        })?;
        configurable
            .prepare_header(mode)
            .map(|source| source.map(Self::from_source))
    }

    fn csv_profile_configurable(&self) -> Result<&dyn CsvProfileConfigurable, DataError> {
        self.inner.csv_profile_configurable().ok_or_else(|| {
            DataError::invalid_request("CSV parsing profiles are only available for CSV files.")
        })
    }

    pub fn active_csv_profile(&self) -> Result<CsvParsingProfile, DataError> {
        Ok(self.csv_profile_configurable()?.active_profile())
    }

    pub fn preview_csv_profile(
        &self,
        profile: &CsvParsingProfile,
        generation: u64,
        cancel: &AtomicBool,
    ) -> Result<CsvProfilePreview, DataError> {
        self.csv_profile_configurable()?
            .preview_profile(profile, generation, cancel)
    }

    pub fn validate_csv_profile(
        &self,
        profile: &CsvParsingProfile,
        cancel: &AtomicBool,
        progress: &mut CsvValidationProgress<'_>,
    ) -> Result<Vec<CsvColumnValidation>, DataError> {
        self.csv_profile_configurable()?
            .validate_profile(profile, cancel, progress)
    }

    pub fn prepare_csv_profile(&self, profile: &CsvParsingProfile) -> Result<Self, DataError> {
        self.csv_profile_configurable()?
            .prepare_profile(profile)
            .map(Self::from_source)
    }
}
