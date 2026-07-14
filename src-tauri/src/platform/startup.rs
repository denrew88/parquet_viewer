use std::{
    collections::VecDeque,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::commands::{OpenOrigin, OpenPathsRequest};

#[derive(Debug, Default)]
pub struct PendingOpenQueue {
    requests: Mutex<VecDeque<OpenPathsRequest>>,
}

impl PendingOpenQueue {
    pub fn push(&self, request: OpenPathsRequest) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.push_back(request);
        }
    }

    pub fn drain(&self) -> Vec<OpenPathsRequest> {
        self.requests
            .lock()
            .map(|mut requests| requests.drain(..).collect())
            .unwrap_or_default()
    }
}

pub fn normalize_path_operands(
    args: impl IntoIterator<Item = OsString>,
    cwd: &Path,
) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|argument| !argument.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect()
}

pub fn startup_request(request_id: String) -> Option<OpenPathsRequest> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let paths = normalize_path_operands(std::env::args_os().skip(1), &cwd);
    (!paths.is_empty()).then_some(OpenPathsRequest {
        request_id,
        origin: OpenOrigin::StartupArg,
        paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_paths_preserve_spaces_unicode_and_resolve_relative_to_cwd() {
        let cwd = Path::new("C:/fixture root");
        let paths = normalize_path_operands(
            [
                OsString::from("--ignored"),
                OsString::from("공백 파일.csv"),
                OsString::from("C:/절대 경로/data.parquet"),
            ],
            cwd,
        );

        assert_eq!(paths[0], cwd.join("공백 파일.csv"));
        assert_eq!(paths[1], PathBuf::from("C:/절대 경로/data.parquet"));
    }

    #[test]
    fn no_operands_is_an_empty_request_list() {
        assert!(normalize_path_operands(Vec::<OsString>::new(), Path::new("C:/cwd")).is_empty());
    }
}
