# Phase 15 Quality 사전 설계 리뷰

- 리뷰 범위: `00-scope.md`, `10-test-plan.md`, `30-csv-polars-architecture.md`,
  `40-implementation-plan.md`
- 기준 근거: Phase 14 high CSV Rust/Polars profile, 구현·통합 기록, `90-review.md`
- 판정: **조건부 승인 — 아래 HIGH 항목을 테스트 계획에 반영하기 전에는 구현 완료 gate가
  추적 가능하지 않음**
- 코드·공유 문서 변경: 없음

## 1. 확인된 강점

- 58.38초의 병목을 parser가 아니라 값 변환, 46열 Parquet, 274만 회 bitmap write와 cache
  재복사로 분해한 근거가 충분하다.
- DuckDB query를 유지하고 Polars를 CSV preparation provider 경계에만 두는 선택은 회귀 범위를
  합리적으로 제한한다.
- Auto 타입 추론을 bounded sample 뒤 no-modal로 진행하고, 표본 이후 cast 실패를 타입 변경이 아닌
  `invalid`와 raw 보존으로 처리하는 방향은 제품 계약과 일치한다.
- Polars 채택을 시간 하나가 아니라 RSS, 취소, dialect, raw/state parity와 실행 파일 증가량으로
  판단하도록 한 점은 적절하다.
- Phase 14의 미충족 성능·architecture gate를 숨기지 않고 Phase 15로 승계했다.

## 2. HIGH — 구현 전에 보강해야 하는 항목

### `Q15-H01` 2-pass source byte gate가 독립 테스트 ID와 계수 의미를 갖지 않는다

현재 바이트 상한은 `P15-PERF` 표 아래 설명으로만 존재한다. 이 상태에서는 fingerprint, preview,
fallback 또는 foreground page가 만든 세 번째 scan을 어느 counter에 넣을지에 따라 같은 실행을
PASS 또는 FAIL로 만들 수 있다.

필수 보강:

- `P15-BYTE-001`: source handle의 실제 `Read` 반환 바이트를
  preview/structure/conversion/foreground/navigation별로 계수한다. 논리적으로 처리한 byte나
  cache/typed byte를 source read로 대신하지 않는다.
- `P15-BYTE-002`: 사용자 추가 동작이 없는 자동 준비에서
  `structure <= file+1MiB`, `conversion <= file+1MiB`, preview 포함 총량
  `<= file×2.01+8MiB`를 검증한다. metadata/fingerprint/checksum을 위한 source read도 반드시 이
  합계에 포함한다.
- `P15-BYTE-003`: 준비 중 사용자가 요청한 direct foreground read는 자동 준비 합계와 별도 기록하되,
  그 요청 때문에 structure/conversion worker가 새 full scan을 시작하지 않는지 검증한다.
- `P15-BYTE-004`: Ready page/query/copy/navigation에서 원본 CSV read가 0인지 각각 독립 counter로
  검증한다. prepared Parquet read byte와 원본 CSV read byte를 혼용하지 않는다.

### `Q15-H02` direct atomic publish의 최종 가시성 경계가 모호하다

설계에는 `.partial-<generation>` 디렉터리, manifest rename과 atomic publish가 함께 나오지만,
Windows에서 무엇을 어떤 이름으로 rename해야 cache key의 새 generation이 한 번에 보이는지 확정되어
있지 않다. manifest만 partial 디렉터리 안에서 rename하면 stable cache entry 게시가 되지 않으며,
기존 valid generation과 active lease를 보호하는 교체 순서도 판정할 수 없다.

필수 보강:

- `P15-PUBLISH-004`: immutable generation directory와 stable entry pointer/manifest 중 실제 commit
  point를 하나로 확정하고, commit 전 cache miss·commit 후 full hit만 허용한다.
- `P15-PUBLISH-005`: 기존 valid generation을 읽는 lease가 있는 상태에서 새 generation 게시,
  rename 실패, writer 경쟁과 두 프로세스 동시 준비를 검증한다. 기존 reader 중단과 valid cache 손상은
  0이어야 한다.
- `P15-PUBLISH-006`: append/truncate/mtime 변경뿐 아니라 same-path replace, same-size replacement,
  scan handle을 연 뒤 rename/recreate를 포함한다. pinned handle과 시작/commit fingerprint가 어느
  mutation을 막거나 탐지하는지 결과를 구분한다.
- fault matrix는 manifest 전/후, part close, bitmap flush, sync, rename 각 지점의 unit fault와 실제
  subprocess 강제 종료를 분리하고, janitor가 active writer/lease 또는 unrelated path를 지우지 않는지
  확인한다.

### `Q15-H03` bitmap format parity가 바이트 호환성과 write 결함 제거를 충분히 증명하지 않는다

