# Phase 15 CSV 준비·Polars 후보 아키텍처

## 1. 결론부터

DuckDB는 유지한다. DuckDB는 준비된 typed Parquet의 filter, multi-sort, logical row identity와 query
page를 담당한다. Polars는 gate를 통과할 경우에만 **CSV를 columnar cache로 준비하는 구간**에 한정해
사용한다.

CSV 전체를 Polars DataFrame 하나로 올리는 3.23GB 비교 구현은 사용하지 않는다. bounded batch,
partition sink와 최대 2개 batch queue로 peak RSS 1.5GiB를 지키는 것이 채택의 전제다.

## 2. 처리 흐름

```text
open
  ├─ bounded preview + type sample ──> 화면 표시
  └─ pass A: quote-aware structure/checkpoint scan
       └─ fixed automatic profile
            └─ pass B: Polars streaming conversion
                 ├─ part-00000.parquet + state words
                 ├─ part-00001.parquet + state words
                 ├─ committed frontier 갱신
                 └─ final validation + manifest atomic publish
                        └─ DuckDB view over committed parts
```

두 pass는 의도적이다. 현재 979MB 파일의 순차 read는 약 0.201초, `csv` crate 순수 parse는
약 1.487초였고 실제 58초의 병목은 변환·쓰기·비트맵 저장이었다. quote-aware 정확한 checkpoint와
Polars의 병렬 columnar 변환을 억지로 한 parser에 결합해 복잡도를 높이는 대신, 약 2회 source read를
명시적으로 계수하고 전체 15초 목표로 판정한다.

## 3. 자동 타입 결정

### 3.1 시점

preview와 동시에 최대 10,000 records 또는 decoded 8MiB 중 먼저 도달하는 표본을 사용한다. 표본이
끝나면 profile을 고정하고 preparation을 바로 시작한다. 기본 Auto에서는 확인창을 띄우지 않는다.

### 3.2 보수적 규칙

- 빈 field는 추론 표본에서 제외하고 cell state `empty`로 처리한다.
- 모든 비어 있지 않은 값이 안전하게 맞는 경우에만 Boolean, Int64, UInt64, Float64를 선택한다.
- Date/Timestamp/Duration은 명확한 형식과 범위를 만족할 때만 선택한다.
- 한 자리 숫자를 Timestamp epoch로 추측하지 않는다.
- 후보가 충돌하거나 전부 비어 있으면 Text를 선택한다.
- Decimal 정밀도·scale을 표본으로 안전하게 확정할 수 없으면 Text 또는 명시적 profile을 사용한다.

### 3.3 full scan에서 다른 값이 나올 때

full scan 중 타입 변환 실패가 발견되어도 열 타입을 바꾸거나 사용자에게 중간 확인을 요구하지 않는다.

- raw field가 비어 있음: `empty`, typed null
- 비어 있지 않고 cast 성공: `valid`, typed value
- 비어 있지 않고 cast 실패: `invalid`, typed null, raw lexeme 보존

사용자가 나중에 CSV Parsing Profile을 변경하면 새 generation을 만들되 원문 cache를 재사용한다.

## 4. compact partition schema

현재 각 source 열을 normalized/raw/invalid 세 열로 확장하는 46열 layout을 폐기한다. 각 partition은
다음만 가진다.

```text
__dv_row_id
typed value per source column
raw shadow only for non-String typed columns
```

- String typed 열의 값 자체가 정확한 raw이므로 별도 raw shadow를 만들지 않는다.
- non-String 열은 표시·raw copy·재profile을 위해 exact raw shadow를 둔다.
- invalid 여부는 Parquet Boolean 열로 중복하지 않고 2-bit `states.bin`에서 얻는다.
- 15열 fixture에서 non-String이 12개라면 1+15+12=28 physical columns가 된다.
- display format은 cache에 저장하지 않으며 page/copy 경계에서만 적용한다.

