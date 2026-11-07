# Phase22 SQL editor intelligence — test design

Execution mode: test design, 2026-11-06. Frozen user/root scope: CodeMirror6 local editor intelligence, no remote service/LSP/AI and no backend query while typing. Version remains0.22.0; this is draft development, not formal promotion. Root owns common contracts, dependency lockfile, pure completion model/function catalog and native harness; UI owns editor integration; Quality owns this plan and dedicated E2E/review evidence. Existing SQL/storage behavior and user changes are preserved.

## Traceable acceptance

| ID | Requirement / cases | Layer and owner | Expected |
| --- | --- | --- | --- |
| T-P22-INT-001 | CM syntax, undo/redo, bracket matching/closing, find | UI component + Quality E2E/native | Editor retains accessible `SQL editor` textbox; ordinary typing, multiline selection, Ctrl+Z/redo, local find and bracket decoration behave correctly. Editor Find must not open/move source-grid Find. Existing SQL run, source/result selection isolation and byte cap retained. |
| T-P22-INT-002 | Explicit Ctrl+Space and dot completion; incomplete fragments | Root pure-model + UI/E2E | `SELECT o.| FROM orders o` resolves alias even with FROM after cursor; `FROM |`/`JOIN |` proposes registered tables; `SELECT o.| FROM orders AS o` resolves correctly. Whitespace/newlines, partial token replacement and unterminated syntax must not crash or replace unrelated text. Dot completion runs locally. |
| T-P22-INT-003 | SQL lexical context | Root model + UI/E2E | No identifier/function suggestions inside single-quoted strings, line comments or block comments. Escaped strings, doubled quoted identifiers, `--`/`/*` inside strings and `.` inside quotes are distinguished. Quoted partial names insert a complete valid identifier without doubled outer quotes; existing suffix outside replacement span remains intact. |
| T-P22-INT-004 | Scope and ambiguous aliases | Root model unit + Quality E2E | Simple FROM/JOIN local aliases only in their scope; FROM after cursor supported. `WITH orders AS (...) SELECT orders.| FROM orders`, derived alias, nested SELECT shadowing or conflicting aliases must suppress uncertain columns rather than bind the globally registered `orders` incorrectly. CTE/subquery output inference intentionally excluded. Distinct local source aliases in ordinary joins resolve independently. |
| T-P22-INT-005 | Exclusive table modes, accurate details and schema refresh | Root model + UI/component + E2E/native | Name mode gives only original-name spelling with quote escaping; ordinal gives only physical cN and raw name/type details. Korean/spaces/embedded quote raw names, genuine raw `c1`, skipped ordinal gaps and source reorder tested. Alias/mode/schema changes refresh future suggestions, leave existing SQL byte-identical and reject stale selections from old schema. Registered duplicate original names remain ordinal-only. |
| T-P22-INT-006 | Function catalog, signature/current argument | Root catalog parity + model + UI/E2E | Suggested callable functions are subset of backend security allowlist, never file/network/catalog/config/dynamic-query functions. Common entries show signature/argument docs. Current argument respects nested parentheses and commas inside strings/comments; overload/unknown signature is unavailable, not fabricated. Function prefix replacement and insertion keep valid punctuation. |
| T-P22-INT-007 | Keyboard ownership and exact run count | UI component fake callbacks + Quality E2E | Popup ArrowUp/Down, Enter/Tab accept one option, Escape dismisses without rewriting; Enter outside popup remains newline. Ctrl+Enter invokes Run exactly once whether popup open or closed, not completion acceptance. Search/input/editor shortcuts do not change grid selection. Focus remains in editor after completion/insertion. |
| T-P22-INT-008 | IME composition | UI deterministic event tests + browser synthetic + native caveat | During composition, Enter/Tab/Ctrl+Enter do not accept completion or run. Compositionend restores normal shortcuts; no final composed character loss. Real Windows IME is separate native evidence; synthetic composition does not prove OS IME behavior. |
| T-P22-INT-009 | Existing column/table/example bulk insertion | UI handle/component + E2E/native | All insertions use CM transaction handle, preserve logical selection/focus, produce exactly quoted current spelling and remain undoable. Example insertion stays explicit and never autoexecutes. Controlled value/schema rerenders do not reset document, selection or history unnecessarily. |
| T-P22-INT-010 | Bounded work and local-only behavior | Root model perf/unit + UI fake-backend instrumentation + E2E | ≤200 returned candidates, bounded rendered popup, UTF-8 SQL≤65,536 bytes. Large4096-column source and long/incomplete document do not unboundedly scan/allocate. Type100characters/manual+dot/functions/find without extra SQL/EXPLAIN/file-read IPC; descriptor refresh allowed only when source/schema changes. Known status/page polling is tracked separately, not mistaken for typing calls. No network completion requests. |
| T-P22-INT-011 | Popup/tooltip/search geometry, three screenshots | Quality Playwright + independent image review |1440×900,1024×768,800×600. Popup anchored at caret, signature/help readable, search controls reachable, keyboard-selected option visible; no clipping by editor/output/help container or fixed footer, no page overflow. Intentional CM scroller and candidate list scroll bounded. Capture completion+details/signature at boundary caret and inspect images. |
| T-P22-INT-012 | Actual WebView execution, regression and EXE size | Root native/build + Quality independent evidence review | Optimized Tauri actual name/cN completion then executed query gives known correct result; local alias/quoted-header acceptance verified through actual Rust SQL. At least real keyboard Ctrl+Enter once and undo insertion. Record before/after product EXE size/hash/version and dependency scope. Final Rust/front-end/full E2E related gates remain green; browser does not substitute native IPC/IME/clipboard. |

