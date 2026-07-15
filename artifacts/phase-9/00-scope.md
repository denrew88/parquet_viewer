# Phase 9 확정 범위: 입력 포맷 구조, 복사 형식, CSV 타입, 필터·정렬·검색

- 상태: 제품 범위 확정, 구현 미착수
- 작성일: 2026-07-15
- 구현 상태: 미착수
- 선행 조건: Phase 8의 다중 문서, 선택, clipboard, `DocumentRegistry` 계약

이 문서는 Phase 9의 제품 동작과 기술 범위를 고정한다. query engine 구현체는 9D spike에서
같은 fixture로 비교한 뒤 결정하며, 네이티브 runtime dependency 추가는 별도 승인 gate로 남긴다.
테스트, UX, 기술 계약과 구현 순서는 같은 디렉터리의 `10-test-plan.md`부터
`40-implementation-plan.md`까지를 따른다.

## 1. 목표

1. 선택 범위를 목적지에 맞는 구분자와 quoting 규칙으로 clipboard에 복사한다.
2. CSV를 열 때 sample 기반 추천과 사용자 override로 컬럼 타입을 결정한다.
3. 전체 파일 또는 현재 query 결과를 대상으로 컬럼 필터, 정렬, 검색을 제공한다.
4. 1,000만 행 파일에서도 전체 materialize와 무제한 메모리 사용 없이 동작한다.
5. 각 문서의 parsing profile과 query state를 다른 문서와 격리한다.
6. 이후 tabular 입력 포맷을 추가할 때 문서·query·grid 핵심 코드를 반복 수정하지 않는 source
   확장 구조를 만든다.

## 2. Clipboard 복사 형식

### 2.1 확정 UX

설정 항목을 매번 직접 조합하게 하지 않고 preset을 먼저 제공한다.

| Preset | 구분자 | 줄바꿈 | 기본 용도 |
| --- | --- | --- | --- |
| Excel | Tab | CRLF | Excel, Google Sheets 붙여넣기 |
| TSV | Tab | CRLF | 일반 TSV 소비자 |
| CSV | Comma | CRLF | CSV parser와 텍스트 도구 |
| Custom | 사용자 지정 | CRLF 또는 LF | DB 도구, script, 특수 형식 |

- 기본 preset은 기존 동작과 호환되는 `Excel`로 한다.
- toolbar의 작은 설정 button 또는 Copy split menu에서 preset을 선택한다.
- `Ctrl+C`는 현재 선택된 preset을 사용한다.
- 컨텍스트 메뉴의 Copy도 같은 serializer와 preset을 사용한다.
- 현재 설정과 결과 일부를 보여주는 preview를 제공한다.
- 설정은 앱 전역 기본값으로 기억하되 복사 중인 문서 상태와 충돌하지 않게 한다.

### 2.2 Custom 설정

- delimiter: Tab, comma, semicolon, pipe, custom 한 문자
- header: 포함하지 않음, 컬럼명 포함
- quote mode: 필요한 값만, 항상, 사용하지 않음
- quote character: 기본 `"`, custom 한 문자
- escape: quote 두 번 쓰기, backslash
- line ending: CRLF, LF
- null representation: 빈 필드, `NULL`, `\N`, custom 문자열
- empty string representation: 빈 필드 또는 명시적 quoted empty string
- boolean representation: `true/false`, `TRUE/FALSE`, `1/0`
- date/timestamp: 현재 표시값, ISO 8601, custom format

### 2.3 제약과 권장 기본값

- clipboard는 Windows Unicode text를 사용하므로 encoding 설정을 노출하지 않는다.
- delimiter와 quote character는 한 문자만 허용한다.
- custom delimiter가 값에 포함되면 quote 또는 escape가 필요하다.
- `quote mode: 사용하지 않음`에서 구조를 보존할 수 없는 값이 있으면 경고하거나 실행을
  거부한다. 조용히 손상된 결과를 만들지 않는다.
- null과 빈 문자열은 내부적으로 계속 구별한다. 같은 출력 표현을 선택한 경우 preview에서
  구별이 사라진다는 점을 보여준다.
