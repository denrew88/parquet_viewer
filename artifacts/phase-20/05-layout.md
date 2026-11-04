# Phase 20 경로와 실행 흐름

| 역할 | 기준 위치 | 비고 |
| --- | --- | --- |
| React 제품 UI | src/ | 이번에는 변경 없음 |
| 원래 Rust 제품 소스·manifest | src-tauri/ | 0.20.0 및 Utf8View 공통 Rust 수정; 원래 full-Polars 의존성 구조 유지 |
| 현재 경량화 EXE의 Rust 빌드 입력 | artifacts/experiments/csv-native-parquet/size-variant/ | polars-arrow/parquet 하위 crate를 쓰는 기존 native variant |
| 공유 runtime 동기화 | artifacts/phase-20/storage-pressure/sync_runtime.cjs | storage/query 공유 파일과 기존 worker patch 검사 |
| 빌드 진입점 | node scripts/dev-check.mjs native-build | native/build.ps1 → 기존 Cargo cache → draft EXE |
| Cargo 중간 산출물 | .tmp/duckdb-size-target/ | 최종 배포 위치가 아닌 재사용 컴파일 cache |
| 정식 EXE | src-tauri/target/release/data-viewer.exe | 검증한 draft를 승인된 범위에서 반영 |
| Phase 20 입력 | fixtures/phase-20/ | Timestamp·소수 Storage·main-high 포함 5개 성능 입력 |
| 과거 Phase 공용 입력 | 기존 fixtures/phase-N | experiment 경로를 정식 fixture 위치로 사용하지 않음 |
| 테스트용 mirror·hardlink | experiment/fixtures 및 실행별 fixtures 하위 | 원본 입력 위치가 아니며 기존 테스트 상대 경로에 필요 |
| 정식 문서·검증 기록 | artifacts/phase-20/ | 원시 과거 증거는 당시 경로·해시 유지 |
| 재빌드·실행 결과 | artifacts/phase-20/version-0.20.0/ 및 utf8-view/ | 초기 버전 정렬과 후속 문자열 수정 증거 분리 |

현재 정식 EXE가 원래 src-tauri/Cargo.toml만으로 빌드되는 구조라고 표현하면 안 된다.
이번 요청은 기존 경량화 경로를 유지한 버전 재빌드와 fixture 배치 정리이며, 두 Rust 트리의 통합 리팩터링은 하지 않는다.
