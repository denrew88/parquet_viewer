# Phase 12 아키텍처 설명: 다중 필터·정렬과 대용량 처리

- 상태: 설계 설명, 사용자 검토용
- 작성일: 2026-07-21
- 관련 문서: `00-scope.md`, `10-test-plan.md`, `20-ux-design.md`, `30-technical-design.md`, `40-implementation-plan.md`

지금 제시한 구조는 여러 필터·다중 정렬·대용량 페이지 탐색을 함께 처리하는 뷰어에 적합한
구조다. 특히 전체 결과를 한 번 정렬한 뒤 필요한 화면만 빠르게 읽는 용도에 맞춰져 있다.

## 전체 흐름

```text
Parquet / CSV 원본
        │
        ▼
DuckDB에서 typed filter 적용
        │
        ▼
여러 컬럼 기준 안정 정렬
        │
        ▼
정렬된 source row ID 한 열만 저장
        │
        ▼
현재 페이지의 row ID 최대 200개 조회
        │
        ▼
원본에서 필요한 컬럼만 sparse read
        │
        ▼
그리드 표시 / Find / 이동 / 복사
```

핵심은 정렬된 전체 값을 별도로 복제하지 않고 정렬된 원본 행 번호 목록만 저장한다는 것이다.

## 1. 여러 필터를 효율적으로 처리하는 방식

필터는 DuckDB가 원본 값을 읽는 단계에서 적용한다.

예를 들어 다음 조건이 있다면:

```text
group_id IN (10, 20, 30)
AND intensity >= 1000
AND timestamp < 2026-01-01
```

논리적으로는 다음처럼 처리한다.

- 같은 컬럼에서 여러 값: OR
- 서로 다른 컬럼의 조건: AND
- 문자열, 숫자, timestamp, null 등은 원본 타입으로 비교
- 화면에 표시된 문자열이 아니라 raw typed value로 비교

Parquet에서는 필요한 컬럼만 읽는 projection pushdown과 가능한 row group을 건너뛰는 filter
pushdown을 활용할 수 있다.

15개 컬럼 중 필터와 정렬에 필요한 컬럼이 3개라면 처음부터 15개 컬럼 전체를 문자열로 변환하지
않는다. 이 때문에 잘못된 26 GiB 메모리 경고나 전체 display 문자열 생성 같은 문제가 없어져야 한다.

필터 결과가 적으면 정렬해야 할 행 수도 줄어든다.

```text
585만 행
→ 필터 후 40만 행
→ 40만 행만 정렬
→ 40만 개 source row ID만 결과 index에 저장
```

## 2. 여러 컬럼 정렬을 처리하는 방식

예를 들어 사용자가 다음 순서로 정렬했다고 가정한다.

```text
1. group_id ASC
2. timestamp DESC
3. wavelength ASC
```

실제 정렬 key는 내부적으로 다음과 같다.

```text
group_id ASC
timestamp DESC
wavelength ASC
source_row_id ASC
```

마지막 `source_row_id`는 사용자가 선택한 정렬 컬럼은 아니지만 같은 값을 가진 행의 순서를 항상
동일하게 만들기 위한 tie-breaker다.

이 방식의 장점은 다음과 같다.

- 같은 파일과 같은 조건이면 항상 같은 순서
- 페이지를 다시 읽어도 행 순서가 바뀌지 않음
- PageDown이나 복사 중 중복·누락이 발생하지 않음
- Shift+header 정렬과 정렬 패널이 같은 QueryPlan을 사용
- null은 오름차순·내림차순 모두 마지막으로 일관되게 처리

정렬 우선순위가 바뀌면 새 정렬 결과를 만들지만 정렬 결과에는 원본 데이터 전체를 저장하지 않는다.

## 3. 정렬 결과에는 행 번호 하나만 저장

현재 문제가 있는 구조는 행마다 다음 두 값을 저장한다.

```text
source row ID
row_number()로 계산한 result position
```

게다가 `row_number()`를 계산하려고 정렬된 전체 결과에 window 연산까지 수행한다.

새 구조는 다음 하나만 저장한다.

```text
query_result
┌────────────────┐
│ source_row_id  │
├────────────────┤
│ 5,120,003      │
│ 42             │
│ 988,120        │
│ ...            │
└────────────────┘
```

이 table의 물리적인 `rowid`를 정렬 결과 위치로 사용한다.

```text
query_result.rowid 0 → 정렬 결과 첫 번째 행
query_result.rowid 1 → 정렬 결과 두 번째 행
query_result.rowid 2 → 정렬 결과 세 번째 행
```

