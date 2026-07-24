# Phase 15 Stage 2 Polars 제품 통합 구현 전 Quality 검토

## 1. 판정과 범위

사용자가 Stage 2 구현 시작을 명시적으로 지시했으므로 Polars 제품 provider의 개발과 feature ON
검증은 시작할 수 있다. 이 지시는 Stage 1의 미완료 항목을 PASS로 바꾸거나 Polars를 default provider로
승격하라는 뜻은 아니다.

구현 중에는 다음 경계를 유지한다.

- `polars-csv-provider`는 non-default feature다.
- feature OFF 제품은 현재 Rust CSV provider만 사용한다.
- feature ON이어도 classifier가 명시적으로 허용한 입력만 Polars로 보낸다.
- classifier가 아직 검증하지 않은 조합은 기본적으로 `RustRequired`다.
- Polars 실행 중 실패한 같은 generation을 Rust preparation으로 자동 재시작하지 않는다. 기존 direct
  preview/page는 유지하되 partial을 폐기하고 명확한 실패 상태를 반환한다.
- DuckDB query, Parquet/H5 provider, 프런트엔드 DTO와 cache v3 논리 계약은 변경하지 않는다.
- 아래 필수 gate가 끝나기 전에는 default feature, Phase 완료 또는 제품 채택을 선언하지 않는다.

## 2. Stage 1 승계 상태

Stage 2 개발은 허용됐지만 다음 Stage 1 부채는 최종 채택 gate에 그대로 남긴다.

| 항목 | 상태 | Stage 2 영향 |
| --- | --- | --- |
| `P15-TC-006` | FAIL | linker warning을 숨기지 않고 최종 build diagnostic에 계속 기록한다. |
| `P15-TC-012` | PASS | 재부팅 후 실제 5.85M clipboard, H5와 native 전체 smoke 기준선을 사용한다. |
| `P15-TC-013` | BLOCKED | feature OFF/ON binary audit에서 raw import 결과를 새로 보존한다. |
| `P15-TC-014` | BLOCKED | 최종 NSIS clean install 전에는 packaging 완료로 표시하지 않는다. |
| `P15-TC-015` | BLOCKED | 5회 교차 표본과 peak RSS가 필요하다. |
| CSV product cleanup | HIGH 미해결 | `process_bytes=289,164,521` 잔존 원인을 분리하기 전 RSS/lifecycle PASS 금지 |

Stage 2에서 만든 성능 수치는 cleanup assertion을 제거하거나 무시해서 PASS 처리하지 않는다. cache,
query temp, worker와 lease의 정상 잔존 범위를 먼저 정의하고 실제 잔존 byte와 handle을 계측한다.

## 3. 필수 구현 순서

### Priority 0 — feature 격리와 취소 가능성

1. POC feature를 `polars-csv-provider` 제품 feature와 분리한다.
2. feature OFF에서 기존 Rust provider 전체 test와 cache hash/oracle을 다시 통과시킨다.
3. coordinator 뒤 provider 계약을 추출하되 최초 classifier는 모든 입력을 `RustRequired`로 반환한다.
4. 제품 sink를 연결하기 전에 cancel spike를 실행한다.
5. sink가 1초 안에 cooperative terminal 상태가 될 수 없으면 장시간 단일 sink를 coordinator에 연결하지
   않는다. bounded partition 또는 별도 worker process 경계를 먼저 결정한다.

이 단계의 실패는 이후 parity나 성능 구현으로 우회할 수 없다.

### Priority 1 — dialect classifier와 사전 fallback

classifier는 bounded preview와 확정 parsing profile만 사용한다. 원본 전체 scan, partial 생성 또는
Polars 초기화 전에 다음 중 하나를 확정한다.

- `PolarsEligible`
- `RustRequired(reason)`
- `Invalid(reason)`

초기 allow-list는 비어 있는 상태에서 시작한다. 아래 matrix의 각 조합이 csv crate oracle과 완전히
일치한 뒤에만 그 조합을 `PolarsEligible`로 전환한다.

- UTF-8, UTF-8 BOM
- header on/off와 Auto가 확정한 header 결과
- 현재 제품 delimiter와 quote/escape/double-quote 조합
- quoted delimiter, doubled/escaped quote
- LF, CRLF, quoted LF/CRLF
- trailing empty, quoted empty, blank record
- consistent/inconsistent width
- long record와 8MiB 경계
- invalid UTF-8과 지원하지 않는 encoding
- Auto, All Text, Custom profile
- Text, Boolean, Int64, UInt64, Float64, Decimal, Date, Timestamp, Duration, Skip
- trim, null/Boolean token, decimal/thousands separator, timezone와 duration option

