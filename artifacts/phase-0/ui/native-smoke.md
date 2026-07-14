# Phase 0 Native Smoke

- 날짜: 2026-07-14
- 명령: `npm run tauri dev`
- 결과: PASS
- 실행 파일: `src-tauri/target/debug/data-viewer.exe`
- 창 제목: `Data Viewer`
- 캡처 크기: 1196x799

## 확인 항목

- Windows WebView 창이 blank screen 없이 열렸다.
- Data, Schema, Metadata 탭과 Open file 버튼이 표시됐다.
- empty workspace에 `No file open` 안내가 표시됐다.
- 실제 Tauri command 결과로 `Backend connected`와 `v0.1.0`이 표시됐다.
- 불필요한 shell 또는 광범위한 filesystem capability는 활성화되지 않았다.

증거: `artifacts/phase-0/ui/native-desktop.png`