585만 행이라면 source row ID의 논리 payload는 대략 다음 정도다.

```text
5,850,000 × 8 bytes ≈ 44.6 MiB
```

실제 DuckDB table overhead와 정렬 작업 메모리는 별도로 발생하지만 모든 컬럼 값이나 표시 문자열을
저장하는 것과는 규모가 완전히 다르다.

이 table은 같은 DuckDB connection에서 만든다. DuckDB 1.4의 writer transaction 안에서는 physical
`rowid`가 큰 transient base에서 시작할 수 있으므로, materialization을 commit한 직후 read-only
lifetime transaction을 시작한다. 이후 table을 수정하지 않고 다음 조건을 검사한다.

- 행 수가 예상 결과 수와 일치
- 첫 physical rowid가 0
- 마지막 physical rowid가 `count - 1`
- 정렬 결과 checksum이 기준값과 일치
- query가 교체되거나 탭이 닫히면 함께 제거

## 4. 페이지를 읽을 때 전체 조인을 하지 않음

현재 느린 이유는 대략 다음 순서로 동작하기 때문이다.

```text
query_result 전체
JOIN
원본 585만 행
ORDER/LIMIT
마지막에 200행 선택
```

화면에는 200행만 필요한데 큰 작업을 먼저 수행한다.

새 구조는 순서가 반대다.

```text
1. query_result에서 현재 위치의 row ID 200개 조회
2. DuckDB connection lock 해제
3. 원본에서 그 200행과 필요한 컬럼만 조회
4. query 순서로 다시 조립
```

예를 들어 현재 화면에 200행과 8개 컬럼이 필요하면 전체 585만×15 값을 읽는 것이 아니라 200개
row identity와 8개 requested column만 읽는다.

정렬이 한 번 준비된 다음의 페이지 조회 비용은 전체 585만 행보다는 현재 200개 행이 어느 row group에
흩어져 있는지에 더 크게 좌우된다.

## 5. 가로·세로 이동도 필요한 정보만 읽음

### Ctrl+Left/Right

현재 logical row의 값만 필요하다.

```text
현재 query position
→ source row ID 1개
→ 현재 visible column들의 빈값 여부만 읽기
→ 경계 계산
```

전체 필터 결과를 조인할 이유가 없다. 따라서 필터 적용 후 가로 Ctrl 이동이 느린 문제를 직접 해결할
수 있다.

### Ctrl+Up/Down

현재 컬럼에서 빈 셀과 값이 있는 영역의 경계를 찾아야 한다.

- null 불가능 숫자/Boolean: 처음 또는 끝을 O(1)로 계산
- nullable/string: 한 컬럼의 occupancy만 block 단위로 검사
- 이미 검사한 영역: query·column별 boundary cache 사용
- display 문자열이나 전체 `DataValue` 생성 없음

빈 셀이 없는 585만 행 숫자 컬럼은 처음부터 끝까지 200행씩 읽지 않는다.

### Ctrl+Alt+화살표

값을 검사하지 않고 결과 행 수와 컬럼 수만 사용하므로 거의 O(1)이다.

### PageUp/PageDown

중간 페이지를 순서대로 읽지 않고 목표 위치를 계산한 다음 그 페이지 하나만 요청한다.

## 6. 필터와 정렬 순서도 일관됨

사용자가 UI에서 어떤 작업을 먼저 했든 최종 실행 의미는 고정된다.

```text
필터로 행 집합 결정
→ 다중 정렬로 행 순서 결정
→ Find로 현재 위치 탐색
```

`group_id` 필터 후 `timestamp` 정렬과 `timestamp` 정렬 후 `group_id` 필터가 최종적으로 같은 필터와
정렬 조건을 가지고 있다면 동일한 QueryPlan을 실행하므로 결과도 같아야 한다.

Find는 결과 안에서 일치하는 위치를 찾을 뿐 행을 제거하거나 순서를 변경하지 않는다.

## 7. 선택과 복사도 같은 query 결과를 사용

복사만 별도의 원본 순서를 사용하면 화면과 복사 결과가 달라질 수 있다. 따라서 선택·Find·복사·키보드
이동이 모두 같은 query position을 사용한다.

필터와 정렬이 적용된 상태에서는 다음 계약을 적용한다.

- 일부 선택: 화면에서 선택한 filtered/sorted 행만 복사
- 전체 선택: 필터를 통과한 모든 행만 복사
- 행 순서: 현재 다중 정렬 순서
- 컬럼 순서: 화면에서 재배치된 visible column 순서
- hidden column: 제외

