# Phase 13 테스트 계획

- 작성일: 2026-07-22
- 상태: Quality 사전 설계 완료, Root 승인 완료
- 범위: `artifacts/phase-13/00-scope.md`의 13A~13H
- 근거: `artifacts/phase-12/95-follow-up-requests.md`
- 원칙: 구현 Agent는 소유 모듈의 unit/component test를 코드와 함께 작성하고, Quality Agent는 fixture,
  독립 oracle, integration/E2E/release benchmark와 사후 검증을 소유한다. Browser mock은 native 또는 release
  증거를 대체하지 않는다.

## 1. 판정과 선행 gate

별도 `선택` 표시가 없는 모든 ID는 필수다. 각 ID는 `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN` 중 하나로 기록한다. 필수 ID의 FAIL/BLOCKED가 남거나 아래
선행값이 고정되지 않으면 Phase 13을 완료로 판정하지 않는다.

| Gate | 구현 전 고정할 값 | 판정 |
| --- | --- | --- |
| `P13-GATE-001` | occupancy block row cap `65,536`; 증가 단계 `256, 4,096, 16,384, 65,536` | 범위에서 확정됨 |
| `P13-GATE-002` | occupancy provider accepted decoded block `<=8 MiB`; 초과 후보는 값 판정 전 폐기·분할 | Root 확정 |
| `P13-GATE-003` | bitmap LRU 최근 8컬럼, process payload cap 16 MiB | Root 확정 |
| `P13-GATE-004` | direct CSV와 후보 prepared 형식의 동일 장비 release baseline, fixture SHA-256 | production 구현 전 필수 |
| `P13-GATE-005` | baseline artifact에서 `CSVPERF-001..012` 절대 p95와 허용 회귀율 고정 | candidate 구현 시작 전에 필수; correctness/counter gate는 즉시 적용 |
| `P13-GATE-006` | copy 성공 status `3,000 ms ±250 ms` | Root 확정 |
| `P13-GATE-007` | tab/header `Alt+Shift+Left/Right`, sort criterion `Alt+Shift+Up/Down`; visible move button 없음 | Root 확정 |
| `P13-GATE-008` | CSV Duration `sourceUnit=s/ms/us/ns`, `inputFormat=rawInteger/daysClock`와 아래 grammar | Root 확정 |
| `P13-GATE-009` | Settings V4, valid V1/V2/V3 migration 유지 | Root 확정 |

고정된 값은 Rust 상수, TypeScript wire validation, fixture manifest와 benchmark JSON에서 동일해야 한다.
timeout 확대, fixture 축소, compression 변경이나 counter 누락으로 gate 실패를 우회하지 않는다.

## 2. 계층, 담당과 증거

| 표기 | 계층 | 주 담당 | 필수 증거 |
| --- | --- | --- | --- |
| Unit-R | Rust unit/property | Rust Data Agent 또는 Root(공통 DTO) | 관련 `cargo test` 이름과 결과 |
| Unit-TS | TypeScript unit/component | Grid UX Agent 또는 Root(공통 DTO) | Vitest 이름과 결과 |
| Integration | Rust/TS 경계·source/query 통합 | Quality Agent, 구현 Agent 협업 | fixture hash, counter, oracle 비교 |
| E2E | Playwright browser mock | Quality Agent | interaction, geometry JSON, 세 viewport screenshot |
| Native | 실제 Tauri/WebView2/Windows | Tauri Platform Agent | native log, screenshot, clipboard/hash |
| Release | release backend/installed executable | Quality 또는 Tauri Platform Agent | raw sample, p50/p95, RSS/temp/counter JSON |

최종 UI 증거는 `artifacts/phase-13/ui/`에 저장한다. 성능 raw sample은
`boundary-performance-baseline.json`, `boundary-performance.json`, `csv-prepared-performance-baseline.json`,
`csv-prepared-candidate-comparison.json`, `csv-prepared-performance.json`에 저장한다.

## 3. Fixture와 독립 oracle

모든 생성 fixture는 generator version, seed, row/column count, schema/profile, 실제 byte size와 SHA-256을
`artifacts/phase-13/fixture-manifest.json`에 기록한다. 제품 DuckDB 결과로 reference를 만들지 않는다.

| Fixture | 내용과 입력 | Oracle |
| --- | --- | --- |
| `boundary-states-small.parquet` | null, `""`, whitespace, invalid에 대응하는 state, `0`, `false`, NaN, empty binary를 시작/중간/끝에 배치 | 고정 logical state vector와 Excel transition 표 |
| `boundary-query-map.parquet` | source row가 흩어진 filter-only, sort-only, 3-column sort 결과; nulls-last와 tie 포함 | Python stable tuple sort + source row ID tie-breaker |
| `boundary-5850000-low.parquet` | 5.85M×15, 반복 group, 빈 셀 가까움/멀리/없음 컬럼 | seed 기반 closed-form row/state 함수 |
| `boundary-5850000-high.parquet` | 같은 schema/row-group의 high-cardinality 값과 sparse row identity | seed 기반 독립 reference page/boundary checksum |
| `boundary-long-string.parquet` | 균일 long string과 5 MiB 값이 앞에 몰린 skew를 포함해 decoded byte cap이 row cap보다 먼저 걸림 | 전체 state reference, observed/accepted byte audit |
| `csv-prepared-matrix/` | empty/1행, header modes, duplicate/blank header, comma/tab/semicolon, quote/LF/CRLF/trailing field/BOM/long row, malformed/invalid UTF-8 | Python `csv` 기반 parser + 고정 malformed error table |
| `csv-profile-types.csv` | Text/Boolean/Int64/UInt64/Float64/Decimal/Date/Timestamp/Duration/Skip, trim/null/custom token/separator | Python `Decimal`, integer와 datetime/duration integer arithmetic |
| `csv-5850000-{low,high,long-invalid}.csv` | release prepared source, query, copy와 resource 측정 | 생성 seed와 독립 checksum/reference pages |
| `duration-arrow.parquet` | Arrow Duration s/ms/us/ns, null/0/±/24h 초과/i64 min/max/2^53 인접 | signed integer count+unit golden JSON |
| `duration-pandas-metadata.parquet` | pandas/NumPy timedelta metadata로 복원되는 duration | PyArrow schema와 source count golden |
| `duration-negative-types.parquet` | physical INT64, Interval 3종, Time32/Time64 | INT64 유지 또는 typed unsupported golden |
| `duration-profile.csv` | 확정된 CSV Duration format별 valid/null/empty/invalid/boundary | grammar 독립 parser와 count/unit golden |
| `timestamp-zones.parquet` | timezone 없음, UTC, fixed ±offset, Asia/Seoul, America/New_York DST 전후와 ns fraction | wall-clock field, epoch, unit, timezone golden |
| `ui-wide-documents` | overflow file tabs, 80+ logical columns, hidden/sorted/filtered columns | ID order와 saved document/grid state |
| `copy-history-mock` | active, success, cancelled, 7 previous failures와 시간이 다른 operation | 최근 5 bounded history golden |

