# Phase 23 브라우저 시각 검토

1440×900, 1024×768, 800×600에서 Find, Export, Query 최대 높이 캡처를 각각 열어 확인했다. 각 이미지의 잘린 범위는 Playwright의 SQL workspace 영역 캡처에 따른다.

- `browser-desktop.png`, `browser-compact.png`, `browser-minimum.png`에서 Search, Options, 이전·다음, Clear, 일치 수를 확인했다. 최소 너비에서는 필터 칩의 값이 말줄임표로 표시된다. Search와 Clear는 텍스트와 경계가 온전히 보이고 좌·중앙·우의 포인터 검사를 모두 통과했다. 수치는 `geometry-results.json`에 있다.
- 세 `browser-*-export.png`에서 Current view와 Whole result의 선택지가 네 가지씩 보이며, 팝오버는 의도대로 그리드 위에 표시된다. 각 범위의 실제 클릭도 통과했다.
- 세 `browser-*-expanded.png`에서 Query 편집기, Run, 경계, 출력 탭, 결과 표가 서로 겹치지 않는다. 최대 Query 높이에서 결과 행 영역은 스크롤을 사용한다.
- 초기 실행에서 최소 창의 결과 표 높이와 Export 팝오버 쌓임 순서 문제가 재현됐다. 초기 이미지는 `../quality/first-failures/`에 있다. 이후 Find 컨트롤을 별도로 검토해 가림을 발견했고, 추가 CSS 수정 뒤 세 창 크기의 클릭과 화면을 다시 확인했다.
