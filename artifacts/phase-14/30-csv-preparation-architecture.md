# Phase 14 CSV 단일 스캔·columnar cache 설계

## 1. 배경과 문제

5,850,000행×15컬럼 CSV를 준비하는 현재 구현은 같은 원본 파일을 두 경로에서 각각 전체 스캔한다.

1. `CsvSource`가 행 수와 4,096행 단위 checkpoint를 만들기 위한 index scan을 수행한다.
2. `QueryService`가 session 전용 `prepared.duckdb`를 만들기 위한 preparation scan을 수행한다.

두 작업이 동시에 실행될 수 있으며, preparation은 각 원본 컬럼을 다음 세 값으로 확장해 DuckDB
Appender에 한 행씩 삽입한다.

- 변환된 display 문자열
- 원본 raw 문자열
- invalid Boolean

따라서 15컬럼은 행 ID를 포함해 행당 46개 값이 되고, 5,850,000행에서는 약 2억 6천만 개 값을
행 단위로 처리한다. 5,850,000행 low-cardinality fixture의 측정 preparation 시간은 151.5초,
처리율은 약 38,614 rows/s였다.

Ctrl+화살표에도 두 가지 문제가 있다.

- preparation이 `Ready`가 되기 전에는 원본 CSV를 처음부터 다시 읽는 sequential fallback을 사용한다.
- preparation 완료 후에도 필터·정렬하지 않은 원본 CSV의 Ctrl+위/아래는 prepared DuckDB를
  200행씩 반복 조회한다. 585만 행에서 전환점이 없으면 최대 약 29,250번의 page 조회가 필요하다.

필터·정렬된 query 결과만 256→4,096→16,384→65,536 adaptive occupancy scan과 bitmap cache를
사용하고 있다. 이 최적화가 원본 CSV 경로에는 연결되지 않은 상태다.

## 2. 목표

원본 CSV를 한 번만 순차 파싱하고, 같은 파싱 결과로 다음 산출물을 함께 생성한다.

- 행 수와 임의 page 접근용 row checkpoint
- Ctrl+화살표용 컬럼 상태 bitmap
- 필터·정렬·기본 표시용 typed columnar cache
- 정확한 raw copy와 profile 재적용용 raw columnar cache
- 재실행 시 cache를 검증하고 재사용할 manifest

DuckDB는 유지하지만 CSV의 행 단위 적재 저장소가 아니라 typed Parquet에 필터·다중 정렬 query를
실행하는 엔진으로 제한한다. 기존 Arrow, Parquet, DuckDB 의존성을 사용하며 새로운 대형 runtime
dependency를 추가하지 않는다.

## 3. 전체 구조

```text
CSV 원본
   │ 한 번만 순차 파싱
   ▼
CsvPrepareCoordinator
   ├─ row offset checkpoints
   ├─ 컬럼별 2-bit state bitmap
   ├─ raw Arrow RecordBatch
   ├─ typed Arrow RecordBatch
   └─ invalid diagnostics
         │
         ▼
   임시 Parquet cache
         │
         ├─ 일반 page/default·raw copy
         └─ DuckDB filter/multi-sort
```

기존 `CsvSource` index worker와 `QueryService` CSV preparation worker를 session별
`CsvPrepareCoordinator` 하나로 통합한다. 다른 파일 탭이나 같은 session에서 중복 worker가 원본을
다시 읽지 못하게 preparation identity와 generation을 coordinator가 단일 소유한다.

## 4. 산출물

### 4.1 Row checkpoint index

4,096행마다 해당 CSV record 시작 byte offset을 저장한다.

```text
row 0       -> byte 0
row 4,096   -> byte 682,441
row 8,192   -> byte 1,365,992
...
```

5,850,000행이면 checkpoint가 약 1,429개이므로 메모리와 disk 사용량이 작다. 다음 용도로 사용한다.

- preparation 중 아직 columnar row group이 commit되지 않은 위치의 page 조회
- 특정 원본 행의 확인
- preparation 실패 시 bounded direct fallback

checkpoint가 있어도 Ctrl 탐색을 위해 원본 CSV를 반복 파싱하지 않는다. Ctrl 탐색은 state bitmap만
사용한다.

### 4.2 Cell-state bitmap

각 셀의 상태를 2비트로 기록한다.

