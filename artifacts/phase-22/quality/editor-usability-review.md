# Phase22 editor usability — independent review

Execution mode: independent verification. Scope: the five approved directly typed SQL usability changes; Phase22 overall remains in progress. Final review 2026-11-07. The chronological checkpoints below preserve initial failures and their closure.

## Final verdict: PASS for this follow-up scope

| Test ID | Final verdict |
| --- | --- |
| T-P22-USE-001 | PASS — concise name/ordinal candidates; focused browser and native regression. |
| T-P22-USE-002 | PASS — explicit disclosure without insertion; final browser/native visuals and interaction. |
| T-P22-USE-003 | PASS — undeclared alias remains conservative; actual-name guidance and zero typing SQL calls. |
| T-P22-USE-004 | PASS — browser persistence/fallback and actual app restart preserving collapsed help. |
| T-P22-USE-005 | PASS — independent exact result/plan provenance, edit/restore and binding changes. |
| T-P22-USE-006 | PASS — failure/cancel retention, running edit, original retry snapshot, guarded stale rejection; fixed visibility regression. |
| T-P22-USE-007 | PASS — three browser viewport image review, actual WebView interaction/images, regression rerun and final product build evidence below. |

## Initial checkpoint (historical)

| Test ID | Current evidence / verdict |
| --- | --- |
| T-P22-USE-001 | Browser PASS in all three viewports: original-name candidate detail is type only; ordinal detail preserves type and original name once. Provider implementation independently inspected. |
| T-P22-USE-002 | Browser PASS in all three viewports: short inferred disclaimer; initially closed `Why this JOIN?` disclosure, explicit expansion without changing SQL or accepting a candidate. Final selected-detail contrast image pending. |
| T-P22-USE-003 | Browser PASS in all three viewports: undeclared `c.` has no guessed columns; actual registered name and correctly declared forward alias work. Hint is readable. Typing/completion exploration leaves SQL backend call counters unchanged. |
| T-P22-USE-004 | Browser PASS in all three viewports: collapsed/open preference survives navigation/remount/reload; invalid storage value safely defaults open. Storage denial defenses are covered by owner component tests. Actual Tauri restart evidence pending. |
| T-P22-USE-005 | Browser PASS for independent result/plan exact SQL and binding snapshots, whitespace edit, restoration, alias/mode change and reversal. Running-edit portion passes before the first-page recovery failure below. |
| T-P22-USE-006 | Initial browser FAIL: retry for an initial result-page error is hidden when Execute was launched while Execution plan was selected. Product fix inspected; focused rerun pending. Cancellation/failure retain outputs and separate attempt history from restored draft equality before that failure. |
| T-P22-USE-007 | Three viewport screenshots independently opened. Initial focused 9 PASS / 3 FAIL; final focused/full browser/native/build gates pending. No Phase completion claim. |

## Findings and disposition

1. **Medium, result-page recovery visibility.** From Execution plan, execute a new query and fail its initial result page. The pending retry banner was rendered only in the hidden Results panel, leaving no visible recovery action. All three viewport tests reproduced this at `e2e/phase22-editor-usability.spec.ts:292` (initial log `2026-11-07T00-53-29-146Z-phase22-e2e.log`). This is a product issue, not grounds to change the test to click Results. The corrected catch sets output to Results while retaining the previous successful output and submitted retry snapshot. Product owner added the fix; final regression is pending.
2. **Medium, selected candidate detail contrast.** Initial selected `Suggested JOIN` detail used grey text on blue selection. Root independently reported the same issue and assigned the CSS fix. Final imagery pending; no duplicate new finding.

No additional source-review findings in this batch. Snapshots are cloned/frozen before invocation, including bindings; result and plan retain independent snapshots. Pending publication/retry uses the submitted snapshot rather than live editor text. Exact SQL and sorted binding/source identity comparisons are separate from failed/cancelled-attempt history, allowing exact restoration to become current again. Previous result page/cell/copy callbacks remain bound to its result identity.

Help preference is a guarded UI-only localStorage key with no backend schema mutation. JOIN detail DOM uses `textContent` for source names and descriptions, and is initially closed; no source-derived HTML interpolation was introduced.

## Independent visual inspection

Opened actual PNGs: `editor-usability-join-expanded-desktop-wide.png` (1440×900), `editor-usability-join-closed-desktop-compact.png` (1024×768), and `editor-usability-previous-result-desktop-minimum.png` (800×600). Expanded explanation wraps within the popup; compact short disclaimer remains readable; minimum-size previous-result badge and grid are visible. Completion popup may cover adjacent help while active, as a normal transient popup. Selected detail contrast finding above remains pending corrected image review. Geometry assertions executed by the focused browser tests preserve viewport bounds and no horizontal document overflow.

