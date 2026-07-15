# Phase 9 Large Fixture and Benchmark Report

- Date: 2026-07-15
- Fixture shape: 10,000,000 rows x 40 columns
- Engine: DuckDB Python 1.5.4
- Measurement: 3 warm-ups followed by 10 recorded runs
- Result: PASS for the DuckDB fallback harness

## Reproduction

```powershell
C:\Users\denrew88\.conda\envs\py311\python.exe scripts/generate_phase9_large_fixtures.py `
  --output-dir logs/phase9-large `
  --manifest artifacts/phase-9/large-fixtures-manifest.json `
  --rows 10000000 --row-group-size 100000 `
  --profiles full40 --cardinalities low high `
  --expected-upper-gib 20 --clean

C:\Users\denrew88\.conda\envs\py311\python.exe scripts/run_phase9_large_bench.py `
  --manifest artifacts/phase-9/large-fixtures-manifest.json `
  --output artifacts/phase-9/large-benchmark-results.json `
  --temp-root logs/phase9-bench-temp `
  --engine duckdb-python --warmups 3 --runs 10
```

The generator preflight found 178,660,610,048 free bytes. The configured 20 GiB expected upper
bound plus 5 GiB reserve required 26,843,545,600 bytes, so preflight passed.

## Fixture Evidence

| Cardinality | Size | SHA-256 | Compression ratio | Sample cardinality |
| --- | ---: | --- | ---: | --- |
| low | 15,502,401 bytes | `2cd3a04b476377039fcabaca77e4d7872ab5603e54a34b43f50b9070908d4eb1` | 0.00614000 | category 16 / 12,288 sampled rows |
| high | 2,561,128,881 bytes | `37cb4b1b5264b537985251baec3e618ecb93acf5fb92814b503a1517e8b005ca` | 0.78413119 | category 12,288 / 12,288 sampled rows |

Both files contain 100 deterministic 100,000-row groups. Schema, shape, file hash, row-group
sizes, encoding metadata, and cardinality sample checksum passed validation. A small two-write
determinism audit passed for every `full40`/`repeated10` and low/high combination.

The optional `repeated10` profile uses the same first ten fields and can be selected with
`--profiles repeated10`. It is intended to reproduce the user's highly repetitive 10-column data
without weakening the required high-cardinality 40-column fixture.

## Performance Evidence

| Metric | Low p95 | High p95 | Gate |
| --- | ---: | ---: | --- |
| First result | 1,524.592 ms | 1,041.921 ms | recorded |
| Random page | 808.130 ms | 803.827 ms | PERF-004 PASS, <= 1,000 ms |
| Simple filter first result | 986.826 ms | 1,038.094 ms | PERF-004 PASS, <= 10,000 ms |
| Stable 3-column sort | 1,142.449 ms | 1,739.092 ms | PERF-005 PASS, <= 120,000 ms |
| Cancel latency | 22.380 ms | 21.955 ms | PERF-008 PASS, <= 2,000 ms |

| Resource | Low peak | High peak | Gate |
| --- | ---: | ---: | --- |
| RSS | 125,829,120 bytes | 143,040,512 bytes | PERF-006 PASS, <= 1.5 GiB |
| Query temp | 0 bytes | 0 bytes | PERF-007 PASS, <= 10 GiB |
| Temp cleanup | complete | complete | PERF-007 PASS |
| File checksum | exact | exact | PERF-010 PASS |

DuckDB was configured with a 1 GiB memory limit, 10 GiB maximum temporary-directory size,
preserved insertion order, and extension auto-install/auto-load disabled. Sort order was
`category ASC, group_id ASC, score DESC, row_id ASC`, with nulls last.

The DuckDB Python binding's connection-level interrupt blocks behind an active connection mutex
on this Windows environment. The fallback harness therefore measures cancellation by terminating
the isolated query worker process after its ready marker. This proves bounded process cleanup and
latency, but it does not replace the final product runner's cooperative query-cancel test.

## Retry Record

The first measured run is preserved as `large-benchmark-results-attempt-1.json`. It failed only
the high-cardinality random-page gate at 1,268.047 ms because SQL `OFFSET` performed sequential
skipping. The final harness maps the deterministic logical offset to a `row_id` range predicate,
allowing Parquet row-group statistics to seek directly. The final high-cardinality p95 was
803.827 ms.

The final result JSON was written before cleanup. Both generated large Parquet files and the
benchmark temporary root were removed successfully; the manifest and result evidence remain.
