# SQL editor layout and newline behavior

2026-11-07. User requested three scoped Phase22 UI fixes.

- Tables/Columns height allocation now has a7px horizontal separator. Drag vertically, keyboard
  Up/Down10px or Home/End, double-click to restore32%. Escape/pointer cancellation restores the prior
  preference. Heights clamp within the current pane;160px Tables and180px Columns are protected where
  possible, otherwise proportionally reduced. Resize and SQL reactivation remeasure available height.
  Preference is held for the current window; no backend settings DTO or disk preference was added.
- Editor intrinsic grid sizing/min-height previously let long lines or the scroller extend beyond the
  clipped wrapper. Bounded flex sizing/min-width0/min-height0 keep the actual horizontal scroll surface
  inside the editor. Long lines remain unwrapped. Compact help-closed now overrides the responsive
  two-column grid so the editor gains the freed width.
- Enter and Shift+Enter use CodeMirror insertNewlineKeepIndent: preserve existing leading whitespace,
  without SQL continuation indentation. Existing text/spaces after the cursor remain authored content.
  Initial automatic popup Enter is newline; deliberate/explicit Enter and Tab still accept candidates,
  Ctrl+Enter still runs once, and composing input remains guarded.

Owners: Root SqlEditor/tests/native harness/docs/build; UI Workspace/CSS/split helper/tests; Quality
dedicated E2E, geometry/screenshots and independent review. Plan: [LAYOUT001..007](quality/editor-layout-plan.md).

## Validation

SQL workspace272PASS (`2026-11-07T02-08-17-134Z-frontend-test.log`), including editor31, Workspace19
and splitter helper9 cases. Initial unit expectation was corrected to preserve an existing space after
the cursor rather than treating it as newly inserted indentation; production behavior was unchanged.
After the compact-help override, final frontend format/lint/types PASS (`02-09-32`), full frontend
823/823PASS49.61s and focused browser9/9PASS36.2s. Source review PASS. Browser geometry covers help
open/closed width gain, long-line end DOMRange within the visible scroller, scroller bottom within its
clipping host, source split capture/cancel and manual-only newlines. Full213/213browserPASS9.1m
(`02-10-46`), historical222evidence files preserved. Six open/closed three-viewport images were
independently opened/reviewed. Native candidate build PASS8m29s (`02-10-36`).

Initial native check (`02-19-31`) timed out because the harness required exact scrollLeft0 at Home,
despite visible SELECT text and horizontal bar. The initial report/image are retained as
`native/stress-layout-initial.json` and `native/native-sql-layout-initial.png`. Harness-only correction
asserts the start text DOMRange is visible (end-marker bounds unchanged), without relaxing behavior or
changing product code. Final native PASS12.707s (`02-20-43`): source split201→261→201 and Home/End bounds,
help-open672px/help-closed912px scroller width versus4179px content, caret-End marker visible within both
surfaces and scroller bottom inside the host. Actual Windows scrollbar and end token are visibly captured
in `native/native-sql-layout-horizontal.png`. Empty/2space/tab manual indentation and Shift+Enter pass.
Four JOIN mode pairs still COUNT3, typing SQL0 and4explicit starts; source hashes/settings/owned process
cleanup and actual restart pass.

## Product EXE and scoped verdict

Scoped source/browser/native PASS: [independent review](quality/editor-layout-review.md).
Product Release build PASS4m10s (`artifacts/dev-check/2026-11-07T02-21-20-436Z-phase22-build.log`).
No canonical Viewer was running at replacement. `src-tauri/target/release/data-viewer.exe` replaced and
embedded version0.22.0/canonical-candidate SHA match verified.60,490,752bytes, +512bytes (+0.5KiB).
SHA256: `f51603f9ab279e3a22db3663375b803a4ac5704ec6c77b12df8a7b8459138a0c`.
Baseline and separate native/product provenance: `editor-layout-exe.json`.
No installer/publication or Phase-wide promotion; broader Phase status remains in progress.

Native harness uses separate `native/stress-layout.json`/`native-sql-layout-*` captures: real pointer and
keyboard split, long-line tail DOMRange visibility with help open/closed, manual spaces/tab/newlines,
plus existing four-mode JOIN, no-query-on-type and actual restart regression. No backend/dependency/
capability change, formal Phase promotion or external publication.
