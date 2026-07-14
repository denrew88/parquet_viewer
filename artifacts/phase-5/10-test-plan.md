# Phase 5 가상화 그리드 테스트 계획 (Draft)

- 작성일: 2026-07-14
- 기준: `PROJECT_SPEC` 8절, `DEVELOPMENT_PLAN` Phase 5, `UI_VALIDATION`, Phase 4 통합 열기 계약
- 상태: Root가 아래 구현 계약과 수치 기준을 승인한 뒤 `10-test-plan.md`로 승격
- 핵심 불변 조건: 데이터의 논리 좌표와 요청 상태는 DOM 생명주기와 분리하며, 스크롤 중에도 최신 session의 정확한 행·컬럼만 표시한다.

## 완료 판정

다음 항목은 모두 필수다.

1. TanStack Table이 컬럼 상태를, TanStack Virtual이 행·컬럼 window를 소유하고 전체 데이터 크기에 비례한 DOM을 만들지 않는다.
2. 10,000행 이상·100컬럼 이상에서 고정 header, 양방향 스크롤, resize/hide/search와 페이지 선행 읽기가 아래 수치 기준을 만족한다.
3. 미로딩·stale·실패 페이지를 다른 논리 행으로 표시하지 않으며, 현재 보이는 정상 데이터는 요청 중 유지한다.
4. loading, empty, error, 부분 metadata, 긴 값·컬럼 이름·nested 값의 상태와 접근성을 자동 테스트와 실제 입력으로 검증한다.
5. Browser interaction·geometry·세 viewport screenshot과 실제 Windows Tauri smoke를 각각 남긴다. 한 계층의 결과로 다른 계층을 대체하지 않는다.

## 제안 구현 계약과 정량 기준

### 그리드 좌표와 치수

- TanStack Table의 row model에는 로드된 page만 넣되, row key는 page 내 index가 아니라 `sessionId:logicalRow`를 쓴다. 컬럼 key는 중복되지 않는 backend column identity를 쓴다.
- TanStack Virtual row count는 row count가 확정되면 전체 논리 행 수, 계산 중인 CSV는 `loadedEnd + (hasMore ? 1 : 0)`로 둔다. sentinel은 data row나 선택 좌표가 아니다.
- 기본 row 높이 `34px`, header 높이 `36px`, row-number 컬럼 `56px`, data 컬럼 기본 `180px`, 최소 `80px`, 최대 `800px`를 권장한다. 측정 오차와 브라우저 배율을 고려해 header/data 정렬 허용 오차는 `1 CSS px`다.
- vertical overscan은 위·아래 각 `8행`, horizontal overscan은 좌·우 각 `3컬럼`으로 고정한다. 동적 측정이 필요하면 같은 상한을 만족하는 이유와 실제 값을 evidence에 기록한다.
- 1440x900에서 mounted data row는 `ceil(viewportHeight / 34) + 16 + 2` 이하이면서 절대 `60` 이하, mounted data column은 `ceil(viewportWidth / 80) + 6 + 2` 이하이면서 절대 `32` 이하다. header·row-number를 포함한 grid cell DOM은 `1,500개` 이하다.
- scroll surface만 의도된 overflow를 허용한다. toolbar, tabs, status, paging/loading 표시의 높이는 empty/loading/populated 전환에서 `2 CSS px` 넘게 변하지 않는다.

### page window, prefetch, stale 처리

- backend page size는 기존 상한인 `200행`을 유지한다. 요청 key는 `sessionId + offset + limit + projection order`다.
- visible window가 미로드 page에 진입하면 foreground 요청 1개를 보낸다. 현재 page의 앞/뒤 `40행` 이내에 들어오면 진행 방향의 인접 page 1개를 prefetch한다.
- 동일 key의 in-flight 요청은 합치고, 한 session에서 동시 page 요청은 foreground 1개와 prefetch 1개, 합계 `2개` 이하로 제한한다. 방향이 바뀌면 필요 없어진 queued prefetch는 취소하고, 이미 전송된 IPC 결과는 generation 검사로 폐기한다.
- frontend는 현재 page와 앞·뒤 각 1 page, 최대 3 page의 표시 window를 유지한다. backend의 기존 8-entry LRU 상한은 바꾸지 않는다.
- session 교체, CSV header generation 변경, 컬럼 projection 변경은 grid generation을 증가시킨다. 다른 generation/session/request key의 성공·실패는 rows, error banner, loading 상태를 바꾸지 않는다.
- 요청 중에는 이미 검증된 셀을 비우지 않는다. 아직 로드되지 않은 논리 행만 고정 높이 skeleton으로 표시하며 이전 page의 값을 해당 좌표에 재사용하지 않는다.
- unknown total CSV는 `hasMore=false`가 확인된 page까지만 scroll extent를 확정한다. row-count metadata가 나중에 완료돼도 현재 scroll anchor가 `1행` 넘게 이동하지 않는다.

