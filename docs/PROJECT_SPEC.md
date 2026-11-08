# 프로젝트 상세 명세

이 문서는 CSV, Parquet와 Phase 11의 OEF H5 v3 확장, Phase 12의 대용량 query·복사와 grid 작업 흐름 안정화를
포함한 데스크톱 뷰어의 상세 제품 요구사항과 기술 계약을 정의한다.
구현 순서와 단계별 완료 조건은 `docs/DEVELOPMENT_PLAN.md`를 따른다.

2026-11-04 후속 경량화와 Storage 안정화는 [Phase 20](../artifacts/phase-20/README.md)으로 통합 관리한다.
기존 검증본은 Rust csv와 polars-arrow/polars-parquet 하위 crate를 사용하고 DuckDB query 엔진을 유지한다.
이 등록은 제품 동작을 새로 바꾸거나 원래 full-Polars manifest를 교체하는 작업이 아니다.
사용자 승인으로 재빌드한 EXE는 src-tauri/target/release/data-viewer.exe이며 Phase 대응·Windows 속성·실제 앱 버전은 모두 0.20.0이다.
Phase 20 전용 입력은 fixtures/phase-20/에 모으고, 이전 Phase 공용 입력의 소유 경로는 유지한다.

## 1. 제품 목표

테이블 형태의 로컬 데이터 파일을 빠르고 안전하게 살펴볼 수 있는 읽기 전용 데스크톱
뷰어를 만든다. 사용자는 파일 전체를 메모리에 올리지 않고도 데이터, 스키마, 메타데이터를
탐색하고, Excel과 유사한 방식으로 셀을 선택해 다른 스프레드시트에 붙여넣을 수 있어야
한다.

첫 번째 릴리스는 CSV와 Parquet를 지원한다. 형식별 읽기 방식과 메타데이터 차이는 각
데이터 소스 내부에서 처리하고, 그리드와 사용자 상호작용은 공통 모델을 사용한다.

## 2. MVP 범위

MVP는 다음 기능을 포함한다.

- 네이티브 파일 대화상자에서 CSV와 Parquet 파일 열기
- 앱 창으로 파일을 드래그 앤 드롭해서 열기
- 운영체제 파일 연결 또는 시작 인자로 전달된 경로 열기
- 한 창에서 CSV·Parquet 파일을 문서 탭으로 열기
- 애플리케이션을 독립 프로세스로 여러 개 동시 실행
- Data, Schema, Metadata 화면
- 파일 전체를 메모리에 올리지 않는 페이지 단위 탐색
- 가상화된 행과 컬럼
- 컬럼 크기 조절, 숨기기, 선택, 이름 검색
- 마우스와 키보드를 이용한 Excel 방식의 셀 및 범위 선택
- 선택 범위를 복사해 Excel 등의 스프레드시트에 붙여넣기
- 셀 컨텍스트 메뉴에서 선택 범위와 셀 대상 액션 실행
- 명확한 로딩, 진행, 빈 데이터, 취소, 오류 상태

MVP에는 데이터 편집, 셀 값 붙여넣기를 통한 데이터 변경, 원격 스토리지, SQL, 데이터
내보내기, HDF5 지원을 포함하지 않는다. Phase 11의 OEF H5 v3는 MVP 완료 뒤 추가되는 제한된
읽기 전용 확장이며 범용 HDF5 지원을 뜻하지 않는다.

## 3. 파일 열기

다음 진입점을 지원한다.

- 툴바의 열기 버튼으로 실행하는 네이티브 파일 대화상자
- 앱 창의 drop target에 놓은 파일
- 운영체제의 연결 프로그램 또는 파일 더블클릭
- 애플리케이션 시작 인자로 전달된 파일 경로

모든 진입점은 같은 경로 정규화, 형식 판별, 검증, 세션 생성 절차를 사용한다. 열기 방식에
따라 지원 형식이나 오류 처리가 달라져서는 안 된다.

한 창은 최대 64개의 파일을 문서 탭으로 유지하며 한 탭만 활성화한다. 8개 동시 문서는
일반 사용 성능 검증 기준이고 제품 최대치가 아니다. 파일 대화상자, drag and drop, 시작
인자는 한 요청에 최대 32개 경로를 받을 수 있고 입력 순서대로 처리한다.
성공한 파일은 탭으로 유지하며 실패한 파일은 항목별 오류로 표시한다. 입력 순서상 첫 성공
또는 기존 탭 재사용 항목을 활성화하고, 전부 실패하면 현재 활성 탭을 유지한다.

같은 프로세스에서 같은 canonical path를 다시 열면 중복 세션을 만들지 않고 기존 문서 탭을
활성화한다. 열린 문서가 64개이면 기존 탭을 자동으로 닫지 않고 65번째 파일만 제한 오류로
거부한다. 이 상한은 accidental mass drop에 대한 방어선이며 성능 목표를 뜻하지 않는다.
서로 다른 프로세스에서는 같은 파일을 각각 독립적인 읽기 전용 세션으로 열 수 있다.

애플리케이션은 single-instance로 제한하지 않는다. executable, 바로가기, 시작 메뉴, 파일
연결로 시작한 각 invocation은 새 프로세스와 창을 만든다. 한 invocation에 여러 시작 경로가
전달되면 그 새 창의 문서 탭으로 연다. 프로세스 사이에는 session, worker, cache, 활성 탭을
공유하지 않는다.

release와 installer 실행 파일은 frontend 개발 서버나 TCP 포트를 사용하지 않는다. 개발
모드에서만 하나의 Vite 서버를 `localhost:1420`에 실행하고 여러 debug 앱 프로세스가 이를
공유한다. 다중 프로세스 제품 판정은 개발 서버가 없는 release 또는 installer에서 수행한다.

파일을 그리드 위에 끌어오는 동안 명확한 drop target을 표시한다. 사용자가 파일 선택을
취소한 경우는 오류로 표시하지 않는다. 지원하지 않는 형식, 존재하지 않는 경로, 접근 권한
부족, 손상된 파일은 사용자가 조치할 수 있는 오류로 표시한다.

## 4. 백엔드와 데이터 소스

Tauri command는 입력 검증과 응답 변환만 담당하도록 얇게 유지한다. 파일 읽기, 파싱,
인덱싱, 값 변환 로직은 Tauri를 실행하지 않고도 테스트할 수 있는 Rust 모듈에 둔다.

프런트엔드는 데이터 파일을 직접 읽거나 광범위한 파일 시스템 권한을 갖지 않는다. 열린
파일은 Rust 백엔드 세션으로 관리한다. command는 다음 책임을 기준으로 설계한다.

- `open_data_files`: 최대 32개 경로 검증, 형식 판별, 문서 생성 또는 기존 문서 재사용,
  파일별 성공·실패 반환
- `read_page`: 문서와 source generation을 검증하고 요청한 행 범위와 컬럼을 제한된 크기로 반환
- `copy_selection`: 해당 문서의 선택 범위를 active copy options로 제한된 크기만큼 구성해
  클립보드에 기록
- `execute_query`/`read_query_page`: 문서, source와 query generation을 검증하고 전체 결과에서
  먼저 제한한 source row identity와 요청 column projection만 materialize하여 page를 반환
- `close_document`: 해당 문서의 handle, index, cache, worker, 진행 작업 해제

문서 탭 수명의 `documentId`와 source generation의 `sessionId`를 분리한다. 모든 데이터 command는
두 ID를 확인하며 닫힌 문서, 교체 전 generation, 다른 문서의 늦은 결과를 적용하지 않는다.
백엔드는 여러 문서를 소유하는 `DocumentRegistry`를 사용하되 registry lock을 잡은 채 파일 I/O,
decode, worker join을 수행하지 않는다.

열린 문서는 프로세스당 64개, 동시 source prepare와 CSV worker는 각각 4개로 제한한다. page
cache는 문서당 8 pages, 프로세스 전체 64 pages 또는 추정 256 MiB 중 먼저 도달하는 상한을
사용한다. cache는 LRU로 회수할 수 있지만 열린 문서 탭은 자동 퇴출하지 않는다.

CSV, Parquet와 OEF H5는 compile-time format registry와 공통 tabular source 인터페이스 뒤에 둔다.
registry descriptor는 format id, 표시 이름, 확장자, MIME과 capability를 제공한다. native dialog,
drag-and-drop 안내와 backend 형식 판별은 같은 descriptor 목록을 사용한다. 공통 인터페이스는 다음 정보를
제공한다.

- 파일 이름, 경로, 형식, 크기
- 컬럼 이름과 논리 타입
- 전체 행 수 또는 행 수를 계산 중이라는 상태
- 페이지 단위 행 조회와 컬럼 projection
- 형식별 메타데이터

문서, query, grid와 selection 핵심 계층은 구체적인 format variant를 알지 않는다. 형식별 profile,
row group, pushdown, multiple dataset 같은 차이는 capability로 노출한다. 전용 metadata renderer가
없는 새 format도 공통 Metadata와 Data grid를 사용할 수 있어야 한다. runtime reader plugin은
지원하지 않으며 Windows file association은 Tauri의 정적 bundle 설정으로 별도 관리한다.

형식별 최적화와 오류를 억지로 하나의 구현으로 합치지 않는다. 페이지 크기, 디코딩된
데이터, 인덱스, 캐시는 항상 상한을 갖는다. 빠른 스크롤 중 발생한 오래된 요청은 취소하거나
요청 세대 번호를 확인해 결과를 무시한다.

처음에는 크기가 제한된 JSON 페이지 응답을 사용한다. 프로파일링에서 직렬화가 실제
병목으로 확인된 경우에만 Arrow IPC 등의 바이너리 전송 방식을 도입한다.

## 5. Parquet 규칙

파일을 열 때 footer와 스키마, row group 메타데이터를 읽고 즉시 확인할 수 있는 요약을
반환한다. 행 데이터는 요청한 컬럼 projection과 필요한 최소 범위의 row group만 읽는다.
1,000만 행 규모에서도 open 시 전체 행을 읽거나 materialize하지 않으며 첫 페이지, 임의
row-group 경계, 중간 페이지와 마지막 페이지를 같은 제한된 조회 계약으로 처리한다. 이
규모의 검증은 동일한 논리 스키마와 row-group 구성에서 저카디널리티 반복 데이터와
고카디널리티 데이터를 모두 사용하며 압축이 잘되는 경우만 성능 기준으로 삼지 않는다.