Browser mock response barriers are test-owned UI state fixtures. They do not prove DuckDB runtime failure/cancellation, actual clipboard, OS IME, or native restart behavior. Actual Tauri evidence and final EXE metadata will be reviewed separately when supplied by the root. No extra test/build was run by the reviewer.

## Corrected-source checkpoint

Source review PASS for this follow-up, with final whole-browser/native/product gates still pending. Focused browser rerun `2026-11-07T00-56-38-…-phase22-e2e.log` passed all12 cases in45.6s, including the unchanged initial-page retry assertion in every viewport. The recovery visibility finding is closed. The newly refreshed minimum-size closed-JOIN PNG was independently opened: selected label and `Suggested JOIN` detail now both use readable white text on blue; the contrast finding is closed.

Final retry catch independently inspected: it only publishes the error while mounted and the pending request runId still equals the current runId. Owner's deferred test explicitly fails pageA, starts retryA, publishes newer resultB, then rejects retryA and asserts no stale error and the new result identity/current state remain unchanged. Owner reports Workspace17/17 PASS (`00-57-28`). This closes the related stale-error review concern without changing E2E criteria. Initial failed evidence remains preserved above.

## Native acceptance checkpoint

Independently read `native/stress-usability.json` and opened both `native-sql-usability-completion.png` and `native-sql-usability-result.png`. The native acceptance helper passed in11.705s. The calibrated forwarded-fetch observer has controlDescribeCalls1 and zero SQL calls during typing/exploration, followed by exactly4 acknowledged query starts. All four name/ordinal combinations completed the correct JOIN, with actual result3 visible in the result PNG. Native assertions record initially closed detail, explicit expansion/no insertion, changed-result label and exact restoration for every combination, and collapsed help retained after real restart. Both fixture hashes are unchanged, settingsRestored/ownerStopped are true, and input before/after hash agrees.

The completion PNG shows the editor immediately before completion, with no popup present at capture time; it is not used as native disclosure visual evidence. Disclosure interaction is proven by actual WebView assertions, while popup visual review uses the three browser viewport images. Result PNG independently shows readable `Current result`, one result row and value3. These native checks do not replace mock/component coverage of fault injection, first-page retry or stale rejection.

Root's final full browser run reported200 PASS /1 failure after product assertions, caused by a Windows `screenshot.open UNKNOWN` write error in USE005/007 wide; this is an evidence-capture environment failure, not a passed full run. Unchanged affected-title three-viewport rerun and final product build metadata remain pending at this checkpoint. Root reports full frontend775 PASS.

## Final interaction and capture closure

The unchanged affected-title rerun passed3/3 in14.4s (`2026-11-07T01-08-09-…-phase22-e2e.log`). This closes the environmental capture failure; the original whole run remains recorded as200 PASS /1 environment failure rather than a single clean201 run.

Latest actual native capture rerun (`01-09-09`, finished01:09:25Z) passed all native acceptance assertions in12.279s, with settings restored and owned process stopped. Independently opened refreshed `native-sql-usability-completion.png`: the actual WebView now visibly shows the white-on-blue short JOIN candidate, concise inferred disclaimer and closed `Why this JOIN?`. Opened new `native-sql-usability-previous-result.png`: `SQL changed · previous result` is readable above the preserved COUNT3 grid. These replace the earlier popup-absent image limitation as final visual evidence. No product source change was needed for capture recovery. Source/browser/native scope PASS; final product binary metadata remains pending.

## Product gate closure

Independently read `editor-usability-exe.json` and final build log `2026-11-07T01-08-26-234Z-phase22-build.log`: optimized release build succeeded in4m32s. Recorded canonical and candidate SHA256 both equal `01df54625e4f15a550782f4cf29ced3cc63d2a4dd2b5a25a0cef1d3306105dd1`; version0.22.0,60,488,192bytes,512bytes (0.5KiB) above the60,487,680byte baseline. The native acceptance binary hash `aa53529c…` is separately recorded and is not represented as identical to the product identifier build. Root reports canonical replacement succeeded after closing only the confirmed owned verification window that held the EXE lock. No additional product changes or builds were requested by this review.

All scoped gates are closed. Full-browser history remains200 PASS /1 Windows image-write error, followed by unchanged affected-title3/3 PASS; it is not relabeled as a clean201-run result. Real OS IME/installer/clipboard behaviors were not changed or newly certified here. Phase22 overall and phase-wide promotion remain outside this scoped PASS; metadata explicitly records `phaseWidePromotion:false`.
