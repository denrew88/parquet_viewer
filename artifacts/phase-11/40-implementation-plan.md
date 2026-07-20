# Phase 11 구현 계획

- 상태: 진행 중
- 선행 조건: `00-scope.md`, `10-test-plan.md`, `20-ux-design.md`, `30-technical-design.md` 확정
- 실행 방식: 구현 요청 시 `data-viewer-development-orchestrator` Skill과 전문 Agent 사용

## 1. 역할과 소유

| 역할 | 책임 | 기본 소유 경로 |
| --- | --- | --- |
| Root Orchestrator | 공통 계약, shared DTO/settings, 통합, 문서와 최종 판정 | docs, artifacts, shared files |
| `quality_gate_reviewer` | 구현 전 fixture/expected/perf 계획 감사, 구현 후 독립 gate | fixtures, E2E, artifacts |
| `rust_data_engineer` | OEF H5 v3 source, typed payload, boundary, Parquet query | `src-tauri/src/data/**`, query |
| `grid_ux_engineer` | segmented grid, geometry, formatting UI, interaction test | `src/**`, `e2e/**` |
| `tauri_platform_engineer` | settings persistence, native HDF5/runtime, WebView2/clipboard/package | platform, commands, Tauri tests |

Root는 Cargo/lock, 공통 Rust/TypeScript DTO, settings schema, shared registry와 Phase 상태를 단일 소유한다.
Agent별 정확한 write scope는 구현 시작 시 현재 dirty worktree를 확인한 뒤 기록한다.

## 2. 시작 절차

1. Root가 필수 문서와 사용자 확정 사항을 다시 확인하고 Phase 11을 `진행 중`으로 바꾼다.
2. Quality Agent가 `10-test-plan.md`를 실제 fixture generator, checksum, reference result와 실행 명령으로 감사한다.
3. 현재 release에서 5.85M cutoff, last-row clipping, Ctrl latency, filter/sort/temp warning과 timestamp/string
   baseline을 재현해 증거를 남긴다.
4. shared DTO/settings 변경은 Root가 먼저 통합하고 format/UI Agent가 임의 wire variant를 만들지 않는다.
5. 11A부터 dependency 순서대로 진행하며 완료 gate가 실패한 상태에서 후속 임시 workaround를 넣지 않는다.

## 3. 11A 공통 typed value와 Settings V3

**주담당:** Root + Rust Data + Grid UX 순차 handoff

**Quality:** VAL contract/parity/migration

1. 정밀도를 보존하는 canonical `sourceDisplay`, `rawDisplay`, unit/timezone metadata와
   raw/display/copy formatter contract 및 Rust/TS validator를 추가한다.
2. 기존 DataValue 생성기를 source typed payload 기반으로 이전한다.
3. 타입별 전역 `displayFormats`와 copy representation을 Settings V3에 추가한다.
4. V2 migration, atomic save/backup recovery와 invalid combination validation을 구현한다.
5. timestamp 기본 형식과 string 실제 개행/2줄 default를 고정한다.

완료 gate:

- VAL-001–014 PASS
- 기존 int64/decimal/CSV invalid/null/empty 정밀도 회귀 0
- page/cache memory estimate와 copy snapshot 상한 유지

## 4. 11B OEF H5 v3 source 교체

**주담당:** Rust Data

**협업:** Platform native fixture/runtime

**Quality:** H5V3/security/package

1. old attribute/intensity 구조 validator를 v3 attribute/dataset/`oes` 구조로 교체한다.
2. time/wavelength dataset type matrix와 shape cross-validation을 구현한다.
3. `/oes[w,t]` projected hyperslab read와 bounded transpose를 구현한다.
4. int64 oes, string empty time과 Blosc-Zstd filter pipeline을 검증한다.
5. Schema/Metadata/browser mock/golden fixture를 v3로 갱신한다.

완료 gate:

- H5V3-001–012, PKG-001–003 PASS
- 전체 oes materialize call 0
- arbitrary HDF5, external reference와 unknown compression typed error

## 5. 11C 고정 2줄 grid, column auto-fit과 segmented virtualization

**주담당:** Grid UX

**Root 협업:** shared logical scroll state

**Quality:** VIRT/GEO Browser와 native

1. 하나의 fixed two-line row geometry로 CSS/virtualizer/page navigation을 통합한다.
2. header/cached display 기반 pure auto-fit width 계산과 separator double-click/menu action을 구현한다.
3. logical row↔physical segment mapper와 recenter generation을 구현한다.
4. scroll, scrollbar drag, programmatic jump, selection auto-scroll과 page loading을 mapper에 연결한다.
5. final row bottom geometry와 horizontal scrollbar 공간 계산을 수정한다.
6. 5.85M/10M browser mock interaction, auto-fit, geometry와 screenshot test를 작성한다.

