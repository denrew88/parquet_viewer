use std::{
    collections::{HashMap, HashSet},
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
    pub query_temp_bytes: u64,
    pub csv_cache_bytes: u64,
    pub csv_cache_entries: usize,
    pub csv_cache_path: String,
    pub csv_cache_limit_bytes: u64,
    pub csv_cache_effective_limit_bytes: u64,
    pub csv_cache_active_bytes: u64,
    pub csv_cache_active_entries: usize,
    pub csv_cache_available_bytes: u64,
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
            query_temp_bytes: 0,
            csv_cache_bytes: 0,
            csv_cache_entries: 0,
            csv_cache_path: String::new(),
            csv_cache_limit_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            csv_cache_effective_limit_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            csv_cache_active_bytes: 0,
            csv_cache_active_entries: 0,
            csv_cache_available_bytes: 0,
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
    external_cache_bytes: AtomicU64,
    reservations: Arc<Mutex<HashMap<PathBuf, u64>>>,
    pinned_source_aliases: Arc<Mutex<HashMap<PathBuf, PinnedSourceAlias>>>,
}

#[derive(Debug)]
pub struct QueryTempLease {
    path: PathBuf,
    active_paths: Arc<Mutex<HashSet<PathBuf>>>,
    active_queries: Arc<AtomicUsize>,
    reservations: Arc<Mutex<HashMap<PathBuf, u64>>>,
    pinned_source_aliases: Arc<Mutex<HashMap<PathBuf, PinnedSourceAlias>>>,
}

