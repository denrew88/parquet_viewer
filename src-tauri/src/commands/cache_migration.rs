use super::*;
use crate::storage::{
    CsvCacheMigrationPreview, CsvCacheMigrationProgress, CsvCacheMigrationResult,
};
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMigrationSelection {
    selection_id: String,
    preview: CsvCacheMigrationPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMigrationStatus {
    operation_id: String,
    state: String,
    progress: CsvCacheMigrationProgress,
    source_path: String,
    target_path: String,
    error: Option<DataError>,
    result: Option<CsvCacheMigrationResult>,
}

struct MigrationTask {
    status: CacheMigrationStatus,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub(super) struct CacheMigrationControl {
    pub admission: RwLock<()>,
    busy: AtomicBool,
    selection: Mutex<Option<(String, PathBuf)>>,
    task: Mutex<Option<MigrationTask>>,
}

impl CacheMigrationControl {
    pub fn enter(&self) -> Result<std::sync::RwLockReadGuard<'_, ()>, DataError> {
        let guard = self
            .admission
            .read()
            .map_err(|_| DataError::query_failed("Cache migration admission is unavailable."))?;
        self.ensure_idle()?;
        Ok(guard)
    }
    pub fn ensure_idle(&self) -> Result<(), DataError> {
        if self.busy.load(Ordering::Acquire) {
            Err(DataError::invalid_request("CSV cache migration is running. Wait for it to finish or cancel it before opening files or changing settings."))
        } else {
            Ok(())
        }
    }

    fn status(&self, operation_id: &str) -> Result<CacheMigrationStatus, DataError> {
        let task = self
            .task
            .lock()
            .map_err(|_| DataError::query_failed("Cache migration state is unavailable."))?;
        match task.as_ref() {
            Some(task) if task.status.operation_id == operation_id => Ok(task.status.clone()),
            _ => Err(DataError::invalid_request(
                "Cache migration operation is no longer current.",
            )),
        }
    }
}

pub(super) fn validate_directory_unchanged(
    previous: &AppSettingsV1,
    next: &AppSettingsV1,
) -> Result<(), DataError> {
    if previous.csv_cache_directory != next.csv_cache_directory {
        Err(DataError::invalid_request(
            "Use Choose location and Move cache to change the CSV cache directory.",
        ))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn choose_csv_cache_location(
    app: AppHandle,
) -> Result<Option<CacheMigrationSelection>, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.cache_migration.ensure_idle()?;
        let parent = crate::platform::pick_cache_directory(&app).map_err(|message| DataError {
            code: DataErrorCode::Io,
            message,
        })?;
        let Some(parent) = parent else {
            return Ok(None);
        };
        let preview = match state.query_service(&app) {
            Ok(service) => service.preview_csv_cache_migration(&parent)?,
            Err(_) => {
                let local_data = application_directory(&app, ApplicationDirectoryKind::LocalData)?;
                let settings = get_settings(app.clone())?;
                let source = settings
                    .csv_cache_directory
                    .map(PathBuf::from)
                    .unwrap_or_else(|| local_data.join("csv-cache-v1"));
                crate::storage::preview_unavailable_cache_location(&local_data, &source, &parent)?
            }
        };
        let selection_id = format!(
            "cache-location-{}",
            state.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        *state
            .cache_migration
            .selection
            .lock()
            .map_err(|_| DataError::query_failed("Cache location selection is unavailable."))? =
            Some((selection_id.clone(), parent));
        Ok(Some(CacheMigrationSelection {
            selection_id,
            preview,
        }))
    })
    .await
    .map_err(|error| DataError::query_failed(error.to_string()))?
}

#[tauri::command]
pub fn get_csv_cache_migration_status(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<CacheMigrationStatus, DataError> {
    state.cache_migration.status(&operation_id)
}

#[tauri::command]
pub fn cancel_csv_cache_migration(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<CacheMigrationStatus, DataError> {
    let tasks = state
        .cache_migration
        .task
        .lock()
        .map_err(|_| DataError::query_failed("Cache migration state is unavailable."))?;
    let task = tasks
        .as_ref()
        .filter(|task| task.status.operation_id == operation_id)
        .ok_or_else(|| {
            DataError::invalid_request("Cache migration operation is no longer current.")
        })?;
    task.cancel.store(true, Ordering::Release);
    Ok(task.status.clone())
}

#[tauri::command]
pub async fn start_csv_cache_migration(
    selection_id: String,
    app: AppHandle,
) -> Result<CacheMigrationStatus, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_csv_cache_migration_inner(selection_id, app.clone(), &state)
    })
    .await
    .map_err(|error| DataError::query_failed(error.to_string()))?
}

