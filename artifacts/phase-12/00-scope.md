# Phase 12 구현 범위: 대용량 query·복사와 grid 작업 흐름 안정화

- 상태: 구현 및 검증 완료
- 작성일: 2026-07-21
- 선행 조건: Phase 9 query engine, Phase 11 segmented grid와 source-native navigation
- 기준 회귀: 5,850,000행 × 15열 Parquet의 `group_id` 안정 정렬과 정렬 후 page 탐색

이 Phase는 대용량 query 결과의 정렬 인덱스와 page 조회 경로를 수정하고, 그 결과 위에서
navigation·선택·복사·Find가 같은 논리 좌표를 사용하게 한다. 탭 복귀 geometry, 파일/컬럼 순서 변경,
복사 진행·오류 식별과 H5 구조 판별도 함께 정리한다. 빈 셀과 source/raw/display 값 의미는 바꾸지 않는다.
OEF H5는 query provider가 없으므로 filter/sort 대상에 추가하지 않지만 공통 grid navigation, 구조 판별과
적응형 복사 회귀에는 포함한다.

## 1. 문제 정의와 기준 측정

현재 query engine은 정렬 결과마다 다음 두 값을 5,850,000행 전체에 materialize한다.

```text
__dv_row_id
__dv_result_position = row_number() over (order by ...)
```

또한 `read_query_page`는 필요한 200개 row identity를 먼저 제한하지 않고 `query_result`와
`dv_source`를 join한 뒤 마지막에 `LIMIT`을 적용한다. 2026-07-21 개발 머신의 독립 측정은 다음과 같다.

| 작업 | 측정값 |
| --- | ---: |
| NumPy `argsort(kind="quicksort")` | 0.508초 |
| NumPy stable argsort | 1.571초 |
| DuckDB 정렬 후 source row identity 1열 materialize | 1.16~1.30초 |
| 현재 window position과 2열 index materialize | 2.56초 |
| 현재 방식의 정렬 후 200행·15열 첫 page | 6.42초 |
| 200개 identity를 먼저 제한한 join spike | 0.40초 |

위 수치는 제품 완료 증거가 아니라 설계 방향을 정하기 위한 baseline이다. 최종 성능 판정은
release 제품 경로, low/high cardinality fixture와 반복 측정으로 다시 수행한다.

## 2. 목표

1. 정렬 결과 index를 source row identity 1열로 제한하고 별도 window position 열을 제거한다.
2. 정렬된 물리 table의 `rowid`를 query 결과의 논리 행 위치로 사용한다.
3. page의 source row identity를 먼저 제한한 뒤 요청한 source column만 sparse하게 읽는다.
4. 정렬 후 아래로 스크롤할 때 page 요청이 전체 source join 뒤에서 `pending`으로 고착되지 않게 한다.
5. 정렬·필터 결과에서도 `Ctrl`, `Ctrl+Shift`, `Ctrl+Alt`, `Ctrl+Alt+Shift`, `PageUp`,
   `PageDown`, `Home`, `End`의 좌표·선택·focus 의미를 보존한다.
6. copy, find, boundary, first/middle/last page가 같은 query position 계약을 사용하게 한다.
7. 전체 표시/raw 값 복제 없이 memory와 temp 상한을 유지한다.
8. filter/sort 적용 전 logical row·column focus를 결과 범위 안에서 보존하고 범위 선택은 active cell 하나로 축소한다.
9. 5.85M행×1열과 소수 행×다수 H5 열을 page IPC 반복 없이 bounded backend copy로 처리한다.
10. `Ctrl+F` 명시적 Find, 파일 탭·컬럼 header 순서 변경과 다중 정렬 우선순위 UI를 제공한다.
11. H5는 `.h5`/`.hdf5`, HDF5 signature와 실제 구조로 판별하고 `format` attribute를 판별 조건에서 제외한다.
12. 실제 마지막 row의 content와 border가 horizontal scrollbar 위에 완전히 보이도록 geometry 회귀를 고정한다.

## 3. Query position 계약

정렬·필터가 적용된 query 결과의 좌표는 다음처럼 정의한다.

```text
logical result row = query_result.rowid
source row identity = query_result.__dv_row_id
```

`query_result`는 다음 조건을 만족하는 DuckDB 물리 table이다.

