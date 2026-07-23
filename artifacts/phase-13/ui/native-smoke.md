# Phase 13 네이티브 스모크 결과

- 판정: **PASS**
- 실행 시각: 2026-07-22T21:18:16.471Z
- 실행 파일: `src-tauri/target/debug/data-viewer.exe`
- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)
- WebView URL: `http://tauri.localhost/`
- devicePixelRatio: 1

## 검증 항목

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| NATIVE13-PREFLIGHT | PASS | manifest의 585만 행 Parquet와 Arrow Duration 파일 크기·SHA-256을 확인했습니다. |
| NATIVE13-RUNTIME | PASS | 실제 Tauri URL, Rust invoke와 Windows WebView2 CDP를 확인했습니다. |
| NATIVE13-DURATION-OPEN | PASS | CDP 연결 후 native open-paths event를 통해 Arrow Duration 파일을 open_data_paths IPC로 열었습니다. |
| NATIVE13-LARGE-OPEN | PASS | WebView2 연결 후 native open-paths event를 통해 585만 행 파일을 open_data_paths IPC로 열었습니다. |
| NATIVE13-DRAG | PASS | 실제 pointer로 file tab과 column header를 재정렬했고 내부 drag 중 file-drop overlay는 0회였습니다. |
| NATIVE13-DURATION-CLIPBOARD | PASS | Arrow Duration 셀을 실제 Windows clipboard로 복사하고 sentinel 교체를 확인했습니다. |
| NATIVE13-SURFACE-SETTINGS | PASS | transient outside/Escape와 Timestamp/Duration Settings focus·Date-only 숨김을 확인했습니다. |
| NATIVE13-SORT-FIND | PASS | Duration에서 2기준 pointer reorder/apply와 Ctrl+F 명시 실행을 실제 query IPC로 확인했습니다. |
| NATIVE13-FINAL-ROW | PASS | 585만 행의 실제 마지막 행이 WebView2 scrollbar 위에서 완전히 표시되고 focus를 유지했습니다. |

## IPC 계수

```json
{}
```

## 네이티브 경계

- 내부 pointer drag 중 OS file-drop overlay가 나타나지 않는 것은 자동 검증했습니다.
- Explorer에서 실제 파일을 끌어오는 external drop과 NSIS 설치본은 이 자동화에 포함하지 않습니다.

## 산출물

- `artifacts/phase-13/native-results.json`
- `artifacts/phase-13/ui/native-smoke.md`
- `artifacts/phase-13/ui/native-phase13-final.png`

