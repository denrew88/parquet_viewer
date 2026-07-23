# Phase 12 후속 요청

- 작성 시작일: 2026-07-22
- 상태: 구현 전
- 목적: Phase 12 완료 뒤 발견되거나 추가로 합의한 요청을 기존 완료 기록과 분리해 누적한다.

## 1. 필터·정렬 결과의 `Ctrl+Up/Down` 경계 탐색 가속

### 1.1 문제

현재 필터·정렬된 query 결과에서 nullable 또는 string 컬럼의 세로 `Ctrl+Arrow` 경계를 찾을 때
화면 page와 같은 200행 단위 조회를 반복한다. 5,850,000행에서 경계가 멀거나 빈 셀이 없으면 최대
약 29,250개의 position block과 source sparse read가 발생할 수 있다.

빈 셀 판정 자체보다 작은 block을 반복해서 조회하는 비용이 병목이다. Parquet row-group 통계가 없거나
사용할 수 없는 경우에도 correctness와 실용적인 성능을 만족해야 하며, 통계는 선택적인 fast path일 뿐
필수 조건으로 삼지 않는다.

### 1.2 확정 방향

필터·정렬 query의 세로 경계 탐색에 다음 두 최적화를 함께 적용한다.

1. grid page의 200행 API와 분리된 occupancy 전용 대용량 batch 경로를 사용한다.
2. 읽은 점유 상태를 query logical position 기준의 지연 생성 비트맵에 누적한다.

첫 조회는 가까운 경계를 불필요하게 크게 읽지 않도록 작은 block으로 시작하고, 경계가 없으면
점진적으로 키운다. 초기 후보는 `256 → 4,096 → 16,384 → 65,536`행이며, 실제 상한과 단계는
5.85M low/high-cardinality fixture의 release 측정으로 확정한다. 상한에 도달한 뒤에는 계속 배수로
증가시키지 않고 최대 block 크기인 65,536행씩 반복한다. 따라서 5.85M행 전체에 경계가 없는 최악의
경우에도 약 90개의 큰 block을 조사하며, 기존 200행 page 약 29,250회 왕복을 만들지 않는다.

한 번에 읽는 것은 활성 컬럼 하나뿐이고 다음 두 hard cap을 함께 적용한다.

- row cap: block당 최대 65,536행 후보
- estimated decoded byte cap: block당 8~16 MiB 후보

긴 문자열처럼 byte cap에 먼저 도달하는 입력은 row cap보다 작은 block으로 끝낸다. 각 block 사이에서
cancellation, session/query generation과 source lifetime을 확인해 오래된 탐색이 다음 block을 시작하거나
현재 문서의 결과를 덮어쓰지 못하게 한다. 정확한 row/byte cap은 release benchmark로 확정하되 어떤
경우에도 무제한으로 증가시키지 않는다.

화면에는 scan block을 전달하지 않는다. backend는 최종 target logical row만 반환하고 frontend는 기존처럼
target page만 최대 한 번 조회한다.

### 1.3 필터·정렬 순서와 비트맵 좌표

비트맵 index는 원본 source row ID가 아니라 최종 `query_result.rowid` 순서에 대응한다.

```text
query logical position: 0  1  2  3
source row ID:          40 12 91  7
known:                   1  1  1  1
occupied:                1  1  0  1
```

필터에서 제외된 source row는 비트맵에 존재하지 않는다. 단일·다중 정렬의 source row ID가 파일 전체에
흩어져 있어도 provider가 요청 순서를 복원한 뒤 해당 logical position에 비트를 기록한다. 따라서 선택,
복사와 `Ctrl+Arrow`가 모두 같은 필터 결과와 정렬 순서를 사용한다.

부분적으로만 조사한 컬럼은 두 packed bitmap으로 표현한다.

- `known`: 해당 logical position을 이미 조사했는지
- `occupied`: 조사한 셀이 값이 있는 상태인지

탐색 중 known 영역에서는 word 단위 bit scan으로 다음 상태 전환을 찾고, unknown 영역에 도달했을 때만
다음 adaptive block을 읽는다. 새로 읽은 결과는 버리지 않고 같은 cache에 채운다. 빈 셀이 없는 컬럼을
처음 끝까지 탐색하면 그 한 번으로 해당 방향 범위의 index가 완성되며, 이후 탐색은 source를 다시 읽지
않는다.

### 1.4 빈 셀 의미

비트맵은 display 문자열이 아니라 source/query의 `DataValueState` 의미로 생성한다.

- 모든 타입의 null은 빈 셀이다.
- string의 빈 문자열 `""`은 빈 셀이다.
- whitespace-only string은 값이 있는 셀이다. CSV trim 설정이 켜진 경우에는 적용된 profile 의미를 따른다.
- 숫자 `0`, Boolean `false`, NaN, 빈 binary와 invalid 값은 값이 있는 셀이다.
- 표시 형식 변경은 점유 여부를 바꾸지 않는다.

현재 셀과 이웃 셀의 상태에 따른 Excel transition rule은 유지한다. 값 영역에서는 첫 빈 셀 직전으로,
빈 영역에서는 다음 값이 있는 셀로 이동한다.

### 1.5 Cache 수명과 자원 상한

cache key에는 최소한 다음 identity가 포함되어야 한다.

```text
document + session + query generation + column ID + value-semantics generation
```

다음 경우에는 관련 비트맵을 폐기한다.

- 필터, 단일·다중 정렬 또는 query 교체
- CSV null token, trim, target type 같은 빈 셀 의미 변경
- session/profile 변경, 파일 reload 또는 tab close

column 표시 순서·너비·visibility와 timestamp 등 display format 변경만으로는 폐기하지 않는다.

5,850,000행에서 `known + occupied` 두 bitset은 컬럼당 약 1.4 MiB다. cache는 사용한 컬럼에 대해서만
지연 생성하고, query별 컬럼 수와 프로세스 전체 byte를 LRU 상한으로 제한한다. 초기 비교 후보는 최근
8개 컬럼 또는 동등한 byte cap이며 release RSS 측정 후 확정한다.

### 1.6 적용 범위

- 대상: 필터·정렬 query 결과의 세로 `Ctrl+Up/Down`과 Shift 조합
- `Ctrl+Alt+Up/Down`: row count를 사용하는 절대 이동이므로 비트맵을 사용하지 않는다.
- `Ctrl+Left/Right`: 현재 logical row 한 개의 visible projection만 읽는 별도 경로를 유지한다.
- direct Parquet의 기존 fast path와 H5의 메모리 resident axis 경로는 회귀시키지 않는다.

### 1.7 구현 전 검증 항목

구현 전에 현재 200행 반복 횟수와 cold latency를 같은 5.85M fixture로 기록한다. 구현 뒤에는 다음을
독립적으로 확인한다.

