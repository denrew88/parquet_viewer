# Phase 12 브라우저 상호작용 검증 결과

- 결과: **PASS (browser mock)**
- 실행일: 2026-07-21
- 명령: `npm run test:e2e -- e2e/phase12.spec.ts`
- 결과: 3개 viewport, 12개 테스트 모두 통과
- 별도 검사: `npm run typecheck` 통과
- 네이티브 상태: 별도 release 스모크에서 100%·150% WebView2, 실제 Rust IPC와 Windows clipboard를 통과했다.

## 검증한 상호작용

### Find와 query commit

- `Ctrl+F`로 Find를 열고 `Find data` 입력에 focus가 들어가는 것을 확인했다.
- 문자열 입력 뒤 300ms를 기다려도 `executeQuery` 호출은 0회였고, Enter/Search에서만 1회 호출됐다.
- query commit 뒤 논리 row 4와 column 2가 유지되고, row 2~4 범위 선택은 active cell 하나로 축소됐다.
- previous/next는 commit된 query ID의 결과 좌표를 사용했다.
- Esc로 Find를 닫고 `Ctrl+F`로 다시 열었을 때 입력 focus와 commit된 조건이 유지됐다.
- 전역 match-only `Filter` 버튼은 없고 column header별 typed Filter만 남아 있다.

### 다중 정렬과 컬럼 순서

- Shift+header로 2개 정렬을 만든 뒤 priority 1/2 표시를 확인했다.
- 다중 정렬 dialog의 direction·priority 변경은 staged 상태에서 backend 호출을 만들지 않았다.
- Apply에서만 `executeQuery`가 3회에서 4회로 한 번 증가했다.
- Apply 뒤 draft direction을 바꾸고 Cancel했을 때 backend 호출 수와 committed priority/direction이 변하지 않았다.
- 1440×900, 1024×768, 800×600 모두 Apply가 실제 hit target이며 column toolbar에 가려지지 않았다.
- 컬럼 메뉴로 `category`를 왼쪽으로 옮긴 뒤 visible order가 `category`, `row_id`가 됐다.
- `group_id` column filter Apply 뒤 active row 5와 논리 column 1을 보존하고 범위는 active cell 하나로 축소됐다.

### query-aware copy와 실패 이력

- 정렬·Find가 적용된 query에서 row 4~5와 재정렬된 두 컬럼을 복사했다.
- backend snapshot은 non-null query ID, `rowStart=4`, `rowEndExclusive=6`, `columnIds=[category,row_id]`였다.
- 5,850,000×15 전체 선택은 `preparing/selectionLimit`으로 실패하고 Retry가 노출됐다.
- Retry 후 서로 다른 operation ID 두 개가 current/history에 구분되어 나타났다.
- 이 브라우저 검증은 `selectionLimit` 한 원인의 표시만 다룬다. 전체 error taxonomy와 clipboard atomicity는 Rust/native 검증 대상이다.

### pending, stale 응답과 탭 복귀

- adjacent prefetch가 진행 중인 상태를 통제해 `aria-busy=true`와 `Loading page`를 캡처했다.
- pending 도중 다른 파일 탭으로 이동해도 240-row 문서에 5.85M-row 응답이 적용되지 않았다.
- 요청 settle 뒤 두 파일을 20회 왕복했으며 세 viewport 모두 page read count가 `2 → 2`, 추가 호출 0회였다.
- 파일 탭 순서 메뉴로 탭을 이동한 뒤 active document가 바뀌지 않았다.

### navigation과 마지막 행 geometry

- query 상태에서 Ctrl+Alt+Down과 Ctrl+Shift+Up이 각각 boundary 요청 1회만 사용했다.
- Shift 조합의 anchor·rect와 grid focus가 유지됐다.
- 마지막 행 cell 높이는 48px이며 세 viewport 모두 `cellBottom = gridContentBottom - 18px`였다.
- 마지막 행에서 PageUp 후 PageDown으로 복귀했을 때 active cell이 다시 완전히 보였다.

## 구현 중 발견 후 회귀 확인한 결함

1. large browser query가 typed fixture page를 반환하던 분기 누락
2. large timestamp mock의 확장 DataValue 필드 누락으로 query page가 `InvalidResponse`가 되던 문제
3. 탭 재활성화마다 같은 adjacent page prefetch가 재시작되던 문제
4. multi-sort dialog의 stacking context가 column toolbar보다 낮아 Apply가 가려지던 문제

네 항목 모두 수정 뒤 최종 3-viewport 실행에서 회귀하지 않았다.

## 별도 근거로 완료한 검증

- `native-results.json`, `native-results-150dpi.json`: 실제 Tauri/WebView2의 focus, blur, 마지막 행 geometry와 Windows clipboard
- `benchmark-results.json`, `query-plan-audit.json`: release backend의 5.85M 정렬·filter·page 성능과 bounded page 계획
- Rust copy tests: byte/selection 제한, cancel, clipboard 실패에서 이전 clipboard 보존과 단일 atomic commit
- `lifecycle-results.json`: 100회 query create/scroll/replace/close 뒤 task/result/temp/handle/RSS 생명주기

실제 Excel 프로세스 붙여넣기와 clean-machine NSIS 설치는 Phase 12 제품 결함이 아니라 별도 외부 환경 검증으로 계속 추적한다.
