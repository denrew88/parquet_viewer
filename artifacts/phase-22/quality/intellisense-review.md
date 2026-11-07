# Phase22 CodeMirror / SQL intelligence — independent review

Mode: independent verification, 2026-11-06. Draft evidence, not formal promotion.

**SQL editor intelligence follow-up: PASS.** Final affected browser acceptance is PASS15/15 (12 editor +3 legacy input cases), corrected actual Tauri execution and final product EXE build/size evidence are PASS. Phase22 as a whole remains in progress; this review does not approve formal promotion or complete unrelated Phase gates.

| ID | Checkpoint verdict | Evidence / limit |
| --- | --- | --- |
| T-P22-INT-001 | PASS browser + native | Actual CM contenteditable, syntax colors, undo/redo and local Find exercised. Final native verifies typed opening parenthesis inserts matching pair, matching-bracket decoration, pair insertion undo together and local Find without query calls. |
| T-P22-INT-002 | PASS browser/model | Ctrl+Space registered tables, automatic dot completion, local alias declared after cursor, whole-token replacement and Enter/Tab acceptance. Incomplete fragments covered by pure model. Final browser includes corrected unqualified expression-comma completion. |
| T-P22-INT-003 | PASS browser/model | Quoted original insertion with embedded quotes is exact/undoable; string/comment positions suppress suggestions. Model covers dollar/escaped strings and quoted replacement spans. |
| T-P22-INT-004 | PASS browser/model | Unknown/derived/CTE/duplicate aliases suppress uncertain columns. Review found CTE structural comments could reveal wrong global schema; root filters comment tokens and added3 negative regressions. Dedicated E2E includes that case and passes. No output inference claimed. |
| T-P22-INT-005 | PASS browser/model | Mode changes leave existing SQL unchanged, close old suggestions and offer only cN thereafter; name suggestions show raw name/type. Physical ordinal gaps/schema/alias refresh are model/component assertions. Actual native name+cN still under012. |
| T-P22-INT-006 | PASS browser/model | Backend allowlisted catalog audited in root unit tests; common signatures plus lexical current argument. Browser shows COALESCE Argument2 despite comma inside string and selected column type/original name. Unknown overload remains generic documentation. |
| T-P22-INT-007 | PASS browser/component | Popup Enter/Tab accept, Escape closes without rewrite, Ctrl+Enter invokes exactly1 start while popup open; editor focus preserved. No grid shortcut substitution. |
| T-P22-INT-008 | PASS synthetic guard only | Synthetic `KeyboardEvent.isComposing` Enter/Tab/Ctrl+Enter does not change SQL or run. UI component lifecycle/composing guards present. Real Windows IME input is untested and is not inferred from synthetic events. |
| T-P22-INT-009 | PASS browser/component | Existing sidebar quoted-column insertion keeps CM focus and undo/redo. Component verifies transaction selection and external example undo; prior SQL E2E was deliberately adapted to true CM lines rather than a fake textarea. |
| T-P22-INT-010 | PASS bounded/local assertions | Provider max200 candidates, CM max40 rendered, UTF-8 doc≤65,536, tokens≤8192, nesting≤64, bindings≤64. Model wide/oversized guards; browser counters for describe/start/status/page/cell stay unchanged during typing/manual/dot/signature/search. Source model only uses supplied metadata/local catalog. No remote/LSP/AI/query-on-type path found. No measured worst-case latency/RSS guarantee. |
| T-P22-INT-011 | PASS captured browser geometry/images | All3 viewport tooltips inside window; list≤40 nodes, signature readable, details flip left at800px. Selected row remains visible. Fixed-caret captured state, not exhaustive every caret/scroll position. |
| T-P22-INT-012 | PASS native/build/size | Corrected optimized Tauri completes quoted-name and physical c1 SQL through visible grid rows0/1/2, one start per Ctrl+Enter, local-only observation, bracket/find/undo. Final product release build passes; EXE60,456,960 bytes, increase121,344 bytes (118.5KiB/0.2011%). Full initial regression failures and successful affected reruns retained separately. |

## Executed independent browser evidence

`../../dev-check/2026-11-06T12-37-45-718Z-phase22-e2e.log`:12/12 focused cases PASS in31.7s,3 projects1440×900/1024×768/800×600.222 historical evidence files retained. Cases assert exact resulting SQL/undo, mode exclusivity, conservative lexical scope, signature argument, no typing SQL calls, popup keyboard ownership and synthetic composition.

Independently opened all `../ui/intellisense-desktop-{wide,compact,minimum}.png` as images and read matching JSON. Populated completion list shows selected option, original Korean name/type and detail; signature appears above caret, completion below it. All tooltip coordinates are within the physical viewport. At800px detail panel flips to the left and the floating list extends over the help panel; this is intentional temporary overlay, without clipping or inaccessible selected item. The source/editor/output layout remains intact. No new visual defect found in these captured states.

