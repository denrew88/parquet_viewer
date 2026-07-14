# Phase 8 native smoke

- 실행일: 2026-07-15
- 대상: `src-tauri/target/release/data-viewer.exe`
- 판정: PASS, 일부 환경 항목 BLOCKED

## PASS

- CSV와 Parquet startup argv를 한 프로세스의 별도 탭으로 열었다.
- Windows `\\?\` canonical path 응답과 일반 요청 path의 비교 회귀를 실제 release에서 확인했다.
- 같은 Parquet를 지정한 5개 process x 20 cycle, 총 100 invocation이 독립 PID와 visible
  top-level window를 유지했다.
- 1024x768에서 실제 우클릭 메뉴를 열고 Copy를 실행해 clipboard `1`을 확인했다.
- 1440x900, 1024x768, 800x600 창 크기에서 blank WebView, clipping, incoherent overlap이 없다.

## BLOCKED

- 150% DPI
- clean VM NSIS install/upgrade/uninstall/reinstall
- 설치본 CSV/Parquet file association double-click
- 실제 Excel paste
