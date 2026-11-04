use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use fs2::FileExt;
use parquet::file::reader::{FileReader, SerializedFileReader};
use serde::{Deserialize, Serialize};

use crate::{data::CsvPreparedPhysicalColumn, domain::DataError};

use super::{temp::QUERY_TEMP_SAFETY_RESERVE_BYTES, QueryTempManager};

const CACHE_SCHEMA_VERSION: u32 = 3;
const MAX_CACHE_ENTRIES: usize = 16;
const MANIFEST_NAME: &str = "cache-manifest.json";
const PARTIAL_MARKER: &str = "publish.partial";
const GLOBAL_LOCK_NAME: &str = ".cache.lock";
const LOCK_DIRECTORY_NAME: &str = ".locks";
const REQUIRED_FILES: [&str; 3] = ["prepared.parquet", "states.bin", "offsets.idx"];
const FULL_SCRUB_INTERVAL_NANOS: u128 = 24 * 60 * 60 * 1_000_000_000;

#[derive(Debug, Clone)]
pub(crate) struct CsvCacheIdentity {
    pub canonical_path: String,
    pub file_identity: String,
    pub source_bytes: u64,
    pub modified_nanos: Option<u128>,
    pub created_nanos: Option<u128>,
    pub profile_identity: String,
    pub rows: Option<u64>,
    pub columns: usize,
    pub source_columns: usize,
    pub physical_columns: Vec<CsvPreparedPhysicalColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CsvCacheManifest {
    cache_schema_version: u32,
    application_version: String,
    canonical_path: String,
    file_identity: String,
    source_bytes: u64,
    modified_nanos: Option<String>,
    created_nanos: Option<String>,
    profile_identity: String,
    rows: u64,
    columns: usize,
    source_columns: usize,
    physical_layout: Vec<String>,
    schema_contract: Vec<String>,
    physical_mapping: Vec<CachedPhysicalMapping>,
    schema_fingerprint: String,
    parquet: CachedArtifact,
    states: CachedArtifact,
    offsets: CachedArtifact,
    last_full_scrub_nanos: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedArtifact {
    bytes: u64,
    file_identity: String,
    modified_nanos: Option<String>,
    created_nanos: Option<String>,
    checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPhysicalMapping {
    field: String,
    physical_kind: String,
    source_index: Option<usize>,
    state_word_index: Option<usize>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CsvCacheAudit {
    pub hits: u64,
    pub misses: u64,
    pub corruptions: u64,
    pub publishes: u64,
    pub evictions: u64,
    pub scrubs: u64,
    pub relocated_bytes: u64,
    pub copied_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvCacheUsage {
    pub bytes: u64,
    pub entries: usize,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvCacheCleanupResult {
    pub deleted_bytes: u64,
    pub deleted_entries: usize,
    pub skipped_active_bytes: u64,
    pub skipped_active_entries: usize,
    pub cleanup_failures: Vec<String>,
    pub remaining_cache_bytes: u64,
    pub remaining_cache_entries: usize,
}

#[derive(Debug)]
pub(crate) struct CsvPersistentCache {
    root: PathBuf,
    lock_directory: PathBuf,
    temp: Arc<QueryTempManager>,
    global_lock: Mutex<File>,
    audit: Mutex<CsvCacheAudit>,
    #[cfg(test)]
    reclaim_delete_failures: Mutex<std::collections::HashSet<String>>,
}

#[derive(Debug)]
pub(crate) struct CsvPersistentCacheLease {
    lock: File,
    path: PathBuf,
}

struct CacheGlobalGuard<'a> {
    file: MutexGuard<'a, File>,
}

#[derive(Debug)]
pub(crate) struct CsvCacheHit {
    pub path: PathBuf,
    pub rows: u64,
    pub lease: CsvPersistentCacheLease,
}

impl CsvPersistentCache {
    pub(crate) fn open(local_data: &Path, temp: Arc<QueryTempManager>) -> Result<Self, DataError> {
        let root = local_data.join("csv-cache-v1");
        fs::create_dir_all(&root).map_err(|error| DataError::io(&root, error))?;
        let lock_directory = root.join(LOCK_DIRECTORY_NAME);
        fs::create_dir_all(&lock_directory)
            .map_err(|error| DataError::io(&lock_directory, error))?;
        let global_lock_path = root.join(GLOBAL_LOCK_NAME);
        let global_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&global_lock_path)
            .map_err(|error| DataError::io(&global_lock_path, error))?;
        let cache = Self {
            root,
            lock_directory,
            temp,
            global_lock: Mutex::new(global_lock),
            audit: Mutex::new(CsvCacheAudit::default()),
            #[cfg(test)]
            reclaim_delete_failures: Mutex::new(std::collections::HashSet::new()),
        };
        let _global = cache.lock_global()?;
        // Publication and atomic manifest replacement use this same global
        // lock, so no live publisher can own these temporary names here.
        // Entry leases may remain active; deleting only direct manifest
        // temporaries leaves their immutable artifacts and manifest intact.
        for entry in fs::read_dir(&cache.root).map_err(|error| DataError::io(&cache.root, error))? {
            let path = entry
                .map_err(|error| DataError::io(&cache.root, error))?
                .path();
            let entry_name = path.file_name().and_then(|name| name.to_str());
            if entry_name.is_some_and(|name| name.contains(".partial"))
                || path.join(PARTIAL_MARKER).is_file()
            {
                let _ = fs::remove_dir_all(path);
                continue;
            }
            if path.is_dir() && !entry_name.is_some_and(|name| name.starts_with('.')) {
                cleanup_orphan_manifest_partials(&path)?;
            }
        }
        cache.refresh_usage_locked()?;
        // Startup must remain available even if only the process lock exceeds a
        // deliberately tiny test limit. Any persistent entries that can be
        // reclaimed are still brought back under the shared count/disk budget.
        let _ = cache.evict_to_budget_locked(0, Some("__startup_without_new_entry__"));
        cache.refresh_usage_locked()?;
        drop(_global);
        Ok(cache)
    }

    pub(crate) fn lookup(
        &self,
        identity: &CsvCacheIdentity,
    ) -> Result<Option<CsvCacheHit>, DataError> {
        let _global = self.lock_global()?;
        self.refresh_usage_locked()?;
        for (key, path) in self.compatible_lookup_candidates_locked(identity)? {
            if path.join(PARTIAL_MARKER).is_file() {
                self.record_corruption();
                self.remove_if_unleased_locked(&key, &path)?;
                continue;
            }
            let validated = validate_entry_fast(&path, identity);
            let manifest = match validated.and_then(|validation| match validation {
                EntryValidation::Fast(manifest) => Ok(manifest),
                EntryValidation::NeedsScrub(manifest) => {
                    self.record_scrub();
                    scrub_entry(&path, identity, manifest)
                }
            }) {
                Ok(manifest) => manifest,
                Err(_) => {
                    self.record_corruption();
                    self.remove_if_unleased_locked(&key, &path)?;
                    continue;
                }
            };
            self.touch(&path)?;
            // Acquire the shared entry lease while the global lock still covers
            // validation, so another process cannot evict between the two steps.
            let lease = self.lease(key)?;
            if let Ok(mut audit) = self.audit.lock() {
                audit.hits = audit.hits.saturating_add(1);
            }
            return Ok(Some(CsvCacheHit {
                path,
                rows: manifest.rows,
                lease,
            }));
        }
        self.record_miss();
        Ok(None)
    }

    fn compatible_lookup_candidates_locked(
        &self,
        identity: &CsvCacheIdentity,
    ) -> Result<Vec<(String, PathBuf)>, DataError> {
        let current_key = cache_key(identity);
        let current_path = self.root.join(&current_key);
        let mut candidates = Vec::new();
        if current_path.is_dir() {
            candidates.push((current_key.clone(), current_path));
        }

        // compact-v3 initially included the application version in the directory
        // hash. Discover those bounded (max 16) entries by their manifest so an
        // application update does not show a false cold-preparation state.
        let mut compatible_legacy = Vec::new();
        for (key, path) in self.owned_entry_paths()? {
            if key == current_key {
                continue;
            }
            let manifest_path = path.join(MANIFEST_NAME);
            let Ok(bytes) = fs::read(&manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_slice::<CsvCacheManifest>(&bytes) else {
                continue;
            };
            if !manifest.matches(identity) {
                continue;
            }
            let access = fs::metadata(path.join("last-access"))
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            compatible_legacy.push((key, path, access));
        }
        compatible_legacy.sort_by_key(|candidate| std::cmp::Reverse(candidate.2));
        candidates.extend(
            compatible_legacy
                .into_iter()
                .map(|(key, path, _)| (key, path)),
        );
        Ok(candidates)
    }

    pub(crate) fn has_publish_artifacts(&self, source_directory: &Path) -> Result<bool, DataError> {
        let present = REQUIRED_FILES
            .iter()
            .filter(|name| source_directory.join(name).is_file())
            .count();
        if present == 0 {
            return Ok(false);
        }
        if present != REQUIRED_FILES.len() {
            return Err(DataError::query_failed(
                "Prepared CSV cache artifacts are incomplete.",
            ));
        }
        Ok(true)
    }

    pub(crate) fn publish(
        &self,
        identity: &CsvCacheIdentity,
        source_directory: &Path,
        commit_check: impl FnOnce() -> Result<(), DataError>,
    ) -> Result<CsvPersistentCacheLease, DataError> {
        let _global = self.lock_global()?;
        if identity.rows.is_none() {
            return Err(DataError::query_failed(
                "CSV cache publication requires a completed row count.",
            ));
        }
        for name in REQUIRED_FILES {
            let path = source_directory.join(name);
            if !path.is_file() {
                return Err(DataError::query_failed(format!(
                    "Prepared CSV cache artifact is missing: {name}"
                )));
            }
        }
        let key = cache_key(identity);
        let destination = self.root.join(&key);
        if destination.is_dir() && validate_entry(&destination, identity).is_ok() {
            self.touch(&destination)?;
            return self.lease(key);
        }
        if destination.exists() && !self.remove_if_unleased_locked(&key, &destination)? {
            return Err(DataError::query_temp_limit(
                "CSV persistent cache entry is currently leased by another process.",
            ));
        }
        let sizes = REQUIRED_FILES
            .iter()
            .map(|name| {
                fs::metadata(source_directory.join(name))
                    .map(|metadata| metadata.len())
                    .map_err(|error| DataError::io(&source_directory.join(name), error))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let incoming = sizes.iter().copied().sum::<u64>().saturating_add(4096);
        self.evict_relocated_to_budget_locked(incoming, sizes.iter().copied().sum(), Some(&key))?;

        let staging = self.root.join(format!(".{key}.partial-{}", nonce()));
        fs::create_dir(&staging).map_err(|error| DataError::io(&staging, error))?;
        let partial_marker = staging.join(PARTIAL_MARKER);
        fs::write(&partial_marker, nonce().to_le_bytes())
            .map_err(|error| DataError::io(&partial_marker, error))?;
        let mut moved = Vec::new();
        let result = (|| {
            for name in REQUIRED_FILES {
                let source = source_directory.join(name);
                let target = staging.join(name);
                fs::rename(&source, &target).map_err(|error| DataError::io(&target, error))?;
                moved.push(name);
            }
            let artifacts = REQUIRED_FILES
                .iter()
                .map(|name| CachedArtifact::capture(&staging.join(name), true))
                .collect::<Result<Vec<_>, _>>()?;
            let (physical_layout, schema_contract) =
                parquet_schema_layout(&staging.join("prepared.parquet"))?;
            let manifest = CsvCacheManifest::from_identity(
                identity,
                &artifacts,
                physical_layout,
                schema_contract,
            );
            let manifest_path = staging.join(MANIFEST_NAME);
            let bytes = serde_json::to_vec(&manifest)
                .map_err(|error| DataError::query_failed(error.to_string()))?;
            let mut file = File::create(&manifest_path)
                .map_err(|error| DataError::io(&manifest_path, error))?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| DataError::io(&manifest_path, error))?;
            drop(file);
            commit_check()?;
            for name in REQUIRED_FILES {
                set_read_only(&staging.join(name))?;
            }
            fs::remove_file(&partial_marker)
                .map_err(|error| DataError::io(&partial_marker, error))?;
            fs::rename(&staging, &destination)
                .map_err(|error| DataError::io(&destination, error))?;
            self.touch(&destination)?;
            validate_entry_fast(&destination, identity)?;
            Ok::<(), DataError>(())
        })();
        if let Err(error) = result {
            if staging.is_dir() {
                for name in moved.into_iter().rev() {
                    let staged = staging.join(name);
                    let source = source_directory.join(name);
                    if staged.exists() {
                        let _ = set_writable(&staged);
                        let _ = fs::rename(&staged, &source);
                    }
                }
                let _ = fs::remove_dir_all(&staging);
            } else if destination.is_dir() {
                let _ = self.remove_if_unleased_locked(&key, &destination);
            }
            self.refresh_usage_locked()?;
            return Err(error);
        }
        self.refresh_usage_locked()?;
        if let Ok(mut audit) = self.audit.lock() {
            audit.publishes = audit.publishes.saturating_add(1);
            audit.relocated_bytes = audit
                .relocated_bytes
                .saturating_add(sizes.iter().copied().sum());
        }
        self.lease(key)
    }

    #[cfg(test)]
    pub(crate) fn audit(&self) -> CsvCacheAudit {
        self.audit.lock().map(|audit| *audit).unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn entry_paths(&self) -> Vec<PathBuf> {
        self.entries()
            .map(|entries| entries.into_iter().map(|entry| entry.3).collect())
            .unwrap_or_default()
    }

    pub(crate) fn usage(&self) -> Result<CsvCacheUsage, DataError> {
        let _global = self.lock_global()?;
        self.usage_locked()
    }

    pub(crate) fn clear_inactive(&self) -> Result<CsvCacheCleanupResult, DataError> {
        let _global = self.lock_global()?;
        let mut result = CsvCacheCleanupResult::default();

        for (key, path) in self.owned_entry_paths()? {
            let bytes = match directory_bytes(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    result
                        .cleanup_failures
                        .push(format!("{}: {}", path.display(), error.message));
                    continue;
                }
            };
            let lock = match self.try_exclusive_entry_lock(&key) {
                Ok(Some(lock)) => lock,
                Ok(None) => {
                    result.skipped_active_bytes = result.skipped_active_bytes.saturating_add(bytes);
                    result.skipped_active_entries = result.skipped_active_entries.saturating_add(1);
                    continue;
                }
                Err(error) => {
                    result
                        .cleanup_failures
                        .push(format!("{}: {}", path.display(), error.message));
                    continue;
                }
            };

            match fs::remove_dir_all(&path) {
                Ok(()) => {
                    result.deleted_bytes = result.deleted_bytes.saturating_add(bytes);
                    result.deleted_entries = result.deleted_entries.saturating_add(1);
                }
                Err(error) => result
                    .cleanup_failures
                    .push(format!("{}: {error}", path.display())),
            }
            if let Err(error) = FileExt::unlock(&lock) {
                result.cleanup_failures.push(format!(
                    "{}: failed to release the CSV cache entry lock: {error}",
                    path.display()
                ));
            }
            if !path.exists() {
                let _ = fs::remove_file(self.lock_directory.join(format!("{key}.lock")));
            }
        }

        if let Err(error) = self.refresh_usage_locked() {
            result.cleanup_failures.push(format!(
                "{}: failed to refresh CSV cache budget usage: {}",
                self.root.display(),
                error.message
            ));
        }
        let remaining = self.owned_entry_paths()?;
        result.remaining_cache_entries = remaining.len();
        for (_, path) in remaining {
            match directory_bytes(&path) {
                Ok(bytes) => {
                    result.remaining_cache_bytes =
                        result.remaining_cache_bytes.saturating_add(bytes);
                }
                Err(error) => {
                    let prefix = format!("{}:", path.display());
                    if !result
                        .cleanup_failures
                        .iter()
                        .any(|failure| failure.starts_with(&prefix))
                    {
                        result
                            .cleanup_failures
                            .push(format!("{} {}", prefix, error.message));
                    }
                }
            }
        }
        Ok(result)
    }

    pub(crate) fn reclaim_for_query(&self, target_allowance: u64) -> Result<u64, DataError> {
        let _global = self
            .lock_global()
            .map_err(|_| self.actionable_temp_error())?;
        self.refresh_usage_locked()
            .map_err(|_| self.actionable_temp_error())?;
        loop {
            let allowance = self
                .temp
                .bounded_allowance(target_allowance)?
                .allowance_bytes;
            if allowance >= target_allowance {
                return Ok(allowance);
            }
            if self.reclaim_one_lru_locked()?.is_none() {
                return if allowance > 0 {
                    Ok(allowance)
                } else {
                    Err(self.temp.limit_error()?)
                };
            }
        }
    }

    pub(crate) fn reclaim_under_pressure(&self) -> Result<bool, DataError> {
        let _global = self
            .lock_global()
            .map_err(|_| self.actionable_temp_error())?;
        self.refresh_usage_locked()
            .map_err(|_| self.actionable_temp_error())?;
        let mut reclaimed = false;
        while self.temp.budget_violation()?.is_some() {
            if self.reclaim_one_lru_locked()?.is_none() {
                break;
            }
            reclaimed = true;
        }
        Ok(reclaimed && self.temp.budget_violation()?.is_none())
    }

    fn reclaim_one_lru_locked(&self) -> Result<Option<u64>, DataError> {
        let mut last_failure = None;
        for (key, _, bytes, path) in self
            .reclaimable_entries_locked()
            .map_err(|_| self.actionable_temp_error())?
        {
            let Some(lock) = self
                .try_exclusive_entry_lock(&key)
                .map_err(|_| self.actionable_temp_error())?
            else {
                continue;
            };
            let removal = self.remove_reclaim_candidate(&key, &path);
            let _ = FileExt::unlock(&lock);
            drop(lock);
            if removal.is_err() {
                last_failure = Some(self.actionable_temp_error());
                continue;
            }
            if !path.exists() {
                let _ = fs::remove_file(self.lock_directory.join(format!("{key}.lock")));
            }
            if let Ok(mut audit) = self.audit.lock() {
                audit.evictions = audit.evictions.saturating_add(1);
            }
            self.refresh_usage_locked()
                .map_err(|_| self.actionable_temp_error())?;
            return Ok(Some(bytes));
        }
        match last_failure {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }

    fn remove_reclaim_candidate(&self, _key: &str, path: &Path) -> std::io::Result<()> {
        #[cfg(test)]
        if self
            .reclaim_delete_failures
            .lock()
            .is_ok_and(|mut failures| failures.remove(_key))
        {
            let _ = fs::remove_file(path.join("states.bin"));
            return Err(std::io::Error::other("injected cache reclaim failure"));
        }
        fs::remove_dir_all(path)
    }

    #[cfg(test)]
    fn fail_next_reclaim_delete(&self, key: impl Into<String>) {
        self.reclaim_delete_failures
            .lock()
            .unwrap()
            .insert(key.into());
    }

    fn reclaimable_entries_locked(&self) -> Result<Vec<(String, u128, u64, PathBuf)>, DataError> {
        let mut output = Vec::new();
        for (key, path) in self.owned_entry_paths()? {
            let manifest_path = path.join(MANIFEST_NAME);
            let Ok(bytes) = fs::read(&manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_slice::<CsvCacheManifest>(&bytes) else {
                continue;
            };
            if manifest.cache_schema_version != CACHE_SCHEMA_VERSION
                || (manifest_cache_key(&manifest) != key
                    && manifest_legacy_cache_key(&manifest) != key)
                || !manifest_artifacts_have_expected_sizes(&path, &manifest)
            {
                continue;
            }
            let access = fs::metadata(path.join("last-access"))
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            output.push((key, access, directory_bytes(&path)?, path));
        }
        output.sort_by(|left, right| (left.1, &left.0).cmp(&(right.1, &right.0)));
        Ok(output)
    }

    fn actionable_temp_error(&self) -> DataError {
        self.temp.limit_error().unwrap_or_else(|error| error)
    }

    fn lease(&self, key: String) -> Result<CsvPersistentCacheLease, DataError> {
        let entry_path = self.root.join(&key);
        let path = self.lock_directory.join(format!("{key}.lock"));
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| DataError::io(&path, error))?;
        FileExt::lock_shared(&lock).map_err(|error| DataError::io(&path, error))?;
        Ok(CsvPersistentCacheLease {
            lock,
            path: entry_path,
        })
    }

    fn try_exclusive_entry_lock(&self, key: &str) -> Result<Option<File>, DataError> {
        let path = self.lock_directory.join(format!("{key}.lock"));
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| DataError::io(&path, error))?;
        match lock.try_lock_exclusive() {
            Ok(()) => Ok(Some(lock)),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || matches!(error.raw_os_error(), Some(32 | 33)) =>
            {
                Ok(None)
            }
            Err(error) => Err(DataError::io(&path, error)),
        }
    }

    fn remove_if_unleased_locked(&self, key: &str, path: &Path) -> Result<bool, DataError> {
        let Some(lock) = self.try_exclusive_entry_lock(key)? else {
            return Ok(false);
        };
        if path.exists() {
            fs::remove_dir_all(path).map_err(|error| DataError::io(path, error))?;
        }
        FileExt::unlock(&lock).map_err(|error| DataError::io(path, error))?;
        let _ = fs::remove_file(self.lock_directory.join(format!("{key}.lock")));
        self.refresh_usage_locked()?;
        Ok(true)
    }

    fn lock_global(&self) -> Result<CacheGlobalGuard<'_>, DataError> {
        let file = self.global_lock.lock().map_err(|_| {
            DataError::query_failed("CSV persistent cache global lock is unavailable.")
        })?;
        file.lock_exclusive()
            .map_err(|error| DataError::io(&self.root, error))?;
        Ok(CacheGlobalGuard { file })
    }

    fn touch(&self, path: &Path) -> Result<(), DataError> {
        let marker = path.join("last-access");
        fs::write(&marker, nonce().to_le_bytes()).map_err(|error| DataError::io(&marker, error))
    }

    #[cfg(test)]
    fn evict_to_budget(&self, incoming: u64, replacing: Option<&str>) -> Result<(), DataError> {
        let _global = self.lock_global()?;
        self.evict_to_budget_locked(incoming, replacing)
    }

    fn evict_to_budget_locked(
        &self,
        incoming: u64,
        replacing: Option<&str>,
    ) -> Result<(), DataError> {
        self.evict_relocated_to_budget_locked(incoming, 0, replacing)
    }

    fn evict_relocated_to_budget_locked(
        &self,
        incoming: u64,
        relocating: u64,
        replacing: Option<&str>,
    ) -> Result<(), DataError> {
        loop {
            let entries = self.entries()?;
            let current = entries.iter().map(|entry| entry.2).sum::<u64>();
            let replacing_bytes = replacing
                .and_then(|key| entries.iter().find(|entry| entry.0 == key))
                .map_or(0, |entry| entry.2);
            let process = self.temp.process_temp_bytes()?;
            let free = fs2::available_space(&self.root)
                .map_err(|error| DataError::io(&self.root, error))?;
            let projected = process
                .saturating_sub(relocating)
                .saturating_add(current.saturating_sub(replacing_bytes))
                .saturating_add(incoming);
            let additional_disk_bytes = incoming.saturating_sub(relocating);
            let replaces_existing =
                replacing.is_some_and(|key| entries.iter().any(|entry| entry.0 == key));
            let count_ok = entries.len() + usize::from(!replaces_existing && incoming > 0)
                <= MAX_CACHE_ENTRIES;
            if projected <= self.temp.configured_limit()
                && free.saturating_sub(additional_disk_bytes) > QUERY_TEMP_SAFETY_RESERVE_BYTES
                && count_ok
            {
                self.temp.set_external_cache_bytes(current);
                return Ok(());
            }
            let candidates = entries
                .iter()
                .filter(|entry| replacing != Some(entry.0.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let mut candidates = candidates;
            candidates.sort_by_key(|entry| entry.1);
            let mut candidate = None;
            for entry in candidates {
                if let Some(lock) = self.try_exclusive_entry_lock(&entry.0)? {
                    candidate = Some((entry, lock));
                    break;
                }
            }
            let Some(((key, _, _, path), lock)) = candidate else {
                return Err(DataError::query_temp_limit(
                    "CSV persistent cache cannot satisfy the temporary storage budget while active entries are leased. Close other CSV tabs or increase the storage limit, then retry.",
                ));
            };
            fs::remove_dir_all(&path).map_err(|error| DataError::io(&path, error))?;
            FileExt::unlock(&lock).map_err(|error| DataError::io(&path, error))?;
            let _ = fs::remove_file(self.lock_directory.join(format!("{key}.lock")));
            if let Ok(mut audit) = self.audit.lock() {
                audit.evictions = audit.evictions.saturating_add(1);
            }
            self.refresh_usage_locked()?;
        }
    }

    fn entries(&self) -> Result<Vec<(String, u128, u64, PathBuf)>, DataError> {
        let mut output = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|error| DataError::io(&self.root, error))? {
            let path = entry
                .map_err(|error| DataError::io(&self.root, error))?
                .path();
            if !path.is_dir() {
                continue;
            }
            let Some(key) = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
            else {
                continue;
            };
            if key.starts_with('.') || key.contains(".partial") {
                continue;
            }
            let access = fs::metadata(path.join("last-access"))
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            output.push((key, access, directory_bytes(&path)?, path));
        }
        Ok(output)
    }

    fn owned_entries(&self) -> Result<Vec<(String, u64, PathBuf)>, DataError> {
        self.owned_entry_paths()?
            .into_iter()
            .map(|(key, path)| Ok((key, directory_bytes(&path)?, path)))
            .collect()
    }

    fn owned_entry_paths(&self) -> Result<Vec<(String, PathBuf)>, DataError> {
        let mut output = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|error| DataError::io(&self.root, error))? {
            let entry = entry.map_err(|error| DataError::io(&self.root, error))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| DataError::io(&path, error))?;
            if !file_type.is_dir() {
                continue;
            }
            let Some(key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_stable_cache_key(&key) {
                continue;
            }
            output.push((key, path));
        }
        Ok(output)
    }

    fn usage_locked(&self) -> Result<CsvCacheUsage, DataError> {
        let entries = self.owned_entries()?;
        Ok(CsvCacheUsage {
            bytes: entries.iter().map(|entry| entry.1).sum(),
            entries: entries.len(),
            path: self.root.to_string_lossy().into_owned(),
        })
    }

    pub(crate) fn refresh_usage(&self) -> Result<(), DataError> {
        let _global = self.lock_global()?;
        self.refresh_usage_locked()
    }

    fn refresh_usage_locked(&self) -> Result<(), DataError> {
        self.temp
            .set_external_cache_bytes(directory_bytes(&self.root)?);
        Ok(())
    }

    fn record_miss(&self) {
        if let Ok(mut audit) = self.audit.lock() {
            audit.misses = audit.misses.saturating_add(1);
        }
    }

    fn record_corruption(&self) {
        if let Ok(mut audit) = self.audit.lock() {
            audit.corruptions = audit.corruptions.saturating_add(1);
        }
    }

    fn record_scrub(&self) {
        if let Ok(mut audit) = self.audit.lock() {
            audit.scrubs = audit.scrubs.saturating_add(1);
        }
    }
}

impl CsvCacheManifest {
    fn from_identity(
        identity: &CsvCacheIdentity,
        artifacts: &[CachedArtifact],
        physical_layout: Vec<String>,
        schema_contract: Vec<String>,
    ) -> Self {
        let physical_mapping = physical_mapping(&physical_layout, &identity.physical_columns);
        let schema_fingerprint =
            layout_fingerprint(&physical_layout, &schema_contract, &physical_mapping);
        Self {
            cache_schema_version: CACHE_SCHEMA_VERSION,
            application_version: env!("CARGO_PKG_VERSION").to_owned(),
            canonical_path: identity.canonical_path.clone(),
            file_identity: identity.file_identity.clone(),
            source_bytes: identity.source_bytes,
            modified_nanos: identity.modified_nanos.map(|value| value.to_string()),
            created_nanos: identity.created_nanos.map(|value| value.to_string()),
            profile_identity: identity.profile_identity.clone(),
            rows: identity.rows.unwrap_or(0),
            columns: identity.columns,
            source_columns: identity.source_columns,
            physical_layout,
            schema_contract,
            physical_mapping,
            schema_fingerprint,
            parquet: artifacts[0].clone(),
            states: artifacts[1].clone(),
            offsets: artifacts[2].clone(),
            last_full_scrub_nanos: nonce().to_string(),
        }
    }

    fn matches(&self, identity: &CsvCacheIdentity) -> bool {
        self.cache_schema_version == CACHE_SCHEMA_VERSION
            && self.canonical_path == identity.canonical_path
            && self.file_identity == identity.file_identity
            && self.source_bytes == identity.source_bytes
            && self.modified_nanos == identity.modified_nanos.map(|value| value.to_string())
            && self.created_nanos == identity.created_nanos.map(|value| value.to_string())
            && self.profile_identity == identity.profile_identity
            && identity.rows.is_none_or(|rows| self.rows == rows)
            && self.columns == identity.columns
            && self.source_columns == identity.source_columns
    }
}

impl CachedArtifact {
    fn capture(path: &Path, with_checksum: bool) -> Result<Self, DataError> {
        let file = File::open(path).map_err(|error| DataError::io(path, error))?;
        let metadata = file
            .metadata()
            .map_err(|error| DataError::io(path, error))?;
        let nanos = |time: std::io::Result<SystemTime>| {
            time.ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos().to_string())
        };
        Ok(Self {
            bytes: metadata.len(),
            file_identity: artifact_file_identity(&file, &metadata),
            modified_nanos: nanos(metadata.modified()),
            created_nanos: nanos(metadata.created()),
            checksum: if with_checksum {
                content_checksum(path)?
            } else {
                String::new()
            },
        })
    }

    fn metadata_matches(&self, current: &Self) -> bool {
        self.bytes == current.bytes
            && self.file_identity == current.file_identity
            && self.modified_nanos == current.modified_nanos
            && self.created_nanos == current.created_nanos
    }
}

impl Drop for CsvPersistentCacheLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock);
    }
}

impl CsvPersistentCacheLease {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CacheGlobalGuard<'_> {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&*self.file);
    }
}

