# Phase 23 실제 Windows 검증

격리된 WebView와 `com.denrew88.data-viewer-phase23-acceptance`의 0.23.0 후보에서 6/6건을 통과했다. `node scripts/dev-check.mjs phase23-native`로 실행했다. 최종 로그는 `2026-11-07T16-24-59-911Z-phase23-native.log`에 있다. 후보의 SHA-256은 `5a2a3d3f45e5a727256d4ea8bd333cc862fe4d2c921576e83e8796a63a056ef3`이다.

| 범위 | 실제 결과 |
| --- | --- |
| T-P23-001/007 | Query 높이 140px에서 180px로 포인터 변경. 필터 적용 뒤 230행. 100행 단위로 1~100, 101~200, 201~230을 왕복 |
| T-P23-005 | SQL이 참조한 원본 CSV 탭을 닫은 뒤 460행 스냅샷의 마지막 행과 후속 보기 조회 유지 |
| T-P23-001/002 | 텍스트 필터와 두 정렬 기준을 적용한 230행 전체가 golden 순서와 일치. 200행 IPC 페이지 경계, 보기 해제, 64비트·소수·ns 원본 값 확인 |
| T-P23-003 | 정확 일치 검색에서 대소문자 무시 시 29·106·135, 대소문자 구분 시 29·135. 다음·이전·순환 확인 |
| T-P23-004 | Windows 클립보드에 230행의 현재 보기 TSV를 저장하고 기존 텍스트 복원 |
| T-P23-004 | 실제 저장 대화상자 취소, 현재 보기 CSV·TSV·Parquet 각각 230행 및 전체 CSV 460행. 텍스트 BOM·CRLF와 정밀도, 다시 연 Parquet의 정확한 행 순서와 값 확인 |

[실행 보고서](../native/report.json)와 [실제 WebView 화면](../native/native-results.png)을 확인했다. 화면에서 Query·Results 경계, 필터 칩, 선택 셀, 숫자·시간 표시, 페이지 바가 서로 구분된다. 그리드에는 콘텐츠 스크롤이 표시된다.

첫 실행에서는 WebView 페이지 탐색을 기다리기 전에 찾아 실패했다. 다음 실행은 100행 UI 페이징을 200행으로 가정한 harness 기대값과 클립보드 옵션 DTO의 잘못된 태그 표현에서 실패했다. harness를 고쳐 동일한 바이너리에서 6/6을 다시 확인했다. 두 시도는 `../native/report-first-launch.json`과 `../native/report-first-ui.json`에 남겼다.
