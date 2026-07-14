# Phase 7 통합 결과

- 통합일: 2026-07-14
- 상태: release 산출물 생성 완료, 외부 UI gate 일부 BLOCKED

## 자동 gate

- frontend format/lint/typecheck/build, 102 tests: PASS
- Rust fmt/clippy, 76 tests: PASS
- Tauri release executable: PASS
- NSIS installer: PASS
- npm audit: 취약점 0
- CSP/capability/hostile input audit: PASS

## 성능

250,000행×40열 gate fixture 기준 p95:

| 형식 | open | first page | cached page | random page |
| --- | ---: | ---: | ---: | ---: |
| Parquet | 6.4 ms | 39.1 ms | 4.0 ms | 68.8 ms |
| CSV | 4.1 ms | 6.3 ms | 1.8 ms | 660.9 ms |

데이터 계층 open/page 예산을 모두 충족했다. UI scroll/input latency는 Browser/native 계측 환경이 없어 BLOCKED다.

100회 open/read/close/replace soak는 100/100 성공했다. handle은 49→49, working set은 약 3.3MiB 증가했다.

## Installer smoke

- 산출물: `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe`
- silent install exit 0, 설치본 존재 확인
- CSV·Parquet HKCU file association 등록 확인
- CSV 시작 인자로 첫 process 실행 확인
- Parquet 인자로 두 번째 process 실행 시 두 번째 process 종료 및 첫 process 단일 유지 확인
- silent uninstall exit 0, 설치 경로와 app association 제거 확인

clean VM, Explorer pointer drag/drop, 실제 더블클릭 화면, Excel paste는 BLOCKED다.
