# Phase 14 테스트 계획

- 작성일: 2026-07-23
- 상태: Quality 사전 설계 완료, Root 승인 완료
- 범위: `00-scope.md`, `20-ui-design.md`, `30-csv-preparation-architecture.md`
- 원칙: 별도 `선택` 표시가 없는 모든 테스트 ID는 필수다. Browser mock은 release 성능, 실제
  WebView2 pointer 동작 또는 Windows clipboard의 증거를 대체하지 않는다.

## 1. 판정 규칙과 고정 gate

각 ID는 `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN` 중 하나로 기록한다. 필수 ID에 `FAIL`, `BLOCKED`,
`NOT_RUN`이 남거나 아래 계측값이 누락되면 Phase 14를 완료로 판정하지 않는다. timeout 확대, fixture
축소, 원본 압축률 변경, OS cache 결과 선택 또는 counter 제거로 실패를 우회하지 않는다.

| Gate | 고정값 | 완료 판정 |
| --- | --- | --- |
| `P14-GATE-000` | 구현 전 영향 UI baseline 76개 테스트 PASS | candidate에서도 같은 76개와 신규 Phase 14 UI test가 모두 PASS해야 하며, 정확한 명령·commit/executable hash를 integration 기록에 남긴다. |
| `P14-GATE-001` | preparation identity = canonical path + file identity/size/time + header/profile hash + cache schema/application compatibility | 시작·commit 직전 fingerprint가 모두 일치해야 한다. |
| `P14-GATE-002` | background preparation active worker는 process당 기본 1개, writer queue 최대 2 batch | 같은 generation 중복 worker 0, background document는 queue한다. |
| `P14-GATE-003` | 기본 batch 16,384행, 최대 65,536행, accepted Arrow buffers `<=64 MiB` | 실제 Arrow buffer 합계로 판정하고 초과 batch를 writer에 전달하지 않는다. |
| `P14-GATE-004` | cell state 2-bit: valid `00`, null `01`, empty `10`, invalid `11` | valid/invalid는 occupied, null/empty만 empty다. |
| `P14-GATE-005` | checkpoint interval 4,096행, Parquet row group 최대 65,536행 | first/middle/last/EOF와 quoted multiline record에서도 row identity가 일치한다. |
| `P14-GATE-006` | preparation source read `<=file size+1 MiB`; preview+preparation `<=file size×1.01+8 MiB` | 원본 CSV를 감싼 counting reader의 실제 byte만 센다. |
| `P14-GATE-007` | Ready 이후 Ctrl navigation source read `=0` | cache hit/warm 여부와 관계없이 추가 원본 read가 있으면 FAIL이다. |
| `P14-GATE-008` | 5.85M preparation `<=60 s`이며 현행 151.5 s 대비 `>=2.5×` 개선 | 같은 장비·fixture hash·release build의 cold 5회 중 median과 p95 원본 표본을 모두 기록한다. |
| `P14-GATE-009` | process peak RSS `<=1.5 GiB`; cache disk는 source 비율이 아니라 temporary storage hard cap 적용 | raw/typed/state/checkpoint/manifest byte를 구성별로 기록한다. |
| `P14-GATE-010` | multi-sort 최대 64 level; incomplete/duplicate draft는 backend plan이 아니다 | Apply 전 query 0, valid Apply에서만 query 1회다. |
| `P14-GATE-011` | live reflow는 preview transform, 실제 order commit은 drop에서 1회 | pointer move의 document/backend commit과 추가 page/query request는 0이다. |

## 2. 계층, 실행 방식, 담당과 증거

| 표기 | 자동/수동 | 주 담당 | 책임 모듈 | 필수 증거 |
| --- | --- | --- | --- | --- |
| `Unit-R` | 자동 | Rust Data Agent 또는 Root | `src-tauri/src/data/**`, `query/**`, 공통 DTO | test 이름, assertion/counter 결과 |
| `Unit-TS` | 자동 | Grid UX Agent 또는 Root | `src/**` | Vitest 이름과 DOM/state assertion |
| `Integration` | 자동 | Quality Agent + 구현 Agent | source/cache/query/copy 경계 | fixture hash, independent oracle, counter JSON |
| `E2E` | 자동 | Quality Agent | `e2e/phase14.spec.ts`, browser mock | interaction 결과, geometry JSON, screenshot |
| `Release` | 자동 측정 | Quality Agent | release backend/harness | raw samples, p50/p95, RSS/I/O/temp JSON |
| `Native` | 자동 smoke + 사람 시각 검토 | Tauri Platform 검증 | 실제 Rust IPC/WebView2/Windows | native log, screenshot, clipboard hash |
| `NSIS` | 자동 build + 설치 smoke | Tauri Platform 검증 | 설치본 | installer hash, 실행·cache 경로 audit |

구현 Agent는 소유 모듈의 unit/component test를 제품 코드와 함께 작성한다. Quality Agent는 fixture,
독립 oracle, integration/E2E/release benchmark와 사후 독립 검증만 소유한다.

## 3. Fixture와 독립 oracle

생성 fixture는 generator version, seed, row/column count, delimiter/header/profile, 실제 byte size,
SHA-256, 예상 row count와 schema를 `artifacts/phase-14/fixture-manifest.json`에 기록한다. 제품 DuckDB,
제품 Parquet cache 또는 제품 state bitmap으로 oracle을 만들지 않는다.

