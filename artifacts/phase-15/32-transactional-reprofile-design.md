# Phase 15 transactional reprofile 정적 설계

- 작성일: 2026-07-23
- 범위: 기존 hybrid compact v3 cache를 raw foundation으로 재사용하는 backend 설계와 테스트 계획
- 구현 상태: **정적 설계만 완료, 코드 변경 없음**
- 직접 대응 gate: `P15-CACHE-002`, `P15-CACHE-006`, `P15-CACHE-007`,
  `P15-BYTE-004`, `P15-PUBLISH-004~006`, `P15-FRONTIER-003`

## 1. 결론

profile 변경은 원본 CSV 준비를 다시 실행하는 작업이 아니라, 이미 lease 중인 valid compact v3
cache의 `__dv_base_raw_<sourceIndex>` 열을 입력으로 삼는 **cache-to-cache 변환**이어야 한다.

```text
현재 old session (계속 서비스)
  └─ Arc<CsvPreparedArtifact>
       └─ shared persistent cache lease
            └─ old prepared.parquet의 all-source __dv_base_raw_*
                 │
                 ├─ bounded Parquet batch read
                 ├─ target profile cast
                 ├─ target typed/value + all-source packed state 생성
                 ├─ visible-column states.bin 생성
                 ├─ offsets.idx 재사용
                 └─ target cache directory atomic publish
                        │
                        ├─ target query artifact를 reserved session에 먼저 설치
                        └─ document source/session compare-and-swap
                               ├─ 성공: new session 공개, old session stale 처리
                               └─ 실패/취소: old session과 old lease 그대로 유지
```

핵심 선형화 지점은 둘이다.

1. cache publication은 기존과 같이 immutable target directory를 stable key로 rename하는 순간이다.
2. 사용자에게 보이는 profile 변경은 이미 Ready인 target artifact를 reserved session에 설치한 뒤
   `DocumentRegistry`가 old session을 new session으로 compare-and-swap하는 순간이다.

그 전까지 old session의 page, query, navigation과 copy는 계속 동작한다. 교체와 겹친 old session의
늦은 응답은 기존 stale-session 규칙대로 폐기한다. 교체가 끝난 뒤에도 old session을 동시에 active로
유지하는 다중-version UI는 범위가 아니다.

## 2. 현재 코드에서 source 재scan이 발생하는 이유

### 2.1 physical cache는 재profile에 충분하다

현재 compact v3 Parquet에는 다음 foundation이 이미 존재한다.

- `__dv_row_id`
- profile의 `Skip` 여부와 관계없는 **모든 source 열**의 `__dv_base_raw_<sourceIndex>`
- target profile에 필요한 `__dv_value_<sourceIndex>`
- 모든 source 열 상태를 32열씩 묶은 `__dv_state_word_<wordIndex>`
- 별도 `states.bin`과 `offsets.idx`

여기서 raw는 source byte lexeme가 아니라 Rust `csv` parser가 quote, escape와 record 경계를 처리한 뒤
반환한 **decoded field 문자열**이다. 따라서 quoted comma, doubled quote, quoted LF/CRLF도 재profile에
필요한 원문 의미를 잃지 않는다. 따옴표 자체나 원래 line ending byte를 복원하는 것은 계약이 아니다.

### 2.2 identity가 source와 profile을 묶고 있다

`CsvQueryProvider::reusable_source_identity()`는 현재 path, header 사용 여부와
`CsvParsingProfile` 전체 JSON을 합친다. 이 JSON에는 UI의 `generation`도 들어간다.
`CsvPersistentCache::cache_key()`도 이 identity를 포함한다. 그 결과 다음 경우 모두 다른 cache miss가
된다.

- Text → Int64 같은 실제 profile 변경
- Skip 추가·해제
- option은 같고 generation만 증가한 동일 설정 재적용

### 2.3 apply가 source 검증과 session 교체를 먼저 한다

현재 `apply_csv_profile`은 `CsvSource::prepare_profile()`을 호출한다. 이 함수는 새 source를 다시 열고
`validate_profile()`로 전체 source를 읽는다. 그 다음 old query를 drop하고 document session을 교체한
뒤 새 preparation을 시작한다. 즉, cache raw가 있어도 source를 읽으며 preparation 실패 시 old Ready
session을 그대로 제공할 수 없다.

## 3. 반드시 고정할 불변식

