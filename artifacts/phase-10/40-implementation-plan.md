# Phase 10 구현 계획

- 상태: 실행 완료, 필수 gate BLOCKED
- 선행 조건: `00-scope.md`, `10-test-plan.md`, `20-ux-design.md`, `30-hdf5-design.md` 확정
- 실행 방식: Root Orchestrator + 전문 Agent, Quality 사전/사후 참여

## 1. 역할과 소유

| 역할                      | 책임                                                                | 기본 소유 경로                    |
| ------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| Root                      | 계약, Cargo/lock, 공통 DTO, shared file, 통합과 최종 판정           | docs, artifacts, shared files     |
| `rust_data_engineer`      | OES handler/source, validation, axis binding, hyperslab paging      | `src-tauri/src/data/**`           |
| `tauri_platform_engineer` | HDF5 init, build prerequisite, dialog/drop/startup, package/license | platform, commands, Tauri config  |
| `grid_ux_engineer`        | generic OES mock, capability UI와 wide-grid 회귀                    | `src/**`, `e2e/**`                |
| `quality_gate_reviewer`   | fixture, contract/security/perf/UI/native 독립 검증                 | fixture scripts, tests, artifacts |

Root만 다음 shared file을 수정한다.

```text
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/src/lib.rs
src-tauri/src/domain/models.rs
src-tauri/src/domain/error.rs
src-tauri/src/data/registry.rs
src-tauri/tauri.conf.json
docs/PROJECT_SPEC.md
docs/DEVELOPMENT_PLAN.md
artifacts/phase-10/*.md
```

## 2. 시작 절차

1. Root가 Phase 10을 `진행 중`으로 바꾸고 사용자 변경과 shared-file 소유를 확인한다.
2. Quality가 이 테스트 계획을 fixture/명령/expected checksum으로 다시 감사한다.
3. Phase 9 release EXE/NSIS, build time, CSV/Parquet open/page와 process RSS baseline을 기록한다.
4. 10A부터 순서대로 실행하며 gate 실패 상태에서 후속 production 구현을 임시 진행하지 않는다.

## 3. 10A Native dependency와 보안 spike

**주담당:** Platform, Root manifest 소유  
**Quality:** actual Python golden fixture와 clean runtime

계획 작성 시점의 일반 PATH에서는 `cmake`, `cl`, `ninja`를 찾지 못했다. 이미 설치된 Visual
Studio/MSVC 개발자 셸에서 발견되는지 먼저 확인하고, 없다면 10A prerequisite로 설치한 뒤에만
production 구현으로 진행한다.

1. CMake, MSVC, rustc/cargo version과 cold shell discovery를 기록한다.
2. Root가 pinned hdf5-metno static+blosc-zstd, ndarray와 필요 시 matching sys dependency를 추가한다.
3. process-once plugin lockdown과 Blosc availability 최소 harness를 작성한다.
4. 실제 `sample_current_rules.oes.h5`와 committed golden의 first/middle/last slice를 읽는다.
5. debug/release build, binary imports, EXE/NSIS delta와 third-party license를 감사한다.

완료 gate:

- OES-PKG-001–004와 OES-SEC-004 PASS
- HDF5/Blosc/Zstd loose DLL과 plugin env 의존 0
- CMake/MSVC prerequisite와 resolved Cargo feature tree 기록
- license redistribution 계획 확정

## 4. 10B OES source와 구조 계약

**주담당:** Rust Data  
**Quality:** format/axis/security fixture

1. `OesHdf5FormatHandler`, descriptor와 typed errors를 구현한다.
2. root hard-linked intensity와 external/VDS/storage 차단을 구현한다.
3. axis size preflight, process budget lease와 bounded decode를 구현한다.
4. time/wavelength type와 deterministic column binding을 구현한다.
5. FileSummary, Schema와 generic Metadata를 구성한다.
6. format contract와 malformed fixture test를 작성한다.

