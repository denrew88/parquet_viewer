# Phase 9 native smoke

- 실행일: 2026-07-15
- 대상: 최적화 release 사본과 최종 `src-tauri/target/release/data-viewer.exe`
- 판정: 실행 가능한 native 항목 PASS, 설치/외부 앱 항목 BLOCKED

## PASS

- startup argv로 `fixtures/phase-7/small-csv.csv`를 열고 10,000행·20컬럼을 표시했다.
- 테스트 전용 Tauri config로 WebView2 CDP locator 조작을 수행했다.
- UInt64 comma/dot/space 각각 preview, Apply, 새 session page에 표시했다.
- 99,990,189,981 상당의 최댓값 내림차순 정렬과 `> 50000000000` 5,000행 필터를 확인했다.
- `Shift+ArrowRight`가 `[0,0]`, `[0,1]` 두 셀을 선택했다.
- Custom semicolon과 header를 실제 Windows clipboard에서 확인했다.
- 하네스 종료 후 원래 app settings가 복원됐다.
- 최종 release를 5 process x 20 cycles, 총 100번 실행했고 missing window와 early exit가 0이었다.
- 최종 배포 EXE의 WebView2 원격 디버깅은 비활성화돼 있었다.

## 최종 산출물

- `data-viewer.exe`: 48,085,504 bytes, SHA-256 `48625D6FFEEA508D4A81E1410031A794DACA3130E5428E2322B9D838B7390702`
- `Data Viewer_0.1.0_x64-setup.exe`: 10,918,187 bytes, SHA-256 `2C9080DDD314CEDBAE424A24CFF38B819AF63A50AF29674715FAA85CC8D0FF89`

## BLOCKED

- OS drag-and-drop
- 설치본 CSV/Parquet file association double-click
- 150% DPI
- 실제 Excel paste

Native file dialog와 context menu는 기존 `native-file-dialog.png`, `native-context.png`에 기록했다.