| 불변식 | 계약 |
| --- | --- |
| raw 정확성 | 모든 source 열의 decoded field가 `__dv_base_raw_*`에 exact하게 존재한다. |
| source I/O | valid old lease를 사용한 validate/apply/reprofile의 `source_read_bytes`는 정확히 0이다. metadata fingerprint 확인은 content read로 세지 않는다. |
| bounded memory | full collect를 금지하고 decoded input과 output batch를 각각 64MiB 이하로 제한한다. queue는 최대 1개 in-flight output batch다. |
| old session | target cache와 query artifact가 Ready가 되기 전까지 old session을 registry에서 교체하거나 old query/cache lease를 drop하지 않는다. |
| generation isolation | old, candidate와 target의 provider, bitmap, manifest와 DuckDB view를 섞지 않는다. |
| publish atomicity | partial artifact는 cache hit가 될 수 없고 complete target directory rename만 persistent commit이다. |
| swap atomicity | target query artifact가 먼저 설치된 reserved session만 document compare-and-swap으로 공개한다. |
| failure | parse/cast Fail policy, cancel, budget, corruption, publish 또는 session race가 나면 old session이 그대로 active다. |
| concurrency | 같은 source+semantic profile은 process 전체에서 한 builder만 publish한다. 다른 target profile은 temp/RSS gate 안에서 병렬 가능하다. |
| no silent fallback | foundation이 corrupt하거나 raw 열이 불완전하면 원본 재scan으로 조용히 우회하지 않고 typed error를 반환한다. 명시적 cold rebuild만 별도 경로다. |

## 4. identity를 세 층으로 분리한다

현재 하나인 opaque identity를 다음처럼 분리한다.

### 4.1 source snapshot identity

```text
CsvSourceSnapshotIdentity
  canonical_path
  OS file identity
  source bytes / created / modified nanos
  CSV decode contract (delimiter, quote, escape, encoding, header mode/used)
  source column IDs/names/order
  source column count
  cache schema/application ABI
```

같은 raw foundation인지 판정하는 identity다. target profile이나 UI generation은 포함하지 않는다.

### 4.2 semantic profile identity

```text
CsvSemanticProfileIdentity
  resolved target type per source column
  Skip/visible mapping
  trim, null tokens, Boolean tokens
  decimal/thousands, temporal/duration options
  conversion failure policy
```

`CsvParsingProfile.generation`은 제외한다. `Auto` 문자열 자체보다 실제로 고정된 resolved type을 넣어
thread 수, batch 크기와 UI generation이 달라도 같은 의미면 같은 hash가 나오게 한다.

### 4.3 logical session generation

UI stale-response 판정에만 사용한다. 동일 설정을 다시 적용해도 기존 physical cache를 hit할 수 있지만,
현재 명세의 “apply는 새 sessionId” 계약을 유지하려면 새 logical session은 만들 수 있다. 이 경우
Parquet/state regeneration은 하지 않고 같은 semantic cache artifact를 새 session provider에 연결한다.

target persistent key는 `source snapshot identity + semantic profile identity`로 계산한다. source raw
foundation 탐색은 cache root를 모호하게 훑기보다 **현재 Ready artifact가 이미 보유한 valid lease**에서
시작한다.

## 5. source 열과 visible 열의 count를 분리한다

현재 `columns` 하나로는 Skip profile을 정확히 검증할 수 없다. manifest와 identity에 다음을 분리한다.

```text
sourceColumnCount   = 원본 CSV 열 수
visibleColumnCount  = target profile에서 Skip이 아닌 열 수
```

- `__dv_base_raw_*`: 정확히 `sourceColumnCount`개
- Parquet `__dv_state_word_*`: 정확히 `ceil(sourceColumnCount / 32)`개
- target `__dv_value_*`: resolved profile에서 별도 물리 값이 필요한 visible 열만 존재
- `states.bin` header column count: `visibleColumnCount`
- `offsets.idx`: profile과 무관하며 row/source 구조에 귀속

manifest에는 physical mapping 외에 semantic profile hash, raw foundation fingerprint, source/visible count,
row count와 parent cache lineage를 기록한다. lineage에는 old entry key와 old Parquet checksum을 넣되,
target cache 유효성은 parent directory가 계속 존재하는지에 의존하지 않는다. target은 publish 전에
완전한 standalone artifact가 된다.

