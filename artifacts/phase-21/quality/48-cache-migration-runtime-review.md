# C:→D: cache migration independent review

Execution mode: focused independent runtime/evidence review. **Requested scope PASS: actual cross-volume success, restart warm reuse, cancellation and preflight failure preserve originals. This does not approve all Phase21 gates or formal promotion.**

Evidence: `native/migration-only.json` final PASS, unchanged acceptance EXE SHA256 `ebb5ed654fe8afb2a1ae2827bfbab5a7d4a40a63c62cc4a87130e4c38878bad9`; isolated identifier `com.denrew88.data-viewer-phase21-acceptance`. Recorded C/D NTFS volume UniqueIds differ. Root operated the real native picker and UI; Quality independently read the report, manifests/live files and representative screenshot. No product/harness edits or additional test runs by Quality.

| Scenario | Independent result |
| --- | --- |
|m05 actual destination obstruction|InvalidRequest; settings and full original inventory unchanged; obstruction/foreign sentinels preserved. m05b small CSV warm0 source bytes, page/filter/sort PASS. This is a preflight filesystem collision, not a post-copy disk-full test.|
|m07 cancel while copying|Before cancel12,582,912 bytes observed; terminal19,922,944 of407,010,332 bytes, Cancelled. All14 original inventory records exactly equal; directly listed D cancel parent contains only foreign sentinel. m07b large sourceReadBytes0 and row5849999 correct.|
|m09 C:→D: success|Complete,2/2 entries,407,010,332 progress bytes; cleanupFailures empty. All six prepared/states/offset artifacts retain exact SHA256/size and have different device/fileId pairs. Live D artifact SHA256 independently recomputed and matches original.|
|Original cleanup|Live C root contains only `.locks`, `.cache-moved.json`, `.cache.lock`, `.data-viewer-cache.json`; both original entry directories and all prepared artifacts are absent.|
|Restart migrated caches|PID28208→4104; large5.85M warm0 source bytes/60ms, final row5849999; small708-row warm0/34ms, filter/sorted results PASS. Configured cache remains D.|
|New cross-drive publication + second restart|m13 uncached100k-row CSV reads1,877,790 bytes cold, publishes active entry on D, same-process reopen warm0. PID4104→28508; m15 warm0/34ms and final value correct, proving reuse after a real restart.|
|Foreign/settings/process preservation|All five sentinel SHA256 values independently recomputed unchanged. Initial settings restored except the intentionally retained migrated D root in the isolated namespace. Clean finish recorded; original product namespace was not migrated.|

## Manifest and OS identity verification

Compared both original JSONL manifests captured before migration (`.tmp/phase21-native/source-manifests-before-migration.json`) with live D `cache-manifest.json`, matched by canonical source path. For708 and5,850,000 rows, all compared source/profile/schema fields are identical: schema/app version, canonical source path/fileIdentity/bytes/times, profileIdentity, row/column counts, physical layout/mapping, schema contract/fingerprint. Each of parquet/states/offsets preserves bytes and checksum while its fileIdentity changes. All six new manifest fileIdentity strings exactly match the destination inventory's Windows device/fileId representation. This confirms recaptured destination identity rather than merely matching copied Parquet hashes.

## UI and reproducibility review

Opened `native/native-ui-cache-terminal-11.png` as an image: actual Settings shows D location,388.2MiB/2 items and "Cache moved successfully" with2/2 progress; wrapped paths, controls and footer are legible with no overlap/clipping. The retained progress phase says committing, while terminal state is complete; report records final success, not an in-flight screenshot misrepresented as completion.

Reviewed focused runner/harness diff. Dedicated fixed entrypoint, real-picker selection grants, unique owned destinations, copiedBytes>0 cancellation assertion, warm checks and explicit restart commands are reproducible. Initial isolated-namespace guard is restored and requires the acceptance C root; rerunning after migration requires deliberate test-owned reverse/reset. The helper itself does not automate every manifest/cleanup assertion: independent live comparisons above supply those missing integrity checks for this run. Raw reports are preserved. No new blocking harness defect found for this requested scope.

Limits: actual disk full, ACL denial, settings-save failure after copy, crash recovery and offline-drive replacement were **not** rerun natively here. Existing unit/subprocess evidence must retain separate labels; this run cannot promote them to native PASS. No unrelated Phase suite, installer/DPI or formal artifact promotion is implied.
