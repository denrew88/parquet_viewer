# Phase 6 선택·키보드·클립보드 테스트 계획 (Draft)

- 작성일: 2026-07-14
- 기준: `PROJECT_SPEC` 9~10절, `DEVELOPMENT_PLAN` Phase 6, `UI_VALIDATION`, Phase 5 grid 좌표·가상화 계약
- 상태: 구현 전 Root 승인 필요
- 핵심 원칙: 선택은 DOM node가 아니라 `sessionId`, logical row/column 좌표로 관리하고, 복사는 보이는 DOM이 아니라 논리 rect를 읽는다.

## 제안 수치 계약

| 항목 | 제안값 | 판정 방식 |
| --- | --- | --- |
| soft limit | `100,000셀` 또는 예상 UTF-8 TSV `8 MiB` 중 먼저 도달 | 사용자 확인 전 조회·clipboard write 금지 |
| hard limit | `1,000,000셀` 또는 실제 TSV `64 MiB` 중 먼저 도달 | 확인 여부와 무관하게 typed error, clipboard 불변 |
| copy chunk | 최대 `200행`, `100,000셀`, 직렬화 전 추정 `4 MiB` | 한 번에 하나만 조회, page key dedupe |
| 진행 표시 | 시작 후 `150ms` 이내, 이후 chunk마다 또는 `250ms`마다 | 처리 rows/cells와 전체 예상량 표시 |
| 취소 반응 | UI는 `100ms` 이내 cancelling 표시, 현재 chunk 종료 전 cooperative cancel | clipboard 불변, 임시 buffer 해제 |
| 메모리 | copy 전후 안정값 대비 JS+native working set 증가 `96 MiB` 이하 | hard-limit fixture 3회 반복 후 회수 확인 |
| 자동 scroll | pointer가 viewport 가장자리 `24px` 안, 속도 `4..24px/frame` | 거리 비례, 한 frame에 active 좌표 1회 갱신 |
| focus scroll | active cell이 완전히 보이도록 최소 이동, 허용 오차 `2 CSS px` | header/row-number를 가리지 않음 |
| selection outline | 논리 rect의 보이는 교집합과 `2 CSS px` 이내 | unmounted 영역은 edge continuation 표시 |

soft 확인 문구에는 행×열, 셀 수, 예상 크기를 표시한다. hard limit은 `CopyLimitExceeded`와 실제/허용 수치를 반환한다. 직렬화 도중 실제 byte가 hard limit을 넘으면 즉시 중단하며 부분 TSV를 clipboard에 쓰지 않는다.

## 선택 상태 계약

```text
SelectionState = {
  sessionId,
  anchor: { row, column },
  active: { row, column },
  rect: { top, left, bottom, right }, // inclusive, 항상 정규화
  kind: cell | row | column | all,
  includeColumnHeaders: boolean,
  generation
}
```

- `rect`는 `min/max(anchor, active)`로 파생하며 저장값과 파생값 불일치를 허용하지 않는다.
- click은 anchor/active를 같은 좌표로, shift-click은 anchor를 보존하고 active만 변경한다.
- drag는 pointer-down 좌표를 anchor로 고정하고 hit-test logical coordinate로 active를 갱신한다.
- row header는 해당 row와 현재 표시 data column 전체, column header는 해당 column과 전체 logical data row를 선택한다.
- column header를 명시적으로 선택한 경우에만 `includeColumnHeaders=true`다. row/all 선택의 TSV에는 header를 자동 추가하지 않는다.
- session/generation 교체 시 이전 선택을 제거한다. virtual unmount, page eviction, scroll은 선택을 제거하지 않는다.
- Escape는 range를 active 단일 셀로 축소한다. active가 없거나 0행/0열이면 no-op다.

## Fixture

| ID | 내용 |
| --- | --- |
| `F-P6-01` | 12행×8열 dense table, 값 `R{row}C{col}`, viewport page step 4행 |
| `F-P6-02` | 12×4 sparse matrix: 연속 값, 빈 셀, 단일 값, 빈 행을 의도적으로 배치한 Ctrl 경계 fixture |
| `F-P6-03` | 10,240×120 Phase 5 virtual Parquet, page 200, 앞·뒤 page 지연 제어 |
| `F-P6-04` | 0×0, 0×8, 1×1, 1×120, 10,000×1 경계 묶음 |
| `F-P6-05` | TSV 값: tab, CR, LF, CRLF, `"`, leading/trailing space, Unicode, null, empty string, literal `null` |
| `F-P6-06` | soft 바로 아래/동일/바로 위의 cell·byte 조합과 사용자 confirm/cancel double |
| `F-P6-07` | hard 바로 아래/동일/바로 위, 단일 65 MiB 값, 1,000,001셀 조합 |
| `F-P6-08` | chunk adapter: offset/projection별 지연·실패·취소·stale resolve와 호출 수 제어 |
| `F-P6-09` | session A/B, projection A/B, CSV generation 1/2 결과가 교차 완료되는 fixture |
| `F-P6-10` | 실제 Excel용 7행×6열 고정 TSV fixture와 기대 workbook cell manifest |