- 정밀도 보존을 위해 Int64, UInt64, Decimal, Timestamp는 문자열 display 값을 사용한다.
- Phase 9에서는 clipboard만 다룬다. 파일 export는 별도 Phase로 둔다.

## 3. CSV 컬럼 타입 profile

### 3.1 의미

이 기능에서 `import`는 CSV를 다른 저장소로 쓰거나 변환한다는 뜻이 아니다. 읽기 전용
viewer가 CSV 값을 어떤 논리 타입으로 해석할지 정하는 parsing profile이다. 원본 파일은
변경하지 않는다.

### 3.2 지원 타입

| 타입 | 주요 용도 | 추가 설정 |
| --- | --- | --- |
| Auto | sample 기반 추천 | sample 크기 |
| Text | ID, 코드, 앞자리 0 보존 | trim 여부 |
| Boolean | true/false 계열 | true/false token 목록 |
| Int64 | signed 정수 | 천 단위 구분자 |
| UInt64 | 음수가 없는 큰 정수 | 천 단위 구분자 |
| Float64 | 일반 실수 | decimal separator |
| Decimal | 금액과 고정 정밀도 | precision, scale, 반올림 정책 |
| Date | 날짜 | 입력 format 목록 |
| Timestamp | 날짜와 시간 | 입력 format, timezone |
| Skip | viewer에서 제외 | 없음 |

`Auto`는 추천일 뿐 최종 타입을 보장하지 않는다. 숫자로 보이는 우편번호, 사번, 제품 코드,
긴 계정 ID는 사용자가 `Text`로 고정할 수 있어야 한다.

### 3.3 Parsing profile 설정

- 컬럼 이름과 sample 값
- 추천 타입과 confidence
- 사용자 선택 타입
- trim leading/trailing whitespace
- null token 목록: 빈 값, `NULL`, `N/A`, custom
- 숫자 decimal separator와 thousand separator
- date/timestamp 입력 format 우선순위
- timezone이 없는 timestamp의 해석 기준
- 변환 실패 정책: invalid 원문 보존, 전체 실패, null로 대체
- 실패 개수와 대표 row/value 목록

### 3.4 기본 열기 정책과 사후 변경

사용자가 CSV를 열 때마다 profile 화면을 반드시 거치게 하지 않는다. `Settings > CSV > Default
parsing mode`에 다음 전역 기본값을 제공한다.

| 모드 | 동작 |
| --- | --- |
| Auto로 바로 열기 | 제한된 sample로 타입을 추론하고 문서를 바로 연다. 권장 기본값이다. |
| 모든 컬럼을 Text로 열기 | CSV 구조는 정상적으로 parsing하되 모든 cell 값을 문자열로 유지한다. |
| 열 때마다 확인 | 문서를 열기 전에 CSV Parsing Profile 화면을 표시한다. |

- Text 모드도 delimiter, quote, escape, header와 row 구조는 parsing한다. 값의 논리 타입만 Text로
  고정한다.
- 기본 열기 모드는 사용자 설정에 영구 저장하며 새로 여는 CSV에 적용한다. 이미 열린 문서의
  profile을 소급해서 변경하지 않는다.
- 첫 구현은 전역 기본값만 제공한다. 파일별 기본 profile 기억은 안정적인 file identity 계약이
  정해진 뒤 검토한다.
- 열린 CSV에는 현재 profile 상태를 `Auto`, `All Text`, `Custom`으로 표시한다.
- toolbar 또는 문서 menu의 `CSV Parsing Profile` 명령으로 열린 뒤에도 profile을 변경할 수 있다.
- 사후 변경 화면은 현재 profile을 초기값으로 사용하며 다중 컬럼 설정, sample 미리보기와 전체
  파일 검증을 동일하게 제공한다.