## Final source review batch

Returned one material provider defect before final gates: valid comments inside CTE declarations prevented collecting unknown CTE names, permitting incorrect fallback to globally registered schemas. Root corrected `bindingsFor` to remove comment tokens before structural CTE/relation parsing; unit cases cover comments after WITH/name/AS and between CTEs; actual E2E negative case passes.

Current provider is a bounded conservative local parser, not a complete SQL semantic service. It supports supplied registered tables and simple resolvable aliases, suppresses uncertain shadowed/derived bindings and does not infer CTE/subquery output. Function catalog is constrained by backend allowlist. UI integration uses CM transaction/history, custom local completion override, explicit key ownership and composition guards. Metadata changes close cached options without rewriting text. No additional material source defect was found in this pass.

Remaining: root native evidence/final regressions/EXE size comparison; explicit bracket interaction. Preserve the distinction between actual WebView tests and real OS IME. Any remaining required Phase-wide gates and formal promotion stay separate from this focused editor review.

## Legacy full-suite timeout investigation

Root's full browser run had168 passed/3 failed, all the existing T-P16-007/015 blocked repeated-input case; focused rerun `12-55-55-527Z` repeated the three30s timeouts. Independently read its error contexts and trace action timeline. There was one exact Find button, the CSV blocker/inert/disabled state remained intact, and the test continued making progress through repetitions. No single ambiguous locator or application deadlock was established. Unrelated individual operations were slow (one mouse click2482ms, grid role resolution1932ms, several keypresses420–946ms), consistent with traced browser/environment pressure while native compilation was also active.

Root authorized a minimal test-only change to `e2e/phase16.spec.ts`: resolve six fixed inert targets once, then verify attached/nonzero geometry and unchanged bounds in one browser read before **each** cycle and after all cycles. Reuse verified centers for physical clicks/wheel. All10 repetitions, all50 pointer clicks, all40 key chords, all10 move/wheel pairs,30s timeout, zero-IPC/selection/final-popup assertions are retained. No product change, retry increase, timeout extension or weaker acceptance criterion. Focused rerun pending root execution; the old failure is not erased or relabeled PASS before that result.

The geometry-only optimization did not resolve the three focused timeouts (`13-01-09-391Z`). Second trace read confirms general input latency: compact Ctrl+C max2586ms, Ctrl+F2391ms, Ctrl+ArrowDown1464ms, Shift+ArrowRight790ms and mouse click968ms. Clipboard/native browser Find delay is possible but not established because unrelated input is also slow. Root will rerun unchanged tests after native compilation; no additional test standard changes were made.

## Native-discovered comma regression

Root's actual WebView attempt found unqualified function arguments after a comma could receive only table suggestions: `SELECT COALESCE(s."id", |) FROM stress s`. The provider treated any earlier FROM plus comma as a relation list. Root corrected relation-comma detection to the current depth/parent and preceding FROM/JOIN clause, keeping SELECT/ORDER BY/function commas in expression completion. Root reports50 model tests and154 SQL workspace tests passing (`13-05-11`). Quality added the exact browser regression `SELECT COALESCE(o."주문 번호", |) FROM orders o`, requiring the original-name property and BIGINT detail; fixed formatter passed `13-05-37-872Z`. Focused browser and rebuilt native execution remain pending for this corrected snapshot. This is a confirmed provider bug found through actual native validation, unlike the unrelated phase16 timing failures.

## Corrected snapshot browser/source closure

Final affected run `2026-11-06T13-08-54-478Z-phase22-e2e.log`:15/15 PASS in42.6s, including all3 unchanged-criteria legacy cases and12 editor cases with the added unqualified function-comma regression. Root serializes local Playwright execution with one worker to avoid input contention;30s test limits,10 legacy input repetitions and all assertions remain.222 historical evidence files preserved. The previous timeout logs remain; no single clean full-suite claim is made.

Independently reopened all3 regenerated intellisense screenshots. Selected completion, original/type detail and COALESCE Argument2 remain readable, within viewport and without clipping;800px detail panel still correctly flips left. No new captured-state visual defect found.

Reviewed final `relationComma`: both comma depth and parent must match the selected SELECT scope, and the last cursor-preceding structural clause must be FROM/JOIN. This prevents a future FROM declaration from converting earlier function/SELECT-list commas into relation completion. Comment filtering and bounded scope rules remain intact. No additional material source issue found in this pass. Format/lint/types13-08-40 and provider50/SQL workspace154 tests pass. Corrected native rebuild13-09-49 and EXE comparison remain pending; physical Windows IME is still unverified beyond synthetic guards.