Randomized CSV는 seed를 고정해 valid 1,000 cases와 malformed corpus를 direct/prepared 양쪽에 입력한다. failure
artifact에는 최소 입력, seed와 expected typed error를 남긴다.

## 4. 13A — 공통 값, Duration과 Timestamp 설정 계약

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `VAL13-001` | Unit-R + Unit-TS / Root | duration count `0, ±1, 2^53±1, i64::MIN/MAX`, unit s/ms/us/ns, null | wire DTO는 count를 decimal string으로, unit을 필수 enum으로 보존한다. number coercion 0, unknown/missing/extra field는 field path가 있는 typed error다. Rust/TS accept/reject matrix hash가 같다. |
| `VAL13-002` | Unit-R / Rust Data | `duration-arrow.parquet` | Arrow Duration 네 unit을 `ValueKind::Duration`으로 변환하고 source count/unit/state를 보존한다. 0은 occupied, null만 empty다. |
| `VAL13-003` | Unit-R + Integration / Rust Data, Quality | `duration-negative-types.parquet` | 물리 INT64는 int로 남고 Interval/Time32/Time64는 타입명이 포함된 unsupported다. Duration으로 오인한 case 0이다. |
| `VAL13-004` | Integration / Quality | `duration-pandas-metadata.parquet` | Arrow schema metadata로 복원된 pandas/NumPy timedelta의 schema, page, raw count와 unit이 PyArrow golden과 같다. |
| `VAL13-005` | Unit-R + Unit-TS / Root | Duration display styles `daysClock`, `totalHours`, `totalSeconds`; fraction Preserve/Hidden/0..9; suffix on/off | integer arithmetic만 사용해 음수 부호를 한 번 표시하고 i64::MIN overflow 없이 golden과 일치한다. grid/detail/default copy는 같은 formatter output을 사용한다. |
| `VAL13-006` | Unit-R + Unit-TS / Root | Timestamp 날짜 4종 × Space/T × time format `HH24:MI:SS`/`HH24:MI`/`hidden` × Preserve/Hidden/0..9 | pairwise 전체와 각 enum 경계에서 Rust/TS output이 같다. `hidden`은 날짜 뒤 separator·시간·fraction을 출력하지 않는다. fixed fraction은 pad/truncate만 하고 raw epoch/unit을 바꾸지 않는다. source fraction이 없고 Preserve/Hidden이면 불필요한 점이 없다. |
| `VAL13-007` | Integration / Quality | `timestamp-zones.parquet` | Hidden/Offset/Name에서 wall-clock field는 변하지 않는다. UTC는 Offset에서 Z, fixed offset은 `±HH:MM`, named zone은 `[Name]`, timezone 없음은 suffix 없음이다. DST 전후도 conversion 0이다. |
| `VAL13-008` | Integration / Quality | timestamp와 duration 대표값을 preview/grid/full-detail/default/displayed/raw copy에 입력 | preview/grid/display copy byte가 동일하다. raw는 `count [unit=..., timezone=...]` 계약을 보존한다. formatter implementation/call-path별 golden mismatch 0이다. |
| `VAL13-009` | Unit-R + Unit-TS / Root | 기존 Settings V1/V2/V3, 다음 version, missing/unknown/out-of-range/nested unknown field | 기존 유효 설정을 보존하며 새 timestamp/duration 기본값을 채운다. canonical/backup recovery 뒤 migration도 원자적이다. 손상 입력은 정확한 field path 오류며 부분 저장 0이다. |
| `VAL13-010` | Integration / Quality | display 설정만 변경한 열린 Parquet/CSV/query | document/session/query/prepared generation, bitmap identity, source read/parse counter가 변하지 않고 화면/default copy만 바뀐다. |
| `CSV13-DUR-001` | Unit-R / Rust Data | `duration-profile.csv`, 확정 source unit/input format | profile parser가 count/unit, null/empty/invalid 원문과 failure policy를 보존한다. preview/validation/applied page가 같다. |
| `CSV13-DUR-002` | Unit-R + Unit-TS / Root, Rust Data | CSV Duration profile/literal valid·invalid matrix | source unit/input-format와 filter literal의 wire validation parity가 같고 overflow, unit 없음, trailing junk, 과도한 fraction을 typed error로 거부한다. |
| `DUR13-QRY-001` | Integration / Quality | duration Arrow/CSV에 equals/comparison/between/null, asc/desc, Find, Ctrl, filtered copy | query는 formatted string이 아닌 signed count+unit 의미를 사용하고 nulls-last/stable tie/copy order가 independent reference와 같다. |

