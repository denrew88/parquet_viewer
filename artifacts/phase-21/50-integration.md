# Phase 21 integration — draft

Latest execution checkpoint (2026-11-05 KST): final Rust 352 PASS/16 historical ignored; Clippy/fmt, portable 0.21.0 and NSIS build PASS. Native exact237/filtered118 clipboard, settings boundary sessions, typed values, copy cancellation, active-cap reclaim/oversize Ready and 5.85M distinct have individual passing evidence on the final acceptance EXE. The final partial run also verifies actual chooser cancellation. The user stopped Computer Use with the physical Escape key before actual C:→D: migration/restart/offline acceptance. The test process exited and restored clipboard text/settings; existing formal0.20.0 EXE remains unchanged. Phase21 is still in progress and unpromoted. Actual cross-volume migration, native recovery and final independent acceptance remain pending.

State: in progress; native acceptance and final candidate validation remain. No formal EXE replacement or external release.

## Integrated behavior

- A separate Column values panel exposes exact whole-source/filtered snapshot totals, search, stable value/frequency sort, bounded pages, cancellation and full matching TSV copy. Existing filter value selection remains independent.
- Schema 5 adds a dedicated CSV cache cap and selected managed root. Effective cache cap is min(overall, configured cache cap). Active leases survive cap reduction; last close reclaims inactive overage. Oversize persistent results remain usable as bounded session preparation rather than failing only because they cannot be retained.
- Native folder selection issues an opaque one-use grant. Migration freezes admissions, requires closed documents/pending opens/other-process leases, copies with bounded buffers, verifies content, recaptures file identity, commits settings, then removes owned originals. A durable journal recovers process death around commit. Foreign files/reparse paths are protected. Missing configured drives leave Settings reachable and support explicit replacement without deleting old data.
- Cross-volume publication after migration checks full remaining destination allocation plus 5GiB reserve separately from logical relocation credit. Query-temp and cache volume space are checked independently.

## Implementation ownership and boundaries

- Rust query: `src-tauri/src/query/column_values.rs`, engine lifecycle and existing copy pipeline. SQL page/search/copy use cancellation/interrupt and budget monitors, including filtered snapshots. A worker permit remains charged until actual thread exit; at most 16 live workers.
- Rust cache: `storage/csv_cache.rs` and `csv_cache/migration{,/recovery}.rs`. Cache slot accounting and automatic reclaim require validated owned entries. Generic settings and migration share a process-wide OS control lock, preventing stale settings from restoring an old directory.
- Platform: thin commands, native dialog plugin, migration admission/status, delayed initialization for offline cache roots. No new dependencies, runtime libraries or capabilities.
- React: column values panel, dedicated cache cap, native location preview/progress/cancel, offline explanation; header actions preserve the center drag area.
- Fixtures: `fixtures/phase-21/`, independent generator/golden; existing large input is referenced at `fixtures/phase-20/performance/main-high/` without duplication.
- Native runtime variant is synchronized recursively by `scripts/sync_native_runtime.cjs`, preserving the established native CSV converter. Candidate EXEs remain under `src-tauri/target/release/candidates/`, outside artifacts.

## Executed verification

| Gate | Result | Evidence |
| --- | --- | --- |
| Frontend unit/component | 468 PASS / 25 files | `artifacts/dev-check/2026-11-05T04-24-36-435Z-frontend-test.log` |
| Frontend format/lint/3 TypeScript configs | PASS | `2026-11-05T04-25-03-548Z-*` logs; later scoped header CSS/type checks by UI agent |
| Full browser regression | 125 PASS, 10 FAIL initially | `2026-11-05T04-24-36-457Z-phase21-e2e.log` |
| All failed browser ranges + Phase 21 | 24/24 PASS after product fix | `2026-11-05T04-28-33-308Z-phase21-e2e.log`; tests unchanged |
| Phase 21 screenshots/geometry | 9+9 PASS, independent image review | `ui/visual-review.md` |
| Rust full lib suite | 345 PASS / 16 historical ignored | `2026-11-05T04-26-14-180Z-phase21-test.log`; later physical-space helper and final Clippy cleanup require final run |
| Rust fmt + all-targets Clippy `-D warnings` | PASS | `2026-11-05T04-31-29-401Z-phase21-format.log`, `2026-11-05T04-31-31-477Z-phase21-clippy.log` |
| Production embedded frontend | PASS | `2026-11-05T04-30-49-422Z-frontend-build.log` |