fixture manifest는 seed, 좌표별 checksum, null/empty type, UTF-8 byte 수, page별 checksum을 기록한다.

## Reducer 단위 테스트

| ID | 입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P6-001` | null→click(3,4) | anchor=active=(3,4), rect=3,4,3,4, kind=cell | Grid UX |
| `T-P6-002` | anchor(7,6), active(2,1) | rect=2,1,7,6으로 정규화 | Grid UX |
| `T-P6-003` | 기존 anchor + shift-click(9,0) | anchor 불변, active=(9,0), rect 재계산 | Grid UX |
| `T-P6-004` | drag (2,2)→(8,5)→(1,0) | anchor 고정, 매 hit-test마다 normalized rect | Grid UX |
| `T-P6-005` | row header 4 | row 4와 표시 data columns 전체, kind=row | Grid UX |
| `T-P6-006` | column header 3 | 전체 logical rows×column 3, kind=column, header 포함 | Grid UX |
| `T-P6-007` | corner/all command | 전체 logical data rect, kind=all, header 자동 포함 안 함 | Grid UX |
| `T-P6-008` | Escape(range) | anchor=active=이전 active, 단일 rect | Grid UX |
| `T-P6-009` | 같은 session virtual unmount/remount | 좌표·rect·generation 불변 | Grid UX |
| `T-P6-010` | session/generation 교체 | 선택 제거, 늦은 reducer action 무시 | Grid UX |
| `T-P6-011` | hidden column 포함 전후 | 표시 logical column identity로 rect 재정규화, 다른 원본 열 선택 금지 | Grid UX |
| `T-P6-012` | invalid/negative/out-of-range 좌표 | clamp가 아닌 typed reject 또는 명시 no-op, state 불변 | Grid UX |

## Table-driven 키 매트릭스

기본 상태는 F-P6-01의 anchor=active=(5,3), rect 단일 셀이다. `pageStep=4`, 마지막 좌표=(11,7)이다. Ctrl은 macOS에서 Meta로 동일하게 반복한다.

| ID | Key | Modifier | 기대 active | 기대 anchor/rect | 담당 |
| --- | --- | --- | --- | --- | --- |
| `T-P6-020` | ArrowUp | 없음 | (4,3) | anchor=active, 단일 | Grid UX |
| `T-P6-021` | ArrowDown | 없음 | (6,3) | anchor=active, 단일 | Grid UX |
| `T-P6-022` | ArrowLeft/Right | 없음 | (5,2)/(5,4) | 각 단일 | Grid UX |
| `T-P6-023` | ArrowDown | Shift | (6,3) | anchor=(5,3), rect rows 5..6 | Grid UX |
| `T-P6-024` | ArrowUp×2 | Shift | (3,3) | anchor 고정, 확장 후 역방향 축소 정확 | Grid UX |
| `T-P6-025` | ArrowRight | Ctrl | sparse 규칙의 다음 경계 | anchor=active, 단일 | Grid UX |
| `T-P6-026` | ArrowRight | Ctrl+Shift | 다음 경계 | anchor 고정, 경계까지 rect | Grid UX |
| `T-P6-027` | Home | 없음 | (5,0) | 단일 | Grid UX |
| `T-P6-028` | End | 없음 | (5,7) | 단일 | Grid UX |
| `T-P6-029` | Home/End | Shift | (5,0)/(5,7) | anchor 고정, 행 범위 확장 | Grid UX |
| `T-P6-030` | Home | Ctrl | (0,0) | 단일 | Grid UX |
| `T-P6-031` | End | Ctrl | (11,7) | 단일 | Grid UX |
| `T-P6-032` | PageUp | 없음 | (1,3) | 단일, 4행 이동 | Grid UX |
| `T-P6-033` | PageDown | 없음 | (9,3) | 단일, 4행 이동 | Grid UX |
| `T-P6-034` | PageUp/Down | Shift | ±4행 | anchor 고정, rect 확장 | Grid UX |
| `T-P6-035` | A | Ctrl | (11,7) | 전체 rect, kind=all | Grid UX |
| `T-P6-036` | Escape | 없음 | (5,3) | active 단일 셀로 축소 | Grid UX |
| `T-P6-037` | 위 명령 전체 | Meta | Ctrl 대응 결과와 동일 | 동일 | Grid UX + Quality |
| `T-P6-038` | 방향/Home/End | 경계에서 | 경계 좌표 유지 | state 유효, scroll 추가 이동 없음 | Grid UX |
| `T-P6-039` | 모든 key | Alt 또는 조합 외 modifier | 명세 command 미실행 | browser/OS 기본 동작 방해 없음 | Grid UX |

### Ctrl 경계 매트릭스

| ID | 시작 셀 상태 | 방향의 값 분포 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P6-040` | non-empty | 연속 non-empty 뒤 empty | 연속 영역의 마지막 non-empty | Grid UX |
| `T-P6-041` | non-empty 경계 | 바로 empty 뒤 다음 영역 | 다음 non-empty 또는 table boundary | Grid UX |
| `T-P6-042` | empty | 여러 empty 뒤 non-empty | 첫 non-empty | Grid UX |
| `T-P6-043` | empty | 끝까지 empty | table boundary | Grid UX |
| `T-P6-044` | non-empty | 끝까지 연속 | table boundary | Grid UX |
| `T-P6-045` | unloaded page 포함 | 경계 판정에 필요한 page 지연 | bounded fetch 후 동일 결과, 현재 선택 유지 | Grid UX + Rust Data |
| `T-P6-046` | unknown-total CSV | hasMore true→false | 확인된 EOF까지만 이동, sentinel 선택 금지 | Grid UX + Rust Data |

