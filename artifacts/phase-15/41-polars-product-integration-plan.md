# Phase 15 Polars 제품 통합 개발 계획

## 1. 목적과 현재 판단

CSV preparation의 기존 bounded Rust 변환기를 Polars 0.54.4 최신 streaming sink 기반 provider로
교체한다. DuckDB query, page, filter, sort, navigation, copy와 프런트엔드 DTO는 변경하지 않는다.

제품 통합 전 POC에서 979,427,914 bytes, 5,850,000행×15열 high fixture를 8스레드 fresh process로
5회 실행했다. wall 중앙값 12.206초, 관측 최악값 12.938초, peak RSS 최악값 1.103GiB였으며
5,850,000행, 28개 물리 열과 DVST 5,850,000×15 정합성이 모두 PASS했다. 측정 원본과 이전
Polars 0.51의 약 4.55GB RSS 원인은 `31-polars-rust-poc.md`에서 관리한다.

이 결과는 제품 채택을 위한 성능·RSS 가능성을 확인한 것이며 dialect, 취소, fault, 패키징과 제품
회귀를 아직 통과했다는 뜻은 아니다.

## 2. 확정 결정

- Polars는 CSV를 compact cache Parquet로 준비하는 구간에서만 사용한다.
- DuckDB는 준비된 cache의 filter, multi-sort, page와 copy query engine으로 유지한다.
- UI, Tauri command와 공통 `DataSource` 계약에는 Polars 타입을 노출하지 않는다.
- 제품 cache v3의 typed value, exact raw, empty/invalid state와 source-column mapping을 유지한다.
- CSV 지원 범위를 조용히 축소하지 않는다. Polars 비적합 파일은 작업 시작 전에 기존 Rust provider로
  보낸다.
- Polars 실행 중 오류가 난 뒤 같은 요청을 Rust로 자동 재시작하지 않는다. 중복 전체 스캔과 잘못된
  progress를 막기 위해 명확한 오류로 종료하고 재시도 정책은 coordinator가 결정한다.
- 원본 파일은 항상 읽기 전용이며 결과는 같은 volume의 `.partial`에 만든 뒤 검증 후 atomic publish한다.
- Polars를 query engine, 일반 DataFrame API 또는 Parquet/H5 provider로 확대하지 않는다.

## 3. Toolchain과 의존성

### 3.1 Rust

Polars 0.54.4는 현재 제품의 Rust 1.88에서 컴파일되지 않았고 Rust 1.97.1 POC에서 컴파일됐다.
repository에 `rust-toolchain.toml`을 추가해 stable 1.97.1을 고정하고 개발·CI·release가 같은 버전을
사용하게 한다. 개발자 컴퓨터의 전역 default toolchain은 바꾸지 않는다.

Stage 1 실제 전환 결과와 `P15-TC-*` 판정은 `42-rust-1.97-migration-validation.md`에서 관리한다.
기능·전체 Rust test·release·NSIS·DLL import는 PASS했지만 Windows clipboard session과 안정된 성능
교차 측정은 BLOCKED이므로, 해당 문서의 남은 gate를 숨기고 이 단계를 완료로 표시하지 않는다.

Rust toolchain 변경과 Polars 제품 통합은 같은 변경으로 묶지 않는다. 먼저 Polars feature를 끈
상태에서 toolchain만 1.97.1로 바꾸고 기존 제품의 무회귀를 검증한다. 이 변경은 독립 commit으로
관리해 문제가 있으면 `rust-toolchain.toml`과 그 commit만 되돌려 1.88 기준선으로 즉시 복귀할 수
있게 한다. Rust edition은 자동으로 올리지 않고 현재 edition을 유지한다.

전환 직후 기능 구현보다 먼저 다음을 실행한다.

1. Rust 1.88의 test, release EXE/NSIS 크기, 대표 CSV·Parquet·H5 동작과 성능 기준선 보존
2. Polars feature OFF, Rust 1.97.1에서 format, clippy `-D warnings`, 전체 Rust test
3. Polars feature OFF의 release build, Tauri native smoke와 대표 CSV·Parquet·H5 회귀
4. 기존 기준선과 EXE 크기, 준비·조회 성능, peak RSS 비교
5. lockfile diff와 MSRV가 올라간 직접·간접 dependency 기록

