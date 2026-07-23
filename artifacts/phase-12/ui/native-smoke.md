# Phase 12 네이티브 스모크 결과

- 판정: **PASS**
- 실행 시각: 2026-07-21T22:21:43.942Z
- 실행 파일: `src-tauri/target/release/data-viewer.exe` (release)
- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)
- WebView URL: `http://tauri.localhost/`
- devicePixelRatio: 1.5

## 검증 항목

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| NATIVE12-PREFLIGHT | PASS | manifest hash·size와 low/high/H5 실제 파일을 확인했습니다. |
| NATIVE12-RUNTIME | PASS | browser mock이 아닌 Tauri URL, Rust invoke와 WebView2 CDP를 확인했습니다. |
| NATIVE12-LOW | PASS | low-cardinality 정렬의 first/986803/last identity와 모든 Ctrl/Ctrl+Alt 방향, PageUp/Down을 확인했습니다. |
| NATIVE12-HIGH | PASS | high-cardinality 정렬의 first/986803/last source identity를 실제 query page IPC로 확인했습니다. |
| NATIVE12-FIND-COPY | PASS | 명시적 Find로 986803행에 이동하고 query-aware 5.85M×1 raw copy와 Windows clipboard를 확인했습니다. |
| NATIVE12-H5-COPY | PASS | 64열보다 넓은 H5 전체 선택을 backend copy하고 clipboard 행·열 및 마지막 행 geometry를 확인했습니다. |
| NATIVE12-TAB-RESTORE | PASS | 20회 tab 왕복 동안 blank/blur/busy frame이 없었습니다. 로드 후 invoke hook 제한으로 page IPC 횟수는 browser E2E 증거를 사용합니다. |

## IPC 계수

```json
{}
```

## 산출물

- `artifacts/phase-12/native-results-150dpi.json`
- `artifacts/phase-12/ui/native-desktop-150dpi.png`
- `artifacts/phase-12/ui/native-smoke.md`

