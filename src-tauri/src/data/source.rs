use std::{
    fmt::Debug,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

use duckdb::Connection;

use crate::domain::{
    ColumnSchema, CsvColumnValidation, CsvParsingProfile, CsvProfilePreview, DataError, DataPage,
    FileSummary, FormatDescriptor, HeaderMode, ValueKind,
};

#[derive(Debug, Clone)]
pub struct QuerySourceSpec {
    pub path: std::path::PathBuf,
    pub columns: Vec<ColumnSchema>,
    pub total_rows: Option<u64>,
    pub provider: Arc<dyn QueryInputProvider>,
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
    pub cancel: &'a AtomicBool,
    pub progress: &'a mut QueryPrepareProgress<'a>,
}

pub trait QueryInputProvider: Debug + Send + Sync {
    fn prepare(&self, context: QueryPrepareContext<'_>) -> Result<(), DataError>;

    fn format_query_display(&self, _column: &str, _kind: ValueKind, value: &str) -> String {
        value.to_owned()
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

    pub fn query_source_spec(&self) -> Result<QuerySourceSpec, DataError> {
        self.inner.query_source_spec()
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