- `적용`은 새 `sessionId`로 CSV를 다시 해석하고 page cache와 이전 query result를 무효화한다.
- 기존 filter, sort, search는 새 타입에 대해 다시 검증한다. 호환되는 조건은 다시 실행하고,
  호환되지 않는 조건은 조용히 다른 의미로 실행하지 않고 비활성화한 뒤 이유를 표시한다.
- schema의 컬럼 순서가 유지되는 경우 현재 scroll 위치와 cell 선택을 가능한 범위에서 복원한다.
- `취소`는 현재 문서와 query 상태를 그대로 유지한다. 모든 경우 원본 CSV는 변경하지 않는다.

### 3.5 다중 컬럼 선택과 일괄 설정

CSV profile 화면은 컬럼별 card 목록이 아니라 설정 전용 grid로 제공한다. 각 row에는 컬럼 이름,
sample 값, 추천 타입과 confidence, 현재 타입, 변환 상태를 표시한다.

- click은 단일 컬럼을 선택한다.
- `Ctrl+click`은 개별 컬럼을 선택에 추가하거나 제거한다.
- `Shift+click`은 anchor부터 현재 컬럼까지 연속 범위를 선택한다.
- grid에 focus가 있을 때 `Ctrl+A`는 현재 검색·필터 결과에 표시된 컬럼 전체를 선택한다.
- 컬럼 이름, 추천 타입, 현재 타입, 변환 오류 여부로 설정 grid를 검색·필터할 수 있다.
- header checkbox 또는 `표시된 컬럼 모두 선택`으로 필터 결과를 한 번에 선택할 수 있다.
- 선택한 컬럼에는 타입, null token, 숫자·날짜 형식, 변환 실패 정책을 일괄 적용할 수 있다.
- 일괄 설정은 사용자가 명시적으로 변경한 항목만 덮어쓴다. 타입만 변경했으면 기존 null token이나
  date format을 임의로 변경하지 않는다.
- 선택한 컬럼의 설정이 서로 다르면 control에는 단일 값 대신 `혼합됨` 상태를 표시한다.
- `추천 타입으로 초기화`, 직전 일괄 변경 실행 취소, 한 컬럼의 설정을 선택 컬럼에 복사하는 명령을
  제공한다.
- 컬럼 선택은 sample data grid의 셀 선택과 별도의 상태로 관리한다.

첫 구현의 필수 범위는 다중 선택, 검색·필터 후 전체 선택, 일괄 설정, 실행 취소까지다. 정규식 기반
컬럼 선택과 profile preset 영구 저장은 첫 구현의 필수 범위에서 제외한다.

### 3.6 설정 미리보기와 전체 파일 검증

profile 화면 하단에는 적용 전 결과를 확인할 수 있는 sample data grid를 제공한다. profile 편집은
미리보기 상태만 변경하며, 사용자가 `적용`을 실행하기 전에는 현재 문서 session과 원본 파일을
변경하지 않는다.

**빠른 sample 미리보기**

- 원본 값과 변환 결과를 전환해 확인할 수 있다.
- 컬럼 header에는 `추천 타입 -> 설정 타입`과 sample 변환 성공·실패 건수를 표시한다.
- 변환 실패 cell, null로 해석된 cell, 일괄 설정으로 변경된 컬럼을 서로 구별해 표시한다.
- date, timestamp, number format을 적용한 최종 display 값을 보여준다.
- 미리보기는 전체 파일을 다시 읽지 않고 최대 1,000행의 제한된 sample을 사용한다. 최초에는
  파일 앞부분을 사용하고 checkpoint/index가 준비되면 분산 sample을 보충해 같은 generation 규칙으로
  갱신한다.
- 설정 변경은 약 200ms debounce 후 background에서 다시 계산한다.
- 각 미리보기 요청에는 generation ID를 부여한다. 새 요청이 시작되면 이전 작업을 취소하고 늦게
  도착한 결과는 폐기해 최신 설정을 덮어쓰지 못하게 한다.

**전체 파일 검증**

