# SQL per-query storage setting — independent review

Mode: independent verification, Phase22 follow-up, 2026-11-06.

**SQL storage setting behavior: PASS.** All eight acceptance IDs below have automated and applicable actual Tauri evidence. This approves the reviewed follow-up behavior, not formal artifact promotion or whole-Phase completion. Product-namespace release build is a separate root gate still running at this review checkpoint.

## Current acceptance status

| ID | Status | Evidence / outstanding |
| --- | --- | --- |
| T-P22-SQLSTORE-001 | PASS automated boundaries | Rust and TS directly consume `sql-storage-boundaries.json`;19 byte cases include missing/current/null/fraction/type/range rejection. Existing Math.round GiB behavior preserved;0.3GiB is322,122,547 bytes. Related tests and browser wire assertions passed. |
| T-P22-SQLSTORE-002 | PASS automated migration/store | Source has strict schema6 required field and explicit V1–5 defaults, preserving old settings. V5 transformation refuses an unexpected SQL field; current missing/invalid follows invalid-settings backup/recovery. Tests cover migrated/interrupted V5, missing-current backup, valid round trips. Native process restart still pending under004. |
| T-P22-SQLSTORE-003 | PASS browser behavior |6 dedicated browser cases across3 viewports pass: invalid disables Apply, cancel/default/reopen, Reset changes draft only, valid representative bytes reach mock settings, unrelated settings preserved, configured1GiB allowed above overall0.3GiB. No disk-enforcement claim from mock. |
| T-P22-SQLSTORE-004 | PASS native | Actual UI values64MiB/0.3GiB/512MiB/1GiB/10GiB save exact bytes. Each creates a new source session, reads id0 page and executes exact COUNT/SUM. Actual process restart reloads saved1GiB; new page and query remain correct. |
| T-P22-SQLSTORE-005 | PASS native + automated | A running real worker manifest retains64MiB after UI saves1GiB. Query remains running, then cancels correctly; old42 and subsequent normal COUNT/SUM remain readable/correct. Task snapshot matches source review and module tests. |
| T-P22-SQLSTORE-006 | PASS native + automated | New configured1GiB with overall64MiB receives effective67,107,298 bytes and typed temp-limit failure, followed by cleanup/recovery. Physical-headroom cases are covered by allocator tests; this run had ample actual free disk. |
| T-P22-SQLSTORE-007 | PASS native | Byte-identical SQL and real WINDOW/ORDER BY plan.64MiB fails with observed spill and QueryTempLimitExceeded;1GiB effective allowance succeeds with743,047,168 observed spill bytes and exact17,111,252,925,000 result. Confirms old512MiB byte clamp is gone. |
| T-P22-SQLSTORE-008 | PASS browser/static; image coverage noted below | Full159 E2E assertions pass including6 new cases; historical222 evidence restored. Frontend633 tests, format/lint/3 TypeScript configs, Rust390 passed/18 ignored, all-target clippy pass in root logs. Final optimized native/product build and settings acceptance separate. |

## Source review

- Schema6 `sqlTempLimitBytes` is a required u64 and validates64MiB–10GiB. Versions1–5 explicitly add512MiB; a malformed schema6 object cannot silently migrate as an older version.
- `start_sql_query` reads saved cap once; `SqlTask` retains it. Reclaim and bounded allocation use the task snapshot. Worker receives effective lease allowance. Raising settings does not rewrite an existing job manifest or old result lease. The old fixed512MiB combined byte ceiling is removed; row/column/memory constraints remain separate.
- UI explains combined spill+saved-result use, effective minimum and new-query semantics; input has `aria-describedby` and error `aria-invalid`/alert. Reset edits draft and Apply persists. No new permission, native dependency or OS memory limit.
- Read-only native harness review found no additional material defect. Final report independently verifies the five UI values, page/new-session identity, byte-exact low/high SQL, WINDOW plan, high allowance above512MiB, retained42/recovery, immutable active job, global constraint and process restart.

