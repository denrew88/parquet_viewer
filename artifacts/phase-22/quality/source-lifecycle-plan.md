# Phase22 actual SQL source lifecycle — test design

Mode: test design, 2026-11-07. User-authorized partial change, version0.22.0 retained. Root owns shared contract/common docs, commands, dev-check and native harness; engine owns reference analysis/lifetime, UI owns source-row interaction/state, Quality owns this plan. Existing edits and evidence are preserved. No new dependency/permission or artifact promotion inferred.

## Frozen acceptance intent

Only sources actually referenced by the submitted SQL own execution lifetime/cancellation leases. Closing an unrelated registered file leaves the current query running; closing a referenced identity cancels that run, stops its worker and then releases execution leases. A completed independent result remains readable/copyable after source close. Closing removes that source from future autocomplete without rewriting authored SQL. Explain/analyze follow the same dependency rules. Entire SQL source row selects the table; its pencil remains a separate rename action. Cancellation identifies why it happened.

Reference discovery must use actual DuckDB analysis/binding, not substring/regex matching of user SQL. Keep existing security ordering: read-only/single-statement/registered-source validation before any potentially unsafe prepare; analysis must not become an unguarded side-effect path or execute the query.

## Traceable acceptance matrix

| ID | Completion condition and cases | Layer / owner | Exact expected evidence |
| --- | --- | --- | --- |
| T-P22-LIFE-001 | Actual dependency set: aliases/quotes/case, FROM/JOIN, nested SELECT, used CTE, shadowed CTE, literal/comment occurrence, no-FROM constant, EXPLAIN/ANALYZE | Engine DuckDB integration + root native | Registered A/B/C remain available, but only actually bound source identities appear in authoritative reference set. A file name in a string/comment or CTE name shadowing it is not a dependency. Multiple references/self-join deduplicate. Used nested/CTE relation dependencies propagate. A query requiring no registered relation has empty dependencies. EXPLAIN discovers dependencies without executing; ANALYZE still executes once. |
| T-P22-LIFE-002 | Close unrelated source while real query runs | Engine deterministic lifecycle + actual Tauri/worker | Run on A, observe worker PID+CPU/state, close B. Same run/worker continues and completes/can subsequently be explicitly cancelled; no cancellation flag, worker replacement, loss of A lease or SQL rewrite. B is removed from future table/column suggestions. Include unrelated source merely named in SQL literal/comment, and a source present in registered bindings but unused. |
| T-P22-LIFE-003 | Close referenced source while real query runs | Engine concurrency/subprocess + root native | After real running proof on A (or A JOIN B), close A. Run becomes cancelled with source-close reason, not generic success/failure. No new result published; previously successful result42 remains readable. Worker PID exits before execution source/cache lease is released/deletable; no dead worker use or orphan. Subsequent query on remaining source succeeds. Record close→terminal→worker exit→lease release ordering. |
| T-P22-LIFE-004 | Completed result survives source close | Engine result/page/copy integration + browser/native | Successful result from A remains stable after closing A/all sources, including first/middle/last projected page/full cell and TSV copy; result release still invalidates copy/lifetime normally. Closing source does not clear prior result or retarget its identity. Source hash unchanged. |
| T-P22-LIFE-005 | UI source reconciliation, SQL preservation and reason | UI component + Quality E2E/native | Authored SQL text remains byte-identical after A/B close, schema change or mode/alias refresh. Only closed-source autocomplete disappears, no stale option is accepted. Referenced-close notice identifies cause; unrelated close does not show cancellation. Manual cancel remains distinguishable. Busy/current run identity cannot be overwritten by a late schema/status/page response. |
| T-P22-LIFE-006 | Whole source row selection, separate pencil rename | UI component + Quality E2E/geometry | Click alias, path, mode text and empty row body selects same table and updates selected column panel/mode; no accidental rename. Pencil enters rename only, preserving intended selection/SQL. Existing double-click alias behavior and Enter/Escape remain per settled UI contract. Keyboard selection remains reachable and no invalid nested interactive controls or doubled activation. |
| T-P22-LIFE-007 | Admission/reference-discovery/close races | Engine deterministic barriers + UI stale tests | Close referenced A during collecting specs, dependency analysis, CSV preparation, lease acquisition, executing/materializing, and just before publish. Never publish from detached identity; cancellation cannot be missed when refs are not known yet. Close unrelated B at identical barriers must not cancel/hold B lease or block A. Reopen same path/new session does not silently replace old identity; same-basename/different-path sources remain distinct. No sleep-only race assertion. |
| T-P22-LIFE-008 | Actual native, existing security/storage and3viewport regression | Root focused/final gates + Quality independent review | Actual optimized Tauri IPC/worker with A/B files proves unrelated-close continuation, referenced-close cancel/exit/lease cleanup, retained result and authored text, closed-source completion removal, later query success. Source-row geometry/screenshots1440×900/1024×768/800×600 independently opened. Existing query guards, bounds, storage caps, copy, completion and related suites pass; build/version/hash recorded. Browser mock does not prove native leases/processes. |