enum EntryValidation {
    Fast(CsvCacheManifest),
    NeedsScrub(CsvCacheManifest),
}

fn validate_entry(path: &Path, identity: &CsvCacheIdentity) -> Result<CsvCacheManifest, DataError> {
    match validate_entry_fast(path, identity)? {
        EntryValidation::Fast(manifest) => Ok(manifest),
        EntryValidation::NeedsScrub(manifest) => scrub_entry(path, identity, manifest),
    }
}

fn validate_entry_fast(
    path: &Path,
    identity: &CsvCacheIdentity,
) -> Result<EntryValidation, DataError> {
    let manifest_path = path.join(MANIFEST_NAME);
    let manifest: CsvCacheManifest = serde_json::from_slice(
        &fs::read(&manifest_path).map_err(|error| DataError::io(&manifest_path, error))?,
    )
    .map_err(|error| DataError::query_failed(format!("Invalid CSV cache manifest: {error}")))?;
    if !manifest.matches(identity) {
        return Err(DataError::query_failed(
            "CSV cache manifest identity is stale or incompatible.",
        ));
    }
    let parquet_path = path.join("prepared.parquet");
    let states_path = path.join("states.bin");
    let offsets_path = path.join("offsets.idx");
    let mut fingerprint_changed = false;
    for (artifact, expected) in [
        (&parquet_path, &manifest.parquet),
        (&states_path, &manifest.states),
        (&offsets_path, &manifest.offsets),
    ] {
        let current = CachedArtifact::capture(artifact, false)?;
        if current.bytes != expected.bytes {
            return Err(DataError::query_failed(
                "CSV cache artifact size does not match its manifest.",
            ));
        }
        fingerprint_changed |= !expected.metadata_matches(&current);
    }
    let reader = SerializedFileReader::new(
        File::open(&parquet_path).map_err(|error| DataError::io(&parquet_path, error))?,
    )
    .map_err(|error| DataError::query_failed(format!("Invalid cached Parquet footer: {error}")))?;
    if reader.metadata().file_metadata().num_rows() != manifest.rows as i64 {
        return Err(DataError::query_failed(
            "Cached Parquet row count does not match its manifest.",
        ));
    }
    let actual_layout = parquet_layout_from_reader(&reader);
    let actual_contract = parquet_schema_contract_from_reader(&reader);
    let actual_mapping = physical_mapping(&actual_layout, &identity.physical_columns);
    if actual_layout != manifest.physical_layout
        || actual_contract != manifest.schema_contract
        || actual_mapping != manifest.physical_mapping
        || !physical_contract_matches(&actual_mapping, identity)
        || layout_fingerprint(&actual_layout, &actual_contract, &actual_mapping)
            != manifest.schema_fingerprint
        || actual_layout
            .first()
            .is_none_or(|column| !column.starts_with("__dv_row_id:"))
        || !actual_layout
            .iter()
            .any(|column| column.starts_with("__dv_state_word_0:"))
    {
        return Err(DataError::query_failed(
            "Cached Parquet schema does not match its manifest.",
        ));
    }
    validate_states(&states_path, manifest.rows, identity.columns)?;
    validate_offsets(&offsets_path, manifest.rows)?;
    // This is a non-adversarial corruption policy for a disposable derived
    // cache, not a tamper-proof store. Fast hits trust the exact OS
    // identity/size/time tuple of read-only artifacts. An actor that can make
    // a file writable, alter bytes in place, and restore every timestamp can
    // hide until this bounded synchronous scrub interval expires. The scrub
    // runs before a new lease is returned, so an already-returned hit is never
    // revoked asynchronously; deleting the cache always remains a safe repair.
    let scrub_expired = manifest
        .last_full_scrub_nanos
        .parse::<u128>()
        .map_or(true, |last| {
            nonce().saturating_sub(last) >= FULL_SCRUB_INTERVAL_NANOS
        });
    if fingerprint_changed || scrub_expired {
        Ok(EntryValidation::NeedsScrub(manifest))
    } else {
        Ok(EntryValidation::Fast(manifest))
    }
}

