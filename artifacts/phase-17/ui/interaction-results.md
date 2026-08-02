# Phase 17 UI 상호작용 결과

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 빠른 scrollbar 이동 | PASS | 중간 offset 요청 없이 최종 offset 요청 1회 이하 |
| 연속 작은 wheel 입력 | PASS | 120ms window 누적 1 page에서 scrub 진입 |
| 느린 이동과 adjacent prefetch | PASS | idle immediate read와 정착 page prefetch 유지 |
| cache hit | PASS | page IPC 0, 즉시 populated cell 표시 |
| source/query stale 응답 | PASS | 최종 query identity·projection·offset 유지 |
| PageUp/Down, Ctrl/Ctrl+Alt, Shift selection | PASS | 논리 좌표·focus·viewport 유지 |
| 비활성 탭 복귀 | PASS | 저장된 논리 행으로 segment와 page 복원 |
| 마지막 행 | PASS | 세 viewport와 native에서 전체 셀 표시 |

실행: `e2e/phase17.spec.ts`의 5개 시나리오를 desktop 1440×900, compact 1024×768,
minimum 800×600에서 실행해 15/15 PASS했다.
