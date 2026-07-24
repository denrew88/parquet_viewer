# Phase 15 hybrid compact v3 독립 리뷰

- 리뷰 일자: 2026-07-23
- 리뷰 범위: `data/source.rs`, `data/csv_source.rs`, `query/engine.rs`, `storage/csv_cache.rs`
- 코드 수정: 없음
- 최종 판정: **compact v3의 현재 profile 정확성과 v3 cache 수명주기는 PASS지만, Phase 15 완료는 불가**

현재 구현은 all-source raw, 선택적 typed value, packed state를 안전하게 조합하고 기존 `dv_source`
계약을 복원한다. UTF-8 fallback, Rust trim parity, Skip 열 수, 내부 이름 충돌과 manifest mapping에서
리뷰 중 발견된 결함은 구현 Agent가 수정했고 독립 targeted test도 통과했다.

그러나 profile 변경 시 기존 raw foundation을 재사용하는 경로가 없다. 또한 실제 high CSV 한 번의
cold Ready가 52.763초로 Phase 목표를 크게 넘는다. 따라서 `P15-CACHE-002/007`과 cold performance
gate는 FAIL이다.

## 1. 최종 physical layout 판정

준비 Parquet의 물리 열은 다음 순서와 의미를 가진다.

| 물리 열 | 개수 | 의미 |
| --- | ---: | --- |
| `__dv_row_id` | 1 | 0부터 시작하는 source 논리 행 ID |
| `__dv_base_raw_<source_index>` | 모든 source 열 | CSV parser가 decode한 field 원문. Skip 열도 반드시 포함 |
| `__dv_value_<source_index>` | 필요한 열만 | native typed 값, UTF-8 fallback normalized 값, 또는 `trim=true` Text normalized 값 |
| `__dv_state_word_<word_index>` | `ceil(source_columns / 32)` | source 열마다 2-bit state를 32개씩 packed한 `UInt64` |

untrimmed Text는 `base_raw`가 value와 동일하므로 별도 value 열을 만들지 않는다. Boolean, Int64,
UInt64, Float64는 Arrow native builder를 사용한다. Decimal, Date, Timestamp, Duration은 exact raw와
별개로 normalized UTF-8 value를 저장한다. trimmed Text도 DuckDB `trim()`과 Rust `str::trim()`의
whitespace 차이를 피하려고 Rust normalized UTF-8 value를 저장한다.

packed state lane은 `source_index % 32`, word는 `source_index / 32`이며 mapping은 다음과 같다.

| bits | state | compatibility value |
| ---: | --- | --- |
| `0` | Valid | physical normalized/native value 또는 untrimmed raw |
| `1` | Null | SQL `NULL` |
| `2` | Empty | 빈 문자열 `''` |
| `3` | Invalid | exact raw, `__dv_invalid_n=true` |

`states.bin`은 UI navigation용 visible 열 bitmap이고, Parquet의 base raw/state word는 Skip을 포함한
all-source 열 기준이다. 최종 구현은 cache identity의 `columns`와 `source_columns`를 분리해 두 형식을
혼동하지 않는다.

판정:

- all-source/Skip raw 보존: **PASS**
- native/UTF-8 fallback의 normalized/null/empty/invalid 복원: **PASS**
- packed state bit mapping 정적 검토: **PASS**
- 32/33번째 lane을 직접 겨냥한 별도 자동 test: **NOT_RUN**

## 2. compatibility view와 SQL 안전성

`CsvQueryProvider::prepared_view_sql`은 compact Parquet를 기존 query engine이 기대하는 다음 논리
열로 복원한다.

```text
__dv_row_id
<visible column>
__dv_raw_<visible_index>
__dv_invalid_<visible_index>
```

- visible identifier와 internal physical identifier는 double-quote escaping을 사용한다.
- Parquet path는 single-quote escaping된 literal만 전달된다.
- Null/Empty/Invalid는 packed state를 기준으로 복원하므로 typed physical null만으로 상태를 추측하지
  않는다.
- raw는 항상 해당 source index의 `__dv_base_raw_*`에서 나온다.
- `__dv_*`로 시작하는 untrusted CSV header는 `(source)` suffix의 안정적인 visible alias로 바뀌어
  row ID/raw/invalid/state/value internal namespace를 shadow하지 못한다.
- `trim=true` Text는 Rust에서 materialize한 normalized value를 사용하므로 TAB, quoted LF, NBSP 및
  Unicode whitespace가 direct CSV conversion과 동일하다.

판정: **PASS**.

## 3. cache v3, fingerprint와 warm hit

- `CACHE_SCHEMA_VERSION=3`은 manifest와 cache key에 모두 들어가므로 v2와 v3 key가 격리된다.
- manifest는 physical layout 외에 Parquet physical/logical/converted type, definition/repetition level,
  source mapping과 state word index를 fingerprint에 포함한다.
- expected structured physical plan은 base raw 1개/source, state word `ceil(source/32)`, 필요한 value 열
  1개를 검증한다.
- warm hit는 manifest/artifact/state/offset 검증 뒤 persistent Parquet를 read-only로 연결하고
  `source_read_bytes=0`으로 Ready가 된다.