다음 정보를 표시한다.

- Arrow 논리 스키마와 Parquet 물리 타입
- 전체 행 수와 컬럼 수
- row group 수와 각 row group의 행 수
- 압축 방식과 확인 가능한 압축 크기
- 통계가 존재하는 경우 null 수, 최솟값, 최댓값

스칼라, null, integer, floating point, boolean, string, binary, decimal, date, timestamp,
list, struct, map 값을 지원한다. Arrow dictionary로 보존된 pandas·Polars categorical 컬럼은
dictionary index가 아니라 실제 category 값을 원래 value 타입으로 해석하며 null과 빈 문자열을
구분한다. 중첩 값은 구조를 잃지 않는 일관된 축약 표현으로 표시하고, 전체 값을 확인할 수 있는
방법을 제공한다.

schema DTO의 `logicalType`은 `Dictionary(Int8, Utf8)`처럼 원래 Arrow 타입을 표시하고,
`valueLogicalType`은 dictionary wrapper를 재귀적으로 해제한 실제 value 타입을 필수로 제공한다.
비-dictionary 컬럼은 두 값이 같다. filter, sort, distinct, Find, query page, copy, boundary와
result value kind는 `valueLogicalType`과 디코딩된 실제 값만 사용한다. dictionary key/code는 현재
Arrow batch 안에서 value를 찾는 용도로만 사용하며 row group 사이에 저장하거나 비교하지 않는다.
기본 categorical 정렬은 decoded value의 native typed order이고 양방향 모두 null-last이며, 같은
값은 source row identity 순서를 유지한다. pandas ordered categorical의 별도 category order는
명시적인 file-wide order metadata를 지원하기 전까지 적용하지 않는다.

## 6. CSV 규칙

CSV는 줄 단위 문자열 분리로 파싱하지 않고 Rust `csv` crate를 사용한다. 따옴표로 감싼
delimiter, 줄바꿈, escape 문자, 빈 필드를 올바르게 처리한다.

파일을 빠르게 열 수 있도록 preview를 먼저 반환한다. 전체 행 수와 랜덤 접근용 위치
index는 필요할 때 백그라운드에서 계산하며 진행 상태와 취소를 제공한다. 위치 index는
크기를 제한하고 가장 가까운 checkpoint에서 파싱을 재개할 수 있어야 한다.

CSV session이 열리거나 profile generation이 바뀌면 canonical path, header mode와 profile snapshot을
identity로 하는 재사용 가능한 prepared source를 백그라운드에서 만든다. 준비 중에는 preview와 기존
direct page의 backend availability를 유지하되, 실제 `Preparing` 상태를 확인한 frontend는 해당 문서의
Data view를 inert 처리해 새 page·query·distinct·copy·navigation 상호작용을 시작하지 않는다. Ready 이후
page, query, copy와 경계 탐색은 같은 typed/raw/invalid 정보를 가진 prepared artifact를 재사용한다.
진행 행 수·경과 시간과 취소를 제공하고 실패·취소 시에는 이유를 남긴 채 direct source로 안전하게
fallback하며 Data view interaction도 다시 허용한다. session 교체, tab close, process 종료와 crash janitor는 artifact와
작업을 정리하며 다른 generation이나 process의 artifact를 재사용하거나 삭제하지 않는다. 연속 page와
copy는 거대한 row ID `IN (...)` 목록을 만들지 않고 bounded contiguous range로 조회한다.

재사용 가능한 CSV preparation이 `Preparing`인 동안 들어온 filter/sort query와 column distinct-values
요청은 원본 CSV에 대한 두 번째 full scan을 시작하지 않는다. query worker는 preparation의 terminal
상태를 cancel-aware하게 기다리되 DuckDB query permit을 점유하지 않으며, `Ready`가 되면 동일한
prepared artifact를 재사용한다. query 취소는 해당 waiter만 취소하고 공유 preparation을 취소하지
않는다. preparation이 실패하거나 명시적으로 취소된 경우에만 기존 direct source 경로로 안전하게
fallback한다. session·generation·source fingerprint가 달라진 오래된 waiter는 결과를 게시하지 않는다.

cold preparation은 source read byte와 전체 source byte를 사용한 실제 progress bar, 진행 행 수와 경과
시간을 하나의 preparation UI에 표시한다. 유효한 warm cache hit는 이 UI를 한 frame도 표시하지 않는다.

prepared source의 persistent CSV cache는 운영체제의 app-local-data 아래 제품이 소유한
`csv-cache-v1`에 저장한다. Settings에서 query temporary data와 구분된 cache 크기, 항목 수와 실제 경로를
표시하고 사용자가 확인 후 비활성 cache를 삭제할 수 있게 한다. 삭제 요청은 frontend가 경로를 지정하지
않으며 backend가 고정된 cache root 안에서만 수행한다. 활성 session이나 다른 process가 lease한 항목은
삭제하지 않고 건너뛴 결과를 보고하며 원본 CSV는 어떤 경우에도 변경하지 않는다.

유효한 cache hit는 원본 scan과 preparation worker를 시작하지 않고 복원된 row count와 index 상태까지
원자적으로 `Complete`로 게시한다. frontend는 즉시 `Ready` 응답에 preparation progress, Cancel 또는
row-count 계산 UI를 표시하거나 polling하지 않는다. cache compatibility는 cache schema와 artifact layout으로
판정하며 application version 문자열만 바뀐 경우에는 호환 cache를 불필요하게 무효화하지 않는다.
이전 release가 application version을 포함한 directory key로 저장한 compact-v3 cache도 bounded entry
scan과 manifest 검증으로 찾아 재사용한다. 따라서 업데이트 직후에도 호환 cache는 cold preparation UI를
다시 띄우지 않는다.

UTF-8과 UTF-8 BOM을 기본 지원한다. 지원하지 않는 encoding은 깨진 문자열로 표시하지
말고 명확한 오류를 반환한다. 다른 encoding 지원은 별도 요구사항으로 추가한다.

header 존재 여부는 preview를 사용해 제안하되 사용자가 바꿀 수 있어야 한다. 원문 문자열은
항상 보존한다. 전역 기본 열기 모드는 `Auto`, `All Text`, `Ask Every Time`이며 초기값은 Auto다.
`Auto`는 제한된 표본으로 타입을 자동 결정한 뒤 사용자 확인 modal 없이 즉시 준비를 계속한다.
애매한 열은 값 손실이나 잘못된 시간 해석보다 `Text`를 우선한다. 사용자가 명시적으로
`Ask Every Time`을 선택했거나 CSV Parsing Profile을 열었을 때만 타입 확인·수정 UI를 표시한다.
열린 뒤에도 document 범위의 CSV Parsing Profile에서 컬럼 타입을 변경할 수 있다.

profile은 Auto, Text, Boolean, Int64, UInt64, Float64, Decimal, Date, Timestamp, Duration,
Skip을 지원한다.
설정 grid에서 Ctrl/Shift 다중 선택, filter 결과 전체 선택, bulk apply와 undo를 제공한다. 변경 전
최대 1,000행 sample preview와 취소 가능한 전체 파일 검증을 제공한다. 변환 실패 기본값은 원문을
보존하는 invalid 상태이며 source null과 구별한다. profile 적용은 새 sessionId를 만들고 이전
cache/query를 무효화하지만 원본 파일을 수정하지 않는다. 첫 구현은 profile을 session에만 유지한다.

bulk 설정은 선택 컬럼의 유효 타입에 적용되는 항목만 표시한다. Text에는 숫자·Boolean·시간 설정을
표시하지 않고, 정수에는 Thousands separator만, Float64/Decimal에는 Decimal과 Thousands
separator를, Boolean에는 true/false token을, Date/Timestamp에는 temporal 설정을 표시한다.
Duration에는 source unit(`s`, `ms`, `us`, `ns`)과 `rawInteger`/`daysClock` 입력 형식을 표시한다. 단일
선택에서는 비활성 Mixed placeholder나 선택할 수 없는 separator option을 목록에 남기지 않는다.
Thousands separator는 입력 구분자를 해석하는 동시에 converted preview와 적용 후 grid의 숫자
표시를 그룹화한다. 예를 들어 UInt64 값 `10001`에 `,`를 적용하면 `10,001`로 표시한다. 정렬, 필터,
검색 query에는 separator가 없는 정규 숫자값을 사용해 표시 형식이 숫자 의미를 바꾸지 않게 한다.
정수 타입은 decimal separator를 사용하지 않으므로 Thousands `.`을 허용하고 `10001`을
`10.001`로 표시한다. Float64/Decimal에서만 Decimal과 Thousands가 같은 문자인 조합을 거부한다.
이 규칙은 TypeScript wire 검증과 Rust profile 검증에서 동일해야 한다.

다음 파싱 정보를 Metadata 화면에 표시한다.

- delimiter
- header 사용 여부
- encoding
- 전체 행 수 또는 계산 진행 상태
- 일관되지 않은 컬럼 수 등 발견된 구조 문제

## 7. 값 표현

정밀도가 손실될 수 있는 64비트 정수, unsigned 정수, decimal을 JavaScript `number`로
표현하지 않는다. 논리 타입을 보존하고 문자열 또는 타입이 명시된 DTO로 전달한다.

null은 빈 문자열과 구별한다. date와 timestamp에는 단위와 timezone 정보를 보존한다.
binary 값은 안전한 preview와 크기를 표시하며 임의로 UTF-8 문자열로 간주하지 않는다.
지원하지 않는 값은 숨기지 않고 타입과 함께 명확한 대체 표현을 표시한다.

Phase 11부터 값은 source/raw typed value, display와 copy 표현을 구분한다. filter, sort, search와
빈 셀 경계는 display 문자열이 아니라 source typed value와 `DataValue.state`를 사용한다. display는
타입별 app-global 설정으로 구성하고 첫 구현에서 column별 override를 제공하지 않는다. copy는 시작
시점의 별도 설정 snapshot을 사용한다. binary와 긴 nested 값은 bounded preview만 page에 포함하고
전체 값은 명시적 전체 값 요청이나 copy에서 제한된 chunk로 읽는다.

