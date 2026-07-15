# Phase 9 UX 설계

- 상태: 구현 기준 확정
- 제품 계약: `00-scope.md`
- 테스트 계약: `10-test-plan.md`
- 공통 UI 검증: `docs/UI_VALIDATION.md`

## 1. 설계 원칙

Phase 9 UI는 데이터 작업 화면의 밀도와 예측 가능성을 유지한다. 설정 화면을 marketing card처럼
구성하지 않고 grid, toolbar, menu, segmented control과 dialog를 사용한다. 모든 query는 현재
page가 아닌 전체 source/result를 대상으로 하므로 진행 상태와 취소를 항상 같은 위치에서 제공한다.

- 문서별 query/profile 상태를 tab 간에 섞지 않는다.
- 화면에 보이는 값만 처리한 것처럼 오해하게 하는 표현을 사용하지 않는다.
- destructive data action은 없으며 원본 파일은 계속 read-only다.
- icon button은 Lucide icon, accessible name과 tooltip을 함께 사용한다.
- 상태는 색상만으로 표현하지 않고 icon, label 또는 pattern을 함께 사용한다.
- 800x600에서도 primary command, 취소와 오류 원인을 접근할 수 있어야 한다.

## 2. Main toolbar와 문서 상태

기존 문서 tab과 Data/Schema/Metadata view 구조를 유지한다. Data view toolbar에는 다음 순서로
명령을 배치한다.

1. Open files
2. Copy split button
3. CSV Parsing Profile: 활성 source가 `parsingProfile` capability를 가질 때만 표시
4. Global search
5. Query progress/cancel
6. Settings

공간이 부족하면 검색 폭을 먼저 줄이고 secondary label을 menu로 이동한다. 문서 tab, view tab과
toolbar를 여러 줄로 감싸지 않는다. 현재 파일 요약에는 registry descriptor의 display name을 사용하며
CSV/Parquet 삼항 연산을 사용하지 않는다.

활성 문서에는 다음 상태 중 하나를 표시한다.

- `Ready`
- `Analyzing CSV types`
- `Filtering`, `Searching`, `Sorting`
- `Cancelling`
- `Query failed`

비활성 문서의 진행/오류는 tab의 고정 폭 status icon으로 표시한다. 활성 query가 바뀌어도 tab 폭은
변하지 않는다.

## 3. Copy 설정

### 3.1 실행 위치

Copy는 icon+label split button을 사용한다. 주 button은 현재 preset으로 바로 복사하고 chevron은
다음 menu를 연다.

- Copy
- Copy with column headers
- preset: Excel, TSV, CSV, Custom
- Copy settings

`Ctrl+C`와 셀 context menu는 현재 preset을 사용한다. menu에서 preset을 고르면 복사를 즉시
시작하지 않고 이후 copy 기본값만 변경한다. 현재 preset 이름은 tooltip과 menu check로 확인한다.

### 3.2 설정 dialog

dialog 상단은 Excel/TSV/CSV/Custom segmented control이다. Custom에서만 상세 control을 활성화한다.

- delimiter menu와 custom 한 문자 input
- header checkbox
- quote mode menu
- quote character input
- escape menu
- CRLF/LF segmented control
- null, empty string, Boolean, date/timestamp 표현 menu/input

하단에는 최대 20행/64KiB의 read-only monospace preview를 표시한다. 실제 serializer 결과를 사용하고
별도 예제 serializer를 만들지 않는다. null과 empty가 같은 출력이 되거나 no-quote가 구조를 보존하지
못하면 preview 위 inline warning을 표시한다. 구조가 손상되는 조합은 Apply를 disabled 처리하고 원인을
연결한다.

`Cancel`, `Apply`를 오른쪽 아래에 둔다. Apply는 전역 설정을 atomic 저장하며 이미 진행 중인 copy에는
영향을 주지 않는다.

## 4. CSV 기본 열기 설정

Settings dialog의 CSV section에 `Default parsing mode` segmented control을 둔다.

- Auto
- All Text
- Ask Every Time

초기값은 Auto다. 도움말 문단을 화면에 상시 늘어놓지 않고 각 option의 tooltip/description line에
동작을 짧게 표시한다. 변경은 이후 여는 CSV에만 적용하며 열린 tab을 다시 parsing하지 않는다.

열린 CSV의 file summary에는 `Auto`, `All Text`, `Custom` 상태를 표시한다. `CSV Parsing Profile`
명령은 toolbar와 document menu에 두며 column별 설정이 필요한 기능이더라도 특정 column menu에만
숨기지 않는다.

## 5. CSV Parsing Profile 화면

### 5.1 Container와 layout

profile은 문서 범위 modal dialog로 열되 1024px 이상에서는 workspace 대부분을 사용하고, 800x600에서는
window inset 8px 안의 full-size dialog가 된다. card를 중첩하지 않고 다음 세 band로 구성한다.