partition은 기본 65,536행을 목표로 하되 decoded batch 64MiB가 먼저 차면 더 작게 닫는다. 하나의 큰
파일보다 닫힌 part 단위로 frontier를 게시해 준비 중 page와 Ctrl이 완성된 범위를 안전하게 사용할 수
있게 한다.

## 5. bitmap 저장

메모리에서는 기존 2-bit state 의미와 column-major word layout을 유지한다. 저장할 때 `u64`마다
`write_all`하지 않는다.

1. 큰 연속 little-endian byte chunk로 변환한다.
2. `BufWriter` 또는 동등한 buffered writer로 수 MiB 단위 write를 수행한다.
3. header, payload, checksum을 기록하고 flush/fsync한다.
4. committed frontier에 해당하는 word까지만 reader snapshot에 공개한다.

파일 format을 유지할 수 있으면 version을 올리지 않는다. format이 바뀌면 manifest cache schema
version을 올리고 이전 derived cache는 재생성한다.

## 6. persistent cache publish

query 임시 디렉터리에서 완성한 767MB를 persistent 위치로 복사하지 않는다.

```text
cache-root/<key>/.partial-<generation>/
  parts/*.parquet
  states.bin.partial
  offsets.idx
  manifest.draft.json
```

- 처음부터 최종 cache와 같은 volume의 partial 디렉터리에 쓴다.
- 각 part는 close+검증 후 coordinator frontier에만 공개한다.
- source fingerprint를 시작과 commit 직전에 다시 확인한다.
- 모든 artifact sync 후 완성 manifest를 마지막에 atomic rename한다.
- manifest가 없는 generation은 persistent hit로 인정하지 않는다.
- session lease는 게시된 디렉터리를 직접 읽으므로 full-file copy가 없다.
- crash janitor는 active writer/lease가 없는 오래된 partial만 제거한다.

## 7. Polars 경계

### 7.1 사용하는 기능

- Rust Polars의 lazy CSV scan
- streaming physical plan
- Parquet sink 또는 bounded batch callback
- 필요한 문자열, 정수, 실수, Boolean, Date/Timestamp/Duration 변환만 활성화

정확한 crate version을 고정하고 `default-features = false`로 시작한다. 기능을 하나씩 추가하면서
dependency tree와 binary 증가량을 기록한다.

### 7.2 사용하지 않는 경계

- Polars 배열을 기존 Apache Arrow 58 배열로 직접 변환하지 않는다.
- Polars를 DuckDB query 대신 사용하지 않는다.
- 전체 DataFrame collect를 허용하지 않는다.
- UI나 Tauri command가 Polars 타입을 직접 알지 않는다.

Polars와 현재 Arrow/Parquet crate의 내부 구현 중복은 Parquet file을 안정적인 경계로 삼아 격리한다.

### 7.3 취소

각 batch/partition 경계에서 generation cancel token을 확인한다. Polars API가 1초 안의 cooperative
cancel을 제공하지 못하면 다음 중 하나를 사용한다.

- bounded `sink_batches` callback에서 취소 확인
- 더 작은 partition 단위 scan/sink
- 개선된 기존 Rust converter fallback

취소를 위해 worker thread를 강제 종료하거나 partial file을 valid cache로 가장하지 않는다.

## 8. query와 navigation

- DuckDB view는 committed typed columns와 `__dv_row_id`만 노출한다.
- filter와 sort는 source typed value를 사용하고 display 문자열을 사용하지 않는다.
- source navigation은 state bitmap을 사용한다.
- filtered/sorted navigation은 query-order row ID를 source bitmap에 gather한 occupancy bitmap을 사용한다.
- Ready 이후 Ctrl, Ctrl+Shift, Ctrl+Alt, PageUp/PageDown은 원본 CSV를 읽지 않는다.
- filtered/sorted 선택 복사는 logical query 순서와 현재 visible column 순서를 따른다.

## 9. progress와 관측

행 수 하나만 보여 주지 않고 다음 stage를 구분한다.

1. `Inspecting structure`
2. `Converting and caching`
3. `Verifying cache`
4. `Ready`

각 stage는 elapsed, rows, source read bytes, output bytes를 남긴다. 성능 artifact에는 다음을 반드시
분리한다.

