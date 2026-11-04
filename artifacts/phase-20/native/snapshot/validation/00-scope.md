# Comprehensive experimental native CSV validation

2026-11-03. User requested broad testing after the 55.85MiB full-app comparison.
Production source/manifest/lock/UI and Phase states remain unchanged. Target both standalone native
converter and full-app size variant. Preserve baseline exe and all earlier evidence.

Orchestrator skill applied for independent quality and native runtime gates. Root owns shared plan,
converter fixes if justified, deterministic data matrix/oracle, performance and final integration.
Quality agent owns validation/quality; platform agent owns validation/native. No overlapping edits.
Agents report permission barriers to root and do not issue user approval requests.

## Required gates

| ID | Owner | Scope and criterion |
| --- | --- | --- |
| DATA-01 | Root | Deterministic seeded rows/types/widths, full decoded raw/typed/state/ID oracle and Polars parity |
| DATA-02 | Root | 65,535/65,536/65,537 rows and 31/32/33/64/65/255/256 column state boundaries |
| DATA-03 | Root | Long strings, UTF8/quotes/newlines, no-header, zero/one-row; bounded decoded oracle batches |
| PERF-01 | Root | Representative low/high/numeric/wide/long workloads, CPU/wall/process peaks; no timing during competing tests |
| Q-01 | Quality | Fail-closed profiles, numeric lexical and float boundary compatibility |
| Q-02 | Quality | BOM/CSV structure, malformed data and limits, source/output/partial integrity |
| Q-03 | Quality | Independent source review, hostile-input/cancellation/publication limits and final findings |
| APP-01 | Platform | Actual Tauri full-app native converter cold preparation and first/last page |
| APP-02 | Platform | Profile apply, sort/filter/copy/schema/metadata; no baseline cache/fallback false PASS |
| APP-03 | Platform | Warm reopen, cancellation/error recovery, native Parquet/HDF regression where feasible |
| BUILD-01 | Root | Changed Rust fmt/clippy/related tests, final build only if actual runtime code changes |

Unsupported settings are reported separately from correctness FAIL within supported contract. A setting
that is unsupported must be rejected rather than silently interpreted with different semantics.
Any reproducible data-integrity/security defect remains a failure until fixed and retested; no criteria
weakening. Full app product-readiness is not inferred from passing a narrow converter matrix.

Original app suite is not a substitute for experiment testing. Existing variant omitted old Polars sink
tests; don't silently count it as full product suite coverage. Native runtime tests use dedicated cache,
settings and WebView folders. No installer deployment/OS association/Excel gate is implied.