| Fixture | 내용 | 독립 oracle |
| --- | --- | --- |
| `csv-state-matrix.csv` | header 유/무, empty raw field, null token, invalid integer/date/duration, whitespace, `0`, `false`, quoted comma/LF/CRLF, trailing empty field | Python `csv`, `Decimal`, 정수 시간 계산과 고정 2-bit state JSON |
| `csv-checkpoint-boundaries.csv` | 4,095/4,096/4,097, 65,535/65,536/65,537행 경계에 quoted multiline과 빈 필드 배치 | record start byte와 row/page checksum golden |
| `csv-typed-raw.csv` | `001`, `1`, `1.00`, i64/u64 경계, Decimal, timestamp ns/timezone, duration, invalid 원문 | raw lexeme, typed value/state, default/displayed/raw copy golden |
| `csv-5850000-low.csv` | 5.85M×15 저카디널리티, near/far/no-empty run과 1열 전체 copy용 짧은 값 | seed 기반 closed-form row/state/page/query/copy checksum |
| `csv-5850000-high.csv` | 같은 schema의 고카디널리티 string과 scattered row identity | seed 기반 reference page와 Python stable tuple sort |
| `csv-5850000-long-invalid.csv` | 긴 문자열, 64 MiB batch cap 유도, sparse invalid/null/empty | 생성 시 state/raw hash와 buffer-size reference |
| `csv-fingerprint-matrix/` | path, size, mtime/creation identity, header/profile, schema version을 한 요소씩 변경 | expected hit/miss/invalidate 표 |
| `csv-corrupt-cache/` | missing/truncated Parquet footer, states header/payload, offset index, manifest; valid cache+partial 혼합 | typed rejection과 cleanup 표 |
| `csv-ui-wide` | 80개 variable-width 컬럼, hidden/sorted/filtered 컬럼, multiline/long/null/invalid visible cells | immutable source order, applied order, width/visibility/query/focus JSON |
| `ui-settings-values` | 모든 display type 대표값과 Timestamp/Duration/Decimal 상세 조합 | production formatter golden과 expected typography token |

5.85M fixture는 low/high/long-invalid 모두 같은 row count와 profile을 유지한다. benchmark 전 SHA-256과
release executable hash가 baseline/candidate에서 같은지 먼저 확인한다.

## 4. 계측 계약

### 4.1 Preparation과 cache counter

Integration/release harness는 canonical path, document/session/profile generation과 process owner별로 최소
다음 값을 terminal snapshot에 남긴다.

```text
preview_source_read_bytes, preparation_source_read_bytes,
foreground_source_read_bytes, navigation_source_read_bytes,
source_scan_started, source_scan_completed, parsed_rows, checkpoints_written,
record_batches_accepted, peak_decoded_batch_bytes, writer_queue_peak_batches,
writer_queue_peak_bytes, raw_parquet_bytes, typed_parquet_bytes,
state_bitmap_payload_bytes, checkpoint_index_bytes, manifest_bytes,
total_cache_bytes, prepare_commit_count, prepare_cancel_count,
prepare_failure_count, active_prepare_tasks, queued_prepare_tasks,
partial_artifact_bytes, cache_hit_count, cache_miss_count,
raw_cache_reuse_count, typed_cache_rebuild_count, stale_commit_count,
open_source_handles, active_cache_leases, process_peak_rss_bytes
```

### 4.2 Navigation/query/copy/UI counter

```text
bitmap_word_reads, source_state_gathers, query_identity_rows_read,
source_value_reads, intermediate_page_requests, target_page_requests,
boundary_cache_hits, boundary_cache_misses, navigation_waits,
navigation_cancelled, stale_navigation_commits, query_execute_count,
copy_batches, copy_cells, copy_serialized_bytes, clipboard_commits,
column_reorder_preview_updates, column_reorder_commits,
page_requests_during_drag, file_drop_overlay_shown, open_paths_calls
```

counter가 제품 UI에 상시 노출될 필요는 없지만 test/release harness에서 관찰 가능해야 한다. 카운터가 없어
단일 scan, byte cap, stale commit 또는 no-backend-during-drag를 판정할 수 없으면 해당 ID는 FAIL이다.

