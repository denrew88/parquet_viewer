# Phase 22 — SQL workspace

2026-11-06. Status: **in progress / draft**, implementation authorized. Formal promotion and external
release are separate approvals. Phase21 evidence is retained without relabeling historical unexecuted gates.

## Approved scope

2026-11-07 JOIN/quiet-editor follow-up: inferred original-name/type-compatible ON predicates with explicit
selection only, physical cN insertion per table, conservative scope/type exclusions and manual-only generic
keys. Default contextual dot/ON suggestions, optional automatic2+characters or manual-only mode;
Escape suppression and deliberate Enter acceptance. AppSettingsV7 persists sqlCompletionMode, migratesV1..6.
Root owns pure completion/settings TS/shared docs/native base; UI owns editor/workspace; engine owns Rust
settings; Quality owns [pre-implementation test plan](quality/join-completion-plan.md), E2E and native helper.

2026-11-07 follow-up: separate registered tables from parsed SQL source dependencies before source
resolution/preparation. Closing an unrelated tab must preserve running SQL; closing a referenced tab cancels
that run with a source-close reason, holds leases until worker exit, and preserves independent completed results.
The SQL source selection button covers the whole card; rename/form controls remain separate.
Root owns commands/common docs/native harness, engine agent owns SQL runtime/security/tests, UI agent owns
workspace/card component tests, Quality owns the [follow-up test plan](quality/source-lifecycle-plan.md) and E2E.

- One SQL workspace per window, one active SQL job; local opened CSV/Parquet sources, whole-file input.
- Inline editable unique table aliases; same filenames/different paths remain separate. Selected-table
  searchable virtual column list, original source names and SQL types visible.
- Each table exposes **one mutually exclusive** column mode: `name` or `ordinal` (`c1`, `c2`, …).
  Default name only when complete original source headers have no empty/blank or ASCII-case-insensitive
  duplicates; otherwise ordinal. Eligibility uses raw original headers, before viewer suffixes.
- Native radios labeled one choice per table; disabled name option explains why. Numbering is original
  source position, unaffected by grid reorder/hide. Name insertion quotes/escapes identifiers. Tables may
  use different modes in one SQL statement; one table never exposes both sets. A raw name `c1` remains
  a genuine name in name mode. Aliases/modes are session-local and not silently rewritten into existing SQL.
- Single read-only SELECT/CTE, joins/aggregates/window expressions; arbitrary typed result schema,
  independent stable result rows, virtualization/page/selection/TSV copy, full-value inspection.
- Examples + writing help use current table aliases/modes. Inserting an example never executes it.
- Execute, EXPLAIN and EXPLAIN ANALYZE, status/cancel/error. Analyze runs once and returns profile,
  not a second SELECT. Plan tree plus raw text, absent metrics are unknown, no invented costs.
- Registered sources only, extraction/validation before unsafe prepare, no user mutation, arbitrary file,
  network, configuration or extension access. Existing dependencies only.
- Bounded shared managed storage, CPU/memory settings, worker cancellation/cleanup, previous successful
  result preserved after new failure/cancel. Same-EXE worker is the preferred process isolation.

## Initial implementation bounds

SQL text ≤65,536 UTF-8 bytes; 1..32 registered source bindings; alias ≤128 Unicode scalar values/512 UTF-8
bytes, nonempty/no NUL, case-insensitive unique. IDs follow existing nonempty bounded identity rules.
Result ≤1,000,000 rows, ≤4,096 columns and configurable combined spill/output allowance (default512MiB,
Settings64MiB..10GiB), additionally constrained by the
remaining existing overall storage allowance and physical reserve. Exceeding caps fails, never silently truncates.
At most2 live result snapshots (old/new); SQL status history bounded16. Page ≤200 rows/64 projected columns,
bounded response bytes/preview as existing page contracts. Copy uses existing settings/limits and atomic commit.
These are concrete initial ceilings, not workload performance guarantees; adjust only with measured need.

## Type and lifecycle decisions

CSV uses active parsing profile. Typed-invalid values become SQL NULL with conversion warning and a
source-profile inspection path; genuine text empty stays empty. No silent integer/decimal/time precision loss.
If a logical type cannot map exactly, reject with an actionable typed error rather than cast to float/string
without disclosure. Full result values retain type/raw canonical precision. Nested/BLOB support is tested or
explicitly unsupported. Input session/fingerprint/profile/mode snapshots and cache leases survive running work.
Closing/changing a participating source cancels affected work instead of silently rebinding. Terminal independent
results can remain until explicit release; no page re-execution. Storage for input artifacts, spill, old/new results
and copy staging is accounted by existing manager; no new global storage setting in this Phase.

## Ownership

| Owner | Files / responsibility |
| --- | --- |
| Root | Common docs/status, commands/sql_workspace.rs, commands/mod.rs, lib/main, copy header interface, manifest/version/build scripts |
| Engine | query/sql_workspace/**, necessary query/engine.rs/input helpers, domain/sql_workspace.rs, module tests, same-EXE worker implementation |
| UI | src/sql-workspace/**, App/VirtualDataGrid integration, backend adapter, related frontend tests |
| Quality | quality plan, fixtures/phase-22/**, dedicated E2E, independent regression/security/native review |

Shared DTO contract is frozen in `05-contract.md`. No agent edits others' modules or common manifests.
Root coordinates necessary module exports. No unrelated library replacement or source data writes.

## Acceptance

2026-11-07 editor layout follow-up: accessible adjustable Tables/Columns vertical allocation,
bounded horizontal editor scroll showing long-line endings, and Enter preserving manual indentation
without SQL language continuation indentation. Root owns SqlEditor/tests/native/docs/build; UI owns
Workspace/CSS/split helper/tests; Quality owns [LAYOUT001..007](quality/editor-layout-plan.md), E2E
and independent review. Existing completion selection, IME, read-only execution and source identity remain.

2026-11-07 identifier insertion follow-up: use bare spelling for non-keyword ASCII identifiers;
retain escaping for parser keywords/unsafe names across completion/JOIN/examples/table-column insertion.
Existing SQL is never globally rewritten. Root owns helper/catalogue/unit/native/docs; Quality owns E2E
adaptation and independent [ID001..006 plan](quality/identifier-insertion-plan.md)/review. Backend unchanged.

2026-11-07 scoped usability follow-up: concise completion rows and opt-in JOIN explanation,
undeclared-alias/table-name discovery guidance, persisted help visibility (local UI preference only),
and explicit previous-result/plan labels comparing the draft against its captured execution SQL/bindings.
No alias inference, execution, query lifecycle or backend DTO change. Root owns completion provider/editor,
native helper/common docs/build; UI owns Workspace/CSS/component tests; Quality owns
`quality/editor-usability-plan.md`, dedicated E2E and independent evidence review. Existing edits retained.

Tracked tests in `10-test-plan.md` (Quality design first). Related tests while implementing; final full Rust,
frontend, E2E/geometry/three screenshots, clippy/fmt/lint/typecheck, product/native candidate and required native
runtime/security/resource/clipboard checks once code converges. Failed scopes rerun only as justified.
No PASS claim for browser mock in place of native. Missing required gates keep Phase in progress.
