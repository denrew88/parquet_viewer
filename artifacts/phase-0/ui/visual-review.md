# Phase 0 시각 검토

## Native

- 상태: PASS
- 증거: `native-desktop.png`
- toolbar, tab strip, workspace, status bar 사이 겹침이나 잘림이 없다.
- 앱 이름과 Open file command가 첫 화면에서 명확하다.
- 빈 상태가 작업 영역 중앙에 배치되고 과도한 hero 또는 card 구성이 없다.
- 상태는 아이콘과 텍스트를 함께 사용하며 색상만으로 전달하지 않는다.

## Browser Viewports

- 상태: BLOCKED
- `browser-desktop.png`, `browser-compact.png`, `browser-minimum.png`은 생성하지 않았다.
- 원인: 현재 세션의 in-app Browser runtime에 사용 가능한 backend가 없다.
- native screenshot을 browser screenshot으로 이름만 바꿔 대체하지 않았다.