## 5. CSV 단일 scan, columnar cache와 값 정확성

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `CSV14-001` | Unit-R 자동 / Rust Data | `csv-state-matrix.csv`를 profile별로 한 번 파싱해 state encode/decode와 occupancy를 전수 비교 | payload는 cell당 정확히 2-bit다. null/empty만 empty이고 invalid, whitespace, `0`, `false`는 occupied다. last partial byte의 unused bit를 읽지 않는다. |
| `CSV14-002` | Unit-R 자동 / Rust Data | row 수 0..65와 column 수 1..17의 state property test | 각 column을 독립적인 `u64` word로 정렬하므로 resident/state payload byte는 `columns×ceil(rows/32)×8`이다. 각 셀은 word 안에서 정확히 2-bit이고 column-major ordinal lookup이 모든 cell golden과 같다. 범위 밖 lookup은 typed error다. |
| `CSV14-003` | Unit-R+Integration 자동 / Rust Data, Quality | `csv-checkpoint-boundaries.csv`의 first/middle/checkpoint/row-group/last/EOF를 1/64열 projection으로 조회 | checkpoint는 4,096행 간격이고 multiline record를 물리 line으로 오인하지 않는다. row ID/page/raw/state checksum mismatch 0, projection cap 준수다. |
| `CSV14-004` | Integration 자동 / Quality | cold preparation 한 generation을 Ready까지 실행 | `source_scan_started=source_scan_completed=1`, row/checkpoint/state/raw/typed가 같은 scan에서 생성된다. 기존 별도 index/prepared full scan과 행 단위 DuckDB 적재가 0이다. |
| `CSV14-005` | Integration 자동 / Quality | `csv-typed-raw.csv`를 direct preview와 Ready cache page/query/detail/copy로 비교 | typed/raw/invalid/null/empty, 64-bit/Decimal/Timestamp/Duration 정밀도가 oracle과 같다. display 문자열은 manifest/cache identity와 typed filter/sort에 저장·사용되지 않는다. |
| `CSV14-006` | Unit-R+Integration 자동 / Rust Data, Quality | 16,384/65,536 경계와 long-string batch를 flush | accepted batch는 행 `<=65,536`, 실제 Arrow buffer `<=64 MiB`; 초과 후보는 writer 전 분할된다. writer queue peak `<=2`고 raw/typed row count가 같다. |
| `CSV14-007` | Integration 자동 / Quality | raw/typed/state/checkpoint writer 중 하나씩 fault 주입 | 어떤 실패도 manifest를 commit하지 않는다. typed terminal error, partial cleanup, 이전 valid cache·clipboard 보존, source directory write 0이다. |
| `CSV14-008` | Integration 자동 / Quality | valid cache build 후 manifest/footer/state/index를 각각 truncate·변조하고 reopen | corrupt/missing/unknown-incompatible cache는 읽지 않고 typed miss 후 안전 재build한다. valid manifest 없는 partial을 Ready로 노출하지 않는다. panic/부분 page 0이다. |
| `CSV14-009` | Integration 자동 / Quality | Ready 뒤 first/middle/last/random page, Find, distinct, full value, filter, 3-sort, default/raw copy | 모든 consumer가 같은 generation/artifact를 사용하고 원본 full scan 추가 0이다. query result는 source row identity만 저장하며 page는 requested projection만 decode한다. |
| `CSV14-010` | Integration 자동 / Quality | filter→3-sort와 3-sort draft→동일 filter plan을 low/high fixture에서 실행 | 실행 의미는 filter 후 ordered multi-sort다. 동일 최종 plan의 ordered row IDs/page/copy checksum이 같고 양방향 nulls-last, source row ID stable tie-breaker가 oracle과 같다. |
| `CSV14-011` | Integration 자동 / Quality | display format/column order/width/visibility/Find를 반복 변경 | source/profile/cache generation, scan/build/state bitmap과 typed query 의미가 변하지 않는다. 화면/default copy만 snapshot 계약대로 갱신된다. |
| `CSV14-012` | Integration 자동 / Quality | profile만 변경한 동일 source를 재준비 | 원본 scan 0, raw Parquet 재사용 1회, typed/state만 새 profile generation으로 재생성한다. old query/page/navigation commit 0이다. |

## 6. Manifest, 무효화, 중단 복구와 생명주기

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `LIFE14-001` | Unit-R 자동 / Rust Data | `csv-fingerprint-matrix`의 canonical path/file identity/size/time/header/profile/schema/app compatibility를 한 요소씩 변경 | 동일 key만 hit한다. source 의미나 호환성 변경은 miss이며 display/layout/query-only 변경은 hit다. |
| `LIFE14-002` | Integration race 자동 / Quality | scan 시작 후 원본 append/truncate/replace/mtime 변경을 commit 직전에 수행 | 시작/commit fingerprint mismatch로 stale worker commit 0, partial 정리, 기존 valid cache 오염 0, 사용자 typed reason을 남긴다. |
| `LIFE14-003` | Unit-R+Integration 자동 / Rust Data, Quality | 모든 writer flush/footer 성공 후 manifest rename 전후 crash/fault 주입 | manifest가 atomic commit point다. 재시작은 완전한 이전/새 cache 중 하나만 보며 반쪽 조합을 읽지 않는다. |
| `LIFE14-004` | Integration 자동 / Quality | 4개 대용량 CSV tab을 연 뒤 active tab을 전환 | active preparation은 최대 1, 나머지는 deterministic queue다. active tab/foreground page·Ctrl·copy가 batch 경계에서 우선되고 장기 mutex로 UI를 막지 않는다. |
| `LIFE14-005` | Integration 자동 / Quality | 같은 session/key 준비 요청 20회와 profile을 빠르게 10회 변경 | 같은 generation active worker 최대 1, 마지막 generation만 commit, stale commit 0이다. 각 cancelled worker는 terminal state 하나와 partial 0을 남긴다. |
| `LIFE14-006` | Integration 자동 / Quality | 4,096행 경계마다 cancel, close, session replace | 요청 후 terminal `<=1 s`; source handle/task/writer queue/cache lease/partial byte가 0으로 복귀하고 늦은 progress/page/Ready commit 0이다. |
| `LIFE14-007` | crash harness 자동 / Quality | 정상 종료, 강제 종료, 실패, cancel 뒤 재시작 janitor | dead-owner partial만 제거하고 valid persistent cache와 live-owner artifact는 보존한다. 다른 process/source/exe directory 삭제·쓰기 0이다. |
| `LIFE14-008` | Integration 자동 / Quality | valid L2 cache를 close/reopen, 앱 재시작, 다른 document로 reopen | fingerprint hit는 원본 scan 0, `<=1 s` Ready이며 raw/typed/state/footer 기본 검증을 한다. document/session identity는 새로 발급하고 old query/result를 재사용하지 않는다. |
| `LIFE14-009` | Integration 자동 / Quality | temp hard cap 바로 아래/위, free-space safety reserve, LRU 압박, active lease | 예상치가 budget을 넘기기 전 다음 batch write를 중단한다. active lease는 evict하지 않고 inactive LRU만 제거하며 모든 구성별 실제 byte와 typed error를 기록한다. |
| `LIFE14-010` | release soak 자동 / Quality | low/high 파일 prepare/query/copy/close/reopen 100 cycle | active task/lease/handle/partial/temp가 cycle마다 기준으로 복귀한다. settled RSS·handle·cache entry에 증가 추세가 없고 다른 process cache를 삭제하지 않는다. |

