# Phase 22 actual EXE stress acceptance

Mode: independent test design for the user's requested inefficient CROSS JOIN, large sort/aggregation, limits, running cancellation and recovery. Draft, 2026-11-06. Root owns harness and execution; this document changes no product code or settings.

## Target and evidence

Test the real product EXE: version 0.22.0, 60,323,328 bytes, SHA256 `69521B395109BD83A5D040C6B99E47588F95981280F7E66B71FD93BEF7C9BF2C` (root supplied; harness must verify before launch). Distinguish any namespace-isolated acceptance build and record its own hash; do not substitute browser mock or an unrelated DuckDB process. Use an isolated test configuration/cache and restore original settings. Preserve source hashes and any existing clipboard. Never fill a drive deliberately or delete user cache.

Use existing `fixtures/phase-20/performance/main-high/high-5850000x15.csv`, registered as `big` in ordinal mode. Its c1=row_id, c2=group_id, c3=category, c8=label, c9=code. Record actual source profile/types, row count and prepared-cache size before SQL; invalid inference or unready CSV is a setup failure, not a stress result. Keep prior independent result `SELECT 42 AS answer` and record its run/result identity. Release every other snapshot: only two snapshots are allowed.

## Acceptance matrix

| ID | Real workload / action | Exact acceptance |
| --- | --- | --- |
| S-P22-001 | Identity, ready source, `SELECT COUNT(*) FROM big`, baseline `SELECT 42 AS answer` | Verified EXE/hash/owned parent PID; count 5,850,000; baseline remains independently readable throughout subsequent failures/cancel. |
| S-P22-002 | `SELECT SUM(SQRT((CAST(a.c1 AS DOUBLE)+1)*(CAST(b.c1 AS DOUBLE)+1))) AS work FROM big a CROSS JOIN big b` then cancel | See worker PID with parent/path/start-time identity, nonzero CPU delta while SQL state is `running`; cancel only after this evidence, not merely `queued` or parent's `executing` label. Terminal `cancelled`, no result published, child exits, SQL lease/temp partials reclaimed. Target ≤5 seconds from acknowledged cancel to terminal+child exit; report measured values and fail if exceeded. Baseline still42; immediately run and verify normal COUNT, release its result. |
| S-P22-003 | `SELECT c1,c8,c9 FROM big ORDER BY CONCAT(CAST(c1 AS VARCHAR),c8,c9) DESC` | Exercise actual blocking full sort without LIMIT, then bounded result materialization. Record observed spill (nonzero bytes required to call this a spill test), terminal state and exact typed reason. Either documented bounded success or resource/result-row failure is acceptable safety behavior; an unrelated SQL parse/bind/type error is not a resource test. On failure, no partial result publication, old result readable and subsequent COUNT correct. |
| S-P22-004 | `SELECT c1,c8,c9,COUNT(*) AS n FROM big GROUP BY c1,c8,c9 ORDER BY n DESC,c1` | High-cardinality hash aggregation and sort. Same resource, cleanup and recovery assertions as003; record OOM vs temp allowance vs 1M output-row cap separately. At least one actual memory-pressure/spill observation is required; merely rejecting metadata/SQL proves nothing about memory. |
| S-P22-005 | Repeat sort/aggregation with managed storage 0.5GiB and1GiB, after accounting active prepared cache and retained result | Record effective SQL reservation/allowance and actual per-volume free space. If ready active cache already consumes allowance, typed admission rejection is valid but **does not replace a running-spill failure**. Obtain at least one actual running resource-limit failure with spill/output bytes measured. Use bounded isolated cache/test input variation only as needed; no physical disk-full experiment. Preserve baseline/result/source and normal next query on each case. |
| S-P22-006 | Repeat running cancellation once during aggregation/sort after nonzero worker CPU or spill | Proves blocking operator interruption separately from CROSS JOIN. Same ≤5s terminal/exit target, lease cleanup and recovery checks. If operation completes before cancellation evidence, classify inconclusive and use the already defined heavier workload; never call queued cancel a running cancel. |
| S-P22-007 | Release results, close sources, stop owned Viewer process | No surviving owned SQL worker, no active SQL reservations or orphan partial directories. Files retained for cache/result ownership must be named and counted, not mistaken for leaks. Source hashes unchanged. Settings restored. |

