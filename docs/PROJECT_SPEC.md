# 프로젝트 상세 명세

이 문서는 CSV, Parquet와 Phase 11의 OEF H5 v3 확장, Phase 12의 대용량 query·복사와 grid 작업 흐름 안정화를
포함한 데스크톱 뷰어의 상세 제품 요구사항과 기술 계약을 정의한다.
구현 순서와 단계별 완료 조건은 `docs/DEVELOPMENT_PLAN.md`를 따른다.

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
list, struct, map 값을 지원한다. 중첩 값은 구조를 잃지 않는 일관된 축약 표현으로 표시하고,
전체 값을 확인할 수 있는 방법을 제공한다.

## 6. CSV 규칙

CSV는 줄 단위 문자열 분리로 파싱하지 않고 Rust `csv` crate를 사용한다. 따옴표로 감싼
delimiter, 줄바꿈, escape 문자, 빈 필드를 올바르게 처리한다.

파일을 빠르게 열 수 있도록 preview를 먼저 반환한다. 전체 행 수와 랜덤 접근용 위치
index는 필요할 때 백그라운드에서 계산하며 진행 상태와 취소를 제공한다. 위치 index는
크기를 제한하고 가장 가까운 checkpoint에서 파싱을 재개할 수 있어야 한다.

CSV session이 열리거나 profile generation이 바뀌면 canonical path, header mode와 profile snapshot을
identity로 하는 재사용 가능한 prepared source를 백그라운드에서 만든다. 준비 중에는 preview와 기존
direct page를 막지 않고, Ready 이후 page, query, copy와 경계 탐색은 같은 typed/raw/invalid 정보를 가진
prepared artifact를 재사용한다. 진행 행 수·경과 시간과 취소를 제공하고 실패·취소 시에는 이유를 남긴 채
direct source로 안전하게 fallback한다. session 교체, tab close, process 종료와 crash janitor는 artifact와
작업을 정리하며 다른 generation이나 process의 artifact를 재사용하거나 삭제하지 않는다. 연속 page와
copy는 거대한 row ID `IN (...)` 목록을 만들지 않고 bounded contiguous range로 조회한다.

UTF-8과 UTF-8 BOM을 기본 지원한다. 지원하지 않는 encoding은 깨진 문자열로 표시하지
말고 명확한 오류를 반환한다. 다른 encoding 지원은 별도 요구사항으로 추가한다.

header 존재 여부는 preview를 사용해 제안하되 사용자가 바꿀 수 있어야 한다. 원문 문자열은
항상 보존한다. 전역 기본 열기 모드는 `Auto`, `All Text`, `Ask Every Time`이며 초기값은 Auto다.
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
제공한다. header click과 Shift+header click은 모두 해당 단일 컬럼의 같은 sort cycle로 동작하며
다중 기준 변경은 criteria editor의 Apply에서만 ordered plan으로 commit한다. 실행 의미는 항상 typed
column filter로 row 집합을 정한 뒤 multi-sort로 순서를
정하고 Find로 위치를 탐색하는 순서다. filter→sort와 sort→filter의 최종 plan이 같으면 결과도 같다.

1,000만 행 저·고카디널리티 데이터에서도 전체 UI row를 materialize하지 않는다. memory budget을
넘는 sort/query는 bounded temporary disk spill을 사용할 수 있다. query engine은 동일 fixture의
DataFusion, DuckDB/direct spike 후 선택하고 신규 runtime dependency는 사용자 승인 뒤 추가한다.

temporary data는 Tauri가 resolve한 app-local-data 아래 process/document/query별 경로를 사용한다.
기본 process hard cap은 10 GiB이며 기본 5 GiB의 디스크 안전 여유 공간을 별도 보존한다. volume
크기의 비율을 query가 필요로 하는 byte처럼 표시하지 않는다. UI와 wire DTO는 가능한 예상 임시
데이터, 안전 여유와 hard cap을 서로 구분한다. 완료, 실패,
취소, 교체와 tab close 시 정리하고 owner lock을 사용해 다른 active process의 파일을 삭제하지 않는다.
crash orphan은 다음 startup janitor가 lock 획득 가능한 directory만 정리한다.

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
- query temp와 settings는 Tauri app directory에만 쓰고 source/exe directory에는 쓰지 않는다.

## 14. 향후 범위

aggregation, group by, join, pivot와 SQL editor는 별도 요구사항이 승인된 경우에만 추가한다.
runtime reader plugin과 query 결과의 persistent reusable cache는 현재 범위가 아니다.

Phase 11 OEF H5 v3 계약 밖의 일반 HDF5는 별도 데이터 소스로 다룬다. 한 파일의 여러 dataset을 위한
`multipleDatasets` capability와 선택 UI, axis dataset paging, OES query provider는 각각 별도
요구사항과 fixture가 승인된 경우에만 추가한다. Excel도 같은 방식으로 sheet 선택 계약을 먼저
정의한다.
