# Phase 12 기술 설계

- 상태: 구현 및 검증 완료
- 작성일: 2026-07-21
- 변경 영역: query SQL/index, source sparse read, query page DTO, grid request scheduling과 navigation

## 1. 설계 원칙

1. query logical position과 source row identity를 분리한다.
2. 정렬 결과에 source value나 명시적인 position column을 중복 저장하지 않는다.
3. page identity를 먼저 제한하고 source value는 나중에 projection 단위로 읽는다.
4. format별 sparse read는 공통 trait 뒤에 두되 CSV와 Parquet 구현을 억지로 합치지 않는다.
5. frontend selection과 navigation은 source row identity를 알지 않는다.
6. 모든 request, cache와 response는 document/session/query/projection generation으로 격리한다.
7. grid page와 bulk copy는 서로 다른 resource 계약을 사용한다.
8. UI 순서는 index가 아니라 document/column identity로 보존한다.
9. H5 판별은 `format` 문자열이 아니라 확장자, signature와 dataset 구조를 사용한다.
10. resource 상한, cancellation과 typed error를 성능 최적화보다 먼저 유지한다.

## 2. 기존 병목

현재 materialize SQL은 같은 order expression을 ordered window와 table order에 사용한다.

```sql
CREATE TABLE query_result AS
SELECT
  __dv_row_id,
  row_number() OVER (ORDER BY <sort>, __dv_row_id) - 1
    AS __dv_result_position
FROM dv_source
WHERE <filter>
ORDER BY <sort>, __dv_row_id;
```

이 구조는 DuckDB sort 외에 blocking window와 position column 전체 materialization을 추가한다.
현재 page SQL도 다음 형태라 `LIMIT` 전에 source scan/hash join이 발생할 수 있다.

```sql
SELECT q.__dv_row_id, <source values>
FROM query_result q
JOIN dv_source s USING (__dv_row_id)
WHERE q.__dv_result_position >= ?
ORDER BY q.__dv_result_position
LIMIT ?;
```

실행 계획상 source의 5,850,000행과 요청 projection을 읽은 뒤 `TOP_N 200`을 적용할 수 있어
page마다 전체 source 작업이 반복된다.

## 3. 새 result index

### 3.1 생성 SQL

```sql
CREATE TABLE query_result AS
SELECT __dv_row_id
FROM dv_source
WHERE <typed filters>
ORDER BY <typed sort expressions>, __dv_row_id ASC;
```

sort가 없는 경우에도 원본 순서를 결정적으로 보존하기 위해 `__dv_row_id ASC`를 마지막이자 유일한
order key로 사용한다. sort key identifier는 기존 validator를 통과한 column만 quote하고 filter 값은
bind parameter를 사용한다.

### 3.2 Physical rowid 사용

DuckDB 물리 table의 `rowid`를 `__dv_result_position`으로 해석한다. DuckDB 문서는 삭제가 없는
table의 rowid가 0부터 연속인 unsigned integer이며 materialized table의 순서 번호로 사용할 수 있다고
설명한다.

- 공식 rowid: <https://duckdb.org/docs/stable/sql/statements/select#row-ids>
- order preservation: <https://duckdb.org/docs/stable/sql/dialect/order_preservation>

DuckDB 1.4에서는 writer transaction이 열린 동안 생성·삽입한 table의 physical `rowid`가 0이 아닌
transient base에서 시작할 수 있다. 따라서 같은 result-owned connection에서 materialization
transaction을 commit한 직후 read-only lifetime transaction을 다시 시작한다. 이 경계 뒤에는
update/delete/append를 금지하고 `rowid=0..count-1`을 검사한다. replace/close에서는 read-only
transaction을 rollback한 뒤 connection과 temp lease를 해제한다. page/find/boundary는 모두 이 같은
connection과 read-only snapshot에서 수행한다. 생성 직후 다음 invariant를 검사한다.

```sql
SELECT count(*), min(rowid), max(rowid), count(DISTINCT __dv_row_id)
FROM query_result;
```

전체 row 수가 매우 클 때 `count(DISTINCT)`가 불필요한 추가 hash 비용을 만들 수 있으므로 source
identity의 1:1 성질은 생성 SQL과 source invariant test로 검증하고 제품 경로에서는 count/min/max만
사용한다. 빈 결과는 min/max null을 허용한다.

### 3.3 Position 참조

모든 query SQL은 저장 column 대신 qualified pseudo-column을 사용한다.

```sql
q.rowid AS __dv_result_position
```