- filter-only, sort-only, filter+다중 정렬에서 logical boundary 정확성
- null, empty string, whitespace, invalid와 non-null numeric 의미
- cold 첫 탐색의 block 증가와 source read 횟수
- 같은 컬럼·범위 cache hit에서 source read 0
- 다른 위치에서 시작한 부분 index 병합
- query/profile/session 교체 뒤 stale bitmap 사용 0
- Ctrl 및 Ctrl+Shift target, selection anchor와 focus visibility
- target 이외 intermediate page IPC 0
- cancellation latency, bitmap LRU byte cap과 lifecycle cleanup
- 5.85M low/high-cardinality cold latency, warm latency, RSS와 decoded rows/bytes

정확한 batch 단계와 cache byte cap은 위 측정을 근거로 확정하며, timeout을 늘리는 방식으로 성능 실패를
숨기지 않는다.

## 2. 파일 탭·컬럼의 직접 drag reorder와 상시 `...` 버튼 제거

### 2.1 문제

사용자 요구는 파일 탭과 grid 컬럼을 마우스 왼쪽 버튼으로 누른 채 원하는 위치까지 이동한 뒤 놓아서
순서를 바꾸는 직접 drag-and-drop이었다. 현재 코드는 HTML `draggable` 속성과 일부 drag/drop handler를
가지고 있지만 실제 제품에서 이 상호작용이 동작하지 않는다. moving item, drag threshold, 앞/뒤 hit-test,
drop indicator와 edge auto-scroll도 완성돼 있지 않으므로 이를 "drag 구현 완료"로 간주하지 않는다.

기존 component/E2E 검증은 실제 pointer drag를 재현하지 않고 `...` 메뉴의 `Move left`/`Move right`만
클릭했다. 따라서 기존 PASS 기록은 직접 drag 요구의 증거가 아니다. 또한 keyboard 대체 동작을 제공한다는
이유로 각 파일 탭과 각 컬럼 header에 해당 메뉴를 상시 노출해 화면을 복잡하게 만들었다.

### 2.2 확정 방향

- 파일 탭과 컬럼 header의 reorder 전용 `...` 버튼을 화면에서 제거한다.
- `Move left`/`Move right`를 제공하기 위한 상시 popup trigger와 메뉴를 제거한다.
- 파일 탭 자체와 컬럼 header 자체를 primary drag surface로 사용한다.
- native HTML `draggable` 속성이 존재하는지만 확인하지 않고, 실제 pointer press-hold-move-release 전체
  동작을 구현하고 검증한다.
- drag 중에는 moving item, 원래 위치와 삽입 위치를 구분할 수 있는 drop indicator를 표시한다.
- target의 좌우 절반을 구분해 앞/뒤 삽입을 결정하고, 마지막 항목 뒤에도 drop할 수 있어야 한다.
- 가로 overflow 상태에서는 drag pointer가 strip/grid 가장자리에 가까워지면 필요한 범위에서 auto-scroll한다.
- tab close, column resize separator, filter/sort action에서 시작한 pointer gesture는 reorder drag로 처리하지
  않는다.
- drag threshold를 넘긴 동작은 tab 활성화나 header sort click으로 이어지지 않는다.
- reorder 뒤 session/query/page cache, width, visibility, filter/sort, selection, focus와 copy column 순서는
  기존 column/document ID 계약으로 보존한다.

keyboard 또는 screen-reader용 동등 동작이 필수라면 화면을 계속 차지하는 `...` 버튼을 다시 만들지 않는다.
focused tab/header의 명시적 shortcut이나 비상시 context action처럼 평소 보이지 않는 경로로 제공하고,
구체적인 키 조합은 기존 grid navigation 및 운영체제 shortcut과 충돌하지 않는지 검토한 뒤 정한다.

### 2.3 내부 reorder drag와 외부 파일 drop 분리

현재 Tauri file drag listener는 `enter`에서 path를 받고, `over`에서는 현재 상태가 없어도
`{ paths: [] }`를 새로 만들어 file drop overlay를 표시한다. 내부 tab/header HTML drag도 WebView/Tauri의
drag event 경로에 섞일 수 있으므로, 파일 경로가 확인되지 않은 내부 drag에서 `Drop data file`이 뜬다.

두 drag 상태를 명시적으로 분리한다.

- tab/header reorder는 HTML5 native `draggable`에 의존하지 않고 Pointer Events 기반의 app-internal drag
  session으로 구현한다.
- file drop overlay는 Tauri `enter`에서 non-empty filesystem path 목록이 확인된 경우에만 시작한다.
- Tauri `over`는 이미 시작된 external file drag session의 위치만 갱신하며 스스로 overlay를 만들지 않는다.
- internal reorder session 중 발생한 Tauri enter/over/leave는 file drop UI와 open request를 만들지 않는다.
- external `drop`은 non-empty path와 active external session을 검증한 뒤에만 `openPaths`를 호출한다.
- internal drag 종료·취소와 external leave/drop에서 각 상태를 독립적으로 정리한다.

이 분리는 단순히 overlay를 CSS로 숨기는 방식이 아니라 event source와 상태 machine을 분리해 처리한다.

### 2.4 검증 항목

- 파일 탭을 pointer로 첫 위치, 중간, 마지막 위치에 직접 이동할 수 있다.
- 컬럼 header를 pointer로 첫 위치, 중간, 마지막 위치에 직접 이동할 수 있다.
- Playwright가 `dragTo` 또는 동등한 실제 pointer sequence를 사용하며 메뉴 action으로 drag 검증을
  대체하지 않는다.
- 앞/뒤 삽입 indicator와 실제 결과가 일치한다.
- reorder 전용 `...`, `Move left`, `Move right`가 일반 화면에 존재하지 않는다.
- drag와 click, close, resize, filter, 단일·다중 sort gesture가 서로 오작동하지 않는다.
- overflow 상태의 첫/마지막 위치 이동과 edge auto-scroll이 동작한다.
- 내부 파일 탭·컬럼·정렬 criterion drag 중 file drop overlay가 한 번도 나타나지 않는다.
- 내부 drag는 `openPaths`를 호출하지 않고, 외부 파일 drag만 overlay와 open request를 만든다.
- path가 없는 Tauri `over` 이벤트 단독으로는 file drop overlay를 만들지 않는다.
- 파일 reorder 뒤 tab별 query/cache/scroll/focus가 유지된다.
- 컬럼 reorder 뒤 width, visibility, filter/sort priority, selection과 복사 순서가 유지된다.
- 1440×900, 1024×768, 800×600 및 실제 Tauri에서 geometry와 drag interaction을 확인한다.

## 3. 다중 정렬 UX 재설계

### 3.1 문제

현재 다중 정렬은 첫 컬럼의 sort button을 누른 뒤 다른 컬럼을 `Shift+click`해야 시작할 수 있다.
`Sorts (N)` panel은 이미 추가된 기준의 방향·우선순위·삭제만 제공하며 새 컬럼을 추가할 수 없다.
따라서 사용자가 숨겨진 Shift 조작을 모르면 panel만으로 다중 정렬을 구성할 수 없다.