완료 gate:

- VIRT-001–008, GEO-001–006, AFIT-001–008 PASS
- 986,803 부근과 실제 마지막 row mapping 정확
- auto-fit backend/full-column scan 0, 결과 80..800 px와 document state 보존
- 세 viewport와 WebView2 100%/150% DPI clipping 0

## 6. 11D Source-native boundary navigation

**주담당:** Rust Data

**협업:** Grid UX target/focus/queue

**Quality:** correctness/race/performance

1. format별 boundary scanner trait와 target-only DTO를 확정한다.
2. OEF invariant O(1), HDF5 string block scan, Parquet vector scan과 CSV checkpoint scan을 구현한다.
3. query result boundary path와 generation별 interval cache/cancel을 구현한다.
4. frontend 중간 page loop를 제거하고 target page 1회/focus visible 계약을 연결한다.
5. Ctrl/Ctrl+Alt와 두 Shift 조합을 unit/E2E/native performance로 검증한다.

완료 gate:

- NAV-001–010 PASS
- frontend intermediate `read_page` 0
- stale target 적용 0, 실패/cancel selection 원자성 유지

## 7. 11E Parquet query late materialization과 temp UX

**주담당:** Rust Data

**협업:** Grid UX warning/progress, Platform temp storage

**Quality:** reference checksum, plan, resource/lifecycle

1. 현재 `dv_source`와 `query_result`의 typed/raw/display materialization을 측정해 audit한다.
2. predicate/projection pushdown과 최소 result index/late page materialization을 구현한다.
3. stable sort, query paging, distinct/boundary와 source-row identity를 회귀 검증한다.
4. temp admission DTO와 정책을 estimated/safety/hard-cap으로 분리한다.
5. 5.85M과 10M low/high fixture에서 memory/temp/time/cancel/cleanup을 측정한다.

완료 gate:

- QRY-001–011 PASS
- 전체 15열 display/raw duplicate materialization 0
- 26 GiB 오인 경고 0, disk 부족/limit typed error

## 8. 11F 통합 UI, native와 release 검증

**주담당:** Quality

**협업:** Grid UX, Platform

**Root:** 최종 통합과 상태 판정

1. Settings, cell detail, multiline/timestamp copy와 last-row 상태를 세 viewport에서 검증한다.
2. 실제 OEF H5/5.85M Parquet를 Tauri에서 open, navigate, filter/sort, copy한다.
3. Windows 100%/150% DPI, system clipboard와 실제 Excel smoke를 분리 기록한다.
4. frontend/Rust/E2E/native 전체 gate를 코드 확정 뒤 각각 한 번 실행한다.
5. 최종 release/NSIS를 한 번 build하고 clean runtime/install 회귀를 검증한다.
6. Quality가 모든 test ID와 HIGH/MEDIUM defect를 독립 판정한다.

완료 gate:

- UI-001–010, PKG-004–006 PASS
- Phase 1–10 기능·성능·security/package 회귀 0
- 필수 BLOCKED와 HIGH/MEDIUM defect 0
- `50-integration.md`, `90-review.md`, `ui/` 증거 완성

## 9. 실행과 병렬화 기준

- Quality의 테스트 계획 감사는 production 구현 전에 완료한다.
- 11A shared DTO/settings와 11B source DTO 연결은 순차 실행한다.
- 11B H5 source와 11C segmented mapper는 shared DTO 확정 뒤 서로 다른 소유 경로에서 병렬 가능하다.
- 11D는 11B invariant와 11C target focus API가 고정된 뒤 통합한다.
- 11E query engine과 temp manager는 shared value model 확정 뒤 진행한다.
- final formatter, 전체 suite, release/NSIS와 screenshot은 코드 확정 뒤 각각 한 번 실행한다.
- Agent 결과는 Root가 diff와 테스트 증거를 검토한 뒤에만 통합 판정한다.

## 10. 산출물

```text
artifacts/phase-11/
  00-scope.md
  10-test-plan.md
  20-ux-design.md
  30-technical-design.md
  40-implementation-plan.md
  fixture-manifest.json
  benchmark-results.json
  query-plan-audit.md
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

구현 전에는 실행 결과, integration/review나 빈 UI 증거 파일을 만들지 않는다.
