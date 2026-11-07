# Phase22 JOIN suggestions and quiet completion — test design

Execution mode: test design, 2026-11-07. User-authorized follow-up; root/shared contract must freeze exact wire field, type compatibility and ambiguous-key policy before implementation expectations are finalized. Quality owns only this plan initially; no product files, dependencies, builds or approvals changed.

## Agreed behavior

- ON-context suggestions compare **original** column names and compatible types of resolvable local FROM/JOIN bindings. They are explicitly estimated candidates, not verified PK/FK relationships or automatically inserted joins.
- Ordinal mode compares original metadata, then inserts each side's real physical cN. Name mode inserts escaped quoted originals. CTE/derived/ambiguous scope is conservative; no output inference.
- Default `contextual`: automatic dot and JOIN candidates only. `automatic`: ordinary text candidates from2characters plus contextual candidates. `manual`: only explicit Ctrl+Space. Ctrl+Space is immediate in every mode.
- Escape suppresses automatic reopen while continuing the same token. Automatic popup Enter inserts newline; Tab accepts, or Arrow selection then Enter accepts. Explicit completion Ctrl+Space behavior is tested separately. Ctrl+Enter runs once; IME guards remain.
- Settings schemaV7 persists the3modes. V1–6 migrate to contextual; invalid current values reject. Typing uses local metadata only, with zero query/EXPLAIN/file-scanning calls. Existing candidate/document limits and result/source lifecycle remain.

## Acceptance matrix

| ID | Requirement and exact scenarios | Layer / owner | PASS evidence |
| --- | --- | --- | --- |
| T-P22-JOIN-001 | Key matching, confidence and exclusions | Root pure-model/catalog tests + Quality E2E | `customer_id` same original name/compatible integer types yields qualified equality candidate after ON. Same display c1 but different original names does not match. Different name/same type does not imply relation. Generic `id` is excluded or ranked below a stronger key according to frozen policy; incompatible types excluded. UI labels candidate as estimated, with no uniqueness/referential-integrity claim. |
| T-P22-JOIN-002 | Mode matrix and physical positions | Root model + UI + actual native | Name/name, name/ordinal, ordinal/name, ordinal/ordinal all insert correct current spelling. Example left original customer_id at sourceIndex4 vs right at1 must insert a.c5=b.c2, never c1=c1 or visible-row numbering. Embedded quote/space/Korean names escaped; skipped positions preserve gaps. No automatic insertion or rewrite on alias/mode/schema change. |
| T-P22-JOIN-003 | Context, incomplete SQL and scope | Root model + Quality browser/native | JOIN ON directly, multiline, AS/bare aliases, self-join, additional AND predicate, cursor before later FROM/JOIN if supported by frozen model. Ignore matches in strings/comments. CTE name shadowing, unknown subquery output, ambiguous repeated aliases or closed source suppress uncertain relationship guesses. Normal commas/function arguments keep expression context (prior native regression). |
| T-P22-JOIN-004 | Quiet3mode triggers | UI component deterministic activation + browser | contextual: plain letters even2+ never auto popup, dot/eligibleON may popup. automatic:1letter no general popup,2letters yes; contextual cases still work. manual: typing/dot/ON no automatic popup. Ctrl+Space immediately opens relevant choices in all3modes, without waiting for further edit. Existing200candidate/40rendered/64KiB guards retained. |
| T-P22-JOIN-005 | Escape token suppression | UI component + Quality E2E | Open automatic candidates, pressEscape, keep typing same token→no reopen; record complete SQL unchanged except user's characters. ExplicitCtrl+Space may reopen. New token/caret move/schema or mode change behavior must follow root's frozen suppression reset contract, not accidentally revive the dismissed token. Dot/manual transitions covered. |
| T-P22-JOIN-006 | Keyboard intent, execution and IME | UI component callback counts + browser/native | Automatic popup with no deliberate option selection:Enter is newline, no insertion. Tab accepts. ArrowUp/Down thenEnter accepts selected option. ManualCtrl+Space Enter policy explicit in root contract; test separately. Ctrl+Enter starts exactly1query irrespective of popup. Synthetic composing Enter/Tab/CtrlEnter neither accepts nor runs; actual OS IME remains separate if untested. |
| T-P22-JOIN-007 | V7 settings wire/default/migration/persistence | Engine Rust DTO/store + root TS/model + shared parity | New default contextual; valid values contextual/automatic/manual. V1–6 preserve all existing SQL storage/copy/cache/display fields and add contextual. V7 missing/invalid enum/null/type/case/unknown version reject under existing backup/recovery policy. Draft/cancel/reset/apply and actual restart retain chosen mode; current editor uses saved setting without SQL/history reset. Both Rust/TS consume same approved boundary corpus or existing shared test mapping. |
| T-P22-JOIN-008 | Local-only work, stale metadata and history | Root model + UI/component + E2E | Typing/manual/dot/ON/hint/search makes no extra SQL backend calls. Mode/source close/alias changes invalidate current candidates, never mutate editor text or accept a stale candidate. Explicit candidate insertion is one undoable CM transaction and keeps focus. No remote/API/model service. |
| T-P22-JOIN-009 |3viewport UI and geometry | Quality E2E + independent PNG review |1440×900/1024×768/800×600 completion popup shows complete estimated relationship/current spellings/details, selected row visible, no unintended clipping; long raw names bounded and inspectable. Settings3mode mutually exclusive and clear default; helper visible. Intentional popup/list/editor scroll exceptions documented. GeometryJSON plus images independently opened. |
| T-P22-JOIN-010 | Actual Tauri correctness and final regression | Root native/build + Quality review | UI chooses ON candidate in name and cN/mixed modes; actual Rust join returns known golden count/values. Uniqueness is not inferred from matching names. Actual Settings restart and observed trigger/Enter/Escape behavior verified in WebView, zero typing SQL calls with calibrated observer, CtrlEnter once. Related/final gates and version/hash/EXE delta documented without claiming entirePhase complete. |

