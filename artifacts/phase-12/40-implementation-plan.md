# Phase 12 구현 계획

- 상태: 12A~12H 구현 및 검증 완료
- 선행 조건: `00-scope.md`, `10-test-plan.md`, `20-ux-design.md`, `30-technical-design.md` 승인
- 실행 방식: 구현 요청 시 `data-viewer-development-orchestrator` Skill과 전문 Agent 사용
- 제한: 승인된 12A~12H 순서를 지키고 Quality 사전 감사 전에 production 구현을 병렬 시작하지 않는다.

## 1. 역할과 소유

| 역할 | 책임 | 기본 소유 경로 |
| --- | --- | --- |
| Root Orchestrator | 공통 계약, DTO, 통합 순서, 문서와 최종 판정 | docs, artifacts, shared DTO |
| `quality_gate_reviewer` | 구현 전 fixture/reference/perf 감사, Phase 12 E2E와 구현 후 독립 검증 | scripts의 Phase 12 fixture/audit, `e2e/phase12.spec.ts`, artifacts |
| `rust_data_engineer` | result index, page identity, Parquet/CSV sparse read, query boundary, H5 구조 판별과 bulk copy | `src-tauri/src/query/**`, `data/**` |
| `grid_ux_engineer` | projection scheduler, keyboard/focus, Find, tab/column reorder와 copy 상태 | `src/**`와 component/unit test |
| `tauri_platform_engineer` | native clipboard, performance harness, app-local temp/lifecycle, release smoke | scripts, platform, native artifacts |

공통 Rust/TypeScript DTO와 query position 계약은 Root 단일 소유다. query SQL과 source sparse provider는
Rust Data가 맡되 같은 shared file을 여러 Agent가 동시에 수정하지 않는다. Quality는 production 구현을
소유하지 않고 fixture/reference와 독립 검증을 담당한다.

## 2. 구현 전 절차

1. Root가 사용자 검토 의견을 문서에 반영하고 Phase 12 상태를 `진행 중`으로 바꾼다.
2. 현재 dirty worktree와 Phase 11 변경을 확인하고 사용자 변경을 보존한다.
3. Quality Agent가 IDX/PAGE/NAV/RACE/PERF/LIFE/QUX/COPY/H5/UI ID를 실행 가능한 fixture, oracle,
   명령과 증거 파일로 감사한다.
4. low/high 5.85M fixture를 결정적으로 생성하고 hash/schema/cardinality를 확인한다.
5. 현재 release에서 sort, first/middle/last page, 연속 PageDown과 pending baseline을 다시 기록한다.
6. shared DTO와 result metadata 설계를 먼저 통합한 뒤 backend/frontend가 임의 variant를 만들지 않게 한다.
7. H5 `format` 의존, 200행×64열 copy 반복, filter/sort focus reset과 tab 복귀 IPC를 failing test로 고정한다.

## 3. 12A 테스트 기반과 shared contract

**주담당:** Root

**Quality:** fixture/reference와 failing regression test

1. `ReadQueryPageRequest.columns` Rust/TypeScript DTO와 parity validator를 추가한다.
2. query logical result columns와 `DataPage.columns` projection을 분리한다.
3. 5.85M low/high manifest와 deterministic page/source identity reference를 작성한다.
4. 현재 2열 index, unbounded join과 pending을 재현하는 실패 테스트를 먼저 고정한다.
5. backend page decode audit와 frontend IPC/pending instrumentation을 test-only로 추가한다.
6. copy operation DTO, query-aware selection snapshot과 H5 구조 판별 matrix의 parity contract를 확정한다.
7. `generate_phase12_fixtures.py`와 독립 auditor를 small smoke로 실행하고 manifest/reference hash를 고정한다.

완료 gate:

- 테스트가 기존 결함을 실제로 FAIL로 재현한다.
- fixture hash/schema/reference가 제품 DuckDB와 독립적으로 검증된다.
- wire DTO parity와 invalid boundary matrix가 확정된다.

