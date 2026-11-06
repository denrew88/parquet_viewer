use super::*;
mod recovery;
use recovery::MigrationJournal;
pub(crate) use recovery::{lock_csv_cache_control, recover_csv_cache_migration};

pub(super) const REDIRECT_NAME: &str = ".cache-moved.json";
pub(super) const TRANSACTION_NAME: &str = ".cache-migration.json";
const OWNER_NAME: &str = ".data-viewer-cache.json";
const OWNER_BYTES: &[u8] = b"{\"kind\":\"data-viewer-csv-cache\",\"version\":1}";
const MANAGED_CHILD: &str = "data-viewer-csv-cache";
const COPY_BUFFER: usize = 1024 * 1024;

fn owner_matches(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    file.take(OWNER_BYTES.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .is_ok()
        && bytes == OWNER_BYTES
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvCacheMigrationPreview {
    pub source_unavailable: bool,
    pub source_path: String,
    pub target_path: String,
    pub bytes: u64,
    pub entries: usize,
    pub active_entries: usize,
    pub available_bytes: u64,
    pub required_free_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvCacheMigrationProgress {
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub copied_entries: usize,
    pub total_entries: usize,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvCacheMigrationResult {
    pub source_path: String,
    pub target_path: String,
    pub moved_bytes: u64,
    pub moved_entries: usize,
    pub cleanup_failures: Vec<String>,
}

fn reject_reparse(path: &Path) -> Result<(), DataError> {
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(DataError::io(ancestor, error)),
        };
        let mut reparse = metadata.file_type().is_symlink();
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            reparse |= metadata.file_attributes() & 0x400 != 0;
        }
        if reparse {
            return Err(DataError::invalid_request(
                "CSV cache locations cannot contain symbolic links or reparse points.",
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_cache_location(root: &Path, configured: bool) -> Result<(), DataError> {
    reject_reparse(root)?;
    if configured {
        if !root.is_absolute() || !owner_matches(&root.join(OWNER_NAME)) {
            return Err(DataError::invalid_request("The configured CSV cache location is not an application-owned cache. Select a location and move the cache through Settings."));
        }
    } else {
        fs::create_dir_all(root).map_err(|error| DataError::io(root, error))?;
        let marker = root.join(OWNER_NAME);
        if marker.exists() {
            if !owner_matches(&marker) {
                return Err(DataError::invalid_request(
                    "The CSV cache ownership marker is invalid.",
                ));
            }
        } else {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .and_then(|mut file| file.write_all(OWNER_BYTES).and_then(|()| file.sync_all()))
                .map_err(|error| DataError::io(&marker, error))?;
        }
    }
    Ok(())
}

fn destination(source: &Path, parent: &Path) -> Result<PathBuf, DataError> {
    reject_reparse(parent)?;
    if !parent.is_absolute() || !parent.is_dir() {
        return Err(DataError::invalid_request(
            "Choose an existing absolute folder for the CSV cache.",
        ));
    }
    let parent = fs::canonicalize(parent).map_err(|error| DataError::io(parent, error))?;
    let target = parent.join(MANAGED_CHILD);
    reject_reparse(&target)?;
    let source = match fs::canonicalize(source) {
        Ok(path) => path,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            source.to_path_buf()
        }
        Err(error) => return Err(DataError::io(source, error)),
    };
    let resolved_target = if target.exists() {
        fs::canonicalize(&target).map_err(|error| DataError::io(&target, error))?
    } else {
        target.clone()
    };
    if resolved_target == source
        || resolved_target.starts_with(&source)
        || source.starts_with(&resolved_target)
    {
        return Err(DataError::invalid_request(
            "The new CSV cache must be a different folder outside the current cache tree.",
        ));
    }
    if target.exists() {
        if !target.is_dir() || !owner_matches(&target.join(OWNER_NAME)) {
            return Err(DataError::invalid_request("The destination contains a foreign folder. Choose a different location; existing files will not be overwritten."));
        }
        for entry in fs::read_dir(&target).map_err(|error| DataError::io(&target, error))? {
            let entry = entry.map_err(|error| DataError::io(&target, error))?;
            let name = entry.file_name();
            if ![
                OWNER_NAME,
                GLOBAL_LOCK_NAME,
                LOCK_DIRECTORY_NAME,
                REDIRECT_NAME,
            ]
            .iter()
            .any(|allowed| name == *allowed)
            {
                return Err(DataError::invalid_request("The destination cache is not empty. Choose an empty application cache location."));
            }
            reject_reparse(&entry.path())?;
        }
    }
    Ok(target)
}

fn manifest_identity(manifest: &CsvCacheManifest) -> CsvCacheIdentity {
    CsvCacheIdentity {
        canonical_path: manifest.canonical_path.clone(),
        file_identity: manifest.file_identity.clone(),
        source_bytes: manifest.source_bytes,
        modified_nanos: manifest
            .modified_nanos
            .as_deref()
            .and_then(|value| value.parse().ok()),
        created_nanos: manifest
            .created_nanos
            .as_deref()
            .and_then(|value| value.parse().ok()),
        profile_identity: manifest.profile_identity.clone(),
        rows: Some(manifest.rows),
        columns: manifest.columns,
        source_columns: manifest.source_columns,
        physical_columns: manifest
            .physical_mapping
            .iter()
            .filter_map(|column| {
                let source_index = column.source_index?;
                column
                    .field
                    .starts_with("__dv_value_")
                    .then(|| CsvPreparedPhysicalColumn {
                        source_index,
                        field: column.field.clone(),
                        physical_kind: column.physical_kind.clone(),
                    })
            })
            .collect(),
    }
}

fn read_owned_manifest(path: &Path) -> Result<CsvCacheManifest, DataError> {
    read_owned_manifest_cancelable(path, None)
}

fn read_owned_manifest_cancelable(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<CsvCacheManifest, DataError> {
    reject_reparse(path)?;
    let manifest_path = path.join(MANIFEST_NAME);
    reject_reparse(&manifest_path)?;
    let mut file =
        File::open(&manifest_path).map_err(|error| DataError::io(&manifest_path, error))?;
    if file
        .metadata()
        .map_err(|error| DataError::io(&manifest_path, error))?
        .len()
        > 1024 * 1024
    {
        return Err(DataError::invalid_request(
            "CSV cache manifest exceeds the migration metadata limit.",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| DataError::io(&manifest_path, error))?;
    if bytes.len() > 1024 * 1024 {
        return Err(DataError::invalid_request(
            "CSV cache manifest exceeds the migration metadata limit.",
        ));
    }
    let manifest: CsvCacheManifest = serde_json::from_slice(&bytes)
        .map_err(|_| DataError::query_failed("CSV cache manifest cannot be read for migration."))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if manifest.cache_schema_version != CACHE_SCHEMA_VERSION
        || (manifest_cache_key(&manifest) != name && manifest_legacy_cache_key(&manifest) != name)
    {
        return Err(DataError::query_failed(
            "CSV cache entry identity is invalid for migration.",
        ));
    }
    for name in REQUIRED_FILES {
        reject_reparse(&path.join(name))?;
    }
    match validate_entry_fast(path, &manifest_identity(&manifest))? {
        EntryValidation::Fast(manifest) => Ok(manifest),
        EntryValidation::NeedsScrub(manifest) => {
            for (name, expected) in
                REQUIRED_FILES
                    .iter()
                    .zip([&manifest.parquet, &manifest.states, &manifest.offsets])
            {
                let actual = capture_migration_artifact(&path.join(name), cancel)?;
                if actual.bytes != expected.bytes || actual.checksum != expected.checksum {
                    return Err(DataError::query_failed(
                        "CSV cache content changed before migration.",
                    ));
                }
            }
            Ok(manifest)
        }
    }
}

fn capture_migration_artifact(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<CachedArtifact, DataError> {
    let mut artifact = CachedArtifact::capture(path, false)?;
    artifact.checksum = content_checksum_cancelable(path, cancel)?;
    Ok(artifact)
}

pub(super) fn copy_verified(
    source: &Path,
    target: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64) -> Result<(), DataError>,
) -> Result<u64, DataError> {
    reject_reparse(source)?;
    reject_reparse(target)?;
    let mut input = File::open(source).map_err(|error| DataError::io(source, error))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| DataError::io(target, error))?;
    let mut buffer = vec![0_u8; COPY_BUFFER];
    let mut written = 0_u64;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        let length = input
            .read(&mut buffer)
            .map_err(|error| DataError::io(source, error))?;
        if length == 0 {
            break;
        }
        output
            .write_all(&buffer[..length])
            .map_err(|error| DataError::io(target, error))?;
        written = written.saturating_add(length as u64);
        progress(length as u64)?;
    }
    output
        .sync_all()
        .map_err(|error| DataError::io(target, error))?;
    drop(output);
    if written
        != input
            .metadata()
            .map_err(|error| DataError::io(source, error))?
            .len()
        || content_checksum_cancelable(source, Some(cancel))?
            != content_checksum_cancelable(target, Some(cancel))?
    {
        return Err(DataError::query_failed(
            "CSV cache copy failed content verification.",
        ));
    }
    Ok(written)
}

impl CsvPersistentCache {
    pub(crate) fn preview_migration(
        &self,
        parent: &Path,
    ) -> Result<CsvCacheMigrationPreview, DataError> {
        let _global = self.lock_global()?;
        self.preview_migration_locked(parent)
    }

    fn preview_migration_locked(
        &self,
        parent: &Path,
    ) -> Result<CsvCacheMigrationPreview, DataError> {
        let target = destination(&self.root, parent)?;
        let entries = self.reclaimable_entries_locked()?;
        let mut active = 0;
        for (key, _) in self.owned_entry_paths()? {
            if let Some(lock) = self.try_exclusive_entry_lock(&key)? {
                let _ = FileExt::unlock(&lock);
            } else {
                active += 1;
            }
        }
        let bytes = entries.iter().map(|entry| entry.2).sum::<u64>();
        Ok(CsvCacheMigrationPreview {
            source_unavailable: false,
            source_path: self.root.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            bytes,
            entries: entries.len(),
            active_entries: active,
            available_bytes: fs2::available_space(parent)
                .map_err(|error| DataError::io(parent, error))?,
            required_free_bytes: bytes.saturating_add(QUERY_TEMP_SAFETY_RESERVE_BYTES),
        })
    }

    pub(crate) fn migrate_to(
        &self,
        parent: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(CsvCacheMigrationProgress) -> Result<(), DataError>,
        commit_settings: impl FnOnce(&Path) -> Result<(), DataError>,
    ) -> Result<CsvCacheMigrationResult, DataError> {
        let _control_lock = recovery::lock_csv_cache_control(&self.control_directory)?;
        if recovery::has_pending(&self.control_directory) {
            return Err(DataError::invalid_request("A prior CSV cache move requires startup recovery before another migration can begin."));
        }
        let _source_global = self.lock_global()?;
        let preview = self.preview_migration_locked(parent)?;
        if cancel.load(Ordering::Acquire) {
            return Err(DataError::task_cancelled());
        }
        if preview.active_entries > 0 {
            return Err(DataError::invalid_request("CSV cache is in use by another application window. Close its CSV documents before moving the cache."));
        }
        if preview.bytes > self.effective_limit() {
            return Err(DataError::query_temp_limit("The existing CSV cache exceeds its effective limit. Clear inactive cache or increase the limit before moving it."));
        }
        if preview.available_bytes <= preview.required_free_bytes {
            return Err(DataError::query_temp_limit("The destination does not have enough space for the cache plus the 5 GiB safety reserve."));
        }
        // Source may already be low on disk: migration never allocates cache data there.
        // Verify it remains readable rather than requiring 5GiB free to free its space.
        let _source_free =
            fs2::available_space(&self.root).map_err(|error| DataError::io(&self.root, error))?;
        let target = PathBuf::from(&preview.target_path);
        let prior_target_redirect = if let Ok(file) = File::open(target.join(REDIRECT_NAME)) {
            let mut bytes = Vec::new();
            file.take(256 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| DataError::io(&target, error))?;
            if bytes.len() > 256 * 1024 {
                return Err(DataError::invalid_request(
                    "The destination cache redirect marker is too large.",
                ));
            }
            Some(bytes)
        } else {
            None
        };
        let target_was_absent = !target.exists();
        if target_was_absent {
            fs::create_dir(&target).map_err(|error| DataError::io(&target, error))?;
            if let Err(error) = fs::write(target.join(OWNER_NAME), OWNER_BYTES) {
                let _ = fs::remove_dir(&target);
                return Err(DataError::io(&target, error));
            }
        }
        reject_reparse(&target)?;
        fs::create_dir_all(target.join(LOCK_DIRECTORY_NAME))
            .map_err(|error| DataError::io(&target, error))?;
        let destination_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(target.join(GLOBAL_LOCK_NAME))
            .map_err(|error| DataError::io(&target, error))?;
        destination_lock.try_lock_exclusive().map_err(|_| {
            DataError::invalid_request(
                "The destination cache is in use by another application window.",
            )
        })?;
        // A different process could publish after preview and before this lock.
        // Do not silently merge with entries that were absent from the preview.
        if destination(&self.root, parent)? != target {
            return Err(DataError::invalid_request(
                "The destination location changed during migration setup.",
            ));
        }
        let entries = self.reclaimable_entries_locked()?;
        let mut entry_locks = Vec::new();
        for (key, _, _, _) in &entries {
            let lock = self.try_exclusive_entry_lock(key)?.ok_or_else(|| DataError::invalid_request("A CSV cache entry became active during migration. Retry after closing other windows."))?;
            entry_locks.push(lock);
        }
        let mut copied_bytes = 0_u64;
        let mut copied_entries = 0_usize;
        let mut journal = MigrationJournal::begin(
            self,
            &target,
            target_was_absent,
            prior_target_redirect,
            &entries,
            cancel,
        )?;
        let mut settings_committed = false;
        let operation = (|| {
            for (key, _, _, source) in &entries {
                let mut manifest = read_owned_manifest_cancelable(source, Some(cancel))?;
                let staged = journal.staged_path(key);
                fs::create_dir(&staged).map_err(|error| DataError::io(&staged, error))?;
                journal.mark_entry(&self.control_directory, &staged)?;
                for name in REQUIRED_FILES {
                    copy_verified(&source.join(name), &staged.join(name), cancel, |bytes| {
                        copied_bytes = copied_bytes.saturating_add(bytes);
                        let free = fs2::available_space(&target)
                            .map_err(|error| DataError::io(&target, error))?;
                        if free <= QUERY_TEMP_SAFETY_RESERVE_BYTES {
                            return Err(DataError::query_temp_limit("Destination disk space fell below the safety reserve while moving the CSV cache."));
                        }
                        progress(CsvCacheMigrationProgress {
                            copied_bytes,
                            total_bytes: preview.bytes,
                            copied_entries,
                            total_entries: preview.entries,
                            phase: "copying".into(),
                        })
                    })?;
                }
                let artifacts = REQUIRED_FILES
                    .iter()
                    .map(|name| capture_migration_artifact(&staged.join(name), Some(cancel)))
                    .collect::<Result<Vec<_>, _>>()?;
                for (actual, expected) in
                    artifacts
                        .iter()
                        .zip([&manifest.parquet, &manifest.states, &manifest.offsets])
                {
                    if actual.bytes != expected.bytes || actual.checksum != expected.checksum {
                        return Err(DataError::query_failed(
                            "CSV cache changed while it was being migrated.",
                        ));
                    }
                }
                manifest.parquet = artifacts[0].clone();
                manifest.states = artifacts[1].clone();
                manifest.offsets = artifacts[2].clone();
                manifest.last_full_scrub_nanos = nonce().to_string();
                write_manifest_atomic(&staged, &manifest)?;
                if source.join("last-access").is_file() {
                    fs::copy(source.join("last-access"), staged.join("last-access"))
                        .map_err(|error| DataError::io(&staged, error))?;
                }
                if cancel.load(Ordering::Acquire) {
                    return Err(DataError::task_cancelled());
                }
                validate_entry_fast(&staged, &manifest_identity(&manifest))?;
                for name in REQUIRED_FILES {
                    set_read_only(&staged.join(name))?;
                }
                let published = target.join(key);
                if published.exists() {
                    return Err(DataError::invalid_request("Destination cache entry appeared during migration; no existing entry was overwritten."));
                }
                fs::rename(&staged, &published)
                    .map_err(|error| DataError::io(&published, error))?;
                copied_entries += 1;
            }
            if cancel.load(Ordering::Acquire) {
                return Err(DataError::task_cancelled());
            }
            if target.join(REDIRECT_NAME).exists() {
                fs::remove_file(target.join(REDIRECT_NAME))
                    .map_err(|error| DataError::io(&target, error))?;
            }
            progress(CsvCacheMigrationProgress {
                copied_bytes: preview.bytes,
                total_bytes: preview.bytes,
                copied_entries,
                total_entries: preview.entries,
                phase: "committing".into(),
            })?;
            // Redirect first while source global lock is held, then persist location.
            // A failed settings commit removes redirect and destination copies.
            let redirect_path = self.root.join(REDIRECT_NAME);
            let redirect = serde_json::to_vec(&preview.target_path)
                .map_err(|error| DataError::query_failed(error.to_string()))?;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&redirect_path)
                .and_then(|mut file| file.write_all(&redirect).and_then(|()| file.sync_all()))
                .map_err(|error| DataError::io(&redirect_path, error))?;
            commit_settings(&target)?;
            settings_committed = true;
            Ok::<(), DataError>(())
        })();
        if let Err(error) = operation {
            if !settings_committed {
                journal.rollback(&self.control_directory)?;
                let _ = FileExt::unlock(&destination_lock);
                drop(destination_lock);
                if target_was_absent {
                    recovery::remove_empty_created_target(&target)?;
                }
            }
            return Err(error);
        }
        let cleanup_failures = journal
            .finish_committed(&self.control_directory)
            .unwrap_or_else(|error| vec![error.message]);
        self.temp.set_external_cache_bytes(0);
        drop(entry_locks);
        let _ = FileExt::unlock(&destination_lock);
        Ok(CsvCacheMigrationResult {
            source_path: preview.source_path,
            target_path: preview.target_path,
            moved_bytes: copied_bytes,
            moved_entries: copied_entries,
            cleanup_failures,
        })
    }
}

fn require_unavailable_source(source: &Path) -> Result<(), DataError> {
    if fs::read_dir(source).is_ok() {
        return Err(DataError::invalid_request("The previous cache location is available again. Choose the location again to move its existing cache safely."));
    }
    Ok(())
}

pub(crate) fn preview_unavailable_cache_location(
    local_data: &Path,
    source: &Path,
    parent: &Path,
) -> Result<CsvCacheMigrationPreview, DataError> {
    let _control = recovery::lock_csv_cache_control(local_data)?;
    require_unavailable_source(source)?;
    let target = destination(source, parent)?;
    Ok(CsvCacheMigrationPreview {
        source_unavailable: true,
        source_path: source.to_string_lossy().into_owned(),
        target_path: target.to_string_lossy().into_owned(),
        bytes: 0,
        entries: 0,
        active_entries: 0,
        available_bytes: fs2::available_space(parent)
            .map_err(|error| DataError::io(parent, error))?,
        required_free_bytes: QUERY_TEMP_SAFETY_RESERVE_BYTES,
    })
}

pub(crate) fn replace_unavailable_cache_location(
    local_data: &Path,
    source: &Path,
    parent: &Path,
    commit: impl FnOnce(&Path) -> Result<(), DataError>,
) -> Result<CsvCacheMigrationResult, DataError> {
    let _control = recovery::lock_csv_cache_control(local_data)?;
    require_unavailable_source(source)?;
    let target = destination(source, parent)?;
    if fs2::available_space(parent).map_err(|error| DataError::io(parent, error))?
        < QUERY_TEMP_SAFETY_RESERVE_BYTES
    {
        return Err(DataError::query_temp_limit(
            "The new cache drive must retain at least 5 GiB of free space.",
        ));
    }
    let created_root = !target.exists();
    if created_root {
        fs::create_dir(&target).map_err(|error| DataError::io(&target, error))?;
    }
    let marker = target.join(OWNER_NAME);
    if created_root {
        let result = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .and_then(|mut file| file.write_all(OWNER_BYTES).and_then(|()| file.sync_all()));
        if let Err(error) = result {
            let _ = fs::remove_file(&marker);
            let _ = fs::remove_dir(&target);
            return Err(DataError::io(&marker, error));
        }
    }
    let lock_path = target.join(GLOBAL_LOCK_NAME);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| DataError::io(&lock_path, error))?;
    lock.lock_exclusive()
        .map_err(|error| DataError::io(&lock_path, error))?;
    let old_redirect = fs::read(target.join(REDIRECT_NAME)).ok();
    let mut retired = None;
    let result = (|| {
        require_unavailable_source(source)?;
        destination(source, parent)?;
        if old_redirect.is_some() {
            fs::remove_file(target.join(REDIRECT_NAME))
                .map_err(|error| DataError::io(&target, error))?;
        }
        retired = recovery::retire_unavailable(local_data, source)?;
        commit(&target)
    })();
    if result.is_err() {
        if let Some(retired) = &retired {
            recovery::restore_retired(local_data, retired)?;
        }
        if let Some(bytes) = &old_redirect {
            fs::write(target.join(REDIRECT_NAME), bytes)
                .map_err(|error| DataError::io(&target, error))?;
        }
    }
    let _ = FileExt::unlock(&lock);
    drop(lock);
    if result.is_err() && created_root {
        reject_reparse(&target)?;
        // Only our empty metadata is removed; never recurse into a foreign insertion.
        let _ = fs::remove_file(&lock_path);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir(&target);
    }
    result?;
    Ok(CsvCacheMigrationResult {
        source_path: source.to_string_lossy().into_owned(),
        target_path: target.to_string_lossy().into_owned(),
        moved_bytes: 0,
        moved_entries: 0,
        cleanup_failures: Vec::new(),
    })
}

pub(super) fn remove_owned_tree(path: &Path) -> Result<(), DataError> {
    reject_reparse(path)?;
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| DataError::io(path, error))? {
        let entry = entry.map_err(|error| DataError::io(path, error))?;
        reject_reparse(&entry.path())?;
        if entry
            .file_type()
            .map_err(|error| DataError::io(&entry.path(), error))?
            .is_dir()
        {
            remove_owned_tree(&entry.path())?;
        } else {
            set_writable(&entry.path())?;
            fs::remove_file(entry.path()).map_err(|error| DataError::io(&entry.path(), error))?;
        }
    }
    fs::remove_dir(path).map_err(|error| DataError::io(path, error))
}

#[cfg(test)]
mod unavailable_tests {
    use super::*;

    #[test]
    fn phase21_offline_location_can_be_replaced_without_touching_old_data() {
        let directory = tempfile::tempdir().unwrap();
        let control = directory.path().join("control");
        let source = directory.path().join("offline-drive/cache");
        let parent = directory.path().join("new-location");
        fs::create_dir(&parent).unwrap();
        let preview = preview_unavailable_cache_location(&control, &source, &parent).unwrap();
        assert!(preview.source_unavailable);
        assert_eq!(preview.bytes, 0);
        let mut selected = None;
        let result = replace_unavailable_cache_location(&control, &source, &parent, |path| {
            selected = Some(path.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(selected.as_deref(), Some(Path::new(&result.target_path)));
        assert!(!source.exists());
        validate_cache_location(Path::new(&result.target_path), true).unwrap();
    }

    #[test]
    fn phase21_offline_replacement_save_failure_and_available_source_are_safe() {
        let directory = tempfile::tempdir().unwrap();
        let control = directory.path().join("control");
        let source = directory.path().join("missing");
        let parent = directory.path().join("destination");
        fs::create_dir(&parent).unwrap();
        assert!(
            replace_unavailable_cache_location(&control, &source, &parent, |_| Err(
                DataError::query_failed("settings save failed")
            ))
            .is_err()
        );
        assert!(!parent.join(MANAGED_CHILD).exists());
        fs::create_dir(&source).unwrap();
        fs::write(source.join("foreign.txt"), b"preserve").unwrap();
        assert!(preview_unavailable_cache_location(&control, &source, &parent).is_err());
        assert_eq!(fs::read(source.join("foreign.txt")).unwrap(), b"preserve");
    }
}