## 7. Ctrl 경계 탐색과 query bitmap

### 7.1 Excel 경계 oracle

방향별 state vector에 대해 다음 대칭 규칙을 독립 oracle로 사용한다.

- 현재와 다음 cell이 occupied면 현재 occupied run의 마지막으로 이동한다.
- 현재 occupied이고 다음이 empty면 다음 occupied run의 첫 cell로 이동하며 없으면 표 경계로 간다.
- 현재가 empty면 방향상 다음 occupied cell로 이동하며 없으면 표 경계로 간다.
- `Shift`는 기존 anchor에서 같은 target까지 확장하고, `Ctrl+Alt`는 state를 읽지 않는다.

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `NAV14-001` | Unit-R property 자동 / Rust Data | `csv-state-matrix.csv`의 모든 start/direction/current-next state 조합 | Up/Down target이 oracle과 같고 valid/invalid vs null/empty 의미가 정확하다. first/last와 row-count 비배수 bitmap word를 넘지 않는다. |
| `NAV14-002` | Unit-R+Integration 자동 / Rust Data, Quality | unfiltered low/high의 near/far/no-boundary column에서 Ctrl+Up/Down cold/warm | 고정 200행 page loop와 source value decode 0, bitmap word scan으로 정확한 target을 찾는다. warm은 boundary cache/OS cache와 무관하게 원본 read 0이다. |
| `NAV14-003` | Unit-R+E2E 자동 / Rust Data, Quality | current row의 first/middle/last visible column에서 Ctrl+Left/Right; hidden column 포함 | 현재 row의 visible-column state만 검사하고 hidden column은 건너뛴다. DuckDB/page query와 전체 row decode 0, target/Shift selection이 applied visual order oracle과 같다. |
| `NAV14-004` | Integration 자동 / Quality | preparation frontier 안/밖 target, scan 진행 중 새 navigation과 cancel | frontier 안은 즉시 bitmap 응답, 밖은 같은 coordinator 진전을 기다린다. 별도 sequential source fallback/worker 0; 새 navigation은 이전 wait를 취소하고 stale commit 0이다. |
| `NAV14-005` | Integration 자동 / Quality | filter-only, sort-only, filter+3-sort의 scattered source IDs에서 네 방향 Ctrl | query logical position→source row ID→source state gather가 최종 query 순서를 보존한다. 256→4,096→16,384→65,536 adaptive cap과 known/occupied cache가 유지된다. |
| `NAV14-006` | Integration 자동 / Quality | 같은 query/column/range cold 후 5회 왕복 | warm은 query identity/source state 재조회 0, bitmap hit 100%, target mismatch 0이다. query/session/profile 변경만 cache를 폐기하고 display/layout 변경은 유지한다. |
| `NAV14-007` | Unit-R+E2E 자동 / Rust Data, Quality | Ctrl+Alt와 Ctrl+Alt+Shift 네 방향 | occupancy/value/source read 0; row count와 first/last visible column bound만 쓴다. Shift anchor/rect와 active cell이 target page 검증 후 commit된다. |
| `NAV14-008` | E2E 자동 / Quality | Ctrl/Ctrl+Shift target page cache hit/miss, 연속 shortcut queue | shortcut당 boundary IPC 1, intermediate page request 0, target page miss 최대 1이다. 앞 target commit 뒤 다음 key를 처리하고 selection/focus/scroll이 완전한 target cell에 맞는다. |
| `NAV14-009` | Integration race 자동 / Quality | navigation 중 mouse click, ordinary key, focus loss, query/session/tab change, target page failure | cancel/identity 검증으로 stale target/selection/scroll commit 0이다. 실패 시 이동 전 상태를 보존하고 permanent pending이 없다. |

