# Phase 12 UX 설계: query·copy와 grid 작업 흐름

- 상태: 구현 및 검증 완료
- 작성일: 2026-07-21
- UI 원칙: 기존 grid의 정보 밀도를 유지하면서 query, Find, tab/column 순서, focus와 copy 상태를 명확히 한다.

## 1. 사용자에게 보이는 목표

- 5,850,000행 Parquet에서 정렬을 적용한 뒤 첫 행이 합의된 시간 안에 표시된다.
- 아래로 스크롤하거나 PageDown을 눌렀을 때 visible row가 장시간 빈 `pending` 상태로 남지 않는다.
- 정렬 전후에 같은 단축키가 같은 논리 의미를 가진다.
- query page가 준비되는 동안 기존의 유효한 page, selection과 scroll 위치를 불필요하게 지우지 않는다.
- 실패한 page는 무한 spinner가 아니라 재시도 가능한 오류로 표시한다.
- filter/sort 뒤에도 사용자가 보던 logical cell을 유지하고 같은 result snapshot을 복사한다.
- 탭 복귀 때 blur·blank·불필요한 loading 없이 이전 viewport를 즉시 복원한다.
- 복사 실패 이유와 현재/이전 attempt를 구분한다.

## 2. Loading 상태

상태는 다음 세 가지를 구분한다.

| 상태 | 화면 동작 |
| --- | --- |
| Query preparing | filter/sort 전체 결과 index 생성 진행과 Cancel 표시 |
| Foreground page loading | 현재 viewport에 필요한 page loading 표시, 이전 유효 page는 가능한 한 유지 |
| Adjacent prefetch | 사용자에게 별도 전역 spinner를 띄우지 않고 foreground가 없을 때만 실행 |

query 준비가 완료됐더라도 첫 visible page가 오기 전에는 query 상태를 완전히 idle로 표시하지 않는다.
`Query ready`와 빈 grid가 동시에 보이는 중간 상태를 만들지 않는다. foreground page가 준비된 뒤
새 query result, 보존·clamp된 active cell과 idle 상태를 한 번에 commit한다.

## 3. Pending과 오류

- loading cell은 해당 foreground page 요청이 실제 in-flight일 때만 표시한다.
- projection 또는 scroll generation 변경으로 폐기된 요청은 loading set에서도 즉시 제거한다.
- backend 오류나 취소는 영구 loading cell을 남기지 않는다.
- foreground page 실패 또는 15초 timeout 시 기존 query는 유지하고 page 범위가 포함된 오류와 Retry를 제공한다.
- Retry는 같은 query identity와 현재 projection을 다시 확인하고 stale query에는 실행하지 않는다.
- prefetch 실패는 현재 visible page를 오류로 바꾸지 않지만 실제 이동 시 foreground로 다시 요청한다.

## 4. Keyboard와 논리 좌표

query가 활성화되면 grid row coordinate는 정렬 결과의 logical position이다. source row identity는
사용자 focus나 selection coordinate로 노출하지 않는다.

| 입력 | 기대 동작 |
| --- | --- |
| `↑/↓/←/→` | 한 logical cell 이동 |
| `Shift+화살표` | anchor부터 한 cell씩 확장·축소 |
| `PageUp/PageDown` | viewport 기준 logical row 이동 후 target page 표시 |
| `Home/End` | 현재 row의 첫/마지막 logical column 이동 |
| `Ctrl+↑/↓` | 정렬된 결과 순서의 occupied/empty 경계 이동 |
| `Ctrl+←/→` | 현재 logical row의 projection 순서에서 경계 이동 |
| `Ctrl+Alt+↑/↓` | query 결과의 첫/마지막 row 이동 |
| `Ctrl+Alt+←/→` | query projection의 첫/마지막 column 이동 |
| 각 `Shift` 조합 | 기존 anchor를 유지한 범위 확장 |

target page가 아직 없으면 active selection은 성공한 target page와 identity를 검증한 뒤 commit한다.
그 전에는 focus outline이 데이터가 없는 위치로 먼저 이동하지 않는다. 실패 시 selection과 scroll은
이동 전 상태를 유지한다.

## 5. Scroll과 prefetch