The full browser run exposed a new header button covering the old center drag start. A scoped right inset fixes that product regression without altering drag tests. One tab/pending-page timeout passed on targeted rerun. Each browser regression run preserves and SHA-verifies 192 historical evidence files; existing Phase records were not replaced by Phase 21 captures.

Initial Rust failures exposed mismatched slot accounting and legacy manifestless fake fixtures. Production now counts the same validated owned entries it may reclaim; tests use real valid entries and still assert cross-process leases, LRU, bounds and lock blocking. A new 17-foreign-directory test verifies no deletion and successful managed publication.

## Remaining gates

Final Rust run after physical-copy reserve change; isolated release native chooser/Windows clipboard/high-cardinality/cache cap/C:→D: migration/restart/warm and new publication/offline recovery; production-identifier candidate build/version/hash; packaging gate; final independent review.

Browser mocks and injected EXDEV tests do not establish native clipboard or actual separate-volume success. Historical Excel/DPI/clean-machine gates remain separate and unexecuted unless explicitly evidenced.

## Native integration findings and fixes (2026-11-05)

The initial native run is retained in `native/before-copy-sort-fix.json`; its overall result is FAIL, not acceptance.
It exposed two product defects that browser mocks could not establish:

1. Copying 237 distinct values stopped after a bounded 200-row batch. CopyManager treated a short batch as EOF despite `has_more=true`. The shared reader contract now accepts nonempty bounded partial batches and advances by actual rows, while empty pages, premature EOF, stale projection and overlarge returned ranges fail atomically. Real CopyManager tests cover 237/512/4301 rows with/without counts, two 4MiB values, and configured byte limits. Independent review: `quality/40-copy-batch-review.md`.
2. CSV prepared values can be canonical VARCHAR despite a numeric/temporal logical schema. The distinct table previously used physical string sorting. Logical sort/group keys now preserve integer/unsigned64, arbitrary plain decimal precision, nanoseconds/timezone equality, boolean, date, duration and Float64 semantics. Typed-equivalent spellings group together with a deterministic existing display representative. Independent review identified a NULL struct-key category issue; that fix and extra real CSV category tests are being integrated.

Rust after the copy fix: 349 PASS/16 ignored (`2026-11-05T05-02-27-881Z-phase21-test.log`).
Rust including the initial real CSV logical-type matrix: 350 PASS/16 ignored (`2026-11-05T05-08-59-615Z-phase21-test.log`).
Two earlier executions were blocked before any test ran by Windows application control error4551; they are environment failures, not assertion failures or PASS results.

The pre-fix native candidate separately established:

- A 406,997,553-byte leased persistent cache remains readable after lowering cap to 64MiB; final close reclaims it to zero without reapplying settings. The next oversized preparation reaches Ready using bounded session temp, with zero persistent active entries.
- 5,850,000 exact distinct values complete in 1,799ms; only 200 values are returned to the first page. Cancellation reaches the tested terminal path in 485ms. Sampled main-app RSS peak is 216,891,392 bytes (this is not process-tree preparation peak memory).
- A 5,850,000-cell copy fails with `selectionLimit` at zero processed rows under the configured 1,000,000-cell cap.
- C: and D: have distinct OS volume UniqueIds; owned test parents and foreign sentinels were prepared, but no actual migration has yet passed.

The original clipboard text and isolated settings were restored when the pre-fix process exited. Clipboard format restoration beyond plain text was not tested. The native folder-control tool timed out waiting for application access; the user subsequently authorized access. Final chooser and actual C:→D: checks remain pending until executed on the rebuilt candidate.