## 4. 12B 1열 result index와 physical position

**주담당:** Rust Data

**Quality:** IDX SQL/plan/lifecycle

1. ordered source identity 한 열 table을 만들고 결정적 order의 `INSERT ... SELECT`로 materialize한다.
2. 같은 connection에서 materialization transaction commit 뒤 read-only lifetime transaction을 시작하고 종료 시 rollback하는 수명주기를 구현한다.
3. 모든 stored `__dv_result_position` 참조를 qualified `query_result.rowid`로 이전한다.
4. count/min/max invariant, empty result와 typed failure를 구현한다.
5. filter→sort와 sort→filter equivalence, find position, nulls-last/multi-column stable 결과를 회귀 검증한다.
6. cancel/failure/replace/close에서 incomplete index commit과 temp 누적을 차단한다.

완료 gate:

- IDX-001~008 PASS
- query result schema에 source identity 외 value/position column 0
- 5.85M low `group_id ASC` release index p95 1.5초 이하

## 5. 12C Two-stage page와 source sparse read

**주담당:** Rust Data

**Root 협업:** shared page DTO

**Quality:** PAGE decode/projection/checksum/performance

1. query connection 안에서 최대 200개의 position/source identity만 읽는 함수를 분리한다.
2. mutex 해제 시점을 unit instrumentation으로 검증한다.
3. `QueryInputProvider` sparse projection contract를 추가한다.
4. Parquet row group mapping, ProjectionMask와 RowSelection path를 구현한다.
5. CSV checkpoint grouping과 profile-aware sparse read를 구현한다.
6. timestamp exact, binary/nested preview, invalid/null/empty와 output order를 통합한다.
7. read/detail/find 호출부를 새 position→source identity path로 이전하고 bulk copy에는 같은 identity primitive만 공유한다.

완료 gate:

- PAGE-001~010 PASS
- source-before-limit 전체 join 0
- low page p95 250ms, high random page p95 1초 이하
- page identity 200/projection 64와 decoded resource audit 준수

## 6. 12D Grid projection, tab restore와 request scheduler

**주담당:** Grid UX

**Root 협업:** query state/result metadata

**Quality:** RACE와 UI interaction/geometry

1. mounted logical columns를 query page `columns`로 전달한다.
2. logical result columns를 projected DataPage와 분리해 horizontal virtualization을 유지한다.
3. foreground와 prefetch queue, same-key dedupe와 generation invalidation을 구현한다.
4. foreground 완료 전 adjacent prefetch를 억제한다.
5. query complete와 first page를 원자적으로 commit한다.
6. stale/error/cancel에서 loading key와 `aria-busy`를 정확히 정리한다.
7. inactive tab의 virtualizer/request를 pause하고 document별 page/scroll/segment/projection snapshot을 보존한다.
8. tab 활성화 `useLayoutEffect`에서 geometry와 focus를 paint 전에 복원하고 cache hit page IPC를 막는다.
9. query commit 전 logical row와 column ID를 snapshot해 새 결과에 clamp하고 range를 active cell 하나로 축소한다.
10. 실제 마지막 row의 content/border가 horizontal scrollbar 위에 완전히 보이도록 scroll surface geometry를 수정한다.

완료 gate:

- RACE-001~007, UI12-001~005 PASS
- 빠른 scroll/연속 PageDown의 permanent pending 0
- query first page와 horizontal projection의 wrong-column 0
- cache-valid tab 복귀 page IPC, blank/blur/loading flash와 stale focus commit 0

## 7. 12E Query navigation 이전

**주담당:** Rust Data + Grid UX 순차 handoff

**Quality:** table-driven keyboard, race와 native performance