## Pointer·가상화·focus 테스트

| ID | 시나리오 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P6-050` | click/shift-click 네 방향 | logical 좌표와 rect가 reducer oracle과 일치 | Grid UX |
| `T-P6-051` | 실제 pointer drag, 셀 안/밖 재진입 | pointer capture 유지, rect 정확, text native selection 없음 | Grid UX |
| `T-P6-052` | drag 중 상/하/좌/우 edge | 24px zone 자동 scroll, active 좌표 연속, 속도 4..24px/frame | Grid UX + Quality |
| `T-P6-053` | 10,240×120 첫→중간→끝 키 이동 | page/virtual 경계를 넘어 active·anchor 유지 | Quality |
| `T-P6-054` | 선택 영역 일부/전부 unmount | visible 교집합 outline과 continuation 표시, state 유지 | Quality |
| `T-P6-055` | PageDown으로 미로드 page | 기존 grid 유지, skeleton 뒤 정확한 active cell focus | Grid UX |
| `T-P6-056` | page 실패/재시도 | 선택 state 보존, actionable error, 재시도 후 목표 focus | Grid UX |
| `T-P6-057` | empty/1×1/단일 축 | crash·가짜 좌표 없음, 가능한 명령만 no-op/동작 | Grid UX |
| `T-P6-058` | column hide/resize 후 선택 | identity 유지, outline 2px 이내, 숨긴 열로 focus 이동 안 함 | Quality |
| `T-P6-059` | active 이동 시 auto-scroll | 최소 scroll, sticky header/row-number에 가리지 않음 | Quality |
| `T-P6-060` | search input/resize handle/inspector focus | grid key/Ctrl+A/Ctrl+C 차단, control 기본 편집 유지 | Grid UX |
| `T-P6-061` | grid→toolbar→grid focus 왕복 | 단일 roving focus owner, 선택 유지, focus ring 명확 | Quality |
| `T-P6-062` | pointer drag 중 window blur/Escape | capture 해제, runaway scroll 중지, 유효한 마지막 rect | Grid UX |

## TSV·clipboard 테스트

직렬화 규칙은 data row를 CRLF, column을 tab으로 구분한다. tab/CR/LF/quote가 있는 field는 큰따옴표로 감싸고 내부 quote를 두 번 쓴다. null은 길이 0의 unquoted field, 빈 문자열은 `""`로 기록한다. 마지막 row 뒤에는 추가 CRLF를 붙이지 않는다.

| ID | 입력/시나리오 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P6-070` | 2×3 ASCII rect | 행/열 순서의 정확한 TSV, CRLF 1개 | Grid UX |
| `T-P6-071` | tab/CR/LF/CRLF/quote | quote·double quote 후 재파싱 구조/값 일치 | Rust Data + Grid UX |
| `T-P6-072` | null, empty, literal null | ``, `""`, `null`로 구분되는 payload | Rust Data |
| `T-P6-073` | Unicode/emoji/decimal/int64/timestamp | UTF-8 및 display string 정밀도 보존 | Rust Data |
| `T-P6-074` | column header 명시 선택 | header 1행 포함, 특수 header도 동일 quoting | Grid UX |
| `T-P6-075` | cell/row/all 선택 | 명시 header 선택이 아니면 header 미포함 | Grid UX |
| `T-P6-076` | virtualized·paged rect | DOM mounted 여부와 무관하게 checksum 완전 일치 | Grid UX + Rust Data |
| `T-P6-077` | clipboard write 성공/권한 실패 | 성공 안내 또는 typed error, 기존 grid/selection 유지 | Tauri Platform |
| `T-P6-078` | soft 아래/경계 | 확인 없이 copy, clipboard 1회 atomic write | Grid UX |
| `T-P6-079` | soft 초과 confirm/cancel | confirm만 chunk 시작, cancel은 조회/write 0회 | Grid UX |
| `T-P6-080` | hard cell/byte 경계 초과 | `CopyLimitExceeded`, write 0회, 메모리 상한 | Rust Data + Quality |
| `T-P6-081` | 3개 이상 chunk | 순서·progress 단조 증가, 동시 fetch 1개 | Rust Data |
| `T-P6-082` | 중간 chunk typed failure | partial write 없음, retry 가능, 선택 유지 | Rust Data + Grid UX |
| `T-P6-083` | 진행 중 cancel | 다음 chunk 없음, clipboard 불변, buffer 회수 | Rust Data + Grid UX |
| `T-P6-084` | copy A 뒤 session B/open | A 성공·실패 모두 stale 폐기, B UI/clipboard 불변 | Grid UX |
| `T-P6-085` | projection/generation 변경 | 이전 chunk 폐기, 잘못된 열 값 혼합 0건 | Grid UX + Rust Data |
| `T-P6-086` | Ctrl+C/Meta+C 반복 | 중복 command당 atomic write 1회, 최신 generation만 완료 | Grid UX |