Final NULL category/profile run: 351 PASS/16 ignored (`2026-11-05T05-19-33-435Z-phase21-test.log`). Independent typed-key review closes the struct-key NULL finding in `quality/41-typed-key-review.md`.

A subsequent focused review confirmed stale offline-cache reuse: offline replacement cannot put a redirect onto a missing source drive, and a cached service previously reused its old root when that drive returned. Runtime caches now bind the authoritative settings directory before being published; both initial startup and migration reopen are wired. Cached command settings are checked before changing limits, and every global cache operation rechecks saved location before restore/publish/reclaim/clear. Active sessions are not silently rebound. A real SettingsStore regression preserves a readable old root without a redirect, rejects its usage/cap change/clear, preserves its cap/sentinel, and accepts a new bound cache. Independent source closure: `quality/42-stale-offline-root-review.md` (runtime pending). Fmt and all-targets Clippy pass in `2026-11-05T05-31-22-986Z-*` / `2026-11-05T05-31-24-865Z-*`; final Rust run and isolated native rebuild are `05-33-32` / `05-33-42`.

## 1GiB high-cardinality string failure (2026-11-06 KST)

User conditions: overall managed storage 1GiB, `distinct-pages.csv` open alongside
`fixtures/phase-20/performance/main-high/high-5850000x15.csv`, whole-source `category` values.
The 25-byte text column has exactly 5,850,000 distinct values. Each query receives at most half
the overall limit, so the DuckDB spill allowance is 512MiB. The engine memory limit remains 128MiB.
The initial 10GiB diagnosis was a different condition and did not reproduce the reported error.

The existing app reproduced the exact `QueryTempLimitExceeded` / safe-disk-allowance message on both
1GiB runs. Evidence: `native/category-regression-1g-before-fix.json` and
`../dev-check/2026-11-05T14-36-41-666Z-phase21-native-category-1g.log`.
The MIN aggregate retained an additional variable-length representative per string group even though
the grouping keys already determine that representative. The String-only COUNT path reconstructs valid,
invalid, empty and null display values from the unchanged keys. All other logical types retain MIN,
including decimal and timestamp representatives. No quota, reserve, cache policy or user setting was changed.

Validation after the fix:

- Rust: 353 PASS, 17 explicitly ignored; `../dev-check/2026-11-05T15-16-25-253Z-phase21-test.log`.
- Rustfmt and all-targets clippy with `-D warnings`: PASS; `15-16-18-845Z` / `15-19-29-950Z` logs.
- Actual prepared Parquet at 128MiB / 512MiB: old MIN path fails; production String path returns exactly
  5,850,000 groups in 3.353s. Small full-DTO parity compares the old MIN algorithm independently against
  the production algorithm, including valid/invalid raw collisions, empty values, null aliases and counts.
  Evidence: `../dev-check/2026-11-05T15-19-50-867Z-phase21-category.log`.
- Isolated Tauri with 1GiB and both CSVs open: group counts and the first 200 rows under default
  count-descending and value-ascending orders PASS twice. Group elapsed 2.719s / 2.879s.
  One-second sampled main-app RSS peak: 221,437,952 bytes, compared with 547,897,344 before;
  sampled own-query DuckDB spill peak: 393,838,592 bytes, compared with 543,195,136 before.
  These are observed samples, not a process-tree or exact instantaneous peak guarantee.
  Both preparations were existing-cache hits; this does not establish a fresh 1GiB conversion run.
  Evidence: `native/category-regression-1g.json`, `../dev-check/2026-11-05T15-26-05-622Z-phase21-native-category-1g.log`.
  The acceptance namespace's original settings were restored and equality-checked; clipboard was not accessed.