또한 현재 `Shift+click`으로 이미 정렬 중인 컬럼의 방향을 바꾸면 그 criterion을 배열 끝에 다시 넣어
우선순위까지 바뀐다. 방향 변경과 우선순위 변경이 한 동작에 섞여 예측하기 어렵다.

### 3.2 기본 원칙

- header sort는 빠른 단일 정렬 경로로 유지한다.
- 다중 정렬 panel 하나만으로 컬럼 추가부터 적용까지 모든 작업을 완료할 수 있어야 한다.
- `Shift+click` 다중 정렬 기능은 제거하고 modifier를 알아야 하는 숨은 조작을 두지 않는다.
- panel 내부 변경은 draft이며 `Apply` 전에는 query를 실행하지 않는다.
- 방향 변경은 우선순위를 바꾸지 않고, 우선순위 변경은 방향을 바꾸지 않는다.
- filter와 sort의 실행 의미, nulls-last와 source row ID stable tie-breaker는 유지한다.

### 3.3 Header 빠른 정렬

일반 click은 기존처럼 다른 기준을 제거하고 해당 컬럼만 즉시 정렬한다.

```text
not sorted → ascending → descending → not sorted
```

`Shift`를 누른 header click에도 별도 의미를 부여하지 않는다. modifier 여부와 관계없이 일반 click과 같은
단일 정렬 cycle로 처리하며 기존 다중 정렬에 criterion을 추가하지 않는다. 다중 정렬의 추가·방향·priority
변경은 모두 `Sorts (N)` panel에서만 수행한다.

각 정렬된 header에는 방향 아이콘과 `1`, `2`, `3` priority badge를 표시한다. tooltip에는 현재 방향과
priority를 표시하되 Shift shortcut 안내를 넣지 않는다.

### 3.4 다중 정렬 panel

toolbar의 `Sorts (N)`을 누르면 다음 구조의 editor를 연다.

```text
Multi-column sort

≡  1  [group_id ▼]  [Ascending  ▼]  [Remove]
≡  2  [time     ▼]  [Descending ▼]  [Remove]

[+ Add sort level]  [Clear all]
                         [Cancel] [Apply]
```

각 criterion row는 다음 기능을 가진다.

- searchable column selector: 현재 query의 전체 logical column에서 선택
- direction selector: Ascending 또는 Descending
- priority 번호
- pointer drag handle: row를 직접 위아래로 끌어 priority 변경
- Remove: 해당 criterion 삭제

`Add sort level`은 새 row를 추가하고 column selector에 즉시 focus한다. 이미 선택한 컬럼은 목록에서
제외하거나 disabled 상태와 이유를 표시해 duplicate sort를 만들지 않는다. hidden column도 현재 query
schema에 존재하면 선택할 수 있지만 `Hidden` 상태를 명시한다. 최대 64개 criterion 계약에 도달하면
추가 button을 disabled하고 이유를 표시한다.

`Clear all`은 panel의 draft만 비우며 `Apply`를 눌러야 실제 정렬을 해제한다. `Cancel`과 Esc는 draft를
버리고 기존 committed sort를 유지한다. 바깥쪽 click으로 닫는 경우도 Cancel과 같아야 한다.

row drag는 실제 pointer press-hold-move-release와 삽입 indicator로 구현한다. 상시 `Move up/down` button을
여러 개 노출해 panel을 복잡하게 만들지 않는다. keyboard/screen-reader reorder가 필요하면 focused drag
handle의 접근 가능한 shortcut으로 제공하되, 방향 select나 column select의 arrow key와 충돌하지 않게 한다.

### 3.5 Apply와 화면 상태

- 모든 criterion에 유효하고 서로 다른 column이 선택돼야 `Apply`할 수 있다.
- 변경이 없으면 `Apply`를 disabled하거나 query를 재실행하지 않는다.
- `Apply`는 완성된 ordered sort plan으로 query를 정확히 한 번 실행한다.
- 성공하면 header direction/priority badge와 `Sorts (N)` count를 함께 갱신한다.
- 실패하면 기존 committed result와 selection을 유지하고 panel draft와 typed error를 확인할 수 있게 한다.
- 성공 뒤 active column ID와 logical row를 보존·clamp하고 기존 rectangular selection은 active cell 하나로
  축소한다.

### 3.6 검증 항목

- `Sorts (0)`에서 Shift 사용 없이 2개 이상 criterion을 추가하고 적용할 수 있다.
- column 검색·선택, direction, 제거와 Clear all이 draft에서만 동작한다.
- criterion row를 실제 pointer drag로 첫·중간·마지막 priority에 옮길 수 있다.
- Cancel, Esc와 바깥쪽 click이 committed plan과 query 실행 횟수를 바꾸지 않는다.
- Apply 한 번에 backend query도 정확히 한 번 실행된다.
- 같은 컬럼 중복과 64개 초과가 UI 및 wire validation에서 모두 차단된다.
- Shift+click은 다중 정렬을 추가·변경하지 않고 일반 click과 같은 단일 정렬 동작만 수행한다.
- 일반 click은 명시적으로 단일 정렬로 교체하며 ascending/descending/clear cycle이 일치한다.
- nulls-last, 다중 criterion 우선순위와 source row ID tie-breaker가 reference 결과와 같다.
- filter와 함께 적용해도 `filter → ordered multi-sort` 의미와 복사 순서가 일치한다.
- 1440×900, 1024×768, 800×600에서 panel이 grid를 잘못 가리거나 잘리지 않는다.
- 실제 Tauri에서 pointer drag, select popup, Apply focus 복귀와 정렬 결과를 검증한다.

## 4. CSV 사전 준비와 재사용 가능한 가속 cache

### 4.1 목적

목표는 CSV를 Parquet이라는 특정 형식으로 변환하는 것이 아니라, CSV를 열 때 한 번 준비해 이후 기능이
원본 CSV를 반복해서 처음부터 파싱하지 않게 하는 것이다. 임시 Parquet, DuckDB database, Arrow IPC 또는
자체 columnar 형식은 구현 후보이며 correctness·성능·자원 측정 뒤 선택한다.

현재 CSV query provider는 query를 준비할 때 원본 전체를 읽어 `dv_source` DuckDB table을 만들지만,
일반 page와 boundary는 이 결과를 충분히 공유하지 않고 원본 CSV와 checkpoint를 다시 사용한다. 새 설계는
profile generation당 한 번 만든 source-level 준비 결과를 page, query, boundary, Find와 copy가 함께
재사용하게 한다.

### 4.2 사용자 동작과 상태

CSV open은 전체 준비가 끝날 때까지 막지 않는다.

