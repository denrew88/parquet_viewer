# Typed JOIN suggestion acceptance inputs

Two small Parquet tables avoid CSV inference as a confounder. Open both files with default aliases
`orders` and `customers`; the shared Korean key `고객 번호` is orders physical index1(c2) and customers
physical index0(c1). Generic original `id` is index2(c3) in both and deliberately has unrelated values.

Inner JOIN on the real shared key returns3rows:101/Alice,102/Bob,102/Betty. NULL keys do not join.
The generic id predicate returns0rows. `manifest.json` contains sizes/hashes and the independent Python
golden. `node scripts/dev-check.mjs phase22-join-fixtures` regenerates and re-reads the small files.
These are synthetic test data, not foreign-key metadata. The completion feature must label inference.
