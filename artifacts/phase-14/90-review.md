# Phase 14 독립 사후 리뷰

- 리뷰일: 2026-07-23
- 결론: **Phase 14 완료 판정 불가**

## 핵심 판정

UI 범위는 blank-first 다중 정렬, inline settings accordion, live reflow drag, 원본 열 순서 복원을
달성했다. 전체 Vitest 364/364, 전체 Playwright 75/75, Phase 11~14 선택 회귀 48/48이 통과했다.
직접 연 screenshot과 최종 Tauri/WebView2 native smoke에서도 큰 clipping이나 정렬 결함은 없었다.

데이터 경로는 Phase 14의 필수 완료 기준에 도달하지 못했다. 가장 중요한 이유는 아래와 같다.

1. 최종 cold preparation 단일 표본은 53.9417초, baseline 대비 약 2.81배로 수치 기준은 통과했다.
   그러나 필수 cold 5회 median/p95가 없어 `P14-GATE-008`은 아직 PASS가 아니다.
2. product-path Ready page p95는 42.057ms로 20ms hard gate를 실패했다.
3. source read를 preview/preparation/navigation으로 분리한 필수 byte counter와 cache 구성별 byte
   audit가 없어 단일 scan, read cap, Ready navigation read=0을 판정할 수 없다.
4. physical raw/typed cache, profile 변경 시 raw 재사용, preparing frontier 안 즉시 Ctrl 응답의
   end-to-end 증거가 부족하다.
5. persistent hit 20회는 p95 110.6953ms와 source read 0으로 통과했지만, cold/page/navigation/
   query/copy의 나머지 정규 표본은 채우지 못했다.
6. final release/NSIS build와 DPR1 WebView2 smoke는 통과했다. Windows clipboard full-copy,
   150% DPI, NSIS 실제 설치 smoke는 여전히 없다.

## 결함 목록

### HIGH

- `P14-GATE-008`, `PERF14-003`: 최종 수치는 통과했지만 cold 5회 표본 계약 미충족.
- `PERF14-004`: Ready page latency hard gate 실패.
- `P14-GATE-006/007`, `PERF14-002`: 필수 source-read counter가 없어 byte gate를 증명할 수 없음.
- `CSV14-005/012`, `PERF14-012`: raw/typed 물리 cache와 구성별 용량 증거가 불완전함.
- `NAV14-004`: preparation frontier 내 즉시 탐색/밖 coordinator wait 계약을 검증할 수 없음.

### MEDIUM

- writer별 fault injection 전수 matrix, 100-cycle soak, 5.85M full-copy가 미실행임.
- Rust progress 테스트의 내부 대기 deadline이 permit 경합 안정화를 위해 1초에서 5초로 완화됐다.
  최종 전체 lib는 통과했지만 제품의 cancel terminal `<=1초` gate를 완화한 것으로 오해되지 않도록
  release cancel/queue 계측을 별도로 남겨야 함.
- UI geometry가 여러 fragment JSON으로만 남아 있고 계획의 통합 `geometry-results.json` 필드 전체를
  충족하지 않음.
- 전체 E2E는 통과했지만 preparing/navigation/copy-history의 계획상 counter와 일부 전용 screenshot이 없음.

### 증거 공백

- `csv-preparation-baseline.json`
- `csv-navigation-performance.json`
- `csv-query-copy-performance.json`
- `cache-byte-audit.json`
- `lifecycle-soak.json`
- 완전한 `ui/geometry-results.json`과 `ui/interaction-results.md`
- Windows clipboard/150% DPI native 증거
- installer runtime audit와 NSIS 실제 install smoke

## 통과한 주요 항목

- Fixture audit 12/12 및 세 large fixture hash 검증.
- 전체 Vitest 364/364, 전체 Playwright 75/75, Phase 11~14 선택 48/48.
- Rust fmt/check/clippy `-D warnings`와 독립 전체 lib 239 PASS/0 FAIL/12 ignored.
- persistent cache의 OS file identity, checksum/fingerprint, pinned handle, stale commit, process-shared
  lock/LRU/live usage, orphan cleanup 회귀 통과. persistent-cache 코드 최종 재리뷰의 신규
  HIGH/MEDIUM은 0개다.
- 5.85M persistent hit 20회 p50 84.9574ms, p95 110.6953ms, 최대 113.891ms,
  20/20 Ready/source read 0.
- release filter+3-sort 634.293ms, 64k×1 copy 103.427ms, source/query boundary 0.365/6.688ms,
  cancel 102.869ms, peak RSS 116,006,912B. 단, 요구 표본 수가 부족한 성능 ID는 PASS로 승격하지
  않았다.
- multi-sort/settings/drag/source-order 세 viewport screenshot 직접 검토.
- 최종 release EXE/NSIS build와 실제 Tauri IPC/WebView2 RUNTIME/SORT/SETTINGS/COLUMN-DRAG 통과.

## 완료를 위해 필요한 재검증

1. physical typed/raw cache와 preparing frontier를 구현하고, byte/cache counter를 release harness에
   완전하게 노출한 뒤 low/high/long-invalid 정규 표본을
   수집한다.
2. cold preparation 5회 표본을 채우고 Ready page p95를 20ms 이하로 개선한 뒤 기존 실패 JSON을
   덮어 숨기지 말고 새 raw sample과 함께 비교한다.
3. writer별 fault/corruption recovery 전수 matrix, full-copy, lifecycle soak를 실행한다.
4. 계획에 빠진 E2E 시나리오와 전체 E2E를 실행하고 통합 geometry/interaction artifact를 만든다.
5. Windows clipboard, 150% DPI와 NSIS install/runtime smoke를 수행한다.

위 HIGH 항목이나 필수 `NOT_RUN`이 하나라도 남으면 `docs/DEVELOPMENT_PLAN.md`의 Phase 14 상태를
완료로 변경하면 안 된다.
