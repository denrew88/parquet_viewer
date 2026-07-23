# Phase 14 실행 범위

## 1. 목표

Phase 14는 5,850,000행 CSV의 초기 준비와 Ctrl 탐색 병목을 제거하고, 확정된 정렬·Settings·컬럼
reorder UX를 구현한다.

- 원본 CSV의 row-count/checkpoint scan과 query preparation scan을 coordinator 한 작업으로 통합한다.
- 행 단위 DuckDB Appender를 Arrow RecordBatch→Parquet columnar cache로 교체한다.
- source row checkpoint, 2-bit cell-state bitmap, raw/typed cache와 manifest를 같은 scan에서 만든다.
- unfiltered CSV도 state bitmap으로 Ctrl 네 방향을 처리하고 Ready 뒤 원본 CSV navigation read를 0으로
  만든다.
- filtered/sorted query logical occupancy는 기존 adaptive cache와 새 source bitmap을 연결한다.
- multi-sort는 빈 level부터 추가하고 컬럼·방향을 나중에 결정한다.
- Settings typography를 정리하고 Value display formats를 inline primary control+단일 accordion으로 바꾼다.
- column drag는 header와 mounted cell strip이 움직이고 다른 column이 live reflow로 자리를 만든다.
- 원본 source schema 순서를 복원하는 column toolbar action을 추가한다.

상세 데이터 설계는 `30-csv-preparation-architecture.md`, UI 계약은 `20-ui-design.md`를 따른다.

## 2. 제외 범위

- Polars와 DataFusion 도입 또는 기술 스택 교체
- Python subprocess와 외부 CSV converter
- 원본 CSV나 source directory에 cache 쓰기
- 데이터 편집과 export 기능
- Parquet, OEF H5의 source reader 구조 교체
- display setting 변경에 따른 source cache 재생성
- browser mock 결과로 release/native 성능을 대체하는 판정

## 3. 공통 계약

### 3.1 Preparation identity

- preparation key는 canonical path, file identity/size/time, header/profile hash와 cache schema version이다.
- 같은 document/session/generation에는 active worker가 최대 하나다.
- source/profile/session generation이 달라진 worker는 partial 또는 ready artifact를 commit하지 못한다.
- 시작과 commit 직전에 source fingerprint를 확인한다.
- partial artifact는 manifest가 atomic commit되기 전까지 읽기 경로에 노출하지 않는다.

### 3.2 Source read와 자원

- background preparation source read는 원본 크기+1MiB 이하다.
- preview+preparation source read는 원본 크기×1.01+8MiB 이하다.
- foreground source read는 별도 계수이며 Ctrl 탐색 read와 섞지 않는다.
- Ready 이후 Ctrl navigation source read는 0 byte다.
- accepted Arrow RecordBatch의 실제 buffer 합계는 64MiB 이하다.
- writer queue는 최대 2 batch, process peak RSS hard gate는 1.5GiB다.
- cache output은 source 1.1배 제한을 사용하지 않고 구성별 byte와 temporary storage limit을 적용한다.
- active preparation은 기본 1개이며 background document는 queue한다.

### 3.3 Cell state와 값

- state는 valid/null/empty/invalid 네 상태를 보존한다.
- Ctrl occupancy는 valid와 invalid를 occupied, null과 empty를 empty로 본다.
- `0`, `false`, whitespace string과 invalid 원문은 occupied다.
- source/raw/display/default copy 의미, 64-bit integer, Decimal, Timestamp/Duration 정밀도를 보존한다.
- display 문자열을 cache identity나 query/filter/sort 의미로 사용하지 않는다.

### 3.4 Navigation

- unfiltered vertical Ctrl은 source state bitmap word scan을 사용하고 고정 200행 반복을 사용하지 않는다.
- unfiltered horizontal Ctrl은 현재 row의 visible-column state만 읽는다.
- filtered/sorted Ctrl은 query logical position→source row ID→state bitmap gather 순서다.
- Ctrl+Alt는 occupancy/value read 없이 table/visible-column bounds만 사용한다.
- target page만 로드하고 intermediate page request는 0이다.
- preparation frontier 밖의 결과는 같은 worker의 진전을 기다리며 원본 sequential fallback을 새로 시작하지
  않는다.

