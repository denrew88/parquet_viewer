# Phase 25 Settings — integration

Scope: Settings category navigation and typography, readable display examples and correctly placed reset, and two managed-folder Open actions. The user explicitly approved remaining verification and formal EXE promotion on2026-11-16. Whole Phase25 stays in progress; its separate OS file-drop gate is outside this follow-up.

## Implementation

- UI owner: CSV/SQL/Copy/Display/Storage mounted panels, one global draft/Apply/Cancel, hidden-invalid navigation, scoped CSS, inline display details, per-root path/availability/error/open state and migration refresh. Async folder opening keeps focus within the modal, restores the trigger after completion, and preserves deliberate focus/category changes.
- Platform owner: thin commands under existing migration admission; read-only saved-root resolution and existing storage ownership/reparse validation; literal filesystem ShellExecuteW target without shell command construction. No dependency/capability additions or QueryService initialization from Get/Open.
- Root: strict shared DTO/transport, App wiring, registration, shared tests, fixed test/build/native tasks and common documentation.
- Quality: approved T-P25-S01..S12 plan, shared19-case kind corpus, independent browser/geometry/native checks and code review.

## Verification

| Check | Result / evidence |
| --- | --- |
| Frontend static | PASS: final format, lint, app/node/E2E types; `artifacts/dev-check/2026-11-16T08-19-18-804Z-*.log` |
| Full frontend run | 979 passed / one old Copy-category entry failed; `2026-11-16T08-14-16-234Z-phase24-frontend-test.log` |
| Failed Copy entry retry | PASS after explicit Copy navigation; unchanged behavior assertions; `2026-11-16T08-17-04-706Z-phase25-app-test.log` |
| Final Settings units | 50/50 PASS including five async-focus regressions; `2026-11-16T08-18-06-907Z-frontend-test.log` |
| Transport / DTO / cache controls | 88/88 backend,28/28 storageFolders,6/6 CacheLocationControls; included in full run |
| Rust format / Clippy | PASS: `2026-11-16T08-06-46-813Z-phase25-format.log`, `2026-11-16T08-14-16-262Z-phase25-clippy.log` |
| Folder Rust units | 9/9 PASS: no-create, kind parity, default/custom independent roots, missing/file/foreign owner, launch error and Windows literal paths; `2026-11-16T08-07-08-945Z-phase25-storage-folders-unit.log` |
| Full Rust | 491 passed /19 pre-existing ignored; `2026-11-16T08-15-45-005Z-phase25-test.log` |
| Focused Settings browser | All9 cases across1440×900,1024×768,800×600 verified through full initial plus failed/changed-range retries. Final folder/focus3: `2026-11-16T08-18-46-932Z-phase25-e2e.log` |
| Full browser | 358 passed,4 existing skipped,one calculation-cancel timing failure; unchanged failing case passes in all3 viewports on targeted retry `2026-11-16T09-09-58-089Z-phase25-e2e.log`. Full log: `2026-11-16T08-19-41-272Z-phase24-e2e-full.log` |
| Windows candidate | PASS:21m22s release compile,62,542,848bytes,SHA256 `041AD9484900D7D274A0F6D40E508EA5723F4A498F247458BC6D595C5FF575D5`; `2026-11-16T08-18-46-956Z-phase25-workspace-draft-build.log` |
| Actual Explorer | PASS by direct Computer Use on the exact candidate: each actual Viewer button click followed by reading the full Explorer address bar; query-temp and csv-cache-v1 both equal their expected backend roots. `native/manual-results.json` records the two actions, actual paths, HWNDs and candidate hash. No folder navigation or settings changes were performed. |

Initial capture incorrectly bounded a deliberately scrolling panel; corrected the assertion target to the actual scroll viewport while retaining panel horizontal-overflow/dialog/navigation/footer bounds. Subsequent folder failure revealed genuine modal focus loss after a disabled Open button. The product fix and new deferred-success/failure/focus-movement regressions address that defect; no behavioral/security limits were weakened.

## Documents and limitations

PROJECT_SPEC records category/draft/focus/typography and folder-resolution/launch contracts. DEVELOPMENT_PLAN and the Phase25 promotion receipt record the user-approved local EXE replacement, preserving the previous promotion receipt. USER_GUIDE explains categories, Apply/Cancel, Display reset and both Explorer targets; removed the obsolete Phase21 Settings screenshot.

The first two automatic native attempts failed in observer path normalization. The corrected third observer returned the exact CSV root without errors, but its new-HWND criterion rejected legitimate reuse of an already-open Explorer window. Those automatic failures remain in the native evidence; they are not relabelled PASS. The direct physical-click/address-bar verification completes the actual-target gate without changing the product or closing personal Explorer windows.

Custom-root resolution/migration has unit/browser coverage; actual custom-root Explorer opening and Windows junction creation are not claimed. No Linux builds, installer or external release are included. The formal EXE is a byte-identical copy of the verified candidate; no rebuild is required.
