# Phase 13 실행 범위

- 시작일: 2026-07-22
- 상태: 진행 중
- 근거: `artifacts/phase-12/95-follow-up-requests.md`
- 목표: Phase 12 완료 뒤 확인된 대용량 경계 탐색, CSV 재사용 준비, 직접 reorder, 다중 정렬,
  transient UI, timestamp 설정과 Duration 타입의 결함과 확장을 하나의 typed source/query/settings
  계약으로 구현하고 독립 검증한다.

## 1. 포함 범위

### 13A. 공통 값과 설정 계약

- Arrow Duration `s/ms/us/ns`의 signed i64 source count, unit, display/raw/copy DTO
- Timestamp 조합형 설정, Standard/ISO/Date-only preset, 숨김을 포함한 time format,
  timezone suffix와 source wall-clock 비변환
- Duration 표시 preset과 precision 설정
- Rust/TypeScript settings schema migration, validation과 formatter parity
- CSV Parsing Profile의 명시적 Duration target type과 source unit/format

### 13B. query-aware Ctrl 경계 탐색

- grid 200행 page와 분리한 한 컬럼 occupancy batch
- `256 -> 4,096 -> 16,384 -> 65,536` adaptive scan과 최대 block 반복
- row 65,536 후보와 occupancy provider가 채택하는 decoded block 8 MiB의 이중 hard cap. 초과 후보
  Arrow batch는 값을 판정하기 전에 폐기·분할하며 observed 후보와 accepted block을 별도 계수한다.
- query logical position 기준 known/occupied packed bitmap과 LRU/lifecycle
- filter, 단일·다중 sort, source/profile/session/query 교체와 cancellation
- 현재 행의 visible projection만 검사하는 filtered `Ctrl+Left/Right` 경량 경로
- 기존 `Ctrl+Alt+Arrow` absolute boundary와 target-only page IPC 보존

### 13C. CSV prepared source

- 첫 page를 막지 않는 background prepare state machine
- profile generation당 원본 CSV full parse 최대 1회
- typed/raw/state를 보존하는 app-local reusable source와 occupancy bitmap
- page, filter/sort, Find, boundary, distinct, full-cell과 copy의 재사용
- atomic commit, cancel/failure/close/crash cleanup과 generation invalidation
- 5.85M행 low/high-cardinality correctness, latency, RSS와 temp benchmark

### 13D. 다중 정렬 UX

- header click은 ascending/descending/clear 단일 정렬만 수행
- Shift 기반 다중 정렬 기능과 안내 제거
- `Sorts (N)` draft panel에서 전체 logical column 검색·선택
- 방향, 제거, clear, Apply/Cancel과 직접 row drag priority
- hidden column 표시, duplicate 방지, 최대 64 criteria
- filter 다음 ordered multi-sort, source row identity stable tie-breaker와 logical focus 보존

### 13E. 파일 탭과 컬럼 직접 reorder

- reorder 전용 `...`, Move left/right menu 제거
- tab/header pointer drag, threshold, insertion indicator와 edge auto-scroll
- click/close/resize/filter/sort gesture 분리와 ID 기반 상태 보존
- app-internal Pointer Events session과 Tauri external file drag state machine 분리
- path 없는 `over`와 internal drag에서 `Drop data file` overlay/open request 0

### 13F. transient surface와 copy 상태

- Copy history의 controlled popover, outside pointer/Esc/scroll/resize/tab lifecycle
- current/previous operation ID, timestamp, terminal reason 구분
- success status 자동 축소, failure/cancel Dismiss와 필요한 Retry
- Column chooser와 기존 transient surface의 공통 close/focus 계약
- Find bar와 Settings/modal 같은 persistent surface는 accidental outside close에서 제외

### 13G. 간결한 Value display formats UI

- Settings 전체 section을 유지하고 `Value display formats` 내부만 summary/detail로 전환
- 타입별 현재 예시 한 줄과 상세 진입, nested popup/modal 추가 금지
- Timestamp와 Duration의 Preview, Preset, 접힌 Advanced settings
- 세부 변경 시 Custom 전환, All formats 복귀, 기존 dialog Cancel/Apply 재사용
- 실제 production formatter 기반 preview와 grid/default/raw copy parity

### 13H. 통합·성능·native 검증

