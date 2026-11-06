# Logical distinct key independent review

2026-11-05 KST. Scope: frozen `materialize_values` and `logical_sort_expression` in `query/column_values.rs`, with real CSV profile matrix tests. No product code edited by Quality.

**Initial verdict: FAIL pending the category correction below.** This is a scoped source review, not a final Phase verdict.

## Finding TYPED-01 — NULL must not retain a non-null struct key

Severity: high for exact value-category ordering. `materialize_values` currently nulls the sort key only for invalid/empty values. Decimal and Timestamp use `struct_pack`; a null input creates a non-null struct containing null fields instead of SQL NULL. Consequently `NULLS LAST` cannot classify nulls consistently alongside the special categories, and descending order can put null before valid data. Scalar numeric tests do not cover this distinction.

Expected correction: include the computed null category in the sort-key CASE. Add real Decimal/Timestamp profile tests containing valid, NULL, empty and invalid raw values for both value directions and source/filtered scopes. Root acknowledged and assigned the fix to the source owner. Final runtime/source confirmation remains pending.

## Other reviewed properties

- HUGEINT preserves signed/unsigned 64-bit neighbors and duration nanosecond integers without Float64 conversion.
- Decimal keys compare sign, significant integer length, digits and fractional digits directly. Complemented negative digits plus a terminator reverse fractional-prefix ordering. Trailing zero and signed-zero normalization groups typed-equal values without a fixed decimal scale or precision truncation.
- Timestamp keys retain whole-second epoch and nine fractional digits separately, including equivalent offsets and pre-epoch instants. They avoid microsecond truncation of the fractional component.
- Grouping keys omit representative display spelling; deterministic minimum display does not split typed-equal values. Invalid raw keys retain separate identities, while explicit category flags distinguish NULL/empty/invalid.
- Real CSV matrix covers whole-source and filtered snapshots, ascending/descending Int/UInt64/Decimal/date/timestamp/duration/bool and ascending Float64. It includes 2/10, 64-bit neighbors, decimal fractional prefixes and timestamp nanosecond/offset equivalence. No additional confirmed defect was found in this bounded review.

The suite started at `2026-11-05T05-08-59-615Z-phase21-test.log` was still compiling during review; no unobserved runtime outcome is claimed here. Existing global query-engine typed helper behavior is outside this patch and is not certified by this review.

## Source correction reviewed

The frozen correction now explicitly returns SQL NULL for invalid, empty **or computed-null** categories before constructing the logical key. **TYPED-01 source finding closed; scoped source-review verdict PASS, runtime confirmation pending.**

`p21_distinct_real_struct_key_profiles_keep_null_empty_invalid_last` meaningfully exercises the defect through real CSV profiles for Decimal and Timestamp, both whole-source/filtered and ascending/descending. It asserts two typed valid groups before both distinct invalid raw groups, then empty and NULL; exact counts, exclusive flags, representatives and opposite invalid ordering are checked. Decimal scale-equivalence and timestamp offset-equivalence with adjacent nanoseconds remain in the same test, so the correction does not merely mask null placement. It would fail on the previous non-null struct category key.

Root's final runtime log `2026-11-05T05-19-33...` is still pending at this review; no suite rerun was requested or performed by Quality. Rebuilt native and final integration acceptance remain independent gates.
