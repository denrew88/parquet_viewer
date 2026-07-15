# Phase 9 구현 계획

- 상태: 실행 대기
- 선행 조건: Phase 8 구현 유지, `00/10/20/30` 문서 확정
- 실행 방식: 루트 Orchestrator + 전문 subagent, Quality 사전/사후 참여

## 1. 역할과 테스트 책임

| 역할 | Phase 9 책임 | 기본 소유 경로 |
| --- | --- | --- |
| Root Orchestrator | 계약, 공통 DTO, 순서, 통합, dependency 승인과 최종 판정 | 공통 파일과 `docs/**`, `artifacts/**` |
| `rust_data_engineer` | format registry/source, CSV profile, query adapter/result/resource | `src-tauri/src/data/**`, `query/**`, `storage/**`, `domain/**` |
| `grid_ux_engineer` | copy settings, profile UI, filter/search/sort와 문서별 상태 | `src/**` |
| `tauri_platform_engineer` | settings path, dialog descriptor, command/IPC, temp lock/janitor, package | `src-tauri/src/platform/**`, `commands/**`, Tauri config |
| `quality_gate_reviewer` | fixture, contract/E2E/benchmark/UI 증거, 독립 완료 검증 | `artifacts/phase-9/**`, test harness/fixture scripts |

테스트 항목을 Quality Agent만 작성하는 것은 아니다.

- 구현 Agent는 소유 모듈의 unit/component test를 코드와 함께 작성한다.
- Quality Agent는 구현 전에 `10-test-plan.md`의 누락과 측정 가능성을 검토하고 fixture/harness를 준비한다.
- Quality Agent는 구현 후 통합 테스트와 성능/UI/native gate를 독립 실행한다.
- Root는 테스트 기준을 낮추거나 자동으로 baseline을 갱신하지 않고 최종 증거를 판정한다.

## 2. 공유 파일과 병렬 편집 제한

다음 파일은 Root가 직접 편집하거나 한 시점에 한 Agent만 소유한다.

```text
src-tauri/Cargo.toml
src-tauri/Cargo.lock
package.json
package-lock.json
src-tauri/src/lib.rs
src-tauri/src/domain/models.rs
src/backend.ts
src/App.tsx
src-tauri/tauri.conf.json
docs/PROJECT_SPEC.md
docs/DEVELOPMENT_PLAN.md
artifacts/phase-9/*.md
```

공통 DTO를 먼저 고정한 뒤 Rust와 frontend adapter 작업을 handoff한다. 여러 Agent가 같은 lockfile,
manifest 또는 전체 formatter를 동시에 실행하지 않는다. 신규 dependency는 spike 기록과 사용자 승인
전에는 product manifest에 추가하지 않는다.

## 3. Phase 시작 절차

1. Root가 `docs/DEVELOPMENT_PLAN.md`의 Phase 9를 `진행 중`으로 변경하고 시작일을 기록한다.
2. Quality Agent가 `10-test-plan.md`를 테스트 설계 모드로 감사한다.
3. Root가 현재 frontend/Rust test 수, release binary, CSV/Parquet open/random-page 성능을 baseline으로 기록한다.
4. 작업 tree의 기존 사용자 변경과 shared-file 소유자를 확인한다.
5. 9A부터 순서대로 실행한다. 후속 단계가 앞 단계의 미확정 DTO를 임시 복제하지 않는다.

## 4. 9A 입력 포맷 source 리팩터링

**목표:** 기능 회귀 없이 CSV/Parquet 하드코딩을 registry/capability 계약으로 이동한다.

**주담당:** `rust_data_engineer`  
**협업:** `tauri_platform_engineer`, 계약 고정 후 `grid_ux_engineer`  
**Quality:** FMT fixture와 architecture test

### 순서

1. Root/Rust Data가 `FormatDescriptor`, capabilities, common summary/details와 IPC schema를 고정한다.
2. Rust Data가 Parquet/CSV를 `FormatHandler`와 `TabularSource`로 이전한다.
3. Platform이 native dialog와 backend supported-format command를 registry에 연결한다.
4. Grid UX가 descriptor store, generic metadata fallback과 renderer registry를 연결한다.
5. Quality가 test-only handler와 FMT contract suite를 실행한다.

### 완료 gate

- FMT-001~011 PASS
- 기존 Phase 1~5와 Phase 8 open/tab regression PASS
- Phase 8 대비 open/random-page median 회귀 15% 미만
- `App.tsx`, `backend.ts`, `DocumentRegistry`에 새 format별 core 분기를 추가하지 않고 test handler 표시

