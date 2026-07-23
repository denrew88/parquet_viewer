# Phase 14 UI 개선 설계

## 1. 범위

이 문서는 다음 UI 변경의 확정 계약을 정의한다.

1. Excel 방식으로 빈 정렬 level을 먼저 추가하는 multi-sort editor
2. Settings와 Copy settings의 typography 균형 조정
3. Value display formats의 inline primary control과 accordion detail
4. 헤더와 현재 보이는 셀이 함께 움직이는 column live reflow drag
5. 원본 파일 schema 순서로 컬럼을 복원하는 버튼

데이터 query 의미, filter→ordered sort 순서, display/default/raw copy 의미, source schema와 파일 내용은
변경하지 않는다. 변경 사항은 UI draft, 표시와 document별 column order에만 적용한다.

## 2. Multi-sort editor

### 2.1 현재 문제

현재는 하단에서 검색과 컬럼 선택을 먼저 마친 뒤 `Add sort level`을 눌러야 정렬 행이 생성된다.

```text
Find a column → Select a column → Add sort level
```

사용자는 정렬 기준의 개수와 우선순위를 먼저 구성할 수 없고, Excel의 `Add level` 동작과도 다르다.
또한 현재 draft row는 `columnId`를 React key와 pointer reorder ID로 같이 사용하므로 컬럼이 선택되지
않은 빈 행을 안정적으로 표현할 수 없다.

### 2.2 변경 UI

panel 상단 또는 criteria 목록 바로 위에 `Add level`을 둔다.

```text
Multi-column sort
Drag rows to change sort priority.

[+ Add level]

[⠿ 1] [Choose a column...       ] [Ascending  ▼] [×]
[⠿ 2] [Choose a column...       ] [Ascending  ▼] [×]

[Clear all]                         [Cancel] [Apply]
```

- `Add level`을 누르면 즉시 빈 draft row를 마지막에 추가한다.
- 새 행의 column combobox에 focus를 이동하고 선택 목록을 연다.
- 컬럼과 방향은 어느 순서로든 변경할 수 있다.
- 새 level의 기본 방향은 `Ascending`, `nullsLast`는 기존 계약을 유지한다.
- 사용자는 빈 행도 drag해 우선순위를 바꿀 수 있다.
- 삭제 후 priority 번호는 1부터 연속으로 다시 표시한다.
- 최대 64 level 계약을 유지하며 64개에서 `Add level`을 비활성화한다.

### 2.3 Draft model

backend로 보내는 `QuerySort`와 UI draft를 분리한다.

```ts
interface SortDraftRow {
  readonly draftId: string;
  readonly columnId: string;
  readonly direction: "ascending" | "descending";
  readonly nullsLast: boolean;
}
```

- `draftId`는 row 생성 시 한 번 발급하고 컬럼 변경과 reorder 중 유지한다.
- `columnId`는 draft에서 빈 문자열을 허용한다.
- pointer reorder와 React key는 `draftId`를 사용한다.
- Apply 시 모든 행이 valid한 경우에만 `QuerySort[]`로 변환한다.

### 2.4 Column combobox

각 sort row의 column control은 검색 가능한 combobox다.

```text
Search columns...
──────────────────────
row_id
group_id
category
hidden_column (Hidden)
```

- visible/hidden을 포함한 모든 source 컬럼을 표시한다.
- hidden 컬럼에는 `(Hidden)`을 붙인다.
- 다른 sort row에서 이미 선택한 컬럼은 `Already used`로 표시하고 선택을 막는다.
- 현재 행이 이미 가진 컬럼은 그대로 선택 가능하다.
- 검색어가 비어 있으면 모든 컬럼을 source schema 순서로 표시한다.
- 검색은 label의 대소문자를 구분하지 않는 부분 일치다.
- 기존 하단 `Find a column`, `Column to add`, `Add sort level` 조합은 제거한다.

### 2.5 Validation과 Apply/Cancel

