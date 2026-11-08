# Phase 23 SQL Results fixture

Open `input.csv` and run `results.sql` in SQL workspace. The deterministic query generates 460 rows with source positions 0–459.
The query cross joins the registered one-row CSV to make source-tab closure testable. The typed values come from the SQL fixture.

`golden.json` describes the expected row positions for `group_name = '팀-A'`, ordered by `score` descending with nulls last and then `amount` ascending. Source position breaks ties. Subtract 9007199254740992 from the exported `row_key` using integer arithmetic to compare with the recorded offsets. The 230-row view crosses the 200-row page boundary.

Find `Needle` in `detail` and compare zero-based view positions for case-sensitive and case-insensitive exact searches. Sample raw values in the golden file exercise 64-bit integer precision, decimal scale and nanosecond timestamps. The fixture also includes text with a comma and quotes, Korean text, nulls and empty text.
