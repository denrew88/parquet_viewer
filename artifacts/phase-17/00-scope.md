# Phase 17 실행 범위

- 시작일: 2026-07-30
- 실행 상태: **진행 중**
- 주제: 빠른 scrollbar·wheel 이동의 적응형 page scheduling

## 목표

느린 스크롤은 현재처럼 보이는 페이지를 즉시 읽고 인접 페이지를 선행 읽는다. 빠른 scrollbar
drag나 touchpad/wheel 이동은 중간 cache miss를 연속 조회하지 않고 논리 위치와 row number만
갱신한 뒤, 입력이 끝난 최종 위치의 foreground page 하나를 우선 조회한다. 이미 cache된 페이지는
속도와 관계없이 즉시 표시한다.

## 제품 계약

1. 스크롤 속도는 120ms 표본 window의 누적 `logical row delta / elapsed time`과 인접 page jump 크기로
   판정한다. 작은 event가 연속되어도 window 안에서 합계가 1 page에 도달하면 빠른 입력이다.
2. 인접 표본에서 2 page 이상 건너뛰거나 120ms window 안에 누적 1 page 이상 이동하는 빠른 입력은 scrub mode로
   전환한다. 한 번 진입한 scrub mode는 느린 중간 표본으로 흔들리지 않고 `scrollend` 또는 마지막
   scroll event 뒤 120ms quiet period에서 종료한다.
3. scrub mode에서 cache miss인 중간 foreground page와 adjacent prefetch는 시작하지 않는다.
4. cache hit는 scrub mode에서도 즉시 active page로 전환한다.
5. scrub 종료 시 최종 visible offset의 foreground page를 정확히 한 번 요청한다. 같은
   offset/projection 요청은 합친다.
6. scrub 진입 전에 시작된 최대 2개의 기존 요청은 늦게 도착해도 최종 위치를 덮어쓰지 못한다.
   이번 Phase는 새 backend cancellation DTO를 추가하지 않으며 이후 중간 요청 자체를 만들지 않는
   것으로 낭비를 제한한다.
7. 느린 wheel/scrollbar 이동, keyboard navigation, selection auto-scroll, segmented recenter,
   source/query page, 마지막 행 geometry와 focus 계약은 유지한다.
8. 200,000행 segmented physical surface는 유지한다. recenter의 synthetic scroll은 사용자 속도
   표본으로 계산하지 않는다.

## 구현 범위

- 순수 scroll velocity/scrub state helper와 경계 단위 테스트
- `VirtualDataGrid`의 scroll sampling, quiet timer, `scrollend`, cache-hit/foreground/prefetch scheduling
- 빠른 입력 시작 시 stale frontend generation 격리와 loading 상태 정리
- 느린/빠른/cached/query/segment/마지막 행 interaction·geometry 회귀
- 세 viewport Playwright와 실제 WebView2 대용량 native smoke

## 제외 범위

- Rust page/query engine, cache format와 DTO 변경
- 새 dependency 또는 Tauri capability 추가
- scrollbar 디자인 변경
- 전체 논리 행을 하나의 DOM scroll height로 만드는 변경
- 이미 backend에서 실행 중인 page read를 취소하는 새 IPC

## 파일 소유권

- Grid 구현 Agent: `src/VirtualDataGrid.tsx`, 새 scroll helper, 관련 component unit test
- Quality Agent: `artifacts/phase-17/10-test-plan.md`, `e2e/phase17.spec.ts`, Phase 17 UI 증거와 독립 검증
- Root Orchestrator: 공통 문서, 통합, 전체 gate와 완료 판정

## 완료 조건

- 빠른 uncached drag에서 중간 foreground page 요청과 prefetch가 0이고 최종 page 요청이 1회다.
- 느린 이동과 cache hit는 대기 없이 표시되고 인접 prefetch 계약을 유지한다.
- source와 filter/sort query에서 row, selection, focus, projection과 stale response가 정확하다.
- 5,850,000행 segmented scroll의 first/middle/last와 실제 마지막 행 geometry가 유지된다.
- frontend unit, Playwright 세 viewport, 실제 Tauri smoke, 전체 회귀와 release/NSIS build가 PASS다.
- 독립 Quality 판정에 HIGH/MEDIUM 결함과 필수 BLOCKED가 없다.