완료 gate:

- OES-FMT-001–008, OES-AXIS-001–009, OES-SEC-001–006 PASS
- arbitrary HDF5를 OES로 오인하지 않음
- validation 실패에서 handle/axis lease 누적 0

## 5. 10C Bounded page, projection과 lifecycle

**주담당:** Rust Data  
**Root 협업:** 공통 initial projection/cache key  
**Quality:** chunk boundary, wide/tall, race와 copy

1. time-only와 coalesced intensity hyperslab page를 구현한다.
2. 200행, 64열, chunk 64 MiB와 checked arithmetic 상한을 적용한다.
3. wide source 최초 page를 format-neutral 최대 64열 projection으로 바꾼다.
4. actual projection cache key와 DocumentRegistry close/stale lifecycle을 검증한다.
5. 기존 selection/copy pipeline에 generic source로 연결한다.

완료 gate:

- OES-PAGE-001–008, OES-INT-001–008, OES-SEC-007–009 PASS
- 전체 intensity materialize call 0
- CSV/Parquet initial page와 cache regression 0

## 6. 10D Entry point와 generic UI

**주담당:** Platform과 Grid UX의 순차 handoff  
**Quality:** Browser와 실제 Tauri

1. registry descriptor를 dialog/drop/startup과 browser mock에 연결한다.
2. generic Data/Schema/Metadata와 capability-hidden query control을 component test로 고정한다.
3. wide wavelength virtual columns, selection, keyboard와 clipboard를 Playwright로 검증한다.
4. 실제 Tauri dialog, OS drop, startup argv, Unicode/공백 경로와 mixed batch를 검증한다.
5. `.h5/.hdf5` association이 installer에 추가되지 않았음을 확인한다.

완료 gate:

- OES-UI-001–008 PASS
- 전용 OES React renderer/dataset selector 없음
- CSV/Parquet dialog/drop/startup/native clipboard 회귀 0

## 7. 10E 성능, release와 독립 완료 검증

**주담당:** Quality  
**협업:** Platform  
**Root:** 최종 통합과 상태 판정

1. low/high large fixture manifest와 checksum을 감사한다.
2. release open/random projection, axis/process memory와 8-tab soak를 측정한다.
3. 2~5 release process가 같은 OES를 독립적으로 여는지 확인한다.
4. 전체 frontend/Rust/E2E/native gate를 실행한다.
5. 최종 release/NSIS를 한 번 만들고 clean runtime/install/uninstall을 검증한다.
6. Quality가 HIGH/MEDIUM defect와 모든 test ID를 독립 판정한다.

완료 gate:

- OES-PERF-001–007, OES-PKG-005–007 PASS
- 전체 gate와 Phase 1–9 회귀 PASS
- 필수 BLOCKED와 HIGH/MEDIUM defect 0
- 실제 결과가 `50-integration.md`, `90-review.md`, `ui/` 증거에 기록됨

## 8. 병렬 실행 기준

- 10A manifest/lock/build는 단일 소유로 순차 실행한다.
- Quality fixture 생성은 product source와 충돌하지 않을 때 10A/10B와 병렬 가능하다.
- 10B OES source 계약이 고정되기 전 frontend mock DTO를 임의로 만들지 않는다.
- 공통 initial projection은 Root가 단독 통합한 뒤 OES paging과 frontend를 handoff한다.
- native release/NSIS build와 Cargo dependency 변경을 동시에 실행하지 않는다.
- 최종 formatter, 전체 suite, release build와 screenshot은 코드 확정 후 각각 한 번 실행한다.

## 9. 산출물

```text
artifacts/phase-10/
  00-scope.md
  10-test-plan.md
  20-ux-design.md
  30-hdf5-design.md
  40-implementation-plan.md
  dependency-spike.md
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

구현 전에는 dependency 결과, integration/review나 빈 UI 증거 파일을 만들지 않는다.