## 5. 13B — Adaptive query boundary와 occupancy bitmap

### 5.1 Counter 계약

release/integration harness는 최소 다음 counter를 노출한다.

```text
blocks_started, blocks_completed, requested_candidate_rows, decoded_rows,
max_observed_decoded_bytes, max_accepted_decoded_bytes, oversized_batches,
source_value_reads, cancellation_checks, known_word_hits, bitmap_misses,
resident_bitmap_columns, resident_bitmap_bytes, bitmap_evictions,
intermediate_page_requests, target_page_requests, stale_result_commits
```

counter는 document/session/query/column/navigation ID로 분리하고 cancelled/stale 작업도 terminal snapshot을
남긴다.

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `BND13-001` | Unit-R / Rust Data | unknown range에 경계를 20, 300, 5,000, 20,000, 100,000행 뒤 배치 | block 요청은 `256→4,096→16,384→65,536`을 넘지 않고 cap 도달 뒤 65,536을 반복한다. 경계를 포함한 block 이후 추가 block 0이다. |
| `BND13-002` | Unit-R + Integration / Rust Data, Quality | 균일·skew `boundary-long-string.parquet` | 모든 요청 candidate rows `<=65,536`; accepted decoded block `<=OCCUPANCY_DECODE_CAP_BYTES`; 초과 observed 후보는 값 판정 전 폐기되고 split 뒤 전체 state가 reference와 일치하며 zero-progress loop 0이다. |
| `BND13-003` | Unit-R property / Rust Data | `boundary-states-small.parquet`, 모든 start/direction/current-neighbor state | null과 string empty만 empty다. whitespace, invalid, 0, false, NaN, empty binary/duration 0은 occupied다. Excel transition target이 golden과 같다. |
| `BND13-004` | Integration / Quality | `boundary-query-map.parquet`, filter-only/sort-only/filter+3-sort, Up/Down | bitmap index가 final query logical position과 1:1이며 scattered source IDs를 provider가 query order로 복원한다. target/selection reference mismatch 0이다. |
| `BND13-005` | Integration / Quality | 같은 query/column/range cold 후 warm Ctrl 왕복 | 첫 탐색이 채운 known range의 warm 탐색은 `source_value_reads=0`, `decoded_rows=0`, `bitmap_misses=0`이고 word scan만 증가한다. |
| `BND13-006` | Unit-R / Rust Data | 서로 겹치거나 떨어진 세 start position에서 부분 scan | known/occupied bit가 손실 없이 union되고 이미 known인 position 재읽기 0이다. last partial word와 row-count 비배수 경계를 masking한다. |
| `BND13-007` | Unit-R + Release / Rust Data, Quality | 9개 이상 column과 여러 query에서 bitmap 생성 | resident columns/bytes가 승인 cap 이하이고 LRU 순서대로 evict한다. evicted entry만 재읽고 active navigation entry를 사용 중 해제하지 않는다. RSS는 counter와 허용 overhead 안이다. |
| `BND13-008` | Integration / Quality | filter/sort/query, CSV profile/null/trim/session/tab close, display/width/order/visibility 변경 | value-semantics 변경은 해당 bitmap을 폐기한다. display/layout 변경은 hit를 유지한다. stale bitmap lookup/commit 0, close 후 resident bytes 0이다. |
| `BND13-009` | Integration / Quality | 각 증가 단계 직전 cancel, query/session 교체, pointer/keyboard 새 선택 | 다음 block 시작은 최대 1회 race allowance 뒤 중단되고 2초 안에 terminal cancel이다. target/selection/scroll stale commit 0, task와 bitmap lease 누적 0이다. |
| `BND13-010` | Unit-R + Integration / Rust Data, Quality | filtered/sorted row에서 Ctrl+Left/Right, nullable/string/numeric visible columns | 현재 logical row 1개와 visible projection만 검사한다. full-result join/decode 0, source rows read `<=1`, hidden column read 0, typed state target이 golden과 같다. |
| `BND13-011` | Unit-TS + E2E / Grid UX, Quality | Ctrl/Ctrl+Shift Up/Down, target cache hit/miss | backend target IPC는 shortcut당 1회, intermediate page IPC 0, target page cache miss 최대 1회다. Shift anchor/rect, active cell, focus visibility가 target page 검증 뒤 commit된다. |
| `BND13-012` | Unit-R + E2E / Rust Data, Quality | Ctrl+Alt 네 방향과 Shift 조합 | absolute boundary는 occupancy block/bitmap read 0이고 row/visible-column bounds만 사용한다. 기존 target-only page/focus 계약이 유지된다. |
| `BND13-013` | Integration / Quality | concurrent foreground page, copy와 두 boundary navigation | 장기 query/source mutex가 UI 작업을 직렬화하지 않는다. cancelled 이전 navigation은 다음 결과를 덮지 않고 request identity별 terminal state가 하나다. |

### 5.2 Boundary 성능 gate

