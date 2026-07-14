# UI 검증 계약

이 문서는 CSV·Parquet 뷰어의 UI 변경을 검증하는 방법과 필수 증거를 정의한다. UI가 포함된
Phase나 변경은 unit test와 build만으로 완료할 수 없다. 브라우저 shell과 실제 Tauri 앱의
검증 범위를 구분하고, 자동화할 수 없는 항목을 근거 없이 PASS 처리하지 않는다.

## 적용 조건

다음 중 하나라도 해당하면 이 계약을 적용한다.

- React component, CSS, layout, grid, 상태 표시 변경
- 키보드, 마우스, focus, clipboard 상호작용 변경
- native dialog, drag and drop, 파일 연결처럼 UI 진입점 변경
- Tauri event나 IPC 상태가 화면 표시를 바꾸는 변경
- viewport, WebView, installer 환경에 따라 달라질 수 있는 변경

## 역할

| 역할 | 책임 |
| --- | --- |
| `grid_ux_engineer` | UI 구현, component·interaction test, 개발 중 브라우저 확인 |
| `quality_gate_reviewer` | 독립 browser interaction, DOM geometry, screenshot 시각 검토 |
| `tauri_platform_engineer` | 실제 Tauri WebView, native dialog, drag and drop, 파일 연결 smoke |
| 루트 Orchestrator | 테스트 계획 승인, 증거 완전성 확인, 최종 PASS·FAIL·BLOCKED 판정 |

구현 Agent가 생성한 스크린샷만으로 UI 품질을 승인하지 않는다. 통합 후 Quality Agent가
같은 조건에서 독립적으로 다시 검증한다.

## 1. 정적·단위 검증

브라우저를 열기 전에 다음 항목을 자동 테스트한다.

- loading, empty, error, populated 상태의 component 렌더링
- selection reducer와 keyboard command 매핑
- stale response가 현재 화면 상태를 덮어쓰지 않는지 확인
- null, 긴 문자열, 긴 컬럼 이름, nested 값 표시
- 접근성 role, label, focus 가능 여부
- TSV와 clipboard 상태 모델

단위 테스트는 실제 layout이나 WebView 동작을 증명하지 않는다. 다음 검증 계층을 생략할
근거로 사용하지 않는다.

## 2. 브라우저 상호작용 검증

Tauri API를 mock 또는 adapter로 대체한 로컬 프런트엔드를 in-app Browser에서 실행한다.
Browser Skill의 지침을 읽고 해당 Browser의 Playwright API를 사용한다.

적용되는 기능에 대해 다음 동작을 실제 입력으로 재현한다.

- 파일이 없는 empty workspace
- loading, progress, cancellation, error, populated 상태 전환
- click, double click, mouse drag, 빠른 scroll
- 컬럼 resize, hide, 이름 검색
- `Shift+화살표`, `Ctrl+화살표`, `Ctrl+Shift+화살표`
- `Home`, `End`, `PageUp`, `PageDown`, `Ctrl+A`, `Escape`
- 선택 범위 자동 scroll과 가상화 이후 선택 유지
- input focus 중 grid shortcut 차단
- clipboard에 기록되는 TSV 확인
- drag 진입·이탈 중 drop target 표시

각 동작은 시작 상태, 입력, 기대 결과, 실제 결과를 기록한다. 클릭이 성공했다는 사실만으로
PASS 처리하지 말고 논리 좌표, 화면 상태, scroll 위치 또는 clipboard 값을 확인한다.

## 3. DOM geometry 검증

브라우저에서 `getBoundingClientRect`, computed style, `scrollWidth`, `clientWidth`,
`scrollHeight`, `clientHeight`를 수집한다. 최소한 다음을 검사한다.

- toolbar, tab, status bar, grid가 의도하지 않게 겹치지 않는다.
- 버튼과 label의 텍스트가 잘리지 않는다.
- 명시적으로 ellipsis를 사용하는 data cell 이외에는 예상하지 않은 overflow가 없다.
- 고정 header와 data cell의 컬럼 시작점과 너비 차이가 1 CSS px 이내다.
- selection outline은 선택한 셀 경계와 2 CSS px 이내로 일치한다.
- loading과 populated 상태 전환이 전체 workspace 치수를 불필요하게 바꾸지 않는다.
- 렌더링된 row와 cell 수는 전체 데이터 수가 아니라 viewport와 overscan에 의해 제한된다.
- focus 대상이 viewport 밖으로 이동하면 필요한 만큼만 자동 scroll된다.