1. title, 현재 mode, 전체 파일 검증, close
2. column 설정 grid와 bulk toolbar
3. sample preview grid, validation summary, Cancel/Apply

desktop에서는 설정 grid와 sample preview를 위/아래 resizable split로 두고, minimum viewport에서는
고정 최소 높이와 독립 scroll을 사용한다. dialog 전체가 이중 scroll되지 않게 한다.

### 5.2 Column 설정 grid

고정 column은 checkbox, 컬럼명, sample, 추천 타입/confidence, 설정 타입, 상태다. 256개 이상의
컬럼에서도 row virtualization을 사용한다.

- click: 단일 선택
- Ctrl+click: 개별 추가/제거
- Shift+click: anchor 범위
- Ctrl+A: 설정 grid에 focus가 있을 때 현재 filter 결과 전체
- header checkbox: 현재 filter 결과 전체 선택/해제

상단 search input은 column name을 검색한다. 옆 menu에서 추천 타입, 현재 타입, invalid 유무로
필터한다. `12 of 256 selected`처럼 선택 수와 전체 수를 함께 표시한다.

선택이 있을 때 bulk toolbar를 활성화한다.

- Type menu
- Null tokens
- Number/date format
- Failure policy
- Copy settings from active column
- Reset to inferred
- Undo

서로 다른 값은 control에 `Mixed`를 표시한다. 사용자가 Type만 바꾸면 다른 field를 덮어쓰지 않는다.
Undo는 마지막 bulk operation 단위로 되돌리며 profile dialog를 닫을 때 history를 폐기한다.

### 5.3 Sample preview

sample grid 위에는 Raw/Converted segmented control과 sample 성공/invalid/null 수를 둔다. header에는
`Int64 -> Text`처럼 추천 타입과 설정 타입이 다를 때만 전이를 표시한다.

- null: `NULL` label과 muted style
- invalid: warning icon, 원문 display와 오류 tooltip
- bulk 변경 column: header의 changed marker
- conversion pending: 기존 값을 지우지 않고 header spinner

설정 변경은 200ms debounce한다. 이전 generation이 취소되는 동안 새 setting은 즉시 control에 보이되
preview에는 `Updating preview`를 표시한다. 늦은 결과는 보여주지 않는다.

### 5.4 전체 파일 검증

`Validate entire file`은 toolbar command다. 실행 중에는 rows/bytes progress, elapsed time과 Cancel을
표시한다. sample preview는 계속 탐색할 수 있다.

완료 summary는 전체 성공/invalid 수와 컬럼별 표를 제공한다. 컬럼 row를 선택하면 최초 오류 row와
최대 20개 대표 원문을 표시한다. 모든 오류값을 UI에 적재하지 않는다.

검증을 하지 않아도 Apply할 수 있다. invalid가 있으면 확인 dialog에서 건수와 failure policy를
보여주며, 구조 parser 오류는 Apply를 막는다. 기본 `invalid 원문 보존`은 원문을 유지하고 null과
다른 상태로 표시한다.

### 5.5 Apply와 복원

Apply 중 dialog를 바로 닫지 않고 새 session prepare progress를 표시한다. 성공하면 dialog를 닫고
새 schema/query를 반영한다. 실패하면 기존 document를 유지한 채 dialog에 오류를 표시한다.

호환되지 않는 filter/sort가 있으면 적용 후 query bar에 disabled condition과 이유를 표시한다.
가능한 scroll/selection 복원이 실패한 경우 오래된 선택을 유지하지 않고 첫 visible cell로 focus를
옮긴다. Cancel은 기존 session/query/selection에 아무 변경도 만들지 않는다.

## 6. Column filter와 sort

### 6.1 Column header

각 header 오른쪽에 좁은 고정 영역을 예약한다.

- filter 활성 여부: Funnel icon
- sort: ArrowUp/ArrowDown icon
- multi-sort priority: 작은 숫자
- column menu: MoreVertical icon

상태 icon이 생겨도 header text와 column width가 움직이지 않는다. filter/sort icon button에는 tooltip과
accessible name이 있다.

header의 sort button click은 ascending, descending, clear를 순환한다. Shift+click은 기존 sort를
유지하며 해당 column을 추가/변경한다. Shift가 없으면 단일 sort로 교체한다. null은 양 방향 모두
마지막이다.

### 6.2 Filter popover

popover는 column type에 맞는 operator만 제공한다. operator menu, value editor, Apply/Clear로 구성하며
number/date range는 start/end input을 명시적으로 분리한다.

distinct value section은 검색 input과 page list를 사용한다. 전체 distinct 값을 한꺼번에 불러오지
않으며 loading, 더 불러오기, error 상태가 있다. 여러 선택 값은 같은 column 안에서 OR다.

