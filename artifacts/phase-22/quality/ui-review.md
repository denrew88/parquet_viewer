# Phase 22 independent UI review — intermediate

Execution mode: independent verification. Draft evidence, 2026-11-06.

**Overall: BLOCKED for complete Phase acceptance.** Browser mock interaction and geometry are separate from native IPC, actual SQL, Windows clipboard and process/storage behavior.

## Browser evidence

Six independent SQL scenarios run in all three configured viewports: 1440×900, 1024×768, 800×600.
Initial focused run passed 18/18 (`2026-11-06T05-54-37-386Z-phase22-e2e.log`).
After editor gutter/highlight and accessible result header refinements, root started the full E2E regression
(`2026-11-06T06-07-49...`): **153 browser tests passed in 3.0 minutes**, including all 18 updated SQL cases. The updated scenarios include exact header IDs, header/cell alignment and help insertion hit testing. The runner then failed restoring a historical phase-14 screenshot (`copyfile UNKNOWN`, errno -4094). This separate evidence-restoration failure was recovered without rerunning successful tests: `2026-11-06T06-13-15-807Z-phase22-restore-evidence.log` reports PASS, 222 files checked, 39 restored, content SHA verified. Root reports historical Git diff clean; runner restoration now uses read/write instead of `copyFile`. The original failing runner exit remains recorded, with successful recovery as separate evidence.

| Test IDs | Independent assertions |
| --- | --- |
| 001–004, 019 | Per-table exclusive native radios; default and duplicate-name prohibition; alias duplicate error, Enter/Escape, same basename identity; no existing SQL rewrite; examples update only; virtual column search and escaped quoted insertion; original c38 ordinal. |
| 018, 019, 021 | Help toggle, explicit insertion, result-free EXPLAIN and missing metrics shown as unavailable; raw plan available; Insert example reachable and unobscured. |
| 014, 017, 020 | Ctrl+Enter, running controls locked, cancellation and failure preserve previous result; source/editor/grid state kept separate. |
| 009, 013, 020 | Duplicate display labels use separate r0/r1 identities, selection/copy exact browser TSV, editor arrows preserve grid selection, clear removes result. |
| 021 | Workspace/page overflow, one checked radio, virtualized column count, visible control horizontal bounds; populated result header/cell starts and widths differ by ≤1px. Active selection is painted inset on the cell itself, rather than a separate positioned overlay. |

## Independent screenshot inspection

Opened the generated PNGs as image input rather than relying on file existence.

- Updated wide populated screenshot: gutter and SQL highlight legible, selected-cell border follows its cell, source/mode/help/editor/results hierarchy distinct, duplicate visible `value` labels preserved, no toolbar overlap.
- Updated compact populated screenshot: all query actions fit, help insertion visible, gutter does not overlap text, header/cell alignment visually consistent; column controls wrap as intended.
- Updated minimum populated screenshot: gutter, SQL text and all query buttons remain visible; result header/cell boundaries align; the active cell inset border is correctly placed. The one-row result viewport and internally scrolling source/help panels are expected at 800×600.
- Updated blocked-name and plan screenshots at all three sizes were also opened. Disabled original-name option, selected ordinal radio and full duplicate-name reason remain readable. No source/mode/editor/help/result overlap was found. Plan tree and metrics are distinct; unavailable actual metrics are explicitly `Not provided`. Minimum raw plan continues within the scrollable output region.

All three populated geometry JSONs record **0px** header/cell left and width deltas, exactly one checked radio, and bounded rendered columns (11 wide, 7 compact/minimum against 38 logical columns).

The source list, virtual column area and help panel deliberately scroll internally. At smaller sizes not every file/column is simultaneously visible; this is not interpreted as missing data. Search and table switching are exercised in each viewport. The tests do not establish every possible long label, every scrollbar position or all native focus behavior.

## Native and remaining gates

Actual Tauri WebView, native clipboard, source-close/profile-change lifecycle, real SQL plans/results, same-EXE worker cancellation and measured memory/storage/performance remain separate required evidence. User confirmed Smart App Control is enabled; application-control error 4551 blocks a real candidate build/runtime. Browser mock PASS does not satisfy those gates. Historical evidence restoration is closed by the separately logged verified recovery above.