## Independent cases and fixture reuse

Reuse immutable `fixtures/phase-22/sales/orders.csv`, `archive/orders.csv`, `customers.parquet` and existing deterministic large stress Parquet. Existing Decimal/integer golden data remains the oracle. No need another large fixture. Real CSV lifecycle must observe preparation/cache lease ownership; Parquet-only worker proof does not establish a CSV cache release.

Suggested reference-set cases (test positions/aliases are examples; actual DuckDB binding is authoritative):

```sql
SELECT * FROM a
SELECT * FROM a x JOIN a y ON x.c1=y.c1
SELECT * FROM a JOIN b ON a.c1=b.c1
SELECT * FROM a WHERE c1 IN (SELECT c1 FROM b)
WITH used AS (SELECT * FROM b) SELECT * FROM used
WITH b AS (SELECT 1 AS c1) SELECT * FROM b
SELECT 'b' AS literal FROM a -- b is not a relation
SELECT 42 AS retained
```

Test quoted aliases containing spaces/embedded quotes and ASCII-case-insensitive names with current exclusive name/cN schema. An unused CTE case must follow the chosen DuckDB bind contract explicitly: record what the engine actually resolves and which file reads it may perform rather than guessing from textual occurrence. No CTE-output autocomplete inference is introduced.

An unrelated CSV still preparing/failed or with changed fingerprint must not become a required execution lease/preflight dependency merely because it is registered. Include it in owner integration tests if allowed by the current registration contract; it must not falsely prove actual-reference filtering using only already-ready sources.

## Implementation vs independent verification

Engine writes binding/reference identity tests and barrier-driven lifecycle tests with worker/lease instrumentation. Root writes thin IPC/source-close integration and native harness plus shared DTO parity if reference/reason data crosses the boundary. UI writes reducer/component tests for source removal, row hit areas, pencil propagation, cancellation reasons and stale responses.

Quality later writes an assigned dedicated E2E for whole-row clicks, source-close UI states, autocomplete/text preservation and known-result retention; browser fake backend must model actual dependency notifications explicitly, not infer by SQL substring. Quality independently reads final native reports and source/worker lease timing evidence, opens3viewport PNGs, and returns PASS/FAIL/BLOCKED per ID. No product changes or new approvals from Quality.

## High-risk invariants

- Dependency discovery and cancellation cannot race: a close before references are published must be reconciled against the authoritative identities before work/publish, while a close of a later-discovered unused source cannot cancel the job by blanket registration membership.
- Query source lookup, schema binding and actual execution are separate stages. Do not acquire/retain all registered CSV artifacts until completion just to discover a smaller final reference set; prove unused leases are absent/released safely. Do not free any lease while the worker may read it.
- A cancellation flag/status alone is not worker-exit proof. Require PID/start-time ownership, actual running CPU evidence and cache deletion/lease release observation. A task cancellation reason must survive final worker error normalization.
- SQL is user-authored state. Schema reconciliation may prune suggestions/selected table only; it must not silently replace the editor or clear an independent result. Read/copy result identities remain separate from document source identity.
- Row-wide pointer behavior must preserve native accessible keyboard controls. Avoid a container button wrapping pencil button; verify pencil does not also trigger row selection twice or commit unrelated rename.
- Keep prior security/file/network canaries intact. No extra SQL execution/EXPLAIN while typing is introduced by dependency analysis, which runs only for explicit submitted query actions.

All test gates are pending implementation/integration. Relevant focused tests first; full regression/build and native evidence follow root's convergence policy. Missing mandatory native/lifetime evidence blocks this partial change's completion, regardless of browser success.

## Initial E2E correction record

Initial focused run `15-20-07-715Z` passes card/unrelated-close scenarios but the referenced-close case times out at the final completed-source close. Error context confirms cancellation reason, Messages and prior-result checks already passed. The test incorrectly waited for exact `Close orders.csv`; same-basename tabs correctly expose `Close orders.csv (sales)` and `(archive)`. Quality corrected only that final locator to the exact sales close button, removing positional first-match selection. No product change, timeout or criterion relaxation. Failed-case three-viewport rerun pending root execution; this harness mistake is not a product lifecycle defect.