`P15-BITMAP-001`의 “8-byte OS write 0”만으로는 `write_all`을 word마다 호출하고 `BufWriter`가 syscall만
합치는 구현도 통과할 수 있다. 이는 274만 회 호출 자체를 제거하려는 목적과 다르다.

필수 보강:

- `P15-BITMAP-003`: spy writer로 payload serialize/write 호출 수와 chunk size를 기록한다. word별
  호출은 0, header/tail을 제외한 payload는 큰 연속 chunk이며 전체 호출 수는 입력 word 수가 아니라
  파일 크기/chunk 크기에 비례해야 한다.
- `P15-BITMAP-002` oracle은 기존 writer가 만든 golden file의 전체 byte checksum으로 고정한다.
  magic/version, little-endian word, column-major 순서, 마지막 word padding bit, header dimensions,
  payload length와 checksum을 모두 비교한다.
- truncation, bit flip, 잘못된 row/column 수, checksum mismatch와 trailing data를 각각 typed error로
  검증한다.
- frontier가 partial bitmap을 읽는 경우 final CRC가 없는 internal snapshot과 persistent cache hit
  판정을 분리하고, part와 bitmap flush가 끝나기 전에 frontier가 증가하지 않음을 검증한다.

### `Q15-H04` compact raw cache와 “profile 변경 시 source 재scan 0” 계약이 완전히 정의되지 않았다

String typed 열은 typed value를 raw로 재사용할 수 있지만 `Skip`, all-empty, invalid, String→numeric,
numeric→String 전환에서 모든 원문을 복구하는 물리 경로가 명확하지 않다. 또한 “raw lexeme”가 CSV
source의 quote/escape byte까지 포함하는지, parser가 decode한 field 문자열을 뜻하는지 확정되지 않았다.

필수 보강:

- `P15-CACHE-006`: raw의 의미를 **CSV parser가 반환한 decoded field value** 또는 source byte lexeme 중
  하나로 확정하고 csv crate oracle과 byte-for-byte 비교한다. quote, doubled quote, escaped quote,
  CRLF와 quoted newline을 포함한다.
- `P15-CACHE-007`: Text, numeric/temporal, all-empty, invalid와 Skip 열을 모든 지원 profile 타입으로
  변경하는 matrix에서 원본 CSV read 0, raw copy 동일, typed/state 정확성을 검증한다.
- cache physical schema audit는 column name만 보지 말고 source column ID, physical logical type,
  raw shadow mapping, row count, partition min/max row ID와 schema/profile version을 확인한다.

### `Q15-H05` Polars bounded streaming과 RSS gate의 측정 경계가 불충분하다

“queue 최대 2 batch”와 “decoded batch 64MiB”는 제품 callback만 계수하면 Polars 내부 collect 또는
unbounded parser/sink buffer를 놓칠 수 있다. Python 비교 경로가 3.23GB였으므로 physical plan과 제품
counter만으로 1.5GiB 상한을 증명해서는 안 된다.

필수 보강:

- `P15-POLARS-008`: 매 표본을 새 process에서 실행하고 baseline RSS, absolute peak RSS, polling 주기,
  child process 포함 여부와 allocator 잔류를 raw artifact에 기록한다. 판정은 absolute process peak
  `<=1.5GiB`로 유지한다.
- `P15-POLARS-009`: physical plan에 full `collect`가 없음을 저장하고, accepted batch bytes, candidate
  batch bytes, product queue depth와 part writer bytes를 분리한다. dependency 내부 buffer는 RSS에는
  반드시 포함한다.
- `P15-POLARS-010`: cancel을 parse, cast, queue backpressure, Parquet sink, sync, publish wait의 각
  stage에서 반복해 terminal p95/max가 1초 이하인지 측정한다. 단순 token set 시간이 아니라 worker,
  handle, queue, partial, lock과 lease가 0이 되는 terminal 시점을 사용한다.
- 단일 row/record가 64MiB보다 큰 경우의 typed resource-limit 또는 bounded fallback 동작을 별도
  fixture로 검증한다.

### `Q15-H06` dialect parity와 fallback gate가 너무 넓어 silent 지원 축소를 허용한다

`P15-POLARS-006`의 “typed error 또는 fallback”은 csv crate에서 정상 지원하던 입력을 모두 오류로
거부해도 형식상 PASS가 될 수 있다.

필수 보강:

- `P15-POLARS-005`를 delimiter, header on/off, custom quote/escape/double-quote, quoted delimiter,
  quoted LF/CRLF, escaped quote, BOM, trailing empty, blank record, inconsistent width, long record,
  invalid UTF-8 matrix로 확장한다.
- 각 조합을 `Polars 지원`, `Rust fallback`, `제품 typed error` 중 하나로 사전 고정한다. 기존 제품에서
  지원한 조합은 silent error 축소를 허용하지 않는다.
