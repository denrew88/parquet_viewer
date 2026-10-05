# Phase 19 integration

## Integrated contract

- `ColumnSchema.logicalType` keeps the original Arrow type, including the dictionary key and value wrapper.
- Required `ColumnSchema.valueLogicalType` recursively unwraps dictionary values and is equal to `logicalType` for non-dictionary columns.
- Query validation, filter operators, sorting, result value kind, duration handling, Parquet boundary/statistics/occupancy, and frontend scalar inference use the value type rather than the dictionary key or Parquet physical type.
- Dictionary codes are resolved only against the dictionary attached to the current Arrow batch. They are not stored or compared across row groups.
- Dictionary full-value reads recurse into the decoded value so binary and nested values keep the same preview/full contract as direct arrays.
- A nested dictionary whose inner key is null resolves to a null value rather than a decode error.

## Regression fixture

The Rust query integration test writes two Parquet row groups with deliberately different local dictionaries. Code `0` means `beta` in the first row group and `alpha` in the second; `beta` moves from code `0` to code `2`. The test audits those dictionaries before exercising filters, stable ascending/descending native-value sorting, null-last behavior, distinct values, Find, pages, and copy. A numeric dictionary test proves `2` sorts before `10`.

## Implementer verification

- Rust focused dictionary/query/data tests: PASS.
- Full Rust suite: 305 PASS, 16 ignored fixture/performance tests.
- `cargo fmt --all -- --check`: PASS.
- `cargo clippy --all-features --lib --bins -- -D warnings`: PASS.
- Frontend format, lint, and typecheck: PASS.
- Frontend unit/component suite: 405 PASS.
- Playwright across 1440x900, 1024x768, and 800x600: 123 PASS, including the new categorical filter interaction.
- Native Tauri debug build: PASS.
- Native WebView/CDP smoke: PASS on retry; the first run reached the final clipboard assertion with a transient one-row selection, while the immediate clean retry passed CSV profile, boundary, sort, filter, copy settings, and 10,000-row loading.
- Release build and NSIS installer: PASS.
- No markup or CSS changed, so new screenshot and geometry evidence is not applicable; the existing geometry E2E remained green.

## Review note

The delegated Quality review could not start because the agent service reported a usage-limit error. Root therefore repeated the code-path audit and complete executable gates. That audit found and fixed one additional nested-dictionary null edge before the final full Rust and release runs. No unresolved Phase 19 product defect remains.