새 compiler warning, Cargo resolver/lockfile, native DuckDB·HDF5 build script, release optimizer 차이를
별도 위험으로 추적한다. 기존 기능 회귀가 하나라도 있으면 Polars provider를 활성화하지 않는다.
원인이 작고 명확하면 toolchain 전환 commit에서 먼저 수정하고 전체 기준선을 다시 실행한다. 해결
범위가 크거나 기존 동작·성능을 보존하지 못하면 1.97.1 전환을 취소하고 Phase 15 Polars 통합을
중단한다. Rust 1.88용 dependency source patch나 nightly로 우회하지 않는다.

### 3.2 Polars dependency

정확한 버전 `0.54.4`를 pin하고 `default-features = false`를 유지한다. 시작 feature는 다음 네 개다.

```toml
features = ["csv", "lazy", "streaming", "parquet"]
```

POC 전용 feature를 먼저 `phase15-polars-poc`에서 `polars-csv-provider`로 이름을 분리한다. 제품 gate가
끝나기 전에는 default feature로 만들지 않는다. dependency tree, 중복 Arrow/Parquet, license와
security audit를 `50-integration.md`에 기록한다.

## 4. 제품 구조

### 4.1 Provider 경계

`CsvPrepareCoordinator` 뒤에 다음 내부 계약을 둔다. 실제 이름은 기존 모듈 명명에 맞추되 역할은
섞지 않는다.

```text
CsvPrepareCoordinator
  ├─ CsvEligibilityClassifier
  ├─ RustCsvPreparationProvider
  └─ PolarsCsvPreparationProvider
       ├─ exact structure/state pass
       ├─ lazy CSV conversion
       ├─ streaming Parquet sink
       └─ verify + atomic publish
```

provider 입력에는 source identity, parsing profile, generation, cache target, cancel token, progress sink와
resource budget을 넣는다. 출력은 기존 cache manifest, physical mapping, state/checkpoint 경로와 계측값만
반환한다. query 계층은 어느 provider가 만들었는지 몰라도 같은 결과를 내야 한다.

### 4.2 경로 선택

`CsvEligibilityClassifier`는 preview/sample과 사용자가 확정한 parsing profile만 사용해 원본 전체를
읽지 않고 다음 중 하나를 결정한다.

- `PolarsEligible`: 검증된 delimiter, header, quote/escape, encoding, row-width와 type 조합
- `RustRequired(reason)`: Polars가 기존 계약과 동일하게 처리한다고 입증하지 못한 조합
- `Invalid(reason)`: 어느 provider에서도 열 수 없는 입력

classifier 결과와 reason을 progress/diagnostic에 기록한다. Polars partial을 만든 다음 Rust fallback으로
전환하는 `partial hit`는 허용하지 않는다. classifier parity test가 모든 지원 dialect를 소유한다.

### 4.3 두 source pass

제품 정확성을 위해 다음 두 pass를 명시적으로 허용한다.

1. structure/state pass
   - 기존 `csv` crate parser를 oracle로 사용한다.
   - source row/column 구조, exact decoded raw 의미와 2-bit empty/invalid state를 확정한다.
   - buffered DVST와 필요한 checkpoint를 `.partial`에 기록한다.
2. conversion pass
   - `LazyCsvReader`를 확정 schema/profile로 연다.
   - compact v3 physical projection을 만든다.
   - 전체 `DataFrame`을 `collect()`하지 않고 single-file Parquet streaming sink로 직접 쓴다.

각 pass의 실제 `Read` byte를 따로 계수한다. preview를 포함한 자동 준비 총 source read는
`source_file_size×2.01 + 8MiB` 상한을 유지하고 Ready 이후 page/query/navigation의 원본 source read는
0이어야 한다.

## 5. 타입·raw·state 계약

Polars provider도 기존 compact cache v3 mapping을 그대로 만든다.

- Boolean, Int64, UInt64, Float64: 무손실 native physical value
- Decimal, Date, Timestamp, Duration: 기존 Rust normalization과 같은 UTF-8 physical value
- Text: exact decoded field를 보존하며 trim profile이 있으면 normalized value를 별도 생성
- Skip: 화면 value는 만들지 않아도 source-column mapping과 exact raw 재구성 능력을 유지
- empty와 invalid: value/null만으로 추론하지 않고 DVST state가 최종 기준
- `__dv_*`와 충돌하는 원본 header: structured physical mapping으로 안전하게 분리

direct preview와 Ready cache에서 display, default copy와 raw copy 결과가 같아야 한다. 숫자 overflow,
NaN/Infinity, all-empty, empty string, quoted empty, invalid timestamp와 긴 UTF-8 필드를 별도 fixture로 둔다.