```text
CSV open
  → schema/첫 page 즉시 표시
  → background prepare 시작
  → 준비 중에는 기존 bounded streaming/checkpoint 경로 사용
  → 준비 성공 시 같은 session 안에서 prepared source로 원자적 전환
```

상태는 최소한 다음과 같이 구분한다.

```text
NotStarted → Preparing(progress) → Ready
                         ├───────→ Cancelled
                         └───────→ Failed(typed reason)
Ready/Preparing → Stale → 새 generation 준비
```

- 준비 중에도 현재 page와 이미 가능한 read-only 탐색을 유지한다.
- 준비 완료 전후에 logical row, column, selection, scroll과 focus가 움직이지 않는다.
- 완료 시 새 source generation으로 page/query cache를 안전하게 교체하고 늦은 이전 응답을 폐기한다.
- 준비 실패·취소·디스크 부족은 파일 자체를 닫지 않고 기존 CSV 경로로 fallback한다.
- 진행률은 parsed rows/bytes와 stage를 표시하고 명시적 취소를 제공한다.

### 4.3 Prepared source 내용

한 번의 순차 CSV parse에서 다음 artifact를 함께 만든다.

- 연속된 `__dv_row_id`와 정확한 row count
- 적용된 header와 parsing profile에 따른 native typed column value
- `Valid`, `Null`, `Empty`, `Invalid` 상태와 필요한 raw field
- display 설정과 독립적인 source value metadata
- 각 컬럼의 packed occupied bitmap
- query filter/sort/Find와 projected page/copy가 재사용할 columnar source table
- 원본 세부 확인이나 fallback에 필요한 bounded checkpoint/file identity

prepared source는 raw/display/copy와 int64·uint64·decimal·timestamp 정밀도를 기존 직접 CSV 경로와 동일하게
보존해야 한다. disk 증가를 줄인다는 이유로 invalid 원문이나 raw copy 의미를 버리지 않는다. 저장 방식이
이를 저렴하게 지원하지 못하면 원본 fallback 범위와 비용을 설계·측정으로 명시한다.

점유 비트맵은 별도 전체 재스캔으로 만들지 않고 같은 parse에서 생성한다. 필터·정렬이 없는 Ctrl boundary는
source-order bitmap을 직접 사용한다. 필터·정렬 query는 `query_result.rowid → __dv_row_id` mapping으로
source bitmap을 query logical order bitmap에 투영하므로 CSV field를 다시 파싱하지 않는다.

### 4.4 Cache identity와 무효화

cache key에는 최소한 다음 값이 들어간다.

```text
canonical path + file size + modified time/fingerprint
+ delimiter/header/encoding
+ complete CSV parsing profile generation
+ prepared format/schema version
```

다음 변경은 준비 결과를 stale로 만들고 in-flight build를 취소한 뒤 새 generation을 만든다.

- header mode, delimiter 또는 encoding 변경
- target type, trim, null token, Boolean/date/timestamp/number parsing option 변경
- source 파일의 크기·수정 시각 또는 fingerprint 변경
- document session 교체와 file reload

display-only 설정, column width/order/visibility와 selection 변경은 prepared source를 폐기하지 않는다.
filter, Find와 단일·다중 sort 변경도 source preparation을 다시 수행하지 않고 같은 prepared source 위에 새
query result만 만든다.

### 4.5 저장소와 자원 정책

초기 구현 후보는 이미 포함된 DuckDB를 사용하는 app-local/session-owned on-disk source table과 별도
packed bitmap이다. 새 dependency는 우선 추가하지 않는다. 그러나 구현 전에 임시 Parquet 및 다른 bounded
columnar 후보와 다음 항목을 같은 fixture로 비교해 최종 형식을 확정한다.

- 최초 build 시간과 첫 page 방해 여부
- ready 뒤 projected random page, filter/sort와 boundary latency
- typed/raw/state parity 구현 난이도
- peak RSS, temp high-water와 cache file 크기
- 취소·partial build 정리와 crash recovery

artifact는 process/document/session/generation별 임의 app-local 경로에 만들고 성공 전에는 registry에
노출하지 않는다. 성공 시 atomic commit하고 partial artifact는 삭제한다. process temp 10 GiB, 5 GiB safety
reserve와 기존 memory budget을 넘지 않으며, 예상 공간 부족은 build 전에 확인하고 실행 중에도 재검사한다.
tab close, session/profile 교체와 정상 종료에서 소유 artifact를 정리하고 startup janitor가 죽은 process의
잔여물만 제거한다. 다른 실행 중인 viewer process의 cache는 건드리지 않는다.

### 4.6 준비 완료 뒤 사용 계약

`Ready` 이후에는 다음 동작이 같은 profile generation의 원본 CSV를 전체 재파싱하지 않아야 한다.

- first/middle/last와 임의 projected page
- 원본 순서 및 필터·정렬 결과의 Ctrl boundary
- filter, 단일·다중 sort와 반복 query 교체
- Find, distinct와 full-cell detail
- 부분·전체 selection의 displayed/raw copy

query별 `query_result`는 계속 ordered source identity만 저장하고 prepared source value를 중복 materialize하지
않는다. 여러 query가 같은 prepared source를 공유하되 query/session lifetime과 connection lock을 분리하고,
copy·page·boundary가 서로 UI thread나 하나의 장기 mutex를 점유하지 않게 한다.

### 4.7 필수 correctness test

제품 DuckDB 결과를 oracle로 재사용하지 않는 독립 reference parser로 direct CSV와 prepared source의 다음
결과를 비교한다.

- empty/1행, header 있음·없음·auto와 duplicate/빈 header
- comma/tab/semicolon delimiter, quoted delimiter, escaped quote
- quoted LF/CRLF, 빈 field, trailing field와 whitespace-only field
- UTF-8 BOM, 긴 field, 긴 row, 최대 column 경계와 유효하지 않은 UTF-8
- 일정하지 않은 field count와 malformed quote의 동일한 typed error
- Text/Boolean/Int64/UInt64/Float64/Decimal/Date/Timestamp/Skip profile
- trim on/off, 다중 null token, custom Boolean/date/timestamp/number separator
- int64·uint64 경계, 2^53 인접값, decimal scale, NaN/Infinity 정책과 timestamp 정밀도
- Valid/Null/Empty/Invalid state, display/raw/full-cell와 default/displayed/raw copy
- 첫·중간·마지막·EOF page 및 여러 projection/column order
- 빈 셀 transition이 시작·중간·마지막에 있는 Ctrl Up/Down과 빈 셀이 전혀 없는 컬럼
- filter-only, sort-only, filter+다중 sort, nulls-last와 stable source-ID tie-breaker
- Find/distinct와 partial/whole filtered-sorted copy checksum

작은 결정적 fixture 외에 randomized valid CSV와 malformed input corpus로 direct/prepared parity를 반복한다.
Rust DTO/state와 TypeScript가 같은 generation/status 규칙을 검사하면 parity matrix를 추가한다.

