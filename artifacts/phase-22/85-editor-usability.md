# Direct typing usability follow-up

2026-11-07. User approved the five findings from directly typing a three-table commerce JOIN in the
canonical Release app. Scoped Phase22 follow-up; the Phase remains in progress.

- Completion rows show name + type; ordinal rows also retain the original name once. Qualification,
  matching, ranking, quoting and insertions are unchanged. JOIN rows retain a short confidence label.
- JOIN information starts with `Inferred, not a verified foreign key.`. `Why this JOIN?` explicitly opens
  the original-name/type/metadata-only explanation. No verified relationship or uniqueness is claimed.
- A short hint explains that undeclared `c.` needs a FROM/JOIN declaration; the selected actual table
  name can be used before a dot. Existing table selection/search/insert is available. No alias guessing.
- Examples/help open/collapsed preference alone persists in the WebView profile's local UI storage.
  Missing/invalid/denied storage safely uses the existing first-use open default. SQL/paths are not saved.
- Each result and plan independently retains submitted exact SQL + stable table binding snapshot.
  Draft/configuration changes visibly identify previous output; exact restoration recovers a current match.
  Latest failed/cancelled/running attempt history is separate. Pending first-page retry keeps its request
  snapshot, and edits while awaiting completion do not relabel the eventual result as the current draft.

Owners: Root provider/editor, native helper and integration/docs/build; UI Workspace/style/component tests;
Quality dedicated E2E, three-viewport geometry/images and independent source/native review.
Pre-implementation plan: [USE-001..007](quality/editor-usability-plan.md).

## Validation

Completion model80PASS and actual CodeMirror24PASS; full frontend775/775PASS50.96s
(`2026-11-07T00-53-51-948Z-frontend-test.log`). Initial new browser run9PASS/3FAIL exposed a real
first-page error hidden when execution started from the Plan tab, not a test timeout or assertion issue.
The error now opens Results while preserving the prior result. A late retry rejection is also guarded
by mounted/current run identity, with a deferred regression proving a newer result remains intact.
Final affected Workspace17PASS (`00-57-28`) includes that additional test; the earlier full775 run predates it.
Focused browser12/12PASS45.6s (`00-56-38`) after retry visibility/selected-detail contrast correction.
Final format/lint/types PASS (`00-57-58`). Full201browser run (`00-58-18`) had200PASS and1Windows
`locator.screenshot: UNKNOWN ... open ... previous-result-desktop-wide.png` file-write failure after
the behavior assertions. Without code changes, all3viewports of that test PASS14.4s (`01-08-09`).
This is passing coverage across runs, not a claim that the initial full run was clean. Historical222
evidence files were preserved. Native Release build PASS9m07s (`00-58-08`). Actual acceptance PASS
in `native/stress-usability.json`: all four mode pairs COUNT3,4explicit starts/acknowledgements, calibrated
typing SQL calls0, explicit explanation without insertion, each result's edit→previous/restore→current,
and collapsed help retained across an actual process restart. Source hashes/settings/owned-process cleanup
pass. Final product Release provenance is recorded below.

No Rust/backend, settings DTO/version, capability, native dependency, file-writing feature or SQL
execution policy change. Existing Vite large-chunk warning remains; no warning limit was changed.

Native acceptance reuses the typed JOIN golden fixtures and four mode pairs, adds explicit detail,
draft edit/restore labels and actual process restart with collapsed help. The `usability` fixed filter
writes separate `native/stress-usability.json` and `native-sql-usability-*` screenshots to retain prior evidence.

## Product EXE and verdict

Scoped source/browser/native review PASS: [independent review](quality/editor-usability-review.md).
Product Release build PASS4m32s (`artifacts/dev-check/2026-11-07T01-08-26-234Z-phase22-build.log`).
The earlier direct-typing test window held the canonical EXE open; that owned test window was closed,
then `src-tauri/target/release/data-viewer.exe` was replaced. Embedded version0.22.0,60,488,192bytes:
+512bytes (+0.5KiB) from the preceding canonical EXE. Canonical/candidate SHA256 match:
`01df54625e4f15a550782f4cf29ced3cc63d2a4dd2b5a25a0cef1d3306105dd1`.
Baseline and separate native/product hashes: `editor-usability-exe.json`.

Latest native acceptance PASS12.279s (`01-09-09`). Harness-only capture correction reopens the popup
after disclosure focus returns; `native-sql-usability-completion.png` now visibly shows the short JOIN
information. `native-sql-usability-previous-result.png` visibly shows the edited-SQL badge with preserved
COUNT3, while `native-sql-usability-result.png` shows restored current state. These were independently
opened and reviewed; no product source changed for the capture correction. No further product rebuild,
installer publication or Phase-wide promotion was performed.