## 8. Query, 대용량 copy와 성능·byte gate

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `PERF14-001` | Release 자동 / Quality | low/high cold preview 10회 | preview p95 `<=500 ms`; schema/첫 page를 preparation Ready 전에 표시하고 UI thread 장기 block 0이다. |
| `PERF14-002` | Release 자동 / Quality | low/high/long-invalid cold preparation 5회 | background source read `<=size+1 MiB`, preview+preparation `<=size×1.01+8 MiB`; source scan 1회다. raw sample과 median/p95를 저장한다. |
| `PERF14-003` | Release 자동 / Quality | 5.85M low baseline 151.5 s와 candidate 동일 fixture/장비 비교 | candidate 전체 preparation `<=60 s`이고 `>=2.5×` 개선이다. 절대 시간과 개선율 둘 중 하나라도 실패하면 FAIL이다. |
| `PERF14-004` | Release 자동 / Quality | first/middle/last/random 100개 Ready page | page p95 `<=20 ms`, request당 최대 200행/64열과 requested projection만 decode한다. permanent pending/error 0이다. |
| `PERF14-005` | Release 자동 / Quality | unfiltered Ctrl Up/Down cold·warm 각 50회, Left/Right 50회 | vertical cold p95 `<=100 ms`, warm `<=20 ms`, horizontal `<=20 ms`; Ready 이후 navigation source read `=0`, intermediate page 0이다. |
| `PERF14-006` | Release 자동 / Quality | filtered/sorted Ctrl boundary cold·warm 각 50회 | cold p95 `<=250 ms`, warm `<=20 ms`; logical target oracle, adaptive/state gather cap, stale/pending 0이다. |
| `PERF14-007` | Release 자동 / Quality | low/high에서 filter+3-sort 20회 | 목표 `<=1 s`, hard gate p95 `<=2 s`; row count/order/tie/nulls-last checksum이 oracle과 같다. temp/RSS hard cap 준수다. |
| `PERF14-008` | Release 자동 / Quality | 64,000행×1열 default/raw copy 각 20회 | p95 `<=150 ms`, source/page/value IPC 0, serialized checksum과 representation snapshot이 oracle과 같다. |
| `PERF14-009` | Integration+Release 자동 / Quality | 5.85M행×1열 source와 filter+sort 전체 선택 copy | bounded streaming은 최대 `ceil(rows/64,000)` data batch, progress/cancel을 제공한다. filtered row와 sorted order만 복사하고 page IPC 0, clipboard commit은 성공 시 1회다. elapsed/throughput/RSS/temp를 기록한다. |
| `PERF14-010` | Integration+Native 자동 / Quality, Tauri Platform | full copy를 시작·중간·마지막 batch에서 cancel/fault/stale query로 종료 | partial system clipboard commit 0, 이전 clipboard hash 유지, typed terminal reason/operation ID가 current/history에서 구분된다. 성공만 atomic commit 1회다. |
| `PERF14-011` | Release 자동 / Quality | long-invalid에서 adaptive batch와 queue pressure | peak decoded accepted batch `<=64 MiB`, queue `<=2`, process peak RSS `<=1.5 GiB`; 초과 예상은 split 또는 typed budget error 후 partial 0이다. |
| `PERF14-012` | Release 자동 / Quality | cache 구성별 실제 byte와 첫 batch 예상치 비교 | raw/typed/state/checkpoint/manifest/total/cache-to-source를 모두 기록한다. source 1.1배를 cache hard gate로 사용하지 않으며 실제 total은 temp limit 이하다. |
| `PERF14-013` | Release 자동 / Quality | valid persistent cache hit 20회 reopen | 원본 scan/read 0, Ready p95 `<=1 s`, page/query/Ctrl/copy 정확성이 cold build와 같다. |

## 9. Multi-sort blank draft UX

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `SORT14-001` | Unit-TS 자동 / Grid UX | `Add level`을 1회 누름 | stable `draftId`, 빈 `columnId`, ascending/nulls-last 기본 행을 즉시 만들고 combobox에 focus·open한다. query execute 0이다. |
| `SORT14-002` | Component 자동 / Grid UX | direction을 먼저 바꾼 뒤 column 선택, column 먼저 선택 뒤 direction 변경 | 두 순서 모두 같은 valid plan을 만들며 `draftId`는 변하지 않는다. 기존 하단 Find/Column to add/Add 조합은 DOM에 없다. |
| `SORT14-003` | Component+E2E 자동 / Grid UX, Quality | 검색어 empty/부분/대소문자, hidden/visible 80개 source column | empty 검색은 모든 source column을 schema 순서로 보여준다. 부분 검색은 case-insensitive이고 hidden은 `(Hidden)`, 다른 row의 선택값은 `Already used` disabled다. |
| `SORT14-004` | Unit-TS 자동 / Grid UX | empty/missing/duplicate/65개, valid 64개 draft | invalid/incomplete는 Apply disabled와 행별 이유를 제공하고 backend plan으로 변환하지 않는다. 최대 64개 valid row만 허용하며 64에서 Add disabled다. |
| `SORT14-005` | Component+E2E 자동 / Grid UX, Quality | 빈/완성 row를 first/middle/last로 pointer·keyboard reorder하고 삭제 | reorder identity는 `draftId`, priority는 1부터 재번호화하고 column/direction은 보존한다. internal drag 중 file overlay/open 0이다. |
| `SORT14-006` | Component+E2E 자동 / Grid UX, Quality | draft 변경 후 Cancel/outside/Escape/Clear all/0개 Apply/valid 3개 Apply | Cancel/outside/Escape는 applied plan/query를 보존한다. Clear all은 draft만 비우며 0개 Apply는 source-order sort로 복귀, valid Apply는 query 정확히 1회다. |
| `SORT14-007` | Integration+E2E 자동 / Quality | valid Apply 성공/실패 후 offscreen active range | 성공은 logical row/column을 preserve·clamp하고 range를 active cell로 축소한다. 실패는 committed result/selection과 재확인 가능한 draft/error를 유지한다. |
| `SORT14-008` | Accessibility+Native 자동/수동 / Grid UX, Tauri Platform | keyboard-only Add/search/select/direction/reorder/remove/Apply/Cancel | role/name/expanded/priority/focus order가 명확하고 select arrow와 reorder shortcut이 충돌하지 않는다. 실제 WebView2 focus 복귀가 같다. |