compact v3가 아직 release되지 않은 Phase 내부 형식이라면 이 count 계약을 v3 최종 계약으로 바로
고정하고 개발 cache를 재생성한다. 이미 외부에서 v3를 영속 형식으로 사용했다면 애매한 `columns`를
추측하지 말고 cache schema를 v4로 올린다.

## 6. 최소 backend 변경

### 6.1 `CsvPreparedArtifact`가 foundation을 안전하게 빌려준다

현재 `_persistent_lease`를 단순 보관 필드로 두지 말고 다음 정보를 가진 내부 참조로 묶는다.

```rust
CsvPreparedCacheRef {
    entry_path,
    manifest_snapshot,
    lease,
}
```

`Arc<CsvPreparedArtifact>`를 reprofile worker가 잡는 동안 old session이 닫히더라도 shared cache lease가
먼저 해제되지 않는다. worker에는 `prepared.parquet`, `offsets.idx`, source snapshot identity와 validated
raw mapping만 노출한다. mutable cache API나 임의 경로는 노출하지 않는다.

### 6.2 `CsvRawFoundationReader`를 하나 추가한다

old Parquet에서 다음 projection만 순차적으로 읽는다.

```text
__dv_row_id, __dv_base_raw_0, ..., __dv_base_raw_(sourceColumnCount-1)
```

- row ID가 0부터 연속인지 검증한다.
- 모든 base raw 열은 non-null UTF-8이어야 한다.
- manifest의 source column ID/order와 physical mapping을 다시 확인한다.
- Parquet row-group/batch 단위로 읽고 input/output actual Arrow memory가 각각 64MiB를 넘으면 더 작은
  batch로 재시도하거나 typed size error를 낸다.
- reader byte는 `foundation_read_bytes`로 기록하며 `source_read_bytes`에 합치지 않는다.
- validation과 reprofile이 같은 reader를 사용해 raw 의미가 갈라지지 않게 한다.

### 6.3 target provider가 cache raw를 변환한다

`QueryInputProvider`에 CSV 전용 기본-unsupported hook을 하나 추가하거나, `CsvQueryProvider` 내부
구체 함수로 다음 계약을 제공한다.

```text
prepare_from_raw_foundation(target provider, foundation reader, artifact directory, cancel)
```

기존 `convert_value_for_query`, `CsvPreparedBatchBuilder`, adaptive batch sizer와 Parquet writer를 재사용한다.
각 row에서 다음을 한 번에 만든다.

1. all-source base raw를 target Parquet에 그대로 기록
2. target typed/native/fallback value 생성
3. all-source packed state word 생성
4. visible 열 상태를 `states.bin` builder에 추가
5. `Fail` failure policy의 첫 invalid를 만나면 candidate만 실패

`offsets.idx`는 profile과 무관하므로 old artifact에서 bounded copy한다. 파일 시스템 hardlink는 old/new
artifact의 read-only·corruption lifecycle을 결합하므로 기본값으로 사용하지 않는다. 파일이 작아 copy
비용은 미미하며 이 byte는 `cache_reused_bytes`로 따로 계수한다.

### 6.4 source object도 source I/O 없이 stage한다

`CsvSource::prepare_profile()`의 open+full validation을 accelerator에서 호출하지 않는다. 대신 내부
`stage_profile_from_cache()`가 다음만 수행한다.

- old source의 path/header/encoding/column metadata와 inference snapshot 복사
- profile normalize와 resolved semantic plan 생성
- base manifest row count와 `offsets.idx`로 completed index/checkpoint snapshot 구성
- 새 cancel token과 generation 생성, background source index worker는 시작하지 않음

full-file validation 결과는 foundation 변환 중 집계한다. `Fail` policy invalid가 있으면 registry swap 전에
실패하므로 old source는 그대로다. 기존 source 기반 `prepare_profile()`은 valid foundation이 없는 cold
fallback에만 남기며, fallback 사용 사실과 source byte를 명시한다.

### 6.5 cache key generation을 semantic hash로 바꾼다

`CsvCacheIdentity`는 opaque `profile_identity` 대신 source snapshot identity, semantic profile hash,
`source_columns`, `visible_columns`와 expected physical columns를 가진다. UI generation은 manifest의
진단 snapshot에는 남길 수 있지만 `matches()`와 `cache_key()`에는 넣지 않는다.

같은 target key의 process 간 중복 변환을 막기 위해 cache lock directory에 target-key build lock을
추가한다.