## Browser·geometry·screenshot 증거

| ID | 검증 | 필수 증거 | 담당 |
| --- | --- | --- | --- |
| `T-P6-090` | 1440×900 single/range/row/column selection | interaction log, logical state JSON, screenshot | Quality |
| `T-P6-091` | 1024×768 keyboard+auto-scroll | key sequence, before/after scroll/active 좌표 | Quality |
| `T-P6-092` | 800×600 drag auto-scroll+progress | geometry JSON, screenshot, overlap/overflow 판정 | Quality |
| `T-P6-093` | outline geometry | visible selected cell union 대비 각 edge 오차 <=2px | Quality |
| `T-P6-094` | virtual unmount/remount | mounted range·padding·selection state·outline JSON | Quality |
| `T-P6-095` | input isolation | input value/caret/selection과 grid state 동시 기록 | Quality |
| `T-P6-096` | clipboard browser adapter | exact UTF-8/escaped TSV와 write 호출 수 | Quality |
| `T-P6-097` | loading/error/cancel screenshot | 기존 grid, selection, progress/banner 무겹침 | Quality |

필수 screenshot은 `browser-desktop-single.png`, `browser-desktop-range.png`, `browser-compact.png`, `browser-minimum-progress.png`다. geometry JSON에는 viewport, grid rect, visible logical range, anchor/active/rect, outline rect, scroll/client 크기, mounted row/column/cell 수를 저장한다.

## Native clipboard·Excel 증거

| ID | 검증 | 기대 결과/증거 | 담당 |
| --- | --- | --- | --- |
| `T-P6-100` | Windows Tauri Ctrl+C | 실제 시스템 clipboard text hash와 예상 TSV hash 일치 | Tauri Platform |
| `T-P6-101` | F-P6-10을 실제 Excel A1에 paste | 7×6 cell 구조, tab/newline/quote/Unicode manifest 일치 | Tauri Platform + Quality |
| `T-P6-102` | null/empty Excel paste | payload 차이를 기록하고 Excel 표시/수식 입력줄 결과를 셀별 증거화 | Quality |
| `T-P6-103` | 큰 selection progress/cancel | native screenshot, 요청 로그, clipboard before/after hash | Tauri Platform |
| `T-P6-104` | Meta parity | macOS 실행 가능 시 실제 Command smoke, 불가 시 BLOCKED와 환경 기록 | Tauri Platform |

