# 프로젝트 상세 명세

이 문서는 CSV와 Parquet 데스크톱 뷰어의 상세 제품 요구사항과 기술 계약을 정의한다.
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
내보내기, HDF5 지원을 포함하지 않는다.

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
- `execute_query`/`read_query_page`: 문서, source와 query generation을 검증하고 전체 결과의
  제한된 page를 반환
- `close_document`: 해당 문서의 handle, index, cache, worker, 진행 작업 해제

문서 탭 수명의 `documentId`와 source generation의 `sessionId`를 분리한다. 모든 데이터 command는
두 ID를 확인하며 닫힌 문서, 교체 전 generation, 다른 문서의 늦은 결과를 적용하지 않는다.
백엔드는 여러 문서를 소유하는 `DocumentRegistry`를 사용하되 registry lock을 잡은 채 파일 I/O,
decode, worker join을 수행하지 않는다.

열린 문서는 프로세스당 64개, 동시 source prepare와 CSV worker는 각각 4개로 제한한다. page
cache는 문서당 8 pages, 프로세스 전체 64 pages 또는 추정 256 MiB 중 먼저 도달하는 상한을
사용한다. cache는 LRU로 회수할 수 있지만 열린 문서 탭은 자동 퇴출하지 않는다.

CSV와 Parquet는 compile-time format registry와 공통 tabular source 인터페이스 뒤에 둔다.
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

UTF-8과 UTF-8 BOM을 기본 지원한다. 지원하지 않는 encoding은 깨진 문자열로 표시하지
말고 명확한 오류를 반환한다. 다른 encoding 지원은 별도 요구사항으로 추가한다.

header 존재 여부는 preview를 사용해 제안하되 사용자가 바꿀 수 있어야 한다. 원문 문자열은
항상 보존한다. 전역 기본 열기 모드는 `Auto`, `All Text`, `Ask Every Time`이며 초기값은 Auto다.
열린 뒤에도 document 범위의 CSV Parsing Profile에서 컬럼 타입을 변경할 수 있다.

profile은 Auto, Text, Boolean, Int64, UInt64, Float64, Decimal, Date, Timestamp, Skip을 지원한다.
설정 grid에서 Ctrl/Shift 다중 선택, filter 결과 전체 선택, bulk apply와 undo를 제공한다. 변경 전
최대 1,000행 sample preview와 취소 가능한 전체 파일 검증을 제공한다. 변환 실패 기본값은 원문을
보존하는 invalid 상태이며 source null과 구별한다. profile 적용은 새 sessionId를 만들고 이전
cache/query를 무효화하지만 원본 파일을 수정하지 않는다. 첫 구현은 profile을 session에만 유지한다.

bulk 설정은 선택 컬럼의 유효 타입에 적용되는 항목만 표시한다. Text에는 숫자·Boolean·시간 설정을
표시하지 않고, 정수에는 Thousands separator만, Float64/Decimal에는 Decimal과 Thousands
separator를, Boolean에는 true/false token을, Date/Timestamp에는 temporal 설정을 표시한다. 단일
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

Data view에는 capability에 따라 copy 설정, CSV Parsing Profile, column filter/sort와 global
search를 제공한다. 전체 query의 진행 상태와 취소는 활성 문서에 귀속한다. query가 commit되면
이전 result 좌표의 selection을 지워 다른 행을 잘못 복사하지 않게 한다.

각 문서 탭은 활성 뷰, page와 scroll, selection, 컬럼 폭·숨김·검색, loading/error 상태를
독립적으로 보존한다. 활성 문서 탭을 닫으면 오른쪽 이웃, 없으면 왼쪽 이웃을 활성화하며
마지막 탭을 닫으면 empty workspace로 돌아간다. 문서 탭은 한 줄을 유지하고 좁은 화면에서는
가로 overflow control을 제공한다. `Ctrl+Tab`, `Ctrl+Shift+Tab`으로 문서를 전환하고
`Ctrl+W`로 활성 문서를 닫는다.

그리드는 안정적인 크기와 고정 header를 사용한다. 행이나 컬럼이 로드되고 hover, 선택,
로딩 상태가 바뀌어도 주변 레이아웃이 움직이지 않아야 한다. 긴 값은 셀을 무제한 확장하지
않고 잘라 표시하며 전체 값 확인 수단을 제공한다.

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
- `Ctrl+화살표`로 현재 데이터 영역의 다음 경계로 이동
- `Ctrl+Shift+화살표`로 다음 경계까지 선택 범위 확장
- `Home`, `End`, `PageUp`, `PageDown`으로 표준 그리드 이동
- 행 또는 컬럼 header 클릭으로 해당 행 또는 컬럼 선택
- `Ctrl+A`로 현재 데이터 테이블 전체 선택
- `Escape`로 확장 범위를 해제하고 active cell만 유지

`Ctrl+화살표`는 현재 셀이 비어 있지 않으면 연속된 값 영역의 끝으로, 비어 있으면 다음
값이 있는 셀 또는 테이블 경계로 이동한다. 아직 로드하지 않은 데이터가 필요하면 제한된
범위로 백엔드에 요청한다.

macOS에서는 `Ctrl` 기반 명령에 해당하는 `Command` 동작을 함께 제공한다. 키보드 이벤트는
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

