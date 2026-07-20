# Phase 11 query-plan audit

- Date: 2026-07-20
- Fixture: `.tmp/phase11-large/query-low-5850000-15c.parquet`
- Result: PASS for bounded result indexing and late value materialization

## Observed plan shape

1. `dv_source` remains the typed DuckDB source relation.
2. Filter and stable sort create `query_result` with only `__dv_row_id` and
   `__dv_result_position`; the 15 display/raw values are not copied into the result index.
3. A page request joins only its projected columns back to `dv_source` and uses Arrow batches.
4. Parquet timestamp columns are refined by source row id so DuckDB's microsecond timestamp path
   cannot discard the original nanosecond value or timezone metadata.
5. A full-cell request reads one result position and one requested column. Binary and nested values
   therefore remain bounded during ordinary page rendering and are decoded fully only on demand.

## Measured result

- 5,850,000 rows, 15 columns, 59 row groups
- Full stable sort: 15.139 s
- Random first/middle/986,803/final page and checksum assertions: PASS
- Empty filter count and final row mapping: PASS
- Query temp usage reported by the test: 10 bytes after cleanup
- No 15-column display/raw duplicate table is created.

The audit does not claim that every DuckDB expression is pushed into every Parquet row group. It
does establish that the persistent query result is a two-column identity/position index and that
page values are materialized late with a bounded projection.