timestamp의 source epoch, unit과 timezone은 raw metadata에 보존한다. 기본 grid display와 기본 copy는
source timezone의 wall-clock field를 암묵 변환하지 않고 `YYYY-MM-DD HH24:MI:SS.F...` 형식으로 출력한다.
source가 가진 소수초 정밀도를 보존하며 소수초가 없으면 점을 출력하지 않는다. `T`, `Z`, timezone
offset과 `[unit=ns]` 같은 annotation은 display와 기본 copy에 넣지 않고 셀 상세 정보에만 표시한다.

Arrow Duration과 CSV Duration은 signed 64-bit count와 source unit(`s`, `ms`, `us`, `ns`)을 정확한
문자열/BigInt 경계로 보존한다. CSV는 raw integer와 days+clock 입력을 지원하고, 빈 필드는 타입과 관계없이
`empty`, 변환 실패는 원문을 가진 `invalid`다. display는 clock, days+clock, raw count preset과 소수부·unit
suffix 설정을 제공하지만 filter/sort/boundary는 source count와 unit을 사용한다. TypeScript draft 검증과
Rust parser는 clock 범위, unit으로 정확히 표현 가능한 소수부와 signed i64 overflow를 같은 규칙으로 거부한다.

Settings의 Value display formats는 String, Integer, Decimal, Date, Timestamp, Duration, Boolean과 Binary
요약 행만 먼저 표시하고 한 타입을 선택하면 같은 Settings content 영역을 상세 편집 화면으로 전환한다.
별도 modal을 겹치지 않으며 Back은 요약의 원래 행으로, 요약에서 상세 진입은 첫 상세 control로 focus를
이동한다. Apply 전 draft와 다른 설정 section의 상태를 보존한다.

## 8. 사용자 인터페이스

첫 화면은 바로 사용할 수 있는 뷰어 작업 공간이어야 한다. 마케팅용 랜딩 페이지를 만들지
않는다. 파일이 열리지 않은 상태에는 열기 동작과 drop target을 제공한다.

상단 툴바에는 파일 열기와 활성 파일 식별 정보를 배치한다. 툴바 아래 문서 탭에는 열린
파일을, 그 아래 뷰 탭에는 활성 문서의 다음 화면을 제공한다.

- Data: 가상화된 데이터 그리드
- Schema: 컬럼 이름, 논리 타입, nullable 여부, 형식별 타입
- Metadata: 파일과 형식별 상세 메타데이터

파일 이름, 형식, 크기, 행 수 또는 계산 상태, 컬럼 수, 현재 표시 범위, 로딩 상태를
표시한다. Parquet에는 row group 정보를, CSV에는 파싱 정보를 표시한다.

Data view에는 capability에 따라 copy 설정, CSV Parsing Profile, column filter/sort와 Find를
제공한다. 전체 query의 진행 상태와 취소는 활성 문서에 귀속한다. query가 commit되면 이전 active
logical row와 column ID를 새 결과 범위에 보존·clamp하고 rectangular selection은 active cell 하나로
축소한다. target page 검증 전에는 selection, scroll과 focus를 commit하지 않는다.

cold CSV preparation의 backend 응답이 실제 `Preparing`이면 해당 문서의 Data toolbar와 grid 전체를
`inert`로 전환하고 진행 overlay를 표시한다. pointer·wheel·keyboard·programmatic focus를 포함해 filter,
sort, Find, copy, navigation, column 조작과 CSV Parsing Profile 진입을 차단한다. 다른 문서 탭 이동과
현재 문서 닫기, Data/Schema/Metadata 전환, Settings, preparation 진행 확인과 Cancel은 blocker 밖에서
계속 사용할 수 있어야 한다. Preparing 전에 열려 있던 transient surface는 닫고 focus를 허용된 control로
옮긴다. `Ready`, `Failed`, `Cancelled` terminal 상태에서는 즉시 inert를 해제하며 실패·취소 뒤에는
direct source를 사용할 수 있다. 상태가 아직 확정되지 않은 `starting`만으로 blocker를 표시하지 않아
warm cache의 즉시 Ready에서 overlay·spinner·Cancel 또는 layout shift가 한 frame도 나타나지 않게 한다.

각 문서 탭은 활성 뷰, page와 scroll, segmented anchor, selection, 컬럼 순서·폭·숨김·검색,
loading/error 상태를
독립적으로 보존한다. 활성 문서 탭을 닫으면 오른쪽 이웃, 없으면 왼쪽 이웃을 활성화하며
마지막 탭을 닫으면 empty workspace로 돌아간다. 문서 탭은 한 줄을 유지하고 좁은 화면에서는
가로 overflow control을 제공한다. `Ctrl+Tab`, `Ctrl+Shift+Tab`으로 문서를 전환하고
`Ctrl+W`로 활성 문서를 닫는다.

문서 탭과 Data grid의 컬럼 header는 pointer drag와 keyboard action으로 순서를 바꿀 수 있다.
문서 탭 reorder는 session/query/cache identity를 바꾸지 않고, 컬럼 reorder는 document별 column ID
순서만 바꾼다. width, visibility, filter, sort, active와 anchor는 column ID로 보존한다. inactive tab은
virtualizer 측정과 page request를 정지하고 cache가 유효한 복귀에서는 geometry·scroll·focus를 첫
paint 전에 복원하며 page IPC, blur/blank/loading flash를 만들지 않는다.

pointer reorder는 6px 이동 뒤 시작하며 target의 앞/뒤 insertion indicator를 사용한다. overflow 가장자리에
pointer를 유지하면 animation frame 단위로 계속 auto-scroll하고 drop 시 최신 pointer 위치의 target을
계산한다. resize separator, filter/sort button과 close control에서는 reorder를 시작하지 않는다. internal
reorder와 OS file drop은 별도 state machine이며 internal drag나 path 없는 platform event로 file-drop
overlay를 표시하거나 파일을 열지 않는다. 취소 뒤 다음 정상 click을 삼키지 않는다.

그리드는 안정적인 크기와 고정 header를 사용한다. 행이나 컬럼이 로드되고 hover, 선택,
로딩 상태가 바뀌어도 주변 레이아웃이 움직이지 않아야 한다. 긴 값은 셀을 무제한 확장하지
않고 잘라 표시하며 전체 값 확인 수단을 제공한다.

문자열의 실제 LF와 CRLF는 셀 안에서 줄바꿈으로 렌더링한다. 모든 data row는 같은 고정 높이를
사용하고 문자열은 wrap 결과를 포함해 최대 2줄만 표시한다. 초과 내용은 line clamp/ellipsis로
줄이며 전체 값 보기는 원문 전체를 표시한다. 문자 두 개 `\n`은 실제 개행으로 변환하지 않는다.

열 header 오른쪽 resize separator를 더블클릭하거나 column menu의 `열 너비 자동 맞춤`을 실행하면
header와 해당 열의 현재 로딩·캐시된 display 문자열을 실제 font로 측정해 너비를 맞춘다. 실제 개행은
가장 긴 논리 줄을 사용하고 padding, border와 header action 공간을 포함한 뒤 기존 80..800 px 범위로
제한한다. 이 동작은 backend page나 전체 column scan을 시작하지 않는다. 이후 page나 display 설정이
바뀌어도 너비를 자동 변경하지 않으며 재실행할 때만 새 표시값으로 계산한다. 수동 resize와 document별
column width 보존은 계속 지원한다. row height auto-fit은 제공하지 않는다.

논리 행 수에 고정 row 높이를 곱한 전체 높이를 하나의 DOM scroll surface로 만들지 않는다.
WebView의 최대 scroll height보다 작은 segmented/anchored surface를 사용하고 논리 row와 물리 scroll
offset을 분리한다. 5,850,000행과 10,000,000행에서도 실제 마지막 행까지 정확히 이동해야 하며 마지막
행의 전체 border/content는 horizontal scrollbar 위에 완전히 표시되어야 한다.

세로 스크롤의 page scheduling은 입력 속도에 적응한다. 120ms 표본 구간 안에서 누적 1 page 이상
이동하거나 인접 표본이 2 page 이상 건너뛰면 scrub mode로 전환한다. scrub 중에는 논리 위치와 행
번호만 갱신하고 uncached 중간 page 조회와 인접 prefetch를 억제한다. `scrollend` 또는 마지막 입력 뒤
120ms quiet period에서 최종 visible page 하나만 foreground로 읽는다. 이미 호환되는 projection의
page가 cache에 있으면 속도와 관계없이 즉시 표시한다. 느린 스크롤, 키보드 이동, selection auto-scroll은
기존 즉시 조회를 유지하며 정착한 page의 인접 prefetch도 유지한다. segmented surface를 재배치하며
발생한 synthetic scroll은 속도 판정과 추가 page 요청에 포함하지 않는다.

## 9. 그리드 선택과 키보드

선택 상태는 렌더링된 DOM 셀이 아니라 논리적인 행과 컬럼 좌표로 관리한다. 선택 모델은
anchor, active cell, 직사각형 범위를 갖는다. 가상 스크롤로 셀이 unmount되거나 새 페이지를
읽어도 선택이 유지되어야 한다.

다음 동작을 지원한다.

- 클릭으로 단일 셀 선택
- 마우스 드래그로 직사각형 범위 선택
- `Shift+클릭`으로 anchor부터 클릭한 셀까지 확장
- 화살표 키로 active cell 이동
- `Shift+화살표`로 선택 범위를 한 셀씩 확장 또는 축소
- `Ctrl+화살표`로 Excel 방식의 연속 데이터 또는 빈 셀 영역 경계로 이동
- `Ctrl+Shift+화살표`로 같은 데이터 영역 경계까지 선택 범위 확장
- `Ctrl+Alt+화살표`로 빈 셀과 관계없이 해당 방향의 전체 표 경계로 이동
- `Ctrl+Alt+Shift+화살표`로 기존 anchor부터 전체 표 경계까지 선택 범위 확장
- `Home`, `End`, `PageUp`, `PageDown`으로 표준 그리드 이동
- 행 또는 컬럼 header 클릭으로 해당 행 또는 컬럼 선택
- `Ctrl+A`로 현재 데이터 테이블 전체 선택
- `Escape`로 확장 범위를 해제하고 active cell만 유지

