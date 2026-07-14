# Phase 8 통합 결과

- 실행일: 2026-07-15
- 판정: 제품 구현과 실행 가능한 자동/native gate PASS, 환경 의존 gate 일부 BLOCKED

## 제품 계약

- 한 창에서 CSV/Parquet 다중 문서 탭, 문서별 page·selection·worker·error 상태 격리
- 셀 우클릭 메뉴의 Copy, Copy with column headers, Copy cell value, View full value
- single-instance 제거와 독립 다중 프로세스 실행
- 32개 batch open, 64개 open document guard, canonical path dedupe, 부분 성공
- source prepare 프로세스 전역 최대 4개, 문서별 cache 8 pages, 전체 cache 64 pages/256MiB
- close/configure/copy/open 취소 경쟁에서 stale 결과 폐기와 정확한 자원 정리

## 자동 gate

| Gate | 결과 |
| --- | --- |
| Prettier, ESLint, TypeScript | PASS |
| Vitest | PASS, 124/124 |
| Vite production build | PASS |
| rustfmt, Clippy `-D warnings` | PASS |
| Rust tests | PASS, 78/78 |
| Tauri release/NSIS build | PASS |

## 대용량 데이터

| Fixture | 크기 | 구조 | 감사 |
| --- | ---: | --- | --- |
| low cardinality | 11,757,872 bytes | 10,000,000 rows x 10 columns, 100 row groups | PASS |
| high cardinality | 579,719,187 bytes | 10,000,000 rows x 10 columns, 100 row groups | PASS |

release runner 3회 측정의 p95는 low/high 순서로 first page 7.196/25.596ms,
cached page 0.218/0.266ms, random page 24.523/87.224ms였다. 100회 open/read/close
soak는 100/100 성공, handle 49 -> 49, working set +2,265,088 bytes였다.

이 수치는 in-process Rust `DataSource`/`DocumentRegistry` 결과다. 별도 cold process 30회,
실제 grid random scroll/copy/multi-document 성능을 대신하지 않는다.

## Native와 패키징

- 같은 Parquet를 지정한 5개 프로세스 x 20 cycle, 총 100 invocation: PASS
- 1440x900 CSV+Parquet 다중 탭: PASS
- 1024x768 셀 컨텍스트 메뉴: PASS
- 800x600 8개 탭 overflow와 좌우 이동 control: PASS
- 컨텍스트 메뉴 Copy 후 Windows clipboard 값 `1`: PASS
- release EXE: `src-tauri/target/release/data-viewer.exe`
- NSIS: `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe`

## 제한

- in-app Browser backend가 없어 Browser interaction/DOM geometry gate는 BLOCKED다.
- 150% DPI, 실제 Excel paste, clean VM install/upgrade/file association은 실행하지 못했다.
- `closed_documents` tombstone은 process-lifetime idempotent close를 위해 누적된다.