### 4.8 필수 전환·경쟁·실패 test

- 준비 중 first/middle page, Ctrl, filter 요청과 완료 직전·직후 응답 순서 교차
- 준비 완료 전 old page가 완료 뒤 prepared page를 덮어쓰지 않음
- profile/header를 빠르게 연속 변경했을 때 마지막 generation만 commit
- build cancel, parser error, disk-full simulation, temp limit과 permission 오류
- 실패·취소 후 direct fallback의 page/query/copy 정확성
- source 파일 truncate/replace/mtime 변경 감지와 stale cache 차단
- tab 전환 20회, document close, reopen과 다중 CSV 동시 준비
- query replace/copy 중 source generation 교체와 stale clipboard commit 차단
- app 정상 종료, 강제 종료 잔여물과 다음 startup janitor
- 같은 canonical file을 같은 process와 다른 process에서 열었을 때 소유권 격리
- 내부 reorder drag와 외부 file drop이 준비 상태를 잘못 시작·취소하지 않음

각 test는 성공 UI만 보지 않고 active generation, source read count, cache path ownership, task/temp 수와 terminal
error code를 assertion한다. lifecycle soak는 prepare→query→page→copy→close를 최소 100회 반복하고 handle,
task, temp와 RSS 증가 추세가 남지 않는지 확인한다.

### 4.9 필수 성능·자원·native test

작은 fixture만으로 성능을 판정하지 않는다. 기존 `large-csv.csv`와 별도의 5.85M행 low/high-cardinality,
긴 문자열·높은 invalid 비율 fixture에서 debug가 아닌 release executable로 측정한다.

- direct baseline과 prepare build throughput/elapsed
- build 중 첫 page와 interactive scroll latency
- cold/warm projected random page p50/p95
- source/query bitmap Ctrl boundary cold/warm p50/p95
- filter, 단일 및 3-column sort 준비·첫 page p50/p95
- Find/distinct와 1-column/다중-column copy throughput
- 원본 CSV open/read 횟수와 parsed rows/bytes
- peak/settled RSS, DuckDB memory, cache/temp high-water와 최종 정리 크기
- cancel 요청부터 terminal state까지의 latency

최소 완료 조건은 다음과 같다.

- profile generation당 full CSV parse가 한 번을 넘지 않는다.
- `Ready` 뒤 filter/sort 반복과 page/boundary가 원본 CSV full reparse를 만들지 않는다.
- bitmap cache hit Ctrl boundary는 source value read 0이다.
- prepared path의 모든 결과와 copy hash가 direct/reference 결과와 같다.
- 준비 중 UI thread block, permanent pending, focus/geometry 이동이 없다.
- 기존 process temp 10 GiB, safety reserve와 memory 예산을 지킨다.
- 실패·취소·close·crash 뒤 partial artifact와 task가 누적되지 않는다.

정확한 latency hard budget은 구현 전 현재 release baseline과 후보 저장 형식 benchmark를 같은 장비에서
수집해 고정한다. timeout 확대, fixture 축소, compression 변경만으로 실패를 숨기지 않는다. browser mock은
상태·경쟁·geometry만 담당하고 실제 filesystem, DuckDB/cache, RSS, clipboard와 cleanup은 실제 Tauri
release 및 NSIS build에서 별도로 검증한다.

### 4.10 실행 가능한 성능 test gate

성능 검증을 review 때 사람이 체감으로 확인하는 항목으로 두지 않고 다음 ID를 가진 자동화 test/harness로
작성한다.

| ID | 환경 | 필수 검증 |
| --- | --- | --- |
| `CSVPERF-001` | Release backend | 5.85M CSV prepare의 elapsed, rows/s, parsed rows/bytes, peak RSS와 temp high-water를 기록한다. |
| `CSVPERF-002` | Release backend | 준비 중 first page와 연속 20 page scroll의 p50/p95를 direct baseline과 비교하고 UI foreground starvation이 없는지 확인한다. |
| `CSVPERF-003` | Release backend | Ready 뒤 first/middle/last 및 random 20 projected pages의 p50/p95와 source CSV read 0을 확인한다. |
| `CSVPERF-004` | Release backend | 빈 셀이 가까움·멀리 있음·전혀 없음인 source-order Ctrl boundary cold/warm p50/p95와 bitmap hit source read 0을 확인한다. |
| `CSVPERF-005` | Release backend | filter-only, sort-only와 filter+3-column sort의 준비·first page p50/p95를 low/high-cardinality에서 측정한다. |
| `CSVPERF-006` | Release backend | filtered/sorted query Ctrl boundary cold/warm p50/p95, adaptive block 수, bitmap bytes와 원본 CSV parsed row 증가량을 확인한다. |
| `CSVPERF-007` | Release backend | query 조건을 20회 변경해도 source full parse count가 1이고 cache artifact를 재생성하지 않는지 확인한다. |
| `CSVPERF-008` | Release backend | 5.85M×1열 및 대표 다중 열 copy의 rows/s, total elapsed, RSS/temp, progress interval과 cancel latency를 기록한다. |
| `CSVPERF-009` | Release soak | prepare/query/page/boundary/copy/close 100회에서 handle, task, cache/temp와 settled RSS 증가 추세가 없는지 확인한다. |
| `CSVPERF-010` | Native Tauri | 실제 WebView2에서 prepare 중 navigation, Ready 전환, random page와 Ctrl target의 key-to-visible latency 및 permanent pending 0을 확인한다. |
| `CSVPERF-011` | Candidate comparison | DuckDB/Parquet 등 후보를 동일 입력·profile·resource cap에서 비교하고 선택 근거를 JSON으로 남긴다. |
| `CSVPERF-012` | NSIS release | 최종 설치본에서 대표 prepare→warm page→filter/sort→Ctrl 시나리오가 개발 build와 같은 gate를 만족한다. |

측정 protocol은 다음과 같이 고정한다.

- 제품과 같은 release profile, DuckDB thread/memory/temp 설정을 사용한다.
- low/high-cardinality와 long-string fixture hash, schema, row count, byte size를 manifest에 고정한다.
- 각 latency scenario는 별도 warm-up 뒤 최소 5회 실행하고 raw sample, p50과 p95를 모두 저장한다.
- cold는 새 process와 비어 있는 app-owned cache, warm은 같은 prepared generation이라는 조건을 명시한다.
- wall time뿐 아니라 source open/full-parse count, parsed/decoded rows·bytes, block 수, bitmap hit/miss,
  peak/settled RSS와 temp high-water를 함께 수집한다.
- 측정 중 다른 test의 background worker를 공유하지 않고 machine/OS/CPU/RAM과 fixture storage를 기록한다.
- timeout, cancel되지 않는 worker, permanent pending, 누락된 metric 또는 fixture hash 불일치는 FAIL이다.
- 결과는 `artifacts/phase-12/csv-prepared-performance.json`에 machine-readable raw sample과 gate 판정을 남긴다.