예를 들어 원본 행 번호가 다음처럼 정렬되었다고 가정한다.

```text
query position:  0    1    2    3
source row ID:  90   12   44    3
```

화면에서 query position 1~3을 복사하면 원본 순서 `3, 12, 44`가 아니라 화면 순서인 `12, 44, 3`으로
복사한다.

## 8. 대용량 복사를 페이지 조회와 분리한 이유

585만 행×1컬럼을 200행씩 읽으면 약 29,250번의 요청이 필요하다. 각 요청이 빨라도 IPC, JSON 변환과
JavaScript 문자열 누적 때문에 느릴 수밖에 없다.

새 복사 경로는 다음처럼 동작한다.

```text
Rust backend copy task
→ 큰 row batch로 읽기
→ Rust에서 TSV streaming 직렬화
→ 진행률만 frontend에 전달
→ 전부 성공하면 clipboard 한 번 기록
```

따라서 WebView는 585만 개 값을 하나씩 전달받거나 거대한 문자열을 조립하지 않는다.

H5처럼 행은 적지만 컬럼이 많은 데이터는 반대로 넓은 batch를 사용한다.

```text
15행 × 4,096컬럼 = 61,440 cells
```

이 정도라면 64컬럼씩 64번 호출하지 않고 메모리·byte 한도 안에서 큰 hyperslab 하나 또는 소수의
hyperslab으로 읽을 수 있다.

## 9. 메모리가 부족하면 DuckDB가 임시 디스크를 사용

정렬은 본질적으로 전체 입력을 확인해야 하는 blocking 작업이다. 585만 행 정렬 자체를 페이지 조회처럼
200행만 읽어서 끝낼 수는 없다.

대신 다음 상한을 둔다.

- DuckDB memory limit
- query process temp hard cap
- 디스크 안전 여유 공간
- 취소 가능
- query 교체·탭 종료 시 정리
- crash orphan 정리

메모리에 충분히 들어가면 메모리에서 정렬하고 부족하면 bounded temporary disk spill을 사용한다. UI에는
실제 임시 공간 추정치와 hard cap을 구분해서 보여줘야 한다.

## 10. 이 구조의 한계

효율적인 구조이지만 모든 작업이 즉시 끝나는 것은 아니다.

### 새로운 정렬은 전체 정렬 작업이 필요함

정렬 컬럼이나 방향을 바꾸면 결과 index를 다시 만들어야 한다. 다만 불필요한 window column과 전체 값
복제를 제거했기 때문에 현재보다 훨씬 가벼워진다.

### 고카디널리티 정렬은 더 어려움

거의 모든 값이 서로 다른 컬럼으로 정렬하면 source row ID가 여러 Parquet row group에 넓게 흩어질 수
있다. 그러면 random page 조회가 저카디널리티 정렬보다 느릴 수 있다. 따라서 low/high-cardinality
성능 테스트를 별도로 둔다.

### CSV는 Parquet보다 random access가 불리함

CSV는 row group과 column projection이 없으므로 checkpoint에서 다시 파싱해야 한다. checkpoint별로
row ID를 묶어 읽어야 하며 Parquet만큼 빠른 sparse read를 보장할 수는 없다.

### 초대형 clipboard 자체에도 비용이 있음

585만 행을 효율적으로 읽어도 최종 TSV가 수백 MiB라면 직렬화와 Windows clipboard 기록에는 시간이
필요하다. 이 부분은 progress, cancel, byte limit과 Excel 행 한도로 관리한다.

## 11. 정렬된 200개 row ID로 실제 값을 조회하는 과정

정렬된 `source row ID` 200개는 원본에서 가져와야 할 행 주소 목록으로 사용한다. DuckDB는 최종 셀
값을 반환하는 역할이 아니라 어떤 원본 행을 어떤 순서로 보여줄지를 결정한다.

### 11.1 DuckDB에서 현재 결과 위치의 row ID를 가져옴

필터·정렬 결과의 logical position 1,000부터 200행을 조회한다면 다음과 같은 position slice를 읽는다.

```sql
SELECT
    rowid AS result_position,
    source_row_id
FROM query_result
WHERE rowid >= 1000
  AND rowid < 1200
ORDER BY rowid;
```

결과가 다음과 같다고 가정한다.

| 결과 위치 | 원본 row ID |
| ---: | ---: |
| 1000 | 5,120,003 |
| 1001 | 42 |
| 1002 | 988,120 |
| 1003 | 5,119,999 |
| ... | ... |

이 순서가 화면의 정렬 순서다.

