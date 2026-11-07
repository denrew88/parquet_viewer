# Phase 22 review — in progress; requested SQL stress PASS

2026-11-08 HAVING 출력 별칭 추천 및 CSV·TSV의 UTF-8 BOM 검증을 통과했다. 제품 Release
0.22.0을 정식 경로에 반영했다. [후속 변경과 검증](92-sql-editor-results.md#2026-11-08-후속-반영)

2026-11-07 SQL 편집기, 실행계획, 결과 내보내기 후속 검증 통과. 실제 Windows 앱에서
7/7건을 확인했고 제품 Release 0.22.0을 정식 경로에 반영했다. 이 기록은 해당 후속 범위의
승격을 다룬다. [변경과 검증](92-sql-editor-results.md) · [실행 파일 기록](sql-editor-export-exe.json)

Latest editor layout behavior PASS2026-11-07: [results](89-editor-layout.md),
[independent review](quality/editor-layout-review.md). Source/browser/native review and full823/213tests,
actual scrollbar/tail, pointer split and newline regression are recorded with initial harness-failure history.
Product Release0.22.0 replaced,60,490,752bytes (+512bytes), canonical/candidate SHA match;
`editor-layout-exe.json`. Remaining Phase-wide gates retain prior status.

Latest optional identifier insertion behavior PASS2026-11-07: [results](88-identifier-insertion.md),
[independent review](quality/identifier-insertion-review.md). Scoped source/browser/native gates PASS:
safe bare spelling, keyword/unsafe escaping and4actual JOIN mode results. Product Release0.22.0 replaced,
60,490,240bytes (+2KiB), canonical/candidate SHA match; provenance `identifier-insertion-exe.json`.
Remaining Phase-wide gates retain prior status.

Latest direct-typing usability behavior PASS2026-11-07: [results](85-editor-usability.md),
[independent review](quality/editor-usability-review.md). Source/browser/native gates reviewed, including
draft provenance during edits/retry, concise JOIN information and actual restart help preference.
Initial full-browser Windows screenshot write failure and successful unchanged targeted rerun remain
separately recorded. Product Release0.22.0 replaced,60,488,192bytes (+512bytes), canonical/candidate SHA
match; `editor-usability-exe.json`. Remaining Phase-wide gates retain prior status.

Latest JOIN/quiet-completion behavior PASS2026-11-07: [results](80-join-completion.md),
[independent review](quality/join-completion-review.md). Full browser189PASS, Rust398PASS;
actual four mode pairs COUNT3, zero SQL calls while typing and settings restart PASS.
Product Release0.22.0 replaced,60,487,680bytes (+17.5KiB), canonical/candidate SHA match;
`join-completion-exe.json` records provenance. Remaining Phase-wide gates retain prior status.

Latest source-lifecycle and full-card selection follow-up PASS2026-11-07:
[results](75-source-lifecycle.md), [independent review](quality/source-lifecycle-review.md).
Native referenced/unrelated source close, source-generation recovery, CSV lease cleanup, preserved dependent
results and six admission interleavings passed. Product Release replaced; exact metadata in
`source-lifecycle-exe.json`. Remaining broader Phase gates retain their prior status.

Latest editor follow-up: [IntelliSense results](70-intellisense.md) and
[independent editor review](quality/intellisense-review.md). Phase-level completion remains separate.

Editor/native result scope PASS; product EXE replaced at the existing release path with version0.22.0,
60,456,960bytes (+118.5KiB/0.2011%). Exact hashes and before/after comparison: `intellisense-exe.json`.
Actual native grid values0/1/2 in both modes, calibrated no-query-on-type, exactly-once execution,
bracket/undo/find and source/settings cleanup passed. OS IME is synthetic-guard coverage only.

Latest follow-up2026-11-06 20:43: SQL per-job storage setting scope PASS (all8SQLSTOREIDs, native9/9,
Rust390/0FAIL/18existing ignored, frontend633, browser159, finalformat/lint/types/clippy). Valid64MiB..10GiB,
default512MiB, schemaV6migration, newtask snapshot, global/physical cap, actual lowerfail/highersuccess and
restart verified. Independent `quality/sql-storage-setting-review.md`; details `65-sql-storage-setting.md`.
Release EXE0.22.0 replaced with60,335,616-byte product build/hash recorded in50-integration.
Prior full-suite intermittent failure is not reproduced this run, not declared permanently fixed. WholePhase
completion/promoting and unrequested remaining native matrix are still separate. Older reviews below are history.

Latest verdict2026-11-06 19:55: actual native stress10/10PASS, independently reviewed in
`quality/stress-review.md`; exact evidence/limits in `60-sql-stress.md`. Corrected0.22.0 product Release EXE
replaced at user-requested path,60,328,448bytes/hash in `50-integration.md`. Build is no longer blocked.
Arrow worker crash, Windows open-file accounting/exclusive-lock compatibility and disk-error normalization
were fixed and validated. Cancellation+cleanup181ms/427ms; all8failure/cancel cases preserve previous result,
reclaim temp files and run exact COUNT/SUM afterward. No OS process-memory hard quota is claimed.

**Full Phase is not complete:** latest full Rust suite383PASS/1FAIL/18ignored; failed CSV-cache corruption
case passes unchanged in isolation but remains an intermittent risk. Unrequested broader native acceptance
(active CSV cache pressure, physical-full disk, parent death, clipboard/UI/security matrix) is still separate.
No installer, formal promotion or external publishing. Older BLOCKED paragraphs below are historical only.

Follow-up2026-11-06 17:25: normal product build now PASS, latest UI included, user-requested Release EXE
replaced with0.22.0 (60,323,328bytes). Earlier4551 no longer reproduced; no agent security-setting changes.
See `50-integration.md` follow-up for logs/hash. Actual Rust tests and native acceptance remain pending,
so Phase is still in progress; the historical build-block description below is superseded for build only.

2026-11-06. Root verdict: **BLOCKED**, Phase remains in progress; no formal promotion.

UI, engine and root implementation are integrated. Quality prepared fixtures/tests before implementation and
independently reviewed final UI images, geometry and backend source. Findings were addressed, including
quoted catalog guards, temporal precision preflight, DTO parity, reserved copy staging and cache migration
admission. No additional confirmed material source defect was identified in the final independent pass.

Frontend593unit tests and153browser assertions passed. Historical evidence restoration subsequently failed in
the browser runner and passed separate SHA-verified recovery; original logs remain intact. Final formatter,
frontend lint/types, compile-only Rust Clippy and Rust test metadata checks passed. Evidence and limits:
[integration](50-integration.md), [UI review](quality/ui-review.md), [backend review](quality/backend-review.md).

Required native gates are **BLOCKED**: Smart App Control is enabled and rejects Cargo's new build-script binary
with OS error4551. Normal Rust build/test execution, EXE linking, real SQL/worker/clipboard/security,
resource/storage/cancel/crash validation and candidate/installer builds have not run. Compile-only checks omit
generated Tauri context and execute no project binaries/tests; browser tests use mocks. Neither substitutes for
these gates. No new EXE exists, existing formal EXE is preserved and Phase22 must not be marked complete.

Resume after Windows permits the normal development build: normal Rust gates, isolated native candidate,
native harness plus full24-case matrix (especially active cancel, parent death, low storage and large-file
resources), fixes, product candidate/installer, final independent acceptance. Formal replacement/promotion
and external publishing remain separate approvals. No security setting was changed or blocked binary bypassed.