```text
00 = valid
01 = null
10 = empty string
11 = invalid
```

빈 셀 판정 계약은 다음과 같다.

- `valid`, `invalid`: occupied
- `null`, `empty string`: empty
- 숫자 `0`, Boolean `false`, whitespace string: occupied

5,850,000행×15컬럼은 약 20.9MiB다. 컬럼 하나는 약 1.4MiB이므로 전체 컬럼의 문자열을 decode하지
않고도 빠르게 전환점을 찾을 수 있다. bitmap은 column-major로 저장하며 각 컬럼을 독립된 64-bit
word 경계에 맞춘다. 따라서 resident/state payload는 `columns × ceil(rows / 32) × 8` byte이고,
컬럼당 마지막 word의 padding만 추가된다. 이 정렬로 다른 컬럼을 건드리지 않고 한 컬럼의 32개 셀을
word 단위로 검사할 수 있다. 준비 중에는 완료된 word까지 읽기 전용 snapshot으로 공개한다.

### 4.3 Raw columnar cache

CSV의 실제 원본 문자열을 보존한다.

- raw copy의 byte/문자열 의미 보존
- invalid 값 원문 표시
- `001.00`과 `1`처럼 typed 값이 같아도 source lexeme가 다른 경우 보존
- CSV profile 변경 시 원본 1GB CSV를 다시 읽지 않고 raw cache에서 재변환

String 컬럼은 raw 값 자체를 값 컬럼으로 사용할 수 있다. 숫자, Boolean, Decimal, Timestamp,
Duration처럼 typed 값과 원래 표기가 다른 타입은 raw shadow column을 둔다.

### 4.4 Typed columnar cache

필터·정렬·기본 표시·기본 복사에는 실제 타입을 저장한다.

| CSV target | cache 타입 |
| --- | --- |
| Integer | Int64 또는 계약된 정수 타입 |
| Float | Float64 |
| Decimal | precision/scale을 보존한 Decimal |
| Boolean | Boolean |
| Timestamp | source unit/timezone metadata를 보존한 Timestamp |
| Duration | signed Int64 count와 unit metadata |
| String | Utf8 |

display 문자열은 cache에 저장하지 않는다. page나 default copy 결과를 만들 때 현재 display setting으로
format한다. 따라서 표시 형식 변경은 source cache, bitmap, filter/sort 의미를 무효화하지 않는다.

## 5. RecordBatch pipeline

CSV record를 DuckDB Appender에 한 행씩 넣지 않고 Arrow builder로 column batch를 생성한다.

- 기본 batch: 16,384행
- 최대 batch: 65,536행
- decoded batch 목표 상한: 64MiB
- writer queue: 최대 2 batch
- 진행 상태 갱신: 250ms 또는 65,536행 중 먼저 도달하는 시점
- 취소 확인: 최대 4,096행마다, 그리고 각 flush 전후

문자열 때문에 64MiB를 넘을 것으로 예상되면 batch 행 수를 줄인다. 완성된 `RecordBatch`는 Parquet
writer에 한 번에 전달한다.

권장 초기 Parquet 설정은 다음과 같다.

- row group: 최대 65,536행
- compression: ZSTD level 1 또는 3
- statistics: 활성화
- String dictionary: 표본 cardinality가 낮거나 중간일 때만 활성화

high-cardinality 문자열에서 dictionary가 손해가 되지 않도록 첫 batch 표본으로 정책을 결정하고
manifest에 기록한다.

## 6. 단일 preparation lifecycle

### 6.1 시작

1. 200행 preview를 먼저 반환한다.
2. source fingerprint와 profile hash로 preparation key를 만든다.
3. 같은 key의 active/ready coordinator가 있으면 재사용한다.
4. 없으면 session preparation worker 하나를 시작한다.

### 6.2 단일 scan

각 CSV record를 한 번 파싱하면서 동시에 다음을 수행한다.

1. row count와 byte progress 증가
2. 4,096행 checkpoint 기록
3. null/empty/invalid/valid state bitmap 기록
4. raw Arrow builder 추가
5. typed conversion과 typed Arrow builder 추가
6. invalid diagnostic의 bounded sample 기록
7. batch 상한 도달 시 raw/typed Parquet row group flush

### 6.3 commit