구현 전에 현재 direct 경로와 현행 query 준비 경로를 같은 harness로 측정해
`csv-prepared-performance-baseline.json`에 고정한다. 그 결과를 검토해 각 ID의 절대 p95와 허용 회귀율을
production 구현 시작 전에 문서와 JSON에 확정한다. hard budget이 비어 있거나 baseline fixture와 다른
데이터로 측정된 상태에서는 이 후속 기능을 완료로 판정하지 않는다.

최소 비율·구조 gate는 baseline 수치와 무관하게 즉시 고정한다.

- profile generation당 source full parse count `<= 1`
- Ready 뒤 query 20회 변경의 추가 full parse count `= 0`
- warm source/query bitmap boundary의 source value read `= 0`
- Ready 뒤 random page 20회의 원본 CSV parsed bytes 증가량 `= 0`
- foreground page와 Ctrl 요청의 permanent pending `= 0`
- cancel 요청의 terminal 전환은 기존 2초 계약 이내
- process temp `<= 10 GiB`, safety reserve `>= 5 GiB`, peak RSS는 기존 query `<= 1.5 GiB` 계약 이내
- success/failure/cancel/close 뒤 partial cache artifact와 active prepare task `= 0`

## 5. Copy history와 임시 panel의 일관된 닫기 동작

### 5.1 문제와 현재 audit

`Copy history`는 controlled popover가 아니라 native HTML `<details>`로 구현돼 있다. 따라서 summary를 다시
누르기 전까지 열린 상태가 유지되며 셀, grid 또는 다른 toolbar를 클릭해도 닫히지 않는다. 화면 위에
absolute list가 계속 남아 작업을 방해한다.

같은 관점에서 현재 transient surface를 점검한 결과는 다음과 같다.

| Surface | 현재 outside click | 후속 처리 |
| --- | --- | --- |
| Copy history | 닫히지 않음 | 수정 필요 |
| Column chooser | 닫히지 않으며 Close button만 있음 | 수정 필요 |
| Multi-column sort panel | 닫히지 않으며 Apply/Cancel만 있음 | 3번 재설계에 포함 |
| File tab order menu | 닫히지 않음 | 2번에서 trigger/menu 자체 제거 |
| Column order menu | 닫히지 않음 | 2번에서 trigger/menu 자체 제거 |
| Column filter popover | outside pointer, scroll, resize에서 닫힘 | 유지·회귀 검증 |
| Copy options menu | outside pointer와 Esc에서 닫힘 | 유지·회귀 검증 |
| Find options/hidden-filter menu | outside pointer와 Esc에서 닫힘 | 유지·회귀 검증 |
| Cell context menu | outside pointer, scroll, resize에서 닫힘 | 유지·회귀 검증 |

Find bar는 반복 검색을 위한 persistent tool이므로 셀 click만으로 닫지 않고 Esc 또는 명시적 Close로 닫는다.
full-value, Settings, Copy settings와 CSV profile 같은 modal/draft dialog도 accidental outside click으로 닫지
않는다. 즉 모든 surface를 무조건 같은 방식으로 닫는 것이 아니라 transient popover와 persistent/modal
surface를 구분한다.

### 5.2 공통 transient surface 계약

- transient menu/popover/history는 trigger를 다시 누르거나 바깥 `pointerdown`에서 닫힌다.
- grid cell, header, 다른 toolbar control과 빈 workspace click은 모두 바깥 click이다.
- 바깥 click을 가로채지 않으므로 원래 cell selection, focus와 button action도 정상 실행된다.
- Esc로 닫으면 해당 trigger에 focus를 복원한다.
- 바깥 pointer로 닫으면 새로 클릭한 대상의 focus를 빼앗지 않는다.
- scroll, resize, active document/tab 변경과 해당 session/query generation 교체에서도 닫는다.
- 한 transient surface를 열면 같은 scope의 다른 transient surface를 먼저 닫는다.
- surface 내부의 scroll, text selection과 단순 click은 임의로 닫지 않는다.
- Apply/선택처럼 action이 완료되는 동작은 surface별 계약에 따라 닫는다.
- draft가 있는 surface의 outside click과 Esc는 commit하지 않고 Cancel과 같은 의미다.
- backdrop으로 화면을 막지 않으며 grid geometry를 이동시키지 않는다.

### 5.3 Copy history 변경

- uncontrolled `<details>`를 제거하고 trigger button과 controlled anchored popover로 바꾼다.
- trigger는 `aria-expanded`, `aria-controls`와 최근 operation 수를 제공한다.
- popover 내부에는 current와 최근 previous attempt 최대 5개를 operation ID·시각·상태·실패 이유로 구분해
  표시한다.
- 셀이나 다른 곳을 클릭하면 즉시 닫히고 해당 click의 selection/action은 그대로 수행한다.
- 새 copy가 시작되거나 완료돼도 사용자가 열지 않은 history를 자동으로 펼치지 않는다.
- history가 열린 동안 새 상태가 들어오면 목록은 갱신하되 focus와 scroll을 불필요하게 초기화하지 않는다.
- tab/session 변경 시 이전 문서의 history popover는 닫고 새 문서에서 자동으로 열지 않는다.

### 5.4 Column chooser와 상태 메시지

Column chooser는 여러 visibility를 연속 변경할 수 있으므로 내부 click에서는 유지하되 cell/header/toolbar의
바깥 click, Esc, scroll, resize와 tab 변경에서 닫는다. Esc는 trigger focus를 복원하고 바깥 click은 새
대상의 focus를 유지한다.

copy status도 영구적인 toolbar 문장으로 남지 않게 상태별 수명을 구분한다.

- queued/running/finishing과 progress는 작업이 active인 동안 유지한다.
- 성공 안내는 짧은 non-blocking status로 표시한 뒤 자동으로 축소하고 history에는 계속 남긴다.
- 실패·취소 이유는 자동으로 사라지게 하지 않고 Dismiss와 필요한 경우 Retry를 제공한다.
- 새 operation이 시작되면 이전 transient success는 즉시 정리하되 history record는 보존한다.
- copy preset 저장 오류처럼 사용자 조치가 필요한 inline error에도 명시적 Dismiss 또는 다음 성공 시 정리
  규칙을 둔다.

정확한 성공 status 표시 시간은 UI 검증에서 읽을 수 있는 최소 시간과 작업 방해를 함께 측정해 확정하며,
history 자체를 자동으로 여는 방식으로 성공·실패를 알리지 않는다.

### 5.5 검증 항목

