# Phase 25 Settings — independent quality review

Execution mode: independent verification. Overall verdict: **PASS for this Settings follow-up**. Reviewed `50-integration.md` and the final exact-binary manual native record. All S01..S12 acceptance items have passing evidence. The user has explicitly authorized completing verification and formal EXE promotion; Root owns that promotion and its receipt. This verdict does not change the separate whole-Phase OS file-drop gate.

## Acceptance matrix

| Test ID | Verdict | Evidence / actual result |
| --- | --- | --- |
| T-P25-S01 | PASS | All five labelled category panels, default CSV, pointer/keyboard navigation, hidden-panel focus exclusion and real Escape behavior; independent browser cases in three viewports plus final Settings50-unit run. |
| T-P25-S02 | PASS | One draft across categories, Cancel restores saved state, Apply commits the exact changed values once; browser and exact-candidate native Settings checks before the Explorer observer failure. |
| T-P25-S03 | PASS | Hidden invalid Copy value blocks Apply with its original validation; inclusive settings boundary and save/busy behavior assertions retained in existing unit/E2E coverage. |
| T-P25-S04 | PASS | Computed18/14/13/12px and inherited sans assertions, all eight readable previews, SQL heading text bounds; directly reviewed wide/compact/minimum screenshots. |
| T-P25-S05 | PASS | Reset remains in Display, changes only its draft formats, preserves CSV draft, and retains inline details/focus behavior; exact default-format assertions. |
| T-P25-S06 | PASS | Two distinguishable current paths and corresponding availability/actions; bounded long-path/error geometry, no opens on rendering/navigation, exact-candidate Storage screenshot. |
| T-P25-S07 | PASS | Nine folder Rust tests and independent resolver review: saved default/custom CSV root, stable query-temp root, QueryService independence and no-create behavior. |
| T-P25-S08 | PASS | Shared19-case kind corpus, strict transport, literal Windows paths and reviewed ShellExecuteW call; no arbitrary frontend path, shell command string, added capability or dependency. |
| T-P25-S09 | PASS | Unavailable and launch-error cases, refreshed locations, availability recheck and guarded asynchronous focus restoration; final folder browser3/3 and Settings50/50 units. |
| T-P25-S10 | PASS | Existing migration/picker-cancel/error/offline/dirty-state behavior assertions retained with explicit category entry; full browser plus unchanged failing calculation-cancel case retry covers the suite. |
| T-P25-S11 | PASS |1440×900,1024×768,800×600 interactions, content-viewport/dialog/navigation/footer/preview geometry and screenshots; independent image observations recorded below. |
| T-P25-S12 | PASS | `native/manual-results.json`: physical clicks from exact-candidate Viewer HWND1969140, query-temp HWND787624 and CSV-cache HWND1968666 address-bar reads exactly match the two distinct backend roots. Automatic reuse-guard failure remains recorded, not relabelled PASS. |

Final gates: frontend static PASS (`08-19-18-804`); Rust491 PASS/19 existing ignored and Clippy PASS; full frontend979 PASS/one old category-entry failure, corrected entry focused retry PASS (`08-17-04-706`); full browser358 PASS/4 existing skips/one calculation-cancel timing failure, unchanged case retry PASS in all three viewports (`09-09-58-089`). This is full-suite coverage with targeted retries, not a claim that the initial full runs were clean.

## Contract / ownership

Approved `00-scope.md` and T-P25-S01..S12 in `10-test-plan.md`. Quality owns the new Settings browser/native tests, enum corpus and category-entry updates in existing E2E. Product code, shared App/backend tests and fixed execution/build plumbing remain with their owners.

## Test convergence

- `2026-11-16T08-09-35-721Z-phase25-e2e.log`: three passed, six failed. All three global draft/Apply/Cancel/hidden-invalid cases passed.
- The six failures shared a test geometry mistake: capture required the entire long Display/Storage tabpanel to fit the viewport, although the approved content container intentionally scrolls. The screenshot showed bounded dialog/navigation/footer and a normal scrolling content surface. Root approved correcting the bounded target to `.settings-dialog__content`; active-panel horizontal-overflow, footer hit checks and page/dialog bounds remain strict. No product fix was inferred from those failures.
- New fixtures use two distinct roots with spaces/Unicode, explicit kind-only call probes, unavailable state and launch failure. Existing Settings regressions explicitly enter the intended category; original settings values, limits, migration/cancellation protections and geometry thresholds are retained. Intended typography expectations alone change to18/14/13/12px.
- Settings category mapping is confirmed: SQL suggestions in SQL; Overall/SQL-per-query/CSV-cache caps stay together in Storage. Display retains inline details rather than introducing a Back/subpage flow.
- Corrected Display cases pass in all three viewports. Folder cases then exposed a real asynchronous-action focus defect: disabling the initiating Open button could move focus out of the modal, so Escape did not reach its handler. Product owner added guarded focus fallback/restoration without stealing focus from another input/category; related50 unit cases pass. The test now waits for focus inside the dialog, sends the real keyboard Escape and explicitly waits for dialog closure. The three folder cases pass in `2026-11-16T08-18-46-*`; no sleeps or forced target were used.
- Root reports final frontend static checks PASS (`08-19-18`), full Rust491 passed/19 existing ignored with the new9 included, and Clippy PASS. The full frontend run979 passed/one Copy-category test-entry failure; Root corrected only that entry and its focused App test passed (`08-17-04`). Final full browser and candidate-build results are recorded above; the remaining native target gate is recorded below.