9A가 PASS하기 전 9C/9D source 계약 구현을 시작하지 않는다. 9B frontend serializer는 shared DTO를
건드리지 않는 범위에서만 병렬 가능하다.

## 5. 9B Copy preset과 settings

**목표:** 기존 copy pipeline을 보존하면서 preset/custom serializer와 persistent settings를 제공한다.

**주담당:** `grid_ux_engineer`  
**협업:** `tauri_platform_engineer`  
**Quality:** serializer golden/round-trip과 native clipboard

### 순서

1. Grid UX가 immutable `CopyOptions`, preset과 delimiter-aware serializer test를 작성한다.
2. Root가 settings IPC/version schema를 고정한다.
3. Platform이 Tauri app config path의 atomic settings store를 구현한다.
4. Grid UX가 split button, settings dialog와 실제 serializer preview를 연결한다.
5. 기존 Ctrl+C/context menu/large-copy pipeline을 같은 snapshot serializer로 통합한다.

### 완료 gate

- CPY-001~011 자동 PASS
- CPY-012 실제 clipboard PASS, 실제 Excel은 환경 부재 시 BLOCKED
- 기존 copy soft/hard limit, cancel과 document 격리 회귀 0

## 6. 9C CSV parsing profile

**목표:** 기본 열기 정책과 사후 typed profile 변경을 raw data 손실 없이 제공한다.

**주담당:** `rust_data_engineer`  
**협업:** `grid_ux_engineer`, `tauri_platform_engineer`  
**Quality:** ambiguous/invalid/wide/10M CSV fixture와 race

### 순서

1. Rust Data가 profile DTO, inference, converter, invalid/null bitmap과 sample API unit test를 구현한다.
2. Grid UX가 독립 profile selection/bulk reducer와 undo component test를 구현한다.
3. Platform이 global default mode와 preview/validation/apply/cancel command를 연결한다.
4. Grid UX가 profile dialog, virtual column grid, sample preview와 validation progress를 구현한다.
5. Rust Data가 prepare/commit session 교체와 query/cache invalidation hook을 구현한다.
6. Quality가 stale preview, validation cancel, apply rollback과 multi-document/process 격리를 검증한다.

### 완료 gate

- CSV-001~020 PASS
- sample preview p95와 validation cancel budget PASS
- 원본 CSV hash가 작업 전후 동일
- invalid/null/empty의 UI, page DTO와 query 의미가 문서에 정의된 대로 구분

## 7. 9D Query engine spike와 선택 gate

**목표:** 정확성, bounded resource와 Windows package 근거로 engine을 선택한다.

**주담당:** `rust_data_engineer`  
**협업:** `tauri_platform_engineer`  
**Quality:** 동일 fixture benchmark와 checksum  
**Root:** 후보 선택과 dependency 승인 요청

### 순서

1. Root/Rust Data가 engine-neutral QueryPlan, QueryResult, QueryBudget과 expected checksum을 고정한다.
2. Rust Data가 DataFusion, DuckDB embedded, 직접 구현 후보의 최소 adapter spike를 각각 측정한다.
3. Platform이 release build/NSIS, temp path, 5-process 실행 가능성을 확인한다.
4. Quality가 low/high 10M Parquet와 large CSV에서 성능/resource/cancel을 독립 측정한다.
5. Root가 `engine-spike.md`를 검토하고 한 후보를 추천한다.
6. native/runtime dependency 추가가 필요하면 사용자 승인을 받은 뒤에만 Cargo manifest에 반영한다.
7. 선택하지 않은 spike product code는 제거하되 결과 문서는 보존한다.

### 선택 gate

- 동일 checksum과 typed/null/invalid/stable-sort correctness PASS
- peak RSS, spill cap, free-space floor와 cancel budget PASS
- release/NSIS build와 독립 multi-process PASS
- 임시 파일 수명주기 PASS
- 선택 이유, version, binary 증가량과 알려진 위험 기록

모든 후보가 gate를 실패하면 9D는 FAIL이다. 임의로 가장 빠른 후보를 선택하거나 page-only sort로
기능 의미를 축소하지 않는다.

## 8. 9E Filter와 search

**목표:** 전체 source/result를 대상으로 typed filter와 global/column search를 제공한다.

