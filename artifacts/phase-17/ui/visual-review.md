# Phase 17 시각 검토

- 판정: PASS
- 검토 이미지: `browser-{desktop,compact,minimum}.png`,
  `settled-{desktop,compact,minimum}.png`, `native-desktop.png`

빠른 이동 중에는 목표 행 번호가 움직이고 아직 읽지 않은 data cell은 비어 있어 과거 page 값을 현재
행처럼 오인시키지 않는다. 정착 뒤에는 같은 위치에 값이 채워지고 header와 cell의 시작점·너비가
일치한다. 세 viewport에서 toolbar, footer, horizontal scrollbar가 겹치거나 잘리지 않았으며 page
전체의 가로 overflow도 없다. 실제 Tauri 마지막 행은 horizontal scrollbar 위에서 border와 18px
bottom clearance를 포함해 완전히 보인다.