### 컬럼과 값 UI

- resize는 pointer drag와 키보드 조작 가능한 separator를 제공하고 `80..800px`로 clamp한다. 숨김·검색 후에도 저장된 너비와 원래 컬럼 순서는 유지한다.
- 컬럼 이름 검색은 대소문자를 구분하지 않는 substring이고 `150ms` 이하 debounce를 사용한다. 검색은 컬럼 chooser 결과만 좁히며 입력 중 grid keyboard shortcut을 소비하지 않는다.
- 숨김은 논리 컬럼 목록만 바꾸고 행 데이터를 재정렬하지 않는다. 모두 숨기기는 row-number와 복구 가능한 empty-columns 안내를 남긴다.
- cell은 한 줄 ellipsis이며 원문은 title만으로 끝내지 않고 keyboard로 열 수 있는 full-value inspector를 제공한다. inspector는 문자열·binary preview·list/struct/map의 표시 문자열을 그대로 보이고 Escape로 닫히며 grid 치수를 바꾸지 않는다.
- 긴 컬럼 이름, 100,000자 문자열, 3단계 nested 값은 인접 셀·header·paging bar를 덮지 않는다. 테스트 fixture는 원문 checksum으로 축약 표시와 inspector 값이 같은 원본에서 왔음을 확인한다.

### 성능 예산

- 기준 환경은 Windows release Tauri WebView와 Browser mock 각각이며 하드웨어·배율·fixture hash를 기록한다. 개발 모드 수치는 참고이고 최종 판정은 release를 우선한다.
- 10,000 x 120 fixture를 연 뒤 첫 usable grid가 표시된 다음 5초간 수직·수평 왕복 스크롤에서 `>100ms` long task 0개, `>50ms` long task 2개 이하, `requestAnimationFrame` interval p95 `<=32ms`, 최대 `<=100ms`를 목표로 한다.
- 이미 로드된 window의 wheel-to-paint와 column resize pointer-to-paint latency p95는 `<=50ms`; column search key-to-result p95는 debounce 제외 `<=100ms`; mock page promise resolve-to-correct-row paint p95는 `<=100ms`다.
- 30초 scroll soak 뒤 grid DOM cell은 상한의 110%를 넘지 않고 계속 증가하지 않는다. JS heap은 GC 후 시작 안정값 대비 `+64MiB` 이하를 목표로 기록하되, WebView heap을 수집할 수 없으면 DOM·process working set과 제한 사유를 함께 남긴다.
- 수치 실패는 기능 PASS로 덮지 않는다. 환경 변동이 의심되면 같은 build로 3회 수행해 중앙값과 최악값을 기록한다.

## Fixture

| ID | 내용 |
| --- | --- |
| `F-P5-01` | 10,240행 x 120컬럼 Parquet, 16 row group; 각 셀 `R{row}C{col}` checksum, Int64·decimal·timestamp·null 포함 |
| `F-P5-02` | 12,345행 x 128컬럼 UTF-8 CSV; row count 계산 중/완료를 제어하고 quoted newline 포함 |
| `F-P5-03` | 0행 x 120컬럼 Parquet와 header-only CSV, 0행 x 0컬럼 CSV |
| `F-P5-04` | 100,000자 문자열, 240자 컬럼 이름, 공백·한글·emoji 컬럼 이름, list/struct/map 3단계 nested 값 |
| `F-P5-05` | 240행 x 120컬럼 wide fixture; 모든 컬럼 숨김, 검색 0/1/다수 결과, resize 경계 검증 |
| `F-P5-06` | page adapter double: offset별 지연·성공·typed failure·resolve 순서와 호출 횟수를 제어 |
| `F-P5-07` | partial metadata: rowCount null, calculating/cancelled/failed, rowGroups 또는 CSV issue 일부만 사용 가능 |
| `F-P5-08` | session A/B 및 CSV generation 1/2 응답을 교차 완료하는 stale fixture |
| `F-P5-09` | Browser performance fixture: 10,000 x 120 logical dataset을 결정적으로 생성하되 DOM 밖 셀은 만들지 않음 |
| `F-P5-10` | native release fixture: F01/F02의 고정 hash, 첫·중간·마지막 행과 컬럼 checksum manifest |