- column은 `__dv_row_id` 한 개만 저장한다.
- 생성 SQL의 마지막 정렬 key는 항상 원본 `__dv_row_id`다.
- QueryResult가 소유한 같은 DuckDB connection에서 materialization을 commit한 뒤 read-only lifetime transaction을 시작하고 모든 position 조회를 그 snapshot에서 수행한다.
- 생성 뒤 update/delete/재삽입하지 않는다.
- row count가 0이 아니면 `min(rowid)=0`, `max(rowid)=count-1`을 검사한다.
- query 교체·취소·실패·tab close 때 table과 관련 cache를 함께 폐기한다.
- 내부 rowid invariant가 맞지 않으면 잘못된 page를 반환하지 않고 typed query 오류로 중단한다.

DuckDB `ORDER BY` 자체의 안정성에 의존하지 않는다. 원본 row identity를 고유한 마지막 key로
추가하여 같은 값과 null 사이의 결정적인 순서를 만든다. null은 오름차순과 내림차순 모두 마지막이다.

## 4. Two-stage query page 계약

query page는 반드시 다음 두 단계로 읽는다.

1. `query_result.rowid` 범위에서 최대 200개의 `(logical_position, source_row_id)`만 가져온다.
2. query connection lock을 해제한 뒤 source provider가 그 row identity와 요청 projection만 읽는다.

원본 값을 먼저 join한 뒤 `LIMIT`하는 SQL은 금지한다. provider가 sparse read를 지원하지 않는
경우에도 최대 200개 identity를 materialized CTE로 먼저 제한한 bounded fallback만 허용한다.

`ReadQueryPageRequest`는 1~64개의 중복 없는 `columns`를 받는다. 응답의 `DataPage.columns`는
요청 projection과 같은 순서여야 한다. query 전체 logical column 목록은 page payload가 아니라
query result metadata에서 유지한다. 이 64열·200행 제한은 grid page 계약이며 copy에는 재사용하지 않는다.
copy는 별도 backend task와 format capability별 적응형 batch 계약을 사용한다.

## 5. 형식별 sparse read

### Parquet

- source row identity를 row group별로 묶는다.
- 요청 projection만 `ProjectionMask`로 연다.
- 선택 row 사이를 `RowSelection`으로 skip하여 선택 row group 전체를 value decode하지 않는다.
- decode 결과는 source row identity map을 통해 query position 순서로 다시 조립한다.
- timestamp ns와 timezone의 exact refinement를 새 sparse path에서도 보존한다.

### CSV

- 적용된 CSV parsing profile과 invalid/null/empty 상태를 보존한다.
- checkpoint index에서 가까운 위치를 찾아 source row identity를 오름차순으로 묶어 읽는다.
- 같은 구간을 중복 파싱하지 않고 요청 결과는 query position 순서로 복원한다.
- sparse path가 기존 page/resource 상한을 우회하지 않는다.

### OEF H5

OEF H5는 이 Phase에서 query provider를 추가하지 않는다. 일반 Data view의 page와 navigation은
기존 transpose/hyperslab 계약을 유지한다. 후보는 `.h5`와 `.hdf5` 확장자, HDF5 signature와 다음
실제 구조로 판별한다.

- `format` attribute는 없어도 되고 값이 무엇이든 판별·거부 조건으로 사용하지 않는다. 작성 측 권장값은 `oesh5`다.
- `format_version`은 정수 `3`, `shape`는 `[n_time, n_wavelength]` 정수 2개여야 한다.
- `/time[n_time]`, `/wavelength[n_wavelength]`는 허용된 integer/float/string 1차원 dataset이어야 한다.
- `/oes[n_wavelength, n_time]`는 int32/int64 2차원 dataset이며 화면에서는 transpose해 time row로 제공한다.
- chunk shape에는 별도 형태 제한을 두지 않되 decoded chunk 64 MiB 상한과 overflow 검사를 유지한다.
- Blosc v1 filter ID 32001의 Zstd를 지원하고 사용할 수 없는 filter/codec은 typed 오류로 거부한다.

## 6. Navigation 계약

- 일반 화살표와 `PageUp`/`PageDown`은 query logical row를 이동한 뒤 목표 page만 읽는다.
- `Ctrl+Alt+↑/↓`는 source row가 아니라 query result의 0 또는 마지막 logical row로 이동한다.
- `Ctrl+Alt+←/→`는 현재 query projection의 첫 또는 마지막 logical column으로 이동한다.
- 모든 Shift 조합은 기존 anchor를 유지하고 새 logical target까지 범위를 확장한다.
- `Ctrl+↑/↓`는 정렬된 query 순서에서 `null`/`empty` 경계를 찾는다. 원본 source 순서의
  boundary target을 재사용하지 않는다.