fn start_csv_cache_migration_inner(
    selection_id: String,
    app: AppHandle,
    state: &AppState,
) -> Result<CacheMigrationStatus, DataError> {
    let control = Arc::clone(&state.cache_migration);
    if control
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(DataError::invalid_request(
            "A CSV cache migration is already running.",
        ));
    }
    let prepare = (|| {
        let _admission = control.admission.try_write().map_err(|_| DataError::invalid_request("Files are still opening. Wait for them to finish and close all documents before moving the cache."))?;
        if !state.documents.is_idle().map_err(document_error)? || !state.pending_opens.is_empty() {
            return Err(DataError::invalid_request(
                "Close all documents and finish pending file opens before moving the CSV cache.",
            ));
        }
        let parent = control
            .selection
            .lock()
            .map_err(|_| DataError::query_failed("Cache location selection is unavailable."))?
            .as_ref()
            .filter(|(id, _)| id == &selection_id)
            .map(|(_, path)| path.clone())
            .ok_or_else(|| {
                DataError::invalid_request(
                    "Choose a cache destination using the folder picker first.",
                )
            })?;
        let config = application_directory(&app, ApplicationDirectoryKind::Config)?;
        let local_data = application_directory(&app, ApplicationDirectoryKind::LocalData)?;
        let settings = SettingsStore::new(config.clone()).load()?;
        let service = state
            .query_service
            .lock()
            .map_err(|_| DataError::query_failed("Query service is unavailable."))?
            .as_ref()
            .cloned();
        let source_root = settings
            .csv_cache_directory
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| local_data.join("csv-cache-v1"));
        let preview = if let Some(service) = &service {
            service.preview_csv_cache_migration(&parent)?
        } else {
            crate::storage::preview_unavailable_cache_location(&local_data, &source_root, &parent)?
        };
        if preview.active_entries != 0 {
            return Err(DataError::invalid_request("CSV caches are still in use by another window. Close those CSV documents before moving the cache."));
        }
        let status = CacheMigrationStatus {
            operation_id: format!(
                "cache-migration-{}",
                state.next_request_id.fetch_add(1, Ordering::Relaxed)
            ),
            state: "queued".to_owned(),
            source_path: preview.source_path,
            target_path: preview.target_path,
            progress: CsvCacheMigrationProgress {
                copied_bytes: 0,
                total_bytes: preview.bytes,
                copied_entries: 0,
                total_entries: preview.entries,
                phase: "queued".to_owned(),
            },
            error: None,
            result: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        *control
            .task
            .lock()
            .map_err(|_| DataError::query_failed("Cache migration state is unavailable."))? =
            Some(MigrationTask {
                status: status.clone(),
                cancel: Arc::clone(&cancel),
            });
        *state
            .query_service
            .lock()
            .map_err(|_| DataError::query_failed("Query service is unavailable."))? = None;
        *control
            .selection
            .lock()
            .map_err(|_| DataError::query_failed("Cache location selection is unavailable."))? =
            None;
        Ok((
            parent, config, local_data, settings, service, cancel, status,
        ))
    })();
    let (parent, config, local_data, settings, service, cancel, status) = match prepare {
        Ok(prepared) => prepared,
        Err(error) => {
            control.busy.store(false, Ordering::Release);
            return Err(error);
        }
    };
    state.copy_manager.cancel_all();
    let operation = status.operation_id.clone();
    std::thread::spawn(move || {
        if let Ok(mut tasks) = control.task.lock() {
            if let Some(task) = tasks.as_mut() {
                task.status.state = "running".to_owned();
            }
        }
        if let Some(service) = &service {
            service.shutdown();
        }
        let store = SettingsStore::new(config.clone());
        let mut committed = settings.clone();
        let commit = |path: &Path| {
            committed.csv_cache_directory = Some(path.to_string_lossy().into_owned());
            store.save(&committed).map(|_| ())
        };
        let outcome = if let Some(service) = &service {
            service.migrate_csv_cache(
                &parent,
                &cancel,
                |progress| {
                    let mut tasks = control.task.lock().map_err(|_| {
                        DataError::query_failed("Cache migration state is unavailable.")
                    })?;
                    let task = tasks
                        .as_mut()
                        .filter(|task| task.status.operation_id == operation)
                        .ok_or_else(DataError::task_cancelled)?;
                    task.status.progress = progress;
                    Ok(())
                },
                commit,
            )
        } else if cancel.load(Ordering::Acquire) {
            Err(DataError::task_cancelled())
        } else {
            let source_root = settings
                .csv_cache_directory
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| local_data.join("csv-cache-v1"));
            crate::storage::replace_unavailable_cache_location(
                &local_data,
                &source_root,
                &parent,
                commit,
            )
        };
        // Reload the committed settings even if post-commit source cleanup reported a failure.
        let current = store.load().unwrap_or(settings);
        let reopened = QueryService::open_with_cache(
            local_data,
            current.query_temp_limit_bytes,
            current.csv_cache_directory.as_deref().map(Path::new),
            current.csv_cache_limit_bytes,
        );
        let state = app.state::<AppState>();
        let restore = reopened.and_then(|opened| {
            opened.bind_cache_settings_directory(&config)?;
            *state
                .query_service
                .lock()
                .map_err(|_| DataError::query_failed("Query service is unavailable."))? =
                Some(Arc::new(opened));
            state
                .applied_csv_cache_limit
                .store(current.csv_cache_limit_bytes, Ordering::Relaxed);
            Ok(())
        });
        if let Ok(mut tasks) = control.task.lock() {
            if let Some(task) = tasks.as_mut() {
                match outcome.and_then(|result| restore.map(|()| result)) {
                    Ok(result) => {
                        task.status.state = "complete".to_owned();
                        task.status.result = Some(result);
                    }
                    Err(error) => {
                        task.status.state = if error.code == DataErrorCode::TaskCancelled {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .to_owned();
                        task.status.error = Some(error);
                    }
                }
            }
        }
        control.busy.store(false, Ordering::Release);
    });
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p21_directory_changes_require_the_migration_command() {
        let previous = AppSettingsV1::default();
        let mut next = previous.clone();
        next.csv_cache_limit_bytes = crate::domain::MIN_QUERY_TEMP_LIMIT_BYTES;
        assert!(validate_directory_unchanged(&previous, &next).is_ok());
        next.csv_cache_directory = Some("D:/csv-cache".to_owned());
        assert!(validate_directory_unchanged(&previous, &next).is_err());
    }

    #[test]
    fn p21_migration_status_rejects_unknown_and_stale_operations() {
        let control = CacheMigrationControl::default();
        assert!(control.status("unknown").is_err());
        control.busy.store(true, Ordering::Release);
        assert!(control.ensure_idle().is_err());
        control.busy.store(false, Ordering::Release);
        assert!(control.ensure_idle().is_ok());
    }
}