- 빈 `columnId`가 하나라도 있으면 Apply를 비활성화하고 해당 행에 `Choose a column` 상태를 표시한다.
- duplicate, 존재하지 않는 컬럼, 64개 초과 draft는 Apply하지 않는다.
- direction은 각 행에서 항상 valid한 기본값을 가진다.
- `Cancel`, outside close와 Escape는 전체 draft를 폐기하고 적용된 sort를 변경하지 않는다.
- `Clear all`은 draft row를 전부 제거한다.
- sort 0개로 Apply하면 기존 적용된 sort를 취소하고 source order query로 돌아간다.
- Apply 뒤 기존 계약대로 active logical row/column 좌표를 유지하고 범위 선택은 활성 셀 하나로 축소한다.

## 3. Settings typography

### 3.1 목표

현재 `Copy settings` 버튼과 Value display type 행은 주변의 11~13px label보다 큰 inherited body font를
사용해 시각적 위계가 불균형하다. 모든 글자를 일괄 축소하지 않고 dialog title, section heading,
field label과 preview의 계층을 통일한다.

| 요소 | 크기와 weight |
| --- | --- |
| Settings/Copy settings dialog title | 16px, 650 |
| Section heading | 13px, 650 |
| 일반 label·button·select | 12px, normal 또는 600 |
| Value type 이름 | 12px, 650 |
| 현재 설정 summary·preview | 11px, normal |
| 설명·도움말·validation | 11px, normal |
| input 값 | 12px, normal |

### 3.2 적용 대상

- Settings의 `Copy settings` button을 12px로 명시한다.
- 별도 Copy settings dialog의 제목은 16px로 조정한다.
- `String`, `Integer`, `Decimal`, `Date`, `Timestamp`, `Duration`, `Boolean`, `Binary` label은
  12px semibold로 통일한다.
- format preview는 11px monospace를 유지한다.
- 상세 control label/select/input은 12px로 통일한다.
- dialog action button은 12px를 사용하되 primary Apply의 weight와 색 대비는 유지한다.
- minimum viewport에서도 Windows font scaling 때문에 text가 잘리지 않도록 고정 height 대신
  `min-height`와 line-height를 사용한다.

## 4. Value display formats inline accordion

### 4.1 현재 문제

현재 type summary를 누르면 목록 전체가 단일 type detail 화면으로 교체된다. 설정 항목이 하나뿐인
Integer, Date, Boolean도 상세 화면으로 이동해야 하고, 다른 type을 편집하려면 `All formats`로 돌아가야
한다.

### 4.2 기본 화면

type별로 가장 자주 쓰는 control과 실제 production formatter preview를 첫 화면에 직접 표시한다.

```text
Value display formats

String
  Line breaks [On]                       First line ↵ Second line
  ▾ More options

Integer
  Grouping [Comma ▼]                     1,234,567

Decimal
  Notation [General ▼] Grouping [None ▼] 1,234.56789
  ▾ More options

Date
  Format [YYYY-MM-DD ▼]                  2025-12-18

Timestamp
  Preset [Standard ▼]                    2025-12-18 01:23:34.111111111
  ▾ More options

Duration
  Style [Total hours ▼]                  51:04:05.123456789
  ▾ More options

Boolean
  Format [true / false ▼]                true

Binary
  Encoding [Hex ▼]                       01 02 03 04
  ▾ More options
```

### 4.3 기본 control과 상세 control

| 타입 | 첫 화면 | 펼친 상세 |
| --- | --- | --- |
| String | Render line breaks | Wrap long lines, nested format |
| Integer | Grouping | 없음 |
| Decimal | Floating notation, grouping | Float precision, scale mode, fixed digits |
| Date | Date format | 없음 |
| Timestamp | Preset | date/time format, separator, fraction, digits, timezone suffix |
| Duration | Style | fraction, digits, unit suffix |
| Boolean | Representation | 없음 |
| Binary | Encoding | preview bytes |

상세 항목이 없는 Integer, Date, Boolean에는 펼치기 button을 표시하지 않는다.

### 4.4 Accordion 동작

type을 선택하면 목록을 교체하지 않고 해당 type row 아래에 detail panel을 펼친다.

```text
Timestamp
  Preset [Standard ▼]      2025-12-18 01:23:34.111111111
  ▴ Hide details

  ┌──────────────────────────────────────────────┐
  │ Date format      [YYYY-MM-DD ▼]              │
  │ Time format      [HH:MI:SS ▼]                │
  │ Separator        [Space ▼]                   │
  │ Fraction         [Preserve ▼]                │
  │ Timezone suffix  [Hidden ▼]                  │
  └──────────────────────────────────────────────┘
```

