# SQL source lifecycle and whole-card selection

2026-11-07. Requested Phase22 follow-up; no formal promotion or external publishing.

## Contract and implementation

- Registered tables stay available for editing/completion; only DuckDB metadata-binder references become
  execution inputs. No text matching. CTE scopes, joins/subqueries, repeated aliases, constant queries and
  unused CTEs follow native reference discovery. Optimizer-pruned references remain conservative dependencies.
- Discovery precedes source/session resolution and CSV preparation. The temporary discovery DB disables
  external access and locks configuration; native statement extraction/token policy precede name binding.
  User SQL is not prepared/executed in the parent. Request bounds and the security allowlist are unchanged.
- Closing unrelated tabs does not cancel SQL or acquire their CSV cache leases. Referenced close/replacement
  cancels with a specific TaskCancelled reason. Completed independent results remain available.
- Close performs cancellation before and after document detachment. A later admission identity check uses
  `abandon_sql` under the publication mutex to cancel and reclaim only an undisclosed result, closing both
  registration windows. Active-worker terminal state is published after its cleanup, not at flag assignment.
- Worker kill/wait precedes execution-source guard drop. Existing CSV lease and independent-result ownership
  are preserved. No automatic reconnection to a changed generation.
- Table selection is one native button covering alias/path/mode/padding. Pencil and edit form are separate
  siblings. Alias accessible names, Enter/Space, aria-pressed and double-click rename remain available.
- Minimum-height table area/list and nearest scroll keep the selected card visible at800×600.

## Validation evidence

- Plan: `quality/source-lifecycle-plan.md`, LIFE001..008; independent review:
  `quality/source-lifecycle-review.md`.
- Full frontend703PASS: `../dev-check/2026-11-06T15-15-51-389Z-frontend-test.log`.
  Latest workspace9PASS after the small scroll correction; final format/lint/types PASS15-36-45.
- Full browser180PASS8.1m: `15-23-30-360Z-phase22-e2e.log`. Final affected9PASS23.3s after the minimum-height
  correction/stronger ancestor clipping assertions: `15-36-56-100Z-phase22-e2e.log`.
  Three regenerated images/geometry independently reviewed; historical222evidence files preserved.
- Final Rust full394PASS/0FAIL/18existing ignored,75.46s execution: `15-37-20-883Z-phase22-test.log`.
  Includes reference-discovery, abandon-before-worker, completed-result reclamation and close-sweep tests.
  Initial SQL-only attempt compiled but OS4551 prevented execution (`15-17-10`); CodeIntegrity3077 confirmed
  policy rejection (`15-25-08` diagnostics). A new final build executed successfully with no security changes.
- Final Rust format PASS15-36-43, Clippy all-targets with warnings denied PASS15-43-27.
- Initial test-only issues fixed without lowering criteria: Testing Library role options do not accept
  Playwright's exact flag; close button for same-name fixtures includes `(sales)`; selected-card geometry
  now checks ancestor clipping, not just physical viewport containment.

## Actual native acceptance

Final4/4PASS: `../dev-check/2026-11-06T16-04-48-258Z-phase22-stress.log`, `native/stress-lifecycle.json`.
Tested optimized EXE SHA256 `37bd61170975f486f4494281c72933cafa3ef7b1e46077283a4c1e4d9a22537e`.

- Nine native reference/EXPLAIN/ANALYZE cases pass with deliberately detached unused identities; three
  truly referenced/forbidden sources reject before admission. Includes CTE shadowing/unused definitions,
  comments/literals, nested/self JOINs and constant queries with zero physical inputs.
- Actual UI runs a CPU-active cross JOIN against stress.parquet while all three files are registered.
  Worker manifest contains only stress. Closing types.parquet and orders.csv preserves that worker and SQL.
  Closing stress cancels with the specific reason; exit/cleanup observed352ms. Authored SQL remains unchanged.
  Prior `SELECT 42 FROM stress LIMIT 1` result remains visible/readable after its source is gone.
- Referenced CSV uses explicit HeaderMode::Present. A twelve-way CPU-active JOIN holds its prepared cache;
  clear-cache skips the active11,160bytes both before and just after document close. Cancellation/worker exit
  completes195ms; active cache entries then0. Reopening creates a new source generation and returns c1=101.
  Exact kill/wait-before-guard-drop ordering is reviewed RAII plus native protection/terminal cleanup evidence,
  not a claim of a separately instrumented per-instruction timestamp.
- Six start/close interleavings at0/1/5/15/30/60ms leave query temporary bytes exactly1542before/after.
  Includes rejection before registration, rejection with a compensated cancelled job, and accepted cancellation.
- Source hashes unchanged, isolated settings restored, owned process stopped; monitorError is null.
  Final image: `native/native-sql-source-lifecycle.png`.

Native harness corrections required no product rebuild: use configure_csv rather than putting headerMode
inside a parsing-profile DTO; observe real Tauri start response acknowledgement before polling its run;
read live lengths through FILE_READ_ATTRIBUTES/GetFileSizeEx instead of read-data handles that fail on
exclusively opened prepared.duckdb. Earlier logs/initial report are retained; final shared-monitor run is clean.
The native monitor retains exact handle-based size accounting and strict ownership/CPU/cleanup checks.

Independent final native review PASS: `quality/source-lifecycle-review.md`. No browser mock evidence
is claimed as actual worker/CSV lease behavior. Phase-wide promotion remains separate.

## Final product artifact

Product build `../dev-check/2026-11-06T16-04-04-198Z-phase22-build.log` PASS6m00s.
Replaced `src-tauri/target/release/data-viewer.exe`, version0.22.0,60,469,760bytes (+12,800bytes/12.5KiB).
SHA256 `6c45505f92e4ade2dfe455551136b17d6632d006f9cb0fbea259cd984dd24c88` matches the product candidate.
Machine-readable evidence: `source-lifecycle-exe.json`. Isolated native identifier differs from production;
both builds use the same final code/assets (`index-DepYyR5B.js`, `index-DGQAneNw.css`).
No product source changed after native acceptance. No commit, push, external release or Phase-wide promotion.