#[derive(Debug)]
struct PinnedSourceAlias {
    identity: (u64, u64),
    // Keeping the original file open prevents its OS identity from being
    // recycled while a registered alias is exempt from allocated-byte usage.
    _pinned_source: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QueryTempBudget {
    pub allowance_bytes: u64,
    pub limit_remaining_bytes: u64,
    pub free_remaining_bytes: u64,
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
            external_cache_bytes: AtomicU64::new(0),
            reservations: Arc::new(Mutex::new(HashMap::new())),
            pinned_source_aliases: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn set_limit(&self, limit_bytes: u64) {
        self.limit_bytes
            .store(effective_limit(limit_bytes), Ordering::Release);
    }

    #[cfg(test)]
    pub fn allocate(&self, document_id: &str, query_id: &str) -> Result<QueryTempLease, DataError> {
        self.allocate_inner(document_id, query_id, None)
    }

    pub(crate) fn allocate_bounded(
        &self,
        document_id: &str,
        query_id: &str,
        per_query_cap: u64,
    ) -> Result<QueryTempLease, DataError> {
        self.allocate_inner(document_id, query_id, Some(per_query_cap))
    }

    fn allocate_inner(
        &self,
        document_id: &str,
        query_id: &str,
        per_query_cap: Option<u64>,
    ) -> Result<QueryTempLease, DataError> {
        validate_identity(document_id)?;
        validate_identity(query_id)?;
        let path = self
            .process_directory
            .join(identity_component(document_id))
            .join(identity_component(query_id));
        if path.exists() {
            return Err(DataError::invalid_request(
                "A temporary directory already exists for this query identity.",
            ));
        }
        if let Some(per_query_cap) = per_query_cap {
            let mut reservations = self.reservations.lock().map_err(|_| temp_unavailable())?;
            let budget = self.budget_locked(per_query_cap, &reservations)?;
            if budget.allowance_bytes == 0 {
                return Err(self.limit_error()?);
            }
            reservations.insert(path.clone(), budget.allowance_bytes);
        } else {
            let usage = self.usage()?;
            if usage.process_bytes >= usage.limit_bytes
                || usage.free_bytes <= QUERY_TEMP_SAFETY_RESERVE_BYTES
            {
                return Err(self.limit_error_from_usage(&usage));
            }
        }
        if let Err(error) = fs::create_dir_all(&path).map_err(|error| temp_io(&path, error)) {
            if per_query_cap.is_some() {
                if let Ok(mut reservations) = self.reservations.lock() {
                    reservations.remove(&path);
                }
            }
            return Err(error);
        }
        let mut active_paths = match self.active_paths.lock() {
            Ok(active_paths) => active_paths,
            Err(_) => {
                if let Ok(mut reservations) = self.reservations.lock() {
                    reservations.remove(&path);
                }
                let _ = remove_with_retry(&path, std::time::Duration::from_millis(100));
                return Err(temp_unavailable());
            }
        };
        active_paths.insert(path.clone());
        drop(active_paths);
        self.active_queries.fetch_add(1, Ordering::AcqRel);
        Ok(QueryTempLease {
            path,
            active_paths: Arc::clone(&self.active_paths),
            active_queries: Arc::clone(&self.active_queries),
            reservations: Arc::clone(&self.reservations),
            pinned_source_aliases: Arc::clone(&self.pinned_source_aliases),
        })
    }

    pub(crate) fn bounded_allowance(
        &self,
        per_query_cap: u64,
    ) -> Result<QueryTempBudget, DataError> {
        let reservations = self.reservations.lock().map_err(|_| temp_unavailable())?;
        self.budget_locked(per_query_cap, &reservations)
    }

    fn budget_locked(
        &self,
        per_query_cap: u64,
        reservations: &HashMap<PathBuf, u64>,
    ) -> Result<QueryTempBudget, DataError> {
        let free_bytes = fs2::available_space(&self.process_directory)
            .map_err(|error| temp_io(&self.process_directory, error))?;
        let query_temp_bytes = self.accounted_directory_bytes(&self.process_directory)?;
        let cache_bytes = self.external_cache_bytes.load(Ordering::Acquire);
        let mut active_bytes = 0_u64;
        let mut charged_reservations = 0_u64;
        let mut reserved_remaining = 0_u64;
        for (path, reservation) in reservations {
            let bytes = self.accounted_directory_bytes(path).unwrap_or(0);
            active_bytes = active_bytes.saturating_add(bytes);
            // CSV output can grow beyond its initial DuckDB spill reservation.
            // Charge the larger amount so a concurrent query cannot reserve
            // space that the converter has already consumed.
            charged_reservations = charged_reservations.saturating_add((*reservation).max(bytes));
            reserved_remaining =
                reserved_remaining.saturating_add(reservation.saturating_sub(bytes));
        }
        let unreserved_bytes = query_temp_bytes.saturating_sub(active_bytes);
        Ok(calculate_query_budget(
            self.limit_bytes.load(Ordering::Acquire),
            cache_bytes.saturating_add(unreserved_bytes),
            charged_reservations,
            free_bytes,
            reserved_remaining,
            per_query_cap,
        ))
    }

    pub fn usage(&self) -> Result<QueryTempUsage, DataError> {
        let free_bytes = fs2::available_space(&self.process_directory)
            .map_err(|error| temp_io(&self.process_directory, error))?;
        let query_temp_bytes = self.accounted_directory_bytes(&self.process_directory)?;
        let csv_cache_bytes = self.external_cache_bytes.load(Ordering::Acquire);
        Ok(QueryTempUsage {
            process_bytes: query_temp_bytes.saturating_add(csv_cache_bytes),
            query_temp_bytes,
            csv_cache_bytes,
            csv_cache_entries: 0,
            csv_cache_path: String::new(),
            csv_cache_limit_bytes: QUERY_TEMP_HARD_CAP_BYTES,
            csv_cache_effective_limit_bytes: self.limit_bytes.load(Ordering::Acquire),
            csv_cache_active_bytes: 0,
            csv_cache_active_entries: 0,
            csv_cache_available_bytes: 0,
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
        let bytes_before = self.accounted_directory_bytes(&self.root)?;
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
        let bytes_after = self.accounted_directory_bytes(&self.root)?;
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
            return Ok(Some(self.limit_error_from_usage(&usage).message));
        }
        if usage.free_bytes <= QUERY_TEMP_SAFETY_RESERVE_BYTES {
            return Ok(Some(self.limit_error_from_usage(&usage).message));
        }
        Ok(None)
    }

    pub(crate) fn limit_error(&self) -> Result<DataError, DataError> {
        Ok(self.limit_error_from_usage(&self.usage()?))
    }

    fn limit_error_from_usage(&self, usage: &QueryTempUsage) -> DataError {
        DataError::query_temp_limit(format!(
            "Query temporary storage is unavailable (query {} bytes, CSV cache {} bytes, limit {} bytes, free {} bytes, safety reserve {} bytes). Close other CSV tabs or increase the storage limit. Clear inactive CSV cache in Settings or free disk space, then retry.",
            usage.query_temp_bytes,
            usage.csv_cache_bytes,
            usage.limit_bytes,
            usage.free_bytes,
            usage.safety_reserve_bytes,
        ))
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

    pub(crate) fn process_directory(&self) -> &Path {
        &self.process_directory
    }

    pub(crate) fn process_temp_bytes(&self) -> Result<u64, DataError> {
        self.accounted_directory_bytes(&self.process_directory)
    }

    fn accounted_directory_bytes(&self, path: &Path) -> Result<u64, DataError> {
        let aliases = self
            .pinned_source_aliases
            .lock()
            .map_err(|_| temp_unavailable())?;
        directory_bytes_with_aliases(path, &aliases)
    }

    pub(crate) fn configured_limit(&self) -> u64 {
        self.limit_bytes.load(Ordering::Acquire)
    }

    pub(crate) fn set_external_cache_bytes(&self, bytes: u64) {
        self.external_cache_bytes.store(bytes, Ordering::Release);
    }
}

fn effective_limit(configured_limit: u64) -> u64 {
    configured_limit.min(QUERY_TEMP_HARD_CAP_BYTES)
}

fn calculate_query_budget(
    configured_limit: u64,
    occupied_bytes: u64,
    reserved_bytes: u64,
    free_bytes: u64,
    reserved_remaining_bytes: u64,
    per_query_cap: u64,
) -> QueryTempBudget {
    let limit_remaining_bytes = configured_limit
        .saturating_sub(occupied_bytes)
        .saturating_sub(reserved_bytes);
    let free_remaining_bytes = free_bytes
        .saturating_sub(QUERY_TEMP_SAFETY_RESERVE_BYTES)
        .saturating_sub(reserved_remaining_bytes);
    QueryTempBudget {
        allowance_bytes: per_query_cap
            .min(limit_remaining_bytes)
            .min(free_remaining_bytes),
        limit_remaining_bytes,
        free_remaining_bytes,
    }
}

impl QueryTempLease {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn allowance_bytes(&self) -> u64 {
        self.reservations
            .lock()
            .ok()
            .and_then(|reservations| reservations.get(&self.path).copied())
            .unwrap_or(0)
    }

    /// Register an exact parent-owned source alias before the worker creates
    /// it. A file with this name is excluded only while its OS identity equals
    /// the retained input handle; copied or replaced files are still charged.
    pub(crate) fn register_pinned_source_alias(
        &self,
        alias: &Path,
        source: &File,
    ) -> Result<(), DataError> {
        if alias.parent() != Some(self.path.as_path()) {
            return Err(DataError::invalid_request(
                "A pinned source alias must belong to its temporary lease.",
            ));
        }
        let pinned_source = source.try_clone().map_err(|error| temp_io(alias, error))?;
        let identity = file_identity(&pinned_source).map_err(|error| temp_io(alias, error))?;
        let mut aliases = self
            .pinned_source_aliases
            .lock()
            .map_err(|_| temp_unavailable())?;
        if aliases.contains_key(alias) {
            return Err(DataError::invalid_request(
                "The pinned source alias is already registered.",
            ));
        }
        aliases.insert(
            alias.to_owned(),
            PinnedSourceAlias {
                identity,
                _pinned_source: pinned_source,
            },
        );
        Ok(())
    }

    pub(crate) fn commit_usage(&self) {
        let bytes = self
            .pinned_source_aliases
            .lock()
            .ok()
            .and_then(|aliases| directory_bytes_with_aliases(&self.path, &aliases).ok())
            .unwrap_or_else(|| directory_bytes_best_effort(&self.path));
        if let Ok(mut reservations) = self.reservations.lock() {
            if let Some(reservation) = reservations.get_mut(&self.path) {
                *reservation = bytes;
            }
        }
    }
}

impl Drop for QueryTempLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_paths.lock() {
            active.remove(&self.path);
        }
        if let Ok(mut reservations) = self.reservations.lock() {
            reservations.remove(&self.path);
        }
        self.active_queries.fetch_sub(1, Ordering::AcqRel);
        let _ = remove_with_retry(&self.path, std::time::Duration::from_millis(100));
        // Unlink before unregistering, so a concurrent monitor never charges
        // a valid source hardlink merely because its lease is being dropped.
        if let Ok(mut aliases) = self.pinned_source_aliases.lock() {
            aliases.retain(|path, _| path.parent() != Some(self.path.as_path()));
        }
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

fn directory_bytes_with_aliases(
    path: &Path,
    aliases: &HashMap<PathBuf, PinnedSourceAlias>,
) -> Result<u64, DataError> {
    let mut bytes = 0_u64;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(temp_io(path, error)),
    };
    for entry in entries {
        let entry = entry.map_err(|error| temp_io(path, error))?;
        // Workers and lease cleanup can unlink files while usage is sampled.
        // A vanished entry consumes no bytes; other I/O errors remain typed.
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(temp_io(&entry.path(), error)),
        };
        bytes = bytes.saturating_add(if metadata.is_dir() {
            directory_bytes_with_aliases(&entry.path(), aliases)?
        } else {
            accounted_file_bytes(&entry.path(), aliases)?
        });
    }
    Ok(bytes)
}

fn accounted_file_bytes(
    path: &Path,
    aliases: &HashMap<PathBuf, PinnedSourceAlias>,
) -> Result<u64, DataError> {
    // Directory enumeration can retain stale lengths while a Windows spill
    // writer remains open. Query a fresh file handle for both identity and size.
    let file = match open_temp_accounting_file(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(temp_io(path, error)),
    };
    if let Some(alias) = aliases.get(path) {
        if file_identity(&file).is_ok_and(|identity| identity == alias.identity) {
            return Ok(0);
        }
    }
    file.metadata()
        .map(|metadata| metadata.len())
        .map_err(|error| temp_io(path, error))
}

pub(crate) fn open_temp_accounting_file(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Metadata access works alongside DuckDB's exclusive data lock.
        // Requesting data-read access here would reject a healthy live DB.
        OpenOptions::new()
            .access_mode(0x80)
            .share_mode(0x7)
            .open(path)
    }
    #[cfg(not(windows))]
    {
        File::open(path)
    }
}

