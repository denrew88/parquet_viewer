# Optional SQL identifier quoting

2026-11-07 user-approved scoped Phase22 follow-up. Simple ASCII identifier spelling
`[A-Za-z_][A-Za-z0-9_]*` is inserted without quotes unless it is a bundled DuckDB parser keyword.
Other names retain double-quote wrapping and doubled internal quotes. Original case and physical cN
positions are preserved. `quoteSqlIdentifier` remains explicitly always-quoted; new `sqlIdentifier`
serves automatic completion/JOIN qualification, table/column insertion, examples and name-mode previews.
Authored SQL is not globally rewritten; selecting completion replaces only its token/range and is undoable.

The489-keyword compile-time catalogue was generated from all3matching bundled kwlist.hpp copies,
libduckdb-sys1.10504.0. SourceSHA256:
`a14dafc04193e9b70eceed4cb0e83011a328a32f446ca47eed08d8835fc0e65c`.
This mirrors DuckDB KeywordHelper's conservative keyword quoting, including context-sensitive keywords.
`scripts/sync_sql_identifier_keywords.mjs` regenerates from the existing local build; no runtime engine
query, new package, permission or backend change. Generated JSON is pinned to the bundled crate version
by unit tests. Review the source catalogue when upgrading the engine.

## Validation

Independent pre-implementation plan: [ID001..006](quality/identifier-insertion-plan.md).
Related SQLworkspace254PASS, including29new identifier cases (01-43-35). Covers keywords/case, empty,
leading digit, whitespace, punctuation, embedded quote, SQL-like injection payload, cN gaps and an entire
quoted token replaced without leaving quote fragments. Full frontend805/805PASS57.93s and final
format/lint/types PASS (`2026-11-07T01-44-54`). Focused identifier E2E3/3PASS41.3s across the three
viewports, including explicit token replacement/Undo and SQL-like quoted alias payloads with no execution.
Independent source review PASS. Full browser204/204PASS8.8m (`01-46-03`), historical222evidence files
preserved. Three viewport images independently opened/reviewed, bounds and unsafe-name escaping readable.
Native candidate build PASS8m50s (`01-45-53`), actual native acceptance PASS12.189s (`01-55-25`):
all4name/cN pairs execute COUNT3 with bare o/c aliases and retained quoted Korean names as appropriate;
typing SQL calls0, exactly4starts, insertion/Undo, explicit detail, result edit/restore and actual restart
preferences remain valid. Fixture and primary input hashes unchanged, saved settings restored, owned process
stopped. Native screenshots were opened and independently reviewed.

## Product EXE and scoped verdict

Scoped source/browser/native PASS: [independent review](quality/identifier-insertion-review.md).
Product Release build PASS4m13s (`artifacts/dev-check/2026-11-07T01-55-53-537Z-phase22-build.log`).
The running canonical Viewer was closed before replacement. Canonical `src-tauri/target/release/data-viewer.exe`
now has embedded version0.22.0 and60,490,240bytes, +2,048bytes (+2KiB) from the preceding canonical EXE.
Canonical/candidate SHA256 match: `a25e43c5ef60570610407b17a9f64c609580132ce9dff8ded9614a924d49e7d0`.
Full baseline/native/product provenance: `identifier-insertion-exe.json`. No installer publication or
Phase-wide promotion was performed.

Native acceptance uses separate `native/stress-identifiers.json` and `native-sql-identifiers-*` images,
retaining earlier follow-up evidence. All4name/cN pairs must still return the golden COUNT3.
Phase-wide completion/promotion and external release remain separate.
