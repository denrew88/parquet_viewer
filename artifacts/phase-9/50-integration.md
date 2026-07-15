# Phase 9 통합 결과

- 실행일: 2026-07-15
- 판정: 제품 구현과 실행 가능한 자동/native gate PASS, 필수 환경 gate 일부 BLOCKED

## 구현 결과

- compile-time `FormatRegistry`, 공통 `TabularSource`/query provider 계약과 CSV·Parquet handler
- Excel/TSV/CSV/Custom copy preset, 실제 serializer preview, atomic 전역 설정
- CSV Auto/All Text/Ask 기본 모드, 다중 컬럼 profile 편집, 분산 sample preview, 전체 검증·취소
- DuckDB embedded 기반 전체 파일 filter/find/search, distinct paging, nulls-last stable multi-sort
- document/session/query/task identity 검증, stale result 폐기, cooperative cancel
- app-local-data process/document/query temp, 10 GiB process cap, owner lock과 startup janitor
- profile 교체 시 호환 query 재실행, 비호환 조건 제거 알림과 최신 query race 방어

## 자동 gate

| Gate | 결과 |
| --- | --- |
| Prettier, ESLint, TypeScript | PASS |
| Vitest | PASS, 258/258 |
| Vite production build | PASS |
| rustfmt, Clippy `-D warnings` | PASS |
| Rust tests | PASS, 119 passed / 1 ignored |
| Tauri release/NSIS build | PASS |
| 독립 defect review | PASS, HIGH/MEDIUM 0 |

## 대용량 제품 query

제품 `QueryService` ignored test를 release로 별도 실행했다. 두 fixture 모두 10,000,000행 x
40컬럼, 100 row groups다.

| Cardinality | 파일 크기 | filter/sort | random page | cancel |
| --- | ---: | ---: | ---: | --- |
| low | 15,502,401 bytes | 17,626.285 ms | 3.5922-39.5655 ms | PASS |
| high | 2,561,128,881 bytes | 15,034.968 ms | 3.8571-44.1379 ms | PASS |

peak working set은 1,132,679,168 bytes였고 완료 후 spill은 owner lock 10 bytes만 남았다.
상세 근거는 `product-large-test.md`와 `product-large-fixtures-manifest.json`에 있다.

## 프로세스와 패키지

- 5개 독립 process x 20 cycle, 총 100 invocation: PASS
- 최종 EXE: `src-tauri/target/release/data-viewer.exe`, 48,156,160 bytes,
  SHA-256 `165bdf83c51815555029b2fa525e5af60a1d655787a6298e1f8235bf194a81a1`
- 최종 NSIS: `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe`, 10,914,080 bytes,
  SHA-256 `f30ab1109eee70e1cf9f1ecf8ce9563912993c1f0329ccfad4dc5bcbfb7c669e`
- 최종 바이너리로 CSV startup argv와 1440x900 native grid 표시: PASS

## BLOCKED

- CSV profile 기준 Playwright는 PASS했지만 나머지 Browser interaction, geometry, screenshot은 미실행
- OS drag-and-drop, 설치본 file association, 150% DPI, 실제 Excel paste
- LIFE-004 8-tab profile/query/open/close 100 cycle
- PERF-009 8-tab 중 2개 동시 query와 다른 tab page p95

필수 BLOCKED가 있으므로 제품 구현은 끝났지만 Phase 9를 계약상 `완료`로 표시하지 않는다.
