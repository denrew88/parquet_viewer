# Phase 13 통합 결과

## 통합 판정

Phase 13 제품 구현과 현재 실행 가능한 자동·네이티브 검증은 완료했다. 알려진 HIGH/MEDIUM 코드 결함은 없다. 다만 테스트 계획이 필수로 지정한 일부 성능 행렬과 외부 Windows 환경 검증이 미실행이므로 Phase 상태는 `구현 완료, 필수 performance·external native gate BLOCKED`로 유지한다.

## 구현 내용

- query logical position 기준 occupancy bitmap과 256→4,096→16,384→65,536 adaptive boundary scan
- Parquet accepted occupancy block 8 MiB 상한, 초과 observed 후보 폐기·분할, query/session generation 안전한 bounded cache
- CSV session별 background prepared source와 page/query/copy 재사용, 취소·정리·source fingerprint 검증
- 64,000행 단위 1열 copy 경로와 H5의 행 수에 따른 넓은 column batch
- 파일 탭·컬럼·정렬 criterion 직접 pointer drag, 내부 drag와 Tauri file-drop 분리
- Shift 없는 다중 정렬 panel, 명시적 Ctrl+F/Search, 논리 좌표 focus 유지
- Copy history 및 transient surface lifecycle, 실패 이유와 operation identity 구분
- Timestamp summary/detail 설정과 Arrow/CSV Duration의 display/default/raw copy·query 지원
- 실제 마지막 행 geometry 보정과 세 viewport focus/가시성 유지

## 검증 결과

| 영역 | 결과 | 근거 |
| --- | --- | --- |
| Frontend unit | PASS | 20 files, 353 tests |
| Frontend format/lint/typecheck | PASS | warning 은폐 없이 완료 |
| Playwright 전체 | PASS | 63/63, wide/compact/minimum |
| Rust fmt/clippy | PASS | all targets/features, `-D warnings` |
| Rust 전체 test | PASS | 221 passed, 11 ignored, 0 failed |
| 실제 Tauri/WebView2 | PASS | Rust IPC, Duration, 5.85M Parquet, drag, clipboard, sort/find, final-row |
| release/NSIS build | PASS | release exe와 NSIS installer 생성 |

## 대용량 측정

- 5.85M Parquet filter+3-sort: low 1,063.41ms, high 1,674.98ms
- filtered/sorted Ctrl boundary cold: low 9.90ms, high 10.00ms
- warm boundary p95: low 0.0105ms, high 0.0096ms
- 5.85M CSV prepare: 151.50s, 38,614 rows/s
- prepared CSV page p95: 7.65ms; direct CSV recorded p95 대비 약 233배
- 64,000행×1열 copy p95: 104.76ms, 약 610,940 rows/s
- prepared CSV filter+3-sort: 658.43ms
- sampled peak RSS: 676,880,384 bytes, 1.5 GiB gate 이내
- cancel terminal: 307.88ms, 2초 gate 이내

## release 산출물

- `src-tauri/target/release/data-viewer.exe`: 76,953,600 bytes, SHA-256 `44b402ec34e01ecc061d8d22bff207c810f05ab1a8e669f9c20e6d7f01212cd0`
- `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe`: 13,313,267 bytes, SHA-256 `b7b6e4b931eef786a04f1dbe7c7ed0c5190d7ed0c891209064ec9b6de3425fc2`

## 남은 필수 gate

- BNDPERF의 fixed-width 완전 scan, long-string release RSS/p95, horizontal 20 random, scan 중 cancel 성능 행렬
- CSV prepare 중 foreground 20-page, 20회 query-plan 변경, 100-cycle soak, 전체 5.85M copy/cancel 행렬
- Explorer 실제 external drop, 150% DPI, NSIS 설치본 association/drop/clipboard smoke

위 항목은 현재 알려진 correctness 실패가 아니라 계획된 측정·외부 환경 증거의 공백이다. 수치나 실행 증거 없이 PASS로 바꾸지 않았다.