- visible foreground page가 항상 adjacent prefetch보다 높은 우선순위를 가진다.
- foreground 요청 중 새 scroll 입력이 오면 아직 시작하지 않은 prefetch를 버린다.
- 빠른 scroll에서 중간 offset을 모두 요청하지 않고 마지막 visible offset을 우선한다.
- 같은 offset과 projection의 중복 요청은 하나의 promise를 공유한다.
- horizontal scroll로 projection이 달라지면 이전 projection page는 현재 cell을 채우지 않는다.
- foreground page가 표시된 뒤 viewport가 page 끝의 prefetch 거리 안에 있을 때만 다음 page를 읽는다.

## 6. Selection과 focus visibility

- page 교체는 anchor와 active logical coordinate를 바꾸지 않는다.
- filter/sort commit은 active row의 logical position과 active column ID를 보존하고 새 result 범위에 clamp한다.
- query 의미가 달라졌을 때 기존 직사각형 range는 보존된 active cell 하나로 축소한다.
- active cell이 target page에 나타난 뒤 최소한으로 scroll하여 cell 전체가 viewport 안에 오게 한다.
- row가 loading인 동안 selection outline을 잘못된 이전 row에 그리지 않는다.
- segmented grid recenter와 query page 교체가 동시에 발생해도 active logical row가 달라지지 않는다.
- 마지막 row는 horizontal scrollbar 위에 완전히 보이는 Phase 11 geometry 계약을 유지한다.

보존 대상은 같은 source record가 아니라 같은 logical row·column 자리다. 같은 source record가 filter에서
제외되거나 sort로 이동하더라도 별도 identity lookup으로 따라가지 않는다.

## 7. Progress와 cancellation

정렬 index 생성에는 기존 query progress와 Cancel을 사용한다. page 조회는 200행 상한이므로 별도
modal progress를 만들지 않는다. 다만 합의된 page timeout을 넘으면 loading 상태를 계속 숨기지 않고
진단 가능한 오류로 전환한다.

- query Cancel: index 생성과 아직 commit되지 않은 first page를 함께 취소
- 새 filter/sort: 이전 query와 page request generation 폐기
- tab close/session change: 모든 query page, boundary와 prefetch 결과 폐기
- 새 keyboard/mouse navigation: 이전 boundary target을 취소하고 새 입력 queue를 사용

## 8. Filter·sort와 Find

- toolbar의 전역 `Filter/Find` mode switch와 match-only Filter는 제거한다.
- column header의 typed filter control은 유지한다.
- `Ctrl+F`는 접힌 Find bar를 열고 input에 focus한다.
- 입력 중 text는 draft이며 debounce를 포함해 backend 조회를 시작하지 않는다.
- `조회` button 또는 Enter가 draft를 commit하고 previous/next match action을 활성화한다.
- Esc는 Find bar를 닫되 이미 적용된 column filter/sort는 바꾸지 않는다.
- filter/sort가 바뀌면 이전 Find 결과는 stale로 표시하고 사용자가 다시 `조회`할 때 갱신한다.

sort는 header의 일반 click 단일 정렬과 Shift+click 다중 정렬을 계속 지원하며 이 동작은 즉시 commit한다.
별도 정렬 summary/panel은 `1. group_id ↑`, `2. time ↓`처럼 priority와 direction을 보여 주며
criterion 추가·제거·방향 변경과 drag/keyboard priority reorder를 draft에 적용한 뒤 Apply에서 한 번
commit한다. panel을 취소하면 committed plan은 바뀌지 않으며 같은 criteria는 Shift+header와 동일한
ordered plan을 만든다.

## 9. 파일 탭과 컬럼 순서 변경

- 파일 tab은 drag handle/영역으로 순서를 바꾸며 active document와 열린 session은 유지한다.
- column header drag는 현재 document의 visible order를 바꾼다.
- drag 중 drop indicator와 원래/대상 위치를 표시하고 resize separator·sort click과 gesture를 구분한다.
- pointer drag만 강제하지 않는다. keyboard로 tab 또는 column menu를 연 뒤 `왼쪽으로 이동`과
  `오른쪽으로 이동` action을 실행하는 동등한 reorder 경로를 제공한다.
- column reorder 뒤 width, visibility, filter, sort priority와 active column은 column ID로 유지한다.
- copy header와 data column 순서는 reorder된 visible 순서를 따른다.

## 10. 탭 복귀 UX

