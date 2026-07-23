# Phase 12 통합 기록

- 통합일: 2026-07-21
- 제품 구현: 완료
- Phase 판정: 필수 자동·release·native gate 통과

## 통합한 동작

- DuckDB 결과 index를 ordered source row identity 한 열로 축소하고 200행 identity slice 뒤 sparse projection read
- Parquet RowSelection/projection, CSV checkpoint sparse read와 native typed Parquet filter/sort
- query/document/session/projection 세대 기반 request scheduler, stale 응답 폐기와 비활성 탭 page 정지
- Ctrl/Ctrl+Shift data-region boundary와 Ctrl+Alt absolute boundary의 빠른 query snapshot 탐색
- 명시적 `Ctrl+F` Find, Apply 기반 typed column filter, stable 다중 정렬과 file/column 순서 변경
- filter/sort commit 뒤 논리 좌표 보존, 범위 선택의 active cell 축소와 target mount/focus
- backend streaming copy의 진행·취소·typed 실패·재시도·최근 5회 이력과 atomic clipboard commit
- filtered/sorted selection copy, 64,000-cell backend batch와 wide H5 contiguous hyperslab copy
- Excel 1,048,576행 초과 경고를 표시하되 backend selection을 자르지 않는 동작
- H5 `format` attribute를 읽지 않고 확장자·signature·version/shape/dataset 구조로 판별
- Blosc v1/Zstd 32001 정적 runtime과 4×257 wide-copy fixture
- 마지막 행 전체 geometry와 timestamp/display/raw/copy 표현 분리 유지

## 검증 결과

- Rust format/clippy: PASS, 경고 0
- Rust 기본 suite: 197 passed, 6 ignored; 별도 lifecycle/release/oracle ignored gate 실행 PASS
- 프런트 format/lint/typecheck/build: PASS
- Vitest: 327 passed
- Playwright: 45/45 passed, wide/compact/minimum
- release benchmark: 8 case × cold/warm 5회, 총 80회 PASS
- lifecycle soak: 100 cycle, 201 query, 200 page; handle delta 0, query temp growth 0, retained task/status/result 0
- H5 matrix: 36 case와 product static Blosc/Zstd runtime PASS
- native release: WebView2 100%·150% 모두 PASS
- Windows clipboard: 5,850,000×1 Parquet와 4×257 H5 exact copy PASS
- Excel 16.0: 2×2 TSV exact paste, 1,048,577행 입력의 1,048,576행 worksheet 상한 확인
- release EXE 및 NSIS: build PASS

## 성능 요약

- low/high 단일 정렬 p95: 1.040초 / 1.064초
- low/high prepared random page p95: 6.9ms / 96.3ms
- worst 3-sort p95: 2.734초, 예산 4초
- peak RSS: 640.7MB, 예산 1.5GiB
- native Ctrl/Ctrl+Alt 방향 이동: 최종 100% run에서 모두 82ms 이하
- Phase 11 low fixture의 `category` Ctrl+↓: native p95 47.1ms, boundary IPC 1회,
  target page 최대 1회 (`category-boundary-results.json`)

`category` 후속 회귀에서는 정확한 Parquet row-group 통계가 `null_count=0`이고 최소 문자열이
비어 있지 않을 때만 해당 그룹 전체가 occupied임을 사용한다. 통계가 없거나 부정확하거나 빈값과
일반 값이 섞인 그룹은 기존 Arrow value scan으로 돌아가므로 빈 셀에서 멈추는 Ctrl 규칙은 유지된다.

## 외부 추적

Phase 12에서 요구한 실제 Windows clipboard와 Excel worksheet 상한은 확인했다. clean-machine NSIS 설치는
현재 개발 PC에서 판정할 수 없으며 이전 Phase의 배포 환경 gate로 계속 추적한다.