- 한 번에 상세 panel 하나만 연다.
- 다른 type을 펼치면 이전 상세 panel은 접히지만 Settings draft 값은 유지한다.
- 같은 type의 `Hide details`를 누르면 접는다.
- 기존 `All formats` back button, 중앙 type title과 summary/detail 전체 화면 교체를 제거한다.
- 상세 진입 시 dialog scroll을 초기화하거나 새 화면의 back button으로 focus를 강제 이동하지 않는다.
- 펼칠 때 선택한 type heading/control에 합리적인 focus를 유지한다.
- Settings의 Apply/Cancel, focus trap과 schema V4 persistence 의미는 그대로 유지한다.
- preview는 모든 기본/상세 control 변경에 즉시 반응하되 backend setting은 Apply 전까지 변경하지 않는다.

### 4.5 Responsive layout

- wide/compact에서는 type, primary control, preview를 한 행 grid로 표시한다.
- minimum 800×600에서는 type heading 다음 줄에 primary control과 preview를 표시한다.
- detail controls는 wide/compact에서 2열, minimum에서 1열이다.
- dialog 내부만 scroll하며 body overflow와 nested modal/backdrop을 만들지 않는다.
- accordion open/close가 Settings footer의 위치를 viewport 밖으로 밀지 않게 기존 scroll body를 유지한다.

## 5. Column live reflow drag

### 5.1 목표

현재 source header를 반투명하게 만들고 target에 insertion line만 표시하는 방식을 제거한다. drag 중
헤더와 현재 화면에 mount된 셀을 하나의 floating column strip으로 들어 올리고, 다른 컬럼들이 실시간
으로 좌우로 이동해 실제 drop 위치만큼 빈자리를 만든다.

```text
drag 전

[A] [B] [C] [D]

B를 들어 올린 뒤 C와 D 사이로 이동

[A] [C] [       ] [D]       [B] <- pointer를 따라가는 floating strip
        B의 실제 width

drop 후

[A] [C] [B] [D]
```

### 5.2 Floating column strip

- source header 전체를 표시한다.
- 컬럼명, filter icon, sort indicator와 현재 header state를 포함한다.
- 현재 viewport에 mount된 셀만 header 아래에 같은 row height와 content로 표시한다.
- display format, 최대 2줄 string, empty/null/invalid, selected cell 배경을 보존한다.
- source column의 실제 pixel width와 현재 grid content 높이를 사용한다.
- grid viewport 밖은 clip하고 toolbar/footer 위로 확장하지 않는다.
- overlay는 `pointer-events: none`, `aria-hidden=true`이며 backend page read를 추가하지 않는다.
- pointer가 header 안에서 잡힌 상대 offset을 유지한다.
- 이동은 `translate3d()`로 처리하고 약한 shadow와 1.01~1.02 scale을 적용한다.
- drag cursor는 threshold 전 `grab`, drag 중 `grabbing`이다.

### 5.3 Live reflow

실제 document column order는 pointer move마다 변경하지 않는다. source column을 제외한 order에 현재
insertion 위치만 반영한 `previewOrder`를 계산한다.

```text
previewOrder = reorderAtInsertion(
  appliedOrder,
  movingColumnId,
  targetColumnId,
  side,
)
```

각 non-moving column의 이동 거리는 다음과 같다.

```text
previewOrder의 prefix width 위치 - appliedOrder의 prefix width 위치
```

- header와 해당 컬럼의 모든 mounted cell에 같은 X transform을 적용한다.
- 컬럼별 실제 width를 사용해 이동 컬럼 너비만큼 정확한 빈자리를 만든다.
- target이 바뀌면 120~160ms ease transition으로 다른 컬럼이 좌우로 밀린다.
- 굵은 insertion line은 사용하지 않는다. 빈자리에는 필요한 경우 옅은 background/outline만 표시한다.
- selection/focus 표시도 논리 column ID와 함께 preview 위치로 이동한다.
- horizontal virtualizer가 새 컬럼을 mount하면 같은 preview transform을 즉시 적용한다.
- horizontal edge auto-scroll을 유지하고 scroll에 따라 target과 preview order를 갱신한다.
- drag 중 vertical scroll은 잠근다.

### 5.4 Commit과 cancel