- preview/structure/conversion/foreground/navigation source read bytes
- value conversion, Parquet sink, bitmap build/write, sync/publish 시간
- decoded batch와 writer queue peak bytes
- process peak RSS와 평균 사용 core
- part별 raw/typed/state/cache byte
- EXE, NSIS, clean build 시간의 도입 전후 차이

## 10. 채택과 fallback

Polars POC가 시간만 빠르고 RSS, 취소, dialect parity, raw 보존 또는 executable 증가량 판단을 통과하지
못하면 제품에 넣지 않는다. 이 경우에도 buffered bitmap과 direct publish 수정은 독립적으로 유지하며,
기존 Rust converter의 allocation·builder·schema를 compact layout에 맞춰 계속 최적화한다.

Polars가 모든 gate를 통과하면 CSV preparation provider 구현만 교체한다. DataSource, query, page,
selection, copy DTO와 DuckDB 계약은 그대로 유지하므로 Parquet/H5 및 UI 회귀 범위를 제한할 수 있다.

## 11. 구현 결과: hybrid compact cache v3

Polars 0.51 POC는 구 in-memory sink 때문에 peak RSS 약 4.55GB로 탈락했다. 이후 Rust 1.97.1과
Polars 0.54.4의 최신 streaming sink로 재측정한 결과, 8스레드 5회 wall 중앙값 12.206초,
peak RSS 최악 1.103GiB와 출력 parity PASS를 확인했다. 따라서 아래 hybrid v3 layout은 유지하되
CSV preparation의 생성 주체는 남은 dialect·취소·크기·dependency gate를 통과하면 최신 Polars
provider로 교체할 수 있다.

```text
__dv_row_id
__dv_base_raw_<source index>       # Skip 포함 모든 source 열의 parser exact raw
__dv_value_<source index>          # 필요한 visible 열만
__dv_state_word_<word index>       # 32 source 열당 UInt64 1개, cell당 2 bit
```

- Boolean, Int64, UInt64, Float64는 무손실 native physical value를 저장한다.
- Decimal, Date, Timestamp, Duration처럼 고정 Arrow/DuckDB 타입이 기존 허용 범위를 줄일 수 있는
  열은 Rust가 만든 normalized UTF-8 value를 저장한다.
- `trim=false` Text는 exact raw와 value가 같으므로 value physical을 만들지 않는다.
- `trim=true` Text는 Rust `str::trim()`의 Unicode whitespace 의미를 보존하기 위해 normalized
  UTF-8 value를 저장한다. DuckDB `trim()`으로 재현하지 않는다.
- Empty/Invalid/Valid는 packed state word로 판정하며 invalid Boolean N개를 저장하지 않는다.
- provider compatibility view가 기존 `__dv_value_N`, `__dv_raw_N`, `__dv_invalid_N` 계약을
  가상 열로 재구성하므로 query DTO와 상위 SQL 의미는 바꾸지 않는다.

cache manifest v3는 source 열 수와 visible/state 열 수를 분리하고, 구조화된 physical mapping에
source index, internal field, physical kind, state word를 기록한다. Parquet의 primitive/logical type,
repetition/nullability와 mapping fingerprint를 함께 검증하며 v2 cache와 격리한다. 원본 header가
`__dv_*` 형식이어도 내부 필드는 index 기반 namespace를 사용하므로 충돌하지 않는다.

## 12. 아직 연결되지 않은 항목

v3는 Skip을 포함한 모든 raw를 보존해 reprofile 기반은 갖췄지만, 현재 cache identity와 session
교체는 profile별이다. profile 변경 시 old lease에서 새 typed/state generation을 파생하는 연결이
없어 원본 CSV를 다시 읽는다. `32-transactional-reprofile-design.md`의 source-independent semantic
key, bounded raw batch 변환, reserved session Ready, final compare-and-swap을 후속 구현해야 한다.

preparation frontier도 아직 공개되지 않는다. 현 v3는 최종 manifest atomic publish 뒤에만 Ready다.