fn parquet_schema_layout(path: &Path) -> Result<(Vec<String>, Vec<String>), DataError> {
    let reader =
        SerializedFileReader::new(File::open(path).map_err(|error| DataError::io(path, error))?)
            .map_err(|error| {
                DataError::query_failed(format!("Invalid cached Parquet footer: {error}"))
            })?;
    Ok((
        parquet_layout_from_reader(&reader),
        parquet_schema_contract_from_reader(&reader),
    ))
}

fn parquet_layout_from_reader(reader: &SerializedFileReader<File>) -> Vec<String> {
    reader
        .metadata()
        .file_metadata()
        .schema_descr()
        .columns()
        .iter()
        .map(|column| format!("{}:{:?}", column.name(), column.physical_type()))
        .collect()
}

fn parquet_schema_contract_from_reader(reader: &SerializedFileReader<File>) -> Vec<String> {
    reader
        .metadata()
        .file_metadata()
        .schema_descr()
        .columns()
        .iter()
        .map(|column| {
            format!(
                "{}|physical={:?}|logical={:?}|converted={:?}|maxDef={}|maxRep={}",
                column.name(),
                column.physical_type(),
                column.logical_type_ref(),
                column.converted_type(),
                column.max_def_level(),
                column.max_rep_level()
            )
        })
        .collect()
}

