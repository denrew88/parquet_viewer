mod csv_source;
mod parquet_source;
mod value_format;

#[cfg(test)]
mod phase2_tests;
#[cfg(test)]
mod phase3_tests;

pub use csv_source::CsvSource;
pub use parquet_source::ParquetSource;

use crate::domain::{DataError, DataPage, FileSummary, HeaderMode};
use std::path::Path;

#[derive(Debug)]
pub enum DataSource {
    Parquet(Box<ParquetSource>),
    Csv(CsvSource),
}

impl DataSource {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DataError> {
        let path = path.as_ref();
        match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("parquet") => ParquetSource::open(path).map(Box::new).map(Self::Parquet),
            Some("csv") => CsvSource::open(path, HeaderMode::Auto).map(Self::Csv),
            _ => Err(DataError::unsupported_format(path)),
        }
    }

    pub fn summary(&self) -> FileSummary {
        match self {
            Self::Parquet(source) => source.summary().clone(),
            Self::Csv(source) => source.summary(),
        }
    }

    pub fn read_page_projected(
        &self,
        offset: u64,
        limit: usize,
        columns: Option<&[String]>,
    ) -> Result<DataPage, DataError> {
        match self {
            Self::Parquet(source) => source.read_page_projected(offset, limit, columns),
            Self::Csv(source) => source.read_page_projected(offset, limit, columns),
        }
    }

    #[cfg(test)]
    pub fn configure_csv(&mut self, mode: HeaderMode) -> Result<FileSummary, DataError> {
        match self {
            Self::Csv(source) => {
                source.configure_header(mode)?;
                Ok(source.summary())
            }
            Self::Parquet(_) => Err(DataError::invalid_request(
                "Header mode can only be configured for CSV files.",
            )),
        }
    }

    pub fn prepare_configured_csv(&self, mode: HeaderMode) -> Result<Option<Self>, DataError> {
        match self {
            Self::Csv(source) => source
                .prepare_header(mode)
                .map(|source| source.map(Self::Csv)),
            Self::Parquet(_) => Err(DataError::invalid_request(
                "Header mode can only be configured for CSV files.",
            )),
        }
    }
}
