# Phase 17 통합 결과

- 통합일: 2026-07-30
- 상태: 완료

## 구현

- 120ms rolling window의 logical row 이동량으로 `idle`/`scrub`을 판정하는 순수 scheduler를 추가했다.
- 1 page 누적 이동 또는 인접 2 page jump에서 scrub에 진입하고 `scrollend`/120ms quiet에서 한 번만
  정착한다.
- scrub 중 uncached foreground와 adjacent prefetch를 막고, cache hit는 즉시 표시한다.
- scrub 진입 전 요청의 응답은 generation으로 폐기하며 최종 source/query page만 commit한다.
- 키보드·selection 이동은 immediate path를 사용하고 segmented recenter의 synthetic event는 표본에서
  제외한다.
- 비활성 탭에서 segment event를 무시하고 복귀할 때 저장한 논리 행으로 surface를 복원한다.

## 검증 요약

| 검증 | 결과 |
| --- | --- |
| scheduler + VirtualDataGrid 집중 단위 테스트 | 77/77 PASS |
| frontend 전체 Vitest | 391/391 PASS |
| Phase 17 Playwright, 3 viewport | 15/15 PASS |
| 컬럼 drag 뒤 탭 복귀 회귀, 3 viewport | 3/3 PASS |
| 전체 Playwright | 120/120 PASS |
| 실제 Tauri 5,850,000행 source scrub 20회 | PASS, page read 각 1회 이하 |
| 실제 Tauri source settle→cell p95 | 75.5ms |
| 실제 Tauri cache hit | 33.6ms, page IPC 0 |
| 실제 마지막 행 geometry/focus | 48px 전체 표시, bottom clearance 18px, focus 유지 |
| 실제 Tauri 20회 scrub RSS 증가 | 5,685,248 bytes (약 5.4MiB) |
| TypeScript typecheck / ESLint / Prettier | PASS |
| Rust fmt / clippy / lib tests | PASS, 289 passed·16 ignored |

전체 Playwright에서 Phase 16의 test-only Cancelling 관찰 구간이 병렬 부하보다 짧은 비결정성도 발견했다.
제품 시간 계약을 바꾸지 않고 mock의 관찰 가능 구간만 1,000ms로 늘렸으며, 최종 전체 suite는
120/120 PASS했다. release EXE와 NSIS도 최종 소스로 다시 빌드하고 실제 WebView2 smoke를 통과했다.

## 경계와 변경하지 않은 것

- backend cancellation DTO, Tauri capability, package dependency는 추가하지 않았다.
- backend에서 이미 실행 중인 최대 2개 요청은 강제 취소하지 않고 frontend generation에서 폐기한다.
- 브라우저 mock latency를 native 성능으로 간주하지 않았으며 실제 Parquet/WebView2 결과를 별도 기록했다.