시작과 완료 시 source fingerprint를 각각 검사한다. 중간에 원본이 바뀌면 cache를 commit하지 않는다.

```text
raw.parquet.partial
typed.parquet.partial
states.bin.partial
offsets.idx.partial
manifest.json.partial
```

모든 writer flush와 Parquet footer 작성이 성공한 뒤 manifest를 마지막에 atomic rename한다. valid manifest가
없는 partial artifact는 재사용하지 않는다.

### 6.4 취소와 오류

- 취소 후 terminal 상태 목표: 1초 이하
- `.partial` artifact와 active lease 정리
- 이전 valid cache와 기존 clipboard 보존
- 원본 파일 및 원본 파일이 있는 디렉터리에 쓰기 금지
- source/profile/session generation이 다른 stale worker의 commit 금지

## 7. 준비 중 UX와 조회

준비가 끝나기 전 sequential Ctrl fallback은 금지한다. coordinator가 스캔 완료한 frontier와 bitmap
word를 즉시 공개한다.

예를 들어 3,021,312행까지 준비된 경우:

- frontier 안에서 끝나는 Ctrl 이동: bitmap으로 즉시 처리
- frontier 밖의 전환점이 필요한 이동: 같은 preparation worker의 진행을 기다림
- 대기 중 새 navigation: 이전 navigation 취소
- 원본을 처음부터 다시 스캔하는 별도 worker: 시작하지 않음

UI는 준비 범위와 navigation 대기를 구분한다.

```text
Preparing CSV for fast access
3,021,312 / 5,850,000 rows · 52%
Navigation is available within the prepared range.
```

frontier 이후 결과가 필요한 경우:

```text
Resolving boundary as CSV preparation advances...
```

필터·정렬은 부분 artifact로 실행하지 않는다. 불완전한 결과를 보여주지 않도록 `Ready`까지 요청을
queue하고 취소할 수 있게 한다. preparation과 별개로 DuckDB `read_csv`를 실행해 세 번째 전체 scan을
만들지 않는다.

## 8. 준비 완료 후 Ctrl 탐색

### 8.1 Ctrl+위/아래

필터·정렬하지 않은 CSV도 source state bitmap을 직접 검색한다. 현재의 고정 200행 page 반복을 제거한다.

```text
현재 행 state 확인
        │
        ▼
해당 컬럼 bitmap을 64-bit word 단위로 검색
        │
        ├─ 현재 occupied/empty run의 끝
        └─ 다음 occupied/empty 전환 위치
```

검색 후 목표 셀을 포함하는 page만 한 번 읽고 focus/selection을 이동한다. 중간 page를 순서대로 로드하지
않는다.

### 8.2 Ctrl+왼쪽/오른쪽

현재 논리 행에서 visible column들의 2-bit state만 읽는다. 15컬럼이라면 30비트만 검사하므로 DuckDB
page query가 필요 없다.

### 8.3 Ctrl+Alt+화살표

occupancy와 값을 읽지 않고 row/visible-column bounds만 사용한다.

- 위: 첫 행
- 아래: 마지막 행
- 왼쪽: 첫 visible column
- 오른쪽: 마지막 visible column

## 9. 필터·다중 정렬

DuckDB는 typed Parquet에 query를 실행한다.

```sql
CREATE VIEW dv_source AS
SELECT *
FROM read_parquet('typed.parquet');
```

필터가 row 집합을 만들고 ordered multi-sort가 순서를 정한다. stable tie-breaker는 source row ID다.
query result에는 기존과 같이 최종 logical order의 source row ID를 저장한다.

```text
query_result
┌─────────────┐
│ __dv_row_id │
├─────────────┤
│ 5,849,998   │
│ 1,200       │
│ 42          │
└─────────────┘
```

page 조회는 row ID를 Parquet row group별로 묶어 필요한 컬럼만 읽고, 결과를 다시 query logical order로
조립한다.

filtered/sorted Ctrl 탐색은 현재 adaptive 단계와 query logical occupancy cache를 유지한다.

1. query logical position에서 source row ID batch를 조회한다.
2. source state bitmap에서 해당 row ID들의 상태를 gather한다.
3. 256→4,096→16,384→65,536으로 확장한다.
4. query/session/generation/column별 bitmap cache에 commit한다.

## 10. Copy

### 10.1 Default copy

typed Parquet에서 읽고 현재 display 설정으로 format한다.

