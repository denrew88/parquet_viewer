# Phase 22 integration — in progress

2026-11-07 SQL editor layout behavior PASS: [results](89-editor-layout.md),
[independent review](quality/editor-layout-review.md). Accessible vertical source split, bounded horizontal
editor scrolling/help width, manual-only newline indentation. Full frontend823/browser213 and native
split/visible scrollbar/end marker/newlines/four JOIN modes PASS. Initial strict native Home coordinate
check was corrected at the harness level and retained separately. Product Release0.22.0 replaced,
60,490,752bytes (+512bytes), canonical/candidate SHA match; `editor-layout-exe.json`.

2026-11-07 optional identifier quoting behavior PASS: [results](88-identifier-insertion.md),
[independent review](quality/identifier-insertion-review.md). Simple non-keyword ASCII names stay bare;
parser keywords/unsafe names retain escaping across completion/JOIN/examples/insertion. Existing drafts
are not rewritten. Full frontend805, browser204, actual4JOIN modes COUNT3 PASS. Product Release0.22.0
replaced,60,490,240bytes (+2KiB), canonical/candidate SHA match; `identifier-insertion-exe.json`.
No backend/dependency/security capability change or Phase-wide promotion.

2026-11-07 direct-typing usability follow-up behavior PASS: [results](85-editor-usability.md),
[independent review](quality/editor-usability-review.md). Concise suggestions, explicit JOIN detail,
alias guidance, help preference and independent result/plan execution snapshots. Initial hidden Retry and
selected detail contrast corrected; late retry rejection guarded. Full frontend775PASS plus final affected17,
full browser200PASS/1Windows screenshot file-open error then unchanged3viewport rerunPASS, actual native
four modes/edit-restore/restart PASS. Product Release0.22.0 replaced,60,488,192bytes (+512bytes),
canonical/candidate SHA match; provenance `editor-usability-exe.json`. No Phase-wide promotion.

2026-11-07 JOIN/quiet-completion follow-up behavior PASS: [results](80-join-completion.md),
[independent review](quality/join-completion-review.md). Rust398, full browser189, native four-mode
COUNT3, calibrated no-SQL-on-type and actual settings restart PASS. Frontend initial full run762PASS/1
existingApp timeout; unchanged App65PASS separately. Product Release0.22.0 replaced at the established
path,60,487,680bytes (+17.5KiB); canonical/candidate SHA match. Provenance: `join-completion-exe.json`.
No Phase-wide promotion or new native/security dependencies.

2026-11-07 source lifecycle/card follow-up PASS: [implementation/results](75-source-lifecycle.md),
[independent review](quality/source-lifecycle-review.md). Rust394, frontend703, browser180 plus final affected9,
native4 gates PASS. Canonical Release0.22.0 replaced,60,469,760bytes (+12.5KiB);
SHA/provenance: `source-lifecycle-exe.json`. No Phase-wide promotion.

Latest SQL editor follow-up: [CodeMirror IntelliSense implementation and evidence](70-intellisense.md),
[independent review](quality/intellisense-review.md). This adds no native runtime or security capability.

Editor scope PASS: SQL workspace163unit/component cases, affected15browser cases and actual native
completion→two-mode grid execution. Product Release0.22.0 replaced at the established release path,
60,456,960bytes (+118.5KiB/0.2011% from the pre-editor product EXE). Hash/version/build provenance
are in `intellisense-exe.json`. Native acceptance also fixed expression-comma completion and the
existing bare SQL page identity adapter. Remaining Phase-wide gates retain prior status.

## 2026-11-06 20:43 configurable SQL working-space cap — PASS

Settings schemaV6 `sqlTempLimitBytes`64MiB..10GiB/default512MiB is wired through native UI/store/command/
per-task snapshot/worker allowance; existing overall/physical limits remain authoritative. This replaces the
fixed512MiB combined spill/result ceiling without changing memory/time/row limits. See `65-sql-storage-setting.md`
and independent `quality/sql-storage-setting-review.md` (all8feature IDs PASS).

Normal Rust390PASS/18existing ignored/0FAIL (`11-26-08-643Z-phase22-test`), frontend633PASS,
allformat/lint/types/normalclippy PASS, browser159PASS with222historical evidence restored, actual native9/9PASS
(`11-39-14-888Z-phase22-stress`, `native/stress-settings.json`). Same WINDOW query fails at64MiB, succeeds
at1GiB with743,047,168bytes observed spill. Active64MiB job cap remains unchanged afterUI saves1GiB;
overall64MiB still constrains new SQL1GiB; persistence/restart/newsource page/results verified. Initial native
harness source-page envelope mistake was corrected and all9cases rerun, no product changes for that correction.

