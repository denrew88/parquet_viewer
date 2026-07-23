# Phase 14 UI 시각 검토

- 검토일: 2026-07-23
- 대상: Chromium browser mock, `desktop-wide` 1440×900, `desktop-compact` 1024×768, `desktop-minimum` 800×600
- 자동화: Phase 14 12/12 PASS, 전체 Playwright 75/75 PASS, 열 드래그 수정 후 해당 시나리오 3/3 재검증 PASS

## 판정

| 항목 | 판정 | 확인 내용 |
| --- | --- | --- |
| 다중 정렬 | PASS | 빈 조건을 먼저 추가한 뒤 컬럼과 방향을 정할 수 있다. 검색 목록, 조건 순서, 삭제와 Apply/Cancel 구분이 세 viewport에서 잘리지 않는다. |
| 설정 타이포그래피 | PASS | 제목 16px, 섹션 13px, 타입 12px, 예시 11px로 계층이 과도하지 않다. 가로 body overflow는 세 viewport 모두 0이다. |
| 표시 형식 인라인 편집 | PASS | 기본 조작은 첫 목록에서 보이고, 한 타입의 상세 영역만 아래로 펼쳐진다. 별도 상세 화면 전환은 없다. |
| 열 live reflow | PASS | 드래그한 헤더와 현재 mounted 셀이 하나의 floating strip으로 보인다. 다른 열은 대상 위치에서 실시간으로 밀리며 드래그 중 page read는 0이다. |
| 원본 열 순서 복원 | PASS | 복원 뒤 source schema 순서로 돌아오며 숨긴 열 상태는 유지된다. |

## 수동 시각 확인

- `column-live-drag-*.png`에서 floating strip의 첫 셀은 헤더 바로 아래에 붙고 이후 셀은 48px 간격으로 연속한다.
- 초기 캡처에서 overlay 셀이 공통 `height: 100%`를 상속해 위쪽 행이 비어 보이는 결함을 발견했다. 각 overlay 셀 높이를 48px로 고친 뒤 세 viewport의 캡처와 geometry를 다시 생성했다.
- `settings-inline-*.png`와 `settings-accordion-*.png`에서 최소 viewport는 세로 스크롤을 사용하지만 dialog footer가 화면 밖으로 밀리지 않는다.
- 긴 timestamp와 두 줄 문자열은 셀 높이 계약 안에서 표시되며, 드래그 strip이 선택 셀이나 나머지 열 위에 불필요한 세로 공백을 만들지 않는다.

## 증거

- `multi-sort-{wide,compact,minimum}.png`
- `settings-inline-{wide,compact,minimum}.png`
- `settings-accordion-{wide,compact,minimum}.png`
- `column-live-drag-{wide,compact,minimum}.png`
- `column-source-order-{wide,compact,minimum}.png`
- `geometry-settings-*.json`
- `geometry-column-drag-*.json`

Browser 검증과 별도로 실제 WebView2 native smoke에서 runtime, sort, settings, column drag를 모두
PASS했다. native floating overlay의 셀 높이와 간격은 약 48.48px였으며 증거는
`native-smoke.md`, `native-column-drag.png`, `../native-results.json`에 기록했다.
