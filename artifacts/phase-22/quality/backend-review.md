# Phase 22 independent backend review — intermediate

Execution mode: independent verification after `50-integration.md`. 2026-11-06.

**Overall: BLOCKED.** This is a source review checkpoint, not a native acceptance result.
Windows application control error 4551 prevents the new Cargo build-script executable from running.
Rust compilation, unit tests, clippy, actual worker/security/resource tests and Tauri clipboard remain unproved.
No blocked binary workaround or security setting change was performed.

## Findings returned to owners

| Severity | Area / IDs | Original risk | Current source disposition | Required proof |
| --- | --- | --- | --- | --- |
| High | Cache migration, T-P22-012/017 | With documents closed but a SQL result retained, migration could shut down the service and erase that independent result, including on migration failure/cancellation. | Root added `has_live_sql_state()` admission guard before shutdown. Engine detects live results or nonterminal jobs. | Retain result after closing sources; migration must reject before modifying service/cache; clear result then verify ordinary migration. |
| High | Copy storage, T-P22-013/016 | SQL copy used global staging without a shared bounded reservation; result + copy could exceed managed allowance. | SQL copy now owns a bounded temp lease and `Arc<QueryService>`, checks allowance before each serialized write, and checks current aggregate budget. Copy command enters migration admission. | Near-full shared storage, oversized/header-only copy, cancellation, concurrent query and lease cleanup; clipboard must remain atomic on failure. |
| High candidate | Catalog namespace, T-P22-010/011 | Quoted schema qualification could bypass an unquoted-word token check, especially with registered aliases `tables`/`pg_class`. | Guard now inspects quoted or unquoted token words; explicit dangerous function families precede syntax exceptions. Owner added regression cases. | Execute quoted/case-varied schemas and alias collisions against real existing canaries; prove no access/write/HTTP. |
| High | Exact temporal data, T-P22-007 | Native Parquet timezone nanoseconds could lose precision before result type validation; duration metadata warnings could be lost. | Worker schema preflight explicitly rejects timezone-ns input before DuckDB view creation. Input column warnings are collected. | `temporal-extra.parquet`: actionable unsupported error or exact values/units; never silently round 1ns/-1ns. |
| Medium | DTO parity, T-P22-005/012 | Rust/TS disagreed on offset >1M and Unicode blank definitions. | Both now consume independent `dto-boundaries.json`; canonical SQL blank is Unicode White_Space union U+FEFF, offset ≤1M. UI reports 71 cases PASS; Rust test exists but unexecuted. | Execute Rust shared-fixture parity and retain both logs. |

These are source changes addressing review findings. None is reported as a successful native reproduction or runtime fix verification.

## Independent inputs

- `fixtures/phase-22/golden.json`: Python integer/Decimal join/aggregate expectations, no DuckDB-generated oracle.
- `security-cases.json`: allowed and denied SQL; harness must substitute real existing canary paths and verify no HTTP or output writes.
- `dto-boundaries.json`: common literal/repeated-string boundary corpus consumed directly by both implementations.
- `temporal-extra.parquet`, `types.parquet`, malformed/duplicate/blank/raw-header fixtures.

## Native harness review

Root-owned `scripts/native_phase22_sql.mjs` was read, not executed. The negative binding case was checked with root: `start()` catches synchronous rejection as `state: rejected`, and the assertion accepts any non-complete state. No harness defect established.

Root subsequently obtained a compile-only context check reaching Rust typechecking (log prefix `06-06-08`), found and fixed a borrow error, and returned a worker API deprecation to the engine owner. The helper now includes real command registration; routine clippy issues are being addressed. This does not establish a real Tauri build/link/runtime; those gates remain separate from the application-control blocker. User confirmed Smart App Control is enabled.

The service regression now explicitly checks live result retention after source cancellation/close, bounded copy allowance rejection, service ownership through the reader, invalidation on result release and lease directory removal after reader drop. Source review confirms these assertions exist; test execution remains required.

Harness coverage limitation: its queued cancellation case and subsequent successful query do not alone prove cancellation during active execution/materialization, parent-death cleanup, absence of orphan worker processes, or peak storage/RSS. The real harness has not run. Those planned gates remain BLOCKED rather than inferred from the script's check names. No additional confirmed material product defect was established in this final source pass.

Current browser mock results cannot establish SQL semantics, real streaming error propagation, worker process isolation, parent death cleanup, peak RSS/CPU, storage/physical reserve enforcement, OS clipboard, or Tauri lifecycle. The complete 24-ID acceptance matrix remains in `test-design.md` / `10-test-plan.md`; unexecuted required native and performance items continue to block completion.

