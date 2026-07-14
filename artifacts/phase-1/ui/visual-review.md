# Phase 1 시각 검토

## Native PASS

- Data header와 cell 시작점이 일치하고 4개 행이 안정적인 고정 높이로 표시된다.
- null은 italic `null`, 빈 문자열은 `""`로 구분된다.
- Schema의 논리·물리 타입과 nullable 표가 정렬된다.
- Metadata path는 고정 영역에서 ellipsis 처리되어 주변 값을 덮지 않는다.
- error banner는 code, message, retry, dismiss를 함께 제공하고 기존 내용을 유지한다.
- 800x600에서 metadata가 한 열 흐름으로 전환되고 toolbar/status가 남아 있다.

## Browser BLOCKED

`browser-desktop.png`, `browser-compact.png`, `browser-minimum.png`은 Browser backend가 없어
생성하지 않았다. native 이미지를 해당 이름으로 복제하지 않았다.