- `전체 파일 검증`은 명시적인 별도 명령이며 모든 행을 현재 profile로 읽어 변환 가능 여부를 검사한다.
- 진행률과 취소를 제공하고 UI thread를 차단하지 않는다.
- 컬럼별 성공·실패 건수, 최초 오류 row, 제한된 대표 원본 값을 제공한다.
- 검증은 원본 파일, 현재 문서 session, filter·sort·search 상태를 변경하지 않는다.
- 검증을 실행하지 않았거나 경고가 남아 있어도 사용자가 이를 확인한 뒤 적용할 수 있다. 단, 구조를
  읽을 수 없는 parser 오류처럼 문서를 열 수 없는 오류는 적용을 막는다.
- 기본 변환 실패 정책은 `invalid 원문 보존`이다. 실패한 값은 원문 display와 오류 정보를 유지하고
  typed 비교에는 일치하지 않으며 null과 구분한다. 사용자가 명시적으로 선택한 경우에만 null로
  대체하거나 profile 적용 전체를 실패시킨다.

`취소`는 profile 편집과 임시 미리보기 결과를 폐기하고 기존 문서 상태로 돌아간다. `적용`은 새
`sessionId`로 CSV 문서를 다시 열며, 적용 시점의 profile을 이후 query의 typed schema로 사용한다.

### 3.7 실행 모델

1. 파일 open 시 제한된 sample만 읽어 추천 타입을 계산한다.
2. 기본 상태에서는 추천 결과를 preview에 적용하되 원본 text도 보존한다.
3. 사용자가 profile을 확정하면 background scan을 시작한다.
4. profile 변경은 새 `sessionId`를 만들고 page cache, filter, sort, search result를 무효화한다.
5. 긴 scan에는 progress와 cancel을 제공한다.
6. 변환 오류는 문서별 상태로 격리하고 대표 오류를 확인할 수 있게 한다.

### 3.8 Profile 저장 범위

첫 구현은 문서 session 동안만 profile을 유지하는 것이 안전하다. 파일별 profile 영구 저장은
path만 기준으로 하면 파일 교체를 잘못 인식할 수 있으므로 이후 다음 identity를 검토한다.

- canonical path
- file size
- modified time
- header와 일부 sample hash

## 4. 필터, 정렬, 검색

### 4.1 공통 의미

- 현재 page 200행만 대상으로 동작하지 않는다.
- 항상 전체 파일 또는 현재 filter 결과 전체를 대상으로 한다.
- query 적용 후 표시되는 row offset은 원본 offset과 분리한다.
- query 결과에는 stable row identity 또는 원본 row 위치를 유지한다.
- query state는 문서별로 보존한다.
- query 변경은 진행 중인 이전 query를 취소하고 늦은 결과를 폐기한다.

### 4.2 컬럼 필터

타입에 따라 연산자를 제한한다.

| 타입 | 연산자 |
| --- | --- |
| Text | equals, not equals, contains, starts with, ends with |
| Number/Decimal | equals, not equals, greater/less, between |
| Date/Timestamp | before, after, on, between |
| Boolean | true, false |
| 공통 | is null, is not null, is invalid, is not invalid |

- 여러 컬럼의 filter는 기본적으로 AND로 결합한다.
- 한 컬럼 안의 여러 값 선택은 OR로 결합한다.
- 활성 filter는 컬럼 header와 상단 query bar에서 확인하고 개별 또는 전체 해제할 수 있다.
- distinct value 목록은 전체 값을 한 번에 materialize하지 않고 검색·페이지 방식으로 제공한다.

### 4.3 정렬

- 컬럼 header 또는 menu에서 ascending, descending, clear를 제공한다.
- `Shift`를 사용해 기존 sort를 유지하면서 multi-column sort를 추가한다.
- sort 우선순위를 UI에 숫자로 표시한다.
- null은 오름차순과 내림차순 모두 마지막에 둔다. first/last 사용자 option은 첫 구현에 넣지 않는다.
- 같은 값의 순서는 원본 row identity를 최종 tie-breaker로 사용해 안정적으로 유지한다.
- 현재 page만 정렬하는 기능은 제공하지 않는다.