fixture 생성기는 seed, 파일 hash, row/column count, page별 checksum을 manifest에 남긴다. 100,000자 값 전체와 실제 사용자 경로는 로그에 남기지 않는다.

## 단위·컴포넌트 계약

| ID | Fixture/검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P5-001` | F01 row virtualizer 0/중간/마지막 range | 논리 row key와 absolute row number가 정확하고 mounted row가 수식 상한 이내 | Grid UX |
| `T-P5-002` | F01 column virtualizer 좌/중간/우 range | 컬럼 순서·offset·width 정확, mounted column 상한 이내 | Grid UX |
| `T-P5-003` | F01 10,240 x 120 render | 전체 row/cell map을 React node로 만들지 않고 cell DOM 1,500 이하 | Grid UX + Quality |
| `T-P5-004` | row height/header/row-number 치수 | 동적 값·hover·loading이 34/36px과 안정된 track을 바꾸지 않음 | Grid UX |
| `T-P5-005` | F06 같은 page key 동시 요청 10회 | backend 호출 1회, 모든 소비자가 같은 검증 결과 사용 | Grid UX |
| `T-P5-006` | F06 visible 경계 41→40행 | 40행 밖에서는 없음, 경계 안에서 진행 방향 인접 page 1회 prefetch | Grid UX |
| `T-P5-007` | F06 방향 왕복 | queued prefetch 취소·dedupe, 동시 요청 총 2 이하 | Grid UX |
| `T-P5-008` | F06 foreground 실패/prefetch 실패 | foreground만 actionable error; prefetch 실패는 현재 grid를 비우지 않고 재시도 가능 | Grid UX |
| `T-P5-009` | F08 session/generation/request stale success | 현재 rows, scroll anchor, loading, banner에 변화 없음 | Grid UX |
| `T-P5-010` | F08 stale failure after latest success | 최신 정상 grid 위에 오류가 나타나지 않음 | Grid UX |
| `T-P5-011` | F06 미로드 page pending | 해당 논리 좌표에 고정 높이 skeleton, 이전 page 값이나 잘못된 row number 없음 | Grid UX |
| `T-P5-012` | F02 unknown total→complete | sentinel은 data row가 아니고 완료 후 extent/상태 정확, anchor 이동 1행 이하 | Grid UX |
| `T-P5-013` | frontend 3-page window eviction | 진행 방향 앞·현재·뒤만 보관, 재방문은 backend cache와 정확히 연동 | Grid UX + Rust Data |
| `T-P5-014` | projection order가 다른 page key | cache/request key 충돌 없이 요청 컬럼 순서대로 표시 | Grid UX + Rust Data |
| `T-P5-015` | F05 resize 79/80/500/800/801px | 80..800 clamp, header/data 동일 width, pointer 종료 후 유지 | Grid UX |
| `T-P5-016` | resize separator keyboard | focus 가능, 방향키 증감, accessible value/label 갱신 | Grid UX |
| `T-P5-017` | F05 hide/show 1개·다수·전체 | 데이터 매핑 불변, 원래 순서·저장 너비 복원, 전체 숨김 복구 UI | Grid UX |
| `T-P5-018` | F05 검색 case/substring/공백/0건 | 150ms 이내 debounce, chooser만 필터, 입력값과 grid focus 안정 | Grid UX |
| `T-P5-019` | 검색 중 Arrow/Ctrl+A/Escape | input 기본 편집이 동작하고 Phase 6용 grid shortcut hook은 실행되지 않음 | Grid UX |
| `T-P5-020` | F04 긴 값과 nested 값 | 한 줄 ellipsis, 인접 cell overflow 없음, inspector 원문 checksum 일치 | Grid UX |
| `T-P5-021` | F04 긴 컬럼 이름 | header ellipsis·tooltip/accessible name 제공, resize handle과 겹치지 않음 | Grid UX |
| `T-P5-022` | inspector mouse/Enter/Escape/focus return | full value 확인, viewport 내 배치, 닫은 뒤 원래 cell에 focus 복귀 | Grid UX |
| `T-P5-023` | F03 empty shapes | 0행/0컬럼/header-only를 오류와 구분하고 scroll phantom row 없음 | Grid UX |
| `T-P5-024` | F07 loading/error/partial metadata | Data/Schema/Metadata 각각 가능한 정보를 유지하고 누락값은 명시적 unavailable | Grid UX |
| `T-P5-025` | tab 전환 후 복귀 | scroll x/y, column width/visibility/search 상태와 현재 logical anchor 유지 | Grid UX |
| `T-P5-026` | component unmount/session replace | observer, RAF, listener, queued prefetch가 cleanup되고 setState 경고 없음 | Grid UX |
| `T-P5-027` | ARIA/focus 준비 | grid 이름, row/column count, cell index가 논리 좌표이며 한 focus owner만 존재 | Grid UX |
| `T-P5-028` | Phase 6 selection seam | virtual cell unmount 후에도 logical active coordinate를 담을 state/API가 존재 | Grid UX |

## Browser Interaction·Geometry·Screenshot

| ID | 검증 | 기대 결과/증거 | 담당 |
| --- | --- | --- | --- |
| `T-P5-029` | F09 실제 wheel로 첫→중간→마지막→첫 행 | checksum과 row number 정확, 흰 화면·이전 page flash·scroll jump 없음 | Quality |
| `T-P5-030` | F09 Shift+wheel/trackpad 상당 수평 입력 | 첫→중간→마지막 컬럼 정확, sticky row number/header 유지 | Quality |
| `T-P5-031` | 빠른 수직·수평 교차 스크롤 | row/column offset 조합의 checksum 정확, 최대 동시 요청 2 | Quality |
| `T-P5-032` | F06 느린 foreground 중 반대 방향 이동 | 기존 셀 유지, skeleton 좌표 정확, stale 완료 화면 미반영 | Quality |
| `T-P5-033` | F06 prefetch hit/miss/failure | hit에서 추가 loading flash 없음; miss/failure도 잘못된 값 없음 | Quality |
| `T-P5-034` | 실제 pointer column resize min/max | drag 중 header/data 시작점 차이 1px 이하, 주변 layout shift 없음 | Quality |
| `T-P5-035` | 실제 click hide/show와 검색 | 결과 컬럼·원래 순서·scrollLeft clamp 정확, input focus shortcut 격리 | Quality |
| `T-P5-036` | F04 inspector interaction | click/Enter/Escape, focus return, 긴 값이 viewport를 벗어나지 않음 | Quality |
| `T-P5-037` | empty→loading→populated→error | workspace rect 변화 2px 이하, 상태 텍스트와 색 외 표식 구분 | Quality |
| `T-P5-038` | F07 partial metadata와 tab 전환 | 각 tab이 crash 없이 가능한 정보 표시, grid scroll state 유지 | Quality |
| `T-P5-039` | 1440x900 geometry | toolbar/tabs/status/grid 무겹침, DOM row<=60·column<=32·cell<=1500 | Quality |
| `T-P5-040` | 1024x768 geometry | header 정렬 1px 이내, control/검색/상태 무잘림, 의도된 grid overflow만 존재 | Quality |
| `T-P5-041` | 800x600 geometry | 최소 창에서 toolbar·column 도구·paging/status 접근 가능, text 부모 밖 overflow 없음 | Quality |
| `T-P5-042` | overscan geometry JSON | viewport·virtual padding·첫/마지막 mounted index와 설정값 일치 | Quality |
| `T-P5-043` | desktop screenshot | populated wide grid, fixed header, resize·scroll 상태를 `browser-desktop.png`에 기록 | Quality |
| `T-P5-044` | compact screenshot | column search/hidden 상태와 긴 header를 `browser-compact.png`에 기록 | Quality |
| `T-P5-045` | minimum screenshot | loading 또는 partial metadata 상태를 `browser-minimum.png`에 기록 | Quality |
| `T-P5-046` | visual review | 겹침·잘림·비정상 공백·계층·focus·sticky 정렬을 독립 판정 | Quality |

## 성능·DOM 상한

| ID | Fixture/검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P5-047` | F09 10,000 x 120 최초 populated render | cell DOM <=1,500, 전체 dataset 크기에 따른 DOM 증가 없음 | Quality |
| `T-P5-048` | F09 5초 수직 왕복 scroll trace | >100ms task 0, >50ms task <=2, RAF p95<=32ms·max<=100ms | Quality |
| `T-P5-049` | F09 5초 수평 왕복 scroll trace | 같은 frame/long-task 예산, mounted column 절대 32 이하 | Quality |
| `T-P5-050` | wheel-to-paint/resize input latency | 로드 window p95<=50ms | Quality |
| `T-P5-051` | search key-to-result latency | debounce 제외 p95<=100ms, typing 누락 없음 | Quality |
| `T-P5-052` | F06 page resolve-to-paint | p95<=100ms, row checksum과 request key 일치 | Quality |
| `T-P5-053` | 30초 diagonal scroll soak | DOM 상한 110% 이하·지속 증가 없음, GC 후 heap +64MiB 이하 또는 제한 기록 | Quality |
| `T-P5-054` | page request audit | 동일 key 중복 0, 동시 2 이하, prefetch distance 40행, stale apply 0 | Quality + Grid UX |