대상은 page, find matches, query boundary, copy, first/last와 result count다. pseudo-column과 source의
실제 `rowid` 이름 충돌을 피하기 위해 항상 table alias로 qualify하고 외부 DTO 이름은 기존
`resultPosition`을 유지한다.

## 4. Page identity slice

```sql
SELECT
  rowid AS __dv_result_position,
  __dv_row_id
FROM query_result
WHERE rowid >= ? AND rowid < ?
ORDER BY rowid;
```

- offset은 u64, limit은 1..200이다.
- upper bound는 checked addition으로 계산한다.
- query connection mutex 안에서는 이 identity slice만 읽는다.
- `Vec<(position, source_row_id)>`를 만든 즉시 statement와 mutex guard를 해제한다.
- source decode, exact timestamp refinement, DTO formatting과 serialization은 lock 밖에서 실행한다.

## 5. Query page DTO

```text
ReadQueryPageRequest {
  documentId,
  sessionId,
  queryId,
  offset,
  limit,
  columns: string[1..64]
}
```

검증 규칙은 Rust와 TypeScript에서 같다.

- 모든 identity는 기존 길이·문자 계약을 따른다.
- `limit`은 1..200이다.
- `columns`는 1..64, trim 후 non-empty, case-sensitive unique다.
- 모든 column은 query result metadata의 projection에 포함되어야 한다.
- 응답 column은 request와 같은 순서다.

query logical column 목록은 `QueryState.resultColumns` 또는 committed plan projection으로 유지한다.
`DataPage.columns`를 전체 logical schema로 오용하지 않는다. grid horizontal virtualization은 현재
mounted logical column을 request projection으로 보낸다. 64열·200행은 interactive grid page 전용
상한이며 bulk copy는 이 API를 반복 호출하지 않는다.

## 6. Source sparse row contract

`QueryInputProvider`에 bounded sparse read를 추가한다. 정확한 Rust 이름은 구현 시 기존 trait naming과
맞추되 의미는 다음과 같다.

```rust
fn read_rows_projected(
    &self,
    row_ids: &[u64],        // 0..=200, query page order
    columns: &[String],     // 1..=64, request order
    cancel: &AtomicBool,
) -> Result<Vec<Vec<DataValue>>, DataError>;
```

계약:

- 결과 행 수와 순서는 `row_ids`와 정확히 같다.
- duplicate row identity도 input 위치별로 보존한다.
- source bounds, projection과 cancellation을 decode 전에 검사한다.
- page preview 상한과 full-cell 16 MiB 경로를 혼합하지 않는다.
- raw/source metadata와 invalid/null/empty state를 일반 page와 동일하게 만든다.
- request당 decoded/output estimate를 기존 resource limit으로 검사한다.

## 7. Parquet sparse implementation

기존 `read_rows_exact`를 timestamp 전용 보정 함수에서 일반 projection sparse reader로 승격한다.

1. requested source row identity를 row-group offset으로 매핑한다.
2. row group별 target local row를 정렬하고 output index를 함께 저장한다.
3. `ProjectionMask`는 요청 column root만 포함한다.
4. target 사이의 skip/select run으로 `RowSelection`을 구성한다.
5. Parquet reader에는 selected row groups, projection, row selection과 bounded batch size를 설정한다.
6. decoded batch의 선택 row만 `DataValue`로 변환한다.
7. source row identity→output index map으로 query page order를 복원한다.

테스트 audit는 selected row groups뿐 아니라 requested/decoded row와 column 수를 기록한다. high-cardinality
page가 여러 row group에 걸려도 전체 15열 또는 선택 row group의 모든 value row를 decode하지 않아야 한다.
page index가 없는 파일에서도 correctness는 같아야 하며 compressed page read와 decoded value 수를
구분해 기록한다.

timestamp ns/timezone exact path는 sparse reader의 canonical DataValue를 사용해 별도 전체 join 없이
정밀도를 보존한다. binary/nested는 page preview만 만들고 전체 값은 기존 명시적 detail/copy 경로를 쓴다.

## 8. CSV sparse implementation

CSV query provider는 적용된 parsing profile과 checkpoint index를 소유하거나 안전하게 참조한다.

1. row identity를 오름차순으로 정렬하되 원래 output index를 보존한다.
2. 가장 가까운 checkpoint부터 parser를 재개한다.
3. 같은 checkpoint 구간의 여러 target을 한 번의 전진 parse로 읽는다.
4. 멀리 떨어진 target group은 별도 checkpoint에서 재개한다.
5. profile typed value, invalid 원문, null과 empty state를 일반 page와 동일하게 생성한다.
6. 결과를 query page order로 복원한다.