## Independent visual review

Opened `../ui/sql-storage-setting-desktop-wide.png`, `-compact.png`, `-minimum.png` as image inputs and read corresponding JSON geometry.

At1440×900/1024×768/800×600 the new label/input and fixed Apply/Cancel footer remain distinct and readable. No input overlap was observed. Each geometry reports `unobscured: true` and control fully within the viewport. The Settings body deliberately scrolls; screenshots are dialog crops, not full application captures.

The browser captures end at the new input above the footer. Independently opened the additional real Tauri `../native/native-sql-storage-settings.png`: the new control, complete helper explanation and Reset button are visible and readable after scrolling, with storage groups and footer distinct. This closes the helper/Reset visual gap. Invalid-value behavior is verified by component/E2E tests; this native image is the valid64MiB state, not an invalid-state screenshot.

## Evidence checkpoint

- Full frontend tests: root log prefix11-29-33,633 passed.
- Frontend format/lint/three type configurations:11-31-36 PASS.
- Rust normal suite:11-26-08,390 passed,18 ignored,0 failed. Ignored historical gates retain their scope labels.
- Normal all-target clippy:11-31-06 PASS.
- Full browser:11-31-16,159 passed in2.9 minutes; historical222 files restored successfully.
- Optimized acceptance build completed; final native settings run `2026-11-06T11-39-14-888Z-phase22-stress.log` passes9/9. Structured evidence `../native/stress-settings.json`,11:39:15.276–11:39:32.532 UTC. Product-namespace build11-39-14 is running separately. These results supersede earlier failures only for the actually rerun gates; other Phase-wide requirements remain separate.

## Final native evidence and limits

Independently hashed the actual tested candidate: SHA256 `13aeec5dd7eb1b915c69b70373821104b6f961807299925daf4afc0c4a6db616`, matching the report. It is optimized Tauri0.22.0 using actual Rust IPC and same-EXE workers, isolated by acceptance identifier `com.denrew88.data-viewer-phase22-acceptance`; source matches the product build except identifier configuration.

Input5,850,000 rows/413,437,327 bytes has unchanged before/after SHA256 `505692c3e37c7b2a9ad5882a1bda21297175d4bee96e9b8b065dd2828ea34e97`. Report settingsRestored=true and ownerStopped=true. Every representative settings value yields COUNT5,850,000 and SUM(id)17,111,247,075,000 after source-session replacement. Restart checks saved settings equality and uses a different actual process PID.

Paired query:

```sql
SELECT SUM(rn) AS total
FROM (SELECT ROW_NUMBER() OVER (ORDER BY payload) AS rn FROM stress) ranked
```

Report low.sql, high job.sql and shared SQL are byte-identical. The actual plan includes `WINDOW` with `ROW_NUMBER() OVER (ORDER BY payload ASC NULLS LAST)`, so the ordering work was not discarded. Low-cap failure has observed9,863,168 spill bytes; cleanup returns query temp1522→1522 and old42/normal query recover. Higher effective allowance is1,073,741,824 bytes; query completes in4235ms with one exact result17,111,252,925,000. Its sampled743,047,168 spill bytes exceed the former512MiB ceiling, confirming an actual behavioral change rather than a control-only implementation.

The first native attempt11-38-02 failed six checks because the test harness read `read_page` response as `p.rows` rather than `p.page.rows`. Root corrected only that DTO unwrap and reran all nine checks successfully; earlier logs remain retained. No product failure is inferred from that harness mistake.

No additional material issue found in final evidence. This does not introduce an RSS quota, test physical disk exhaustion or active large CSV-cache pressure, or validate every unrelated Phase22 feature. Native sampling is observational, not an instantaneous filesystem quota. Existing18 ignored Rust cases retain their historical labels; no new setting cases were ignored. Product release build, deployment/formal promotion and whole-Phase status remain root/user decisions.