### 3.5 UI draft와 drag

- incomplete sort draft는 backend plan이 아니며 stable `draftId`를 가진다.
- Value display format은 Settings Apply 전까지 draft이고 Cancel은 backend/cache generation을 변경하지 않는다.
- live reflow는 preview transform이며 pointer move마다 document order/backend를 commit하지 않는다.
- drop에서만 column order를 한 번 commit하고 cancel은 applied order를 변경하지 않는다.
- source-order restore는 visibility, width, query와 active column ID를 유지한다.

## 4. 공유 DTO와 상태

Root가 공통 DTO와 IPC 변경을 단일 소유한다. 최소 상태는 다음을 wire에서 검증한다.

- CSV preparation stage: preparing/ready/cancelled/failed
- rows/bytes progress와 total
- source read byte 계수
- cache output byte와 optional estimated total
- navigation frontier row
- typed terminal error

기존 V4 Settings persistence schema는 값 의미가 바뀌지 않으면 유지한다. UI layout state는 전역 설정에
저장하지 않는다.

## 5. 소유권

| 역할 | 소유 범위 |
| --- | --- |
| Root Orchestrator | scope, 공통 DTO/IPC, `commands/mod.rs`, `lib.rs`, docs, 통합과 최종 판정 |
| Rust Data Agent | `src-tauri/src/data/**`, `query/engine.rs`, `query/sql.rs`, 신규 CSV cache 모듈과 unit test |
| Grid UX Agent | `src/**`의 sort/settings/grid reorder/source-order reset과 component test |
| Quality Agent | `10-test-plan.md`, fixture/audit/benchmark, `e2e/phase14.spec.ts`, 사후 독립 검증 |
| Tauri Platform 검증 | native phase14 smoke, WebView screenshot와 release/NSIS 결과 |

`Cargo.toml`, `Cargo.lock`, `package.json`, lockfile, `src-tauri/src/lib.rs`, 공통 DTO, docs는 Root 단일
소유다. 새 native/runtime dependency가 필요하면 구현을 멈추고 사용자 확인을 받아야 하며 이번 범위에서는
추가하지 않는다.

## 6. 실행 순서

1. Quality Agent가 이 scope와 두 설계 문서를 테스트 ID와 fixture로 구체화한다.
2. Root가 DTO/IPC와 phase status를 고정한다.
3. Rust Data와 Grid UX 구현을 독립 파일 소유로 병렬 진행한다.
4. Quality는 제품 파일을 건드리지 않고 fixture, benchmark와 E2E를 준비한다.
5. Root가 공통 파일과 agent 결과를 통합하고 관련 test를 실행한다.
6. Quality가 독립 검증하고 FAIL을 원 소유 Agent에 반환한다.
7. 전체 frontend/Rust, Playwright, release 성능, 실제 Tauri와 NSIS build를 마지막에 실행한다.

## 7. 완료 조건

- `10-test-plan.md`의 필수 correctness, lifecycle, performance, UI와 native test가 PASS다.
- 5.85M low/high CSV의 background source scan이 한 번이며 preparation 시간이 기존 151.5초 대비 최소
  2.5배 개선되고 60초 hard gate 이하다.
- unfiltered/filtered/sorted Ctrl 네 방향이 target, 빈 셀 의미와 latency gate를 만족한다.
- raw/typed/default copy와 filter/multi-sort가 columnar cache에서 정확히 동작한다.
- blank-first multi-sort, inline accordion, typography, live reflow와 source-order restore가 세 viewport에서
  interaction/geometry/visual gate를 만족한다.
- 실제 Tauri/WebView2 pointer drag, CSV preparation/navigation와 Windows clipboard smoke가 PASS다.
- 전체 frontend/Rust test, lint/typecheck/fmt/clippy, release exe와 NSIS build가 PASS다.
- HIGH/MEDIUM 미해결 결함이나 설명되지 않은 필수 BLOCKED가 없을 때만 완료로 바꾼다.
