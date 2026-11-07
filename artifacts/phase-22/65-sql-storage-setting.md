# Phase22 SQL working-space setting — PASS

2026-11-06. User requested configurable SQL per-job temporary storage. Same Phase/version0.22.0.

Settings → Storage → **SQL temporary storage per query (GiB)**. Default0.5GiB; valid0.0625..10GiB, decimal
inputs supported. Combined spill+saved-result bytes; actual allowance also obeys overall Storage remaining
space and5GiB physical reserve. SQL's256MiB DuckDB buffer,300s deadline and1M-row ceiling remain unchanged.
Reset changes only draft; Apply saves; Cancel leaves stored settings unchanged. New queries snapshot the saved
cap; running queries and existing results retain their allowance. No hidden512MiB worker ceiling remains.

Settings schema6 requires `sqlTempLimitBytes`. All valid V1..5 migrations preserve existing values and insert
512MiB default. Current-schema invalid/missing fields reject with existing backup/recovery behavior. No new
dependencies/capabilities. Original source/user data and production cache not used for native test input.

## Verification

| Gate | Evidence / outcome |
| --- | --- |
| Shared wire/input parity | `fixtures/phase-22/sql-storage-boundaries.json`;19byte and11GiB cases plus legacy/effective cases, consumed by Rust/TS |
| Rust full unit suite |390PASS,18existing ignored,0FAIL; `2026-11-06T11-26-08-643Z-phase22-test.log` |
| Rust format / normal all-target Clippy | PASS;11-26-06 format /11-31-06 clippy |
| Frontend full unit suite |633/633PASS;11-29-33-285frontend-test |
| Final format/lint/three TS configs | PASS;11-31-36-954logs. Initial test-only unused destructures were fixed, no suppression |
| Full browser E2E |159/159PASS,2.9min;11-31-16-469phase22-e2e;222historical images/data restored and verified |
| Three viewport settings geometry/images | New SQL control readable/unobscured; Quality inspected3PNGs/JSON |
| Actual optimized Tauri native settings |9/9PASS;11-39-14-888phase22-stress; `native/stress-settings.json` |
| Actual help/reset appearance | `native/native-sql-storage-settings.png`, independently inspected |

Native candidate build log11-31-45-341phase22-native-build, SHA256
`13aeec5dd7eb1b915c69b70373821104b6f961807299925daf4afc0c4a6db616`.
Same source/release profile as product, isolated acceptance identifier. Actual Rust IPC through WebView,
not browser mock. Input5.85M-row Parquet unchanged before/after SHA
`505692c3e37c7b2a9ad5882a1bda21297175d4bee96e9b8b065dd2828ea34e97`.

Native UI preview→Apply→wire→new source/session page→exact COUNT/SUM succeeded for0.0625/0.3/0.5/1/10GiB.
Old successful result remained readable. COUNT5,850,000 and SUM(id)17,111,247,075,000 were checked each time.
For the same SQL:

```sql
SELECT SUM(rn) AS total
FROM (SELECT ROW_NUMBER() OVER (ORDER BY payload) AS rn FROM stress) ranked
```

EXPLAIN confirmed a blocking WINDOW with ORDER BY payload.64MiB failed with QueryTempLimitExceeded;
1GiB actual worker manifest allowance1,073,741,824 succeeded with exact SUM17,111,252,925,000.
Observed high-run spill743,047,168bytes, exceeding the old512MiB ceiling, proves this is operational.
Running CROSS JOIN retained64MiB allowance after UI saved1GiB; it was then cancelled and normal query
recovery succeeded. Overall64MiB still constrained configured SQL1GiB to67,107,298bytes (previous snapshot
accounted). Restart into a new owned PID retained settings, new source page and SQL results were correct.
Original isolated settings restored; owned windows stopped; input hash preserved.

First native attempt11-38-02 failed only in harness source-page assertions (`read_page` returns `{page:...}`,
unlike SQL page's direct DTO). Corrected unwrap only; final9case rerun all PASS, no product rebuild for this
harness correction. No tests ignored/thresholds lowered. Existing earlier CSV-corruption intermittent failure
did not recur in this final full Rust run; no permanent fix to that separate issue is claimed.

Independent acceptance: `quality/sql-storage-setting-review.md`, IDsT-P22-SQLSTORE-001..008 PASS.
This feature pass is not full Phase22 promotion: broader remaining parent-death/clipboard/security/CSV-cache
coexistence gates retain prior status. Product Release build/replacement evidence is recorded in50-integration.

Product build11-39-14-888phase22-build PASS (4m18s); replaced
`src-tauri/target/release/data-viewer.exe`, version0.22.0,60,335,616bytes. SHA256
`9152eab6b9ef6f4cb8a8ec6a448cb8f63791fcc3a99309a3227da3f033aeab6e` equals the product candidate.
No source changed after tested native build. Different app identifier explains product/native hash difference.