## Model fixture cases before UI tests

Use cursor marker `|` only in tests; remove it before passing text/position. Table registry: unique headers in `orders`, duplicate raw headers in `orders_2` ordinal-only, `customers`, embedded quote header `상품 "표시명"`, physical last c38; dedicated unit descriptors for raw `c1` and skipped c2. Add the following exact negative/ambiguity cases to implementation-owned model tests:

```sql
SELECT 'o.|' FROM orders o
SELECT '-- o.|' FROM orders o
SELECT 1 -- o.|
FROM orders o
SELECT /* o.| */ 1 FROM orders o
SELECT o.| FROM orders AS o
SELECT o.| FROM orders o JOIN customers c ON o.c1 = c.c1
WITH orders AS (SELECT 1 AS private_col) SELECT orders.| FROM orders
SELECT a.| FROM (SELECT 1 AS private_col) a
SELECT (SELECT o.| FROM customers o) FROM orders o
SELECT o.| FROM orders o JOIN customers o ON 1=1
SELECT COALESCE('a,b', SUBSTRING(c.c2, 1, 2), |) FROM customers c
```

No-output inference cases may suppress suggestions. They must not advertise incorrect outer/global schema. Assertions cover replacement from/to spans and inserted SQL, not just matching displayed labels. Root decides exact conservative SQL parsing limitations in the public help; tests must not demand excluded full SQL semantic inference.

## Evidence ownership and execution order

1. Root model tests and catalog/backend parity before editor integration; UI component tests for keymaps, composition and undo with deterministic callbacks. No product code in Quality tests.
2. Quality creates `e2e/phase22-intellisense.spec.ts` after stable accessible selectors; existing SQL spec must adapt real contenteditable assertions deliberately rather than adding a fake textarea to satisfy tests.
3. Focused new/affected browser cases while converging. Final full suite once source stable; three viewport JSON geometry and PNGs independently opened. Root owns fixed dev-check tasks; Quality does not request user approvals or launch parallel builds.
4. Root actual candidate native harness, same source except isolated identifier; execute accepted completion against real sources and record exact results/calls. Preserve production cache/settings/source/clipboard and stop only owned processes.
5. Independent review records every ID PASS/FAIL/BLOCKED, evidence and exclusions. Missing native/IME/performance evidence remains explicit. No fixed millisecond latency SLA is invented; report measured model timing/document dimensions if collecting responsiveness evidence.

## High-risk integration checks

The CM syntax parser alone does not provide application source scope; completion must use the curated local model. Candidate validity changes when schema/mode changes without a text edit, so stale cached CM options must invalidate. Ctrl+Enter can be bound by both editor and workspace; callback counting must prove one run. Composition handling must check both browser `isComposing` and editor composition lifecycle. Function signature comma counting must be lexical, not string split. Long non-ASCII text obeys the backend UTF-8 bound, not UTF-16 character count. A front-end-only dependency change can still increase embedded EXE bytes; measure the final same-build before/after artifacts, do not attribute all unrelated release variation to CodeMirror.
