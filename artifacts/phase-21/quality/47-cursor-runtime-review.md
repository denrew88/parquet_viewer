# Cursor focused native/runtime review

Execution mode: independent focused evidence review. **Navigation and constrained-selection PASS; complete native cursor acceptance remains FAIL/pending copy-only retry. No overall Phase approval.**

Evidence inspected: `native/cursor-regression-1g.json`; affected Rust log `2026-11-05T16-14-42-321Z-phase21-cursor-unit.log` (**21 PASS,2 ignored**); actual constrained large test `2026-11-05T16-18-11-558Z-phase21-cursor.log` (**1 PASS**,128MiB engine/512MiB temp, all four orders first/middle/tail with independent rank and next/previous checks). These are distinct from the earlier failed rank implementation and preserve its historical failure.

Quality opened `native/native-cursor-panel.png` as an image input: actual Tauri WebView shows237 distinct values, aligned value/count table, scope/order/search, visible pager and both copy buttons. First-page Previous is disabled and Next available. No panel/footer overlap or clipping; table scroll boundary is intentional. Native report records Next/Previous exact-content roundtrip PASS. Three-viewport browser visual review remains separately documented in45.

| Actual1GiB native control | Observed result |
| --- | --- |
|5.85M text category grouping|Ready, exact5,850,000;2.064s|
|Default first→next→previous|PASS,.870s|
|Middle→next→previous|PASS,9.362s|
|Tail→previous→next|PASS,.882s|
|Legacy value-ascending tail|PASS,.221s|
|Token context/invalid input|PASS; valid token remains usable|
|Small237 values/all four orders|Independent golden PASS|
|Cancel copy after actual work|4096 rows processed of366013 matching, terminal cancelled;2.181s observed cancellation; clipboard unchanged|
|Searched1407-row copy|All1407 rows/2814 cells/40814 bytes serialized; final clipboardWrite FAIL because OS clipboard held by another party|

The failed final copy is an actual failure, not a successful clipboard check. Its precise terminal stage supports a focused fresh retry without rerunning unaffected navigation. The report keeps overall FAIL; `cursor-copy-1g.json` retry remains pending at review time. Do not infer successful Windows publication from serialization or browser clipboard results.

Recorded test overall limit is1,073,741,824 bytes with both CSVs open; sampled app RSS peak233,062,400 bytes and DuckDB spill397,967,360 bytes. These are sampled main-process/own-temp observations, not process-tree or instantaneous maxima. Native evidence records settings restored and prior clipboard text restored, and unchanged source metadata (979,427,914 bytes with recorded mtime). This is not a new full-content source hash guarantee. No user quota increase is needed to claim these constrained navigation results.

No product, runner or common-document edits and no additional test execution were performed by Quality. Copy retry and remaining Phase gates retain their own verdicts.

## Clipboard diagnostic correction

The focused retry `native/cursor-copy-1g.json` again failed at native clipboardWrite. Raw FAIL records above remain unchanged. Reviewed `native/clipboard-probe.json`: both direct clipboard-manager IPC and actual copy worker fail; independent read-only Win32 `OpenClipboard(NULL)` probes fail with **ERROR_ACCESS_DENIED5** at three stages. Open-window/owner handles are0, clipboard sequence stays415, and app/helper are in session1 on WinSta0/Default.

Therefore the library message "held by another party" is **not proof that an external application holds the clipboard**. That earlier causal shorthand is withdrawn. Evidence supports an OS clipboard access restriction in this execution environment; a locked input desktop is a hypothesis pending direct input-desktop evidence, not an established cause. JS clipboard read/restore success and recorded text-restored flags do not prove physical Windows clipboard publication by the product.

**Native Windows clipboard-write acceptance is BLOCKED by observed OS access denial, pending environment clarification and successful actual write/readback.** The original test reports remain FAIL; navigation/serialization/cancellation results retain their scoped verdicts. No product clipboard fix, security change or new build is justified solely by this diagnostic. No overall Phase PASS is issued.

## Clipboard gate closure after desktop access returned

2026-11-06: independently inspected the read-only OS probe log `2026-11-06T02-48-14-310Z-phase21-native-clipboard-os.log`. `OpenClipboard` and close now succeed; input desktop is Default with input access and ChatGPT foreground. This establishes restored access at the retry time; it does not retroactively prove the exact cause of the earlier denial.

Focused native retry `cursor-copy-1g.json` and `2026-11-06T02-48-20-265Z-phase21-native-cursor-copy.log` now **PASS**. Unchanged binary SHA256 `ebb5ed654fe8afb2a1ae2827bfbab5a7d4a40a63c62cc4a87130e4c38878bad9`; actual1GiB/two-CSV conditions;5,850,000-group Ready in2.029s. Search `category-000` matches1407 rows across8 cursor pages. Product copy reaches Complete,2814 cells and40814 clipboard bytes; actual readback equals the reference TSV, SHA256 `b213e03c7521eded18a56456ee1414492fd6b379ec7c220655d9d3b7643a7ce5`. The harness checks exact text equality after product clipboard commit, not merely serialization progress. Settings and previous clipboard text are restored, `settingsChanged=false`, stop failure null; total focused retry14.442s.

**The blocked cursor clipboard-write gate is closed PASS.** Other controls intentionally NOT_RUN in this copy-only retry retain their earlier report evidence, not newly executed PASS claims. Earlier raw FAIL reports/logs remain historical. Combined with the preceding constrained/native navigation and cancellation evidence, the focused column-values cursor change has passed its reviewed gates. Phase21 as a whole remains in progress; the separate C:→D: acceptance and formal promotion are not approved by this closure. No product/common-document change or additional run by Quality.