Product source0.22.0 build `2026-11-06T11-39-14-888Z-phase22-build.log` PASS (4m18s), latest UI included.
Replaced `src-tauri/target/release/data-viewer.exe`,60,335,616bytes, version0.22.0, SHA256
`9152eab6b9ef6f4cb8a8ec6a448cb8f63791fcc3a99309a3227da3f033aeab6e` matches product candidate.
Native isolation build differs only in acceptance identifier, SHA13aeec5d... in detailed record.
This final full Rust run does not reproduce the earlier intermittent CSV-corruption failure; no permanent
fix to that separate risk is claimed. Feature is verified; remaining wholePhase gates and promotion are separate.

## 2026-11-06 19:55 actual SQL stress and corrected Release EXE

Requested actual native stress scope10/10PASS; independent Quality acceptance in `quality/stress-review.md`.
See `60-sql-stress.md` for exact queries, resource measurements, cancellation/recovery and limits of proof.
Found/fixed worker Arrow pointer indirection crash, Windows open-file size undercount (with metadata-only
handles preserving exclusive DB locks), and raw C API temporary-storage error normalization.
Final native candidate build `10-45-35-229Z-phase22-native-build.log` and stress `10-49-50-665Z-phase22-stress.log`
PASS. No source changes followed the tested native build; only report-field naming/docs changed afterward.

Product build `2026-11-06T10-50-59-701Z-phase22-build.log` PASS (4m12s), latest UI included. Replaced
`src-tauri/target/release/data-viewer.exe`:0.22.0,60,328,448bytes, SHA256
`9b019234adfd663394cc3ac67f9277d714b64126750e3cca56f86b65f2aa38e6` matches product candidate.
Stress used the same source/release profile with an isolated acceptance identifier; product namespace EXE was
built/verified afterward, not represented as the exact same hash used in stress. No formal Phase promotion,
installer, git commit/push or external publishing.

Normal format and all-target Clippy PASS. Full final Rust run383PASS/1FAIL/18existing ignored; lone CSV-cache
corruption-recovery failure passes unchanged in isolation. Full-suite failure remains an intermittent risk;
not reported as fully green. Earlier full-run data-read lock regression is corrected with metadata-only handles.
Phase remains in progress for that regression and remaining broader native/UI/security/lifecycle matrix.
The older checkpoint sections below preserve history and are superseded by this follow-up.

## 2026-11-06 17:25 build follow-up

User requested another Release build and replacement. Normal Cargo build now succeeds; the earlier4551
rejection did not recur. No security setting was changed by this agent, and the reason Windows now permits
execution is unknown. First build log `2026-11-06T08-17-19-762Z-phase22-build.log` PASS (4m17s).
Detected stale frontend assets in the Cargo-only runner; added production Vite build before Phase22 product
and native builds. Final UI+EXE logs `2026-11-06T08-21-43-550Z-frontend-build.log` and corresponding
`phase22-build.log` PASS (Cargo4m10s). Copied final candidate to the user-requested
`src-tauri/target/release/data-viewer.exe`; version0.22.0,60,323,328bytes, SHA256
`69521B395109BD83A5D040C6B99E47588F95981280F7E66B71FD93BEF7C9BF2C` matches candidate.
Actual Rust test execution/native acceptance remains pending; successful build is not Phase completion.
The following sections preserve the earlier blocked checkpoint, superseded for build status by this follow-up.

2026-11-06. **Draft, not complete or formally promoted.**

## Current implementation

- Engine: authoritative full raw-header descriptors, file/session/profile snapshots, exclusive name/ordinal
  projection, same-EXE SQL worker, pre-prepare single-query/function/relation guards, bounded independent
  Parquet result chunks, page/cell/copy reader and source/worker cancellation. Backend still under implementation
  review. Normal compilation/runtime are blocked; compile-only checks passed as qualified below.
- Root: thin SQL Tauri commands, source collection/revalidation race closure, main worker entry hook,
  copy display headers independent from unique projection IDs, source/version0.22.0 and candidate-only checks.
- UI: SQL workspace/file tabs, inline aliases, selected-table virtual columns, native exclusive radio modes,
  generated examples/help, asynchronous job/result/plan state, existing result grid/copy adapter. Editor line
  numbering/highlight and previous-result truthfulness refinements are integrated.