현재 제품이 지원하지 않는 delimiter나 encoding을 Stage 2에서 새로 지원하지 않는다. 각 fixture의 기존
Rust 결과를 `PolarsEligible`, `RustRequired`, `Invalid` 중 하나의 golden으로 먼저 고정한다.

fallback 필수 조건은 다음과 같다.

- ineligible 입력에서 Polars provider 호출 0, Polars partial 0
- Rust provider 시작 exactly once, 중복 coordinator와 중복 full scan 0
- classifier reason이 안정적이고 typed diagnostic에 포함됨
- Polars runtime 오류 뒤 같은 generation의 Rust provider 자동 시작 0
- runtime 오류·cancel 뒤 기존 Ready cache와 원본은 보존되고 현재 partial만 정리됨
- classifier가 모르는 새 조합은 `PolarsEligible`가 아니라 `RustRequired`

### Priority 2 — cache v3 parity와 publish

Polars provider는 byte-identical Parquet 파일이 아니라 논리적으로 동일한 cache v3를 만들어야 한다.
다음을 Rust provider oracle과 비교한다.

- row count, source row ID와 physical source-column mapping
- typed value와 exact decoded raw field
- empty/null/invalid 2-bit DVST state
- checkpoint, first/middle/last와 64k 경계 page checksum
- default/raw copy와 profile 변경 결과
- filter, 3-sort, filter→sort, sort→filter 결과 순서
- `__dv_*` header 충돌과 identifier/path escaping
- manifest/footer/state dimension과 checksum

Polars/Rust가 만든 cache는 같은 v3 consumer로 읽을 수 있어야 한다. provider 전환 또는 feature OFF
rollback 때 기존 cache는 검증 후 재사용하거나 안전한 miss/rebuild가 되어야 하며 잘못된 hit는 허용하지
않는다.

publish는 기존 `P15-PUBLISH-*`를 그대로 통과해야 한다. parse, cast, sink, close, fsync, verify, rename,
source mutation과 disk-full fault마다 기존 valid cache 손상 0, stale commit 0, partial/lease/handle 잔존 0을
확인한다.

### Priority 3 — cancel, RSS와 source byte

cancel은 다음 stage 각각에 주입한다.

```text
classify → structure/state → conversion → sink/backpressure → close/fsync → verify → publish
```

각 stage에서 cancel, tab close와 session replace를 실행하고 terminal p95와 max가 모두 1초 이하여야 한다.
late progress/commit, worker, process, queue, file handle, partial, lock과 lease가 0인지 확인한다. 강제 thread
종료는 허용하지 않는다.

RSS는 테스트 process 내부 allocator 수치가 아니라 fresh 제품 process와 자식 process의 working set을
100ms 이하 간격으로 표본화한다. low/high/long-invalid fixture에서 다음을 함께 기록한다.

- launch baseline RSS, absolute peak와 delta peak
- child process 포함 여부와 thread limit
- decoded batch peak 64MiB 이하
- producer/consumer queue 최대 2 batch
- process peak RSS 1.5GiB 이하
- cache/query temp 구성별 byte와 close 후 잔존 byte
- preview/structure/conversion/foreground/navigation source read byte

high cold preparation은 새 process·새 persistent key로 5회 실행한다. p95는 5개 중 max로 계산하며 median
15초, p95 20초 이하를 모두 만족해야 한다. 원본 sample과 fixture hash를 보존한다.

### Priority 4 — native 제품 경로

단위 test가 통과한 뒤 feature ON release EXE에서 다음 순서로 검증한다.

1. 작은 `PolarsEligible` CSV의 open→Ready→page→raw/default copy
2. 작은 `RustRequired` CSV가 Polars partial 없이 Rust provider로 열린다는 진단
3. high 5.85M CSV의 progress, cancel, reopen과 Ready
4. filter, multi-sort, random page, Ctrl/Ctrl+Alt 네 방향과 PageUp/PageDown
5. source/query 5.85M×1 actual Windows clipboard와 checksum
6. tab close/replace와 stale response, 20회 tab 복귀
7. Parquet low/high와 OES H5 회귀