grid 자체의 의도된 scroll surface는 overflow 오류에서 제외한다. 예외는 selector와 이유를
테스트 계획에 명시한다. DOM 수치 수집 결과는 JSON으로 저장한다.

## 4. Screenshot 시각 검토

UI가 변경된 Phase는 최소한 다음 viewport에서 같은 핵심 상태를 촬영한다.

| 이름 | 크기 | 목적 |
| --- | --- | --- |
| desktop | 1440x900 | 기본 데스크톱 작업 환경 |
| compact | 1024x768 | 작은 데스크톱 창 |
| minimum | 800x600 | MVP 최소 지원 창 |

변경 범위에 따라 다음 상태를 촬영한다.

- empty workspace
- loading 또는 progress
- populated data grid
- error
- drop target
- single cell과 range selection
- 긴 값과 긴 컬럼 이름
- Schema와 Metadata 화면

Quality Agent는 screenshot을 이미지 입력으로 열어 다음 항목을 독립 검토한다.

- 겹침, 잘림, 비정상적인 빈 공간
- 정보 계층과 글자 크기
- row, column, header 정렬
- focus, selection, disabled, loading 상태의 구분
- 작은 창에서 control과 텍스트가 부모 영역을 벗어나지 않는지 확인
- 색상 대비와 색상 이외의 상태 표시
- 의도하지 않은 layout shift

pixel diff는 보조 신호로만 사용한다. WebView, font rendering, 운영체제 차이로 발생하는
변화를 고려해 허용 오차를 두며, 기준 이미지를 자동으로 갱신하지 않는다. 시각적 변경이
의도된 경우 루트가 변경 이유를 승인한 뒤 기준 이미지를 갱신한다.

## 5. 실제 Tauri 검증

브라우저 shell은 다음 항목의 최종 증거가 될 수 없다.

- 네이티브 파일 대화상자
- 운영체제 drag and drop
- 파일 더블클릭과 파일 연결
- 실행 중 앱에 전달되는 파일 경로
- 실제 시스템 clipboard
- Windows WebView와 화면 배율
- installer로 설치된 앱

해당 기능이 포함된 Phase에서는 실제 Tauri 개발 앱 또는 설치본을 실행해 검증한다. 가능한
경우 native screenshot, 로그, 재현 명령을 남긴다. 자동화할 수 없는 OS 상호작용은 사용자
또는 사람의 smoke 확인을 요청하고, 확인 전에는 `BLOCKED`로 기록한다.

개발 모드 확인과 installer 설치 후 확인을 구분한다. 파일 연결은 개발 앱 실행만으로 PASS
처리하지 않는다. 실제 Excel 붙여넣기는 TSV 자동 왕복 테스트와 실제 Excel smoke를 나눠
기록한다.

## 6. 증거 파일

UI 검증이 적용되는 Phase는 다음 파일을 사용한다.

```text
artifacts/phase-N/ui/
  browser-desktop.png
  browser-compact.png
  browser-minimum.png
  visual-review.md
  geometry-results.json
  interaction-results.md
  native-desktop.png
  native-smoke.md
```

- Quality Agent는 `browser-*.png`, `visual-review.md`, `geometry-results.json`,
  `interaction-results.md`의 내용을 만든다.
- Tauri Platform Agent는 `native-desktop.png`, `native-smoke.md`의 내용을 만든다.
- 루트 Orchestrator는 Agent 결과를 검토한 뒤 artifact 위치와 최종 판정을 관리한다.
- 적용되지 않는 파일은 빈 파일로 만들지 않고 `90-review.md`에 제외 이유를 기록한다.

## 7. 판정 기준

다음 조건을 모두 만족해야 UI 항목을 PASS 처리한다.

- 적용되는 unit·interaction test가 통과한다.
- geometry 검사에 설명되지 않은 overlap, clipping, overflow가 없다.
- 필수 viewport와 상태의 screenshot이 존재하고 시각 검토가 완료됐다.
- keyboard와 focus 동작이 명세된 논리 좌표와 일치한다.
- UI가 관련된 실제 Tauri 항목이 검증됐거나 적용 제외 근거가 있다.
- 실행하지 못한 필수 native 검증이 남아 있지 않다.

하나라도 충족하지 못하면 `FAIL` 또는 `BLOCKED`로 판정하고 Phase를 완료하지 않는다.

