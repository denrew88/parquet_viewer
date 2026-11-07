# Phase22 test design

Mode: **test design**, 2026-11-06. Draft development evidence; not formal promotion or a PASS claim.
Inputs: `../00-scope.md`, `../05-contract.md`, PROJECT_SPEC, DEVELOPMENT_PLAN, UI_VALIDATION,
PLAYWRIGHT and AI_WORK_POLICY. Latest user-approved file-local exclusive name/ordinal mode overrides
the earlier proposal. Root owns the common plan/status; this file is Quality's independent design.

## Traceable acceptance matrix

| ID | Completion condition / cases | Layer and owner | Fixture / expected result |
| --- | --- | --- | --- |
| T-P22-001 | Registration, alias editing, same basename/different paths, repeated canonical path | Engine unit + Quality E2E/native | sales/orders.csv and archive/orders.csv remain distinct; aliases case-insensitively unique; rename Enter/accept, Esc/cancel, no source rename or SQL rewrite |
| T-P22-002 | Raw-name eligibility and defaults before suffix/truncation | Engine unit + Quality native | duplicates.csv/parquet, case-duplicates.csv, blank.csv, no-header.csv, collisions.csv; complete raw blanks/ASCII-case duplicates/no-header disable name; valid names default name |
| T-P22-003 | One column mode per table; physical ordinal stable | Engine unit + UI component + E2E/native | Two-table mixed modes work; non-exposed spelling fails unless it is itself a genuine raw name; c1 raw-name case tested; skip c2 leaves c1/c3, reorder/hide never renumbers |
| T-P22-004 | Name quoting, insert and examples reflect aliases/modes | UI unit + Quality E2E | Korean/spaces/embedded quote header; click/double-click inserts current legal spelling; examples update but insertion does not execute; prior SQL byte-identical on mode/alias change |
| T-P22-005 | Wire boundary parity and typed failures | Engine/TS unit + shared boundary cases | SQL1/65536/65537 UTF-8 bytes, sources0/1/32/33, alias1/128/129 scalars and512/513 bytes, NUL/blank/duplicates, enum/ID mismatch, count JS-safe integer boundary |
| T-P22-006 | Single SELECT/CTE, inner/left joins, aggregates, windows | Engine integration + Quality golden/native | sales/orders.csv + customers.parquet; ordered exact golden values incl duplicate/null/unmatched keys; empty result retains schema; SQL LIMIT not silently injected |
| T-P22-007 | Exact numeric/temporal values and unsupported types | Engine unit/integration + Quality typed native | Int64 min/max, UInt64 max,2^53 neighbors, DECIMAL38, timestamp ns/tz, duration units; no Number/float loss; explicit actionable unsupported type rather than lossy cast |
| T-P22-008 | Active CSV profile semantics: null/empty/invalid | Engine unit + Quality native | typed-invalid.csv; genuine empty text stays empty; null-token/invalid typed values SQLNULL; warnings and source-profile inspection route; existing parsing mode respected |
| T-P22-009 | Arbitrary result schema with duplicate labels | Engine/TS unit + E2E/native | SELECT ... AS same, ... AS same gives distinct r0/r1; cells/pages/projection/TSV headers preserve correct values and duplicate display labels |
| T-P22-010 | Extract/count/type validation before dangerous prepare | Engine security integration | valid SELECT with quoted semicolon allowed; CREATE/COPY/SET/ATTACH before SELECT rejected before side effects; independent canary files/settings unchanged even on invalid tail |
| T-P22-011 | SELECT file/network/extension/configuration bypass blocked | Engine security integration + isolated native | read_csv/read_parquet/read_text/glob, metadata scanners, URLs, system/secret settings functions and nested/CTE variants; only registered inputs; no external request, write or canary disclosure |
| T-P22-012 | Bounded result storage, independent stable page data | Engine integration + Quality runtime | 1M-row ceiling, 4096-column ceiling,512MiB ceiling and remaining budget; exact-boundary then one-over fail; first/middle/last pages/cell reads do not rerun SQL; response ≤200x64 and existing preview/byte bounds |
| T-P22-013 | SQL result TSV copy uses real limits and atomic commit | Engine copy unit + UI/E2E + Quality native | duplicate labels, tabs/LF/CRLF/quote/Unicode/NULL/long value; partial/reordered projection and headers match golden; cell/byte limit and cancel leave clipboard unchanged; stale result invalidates copy |
| T-P22-014 | Queued/running/materialization cancel, worker crash, late response | Engine deterministic concurrency/subprocess + E2E/native | one active job; interrupt/owned worker kill cleanup; no new result publication after cancel/release; previous successful result remains; next job succeeds |
| T-P22-015 | Input identity/profile/lease lifecycle | Engine concurrency + native | source close/profile change cancels affected work; unrelated source mutation does not rebind snapshot; running input lease blocks cache migration/deletion; independent terminal result survives source close |
| T-P22-016 | Shared cache+spill+old/new result resource accounting | Engine manager integration + measured native | overall1GiB and representative min budget; existing388MiB cache counted; 2snapshots/16statuses bounds; C/D volumes checked separately; no headroom double credit or uncounted DB/WAL/copy staging |
| T-P22-017 | Disk/storage failure and cleanup preserve prior data | Engine injected faults + actual native scenario where safe | fail write/save/publish/worker exit; source hashes/canaries unchanged; owned partials reclaimed; old result remains readable; distinguish injected from actual disk-full/ACL |
| T-P22-018 | EXPLAIN vs ANALYZE execution count and plan fidelity | Engine instrumentation/integration + UI/native | EXPLAIN does not execute query; ANALYZE executes once, no extra SELECT; raw/tree agree; absent metrics remain unknown; parallel operator times not summed as wall time; same guards/cancel/budgets |
| T-P22-019 | Main SQL UI: registration/alias/search/mode/examples/help | UI component + Quality E2E | no-source/loading/error/ready, 4096 logical columns virtualized; one checked native radio per selected table; disabled reason visible; keyboard aliases; independent table modes and search; examples accurate for selected files |
| T-P22-020 | Editor/result keyboard focus and stale request isolation | UI component + Quality E2E | Ctrl+Enter once; editor keys never move grid; request/run/result/mode generation changes discard stale status/page/copy; retry current state, no old overwrite |
| T-P22-021 | Three viewport interaction/geometry/screenshots | Quality E2E + independent image review | 1440x900,1024x768,800x600; SQL tools/help/source list/result usable; no unintended overflow/overlap/clipping; header/cell ≤1px, selection ≤2px; DOM rows/columns bounded by viewport |
| T-P22-022 | Native release behavior and process lifecycle | Quality + Root native | isolated0.22.0 candidate; real Rust IPC mixed CSV/Parquet results, native clipboard exact TSV, own worker lifecycle, parent shutdown cleanup and settings restoration; browser mocks not substitution |
| T-P22-023 | Large real input performance/resource observation | Quality benchmark/native | immutable existing5.85M fixture, COUNT/filter/group/limited join; measure elapsed/peak sampled RSS/spill/resultbytes; correctness and configured resource ceilings required; no invented latency target |
| T-P22-024 | Final regression/build integrity | Root execution + Quality review | affected tests during implementation; final Rust/frontend/E2E once converged + fmt/clippy/lint/typecheck, release/native build/version/hash; historical ignored gates retain labels |