popover는 viewport 네 변에서 8px 안으로 flip/clamp하고 grid scroll, tab switch, profile apply 시 닫는다.
Escape는 draft를 버리고 header focus를 복원한다. Apply 후 query가 시작되며 popover를 닫는다.

## 7. Query bar와 검색

Data view 상단 query bar에는 활성 filter condition을 한 줄 목록으로 표시한다. 각 condition에는 column,
operator, 축약한 value, remove icon이 있으며 전체 Clear command를 제공한다. 공간이 부족하면 `+N filters`
menu로 접되 활성 조건을 숨기지는 않는다.

Global search는 다음 control을 가진다.

- search input
- Find / Filter segmented mode
- case-sensitive toggle
- exact toggle
- target column menu
- previous/next result button: Find mode에서만

기본 대상은 현재 표시 중인 scalar column 전체다. hidden, binary와 nested column은 제외하고 target
menu에서 제외 이유를 표시한다. regex는 노출하지 않는다.

입력은 debounce하며 이전 query를 취소한다. Find는 현재 result를 줄이지 않고 match 위치로 이동하고,
Filter는 일치 행만 새 query result로 만든다. 결과 수가 계산 중이면 `Scanning... 12 matches`처럼 부분
수임을 명확히 표시한다.

## 8. Query progress, selection과 오류

query 시작 시 기존 result를 즉시 비우지 않는다. toolbar/status bar에 진행 상태를 표시하고 새 result가
commit될 때 한 번에 교체한다. commit 시 이전 result 좌표의 selection은 지워 잘못된 데이터를 복사하지
않고 첫 visible cell에 focus한다.

오류 유형별 동작은 다음과 같다.

- invalid filter literal: popover 안 field error, query 시작 안 함
- query engine 오류: 기존 result 유지, document banner와 Retry
- cancel: 기존 result 유지, `Cancelled` status 후 Ready
- disk 부족/cap 초과: 해당 query만 실패, 필요한 공간과 현재 temp 사용량 표시
- stale result: 사용자에게 오류를 보이지 않고 폐기, diagnostic log만 기록

query result가 0행이면 grid 안에 `No rows match the current query`와 Clear filters 명령을 표시한다.

## 9. Temporary data 설정

Settings의 Storage section에는 다음을 표시한다.

- 현재 앱 temp 사용량
- process query temp limit: 기본 10 GiB
- 최소 여유 공간 정책: `max(5 GiB, disk의 10%)`
- `Clear temporary files` icon+text command

Clear는 활성 query 파일을 삭제하지 않는다. 완료 후 삭제 byte와 삭제하지 못한 orphan 수를 표시한다.
사용자에게 실제 내부 경로 입력을 요구하지 않고 Tauri가 resolve한 app-local-data 위치를 read-only로
표시할 수 있다.

## 10. Format capability와 generic metadata

frontend는 supported format descriptor를 시작 시 받고 format display name과 capability를 사용한다.

- `parsingProfile`: CSV profile command
- `rowGroups`: row-group metadata section
- `multipleDatasets`: 미래 dataset selector 진입점
- 전용 renderer 없음: common file/schema metadata와 generic key/value/table section

새 format이 추가돼도 empty workspace, drop target과 오류 문구에 CSV/Parquet를 직접 나열하지 않고
registry의 표시 목록을 사용한다. 목록이 길면 `Supported formats` dialog로 연결한다.

## 11. Keyboard와 접근성

- profile 설정 grid와 data grid는 서로 다른 focus/selection scope다.
- input, select, menu, dialog에 focus가 있으면 data grid shortcut을 실행하지 않는다.
- dialog는 focus trap을 사용하고 close 후 실행한 toolbar command로 focus를 복원한다.
- popover/menu는 Arrow, Home/End, Enter/Space, Escape와 Tab 이동을 지원한다.
- progress는 `role=status`, blocking 오류는 `role=alert`를 사용하되 매 row마다 live announcement하지 않는다.
- invalid cell은 icon과 accessible text를 함께 제공한다.
- sort direction/priority, filter active, Mixed와 disabled reason을 접근성 tree에 전달한다.

## 12. Responsive와 시각 검증 상태

필수 viewport와 대표 screenshot 상태는 다음과 같다.

| Viewport | 필수 상태 |
| --- | --- |
| 1440x900 | profile bulk selection+preview, 3-column sort+filters |
| 1024x768 | validation progress, filter popover near right/bottom edge |
| 800x600 | full-size profile dialog, query bar overflow, disk error |

모든 viewport에서 toolbar, document tabs, view tabs, query bar, grid, status bar가 겹치지 않아야 한다.
profile의 두 grid는 각각 stable height와 scroll surface를 갖고 content 때문에 dialog가 viewport 밖으로
커지지 않는다. screenshot은 Quality Agent가 이미지로 열어 겹침, 잘림, 정보 밀도, focus/invalid/sort
구분을 독립 검토한다.
