# Phase 25 Settings redesign / Open folder — draft test plan

Execution mode: test design, before implementation. Root approval is required before product or E2E edits. Evidence stays under `.tmp/phase-25/settings/`; preserve formal EXE SHA-256 `F303CC4808A98724088529B7A546C4EF249117481E5AD7CBFB826FC6D0CE5D59`.

## Contract and accessible surface

- Existing `Application settings` dialog becomes left navigation / right content with CSV, SQL, Copy, Display and Storage. Proposed widget: vertical tablist `Settings categories`, five named tabs and their labelled tabpanels; CSV initially selected. Inactive panels stay mounted/hidden so draft and migration state survive navigation. Only active controls participate in keyboard focus.
- One global draft and Apply/Cancel. Preserve validation, save failure, focus restoration, storage migration/recovery and formatter/preview semantics. Reset formats belongs to Display and changes only display-format draft fields.
- App sans font inherited by settings UI: title18px, section14px, controls13px, descriptions12px. Preview examples remain legible across all eight existing types. SQL headings must use a sufficient line box instead of clipping at20px.
- `get_storage_locations()` returns `{csvCache:{path,available},queryTemp:{path,available}}` from authoritative backend roots. CSV uses the saved effective custom/default location; temporary data uses app-local-data/query-temp. Resolving/displaying either path must not require QueryService initialization or create directories.
- `open_storage_folder(kind)` accepts only `csvCache`/`queryTemp`; no frontend path argument. Resolve/check the current backend directory at click time. Unknown kinds, missing/offline/non-directory targets and OS launch errors do not open an unrelated folder, create one, or fall back to CSV. No dependency/capability expansion.

## Traceability

| ID | Completion condition and PASS criterion | Layer / owner |
| --- | --- | --- |
| T-P25-S01 | Five categories, default CSV, one visible labelled panel; pointer and keyboard navigation, focus trap/Escape/restore exclude hidden panels | UI unit; Quality browser |
| T-P25-S02 | Edit CSV, SQL, Copy, Display and Storage drafts, navigate away/back, Cancel/reopen restores saved values; one Apply commits all valid fields once | UI unit; browser + existing native settings |
| T-P25-S03 | Hidden invalid draft still blocks Apply; return to its category shows unchanged error/value; inclusive copy/storage/SQL limits, save failure and busy disabling retain existing assertions | UI/model unit; existing strict E2E |
| T-P25-S04 | Computed fonts match18/14/13/12px and app sans; SQL heading line box/text not clipped; all eight Display summary/detail previews legible | Browser computed style/geometry + screenshots |
| T-P25-S05 | Display Reset formats appears in Display, resets all eight draft types using existing defaults, preserves other-category drafts and stays unsaved until Apply; current inline detail toggles/focus remain intact (no new Back/subpage flow) | UI/formatter unit; browser |
| T-P25-S06 | Both actual paths visible and distinguishable even when usage/query initialization fails; long paths wrap/scroll within their row; available flag controls the corresponding Open folder only | UI/transport unit; browser mock |
| T-P25-S07 | Backend default/custom CSV and query-temp root resolution is independent, current and read-only; get/open unavailable paths creates no folders or QueryService | Rust unit; platform engineer |
| T-P25-S08 | Open action sends only correct kind; unknown kind rejected; an extra frontend path cannot redirect target. Spaces/Unicode/shell metacharacters are literal OS arguments, no shell-string construction | Rust launch-spy/DTO unit; transport unit; independent review |
| T-P25-S09 | Missing/offline/file-instead-of-directory disables Open; availability race or launch failure yields actionable error without wrong-folder fallback; successful metadata refresh clears stale error; no open on render/category navigation | UI + Rust unit; browser |
| T-P25-S10 | Cache migration/picker grant, cancel/failure/offline recovery, dirty-storage gating and completed current-path refresh remain correct while categories switch; no lost draft or duplicate launch | Existing CacheLocationControls units + Phase21 E2E |
| T-P25-S11 | 1440x900,1024x768,800x600: navigation, SQL heading, Display summary/detail, Storage roots/actions and global footer reachable; no accidental overlap/clipping/page overflow | Quality browser interaction, geometry JSON and independent image review |
| T-P25-S12 | Exact draft Windows EXE: both Open folder actions open Explorer at their actual distinct backend roots; query target is query-temp, not CSV. Default/custom-root representative settings and error path retain application state | Native WebView2 + actual Explorer target evidence; Root/platform, Quality review |

## Fixtures, evidence and execution

- Reuse existing display examples (String/Integer/Decimal/Date/Timestamp/Duration/Boolean/Binary), settings boundary corpus, CSV-profile and SQL/Copy/Storage regression fixtures. Browser mock supplies distinct default/custom paths including spaces/Unicode, long names, unavailable location and launch failure; no large dataset is needed.
- Implementers own settings/navigation/draft/formatter/component tests and Rust resolution/enum/launch-spy/no-create tests. Quality writes only assigned independent Settings E2E/native extensions after approval; no product files or common docs.
- Required browser evidence: each viewport's CSV default, SQL heading, Display summary plus representative detail, Storage two roots (including unavailable/error state), and navigation with cross-category draft. Record text/control/ancestor bounds, font family/size, horizontal page overflow, footer reachability and click hit tests. Dialog/content/path-row intended internal scroll is the only declared overflow exception.
- Native evidence must record candidate path/version/hash, `get_storage_locations` values and actual Explorer destination (Shell window path/address, not merely invoke success). Use the isolated acceptance profile, restore settings, and touch only task-owned Explorer windows. A direct fresh backend unit proves no initialization/directory creation; normal CSV preparation/query can make roots available for native open verification.
- All execution uses fixed `node scripts/dev-check.mjs TASK [FILTER]` entries assigned by Root. Focused units/E2E during implementation; final format/lint/typechecks, Rust format/clippy/related/full checks and common full browser suite once after convergence. Final draft build once, then exact-binary native smoke. Retry only failed/changed scope. No installer, formal promotion or existing EXE replacement.

## Risks / approval points

1. Unmounting a category can silently reset drafts, selected type, migration tokens/polling or busy state. Hidden panels must not trap focus or duplicate accessible controls.
2. Paths are committed/current state, not unsaved Storage draft or last migration preview. Refresh after successful migration and recheck on open; never reuse the CSV path for query-temp.
3. A nonexistent/offline root must still be displayed without canonicalization/QueryService side effects. Get/Open must not create it; a missing root is not permission to create or open its parent.
4. OS Explorer verification is mandatory for Open folder. Browser mocks or successful `Command::spawn` alone cannot establish the actual target. Report unavailable native evidence as BLOCKED.
5. Existing Settings tests must explicitly navigate to the intended category. Preserve exact values, migration/cancellation protections and boundary assertions rather than hiding new panels or weakening expectations.

Root approval requested for this contract and test ownership before implementation.