## Native page adapter and observer correction checkpoint

The next actual native attempt exposed a separate product integration defect: Rust SQL `DataPage` contains bare page fields, but the frontend common parser requires `sessionId`; a real successful query therefore failed frontend page parsing. Reviewed the minimal SQL-only adapter correction: validate request identity, reject any explicitly present conflicting wire sessionId (including null), inject validated request.resultId into the bare page, then retain unchanged common parser plus exact offset/limit/projection checks. Common `parseDataPage` remains unchanged. New native-shaped tests cover the absent wire ID and malformed/conflicting responses; backend21 and SQL workspace163 tests pass (`13-23-13`). No further material issue found in this correction; actual rebuilt grid execution is still required.

The previous native call counter attempted to replace Tauri's non-writable invoke function and observed zero despite real query execution. That observer result cannot prove no typing/run IPC. Root now uses an installed-and-verified forwarding window.fetch observer for the official IPC transport, validates it sees a real describe control call, then resets counters before editor actions. Reviewed wrapper forwards original input/options/rest unchanged and only stores selected SQL command counts plus start runId/SQL; headers/keys are not recorded. Restores original fetch in finally. This is a harness correction, not a product command change or proof of native success before execution. Corrected native build/report and EXE delta remain pending; no new product changes requested by this review.

## Final actual Tauri closure

Final native evidence: `../native/stress-editor.json`, `../../dev-check/2026-11-06T13-32-30-062Z-phase22-stress.log`, PASS. Report timestamps are **13:32:30.370–13:32:36.985 UTC**,0.22.0 optimized acceptance identifier `com.denrew88.data-viewer-phase22-acceptance`. Independently computed candidate SHA256 `4567c6f4034bd65f8600b5295343d1db6cdc950d26ae3c8c8fb61009173049d1` matches report. Input before/after SHA256 remains `505692c3e37c7b2a9ad5882a1bda21297175d4bee96e9b8b065dd2828ea34e97`; settingsRestored and ownerStopped true.

The verified observer sees one real describe control call before reset. Bracket pair/matching, undo, Find, typing/completion/signature and synthetic composition produce no tracked SQL calls. Two actual completion-generated statements execute, exactly one start each:

```sql
SELECT s."id" FROM "stress" s ORDER BY s."id" LIMIT 3
SELECT s.c1 FROM "stress" s ORDER BY s.c1 LIMIT 3
```

Both complete with3rows and exact0/1/2, at125ms and115ms respectively. The native harness also asserts those three actual WebView grid cells are visible, closing the bare-DataPage adapter defect rather than merely reading rows through a direct test command. Report counts2 starts,8 status reads and4 page reads in total; expected post-run polling/page reads are not claimed zero. BracketPairAndMatching/undo/find are true. Composition evidence remains explicitly syntheticImeOnly=true, actualOsImeProven=false.

Independently opened final `native-sql-editor-intellisense.png` and `native-sql-editor-result.png`. Native completion/details and Argument2 signature are readable and correctly anchored; final ordinal-mode result shows rows0/1/2 with aligned header/selection and unchanged mutually exclusive mode UI. No clipping or new visual issue found in these images.

This closes corrected native behavior for001/012 and previously found comma/page-adapter defects. Product build13-31-48 is still running; final EXE delta remains the outstanding scoped packaging evidence. Real physical Windows IME and unrelated Phase-wide gates remain outside this PASS.

## Final product build / size closure

Final `2026-11-06T13-31-48-539Z-phase22-build.log` reports optimized release build success in7m05s. `../intellisense-exe.json` records version0.22.0, final60,456,960 bytes vs pre-editor60,335,616 bytes: **+121,344 bytes =118.5KiB, +0.2011%**. Product SHA256 `8fb1e4c0ff5367226e4d8b6a11785dafc309aa5bd38f43be99c45714e54af6ff`. Root reports canonical `src-tauri/target/release/data-viewer.exe` and candidate match. These are same build family/version before/after measurements; no claim that CodeMirror installed-package size equals embedded EXE delta.

Tested acceptance EXE SHA4567c6f… differs because its application identifier isolates settings/cache; root records matching product source/frontend bundle (`index-qMJfdEfK`) between tested native and product builds. Final packaging evidence closes INT012. No further code, test or build run was initiated for this report closure.

Final scoped verdict: all12 IDs satisfy their stated acceptance layers, with IME PASS expressly limited to synthetic app guards. Physical Windows Korean IME is not verified. Historical full-run contention failures and successful affected reruns remain visible; no fabricated single full green run. Whole Phase22 remains in progress and formal promotion is a separate user/root action.