1. 짧은 global lock 안에서 target hit를 다시 검사한다.
2. target-key build lock을 cancel 가능한 25ms polling으로 획득한다.
3. 획득 직후 target hit를 한 번 더 검사한다.
4. miss인 단 하나의 process만 변환한다.
5. 대기자는 winner publish 뒤 cache hit lease를 얻는다.

긴 변환 동안 global cache lock을 잡지 않는다. 서로 다른 semantic target은 기존 CSV preparation
worker 상한과 temp/RSS budget 안에서 병렬 실행할 수 있다.

### 6.6 document session을 예약한 뒤 마지막에 교체한다

`DocumentRegistry`에 두 단계 replacement를 추가한다.

```text
reserve_replacement(documentId, expectedOldSessionId)
  -> ReplacementReservation(newSessionId, nonce)

commit_replacement(reservation, stagedSource)
  -> compare current session with expected old session, then atomic swap
```

순서는 반드시 다음과 같다.

1. old session이 current인지 확인하고 reservation을 만든다.
2. old artifact `Arc`와 persistent lease를 고정한다.
3. target cache를 hit하거나 build+publish한다.
4. target `prepared.duckdb`, connection, bitmap restore와 provider를 모두 Ready로 만든다.
5. target artifact를 아직 외부에 알려지지 않은 reserved new session key에 먼저 설치한다.
6. source fingerprint metadata, cancel token과 latest reprofile epoch를 마지막으로 확인한다.
7. registry `commit_replacement`를 실행한다.
8. 성공한 뒤에만 old query/copy/preparation을 cancel·drop한다.

target artifact 설치가 실패하면 registry를 건드리지 않는다. registry commit이 stale/closed로 실패하면
reserved artifact를 제거하고 lease/temp를 해제한다. QueryService/cache lock을 잡은 채 document mutex를
획득하지 않아 기존 lock order를 바꾸지 않는다.

## 7. command와 상태 계약

기존 `apply_csv_profile` request와 최종 `OpenFileResponse`는 유지할 수 있다. command는 async 상태에서
reprofile 완료를 기다리므로 UI thread를 막지 않는다. cancel 식별자는 이미 profile에 있는 generation을
사용한다.

```text
get_csv_reprofile_status(documentId, oldSessionId, profileGeneration)
cancel_csv_reprofile(documentId, oldSessionId, profileGeneration)
```

상태는 `WaitingForFoundation | ReadingFoundation | Converting | Publishing | Committing | Ready |
Cancelled | Failed`를 가진다. 같은 document/old session에서 더 높은 generation 요청이 오면 이전
candidate를 취소하고 latest epoch만 commit할 수 있다.

`validate_csv_profile`도 Ready foundation이 있으면 같은 raw reader를 사용해야 한다. apply에서만 source
read를 없애고 직전 validation이 원본 전체를 읽는 것은 `P15-CACHE-007`의 의도에 맞지 않는다. cached
validation result는 `(old session, foundation checksum, semantic profile hash)`로 식별할 수 있으며,
apply는 이를 참고하되 transform 중 실제 cast 결과를 다시 확인한다.

동일 semantic profile 재적용은 target cache hit로 처리한다. 새 logical session 계약은 유지하되
Parquet, packed state와 `states.bin`을 다시 만들지 않는다.

## 8. 취소·실패·rollback 계약

| 지점 | 기대 결과 |
| --- | --- |
| foundation lock 대기 | 25ms 이내 cancel 관측, old session 유지 |
| Parquet batch read/convert | batch 사이와 최대 4,096 rows마다 cancel 확인 |
| Parquet/state/offset write | `.partial`만 제거, stable target miss |
| sync/manifest 전 | candidate 제거, old cache와 lease 무변경 |
| target directory publish 후 session commit 전 | active session은 old 그대로. 완전한 target cache는 재사용 가능한 derived artifact로 남겨도 됨 |
| session compare-and-swap 실패 | reserved QueryService artifact 제거, old/current winner session 보존 |
| commit과 cancel 경쟁 | registry swap이 선형화 지점. swap 전 cancel은 commit 0, swap 후 cancel은 이미 Ready인 결과를 되돌리지 않음 |
| source metadata fingerprint 변경 | target session commit 금지. source content read 없이 stale-source error |
| old document close | worker cancel·join 뒤 base `Arc`/lease 해제, late target session commit 0 |
| `Fail` policy invalid | invalid count와 첫 row를 반환하고 old session 유지 |
| cache budget/disk-full/corruption | valid old generation 삭제 0, partial 정리, typed reason 반환 |