- source fingerprint는 canonical path, OS file identity, length, modified/created time을 사용한다.
  pinned scan handle과 현재 path fingerprint를 함께 비교하므로 rename replacement와 preparation 중
  mutation이 commit되지 않는다.
- artifact는 size/OS identity/time fast path와 주기적 checksum scrub을 함께 사용한다. 코드에 명시된
  대로 이는 disposable derived cache의 non-adversarial corruption 정책이지 tamper-proof 저장소는 아니다.

판정:

- v2/v3 정적 격리: **PASS**
- exact-identity warm hit: **PASS**
- restart/source mutation/same-size replacement/corruption: **PASS**
- 실제 v2 manifest fixture를 생성한 명시적 migration test: **NOT_RUN**

## 4. 남은 HIGH 결함

### `H15-CV3-001` profile 변경 시 all-source raw foundation을 재사용하지 않는다

`CsvQueryProvider::reusable_source_identity`는 source path, header flag와 전체
`CsvParsingProfile` JSON을 합친다. JSON에는 generation과 모든 profile 설정이 포함된다. 이 identity는
그대로 persistent cache key의 `profile_identity`가 된다.

따라서 다음 동작은 기존 v3 Parquet의 `__dv_base_raw_*`가 모든 source 열을 보유해도 cache miss가 되고
원본 CSV를 다시 scan한다.

- Text에서 numeric/temporal profile로 변경
- numeric에서 Text로 변경
- Skip 열을 visible 열로 변경하거나 반대로 변경
- 동일한 semantic 설정을 새 generation으로 다시 적용

이는 `P15-CACHE-002`의 “모든 열 원문을 source 재scan 없이 재구성”과 `P15-CACHE-007`의 profile
matrix `source read 0` 계약을 직접 위반한다.

필요한 후속 구조는 source fingerprint/header/dialect에 귀속된 profile-independent raw foundation과,
그 lease에서 typed value/state artifact를 재생성하는 profile layer의 분리다. generation은 cache의
semantic identity에서 제외해야 한다. 이 후속 설계는 별도 Agent가 작성 중이지만 현재 코드에는 없다.

### `H15-CV3-002` high CSV cold 성능 표본이 Phase gate를 넘는다

[`csv-high-stage-profile.json`](./csv-high-stage-profile.json)의 실제 5,850,000행 x 15열 표본은 다음과
같다.

| 항목 | 결과 |
| --- | ---: |
| Ready total | 52,762.555 ms |
| provider total | 50,647.709 ms |
| value conversion | 19,360.124 ms |
| Parquet batch write | 18,618.957 ms |
| prepared Parquet | 755,993,043 bytes |
| source read | 979,427,914 bytes, 1 full pass |

Phase 목표는 cold 5회 median 15초 이하, p95 20초 이하다. 이 파일은 1회 표본이라 median/p95를
완성하지는 못하지만 단일 결과부터 hard 목표를 2.6배 이상 넘으므로 현재 성능 gate는 FAIL이다.

## 5. 독립 실행 결과

다음 명령은 Quality Agent가 구현 Agent 실행과 별도로 순차 실행했다.

| 명령/범위 | 결과 |
| --- | --- |
| `cargo test ... csv_compact_ -- --test-threads=1 --nocapture` | **3 PASS**: Auto UTF-8 fallback mapping, mixed raw/normalized/state, Unicode trim |
| `cargo test ... csv_reserved_internal_headers_are_resolved_before_preparation ...` | **1 PASS** |
| `cargo test ... csv_persistent_cache_ -- --test-threads=1 --nocapture` | **3 PASS**: restart/mutation, same path+size+times replacement, corruption/partial cleanup |
| `cargo test ... csv_prepared_session_reuses_exact_identity_for_page_boundary_and_cleanup ...` | **1 PASS** |
| `cargo test ... storage::csv_cache::tests:: -- --test-threads=1 --nocapture` | **6 PASS**: publish/rollback, multi-process lock/lease/LRU, checksum |
| `cargo test ... same_size_source_mutation_during_csv_preparation_discards_the_artifact ...` | **1 PASS** |
| `git diff --check -- <review scope> artifacts/phase-15` | **PASS**, whitespace error 0 |

구현 Agent의 별도 전체 증거는 Rust lib 기본 병렬 **252 PASS / 0 FAIL / 13 ignored**, 직렬도
**252 PASS / 0 FAIL / 13 ignored**, `cargo clippy --lib -- -D warnings` PASS다. 최초 병렬 실행에서
3개 test가 process-global preparation permit 경합으로 5초 timeout됐으나 개별/직렬 PASS 후 test별
limiter 격리를 추가했고 기본 병렬 재실행도 PASS했다.

## 6. 최종 gate 요약

| 항목 | 판정 |
| --- | --- |
| compact physical layout | PASS |
| packed state와 compatibility parity | PASS |
| all-source/Skip exact raw 저장 | PASS |
| UTF-8 fallback과 trim parity | PASS |
| SQL escaping/internal namespace | PASS |
| cache v3 isolation/fingerprint/warm hit/mutation | PASS |
| profile 변경 source read 0 | **FAIL** |
| cold preparation 성능 | **FAIL** |

따라서 compact v3 코드는 현재 profile의 page/query/copy/navigation consumer에 통합할 수 있지만,
Phase 15 전체 상태를 완료로 바꾸면 안 된다.