**Separate unresolved issue:** value-ascending offset 5,849,800 still fails with a DuckDB 128MiB
allocation/pin error, including at 10GiB before this fix. It is distinct from the reported grouping
quota error. The test records the failure and its overall result remains FAIL. Window-ranking SQL
passed supplementary Rust diagnostics but has not been adopted or proven in the actual native path.
This focused fix does not close that issue, the cross-volume migration gate, or Phase 21 acceptance.
The root release EXE and prior installer are not replaced by this draft build.
Production-identifier rebuild PASS (`../dev-check/2026-11-05T15-27-21-811Z-phase21-build.log`):
`src-tauri/target/release/candidates/phase-21/data-viewer.exe`, embedded version 0.21.0,
59,546,112 bytes. Current candidate/native/root hashes and historical installer status are recorded
in `20-build.json`; the installer predates this fix and was not rebuilt.

## Cursor paging and copy follow-up (2026-11-06 KST)

User explicitly authorized the proposed Column values pager/copy changes. Main-grid behavior,
panel layout, quotas/reserves, runtime dependencies and security capabilities are unchanged.
The optional nullable request cursor and required nullable next/previous response tokens are
snapshot-local, bound to search/order/offset/limit/direction, capped at256 entries and30minutes.
Tokens contain no user values or paths. Shared18-case wire fixtures cover UTF-8 size, Unicode
whitespace, missing/null/type/NUL and offset/limit/unknown-field boundaries in Rust and TypeScript.

Native typed keys, NULL placement, category flags, representative ties and final immutable rowid
determine seek order. Previous reverses every order term/NULL placement then reverses the result.
UI commits offset and rows together, resets cursors on context changes, ignores late responses,
and preserves the same token for retry after a failed page. It has no unbounded page-history list.
Copy uses at most4096 rows and the existing8MiB byte preflight, reuses the same anchor while
shrinking, advances only after validated emitted rows, and retains at most4 anchors.

The first cursorless-middle compatibility implementation sorted row identities with WINDOW rank.
Its four middle reads genuinely exceeded512MiB in `../dev-check/2026-11-05T16-04-24-744Z-phase21-cursor.log`;
first/tail reads passed. This failure is retained. The replacement samples at most257 rowids,
sorts only that sample's exact DB keys, counts rows before the pivot and shrinks the range.
At most4096 remaining candidates use bounded TopN; refinement is capped64 iterations and checks
task cancellation and the budget before every SQL statement. No full middle sort or SQL OFFSET
remains in production paging/byte-preflight. Sampling affects progress, not the exact selected rank.

Validation:

- Frontend495/495; format/lint/three TypeScript configs PASS (`15-51-03-930Z` / `15-51-03-933Z`).
- Full browser135/135 across1440×900,1024×768,800×600 PASS, preserving192 historical evidence files
  (`../dev-check/2026-11-05T15-52-21-612Z-phase21-e2e.log`). Nine pager images/geometry records and
  final source independently reviewed in `quality/45-cursor-ui-review.md`.
- Full Rust run:357PASS,18ignored, one pre-existing cache identity test failed on Windows file
  access-denied (`15-56-54-838Z`). That test alone passed in `16-00-59-744Z`; the failure was not hidden.
  After the middle-path correction, the affected module passed21 tests/2ignored in25.78s
  (`16-14-42-321Z`). Latest all-targets clippy/fmt PASS (`16-14-27-108Z`). Independent algorithm,
  NULL/category/order, token, actual CopyManager partial/long-value, cancellation, UInt64 max and
  2^53-neighbor tests are included. See `quality/46-cursor-backend-review.md`.
- Actual prepared5.85M category at128MiB memory/512MiB temp: all four orders' first/middle/tail
  plus independently checked ranks, seek roundtrips and copy byte selection PASS
  (`../dev-check/2026-11-05T16-18-11-558Z-phase21-cursor.log`). Direct-middle selection took6.23–7.59s;
  first/tail took0.16–0.20s. This establishes the corrected path within the unchanged caps.