| ID | 환경 / 담당 | 입력 | 필수 예산 |
| --- | --- | --- | --- |
| `BNDPERF-000` | 기존 release baseline / Quality | 구현 전 현행 200행 반복 경로로 5.85M low/high near/far/none | cold latency, position block/source sparse read 수, decoded rows/bytes와 RSS raw sample을 고정한다. fixture/hash/profile이 구현 후 측정과 같아야 한다. |
| `BNDPERF-001` | Release / Quality | 5.85M low/high, non-empty fixed-width column cold full scan | p95 `<=2 s`; normal fixed-width block 수 `<=92`; max rows/block `65,536`; accepted decoded byte cap 준수 |
| `BNDPERF-002` | Release / Quality | 같은 range warm 5회 이상 | p95 `<=250 ms`, source value read/decoded row `0`, bitmap hit 100% |
| `BNDPERF-003` | Release / Quality | 균일·skew long-string byte-cap fixture | p95는 승인 baseline budget 이내, accepted block byte cap 준수, oversize 후보 폐기·split 계수와 state oracle 일치, peak RSS `<=1.5 GiB` |
| `BNDPERF-004` | Release / Quality | filtered Ctrl+Left/Right 20 random rows | p95 `<=250 ms`, row read `<=1/request`, full-result join 0 |
| `BNDPERF-005` | Release / Quality | cancel during no-boundary scan | cancel 요청부터 terminal `<=2 s`, 추가 accepted decoded bytes는 최대 진행 중 block 하나, resource 0으로 복귀 |

## 6. 13C — CSV prepared source

### 6.1 Prepared counter 계약

```text
csv_open_count, full_parse_count, parsed_rows, parsed_bytes, prepare_build_count,
prepare_commit_count, prepare_cancel_count, fallback_count, prepared_page_reads,
raw_csv_page_reads, source_value_reads, bitmap_build_passes, active_prepare_tasks,
prepared_artifact_bytes, partial_artifact_bytes, open_handles, query_count, copy_count
```

모든 counter는 canonical path, document/session/profile generation과 process owner로 분리한다.

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `PREP13-001` | Unit-R + E2E / Rust Data, Quality | 5.85M CSV cold open | 첫 schema/page는 prepare Ready를 기다리지 않고 표시된다. 상태는 허용 state machine만 전이하고 progress rows/bytes/stage가 단조 증가한다. first-page focus/geometry 이동 0이다. |
| `PREP13-002` | Integration / Quality | profile generation 하나를 Ready까지 준비 | `full_parse_count<=1`, `bitmap_build_passes=1`, 연속 `__dv_row_id`, 정확한 row count와 모든 typed/raw/state가 reference와 같다. bitmap 때문에 두 번째 full scan을 만들지 않는다. |
| `PREP13-003` | Integration/property / Quality | `csv-prepared-matrix`, randomized valid/malformed corpus | direct와 prepared의 schema, typed/raw/state, first/middle/last/EOF page, 여러 projection과 typed error가 독립 oracle과 byte/hash 일치한다. |
| `PREP13-004` | Integration / Quality | Ready 뒤 page, filter/sort, Find, distinct, full-cell, boundary, displayed/raw copy | 모든 consumer가 같은 generation을 사용한다. 추가 `full_parse_count=0`, 원본 `parsed_bytes` 증가 0, query result는 source identity만 저장한다. |
| `PREP13-005` | Integration / Quality | header/delimiter/encoding/profile/null/trim/type 변경 vs display/order/width/visibility/filter/sort 변경 | source semantics 변경은 in-flight를 취소하고 새 generation을 1회 준비한다. display/layout/query-only 변경은 artifact/build count를 바꾸지 않는다. |
| `PREP13-006` | Integration race / Quality | prepare 완료 직전/직후 old page, query, Ctrl 응답 순서 교차 | atomic commit 뒤 old generation 응답 commit 0이다. logical row/column/selection/scroll/focus가 전환 전후 같다. |
| `PREP13-007` | Unit-R + Integration / Rust Data, Quality | parser error, cancel, disk-full, temp cap, permission, source truncate/replace/mtime 변경 | partial artifact를 commit하지 않고 typed terminal reason 뒤 direct fallback이 정확히 동작한다. clipboard stale commit 0, active task/partial bytes 0이다. |
| `PREP13-008` | Integration / Quality | profile/header를 빠르게 10회 변경 | 마지막 generation만 commit하고 앞선 9개 task는 terminal cancel/stale다. full parse는 commit된 각 실제 시작 generation당 최대 1이며 동일 generation 중복 build 0이다. |
| `PREP13-009` | Integration / Quality | close/reopen, same canonical file same/different process, 4/5 concurrent CSV prepares | session-owned artifact와 owner lock이 격리된다. 동시 prepare `<=4`; 5번째는 queued이며 다른 process active artifact 삭제 0이다. close 후 해당 owner handle/task/temp 0이다. |
| `PREP13-010` | Integration + crash harness / Quality, Tauri Platform | success/failure/cancel/close/normal exit/forced exit 후 startup janitor | partial과 dead-owner artifact만 삭제한다. live-owner artifact 보존, source/exe path write 0, process temp cap/safety reserve 준수다. |
| `PREP13-011` | Integration / Quality | prepare 중 page/Ctrl/filter와 copy 동시 실행 | registry/query/source lock을 잡은 장기 parse 0, foreground permanent pending 0, progress interval `<=1 s`, cancel control이 응답한다. |
| `PREP13-012` | Release soak / Quality | prepare→query→page→boundary→copy→close 100회 | active handles/tasks/artifacts 0으로 복귀하고 settled RSS의 선형 증가 추세가 없다. wrong-document/session/query update 0이다. |

### 6.2 실행 가능한 CSV 성능 gate

각 latency scenario는 별도 warm-up 뒤 최소 5회 측정한다. cold는 새 process+빈 app-owned cache, warm은 같은
prepared generation이다. CPU/RAM/OS/storage, DuckDB thread/memory/temp 설정과 raw sample/p50/p95/max를
기록한다.

