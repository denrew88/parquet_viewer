# Phase 5 범위

- 시작일: 2026-07-14
- 목표: 큰 데이터에서도 DOM과 UI thread 사용량이 bounded인 탐색용 그리드를 제공한다.

## 확정 계약

- TanStack Table과 TanStack Virtual을 사용한다.
- 행 overscan 8, 열 overscan 3, page 200행, 다음 page prefetch 경계 40행, 동시 page 요청 최대 2개다.
- 10,000행·120열 fixture에서 DOM 상한은 행 60, 열 32, 데이터 셀 1,500개다.
- header와 행 번호는 고정하고 grid viewport의 높이·열 폭은 상태 변화로 흔들리지 않게 한다.
- column resize, hide, name search를 제공하며 숨김/검색은 source projection과 cache key에 반영한다.
- 긴 값은 한 줄 축약하고 전체 값 확인 affordance를 제공한다.
- 빠른 scroll의 오래된 page/prefetch 결과는 generation으로 무시한다.
- grid focus와 논리 row/column 좌표 API를 Phase 6 selection의 안정적인 경계로 제공한다.

## 완료 조건

- `T-P5-001`~`065` 자동·Browser·native gate를 판정한다.
- frontend/Rust 회귀와 production/Tauri build가 통과한다.
- Browser/native 환경 부재는 대체하지 않고 BLOCKED로 기록한다.