- Copy history를 연 뒤 cell click으로 닫히고 같은 click에서 active cell이 정확히 바뀐다.
- header, toolbar, workspace click과 grid scroll/resize에서도 history가 닫힌다.
- history 내부 click/scroll은 닫지 않고 trigger 재클릭과 Esc는 닫는다.
- Esc 닫기만 trigger focus를 복원하며 outside click focus를 빼앗지 않는다.
- history를 연 상태에서 Column chooser, Copy options, filter 또는 sort panel을 열면 history가 닫힌다.
- tab/session/query generation 변경 뒤 이전 transient surface가 남지 않는다.
- Column chooser의 내부 visibility 여러 번 변경은 유지되고 outside/Esc에서는 닫힌다.
- sort draft의 outside/Esc는 query를 실행하지 않고 committed sort를 유지한다.
- Find bar와 modal/draft dialog는 cell click으로 잘못 닫히지 않는다.
- Copy options, filter popover, Find options와 context menu의 기존 outside/Esc 계약이 회귀하지 않는다.
- success status는 정해진 시간 뒤 축소되지만 failure reason과 Retry는 임의로 사라지지 않는다.
- 1440×900, 1024×768, 800×600에서 popover가 clipping·overlap·layout shift를 만들지 않는다.
- 실제 Tauri pointer/focus/scroll 순서에서도 browser mock과 같은 결과인지 검증한다.

## 6. Timestamp 표시 설정 완성 및 Duration 정식 지원

### 6.1 현재 문제

현재 전역 `Value display formats`에서 timestamp가 제공하는 설정은 소수 초 자릿수의
`Preserve` 또는 `Fixed(0~9)`뿐이다. Date의 날짜 형식 설정은 timestamp에 적용되지 않고,
날짜와 시간의 구분자, 시간 형식, timezone suffix를 설정할 수 없다. 설정 화면의 timestamp 예시도
실제 formatter 결과가 아니라 고정 문자열이다. Grid display와 display-mode copy가 서로 다른 formatter
계약을 사용하면 같은 설정에서도 결과가 달라질 수 있으므로 하나의 설정 DTO와 formatter 계약으로
통합해야 한다.

현재 Arrow `Duration`과 `Interval`은 `ValueKind`와 TypeScript DTO에 별도 타입이 없고 Arrow value
변환에서 `unsupported`로 떨어진다. 따라서 timedelta가 우연히 물리 정수나 문자열로 보이는 경우가
있더라도 의미, 단위, 정렬, 필터와 copy를 보존하는 정식 지원으로 간주하지 않는다.

### 6.2 Duration 타입 계약

첫 지원 범위는 NumPy/Pandas `timedelta64`와 대응하는 고정 길이 Arrow `Duration`이다.

- `Duration(Second)`, `Duration(Millisecond)`, `Duration(Microsecond)`,
  `Duration(Nanosecond)`를 지원한다.
- 값은 signed 64-bit count와 `s`, `ms`, `us`, `ns` 단위를 분리해 보존한다.
- JavaScript `number`로 변환하지 않고 source count를 문자열 DTO로 전달해 2^53 밖의 정밀도를
  잃지 않는다.
- `ValueKind::Duration`과 TypeScript의 `"duration"` kind를 추가하고 unit을 필수 metadata로 둔다.
- `0`은 유효하고 occupied인 duration이며 null만 빈 셀이다.
- 음수, 24시간 이상, 최대·최소 i64와 나노초 정밀도를 보존한다.
- display format 변경은 source value, 정렬, 필터, Find와 raw copy 의미를 바꾸지 않는다.

달력 기반 Arrow `Interval`은 Duration과 같은 타입으로 합치지 않는다. `1 month`는 기준 날짜에 따라
실제 시간 길이가 달라지므로 초나 나노초로 암묵 변환할 수 없다. 첫 구현에서는 year-month,
day-time, month-day-nano Interval을 타입과 함께 명시적인 unsupported 값으로 표시하고, 이후 별도의
`Interval` 타입으로 설계한다. Arrow `Time32/Time64`도 시각(time of day)이므로 Duration으로 취급하지
않는다.

Parquet/Arrow schema가 Duration을 명시하거나 Arrow schema metadata로 Duration이 복원되는 경우에만
자동 인식한다. 단순 물리 `INT64`는 duration인지 판별할 수 없으므로 단위나 논리 타입 없이 추측하지
않는다. CSV는 Parsing Profile에 `Duration` target type과 source unit/입력 format을 명시하는 방식으로
지원하며, H5의 기존 `time`, `wavelength`, `oes` 타입 계약은 이번 변경으로 확장하지 않는다.

### 6.3 Timestamp 전역 표시 설정

Timestamp의 타입별 전역 설정은 다음 조합을 지원한다.

| 항목 | 선택값 | 기본값 |
| --- | --- | --- |
| Date format | `YYYY-MM-DD`, `YYYY/MM/DD`, `DD-MM-YYYY`, `MM-DD-YYYY` | `YYYY-MM-DD` |
| Date/time separator | Space, `T` | Space |
| Time format | `HH24:MI:SS`, `HH24:MI` | `HH24:MI:SS` |
| Fractional seconds | Preserve, Hidden, 0~9 fixed digits | Preserve |
| Timezone suffix | Hidden, Offset, Name | Hidden |

기본 표현은 기존 계약인 `YYYY-MM-DD HH24:MI:SS.F...`이다. source의 소수 초가 없으면 점도 출력하지
않으며 Preserve는 source unit의 정밀도를 그대로 유지한다. fixed digits는 부족한 자리를 0으로 채우고
초과 자리를 display에서만 절삭하며 source와 raw value는 바꾸지 않는다.

Timezone 설정은 suffix 표시만 바꾸며 시간 자체를 UTC, 시스템 local timezone 또는 다른 timezone으로
변환하지 않는다. 원본 timezone의 wall-clock field를 유지한다.

- Hidden: timezone을 표시하지 않는다.
- Offset: 가능한 경우 `+09:00` 또는 `Z`를 표시한다.
- Name: named timezone이면 `[Asia/Seoul]`처럼 표시하고 offset만 있는 source는 offset으로 대체한다.
- timezone metadata가 없는 source에는 suffix를 만들지 않는다.

예시는 다음과 같다.

```text
기본                 2025-12-18 01:23:34.111111111
ISO preset           2025-12-18T01:23:34.111111111
소수 초 3자리        2025-12-18 01:23:34.111
Offset 표시          2025-12-18 01:23:34.111111111+09:00
Timezone 이름 표시   2025-12-18 01:23:34.111111111 [Asia/Seoul]
```

Preset은 최소한 Standard, ISO, Date only와 Custom을 제공한다. preset 선택은 세부 값을 한 번에
변경하고, 세부 값을 하나라도 직접 변경하면 preset 표시를 `Custom`으로 바꾼다. 임의 format 문자열
입력은 첫 구현에 포함하지 않고 검증된 조합형 설정만 제공한다.

### 6.4 복잡도를 낮춘 설정 화면 구조

전체 Settings dialog와 CSV, Copy, Temporary storage section은 그대로 유지한다. `Value display formats`
section 내부만 요약 목록과 타입 상세 화면 사이에서 전환한다. 새 popup, 중첩 modal, backdrop 또는
별도 Apply button을 만들지 않는다.