#[cfg(windows)]
fn file_identity(file: &File) -> std::io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = ByHandleFileInformation::default();
    // SAFETY: the file handle remains owned for the call and the writable
    // structure matches the canonical Win32 BY_HANDLE_FILE_INFORMATION layout.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((
        u64::from(information.volume_serial_number),
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low),
    ))
}

#[cfg(unix)]
fn file_identity(file: &File) -> std::io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File) -> std::io::Result<(u64, u64)> {
    Err(std::io::Error::other(
        "Pinned source alias accounting requires a stable OS file identity.",
    ))
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
                open_temp_accounting_file(&entry.path())
                    .and_then(|file| file.metadata())
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
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

fn temp_io(_path: &Path, _error: impl std::fmt::Display) -> DataError {
    DataError::query_temp_limit(
        "Query temporary storage could not be accessed. Clear inactive CSV cache in Settings, verify the temporary storage location is writable, or free disk space, then retry.",
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn tmp22_accounts_open_writer_using_current_handle_length() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("open-spill.tmp");
        let mut writer = File::create(&path).unwrap();
        let original = fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .metadata()
            .unwrap();
        writer.write_all(&vec![1; 8 * 1024 * 1024]).unwrap();
        assert_eq!(original.len(), 0);
        assert_eq!(
            directory_bytes_with_aliases(directory.path(), &HashMap::new()).unwrap(),
            8 * 1024 * 1024
        );
        assert_eq!(
            directory_bytes_best_effort(directory.path()),
            8 * 1024 * 1024
        );
        writer.write_all(&vec![2; 1024 * 1024]).unwrap();
        assert_eq!(
            accounted_file_bytes(&path, &HashMap::new()).unwrap(),
            9 * 1024 * 1024
        );
        assert_eq!(
            directory_bytes_with_aliases(directory.path(), &HashMap::new()).unwrap(),
            9 * 1024 * 1024
        );
        assert_eq!(
            accounted_file_bytes(&directory.path().join("removed.tmp"), &HashMap::new()).unwrap(),
            0
        );
        assert_eq!(writer.metadata().unwrap().len(), 9 * 1024 * 1024);
    }

    #[test]
    #[cfg(windows)]
    fn tmp22_metadata_accounting_respects_exclusive_database_data_lock() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("prepared.duckdb");
        let mut writer = OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        writer.write_all(&vec![3; 1024 * 1024]).unwrap();
        assert!(
            File::open(&path).is_err(),
            "Fixture must deny data-read handles while writer is open"
        );
        assert_eq!(
            directory_bytes_with_aliases(directory.path(), &HashMap::new()).unwrap(),
            1024 * 1024
        );
        assert_eq!(directory_bytes_best_effort(directory.path()), 1024 * 1024);
        assert_eq!(writer.metadata().unwrap().len(), 1024 * 1024);
    }
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
    fn tmp18_bounded_allowance_uses_cap_shared_usage_and_free_reserve() {
        let reserve = QUERY_TEMP_SAFETY_RESERVE_BYTES;
        let budget = calculate_query_budget(1_000, 200, 300, reserve + 900, 100, 700);
        assert_eq!(budget.limit_remaining_bytes, 500);
        assert_eq!(budget.free_remaining_bytes, 800);
        assert_eq!(budget.allowance_bytes, 500);

        let free_bound = calculate_query_budget(2_000, 100, 200, reserve + 350, 250, 1_000);
        assert_eq!(free_bound.allowance_bytes, 100);
        assert_eq!(
            calculate_query_budget(500, 200, 300, reserve + 1, 0, 100).allowance_bytes,
            0
        );
        assert_eq!(
            calculate_query_budget(1_000, 0, 0, reserve, 0, 100).allowance_bytes,
            0
        );
    }

    #[test]
    fn tmp18_temp_io_is_typed_actionable_and_does_not_expose_paths() {
        let error = temp_io(
            Path::new("C:/private/query-temp/document/query"),
            std::io::Error::other("disk full"),
        );
        assert_eq!(error.code, DataErrorCode::QueryTempLimitExceeded);
        assert!(error.message.contains("Clear inactive CSV cache"));
        assert!(!error.message.contains("C:/private"));
        assert!(!error.message.contains("disk full"));
    }

    #[test]
    fn storage_pressure_reservations_cover_growth_beyond_original_allowance() {
        let local = tempfile::tempdir().unwrap();
        let limit = 8 * 1024 * 1024;
        let manager = QueryTempManager::open(local.path(), limit).unwrap();
        let baseline = manager.usage().unwrap().query_temp_bytes;
        let first = manager
            .allocate_bounded("first", "csv", 4 * 1024 * 1024)
            .unwrap();
        let output = File::create(first.path().join("prepared.parquet")).unwrap();
        let actual_bytes = 6 * 1024 * 1024;
        output.set_len(actual_bytes).unwrap();
        drop(output);
        assert_eq!(first.allowance_bytes(), 4 * 1024 * 1024);
        let expected_remaining = limit - baseline - actual_bytes;
        let budget = manager.bounded_allowance(limit).unwrap();
        assert_eq!(budget.limit_remaining_bytes, expected_remaining);
        assert_eq!(budget.allowance_bytes, expected_remaining);
        let second = manager
            .allocate_bounded("second", "query", 4 * 1024 * 1024)
            .unwrap();
        assert_eq!(second.allowance_bytes(), expected_remaining);
        assert_eq!(manager.bounded_allowance(limit).unwrap().allowance_bytes, 0);
        assert!(
            baseline + actual_bytes.max(first.allowance_bytes()) + second.allowance_bytes()
                <= limit
        );
        drop(second);
        assert_eq!(
            manager.bounded_allowance(limit).unwrap().allowance_bytes,
            expected_remaining
        );
        drop(first);
        assert_eq!(
            manager.bounded_allowance(limit).unwrap().allowance_bytes,
            limit - baseline
        );
    }

    #[test]
    fn storage_pressure_pinned_alias_does_not_charge_source_and_all_accounting_agrees() {
        let local = tempfile::tempdir().unwrap();
        let input = local.path().join("input.csv");
        let source = File::create(&input).unwrap();
        source.set_len(8 * 1024 * 1024).unwrap();
        drop(source);
        let pinned = File::open(&input).unwrap();
        let limit = 1024 * 1024;
        let manager = QueryTempManager::open(local.path(), limit).unwrap();
        let baseline = manager.usage().unwrap().query_temp_bytes;
        let lease = manager.allocate_bounded("document", "csv", limit).unwrap();
        let alias = lease.path().join("polars-source.snapshot.csv");
        lease.register_pinned_source_alias(&alias, &pinned).unwrap();
        // Registration precedes creation, eliminating the monitor race window.
        assert_eq!(manager.usage().unwrap().query_temp_bytes, baseline);
        fs::hard_link(&input, &alias).unwrap();
        fs::write(lease.path().join("prepared.parquet"), vec![0; 16 * 1024]).unwrap();
        let expected = baseline + 16 * 1024;
        assert_eq!(manager.usage().unwrap().query_temp_bytes, expected);
        assert_eq!(manager.process_temp_bytes().unwrap(), expected);
        assert!(manager.budget_violation().unwrap().is_none());
        lease.commit_usage();
        assert_eq!(lease.allowance_bytes(), 16 * 1024);
        assert_eq!(
            manager.bounded_allowance(limit).unwrap().allowance_bytes,
            limit - expected
        );
        assert_eq!(manager.clear_inactive().unwrap().deleted_bytes, 0);
        assert!(manager
            .pinned_source_aliases
            .lock()
            .unwrap()
            .contains_key(&alias));
        drop(lease);
        assert!(manager.pinned_source_aliases.lock().unwrap().is_empty());
        assert!(!alias.exists());
        assert_eq!(manager.usage().unwrap().query_temp_bytes, baseline);
        assert_eq!(fs::metadata(&input).unwrap().len(), 8 * 1024 * 1024);
    }

    #[test]
    fn storage_pressure_only_exact_registered_file_identity_is_exempt() {
        let local = tempfile::tempdir().unwrap();
        let input = local.path().join("input.csv");
        fs::write(&input, vec![0; 8192]).unwrap();
        let pinned = File::open(&input).unwrap();
        let manager = QueryTempManager::open(local.path(), 1024 * 1024).unwrap();
        let lease = manager
            .allocate_bounded("document", "csv", 1024 * 1024)
            .unwrap();
        let baseline = manager.usage().unwrap().query_temp_bytes;
        let alias = lease.path().join("polars-source.snapshot.csv");
        fs::copy(&input, &alias).unwrap();
        assert_eq!(
            manager.process_temp_bytes().unwrap(),
            baseline + 8192,
            "the filename alone never grants an exemption"
        );
        lease.register_pinned_source_alias(&alias, &pinned).unwrap();
        assert_eq!(
            manager.process_temp_bytes().unwrap(),
            baseline + 8192,
            "a registered path containing a copy must still be charged"
        );
        fs::remove_file(&alias).unwrap();
        fs::hard_link(&input, &alias).unwrap();
        assert_eq!(manager.process_temp_bytes().unwrap(), baseline);
        let unregistered = lease.path().join("unregistered-hardlink.csv");
        fs::hard_link(&input, &unregistered).unwrap();
        assert_eq!(
            manager.process_temp_bytes().unwrap(),
            baseline + 8192,
            "an unregistered hardlink must be charged"
        );
        fs::remove_file(&unregistered).unwrap();
        fs::remove_file(&alias).unwrap();
        fs::write(&alias, b"replacement").unwrap();
        assert_eq!(
            manager.process_temp_bytes().unwrap(),
            baseline + 11,
            "replacing a registered alias with another file restores accounting"
        );
        assert!(lease
            .register_pinned_source_alias(&local.path().join("outside.csv"), &pinned)
            .is_err());
        drop(lease);
        assert!(manager.pinned_source_aliases.lock().unwrap().is_empty());
        assert_eq!(fs::read(&input).unwrap(), vec![0; 8192]);
    }

    #[test]
    fn tmp18_bounded_leases_reserve_without_oversubscription_and_release_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let manager = QueryTempManager::open(directory.path(), 4 * 1024 * 1024).unwrap();
        let first = manager
            .allocate_bounded("document", "first", 3 * 1024 * 1024)
            .unwrap();
        let second = manager
            .allocate_bounded("document", "second", 3 * 1024 * 1024)
            .unwrap();
        assert!(first.allowance_bytes() > 0);
        assert!(second.allowance_bytes() > 0);
        assert!(first.allowance_bytes() + second.allowance_bytes() <= 4 * 1024 * 1024);
        let second_allowance = second.allowance_bytes();
        drop(first);
        assert!(
            manager
                .bounded_allowance(3 * 1024 * 1024)
                .unwrap()
                .allowance_bytes
                > second_allowance
        );
    }

    #[test]
    fn temp_usage_wire_separates_estimate_reserve_cap_and_free_space() {
        let usage = QueryTempUsage {
            process_bytes: 100,
            query_temp_bytes: 60,
            csv_cache_bytes: 40,
            csv_cache_entries: 2,
            csv_cache_path: "C:/cache".to_owned(),
            csv_cache_limit_bytes: 150,
            csv_cache_effective_limit_bytes: 150,
            csv_cache_active_bytes: 20,
            csv_cache_active_entries: 1,
            csv_cache_available_bytes: 500,
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
        assert_eq!(json["queryTempBytes"], 60);
        assert_eq!(json["csvCacheBytes"], 40);
        assert_eq!(json["csvCacheEntries"], 2);
        assert_eq!(json["csvCachePath"], "C:/cache");
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