- row count, decoded raw field, state, checkpoint position, first/middle/last/random page checksum을
  csv crate oracle과 비교한다.
- Polars 중도 실패 뒤 Rust fallback 시 Polars partial이 hit되지 않고 중복 coordinator/full scan이
  남지 않는지 검증한다.

### `Q15-H07` EXE/NSIS gate는 기록 항목이지 채택 판정 gate가 아니다

`P15-POLARS-007`에는 허용 증가량도, 사용자 의사결정 상태도 없다. 또한 2026-07-23 binary와 최종
통합 binary의 차이는 Polars 외 코드 변경까지 섞이므로 dependency 비용을 분리하지 못한다.

필수 보강:

- 같은 source commit, toolchain, release profile에서 Polars feature OFF/ON을 별도 clean target으로
  빌드해 EXE, NSIS, clean build wall time과 artifact hash를 비교한다. 현재 78,997,504B/13,763,973B는
  역사적 기준선으로만 함께 기록한다.
- `cargo tree -e features`, 중복 Arrow/Parquet 계열 crate, license, native import/DLL과 runtime file을
  audit한다.
- 자동 수치 상한을 정하지 않는다면 판정을 `PASS`가 아니라 `DECISION_REQUIRED`로 두고, 측정값을
  본 사용자의 명시적 통합 승인 전에는 제품 default feature와 Phase 완료를 BLOCKED로 유지한다.
- 승인되지 않거나 다른 Polars gate가 실패하면 feature OFF 제품 binary와 lock/dependency 상태가
  fallback 결과임을 검증한다.

### `Q15-H08` Phase 14 승계 gate와 최종 산출물에 명시적 P15 ID가 없다

현재 7절의 bullet만으로는 Phase 14의 full-copy, 150% DPI, installer, lifecycle, geometry 증거가
Phase 15 완료를 실제로 막는지 추적하기 어렵다.

필수 보강:

- `P15-GATE-001`~`P15-GATE-008`로 Rust/frontend/Playwright, 세 viewport geometry·screenshot,
  실제 Tauri high CSV, Windows clipboard full-copy, DPR 100/150%, 100-cycle lifecycle, release/NSIS
  build와 실제 installer smoke를 각각 분리한다.
- 각 ID에 owner, 명령, 표본 수, raw artifact 경로와 PASS/FAIL/BLOCKED 판정 위치를 지정한다.
- 외부 환경 항목이 필수라면 미실행 상태는 Phase 15를 완료로 바꾸지 못하는 `BLOCKED`임을 유지한다.

## 3. MEDIUM — 판정 모호성을 줄여야 하는 항목

### `Q15-M01` Auto inference oracle을 표 형태로 고정해야 한다

`P15-TYPE-003`은 positive integer가 Int64/UInt64 중 무엇인지, leading zero, whitespace, NaN/Inf,
Boolean token case, timezone timestamp, Decimal, Date/Timestamp 충돌과 Duration 단위를 판정할 수 없다.
지원 타입별 accepted/rejected literal과 우선순위 lattice를 golden table로 만들고 다음도 검증해야 한다.

- header 제외 여부와 10,000번째 record/8MiB 직전·직후 boundary
- quoted newline이 한 record로 계수되는지
- thread 수와 partition 크기가 달라도 profile hash가 같은지
- Auto에서 modal 0, preview→preparation exactly once, Ask Every Time에서만 대기하는지
- all-empty와 ambiguous 열은 Text, integer epoch는 Timestamp로 추론하지 않는지

### `Q15-M02` cold/p95 benchmark 정의와 표본 수가 모호하다

5회 표본의 p95는 통계적으로 약하므로 현재 계약을 유지한다면 nearest-rank p95를 **5개 중 max**로
명시해야 한다. 각 cold run은 새 process, persistent entry 제거, 같은 fixture hash 조건으로 실행하고
OS file cache를 비우는지 유지하는지 명시한다. raw 5개 값, median, max/p95를 보존한다.

`P15-PERF-003`~`007`도 fixture, projection, source/query 상태, 표본 수와 측정 경계를 고정해야 한다.
특히 page 20ms는 Rust provider와 native IPC를 분리하고, navigation은 상·하·좌·우 및
unfiltered/filter/sort/filter+sort를 각각 측정한다.

### `Q15-M03` frontier abort와 generation 교체 시나리오가 빠져 있다

`P15-FRONTIER-003`으로 frontier 내부 page가 보인 뒤 worker 실패·취소·session replace가 발생할 때
이전 generation page/bitmap 응답을 폐기하고 direct preview로 안전하게 돌아가는지 검증해야 한다.
part, bitmap과 checkpoint row count가 같은 generation snapshot인지도 fault injection으로 확인한다.