- 최대 64,000 cells/batch
- estimated 8MiB/batch
- progress, cancel, operation ID와 terminal reason 유지

### 10.2 Raw copy

raw Parquet에서 같은 row ID와 visible reordered column을 읽는다. 필터·정렬 결과에서는 query result의
logical order를 유지한다.

### 10.3 대용량 copy

5,850,000행×1컬럼은 64,000행 기준 약 92 batch로 streaming한다. 모든 batch가 성공하기 전에는 실제
clipboard를 교체하지 않는다. 실패·취소 시 이전 clipboard를 보존한다.

## 11. Session cache와 persistent cache

### 11.1 L1 session cache

- 현재 열린 tab/session이 소유
- active lease가 있는 동안 eviction 금지
- close/cancel/query 교체의 lifecycle을 기존 document/session identity와 연결

### 11.2 L2 persistent local cache

대용량 CSV를 닫았다 다시 열 때 전체 preparation을 반복하지 않도록 local cache 재사용을 지원한다.

cache key에는 다음을 포함한다.

- canonical source path
- file size
- modified time
- creation time 또는 file identity
- header/profile hash
- cache schema version
- 호환 가능한 application version

fingerprint가 같으면 원본 CSV scan 없이 manifest, Parquet footer와 bitmap header만 확인하고 `Ready`로
복구한다. profile만 바뀌면 raw Parquet를 재사용해 typed/state artifact만 다시 만든다.

cache는 원본 옆이 아닌 application cache/temp 경로에 저장한다. 기존 query temporary storage limit을
공통 disk budget으로 사용하고 inactive entry는 LRU로 제거한다. active lease와 valid cache를 partial
janitor가 삭제하지 못하게 한다.

무결성 검사는 보안 경계가 아니라 **재생성 가능한 derived cache의 비적대적 손상 감지 정책**이다.
정상 hit는 read-only artifact의 OS file identity·크기·수정/생성 시각이 manifest와 모두 같으면 구조만
검사하고, fingerprint가 달라지거나 주기적 scrub 시점이 되면 CRC64를 전수 확인한다. 파일 내용을 바꾼 뒤
identity와 모든 시각까지 원래대로 복원할 수 있는 공격자는 다음 scrub 전까지 fast path를 우회할 수 있으므로
적대적 tamper-proof 저장소로 간주하지 않는다. scrub은 새 lease 반환 전에 동기 실행하며, 의심 시 cache를
삭제해도 원본 CSV에서 안전하게 재생성된다.

## 12. 동시 실행과 foreground 우선순위

현재 최대 4개의 CSV preparation이 동시에 실행될 수 있어 여러 대용량 tab이 disk와 CPU를 경쟁할 수
있다. 기본 동시 preparation을 1개로 제한한다.

- active tab: 높은 우선순위
- background tab: queue
- foreground page/Ctrl/copy 요청: preparation writer가 batch 경계에서 양보
- SSD 환경의 동시 2개 허용은 benchmark로 이득이 입증될 때만 검토

UI thread와 query page worker는 preparation의 장기 mutex를 기다리지 않는다. coordinator status, bitmap
snapshot과 committed row group만 짧은 lock 또는 generation snapshot으로 읽는다.

## 13. 성능 완료 기준

현재 동일 장비 baseline은 low-cardinality 5,850,000행 준비 151.5초다. 최종 수치는 같은 fixture와 장비의
release 측정으로 판정한다.

### 13.1 Byte 계수의 정의

`source read bytes`는 preparation 과정에서 **원본 CSV 파일로부터 애플리케이션 reader가 읽은 byte
수**를 뜻한다. 다음 크기를 포함하지 않는다.

- Arrow decoded buffer와 typed column memory
- raw/typed Parquet output
- state bitmap과 checkpoint index
- process RSS
- 임시 파일 write bytes

CSV source가 짧은 숫자 문자열을 포함하면 typed memory가 원본보다 커질 수 있다. 예를 들어 CSV의
`1`은 1바이트지만 Float64 typed value는 8바이트이고 Arrow validity와 buffer 관리 비용도 추가된다.
따라서 decoded memory나 cache output에 source file 크기의 1.1배 상한을 적용하지 않는다.

원본 read를 다음 계수로 분리한다.