| ID | 환경 / 담당 | 입력과 기대 counter/예산 |
| --- | --- | --- |
| `CSVPERF-001` | Release backend / Quality | 5.85M low/high/long-invalid prepare elapsed, rows/s, parsed rows/bytes, peak RSS, temp high-water. full parse `<=1`. 절대 p95는 `P13-GATE-005` 값 이하. |
| `CSVPERF-002` | Release backend / Quality | prepare 중 first page와 연속 20 page scroll p50/p95가 승인 direct baseline 회귀율 이내; UI foreground starvation/permanent pending 0. |
| `CSVPERF-003` | Release backend / Quality | Ready 뒤 first/middle/last/random 20 projected pages p95가 승인값 이하; 원본 CSV parsed byte 증가 `0`. |
| `CSVPERF-004` | Release backend / Quality | source-order boundary의 near/far/none cold/warm; warm source read `0`, p95 budget 준수. |
| `CSVPERF-005` | Release backend / Quality | low/high에서 filter-only, sort-only, filter+3-sort 준비와 first page; reference checksum과 p95 budget 준수. |
| `CSVPERF-006` | Release backend / Quality | filtered/sorted boundary cold/warm의 adaptive block, bitmap bytes, raw CSV parsed row 증가. warm source read `0`. |
| `CSVPERF-007` | Release backend / Quality | Ready 뒤 query plan 20회 변경: source full parse 추가 `0`, prepared artifact rebuild `0`. |
| `CSVPERF-008` | Release backend / Quality | 5.85M×1열/대표 다중열 copy rows/s, elapsed, RSS/temp, progress `<=1 s`, cancel terminal `<=2 s`, clipboard partial commit 0. |
| `CSVPERF-009` | Release soak / Quality | 100 cycle에서 handle/task/cache/temp 0 복귀, settled RSS 증가 추세 없음. |
| `CSVPERF-010` | Native Tauri / Tauri Platform | prepare 중 navigation, Ready 전환, random page/Ctrl key-to-visible latency와 permanent pending 0. |
| `CSVPERF-011` | Release candidate comparison / Quality | DuckDB on-disk와 승인 후보를 동일 profile/cap에서 build/page/query/boundary/parity/RSS/temp/cleanup으로 비교하고 선택 근거 JSON 기록. |
| `CSVPERF-012` | NSIS installed release / Tauri Platform | 대표 prepare→warm page→filter/sort→Ctrl이 개발 release와 같은 correctness/counter gate를 만족. |

비율과 무관한 hard resource gate는 process temp `<=10 GiB`, safety reserve `>=5 GiB`, peak RSS
`<=1.5 GiB`, success/failure/cancel/close 뒤 `partial_artifact_bytes=0`, `active_prepare_tasks=0`이다.

## 7. 13D — Shift 없는 다중 정렬 UX

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `SORT13-001` | Unit-TS / Grid UX | header sort click과 Shift+click 각각 4회 | modifier와 무관하게 해당 column의 단일 sort가 asc→desc→clear로 cycle하고 다른 criteria는 제거된다. Shift shortcut text/handler 0이다. |
| `SORT13-002` | Component / Grid UX | `Sorts (0)`에서 Add, logical column 검색, hidden column, direction, remove | Shift 없이 2개 이상 criterion을 만들고 hidden 상태를 표시한다. Add 직후 selector focus, selected duplicate 제외/disabled reason이 정확하다. |
| `SORT13-003` | Unit-TS + wire parity / Root, Grid UX | duplicate, missing column, invalid direction, 64/65 criteria | 서로 다른 유효 column 최대 64개만 허용한다. UI와 Rust/TS wire accept/reject matrix가 같고 64에서 Add disabled reason을 제공한다. |
| `SORT13-004` | Component / Grid UX | direction 변경, remove, Clear all, selector 변경, unchanged Apply | 모든 변경은 draft다. Apply 전 `executeQuery=0`; unchanged Apply는 disabled 또는 query 0; Cancel/Esc/outside는 committed plan을 유지한다. |
| `SORT13-005` | E2E / Quality | criterion drag handle을 pointer down→threshold→move→up으로 first/middle/last 이동 | insertion indicator와 final ordered criteria가 일치하고 방향은 변하지 않는다. HTML/menu Move up/down으로 검증을 대체하지 않는다. internal drag 중 file-drop overlay/openPaths 0이다. |
| `SORT13-006` | Component + E2E / Grid UX, Quality | valid 3 criteria Apply, backend failure | Apply 성공은 query 정확히 1회, badge/count/plan을 함께 갱신한다. 실패는 이전 committed result/selection과 재확인 가능한 draft/error를 유지한다. |
| `SORT13-007` | Integration / Quality | low/high, filter+3-sort, duplicate/null/tie | filter→ordered sort, 양방향 nulls-last, source row ID stable tie-breaker와 copy order가 independent reference와 같다. |
| `SORT13-008` | Component + E2E / Grid UX, Quality | Apply 후 active range와 offscreen target | active column ID/logical row를 preserve/clamp하고 range를 active cell로 축소한다. target page 검증 뒤 focus/scroll을 commit한다. |
| `SORT13-009` | Accessibility + Native / Grid UX, Tauri Platform | 확정 keyboard reorder, select popup, Apply/Cancel | drag handle accessible name/value/priority가 있고 keyboard reorder가 select arrow와 충돌하지 않는다. 실제 WebView2 focus 복귀가 정확하다. |

## 8. 13E — 직접 tab/column pointer drag와 external drop 분리

### 8.1 Drag 계측