요약 목록은 설정 control을 모두 펼치지 않고 현재 결과를 한 줄로 보여준다.

```text
Value display formats

String       Line breaks, maximum 2 lines              >
Integer      1,234,567                                  >
Decimal      1,234.567890                               >
Date         2025-12-18                                 >
Timestamp    2025-12-18 01:23:34.111111111              >
Duration     2d 03:04:05.123456789                      >
Boolean      true / false                               >
Binary       Hex, 256-byte preview                      >
```

Timestamp 행을 선택한 기본 상세 화면에는 Preview, Preset과 접힌 Advanced settings만 표시한다.

```text
Value display formats

  < All formats                              Timestamp

  Preview
  +------------------------------------------------+
  | 2025-12-18 01:23:34.111111111                 |
  +------------------------------------------------+
  Source timezone: Asia/Seoul

  Preset                                [Standard v]
  Advanced settings                                v
```

Advanced settings를 펼쳤을 때만 Date format, Date/time separator, Time format, Fractional seconds와
Timezone suffix를 표시한다. Preview는 실제 production formatter를 사용해 입력 즉시 갱신한다.
`< All formats`는 `Value display formats` section만 요약 목록으로 복귀시키며 다른 Settings section과
임시 변경값은 유지한다. dialog 하단의 기존 Cancel/Apply가 전체 설정을 폐기하거나 저장한다.

전체 Settings dialog에서의 위치는 다음과 같다.

```text
+----------------------------------------------------------+
| Settings                                               X |
| Defaults for new files and copy operations.              |
+----------------------------------------------------------+
| CSV default parsing                                      |
|   [Auto] [All text] [Custom]                              |
+----------------------------------------------------------+
| Copy                                                     |
|   Excel-compatible, headers included                 >   |
|   Maximum cells / Maximum clipboard size                 |
+----------------------------------------------------------+
| Value display formats                                    |
|                                                          |
|   < All formats                         Timestamp         |
|   Preview  2025-12-18 01:23:34.111111111                 |
|   Preset                                  [Standard v]    |
|   Advanced settings                                v      |
+----------------------------------------------------------+
| Temporary storage                                        |
|   Query temporary storage limit                           |
+----------------------------------------------------------+
|                                  [Cancel] [Apply]         |
+----------------------------------------------------------+
```

### 6.5 Duration 표시 설정

Duration도 같은 요약 목록과 상세 화면 구조를 재사용한다. 기본 preset은 `Days + clock`이며 full
precision을 보존한다.

```text
Value display formats

  < All formats                               Duration

  Preview
  +------------------------------------------------+
  | -2d 03:04:05.123456789                         |
  +------------------------------------------------+
  Raw: -183845123456789 ns

  Preset                           [Days + clock v]
  Advanced settings                                v
```

Duration preset은 최소한 다음을 제공한다.

- Days + clock: `2d 03:04:05.123456789`
- Clock total hours: `51:04:05.123456789`
- Total seconds: `183845.123456789 s`
- Custom: 세부 설정을 직접 변경한 상태

Advanced settings에는 Display style, Fractional seconds와 Unit suffix만 둔다. 부호는 전체 값 앞에
한 번만 표시한다. 기본 Unit suffix는 숨기고 raw detail과 raw copy에는 반드시 source unit을 표시한다.

```text
0 ns                    -> 00:00:00
1,500,000,000 ns        -> 00:00:01.500000000
183,845,123,456,789 ns  -> 2d 03:04:05.123456789
-1,500,000,000 ns       -> -00:00:01.500000000
```

### 6.6 Display, copy와 query 계약

- 타입별 전역 설정은 grid display, 셀 상세의 Display 값과 display-mode/default copy에 동일하게 적용한다.
- default copy는 현재 보이는 timezone 및 duration 형식을 사용한다.
- raw copy는 설정과 무관하게 source count, unit과 timezone metadata를 보존한다.

```text
Timestamp raw: 1766021014111111111 [unit=ns, timezone=Asia/Seoul]
Duration raw:  -183845123456789 [unit=ns]
```

- filter, sort, Find와 boundary 탐색은 formatted display가 아니라 typed source value를 사용한다.
- Duration filter는 equals, comparison, between, null operator를 제공하고 literal parser는 명시적인
  duration 문법과 단위를 검증한다.
- display format만 변경할 때 source/query/prepared CSV/occupancy bitmap을 무효화하지 않는다.
- display-mode copy와 raw copy는 duration의 filtered/sorted logical row 순서와 column projection을
  그대로 따른다.

### 6.7 설정 DTO와 formatter parity

Rust와 TypeScript 설정 DTO에 Timestamp와 Duration의 동일한 enum, 범위와 unknown-field validation을
둔다. settings load/save, preview, grid page, full-cell detail과 copy가 같은 조합을 해석해야 한다.
프런트엔드 preview만 별도 축약 formatter로 구현하지 않으며 Rust/TypeScript boundary combination
parity test를 둔다. 이전 settings version은 새 기본값으로 migration하고 손상되거나 범위를 벗어난
설정은 field path가 포함된 typed error로 처리한다.

### 6.8 필수 검증

- Timestamp 네 가지 날짜 형식, Space/T, 초 표시 여부, Preserve/0~9 fraction 조합을 검증한다.
- timezone 없음, UTC, fixed offset, named timezone과 DST 전후 값에서 wall-clock 비변환과 suffix를
  검증한다.
- timestamp의 display, default copy, raw copy와 filter/sort source semantics가 일치한다.
- Duration 네 unit, 0, null, 양수, 음수, 24시간 초과와 i64 최소·최대값을 검증한다.
- Parquet Arrow Duration과 Arrow schema metadata로 복원된 pandas/NumPy timedelta fixture를 검증한다.
- 물리 INT64만 있는 Parquet를 duration으로 오인하지 않으며 Interval/Time32/Time64를 duration으로
  변환하지 않는다.
- CSV Duration profile의 source unit, 입력 format, null/empty/invalid와 전체 validation을 검증한다.
- Duration filter/sort/Find, Ctrl boundary, display/default/raw copy와 filtered/sorted copy를 검증한다.
- preset 선택, advanced 변경 후 Custom 전환, Preview, All formats 복귀와 Cancel/Apply를 검증한다.
- 타입 상세 전환 중 CSV, Copy와 Temporary storage draft 값 및 dialog scroll/focus가 보존된다.
- 상세 화면이 nested modal/popover/backdrop을 만들지 않고 Esc와 focus trap이 기존 Settings 계약을
  깨지 않는다.
- 1440x900, 1024x768, 800x600 Playwright interaction, DOM geometry와 screenshot을 검증한다.
- 실제 Tauri에서 settings round trip, representative page/query/copy와 keyboard/focus를 검증한다.
