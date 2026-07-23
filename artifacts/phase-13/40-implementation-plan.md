# Phase 13 구현 계획

## 실행 순서

1. **13A shared contract — Root**
   - Settings V4, V1/V2/V3 migration
   - Rust/TypeScript Duration value, CSV profile와 query scalar wire enum
   - Timestamp/Duration pure formatter와 parity unit test
2. **13B boundary — Rust Data Agent**
   - occupancy batch, packed bitmap LRU, query logical mapping, horizontal fast path
3. **13C CSV prepare — Rust Data Agent**
   - state machine, typed prepared source, generation/cancel/cleanup와 counters
4. **13D/13E UI — Grid UX Agent**
   - Shift-free multi-sort, direct tab/header/criterion pointer and keyboard reorder
5. **13F/13G UI — Grid UX Agent**
   - transient lifecycle, copy status/history, settings summary/detail
6. **13H quality — Quality/Tauri Agents**
   - fixture/oracle, E2E/geometry/screenshot, release/native/clipboard/NSIS
7. **Integration — Root**
   - shared conflict, full gate, spec/plan/integration/review update

## 병렬화 규칙

13A가 관련 unit test와 함께 PASS한 뒤 13B/13C와 13D~13G를 병렬 실행한다. Rust Data Agent는
`src-tauri/src/data/**`, `src-tauri/src/query/**`와 할당된 모듈 test, Grid UX Agent는 `src/**` UI와
component test를 소유한다. `src/backend.ts`, Rust/TS settings domain, package/lockfile, lib/commands,
`docs/**`와 Phase 조정 문서는 Root만 수정한다. Quality는 제품 구현 파일을 수정하지 않는다.

## 구현 중 test

- 13A: settings/domain/display formatter의 Rust/TS 관련 unit test
- 13B: boundary/bitmap/query engine 관련 Rust test와 small fixture
- 13C: CSV parser/profile/source/prepare lifecycle 관련 Rust test
- 13D~13G: component/model test와 영향 Playwright desktop-minimum
- 통합 뒤: frontend/Rust 관련 묶음, lint/typecheck/clippy
- 코드 확정 뒤: 전체 frontend/Rust, 세 viewport E2E, release/native/NSIS를 각 한 번

## 완료 판정

`10-test-plan.md`의 필수 ID와 artifact가 모두 PASS인 경우에만 `50-integration.md`, `90-review.md`와
`docs/DEVELOPMENT_PLAN.md`의 Phase 13 상태를 완료로 바꾼다.

