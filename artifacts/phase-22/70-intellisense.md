# Phase22 SQL IntelliSense

2026-11-06. CodeMirror6 SQL editor; this feature does not mark the whole Phase complete.

## Implemented

- SQL syntax highlighting, line numbers, bracket pairing/matching, undo/redo and local search.
- Current registered table/schema metadata drives completion, including forward FROM/JOIN aliases.
- Exclusive per-table name/cN mode: escaped quoted original names or physical source-index cN.
- Curated SELECT keywords and111function names kept in exact parity with the backend allowlist.
- Common function signatures and lexical current-argument guidance; not an SQL typechecker.
- Ctrl+Space, Enter/Tab, Esc and exactly-once Ctrl+Enter execution; composition guards.
- No query, EXPLAIN, catalogue IPC, file read or network access while typing/completing.
- Candidate allocation200/display40;64KiB UTF8/8192tokens/depth64/bindings64 local-work bounds.
- CTE/derived output inference is excluded; unresolved/ambiguous scopes suppress column guesses.

## Packaging

Seven focused CodeMirror packages;15MIT packages including transitive dependencies.
`public/third-party-codemirror.txt` embeds exact versions and licence texts in the standalone app.
No new native runtime or capability. Source version stays0.22.0.

## Evidence

- Plan and independently reviewed three viewport screenshots: `quality/intellisense-plan.md`,
  `quality/intellisense-review.md`.
- Focused new browser scenarios12/12PASS: `../dev-check/2026-11-06T12-37-45-718Z-phase22-e2e.log`.
- Final frontend format/lint/types PASS: `../dev-check/2026-11-06T12-45-44-556Z-*.log`.
- Full frontend initial run:680PASS/6App timeouts during concurrent browser/build load; no assertion mismatch.
  All65App tests PASS on unchanged-code targeted rerun (`12-54-37-962Z-frontend-test.log`), covering
  the six timeouts. All686tests therefore have passing execution evidence, not one clean full-run claim.
- Full browser initial run168PASS/3timeouts at Phase16 repeated input; targeted retries under concurrent
  workers also timed out (some editor cases). Trace shows broad slow CDP input, not assertion mismatch.
  Cached fixed inert geometry with per-cycle/final stability checks; retained all10physical-input cycles,
  30s timeout, IPC/selection/popup checks. Phase22 runner now one worker to avoid local input contention.
  Final affected15/15PASS42.6s, including all3Phase16 cases and12editor cases with the added comma regression:
  `13-08-54-478Z-phase22-e2e.log`;222historical files preserved. No single clean full-run claim.
- Initial actual native (`native/stress-editor-initial.json`) caught expression-comma context choosing tables
  instead of columns in COALESCE's second argument. Fixed relation commas using current depth/parent and
  cursor-preceding FROM/JOIN clause; SELECT/function/ORDER BY commas have unit+browser regressions.
  All154SQLworkspace unit/component tests PASS (`13-05-11-447Z-frontend-test.log`), provider50tests.
  Final format/lint/types PASS (`13-08-40-213Z-*`). Native rebuild required after this actual product fix.
- Final actual native PASS: `13-32-30-062Z-phase22-stress.log`, `native/stress-editor.json`.
  Both name/ordinal SQL queries complete and actual gridcells show0/1/2. A real describe call calibrates
  the forwarding observer; typing/completion/signature/find produce0SQLcalls, then exactly2query starts
  (one per Ctrl+Enter/mode). Bracket pairing/matching, undo and find pass. Settings restored, owned app
  stopped, source hash unchanged. Images: `native/native-sql-editor-intellisense.png`,
  `native/native-sql-editor-result.png`. Product EXE size comparison is below.
  Native IME guards use synthetic events;
  physical Windows Korean IME behavior is not claimed verified.
- A subsequent actual native attempt exposed bare Rust SQL DataPage lacking the frontend-required
  sessionId. SQL-only transport now supplies validated resultId as sessionId, rejects any explicit
  conflicting ID and retains common parser/range/projection validation. Backend21/SQL workspace163
  tests PASS (`13-23-13`); common parseDataPage unchanged. Quality reviewed the correction; rebuilt
  actual WebView grid execution PASS as recorded above. Final format/lint/types PASS13-23-03.
- Native invoke observer replacement was ineffective because Tauri invoke is non-writable. Root
  replaced it with a forwarding fetch observer, verifies installation and a real describe control call
  before resetting counters; only SQL command counts/runId/SQL are recorded, no headers/keys.
  Initial zero counters are not accepted as IPC proof. Corrected native result is PASS.

## Final product build and measured size

`13-31-48-539Z-phase22-build.log` PASS7m05s. Replaced the existing
`src-tauri/target/release/data-viewer.exe`; version0.22.0,60,456,960bytes.
Baseline60,335,616bytes → +121,344bytes =118.5KiB =0.2011%.
This is the whole editor feature/adapter/licence change, not an isolated dependency-only attribution.
Product SHA256 `8fb1e4c0ff5367226e4d8b6a11785dafc309aa5bd38f43be99c45714e54af6ff`
matches the product candidate. Machine-readable comparison: `intellisense-exe.json`.
Native tested SHA256 `4567c6f4034bd65f8600b5295343d1db6cdc950d26ae3c8c8fb61009173049d1`;
same final code/frontend asset (`index-qMJfdEfK.js`), isolated acceptance identifier differs.
No product source changed after native acceptance. No commit/push/publish or Phase-wide completion.