1. absolute navigation을 query row count와 logical projection에 연결한다.
2. PageUp/PageDown target-only page load와 focus commit을 연결한다.
3. non-null O(1) query boundary fast path를 구현한다.
4. nullable/string bounded position block scanner와 occupancy/boundary cache를 구현한다.
5. horizontal boundary를 한 row의 projected values로 계산한다.
6. Ctrl/Ctrl+Alt와 Shift 조합의 queue, cancellation과 target page 검증을 통합한다.
7. query가 없는 CSV/Parquet/OEF navigation 회귀를 실행한다.

완료 gate:

- NAV12-001~013 PASS
- intermediate page IPC 0, target page cache miss 최대 1
- selection/focus stale commit 0
- navigation 성능 예산 충족

## 8. 12F Backend streaming copy와 H5 판별

**주담당:** Rust Data + Platform 순차 handoff

**Quality:** COPY12/H5 matrix, resource, clipboard atomicity와 native 성능

1. `.h5/.hdf5`와 signature 뒤 version/shape/dataset/type/filter 구조를 검증하고 `format` 검사를 제거한다.
2. copy operation DTO, task registry, progress/cancel, typed terminal error와 bounded history source를 구현한다.
3. query position→source identity block과 source별 batch reader를 copy task에 연결한다.
4. 5.85M행×1열 Parquet/CSV vertical streaming TSV path를 구현한다.
5. wide H5의 cell/decoded/serialized byte 기반 adaptive hyperslab path를 구현한다.
6. bounded memory/app temp staging 뒤 native clipboard one-shot commit과 failure cleanup을 구현한다.
7. partial/whole selection이 filtered/sorted row와 visible/reordered column만 사용하는지 검증한다.

완료 gate:

- COPY12-001~012, H5-001~008 PASS
- 5.85M×1 copy의 page/value IPC 0과 bounded RSS/temp/cancel 충족
- H5 fixed 64-column group 제거, unknown compression typed error와 clean-runtime Blosc/Zstd PASS
- clipboard success one-shot, failure/cancel previous clipboard 보존

## 9. 12G Find, reorder와 multi-sort UX

**주담당:** Grid UX

**Quality:** QUX interaction, accessibility, geometry와 screenshot

1. 전역 match-only Filter mode를 제거하고 header typed filter를 유지한다.
2. `Ctrl+F` Find draft/committed state와 명시적 `조회`/Enter, Esc, previous/next를 구현한다.
3. document tab drag/keyboard reorder를 session/cache identity와 분리한다.
4. document별 column ID order, header drag/keyboard move와 selection/copy visual index resolve를 구현한다.
5. multi-sort summary/panel에서 priority, direction, remove와 reorder를 제공하고 Shift+header plan과 통합한다.
6. current copy operation과 bounded previous history, progress/Cancel/Retry와 typed reason을 표시한다.

완료 gate:

- QUX-001~010과 관련 UI12 PASS
- Find typing backend call 0, explicit query 1회와 stale result 구분
- reorder 뒤 width/visibility/filter/sort/focus/copy order 보존
- three viewport와 keyboard/screen-reader contract PASS

## 10. 12H 통합·native·release 검증

**주담당:** Quality

**협업:** Platform, Grid UX, Rust Data

**Root:** 최종 통합과 Phase 판정

1. low/high 5.85M과 기존 10M query correctness/resource benchmark를 실행한다.
2. 실제 release Tauri에서 sort, first/middle/last scroll, 20회 PageDown/Up과 모든 Ctrl 조합을 검증한다.
3. query-aware 5.85M×1 copy, wide H5 copy와 Windows clipboard/Excel warning을 검증한다.
4. 세 viewport Playwright interaction, geometry와 screenshot을 독립 검토한다.
5. query cancel/replace/tab close, 20회 tab 왕복과 multi-document/copy lifecycle을 반복 검증한다.
6. 코드 확정 뒤 frontend/Rust/E2E 전체 gate를 각각 한 번 실행한다.
7. 최종 release/NSIS를 한 번 build하고 loose runtime dependency와 Phase 1~11 회귀를 확인한다.
8. `50-integration.md`, benchmark/plan audit, UI evidence와 한국어 `90-review.md`를 작성한다.

