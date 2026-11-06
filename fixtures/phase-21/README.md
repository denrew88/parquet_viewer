# Phase 21 deterministic fixtures

- `distinct-pages.csv`: 237 distinct text values, deterministic 1–5 frequencies and bucket A/B scope. 100/200-row pagination boundaries and stable ties.
- `distinct-types.csv`: inline/long Unicode, empty, literal NULL, tab/LF/CRLF/quote, typed-equal integer 01/1, invalid integer, >2^53 and uint64/decimal/nanosecond cases.
- `golden.json`: independent stdlib Counter oracle and RFC CSV-style quoted TSV. Counts retain precision as input strings; typed_integer golden assumes explicit int64 target and NULL token.
- `manifest.json`: hashes. Regenerate with `C:/ProgramData/miniforge3/python.exe fixtures/phase-21/generate_fixtures.py`.

Browser `?phase21=1` uses a separate synthetic 237-value UI dataset (count=238-index); it is not this CSV oracle or native backend evidence.