- null 불가 numeric/Boolean column처럼 empty가 불가능한 경우 query 첫·끝을 O(1)로 계산한다.
- nullable/string column은 bounded position block과 선택 column만 검사하며 query·column별
  occupancy/boundary cache를 사용할 수 있다.
- occupancy block은 최대 16,384개 identity와 column 1개로 제한하고 display/raw 문자열을 만들지 않는다.
- query/filter/sort/session/projection 변경, 새 mouse selection, 일반 key 이동과 focus 이탈은
  진행 중 navigation을 취소하고 늦은 응답을 폐기한다.
- foreground navigation 중에는 인접 page prefetch가 connection이나 provider를 먼저 점유하지 않는다.

## 7. 성능과 자원 예산

같은 머신에서 1회 warm-up 뒤 5회 이상 측정하고 p95, fixture hash, DuckDB thread 수, CPU,
memory와 storage 정보를 기록한다.

| 항목 | 필수 예산 |
| --- | ---: |
| 5.85M low-cardinality `group_id ASC` result index 준비 | p95 1.5초 이하 |
| 위 정렬 적용부터 첫 visible page 표시 | p95 2초 이하 |
| 준비된 low-cardinality first/middle/last 200행 page | p95 250ms 이하 |
| 준비된 high-cardinality random page | p95 1초 이하 |
| query page당 source identity | 최대 200개 |
| query page projection | 최대 64열 |
| query peak RSS | 1.5 GiB 이하 |
| process query temp | 10 GiB 이하 |
| high-cardinality `group_id ASC` result index 준비 | p95 2초 이하 |
| selective 3-column filter/sort 준비와 첫 page | p95 2.5초 이하 |
| non-selective 3-column filter/sort 준비와 첫 page | p95 4초 이하 |

1초 미만 전체 정렬은 목표 최적화 값이지만 현재 Phase의 거짓 완료 조건으로 고정하지 않는다.
위 1.5초 예산을 넘으면 thread 수만 올려 숨기지 말고 plan과 materialization을 다시 조사한다.

## 8. Pending과 요청 우선순위

- foreground visible page가 prefetch보다 우선한다.
- foreground page가 준비되기 전에는 새 adjacent prefetch를 시작하지 않는다.
- 같은 identity/projection/offset 요청은 하나로 합친다.
- scroll·horizontal projection generation이 바뀌면 이전 응답을 적용하지 않는다.
- backend query connection lock은 최대 200개의 identity를 읽는 동안에만 유지한다.
- source decode와 JSON/Arrow 변환은 query connection lock 밖에서 수행한다.
- 실패·취소 시 빈 loading cell을 영구 유지하지 않고 재시도 가능한 typed 오류 상태로 전환한다.

## 9. Filter·sort·Find와 선택 좌표

최종 query 의미는 입력 순서와 무관하게 다음 pipeline으로 고정한다.

```text
column filter로 row 집합 결정
→ multi-column stable sort로 row 순서 결정
→ Find가 결과 안의 match position만 탐색
```

- filter 뒤 sort와 sort 뒤 filter의 최종 plan이 같으면 결과 count·순서·checksum도 같다.
- 전역 match-only `Filter` 모드는 제거하고 header의 typed column filter는 유지한다.
- `Ctrl+F`는 Find를 열고 input에 focus하지만 typing만으로 query를 실행하지 않는다.
- Find draft는 `조회` 또는 Enter에서 commit하며 Esc로 닫고 이전/다음 match를 이동한다.
- normal click은 단일 sort, Shift+click은 multi-sort를 유지하며 별도 UI에서 priority·direction·remove·reorder를 제공한다.
- filter/sort commit 뒤 active column은 column ID, active row는 logical position으로 보존하고 새 count에 clamp한다.
- query 의미가 바뀐 뒤 과거 직사각형을 다른 source row에 적용하지 않도록 range selection은 보존한 active cell 하나로 축소한다.
- target page가 검증되기 전 focus·scroll을 commit하지 않는다.

## 10. 탭 복귀와 순서 변경