fn physical_mapping(
    layout: &[String],
    expected_values: &[CsvPreparedPhysicalColumn],
) -> Vec<CachedPhysicalMapping> {
    layout
        .iter()
        .map(|entry| {
            let (field, _parquet_type) = entry
                .rsplit_once(':')
                .unwrap_or((entry.as_str(), "UNKNOWN"));
            let field = field.to_owned();
            let (physical_kind, source_index, state_word_index) = if field == "__dv_row_id" {
                ("rowId", None, None)
            } else if let Some(index) = field
                .strip_prefix("__dv_base_raw_")
                .and_then(|value| value.parse::<usize>().ok())
            {
                ("baseRaw", Some(index), None)
            } else if let Some(index) = field
                .strip_prefix("__dv_state_word_")
                .and_then(|value| value.parse::<usize>().ok())
            {
                ("stateWord", None, Some(index))
            } else {
                let expected = expected_values.iter().find(|value| value.field == field);
                (
                    expected.map_or("unexpectedValue", |value| value.physical_kind.as_str()),
                    expected.map(|value| value.source_index),
                    None,
                )
            };
            CachedPhysicalMapping {
                field,
                physical_kind: physical_kind.to_owned(),
                source_index,
                state_word_index,
            }
        })
        .collect()
}

fn physical_contract_matches(
    mapping: &[CachedPhysicalMapping],
    identity: &CsvCacheIdentity,
) -> bool {
    let exactly_one = |predicate: &dyn Fn(&CachedPhysicalMapping) -> bool| {
        mapping.iter().filter(|entry| predicate(entry)).count() == 1
    };
    if mapping.len()
        != 1 + identity.source_columns
            + identity.source_columns.div_ceil(32)
            + identity.physical_columns.len()
        || !exactly_one(&|entry| entry.physical_kind == "rowId")
    {
        return false;
    }
    for source_index in 0..identity.source_columns {
        if !exactly_one(&|entry| {
            entry.physical_kind == "baseRaw" && entry.source_index == Some(source_index)
        }) {
            return false;
        }
    }
    for word_index in 0..identity.source_columns.div_ceil(32) {
        if !exactly_one(&|entry| {
            entry.physical_kind == "stateWord" && entry.state_word_index == Some(word_index)
        }) {
            return false;
        }
    }
    identity.physical_columns.iter().all(|expected| {
        exactly_one(&|entry| {
            entry.field == expected.field
                && entry.physical_kind == expected.physical_kind
                && entry.source_index == Some(expected.source_index)
        })
    })
}

