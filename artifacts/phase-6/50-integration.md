# Phase 6 통합 결과

- 통합일: 2026-07-14
- 상태: 구현 및 자동 gate 완료

## 구현

- DOM과 분리된 anchor, active cell, 정규화 rect selection reducer를 구현했다.
- 셀 click/drag/Shift, 행·열·전체 선택과 Arrow/Home/End/Page/Ctrl/Meta key matrix를 구현했다.
- 가상화 좌표, focus, auto-scroll과 input/resize/inspector key isolation을 연결했다.
- TSV serializer와 200행 projection chunk copy, progress/cancel/stale 차단을 구현했다.
- soft 100,000셀·8MiB, hard 1,000,000셀·64MiB 제한을 적용했다.
- 공식 Tauri clipboard manager plugin과 write-text capability를 연결했다.

## 자동 검증

- frontend format/lint/typecheck/build: PASS
- frontend tests: 102/102 PASS
- selection reducer/key matrix: 18 tests PASS
- TSV/limit: 10 tests PASS
- virtual grid selection/copy: 8 tests PASS
- Rust fmt/clippy/tests: 76/76 PASS
- Tauri release build: PASS

실제 system clipboard와 Excel paste, native screenshot, Browser geometry는 현재 UI 환경에서 확인하지 못했으므로 BLOCKED다.

## 2026-07-19 경계 탐색 성능 보완

- source와 활성 query result에 cancellable boundary command를 추가하고, navigation/document/session/query identity를 왕복 검증했다.
- frontend의 page-by-page 경계 scan을 제거하고 target 좌표 응답 뒤 cache miss target page만 최대 1회 읽도록 변경했다.
- CSV 세로 탐색은 선택 열만 판정하는 단일 sequential reader pass를 사용하며 4,096행마다 취소를 확인한다.
- 모든 `Ctrl+화살표`와 `Ctrl+Alt+화살표` target은 backend가 계산하고, 연속 경계 입력은 앞선 target page 검증 뒤 순서대로 처리한다.
- target page 실패 전에는 selection과 scroll을 확정하지 않으며, 실패·취소·stale 응답은 기존 좌표를 보존한다.
- release native `large-csv.csv` 250,000×40 측정: warm-up 366.82ms, 5회 p95 355.60ms, 각 측정의 `find_data_boundary` IPC 1회, warm cache `read_page` IPC 0회, RSS delta 3,915,776 bytes.
- target cache miss의 `read_page` 최대 1회는 component spy로 별도 검증했다. native artifact의 IPC 값은 frontend invoke telemetry 실측이며 하드코딩하지 않는다.
- native `small-csv.csv`: 빈 셀 경계, 절대 경계, Shift anchor, target 가시성, grid focus PASS.