- unit/component/Rust integration과 wire combination parity
- 세 viewport Playwright interaction, geometry, screenshot과 독립 시각 검토
- 실제 WebView2 pointer/focus/drag/settings/copy와 Windows clipboard
- release 5.85M CSV/Parquet boundary, prepared query/copy, lifecycle/RSS/temp benchmark
- 전체 frontend/Rust gate와 최종 Tauri release/NSIS build

## 2. 제외 범위

- Parquet List/Array의 전체 canonical bulk copy, element filter, length filter와 별도 matrix renderer
- Arrow calendar Interval과 Time32/Time64의 Duration 암묵 변환
- H5 `time`, `wavelength`, `oes` 타입 계약의 Duration 확장
- timestamp 임의 format 문자열과 timezone conversion
- aggregation, group by, SQL editor, 원본 데이터 편집
- 기술 스택 교체, 신규 query engine과 새로운 native runtime dependency

## 3. 확정 계약

- 빈 셀은 `DataValue.state`의 null과 string empty이며 `0`, `false`, invalid, whitespace와 빈 list는
  occupied다.
- bitmap 좌표는 source row ID가 아니라 최종 query logical position이다.
- filter가 row 집합을 정하고 ordered multi-sort가 순서를 정하며 Find는 위치만 탐색한다.
- filtered/sorted selection copy는 같은 logical row와 visible reordered column만 사용한다.
- display format 변경은 source, query, prepared CSV와 occupancy bitmap을 무효화하지 않는다.
- Timestamp 기본 display/default copy는 timezone suffix 없는
  `YYYY-MM-DD HH24:MI:SS.F...`이며 raw metadata는 보존한다.
- Duration은 schema가 명시한 경우만 자동 인식하고 물리 INT64만으로 추측하지 않는다.
- 외부 file drop은 non-empty filesystem path가 확인된 active external session만 open한다.
- Settings 상세는 별도 overlay가 아니며 `Value display formats` section 내부 view 전환이다.

## 4. 작업 트리와 보존 규칙

Phase 12 구현과 증거가 아직 commit되지 않은 dirty worktree에 존재한다. 모든 기존 수정과 신규 파일은
사용자 작업으로 취급해 reset, checkout, 삭제 또는 포괄적 formatter로 되돌리지 않는다. Phase 13은
해당 상태 위에 최소 diff로 구현하고 변경 파일과 기존 변경의 경계를 integration 기록에 남긴다.

## 5. 소유권과 실행 순서

| 순서 | 담당 | 소유 범위 |
| --- | --- | --- |
| 사전 | Quality Agent | 테스트 계획, fixture/benchmark/E2E 소유권 제안 |
| 13A | Root 단일 소유 | 공통 Rust/TS DTO, settings schema/migration, 공유 문서 |
| 13B~13C | Rust Data Agent | `src-tauri/src/data/**`, query/source 구현과 모듈 unit test |
| 13D~13G | Grid UX Agent | `src/**` UI, interaction/component test와 CSS |
| 13H backend | Quality Agent | fixture, benchmark, cross-module integration |
| 13H native | Tauri Platform Agent | native smoke와 실제 WebView/clipboard 증거 |
| 통합 | Root | 공유 파일 충돌 해소, 전체 gate, 문서와 최종 판정 |

공통 DTO와 settings model을 고정하기 전에는 Rust와 UI 구현을 병렬로 시작하지 않는다. 이후 파일
소유가 겹치지 않는 Rust data와 React UI 작업만 병렬화한다. package/lockfile, `src-tauri/src/lib.rs`,
`src/backend.ts`, `docs/**`는 Root가 단일 소유한다.

## 6. 완료 조건

- Quality Agent의 추적 가능한 테스트 계획이 구현 전에 승인된다.
- 13A~13G 제품 계약과 해당 모듈 unit/component test가 구현된다.
- adaptive boundary와 prepared CSV가 정확성·상한·취소·generation·성능 gate를 만족한다.
- 직접 pointer drag와 multi-sort panel이 메뉴/Shift 대체 없이 세 viewport와 실제 Tauri에서 동작한다.
- transient surface와 설정 상세가 focus, outside click, geometry와 기존 modal 계약을 깨지 않는다.
- Timestamp와 Duration이 display/default/raw copy, filter/sort와 precision parity를 만족한다.
- 관련 테스트, 전체 frontend/Rust suite, E2E, release/native/NSIS gate 결과가 기록된다.
- HIGH/MEDIUM 결함이나 미설명 필수 BLOCKED가 없을 때만 Phase 13을 완료로 바꾼다.