## 6. 메모리와 병렬도

### 6.1 기본 정책

- 절대 process peak RSS hard gate: 1.5GiB
- 제품이 소유한 decoded batch 목표 상한: 64MiB
- producer/consumer queue: 최대 2 batch
- 전체 `collect()`와 in-memory sink 금지
- `LazyCsvReader::with_cache(false)`와 `with_low_memory(true)` 유지

POC 장비의 8 logical CPU에서 8스레드가 가장 빠르고 peak RSS 1.103GiB였다. 제품 기본 상한은
`min(logical_cpu, 8)`로 시작한다. Polars global pool은 초기화 후 크기를 바꾸기 어렵기 때문에
`POLARS_MAX_THREADS` 적용 시점을 Tauri와 worker thread 생성 전으로 고정하고, CSV reader의
`with_n_threads`도 같은 상한으로 맞춘다. 초기화 순서가 보장되지 않으면 default provider로 승격하지
않는다.

RSS가 gate에 근접하는 fixture가 발견되면 다음 순서로 조정한다.

1. reader/sink chunk size 축소
2. Polars thread 상한 8→4→2 축소
3. raw projection 중복과 expression materialization 제거
4. 그래도 초과하면 해당 profile을 `RustRequired`로 분류

속도를 위해 1.5GiB hard gate를 넘기는 설정은 허용하지 않는다.

### 6.2 계측

각 준비 작업은 다음 값을 manifest 또는 성능 artifact에 남긴다.

```text
provider
polars_version
thread_limit
chunk_rows
preview_source_read_bytes
structure_source_read_bytes
conversion_source_read_bytes
peak_rss_bytes
structure_state_ms
parquet_sink_ms
verify_publish_ms
parquet_bytes
state_bytes
```

행마다 clock을 읽지 않고 stage 경계와 bounded sample만 계측한다.

## 7. 취소·오류·lifecycle

Polars sink가 cooperative cancellation을 제품 코드에서 직접 보장할 수 있는지 가장 먼저 작은 spike로
검증한다. 검증 없이 장시간 blocking sink를 coordinator에 연결하지 않는다.

### 7.1 우선 경로

Polars 실행 API가 안전한 cancel handle을 제공하면 기존 generation cancel token과 연결한다. cancel,
tab close와 session replace 후 1초 안에 terminal 상태가 되고 late manifest commit이 없어야 한다.

### 7.2 API가 충분하지 않은 경우

단일 sink를 강제 종료하지 않는다. bounded partition 단위 실행이나 별도 worker process 격리를 비교하는
spike를 수행한다. 다음 조건을 만족하는 더 작은 변경을 선택한다.

- cancel 확인 간격과 terminal 최대 1초
- partial/worker/handle/lease 잔존 0
- 정상 실행 wall/RSS gate 유지
- 동일 cache manifest와 atomic publish 계약 유지

이 조건을 만족하지 못하면 Polars provider를 제품 기본 경로로 채택하지 않고 기존 Rust provider를
유지한다.

parse, cast, sink, fsync, verify와 publish 오류는 타입이 구분된 제품 오류로 변환한다. 오류와 취소
모두 원본과 기존 Ready cache를 변경하지 않고 현재 generation의 `.partial`만 정리한다. 다른 process의
partial/cache는 삭제하지 않는다.

## 8. 구현 순서

### Batch A — toolchain과 build 기준선

1. Rust 1.88의 기존 test, native 동작, 성능, EXE·NSIS 기준선 고정
2. Polars dependency를 활성화하지 않은 독립 commit에서 `rust-toolchain.toml`에 1.97.1 고정
3. Polars feature OFF로 전체 Rust gate, release와 Tauri native smoke
4. CSV·Parquet·H5, DuckDB query와 cache lifecycle의 기존 결과·성능 비교
5. 무회귀 PASS 후에만 별도 commit에서 Polars exact dependency와 feature 정리
6. feature OFF/ON clean build 시간과 executable 크기 기준선 기록

2~4에서 회귀가 발생하면 Batch B로 넘어가지 않는다. 작은 호환 수정은 toolchain commit에 포함해
재검증하고, 해결할 수 없으면 해당 commit을 되돌려 Rust 1.88로 복귀한다.

### Batch B — provider 경계와 사전 분류

