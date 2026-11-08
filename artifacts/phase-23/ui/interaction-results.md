# Phase 23 브라우저 상호작용

| 테스트 | 검증 내용 | 결과 |
| --- | --- | --- |
| T-P23-001/002/003 | 기존 필터·정렬 동작, Find 명시 실행·이전·다음, 편집기 Find 분리, Search/Clear의 실제 포인터 도달 가능성 | 세 viewport 통과 |
| T-P23-004/005 | Current view와 Whole result의 요청 범위, 정렬·필터 적용 클립보드 행, 첫 결과 페이지 지연·실패 및 SQL 실패 때 이전 뷰 유지 | 세 viewport 통과 |
| T-P23-007 | 키보드 최소·최대·증감, 포인터 크기 변경, Escape와 pointercancel 원복, resize 후 범위와 출력 탭, DOM 비겹침 | 세 viewport 통과 |

초기 실행은 5/9였다. 최소 창에서 결과 표 공간이 부족했고, 넓은 창과 컴팩트 창에서는 Query toolbar가 Export 버튼의 클릭을 가로챘다. 수정 후 9/9였다. 독립 이미지 검토로 최소 창의 Find Search/Clear 가림을 추가 발견했다. Find geometry가 추가된 실행에서 8/9였으며, 한 실패는 테스트 중 포맷터가 SQL CSS를 다시 쓴 시점과 겹쳤고 해당 스크린샷에는 SQL workspace CSS 전반이 누락돼 있었다. CSS 쓰기가 끝난 뒤 같은 Find·geometry 테스트를 재실행해 3/3을 확인했다.

실행 명령은 `node scripts/dev-check.mjs e2e T-P23` 및 `node scripts/dev-check.mjs e2e T-P23-001`이었다. 마지막 6건의 Export·splitter 기록은 `2026-11-07T16-07-37-806Z-e2e.log`에, Find·geometry 재검증은 `2026-11-07T16-09-00-241Z-e2e.log`에 있다. 전체 공통 회귀는 `2026-11-07T16-09-29-124Z-phase23-e2e.log`에서 234건 통과를 확인했다. 실제 Tauri 검증은 별도 기록한다.