`Ctrl+화살표`는 `DataValue.state`가 `null` 또는 `empty`인 셀만 빈 셀로 판정하고, 현재 셀과
다음 셀의 상태에 따라 Excel 방식으로 연속 데이터 영역의 끝 또는 다음 데이터 영역의 시작까지
이동한다. `invalid`와 공백 문자열은 값이 있는 셀이다. 탐색은 현재 source 또는 활성 query result의
백엔드 경계 탐색기가 수행한다. 활성 query에서는 정렬 결과의 logical position을 기준으로 검사하며
원본 source 순서의 boundary를 재사용하지 않는다. 프런트엔드는 중간 page를 순차 요청하지 않고
반환된 좌표가 든 page만 cache miss일 때 최대 1회 요청한다.

경계 탐색기는 공통 200행 `read_page` 반복 대신 source-native scan을 사용한다. OEF H5의 numeric
time과 정수 oes처럼 빈값이 불가능한 영역은 O(1)로 계산한다. string time, CSV와 Parquet의 nullable
또는 empty 가능 column은 HDF5 block, CSV checkpoint 또는 Arrow vector 단위로 검사하고 generation별
경계 cache를 사용할 수 있다. string time의 실제 빈 문자열만 empty이며 OEF H5의 정수 oes에는 별도
sentinel 계약이 없는 한 빈 셀이 없다.

활성 filter/sort query의 경계 탐색은 query logical order의 한 컬럼 occupancy를 256, 4,096, 16,384,
65,536행 단계로 확장해 검사한다. occupancy provider가 채택해 값을 판정하는 decoded block은 8 MiB를
넘기지 않는다. `parquet-rs`가 반환한 후보 Arrow batch가 실제 측정에서 8 MiB를 넘으면 값을 읽거나
bitmap에 반영하기 전에 즉시 폐기하고 더 작은 범위로 분할한다. dependency 내부 page buffer와 폐기 전
후보 batch는 이 제품 상한의 대상이 아니며, audit은 최대 observed 후보와 최대 accepted block을 구분한다.
known/occupied bitmap은 packed
형태로 cache한다. cache는 query generation별 최대 8개 컬럼, 프로세스 전체 16 MiB LRU 상한을 가지며
반복 탐색은 이미 알려진 범위를 source에서 다시 읽지 않는다. null과 실제 empty만 빈 셀이며 numeric
CSV의 빈 raw field도 prepared 복원 뒤 같은 `empty` 의미를 유지한다.

`Ctrl+Alt+화살표`는 셀 값과 nullable metadata를 무시하고 해당 방향의 전체 표 경계로 이동한다.
전체 행 수가 아직 계산 중이면 백엔드가 EOF를 확인해 마지막 논리 행을 함께 반환한다. 두 단축키
모두 `Shift`를 함께 누르면 기존 anchor부터 계산된 경계까지 선택을 확장한다. navigation,
document, session, query identity가 일치하는 응답만 적용하며 새 마우스 선택, 일반 키보드 이동,
focus 이탈, session 또는 query result 변경이 발생하면 진행 중인 탐색을 취소하고 늦은 결과를
폐기한다. 연속 경계 단축키는 앞선 target page의 검증과 선택 확정이 끝난 뒤 다음 입력을 같은
queue에서 처리해, 두 번째 키가 이전 좌표에서 시작하지 않게 한다. target page가 실패하거나
응답 identity·projection·row가 맞지 않으면 선택과 scroll은 이동 전 상태를 유지한다.

macOS에서는 `Ctrl` 기반 명령에 해당하는 `Command` 동작을 함께 제공하며 `Ctrl+Alt`는
`Command+Option`에 대응한다. 키보드 이벤트는
검색창이나 다른 입력 control의 기본 편집 동작을 가로채지 않는다. 선택과 focus는 색상만이
아닌 명확한 시각적 경계로 구분한다.

### 셀 컨텍스트 메뉴

데이터 셀을 우클릭하면 앱 컨텍스트 메뉴를 연다. 현재 선택 범위 안의 셀을 우클릭하면
선택을 유지하고, 범위 밖의 셀은 해당 셀을 단일 선택한 뒤 메뉴를 연다. `Shift+F10`과
Context Menu 키는 active cell을 대상으로 같은 메뉴를 연다.

MVP 메뉴 액션은 `복사`, `열 이름 포함 복사`, `셀 값 복사`, `전체 값 보기`다. 복사 액션은
아래 클립보드 계약과 기존 선택 범위의 논리 좌표를 재사용한다. 메뉴는 viewport 안에
flip/clamp하고 `Escape`, click-away, scroll, resize, 문서 또는 뷰 전환 시 닫는다. 종료 후
선택은 유지하며 적절한 경우 grid focus를 복원한다. 메뉴와 항목은 접근 가능한 role, 이름,
focus, keyboard navigation을 제공한다.

## 10. 클립보드

`Ctrl+C`는 현재 선택 범위를 활성 copy preset과 타입별 기본 copy 표현으로 시스템 클립보드에 기록한다.
초기 preset은 Excel이며 TSV, CSV와 Custom을 제공한다. Excel이나 다른 스프레드시트에
붙여넣었을 때 같은 직사각형 구조가 유지되어야 한다.

- Excel/TSV는 tab, CSV는 comma, Custom은 한 문자의 delimiter를 사용한다.
- delimiter, 줄바꿈, 따옴표가 든 값은 선택한 quote/escape 규칙으로 직렬화한다.
- header를 명시적으로 선택한 경우에만 header를 포함한다.
- null과 빈 문자열을 구별할 수 있는 내부 모델을 유지한다.
- 보이는 DOM 셀이 아니라 논리 선택 범위를 복사한다.
- `Copy displayed value`와 `Copy raw/canonical value`는 기본 copy와 별도 action으로 제공한다.
- display format 변경은 raw 값과 copy 시작 시점의 명시적 representation snapshot을 바꾸지 않는다.

설정 preview는 실제 serializer를 사용한다. 구조를 보존할 수 없는 no-quote 조합은 실행하지 않는다.
Excel/TSV 기본은 null과 empty를 빈 cell로 출력하며 구별 손실을 preview에 알린다. CSV/Custom
기본은 null `NULL`, empty `""`, 실제 문자열 `NULL`은 quoted `"NULL"`로 구별한다. 설정은 앱
전역에 atomic 저장되며 이미 시작한 copy는 시작 시점 snapshot을 사용한다.

grid page 조회의 projection 64열·200행 상한은 bulk copy에 재사용하지 않는다. copy는 Rust backend
task가 source/query position과 format capability에 맞는 bounded batch로 읽고 TSV를 streaming
serialize한다. 5.85M행×1열은 page IPC나 WebView value 누적 없이 큰 vertical batch로 처리하고,
소수 행×다수 H5 열은 cell 수와 decoded/serialized byte 예산 안에서 연속 wavelength hyperslab을
최대한 합친다. 완료 전에는 system clipboard를 바꾸지 않고 성공 시 한 번만 기록한다.

Copy history는 현재 attempt와 bounded 이전 attempt 최대 5개를 operation ID, 시각, 상태와 실패 이유로
구분해 표시한다. transient popover이므로 trigger 재클릭, outside pointer, Escape, 외부 scroll/resize,
문서·session·query 변경에서 닫히며 outside target의 원래 click이나 focus를 막지 않는다. 성공 상태는
짧은 TTL 뒤 축소할 수 있지만 실패·취소 이유와 Retry/Dismiss는 사용자가 처리할 때까지 유지한다.

filter/sort가 있으면 부분 선택은 filtered result의 선택 logical row와 현재 visible·reordered column만,
전체 선택은 filter를 통과한 모든 row와 visible column만 현재 stable sort와 화면 column 순서로
복사한다. hidden column은 제외한다. Find는 row 집합이나 순서를 바꾸지 않는다. query/session snapshot이
pending·교체·stale이면 과거 row를 복사하지 않고 이유가 명확한 terminal state로 종료한다.

큰 선택 범위에는 예상 셀 수와 크기를 알리고 진행 상태와 취소를 제공한다. 100,000셀 또는
8 MiB의 고정 soft limit을 넘으면 사용자 확인을 받는다. app-global hard limit 기본값은
1,000,000셀과 64 MiB이며 Settings에서 셀은 1,000..10,000,000, byte는 1..256 MiB 범위로
변경할 수 있다. 진행 중 copy는 시작 시점의 설정 snapshot을 사용하고, hard limit 초과나
분할 조회 오류·취소·stale 응답에서는 clipboard에 부분 결과를 기록하지 않는다. settings
wire schema V2는 `copyLimits { maxCells, maxBytes }`를 가지며 유효한 V1은 나머지 설정을
보존한 채 기본 copy limit을 채워 atomic migration한다. copy 취소는 clipboard write를 시작하기
전까지만 허용하고, 원자적 clipboard commit 중에는 취소 control을 비활성화한다. settings 저장
중 process가 종료되어 canonical 파일 없이 `settings.previous-*`만 남으면 다음 load에서 backup을
복구한 뒤 migration을 다시 수행한다.

각 copy attempt는 operation ID, 시작 시각, logical range, representation, query/session snapshot,
stage, progress와 terminal state를 가진다. 현재 attempt와 bounded 이전 history를 구분하며 최소한
SelectionLimit, ByteLimit, SourceRead, QueryStale, Cancelled, Serialize와 ClipboardWrite 오류를
사용자 이유로 표시한다. Excel preset에서 1,048,576행을 넘으면 worksheet 한도 경고를 표시하되
일반 TSV hard limit과 혼동하거나 허용된 작업을 임의로 축소하지 않는다.

MVP는 읽기 전용이므로 뷰어에 값을 붙여넣어 원본 데이터를 변경하지 않는다. 여기서
붙여넣기 지원은 뷰어에서 복사한 TSV를 Excel 등의 다른 애플리케이션에 붙여넣을 수 있다는
의미다.

## 11. 전체 파일 filter, search와 sort

