# Stale cached service after offline replacement

2026-11-05 KST. Focused source review requested by Root for T-P21-029.

**Confirmed finding, high severity: cached service ignores a changed saved cache directory.** `commands/mod.rs::AppState::query_service` loads fresh settings, but its cached-service branch updates only overall/cache limits before returning the old QueryService. That service retains its original CsvPersistentCache root. The offline replacement path in `commands/cache_migration.rs` saves a new directory without writing a redirect to the unavailable old root. If another process retains an old cached service and that volume returns, its root has no redirect marker and may resume publishing/reclaiming the old managed cache.

Impact is inconsistent managed-cache location and split storage accounting across processes. No source CSV modification or deletion is asserted by this finding. It falls directly under T-P21-029's requirement that stale processes cannot keep publishing/reclaiming the old root.

Minimal correction recommended to Root: before mutating limits or returning the cached service, compare its stored actual/configured root identity with the freshly saved resolved root. On mismatch, return an actionable restart message; preserve active session/service state rather than silently replacing it. The comparison must work when the old drive is unavailable, so probing old-root usage is unsuitable. Existing normal migration redirect/locking behavior is outside this focused change.

Source correction and targeted regression evidence remain pending. No suites were rerun by Quality.

## Focused source closure

The frozen correction was independently inspected. **Source finding closed; scoped source-review PASS pending executed regression/native results.** Both production `QueryService::open_with_cache` sites (initial AppState creation and migration reopen) bind the Config directory before publishing their service. The remaining wrapper is `#[cfg(test)]`. Cached AppState retrieval and settings application verify the freshly saved directory before changing limits. Default resolution uses the trusted LocalData directory; comparison does not access an unavailable old root.

Importantly, bound `CsvPersistentCache::lock_global` also rereads authoritative settings and checks the saved root before lookup/publish/reclaim/clear. Cached worker paths that bypass AppState retrieval are therefore covered, and an early error releases the RAII global lock. This preserves active service state and returns the requested actionable close/reopen error.

The regression `phase21_saved_location_change_blocks_stale_cache_without_old_root_redirect` models the readable returned old drive without a redirect, changes saved authority, and checks stale usage/cap/clear failures, unchanged cap and foreign sentinel, plus successful operation on the newly bound root. This is meaningful coverage for the reported gap. Quality did not rerun tests or claim final Phase approval.
