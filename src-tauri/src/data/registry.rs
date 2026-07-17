use std::{collections::HashSet, path::Path, sync::OnceLock};

use crate::domain::{DataError, FormatDescriptor};

use super::{
    csv_source::CSV_FORMAT_HANDLER, oes_hdf5_source::OES_HDF5_FORMAT_HANDLER,
    parquet_source::PARQUET_FORMAT_HANDLER, DataSource, FormatHandler,
};

#[derive(Debug)]
pub struct FormatRegistry {
    handlers: Vec<&'static dyn FormatHandler>,
}

impl FormatRegistry {
    pub fn new(handlers: Vec<&'static dyn FormatHandler>) -> Result<Self, DataError> {
        let registry = Self { handlers };
        registry.validate()?;
        Ok(registry)
    }

    pub fn descriptors(&self) -> Vec<FormatDescriptor> {
        self.handlers
            .iter()
            .map(|handler| *handler.descriptor())
            .collect()
    }

    pub fn resolve(&self, path: &Path) -> Option<&'static dyn FormatHandler> {
        let extension = path.extension()?.to_str()?;
        self.handlers.iter().copied().find(|handler| {
            handler
                .descriptor()
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
    }

    pub fn open(&self, path: &Path) -> Result<DataSource, DataError> {
        let handler = self
            .resolve(path)
            .ok_or_else(|| DataError::unsupported_format(path))?;
        handler.open(path).map(DataSource::from_source)
    }

    fn validate(&self) -> Result<(), DataError> {
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        let mut extensions = HashSet::new();
        for handler in &self.handlers {
            let descriptor = handler.descriptor();
            if descriptor.id.as_str().is_empty()
                || descriptor.display_name.trim().is_empty()
                || descriptor.extensions.is_empty()
            {
                return Err(DataError::invalid_request(
                    "Format descriptors require an id, display name, and extension.",
                ));
            }
            if !ids.insert(descriptor.id.as_str()) {
                return Err(DataError::invalid_request(format!(
                    "Duplicate format id: {}",
                    descriptor.id.as_str()
                )));
            }
            if !names.insert(descriptor.display_name) {
                return Err(DataError::invalid_request(format!(
                    "Duplicate format display name: {}",
                    descriptor.display_name
                )));
            }

            let mut descriptor_extensions = HashSet::new();
            for extension in descriptor.extensions {
                let normalized = extension.trim_start_matches('.').to_ascii_lowercase();
                if normalized.is_empty()
                    || normalized != *extension
                    || !normalized
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
                    || !descriptor_extensions.insert(normalized.clone())
                    || !extensions.insert(normalized)
                {
                    return Err(DataError::invalid_request(format!(
                        "Duplicate or invalid extension in {}.",
                        descriptor.display_name
                    )));
                }
            }
            if descriptor
                .mime_types
                .iter()
                .any(|mime| mime.trim().is_empty())
                || descriptor.mime_types.iter().collect::<HashSet<_>>().len()
                    != descriptor.mime_types.len()
                || descriptor.capabilities.iter().collect::<HashSet<_>>().len()
                    != descriptor.capabilities.len()
            {
                return Err(DataError::invalid_request(format!(
                    "{} contains duplicate or invalid descriptor values.",
                    descriptor.display_name
                )));
            }
        }
        Ok(())
    }
}

pub fn builtin_format_registry() -> &'static FormatRegistry {
    static REGISTRY: OnceLock<FormatRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        FormatRegistry::new(vec![
            &CSV_FORMAT_HANDLER,
            &PARQUET_FORMAT_HANDLER,
            &OES_HDF5_FORMAT_HANDLER,
        ])
        .expect("built-in format descriptors must be valid")
    })
}