filter, search와 sort는 현재 page가 아니라 전체 source 또는 현재 query result 전체를 대상으로 한다.
typed filter는 Text, number/decimal, date/timestamp, Boolean과 null/invalid에 맞는 operator만 제공한다.
메인 뷰어의 CSV 타임스탬프 필터는 UTC 오프셋과 소수초 최대 9자리를 반영해 비교한다.
여러 컬럼은 AND, 같은 컬럼의 여러 값은 OR로 결합한다.

Find 기본 대상은 현재 표시 중인 scalar 컬럼 전체이며 사용자가 컬럼을 제한할 수 있다. 기본은
case-insensitive contains이고 exact와 case-sensitive option을 제공한다. regex, binary와 nested Find는
첫 구현에서 제외한다. 전역 match-only Filter mode는 제거하고 header의 typed column filter는 유지한다.
`Ctrl+F`는 Find를 열어 input에 focus하지만 typing만으로 조회하지 않는다. `조회` 또는 Enter에서 draft를
commit하고 Esc, previous/next를 제공한다. Find는 committed filter/sort 결과의 match position만 이동하며
row count와 order를 바꾸지 않는다. modal, Settings, copy dialog나 다른 editable control이 focus를 가진
동안 전역 `Ctrl+F`가 background Find를 열거나 focus trap 밖으로 focus를 빼앗지 않는다. 연속
previous/next 요청은 요청 sequence를 검증해 늦은 이전 match가 최신 위치를 덮어쓰지 못하게 한다.

sort는 ascending, descending, clear와 별도 multi-sort criteria editor를 제공한다. 같은 값은 원본 row
identity를 tie-breaker로 사용해 안정 정렬하며 null은 양 방향 모두 마지막이다. query 결과는
`documentId`, `sessionId`, `queryId`로 격리하고 늦은 결과를 폐기한다.
multi-sort UI는 전체 logical column 검색, priority, direction, remove와 pointer/keyboard reorder를
제공한다. `Add level`은 빈 기준 행만 추가하고 column picker를 자동으로 열거나 focus를 옮기지 않는다.
사용자가 column control을 click·focus하거나 keyboard로 명시적으로 열었을 때만 picker를 표시한다.
criteria editor는 viewport 안에서 높이를 제한하되 여러 기준을 한눈에 볼 수 있도록 충분한 세로 공간과
내부 스크롤을 사용하고, Cancel·Apply footer는 스크롤 중에도 panel 안에서 접근 가능해야 한다.
header click과 Shift+header click은 모두 해당 단일 컬럼의 같은 sort cycle로 동작하며
다중 기준 변경은 criteria editor의 Apply에서만 ordered plan으로 commit한다. 실행 의미는 항상 typed
column filter로 row 집합을 정한 뒤 multi-sort로 순서를
정하고 Find로 위치를 탐색하는 순서다. filter→sort와 sort→filter의 최종 plan이 같으면 결과도 같다.

1,000만 행 저·고카디널리티 데이터에서도 전체 UI row를 materialize하지 않는다. memory budget을
넘는 sort/query는 bounded temporary disk spill을 사용할 수 있다. query engine은 동일 fixture의
DataFusion, DuckDB/direct spike 후 선택하고 신규 runtime dependency는 사용자 승인 뒤 추가한다.

temporary data는 Tauri가 resolve한 app-local-data 아래 process/document/query별 경로를 사용한다.
기본 process hard cap은 10 GiB이며 기본 5 GiB의 디스크 안전 여유 공간을 별도 보존한다.
Storage 입력은 64 MiB~10 GiB 범위의 소수 GiB를 허용하고 가장 가까운 정수 byte로 저장한다.
범위 검사는 반올림 전에 적용하며 재열기·재적용으로 저장된 byte 값이 변하지 않게 표시한다. volume
크기의 비율을 query가 필요로 하는 byte처럼 표시하지 않는다. UI와 wire DTO는 가능한 예상 임시
데이터, 안전 여유와 hard cap을 서로 구분한다. 완료, 실패,
취소, 교체와 tab close 시 정리하고 owner lock을 사용해 다른 active process의 파일을 삭제하지 않는다.
crash orphan은 다음 startup janitor가 lock 획득 가능한 directory만 정리한다.

query와 CSV preparation이 받는 DuckDB temporary allowance는 고정 상한을 그대로 사용하지 않고
현재 query temp, persistent CSV cache, 이미 예약된 동시 query와 `free space - 5 GiB reserve`를
반영한 남은 공통 예산으로 제한한다. 대기 중인 cold CSV preparation은 변환 permit을 얻기 전에는
디스크 예산을 예약하지 않는다. 원본 고정을 위한 hardlink는 해당 lease의 정확한 경로와 열린 원본
handle의 OS file identity가 일치할 때만 추가 저장량에서 제외한다. 동명 복사본, 다른 identity로
교체된 파일과 미등록 hardlink는 일반 임시 파일로 계산하며 실제 출력·cache와 디스크 여유 공간
reserve는 계속 계산한다. 실행 중 출력이 초기 예약량을 넘으면 실제 사용량과 예약량 중 큰 값을
과금해 다른 작업에 같은 공간을 중복 예약하지 않는다. CSV cache 재열기는 현재 남은 공간으로
작은 catalog metadata를 먼저 복원하며, cold 변환용 대량 예약을 확보하려고 다른 cache를 미리
삭제하지 않는다. 예약 가능한 공간이 없거나 복원 metadata의 실제 사용량이 한도를 넘을 때만
필요한 비활성 cache를 회수한다. 외부 CSV 변환기도 실행 중 공통 예산을
검사하며 공간 부족 시 자식 프로세스를 중단·회수하고 partial을 정리한다. query 시작 시 또는 실행 중 100ms monitor가 공통 예산 압력을
확인하면 제품이 소유하고 manifest와 artifact 크기를 검증한 비활성 CSV cache만 oldest-first로
필요한 만큼 회수한다. 같은 process와 다른 process가 lease 중인 cache, 검증되지 않은 cache-like
directory와 원본 데이터 파일은 회수 대상이 아니다. 회수 후에도 안전 예산을 확보할 수 없거나
DuckDB가 temp limit, disk-full 또는 temp directory I/O 오류를 반환하면 raw SQL이나 절대 경로를
노출하지 않는 `QueryTempLimitExceeded`로 정규화하고 현재 query/cache 사용량, limit, free space,
5 GiB reserve와 Settings의 `Clear inactive CSV cache` 조치를 안내한다.

Parquet query는 가능한 predicate와 projection을 scan에 push down한다. Phase 12부터 정렬·filter
결과 index는 정렬된 source row identity 한 열만 가진 DuckDB 물리 table로 materialize한다. 생성 후
수정하지 않는 table의 연속 physical `rowid`를 logical result position으로 사용하고 count/min/max
invariant를 확인한다. index는 QueryResult가 소유한 connection의 materialization transaction에서
만들어 commit하고, 즉시 같은 connection에서 read-only lifetime transaction을 시작한다. 이는 DuckDB
1.4 writer transaction의 transient rowid base를 피하면서 position snapshot을 고정하기 위한 경계다.
결과 종료 때 read-only transaction을 rollback한다. 별도 ordered window position column, 모든 source
column의 display/raw 문자열과 typed value 복사본을 저장하지 않는다. 안정 정렬의 최종 tie-breaker는
원본 row identity를 사용한다.

`read_query_page`는 physical position에서 최대 200개의 source row identity를 먼저 확정하고 query
connection lock을 해제한 뒤 source provider가 요청한 1~64개 column만 sparse하게 읽는다. 원본
source와 전체 join한 뒤 `LIMIT`을 적용하는 page plan은 허용하지 않는다. Parquet는 row group,
projection과 row selection을 사용하고 CSV는 checkpoint index에서 target row를 묶어 읽는다. query의
전체 logical column 목록과 현재 `DataPage.columns` projection은 별도로 관리한다.

query page scheduler는 visible foreground 요청을 adjacent prefetch보다 우선한다. foreground page가
준비되기 전에 새 prefetch를 시작하지 않으며 document/session/query/offset/projection generation이
달라진 늦은 응답을 적용하지 않는다. 정렬 후 `PageUp`/`PageDown`, 일반·Shift·Ctrl·Ctrl+Alt 조합은
source row identity가 아니라 query logical position을 이동하고 target page가 검증된 뒤 selection과
focus를 commit한다. 세부 계약과 성능 예산은 `artifacts/phase-12/`의 승인된 문서를 따른다.

Phase 9 query engine은 DuckDB Rust `1.10504.0`의 `bundled`, `parquet`, `vscalar` 기능을 사용한다.
연결은 in-memory이며 persistent database를 만들지 않는다. spill만 위 app-local-data 임시 경로를
사용한다. case-insensitive 비교는 제품의 scalar lowercase UDF를 사용하고 Unicode 정규화는 하지
않는다. 새 입력 형식은 `FormatRegistry` handler와 선택적 query provider로 추가하며 query executor
핵심에 형식별 분기를 추가하지 않는다.

## 12. OEF H5 v3 규칙

Phase 11은 범용 HDF5 browser가 아니라 다음 고정 구조만 지원한다. writer의 `format` 권장값은
`oesh5`지만 viewer 판별 조건에는 사용하지 않는다.

```text
root attribute: format = "oesh5"  # optional writer hint; viewer ignores it
root attribute: format_version = 3
root attribute: shape = [n_time, n_wavelength]
root dataset:   time[n_time]
root dataset:   wavelength[n_wavelength]
root dataset:   oes[n_wavelength, n_time]
```

- `time`과 `wavelength`는 integer, float 또는 string 1차원 dataset이다.
- `oes`는 2차원 int32 또는 int64 dataset이며 저장축은 wavelength, time 순서다.
- viewer 표는 `time`을 첫 열로 두고 `/oes[wavelength, time]`을 transpose하여 time 행과 wavelength
  열로 표시한다.
- `shape` attribute, 두 axis 길이와 `oes.shape`는 `[T,W]`, `T`, `W`, `[W,T]` 관계로 정확히
  일치해야 한다.
- chunk shape의 축별 길이는 고정하지 않고 correctness나 축 의미를 chunk에서 추론하지 않는다.
  decoded chunk가 64 MiB를 넘으면 HDF5 decode 전에 typed resource-limit 오류로 거부한다.