## 10. Settings inline accordion과 typography

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `SET14-001` | Component 자동 / Grid UX | Settings와 Copy settings의 computed style 감사 | dialog title 16px/650, section 13px/650, 일반 control 12px, type name 12px/650, preview/help 11px다. fixed-height clipping 없이 min-height/line-height를 사용한다. |
| `SET14-002` | Component+E2E 자동 / Grid UX, Quality | Value display formats 첫 화면 | 8개 type의 primary control과 production preview가 동시에 보인다. Integer/Date/Boolean에는 detail toggle이 없고 nested modal/backdrop/All formats 화면 전환이 없다. |
| `SET14-003` | Component+E2E 자동 / Grid UX, Quality | String/Decimal/Timestamp/Duration/Binary detail을 순서대로 open/hide | 동시에 expanded panel 최대 1개다. 다른 panel을 열어도 모든 draft가 유지되고 dialog scroll/focus가 불필요하게 reset되지 않는다. |
| `SET14-004` | Unit-TS+Integration 자동 / Grid UX, Quality | primary/detail 대표·경계값을 변경해 preview→Apply→새 page/query/default/displayed/raw copy 확인 | preview는 즉시 production formatter와 같다. Apply 전 backend/settings/cache generation 0, Cancel은 변화 0, Apply는 atomic save 1회다. raw/query 의미는 바뀌지 않는다. |
| `SET14-005` | Component+E2E 자동 / Grid UX, Quality | minimum에서 Timestamp detail, compact에서 Decimal, wide에서 Duration | wide/compact detail 2열, minimum 1열이다. dialog 내부만 scroll하고 footer 가시성, focus trap, body overflow와 background grid shortcut 차단이 유지된다. |
| `SET14-006` | Accessibility+Native 자동/수동 / Grid UX, Tauri Platform | keyboard-only primary/toggle/detail/Apply/Cancel, 100%/150% DPI | label/current value/expanded state와 focus order가 명확하다. Windows font rendering에서 title/label/preview/control/footer clipping·overlap 0이다. |

## 11. Full-column live reflow drag와 source-order restore

| ID | 계층·방식 / 담당 | Fixture와 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `DRAG14-001` | Unit-TS 자동 / Grid UX | variable-width source/moving/target order로 preview prefix delta 계산 | source를 제외한 preview order와 실제 width prefix 차이가 golden과 같다. pointer move는 applied order를 변경하지 않는다. |
| `DRAG14-002` | Component+E2E 자동 / Grid UX, Quality | 6px 미만/이상 pointer 이동 후 first/middle/last 삽입 | threshold 미만은 정상 click, 이상은 floating strip 1개다. source header+mounted visible cells만 복제하며 source width/row height/content/state/selection이 같다. |
| `DRAG14-003` | Geometry E2E 자동 / Quality | variable width column을 다른 width 사이로 이동 | non-moving header와 각 mounted cell은 같은 X transform이고 실제 moving width만큼 gap을 만든다. header/cell/selection 정렬 오차 `<=1 CSS px`; 굵은 insertion line이 없다. |
| `DRAG14-004` | Component+E2E 자동 / Grid UX, Quality | drag 중 pointer move 100회 후 drop | document/backend order commit은 drop에서 정확히 1회, page/query request와 full-grid document reorder 0이다. commit frame visual jump `<=1 px`다. |
| `DRAG14-005` | Component+E2E 자동 / Grid UX, Quality | Escape/pointercancel/lost capture/window blur와 resize/filter/sort control gesture | cancel은 applied order·selection·focus를 보존하고 transform/capture를 정리한다. 전용 control은 자기 action만 실행하며 reorder/sort accidental action 0이다. |
| `DRAG14-006` | E2E+Native 자동/수동 / Quality, Tauri Platform | overflow grid edge에 pointer 유지, vertical wheel, internal Tauri drag event | horizontal edge auto-scroll과 target 갱신은 계속되고 edge 이탈 시 task 0이다. vertical scroll은 잠기며 internal drag 중 file overlay/open path 0이다. |
| `DRAG14-007` | Geometry E2E 자동 / Quality | floating strip bounding rect를 grid/toolbar/footer와 비교 | overlay는 grid viewport에 clip되고 toolbar/footer를 덮지 않는다. pointer offset, width, visible content height가 source와 같고 `pointer-events:none`, `aria-hidden=true`다. |
| `RESET14-001` | Unit-TS 자동 / Grid UX | source `[A,B,C,D]`, applied `[C,A,X,B,D]`에서 restore | 결과 `[A,B,C,D,X]`; 잔여 ID 상대 순서를 보존한다. width/visibility/filter/sort/Find/query/row/active column ID와 selection 의미는 불변이다. |
| `RESET14-002` | Component+E2E 자동 / Grid UX, Quality | source order/changed order/drag session에서 icon button 상태 | accessible name·tooltip은 `Restore source column order`; source order와 drag 중 disabled, changed order에서 enabled다. 공간이 고정되어 layout shift 0이다. |
| `RESET14-003` | E2E 자동 / Quality | offscreen active column이 있는 reordered grid를 restore | order commit 1회 뒤 같은 active column ID가 보이도록 horizontal scroll 1회, header/cell/selection/copy column order가 일치한다. page/query/cache generation은 불변이다. |
| `RESET14-004` | E2E+Native 자동/수동 / Quality, Tauri Platform | 두 document에서 서로 다른 order/width/visibility를 저장하고 restore·tab 왕복 | source/applied order는 document별 독립이다. 다른 tab 상태와 cached page를 건드리지 않고 복귀 first paint blur/blank/loading/page IPC 0이다. |

## 12. Playwright interaction, DOM geometry와 screenshot

`e2e/phase14.spec.ts`는 accessible locator와 실제 pointer/keyboard 입력을 사용하며 다음 세 project를 모두
실행한다.

| Project | Viewport |
| --- | --- |
| `desktop-wide` | 1440×900 |
| `desktop-compact` | 1024×768 |
| `desktop-minimum` | 800×600 |

