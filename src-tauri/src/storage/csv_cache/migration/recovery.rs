use super::*;

const JOURNAL_NAME: &str = ".csv-cache-migration.json";
const ENTRY_MARKER: &str = ".migration-entry.json";
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;

pub(super) fn has_pending(control: &Path) -> bool {
    control.join(JOURNAL_NAME).exists()
}

pub(crate) fn lock_csv_cache_control(control: &Path) -> Result<File, DataError> {
    reject_reparse(control)?;
    fs::create_dir_all(control).map_err(|error| DataError::io(control, error))?;
    let path = control.join(".cache-migration.lock");
    reject_reparse(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| DataError::io(&path, error))?;
    file.lock_exclusive()
        .map_err(|error| DataError::io(&path, error))?;
    Ok(file)
}

fn equivalent_path(left: &Path, right: &Path) -> bool {
    if let (Ok(left), Ok(right)) = (fs::canonicalize(left), fs::canonicalize(right)) {
        return left == right;
    }
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .eq_ignore_ascii_case(
                &right
                    .to_string_lossy()
                    .trim_start_matches(r"\\?\")
                    .replace('/', "\\"),
            )
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(super) fn retire_unavailable(
    control: &Path,
    source: &Path,
) -> Result<Option<PathBuf>, DataError> {
    let journal_path = control.join(JOURNAL_NAME);
    if !journal_path.exists() {
        return Ok(None);
    }
    let journal: MigrationJournal = read_json(&journal_path)?;
    if !equivalent_path(&journal.source, source)
        || journal.operation.len() > 64
        || !journal
            .operation
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(DataError::invalid_request(
            "The pending migration journal belongs to another cache. Its data was preserved.",
        ));
    }
    let retired = control.join(format!(
        ".csv-cache-migration.retired-{}.json",
        journal.operation
    ));
    if retired.exists() {
        return Err(DataError::invalid_request(
            "An archived migration with this identity already exists.",
        ));
    }
    fs::rename(&journal_path, &retired).map_err(|error| DataError::io(control, error))?;
    sync_directory(control);
    Ok(Some(retired))
}

pub(super) fn restore_retired(control: &Path, retired: &Path) -> Result<(), DataError> {
    reject_reparse(retired)?;
    if retired.parent() != Some(control) || control.join(JOURNAL_NAME).exists() {
        return Err(DataError::invalid_request(
            "Cannot restore the interrupted migration journal safely.",
        ));
    }
    fs::rename(retired, control.join(JOURNAL_NAME))
        .map_err(|error| DataError::io(control, error))?;
    sync_directory(control);
    Ok(())
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionMarker {
    operation: String,
    control_directory: PathBuf,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryFingerprint {
    key: String,
    manifest_checksum: String,
    artifacts: Vec<(u64, String)>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MigrationJournal {
    version: u8,
    operation: String,
    source: PathBuf,
    target: PathBuf,
    target_was_absent: bool,
    prior_target_redirect: Option<Vec<u8>>,
    entries: Vec<EntryFingerprint>,
    cleanup_started: bool,
}

fn bounded_read(path: &Path, maximum: u64) -> Result<Vec<u8>, DataError> {
    reject_reparse(path)?;
    let file = File::open(path).map_err(|error| DataError::io(path, error))?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| DataError::io(path, error))?;
    if bytes.len() as u64 > maximum {
        return Err(DataError::invalid_request(
            "CSV migration metadata exceeds its bounded size limit.",
        ));
    }
    Ok(bytes)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, DataError> {
    serde_json::from_slice(&bounded_read(path, MAX_JOURNAL_BYTES)?).map_err(|_| {
        DataError::invalid_request("CSV migration metadata is invalid. No cache data was removed.")
    })
}

fn write_new_json(path: &Path, value: &impl Serialize) -> Result<(), DataError> {
    reject_reparse(path)?;
    let bytes =
        serde_json::to_vec(value).map_err(|error| DataError::query_failed(error.to_string()))?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(DataError::invalid_request(
            "CSV migration metadata exceeds its bounded size limit.",
        ));
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(&bytes).and_then(|()| file.sync_all()))
        .map_err(|error| DataError::io(path, error))
}

fn atomic_journal(
    control: &Path,
    journal: &MigrationJournal,
    first: bool,
) -> Result<(), DataError> {
    reject_reparse(control)?;
    let path = control.join(JOURNAL_NAME);
    reject_reparse(&path)?;
    if first && path.exists() {
        return Err(DataError::invalid_request(
            "A previous CSV cache migration needs startup recovery before another move.",
        ));
    }
    let temporary = control.join(format!("{JOURNAL_NAME}.partial-{}", journal.operation));
    // A previous update can leave only this transaction's complete temporary.
    if temporary.exists() {
        let saved = read_json::<MigrationJournal>(&temporary);
        if !saved
            .as_ref()
            .is_ok_and(|value| value.operation == journal.operation)
            && !(marker_matches(
                &journal.source.join(TRANSACTION_NAME),
                &journal.operation,
                control,
            )? && marker_matches(
                &journal.target.join(TRANSACTION_NAME),
                &journal.operation,
                control,
            )?)
        {
            return Err(DataError::invalid_request(
                "CSV migration journal temporary is foreign.",
            ));
        }
        fs::remove_file(&temporary).map_err(|error| DataError::io(&temporary, error))?;
    }
    write_new_json(&temporary, journal)?;
    replace_file_atomic(&temporary, &path)?;
    sync_directory(control);
    Ok(())
}

fn sync_directory(path: &Path) {
    #[cfg(unix)]
    if let Ok(file) = File::open(path) {
        let _ = file.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn normalized(path: &Path) -> Result<PathBuf, DataError> {
    reject_reparse(path)?;
    if !path.is_absolute() {
        return Err(DataError::invalid_request(
            "CSV migration paths must be absolute.",
        ));
    }
    fs::canonicalize(path).map_err(|error| DataError::io(path, error))
}

fn normalized_destination(path: &Path) -> Result<PathBuf, DataError> {
    if path.exists() {
        return normalized(path);
    }
    reject_reparse(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| DataError::invalid_request("CSV migration destination has no parent."))?;
    let name = path
        .file_name()
        .ok_or_else(|| DataError::invalid_request("CSV migration destination has no name."))?;
    Ok(normalized(parent)?.join(name))
}

fn marker_matches(path: &Path, operation: &str, control: &Path) -> Result<bool, DataError> {
    if !path.exists() {
        return Ok(false);
    }
    let marker: TransactionMarker = read_json(path)?;
    Ok(marker.operation == operation
        && normalized(&marker.control_directory)? == normalized(control)?)
}

fn remove_matching_marker(path: &Path, operation: &str, control: &Path) -> Result<(), DataError> {
    if path.exists() {
        if !marker_matches(path, operation, control)? {
            return Err(DataError::invalid_request(
                "A foreign CSV migration marker was preserved.",
            ));
        }
        fs::remove_file(path).map_err(|error| DataError::io(path, error))?;
    }
    Ok(())
}

impl MigrationJournal {
    pub(super) fn begin(
        cache: &CsvPersistentCache,
        target: &Path,
        target_was_absent: bool,
        prior_target_redirect: Option<Vec<u8>>,
        entries: &[(String, u128, u64, PathBuf)],
        cancel: &AtomicBool,
    ) -> Result<Self, DataError> {
        let mut fingerprints = Vec::new();
        for (key, _, _, path) in entries {
            let manifest = read_owned_manifest_cancelable(path, Some(cancel))?;
            fingerprints.push(EntryFingerprint {
                key: key.clone(),
                manifest_checksum: content_checksum(&path.join(MANIFEST_NAME))?,
                artifacts: [&manifest.parquet, &manifest.states, &manifest.offsets]
                    .iter()
                    .map(|artifact| (artifact.bytes, artifact.checksum.clone()))
                    .collect(),
            });
        }
        let journal = Self {
            version: 1,
            operation: format!("{:032x}-{:08x}", nonce(), std::process::id()),
            source: normalized(&cache.root)?,
            target: normalized(target)?,
            target_was_absent,
            prior_target_redirect,
            entries: fingerprints,
            cleanup_started: false,
        };
        atomic_journal(&cache.control_directory, &journal, true)?;
        let marker = TransactionMarker {
            operation: journal.operation.clone(),
            control_directory: normalized(&cache.control_directory)?,
        };
        write_new_json(&cache.root.join(TRANSACTION_NAME), &marker)?;
        write_new_json(&target.join(TRANSACTION_NAME), &marker)?;
        sync_directory(&cache.root);
        sync_directory(target);
        Ok(journal)
    }

    pub(super) fn staged_path(&self, key: &str) -> PathBuf {
        self.target
            .join(format!(".{key}.partial-migrate-{}", self.operation))
    }

    pub(super) fn mark_entry(&self, control: &Path, path: &Path) -> Result<(), DataError> {
        write_new_json(
            &path.join(ENTRY_MARKER),
            &TransactionMarker {
                operation: self.operation.clone(),
                control_directory: normalized(control)?,
            },
        )
    }

    pub(super) fn mark_committed(&mut self, control: &Path) -> Result<(), DataError> {
        self.cleanup_started = true;
        atomic_journal(control, self, false)
    }

    fn validate(&self, control: &Path) -> Result<(), DataError> {
        if self.version != 1
            || self.operation.is_empty()
            || self.operation.len() > 64
            || !self
                .operation
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            || self.entries.len() > MAX_CACHE_ENTRIES
            || self.entries.iter().any(|entry| {
                !is_stable_cache_key(&entry.key) || entry.artifacts.len() != REQUIRED_FILES.len()
            })
        {
            return Err(DataError::invalid_request(
                "CSV migration journal contract is invalid.",
            ));
        }
        reject_reparse(control)?;
        let source = normalized(&self.source)?;
        let target = normalized_destination(&self.target)?;
        if source == target
            || source.starts_with(&target)
            || target.starts_with(&source)
            || self.target.file_name().and_then(|name| name.to_str()) != Some(MANAGED_CHILD)
            || !owner_matches(&self.source.join(OWNER_NAME))
            || (self.target.exists() && !owner_matches(&self.target.join(OWNER_NAME)))
        {
            return Err(DataError::invalid_request(
                "CSV migration journal does not identify disjoint application-owned cache roots.",
            ));
        }
        // Both markers are normally present. A journal before source-marker creation
        // can only have an empty destination; completed cleanup may remove markers.
        for path in [&self.source, &self.target] {
            let marker = path.join(TRANSACTION_NAME);
            if marker.exists() && !marker_matches(&marker, &self.operation, control)? {
                return Err(DataError::invalid_request(
                    "CSV migration root belongs to another transaction.",
                ));
            }
        }
        Ok(())
    }

    fn matches_artifacts(
        &self,
        entry: &EntryFingerprint,
        path: &Path,
        source: bool,
    ) -> Result<(), DataError> {
        reject_reparse(path)?;
        let manifest = read_owned_manifest(path)?;
        if source && content_checksum(&path.join(MANIFEST_NAME))? != entry.manifest_checksum {
            return Err(DataError::invalid_request(
                "A source cache manifest changed after migration began; it was preserved.",
            ));
        }
        for ((name, expected), manifest_artifact) in REQUIRED_FILES
            .iter()
            .zip(&entry.artifacts)
            .zip([&manifest.parquet, &manifest.states, &manifest.offsets])
        {
            if manifest_artifact.bytes != expected.0
                || manifest_artifact.checksum != expected.1
                || fs::metadata(path.join(name))
                    .map_err(|error| DataError::io(path, error))?
                    .len()
                    != expected.0
                || content_checksum(&path.join(name))? != expected.1
            {
                return Err(DataError::invalid_request(
                    "A CSV cache artifact changed after migration began; it was preserved.",
                ));
            }
        }
        Ok(())
    }

    fn remove_entry(
        &self,
        control: &Path,
        path: &Path,
        source: bool,
        entry: &EntryFingerprint,
    ) -> Result<(), DataError> {
        if !path.exists() {
            return Ok(());
        }
        reject_reparse(path)?;
        let files = fs::read_dir(path)
            .map_err(|error| DataError::io(path, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| DataError::io(path, error))?;
        if source {
            self.matches_artifacts(entry, path, true)?;
        } else if !files.is_empty()
            && !marker_matches(&path.join(ENTRY_MARKER), &self.operation, control)?
        {
            return Err(DataError::invalid_request(
                "An unowned migration destination entry was preserved.",
            ));
        }
        let mut preserve_foreign = false;
        for file in &files {
            if !source {
                let name = file.file_name();
                let known = REQUIRED_FILES.iter().any(|allowed| name == *allowed)
                    || name == MANIFEST_NAME
                    || name == "last-access"
                    || name == ENTRY_MARKER
                    || name
                        .to_str()
                        .is_some_and(|name| name.starts_with("cache-manifest.json.partial-"));
                if !known {
                    preserve_foreign = true;
                    continue;
                }
            }
            reject_reparse(&file.path())?;
            let name = file.file_name();
            if !file
                .file_type()
                .map_err(|error| DataError::io(path, error))?
                .is_file()
                || !(REQUIRED_FILES.iter().any(|allowed| name == *allowed)
                    || name == MANIFEST_NAME
                    || name == "last-access"
                    || (!source && name == ENTRY_MARKER)
                    || (!source
                        && name
                            .to_str()
                            .is_some_and(|name| name.starts_with("cache-manifest.json.partial-"))))
            {
                return Err(DataError::invalid_request(
                    "Unexpected files in a cache entry were preserved during migration recovery.",
                ));
            }
        }
        // Once deletion begins, an abrupt process death can leave a partial entry.
        // Persist a source-side deletion authorization before its first unlink.
        if source {
            self.mark_source_cleanup(control, path)?;
            return self.remove_partially_deleted_source(control, path, entry);
        }
        let mut files = files;
        files.sort_by_key(|file| file.file_name() == ENTRY_MARKER);
        for file in files {
            if !source {
                let name = file.file_name();
                if !(REQUIRED_FILES.iter().any(|allowed| name == *allowed)
                    || name == MANIFEST_NAME
                    || name == "last-access"
                    || name == ENTRY_MARKER
                    || name
                        .to_str()
                        .is_some_and(|name| name.starts_with("cache-manifest.json.partial-")))
                {
                    continue;
                }
            }
            set_writable(&file.path())?;
            fs::remove_file(file.path()).map_err(|error| DataError::io(path, error))?;
        }
        if preserve_foreign {
            Ok(())
        } else {
            fs::remove_dir(path).map_err(|error| DataError::io(path, error))
        }
    }

    fn mark_source_cleanup(&self, control: &Path, path: &Path) -> Result<(), DataError> {
        let marker = path.join(ENTRY_MARKER);
        if marker.exists() {
            return Ok(());
        }
        self.mark_entry(control, path)
    }

    pub(super) fn rollback(&self, control: &Path) -> Result<(), DataError> {
        if self.cleanup_started {
            return Err(DataError::invalid_request("Settings changed back to an old cache after committed cleanup began. Both cache locations were preserved."));
        }
        for entry in &self.entries {
            self.remove_entry(control, &self.staged_path(&entry.key), false, entry)?;
            self.remove_entry(control, &self.target.join(&entry.key), false, entry)?;
        }
        let redirect = self.source.join(REDIRECT_NAME);
        if redirect.exists() {
            let recorded: String = read_json(&redirect)?;
            if Path::new(&recorded) != self.target {
                return Err(DataError::invalid_request(
                    "A changed CSV redirect was preserved.",
                ));
            }
            fs::remove_file(&redirect).map_err(|error| DataError::io(&redirect, error))?;
        }
        if let Some(bytes) = &self.prior_target_redirect {
            fs::write(self.target.join(REDIRECT_NAME), bytes)
                .map_err(|error| DataError::io(&self.target, error))?;
        }
        remove_matching_marker(
            &self.source.join(TRANSACTION_NAME),
            &self.operation,
            control,
        )?;
        remove_matching_marker(
            &self.target.join(TRANSACTION_NAME),
            &self.operation,
            control,
        )?;
        fs::remove_file(control.join(JOURNAL_NAME))
            .map_err(|error| DataError::io(control, error))?;
        sync_directory(control);
        Ok(())
    }

    pub(super) fn finish_committed(&mut self, control: &Path) -> Result<Vec<String>, DataError> {
        if !self.cleanup_started {
            for entry in &self.entries {
                self.matches_artifacts(entry, &self.target.join(&entry.key), false)?;
            }
            self.mark_committed(control)?;
        }
        let mut failures = Vec::new();
        for entry in &self.entries {
            let source = self.source.join(&entry.key);
            if !source.exists() {
                continue;
            }
            let outcome = if marker_matches(&source.join(ENTRY_MARKER), &self.operation, control)? {
                self.remove_partially_deleted_source(control, &source, entry)
            } else {
                self.remove_entry(control, &source, true, entry)
            };
            if let Err(error) = outcome {
                failures.push(error.message);
            }
        }
        for entry in &self.entries {
            remove_matching_marker(
                &self.target.join(&entry.key).join(ENTRY_MARKER),
                &self.operation,
                control,
            )?;
        }
        remove_matching_marker(
            &self.target.join(TRANSACTION_NAME),
            &self.operation,
            control,
        )?;
        remove_matching_marker(
            &self.source.join(TRANSACTION_NAME),
            &self.operation,
            control,
        )?;
        if failures.is_empty() {
            fs::remove_file(control.join(JOURNAL_NAME))
                .map_err(|error| DataError::io(control, error))?;
            sync_directory(control);
        }
        Ok(failures)
    }

    fn remove_partially_deleted_source(
        &self,
        control: &Path,
        path: &Path,
        entry: &EntryFingerprint,
    ) -> Result<(), DataError> {
        if !marker_matches(&path.join(ENTRY_MARKER), &self.operation, control)? {
            return Err(DataError::invalid_request(
                "Source cleanup marker is foreign.",
            ));
        }
        let mut files = Vec::new();
        for item in fs::read_dir(path).map_err(|error| DataError::io(path, error))? {
            let item = item.map_err(|error| DataError::io(path, error))?;
            reject_reparse(&item.path())?;
            let name = item.file_name();
            if !item
                .file_type()
                .map_err(|error| DataError::io(path, error))?
                .is_file()
                || !(REQUIRED_FILES.iter().any(|allowed| name == *allowed)
                    || name == MANIFEST_NAME
                    || name == "last-access"
                    || name == ENTRY_MARKER)
            {
                return Err(DataError::invalid_request(
                    "Foreign files in partially cleaned source were preserved.",
                ));
            }
            if let Some(index) = REQUIRED_FILES.iter().position(|known| name == *known) {
                if item
                    .metadata()
                    .map_err(|error| DataError::io(path, error))?
                    .len()
                    != entry.artifacts[index].0
                    || content_checksum(&item.path())? != entry.artifacts[index].1
                {
                    return Err(DataError::invalid_request(
                        "Changed source cache data was preserved during interrupted cleanup.",
                    ));
                }
            } else if name == MANIFEST_NAME
                && content_checksum(&item.path())? != entry.manifest_checksum
            {
                return Err(DataError::invalid_request(
                    "Changed source cache manifest was preserved during interrupted cleanup.",
                ));
            }
            files.push(item.path());
        }
        // Keep the authorization marker until the remaining owned files are gone.
        files.sort_by_key(|path| path.file_name().is_some_and(|name| name == ENTRY_MARKER));
        for file in files {
            set_writable(&file)?;
            fs::remove_file(&file).map_err(|error| DataError::io(&file, error))?;
            #[cfg(test)]
            if file.file_name().is_some_and(|name| name != ENTRY_MARKER)
                && std::env::var("DV_CSV_CACHE_LOCK_CHILD_MODE")
                    .ok()
                    .as_deref()
                    == Some("migration-delete-crash")
            {
                fs::write(
                    std::env::var("DV_CSV_CACHE_LOCK_CHILD_READY").unwrap(),
                    b"delete crash",
                )
                .unwrap();
                std::process::exit(94);
            }
        }
        fs::remove_dir(path).map_err(|error| DataError::io(path, error))
    }
}

pub(crate) fn recover_csv_cache_migration(
    local_data: &Path,
    _configured_directory: Option<&Path>,
    read_authoritative_directory: impl Fn() -> Result<Option<PathBuf>, DataError>,
) -> Result<(), DataError> {
    let _control_lock = lock_csv_cache_control(local_data)?;
    let journal_path = local_data.join(JOURNAL_NAME);
    if !journal_path.exists() {
        let selected =
            read_authoritative_directory()?.unwrap_or_else(|| local_data.join("csv-cache-v1"));
        let mut inspected = 0;
        for item in fs::read_dir(local_data).map_err(|error| DataError::io(local_data, error))? {
            let item = item.map_err(|error| DataError::io(local_data, error))?;
            let name = item.file_name();
            if !name.to_str().is_some_and(|name| {
                name.starts_with(".csv-cache-migration.retired-") && name.ends_with(".json")
            }) {
                continue;
            }
            inspected += 1;
            if inspected > 64 {
                return Err(DataError::invalid_request(
                    "Too many archived cache migration journals require inspection.",
                ));
            }
            let Ok(retired) = read_json::<MigrationJournal>(&item.path()) else {
                continue;
            };
            if equivalent_path(&selected, &retired.source)
                || equivalent_path(&selected, &retired.target)
            {
                restore_retired(local_data, &item.path())?;
                break;
            }
        }
        if !journal_path.exists() {
            return Ok(());
        }
    }
    reject_reparse(local_data)?;
    let initial: MigrationJournal = read_json(&journal_path)?;
    initial.validate(local_data)?;
    let source_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(initial.source.join(GLOBAL_LOCK_NAME))
        .map_err(|error| DataError::io(&initial.source, error))?;
    source_lock
        .lock_exclusive()
        .map_err(|error| DataError::io(&initial.source, error))?;
    // A live migration may have completed while recovery waited for its lock.
    if !journal_path.exists() {
        return Ok(());
    }
    let mut journal: MigrationJournal = read_json(&journal_path)?;
    if journal.operation != initial.operation {
        return Err(DataError::invalid_request("The CSV migration changed while startup recovery waited; retry opening the application."));
    }
    journal.validate(local_data)?;
    let target_lock = if journal.target.exists() {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(journal.target.join(GLOBAL_LOCK_NAME))
            .map_err(|error| DataError::io(&journal.target, error))?;
        lock.lock_exclusive()
            .map_err(|error| DataError::io(&journal.target, error))?;
        Some(lock)
    } else {
        None
    };
    let selected =
        read_authoritative_directory()?.unwrap_or_else(|| local_data.join("csv-cache-v1"));
    let selected = normalized(&selected)?;
    let mut entry_locks = Vec::new();
    for entry in &journal.entries {
        if journal.source.join(&entry.key).exists() {
            entry_locks.push(recovery_entry_lock(&journal.source, &entry.key)?);
        }
        if selected == normalized(&journal.source)? && journal.target.join(&entry.key).exists() {
            entry_locks.push(recovery_entry_lock(&journal.target, &entry.key)?);
        }
    }
    if selected == normalized(&journal.source)? {
        journal.rollback(local_data)?;
    } else if selected == normalized_destination(&journal.target)? {
        let redirect = journal.source.join(REDIRECT_NAME);
        if !redirect.exists() {
            write_new_json(&redirect, &journal.target.to_string_lossy().into_owned())?;
        }
        let _remaining_cleanup = journal.finish_committed(local_data)?;
    } else {
        return Err(DataError::invalid_request("Persisted settings identify neither migration cache root. Cache data was preserved for recovery."));
    }
    drop(target_lock);
    drop(entry_locks);
    if selected == normalized(&journal.source)?
        && journal.target_was_absent
        && journal.target.exists()
    {
        for entry in &journal.entries {
            let lock = journal
                .target
                .join(LOCK_DIRECTORY_NAME)
                .join(format!("{}.lock", entry.key));
            reject_reparse(&lock)?;
            if lock.is_file()
                && fs::metadata(&lock)
                    .map_err(|error| DataError::io(&lock, error))?
                    .len()
                    == 0
            {
                fs::remove_file(&lock).map_err(|error| DataError::io(&lock, error))?;
            }
        }
        remove_empty_created_target(&journal.target)?;
    }
    Ok(())
}

fn recovery_entry_lock(root: &Path, key: &str) -> Result<File, DataError> {
    let path = root.join(LOCK_DIRECTORY_NAME).join(format!("{key}.lock"));
    reject_reparse(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| DataError::io(&path, error))?;
    file.try_lock_exclusive().map_err(|_| DataError::invalid_request("Another application window is still using a cache entry needed for migration recovery. Close that window and retry."))?;
    Ok(file)
}

pub(super) fn remove_empty_created_target(target: &Path) -> Result<(), DataError> {
    reject_reparse(target)?;
    if !owner_matches(&target.join(OWNER_NAME)) {
        return Ok(());
    }
    // Never recursively delete a parent: preserve any foreign file that appeared.
    let entries = fs::read_dir(target)
        .map_err(|error| DataError::io(target, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| DataError::io(target, error))?;
    if entries.iter().any(|entry| {
        let name = entry.file_name();
        name != OWNER_NAME && name != GLOBAL_LOCK_NAME && name != LOCK_DIRECTORY_NAME
    }) {
        return Ok(());
    }
    let locks = target.join(LOCK_DIRECTORY_NAME);
    if locks.exists()
        && fs::read_dir(&locks)
            .map_err(|error| DataError::io(&locks, error))?
            .next()
            .is_some()
    {
        return Ok(());
    }
    if locks.exists() {
        fs::remove_dir(&locks).map_err(|error| DataError::io(&locks, error))?;
    }
    let global = target.join(GLOBAL_LOCK_NAME);
    if global.exists()
        && fs::metadata(&global)
            .map_err(|error| DataError::io(&global, error))?
            .len()
            == 0
    {
        fs::remove_file(&global).map_err(|error| DataError::io(&global, error))?;
    }
    if target.join(GLOBAL_LOCK_NAME).exists() {
        return Ok(());
    }
    fs::remove_file(target.join(OWNER_NAME)).map_err(|error| DataError::io(target, error))?;
    fs::remove_dir(target).map_err(|error| DataError::io(target, error))
}
