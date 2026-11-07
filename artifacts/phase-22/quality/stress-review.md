# Phase 22 actual EXE stress — independent review

Execution mode: independent verification, 2026-11-06.

**Stress scope: PASS. Phase-wide completion: not approved.** Independently read the final structured report, execution log, current harness/monitor and relevant Rust regression log. Root executed the tests; Quality reviewed evidence without launching another build or test run.

## Executed target and evidence

- Actual optimized Tauri0.22.0 EXE, Rust IPC and same-EXE SQL child, with namespace `com.denrew88.data-viewer-phase22-acceptance`. The approved build entrypoint changes the application identifier to isolate settings/cache; this is not browser mock or an external DuckDB executable.
- Candidate: `src-tauri/target/release/candidates/phase-22-native/data-viewer.exe`. Independently computed SHA256 matches report: `0d8122c8f82e694dc10cf41c0b55f572fe1c5683e8f3ab244064392abdfb24e8`.
- Native build log: `../../dev-check/2026-11-06T10-45-35...phase22-native-build.log`; actual final run `../../dev-check/2026-11-06T10-49-50-665Z...` lists10 PASS checks. Structured evidence: `../native/stress.json`,10:49:50.972–10:50:40.777 UTC.
- Deterministic Parquet input:5,850,000 rows,413,437,327 bytes, id/bucket/payload. Before (`input.sha256`) and after (`inputSha256After`) match: `505692c3e37c7b2a9ad5882a1bda21297175d4bee96e9b8b065dd2828ea34e97`.

## Acceptance mapping

The root harness's deterministic Parquet variant is the documented substitute in `stress-plan.md`; it tests SQL execution without large CSV preparation overhead.

| Plan ID | Verdict | Actual evidence |
| --- | --- | --- |
| S-P22-001 | PASS | Runtime health0.22.0 and isolated identifier; exact count5,850,000 and SUM(id)=17,111,247,075,000. Baseline retained result42 is reread by recovery after each stress failure/cancel. Low-cardinality aggregate returns1000 groups; independent bucket0/500/999 counts5850 and sums17,108,325,000 /17,111,250,000 /17,114,169,150 match the fixture formula. |
| S-P22-002 | PASS | Nonseparable SQRT CROSS JOIN, actual child PID6188 with measured1.125 CPU seconds, terminal TaskCancelled. Cancellation status91ms; child exit/cleanup181ms. A queued-only cancellation would not satisfy the harness proof. |
| S-P22-003 | PASS | Full sort without LIMIT spills457,146,368 bytes, then deliberately fails the1,000,000-row result cap with InvalidRequest and actionable LIMIT guidance. Separate CROSS JOIN result-cap case also fails at that exact cap. Neither is called disk OOM. |
| S-P22-004 | PASS | High-cardinality aggregation hits actual temp allowance with QueryTempLimitExceeded at1GiB and0.5GiB settings, with observed spill536,805,376 and536,838,144 bytes. Additional unspillable list workload produces actual allocation OOM at249.3/256MiB, classified QueryFailed rather than disk exhaustion. Each recovers normally. |
| S-P22-005 | PASS, documented Parquet variant |1GiB/0.5GiB/64MiB managed settings are recorded with per-job reservations, shared usage and physical free bytes.64MiB full sort has observed56,131,584-byte spill and typed QueryTempLimitExceeded with application guidance, without raw PRAGMA advice. No observed per-job allowance overshoot. This does not test active CSV-cache pressure. |
| S-P22-006 | PASS |0.5GiB blocking sort cancellation has real worker CPU proof and300,056,576 observed spill bytes. Terminal cancellation341ms; exit/cleanup427ms, below the5-second criterion. |
| S-P22-007 | PASS for normal cleanup in this run | Every failed/cancelled case has a fresh empty worker list and query temp1522 bytes, equal to its before baseline. Retained42 plus normal COUNT/SUM succeed after every case. Input hash unchanged, settingsRestored=true, ownerStopped=true. Forced parent-death behavior is outside this result. |

## Resource observations and limits of proof

- Maximum sampled worker WorkingSet/RSS:303,194,112 bytes (289.15MiB); maximum PrivateBytes:295,624,704 bytes (281.93MiB). Maximum sampled parent+worker WorkingSet338,714,624 bytes (323.02MiB). These are observed peaks, not hard upper bounds or total WebView memory.
- DuckDB buffer limit is256MiB with2threads. Its actual list allocation error is distinct from the temporary-directory limit. There is **no OS RSS/commit quota**; the harness2GiB PrivateBytes safeguard was not reached. RSS exceeding256MiB is consistent with the stated buffer-manager contract.
- Monitor sleep target20ms does not equal actual sample spacing: observed maximum gap604ms. Short query workers can evade sampling; the fast final1000-group success has no sampled worker, so its0 memory fields are not a zero-memory claim. Intermediate peaks/short transient overshoot may be missed.
- Observed per-job overshoot is0. Sampled physical free minimum791,599,603,712 bytes remains far above the5GiB safety reserve. This demonstrates managed allowance behavior with ample real disk; it is not a physical disk-full/reserve-exhaustion experiment or instantaneous filesystem quota.
- Earlier Windows open-writer stale enumeration difference35,848,192 bytes motivated the fresh metadata-handle fix. Current regression log explicitly passes open-writer growth, exclusive database metadata access, raw C-API error classification and exact registered alias/replacement accounting tests. The final native run demonstrates typed low-storage failure and recovery after those fixes.

## Findings and remaining gates

No new material product defect established in this final stress evidence. The previously found raw C-API temp-error classification defect is verified corrected by the final64MiB typed failure. Access-violation and Windows stale/exclusive-handle issues remain documented history; earlier runs are not used as final acceptance evidence.

The structured report's final successful aggregate stores its SQL status object under `status` (rather than the wrapper string PASS), while the console execution log records PASS. Its explicit checked bucket rows and successful assertions support this case; consumers should not assume all `checks[].status` values are strings.

**Do not call the entire Phase or full Rust suite green.** Full Rust log10-42-41 reports383 passed,1 failed,18 ignored. The failed `csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging` passes unchanged in isolation (10-44-53,0.58s); that separate result does not erase the full-suite failure. Clippy log10-45-12 passes. Product-namespace release build and any remaining Phase-wide acceptance are root-owned and separate.

This stress review does not establish active large CSV-cache coexistence, physically full disks/ACL faults, forced parent death/orphan recovery, long soak, actual clipboard, installer/file-association behavior or the complete24-ID Phase22 matrix. Required unexecuted or unresolved gates keep Phase-wide completion pending, while the requested actual query stress/cancel/recovery scope above passes.