- 대표 압축은 Blosc v1 filter ID 32001의 Zstd다. static runtime에서 사용할 수 없는 filter/codec은
  typed unsupported-compression 오류이며 dynamic plugin은 사용하지 않는다.
- 다른 attribute는 필수 조건이 아니며 알 수 없는 값은 무시한다.
- wavelength 이름 충돌은 저장 순서 기반 suffix로 고유화하고 내부 projection은 ordinal binding을 쓴다.
- page는 최대 200행, projection은 최대 64열이며 전체 `oes`를 materialize하지 않는다.
- decoded axis는 파일당 128 MiB와 process 256 MiB, decoded chunk/page buffer는 64 MiB 상한을 유지한다.
- source capability는 `typedSchema`, `columnProjection`만 제공하며 OEF query provider는 별도 승인 없이는
  추가하지 않는다.
- root local hard-linked dataset만 허용하고 soft/external link, VDS와 external storage를 거부한다.
- `.h5`, `.hdf5`는 모든 open 진입점의 후보이며 signature, version과 구조를 최종 검증한다.
- `format` attribute는 없거나 어떤 datatype/value여도 판별과 거부 조건으로 읽지 않는다.
- Windows `.h5/.hdf5` file association은 모든 HDF5를 선점하므로 별도 승인 없이 추가하지 않는다.
- grid는 64열 projection 분할을 유지하고 copy는 별도 적응형 bounded batch를 사용한다.

정확한 오류, fixture, transpose paging, packaging과 완료 gate는 `artifacts/phase-11/`의 확정 문서를 따른다.

## 13. 보안과 안정성

모든 파일을 신뢰할 수 없는 입력으로 취급한다.

- 파일을 읽기 전용으로 연다.
- 경로를 정규화하고 지원 형식과 파일 구조를 검증한다.
- panic 대신 타입이 명확하고 사용자 메시지로 변환 가능한 오류를 반환한다.
- shell 실행이나 광범위한 파일 시스템 권한을 활성화하지 않는다.
- CPU 사용량이 큰 파싱과 디코딩은 UI thread 밖에서 실행한다.
- 문서 탭을 닫거나 source generation을 교체할 때 해당 handle, index, cache, worker, session을
  다른 문서에 영향 없이 해제한다.
- 백그라운드 작업은 진행 상태와 취소를 지원하고 닫힌 세션에 결과를 기록하지 않는다.
- query literal과 column name을 engine SQL 문자열로 연결하지 않고 typed expression 또는 bind를 사용한다.
- query temp와 settings는 Tauri app directory에 쓴다. CSV persistent cache는 기본 app directory 또는
  네이티브 picker로 승인한 폴더의 앱 소유 하위 디렉터리에만 쓴다. source/exe directory에는 쓰지 않는다.

## 14. 향후 범위

aggregation, group by, join, pivot와 SQL editor는 별도 요구사항이 승인된 경우에만 추가한다.
runtime reader plugin과 query 결과의 persistent reusable cache는 현재 범위가 아니다.

2026-11-06 사용자 승인으로 아래 Phase22 SQL 작업 공간을 개발한다. 기존 파일 화면의
filter/sort 계약과 SQL 작업의 독립 결과 계약을 구분한다. pivot와 persistent SQL result cache는
이 승인에 포함하지 않는다.

Phase 11 OEF H5 v3 계약 밖의 일반 HDF5는 별도 데이터 소스로 다룬다. 한 파일의 여러 dataset을 위한
`multipleDatasets` capability와 선택 UI, axis dataset paging, OES query provider는 각각 별도
요구사항과 fixture가 승인된 경우에만 추가한다. Excel도 같은 방식으로 sheet 선택 계약을 먼저
정의한다.

## Phase 20 Parquet 문자열 호환성 보완

Parquet에서 Arrow Utf8View로 복원되는 문자열도 Utf8와 같은 표시·전체 값·복사 의미를 제공한다.
Dictionary의 value와 nested preview/full canonical 값에도 적용하며 empty/null의 boundary occupancy를 보존한다.
캐시 prepared.parquet를 직접 열면 내부 물리 컬럼명이 표시되며 원래 CSV 헤더 복원 기능을 뜻하지 않는다.

## Phase 21 컬럼 고유값·캐시 관리 계약

컬럼 헤더의 Column values에서 전체 source 또는 현재 필터 결과의 정확한 고유값 수와 빈도를
조회한다. 기존 필터의 값 선택 목록과 별도이며, 검색 결과 수와 전체 수를 구분한다.
동일 타입 값은 한 항목으로 묶고 null·empty·invalid 원문은 분리한다. 값순/빈도순 양 방향 정렬은
안정적인 동률 순서를 사용한다. 패널은 100행씩 조회하고 wire page 상한은 200행이다.
계산은 취소 가능한 immutable snapshot이며 document/session/query/operation identity가 바뀐
오래된 결과를 게시하지 않는다. 동시에 살아 있는 worker는 취소 요청 후 실제 종료까지 포함해 16개로 제한한다.
미리보기 값은 Unicode 1024자로 제한하되 전체 복사에서는 원문을 보존한다.
전체 값 또는 값+빈도 복사는 현재 scope·검색·정렬의 모든 일치 항목을 대상으로 하며 로드한 페이지에
한정하지 않는다. 기존 copy cell/byte 상한, TSV escaping, 진행·취소와 atomic clipboard commit을 적용한다.
숫자·decimal·timestamp는 문자열로 정밀도를 보존하며 count/total이 JS safe integer를 넘으면 typed 오류를 반환한다.
문자열 집계는 그룹 키에서 표시값을 복원해 그룹마다 별도 `MIN(VARCHAR)` 상태를 보관하지 않는다.
다른 논리 타입은 같은 값의 서로 다른 표기를 합치면서 기존 대표값을 유지한다. 이 최적화로 메모리·임시 저장 한도를 늘리지 않는다.

패널의 이전·다음은 응답의 previousCursor/nextCursor로 이동한다. 두 응답 필드는 필수 nullable이며,
요청 cursor는 생략 또는 null을 허용한다. offset은 표시 위치와 커서 유효성 확인에 사용한다.
커서는 snapshot·검색·정렬·offset·page 크기·이동 방향에 귀속하며 타입별 원본 값을 프런트엔드에 담지 않는다.
토큰은 1..128 UTF-8 bytes, NUL·전체 Unicode 공백 금지이며 snapshot별 최대 256개, 유효기간 30분이다.
정렬·검색·scope·재계산이 바뀌면 화면의 커서와 페이지를 초기화하고 이전 요청의 응답을 버린다.
모든 논리 정렬 키와 null·empty·invalid 구분 및 최종 rowid 순서를 포함해 DB 안에서 seek한다.
이전 이동은 전체 정렬 방향과 NULL 위치를 반전해 읽은 후 표시 순서를 되돌린다.
기존 cursor 없는 임의 offset 호출은 꼬리 역방향 조회 또는 작은 키 표본과 정확한 개수로
기준 행을 찾는 bounded 경로로 처리한다. 큰 SQL OFFSET이나 전체 중간 순위 정렬을 사용하지 않으며,
이 경로도 기존 메모리·임시 저장 한도와 취소 처리를 따른다.
복사는 UI wire 상한 200행과 별도로 내부 배치를 최대 4,096행 및 기존 8MiB 추정 바이트로 제한한다.
바이트 사전 검사·축소 재시도는 같은 기준점을 사용하고, 검증된 실제 반환 행 뒤에서만 다음 기준점을 저장한다.
복사 내부 기준점 캐시는 최대 4개이며 기존 cell/byte 상한과 취소·원자적 clipboard commit을 유지한다.

설정 schema 5는 csvCacheLimitBytes(64MiB~10GiB, 기본10GiB)와 csvCacheDirectory(null=기본 위치)를
추가한다. Overall managed storage limit는 CSV cache와 query/preparation의 공통 예산이다.
CSV cache 전용 실효 한도는 min(overall, configured cache cap)이며 cap이 overall보다 커도 유효하다.
두 용량 입력 모두 소수 GiB를 허용하고 범위 검사 후 가장 가까운 정수 byte로 저장한다.
cap 축소는 비활성 앱 소유 cache만 LRU 회수한다. 활성 cache는 계속 읽을 수 있고 마지막 lease를 닫으면
이미 설정된 한도로 다시 회수한다. 준비 결과가 cache cap보다 크면 persistent 저장을 건너뛰고
overall 예산 안의 session 임시 결과로 Ready를 제공한다. 오류·손상·overall 초과를 무시하지 않는다.
일반 폴더나 manifest를 검증하지 못한 foreign 항목은 cache 개수 제한이나 자동 회수 대상으로 삼지 않는다.

위치 변경은 native picker가 발급한 일회 selection token으로만 실행한다. 선택 폴더 아래
data-viewer-csv-cache를 사용하며, 일반 settings Apply로 경로를 바꾸지 않는다.
문서·pending open·다른 프로세스의 entry lease가 있으면 이전을 거절하고 진행 중에는 신규 작업을 막는다.
source/target 중첩, foreign 충돌, symlink/junction/reparse 경로를 거절한다.
다른 volume에서는 bounded copy→checksum 및 새 OS file identity 검증→destination 확정→settings 원자 저장→
source 정리 순서를 따른다. 대상 volume은 전체 복사 용량과 5GiB 안전 여유를 확보해야 한다.
공통 logical 예산에서는 같은 cache를 한 번 계산하고 이전 중 transient 복제만 별도 처리한다.
취소·실패는 원래 설정과 유효 cache를 유지하며 앱이 만든 partial만 정리한다.
durable journal과 authoritative settings로 crash 경계를 복구하고 옛 process의 이전 root 재사용을 막는다.
실행 중인 cache worker도 저장된 설정 위치를 확인한다. 오프라인 위치 교체 후 옛 드라이브가
돌아오더라도 기존 창이 옛 cache에 publish·회수·clear하지 못하게 하고 해당 창의 재시작을 안내한다.
이전 후 신규 CSV publish도 cross-volume copy/verify를 지원해야 한다.