완료 gate:

- `10-test-plan.md`의 필수 ID 전체 PASS
- HIGH/MEDIUM 제품 결함 0
- 필수 performance/native/UI 증거 누락 0
- 이전 Phase의 BLOCKED 외부 환경 항목은 해소되지 않은 경우 별도로 계속 기록

## 11. 실행 순서와 병렬화

- Quality 테스트 계획 감사가 production 구현보다 먼저다.
- 12A shared DTO/result metadata는 모든 구현의 선행 조건이다.
- 12B result index와 12D frontend scheduler의 test scaffold는 소유 파일이 겹치지 않으면 병렬 가능하다.
- 12C는 12B position contract 뒤에 진행한다.
- 12D backend 연결은 12C page DTO가 고정된 뒤 통합한다.
- 12E는 12B~12D가 모두 통과한 뒤 시작한다.
- 12F copy는 12C identity/provider primitive 뒤 진행하고 H5 구조 판별은 소유 파일 충돌을 피하도록 순차 통합한다.
- 12G Find/reorder UI scaffold는 shared state가 확정되면 가능하지만 copy status 통합은 12F DTO 뒤 진행한다.
- 12H는 12A~12G 완료 뒤에만 시작한다.
- 전체 formatter, suite, final screenshot과 release build는 코드 확정 뒤 각각 한 번 실행한다.
- 리뷰 지적은 모아서 한 번에 수정하고 같은 gate를 반복 실행하지 않는다.

## 12. 변경 예상 영역

```text
src-tauri/src/query/sql.rs
src-tauri/src/query/engine.rs
src-tauri/src/data/source.rs
src-tauri/src/data/parquet_source.rs
src-tauri/src/data/csv_source.rs
src-tauri/src/data/oes_hdf5_source.rs
src-tauri/src/domain/models.rs
src-tauri/src/commands/mod.rs
src-tauri/src/copy/**
src/backend.ts
src/App.tsx
src/VirtualDataGrid.tsx
src/query/**
src/** tests
e2e/phase12.spec.ts
scripts/native_query_page_perf.mjs
scripts/generate_phase12_h5_matrix.py
scripts/audit_phase12_h5_matrix.py
scripts/run_phase12_bench.py
artifacts/phase-12/**
```

새 dependency, 권한, source write와 query engine 교체는 예상하지 않는다. 구현 중 필요해지면 진행을
멈추고 사용자 승인을 받는다.

## 13. 산출물

```text
artifacts/phase-12/
  00-scope.md
  10-test-plan.md
  20-ux-design.md
  30-technical-design.md
  35-architecture-explanation.md
  40-implementation-plan.md
  fixture-manifest.json        # 구현/검증 때 생성
  reference-pages.json         # 독립 query page/source identity oracle
  fixture-audit.json           # schema/hash/cardinality/reference 재검사
  benchmark-results.json       # 구현/검증 때 생성
  query-plan-audit.json        # plan/trace/decode machine-readable audit
  query-plan-audit.md          # 위 audit 요약
  lifecycle-results.json
  copy-results.json
  h5-matrix-results.json
  native-results.json
  e2e-evidence-map.json       # UI handoff 전 selector 없는 test-ID/evidence scaffold
  50-integration.md            # 구현/검증 뒤 생성
  90-review.md                 # 독립 검토 뒤 한국어로 생성
  ui/
    {query-loading,find,multisort,column-reorder,copy-failure-history,tab-restore,last-row}-{wide,compact,minimum}.png
    geometry-results.json
    interaction-results.md
    visual-review.md
    native-desktop.png
    native-smoke.md
```

설계 검토 단계에서는 실행 결과, 빈 evidence 파일과 완료 판정 파일을 미리 만들지 않는다.
