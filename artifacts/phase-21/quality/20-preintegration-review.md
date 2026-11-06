# Phase 21 pre-integration quality review

2026-11-05 KST. Scope: independent source/fixture/browser-evidence review before Root integration record and final native build.
This is **not** final Phase completion approval. At review start `50-integration.md` was not yet written.

## Completed evidence

- Independent fixtures: `fixtures/phase-21/distinct-pages.csv` (708 rows/237 distinct values) and distinct-types.csv; stdlib Counter/TSV oracle, generator and SHA-256 manifest.
- New `e2e/phase21.spec.ts`: four scenarios across three viewports. Initial Root-authorized run: **12/12 PASS**, `artifacts/dev-check/2026-11-04T22-17-42-841Z-e2e.log`.
- TypeScript E2E typecheck and scoped ESLint PASS locally. Quality default-sandbox browser run was stopped because loopback sockets are denied; no product failure or PASS inferred from it. Root reran using existing authorized command.
- Opened all six initial PNGs as image inputs. Distinct panel and Settings footer fit all 1440×900/1024×768/800×600 viewports; raw geometry has zero horizontal panel overflow.
- Initial cosmetic finding: distinct close-X rendered too small. UI owner fixed 18×18 SVG/32×32 button; test now asserts the SVG geometry. Fresh capture review remains required.
- Final spec now also records migration-progress screenshots/geometry, scrolls effective-cap text into the Settings capture, checks stale late search responses, and checks migration blocked with an open document. These changes require the final targeted/full run; the initial 12-pass log is not relabeled as their execution.

## Contract/source findings returned to owners

1. Browser mock TSV headers/search category-label behavior differed from native. UI owner aligned headers to Value/Count and search to actual coalesced values; oracle updated. Await final run.
2. Root was asked to confirm active list/search/sort SQL cancellation and shared-budget monitoring after snapshot build clears its interrupt handle. Build-time cancellation alone is insufficient for long later SQL.
3. Root was asked to move synchronous start_column_values_copy's count query off the Tauri UI thread or establish the execution boundary.
4. Storage owner is adding durable migration recovery. Independent initial review confirms bounded copy, destination checksums, refreshed artifact identity, active lease gates, fixed managed child, reparse rejection and source-vs-target free-space distinction. Final journal and crash tests remain to review.
5. Storage owner was asked about cancellation during multiple checksum/full-validation passes, not just the 1MiB copy loop. Do not claim a bounded verification-cancel latency without evidence.

## Native boundary and pending gates

Browser mocks establish UI state/interaction/clipboard wiring only. They do **not** establish native folder-picker authorization, actual Windows clipboard atomicity, file permissions, crash recovery, disk full behavior or real C:→D: transfer.
Root reported a real D: volume is available and owns test-directory authorization/setup. Native acceptance must use the isolated Phase 21 namespace and restore settings; existing user caches must not be migrated for testing.
Required remaining evidence includes fresh screenshot visual review, Rust/settings parity and lifecycle results, final full frontend/E2E, native distinct golden/clipboard checks, actual cross-volume warm reopen/new CSV publish, cancellation/failure and recovery results, and final binary metadata. Each unexecuted item remains explicit until supplied.

## Subsequent review update

- Root refresh `2026-11-04T22-25-12-750Z-e2e.log`: **9 PASS / 3 FAIL**, all failures cancellation→Escape→Settings in the same scenario across three viewports. The cancelled-state button disappears while focused; Escape sent after focus loss does not reach the panel. UI owner was asked to restore real keyboard focus rather than mask it with forced clicks.
- Opened all nine refreshed captures; `ui/visual-review.md` records captured-state visual/geometry PASS and explicitly retains the interaction failure. Close SVG is now a measured 18×18 and readable; cap helper/location and migration destination/progress/cancel are visible across all viewports.
- Source concerns 2/3 are addressed in code: page/copy SQL now register cancellable connection/interrupt and shared budget monitoring; start-copy command runs via async spawn_blocking. New interruption test is present; final executed Rust results remain pending.
- Storage now has durable journal startup recovery with authoritative settings reread under both root locks, fingerprint-checked source cleanup and transaction-marked destination rollback. Precommit checksum loops poll cancellation per1MiB; after settings commit cleanup/recovery completes rather than rolling back committed settings. Crash tests/native evidence remain pending.
- New startup recovery concern returned to Root: eager cache initialization can abort Tauri setup if a previously configured drive/root becomes unavailable, before Settings is reachable. Needs safe explicit recovery behavior or a clearly scoped limitation.
- New lifecycle concern returned to Root: snapshot registry cap removes cancelled/released tasks before worker completion, so pending cancelled workers may not be included in the cap. Requires bounded-spawn evidence or guard.

## Code-freeze update (2026-11-05 KST)

Root addressed the startup and worker-cap concerns: failed storage initialization keeps Settings reachable; native-authorized offline-root replacement preserves old data; a separate MAX16 live-worker RAII permit remains held until thread exit. Settings mutations/migration/recovery share an OS control lock. These are source-review confirmations, pending final runtime/unit evidence.
Root also addressed the last-lease cap edge: closing a session reclaims now-inactive cache under the already-configured cap, and lowering overall cap applies before trimming cache. N21-07/T-P21-017 in the native checklist explicitly tests this without reapplying settings.
The current native checklist is `30-native-acceptance-checklist.md`. Code is frozen for Root's final suite/build; no additional product edits are made by Quality.

The next targeted run `2026-11-05T04-19-13-870Z-e2e.log` is 9 PASS/3 FAIL: cancellation-focus scenario now passes; remaining failures are source mock ordering. Native SQL places valid values first and then Invalid/Empty/NULL for both value directions; mock still negates its entire category ranking for descending. Quality's copy/order oracle follows native behavior. Root was given the exact source mismatch to fix before final rerun.

## Browser closure update (2026-11-05 13:29 KST)

Root fixed mock category ordering and the header action overlap that caused column dragging regressions. The full E2E attempt recorded 125 PASS/10 FAIL (`2026-11-05T04-24-36-457Z-phase21-e2e.log`); the focused rerun of every affected title plus Phase 21 passed 24/24 (`2026-11-05T04-28-33-308Z-phase21-e2e.log`). Quality independently opened all nine refreshed screenshots and checked all geometry files: visual/geometry PASS for these browser states, with no new finding. See `../ui/visual-review.md` for scope and native exclusions.

Final Rust results, actual isolated Tauri/clipboard/cross-volume/recovery evidence and `50-integration.md` are still pending; no final Phase verdict is issued by this preliminary review.