Excel 증거에는 Excel 버전, locale, paste 대상 workbook, 입력 TSV SHA-256, paste 후 used range와 각 셀의 value/type를 기록한다. Excel 자동화가 불가능하면 사람이 확인한 screenshot만으로 PASS하지 않고 구조 manifest까지 수집하거나 BLOCKED 처리한다.

## 필수 artifact

```text
artifacts/phase-6/
  10-test-plan.md
  selection-matrix-results.json
  clipboard-fixture-manifest.json
  copy-limit-results.json
  ui/
    interaction-results.md
    geometry-results.json
    visual-review.md
    browser-desktop-single.png
    browser-desktop-range.png
    browser-compact.png
    browser-minimum-progress.png
    native-desktop.png
    native-smoke.md
    excel-paste-results.json
```

## 완료 Gate

1. `T-P6-001`~`104` 중 플랫폼 비적용 항목을 제외한 모든 필수 테스트가 PASS다.
2. reducer와 key matrix는 모든 modifier 조합, sparse/empty/bounds를 table-driven test로 검증한다.
3. virtual/page 경계를 넘는 선택과 복사에서 wrong-cell, stale apply, partial clipboard write가 0건이다.
4. soft 확인, hard 거부, progress, cancel, 메모리 상한이 경계값 바로 아래/동일/바로 위에서 검증된다.
5. Browser interaction·geometry·필수 viewport screenshot과 실제 Tauri clipboard 증거가 존재한다.
6. 실제 Excel paste의 행×열 구조와 특수값 manifest가 일치한다. 실행 불가 항목은 근거와 함께 BLOCKED이며 대체 증거로 PASS하지 않는다.

## Root 승인 필요 결정

1. soft `100,000셀/8 MiB`, hard `1,000,000셀/64 MiB`, memory `+96 MiB`를 확정할지.
2. null=`빈 unquoted field`, empty string=`""`로 TSV 표현할지와 실제 Excel 표시 차이를 제품 문구에 명시할지.
3. Home/End는 현재 행 첫/마지막 열, Ctrl+Home/End는 table 첫/마지막 셀로 확정할지.
4. Ctrl 경계에서 현재 non-empty 영역 끝에 이미 있으면 다음 non-empty 영역으로 이동하는 규칙을 확정할지.
5. Ctrl+A와 row/all 선택에는 header를 자동 포함하지 않고 명시적 column-header 선택에서만 포함할지.

## 2026-07-19 Ctrl 경계 탐색 성능 회귀

| ID | 계층 | 검증 |
| --- | --- | --- |
| `NAV-RPC-001` | Rust/TS boundary | 잘못된 direction·mode·좌표·column·session/query identity를 typed reject |
| `NAV-RPC-002` | Rust/TS unit | valid·invalid·null·empty·legacy empty·공백의 occupied parity |
| `NAV-RPC-003` | Rust/native CSV | `small-csv.csv` column_002의 `0→1→100→102→201`과 역방향 경계 |
| `NAV-RPC-004` | Rust unit | source/query의 상·하·좌·우 Excel 경계 matrix parity |
| `NAV-RPC-005` | component | Ctrl+Shift와 Ctrl+Alt+Shift가 backend target까지 anchor 유지 |
| `NAV-RPC-006` | Rust/component | unknown row count의 absolute Down이 backend에서 EOF 확정 |
| `NAV-RPC-007` | component | 숨긴 열 제외, 응답 column ID와 visible 순서 검증 |
| `NAV-RPC-008` | component | resolver 1회, 중간 readPage 0회, target cache miss readPage 최대 1회 |
| `NAV-RPC-009` | component | click·새 key·focus·session/query 교체 뒤 late 결과 폐기 |
| `NAV-RPC-010` | Rust/component | cancel flag 확인과 취소 뒤 선택·scroll·error 불변 |
| `NAV-RPC-011` | Rust query | source와 materialized query가 현재 result ordering에서 같은 경계 반환 |
| `NAV-RPC-012` | release/native perf | large CSV 250,000행 Ctrl+Down resolver IPC 1회와 p95 2초 이하, page IPC·RSS 실측 기록 |

성능 측정은 warm-up 1회 뒤 반복하고 navigation IPC, target page IPC, end-to-visible latency와
RSS delta를 기록한다. 전체 파일 materialize와 frontend 중간 page 요청은 실패다.
