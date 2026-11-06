# Phase 21 native acceptance checklist

2026-11-05 KST. This is an execution checklist, not a PASS claim. Root owns native process execution and approved D: test directories.
Use the isolated release identifier `com.denrew88.data-viewer-phase21-acceptance`; never migrate the user's existing Phase 20/product cache.

## Before starting

- Record candidate EXE SHA-256, Windows FileVersion/ProductVersion and health_check/Tauri version 0.21.0.
- Record settings snapshot and isolated app-local/config paths. Preserve native clipboard text if the harness overwrites it and restore at end where supported; disclose clipboard format limitations.
- Create a unique test-owned parent on C: and D:. Record OS volume identity, not just different path spelling. Seed foreign sentinel beside the managed child and record its hash.
- Have all documents closed before migration. Restore settings and stop only the project process launched by the harness in finally paths.

## Required native scenarios

| ID | Steps | Evidence / expected result |
| --- | --- | --- |
| N21-01 | Open fixtures/phase-21/distinct-pages.csv. Start values for column `value`, whole-source snapshot. Poll terminal, read first/middle/last pages, both value orders and count orders. | Exact total237; row count708; each value/frequency and stable tie order matches golden.json. 100/100/37 pages, no missing/duplicate values. |
| N21-02 | Execute `bucket = A` filter and start a filtered snapshot, then compare whole-source scope. Search a value prefix in both scopes. | Filtered total118; source237. Counts/order match golden scope; matching total differs from overall; query replacement invalidates old operation without changing new state. |
| N21-03 | Native Copy values / Copy values and counts before loading all pages. Inspect actual Windows clipboard. Repeat a search-only copy and empty-result action. | Full237-row payload plus Value/Count header, not only100 loaded. TSV equals golden, CRLF/quoting preserved; empty result does not overwrite clipboard. |
| N21-04 | Use explicit int64 profile for distinct-types.csv typed_integer. Inspect null/empty/invalid and typed-equal01/1; use text values with tab/LF/CRLF/Unicode/quote. | typed integer 1 count4, 2/10 count1, null1, invalid bad count1; total5 under fixed NULL profile. String copy escapes controls; large numeric/decimal/timestamp raw strings preserve precision. |
| N21-05 | Start a high-cardinality operation/copy, cancel or close/release its panel, then start another. | No stale totals/pages or clipboard commit. Terminal cancellation; per-worker permit and map/table/reservation cleanup checked. Large resource bounds require measured/native result or explicit unit-only qualification. |
| N21-06 | Apply overall0.3GiB/cache0.5GiB, reopen Settings, inspect saved DTO and usage; test min/max and just-outside boundaries. Open a new CSV and query its page. | 322122547/536870912 bytes saved; effective=min overall/cache. No preview/apply/session mismatch. Cache cap>overall is valid. |
| N21-07 / T-P21-017 | Keep cache entry leased, lower below its size, then close last lease without reapplying the limit or manually clearing. Test a new CSV whose prepared data exceeds cache cap but fits overall. | Active entry stays readable while leased. Last close invokes reclaim under the already-configured effective cap, usage returns ≤cap without explicit set/clear. No active deletion; configured/effective/active/reclaimable usage truthful. Oversized cache publication is skipped without making file unusable. |
| N21-08 | Open native folder chooser, cancel once, then choose D: test parent. Check preview. Try starting with an open document and after all documents close. | Picker cancellation leaves settings/root untouched. Destination is fixed managed child. Open docs/pending opens block move; normal Apply cannot forge/change directory. |
| N21-09 | With at least two valid prepared caches on C:, record source artifact hashes and run actual C:→D: move. | UI progress/cancel context and status. D: has full copy+5GiB reserve; actual volumes differ. Settings switch only after verification; artifact data unchanged, new OS identity/fingerprints valid; no foreign sentinel changed. |
| N21-10 | Restart release app after move, reopen same CSVs; then prepare an uncached large CSV with overall1GiB/cache≥512MiB. | Old caches warm Ready/sourceReadBytes0; ordinary page/filter/sort results valid. New cross-drive publication succeeds under D: root (not just migration); source CSV hashes preserved. |
| N21-11 | Cancel a migration during copy/verification. Exercise failure cases via supported tests (disk full, permission, settings save failure, source mutation). | Before commit, old settings/cache valid and only owned partials removed. After commit, cancellation never rolls back authoritative settings; cleanup failures explicit. Separate injected faults from actual native filesystem failures. |
| N21-12 | Separate app holds an entry lease, then attempts old-root work after migration. Run deterministic subprocess crash/recovery tests. | Lease blocks whole move. Stale process follows/receives explicit redirect safely. Crash before/after settings/source-unlink has one authoritative root, preserved original data and journal recovery. Native startup wiring verified, not only helper logic. |
| N21-13 | After successful move and exit, make isolated configured root unavailable; restart. Choose another valid location, including a failed save attempt. | App and Settings remain reachable; operations show actionable storage error. Preview says old data unavailable/not moved. Explicit replacement never deletes old root and persists only validated new owned root. If old root comes back before commit, replacement aborts in favor of ordinary migration. |

## Evidence files and boundaries

- Save actual native results under artifacts/phase-21/native/ (or Root's fixed equivalent), including operation IDs, version/hash, chosen path, volume IDs, before/after hashes, settings, cache manifests and warm/cold status.
- Save only representative final screenshots. Test-owned WebView profiles and migration outputs belong under ignored scratch locations, not artifacts source snapshots.
- Browser mock clipboard/preview success is not native chooser/clipboard/disk PASS. Forced-copy EXDEV tests are not actual cross-volume proof. Simulated low-space is not a claim that D: was physically filled.
- Existing Excel-paste/DPI/clean-machine/other historical ignored gates remain separate; do not silently promote them to PASS.