**주담당:** `rust_data_engineer`와 `grid_ux_engineer`의 순차 handoff  
**협업:** `tauri_platform_engineer` IPC  
**Quality:** cross-format expected result와 race

### 순서

1. Rust Data가 typed expression validation, query lifecycle와 projected result page를 구현한다.
2. Platform이 execute/status/page/distinct/cancel command를 연결한다.
3. Grid UX가 column filter popover, distinct paging, query bar와 global search를 구현한다.
4. Rust Data가 Parquet pushdown/CSV typed provider 최적화를 구현체 capability에 맞게 연결한다.
5. Quality가 page-only 오동작, stale query, 조합 filter/search와 empty/error를 검증한다.

### 완료 gate

- QRY-001~011, QRY-015~018 PASS
- LIFE-001~003 PASS
- 10M simple filter, random result page와 cancel budget PASS
- filter/search commit에서 잘못된 기존 selection 복사 불가

## 9. 9F Stable sort, spill과 통합 검증

**목표:** multi-column stable sort와 전체 Phase 자원/UX/배포 gate를 완료한다.

**주담당:** `rust_data_engineer`  
**협업:** `grid_ux_engineer`, `tauri_platform_engineer`  
**Quality:** 독립 전체 검증  
**Root:** 최종 통합과 상태 판정

### 순서

1. Rust Data가 stable row identity, multi-sort와 nulls-last를 engine adapter에 연결한다.
2. Platform이 query temp manager, owner lock, janitor, disk monitor와 clear command를 완성한다.
3. Grid UX가 sort priority, query progress/cancel, disk error와 Storage settings를 완성한다.
4. Quality가 QRY/LIFE/TMP/PERF 전체와 8-tab/5-process soak를 실행한다.
5. Quality와 Platform이 Browser geometry/screenshot과 실제 Tauri/native gate를 각각 실행한다.
6. Root가 전체 regression, release/NSIS build와 문서 증거를 검토한다.

### 완료 gate

- QRY-012~014, LIFE-004, TMP-001~009, PERF-001~010 PASS
- UI-001~010 PASS
- frontend/Rust 전체 gate와 release/NSIS build PASS
- HIGH/MEDIUM defect 0, 필수 BLOCKED 0
- `50-integration.md`, `90-review.md`, UI evidence 완성

## 10. 병렬 실행 기준

루트를 포함해 최대 4개 active slot을 사용한다.

- Quality의 fixture/golden 준비는 production 파일과 충돌하지 않을 때 구현과 병렬 가능하다.
- 9A common Rust/IPC contract가 고정되기 전 frontend format adapter를 병렬 구현하지 않는다.
- 9B serializer unit 작업은 9A Rust source 이전과 병렬 가능하지만 `backend.ts`, `App.tsx`, settings IPC는
  순차 handoff한다.
- 9C Rust converter와 Grid UX bulk reducer는 DTO 고정 후 서로 다른 경로에서 병렬 가능하다.
- engine 후보 build/benchmark는 같은 Cargo.lock/target/temp fixture를 동시에 수정하지 않도록 순차 실행한다.
- 9E Rust query와 UI는 mock DTO가 아니라 고정 schema를 공유한 뒤 분리한다.
- 9F는 통합 단계이므로 기능 구현 Agent가 동시에 shared file을 편집하지 않는다.

## 11. Handoff 형식

각 Agent는 다음을 보고한다.

```text
작업 단계와 요구사항 ID
구현/검증 요약
수정 파일
추가하거나 바꾼 계약과 dependency
실행 테스트와 실제 결과
실행하지 못한 테스트와 이유
성능/memory/spill 측정
알려진 위험과 다음 담당 작업
```

Root는 handoff를 받은 즉시 해당 단계 상태만 갱신한다. 마지막에 모든 단계를 한꺼번에 완료 표시하지
않는다.

## 12. 산출물

```text
artifacts/phase-9/
  00-scope.md
  10-test-plan.md
  20-ux-design.md
  30-query-engine-design.md
  40-implementation-plan.md
  engine-spike.md
  fixture-manifest.json
  benchmark-results.json
  50-integration.md
  90-review.md
  ui/
    browser-desktop.png
    browser-compact.png
    browser-minimum.png
    geometry-results.json
    interaction-results.md
    visual-review.md
    native-desktop.png
    native-smoke.md
```

구현 전에는 결과 문서나 빈 증거 파일을 미리 만들지 않는다. 실제 실행 결과가 생길 때 해당 Agent가
작성하고 Root가 판정한다.