| ID | 자동 절차 / 담당 | 필수 assertion과 screenshot |
| --- | --- | --- |
| `UI14-001` | Preparing→Ready, frontier wait/cancel/failure/cache-hit / Quality | progress rect와 grid/focus가 움직이지 않고 stale page 0; `csv-preparation-{state}-{viewport}.png` |
| `UI14-002` | source/filter/sort Ctrl 네 방향과 Shift/Alt 조합 / Quality | target cell 완전 가시성, intermediate page 0, permanent pending 0; `csv-boundary-{viewport}.png` |
| `UI14-003` | blank level add, all-column search, hidden/duplicate, draft drag, Apply/Cancel / Quality | panel clipping/overlap 0, focus·query count·plan assertion; `multi-sort-{viewport}.png` |
| `UI14-004` | Settings 기본 화면과 Timestamp/Duration/Decimal accordion / Quality | computed font, 한 panel, dialog-only scroll, footer 가시성; `settings-inline-{viewport}.png` |
| `UI14-005` | variable-width first/middle/last column live drag와 edge auto-scroll / Quality | floating header/cell strip, live gap, 1px 정렬, overlay 0; `column-live-drag-{viewport}.png` |
| `UI14-006` | source-order reset 전/후와 offscreen active column / Quality | preserved width/visibility/query/focus, one scroll/commit; `column-source-order-{viewport}.png` |
| `UI14-007` | 5.85M segmented last row와 horizontal scrollbar 회귀 / Quality | 마지막 row content/border가 완전히 보이고 scrollHeight 안전 상한·selection 정렬 유지; `grid-last-row-{viewport}.png` |
| `UI14-008` | full copy current/progress/failure/history와 tab cache 복귀 / Quality | typed reason/operation 구분, outside lifecycle, zero reload/blur/blank; `copy-cache-return-{viewport}.png` |

`artifacts/phase-14/ui/geometry-results.json`에는 viewport, device scale, dialog/toolbar/grid/header/cell/
selection/floating strip/gap/footer rect, transform, source/target width, scrollWidth/clientWidth,
scrollHeight/clientHeight, body overflow, mounted row/cell 수, focus target와 before/after workspace rect를 저장한다.

- grid 자체의 `.virtual-grid-scroll`처럼 문서화된 scroll surface만 의도된 overflow 예외다.
- header/cell 시작점·너비 오차는 `<=1 CSS px`, selection outline은 cell 경계 `<=2 CSS px`다.
- body와 non-scroll container의 설명되지 않은 overflow/overlap/clipping은 1px도 허용하지 않는다.
- loading/accordion/reorder/reset 전후 workspace/grid rect의 의도하지 않은 이동은 `<=1 px`다.
- floating strip의 DOM 수는 mounted row 수+header에 비례하고 logical 전체 row를 복제하지 않는다.

Quality Agent는 세 viewport 이미지 전부를 직접 열어 겹침, 잘림, 빈 공간, 글자 위계, focus/disabled/
loading 구분, header-cell 정렬, layout shift와 색상 외 상태 표시를 검토하고
`artifacts/phase-14/ui/visual-review.md`에 PASS/FAIL 근거를 남긴다.

## 13. 실제 Tauri, release와 전체 회귀

| ID | 방식 / 담당 | 실제 절차 | 기대 결과와 완료 gate |
| --- | --- | --- | --- |
| `NATIVE14-001` | Native 자동+수동 / Tauri Platform | 실제 5.85M low/high CSV cold open→progress→Ready→random page | single scan/read byte/RSS/temp/time counter와 화면 상태가 release gate를 만족하고 permanent pending·stale flash 0이다. |
| `NATIVE14-002` | Native 자동+수동 / Tauri Platform | source/filter/3-sort에서 Ctrl/Ctrl+Shift/Ctrl+Alt 네 방향을 cold/warm 실행 | key-to-visible target과 selection/focus가 oracle과 같고 Ready navigation source read·intermediate page 0이다. |
| `NATIVE14-003` | Native 수동+가능한 CDP 자동 / Tauri Platform | WebView2 실제 pointer로 variable-width column을 first/middle/last/edge에 drag | full visible strip/live reflow/commit/cancel이 보이며 internal drag 중 OS file-drop overlay/open 0이다. native screenshot과 interaction log를 남긴다. |
| `NATIVE14-004` | Native 자동+수동 / Tauri Platform | multi-sort blank draft와 Settings inline accordion을 keyboard/pointer로 조작 | query count, Apply/Cancel, focus trap, production preview가 browser와 같고 100%/150% DPI에서 clipping 0이다. |
| `NATIVE14-005` | Native 자동 / Tauri Platform | 5.85M×1열 source와 filtered/sorted copy를 Windows clipboard에 기록·hash | 성공은 atomic commit 1회, TSV row/order/hash가 oracle과 같다. cancel/failure는 기존 clipboard를 보존한다. |
| `NATIVE14-006` | Native 자동+수동 / Tauri Platform | cache hit reopen, 20회 tab 왕복, source-order restore | reopen scan 0/Ready 1초, tab 복귀 page IPC·blur·blank 0, restore가 query/width/visibility/focus를 보존한다. |
| `NATIVE14-007` | Native 수동 / Tauri Platform | 1440×900, 1024×768, 800×600 대응 창과 100%/150% DPI screenshot | typography, accordion footer, floating strip, last row, scrollbar와 focus/selection clipping·overlap 0이다. |
| `GATE14-001` | 자동 / Root | frontend format, lint, typecheck, 전체 unit/component | warning 은폐·기준 완화 없이 PASS다. |
| `GATE14-001A` | 자동 / Root, Quality | 구현 전 PASS한 영향 UI baseline 76개를 candidate에서 동일 조건으로 재실행 | 기존 76개 전부 PASS이고 삭제·skip·timeout 완화 0이다. 신규 Phase 14 test 결과와 분리해 개수를 기록한다. |
| `GATE14-002` | 자동 / Quality | `npm run test:e2e` | Phase 14 포함 전체 spec이 세 viewport 모두 PASS다. |
| `GATE14-003` | 자동 / Root | `cargo fmt --check`, clippy `-D warnings`, 전체 Rust test | PASS다. |
| `GATE14-004` | 자동 / Quality | fixture generator/oracle/audit/benchmark scripts | manifest SHA, row/schema/profile, raw oracle와 counter completeness가 PASS다. |
| `GATE14-005` | 자동 / Tauri Platform | debug native build/CDP smoke | 실제 IPC/WebView2 PASS, test settings/cache isolation과 원상복구가 확인된다. |
| `GATE14-006` | 자동 / Tauri Platform | final Tauri release와 NSIS build/install smoke | exe/installer hash·크기·runtime audit, app-local cache 경로, dev server/remote debug/dynamic plugin 의존 0이다. |
| `GATE14-007` | 자동 / Root, Quality | 기존 CSV/Parquet/H5, query/page/copy/navigation/display 전체 회귀 | Phase 13까지의 필수 자동 gate에 새 FAIL이 없다. Parquet/H5 source reader와 값 정밀도 계약이 불변이다. |

