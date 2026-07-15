# Phase 9 Product QueryService 10M Test

- Date: 2026-07-15 (Asia/Seoul)
- Result: **PASS after test-budget correction**
- Final Phase 9 gate: not evaluated

## Fixtures

The deterministic generator completed in 134.2 seconds. Its disk preflight passed with 164,545,286,144 bytes free and 26,843,545,600 bytes required, including the reserve.

| Cardinality | Shape | Row groups | File bytes | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| low | 10,000,000 x 40 | 100 | 15,502,401 | `2cd3a04b476377039fcabaca77e4d7872ab5603e54a34b43f50b9070908d4eb1` |
| high | 10,000,000 x 40 | 100 | 2,561,128,881 | `37cb4b1b5264b537985251baec3e618ecb93acf5fb92814b503a1517e8b005ca` |

The manifest validation and generator determinism check passed. The compact manifest remains at `product-large-fixtures-manifest.json`; the generated Parquet files were removed after verification.

## Command

`PHASE9_LARGE_FIXTURE_DIR` was set to the resolved `logs/phase9-product-large` directory before running:

```text
cargo test --lib --release perf_product_query_service_10m_low_high -- --ignored --nocapture
```

The successful rerun used a 10,737,418,240-byte process temp limit and a 5,368,709,120-byte per-query DuckDB temp limit.

## Results

The query filtered `row_id >= 5000000`, sorted `optional_value ASC NULLS LAST` then `amount DESC NULLS LAST`, and projected `row_id` and `category`.

| Cardinality | Result rows | Filter/sort ms | Page offsets | Page ms | Temp bytes after completion | Cancel |
| --- | ---: | ---: | --- | --- | ---: | --- |
| low | 5,000,000 | 17,626.285 | 0; 2,500,000; 4,999,800; 1,666,666 | 39.5655; 16.6013; 3.5922; 28.8412 | 10 | PASS |
| high | 5,000,000 | 15,034.968 | 0; 2,500,000; 4,999,800; 1,666,666 | 44.1379; 39.4706; 3.8571; 42.8627 | 10 | PASS |

Each page contained up to 200 rows and was non-empty. For each fixture, a separate full-data `label ASC NULLS LAST` query was started, cancelled after 100 ms, and reached `Cancelled`.

- Rust test time: 33.80 seconds
- Cargo compilation plus test wrapper time: 91.712 seconds
- Sampled peak test-binary working set: 1,132,679,168 bytes
- Sampling interval and count: 200 ms, 392 samples
- Cargo result: 1 passed, 0 failed, 112 filtered out

## Cleanup

- Cargo and `data_viewer_lib-*` processes after the run: none
- New `%TEMP%/.tmp*` directories at or after test start: none
- Query spill usage after each completed query: 10 bytes (the process owner lock only)
- Generated fixture bytes removed: 2,576,631,282
- `logs/phase9-product-large` after cleanup: absent

## Attempts and evidence

Attempt 1 failed because the ignored test inherited the general unit-test helper's 256 MiB process budget, producing a 128 MiB per-query limit. That failure and its cleanup evidence are preserved in `product-large-test-attempt-1.md`.

- Successful stdout: `product-large-test-attempt-2.stdout.log` (SHA-256 `a0aa997fc23f7f4dbc015051a952533210ccf8a3e0b231d84a7a40c563441a58`)
- Successful stderr: `product-large-test-attempt-2.stderr.log` (SHA-256 `9790d8cb4ff2625081bf9aad91888ff1db3a2cc33a622923c90023d376ec77d5`)
- Fixture metadata: `product-large-fixtures-manifest.json`

