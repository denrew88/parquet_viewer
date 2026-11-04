# Independent review — small Storage budget / multiple CSV

2026-11-04. Mode: independent verification, Phase 18 follow-up bugfix. Reviewer: `storage_pressure_quality`, separate from the implementation agent and root native execution. **Overall: PASS for this bugfix scope.** No Phase completion or release-publication approval is implied.

## Evidence checked independently

- Read the integrated product changes, actual native worker adapter, scope, test plan and integration record. No blocking code finding remains after the queued-replacement, registered-source identity, actual-growth accounting and warm-restore fixes.
- Read final `full.log`: **314 passed / 0 failed / 16 ignored**. All **9** new `storage_pressure_` tests are present as successful individual entries. Existing allocation failure/retry, probe success/partial failure, TMP18 budget/LRU/error and foreign-process lease tests also passed.
- Read `clippy.log` completion and `run_checks.ps1`: all-targets/custom-protocol Clippy uses `-D warnings`; format is checked before the command. The PowerShell NativeCommandError formatting around stderr is not a compiler failure: the final completion is successful and the runner checks the native exit code.
- Independently parsed both final native JSON files, rather than accepting the aggregate PASS field alone: configured limits, 4 cold and 4 warm terminal states, row counts, first/last page values, cache-entry counts, final usage below limit, warm source-read zero, and source hashes before/after all agree.
- Independently hashed current product and native-variant shared runtime files against `80-evidence.json`. Query engine, temp accounting, CSV cache and CSV source are identical across both. Worker adapter and common patch hashes match the evidence.
- Independently hashed the current formal EXE: **58,786,304 bytes**, SHA-256 **`2b9ad299c2d75177528eccd1430b756ff491f8816c01a2719d15447ab5d63cf6`**. Both native runs report this same binary hash.
- Independently opened all four actual native cache Parquet footers via PyArrow: creator `Polars`, rows **5,850,000 / 65,537 / 65,537 / 65,537**, and byte sizes match `nativeCacheAudit`. This is evidence for the polars-parquet writer path, not just small-file fallback.

This review performed read-only JSON/hash/Parquet-footer checks. It did not rerun the full suite, native scenario or release build; root's captured executions are the runtime evidence.

## Test-plan verdicts

| IDs | Verdict | Evidence and criterion |
|---|---|---|
| T-SP-001 | PASS | New queued-files test at 512MiB/1GiB holds the converter permit, verifies waiting requests consume no reservations, then reads correct Ready results. Actual native cold 4/4 Ready in both limits. |
| T-SP-002 | PASS | New 24MiB/2MiB metadata-headroom test asserts cache hits increase and eviction count remains zero. Both final native warm runs retain four cache entries and all sourceReadBytes are zero. Earlier three-cache eviction failure is preserved separately. |
| T-SP-003 | PASS | Existing TMP18 minimal inactive LRU/active+foreign preservation tests passed. Actual native four fitting caches remain available. |
| T-SP-004 | PASS | 512MiB actual additional large CSV fails with QueryTempLimitExceeded, retains four existing Ready artifacts, and succeeds on retry after the first large document closes. The native harness explicitly asserts prior Ready states. |
| T-SP-005 | PASS | New queued cancel and queued replacement/shutdown tests assert no preparation start/reservation, correct abort/cancel state, empty registry and cleanup. |
| T-SP-006 | PASS | Existing checked allowance/free-reserve boundary tests passed; implementation retains the 5GiB reserve. Native volume had ample free space, so this is unit-tested rather than a real nearly-full-volume experiment. |
| T-SP-007 | PASS | Worker typed-budget injected failure terminates/reaps/cleans, allocation failure releases resources and same-session retry succeeds. In actual 512MiB capacity failure, active query count returns to four, query temp returns within 4096 bytes of baseline, and retry reaches 5.85M Ready. |
| T-SP-008 | PASS | Existing subprocess publisher/lease protection and TMP18 active/foreign tests passed. No active-cache deletion or source modification was introduced. |
| T-SP-009 | PASS | Real Tauri IPC: 979MB MAIN + three 68MB CSVs, cold/warm four Ready, first/last exact integer values and unchanged source hashes at both 512MiB and 1GiB. |
| T-SP-010 | PARTIAL | Actual 512MiB active-capacity failure/cleanup/retry verified. The plan's separate 1GiB over-capacity variant was not run. The same typed capacity boundary was exercised at 512MiB and the 1GiB fitting case passed; this is accepted evidence for the bugfix's shared capacity path, not a claim that the planned 1GiB over-capacity scenario ran. |
| T-SP-011 | PASS | Final full Rust suite, format, Clippy and release build evidence agree. Existing 16 ignored tests remain explicit; no assertion lowering or lint suppression found. |
| T-SP-012 | PASS | Current shared runtime/worker patch/source hashes and actual EXE hash verified independently. Formal native variant retains its native converter implementation; archived historical snapshot is not rewritten. |
| T-SP-013 | PASS | Registered pinned-alias accounting test plus actual 979MB input succeeding under 512MiB cap. Existing source hardlink contributes no duplicate data bytes; generated output remains charged. |
| T-SP-014 | PASS | Exact registered identity test charges ordinary copy, same-name file, unregistered hardlink and different-file replacement. Probe tests preserve existing sentinel and AlreadyExists competitor; retained source handle prevents identity recycling. |
| T-SP-015 | PASS | Shared accounting/commit/cleanup test and worker failure/queued lifecycle tests passed; actual failure returns staging usage to baseline. Normal unlinks precede alias unregister. |
| T-SP-016 | PASS | Isolated old native failure retained, fixed actual 512MiB and 1GiB runs verified. The original input/source hashes remain unchanged. |
| T-SP-017 | PASS | New actual-output-growth test charges max(reservation, actual); source identity accounting is shared. Free-space calculation subtracts only unwritten reservations, avoiding double charging actual allocated data. |

## Limits and remaining risk

- This is a backend/native-storage bugfix. Frontend source and DTO were not changed. Full browser interaction, geometry, three viewport screenshot review, installer/NSIS and external release upload were not executed for this fix and are not claimed PASS. The original full-Polars executable was not separately rebuilt; the actual formal native variant and shared source parity were verified.
- Existing 16 ignored Rust gates remain unexecuted. Overall PASS applies to the recorded bugfix scope, not all historical Phase 18 large-spill/soak/installer criteria.
- T-SP-010's exact 1GiB over-capacity variant remains unexecuted as marked PARTIAL above. Root exercised the shared failure/cleanup/retry behavior at 512MiB instead; no broader Phase gate is closed by this scope-limited approval.
- A periodic monitor can detect quota excess only after bytes have been written. This is not an OS-enforced zero-overshoot quota. Actual active capacity exhaustion and <=5GiB free volume space still produce actionable errors.
- Windows delete failures can leave pending orphan cleanup. If a lease directory cannot be unlinked within the existing retry interval, alias registration is released and a remaining hardlink may be conservatively charged on later scans. Normal worker cleanup and the observed capacity-failure path removed staging successfully. No forced deletion or security-policy relaxation is warranted.
- The earlier Windows App Control 4551 build-launch failure is preserved as an environment failure. The final same-source normal external build ran successfully; security policy was not changed.
- Warm sourceReadBytes zero is the preparation counter; it does not claim that opening a CSV skips bounded header/type-inference reads.

Product changes were made by the implementation agent/root. Quality changed the test plan and this review only.