한 요청의 checkpoint group, seek, parsed record와 byte 수를 audit할 수 있게 한다. 200개의 identity마다
파일 처음부터 다시 읽거나 200개의 독립 parser를 만들지 않는다.

## 9. Query boundary

query에서 vertical `Ctrl+Arrow`는 result position 순서로 값을 검사해야 한다. source-native 원본 순서
boundary target을 그대로 사용할 수 없다.

### 9.1 Fast path

- non-null numeric, Boolean과 OEF 정수처럼 empty가 불가능한 column은 현재 cell state와 방향만으로
  query result의 0 또는 마지막 position을 O(1) 계산한다.
- `Ctrl+Alt`는 값 state를 보지 않고 항상 같은 absolute path를 사용한다.

### 9.2 Bounded scan

nullable/string/invalid 가능 column은 다음 순서로 검사한다.

1. `query_result.rowid`에서 방향에 맞는 bounded position block의 source identity를 읽는다.
2. provider의 occupancy 전용 projection으로 선택 column 하나만 읽는다.
3. `null`/`empty`만 vacant로 변환하고 Excel transition rule을 적용한다.
4. target이 없으면 다음 block으로 진행하되 cancellation과 resource budget을 검사한다.
5. 검사한 run과 발견한 boundary를 query+column generation cache에 저장한다.

page sparse read의 200행 상한을 boundary scan에 무단 재사용하지 않는다. boundary provider에는
선택 column 하나와 최대 16,384개의 source identity를 받아 packed occupancy bitset을 반환하는 별도
bounded API를 둔다. 값 문자열이나 DataValue 전체를 만들지 않으며 request estimate가 16 MiB를
넘으면 block을 더 작게 나눈다. Quality 측정으로 더 작은 block이 유리하면 상한 안에서 조정하되
공통 `read_query_page` 반복으로 되돌리지 않는다.

cache는 logical position interval과 occupancy만 저장하고 display/raw 문자열을 저장하지 않는다.
query당 최대 4 column, 총 8 MiB의 LRU 상한을 두는 것을 기본안으로 하며 Quality 성능 측정 후 수치를
확정한다. query 교체, projection/profile/session 변경 시 폐기한다.

horizontal `Ctrl+Left/Right`는 한 source row identity와 현재 logical projection만 sparse read한다.

## 10. PageUp/Down과 absolute navigation

- PageUp/Down target 계산은 frontend logical coordinate reducer에서 수행한다.
- 목표 page가 cache에 없으면 해당 page 한 번만 foreground 요청한다.
- target page identity와 projection이 검증된 뒤 active/selection/scroll을 commit한다.
- `Ctrl+Alt+Up/Down`은 query row count만 사용하므로 source scan이 없다.
- `Ctrl+Alt+Left/Right`는 query result metadata의 logical column count를 사용한다.
- Shift 조합은 target 계산과 page load가 끝날 때까지 기존 anchor를 보존한다.

## 11. Request scheduling과 lock

frontend request 상태는 `(document, session, query, offset, projection, generation)` key를 사용한다.

- foreground queue와 prefetch queue를 구분한다.
- 같은 key는 promise를 합친다.
- foreground in-flight 동안 새 prefetch를 시작하지 않는다.
- foreground target이 바뀌면 시작 전 prefetch를 버리고 늦은 결과를 cache에 적용하지 않는다.
- foreground page가 15초 안에 terminal state가 되지 않으면 generation의 loading key를 제거하고
  같은 query/projection에서만 실행 가능한 typed timeout과 Retry로 전환한다.
- backend는 identity slice 동안만 query connection mutex를 잡는다.
- provider read는 query connection과 독립이며 문서당 bounded semaphore를 사용한다.
- 초기안은 문서당 foreground 1개와 prefetch 최대 1개를 허용하되 foreground가 항상 우선한다.

Tauri command는 validation과 service 호출만 담당한다. scheduler, provider와 query index 로직을 command에
넣지 않는다.

## 12. Query composition, Find와 logical focus

committed `QueryPlan`은 filter와 ordered sort criteria를 함께 가진다. 실행 의미는 항상
`typed column filter → stable multi-column sort → Find navigation`이다. 사용자가 UI에서 filter와
sort를 누른 순서는 plan 결과 의미에 영향을 주지 않는다. sort의 마지막 key는 source row identity이며
양방향 nulls-last를 유지한다.

전역 match-only Filter mode는 제거한다. Find state는 다음처럼 query plan과 분리한다.

```text
FindState {
  draft,
  committed,
  searchedQueryId,
  columns,
  options,
  currentMatchPosition,
  status
}
```