```text
5,120,003 → 42 → 988,120 → 5,119,999
```

DuckDB connection에서는 이 200개의 `(result_position, source_row_id)`만 가져온 뒤 statement와 lock을
즉시 해제한다. 이후 원본 decode, 값 변환과 직렬화는 DuckDB connection lock 밖에서 수행한다.

### 11.2 현재 화면에 필요한 컬럼만 projection함

가로 viewport에 다음 컬럼만 필요하다고 가정한다.

```text
group_id
timestamp
intensity
```

source provider에는 다음 의미의 요청을 보낸다.

```text
row IDs:
[5,120,003, 42, 988,120, 5,119,999, ...]

columns:
[group_id, timestamp, intensity]
```

15개 전체 컬럼이 아니라 현재 필요한 3개 컬럼만 읽는다.

### 11.3 Parquet global row ID를 row group 위치로 변환함

Parquet 파일은 행이 row group 단위로 나뉜다. 각 row group의 누적 시작 행을 source index에 보관한다.

예를 들어 다음과 같이 구성되어 있다고 가정한다.

| Row group | 원본 row 범위 |
| ---: | ---: |
| 0 | 0 ~ 99,999 |
| 1 | 100,000 ~ 199,999 |
| 2 | 200,000 ~ 299,999 |
| ... | ... |
| 51 | 5,100,000 ~ 5,199,999 |

각 global source row ID는 row group과 local row로 변환된다.

```text
source row ID 42
→ row group 0
→ row group 내부 row 42

source row ID 988,120
→ row group 9
→ row group 내부 row 88,120

source row ID 5,120,003
→ row group 51
→ row group 내부 row 20,003
```

구현에서는 누적 row count index의 binary search 또는 순차 batch mapping으로 row group을 찾는다.

### 11.4 같은 row group에 속한 요청을 묶음

정렬 결과 순서대로 파일 위치를 왕복하면 비효율적이므로 물리적으로 읽을 때는 row group별로 묶는다.
원래 query 순서가 다음과 같더라도:

```text
결과 0 → source 5,120,003 → row group 51
결과 1 → source 42        → row group 0
결과 2 → source 988,120   → row group 9
결과 3 → source 5,119,999 → row group 51
```

물리 read plan은 다음처럼 만든다.

```text
row group 0
  source 42
  결과 위치 1

row group 9
  source 988,120
  결과 위치 2

row group 51
  source 5,119,999
  source 5,120,003
  결과 위치 3, 0
```

각 target에는 원래 output position을 함께 보관한다. 물리적으로 효율적인 순서로 읽은 뒤 query 정렬
순서로 되돌리기 위해 필요하다.

### 11.5 Parquet에서 필요한 행과 컬럼만 읽음

각 row group을 열 때 `ProjectionMask`로 요청 컬럼만 선택하고, `RowSelection`으로 target row 사이를
건너뛴다.

예를 들어 row group 51에서 필요한 local row가 다음 두 개라면:

```text
19,999
20,003
```

논리적으로 다음 selection을 구성한다.

```text
skip 19,999
select 1
skip 3
select 1
나머지 skip
```

Parquet 내부 압축 단위 때문에 주변 data page byte까지 읽을 수는 있다. 그러나 주변 row 전체를
`DataValue`로 만들거나 전체 컬럼을 JSON으로 전달하지 않고 요청 row와 projection만 결과로 만든다.

### 11.6 읽은 값을 원래 query 순서로 재배치함

물리 read 결과는 다음 순서일 수 있다.

```text
source 42
source 988,120
source 5,119,999
source 5,120,003
```

화면에 필요한 query 순서는 다음과 같다.

```text
source 5,120,003
source 42
source 988,120
source 5,119,999
```

미리 저장한 output position으로 결과 배열에 scatter한다.

```text
output[0] = source 5,120,003의 값
output[1] = source 42의 값
output[2] = source 988,120의 값
output[3] = source 5,119,999의 값
```

따라서 파일은 물리적으로 효율적인 순서로 읽으면서 최종 `DataPage.rows`는 정확한 filter/sort 결과
순서를 유지한다.

### 11.7 CSV는 checkpoint에서 묶어 읽음

CSV에는 Parquet row group, column projection과 `RowSelection`이 없다. 대신 기존 checkpoint index를
사용한다. checkpoint가 10,000행 간격이라면 다음과 같이 접근한다.

```text
source row 42
→ 파일 시작 checkpoint에서 parsing

source row 988,120
→ row 980,000 checkpoint로 seek
→ 8,120행 전진 parsing

source row 5,120,003
→ row 5,120,000 checkpoint로 seek
→ 3행 전진 parsing
```

