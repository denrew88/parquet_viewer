# Phase22 SQL fixtures

For larger manual SQL exercises, see [commerce](commerce/README.md):100,000customers,
1,000,000orders(CSV) and3,999,997order items(Parquet), with three-table JOIN examples.
Generate via `node scripts/dev-check.mjs phase22-commerce-fixtures`; generated large data stays local.

Small deterministic acceptance inputs. `generate.py` uses the existing PyArrow environment and independent
Python integer/Decimal arithmetic for `golden.json`. It does not execute DuckDB, touch app caches, or create
large benchmark data. Run only through Root's fixed `dev-check` fixture task. `manifest.json` records bytes/SHA.

| Input | Purpose |
| --- | --- |
| sales/orders.csv + archive/orders.csv | Same basename, distinct canonical paths and data; quoted/Korean/space headers |
| customers.parquet | Mixed CSV/Parquet join, duplicate key2, NULL key, unmatched key4 |
| headers/duplicates.csv + .parquet | Raw duplicate headers, suffix-like names, ASCII-case duplicate, genuine c1 and reserved name |
| headers/case-duplicates.csv | ASCII-case collision disables name mode |
| headers/blank.csv | Empty and whitespace-only raw names disable name mode |
| headers/collisions.csv | All names unique, including name (2), c1, quote and reserved name; name mode remains eligible |
| headers/no-header.csv | Explicit HeaderMode::Absent; first row is data, no true original header names |
| headers/late-duplicate.csv | Raw duplicate at position4096, beyond bounded UI audit preview |
| wide.csv | 4096 unique columns for selected-table virtualization/search and physical ordinal stability |
| typed-invalid.csv | Explicit profile invalid numeric/time, NULL token, genuine empty text and TSV controls |
| types.parquet | Exact Int64/UInt64 max and2^53 neighbors, DECIMAL38, naïve ns timestamp |
| temporal-extra.parquet | Timestamp ns+UTC and duration ns: exact support or actionable explicit unsupported type |
| nested-blob.parquet | BLOB/list/struct: exact supported semantics or explicit unsupported type |
| security-cases.json | Allowed syntax/denied side effects; test-owned canary placeholders only |

## CSV profile for the join golden

Use explicit header-present parsing and `NULL` token. Columns1/2 Int64, amount Decimal(18,2), timestamp ns;
product quote-name/text columns stay text. This avoids making auto-inference sampling part of an arithmetic test.
For `typed-invalid.csv`, configure amount Decimal, u64 UInt64, timestamp ns, text with `NULL` as the null token;
amount bad and timestamp not-a-time are invalid values rather than quoted string equivalents.

Golden SQL semantics:

- Inner join orders.customer_id=customers.customer_id: **5 rows**, SUM(amount)=**500.50**.
- Left join: **8 rows**, SUM(amount)=**575.56**; NULL customer IDs never equal each other.
- Ordered join output: order_id ascending, customer_name ascending NULLS LAST.
- Grouped left join by region: Busan2/200.20, Incheon2/200.20, Seoul1/100.10, NULL3/75.06.
- Window: ROW_NUMBER PARTITION BY customer_id ORDER BY order_id.
- `leftJoinTsv` includes display headers; `duplicateResultLabels` proves r0/r1 identity independent of labels.

Numeric precision expectations are strings in JSON to avoid JavaScript Number rounding. Temporal expectations
retain epoch ns strings and unit/type metadata; a string result alone does not establish exact SQL semantics.

Security corpus acceptance requires observing canary/settings/network side effects and no disclosure. Merely
getting an error because a path is absent is not proof of blocked access. Native/browser/injected-fault evidence
must remain separately labeled. No corpus case runs during fixture generation.