browser/native probe는 `internal_drag_started/completed/cancelled`, `external_session_started`,
`file_drop_overlay_shown`, `open_paths_calls`, `reorder_commits`, `click_activations`, `sort_clicks`를 기록한다.

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `DRAG13-001` | Unit-TS / Grid UX | below/at/above threshold, pointer cancel/lost capture/Escape | threshold 미만은 click, 초과는 internal session 하나다. cancel은 order/selection 변경 없이 indicator와 capture를 정리한다. |
| `DRAG13-002` | E2E / Quality | file tab을 실제 `page.mouse` press-hold-move-release로 first/middle/after-last 이동 | target 좌우 half와 indicator가 final ID order와 일치한다. drag 뒤 accidental tab activation 0, active document identity 유지다. |
| `DRAG13-003` | E2E / Quality | column header를 first/middle/after-last로 직접 이동 | width/visibility/filter/sort/active/anchor를 column ID로 보존하고 header/cell/selection/copy column order가 일치한다. |
| `DRAG13-004` | Component + E2E / Grid UX, Quality | overflow tab strip/grid에서 pointer를 좌우 edge에 유지 | bounded auto-scroll이 시작/정지하고 first/last drop이 가능하다. pointer가 edge를 떠난 뒤 timer/task 0이다. |
| `DRAG13-005` | Component / Grid UX | tab close, column resize separator, filter, header sort, sort select에서 gesture | 해당 action만 실행되고 reorder start/commit 0이다. threshold를 넘긴 header drag 뒤 sort click 0이다. |
| `DRAG13-006` | Component + E2E / Grid UX, Quality | 일반 workspace audit | reorder 전용 `...`, `File/Column order menu`, `Move left/right`가 0개다. 접근성 대체는 승인된 숨은 shortcut/handle로만 제공한다. |
| `DRAG13-007` | Unit-TS / Grid UX, Root | internal drag 중 Tauri enter/over/leave/drop, path 없는 over 단독 | internal/external state machine이 분리된다. overlay 0, `openPaths=0`; over는 active external session을 스스로 만들지 않는다. |
| `DRAG13-008` | E2E mock + Native / Quality, Tauri Platform | non-empty external path enter→over→drop, leave/cancel, empty path | active external session+non-empty path에서만 overlay와 open 1회다. drop/leave 뒤 상태 0, empty/pathless event는 open 0이다. |
| `DRAG13-009` | Integration + E2E / Quality | query/cache-valid tab, segmented scroll과 prepared CSV를 reorder | document/session/query/prepared generation, page cache, scroll/segment/focus가 동일하고 tab restore page IPC 0이다. |
| `DRAG13-010` | Geometry + Native / Quality, Tauri Platform | 세 viewport와 100%/150% DPI에서 tab/column/criterion drag | moving item과 insertion indicator가 pointer/target 경계 2px 이내이고 clipping/overlay 혼동이 없다. 실제 Tauri internal drag에서 file-drop overlay 0이다. |

## 9. 13F — Transient surface와 copy status lifecycle

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `SURF13-001` | Unit-TS / Grid UX | copy history/column chooser/sort/filter/copy options/Find options/context menu 각각 trigger, inside, outside, Esc | 공통 transient matrix를 만족한다. trigger 재클릭/outside/Esc는 close, inside interaction은 유지, draft surface outside/Esc는 commit 0이다. |
| `SURF13-002` | Component + E2E / Grid UX, Quality | Copy history open 후 cell/header/toolbar/workspace click | popover가 닫히고 원래 click의 cell selection/button action/focus가 실행된다. outside handler의 event 차단 0이다. |
| `SURF13-003` | Component / Grid UX | Esc vs outside pointer | Esc만 trigger focus를 복원하고 outside는 새 target focus를 유지한다. trigger/target focus loss와 double action 0이다. |
| `SURF13-004` | Component + E2E / Grid UX, Quality | scroll, resize, tab/session/query generation 변경, 다른 transient open | 이전 surface가 닫히고 새 문서에서 자동 open 0이다. 같은 scope에서 동시에 열린 transient surface 최대 1이다. |
| `SURF13-005` | Component / Grid UX | `copy-history-mock`, open 중 status update | current+previous 최대 5개를 ID/time/state/reason으로 구분한다. update가 focus/scroll을 reset하지 않고 사용자가 닫은 history를 자동 open하지 않는다. |
| `SURF13-006` | Unit-TS fake clock + E2E / Grid UX, Quality | copy success, new operation, failure/cancel, Dismiss/Retry | active progress는 terminal까지 유지한다. success는 승인 TTL 뒤 축소하고 history에는 남는다. failure/cancel reason과 Retry는 자동 소멸하지 않으며 Dismiss/다음 성공 규칙이 명시적이다. |
| `SURF13-007` | Component / Grid UX | Column chooser 내부 visibility 3회 변경 후 outside/Esc | 내부 변경 중 열린 상태와 ID visibility를 유지한다. outside는 새 focus 유지, Esc는 trigger focus 복원이다. |
| `SURF13-008` | Component + E2E / Grid UX, Quality | Find bar, Settings, Copy settings, CSV profile/full-value modal에서 cell/workspace outside click | persistent/modal surface는 accidental outside click으로 닫히지 않는다. 기존 focus trap, explicit close/Cancel/Apply 의미가 유지된다. |
| `SURF13-009` | Regression E2E / Quality | filter, copy options, Find options, context menu의 outside/Esc/scroll | Phase 12 close/focus/selection 계약이 회귀하지 않는다. |

## 10. 13G — Value display formats summary/detail UI