## Independent code / current image review

- Reviewed typed transport: strict two-root response parsing and exact kind union, native request contains only `{kind}`. No frontend-selected path is forwarded.
- Reviewed both Rust commands and platform resolver/opener: each resolves saved current settings plus app-local-data under migration admission, independent of QueryService. Existing absolute/NUL/length/reparse/directory/CSV-ownership checks run through a read-only branch; no Get/Open directory creation. Windows ShellExecuteW receives a literal filesystem path and `open`, with no command or parameter string; system errors propagate.
- Reviewed no-create, default/custom-vs-temp, missing/file/foreign-owner, availability-race, launch-error and shared-kind tests. Windows custom-root/junction live behavior is not inferred from those units.
- Directly opened current wide CSV/Display-summary/Storage, compact Timestamp-inline-details, and minimum Display-summary/SQL-heading/Storage-error screenshots. Nav/footer remain separated from the content scroll surface, SQL heading glyphs are not clipped, nanosecond Timestamp preview is complete and the minimum path/error/Open/Clear controls do not overlap. Content cut at a scroll boundary is intentional; no new page overflow or visual blocker was found. All eight previews are individually scrolled/measured in the browser case.

## Native evidence boundary

The native helper verifies actual Explorer destinations via Shell.Application, filters emitted paths to the two backend-provided roots, and closes only new task-owned HWNDs still at those roots. It preserves pre-existing windows and restores saved settings on success/failure. Get/Open do not create a missing root; normal product usage initializes storage separately for the available-folder scenario. A successful mock or process spawn alone will not be accepted as Explorer evidence.

Custom-root resolution and reparse/ownership validation have platform unit/retained migration coverage; no ad-hoc grant, settings-file tampering, extra capability, or fake custom-root native PASS is introduced. Actual Windows custom-location/junction evidence will be stated separately if not exercised.

The refined native helper permits already-open matching folders but never counts them as this action's proof. Each Open must produce a new HWND absent from all Explorer handles immediately before that action, with an exact expected-root match. Only that newly observed matching HWND is owned for cleanup. Personal/pre-existing windows, including matching folders left by earlier failed observations, are not closed to make the scenario pass.

First native `2026-11-16T08-40-45-*` reached the first Open action after Cancel/Apply/Display checks, but timed out observing the actual Explorer destination. Candidate metadata:62,542,848 bytes, SHA-256 `041AD9484900D7D274A0F6D40E508EA5723F4A498F247458BC6D595C5FF575D5`. This is not an Open-folder PASS. Original results and all three images are preserved under `native/first-*`. Failure observations now retain expected roots, UI errors and COM stage/type/HRESULT/count diagnostics only; unrelated Explorer paths/titles are not emitted. Product-launch failure and observer failure remain to be distinguished before the mandatory actual-target verdict.

Second failure diagnostics (`native/second-*`) show seven Shell/Explorer/readable folders, seven normalization-stage MethodInvocationExceptions (HRESULT-2146233087) and no UI errors. Root's direct PowerShell5/7 TrimEnd samples pass, so TrimEnd alone is not established as the cause. Harness normalization now uses an explicit char array, direct JSON-array assignment/scalar-string checks, and an early readonly self-check on two public synthetic Windows paths plus the two expected roots. No product code, grant or capability changed; actual-target verification on the same binary remains required.

Third attempt: normalization self-check and COM observation are now normal. Failure observations contain the exact expected CSV directory at HWND1968666 with no observer/UI errors. The automated scenario still fails because that matching HWND existed before its click, so its deliberately strict new-window causality criterion is not met. Reusing an existing Explorer window is legitimate product behavior, not a folder-launch defect. The automatic failure is retained separately from the passing manual native evidence below.

## Final manual native evidence and decision

Independently read `native/manual-results.json`, supplied after Root's Computer Use interaction. Its binary hash is the same `041AD9484900D7D274A0F6D40E508EA5723F4A498F247458BC6D595C5FF575D5` candidate as the completed native Settings checks. Root activated Viewer HWND1969140, inspected the actual controls and physically clicked Query temporary data / Open folder at11:15:56.411Z and Reusable CSV cache / Open folder at11:17:20.631Z. Explorer address-bar selected text was then read using Ctrl+L, without entering/navigating a path:

- Query temporary data: HWND787624, `C:\Users\denrew\AppData\Local\com.denrew88.data-viewer-phase25-acceptance\query-temp`.
- Reusable CSV cache: HWND1968666, `C:\Users\denrew\AppData\Local\com.denrew88.data-viewer-phase25-acceptance\csv-cache-v1`.

Each observed path exactly equals its corresponding backend expected path; query-temp is distinct from CSV cache. Settings were not modified and no path navigation was performed. Root reports that the SDK permission prompt obscured foreground during the query action, so that Explorer window was explicitly activated solely to read its address; the CSV action's resulting Explorer/address focus was directly observed. This supports actual destinations after the real product actions, not a claim that both created new windows or that query focus was continuously observable. Root reviewed the original Computer Use output; quality reviewed the persisted result and did not independently execute GUI actions or claim to view nonexistent manual screenshot files.

There is no remaining blocking defect for the approved Settings scope. Actual custom-root Explorer opening and Windows junction creation were not run; their unit/browser/code coverage and this limitation remain explicit. Installer/Linux builds and the unrelated whole-Phase file-drop gate are outside this follow-up. No further test, cleanup or product change is required for this verdict.