- document별 page/cache, logical active cell, scroll top/left, segmented anchor, projection과 column order를 보존한다.
- 숨겨진 tab의 virtualizer 측정과 foreground/prefetch 요청을 정지한다.
- tab 복귀 때 저장된 geometry와 scroll을 paint 전에 복원하고 유효한 visible cache가 있으면 page IPC를 다시 보내지 않는다.
- 파일 탭 drag는 documents 배열의 표시 순서만 바꾸며 session/query/cache identity를 바꾸지 않는다.
- column header drag는 document별 column ID order를 바꾸며 filter/sort는 ID로 유지한다.
- 화면 복사 column 순서는 현재 visible·reordered column 순서를 따르고 hidden column은 제외한다.
- drag와 동등한 keyboard move action을 제공한다.

## 11. 복사 계약

복사는 현재 query snapshot의 logical result를 대상으로 한다.

- 부분 선택은 filter를 통과하고 현재 sort 순서에 놓인 선택 row·visible column만 복사한다.
- 전체 선택은 filter를 통과한 모든 row와 현재 visible column을 화면 순서대로 복사한다.
- Find는 row 집합을 바꾸지 않으므로 copy 범위도 바꾸지 않는다.
- query가 pending·교체·stale이면 과거 값을 복사하지 않고 현재 copy attempt를 typed 이유와 함께 실패 또는 취소한다.
- 5.85M행×1열은 200행 page를 약 29,250회 호출하지 않고 Rust task가 source/query identity를 큰 batch로 읽어 TSV를 bounded하게 생성한다.
- H5처럼 row가 적고 column이 많으면 고정 64열 group 대신 cell 수와 예상 decoded/serialized byte로 batch shape를 정한다.
- grid page의 64열·200행 제한, H5 decoded chunk 64 MiB와 copy cell/byte hard limit은 서로 다른 상한으로 유지한다.
- TSV는 frontend에 page value를 누적하지 않는다. backend가 bounded buffer 또는 app temp를 사용하고 progress/cancel 뒤 system clipboard에 한 번 원자적으로 commit한다.
- Excel worksheet의 1,048,576행을 넘으면 Excel 대상 경고를 표시하되 사용자 copy hard limit 안의 일반 TSV 작업을 임의로 축소하지 않는다.

각 copy attempt는 증가하는 operation ID, 시작 시각, query/session snapshot, logical range, representation,
stage, progress, terminal state와 typed error를 가진다. 현재 attempt와 최근 이전 attempt를 구분해 표시하며
SelectionLimit, ByteLimit, SourceRead, QueryStale, Cancelled, Serialize와 ClipboardWrite를 최소 오류 분류로 둔다.

## 12. 제외 범위

- DuckDB를 다른 query engine으로 교체
- DuckDB와 Polars를 동시에 탑재하거나 Polars로 query engine을 교체
- 저카디널리티 전용 counting/bucket sort의 제품 경로 추가
- OEF H5 query provider 추가
- SQL editor, aggregation, group by, join, charting
- 모든 query 결과 value의 사전 materialization
- 1초 미만 수치를 위해 memory/temp/cancellation 상한 완화
- 데이터 편집 또는 source 파일에 정렬 결과 쓰기

## 13. 완료 조건

1. `10-test-plan.md`의 IDX/PAGE/NAV/RACE/PERF/LIFE/QUX/COPY/H5/UI 필수 항목이 모두 PASS다.
2. query result index는 source row identity 1열만 저장하고 별도 position/window 열을 갖지 않는다.
3. 정렬 후 page가 최대 200개 identity와 요청 projection만 source에서 읽는다.
4. first/middle/last와 빠른 연속 scroll에서 빈 row 또는 영구 `pending`이 없다.
5. 모든 navigation과 Shift 조합이 query logical 좌표, 선택, focus visibility를 보존한다.
6. low/high cardinality 정렬·page checksum과 nulls-last stable 순서가 reference와 일치한다.
7. 성능·RSS·temp·cancel·cleanup 예산을 release 제품 경로에서 만족한다.
8. 필수 native 또는 성능 증거가 없으면 Phase를 완료로 표시하지 않는다.
9. filter/sort 뒤 logical focus 보존, tab cache 복귀, Find 명시적 실행과 파일/컬럼 reorder가 UI 계약과 일치한다.
10. 부분·전체 query copy가 filtered row 집합, sorted row 순서와 visible reordered column만 사용한다.
11. 5.85M행×1열과 wide H5 copy가 적응형 backend batch, progress/cancel과 typed history를 사용한다.
12. H5가 `format` 값과 무관하게 확장자·signature·version·shape·dataset 구조로 판별된다.
