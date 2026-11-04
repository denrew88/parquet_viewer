# Phase 20 통합 기록

2026-11-04. 사용자 승인으로 세 작업을 Phase 20에 통합 등록했다.

| 원래 위치 | 현재 위치 |
| --- | --- |
| artifacts/csv-native-parquet | artifacts/phase-20/native |
| artifacts/storage-pressure | artifacts/phase-20/storage-pressure |
| artifacts/storage-decimal | artifacts/phase-20/storage-decimal |
| artifacts/csv-native-parquet/bin/data-viewer.exe | src-tauri/target/release/data-viewer.exe |
| 위 bin의 과거 GUI·성능 CLI | src-tauri/target/release/phase20-reference/ |

기존 승격·중복 삭제 manifest는 prior-*.json으로 옮겼다. 원시 JSON·log·PNG와 snapshot 내용은 보존했다.
옛 절대 경로를 원시 증거에서 일괄 치환하지 않았다. 이동표와 해시가 현재 위치를 연결한다.
과거 결과 생성용 일회성 promote.py/finalize.py는 후속 사용자 정리 지시로 제거했다. 현재 빌드·검증 진입점은 유지한다.

현재 build/check/native/Playwright harness는 이동에 필요한 상대·루트 경로만 정정한다.
개발 runner와 compatibility build wrapper도 Phase 20 경로를 참조한다.
일반 빌드의 중간 draft·컴파일 cache와 정식 EXE 위치는 구분하며, 승인된 승격만 정식 파일을 교체한다.

제품 소스·테스트·Cargo/package/Tauri 버전 파일과 live native converter는 바꾸지 않았다.
기존 native variant 빌드 구조도 유지한다. 이 정리가 원래 full-Polars manifest의 교체까지 수행한 것은 아니다.
새 EXE·installer를 만들거나 게시하지 않았다.

## 후속 승인: 버전 재빌드와 fixture 배치

최초 등록 당시의 재빌드 제외 범위는 이후 사용자의 "그럼 재빌드하고" 지시로 변경됐다.
버전 관련 8개 파일만 0.20.0으로 정렬하고, 전용 fixture 11개를 fixtures/phase-20/으로 정리했다.
새 EXE의 Windows FileVersion/ProductVersion·health_check·Tauri 버전은 모두 0.20.0이다.
Rust/React 동작 코드 변경 없이 기존 native variant를 재빌드했다. 상세 결과는 [재빌드 기록](version-0.20.0/90-results.md)을 따른다.
이전 본문의 무재빌드·0.1.0·해시 보존 판정은 최초 이동 시점의 기록이다.

## Utf8View 후속 수정 — 정식 반영

일반 Parquet의 Utf8View scalar/dictionary/nested 표시·전체 값 및 빈 셀 occupancy를 수정했다.
새 테스트 5개, 전체 Rust 319 PASS/0 FAIL/기존 16 ignored, fmt·all-targets Clippy와 실제 Tauri 화면·캐시 직접 읽기를 통과했다.
사용자 명시적 교체 지시로 검증 EXE를 정식 위치에 반영했다. 버전 0.20.0 유지, 교체 시 재빌드 없음.
[상세 결과](utf8-view/90-results.md). React·캐시 포맷·의존성과 과거 미실행 gate는 유지했다.