## Concrete model fixture matrix

Reuse existing source goldens where appropriate; pure descriptors may cover unusual physical positions without new large files. Do not change production mock metadata just to make model unit tests pass.

- Orders: sourceIndex0 `id` BIGINT, sourceIndex4 `customer_id` BIGINT, sourceIndex7 `상품 "번호"` VARCHAR. Customers: sourceIndex0 `id` BIGINT, sourceIndex1 `customer_id` INTEGER, sourceIndex8 `상품 "번호"` VARCHAR. Strong expected match is customer_id if integer widening is approved; generic id must not outrank it. Quoted text pair tests escaping without claiming it is a meaningful real-world key.
- Mismatch: same raw customer_id INTEGER vsVARCHAR; same c1 with different originals; duplicate raw customer_id twice on one side in ordinal mode; nullable values; decimal/float/integer combinations; timestamp unit/timezone differences; unsupported/nested types. Expected compatibility table is frozen by root, not retrofitted to implementation.
- `SELECT * FROM orders a JOIN customers b ON |`: estimated equality suggestion, no editor change until accepted.
- `WITH customers AS (SELECT 1 AS customer_id) SELECT * FROM orders a JOIN customers b ON |`: unknown CTE output, suppress global customers matches.
- `SELECT * FROM orders a JOIN customers b ON /* customer_id */ |`: comments do not create aliases/keys; original registry still authoritative.
- `SELECT * FROM orders a JOIN customers b ON a.customer_id=b.customer_id AND |`: root must specify whether duplicate predicate suggestions are suppressed or available; do not silently turn an existing ON expression into a different join.

## Contract details root must settle before test expectations

1. Exact serialized settings key and radio/select accessible labels; compatibility table (at least integer widths, signed/unsigned, decimal/float, text, temporal timezone/unit), ASCII folding vs exact original-name matching, duplicate-raw-name ambiguity handling. Default conservative proposal: no whitespace trimming/NFKC/fuzzy matching; compare original name using existing ASCII fold, require scalar-compatible types, suppress nonunique raw-name pairings.
2. Whether generic `id` is excluded or merely lower-ranked. Either agreed choice is acceptable, but tests require a stronger candidate ahead of it and never display an id match as certain.
3. ExplicitCtrlSpace popup Enter acceptance (recommended current manual behavior accepts; automaticEnter remains newline); what qualifies Arrow deliberate selection; suppression reset on cursor/token edit/mode/schema changes. These distinctions must not depend on incidental CM default selection of the first option.
4. Trigger boundaries for ON prefix, AND after ON and repeated/multi-table joins. Full semantic key inference/CTE output remains excluded; uncertainty must not create a wrong relation.

## Ownership and execution

Root writes completion model/type compatibility/scoring, TS settings/migrations and shared contract/corpus; engine owns Rust schemaV7 store/parity; UI owns CM trigger/keyboard/suppression and settings integration. Each writes related module tests. Quality later owns a **new dedicated E2E file only**, mock-call observation and screenshots/review; root owns native harness/dev-check/build and commonPhase docs.

No UI mock result is native join correctness. Reuse orders/customers integer/Decimal goldens for actual native comparison; matching header names alone may produce many-to-many results. Verify duplicate/null/unmatched keys rather than assuming PK uniqueness. Preserve existing files, cache/settings/clipboard and source hashes, terminate only owned validation processes. No extra test/build at design stage. Related tests first; final broad gates once frozen; formal promotion remains separate.

