# Phase 20 범위

## 포함

1. 전체 Polars 엔진 대신 Rust csv와 polars-arrow/polars-parquet 하위 crate를 사용하는 기존 CSV→Parquet 경량화 결과.
2. 작은 Storage 한도의 다중 CSV 예약, 원본 hardlink 중복 과금, worker 예산 검사와 warm cache 복원 수정.
3. Storage 소수 GiB 입력·정수 byte 반올림·재열기 표시 수정 및 관련 테스트 동기화.

DuckDB query 엔진은 유지한 기존 결과다. 원래 검증 범위·실패 이력·미실행 gate는 축소하거나 새 PASS로 바꾸지 않는다.

## 이번 등록 작업

- Root 단독으로 문서와 기존 산출물을 이동하고 참조만 수정한다. 신규 Phase 구현·Agent 검증은 수행하지 않는다.
- 제품 코드·의존성·manifest·내장 버전·앱 식별자 변경 및 새 빌드·benchmark·전체 suite 실행은 제외한다.
- 실행 파일은 src-tauri/target/release/data-viewer.exe. artifacts에는 문서·검증 증거와 기존 구현 snapshot을 보존한다.
- 이전 artifacts/csv-native-parquet, artifacts/storage-pressure, artifacts/storage-decimal은 이동 후 남기지 않는다.
- live native variant와 재현에 필요한 experiment 입력은 삭제하지 않는다. Phase 0~19도 삭제하지 않는다.

## 등록 완료 조건

- Phase 20 문서·개발 계획·제품 명세·현재 artifact 목록을 연결한다.
- EXE SHA-256 동일성과 실제 내장 버전 0.1.0을 기록한다. 대응 번호 0.20.0과 구분한다.
- 제품 소스·설정 158개와 기존 원시 증거의 내용이 이동 전과 같음을 검증한다.
- 옮긴 harness의 repository root와 현재 경로 참조를 정정한다. 재현 실행이나 재빌드는 하지 않는다.

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
