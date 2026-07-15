# Phase 9 UI interaction results

- 실행일: 2026-07-15
- Vitest: **266 passed**
- Playwright Chromium: **24 passed**
- Native release CDP: **comma, dot, space 3개 시나리오 PASS**

## PASS

- 빈 화면, CSV/Parquet 다중 탭, 문서별 Data/Schema/Metadata 상태 유지
- CSV profile checkbox 재선택 해제, Ctrl/Shift/Ctrl+A, bulk type, Undo/Reset/Cancel/Apply
- 타입별 동적 옵션과 None/comma/dot/space, decimal 충돌, Raw/Converted preview
- copy preset 변경과 Custom delimiter/quote/escape/newline/null/boolean/date preview
- global Find/Filter, column filter, distinct values, sort 순환, Escape와 focus 복원
- 설정과 query temporary storage limit/clear
- 실제 release의 UInt64 formatting, DuckDB 정렬·필터, 2셀 `Shift+ArrowRight`
- 실제 Windows clipboard의 header 2열과 custom semicolon 출력
- 5 process x 20 cycles, 총 100번의 독립 window와 종료 후 잔류 process 0

Native CDP 하네스는 테스트 시작 시 app settings를 읽고 `finally`에서 원래 값으로 복원한다.
필터 결과는 `Showing rows 1-200 of 5,000` commit 이후 후속 선택을 실행한다.

## BLOCKED

- 설치본 Explorer CSV/Parquet double-click
- OS drag-and-drop
- 150% DPI
- 실제 Excel application paste

이 항목은 실행하지 않았으며 component나 Browser 결과로 PASS를 추정하지 않았다.
