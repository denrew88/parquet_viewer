# Inferred JOIN predicates and quieter completion

2026-11-07. User-authorized Phase22 follow-up. No Phase-wide promotion or external release.

## Scope

- Fresh JOIN ON offers qualified equality predicates from exact ASCII-folded original names and compatible
  metadata types. Per-table original/cN modes insert their own real physical index; no display-cN matching.
- Current right JOIN table versus preceding inputs only. Unknown CTE/derived/ambiguous scopes, duplicate
  originals and existing/AND predicates do not receive inferred replacement conditions.
- Matching `id/name/status/type/value/amount/total/created_at/updated_at` is manual-only and lower-ranked.
  All predicates are explicitly inferred, never verified foreign keys and never automatically inserted.
- Default contextual mode opens only on dots and meaningful ON candidates. Automatic adds ordinary2+character
  local suggestions; manual uses Ctrl+Space. Ordinary keywords follow clause context; functions/keywords use
  prefix matching. No SQL/backend scans occur while typing.
- Initial automatic popup Enter inserts newline; Tab, navigation then Enter, or explicit Ctrl+Space then Enter
  accepts. Escape suppresses the same token; mode/schema changes invalidate cached popup. IME/Run/history stay.
- AppSettingsV7 requires sqlCompletionMode. ValidV1..6 settings migrate to contextual without changing copy,
  display or storage preferences. Rust/TS share the12-case mode corpus; current invalid values reject/recover.

## Validation

- Pre-implementation plan `quality/join-completion-plan.md`, independent review `quality/join-completion-review.md`.
- SQL workspace/model/component212PASS23-49-27, settings143PASS23-50-39. Full frontend762PASS/1existingApp
  page-navigation timeout under parallel load23-57-05; unchanged-code targeted App65/65PASS23-59-14.
  This is passing evidence across runs, not a claim that the initial full run was clean.
- Final format/lint/types PASS23-56-55. Full Rust398PASS/0FAIL/18existing ignored91.30s23-52-55;
  Clippy all-targets with warnings denied PASS23-59-24.
- New focused browser9/9PASS40.8s23-57-15 over1440×900/1024×768/800×600. Three images independently opened,
  estimated/unverified explanation and narrow layout readable. Full browser189/189PASS8.2min
  (`artifacts/dev-check/2026-11-07T00-02-16-850Z-phase22-e2e.log`); historical222evidence files preserved.
- Small typed Parquet fixtures in `fixtures/phase-22/join-completion`: differing physical key positions,
  NULL keys, duplicate lookup key and deliberately unrelated generic IDs. Independent Python golden JOIN3rows.
- Actual native helper uses forwarding fetch observation with control-call calibration/response acknowledgement,
  four name/cN combinations executed against real Parquet, setting draft/cancel/apply and actual restart.
  Native candidate build PASS7m20s. Actual optimized Tauri acceptance PASS11.012s in
  `native/stress-join.json` (2026-11-07T00:17:13Z). All four mode pairs execute COUNT3 in the real grid;
  NULLs/duplicate lookup key are covered by the fixture golden result. Calibrated typing SQL calls0,
  explicit executions4, one per Ctrl+Enter. Draft/cancel/apply preserve unrelated fields; actual process
  restart retains manual mode, dot stays quiet and Ctrl+Space opens candidates. Both JOIN source hashes
  and primary stress input hash remain unchanged, saved settings restored and owned process stopped.
  Actual screenshots `native/native-sql-join-completion.png` and `native/native-sql-join-result.png`
  were opened and reviewed. Independent native review PASS.

## Product EXE

Product Release build PASS4m58s (`artifacts/dev-check/2026-11-07T00-18-13-441Z-phase22-build.log`).
Replaced `src-tauri/target/release/data-viewer.exe`, embedded version0.22.0. Canonical and candidate
SHA256 match: `3345e981800b2ab62bea30a28683ff85778bb1034639a92e49a0949527e87fde`.
60,487,680bytes, +17,920bytes (+17.5KiB) from the pre-follow-up canonical EXE.
Full baseline/native/product provenance is in `join-completion-exe.json`. No installer/publication or
Phase-wide promotion was performed.

Settings controls only completion popups; the existing function argument guidance remains available.
Actual OS IME is not claimed proven by synthetic composition tests. No CTE output inference was added.