- pointer up에서만 실제 document column order를 한 번 commit한다.
- commit frame에서 preview transform과 새 applied position의 시각적 jump를 방지한다.
- Escape, pointer cancel, lost capture와 window blur는 applied order 변경 없이 원위치로 복귀한다.
- click, column resize, filter/sort button gesture와 reorder threshold를 분리한다.
- drag 시작 시 column 관련 transient popup은 닫는다.
- internal Pointer Events session을 유지하고 HTML5 file drag를 사용하지 않는다.
- internal column drag 동안 Tauri external file-drop overlay와 open request는 0이다.

### 5.5 성능 상한

- floating strip은 mounted row와 moving column 하나만 복제한다.
- 다른 컬럼은 DOM 재배치가 아니라 compositor transform을 사용한다.
- pointer move에서 React document order와 backend state를 갱신하지 않는다.
- drag 때문에 page request, query execution과 full-grid rerender를 추가하지 않는다.
- minimum/compact/wide에서 pointer frame drop과 visible alignment 오차를 측정한다.

## 6. 원본 컬럼 순서 복원

### 6.1 위치와 표시

column finder와 visibility chooser가 있는 toolbar에 작은 `RotateCcw` icon button을 추가한다.

```text
[Find column                 ] [▥] 15 / 15 columns [↶]
                                                       ↑
                                           Restore source column order
```

- visible label을 추가해 toolbar를 복잡하게 만들지 않는다.
- accessible name과 tooltip은 `Restore source column order`다.
- applied order가 source order와 같으면 비활성화한다.
- drag session 중에는 비활성화한다.
- button 공간을 고정해 enable/disable에서 toolbar layout shift를 만들지 않는다.

### 6.2 복원 계약

- document를 열 때 immutable source schema column ID order를 저장한다.
- click하면 현재 존재하는 컬럼을 source schema 순서로 복원한다.
- schema에 없던 잔여 ID가 있으면 기존 상대 순서를 유지해 마지막에 붙인다.
- hidden/visible 상태를 변경하지 않는다.
- column width, manual resize와 auto-fit 결과를 column ID별로 유지한다.
- filter, multi-sort, Find와 query result를 변경하지 않는다.
- active cell은 같은 logical row와 column ID를 유지한다.
- active column이 viewport 밖으로 이동하면 복원 후 해당 column을 보이도록 한 번 scroll한다.
- selection은 column ID 기반 의미를 유지하고 새 visual position에 표시한다.
- 각 document/tab이 source/applied order를 독립적으로 보존한다.

## 7. 테스트와 완료 조건

### 7.1 Unit/component

- 빈 sort level 생성, 방향 우선 변경, column 선택, duplicate, remove, reorder와 최대 64개
- incomplete sort Apply 비활성화, Cancel/Clear all과 applied plan 불변
- typography selector별 computed font size와 minimum line-height
- 모든 type의 inline primary control, 단일 accordion, preview, Apply/Cancel draft parity
- variable-width column의 preview prefix 위치와 live reflow delta
- drag commit/cancel/lost capture/Escape, selection/focus와 resize/filter gesture 분리
- source order restore의 visibility/width/query/focus 보존

### 7.2 Playwright 세 viewport

- 1440×900, 1024×768, 800×600에서 multi-sort blank level과 searchable combobox
- Settings summary와 Timestamp/Duration/Decimal detail의 clipping, body overflow, footer 가시성
- moving column strip과 좌우로 밀리는 header/cell의 alignment 오차 1px 이하
- variable width first/middle/last column drag와 horizontal edge auto-scroll
- restore button enable/disable, same-column focus와 scroll visibility
- drag 중 file-drop overlay 0

### 7.3 실제 Tauri

- WebView2 pointer로 full visible column strip drag와 live reflow를 확인한다.
- drag 중 Windows file-drop state가 시작되지 않는지 확인한다.
- 실제 font rendering에서 Copy settings/type label의 크기와 clipping을 확인한다.
- 100%와 가능한 환경의 150% DPI에서 minimum/compact 대응 창을 검증한다.

완료 증거에는 interaction 결과, geometry JSON과 multi-sort, Settings accordion, column drag, restored order의
세 viewport screenshot 및 실제 Tauri screenshot을 포함한다. 브라우저 mock만으로 native pointer drag를
PASS 처리하지 않는다.