브라우저 mock 결과만으로 native gate를 PASS 처리하지 않는다. 최종 native는 실제 Rust IPC, WebView2,
release EXE와 정상 Windows clipboard를 사용한다.

## 4. 추적 가능한 최소 gate

| Quality ID | 기존 ID | 구현 중 통과 시점 | PASS 기준 |
| --- | --- | --- | --- |
| `Q15-S2-001` | `P15-POLARS-001` | dependency 변경 직후 | exact 0.54.4, default features off, 제품 feature non-default, feature OFF tree에 Polars 0 |
| `Q15-S2-002` | `P15-POLARS-004`, `010` | provider 연결 전 | sink cancel feasibility와 전 stage terminal max 1초 설계가 실제 spike로 입증됨 |
| `Q15-S2-003` | `P15-POLARS-005` | classifier 완료 | dialect/profile matrix의 기존 Rust outcome과 분류 golden 100% 일치 |
| `Q15-S2-004` | `P15-POLARS-006` | Rust provider 추출 후 | ineligible은 사전 Rust route, partial/중복 scan/coordinator 0 |
| `Q15-S2-005` | `P15-CACHE-001`~`007` | Polars sink 연결 후 | raw/typed/state/mapping/page/query/copy checksum parity 100% |
| `Q15-S2-006` | `P15-PUBLISH-001`~`006` | publish 연결 후 | fault/source race에서 stale commit·valid cache 손상·잔존 resource 0 |
| `Q15-S2-007` | `P15-BYTE-001`~`004` | 제품 preparation 완료 후 | 두 pass와 preview byte cap, Ready source read 0 |
| `Q15-S2-008` | `P15-POLARS-003`, `008`, `009` | 성능 측정 전 | fresh-process peak RSS 1.5GiB, batch 64MiB, queue 2 이하, full collect 0 |
| `Q15-S2-009` | `P15-POLARS-002`, `P15-PERF-*` | release 후보 완료 후 | high 5회 median 15초/p95 20초와 page/query/navigation/copy 절대 gate PASS |
| `Q15-S2-010` | `P15-GATE-004`, `005`, `007` | native 통합 후 | eligible/fallback/cancel/query/copy/lifecycle 실제 Tauri PASS |
| `Q15-S2-011` | `P15-POLARS-007`, `P15-GATE-008` | 최종 채택 전 | 같은 commit OFF/ON EXE·NSIS·imports·license 비교와 clean install, 사용자 결정 |

`Q15-S2-002`~`004` 중 하나라도 실패하면 Polars cache 생성 범위를 넓히지 않는다. `Q15-S2-005`~`008`
중 하나라도 실패하면 high 성능 수치가 빨라도 제품 후보로 승격하지 않는다.

## 5. 구현 중 최소 명령 matrix

실제 feature 이름을 `polars-csv-provider`로 확정한 뒤 다음 두 축을 항상 분리한다.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-default-features
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --features polars-csv-provider
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --no-default-features -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --features polars-csv-provider -- -D warnings
cargo tree --manifest-path src-tauri/Cargo.toml --locked --no-default-features -e features
cargo tree --manifest-path src-tauri/Cargo.toml --locked --features polars-csv-provider -e features
```

feature OFF 전체 test가 깨지면 ON 구현을 계속하지 않는다. 성능 runner는 release 제품 provider를 직접
호출해야 하며 POC example이나 Python 결과를 제품 PASS 근거로 사용하지 않는다.

## 6. 중단 기준과 최종 판정

다음 중 하나가 해결되지 않으면 Polars default 전환을 중단하고 Rust provider를 유지한다.

- 기존 지원 입력이 typed error로 축소되거나 decoded raw/state가 달라짐
- 사전 classifier 없이 Polars partial 이후 Rust fallback이 발생함
- cancel terminal max 1초 또는 cleanup을 만족하지 못함
- peak RSS 1.5GiB, batch 64MiB 또는 queue 2를 초과함
- high p95 20초를 반복 초과함
- Ready 이후 원본 source read가 발생함
- feature OFF rollback이 기존 cache나 제품 실행을 깨뜨림
- 실제 native copy/query/lifecycle 또는 최종 packaging gate가 미완료임

Stage 2 구현은 시작할 수 있지만 현재 판정은 **개발 허용, 제품 채택 미승인**이다. 모든 필수 ID가 PASS이고
EXE·NSIS 증가량을 사용자가 검토하기 전까지 Polars feature를 default로 만들거나 Phase 15를 완료로
표시하지 않는다.