1,000만 행 전체 정렬은 in-memory sort로 구현하지 않는다. memory budget을 넘으면 disk spill
또는 embedded query engine의 external sort가 필요하다. 진행 상태, 취소, 임시 파일 정리,
disk 부족 오류가 제품 계약에 포함되어야 한다.

### 4.4 검색

두 종류를 구분한다.

1. 컬럼 검색: 지정한 컬럼의 typed value를 검색한다.
2. 전체 검색: 검색 가능한 모든 표시 컬럼에서 text match를 수행한다.

- 기본 text 검색은 case-insensitive contains로 한다.
- exact와 case-sensitive option은 제공하고 regex는 첫 구현에서 제외한다.
- 입력은 debounce하고 이전 scan을 취소한다.
- 결과 수가 계산 중인지 완료됐는지 구분한다.
- `다음 결과`만 이동하는 find 기능과 `일치 행만 보기` filter 기능을 UI에서 구분한다.
- binary와 복잡한 nested value는 첫 구현의 전체 검색에서 제외한다.

## 5. 대용량 실행 구조

Phase 9부터는 page source 위에 query result 계층이 필요하다.

```text
FormatRegistry
  -> TabularSource
  -> optional format transform (CSV parsing profile 등)
  -> QueryPlan(filters, search, sort, projection)
  -> QueryResult(documentId, sessionId, queryId)
  -> paged grid
```

- `documentId`: 탭 수명
- `sessionId`: 원본 source 또는 CSV parsing generation
- `queryId`: filter/sort/search generation
- 모든 page 응답은 세 ID를 검증해 stale query 결과가 현재 grid를 덮지 못하게 한다.
- query result와 temporary spill file은 문서 close, session 교체, query 취소 시 정리한다.
- memory, worker, spill disk에 프로세스 단위 상한을 둔다.

### 5.1 형식별 특성

**Parquet**

- 필요한 컬럼만 projection한다.
- 가능한 filter는 row-group statistics로 건너뛴다.
- 조건을 만족하는 원본 row 위치 또는 result index를 page 단위로 만든다.

**CSV**

- filter/search는 일반적으로 전체 scan이 필요하다.
- parsing profile을 먼저 적용한 typed value를 대상으로 query한다.
- 반복 query를 위해 result index 또는 임시 columnar cache가 필요할 수 있다.
- scan은 background worker, progress, cancel을 사용한다.

### 5.2 입력 포맷 확장 구조

현재 `DataSource::Csv | Parquet`, frontend의 `"csv" | "parquet"`, 파일 dialog와 drag-and-drop
확장자 검사가 여러 위치에 고정되어 있다. Phase 9에서는 query 계층을 연결하기 전에 이를
compile-time format registry와 공통 tabular source 계약으로 정리한다. 사용자가 별도 binary를
설치하는 runtime plugin system은 만들지 않는다.

**공통 계약**

구현 세부는 Rust 설계 단계에서 확정하되 다음 책임을 분리한다.

```text
FormatDescriptor
  - id, display name, extensions, MIME types
  - capabilities

FormatHandler
  - path/extension candidate 판별
  - signature 또는 구조 검증
  - TabularSource open

TabularSource
  - summary/schema
  - projected page read
  - progress/cancel lifecycle
  - optional query provider
```

- `FormatRegistry`를 runtime에서 지원 포맷을 판별하는 단일 기준으로 사용한다.
- `DocumentRegistry`, paging, query, grid와 selection은 구체적인 포맷 variant를 알지 않는다.
- source 구현은 필요할 때 Arrow schema와 batch 또는 query engine이 소비할 수 있는 provider를
  제공한다. 전체 파일 materialize를 공통 계약으로 요구하지 않는다.
- 확장자만 신뢰하지 않는다. 가능한 포맷은 magic/signature를 검사하고 CSV처럼 magic이 없는
  포맷은 parser의 구조 검증 결과로 오류를 구분한다.
- format별 command를 공통 source match에 계속 추가하지 않는다. CSV profile 같은 전용 동작은
  capability와 전용 service 경계를 통해 노출한다.

