# CSV preparation under small storage budgets

2026-11-04. User reports repeated errors with several CSVs and a configured storage limit around 0.5–1GiB. Exact error and file sizes unavailable.

Scope: diagnose and fix premature reservations by queued CSV preparation, preserve cache leases/read-only inputs/shared disk cap and free-space reserve. Actual capacity exhaustion remains a typed actionable error. Do not delete active cache, silently raise limits, or publish releases.

Initial finding: cold preparation reserves limit/MAX_CONCURRENT_QUERIES (2) before acquiring the single CSV-preparation permit. Queued work can exhaust budget despite small actual cache outputs. Move cold admission after permit and test cancellation/failure cleanup and warm restore independently.

Ownership: Rust agent storage/query implementation and unit tests; Quality agent test plan and independent review; root docs, native smoke, sync to the currently built native CSV variant, final checks and build. Existing user changes to artifacts/phase-20/native build entry and README are preserved. Historical immutable validation snapshot is not rewritten.

Test contract: [10-test-plan.md](10-test-plan.md). Cover 512MiB/1GiB multiple-file cold preparation, queued cancellation and replacement, warm cache, inactive LRU, active-capacity failure, reserve protection and unchanged sources. Run relevant tests during implementation, full backend checks and build once after final source changes. No React changes planned; native behavior verified against real Tauri.

The root src-tauri product and the native converter full-app variant share storage/query sources. Apply the fix to both; the formal executable continues to be src-tauri/target/release/data-viewer.exe. Current task authorizes fixing this behavior and rebuilding, not external deployment or changing Phase completion status.
