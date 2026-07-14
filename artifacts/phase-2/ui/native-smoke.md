# Phase 2 Native Smoke

- 실행 파일: `src-tauri/target/release/data-viewer.exe`
- 입력: `fixtures/phase-2/large-types.parquet`
- 파일 선택: 실제 Windows 파일 선택 대화상자
- 결과: 240행, 6열, 3 row group 표시 PASS
- 첫 페이지: 1~200행 표시 PASS
- 정밀도 보존 값 표시 PASS
- 추가 마지막 페이지 캡처: BLOCKED, 실행 중이던 WebView 창 핸들이 캡처 전에 소멸함
- 증거: `native-desktop.png`