- Quality:24case test design;16small fixture/golden files totaling172,788bytes, security corpus and dedicated E2E.

## Executed checks

- Fixture generation PASS with existing PyArrow26 environment: `../dev-check/2026-11-06T05-44-53-807Z-phase22-fixtures.log`.
  The first run lacked PYTHONPATH and failed to import PyArrow; no package installation, corrected once.
- SQL frontend model/transport20tests PASS (`05-53-39` frontend log); component4tests PASS (`05-56-12-534`).
  Three TypeScript configs PASS (`05-56-12-505`). These precede final editor refinements.
- Focused SQL E2E18/18 PASS,22.3s: `../dev-check/2026-11-06T05-54-37-386Z-phase22-e2e.log`.
  Three viewport interactions/geometry captured;222 historical evidence files preserved. Browser mock only.
- Native harness `scripts/native_phase22_sql.mjs` syntax check PASS; **not executed**.

## Active environment block

`phase22-check` stopped before Rust typechecking because Windows application control refused to execute the
new Cargo build-script binary (OS error4551), despite running the approved development entrypoint outside
the filesystem sandbox. Log: `../dev-check/2026-11-06T05-51-37-774Z-phase22-check.log`.
Blocked path: `.tmp/duckdb-size-target/release/build/data-viewer-939cf44bb3a04f5b/build-script-build.exe`.
No security setting changed or blocked executable workaround applied. User confirmed Smart App Control is
enabled. This is not a normal Rust build PASS. Repeating the unchanged command will not resolve the OS block.

Follow-up Windows event inspection: CodeIntegrity events3077/3033 at2026-11-06 14:51:44 and15:31:05 identify
`cargo.exe` attempting to execute this exact build-script binary, rejected by policy
`{0283ac0f-fff1-49ae-ada1-8a933130cad6}`. File creation14:51:40/write14:51:42 precedes the first rejection;
Authenticode status is NotSigned. Older build-script artifacts exist, including00:19:33 the same day.
The project `build.rs` is unchanged (`tauri_build::build()`); source manifests/config only bump the version.
These establish an OS execution rejection of the newly produced helper, not a compiler diagnostic or a Release
output-folder failure. Why the policy accepted earlier artifacts but rejects this one is still undetermined;
do not claim a recent policy change or definitive Smart App Control attribution from the error number alone.

## Remaining

Normal Rust check/test/clippy, native/product candidate builds, installer, actual IPC/worker/clipboard/security,
active cancellation/parent-death cleanup,1GiB failure recovery and5.85M resource/latency validation remain
unexecuted. Prepared native harness covers only part of this matrix. Missing required gates keep Phase22 in
progress. Existing formal EXE, source data and production cache are preserved. No candidate EXE was created;
no commit/push/publishing or formal replacement was performed.

## Final available verification

- Full frontend593/593 PASS: `../dev-check/2026-11-06T06-06-44-161Z-frontend-test.log`.
  Subsequent previous-result label change:4related component tests PASS (`06-07-16-858Z-frontend-test.log`).
- Final frontend format/lint and three TypeScript configs PASS: `06-08-00-521Z-*` logs.
- Full browser regression:153 assertions PASS (`06-07-49-416Z-phase22-e2e.log`). Runner subsequently returned
  nonzero during historical evidence restoration (Windows copyFile error). Separate recovery PASS
  `06-13-15-807Z-phase22-restore-evidence.log`:222files checked,39restored, SHA verified. Historical tracked
  evidence content has no diff. Runner uses read/write now; original failed log is retained.
- Quality independently inspected9final screenshots over three viewports; geometry, exclusive radios and
  virtualized columns PASS. See `quality/ui-review.md` and `quality/backend-review.md`.
- Final Rust format PASS (`06-18-20-731Z-phase22-format.log`). Compile-only Clippy with `-D warnings` PASS
  (`06-18-22-973Z-phase22-static-clippy.log`), test-code metadata check PASS
  (`06-18-33-517Z-phase22-static-test-check.log`). Initial compiler/lint findings were fixed without suppression.

The compile-only harness includes actual modules/command registration but omits project build-script execution
and Tauri generated context/runtime. It proves typechecking/lint only, not normal linking, SQL semantics,
test execution or native acceptance. Browser checks use mocks. None substitutes for the remaining native gates.