- draft 변경은 backend를 호출하지 않는다.
- `조회`/Enter만 committed criteria로 match position을 계산한다.
- match position은 `q.rowid`로 표현하고 result row count나 order를 바꾸지 않는다.
- query ID가 바뀌면 이전 match는 stale이며 자동 재조회하지 않는다.
- previous/next는 같은 committed query snapshot 안에서만 이동한다.

filter/sort commit 전 active row logical position과 active column ID를 snapshot한다. 새 result count에서
row를 clamp하고 현재 column order/visibility에서 ID를 resolve한다. 이전 rectangular selection은 source
identity 의미가 바뀌므로 active cell 하나로 축소한다. target page identity와 projection이 검증된 뒤에만
selection, scroll과 DOM focus를 한 transaction처럼 commit한다.

## 13. Document tab과 column order

document tab order는 registry/session identity와 분리된 frontend order 배열이다. drag는 이 배열만
재배치하고 document의 page cache, query result, copy task와 source handle을 다시 만들지 않는다.
inactive document는 request scheduling과 virtualizer measurement를 pause한다. 활성화 시 `useLayoutEffect`
단계에서 저장된 segmented anchor, scrollTop/Left, projection과 selection을 복원하고 virtualizer를 measure한다.
visible page cache key가 일치하면 backend page call은 0이어야 한다.

column order는 document별 column ID 배열로 저장한다. width, visibility, filter/sort criteria, active/anchor는
모두 column ID를 canonical identity로 사용하고 render/selection/copy 직전에 visual index로 resolve한다.
drag와 keyboard reorder는 같은 reducer action을 사용한다. hidden column은 visual/copy projection에서
제외하지만 filter/sort plan의 ID 의미를 임의로 제거하지 않는다.

## 14. Backend bulk copy

bulk copy는 frontend page accumulator 대신 Rust task로 실행한다.

```text
StartCopyRequest {
  documentId, sessionId, queryId?,
  logicalRange,
  visibleColumnIdsInOrder,
  representation,
  settingsSnapshot,
  cellLimit, byteLimit
}

CopyOperation {
  operationId, startedAt, snapshot,
  stage, completedRows, totalRows,
  state, errorCode?, message?
}
```

- query copy는 먼저 bounded position block에서 source identity를 얻고 provider가 필요한 column만 batch read한다.
- 부분/전체 선택 모두 filtered result row 집합과 sorted row order를 사용한다.
- column projection은 현재 visible·reordered ID이며 hidden column을 제외한다.
- frontend로 cell page를 반환하지 않고 Rust에서 TSV를 streaming serialize한다.
- cell/serialized byte/temp hard cap을 checked arithmetic으로 preflight하고 실행 중에도 재검사한다.
- output은 bounded memory buffer 또는 process/document/operation별 app-local temp에 기록한다.
- 모든 batch가 성공하고 query/session snapshot이 여전히 유효할 때 native clipboard를 한 번 교체한다.
- 실패·취소에는 이전 clipboard를 유지하고 partial output을 정리한다.
- Excel sheet row 한도 초과는 target warning이며 제품의 일반 TSV hard limit과 분리한다.

source capability가 batch shape를 선택한다. 5.85M행×1열 Parquet/CSV는 한 batch 최대 64,000 cell
또는 serialized estimate 8 MiB 중 먼저 도달하는 vertical batch로 읽고,
wide H5는 `rows × columns`, 예상 decoded bytes와 serialized bytes 안에서 연속 wavelength 범위를 최대한
합친 hyperslab을 사용한다. grid의 64열·200행 상한을 copy에 적용하지 않지만 H5 decoded chunk 64 MiB,
copy cell/byte/temp cap과 cancellation은 완화하지 않는다.

각 silent early return을 terminal state로 바꾼다. 최소 error code는 `SelectionLimit`, `ByteLimit`,
`SourceRead`, `QueryStale`, `Cancelled`, `Serialize`, `ClipboardWrite`다. frontend는 operation ID와 시작 시각으로
현재 attempt를 표시하고 최근 완료 attempt 최대 5개를 보존한다. Retry는 이전 operation을 재사용하지
않고 새 operation ID와 실행 시점의 새 snapshot을 만든다.

## 15. H5 구조 판별

H5 open pipeline은 다음 순서를 따른다.