| ID | 계층 / 담당 | Fixture·입력 | 기대 결과와 계측 |
| --- | --- | --- | --- |
| `SETUI13-001` | Component / Grid UX | Settings의 Value display formats summary | String/Integer/Decimal/Date/Timestamp/Duration/Boolean/Binary 행과 production formatter 예시를 표시한다. 별도 popup/modal/backdrop/Apply 수 0이다. |
| `SETUI13-002` | Component + E2E / Grid UX, Quality | Timestamp 상세→Advanced, Standard/ISO/Date only, 세부 변경 | Preview가 즉시 실제 formatter 결과로 바뀌고 세부 변경 시 Custom이다. Date only preset은 `timeFormat=hidden`이며 separator/time/fraction/timezone suffix가 없는 날짜만 출력한다. timezone source 설명은 metadata로 유지하고 nested overlay 0이다. |
| `SETUI13-003` | Component + E2E / Grid UX, Quality | Duration 상세, 3 preset, fraction/suffix 변경 | 0/음수/24h 초과 preview와 raw count/unit이 golden과 같고 세부 변경 시 Custom이다. |
| `SETUI13-004` | Component / Grid UX | CSV/Copy/temp draft 변경→type detail→All formats→다른 type | 모든 draft, dialog scroll과 합리적 focus anchor를 보존한다. All formats는 section view만 바꾸며 settings dialog를 닫지 않는다. |
| `SETUI13-005` | Integration + E2E / Root, Quality | Settings Cancel vs Apply 후 representative page/query/detail/default/raw copy | Cancel은 저장/formatter/cache generation 변경 0이다. Apply는 atomic save 1회, 새 page/query/display copy에 같은 조합을 적용하며 source/raw/query 의미는 그대로다. |
| `SETUI13-006` | Accessibility + E2E / Grid UX, Quality | keyboard-only summary/detail/advanced/controls/All formats, Esc | label, current value, expanded state와 focus order가 명확하다. Esc/focus trap은 기존 Settings 계약을 깨지 않고 background grid shortcut을 가로막는다. |
| `SETUI13-007` | Migration integration / Root, Quality | migrated V1/V2/V3와 backup recovery를 UI에서 load/apply/reload | 새 기본 preview가 정확하고 기존 CSV/copy/temp 값은 보존된다. reload round-trip byte/semantic parity와 typed warning/error가 정확하다. |

## 11. 13H — UI, geometry, native, release와 전체 회귀

### 11.1 Playwright interaction과 geometry

`e2e/phase13.spec.ts`는 실제 accessible name을 통합 UI에서 취하고 다음 세 project를 모두 실행한다.

| Project | Viewport |
| --- | --- |
| `desktop-wide` | 1440×900 |
| `desktop-compact` | 1024×768 |
| `desktop-minimum` | 800×600 |

| ID | 상태/입력 | 필수 assertion과 screenshot |
| --- | --- | --- |
| `UI13-001` | CSV prepare Preparing→Ready, Cancelled, Failed fallback | progress geometry/focus가 움직이지 않고 stale page 0; `csv-prepare-{state}-{viewport}.png` |
| `UI13-002` | filtered/sorted Ctrl/Shift target cold/warm | target 완전 가시성, intermediate page 0, pending terminal; `boundary-target-{viewport}.png` |
| `UI13-003` | tab/column/criterion pointer drag first/middle/last와 overflow edge | indicator/target 2px, overlay 0, header/cell/selection 1px 정렬; `drag-{kind}-{viewport}.png` |
| `UI13-004` | Shift 없는 multi-sort add/search/hidden/duplicate/drag/Cancel/Apply/error | panel이 viewport 안이고 grid/toolbar와 비의도 overlap 0; `multi-sort-{viewport}.png` |
| `UI13-005` | Copy history current/previous, success TTL, failure Dismiss/Retry | popover clamp, outside click target focus/selection, layout shift 0; `copy-history-{viewport}.png` |
| `UI13-006` | Column chooser와 transient mutual exclusion, persistent Find/Settings | 동시에 열린 transient 최대 1, persistent accidental close 0; `transient-{viewport}.png` |
| `UI13-007` | Value formats summary, Timestamp detail/Advanced | dialog control clipping/overflow 0; `settings-timestamp-{viewport}.png` |
| `UI13-008` | Duration detail/Advanced와 page/detail/copy | preview/grid/copy text parity, focus order; `settings-duration-{viewport}.png` |
| `UI13-009` | external file drag vs internal drag | pathless/internal overlay 0, valid external overlay 명확; `external-drop-{viewport}.png` |
| `UI13-010` | populated grid, final row, multiline/auto-fit, tab restore regression | physical scrollHeight 안전 상한, final row full visibility, page overflow 0; `grid-regression-{viewport}.png` |

geometry JSON에는 viewport, device scale, surface rect, trigger rect, pointer/indicator/target rect, header/cell/selection
rect, scrollWidth/clientWidth, scrollHeight/clientHeight, focus target, before/after workspace rect와 mounted row/cell 수를
저장한다. 명시적 grid scroll surface 외 body overflow는 1px을 넘지 않는다. transient와 settings 전환은
workspace/grid rect를 1px보다 크게 움직이지 않는다.

### 11.2 실제 Tauri/Windows

| ID | 담당 | 실제 입력과 기대 증거 |
| --- | --- | --- |
| `NATIVE13-001` | Tauri Platform | WebView2에서 tab/column/sort criterion을 pointer로 drag하고 focus/order/indicator를 확인한다. internal drag 중 OS file overlay/open 0. |
| `NATIVE13-002` | Tauri Platform | Explorer의 실제 CSV/Parquet drop은 non-empty path session에서만 overlay/open하며 pathless over와 leave는 open 0. |
| `NATIVE13-003` | Tauri Platform | 실제 5.85M CSV prepare progress/cancel/Ready, random page/query/Ctrl과 20회 tab 왕복. permanent pending/stale/extra reload 0. |
| `NATIVE13-004` | Tauri Platform | Timestamp/Duration settings save→restart→page/query/detail/default/raw Windows clipboard. display hash와 raw metadata hash가 golden과 같다. |
| `NATIVE13-005` | Tauri Platform | Copy history/outside/Esc/scroll, chooser, sort panel과 Settings focus 순서를 실제 pointer/keyboard로 검증한다. |
| `NATIVE13-006` | Tauri Platform | 100%와 150% DPI에서 1440×900/1024×768/800×600 대응 창의 drag/popover/settings/final-row screenshot과 clipping audit. |
| `NATIVE13-007` | Tauri Platform | release/NSIS 설치본에서 Duration Parquet/CSV association/dialog/drop, prepared cache/temp path와 clipboard smoke. dev server/remote-debug port/dynamic plugin 의존 0. |