```text
preview_source_read_bytes
preparation_source_read_bytes
foreground_source_read_bytes
navigation_source_read_bytes
```

- `preview_source_read_bytes`: 최초 200행 preview가 원본에서 읽은 byte
- `preparation_source_read_bytes`: coordinator의 단일 background scan이 읽은 byte
- `foreground_source_read_bytes`: preparation 중 사용자가 요청한 bounded page/raw 조회가 읽은 byte
- `navigation_source_read_bytes`: Ctrl 탐색 때문에 원본에서 추가로 읽은 byte

`foreground_source_read_bytes`는 사용자의 실제 page/raw 요청에 따라 달라지므로 preparation 단일 scan
gate와 섞지 않는다. 같은 foreground 범위를 비의도적으로 반복 읽는지는 별도 cache hit/miss로
감사한다.

권장 gate는 다음과 같다.

```text
preparation_source_read_bytes
<= source_file_size + 1 MiB

preview_source_read_bytes + preparation_source_read_bytes
<= source_file_size × 1.01 + 8 MiB

Ready 이후 navigation_source_read_bytes = 0
```

첫 번째 gate는 background worker가 원본을 한 번만 읽는지 검증한다. 두 번째 gate는 preview가 원본
앞부분을 먼저 읽는 정상적인 중복만 허용한다. Ready 이후 Ctrl 이동은 state bitmap만 사용하므로 원본
CSV read가 하나라도 발생하면 실패다.

계수는 filesystem 전체 I/O 추정치가 아니라 원본 파일을 감싼 counting reader에서 측정한다. Parquet
cache read, OS page cache, output write와 다른 프로세스의 I/O가 source read 계수에 섞이지 않게 한다.

### 13.2 Decoded memory 계수

memory budget은 원본 문자열 길이 추정치가 아니라 Arrow array의 실제 buffer 크기로 판정한다.

```text
decoded_batch_bytes
peak_decoded_batch_bytes
writer_queue_bytes
process_peak_rss_bytes
```

고정폭 타입은 실제 physical width로 계산한다. Float64와 Int64는 값당 8바이트이며 validity bitmap,
String offset/data buffer, dictionary와 builder capacity를 모두 포함한다.

권장 hard gate는 다음과 같다.

- accepted decoded batch `<=64 MiB`
- writer queue 최대 2 batch이며 queue 전체 실제 bytes를 기록
- process peak RSS `<=1.5 GiB`
- 64MiB를 넘는 후보 batch는 writer에 전달하지 않고 작은 batch로 분할

### 13.3 Cache output 계수

cache disk 사용량은 다음 항목을 각각 기록한다.

```text
raw_parquet_bytes
typed_parquet_bytes
state_bitmap_bytes
checkpoint_index_bytes
manifest_bytes
total_cache_bytes
cache_to_source_ratio
```

raw와 typed 값을 함께 보존하면 정상적인 데이터에서도 cache가 원본 CSV보다 커질 수 있으므로
`total_cache_bytes <= source_file_size × 1.1` 같은 일괄 상한을 두지 않는다. 특히 짧은 숫자 문자열이
많으면 fixed-width typed buffer가 source text보다 커진다.

첫 RecordBatch 표본으로 다음 값을 포함한 최종 cache 예상치를 계산한다.

- raw string data와 offset
- 타입별 fixed/variable-width typed buffer
- validity/state bitmap
- 예상 Parquet compression ratio
- row group/footer metadata와 안전 여유

각 row group flush 뒤 실제 사용량으로 예측치를 갱신한다. 남은 application temporary storage budget을
넘을 것으로 예상되면 다음 batch를 쓰기 전에 typed error로 중단하고 partial artifact를 정리한다.
절대 hard cap은 source 비율이 아니라 사용자가 설정한 temporary storage limit이다.

low/high/long-invalid fixture에서 `cache_to_source_ratio`를 먼저 수집하고, fixture별 측정 근거 없이 임의의
공통 비율을 완료 gate로 확정하지 않는다. 예상치 오차, 실제 압축률과 cache 구성별 크기는 performance
artifact에 함께 기록한다.

