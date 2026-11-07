# Phase 22 test plan

Status: approved before implementation, not an execution/PASS claim.
Detailed independent cases/fixtures/boundaries: [Quality design](quality/test-design.md).

JOIN/quiet suggestions follow-up uses [JOIN001..010](quality/join-completion-plan.md), frozen type/name/scope,
keyboard and settings contracts. Native typed fixtures and golden rows are `fixtures/phase-22/join-completion/`.

2026-11-07 source lifecycle/card follow-up: [LIFE001..008 plan](quality/source-lifecycle-plan.md), approved
before implementation. Covers native parsed references/CTE scopes, close/start races, cancellation/worker exit,
lease release ordering, independent results, whole-card/rename keyboard interaction and three viewports.

| ID | Gate |
| --- | --- |
| T-P22-001 | Registration/alias/same basename/different paths |
| T-P22-002 | Complete raw headers, blank/ASCII case duplicate default modes |
| T-P22-003 | Exclusive radios and backend enforcement, original-order cN |
| T-P22-004 | Quoting/escape, examples/help sync, original SQL unchanged |
| T-P22-005 | Rust/TS DTO boundary parity |
| T-P22-006 | SELECT/CTE, JOIN/group/window correctness |
| T-P22-007 | Exact integers/decimal/timestamp/timezone/duration |
| T-P22-008 | CSV null/empty/typed-invalid policy |
| T-P22-009 | Duplicate result display labels and unique projection IDs |
| T-P22-010 | Extract/validate before prepare, no multi-statement side effects |
| T-P22-011 | File/network/extension/settings/function bypass rejection |
| T-P22-012 | Bounded result snapshots, first/middle/tail, no page re-execution |
| T-P22-013 | TSV headers/values, limits/cancel/atomic clipboard |
| T-P22-014 | Execute/store cancel, worker exit/kill, stale responses |
| T-P22-015 | Source/profile/session changes and cache/input leases |
| T-P22-016 | Shared storage cache+spill+old/new results at1GiB |
| T-P22-017 | Out-of-space/failure cleanup and previous result preservation |
| T-P22-018 | EXPLAIN no execution, ANALYZE one execution, unknown metrics |
| T-P22-019 | Alias/search/mode/examples native-control browser interactions |
| T-P22-020 | Editor/grid focus/keyboard/selection/stale state |
| T-P22-021 | 1440x900,1024x768,800x600 geometry + independent images |
| T-P22-022 | Actual Tauri IPC/mixed inputs/clipboard/worker lifecycle |
| T-P22-023 | Actual5.85M resource/latency observations with enforced bounds |
| T-P22-024 | Full regression/format/clippy/lint/types/E2E/candidate build |

Final acceptance must distinguish product failures, environment blocks, supported type limitations and
unexecuted native cases. Browser mocks and simulated budget faults do not replace native evidence.

2026-11-06 actual stress follow-up: S-P22-001..007 in `quality/stress-plan.md` map to ten actual native
scenarios covering this request's T-P22-012/014/016/017/023 subset. See `60-sql-stress.md`;10/10PASS on final
rebuilt native candidate. This does not replace remaining broader Phase22 gates or erase the intermittent
CSV-corruption full-suite failure (isolated rerun PASS).
## SQL editor usability follow-up

Editor layout follow-up: [LAYOUT001..007](quality/editor-layout-plan.md), splitter drag/keyboard/cancel,
viewport clamps and selection preservation, actual horizontal overflow/end-marker visibility, manual-only
newline indentation, completion/IME shortcuts, three viewports and real WebView.

Identifier insertion follow-up: [ID001..006](quality/identifier-insertion-plan.md), safe ASCII spelling,
DuckDB keyword parity, reserved/unsafe escaping, whole quoted-token replacement/Undo, no draft rewrite,
four actual native JOIN modes and final EXE verification.

2026-11-07 scoped acceptance: [independent plan](quality/editor-usability-plan.md), USE-001..007.
Related frontend and browser tests during implementation, then full frontend/browser and actual optimized
WebView interaction/restart verification. Rust parsing/query behavior is unchanged in this follow-up.