같은 checkpoint 구간에 속한 target은 하나의 parser로 묶어 읽는다.

```text
필요한 행: 5,120,003 / 5,120,020 / 5,120,100

checkpoint 5,120,000에서 시작
→ 한 번의 parser 전진으로 세 행 모두 수집
```

그 후 Parquet과 마찬가지로 저장된 output position을 사용해 query 결과 순서로 재배치한다. CSV는
필요한 컬럼만 물리적으로 건너뛸 수는 없지만 요청하지 않은 값을 결과 DTO로 보관하거나 전달하지 않는다.

### 11.8 DuckDB에서 원본 값을 바로 join하지 않는 이유

다음처럼 DuckDB에서 값을 바로 조회할 수도 있다.

```sql
SELECT source.*
FROM query_result
JOIN source USING (source_row_id)
WHERE query_result.rowid BETWEEN 1000 AND 1199
ORDER BY query_result.rowid;
```

그러나 현재 성능 문제는 실행 계획에서 원본 전체와 query result를 join한 뒤 마지막에 200행을 제한할
수 있다는 점과 관련된다. 새 구조는 역할을 강제로 분리한다.

```text
DuckDB 역할
→ 어떤 행을 어떤 순서로 보여줄지 결정

Source reader 역할
→ 결정된 200개 행의 요청 컬럼만 정확하게 읽기
```

이 분리는 DuckDB optimizer가 `LIMIT 200`을 늦게 적용하는 문제를 피하고 기존 source reader의 다음
정밀도 계약을 유지하게 한다.

- int64/uint64 정밀도
- decimal
- nanosecond timestamp
- timezone metadata
- raw/display 구분
- binary/nested preview
- CSV invalid/null/empty 구분

### 11.9 가로 스크롤에서는 같은 row ID slice를 재사용함

같은 200행을 표시하면서 오른쪽 컬럼으로 이동하면 정렬 결과 row ID는 바뀌지 않는다.

```text
기존 요청
row IDs 200개 + columns [A, B, C]

가로 스크롤 후
같은 row IDs 200개 + columns [D, E, F]
```

가능하면 200개 identity slice를 query page identity cache에서 재사용하고 새 projection만 source에서
읽는다. 정렬이나 filter를 다시 실행하지 않는다.

### 11.10 고카디널리티 최악 조건

고카디널리티 정렬에서는 200개의 source row ID가 여러 row group에 넓게 흩어질 수 있다.

```text
200개 ID
→ 80개 row group에 분산
```

이 경우 한두 row group에 모인 page보다 느리지만 다음 상한과 최적화를 유지한다.

- 컬럼은 현재 필요한 것만 읽음
- 각 row group은 한 요청 안에서 한 번만 처리
- 필요한 row만 `DataValue`로 변환
- page 요청은 200개 identity로 제한
- cancellation 가능
- 인접 prefetch보다 visible foreground 우선
- 읽은 identity slice, page와 projection cache 가능

따라서 Phase 12에서는 low/high-cardinality fixture의 page 성능을 별도로 측정한다.

전체 과정을 요약하면 다음과 같다.

```text
DuckDB에서 정렬된 row ID 200개 확보
→ 원본 위치로 변환
→ 물리적으로 가까운 ID끼리 묶어서 읽기
→ 필요한 컬럼만 decode
→ 원래 query 정렬 순서로 재배치
→ 화면에 반환
```

row ID 200개는 단순한 번호 목록이 아니라 원본에서 최소한의 데이터만 정확하게 찾아오기 위한 조회
계획의 입력값이다.

## 결론

이 구조는 정렬 알고리즘만 가장 빠른 구조라기보다 다음을 함께 만족시키는 구조다.

- 여러 typed filter
- 여러 컬럼 안정 정렬
- 585만~1,000만 행
- 처음·중간·마지막 임의 페이지 조회
- Ctrl 및 PageUp/Down 이동
- 화면 순서와 동일한 부분·전체 복사
- bounded memory와 디스크 spill
- 진행률, 취소, stale query 차단
- 탭별 독립 상태

따라서 현재 뷰어의 목적에는 적합하고 확장성도 좋은 구조다. 실제 성능은 Phase 12에서 저·고카디널리티
fixture를 모두 사용해 정렬 시간, 첫 페이지, random page, Ctrl 이동, 복사, RSS와 임시 디스크 사용량을
각각 측정한 뒤 최종 판단한다.
