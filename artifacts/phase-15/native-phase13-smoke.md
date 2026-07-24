# Phase 13 네이티브 스모크 결과

- 판정: **BLOCKED**
- 실행 시각: 2026-07-24T13:18:37.634Z
- 실행 파일: `src-tauri/target/debug/data-viewer.exe`
- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)
- WebView URL: `연결 전 실패`
- devicePixelRatio: 확인 불가

## 검증 항목

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| NATIVE13-PREFLIGHT | PASS | manifest의 585만 행 Parquet와 Arrow Duration 파일 크기·SHA-256을 확인했습니다. |
| NATIVE13-CDP | BLOCKED | small CSV bootstrap과 실행별 신규 debug data-root를 사용해도 WebView2 CDP 포트가 열리지 않아 native interaction을 실행하지 못했습니다. |

## IPC 계수

```json
{}
```

## 실패

```text
Error: WebView2 CDP endpoint did not start: Error: browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9333
Call log:
[2m  - <ws preparing> retrieving websocket url from http://127.0.0.1:9333[22m

```

## 네이티브 경계

- 내부 pointer drag와 file-drop overlay 분리는 WebView2 단계에 도달하지 못해 검증하지 못했습니다.
- Explorer에서 실제 파일을 끌어오는 external drop과 NSIS 설치본은 이 자동화에 포함하지 않습니다.

## 산출물

- `artifacts/phase-15/native-phase13-results.json`
- `artifacts/phase-15/native-phase13-smoke.md`