## 실제 Windows Tauri 증거

| ID | 검증 | 필수 증거 | 담당 |
| --- | --- | --- | --- |
| `T-P5-055` | release Tauri로 F10 Parquet/CSV 열기 | fixture hash, PID/build, 첫·중간·마지막 checksum, `ui/native-smoke.md` | Tauri Platform |
| `T-P5-056` | native vertical/horizontal fast scroll | sticky header/row number, 정확한 끝 좌표, 화면 정지·검은 grid 없음 | Tauri Platform + Quality |
| `T-P5-057` | native resize/hide/search/inspector | 실제 pointer·keyboard 입력 결과와 native screenshot | Tauri Platform |
| `T-P5-058` | Windows WebView 100%/125% 배율 | header/data 오차 1 CSS px 이내, text clipping·pointer offset 오류 없음 | Tauri Platform |
| `T-P5-059` | native 1440/1024/800 창 크기 | 최소 desktop screenshot과 크기별 geometry/smoke 결과 | Tauri Platform |
| `T-P5-060` | native release performance trace | frame/input/page latency와 process working set, 측정 도구·환경 기록 | Quality + Tauri Platform |

## 회귀·Gate

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P5-061` | Phase 1~4 회귀 | Parquet/CSV 정확도, paging, dialog/drop/argv/session 교체 회귀 없음 | Quality |
| `T-P5-062` | 정적 gate | Rust fmt/clippy/test, frontend format/lint/typecheck/test/build PASS | Quality |
| `T-P5-063` | Tauri release build | `--no-bundle` release 실행 가능, dependency/lockfile 일치 | Tauri Platform |
| `T-P5-064` | evidence gate | interaction, geometry JSON, 3 browser screenshot, visual review, native smoke 존재 | Quality + Root |
| `T-P5-065` | 최종 판정 | 필수 미실행은 구체적 환경 원인의 `BLOCKED`; jsdom으로 Browser/native를 대체해 PASS 금지 | Root |

## 증거 파일 계약

```text
artifacts/phase-5/ui/
  browser-desktop.png
  browser-compact.png
  browser-minimum.png
  visual-review.md
  geometry-results.json
  interaction-results.md
  performance-results.json
  native-desktop.png
  native-wide-grid.png
  native-smoke.md