## Metrics and interpretation

- Sample every 100–250ms while running: UTC/monotonic timestamp, run/state/phase, owned parent and child PID/start-time/path, cumulative CPU seconds, WorkingSet/RSS and PrivateBytes/commit. Report parent, worker and combined process totals separately, plus baseline, peak and sample interval. WebView/helper processes must be identified separately; do not hide them inside a claimed worker bound.
- DuckDB `memory_limit=256MiB`, threads=2 is a buffer-manager configuration, **not a 256MiB RSS/PrivateBytes hard limit**. Arrow batches, allocator, output and process overhead are outside it. Measure process memory; do not assert RSS≤256MiB or invent an existing OS job-memory cap. A process-memory safety cutoff in the harness protects the machine but is a harness-aborted/inconclusive product-limit test, not successful product OOM handling. Record cutoff before execution and stop only owned test processes if hit.
- Sample job-directory total, spill subdirectory, output chunk bytes, retained result bytes, copy staging if any, managed cache/temp totals, active reservations/effective allowance and physical free bytes on each relevant volume. Cache bytes and previous result must count against shared storage. A static 512MiB SQL result ceiling is not the overall storage setting.
- Source watchdogs sample at20ms/parent25ms: a transient file-size overshoot is possible before interruption. Report maximum measured overshoot and time-to-cleanup explicitly; do not describe sampling as an instantaneous filesystem quota. Passing disk safety requires terminal enforcement, preserved physical reserve and reclaimed failed partials, with any overshoot assessed rather than hidden.
- Do not classify the generic 1M-row output cap as DuckDB OOM, or admission rejection as running-spill control. Record full typed code plus user-facing error text. Unexpected panic/crash, hung cancel, orphan worker, corrupted source, lost old result, unexplained/unbounded growth or failed subsequent normal query is FAIL.

## Current harness pitfalls to avoid

Parent state becomes `Running/executing` **before** `spawn_worker`; state alone cannot prove SQL execution. `COUNT(*)` over tiny repeated CROSS JOINs may complete or optimize too quickly; use the nonseparable numeric expression above and verify child CPU. A huge `ORDER BY ... LIMIT 100` may become TopN and avoids the intended full-sort pressure. Failed queries must not accidentally retain successful test snapshots and exhaust the two-snapshot limit. Keep root's existing security/correctness harness results separate; this matrix supplements, not replaces, other Phase22 gates.

Execution results are pending root evidence. No runtime PASS, memory-limit guarantee or Phase completion is asserted here.

## Root harness variant reviewed

Root prepared `native_phase22_stress.mjs`, `phase22_stress_monitor.ps1` and a deterministic batched Parquet generator. Its isolated input is 5,850,000 rows, 413,437,327 bytes, columns `id` (0-based int64), `bucket=id%1000`, `payload=SHA256(decimal id)` as 64-character text. This permits stress without the large CSV's preparation/cache overhead. Register as `stress` with original names. Its independent expected count is5,850,000 and ID sum17,111,247,075,000. For bucket b∈[0,999], expected count5850 and sum `5850*b + 1000*5850*5849/2`. Record SHA256 of the generated input before/after. This variant exercises shared SQL temp/result reservation but does not establish active large CSV-cache interaction; retain that distinction.

The 1GiB/0.5GiB scenarios are supplemented by a deliberately small64MiB managed-storage spill rejection. A2GiB worker PrivateBytes harness cutoff protects the test machine; it is not a product memory limit. Before execution, root was sent the following required evidence corrections:

1. Assert exact typed terminal cause, not any `failed` state. In particular distinguish row cap, memory exhaustion, temp allowance and unrelated process/query errors. Require nonzero spill to label a running-spill case.
2. Apply memory safety monitoring throughout cancel-proof polling and all active execution. On any check failure, cancel and settle its job in `finally` before the next case.
3. Identify workers by actual parent-PID/job lineage, not binary path/start time alone. Require fresh valid samples to establish no workers; absent/stale samples are not cleanup proof.
4. Record physical free-space reserve and shared/cache usage separately, plus per-job allowance/directory bytes. Do not silently bless a16MiB allowance overshoot as a contract.
5. Validate deterministic grouped expectations beyond a single first-row count and retain immutable input hashes.

These are harness review findings, not observed product failures. Final classification waits for execution evidence and corrections.

## Pre-final accounting review, 2026-11-06

Root's actual low-storage run observed62,816,256 spill bytes; independently reading its retained JSONL yields a maximum35,848,192-byte difference between Windows directory enumeration and fresh file-handle lengths. This substantiates a real open-writer accounting blind spot rather than merely an observer timing guess.

Reviewed the frozen `storage/temp.rs` and SQL `directory_bytes` corrections. Both now open ordinary files and read current handle metadata. The storage manager retains its **exact registered file identity** exemption for pinned source hardlinks; a copied file, unregistered hardlink or replacement identity remains charged. The same opened handle supplies identity and length, avoiding an additional identity/length path race. Vanished files are skipped; other I/O errors remain errors. No product write, source modification, new setting or dependency was introduced. Existing alias/replacement tests remain relevant. New open-writer tests assert both8MiB then9MiB growth while the writer remains open. No confirmed alias/data-integrity regression found in this source pass; execution of those tests and final real stress rerun remain required.

**Additional material finding returned to root/engine:** retained `stress-low-storage.json` reports a real `max_temp_directory_size` failure as `QueryFailed`, with raw DuckDB PRAGMA advice. `NativeStream::result_error()` constructs a generic query error instead of applying the existing shared temporary-storage/interrupt classifier. Resource regex alone incorrectly accepts this as complete typed-error behavior. Require normalization to `QueryTempLimitExceeded` with application guidance and a regression assertion before final acceptance. This is distinct from enforcement itself: observed disk rejection/recovery succeeded, but its error contract was not yet met in that run.

The early actual SELECT42 access-violation failure and subsequent C-API pointer-indirection repair are root-reported history; final EXE identity and all stress cases must be rerun after the accounting/error changes. Earlier8/9 or targeted PASS results do not substitute for that final snapshot.

## Final helper source review checkpoint

The first fresh-handle implementation used data-read `File::open`, which conflicted with an exclusively locked DuckDB database. The real CSV-waiter regression exposed that failure; it was not a CSV global queue issue. The corrected shared helper uses Windows `FILE_READ_ATTRIBUTES` (`0x80`) with sharing read/write/delete (`0x7`) solely for metadata access. Both SQL and shared temp accounting call this helper; non-Windows retains normal read handles. Exact pinned-source identity exemptions still use the same handle's Win32 identity. No data-read/write access, source content changes or alias exemption broadening were introduced by this correction.

Two Windows exclusive-writer regressions assert ordinary data-read open fails while metadata accounting still sees the live file. Open-writer8→9MiB cases and exact alias/replacement accounting coverage remain. The isolated CSV waiter test passed (`2026-11-06T10-38-45...`,1 passed/401 filtered,0.26s). The unchanged five-second cleanup assertion is retained. Full402-test serial run (`10-42-41...`) is pending at this checkpoint.

Raw C-API extraction/prepare/execute/result errors now pass through shared `duckdb_message_error`, as wrapper DuckDB errors do. Temporary-storage patterns map to application `QueryTempLimitExceeded` guidance; interruption maps to cancelled; ordinary memory exhaustion remains a query error rather than being mislabeled disk exhaustion. Targeted regression assertions cover these distinctions. No further material source defect found in this pass. Final real low-storage typed-error verification, full test result, rebuilt EXE identity and all final stress cases remain required before a runtime verdict.