1. registry에서 대소문자 무관 `.h5` 또는 `.hdf5` 확장자를 후보로 선택한다.
2. HDF5 signature와 read-only container open을 확인한다.
3. `format_version` 정수 scalar `3`과 `shape=[n_time,n_wavelength]` 정수 2개를 검증한다.
4. hard link인 `/time`, `/wavelength`, `/oes`의 rank, dtype와 실제 shape를 검증한다.
5. `/oes[n_wavelength,n_time]`의 storage/chunk/filter와 decoded chunk 예산을 검증한다.

`format` attribute는 존재, datatype과 값 모두 판별 조건으로 읽지 않는다. writer 권장값 `oesh5`, 기존
`oefh5`, `oesf5`, 다른 문자열, integer/array attribute와 attribute 없음은 구조가 같으면 같은 결과다.
time/wavelength는 integer·float·string,
oes는 int32/int64만 허용한다. Blosc v1 32001/Zstd는 static runtime으로 읽고 알 수 없거나 사용할 수 없는
filter/codec은 typed unsupported-compression 오류로 반환한다. soft/external link, VDS, external storage와
overflow/oversized decoded chunk 보안 제한은 유지한다.

## 16. Lifecycle

- query cancel/failure는 incomplete index를 registry에 commit하지 않는다.
- query replace/close는 result table, sparse cache, boundary cache와 in-flight generation을 함께 폐기한다.
- copy cancel/failure/query replace/tab close는 operation task와 temp를 정리하고 늦은 clipboard commit을 금지한다.
- full-cell inspector는 한 position→source identity를 읽은 뒤 기존 full-value provider를 사용한다.

## 17. 자원과 보안

- result index logical payload는 source row identity 8 byte/row 한 열이다.
- DuckDB 자체 table overhead와 sort key buffer는 benchmark에서 별도 기록한다.
- max memory 1 GiB, process temp 10 GiB와 5 GiB safety reserve를 유지한다.
- source는 계속 read-only로 연다.
- user value를 SQL 문자열에 연결하지 않고 bind parameter를 사용한다.
- validated identifier만 quote한다.
- checked arithmetic, row/projection/resource 상한과 cancellation을 모든 sparse path에 적용한다.
- 새로운 runtime dependency나 filesystem 권한을 추가하지 않는다.

## 18. 대안과 결정

### 명시적 streaming position column

정렬 subquery 뒤 `row_number() OVER ()`로 position을 만들면 ordered window 중복은 피하지만 2열 index와
전체 position write는 남는다. 독립 측정이 약 1.57초여서 1열 physical rowid 안보다 느리다.

### Rust custom quicksort/counting sort

저카디널리티 integer에는 더 빠를 수 있으나 string/decimal/timestamp/null, multi-column, spill과
cancellation을 별도 구현해야 한다. 현재 범위에서는 DuckDB의 typed hybrid sort를 유지한다.

### Polars query engine 또는 DuckDB+Polars 병행

Polars lazy/streaming은 단발성 scan·transform·sort에 강하지만 이 제품은 materialized result position을
재사용해 random page, navigation, Find와 copy를 같은 snapshot에서 수행해야 한다. Polars를 사용하면
DataFrame 또는 별도 index artifact, spill/lifecycle, stable null semantics와 cancellation을 다시 설계해야 한다.
현재 병목은 DuckDB 자체 sort보다 ordered window와 source-before-limit join에서 측정되었으므로 DuckDB를
유지하고 해당 plan을 제거한다. Polars dependency와 이중 query semantics는 추가하지 않는다.

### 제한된 CTE 뒤 source join

현재 6.42초 page를 약 0.40초로 줄인 spike지만 high-cardinality identity가 전체 source에 흩어지면
source scan이 커질 수 있다. provider sparse read의 안전 fallback으로만 사용하고 최종 Parquet 경로로
채택하지 않는다.

## 19. 기술 완료 조건

- query plan에 ordered window position과 unbounded source-before-limit join이 없다.
- result index는 source identity 한 열이고 physical rowid invariant를 검사한다.
- page와 query copy가 먼저 bounded identity slice를 만들되 copy는 page API를 반복하지 않는다.
- Parquet/CSV sparse reader가 projection, decode와 resource audit를 통과한다.
- navigation, find와 copy가 같은 physical position 계약을 사용한다.
- connection lock, stale response, cancel과 cleanup 회귀가 없다.
- low/high cardinality release 성능 예산을 모두 충족한다.
- filter/sort/Find, tab restore, logical focus와 column ID order가 같은 query snapshot 계약을 사용한다.
- H5가 `format` 값이 아니라 확장자·signature·version·shape·dataset 구조로 판별된다.
- backend copy가 filtered/sorted row와 visible/reordered column을 streaming 처리하고 typed attempt history를 남긴다.
