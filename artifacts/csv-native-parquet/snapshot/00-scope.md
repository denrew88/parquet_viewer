# csv crate + polars-parquet standalone comparison

2026-11-03. User authorized implementing and measuring the narrow converter discussed in the chat.
Product parsing, UI, Cargo manifest/lockfile, feature flags and release EXE stay unchanged.
Single-owner isolated experiment; no Phase transition or product integration.

Use current 0.54.4 polars-parquet/arrow and existing csv crate. No full Polars, DuckDB, lazy planner,
streaming executor or new native runtime dependency in candidate. Fixed explicit profile; match the
existing admitted product sink contract, not the full product prepass or all CSV settings.

Implementation: sequential csv ByteRecord parser → bounded column batches → column-parallel typed
conversion and page encoding/compression → bounded encoded results → ordered single file writer.
Batch target 65,536 rows, decoded field bytes 32MiB, record 8MiB, columns 256, queue capacity 1 per edge.
Maximum stage occupancy is producer + input queue + compute + output queue + writer = 5 batches.
This is bounded by batch shape/bytes, not a hard process RSS cap. csv may allocate a record before
the post-read size check; do not expose this experiment as the production untrusted-input handler.

Acceptance: profile parsing fails closed outside default tokens/no trim/common admitted types;
MAIN full 5,850,000 × 29 decoded values and source IDs match current product and historical digest;
EDGE full parity covers quotes/newlines, null/empty/invalid, integer boundaries, float -0/NaN,
Skip and state lane 31/32. At least 5 alternating MAIN runs per engine with same 8-thread setting,
CPU/process high-water metrics, output bytes/row groups, full samples retained. Add 1-thread candidate
diagnostic. Compare warmed OS-cache converter-only scope; no claim about whole app Ready or size saving
in the integrated product. Check malformed input, overwrite prevention, source immutability, cancellation,
partial cleanup and bounded shape limits. Full native app/installer/GUI tests are inapplicable because
no product implementation or UI is changed. Rust fmt, clippy and experiment tests required.
