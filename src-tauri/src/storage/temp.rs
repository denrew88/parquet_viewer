use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use fs2::FileExt;
use serde::Serialize;

use crate::domain::{DataError, DataErrorCode};

pub const QUERY_TEMP_HARD_CAP_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const QUERY_TEMP_SAFETY_RESERVE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const ROOT_CREATE_ATTEMPTS: usize = 40;
const ROOT_CREATE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);
const JANITOR_LOCK_NAME: &str = ".janitor.lock";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTempUsage {
    pub process_bytes: u64,
    pub limit_bytes: u64,
    pub available_bytes: u64,
    pub active_queries: usize,
    pub estimated_temp_bytes: Option<u64>,
    pub safety_reserve_bytes: u64,
    pub hard_cap_bytes: u64,
    pub free_bytes: u64,
}

impl Default for QueryTempUsage {
    fn default() -> Self {
        Self {
            process_bytes: 0,
            limit_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            available_bytes: 0,
            active_queries: 0,
            estimated_temp_bytes: None,
            safety_reserve_bytes: QUERY_TEMP_SAFETY_RESERVE_BYTES,
            hard_cap_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            free_bytes: 0,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTempCleanupResult {
    pub deleted_bytes: u64,
    pub orphan_failure_count: usize,
    pub cleanup_failures: Vec<String>,
    pub remaining_usage: QueryTempUsage,
}

#[derive(Debug)]
pub struct QueryTempManager {
    root: PathBuf,
    process_directory: PathBuf,
    owner_lock: Mutex<Option<File>>,
    active_paths: Arc<Mutex<HashSet<PathBuf>>>,
    active_queries: Arc<AtomicUsize>,
    limit_bytes: AtomicU64,
}

#[derive(Debug)]
pub struct QueryTempLease {
    path: PathBuf,
    active_paths: Arc<Mutex<HashSet<PathBuf>>>,
    active_queries: Arc<AtomicUsize>,
}

impl QueryTempManager {
    pub fn open(root: impl Into<PathBuf>, limit_bytes: u64) -> Result<Self, DataError> {
        let root = root.into().join("query-temp");
        ensure_directory(&root)?;
        let process_directory = root.join(format!("{}-{}", std::process::id(), unique_nonce()));
        fs::create_dir(&process_directory).map_err(|error| temp_io(&process_directory, error))?;
        let lock_path = process_directory.join("owner.lock");
        let mut owner_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .map_err(|error| temp_io(&lock_path, error))?;
        owner_lock
            .try_lock_exclusive()
            .map_err(|error| temp_io(&lock_path, error))?;
        writeln!(owner_lock, "pid={}", std::process::id())
            .and_then(|()| owner_lock.sync_all())
            .map_err(|error| temp_io(&lock_path, error))?;
        // Startup cleanup is best-effort. This process publishes and locks its
        // owner marker first, so a concurrent janitor can never collect it.
        let _ = cleanup_orphans(&root);
        Ok(Self {
            root,
            process_directory,
            owner_lock: Mutex::new(Some(owner_lock)),
            active_paths: Arc::new(Mutex::new(HashSet::new())),
            active_queries: Arc::new(AtomicUsize::new(0)),
            limit_bytes: AtomicU64::new(effective_limit(limit_bytes)),
        })
    }

    pub fn set_limit(&self, limit_bytes: u64) {
        self.limit_bytes
            .store(effective_limit(limit_bytes), Ordering::Release);
    }

    pub fn allocate(&self, document_id: &str, query_id: &str) -> Result<QueryTempLease, DataError> {
        validate_identity(document_id)?;
        validate_identity(query_id)?;
        let usage = self.usage()?;
        if usage.process_bytes >= usage.limit_bytes {
            return Err(DataError::query_temp_limit(
                "The process query temporary storage limit has been reached.",
            ));
        }
        if usage.free_bytes <= QUERY_TEMP_SAFETY_RESERVE_BYTES {
            return Err(DataError::query_temp_limit(format!(
                "Query requires free disk space above the fixed safety reserve of {QUERY_TEMP_SAFETY_RESERVE_BYTES} bytes."
            )));
        }
        let path = self
            .process_directory
            .join(identity_component(document_id))
            .join(identity_component(query_id));
        if path.exists() {
            return Err(DataError::invalid_request(
                "A temporary directory already exists for this query identity.",
            ));
        }
        fs::create_dir_all(&path).map_err(|error| temp_io(&path, error))?;
        self.active_paths
            .lock()
            .map_err(|_| temp_unavailable())?
            .insert(path.clone());
        self.active_queries.fetch_add(1, Ordering::AcqRel);
        Ok(QueryTempLease {
            path,
            active_paths: Arc::clone(&self.active_paths),
            active_queries: Arc::clone(&self.active_queries),
        })
    }

    pub fn usage(&self) -> Result<QueryTempUsage, DataError> {
        let free_bytes = fs2::available_space(&self.process_directory)
            .map_err(|error| temp_io(&self.process_directory, error))?;
        Ok(QueryTempUsage {
            process_bytes: directory_bytes(&self.process_directory)?,
            limit_bytes: self.limit_bytes.load(Ordering::Acquire),
            available_bytes: free_bytes,
            active_queries: self.active_queries.load(Ordering::Acquire),
            estimated_temp_bytes: None,
            safety_reserve_bytes: QUERY_TEMP_SAFETY_RESERVE_BYTES,
            hard_cap_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            free_bytes,
        })
    }

    pub fn clear_inactive(&self) -> Result<QueryTempCleanupResult, DataError> {
        let bytes_before = directory_bytes_best_effort(&self.root);
        let active = self
            .active_paths
            .lock()
            .map_err(|_| temp_unavailable())?
            .clone();
        let mut failures = cleanup_orphans(&self.root)?;
        for document in read_directories(&self.process_directory)? {
            for query in read_directories(&document)? {
                if !active.contains(&query) {
                    if let Err(error) =
                        remove_with_retry(&query, std::time::Duration::from_millis(100))
                    {
                        failures.push(format!("{}: {error}", query.display()));
                    }
                }
            }
            if fs::read_dir(&document)
                .map_err(|error| temp_io(&document, error))?
                .next()
                .is_none()
            {
                let _ = fs::remove_dir(&document);
            }
        }
        let remaining_usage = self.usage()?;
        let bytes_after = directory_bytes_best_effort(&self.root);
        Ok(QueryTempCleanupResult {
            deleted_bytes: bytes_before.saturating_sub(bytes_after),
            orphan_failure_count: failures.len(),
            cleanup_failures: failures,
            remaining_usage,
        })
    }

    pub fn budget_violation(&self) -> Result<Option<String>, DataError> {
        let usage = self.usage()?;
        if usage.process_bytes >= usage.limit_bytes {
            return Ok(Some(format!(
                "Query temporary storage exceeded the process limit of {} bytes.",
                usage.limit_bytes
            )));
        }
        if usage.free_bytes <= QUERY_TEMP_SAFETY_RESERVE_BYTES {
            return Ok(Some(format!(
                "Query stopped to preserve the fixed safety reserve of {QUERY_TEMP_SAFETY_RESERVE_BYTES} bytes of free disk space."
            )));
        }
        Ok(None)
    }

    pub fn shutdown_cleanup(&self, timeout: std::time::Duration) {
        if let Ok(mut lock) = self.owner_lock.lock() {
            if let Some(file) = lock.take() {
                let _ = FileExt::unlock(&file);
                drop(file);
            }
        }
        let _ = remove_with_retry(&self.process_directory, timeout);
    }

    #[cfg(test)]
    pub fn process_directory(&self) -> &Path {
        &self.process_directory
    }
}

fn effective_limit(configured_limit: u64) -> u64 {
    configured_limit.min(QUERY_TEMP_HARD_CAP_BYTES)
}

impl QueryTempLease {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for QueryTempLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_paths.lock() {
            active.remove(&self.path);
        }
        self.active_queries.fetch_sub(1, Ordering::AcqRel);
        let _ = remove_with_retry(&self.path, std::time::Duration::from_millis(100));
        if let Some(parent) = self.path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

impl Drop for QueryTempManager {
    fn drop(&mut self) {
        if let Ok(lock) = self.owner_lock.get_mut() {
            if let Some(file) = lock.take() {
                let _ = FileExt::unlock(&file);
                drop(file);
            }
        }
        let _ = remove_with_retry(&self.process_directory, std::time::Duration::from_secs(3));
    }
}

fn cleanup_orphans(root: &Path) -> Result<Vec<String>, DataError> {
    let janitor_path = root.join(JANITOR_LOCK_NAME);
    let janitor = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&janitor_path)
    {
        Ok(lock) => lock,
        // An inaccessible coordinator is uncertain. Startup and manual cleanup
        // must leave every process directory untouched in this case.
        Err(_) => return Ok(Vec::new()),
    };
    if janitor.try_lock_exclusive().is_err() {
        return Ok(Vec::new());
    }
    let result = cleanup_orphans_with_janitor(root);
    let _ = FileExt::unlock(&janitor);
    result
}

fn cleanup_orphans_with_janitor(root: &Path) -> Result<Vec<String>, DataError> {
    let mut failures = Vec::new();
    for directory in read_directories(root)? {
        let lock_path = directory.join("owner.lock");
        let mut lock = match OpenOptions::new().read(true).write(true).open(&lock_path) {
            Ok(lock) => lock,
            // A missing or inaccessible lock can be an active process between
            // directory creation and lock publication. Uncertainty is retained.
            Err(_) => continue,
        };
        if lock.try_lock_exclusive().is_ok() {
            let mut marker = String::new();
            let published = lock.seek(SeekFrom::Start(0)).is_ok()
                && lock.read_to_string(&mut marker).is_ok()
                && valid_owner_marker(&marker);
            let _ = FileExt::unlock(&lock);
            drop(lock);
            if !published {
                continue;
            }
            if let Err(error) = remove_with_retry(&directory, std::time::Duration::from_millis(100))
            {
                failures.push(format!("{}: {error}", directory.display()));
            }
        }
    }
    Ok(failures)
}

fn ensure_directory(path: &Path) -> Result<(), DataError> {
    for attempt in 0..ROOT_CREATE_ATTEMPTS {
        match fs::create_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if path.is_dir() {
                    return Ok(());
                }
                let transient = matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied
                        | std::io::ErrorKind::AlreadyExists
                        | std::io::ErrorKind::NotFound
                );
                if !transient || attempt + 1 == ROOT_CREATE_ATTEMPTS {
                    return Err(temp_io(path, error));
                }
                std::thread::sleep(ROOT_CREATE_RETRY_DELAY);
            }
        }
    }
    unreachable!("directory creation retry loop always returns")
}

