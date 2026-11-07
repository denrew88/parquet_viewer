# Phase22 actual EXE SQL stress verification

2026-11-06. Requested stress scope: **PASS,10/10 scenarios**. This is not full Phase acceptance.

## Execution and isolation

Actual optimized Tauri0.22.0 + same-EXE SQL worker, driven through the real WebView's native IPC; no mock
backend. Acceptance identifier `com.denrew88.data-viewer-phase22-acceptance` isolates settings/cache from the
product. Same source/release profile as the product; the identifier differs, so EXE hashes are not identical.
Final native build log `artifacts/dev-check/2026-11-06T10-45-35-229Z-phase22-native-build.log`.
Stress log `2026-11-06T10-49-50-665Z-phase22-stress.log`; machine-readable evidence `native/stress.json`.
Native SHA256 `0d8122c8f82e694dc10cf41c0b55f572fe1c5683e8f3ab244064392abdfb24e8`.

Input:5,850,000rows,413,437,327bytes Parquet, columns `id`, `bucket`,64-character SHA256 `payload`.
Generated in bounded65,536-row batches under `.tmp/phase22-stress/`; generator is
`scripts/phase22_stress_fixture.py`. Input SHA256 before/after:
`505692c3e37c7b2a9ad5882a1bda21297175d4bee96e9b8b065dd2828ea34e97` (unchanged).
Independent expected count5,850,000 and SUM(id)17,111,247,075,000; grouped bucket0/500/999 sums checked
using integer arithmetic. No original user data or production cache was modified.

## Results

| Scenario | Actual outcome |
| --- | --- |
| Exact large-input COUNT/SUM | Correct values |
| Nonseparable SUM(SQRT(a.id+b.id+1)) CROSS JOIN,34.2225trillion combinations | Actual child CPU observed while running; cancel→terminal91ms, child exit+cleanup181ms |
| Unbounded CROSS JOIN returning rows | Explicit1,000,000-row result-cap error; partial output reclaimed |
| Full5.85M sort, noLIMIT,1GiB overall | Sort performed with observed spill457,146,368bytes; then explicit1M result-cap error |
| Unique-payload GROUP BY,1GiB overall | Per-job512MiB temp cap reached; QueryTempLimitExceeded; sampled spill536,805,376bytes |
| Large LIST aggregate with regexp computation | Actual allocation OOM:249.3/256MiB used, failed16MiB allocation; QueryFailed, not a disk-cap misclassification |
| Blocking sort,0.5GiB overall, running cancel | CPU+spill observed; terminal341ms, child exit+cleanup427ms; sampled spill300,056,576bytes |
| Unique-payload GROUP BY,0.5GiB overall | Remaining shared allowance respected; QueryTempLimitExceeded; sampled spill536,838,144bytes |
| Regexp full sort,64MiB overall | Actual running spill observed56,131,584bytes, then QueryTempLimitExceeded with actionable normalized message/noPRAGMA |
| Low-cardinality aggregate,1,000buckets | Correct row count and first/middle/last bucket values |

Every failed/cancelled stress case retained a readable previous `SELECT42` snapshot, reclaimed its temp files
(before/after1,522bytes for the retained snapshot+manager state), and immediately succeeded with exact
COUNT/SUM. Fresh worker-free samples were required after each operation. Final settings restored, owned parent
stopped, original input hash unchanged. SQL binding/parse/crash errors cannot satisfy resource-test assertions.

## Memory and disk interpretation

DuckDB buffer setting256MiB/2threads worked: the allocation-stressing aggregate failed with a genuine buffer
allocation error. **There is no256MiB OS process/RSS hard cap.** Maximum sampled SQL worker working set was
303,194,112bytes (~289.1MiB), private memory295,624,704bytes (~281.9MiB). Parent working set peaked35,622,912;
maximum parent+SQL-worker combined338,714,624bytes. WebView/helper processes are excluded from those totals.
Harness2GiB private-memory safety cutoff was never triggered and is not a product memory limit.

Per-job cap≤512MiB, constrained by overall1GiB/0.5GiB/64MiB and retained snapshot bytes. Fresh-handle samples
showed **zero observed job-allowance overshoot**. Physical5GiB safety reserve remained intact. This is sampled
watchdog enforcement, not an instantaneous filesystem quota or a physically-full-drive test. Target sampling20ms;
actual gaps reached604ms in the file-heavy case. Recorded peaks are sampled observations, not exact maxima.
The monitor repeatedly opens/queries file metadata and adds I/O overhead; timings are not an uninstrumented
performance benchmark. Input is Parquet; active CSV-cache pressure, worker parent death and all Phase22 UI/security
acceptance are separate gates.

## Defects found and resolved

1. Baseline SELECT42 crashed the worker (WindowsAPPCRASH C0000005). Arrow C API required pointer-to-pointer;
   missing indirection fixed. Parent now reports abnormal worker exit codes instead of only missing output.json.
2. Windows directory enumeration undercounted open spill files by35,848,192bytes in a targeted run. SQL and
   shared storage accounting now query fresh metadata handles. Initial data-read handles conflicted with locked
   DuckDB DB files; corrected to FILE_READ_ATTRIBUTES0x80/share0x7. Growth8→9MiB and exclusive-writer regressions
   preserve source-alias identity exemptions and vanished-file handling.
3. Raw C API disk errors bypassed common normalization and exposed QueryFailed/PRAGMA guidance. Shared mapping
   now distinguishes temp limits, actual allocation OOM and interruption; native assertions verify typed errors.

## Regression status

Format and normal all-target Clippy PASS (`10-38-42-655Z-phase22-format`, `10-45-12-316Z-phase22-clippy`).
Full final Rust run `10-42-41-411Z-phase22-test`:383PASS,1FAIL,18existing ignored. The sole failing existing
CSV-corruption-recovery test passed unchanged in isolated rerun `10-44-53-927Z-phase22-csv-corrupt` (0.58s).
This is a retained intermittent regression risk, **not a fully green full-suite result**; no threshold was lowered
or test disabled. Earlier failed full runs exposed the temporary data-read lock regression and were superseded
by the metadata-only fix; exact logs are retained. No frontend/UI code changed during this stress task.

Product Release build/replacement evidence is appended to `50-integration.md` after completion. No installer,
external release, git commit or full Phase22 promotion is part of this verification.

Report-shape note: the final successful aggregate's original `checks[].status` contains its native query DTO
because its details overrode the wrapper verdict field. All assertions and the console PASS are independently
verified; original evidence is retained. The harness now names that detail `queryStatus` for future runs.
