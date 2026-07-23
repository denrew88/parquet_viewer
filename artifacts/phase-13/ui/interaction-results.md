# Phase 13 UI 상호작용 결과

## 판정

- Playwright 전체 실행: **PASS**, 63/63
- 대상 viewport: 1440×900, 1024×768, 800×600
- 실제 Tauri/WebView2 스모크: **PASS**

## 확인한 핵심 동작

- 파일 탭, 컬럼 헤더와 다중 정렬 criterion의 pointer drag 및 키보드 대체 조작
- 내부 drag와 외부 파일 drop overlay의 분리
- Shift에 의존하지 않는 다중 정렬 panel의 추가, 검색, 순서 변경, 적용과 취소
- Ctrl+F로 Find를 열고 입력만으로 조회하지 않으며 Search/Enter에서만 query 실행
- Copy history와 Column chooser의 outside click, Escape, focus 복원과 transient 상호 배제
- Timestamp/Duration의 summary/detail/Advanced 설정, preview와 Apply/Cancel
- 세 viewport에서 5,850,000번째 마지막 행의 완전한 표시와 focus 유지

네이티브 상세 결과는 `native-smoke.md`, geometry 수치는 `geometry-results.json`에 기록했다.
