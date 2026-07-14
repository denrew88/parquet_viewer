# Phase 8 독립 리뷰

- 리뷰일: 2026-07-15
- 최종 판정: 미해결 HIGH/MEDIUM 없음
- Phase 상태: 구현 및 자동/native 검증 완료, 필수 Browser·설치 환경 gate BLOCKED

## 수정 확인

- all-failure batch가 기존 active document를 유지한다.
- pending open close는 request 취소 IPC를 호출하고 batch sibling과 late session을 정리한다.
- same-path close/reopen과 original/reopen 응답의 양방향 순서가 동일 identity를 조기 close하지 않는다.
- configure/close, slow decode/close, copy/unmount의 late 결과를 폐기한다.
- close는 현재 또는 해당 문서의 직전 session만 허용하며 wrong-document session을 거부한다.
- open cancellation 기록은 중복 제거되고 최근 256개로 제한된다.
- Windows canonical `\\?\`와 `\\?\UNC\` 응답 경로를 정상 요청과 안전하게 비교한다.
- 동명 탭 label, close focus, strict batch DTO, 문서별 CSV mock 상태를 확인했다.

## 잔여 위험

- LOW: idempotent close를 위한 `DocumentRegistry.closed_documents` tombstone은 프로세스
  수명 동안 누적된다. 동시 open 상한은 64지만 매우 오래 실행하며 수백만 문서를 닫는
  비정상 workload에서는 메모리가 증가할 수 있다.
- Browser 도구 부재로 Browser interaction/DOM geometry/screenshot gate는 BLOCKED다.
- 150% DPI, 실제 Excel, clean VM installer/file association은 별도 환경 검증이 필요하다.
- 대용량 성능 증거는 데이터 계층 3회 release 측정이다. 계획의 30회 cold-process와 실제
  grid navigation/copy 성능 전체를 PASS 처리하지 않는다.

실행 가능한 자동 gate와 실제 Tauri 3 viewport, clipboard, multi-process 검증에는 알려진
FAIL이 없다.