### `Q15-M04` storage budget과 path safety gate가 필요하다

direct persistent write는 query temp 재복사를 없애지만 partial도 cache hard cap과 free-space reserve에
포함되어야 한다. 예상치보다 typed/raw가 커지는 one-digit numeric CSV, incompressible string과
disk-full fixture에서 사전 예상, 실제 증가, 중단, partial 정리와 기존 cache 보존을 검증한다.
janitor는 cache root 밖 symlink/reparse/unrelated directory를 따라가면 안 된다.

### `Q15-M05` full-copy와 UI progress가 blanket regression에만 남아 있다

- 64k×1뿐 아니라 5.85M×1 source/query copy의 checksum, source read 0, peak RSS, clipboard atomicity와
  cancel/fault를 독립 ID로 둔다.
- `Inspecting structure`→`Converting and caching`→`Verifying cache`→`Ready`의 순서, session 귀속,
  stale progress 폐기, cancel/error 표시를 component·Playwright·실제 Tauri로 검증한다.
- UI 변경이므로 세 viewport geometry/screenshot과 `ui/interaction-results.md`를 최종 증거로 만든다.

### `Q15-M06` low/long-invalid fixture identity와 raw artifact 경로가 빠져 있다

high fixture처럼 low, long-invalid, dialect, oversized-record fixture도 path, shape, byte size와 SHA-256을
manifest에 고정해야 한다. 성능 JSON에는 hardware/toolchain/build profile, fixture hash, provider,
source/cache byte, RSS, queue, raw samples와 판정식을 포함한다.

## 4. 권장 테스트 실행 순서

1. `P15-BITMAP-*`, `P15-PUBLISH-*`, `P15-BYTE-*`를 의존성 없는 Rust unit/fault/release harness로
   먼저 통과시킨다.
2. `P15-TYPE-*`, `P15-CACHE-*`, `P15-FRONTIER-*`의 oracle과 compact schema를 고정한다.
3. 동일 oracle을 개선된 Rust provider에 통과시킨 뒤에만 Polars POC를 비교한다.
4. Polars는 dialect→correctness→bounded RSS/queue→cancel→cold 5회→OFF/ON package audit 순으로
   판정한다. 앞 gate가 실패하면 시간만 빠른 결과로 제품에 연결하지 않는다.
5. 선택된 provider로 page/navigation/query/copy와 Phase 14 승계 native/UI/lifecycle gate를 실행한다.
6. HIGH/MEDIUM 0, 필수 ID PASS, 외부 필수 항목 BLOCKED 0일 때만 Phase 15 완료를 검토한다.

## 5. 현재 위험 요약

### HIGH

- 실제 source read와 논리 byte가 섞여 2-pass 위반을 놓칠 위험
- Windows publish commit point와 concurrent lease가 불명확해 valid cache를 손상할 위험
- bitmap syscall만 줄고 274만 회 serialization 호출이 남거나 기존 format과 달라질 위험
- profile 변경에서 Skip/String/invalid raw를 잃거나 원본을 다시 scan할 위험
- Polars 내부 materialization을 계측하지 못해 1.5GiB gate를 거짓 PASS할 위험
- dialect fallback의 넓은 허용으로 기존 정상 CSV 지원이 조용히 축소될 위험
- 실행 파일 증가량을 Polars 비용으로 분리하지 못한 채 제품 dependency를 채택할 위험
- Phase 14의 필수 미실행 gate가 blanket bullet에 묻혀 Phase가 잘못 완료될 위험

### MEDIUM

- Auto inference literal 우선순위와 표본 경계의 기대값이 구현마다 달라질 위험
- 5회 p95와 cold 조건이 달라 성능 결과를 재현하지 못할 위험
- frontier 공개 뒤 실패·generation 교체에서 stale page가 남을 위험
- partial cache가 disk budget 또는 janitor path 경계를 위반할 위험
- progress UI와 5.85M full-copy가 자동 회귀만으로 충분히 검증됐다고 오판할 위험
- low/long-invalid/dialect fixture와 raw benchmark artifact identity가 고정되지 않아 결과를 재현하지
  못할 위험

## 6. Quality handoff

- 변경 파일: `artifacts/phase-15/11-quality-plan-review.md`만 추가
- 실행 테스트: 없음. 구현 전 문서·측정 근거의 추적 가능성 리뷰만 수행
- 검토 결과: 현재 계획은 방향상 타당하나 HIGH 8개, MEDIUM 6개 보강 전에는 완료 gate로 사용하기
  부족함
- 다음 담당자 입력: Root Orchestrator가 위 제안 ID를 `10-test-plan.md`에 반영하고 owner·명령·raw
  artifact를 확정한 뒤 구현 Agent에게 배정해야 함
