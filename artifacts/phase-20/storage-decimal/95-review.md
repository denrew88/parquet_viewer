# Decimal Storage setting — independent review

2026-11-04. Reviewer: `storage_pressure_quality`. Scope: UI accepts decimal GiB values, applies integer-byte limits and reopens without drift. Product changes and native/E2E executions are root-owned; this reviewer read the source, raw evidence and screenshots independently.

**Final verdict: PASS for this decimal Storage setting bugfix and applicable UI regression coverage.** Input/apply/roundtrip/native behavior and three-viewport evidence pass. The initial Phase 16 test race was diagnosed and fixed with a real prior-operation completion barrier while preserving the blocked-interaction assertion; the six affected viewport cases then passed. This is not a claim of a single clean 123-test execution, all historical Phase gates or release-publication approval.

## Code review

- `step="any"` permits 0.3 instead of requiring a multiple of 0.0625 GiB.
- Validation checks the unrounded byte value against the existing 64MiB..10GiB range, so values just outside the range cannot round into validity.
- Storage bytes are rounded to the nearest integer and checked as a safe integer before applying. NaN/Infinity/empty input do not become valid settings.
- `editableGiB` selects a short decimal representation whose conversion and rounding recover the same integer bytes. For the bounded range, ten decimal places of GiB are finer than one byte, so reopening and applying preserve the stored byte limit.
- Added component cases cover 0.1/0.3/1.1, min/max, reopened equality and raw-range rejection. No blocking code finding was identified.

## Independent visual review

Opened as image inputs:

- `ui/storage-1440.png` — PASS. Storage heading, label, 0.3 input, GiB suffix, helper text and footer Apply/Cancel are legible and do not overlap.
- `ui/storage-1024.png` — PASS. Same key state and controls remain visible; vertical dialog-body scrolling is intentional.
- `ui/storage-800.png` — PASS. Minimum viewport shows 0.3 input and footer controls without horizontal clipping; lower storage content is available via body scroll.
- `ui/native-0.3.png` — PASS. Actual Tauri dialog shows 0.3, enabled Apply and current cache usage. Existing cache may exceed a newly lowered limit until normal reclamation; the screenshot is not evidence of automatic immediate eviction.

These are dialog-cropped screenshots captured at the specified browser viewports, not full-window captures. No layout/CSS change was made. Visual review is independent; it is not a second independently operated browser session.

## Execution evidence

- The three viewport `validates application settings and storage controls` cases passed. Source assertions verify HTML number validity, Apply, dialog reopen value 0.3 and input bounds within the viewport.
- Full E2E first execution: **122 passed / 1 failed**. Failure was `desktop-minimum`, `phase16.spec.ts:507`, Retry Preparing Filter click counter: expected 6, observed 7. Original output is retained in `e2e-full-first.log` / `e2e.log`.
- Initial focused retry: **5 passed / 1 failed**, preserved as `e2e-retry-before-diagnostic.log`. The diagnostic retry preserved as `e2e-diagnostic.log` isolated the extra readQueryPage from the already-started fallback query. This diagnosis, rather than the unrelated test name alone, justified the completion barrier described below.
- **Final focused retry: 6 passed / 0 failed**, `e2e-retry.log`, independently read after completion. Settings and Phase 16 scenarios pass at all three viewports. Combined with the first full run, every one of the 123 scenarios has a successful execution; this is first full run plus targeted regression after a test-only synchronization change, not 123/123 from one clean run.
- Independently read `ui/geometry-1440.json`, `ui/geometry-1024.json`, `ui/geometry-800.json`. The input is 128×32 CSS px at all three viewports; dialog/input/Apply are within the corresponding viewport, and input/Apply are within the dialog without overlap. Minimum dialog is x40/y20/720×560 with input x569.39/y289.72 and Apply x661/y536.5. These raw geometry records close the earlier missing-evidence item.
- `native-result.json`: actual UI 0.3 entry and apply; backend settings and usage both **322,122,547 bytes**; reopened UI value 0.3 asserted by harness; new CSV Ready with rows 1/2/3. Original settings restoration had no reported error.
- Independently parsed native settings/usage/preparation/page fields and hashed the current executable. SHA-256 matches the executed file: **`d34e48c7a0f04c69166fc7cb2b10e58b926792e0824059ae65319a65f7e62a03`**.
- Root reports component 22 / full frontend 414 PASS, lint/typecheck/Vite PASS, recorded in root tool session 11500. Raw logs for those runs were not saved and were not independently read by this reviewer. They are root execution evidence, not independent rerun evidence.

## Resolved shared-test synchronization

The Phase 16 minimum-viewport Retry Preparing filter-click counter failure reproduced before diagnostic synchronization and is retained as failed evidence. After the completion barrier below, the unchanged all-data-counter assertion passes across all three viewports. No product gate behavior or assertion tolerance was changed to obtain approval.

### Diagnostic follow-up and test synchronization

The unchanged equality assertion now reports both counter snapshots. The diagnostic rerun isolated `readQueryPage: 0 → 1`; executeQuery, distinct, copy and other counters did not change across the inert Filter click. The test had waited for the earlier direct-fallback query to start, but not for its first page to finish.

`artifacts/phase-16/00-scope.md` defines the boundary as preventing **new user Data interactions** and explicitly excludes globally stopping every background task. `docs/PROJECT_SPEC.md` likewise prevents starting new page/query/distinct/copy/navigation interactions, while the separate session/generation contract rejects stale responses. T-P16-011 validates that direct fallback works after failure; T-P16-012 then separately validates Retry blocking. These do not require the test to start Retry while its earlier fallback query is still fetching its first page.

Quality therefore added a deterministic completion barrier before Retry: assert the previous query's first page was requested, the grid has its query identity, Page navigation is no longer busy, and the expected queried cell is visible. No sleep, product-code change, counter exclusion, tolerance or decreased assertion was introduced. The original all-data-counter equality during the inert click remains intact, with diagnostic snapshots. This also strengthens direct-fallback coverage by requiring actual queried data to render. The post-barrier six-case execution was independently checked and passes.

Root also reports eslint and E2E TypeScript checks passed after the test change. Existing Phase UI files generated during the shared suite were preserved under this task's regression records and restored to their pre-task repository state; the decimal task's three geometry/screenshot records remain in `ui/`. No additional product rebuild was needed for the test synchronization change.

No product code was changed by this reviewer. No installer/NSIS, external publishing or Phase completion claim is made.
