use super::*;
use crate::platform::{
    describe_storage_locations, open_managed_storage_folder, StorageFolderKind, StorageLocations,
};

#[tauri::command]
pub async fn get_storage_locations(app: AppHandle) -> Result<StorageLocations, DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let local_data = application_directory(&app, ApplicationDirectoryKind::LocalData)?;
        let settings = get_settings(app.clone())?;
        describe_storage_locations(
            &local_data,
            settings.csv_cache_directory.as_deref().map(Path::new),
        )
    })
    .await
    .map_err(|error| DataError::query_failed(error.to_string()))?
}

#[tauri::command]
pub async fn open_storage_folder(kind: StorageFolderKind, app: AppHandle) -> Result<(), DataError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.cache_migration.enter()?;
        let local_data = application_directory(&app, ApplicationDirectoryKind::LocalData)?;
        let settings = get_settings(app.clone())?;
        open_managed_storage_folder(
            &local_data,
            settings.csv_cache_directory.as_deref().map(Path::new),
            kind,
        )
    })
    .await
    .map_err(|error| DataError::query_failed(error.to_string()))?
}