fn valid_owner_marker(marker: &str) -> bool {
    marker
        .strip_prefix("pid=")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .is_some()
}

fn remove_with_retry(path: &Path, timeout: std::time::Duration) -> std::io::Result<()> {
    let started = std::time::Instant::now();
    loop {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_error) if started.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => {
                let pending = path.with_file_name(format!(
                    ".delete-pending-{}-{}",
                    std::process::id(),
                    unique_nonce()
                ));
                return fs::rename(path, pending).or(Err(error));
            }
        }
    }
}

fn read_directories(path: &Path) -> Result<Vec<PathBuf>, DataError> {
    Ok(fs::read_dir(path)
        .map_err(|error| temp_io(path, error))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect())
}

fn directory_bytes(path: &Path) -> Result<u64, DataError> {
    let mut bytes = 0_u64;
    for entry in fs::read_dir(path).map_err(|error| temp_io(path, error))? {
        let entry = entry.map_err(|error| temp_io(path, error))?;
        let metadata = entry
            .metadata()
            .map_err(|error| temp_io(&entry.path(), error))?;
        bytes = bytes.saturating_add(if metadata.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            metadata.len()
        });
    }
    Ok(bytes)
}

fn directory_bytes_best_effort(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok().map(|metadata| (entry, metadata)))
        .fold(0_u64, |bytes, (entry, metadata)| {
            bytes.saturating_add(if metadata.is_dir() {
                directory_bytes_best_effort(&entry.path())
            } else {
                metadata.len()
            })
        })
}