## Boundary details and high-risk assertions

- Alias limits are Unicode scalar count plus UTF-8 bytes, not JS UTF-16 `.length`. SQL is UTF-8 bytes.
  Rust+TS parity cases include emoji, combining sequences, whitespace and NUL. Raw name eligibility uses
  ASCII case folding as specified, including duplicates beyond the metadata display audit truncation cap.
- SourceIndex is zero-based original physical order; ordinal cN is sourceIndex+1. Skipped profile columns
  are not exposed and do not close gaps. Both raw duplicate headers and duplicate result labels need tests.
- Engine must reject mixed spelling based on actual projected schema, not a frontend guard only. A raw
  column genuinely named c1 remains allowed in name mode; this does not create a second ordinal namespace.
- DuckDB Rust1.10504.0 `inner_connection.rs:134..153` executes every intermediate extracted statement in
  `Connection::prepare`. Security tests observe side effects, not just the final error. Extract count before
  invoking this wrapper; valid string literals/comments containing semicolons must remain usable.
- SELECT is not a security classification for functions. Bind/prepare can touch external inputs, so test
  access guards before prepare as well as execute. Canary paths and nonexistent paths are both needed to
  distinguish blocked access from accidental missing-file failure. No real user file or network endpoint used.
- Result caps never silently truncate. Old result occupies budget while new materialization is pending.
  A result cap failure must report failed rather than complete with a partial row count. Empty results retain
  schema. Release/close invalidates copies and cannot allow a delayed clipboard commit.