설정된 cache 드라이브가 연결되지 않아도 앱과 Settings는 열려야 한다. 사용자가 새 위치를 명시적으로
선택하면 unavailable 안내 후 빈 cache 위치로 전환할 수 있다. 이 경로에서는 기존 cache를 이전하거나
삭제하지 않는다. 원래 위치가 commit 전에 다시 사용 가능해지면 일반 이전 절차를 사용하도록 중단한다.

## Phase 22 SQL 작업 공간 계약 — 구현 중

열린 로컬 CSV·Parquet를 전체 파일 범위의 SQL 테이블로 등록한다. 파일별 별칭은 즉석 수정하며
같은 basename의 다른 경로는 독립 등록한다. 별칭 충돌 검사는 ASCII case-insensitive이며
인용·이스케이프 후 SQL에 삽입한다. 등록 테이블 목록과 선택한 테이블의 검색·가상화 컬럼 목록을
분리한다. 기존 그리드 filter/sort는 SQL에 자동 적용하지 않는다.
테이블 선택 버튼은 별칭·경로·모드·여백을 포함한 카드 전체다. 연필과 별칭 편집 폼은 별도
control이며 선택을 바꾸지 않는다. Enter/Space와 aria-pressed를 유지하고, 최소 창 크기에서도
선택 카드의 경로·모드를 목록 안에서 완전히 볼 수 있도록 최소 높이와 가까운 위치 스크롤을 적용한다.

테이블마다 SQL 컬럼 참조 방식은 원본 이름 또는 c번호 중 **하나만** 선택한다. 원본의 완전한
헤더에 blank 또는 ASCII-case-insensitive 중복이 없으면 이름 모드가 기본이고, 그렇지 않으면
c번호가 기본이며 이름 모드를 사용할 수 없는 이유를 표시한다. 뷰어가 자동 suffix를 붙인 이름이나
잘린 metadata preview로 적합성을 판단하지 않는다. 헤더가 없는 CSV도 c번호만 사용한다.
이름 모드는 원본 이름을 보존하고 삽입할 때 큰따옴표·이스케이프를 처리한다. c번호는 원본 physical
index+1로 고정하고 skip/reorder/hide로 재번호를 붙이지 않는다. 한 테이블에 양쪽 namespace를
동시에 노출하지 않는다. 원본 이름 자체가 c1이면 이름 모드의 그 이름으로만 해석한다.
파일마다 서로 다른 모드를 사용해 JOIN할 수 있다. 별칭·모드 변경은 기존 SQL을 자동 수정하지 않는다.

SQL 작업 탭 하나에서 동시에 하나의 SELECT/SELECT CTE를 실행한다. JOIN·집계·window 계산,
결과 페이지·선택·TSV 복사·전체 값 조회와 EXPLAIN/EXPLAIN ANALYZE를 제공한다. 예제·작성 가이드는
현재 파일의 별칭·모드와 연결되며 예제 삽입은 실행하지 않는다. 숫자·decimal·시간 타입의 정밀도를
보존하고 CSV typed-invalid는 SQL NULL로 제공하면서 경고·원문 profile 확인 경로를 제공한다.
정확히 표현할 수 없는 값은 조용히 round/cast하지 않고 명시적 지원 제한 오류로 처리한다.
duration을 BIGINT로 제공할 때는 원래 단위를 경고·설명에 명시한다.

실행 전에 DuckDB의 non-executing metadata binder로 SQL의 참조 파일을 확정한다. 문자열·주석 검색으로
의존성을 판단하지 않으며 CTE scope·JOIN·중첩 SELECT를 따른다. 등록 목록과 실행 의존성은 분리한다.
참조한 입력에만 source/session/profile/mode와 cache lease를 고정한다. 무관한 파일을 닫아도 실행을
유지하고, 참조 파일의 변경·닫기·profile 교체 시 해당 진행 작업을 취소하며 이유를 표시한다.
닫기 전후 취소 검사와 시작 후 session 재검사·미공개 결과 회수로 등록 경쟁을 처리한다.
worker 종료·대기 전에 입력 lease를 해제하지 않는다. 다른 입력으로 자동 재연결하지 않는다.
상수 SQL은 내부 실행 입력0개를 허용하며, 최적화로 제거되는 참조는 보수적으로 의존성으로 유지한다.
완료된 결과는 원본 탭 닫기와 독립적이다. 결과는 자체 schema와 rN 컬럼 ID,
독립 행 순서를 가진 bounded snapshot이다. 표시 이름의 중복을 허용하되 조회·선택·복사는 ID로 구분한다.
페이지 이동·복사·내보내기는 보관된 결과를 사용한다. 새 실행이 실패·취소되면 직전 성공 결과를
유지한다. 이전 결과와 새 결과가 동시에 차지하는 공간을 모두 계산한다.

Results의 Export results는 그리드에서 선택한 셀과 무관하게 표시 중인 결과 전체를 내보낸다.
CSV·TSV는 Excel의 인코딩 감지를 위해 파일 처음에 UTF-8 BOM을 기록한다. 헤더와 UTF-8 원본 값,
CRLF 줄 끝을 사용한다. SQL NULL은 `\N`, 빈 문자열은
`""`로 기록한다. 실제 문자열 `\N`은 큰따옴표로 감싼다. Parquet는 결과의 Arrow 타입과 헤더를
보존하며 0행도 스키마를 저장한다. 파일 저장은 네이티브 대화상자에서 로컬 파일을 지정한 뒤
백그라운드에서 결과 청크를 읽어 수행한다. 기존 파일을 선택하고 덮어쓰기를 승인하면
같은 폴더에 완성된 파일을 기록한 뒤 교체한다. 쓰기 실패나 저장 중 대상 변경 시 기존 파일을
보존하고 부분 파일을 회수한다. 열린 원본, 해당 쿼리의 입력 파일, 결과 스냅샷은 교체 대상에서
제외한다. Clipboard는 헤더를 포함한 TSV로 복사하며
기존 복사 한도와 진행·취소 동작을 따른다.

Phase 23에서는 SQL Results에 파일 뷰어의 열 정렬, 다중 정렬, 타입별 필터와 Find를 연결한다.
SQL Results의 필터·정렬 버튼은 파일 뷰어와 동일한 아이콘, 크기, 활성 표시를 사용한다.
타임스탬프 필터는 24시간제 텍스트 입력이며 `YYYY-MM-DD HH:MM`과 `T` 구분자를 허용한다.
초는 선택이고 소수초는 초 뒤에 최대 9자리까지 입력할 수 있다. `Z`나 `±HH:MM` 오프셋을
입력할 때는 초를 함께 적는다. 입력은 브라우저 시간대로 변환하지 않고 타입 비교에 전달한다.
SQL Results의 `TIMESTAMP_S`는 임시 Parquet에 저장한 epoch 초와 입력 시각을 나노초 기준으로
비교한다. 소수초가 붙은 범위 경계도 그대로 적용한다.
보기 계획은 SQL 결과 스냅샷 전체에 적용한다. 필터·정렬·검색은 내부 열 ID를
사용하므로 표시 이름이 중복되어도 대상이 구분된다. 정렬 동점은 원래 결과 순서를 따르고,
Find는 필터와 정렬이 적용된 보기에서 이동할 위치를 계산한다. Find로 검색해도 보기의 행 수는 유지한다.

보기 변경은 새 첫 페이지가 준비됐을 때 표시 결과에 반영된다. 적용 중이나 실패·취소 뒤에는
마지막으로 반영된 보기를 유지한다. 보기와 페이지·찾기·복사 요청은 원래 SQL 결과 및 보기 ID에
연결한다. Results에서 전체 결과는 원래 SQL 결과를, 현재 보기는 적용된 필터와 정렬 순서를
내보낸다. 표시 페이지 범위에 관계없이 선택한 범위의 전체 행을 내보낸다.
현재 보기의 내보내기에서 SQL 결과 스냅샷과 읽어 온 Arrow 배열의 타입이 같으면 배열을 재사용한다.
DuckDB가 정수로 읽은 초 타임스탬프는 값 버퍼를 재사용해 원래 타입을 복원한다.
마이크로초로 읽은 밀리초 타임스탬프는 모든 값이 밀리초 단위로 정확히 표현될 때 복원한다.
다른 타입 불일치나 정밀도 손실은 내보내기 오류로 처리한다.

Query와 하단 출력 영역 사이에는 높이 조절 경계가 있다. 위아래 드래그, 방향키, Home/End를
지원하며 가능한 높이에서 편집기와 출력 영역의 최소 공간을 확보한다. 창 크기가 바뀌면
분할 높이를 가용 공간에 맞춘다.

SQL text≤65,536UTF8bytes, 입력1..32, alias≤128scalar/512UTF8bytes, 결과≤1,000,000행/4,096열,
live snapshot≤2, status history≤16을 초기 상한으로 둔다. 실제 기존 전체 storage 잔여량과 physical
reserve가 더 작으면 그 한도를 적용한다. 결과 상한 초과는 실패이며 hidden LIMIT이나 조용한 잘림을
허용하지 않는다. 페이지는 최대200행/64열, 응답·복사도 기존 바이트 한도와 atomic clipboard 계약을 따른다.
query temp·spill·결과·copy staging은 기존 관리 공간에 두며 cache 위치와 각 volume의 여유를 구분한다.

Settings의 `SQL temporary storage per query (GiB)`에서 SQL 작업당 spill+결과 합산 한도를 설정한다.
`sqlTempLimitBytes`는 정수64MiB~10GiB이며 기본512MiB다. 실제 허용량은 설정값·전체 관리 공간
잔여량·디스크 안전 여유 중 최솟값이며, 설정을 높여도 전체 Storage 한도를 넘지 않는다.
시작 시 한도를 snapshot하므로 변경은 새 쿼리부터 적용하고 진행 작업·기존 결과의 한도를 바꾸지 않는다.
SQL 한도는V6에서 도입했고 현재 schemaV7에 필수 필드로 저장한다. V1~V5 유효 설정은 기존 값을
보존하며512MiB를 추가하고, V6부터의 필드 누락·범위/타입 오류는 기존 손상 설정 백업·오류·복구 계약을 따른다.
GiB 입력은 기존 파서의 범위 검사 후 Math.round(bytes) 규칙을 공유한다. 메모리·시간·행 수 제한은
이 설정으로 변경되지 않는다. 초기화는 초안만0.5GiB로 되돌리고 Apply 전에는 저장하지 않는다.