```

- `geometry-results.json`은 viewport별 chrome/grid rect, scroll/client 치수, mounted row·column·cell 수, virtual range와 padding을 기록한다.
- `interaction-results.md`는 각 ID의 시작 상태, 실제 입력, 기대/실제 논리 좌표, request audit를 기록한다.
- `performance-results.json`은 build, fixture hash, OS/WebView, CPU·메모리, 화면 배율, 3회 raw/median/worst 측정을 포함한다.
- native log에는 session/request key와 논리 좌표만 남기고 전체 사용자 경로나 긴 셀 원문은 기록하지 않는다.

## 플랫폼 제약과 판정 원칙

- in-app Browser backend가 없으면 `T-P5-029`~`054`의 Browser 전용 항목은 `BLOCKED`다. Vitest/jsdom이나 별도 Playwright로 대체하지 않는다.
- 실제 Tauri pointer, WebView sticky/overflow, Windows 배율 검증은 browser shell만으로 PASS 처리하지 않는다.
- 화면 잠금·sleep·비대화형 session에서는 screenshot·pointer·focus·frame trace가 무효다. 이 경우 native 항목은 `BLOCKED`다.
- WebView 합성으로 screenshot이 검게 캡처되면 입력 로그와 별도 캡처를 남기되 보이는 grid를 확인하지 못한 시각 항목은 PASS하지 않는다.
- 성능 환경 차이는 수치 생략 사유가 아니다. 동일 release build 3회 결과와 환경을 남기고, 도구 부재로 필수 지표를 수집하지 못하면 해당 항목을 `BLOCKED`로 판정한다.

## Root 승인 필요 결정

1. 행/컬럼 overscan을 각각 `8/3`, page size를 `200`, prefetch 경계를 `40행`으로 확정할지.
2. frontend 표시 cache를 현재+인접 최대 3 page, 동시 요청을 foreground+prefetch 최대 2개로 확정할지.
3. 컬럼 width를 기본/min/max `180/80/800px`, row/header 높이를 `34/36px`로 확정할지.
4. DOM 절대 상한을 row `60`, column `32`, cell `1,500`으로 확정할지.
5. release 성능 예산을 long task, RAF, input latency 기준 그대로 Phase 5 완료 gate로 사용할지.
