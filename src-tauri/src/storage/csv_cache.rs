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

use crate::domain::DataError;

use super::{temp::QUERY_TEMP_SAFETY_RESERVE_BYTES, QueryTempManager};

const CACHE_SCHEMA_VERSION: u32 = 2;
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

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CsvCacheAudit {
    pub hits: u64,
    pub misses: u64,
    pub corruptions: u64,
    pub publishes: u64,
    pub evictions: u64,
    pub scrubs: u64,
}

#[derive(Debug)]
pub(crate) struct CsvPersistentCache {
    root: PathBuf,
    lock_directory: PathBuf,
    temp: Arc<QueryTempManager>,
    global_lock: Mutex<File>,
    audit: Mutex<CsvCacheAudit>,
}

#[derive(Debug)]
pub(crate) struct CsvPersistentCacheLease {
    lock: File,
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
        let key = cache_key(identity);
        let path = self.root.join(&key);
        if !path.is_dir() {
            self.record_miss();
            return Ok(None);
        }
        if path.join(PARTIAL_MARKER).is_file() {
            self.record_corruption();
            self.remove_if_unleased_locked(&key, &path)?;
            self.record_miss();
            return Ok(None);
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
                self.record_miss();
                return Ok(None);
            }
        };
        self.touch(&path)?;
        // Acquire the shared entry lease while the global lock still covers
        // validation, so another process cannot evict between the two steps.
        let lease = self.lease(key)?;
        if let Ok(mut audit) = self.audit.lock() {
            audit.hits = audit.hits.saturating_add(1);
        }
        Ok(Some(CsvCacheHit {
            path,
            rows: manifest.rows,
            lease,
        }))
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
        self.evict_to_budget_locked(incoming, Some(&key))?;

        fs::create_dir(&destination).map_err(|error| DataError::io(&destination, error))?;
        let partial_marker = destination.join(PARTIAL_MARKER);
        fs::write(&partial_marker, nonce().to_le_bytes())
            .map_err(|error| DataError::io(&partial_marker, error))?;
        let result = (|| {
            for name in REQUIRED_FILES {
                let source = source_directory.join(name);
                let target = destination.join(name);
                fs::copy(&source, &target)
                    .map(|_| ())
                    .map_err(|error| DataError::io(&target, error))?;
                set_read_only(&target)?;
            }
            let artifacts = REQUIRED_FILES
                .iter()
                .map(|name| CachedArtifact::capture(&destination.join(name), true))
                .collect::<Result<Vec<_>, _>>()?;
            let manifest = CsvCacheManifest::from_identity(identity, &artifacts);
            let manifest_path = destination.join(MANIFEST_NAME);
            let bytes = serde_json::to_vec(&manifest)
                .map_err(|error| DataError::query_failed(error.to_string()))?;
            let mut file = File::create(&manifest_path)
                .map_err(|error| DataError::io(&manifest_path, error))?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| DataError::io(&manifest_path, error))?;
            self.touch(&destination)?;
            validate_entry_fast(&destination, identity)?;
            commit_check()?;
            fs::remove_file(&partial_marker)
                .map_err(|error| DataError::io(&partial_marker, error))?;
            Ok::<(), DataError>(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&destination);
            self.refresh_usage_locked()?;
            return Err(error);
        }
        self.refresh_usage_locked()?;
        if let Ok(mut audit) = self.audit.lock() {
            audit.publishes = audit.publishes.saturating_add(1);
        }
        self.lease(key)
    }

    pub(crate) fn materialize_parquet_link(
        &self,
        hit: &CsvCacheHit,
        destination: &Path,
    ) -> Result<(), DataError> {
        let source = hit.path.join("prepared.parquet");
        fs::hard_link(&source, destination)
            .or_else(|_| fs::copy(&source, destination).map(|_| ()))
            .map_err(|error| DataError::io(destination, error))
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

    fn lease(&self, key: String) -> Result<CsvPersistentCacheLease, DataError> {
        let path = self.lock_directory.join(format!("{key}.lock"));
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| DataError::io(&path, error))?;
        FileExt::lock_shared(&lock).map_err(|error| DataError::io(&path, error))?;
        Ok(CsvPersistentCacheLease { lock })
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
                .saturating_add(current.saturating_sub(replacing_bytes))
                .saturating_add(incoming);
            let replaces_existing =
                replacing.is_some_and(|key| entries.iter().any(|entry| entry.0 == key));
            let count_ok = entries.len() + usize::from(!replaces_existing && incoming > 0)
                <= MAX_CACHE_ENTRIES;
            if projected <= self.temp.configured_limit()
                && free.saturating_sub(incoming) > QUERY_TEMP_SAFETY_RESERVE_BYTES
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
                    "CSV persistent cache cannot satisfy the temporary storage budget while active entries are leased.",
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
    fn from_identity(identity: &CsvCacheIdentity, artifacts: &[CachedArtifact]) -> Self {
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
            parquet: artifacts[0].clone(),
            states: artifacts[1].clone(),
            offsets: artifacts[2].clone(),
            last_full_scrub_nanos: nonce().to_string(),
        }
    }

    fn matches(&self, identity: &CsvCacheIdentity) -> bool {
        self.cache_schema_version == CACHE_SCHEMA_VERSION
            && self.application_version == env!("CARGO_PKG_VERSION")
            && self.canonical_path == identity.canonical_path
            && self.file_identity == identity.file_identity
            && self.source_bytes == identity.source_bytes
            && self.modified_nanos == identity.modified_nanos.map(|value| value.to_string())
            && self.created_nanos == identity.created_nanos.map(|value| value.to_string())
            && self.profile_identity == identity.profile_identity
            && identity.rows.is_none_or(|rows| self.rows == rows)
            && self.columns == identity.columns
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
    let expected_parquet_columns = manifest.columns.saturating_mul(3).saturating_add(1);
    if reader
        .metadata()
        .file_metadata()
        .schema_descr()
        .num_columns()
        != expected_parquet_columns
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
        CACHE_SCHEMA_VERSION,
        env!("CARGO_PKG_VERSION")
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
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
            "lease" => {
                let _lease = cache.lease(String::from("entry-00")).unwrap();
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
}