사용자 SQL은 prepare 전에 DuckDB 문장 추출로 검사한다. 단일 SELECT 분류만으로 신뢰하지 않고
등록 relation과 보수적인 순수 함수 허용 목록을 검증한다. 미지원 함수는 명시적으로 거절한다.
임의 파일·네트워크·설정 변경·쓰기·확장 설치/로드를 허용하지 않으며 engine 설정을 잠근다.
같은 EXE의 SQL worker를 분리하고 취소·종료·partial 정리를 제공한다. 별도 프로세스와 DuckDB 설정이
완전한 OS sandbox라고 주장하지 않는다. 새 런타임 의존성·Tauri capability 추가는 별도 승인 대상이다.

예상 계획은 query를 실행하지 않는 EXPLAIN, 실제 분석은 한 번 실행하는 ANALYZE로 구분한다.
계획의 트리와 상세 정보는 각각 스크롤할 수 있다. 엔진이 제공하는 조건·예상/실제 행 수·시간과
원문을 표시한다. Analyze의 실측 연산자 시간은 ms와 보고된 연산자 시간 합계 대비 비중으로
표시하고 가장 오래 걸린 연산자를 강조한다. 전체 실행 시간은 별도로 표시한다. 실측치가 없거나
합계가 0이면 비중은 미제공이다.
세부 DTO·완료 조건·실행 증거는 artifacts/phase-22/에 연결하며, 현재 문단은 완료 주장이 아니다.

SQL worker의 초기 DuckDB 설정은256MiB buffer memory/2threads다. 이 값은 OS process RSS/commit
강제 상한이 아니며 Arrow·allocator·실행 파일 등의 메모리를 포함한 전체 프로세스 사용량과 구분한다.
SQL 결과 스냅샷은 연속된 엔진 배치를 파일당 최대 32,768행과 디코딩 데이터 16MiB까지 묶는다.
Parquet row group은 최대 2,048행이고, 페이지 조회는 필요한 열과 행 범위를 지정한다.
파일을 닫을 때마다 결과와 spill의 공통 임시 공간 한도를 확인한다.
Windows의 열린 spill 파일은 directory-entry 크기가 지연될 수 있으므로 임시 공간 집계는 새로운
metadata-only 핸들(FILE_READ_ATTRIBUTES, read/write/delete 공유)로 수행한다. 잠긴 DB의 데이터
읽기 권한을 요구하지 않으며 원본 alias의 정확한 file identity 제외 규칙을 유지한다.
Raw C API 오류도 공통 분류를 거쳐 임시 공간 초과는 QueryTempLimitExceeded, 실제 메모리 할당
실패는 QueryFailed, 취소는 TaskCancelled로 구분한다. 실제 부하 검증 범위와 관측 한계는
artifacts/phase-22/60-sql-stress.md에 기록하며, 모든 SQL/OS 장애 상황의 완료 검증으로 확대하지 않는다.

SQL 편집기는 CodeMirror6를 사용한다. 등록된 테이블·컬럼 metadata만으로 테이블·별칭·컬럼과
backend 허용 목록의 함수·SELECT 키워드를 제안한다. 테이블·별칭·원본 컬럼명은 단순한 ASCII
식별자([A-Za-z_][A-Za-z0-9_]*)이면서 내장 DuckDB parser 키워드가 아니면 원래 표기로 삽입한다.
그 외에는 큰따옴표로 감싸고 내부 큰따옴표를 두 번 써서 escape한다. 키워드는 내장 엔진의
kwlist를 compile-time 목록으로 동기화하며 입력 중 엔진 조회는 하지 않는다. 명시적으로 인용된
작성 SQL 전체를 다시 쓰지 않으며 자동완성으로 선택한 토큰/삽입 내용에만 적용한다.
c번호 모드는 원본 물리 순서의 cN을 삽입한다. 한 테이블에서 두 모드를 섞지 않는다.
Ctrl+Space는 명시적 후보 표시다. 후보가 열려 있으면 Enter 또는 Tab으로 적용한다.
Shift+Enter는 줄바꿈이다. Esc는 후보를 닫고 같은 토큰을
계속 쓰는 동안 재개하지 않는다. 새 토큰·점·명시 호출·모드/metadata 변경은 억제를 해제한다.
Ctrl+Enter는 커서가 속한 문장 하나를 실행한다. 이전 문장 경계 다음부터 다음 문장 끝 세미콜론
또는 편집기 끝까지 사용한다. 문자열·인용 식별자·주석 안의 세미콜론은 문장 경계에서 제외한다.
마지막 문장의 세미콜론 바로 뒤에서는 그 문장을 실행한다. 다른 빈 문장에서는 실행하지 않는다.
Run·Explain·Analyze 버튼은 편집기 전체에 단일 문장 검사를 적용한다.
Ctrl+F는 편집기 내부 검색이다. Undo/redo, 괄호 자동 닫기·짝 표시와
일반 함수의 인수 도움말을 제공한다.
Enter/Shift+Enter는 현재 줄의 수동 들여쓰기만 유지하고 SQL 키워드에 따른 추가 들여쓰기를 하지
않는다. 커서 뒤의 기존 공백/내용은 보존하며 자동 후보의 명시 선택/일반 줄바꿈 계약은 유지한다.
Query는 줄바꿈 없이 긴 행을 내부 가로 스크롤로 탐색하고, 커서·행 끝 내용과 스크롤바가 편집기
경계 밖으로 잘리지 않게 한다. 도움말을 접으면 작은 창에서도 편집기가 가용 너비를 모두 쓴다.
Tables와 선택된 테이블의 columns 사이에는 위아래 드래그 및 키보드로 높이를 바꾸는 경계를 둔다.
가능한 높이에서 Tables160px/columns180px를 보호하고 작은 가용 높이에서는 비례 축소한다.
키보드 위/아래10px, Home/End최소/최대, 더블클릭기본32%, 드래그 중 Esc/취소는 원복한다.
현재 창에서의 높이 선호를 유지하며 창 크기 변경·SQL 화면 복귀 시 가용 높이 안으로 제한한다.
입력·자동완성은 SQL/EXPLAIN을 실행하거나 백엔드를 조회하지 않는다. 후보는200개, 표시40개,
문서는64KiB UTF8, token8192개, 괄호 깊이·relation binding은 각각64개까지 처리한다.
단순 FROM/JOIN 별칭과 지역 SELECT를 지원하며 CTE·파생 테이블의 출력 컬럼 추론은 하지 않는다.
모호한 scope나 미지원 식은 잘못된 컬럼을 제안하지 않도록 보수적으로 생략한다.
함수 도움말은 작성 안내이며 overload/type 검증은 실제 실행 시 DuckDB가 담당한다.

후보 행은 이름 모드에서 컬럼명과 타입, c번호 모드에서 cN·타입·원본명1회를 표시한다.
JOIN 후보에는 짧은 추정 표시와 외래키 검증이 아니라는 안내를 두고, 매칭 근거·타입·검증되지
않은 유일성/데이터 관계는 명시적으로 펼쳤을 때 표시한다. 입력·삽입 규칙은 바꾸지 않는다.
미선언 c. 같은 별칭을 추측하지 않으며 FROM/JOIN 별칭 선언 또는 실제 등록 테이블명 뒤의 점으로
컬럼을 탐색하도록 짧게 안내한다. Examples/help의 열림 선호만 local UI storage에 저장한다.
저장 접근이 막혀도 SQL은 계속 사용할 수 있으며 SQL·파일 경로는 이 선호에 저장하지 않는다.

결과와 실행계획은 각각 요청 당시의 정확한 SQL과 테이블 binding snapshot을 보유한다.
현재 SQL/별칭/컬럼모드/소스 identity와 다르면 이전 결과·계획임을 출력 위에 표시하며,
동일한 문서·구성으로 되돌리면 현재와 일치하는 표시를 회복한다. 최신 실행의 실패·취소·실행중
상태는 이 일치 여부와 별도로 표시한다. 실행 중 편집, 첫 페이지 재시도, 실패 후 보존 결과도
완료 시점의 현재 SQL로 출처를 덮어쓰지 않는다. 자동 재실행이나 기존 독립 결과 폐기는 하지 않는다.

Settings의 SQL suggestion mode(sqlCompletionMode)는 automatic/contextual/manual 중 하나다.
기본 contextual은 FROM·JOIN 뒤와 FROM 테이블 목록의 쉼표 뒤에 테이블 후보를 자동 표시한다.
별칭 뒤 점 및 HAVING의 컬럼 후보와 JOIN ON 조건도 자동 표시한다. HAVING에는 같은 SELECT에서
AS로 선언한 고유한 출력 별칭도 추천한다. automatic은 일반 식에서도
2Unicode문자부터 후보를 표시하며 manual은 Ctrl+Space로 후보를 연다.
schemaV7은 해당 필드를 필수로 저장하며 유효V1~6은 기존 저장공간·복사·표시 설정을 보존하고
contextual을 추가한다. 현재 필드 누락·잘못된 enum은 Rust/TS 모두 거부하며 공통 fixture로 검사한다.

JOIN 후보는 현재 ON의 오른쪽 테이블과 앞선 입력의 원본 컬럼명을 ASCII casefold로 정확히
비교한다. 공백은 trim하지 않으며 동일 테이블의 중복 원본명·중복 별칭·미해석 CTE/파생 입력을
추천에서 제외한다. 두 테이블의 실제 physical index로 cN을 삽입하고 원본 이름과 별칭은 escape한다.
integer끼리, float끼리, text끼리와 동일 decimal precision/scale·동일 temporal SQLtype만 호환으로
취급한다. integer/float/decimal 혼합·timezone 혼합·boolean/blob/complex/unknown은 제안하지 않는다.
id/name/status/type/value/amount/total/created_at/updated_at은 수동 호출에서만 낮은 순위로 보인다.
현재 범위는 ON 직후 빈 영역/단일 prefix이며 AND 복합 조건·기존 predicate 자동 교체는 하지 않는다.
모든 조건은 이름·타입 기반 추정으로 표시하고 실제 외래 키·유일성을 보장하지 않으며 자동 삽입하지 않는다.