rollback은 원본 CSV를 수정하지 않으며 old stable cache를 덮어쓰지 않는다. target은 별도 semantic key에
게시되므로 old lease가 존재하는 directory를 rename/delete할 이유가 없다.

## 9. 계측 계약

reprofile 결과와 test artifact에는 다음을 분리해 기록한다.

```text
source_read_bytes = 0
foundation_read_bytes
offsets_reused_bytes
parquet_output_bytes
states_output_bytes
manifest_output_bytes
rows_converted
source_column_count
visible_column_count
invalid_count_by_column
peak_input_batch_bytes
peak_output_batch_bytes
max_inflight_batches
base_entry_key / target_entry_key / semantic_profile_hash
old_session_served_requests / stale_responses_after_commit
partial_count_after_terminal / live_lease_count_after_terminal
```

source CSV content reader를 생성한 횟수와 실제 `Read` 반환 byte도 spy로 계수한다. 단순히
`CsvPreparationStatus.source_read_bytes`를 0으로 초기화한 것만으로 PASS 처리하지 않는다.

## 10. 테스트 계획

### 10.1 단위·golden

| ID | 검증 | 기대 결과 |
| --- | --- | --- |
| `P15-REPROFILE-001` | profile generation만 다른 semantic hash | hash 동일, target physical cache hit, output 재작성 0 |
| `P15-REPROFILE-002` | Text/Boolean/Int64/UInt64/Float64/Decimal/Date/Timestamp/Duration/Skip resolved plan | option 하나가 의미를 바꿀 때만 semantic hash 변경 |
| `P15-REPROFILE-003` | source 35열, visible 33/1/0열 | base raw 35, packed word 2, `states.bin` visible count 정확 |
| `P15-REPROFILE-004` | quoted comma, doubled quote, escaped quote, quoted LF/CRLF, trailing empty | csv crate decoded field oracle와 base raw byte-for-byte 동일 |
| `P15-REPROFILE-005` | null/empty/valid/invalid 2-bit golden | all-source packed state와 visible `states.bin` 각각 direct CSV oracle와 동일 |
| `P15-REPROFILE-006` | missing/duplicate/reordered base raw, wrong row ID/type/count/checksum | source fallback 없이 typed corruption error |
| `P15-REPROFILE-007` | 64MiB 직전/직후와 8MiB single record | full collect 0, hard bound 준수 또는 명시적 bounded error |

### 10.2 profile matrix 통합

기준 row에는 일반 문자열, 공백 포함 문자열, all-empty, null token, signed/unsigned boundary,
float/NaN/Inf, decimal separator, date, timezone timestamp, duration, cast-invalid와 Skip 값을 포함한다.

각 source 열을 모든 지원 target으로 바꾸며 다음을 확인한다.

- old cache raw → target typed/default/raw copy가 direct CSV conversion oracle과 같다.
- `KeepRaw`, `AsNull`, `Fail` 정책별 state와 diagnostic이 같다.
- String→numeric→String, numeric→Skip→Text에서 raw가 처음과 같다.
- filter, 3-sort, filter→sort, sort→filter, boundary navigation과 부분/전체 query copy가 target profile
  결과만 사용한다.
- validate+apply+Ready page/query/copy/navigation 전체 구간의 source `Read` 반환 byte 합이 0이다.

이 matrix가 기존 `P15-CACHE-002/006/007`의 직접 PASS 근거다.

### 10.3 session transaction과 concurrency