| 항목 | 목표 |
| --- | ---: |
| Preview 표시 | 500ms 이하 |
| background preparation source read | 원본 크기+1MiB 이하 |
| preview+preparation source read | 원본 크기×1.01+8MiB 이하 |
| Ready 이후 Ctrl source read | 0 byte |
| 전체 preparation | 60초 이하이면서 기존 대비 2.5배 이상 개선 |
| 준비 후 임의 page p95 | 20ms 이하 |
| unfiltered Ctrl+위/아래 cold | 100ms 이하 |
| unfiltered Ctrl+위/아래 warm | 20ms 이하 |
| Ctrl+왼쪽/오른쪽 | 20ms 이하 |
| filtered/sorted Ctrl boundary cold | 250ms 이하 |
| filtered/sorted Ctrl boundary warm | 20ms 이하 |
| filter+3-sort 585만 행 | 목표 1초, hard gate 2초 |
| 64k×1열 copy p95 | 150ms 이하 |
| cancel terminal | 1초 이하 |
| accepted decoded batch | 실제 Arrow buffer 64MiB 이하 |
| peak RSS | 1.5GiB 이하 |
| cache disk | 설정된 temporary storage limit 이하, 구성별 실측 기록 |
| persistent cache hit 재오픈 | 원본 scan 0, 1초 이내 Ready |

60초는 허용 상한이고 실제 최적화 목표는 20~40초다. 절대값과 기존 대비 개선율을 함께 적용해 장비
차이와 측정 편차를 관리한다.

## 14. 구현 순서

### 14.1 즉시 체감 경로 수정

- unfiltered prepared CSV Ctrl 이동을 source bitmap/adaptive 경로로 연결
- 고정 200행 반복 제거
- Ctrl+왼쪽/오른쪽을 state 조회로 처리
- preparation 중 원본 sequential boundary fallback 금지

이 단계는 전체 preparation 구조 교체 전에 준비 완료 후 Ctrl 지연을 먼저 제거한다.

### 14.2 단일 scan pipeline

- `CsvSource` index worker와 prepared worker를 coordinator로 통합
- Arrow `RecordBatch` builder와 bounded writer queue
- raw/typed Parquet, state bitmap, checkpoint 동시 생성
- 행 단위 DuckDB Appender 제거

### 14.3 page/query/copy 전환

- source page와 default/raw copy를 columnar cache로 전환
- DuckDB가 typed Parquet를 query
- query logical row ID와 source bitmap 연결

### 14.4 Persistent cache

- fingerprint manifest와 cache schema version
- profile별 typed/state generation
- LRU, disk budget, active lease와 crash janitor

## 15. 테스트 계획 방향

low/high/long-invalid 5,850,000행 fixture에서 다음을 각각 preparation 전·중·완료 후·재오픈 후에 검증한다.

- preview와 진행 상태
- 원본 read byte 계수와 중복 scan 0
- 네 방향 Ctrl 및 Shift 조합
- Ctrl+Alt 네 방향
- 빈값이 없는 컬럼, null/empty/invalid 전환
- filter 후 Ctrl, multi-sort 후 Ctrl, filter+sort 순서
- source/filtered/sorted page 정확성
- 부분·전체, default/raw copy와 cancel
- profile 변경 시 raw cache 재사용
- tab close/reopen과 persistent cache hit
- 원본 truncate/replace/mtime/profile 변경의 stale cache 거부
- preparation cancel, disk-full, forced exit와 partial cleanup
- 4개 대용량 CSV tab의 queue와 active-tab foreground 우선순위
- RSS, temp/disk, handle, worker와 lease 복귀

기존 CSV/Parquet/H5 데이터 의미와 Timestamp/Duration precision, display/default/raw copy parity를 회귀
검증한다. 브라우저 mock 성능은 release/native 성능 PASS를 대신하지 않는다.

## 16. 결론

DuckDB 자체를 제거할 필요는 없다. 병목은 CSV를 두 번 스캔하고, 8,775만 셀을 display/raw/invalid로
확장해 행 단위로 DuckDB에 넣는 준비 방식이다.

원본을 한 번 파싱하면서 Arrow batch, raw/typed Parquet, state bitmap과 checkpoint를 동시에 만들고,
DuckDB는 typed Parquet의 필터·정렬에만 사용해야 한다. 이 구조는 초기 preparation 시간, 준비 중 UI
부하, unfiltered Ctrl의 200행 반복, raw copy와 탭 재오픈 비용을 하나의 cache lifecycle로 해결한다.