1. coordinator 뒤 provider 계약 추출
2. 기존 Rust 경로를 첫 구현체로 이동해 동작 무변경 검증
3. eligibility classifier와 reason DTO 구현
4. dialect matrix에서 Polars/Rust 경로 결정 test

### Batch C — Polars cache 생성

1. POC 코드를 제품 모듈로 옮기되 example과 중복 구현 제거
2. 확정 schema와 compact v3 projection 연결
3. streaming Parquet sink와 stage progress 연결
4. DVST/checkpoint/manifest 검증과 same-volume atomic publish 연결
5. direct/Ready raw·typed·state parity test

### Batch D — 취소와 fault

1. cancel spike로 API의 실제 terminal 특성 측정
2. 선택한 cancel 경계를 coordinator에 연결
3. close/replace/source mutation/disk-full/sink failure/fsync failure test
4. crash janitor, lease와 다른 process 보호 test

### Batch E — 성능과 제품 회귀

1. low/high/long-invalid와 dialect matrix resource test
2. high 5회 timing/RSS/source-byte 측정
3. Ready page/filter/3-sort/navigation/copy source-read-0 검증
4. 100-cycle open/cancel/close/reopen soak
5. Parquet/H5와 timestamp/duration/display/copy 회귀

### Batch F — 패키징과 채택

1. feature OFF/ON release EXE, NSIS, clean build와 hash 비교
2. dependency/license/security audit
3. 결과를 `50-integration.md`에 정리
4. 모든 gate 통과 후에만 Polars provider를 default로 전환
5. 최종 Rust/frontend/E2E/release/native gate를 한 번 실행

각 batch는 소유 모듈의 단위 test와 함께 끝낸다. 뒤 batch 문제를 숨기기 위해 앞 batch의 test 기준을
낮추지 않는다.

## 9. 예상 변경 파일

정확한 위치는 기존 모듈 경계를 확인한 뒤 확정하지만 변경 범위는 다음으로 제한한다.

- `rust-toolchain.toml`
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- CSV coordinator/provider 모듈
- `csv_source.rs`, `csv_cache.rs`의 provider 연결과 manifest mapping
- Polars provider 전용 새 Rust 모듈과 단위 test
- POC/성능 runner와 Phase 15 artifact
- `docs/DEVELOPMENT_PLAN.md`, 필요 시 `PROJECT_SPEC.md`의 확정 계약

프런트엔드 변경은 기존 progress DTO로 충분하지 않은 경우에만 허용한다. 새로운 설정 화면이나
사용자 타입 확인 modal은 만들지 않는다.

## 10. 필수 검증과 완료 조건

`10-test-plan.md`의 `P15-POLARS-001`~`010`, `P15-PERF-*`, `P15-BYTE-*`와 최종 `P15-GATE-*`를
그대로 사용한다. 특히 다음 조건은 타협하지 않는다.

- high 5회 median 15초 이하, p95 20초 이하
- peak RSS 1.5GiB 이하
- cancel terminal 최대 1초
- raw/typed/empty/invalid와 dialect parity 전부 PASS
- Ready 이후 source read 0
- filter, multi-sort, page, Ctrl navigation과 filtered/sorted copy 회귀 0
- feature OFF/ON EXE·NSIS 증가량과 dependency audit 기록
- 전체 Rust/frontend/Playwright/release/native 필수 gate PASS

필수 항목이 `FAIL`, `NOT_RUN`, `BLOCKED` 또는 `DECISION_REQUIRED`이면 Phase 15와 Polars default 전환을
완료로 표시하지 않는다.

## 11. 중단·rollback 기준

다음 중 하나가 해결되지 않으면 Polars 제품 통합을 중단하고 기존 bounded Rust provider를 유지한다.

- 지원하던 CSV dialect나 raw 의미를 보존할 수 없음
- cancel 최대 1초 또는 safe cleanup을 만족할 수 없음
- 정상 fixture에서 peak RSS 1.5GiB 초과
- high preparation p95 20초 초과가 반복됨
- package 증가량이나 dependency audit 결과를 사용자가 승인하지 않음
- Rust 1.97.1 전환이 기존 제품 gate를 깨뜨림

rollback은 provider feature를 끄는 것으로 가능해야 하며 cache format과 query/UI 계약은 양쪽 provider가
공유한다. Polars 전용 cache format을 새로 만들지 않는다. toolchain 자체가 회귀 원인이면 Polars
feature만 끄는 것으로 끝내지 않고 독립 toolchain commit을 되돌려 Rust 1.88 기준선으로 복귀한다.