실제 150% DPI, Windows clipboard 또는 NSIS 설치 환경이 없어 필수 native 항목을 실행하지 못하면
근거 없이 PASS 처리하지 않고 `BLOCKED`로 기록하며 Phase 14를 완료로 바꾸지 않는다.

## 14. 요구사항 추적표

| 요구사항 | 핵심 테스트 ID |
| --- | --- |
| 단일 source scan·Arrow/Parquet cache | `CSV14-003..009`, `PERF14-002..004/011/012` |
| 2-bit bitmap과 빈 셀 의미 | `CSV14-001/002`, `NAV14-001..006` |
| manifest·fingerprint·무효화·중단 복구 | `CSV14-007/008`, `LIFE14-001..010` |
| filter/multi-sort/query page 정확성 | `CSV14-009/010`, `NAV14-005/006`, `PERF14-007` |
| 대용량 default/raw/query copy | `CSV14-005/009`, `PERF14-008..010`, `NATIVE14-005` |
| source read/decoded/RSS/cache byte gate | `PERF14-002/003/011/012`, `P14-GATE-006..009` |
| Ctrl source/query 네 방향·target-only | `NAV14-001..009`, `PERF14-005/006`, `NATIVE14-002` |
| blank-first multi-sort UX | `SORT14-001..008`, `UI14-003`, `NATIVE14-004` |
| Settings inline accordion·typography | `SET14-001..006`, `UI14-004`, `NATIVE14-004/007` |
| full-column live reflow drag | `DRAG14-001..007`, `UI14-005`, `NATIVE14-003/007` |
| source-order restore | `RESET14-001..004`, `UI14-006`, `NATIVE14-006` |
| 세 viewport geometry·시각·실제 Tauri | `UI14-001..008`, `NATIVE14-001..007`, `GATE14-002/005/006` |

## 15. 완료 전 필수 산출물

- `artifacts/phase-14/fixture-manifest.json`
- `artifacts/phase-14/csv-preparation-baseline.json`
- `artifacts/phase-14/csv-preparation-performance.json`
- `artifacts/phase-14/csv-navigation-performance.json`
- `artifacts/phase-14/csv-query-copy-performance.json`
- `artifacts/phase-14/cache-byte-audit.json`
- `artifacts/phase-14/lifecycle-soak.json`
- `artifacts/phase-14/ui/geometry-results.json`
- `artifacts/phase-14/ui/interaction-results.md`
- `artifacts/phase-14/ui/visual-review.md`와 세 viewport 핵심 screenshot
- `artifacts/phase-14/ui/native-smoke.md`와 native screenshot/log
- `artifacts/phase-14/50-integration.md`
- `artifacts/phase-14/90-review.md`

각 결과 파일은 테스트 ID, fixture/executable hash, command/build profile, 장비·filesystem, cold/warm 조건,
actual counter/raw sample, 예산, 판정과 미실행 이유를 포함한다. 성능은 평균 하나가 아니라 원본 표본과
p50/p95를 남기고, source read byte와 cache/RSS/I/O를 서로 섞지 않는다.

## 16. 독립 사후 검증 순서

1. Quality Agent가 fixture manifest와 independent oracle을 먼저 검증한다.
2. 영향받는 Rust/TS unit과 integration을 실행해 correctness/counter FAIL을 먼저 제거한다.
3. release에서 단일 scan, byte, RSS, preparation/navigation/query/copy 성능을 측정한다.
4. `e2e/phase14.spec.ts`와 전체 Playwright를 세 viewport에서 실행하고 geometry JSON을 감사한다.
5. 성공 screenshot을 직접 열어 시각 검토한다.
6. 실제 Tauri/WebView2/Windows clipboard와 100%/150% DPI smoke를 수행한다.
7. 코드 확정 뒤 전체 frontend/Rust, final release/NSIS build를 각각 한 번 실행한다.
8. 모든 필수 ID를 `50-integration.md`와 `90-review.md`에서 추적하고 HIGH/MEDIUM 결함이나 필수
   BLOCKED가 없을 때만 Root가 Phase 상태를 완료로 바꾼다.
