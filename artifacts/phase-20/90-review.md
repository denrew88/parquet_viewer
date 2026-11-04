# Phase 20 등록 판정

**정식 Phase 등록·기존 결과 이동 완료. 전체 제품 gate 신규 완료 판정은 하지 않음.**

- Phase 번호, 작업 범위, 기존 테스트 증거와 현재 EXE를 연결했다.
- EXE는 기존 검증본 그대로이며 SHA-256 d34e48c7a0f04c69166fc7cb2b10e58b926792e0824059ae65319a65f7e62a03.
- 실제 FileVersion/ProductVersion은 0.1.0. Phase 대응 버전 0.20.0을 내장 버전처럼 표시하지 않는다.
- 제품·variant 소스와 설정 158개, 원시 JSON·log·PNG 418개의 해시 보존을 확인했다.
- 대체된 artifact 폴더 세 개는 남기지 않고 과거 Phase 0~19는 유지한다.
- 이번 검증은 파일·링크·스크립트 구문과 실행 계획의 확인이다. 제품 테스트·GUI·빌드는 재실행하지 않는다.

기존 검증의 범위·미실행 사항은 10-test-plan.md와 각 결과 보고서를 따른다.
등록과 파일 정리를 위해 새로운 품질 Agent 검증이나 제품 채택·전체 Phase gate 완료를 만들어 기록하지 않았다.

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