fn validate_identity(value: &str) -> Result<(), DataError> {
    if value.trim().is_empty() || value.len() > 128 {
        return Err(DataError::invalid_request(
            "Query identities must contain 1 to 128 characters.",
        ));
    }
    Ok(())
}

fn identity_component(value: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn unique_nonce() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{timestamp:x}-{:x}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn temp_unavailable() -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: String::from("The query temporary storage registry is unavailable."),
    }
}

fn temp_io(path: &Path, error: impl std::fmt::Display) -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: format!(
            "Query temporary storage failed at {}: {error}",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_budget_uses_fixed_reserve_and_ten_gib_hard_cap() {
        assert_eq!(QUERY_TEMP_SAFETY_RESERVE_BYTES, 5 * 1024 * 1024 * 1024);
        assert_eq!(QUERY_TEMP_HARD_CAP_BYTES, 10 * 1024 * 1024 * 1024);
        assert_eq!(effective_limit(64 * 1024 * 1024), 64 * 1024 * 1024);
        assert_eq!(
            effective_limit(1024 * 1024 * 1024 * 1024),
            QUERY_TEMP_HARD_CAP_BYTES
        );
    }

    #[test]
    fn temp_usage_wire_separates_estimate_reserve_cap_and_free_space() {
        let usage = QueryTempUsage {
            process_bytes: 100,
            limit_bytes: 200,
            available_bytes: 300,
            active_queries: 1,
            estimated_temp_bytes: None,
            safety_reserve_bytes: QUERY_TEMP_SAFETY_RESERVE_BYTES,
            hard_cap_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            free_bytes: 300,
        };
        let json = serde_json::to_value(usage).unwrap();
        assert!(json["estimatedTempBytes"].is_null());
        assert_eq!(json["safetyReserveBytes"], QUERY_TEMP_SAFETY_RESERVE_BYTES);
        assert_eq!(json["hardCapBytes"], QUERY_TEMP_HARD_CAP_BYTES);
        assert_eq!(json["freeBytes"], 300);
        assert_eq!(json["availableBytes"], 300);
    }

    #[test]
    fn tmp_lease_is_bounded_and_cleans_up_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let manager = QueryTempManager::open(directory.path(), 64 * 1024 * 1024).unwrap();
        let lease = manager.allocate("document/../../one", "query-one").unwrap();
        let path = lease.path().to_owned();
        assert!(path.starts_with(manager.process_directory()));
        fs::write(path.join("spill.bin"), vec![0_u8; 1024]).unwrap();
        assert!(manager.usage().unwrap().process_bytes >= 1024);
        drop(lease);
        assert!(!path.exists());
    }

    #[test]
    fn tmp_clear_reports_deleted_bytes_failures_and_remaining_usage() {
        let directory = tempfile::tempdir().unwrap();
        let manager = QueryTempManager::open(directory.path(), 64 * 1024 * 1024).unwrap();
        let inactive = manager
            .process_directory()
            .join("inactive-document")
            .join("inactive-query");
        fs::create_dir_all(&inactive).unwrap();
        fs::write(inactive.join("spill.bin"), vec![1_u8; 4_096]).unwrap();
        let root = manager.process_directory().parent().unwrap();
        let orphan = root.join("published-orphan");
        fs::create_dir(&orphan).unwrap();
        fs::write(orphan.join("owner.lock"), b"pid=9999\n").unwrap();
        fs::write(orphan.join("spill.bin"), vec![2_u8; 2_048]).unwrap();

        let result = manager.clear_inactive().unwrap();

        assert!(result.deleted_bytes >= 6_144);
        assert_eq!(result.orphan_failure_count, 0);
        assert!(result.cleanup_failures.is_empty());
        assert_eq!(result.remaining_usage.active_queries, 0);
        assert!(!inactive.exists());
        assert!(!orphan.exists());
        let json = serde_json::to_value(result).unwrap();
        assert!(json["deletedBytes"].as_u64().unwrap() >= 6_144);
        assert_eq!(json["orphanFailureCount"], 0);
        assert!(json["cleanupFailures"].as_array().unwrap().is_empty());
        assert!(json["remainingUsage"].is_object());
    }

    #[test]
    fn tmp_janitor_preserves_locked_process_and_removes_unlocked_orphan() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("query-temp");
        fs::create_dir_all(&root).unwrap();
        let active = root.join("active");
        fs::create_dir(&active).unwrap();
        let active_lock = File::create(active.join("owner.lock")).unwrap();
        active_lock.try_lock_exclusive().unwrap();
        let orphan = root.join("orphan");
        fs::create_dir(&orphan).unwrap();
        fs::write(orphan.join("owner.lock"), b"pid=1234\n").unwrap();
        let unpublished = root.join("unpublished");
        fs::create_dir(&unpublished).unwrap();
        File::create(unpublished.join("owner.lock")).unwrap();

        cleanup_orphans(&root).unwrap();
        assert!(active.exists());
        assert!(!orphan.exists());
        assert!(unpublished.exists());
        FileExt::unlock(&active_lock).unwrap();
    }

    #[test]
    fn tmp_concurrent_absent_root_creation_never_collects_active_managers() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_owned();
        let workers = 24;
        let start = Arc::new(std::sync::Barrier::new(workers));
        let opened = Arc::new(AtomicUsize::new(0));
        std::thread::scope(|scope| {
            let handles = (0..workers)
                .map(|_| {
                    let root = root.clone();
                    let start = Arc::clone(&start);
                    let opened = Arc::clone(&opened);
                    scope.spawn(move || {
                        start.wait();
                        let manager = QueryTempManager::open(root, 64 * 1024 * 1024).unwrap();
                        let process = manager.process_directory().to_owned();
                        opened.fetch_add(1, Ordering::AcqRel);
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(5);
                        while opened.load(Ordering::Acquire) != workers
                            && std::time::Instant::now() < deadline
                        {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        assert_eq!(opened.load(Ordering::Acquire), workers);
                        assert!(process.exists());
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                handle.join().unwrap();
            }
        });
        assert!(root.join("query-temp").is_dir());
        assert!(root.join("query-temp").join(JANITOR_LOCK_NAME).is_file());
    }

    #[test]
    fn tmp_concurrent_janitor_losers_skip_cleanup_until_lock_is_available() {
        let directory = tempfile::tempdir().unwrap();
        let app_root = directory.path().to_owned();
        let root = app_root.join("query-temp");
        fs::create_dir(&root).unwrap();
        let orphan = root.join("orphan");
        fs::create_dir(&orphan).unwrap();
        fs::write(orphan.join("owner.lock"), b"pid=4321\n").unwrap();
        let janitor_path = root.join(JANITOR_LOCK_NAME);
        let janitor = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&janitor_path)
            .unwrap();
        janitor.try_lock_exclusive().unwrap();

        let workers = 16;
        let start = Arc::new(std::sync::Barrier::new(workers + 1));
        let opened = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        std::thread::scope(|scope| {
            let handles = (0..workers)
                .map(|_| {
                    let app_root = app_root.clone();
                    let start = Arc::clone(&start);
                    let opened = Arc::clone(&opened);
                    let release = Arc::clone(&release);
                    scope.spawn(move || {
                        start.wait();
                        let manager = QueryTempManager::open(app_root, 64 * 1024 * 1024).unwrap();
                        let process = manager.process_directory().to_owned();
                        opened.fetch_add(1, Ordering::AcqRel);
                        while !release.load(Ordering::Acquire) {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        assert!(process.exists());
                    })
                })
                .collect::<Vec<_>>();
            start.wait();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while opened.load(Ordering::Acquire) != workers && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let all_opened = opened.load(Ordering::Acquire) == workers;
            let orphan_preserved = orphan.exists();
            FileExt::unlock(&janitor).unwrap();
            release.store(true, Ordering::Release);
            assert!(all_opened);
            assert!(orphan_preserved);
            for handle in handles {
                handle.join().unwrap();
            }
        });

        cleanup_orphans(&root).unwrap();
        assert!(!orphan.exists());
    }
}