| ID | 시나리오 | 기대 결과 |
| --- | --- | --- |
| `P15-REPROFILE-020` | slow transform 중 old page/query/Ctrl/copy 반복 | commit 전 old session 성공, blank/pending 전환 0 |
| `P15-REPROFILE-021` | target artifact Ready 직전/직후 fault | swap 전 fault는 old active, 성공 시 new 첫 요청부터 Ready artifact 사용 |
| `P15-REPROFILE-022` | cancel at read/convert/write/sync/publish/precommit | late session commit 0, partial 0, old result 동일 |
| `P15-REPROFILE-023` | generation N과 N+1 동시 apply | N+1만 commit, N 응답과 artifact는 stale/cancel 처리 |
| `P15-REPROFILE-024` | 같은 target, 같은 process 20 callers | transform 1회, publish 1회, 모든 성공 caller가 valid lease 획득 |
| `P15-REPROFILE-025` | 같은 target, 두 process | process-shared build lock, publish 1회, loser는 target hit |
| `P15-REPROFILE-026` | 서로 다른 두 target 동시 build | old shared lease 손상 0, worker/temp/RSS 상한 준수 |
| `P15-REPROFILE-027` | transform 중 document close 또는 다른 source replace | reserved swap 실패, late commit 0, lease/worker/temp 최종 0 |
| `P15-REPROFILE-028` | source same-path replace/mtime 변경 | content read 0이지만 precommit fingerprint가 stale commit 차단 |

### 10.4 storage·fault

- target publish의 marker 제거, manifest sync와 directory rename 각 경계에 fault를 주입한다.
- disk-full, temp hard limit과 active old lease 때문에 budget을 맞출 수 없는 경우를 각각 검증한다.
- old cache manifest/artifact byte와 checksum은 모든 실패 전후에 동일해야 한다.
- stable target은 완전한 hit 또는 완전한 miss만 허용한다.
- process kill 뒤 janitor가 target partial/build lock orphan을 회수하되 old leased entry를 삭제하지 않는다.
- publish 뒤 session commit 전에 kill되면 target cache는 다음 apply에서 hit할 수 있고 old persistent entry도
  유효해야 한다.

### 10.5 5.85M release 성능·resource

기준 `.tmp/phase13-fixtures/large/csv-5850000-high.csv`의 old Ready cache를 먼저 만든 뒤 source spy
counter를 0으로 reset하고 profile을 변경한다.

- 5회 fresh-process reprofile raw sample, median과 nearest-rank p95(max)를 보존한다.
- absolute peak RSS `<= 1.5GiB`
- input/output batch 각각 `<= 64MiB`, in-flight output batch `<= 1`
- cancel terminal p95/max `<= 1초`
- `source_read_bytes = 0`과 source content reader `Read` byte `= 0`
- target Ready 뒤 random page, Ctrl, filter+3-sort와 64k×1 copy가 기존 Phase 15 latency gate를 통과
- old session serving 중 error/blank/pending 0, commit 후 first new-session page가 persistent target hit

## 11. 파일별 예상 변경 소유권

| 파일 | 최소 변경 |
| --- | --- |
| `src-tauri/src/data/csv_source.rs` | semantic plan, cache raw reader/transform, source-I/O 없는 staged source, source/visible state 분리 |
| `src-tauri/src/data/source.rs` | CSV foundation/reprofile provider hook과 metrics |
| `src-tauri/src/storage/csv_cache.rs` | split identity/count, target build lock, foundation manifest validation과 lineage |
| `src-tauri/src/query/engine.rs` | old artifact lease 고정, candidate build/status/cancel, reserved session artifact 설치 |
| `src-tauri/src/platform/session.rs` | replacement reservation과 compare-and-swap commit |
| `src-tauri/src/commands/mod.rs` | cache-aware validate/apply와 reprofile status/cancel command |

공통 DTO를 바꿀 경우 Rust/TypeScript parity test가 필요하다. 구현은 먼저 backend transaction과 test를
완성하고, 그 다음 기존 profile UI가 status/cancel만 연결하도록 순차 handoff한다.

## 12. 구현 순서

1. semantic profile hash와 source/visible count golden부터 고정한다.
2. active old artifact에서 validated `CsvRawFoundationReader`를 얻는 read-only 경로를 만든다.
3. 작은 fixture에서 cache-to-cache Parquet/state regeneration과 raw oracle을 통과시킨다.
4. target-key process-shared build lock과 기존 atomic publish에 연결한다.
5. staged source와 reserved session artifact를 만든 뒤 registry compare-and-swap을 연결한다.
6. cancel/fault/concurrent apply matrix를 통과시킨다.
7. cache-aware full validation을 같은 raw reader에 연결한다.
8. 5.85M release source-byte/RSS/latency 측정 뒤 전체 Phase 15 회귀를 수행한다.

이 순서에서는 old compact implementation을 먼저 뜯지 않는다. raw foundation reader와 semantic identity를
독립적으로 고정한 뒤, 기존 writer/builder와 publication을 재사용하므로 변경 면적과 rollback 위험을
제한할 수 있다.