fn layout_fingerprint(
    layout: &[String],
    schema_contract: &[String],
    physical_mapping: &[CachedPhysicalMapping],
) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    let values = layout
        .iter()
        .chain(schema_contract)
        .map(String::as_str)
        .chain(
            physical_mapping
                .iter()
                .flat_map(|mapping| [mapping.field.as_str(), mapping.physical_kind.as_str()]),
        );
    for byte in values.flat_map(|value| value.bytes().chain([0])) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    for mapping in physical_mapping {
        for index in [mapping.source_index, mapping.state_word_index] {
            for byte in index.map_or(u64::MAX, |value| value as u64).to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    format!("fnv1a64:{hash:016x}")
}

fn scrub_entry(
    path: &Path,
    identity: &CsvCacheIdentity,
    mut manifest: CsvCacheManifest,
) -> Result<CsvCacheManifest, DataError> {
    let artifacts = REQUIRED_FILES
        .iter()
        .map(|name| CachedArtifact::capture(&path.join(name), true))
        .collect::<Result<Vec<_>, _>>()?;
    for (actual, expected) in
        artifacts
            .iter()
            .zip([&manifest.parquet, &manifest.states, &manifest.offsets])
    {
        if actual.bytes != expected.bytes || actual.checksum != expected.checksum {
            return Err(DataError::query_failed(
                "CSV cache artifact content checksum does not match its manifest.",
            ));
        }
    }
    manifest.parquet = artifacts[0].clone();
    manifest.states = artifacts[1].clone();
    manifest.offsets = artifacts[2].clone();
    manifest.last_full_scrub_nanos = nonce().to_string();
    write_manifest_atomic(path, &manifest)?;
    match validate_entry_fast(path, identity)? {
        EntryValidation::Fast(manifest) => Ok(manifest),
        EntryValidation::NeedsScrub(_) => Err(DataError::query_failed(
            "CSV cache artifact fingerprint did not stabilize after scrub.",
        )),
    }
}

fn validate_states(path: &Path, rows: u64, columns: usize) -> Result<(), DataError> {
    let mut file = File::open(path).map_err(|error| DataError::io(path, error))?;
    let mut header = [0_u8; 24];
    file.read_exact(&mut header)
        .map_err(|error| DataError::io(path, error))?;
    if &header[..8] != b"DVST\x01\0\0\0"
        || u64::from_le_bytes(header[8..16].try_into().unwrap()) != rows
        || u64::from_le_bytes(header[16..24].try_into().unwrap()) != columns as u64
    {
        return Err(DataError::query_failed(
            "Invalid CSV cache state bitmap header.",
        ));
    }
    let words = rows.saturating_add(31) / 32;
    let expected = 24_u64.saturating_add(words.saturating_mul(columns as u64).saturating_mul(8));
    if file
        .metadata()
        .map_err(|error| DataError::io(path, error))?
        .len()
        != expected
    {
        return Err(DataError::query_failed(
            "Invalid CSV cache state bitmap length.",
        ));
    }
    Ok(())
}

fn validate_offsets(path: &Path, rows: u64) -> Result<(), DataError> {
    let mut file = File::open(path).map_err(|error| DataError::io(path, error))?;
    let mut header = [0_u8; 16];
    file.read_exact(&mut header)
        .map_err(|error| DataError::io(path, error))?;
    if &header[..8] != b"DVOF\x01\0\0\0" {
        return Err(DataError::query_failed("Invalid CSV cache offset header."));
    }
    let count = u64::from_le_bytes(header[8..16].try_into().unwrap());
    if (rows == 0 && count != 0) || (rows > 0 && count == 0) {
        return Err(DataError::query_failed(
            "Invalid CSV cache offset checkpoint count.",
        ));
    }
    let expected = 16_u64.saturating_add(count.saturating_mul(16));
    if file
        .metadata()
        .map_err(|error| DataError::io(path, error))?
        .len()
        != expected
    {
        return Err(DataError::query_failed("Invalid CSV cache offset length."));
    }
    let mut previous_row = None;
    let mut previous_offset = None;
    for index in 0..count {
        let mut item = [0_u8; 16];
        file.read_exact(&mut item)
            .map_err(|error| DataError::io(path, error))?;
        let row = u64::from_le_bytes(item[..8].try_into().unwrap());
        let offset = u64::from_le_bytes(item[8..].try_into().unwrap());
        if row >= rows.max(1)
            || (index == 0 && row != 0)
            || previous_row.is_some_and(|value| row <= value)
            || previous_offset.is_some_and(|value| offset <= value)
        {
            return Err(DataError::query_failed(
                "Invalid CSV cache offset ordering.",
            ));
        }
        previous_row = Some(row);
        previous_offset = Some(offset);
    }
    Ok(())
}

fn cache_key(identity: &CsvCacheIdentity) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in format!(
        "{}|{}|{}|{:?}|{:?}|{}|{}|{}|{}",
        identity.canonical_path,
        identity.file_identity,
        identity.source_bytes,
        identity.modified_nanos,
        identity.created_nanos,
        identity.profile_identity,
        identity.columns,
        identity.source_columns,
        CACHE_SCHEMA_VERSION
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn manifest_cache_key(manifest: &CsvCacheManifest) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in format!(
        "{}|{}|{}|{:?}|{:?}|{}|{}|{}|{}",
        manifest.canonical_path,
        manifest.file_identity,
        manifest.source_bytes,
        manifest
            .modified_nanos
            .as_deref()
            .and_then(|value| value.parse::<u128>().ok()),
        manifest
            .created_nanos
            .as_deref()
            .and_then(|value| value.parse::<u128>().ok()),
        manifest.profile_identity,
        manifest.columns,
        manifest.source_columns,
        CACHE_SCHEMA_VERSION
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn manifest_legacy_cache_key(manifest: &CsvCacheManifest) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in format!(
        "{}|{}|{}|{:?}|{:?}|{}|{}|{}|{}|{}",
        manifest.canonical_path,
        manifest.file_identity,
        manifest.source_bytes,
        manifest
            .modified_nanos
            .as_deref()
            .and_then(|value| value.parse::<u128>().ok()),
        manifest
            .created_nanos
            .as_deref()
            .and_then(|value| value.parse::<u128>().ok()),
        manifest.profile_identity,
        manifest.columns,
        manifest.source_columns,
        CACHE_SCHEMA_VERSION,
        manifest.application_version,
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn manifest_artifacts_have_expected_sizes(path: &Path, manifest: &CsvCacheManifest) -> bool {
    [
        ("prepared.parquet", manifest.parquet.bytes),
        ("states.bin", manifest.states.bytes),
        ("offsets.idx", manifest.offsets.bytes),
    ]
    .into_iter()
    .all(|(name, expected)| {
        fs::metadata(path.join(name))
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == expected)
    })
}

#[cfg(test)]
fn legacy_versioned_cache_key(identity: &CsvCacheIdentity, application_version: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in format!(
        "{}|{}|{}|{:?}|{:?}|{}|{}|{}|{}|{}",
        identity.canonical_path,
        identity.file_identity,
        identity.source_bytes,
        identity.modified_nanos,
        identity.created_nanos,
        identity.profile_identity,
        identity.columns,
        identity.source_columns,
        CACHE_SCHEMA_VERSION,
        application_version
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn is_stable_cache_key(key: &str) -> bool {
    key.len() == 16
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn directory_bytes(path: &Path) -> Result<u64, DataError> {
    let mut total = 0_u64;
    for entry in fs::read_dir(path).map_err(|error| DataError::io(path, error))? {
        let entry = entry.map_err(|error| DataError::io(path, error))?;
        let metadata = entry
            .metadata()
            .map_err(|error| DataError::io(&entry.path(), error))?;
        total = total.saturating_add(if metadata.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            metadata.len()
        });
    }
    Ok(total)
}

#[cfg(windows)]
fn artifact_file_identity(file: &File, metadata: &fs::Metadata) -> String {
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Information {
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
            information: *mut Information,
        ) -> i32;
    }
    let mut information = Information::default();
    // SAFETY: `file` owns the handle and `information` is a valid writable
    // Win32 BY_HANDLE_FILE_INFORMATION-compatible structure.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) } != 0 {
        let index =
            (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
        format!(
            "windows:{:08x}:{index:016x}",
            information.volume_serial_number
        )
    } else {
        format!("windows-fallback:created={}", metadata.creation_time())
    }
}

#[cfg(unix)]
fn artifact_file_identity(_file: &File, metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("unix:{:016x}:{:016x}", metadata.dev(), metadata.ino())
}

#[cfg(not(any(windows, unix)))]
fn artifact_file_identity(_file: &File, metadata: &fs::Metadata) -> String {
    format!(
        "fallback:created={:?}:len={}",
        metadata.created().ok(),
        metadata.len()
    )
}

fn set_read_only(path: &Path) -> Result<(), DataError> {
    let mut permissions = fs::metadata(path)
        .map_err(|error| DataError::io(path, error))?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|error| DataError::io(path, error))
}

fn set_writable(path: &Path) -> Result<(), DataError> {
    let mut permissions = fs::metadata(path)
        .map_err(|error| DataError::io(path, error))?
        .permissions();
    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() | 0o200);
    }
    #[cfg(not(any(windows, unix)))]
    {
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
    }
    fs::set_permissions(path, permissions).map_err(|error| DataError::io(path, error))
}

fn write_manifest_atomic(path: &Path, manifest: &CsvCacheManifest) -> Result<(), DataError> {
    let destination = path.join(MANIFEST_NAME);
    let temporary = path.join(format!("{MANIFEST_NAME}.partial-{}", nonce()));
    let bytes =
        serde_json::to_vec(manifest).map_err(|error| DataError::query_failed(error.to_string()))?;
    let mut file = File::create(&temporary).map_err(|error| DataError::io(&temporary, error))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| DataError::io(&temporary, error))?;
    drop(file);
    replace_file_atomic(&temporary, &destination).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

fn cleanup_orphan_manifest_partials(entry: &Path) -> Result<(), DataError> {
    const PREFIX: &str = "cache-manifest.json.partial-";
    for candidate in fs::read_dir(entry).map_err(|error| DataError::io(entry, error))? {
        let candidate = candidate.map_err(|error| DataError::io(entry, error))?;
        let file_type = candidate
            .file_type()
            .map_err(|error| DataError::io(&candidate.path(), error))?;
        let name = candidate.file_name();
        let is_manifest_orphan = file_type.is_file()
            && name
                .to_str()
                .and_then(|name| name.strip_prefix(PREFIX))
                .is_some_and(|suffix| !suffix.is_empty());
        if is_manifest_orphan {
            fs::remove_file(candidate.path())
                .map_err(|error| DataError::io(&candidate.path(), error))?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomic(source: &Path, destination: &Path) -> Result<(), DataError> {
    fs::rename(source, destination).map_err(|error| DataError::io(destination, error))
}

#[cfg(windows)]
fn replace_file_atomic(source: &Path, destination: &Path) -> Result<(), DataError> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 paths are NUL-terminated and remain alive through
    // the synchronous Win32 replacement call.
    if unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(DataError::io(destination, std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn content_checksum(path: &Path) -> Result<String, DataError> {
    const POLYNOMIAL: u64 = 0x42f0_e1eb_a9ea_3693;
    static TABLE: OnceLock<[u64; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0_u64; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut crc = (index as u64) << 56;
            for _ in 0..8 {
                crc = if crc & (1 << 63) != 0 {
                    (crc << 1) ^ POLYNOMIAL
                } else {
                    crc << 1
                };
            }
            *slot = crc;
        }
        table
    });
    let mut file = File::open(path).map_err(|error| DataError::io(path, error))?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut checksum = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| DataError::io(path, error))?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            let index = ((checksum >> 56) as u8 ^ byte) as usize;
            checksum = (checksum << 8) ^ table[index];
        }
    }
    Ok(format!("crc64-ecma:{checksum:016x}"))
}

fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use arrow_array::{RecordBatch, StringArray, UInt64Array};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::{arrow::ArrowWriter, file::properties::WriterProperties};

    const CHILD_MODE: &str = "DV_CSV_CACHE_LOCK_CHILD_MODE";
    const CHILD_ROOT: &str = "DV_CSV_CACHE_LOCK_CHILD_ROOT";
    const CHILD_READY: &str = "DV_CSV_CACHE_LOCK_CHILD_READY";
    const CHILD_RELEASE: &str = "DV_CSV_CACHE_LOCK_CHILD_RELEASE";

    fn wait_for_path(path: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !path.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {path:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn cache_lock_subprocess_helper() {
        let Ok(mode) = std::env::var(CHILD_MODE) else {
            return;
        };
        let root = PathBuf::from(std::env::var(CHILD_ROOT).unwrap());
        let ready = PathBuf::from(std::env::var(CHILD_READY).unwrap());
        let release = PathBuf::from(std::env::var(CHILD_RELEASE).unwrap());
        let temp = Arc::new(QueryTempManager::open(&root, 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(&root, temp).unwrap();
        match mode.as_str() {
            "publisher" => {
                let _global = cache.lock_global().unwrap();
                let partial = cache.root.join("child-publisher.partial-test");
                fs::create_dir_all(&partial).unwrap();
                fs::write(partial.join(PARTIAL_MARKER), b"live-child").unwrap();
                fs::write(&ready, b"ready").unwrap();
                wait_for_path(&release);
            }
            "publish-cache" => {
                let source = root.join(format!("child-publish-source-{}", std::process::id()));
                write_publish_artifacts(&source);
                let lease = cache
                    .publish(&publish_identity(), &source, || {
                        fs::write(&ready, b"ready").unwrap();
                        wait_for_path(&release);
                        Ok(())
                    })
                    .unwrap();
                assert!(lease.path().join(MANIFEST_NAME).is_file());
            }
            "lease" => {
                let _lease = cache.lease(String::from("entry-00")).unwrap();
                fs::write(&ready, b"ready").unwrap();
                wait_for_path(&release);
            }
            "published-lease" => {
                let _lease = cache.lease(cache_key(&publish_identity())).unwrap();
                fs::write(&ready, b"ready").unwrap();
                wait_for_path(&release);
            }
            _ => panic!("unknown child cache lock mode"),
        }
    }

    fn spawn_lock_child(
        mode: &str,
        root: &Path,
        ready: &Path,
        release: &Path,
    ) -> std::process::Child {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "storage::csv_cache::tests::cache_lock_subprocess_helper",
                "--nocapture",
            ])
            .env(CHILD_MODE, mode)
            .env(CHILD_ROOT, root)
            .env(CHILD_READY, ready)
            .env(CHILD_RELEASE, release)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }

    fn publish_identity() -> CsvCacheIdentity {
        CsvCacheIdentity {
            canonical_path: String::from("C:/fixtures/direct-publish.csv"),
            file_identity: String::from("fixture-identity"),
            source_bytes: 42,
            modified_nanos: Some(100),
            created_nanos: Some(50),
            profile_identity: String::from("profile-v1"),
            rows: Some(1),
            columns: 1,
            source_columns: 1,
            physical_columns: Vec::new(),
        }
    }

    fn write_publish_artifacts(path: &Path) -> u64 {
        fs::create_dir_all(path).unwrap();
        let schema = Arc::new(Schema::new(vec![
            Field::new("__dv_row_id", DataType::UInt64, false),
            Field::new("__dv_base_raw_0", DataType::Utf8, false),
            Field::new("__dv_state_word_0", DataType::UInt64, false),
        ]));
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(UInt64Array::from(vec![0])) as Arc<dyn arrow_array::Array>,
                Arc::new(StringArray::from(vec![Some("value")])),
                Arc::new(UInt64Array::from(vec![0])),
            ],
        )
        .unwrap();
        let parquet_path = path.join("prepared.parquet");
        let mut writer = ArrowWriter::try_new(
            File::create(&parquet_path).unwrap(),
            schema,
            Some(WriterProperties::builder().build()),
        )
        .unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
        let states_path = path.join("states.bin");
        let mut states = File::create(&states_path).unwrap();
        states.write_all(b"DVST\x01\0\0\0").unwrap();
        states.write_all(&1_u64.to_le_bytes()).unwrap();
        states.write_all(&1_u64.to_le_bytes()).unwrap();
        states.write_all(&0_u64.to_le_bytes()).unwrap();
        states.sync_all().unwrap();
        let offsets_path = path.join("offsets.idx");
        let mut offsets = File::create(&offsets_path).unwrap();
        offsets.write_all(b"DVOF\x01\0\0\0").unwrap();
        offsets.write_all(&1_u64.to_le_bytes()).unwrap();
        offsets.write_all(&0_u64.to_le_bytes()).unwrap();
        offsets.write_all(&1_u64.to_le_bytes()).unwrap();
        offsets.sync_all().unwrap();
        REQUIRED_FILES
            .iter()
            .map(|name| fs::metadata(path.join(name)).unwrap().len())
            .sum()
    }

    #[test]
    fn crc64_ecma_checksum_matches_the_standard_check_vector() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("crc64.bin");
        fs::write(&path, b"123456789").unwrap();
        assert_eq!(
            content_checksum(&path).unwrap(),
            "crc64-ecma:6c40df5f0b497347"
        );
    }

    #[test]
    fn same_volume_publish_relocates_without_copy_and_rolls_back_before_commit() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let source = local_data.path().join("query-artifacts");
        let expected_bytes = write_publish_artifacts(&source);
        let identity = publish_identity();
        let stable = cache.root.join(cache_key(&identity));

        let failure = cache
            .publish(&identity, &source, || {
                Err(DataError::query_failed("injected commit failure"))
            })
            .unwrap_err();
        assert!(failure.message.contains("injected commit failure"));
        assert!(REQUIRED_FILES
            .iter()
            .all(|name| source.join(name).is_file()));
        assert!(cache.entry_paths().is_empty());
        assert!(fs::read_dir(&cache.root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".partial")));

        let mut observed_precommit = false;
        let lease = cache
            .publish(&identity, &source, || {
                assert!(!stable.exists(), "stable key must be absent before commit");
                let partials = fs::read_dir(&cache.root)
                    .unwrap()
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.contains(".partial"))
                    })
                    .collect::<Vec<_>>();
                assert_eq!(partials.len(), 1);
                assert!(partials[0].join(PARTIAL_MARKER).is_file());
                assert!(partials[0].join(MANIFEST_NAME).is_file());
                assert!(REQUIRED_FILES
                    .iter()
                    .all(|name| partials[0].join(name).is_file()));
                observed_precommit = true;
                Ok(())
            })
            .unwrap();
        assert!(observed_precommit);
        assert_eq!(lease.path(), stable);
        assert!(
            stable.is_dir(),
            "stable key appears only at directory rename"
        );
        assert!(fs::read_dir(&cache.root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".partial")));
        assert!(REQUIRED_FILES
            .iter()
            .all(|name| lease.path().join(name).is_file()));
        assert!(REQUIRED_FILES
            .iter()
            .all(|name| !source.join(name).exists()));
        let audit = cache.audit();
        assert_eq!(audit.publishes, 1);
        assert_eq!(audit.relocated_bytes, expected_bytes);
        assert_eq!(audit.copied_bytes, 0);
        let hit = cache
            .lookup(&identity)
            .unwrap()
            .expect("published cache hit");
        assert_eq!(hit.path, lease.path());

        let replacement_source = local_data.path().join("replacement-query-artifacts");
        write_publish_artifacts(&replacement_source);
        let mut replacement_identity = identity.clone();
        replacement_identity.profile_identity = String::from("profile-v2");
        let replacement_stable = cache.root.join(cache_key(&replacement_identity));
        let rename_failure = cache
            .publish(&replacement_identity, &replacement_source, || {
                fs::create_dir(&replacement_stable).unwrap();
                fs::write(replacement_stable.join("rename-blocker"), b"occupied").unwrap();
                Ok(())
            })
            .unwrap_err();
        assert_eq!(rename_failure.code, crate::domain::DataErrorCode::Io);
        assert!(REQUIRED_FILES
            .iter()
            .all(|name| replacement_source.join(name).is_file()));
        assert!(fs::read_dir(&cache.root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".partial")));
        assert!(validate_entry(&stable, &identity).is_ok());
        assert_eq!(hit.path, stable);
        fs::remove_file(replacement_stable.join("rename-blocker")).unwrap();
        fs::remove_dir(&replacement_stable).unwrap();
    }

    #[test]
    fn cache_usage_and_clear_report_active_deleted_and_remaining_entries() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let source = local_data.path().join("clear-artifacts");
        write_publish_artifacts(&source);
        let lease = cache
            .publish(&publish_identity(), &source, || Ok(()))
            .unwrap();
        let usage = cache.usage().unwrap();
        assert!(usage.bytes > 0);
        assert_eq!(usage.entries, 1);
        assert_eq!(usage.path, cache.root.to_string_lossy());

        let unrelated = cache.root.join("source-files-must-never-be-cleared");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("source.csv"), b"source-data").unwrap();
        let active = cache.clear_inactive().unwrap();
        assert_eq!(active.deleted_bytes, 0);
        assert_eq!(active.deleted_entries, 0);
        assert_eq!(active.skipped_active_bytes, usage.bytes);
        assert_eq!(active.skipped_active_entries, 1);
        assert!(active.cleanup_failures.is_empty());
        assert_eq!(active.remaining_cache_bytes, usage.bytes);
        assert_eq!(active.remaining_cache_entries, 1);
        assert!(lease.path().is_dir());
        assert!(unrelated.join("source.csv").is_file());

        drop(lease);
        let deleted = cache.clear_inactive().unwrap();
        assert_eq!(deleted.deleted_bytes, usage.bytes);
        assert_eq!(deleted.deleted_entries, 1);
        assert_eq!(deleted.skipped_active_bytes, 0);
        assert_eq!(deleted.skipped_active_entries, 0);
        assert!(deleted.cleanup_failures.is_empty());
        assert_eq!(deleted.remaining_cache_bytes, 0);
        assert_eq!(deleted.remaining_cache_entries, 0);
        assert!(unrelated.join("source.csv").is_file());

        let repeated = cache.clear_inactive().unwrap();
        assert_eq!(repeated, CsvCacheCleanupResult::default());
    }

    #[test]
    fn usage_and_clear_include_app_owned_corrupt_entries_without_a_manifest() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let corrupt = cache.root.join("0123456789abcdef");
        fs::create_dir(&corrupt).unwrap();
        fs::write(corrupt.join("orphaned-artifact"), b"cache-bytes").unwrap();

        let usage = cache.usage().unwrap();
        assert_eq!(usage.bytes, 11);
        assert_eq!(usage.entries, 1);
        let cleared = cache.clear_inactive().unwrap();
        assert_eq!(cleared.deleted_bytes, 11);
        assert_eq!(cleared.deleted_entries, 1);
        assert_eq!(cleared.remaining_cache_bytes, 0);
        assert_eq!(cleared.remaining_cache_entries, 0);
        assert!(!corrupt.exists());
    }

    #[test]
    fn cache_clear_records_entry_lock_failures_and_leaves_the_entry_intact() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let source = local_data.path().join("failure-artifacts");
        write_publish_artifacts(&source);
        let lease = cache
            .publish(&publish_identity(), &source, || Ok(()))
            .unwrap();
        let entry = lease.path().to_path_buf();
        let key = cache_key(&publish_identity());
        drop(lease);

        let lock_path = cache.lock_directory.join(format!("{key}.lock"));
        fs::remove_file(&lock_path).unwrap();
        fs::create_dir(&lock_path).unwrap();
        let result = cache.clear_inactive().unwrap();
        assert_eq!(result.deleted_entries, 0);
        assert_eq!(result.skipped_active_entries, 0);
        assert_eq!(result.cleanup_failures.len(), 1);
        assert_eq!(result.remaining_cache_entries, 1);
        assert!(entry.is_dir());

        fs::remove_dir(&lock_path).unwrap();
        let retry = cache.clear_inactive().unwrap();
        assert_eq!(retry.deleted_entries, 1);
        assert!(retry.cleanup_failures.is_empty());
        assert_eq!(retry.remaining_cache_entries, 0);
    }

    #[test]
    fn cache_clear_skips_an_entry_leased_by_another_process() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let source = local_data.path().join("subprocess-clear-artifacts");
        write_publish_artifacts(&source);
        drop(
            cache
                .publish(&publish_identity(), &source, || Ok(()))
                .unwrap(),
        );

        let ready = local_data.path().join("clear-lease.ready");
        let release = local_data.path().join("clear-lease.release");
        let mut child = spawn_lock_child("published-lease", local_data.path(), &ready, &release);
        wait_for_path(&ready);
        let skipped = cache.clear_inactive().unwrap();
        assert_eq!(skipped.deleted_entries, 0);
        assert_eq!(skipped.skipped_active_entries, 1);
        assert_eq!(skipped.remaining_cache_entries, 1);

        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());
        let deleted = cache.clear_inactive().unwrap();
        assert_eq!(deleted.deleted_entries, 1);
        assert_eq!(deleted.remaining_cache_entries, 0);
    }

    #[test]
    fn manifest_application_version_does_not_invalidate_compatible_cache_layout() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let source = local_data.path().join("version-artifacts");
        write_publish_artifacts(&source);
        drop(
            cache
                .publish(&publish_identity(), &source, || Ok(()))
                .unwrap(),
        );
        let entry = cache.root.join(cache_key(&publish_identity()));
        let manifest_path = entry.join(MANIFEST_NAME);
        let mut manifest: CsvCacheManifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest.application_version = String::from("999.0.0-test");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        assert!(manifest.matches(&publish_identity()));
        let hit = cache
            .lookup(&publish_identity())
            .unwrap()
            .expect("application version alone must not invalidate the cache");
        assert_eq!(hit.path, entry);

        manifest.cache_schema_version = CACHE_SCHEMA_VERSION + 1;
        assert!(!manifest.matches(&publish_identity()));
        manifest.cache_schema_version = CACHE_SCHEMA_VERSION;
        let mut changed_profile = publish_identity();
        changed_profile.profile_identity = String::from("different-profile");
        assert!(!manifest.matches(&changed_profile));
    }

    #[test]
    fn legacy_versioned_key_is_discovered_without_repreparing() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), temp).unwrap();
        let identity = publish_identity();
        let source = local_data.path().join("legacy-version-artifacts");
        write_publish_artifacts(&source);
        drop(cache.publish(&identity, &source, || Ok(())).unwrap());

        let current_entry = cache.root.join(cache_key(&identity));
        let legacy_key = legacy_versioned_cache_key(&identity, "0.0.legacy");
        let legacy_entry = cache.root.join(&legacy_key);
        fs::rename(&current_entry, &legacy_entry).unwrap();

        let hit = cache
            .lookup(&identity)
            .unwrap()
            .expect("compatible cache under the old application-version key must be reused");
        assert_eq!(hit.path, legacy_entry);
        assert_eq!(cache.audit().hits, 1);
        assert_eq!(cache.audit().misses, 0);
        assert!(!current_entry.exists());
    }

    #[test]
    fn tmp18_query_reclaim_removes_minimum_inactive_lru_and_preserves_active_and_foreign() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), Arc::clone(&temp)).unwrap();

        let first_source = local_data.path().join("first-artifacts");
        write_publish_artifacts(&first_source);
        let mut first_identity = publish_identity();
        first_identity.profile_identity = String::from("phase18-first");
        let first = cache
            .publish(&first_identity, &first_source, || Ok(()))
            .unwrap();
        let first_path = first.path().to_owned();
        drop(first);
        std::thread::sleep(std::time::Duration::from_millis(5));

        let second_source = local_data.path().join("second-artifacts");
        write_publish_artifacts(&second_source);
        let mut second_identity = publish_identity();
        second_identity.profile_identity = String::from("phase18-second");
        let second = cache
            .publish(&second_identity, &second_source, || Ok(()))
            .unwrap();
        let second_path = second.path().to_owned();
        drop(second);

        let foreign = cache.root.join("0123456789abcdef");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join(MANIFEST_NAME), b"not an app cache manifest").unwrap();
        fs::write(foreign.join("payload"), b"foreign").unwrap();

        let first_key = first_path.file_name().unwrap().to_str().unwrap().to_owned();
        let active = cache.lease(first_key).unwrap();
        cache.refresh_usage().unwrap();
        let second_bytes = directory_bytes(&second_path).unwrap();
        let usage = temp.usage().unwrap();
        let target = 64 * 1024;
        temp.set_limit(
            usage
                .process_bytes
                .saturating_sub(second_bytes)
                .saturating_add(target),
        );

        assert!(cache.reclaim_for_query(target).unwrap() >= target);
        assert!(
            first_path.exists(),
            "the active shared lease must be preserved"
        );
        assert!(
            !second_path.exists(),
            "the oldest reclaimable inactive peer is sufficient"
        );
        assert!(
            foreign.exists(),
            "unvalidated cache-like directories are foreign"
        );
        drop(active);
    }

    #[test]
    fn tmp18_running_pressure_reclaims_inactive_then_active_only_fails_typed() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), Arc::clone(&temp)).unwrap();

        let active_source = local_data.path().join("active-artifacts");
        write_publish_artifacts(&active_source);
        let mut active_identity = publish_identity();
        active_identity.profile_identity = String::from("phase18-active");
        let active = cache
            .publish(&active_identity, &active_source, || Ok(()))
            .unwrap();
        let active_path = active.path().to_owned();

        let inactive_source = local_data.path().join("inactive-artifacts");
        write_publish_artifacts(&inactive_source);
        let mut inactive_identity = publish_identity();
        inactive_identity.profile_identity = String::from("phase18-inactive");
        let inactive = cache
            .publish(&inactive_identity, &inactive_source, || Ok(()))
            .unwrap();
        let inactive_path = inactive.path().to_owned();
        drop(inactive);

        cache.refresh_usage().unwrap();
        let inactive_bytes = directory_bytes(&inactive_path).unwrap();
        let usage = temp.usage().unwrap();
        temp.set_limit(
            usage
                .process_bytes
                .saturating_sub(inactive_bytes)
                .saturating_add(1),
        );
        assert!(temp.budget_violation().unwrap().is_some());
        assert!(cache.reclaim_under_pressure().unwrap());
        assert!(active_path.exists());
        assert!(!inactive_path.exists());

        cache.refresh_usage().unwrap();
        let active_only = temp.usage().unwrap();
        temp.set_limit(active_only.process_bytes.saturating_sub(1));
        let error = cache.reclaim_for_query(64 * 1024).unwrap_err();
        assert_eq!(
            error.code,
            crate::domain::DataErrorCode::QueryTempLimitExceeded
        );
        assert!(error.message.contains("Clear inactive CSV cache"));
        assert!(!error
            .message
            .contains(&local_data.path().to_string_lossy().to_string()));
        assert!(active_path.exists());
        drop(active);
    }

    #[test]
    fn tmp18_reclaim_skips_a_delete_failure_and_uses_the_next_valid_candidate() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), Arc::clone(&temp)).unwrap();

        for index in 0..3 {
            let source = local_data.path().join(format!("failure-artifacts-{index}"));
            write_publish_artifacts(&source);
            let mut identity = publish_identity();
            identity.profile_identity = format!("phase18-failure-{index}");
            drop(cache.publish(&identity, &source, || Ok(())).unwrap());
        }
        for path in cache.entry_paths() {
            fs::remove_file(path.join("last-access")).unwrap();
        }
        cache.refresh_usage().unwrap();
        let candidates = cache.reclaimable_entries_locked().unwrap();
        assert_eq!(candidates.len(), 3);
        assert!(candidates.windows(2).all(|pair| pair[0].0 < pair[1].0));

        let target = 64 * 1024;
        let usage = temp.usage().unwrap();
        temp.set_limit(
            usage
                .process_bytes
                .saturating_sub(candidates[1].2)
                .saturating_add(target),
        );
        cache.fail_next_reclaim_delete(candidates[0].0.clone());

        assert!(cache.reclaim_for_query(target).unwrap() >= target);
        assert!(
            candidates[0].3.exists(),
            "the failed candidate is not retried"
        );
        assert!(!candidates[0].3.join("states.bin").exists());
        assert!(
            !candidates[1].3.exists(),
            "the next valid candidate is reclaimed"
        );
        assert!(candidates[2].3.exists());
        assert!(cache
            .reclaimable_entries_locked()
            .unwrap()
            .iter()
            .all(|entry| entry.0 != candidates[0].0));

        cache.refresh_usage().unwrap();
        let active_usage = temp.usage().unwrap();
        temp.set_limit(active_usage.process_bytes.saturating_sub(1));
        cache.fail_next_reclaim_delete(candidates[2].0.clone());
        let error = cache.reclaim_for_query(target).unwrap_err();
        assert_eq!(
            error.code,
            crate::domain::DataErrorCode::QueryTempLimitExceeded
        );
        assert!(error.message.contains("Clear inactive CSV cache"));
        assert!(candidates[0].3.exists());
        assert!(candidates[2].3.exists());
    }

    #[test]
    fn tmp18_same_timestamp_reclaim_uses_cache_key_as_a_stable_tie_break() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = CsvPersistentCache::open(local_data.path(), Arc::clone(&temp)).unwrap();

        for suffix in ["a", "b"] {
            let source = local_data.path().join(format!("tie-artifacts-{suffix}"));
            write_publish_artifacts(&source);
            let mut identity = publish_identity();
            identity.profile_identity = format!("phase18-tie-{suffix}");
            drop(cache.publish(&identity, &source, || Ok(())).unwrap());
        }
        for path in cache.entry_paths() {
            fs::remove_file(path.join("last-access")).unwrap();
        }
        cache.refresh_usage().unwrap();
        let candidates = cache.reclaimable_entries_locked().unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].1, candidates[1].1);
        assert!(candidates[0].0 < candidates[1].0);

        let target = 64 * 1024;
        let usage = temp.usage().unwrap();
        temp.set_limit(
            usage
                .process_bytes
                .saturating_sub(candidates[0].2)
                .saturating_add(target),
        );
        assert!(cache.reclaim_for_query(target).unwrap() >= target);
        assert!(!candidates[0].3.exists());
        assert!(candidates[1].3.exists());
    }

    #[test]
    fn process_shared_lru_usage_and_partial_cleanup_respect_global_and_entry_locks() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache =
            Arc::new(CsvPersistentCache::open(local_data.path(), Arc::clone(&temp)).unwrap());
        {
            let _global = cache.lock_global().unwrap();
            for index in 0..17 {
                let path = cache.root.join(format!("entry-{index:02}"));
                fs::create_dir(&path).unwrap();
                fs::write(path.join("payload"), [index as u8]).unwrap();
                cache.touch(&path).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            cache.refresh_usage_locked().unwrap();
        }
        let active = cache.lease(String::from("entry-00")).unwrap();
        let second_temp =
            Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let second = CsvPersistentCache::open(local_data.path(), Arc::clone(&second_temp)).unwrap();
        second
            .evict_to_budget(1, Some("new-entry"))
            .expect("inactive LRU entries can satisfy the entry bound");
        assert!(cache.root.join("entry-00").exists());
        assert!(second.entries().unwrap().len() < MAX_CACHE_ENTRIES);
        assert!(second.audit().evictions >= 1);
        second.refresh_usage().unwrap();
        assert!(
            second_temp.usage().unwrap().process_bytes >= directory_bytes(&cache.root).unwrap()
        );

        let partial = cache.root.join("live-publisher.partial-test");
        let global = cache.lock_global().unwrap();
        fs::create_dir(&partial).unwrap();
        fs::write(partial.join(PARTIAL_MARKER), b"live").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let root = local_data.path().to_path_buf();
        let opener = std::thread::spawn(move || {
            let temp = Arc::new(QueryTempManager::open(&root, 256 * 1024 * 1024).unwrap());
            let opened = CsvPersistentCache::open(&root, temp).unwrap();
            sender.send(opened).unwrap();
        });
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        assert!(partial.exists());
        drop(global);
        let _third = receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        opener.join().unwrap();
        assert!(!partial.exists());
        drop(active);
    }

    #[test]
    fn subprocess_publisher_and_lease_are_protected_from_other_processes() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = Arc::new(CsvPersistentCache::open(local_data.path(), temp).unwrap());

        let publisher_ready = local_data.path().join("publisher.ready");
        let publisher_release = local_data.path().join("publisher.release");
        let mut publisher = spawn_lock_child(
            "publisher",
            local_data.path(),
            &publisher_ready,
            &publisher_release,
        );
        wait_for_path(&publisher_ready);
        let root = local_data.path().to_path_buf();
        let (sender, receiver) = std::sync::mpsc::channel();
        let opener = std::thread::spawn(move || {
            let temp = Arc::new(QueryTempManager::open(&root, 256 * 1024 * 1024).unwrap());
            sender
                .send(CsvPersistentCache::open(&root, temp).unwrap())
                .unwrap();
        });
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(150))
            .is_err());
        assert!(cache.root.join("child-publisher.partial-test").exists());
        fs::write(&publisher_release, b"release").unwrap();
        assert!(publisher.wait().unwrap().success());
        let _opened = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        opener.join().unwrap();
        assert!(!cache.root.join("child-publisher.partial-test").exists());

        {
            let _global = cache.lock_global().unwrap();
            let path = cache.root.join("entry-00");
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("payload"), b"active").unwrap();
            cache.touch(&path).unwrap();
        }
        let lease_ready = local_data.path().join("lease.ready");
        let lease_release = local_data.path().join("lease.release");
        let mut lease_child =
            spawn_lock_child("lease", local_data.path(), &lease_ready, &lease_release);
        wait_for_path(&lease_ready);
        {
            let _global = cache.lock_global().unwrap();
            for index in 1..17 {
                let path = cache.root.join(format!("entry-{index:02}"));
                fs::create_dir_all(&path).unwrap();
                fs::write(path.join("payload"), [index as u8]).unwrap();
                cache.touch(&path).unwrap();
            }
        }
        cache
            .evict_to_budget(1, Some("new-entry"))
            .expect("child-held lease must skip only the active entry");
        assert!(cache.root.join("entry-00").exists());
        fs::write(&lease_release, b"release").unwrap();
        assert!(lease_child.wait().unwrap().success());
    }

    #[test]
    fn concurrent_process_publishers_commit_once_and_active_valid_lease_blocks_eviction() {
        let local_data = tempfile::tempdir().unwrap();
        let temp = Arc::new(QueryTempManager::open(local_data.path(), 256 * 1024 * 1024).unwrap());
        let cache = Arc::new(CsvPersistentCache::open(local_data.path(), temp).unwrap());
        let child_ready = local_data.path().join("publish-cache.ready");
        let child_release = local_data.path().join("publish-cache.release");
        let mut child = spawn_lock_child(
            "publish-cache",
            local_data.path(),
            &child_ready,
            &child_release,
        );
        wait_for_path(&child_ready);

        let parent_source = local_data.path().join("parent-publish-source");
        write_publish_artifacts(&parent_source);
        let parent_cache = Arc::clone(&cache);
        let parent_identity = publish_identity();
        let parent_commit_calls = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let worker_commit_calls = Arc::clone(&parent_commit_calls);
        let (attempted_sender, attempted_receiver) = std::sync::mpsc::channel();
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let publisher = std::thread::spawn(move || {
            attempted_sender.send(()).unwrap();
            let result = parent_cache.publish(&parent_identity, &parent_source, || {
                worker_commit_calls.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                Ok(())
            });
            done_sender.send(result).unwrap();
        });
        attempted_receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        assert!(done_receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        assert!(!cache.root.join(cache_key(&publish_identity())).exists());

        fs::write(&child_release, b"release").unwrap();
        assert!(child.wait().unwrap().success());
        let parent_lease = done_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        publisher.join().unwrap();
        assert_eq!(
            parent_commit_calls.load(std::sync::atomic::Ordering::Acquire),
            0
        );
        assert_eq!(cache.audit().publishes, 0);
        assert!(REQUIRED_FILES.iter().all(|name| local_data
            .path()
            .join("parent-publish-source")
            .join(name)
            .is_file()));
        let stable = parent_lease.path().to_path_buf();
        assert!(validate_entry(&stable, &publish_identity()).is_ok());

        {
            let _global = cache.lock_global().unwrap();
            for index in 0..MAX_CACHE_ENTRIES {
                let path = cache.root.join(format!("newer-entry-{index:02}"));
                fs::create_dir(&path).unwrap();
                fs::write(path.join("payload"), [index as u8]).unwrap();
                cache.touch(&path).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        cache
            .evict_to_budget(1, Some("new-entry"))
            .expect("the active valid generation must be skipped during eviction");
        assert!(stable.is_dir());
        assert!(validate_entry(&stable, &publish_identity()).is_ok());
    }
}