`Ctrl+C`는 현재 선택 범위의 표시 값을 활성 copy preset으로 시스템 클립보드에 기록한다.
초기 preset은 Excel이며 TSV, CSV와 Custom을 제공한다. Excel이나 다른 스프레드시트에
붙여넣었을 때 같은 직사각형 구조가 유지되어야 한다.

- Excel/TSV는 tab, CSV는 comma, Custom은 한 문자의 delimiter를 사용한다.
- delimiter, 줄바꿈, 따옴표가 든 값은 선택한 quote/escape 규칙으로 직렬화한다.
- header를 명시적으로 선택한 경우에만 header를 포함한다.
- null과 빈 문자열을 구별할 수 있는 내부 모델을 유지한다.
- 보이는 DOM 셀이 아니라 논리 선택 범위를 복사한다.

설정 preview는 실제 serializer를 사용한다. 구조를 보존할 수 없는 no-quote 조합은 실행하지 않는다.
Excel/TSV 기본은 null과 empty를 빈 cell로 출력하며 구별 손실을 preview에 알린다. CSV/Custom
기본은 null `NULL`, empty `""`, 실제 문자열 `NULL`은 quoted `"NULL"`로 구별한다. 설정은 앱
전역에 atomic 저장되며 이미 시작한 copy는 시작 시점 snapshot을 사용한다.

아직 읽지 않은 페이지는 백엔드에서 제한된 chunk로 가져온다. 큰 선택 범위에는 예상 셀
수와 크기를 알리고 진행 상태와 취소를 제공한다. 소프트 제한을 넘으면 사용자 확인을 받고,
하드 제한을 넘으면 무제한 메모리 사용을 시도하지 말고 제한을 설명한다. 구체적인 제한값은
성능 측정 후 설정하고 테스트로 고정한다.

MVP는 읽기 전용이므로 뷰어에 값을 붙여넣어 원본 데이터를 변경하지 않는다. 여기서
붙여넣기 지원은 뷰어에서 복사한 TSV를 Excel 등의 다른 애플리케이션에 붙여넣을 수 있다는
의미다.

## 11. 전체 파일 filter, search와 sort

filter, search와 sort는 현재 page가 아니라 전체 source 또는 현재 query result 전체를 대상으로 한다.
typed filter는 Text, number/decimal, date/timestamp, Boolean과 null/invalid에 맞는 operator만 제공한다.
여러 컬럼은 AND, 같은 컬럼의 여러 값은 OR로 결합한다.

global search 기본 대상은 현재 표시 중인 scalar 컬럼 전체이며 사용자가 컬럼을 제한할 수 있다.
기본은 case-insensitive contains이고 exact와 case-sensitive option을 제공한다. regex, binary와 nested
global search는 첫 구현에서 제외한다. Find navigation과 match-only Filter는 서로 다른 동작으로
표시한다.

sort는 ascending, descending, clear와 Shift 기반 multi-column sort를 제공한다. 같은 값은 원본 row
identity를 tie-breaker로 사용해 안정 정렬하며 null은 양 방향 모두 마지막이다. query 결과는
`documentId`, `sessionId`, `queryId`로 격리하고 늦은 결과를 폐기한다.

1,000만 행 저·고카디널리티 데이터에서도 전체 UI row를 materialize하지 않는다. memory budget을
넘는 sort/query는 bounded temporary disk spill을 사용할 수 있다. query engine은 동일 fixture의
DataFusion, DuckDB/direct spike 후 선택하고 신규 runtime dependency는 사용자 승인 뒤 추가한다.

temporary data는 Tauri가 resolve한 app-local-data 아래 process/document/query별 경로를 사용한다.
기본 process hard cap은 10 GiB이며 `max(5 GiB, volume의 10%)` 여유 공간을 보존한다. 완료, 실패,
취소, 교체와 tab close 시 정리하고 owner lock을 사용해 다른 active process의 파일을 삭제하지 않는다.
crash orphan은 다음 startup janitor가 lock 획득 가능한 directory만 정리한다.

Phase 9 query engine은 DuckDB Rust `1.10504.0`의 `bundled`, `parquet`, `vscalar` 기능을 사용한다.
연결은 in-memory이며 persistent database를 만들지 않는다. spill만 위 app-local-data 임시 경로를
사용한다. case-insensitive 비교는 제품의 scalar lowercase UDF를 사용하고 Unicode 정규화는 하지
않는다. 새 입력 형식은 `FormatRegistry` handler와 선택적 query provider로 추가하며 query executor
핵심에 형식별 분기를 추가하지 않는다.

## 12. 보안과 안정성

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

## 13. 향후 범위

aggregation, group by, join, pivot와 SQL editor는 별도 요구사항이 승인된 경우에만 추가한다.
runtime reader plugin과 query 결과의 persistent reusable cache는 현재 범위가 아니다.

HDF5는 registry의 별도 데이터 소스 구현으로 추가한다. 한 파일의 여러 dataset을 위한
`multipleDatasets` capability와 선택 UI가 필요하다. 네이티브 HDF5 라이브러리의 설치와 배포
영향을 검증하기 전에는 의존성을 추가하지 않는다. Excel도 같은 방식으로 sheet 선택 계약을
먼저 정의한다.
