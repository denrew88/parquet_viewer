# Actual native-app validation plan

Scope: experimental native-product-size.exe, original product executable preserved. No product/UI changes.
Owned app data, fixtures, screenshots and scripts remain under this directory. Ports 9481..9484.

| ID | Gate | Expected evidence |
| --- | --- | --- |
| NATIVE-001 | Small CSV regression (below 64MiB) | profile, navigation geometry, filter/sort, actual clipboard, screenshot; explicitly fallback-only |
| NATIVE-002 | Large >64MiB CSV Auto route | actual app preparation status/error and screenshot, no stale prior cache |
| NATIVE-003 | Explicit Auto worker request | original worker DTO with source Auto and resolved typed targets; stdout/stderr/exit |
| NATIVE-004 | Parquet regression | first/last values, schema/metadata and screenshot |
| NATIVE-005 | HDF5 regression | projection 64+1, values, schema/metadata, actual clipboard and screenshot |
| NATIVE-006 | Native-supported large cold/warm lifecycle | after source fixes; require native worker evidence plus cache re-open zero source reads |
| NATIVE-007 | Large preparation cancellation/recovery | after successful native route available; terminal state, stale worker/cache cleanup |

Important source finding: classifier's source threshold is 64MiB, so 10k small CSV tests exercise old
Rust fallback. Classifier permits source target Auto but current converter's Column Target enum does
not, so normal large Auto opens are expected to fail. Preserve pre-fix evidence before runtime changes.

Native filesystem/hardlink and GUI launch may require the root's outside-sandbox runner. Subagent
does not request escalation. No installer, OS file associations or Excel are marked PASS here.

## Pre-fix findings

- **HIGH — app frontend not embedded/loaded:** `diagnose-candidate.json` and screenshots show
  `file:///C:/.../dist/` directory listing, not Data Viewer UI. No app scripts/resources are loaded;
  Tauri invoke returns `Origin header is not a valid URL`. Generated Windows absolute frontendDist
  is parsed as URL because tauri-utils FrontendDist untagged enum lists Url before Directory. Use
  relative path (`../../../../dist`) in generated size variant. Previous 55.85MiB measurement must
  be superseded because it omitted frontend assets. This is separate from converter correctness.
- **HIGH — Auto source profile rejected:** actual internal worker with Auto source + typed resolved
  targets returns exit70/no output. Source classifier allows Auto and source size >=64MiB selects
  that worker, but native enum lacks Auto. Recheck after consolidated root fixes.
- **Isolation caveat:** Windows dirs-sys uses SHGetKnownFolderPath, so LOCALAPPDATA env alone does
  not isolate Release app cache/settings. Exact Tauri app_local_data_dir joins config.identifier.
  A unique generated test-only identifier provides isolation; runtime get_query_temp_usage exposes
  csvCachePath for assertion. Never clear shared user caches.