- Result-column IDs r0/r1 are local to a result and may not authorize reads from another result/run. Test
  mismatched runId/resultId/sessionId/documentId/queryId and released/expired handles for page/cell/copy.
- ANALYZE count is verified by an engine-side read/execution probe, not timing or status text. Expose only
  measurements actually provided; no fabricated zero cost/time/rows. Large sampled RSS is an observation,
  not proof of a strict instantaneous process-tree memory maximum.

## Fixtures and independent golden data

Quality owns `fixtures/phase-22/**`; proposed small deterministic inputs:

- `sales/orders.csv`, `archive/orders.csv`: same basename; distinct rows, Korean/spaced headers, nullable
  customer ID, exact decimal amounts. `customers.parquet` includes duplicate and NULL keys and an unmatched key.
- `headers/duplicates.csv`, `headers/duplicates.parquet`: repeated raw names; `case-duplicates.csv`,
  `blank.csv`, `collisions.csv`, `no-header.csv`; raw c1, reserved `__dv_*`, space/quote and suffix collision.
- `typed-invalid.csv`: explicit CSV profile for invalid numeric, NULL token, text empty/tab/LF/CRLF/Unicode.
- `types.parquet`: exact integer/decimal/timestamp/duration values with metadata; optional nested/BLOB
  support must match explicit product contract, otherwise the expected typed unsupported result is recorded.
- `wide.csv`: many original columns for deterministic search/virtualization/ordinal stability.
- `golden.json`: explicit source rows, inner/left joined rows, grouped sums, window ranks and expected TSV.
  Golden arithmetic uses Python integers/Decimal independently of DuckDB; source raw names listed separately
  from viewer-resolved labels. No committed generated large fixture or source-cache copy.

## Ownership and execution sequence

Implementation agents write module unit tests, DTO boundary/parity cases, SQL validation, source typing,
storage/concurrency/subprocess faults and instrumented execution-count tests with their code.
Quality writes fixture/golden generation, dedicated `e2e/phase22-sql.spec.ts`, geometry/screenshot evidence,
independent security/resource/native review. Root owns fixed dev-check tasks, full-suite/build execution,
native app launch/clipboard/worker control and common acceptance status.

Before UI integration the dedicated E2E file remains uncreated; do not invent locator/DTO contracts.
Once stable, test via roles/accessibility and actual state, not implementation-only CSS or clicking alone.

## UI evidence contract

- Viewports: desktop1440x900, compact1024x768, minimum800x600.
- Capture representative ready mixed-mode result, blocked name-mode reason, running/cancel/error,
  examples/help and plan. Avoid one screenshot for every trivial action; keep representative final evidence.
- `ui/geometry-results.json`, `interaction-results.md`, `visual-review.md`, three `browser-*.png` and
  applicable state images. Quality opens images independently; screenshot existence is not visual PASS.
- Intentional scroll exceptions: result grid, selected-table virtual column list and editor scroll surface.
  All app chrome, radio labels/reasons, help controls and status/footer must fit/reflow without overlap.
- Native evidence: isolated release version/hash and PID identities, real Rust source/result DTOs,
  read/copy golden data, exact OS clipboard text, worker cleanup, storage usage and immutable source hashes.
  No installer/file-association/DPI/Excel PASS is inferred from a browser or development executable.

## Current status

Design recorded before product implementation. No PASS/FAIL verdict or executed test count yet.
Final measurements and unsupported-type decisions must be recorded against this matrix without lowering
criteria to match an implementation. Missing required native evidence keeps Phase22 in progress.