### 11.3 전체 자동 gate

| ID | 명령 / 담당 | 기대 결과 |
| --- | --- | --- |
| `GATE13-001` | frontend format/lint/typecheck/unit / Root | warning 은폐나 test 기준 완화 없이 PASS |
| `GATE13-002` | `npm run test:e2e` / Quality | 기존 전체 spec과 Phase 13 세 viewport PASS |
| `GATE13-003` | `cargo fmt --check`, clippy `-D warnings`, 전체 Rust tests / Root | PASS |
| `GATE13-004` | debug native build/smoke / Tauri Platform | 실제 IPC/WebView2 PASS, settings snapshot 복원 |
| `GATE13-005` | final Tauri release와 NSIS build / Tauri Platform | PASS, release exe/installer hash·크기·runtime audit 기록 |
| `GATE13-006` | fixture/audit/reference scripts / Quality | manifest SHA, oracle, row/schema/profile 일치 PASS |

## 12. 요구사항 추적표

| 범위 | 핵심 테스트 ID |
| --- | --- |
| 13A 공통 값/설정 | `VAL13-001..010`, `CSV13-DUR-001..002`, `DUR13-QRY-001` |
| 13B adaptive boundary/bitmap | `BND13-001..013`, `BNDPERF-000..005` |
| 13C CSV prepared source | `PREP13-001..012`, `CSVPERF-001..012` |
| 13D Shift 없는 multi-sort | `SORT13-001..009`, `UI13-004`, `NATIVE13-001` |
| 13E direct drag/external drop | `DRAG13-001..010`, `UI13-003/009`, `NATIVE13-001/002` |
| 13F transient surface | `SURF13-001..009`, `UI13-005/006`, `NATIVE13-005` |
| 13G settings summary/detail | `SETUI13-001..007`, `UI13-007/008`, `NATIVE13-004/006` |
| 13H integration/release/native | `UI13-001..010`, `NATIVE13-001..007`, `GATE13-001..006` |

## 13. 완료 전 필수 산출물

- `artifacts/phase-13/fixture-manifest.json`과 독립 reference 결과
- `artifacts/phase-13/boundary-performance-baseline.json`
- `artifacts/phase-13/boundary-performance.json`
- `artifacts/phase-13/csv-prepared-performance-baseline.json`
- `artifacts/phase-13/csv-prepared-candidate-comparison.json`
- `artifacts/phase-13/csv-prepared-performance.json`
- `artifacts/phase-13/ui/geometry-results.json`
- `artifacts/phase-13/ui/interaction-results.md`
- `artifacts/phase-13/ui/visual-review.md`와 세 viewport 핵심 screenshot
- `artifacts/phase-13/ui/native-smoke.md`와 native screenshot/log
- `artifacts/phase-13/50-integration.md`, `90-review.md`

각 결과 파일은 테스트 ID, fixture hash, command/build profile, actual counter/sample, budget, 판정과 미실행 이유를
포함한다. Release/Native/NSIS 항목을 browser PASS로 대체하지 않는다.

## 14. 확정된 계약과 남은 위험

Root는 구현 전에 다음 값을 확정했다.

1. occupancy provider가 채택하는 decoded block hard cap은 8 MiB다. dependency가 반환한 초과 후보는
   값 판정 전에 폐기·분할하고 observed/accepted byte를 구분해 기록한다.
2. bitmap LRU는 query당 최근 8컬럼, process payload cap은 16 MiB다.
3. copy 성공 status TTL은 3,000 ms이며 test 허용 오차는 ±250 ms다.
4. tab/header reorder handle은 `Alt+Shift+Left/Right`, sort criterion handle은
   `Alt+Shift+Up/Down`을 사용하며 visible move button을 두지 않는다.
5. Settings는 V4로 올리고 valid V1/V2/V3 migration을 유지한다. V3 timestamp fractionalDigits는
   보존하고 새 timestamp 필드와 duration은 기본값으로 채운다.
6. Timestamp Date-only preset은 `timeFormat=hidden`이며 timezone conversion은 하지 않는다.
7. CSV Duration은 `sourceUnit=s/ms/us/ns`, `inputFormat=rawInteger/daysClock`을 사용한다.
   `daysClock`은 `[+|-][<unsigned days>d ]HH:MM:SS[.1..9]`, rawInteger는 signed decimal count다.
   filter literal은 daysClock 또는 필수 unit suffix가 붙은 signed integer이며 source unit으로 정확히
   환산되지 않는 값은 거부한다.
8. prepared artifact는 session-owned이며 tab close에서 삭제한다. close/reopen 간 persistent reuse는
   이번 범위가 아니다.

다음 항목은 구현 시작을 막지 않지만 해당 gate 전에 해소해야 하는 남은 위험이다.

- 동일 장비 direct CSV baseline과 fixture SHA-256을 수집한 뒤 candidate 구현의 `CSVPERF-001..012`
  절대 p95와 허용 회귀율을 performance artifact에 고정해야 한다.
- 5.85M high-cardinality와 long-invalid CSV fixture의 생성 시간·disk footprint가 크므로 manifest hash가
  고정되지 않으면 성능 결과를 비교할 수 없다.
- Windows clipboard, Explorer external drop, WebView2 100%/150% DPI와 NSIS installed smoke 환경이
  없으면 `NATIVE13-*`와 `CSVPERF-012`는 BLOCKED이며 Phase 13 완료 조건을 만족하지 못한다.
