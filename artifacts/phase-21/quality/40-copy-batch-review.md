# Partial copy batch independent review

2026-11-05 KST. Scope: `copy/mod.rs` partial-batch change and real CopyManager regression tests in `query/column_values.rs`; typed grouping/sorting changes are outside this review pending their freeze.

**Scoped source-review verdict: PASS, no new defect found. This is not final Phase approval.**

- Nonempty short batches with `has_more=true` advance by actual rows and continue; final short batches succeed only when the requested selection is complete. Premature EOF (`has_more=false` with remaining selection) fails. Empty batches fail regardless of `has_more`, preventing zero-progress loops. A full-size final batch followed by an overlong selection also fails on the next empty read.
- Offset/projection mismatches, oversized returned row counts and per-row projection width mismatches fail before clipboard commit. Byte and cell limits remain enforced; adaptive batch sizing uses actual returned rows.
- Cancellation is checked before each source read, after staging flush and again under the commit gate. Source/session freshness is revalidated under that gate; clipboard write remains a single final operation. RAII staging cleanup runs on success, EOF, cancellation and serialization/limit failure. The change does not move the commit point or weaken stale-session validation.
- Regression tests exercise actual ColumnValuesReader→CopyManager→clipboard-wrapper flow, not only a mocked frontend: 237/512/4301 selections with and without counts, exact output and processed counts; two long values forcing one-row byte-bounded batches with differing `has_more`; ByteLimit with zero clipboard writes. General copy tests cover bounded partial success, premature/empty EOF, cancellation, stale commit and commit/cancel linearization.

Executed evidence supplied by Root and inspected: `artifacts/dev-check/2026-11-05T05-02-27-881Z-phase21-test.log`, **349 PASS, 0 FAIL, 16 ignored**. All named partial-batch, long-value, cancellation, stale and atomic-commit tests are explicitly present as `ok`. Quality did not rerun the suite. The ignored tests and final rebuilt native clipboard acceptance remain separate gates.

Minor coverage boundary: malformed adapters returning an empty batch with `has_more=true` or more than requested rows have explicit defensive branches, but this change does not add dedicated test cases for those malformed variants. No production path was found that returns them.