- inactive document는 마지막 populated grid를 document state로 보존한다.
- 복귀할 때 이전 scroll, segmented anchor, selection, focus와 projection을 첫 paint 전에 복원한다.
- cache가 유효한 복귀에는 전역 spinner, blur, empty-grid flash와 loading text를 표시하지 않는다.
- 실제 source/session/query가 바뀌어 재조회가 필요할 때만 명시적 loading 상태를 표시한다.
- inactive tab에서 완료된 stale request는 복귀 화면을 덮어쓰지 않는다.

## 11. 복사 UX

복사는 현재 query snapshot과 selection을 먼저 확정한 뒤 시작한다.

- 부분 선택은 filter 결과의 선택 row·visible column을 현재 sort와 column 순서로 복사한다.
- 전체 선택은 filter를 통과한 모든 row와 visible column만 복사한다.
- Find 위치는 selection을 직접 바꾸지 않는 한 copy 범위를 바꾸지 않는다.
- 긴 작업은 row/cell 또는 byte 기반 progress, Cancel과 작업 번호를 표시한다.
- 1,048,576행을 넘으면 Excel sheet 한도 경고를 표시하되 일반 TSV hard limit과 혼동하지 않는다.
- 성공하기 전 system clipboard를 바꾸지 않으며 실패·취소에서는 기존 clipboard를 유지한다.

현재 작업은 `이번 복사 #N`으로 표시하고 시작 시각, 범위, representation과 stage를 함께 보여 준다.
최근 이전 작업은 별도 접기 영역에 최대 5개 남긴다. 실패는 최소한 제한 초과, 원본 읽기, query 변경,
직렬화, clipboard 기록과 취소를 구분하고 가능한 경우 Retry를 제공한다. 현재 실패는 `role=alert`,
진행과 성공은 `role=status`를 사용한다.

## 12. 접근성과 검증 가능한 표시

- grid의 `aria-busy`는 foreground page 또는 query prepare 동안만 true다.
- status text는 `Preparing query`, `Loading rows N–M`, `Page load failed`를 구분한다.
- spinner만으로 상태를 표현하지 않고 접근 가능한 status text를 함께 제공한다.
- 오류 Retry는 keyboard focus가 가능하고 accessible name에 대상 row 범위를 포함한다.
- input control focus에서는 기존처럼 grid 단축키를 가로채지 않는다.
- focus와 selection은 색상뿐 아니라 outline으로 구분한다.
- tab/column drag target과 sort priority는 screen reader가 읽을 수 있는 position/level을 제공한다.
- Find `조회`, copy Cancel/Retry와 history toggle은 keyboard focus와 명확한 accessible name을 가진다.

## 13. Screenshot과 geometry 상태

세 viewport에서 다음 상태를 검증한다.

1. 정렬 적용 전 populated grid
2. query preparing
3. 정렬 후 첫 page populated
4. PageDown foreground loading
5. page error와 Retry
6. last row와 active focus
7. `Ctrl+F` Find draft와 committed result
8. multi-sort summary/panel과 column drag indicator
9. copy progress, current failure와 previous history
10. 다른 파일 tab 복귀 직후 populated grid

row 높이와 기존 column width 계약은 유지한다. toolbar에서 전역 Filter mode를 제거하고 Find는
필요할 때만 열어 minimum viewport의 grid 높이를 불필요하게 줄이지 않는다.

## 14. UX 완료 조건

- 정렬 완료 뒤 빈 grid 또는 영구 loading cell이 없다.
- 빠른 scroll과 연속 PageDown/PageUp에서 마지막 입력의 logical page가 표시된다.
- 모든 Ctrl/Ctrl+Alt와 Shift 조합의 active, anchor, rect와 focus visibility가 정확하다.
- stale·cancel·error가 이전 selection과 유효 page를 비원자적으로 지우지 않는다.
- 세 viewport와 실제 WebView2에서 geometry, keyboard와 status가 검증된다.
- filter/sort 뒤 logical focus가 보존되고 range만 active cell로 안전하게 축소된다.
- tab 복귀에 blur/blank/loading flash와 유효 cache의 page IPC가 없다.
- Find는 명시적 조회 전 backend call이 없고 파일/컬럼 reorder와 multi-sort가 keyboard로도 가능하다.
- query-aware 부분/전체 copy의 범위·순서, progress, cancel과 current/history 오류가 구분된다.