- Actual isolated Tauri,1GiB and both CSVs open:237-value UI button roundtrip/screenshot and four-order
  small-fixture golden comparison PASS; category total5,850,000 Ready in2.064s; first/next/previous,
  middle/next/previous(9.362s combined), tail/previous/next and legacy tail PASS. Invalid/mismatched
  tokens are rejected and valid tokens remain reusable. Source size/mtime metadata unchanged;
  both preparations used existing cache entries. Native sample peak RSS233,062,400 bytes and own
  DuckDB spill397,967,360 bytes are sampled observations, not instantaneous/process-tree guarantees.
- Actual searched copy cancellation after4096 of366,013 rows reached Cancelled in2,181ms, with
  no late commit observed. Search `category-000` selected1407 values; all1407rows/2814cells serialized
  to40,814bytes before the OS rejected clipboardWrite. The failed copy alone was retried, with the
  same final OS error. Original raw FAIL reports remain `native/cursor-regression-1g.json` and
  `native/cursor-copy-1g.json`; they are not relabeled as PASS. See `quality/47-cursor-runtime-review.md`.

**Historical environment block (resolved below):** actual Windows clipboard publication/exact TSV comparison was BLOCKED.
`native/clipboard-probe.json` shows both plugin IPC and the worker failing, and an independent
Win32 OpenClipboard(NULL) probe also returning access-denied5 with no open/owner HWND.
`native/clipboard-os-probe.json` observes WinSta0/Default, input desktop Default, and foreground
process LockApp; clipboard sequence remains415. This is evidence of an OS restriction with the
lock screen active, not proof that another normal app holds the clipboard. No external process,
desktop, lock or security setting was changed. WebView clipboard read/write checks are not proof
of physical Windows clipboard publication while Win32 access is denied. The targeted unlock/retry closure is recorded below.

Production and isolated0.21.0 builds PASS (`16-26-25-034Z` / `16-19-39-923Z` build logs); current sizes,
versions and hashes are in `20-build.json`. Product candidate59,623,936bytes; isolated candidate59,623,424bytes.
The user-copied root EXE and historical installer are unchanged. This is a draft follow-up, not
Phase21 completion or formal promotion; the unrelated actual cross-volume migration gate also remains open.

## Clipboard gate closure — 2026-11-06 11:48 KST

The user confirmed Windows unlock. The read-only OS probe now successfully opens/closes the
Windows clipboard, with foreground process ChatGPT instead of the earlier LockApp observation
(`../dev-check/2026-11-06T02-48-14-310Z-phase21-native-clipboard-os.log`). No security setting or product code changed.

Only the previously blocked copy was rerun using the unchanged isolated candidate SHA256
`ebb5ed654fe8afb2a1ae2827bfbab5a7d4a40a63c62cc4a87130e4c38878bad9`.
`phase21-native-cursor-copy` PASS (`../dev-check/2026-11-06T02-48-20-265Z-phase21-native-cursor-copy.log`):

- Same1GiB overall limit and both CSVs open; existing-cache5,850,000 category snapshot Ready in2,029ms.
- Search `category-000`:1,407 matching values retrieved through8 bounded reference pages.
- Actual native copy completes1,407rows/2,814cells/40,814bytes; physical clipboard text equals the entire expected TSV.
- Clipboard content SHA256 `b213e03c7521eded18a56456ee1414492fd6b379ec7c220655d9d3b7643a7ce5`.
- Original settings and clipboard text restored, settingsChanged=false, no cleanup/stop error.
- Latest targeted report: `native/cursor-copy-1g.json`; unaffected controls explicitly NOT_RUN,
  retaining the earlier full native navigation/cancellation evidence rather than claiming a new full run.

The historical locked-state failures remain in their timestamped logs and full native report.
The requested cursor/copy follow-up acceptance is now PASS across the full run plus targeted retry,
independently closed in `quality/47-cursor-runtime-review.md`. No rebuild, SQL feature implementation,
new Phase artifacts, formal root EXE replacement or Phase21-wide completion was performed.