**Capability 계약**

- `typedSchema`
- `columnProjection`
- `filterPushdown`
- `rowGroups`
- `parsingProfile`
- `backgroundRowCount`
- `multipleDatasets`
- `queryProvider`

UI는 capability가 있을 때만 해당 명령과 metadata section을 표시한다. CSV와 Parquet의 두 경우만
가정한 삼항 연산을 사용하지 않는다. 공통 metadata는 file, row, column, schema 정보로 유지하고,
포맷별 metadata는 keyed section 또는 tagged details와 renderer registry로 분리한다. 전용 renderer가
없는 새 포맷도 공통 metadata와 data grid는 바로 사용할 수 있어야 한다.

**지원 포맷 목록과 파일 연결**

- native file dialog, drag-and-drop 안내, backend open 검증은 registry descriptor에서 같은 확장자
  목록과 표시 이름을 사용한다.
- frontend는 backend가 제공한 descriptor를 사용하거나 build 시 생성된 동일 manifest를 사용한다.
- Windows file association은 Tauri bundle의 정적 설정이므로 새 포맷을 기본 연결하려면 여전히
  `tauri.conf.json` 변경과 installer 재빌드가 필요하다. 이는 reader 확장과 별도 단계로 둔다.

**포맷 적합성 테스트**

모든 handler에 같은 contract test suite를 적용한다.

- 지원 확장자와 대소문자, 손상 파일, 확장자와 실제 signature 불일치
- schema, null, 정밀도 보존, 빈 파일과 wide schema
- 첫 page, 중간·마지막 page, 범위 밖 offset, projection
- 진행 작업 cancel과 source drop 후 worker/file handle 정리
- 여러 문서 격리, stale session/result 폐기
- 전용 metadata renderer가 없을 때 generic UI fallback

첫 리팩터링의 완료 기준은 예제 tabular handler를 하나 추가할 때 `DocumentRegistry`, query 실행기,
grid와 selection 핵심 코드를 수정하지 않는 것이다. 새 포맷의 reader, registry 등록, 선택적인 metadata
renderer, contract fixture와 정적 file association만 추가하는 구조를 목표로 한다. HDF5나 Excel처럼
한 파일에 여러 dataset/sheet가 있는 포맷의 실제 지원은 이번 Phase 범위 밖이지만,
`multipleDatasets` capability로 이후 선택 화면을 추가할 수 있어야 한다.

## 6. Query engine 선택지

이 요구사항은 `PROJECT_SPEC.md`에서 query engine 검토를 허용하는 구체적인 전체 파일
filter/sort/search 요구에 해당한다. 다만 dependency 추가는 사용자 승인 후에만 진행한다.

| 선택지 | 장점 | 단점 |
| --- | --- | --- |
| 현재 Arrow/Parquet/CSV 위에 직접 구현 | dependency와 binary 증가가 작음, 세밀한 제어 | expression, typed filter, external sort, spill, CSV scan index를 모두 직접 구현 |
| DataFusion | Rust/Arrow와 자연스럽고 typed expression/query plan 재사용 가능 | compile/binary 증가, integration과 spill 정책 검증 필요 |
| DuckDB embedded | Parquet/CSV query와 정렬 기능이 성숙하고 빠른 구현 가능 | native binary/packaging, Arrow 변환, temp DB 수명주기 검증 필요 |

### Engine 선택 절차

- source 확장 구조를 먼저 리팩터링하고 CSV profile과 query provider를 그 공통 계약 위에 구현한다.
- 복사 설정은 query engine과 독립적으로 기존 selection serializer 위에 구현한다.
- filter/search/sort는 작은 자체 expression layer를 새로 만들기 전에 DataFusion과 DuckDB를
  같은 fixture로 spike 측정한다.
- 비교 항목은 1,000만 행 저·고카디널리티 Parquet, 대용량 CSV, first result latency,
  random page, multi-column sort, peak memory, spill 크기, cancel latency, release binary 크기다.
- spike 결과를 기록하고 한 엔진을 선택하거나 직접 구현 범위를 축소한다.

