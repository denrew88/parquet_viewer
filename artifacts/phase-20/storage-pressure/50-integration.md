# Storage pressure fix integration

2026-11-04. Root integrated Rust implementation into both product and live native converter app. Archived CSV validation snapshot remains unchanged.

## Confirmed causes

1. Cold CSV preparation reserved up to half the configured allowance before obtaining its single converter permit. More queued documents could fail while no corresponding bytes were written.
2. Source hardlink snapshots and the short capability probe were counted as complete additional CSV files. In the isolated old EXE run, a 979,427,914-byte source exceeded a 512MiB limit before its roughly 407MB cache could be completed.
3. The shared budget monitor could interrupt DuckDB but the external CSV converter needed its own polling check to stop output promptly on pressure.

The initial before/before-clean native runs also encountered an independently open validation app (PID 14388) holding roughly 407MB of legitimate active cache leases. Root verified its project executable path and stopped it under the repository's development-process permission. The `before-isolated-512` result excludes that unrelated lease condition; it still reproduces premature queued failures and source-link overcharging. Never infer that active foreign cache was incorrectly counted or eligible for deletion.

## Changes

- query/engine: acquire converter permit before cold reclaim/reservation; queued cancellation invokes abort; async allocation failure reaches terminal Failed and releases resources. Warm cache stays synchronous.
- storage/temp: exact lease path + retained source handle + OS volume/file identity exclusion. Ordinary files, copies, replaced identities and unregistered links remain charged. Usage/budget/reservation/commit/cleanup use consistent accounting; normal unlink races handle NotFound only.
- worker: capability probe uses the registered alias; creation failure cannot delete a preexisting sentinel. WorkerControl polls the existing budget check every 25ms and terminates/reaps/cleans the child on typed storage errors.
- storage errors advise closing other CSV tabs and adjusting the limit when active caches genuinely consume capacity. Active cache leases and the 5GiB disk free-space reserve remain protected.
- Actual native cold preparation succeeded after the first fixes, but the warm check caught unnecessary eviction caused by requesting the cold reservation target for a tiny catalog restore. Warm admission now first uses available headroom (up to a 16MiB reservation cap), reclaims minimally only on zero allowance, and validates actual metadata usage before Ready. Near-full 24MiB/2MiB regression added; the earlier native result is retained as before-warm-fix-512.json.
- formal build runs sync_runtime.cjs before compilation, retaining the native converter adapter while copying shared runtime sources and applying/verifying the shared worker patch.

## Execution tracking

- Related `storage_pressure_`: 7 PASS, allocation failure/retry: 1 PASS (pre-final FFI declaration normalization).
- Windows duplicate FFI struct declaration warning was fixed by using the same existing canonical Win32 layout, without lint suppression.
- Final all-targets Clippy `-D warnings`: PASS.
- Full Rust suite, final Release and native 512MiB/1GiB results: see final `90-results.md` after execution. This integration record is not a final PASS claim.

First targeted run hit sandbox temp-file access denial. Elevated rerun then exposed a warm test using a newly created source identity; the test was corrected to reuse the exact original spec and assert cache audit hits increase. Neither failure was hidden or converted into a weaker assertion. Relevant failed log is retained locally.