## 7. 확정 구현 순서

### 9A. 입력 포맷 source 리팩터링

- `FormatDescriptor`, `FormatRegistry`, `TabularSource`, capability 계약 확정
- CSV와 Parquet handler 이전, 공통 summary/page 계약 유지
- runtime 지원 포맷 목록을 file dialog, drag-and-drop과 frontend에 연결
- generic metadata fallback과 format별 renderer 경계 분리
- 공통 format contract test suite와 예제 handler로 확장성 검증

### 9B. 복사 preset과 serializer 설정

- preset과 custom schema 확정
- 기존 TSV serializer를 delimiter-aware serializer로 일반화
- preview, 설정 저장, Ctrl+C/context menu 통합

### 9C. CSV parsing profile

- 전역 기본 열기 모드와 열린 문서의 사후 profile 변경
- sample inference와 per-column override
- 설정 grid의 다중 선택, 검색·필터 후 전체 선택, 일괄 설정과 실행 취소
- 원본/변환 결과 sample 미리보기와 stale preview 취소
- 전체 파일 검증, 진행률, 취소, 컬럼별 오류 요약
- typed conversion, 오류 정책, progress/cancel
- session 교체와 cache/query 무효화

### 9D. Query engine spike와 공통 계약

- DataFusion, DuckDB, 직접 구현 후보 비교
- `QueryPlan`, `queryId`, typed expression, result page DTO 확정
- memory/worker/spill 상한 확정

### 9E. 필터와 검색

- 타입별 column filter
- column/global search
- progress, cancel, result count, document state 보존

### 9F. 전체 정렬과 통합 검증

- single/multi-column stable sort
- spill와 disk 부족 처리
- filter + search + sort 조합
- 1,000만 행 성능, memory, cancel, multi-document 격리 검증

## 8. 이번 Phase 제외 범위

- 원본 파일 수정과 CSV 재저장
- 일반 파일 export
- SQL editor
- group by, aggregation, pivot
- join
- chart
- fuzzy search
- filter preset 영구 공유와 cloud sync
- nested Parquet value 전용 query language
- 제3자가 binary를 배포하는 runtime reader plugin system
- HDF5 dataset 또는 Excel sheet 선택 UI와 해당 포맷의 실제 reader

## 9. 확정된 제품 기본값

1. 복사 preset 기본값은 기존 동작과 호환되는 `Excel`이다.
2. custom delimiter와 quote character는 각각 Unicode 문자 하나만 허용하고 CR/LF는 거부한다.
3. Excel/TSV preset은 null과 empty string을 빈 cell로 출력하고 preview에서 구별 손실을 알린다.
   CSV/Custom 기본은 null을 unquoted `NULL`, empty string을 `""`, 실제 문자열 `NULL`을 quoted
   `"NULL"`로 출력한다.
4. CSV 변환 실패 기본값은 원문을 보존하는 `invalid`이며 null과 구분한다.
5. CSV 기본 열기 모드의 초기값은 `Auto로 바로 열기`다.
6. CSV profile은 첫 구현에서 document session에만 유지한다. 전역에는 기본 열기 모드만 저장한다.
7. 전체 검색은 현재 표시 중인 scalar 컬럼 전체를 기본 대상으로 하며 사용자가 컬럼을 제한할 수 있다.
8. regex filter/search는 첫 구현에서 제외한다.
9. multi-column stable sort를 첫 구현에 포함한다.
10. null은 오름차순과 내림차순 모두 기본적으로 마지막에 둔다.
11. query engine은 9D spike 결과로 선택한다. 신규 native/runtime dependency 추가는 구현 전 승인한다.

## 10. 개발 문서

- `10-test-plan.md`: 추적 가능한 자동, performance, UI, native 테스트
- `20-ux-design.md`: copy settings, CSV profile dialog, column menu, query bar
- `30-query-engine-design.md`: source registry, engine adapter, query/session/result/spill 계약
- `40-implementation-plan.md`: 9A~9F 담당과 순서
