# Phase 20 — CSV 변환 경량화와 Storage 안정화

2026-11-04 사용자 지시로 기존 경량화·Storage 오류·소수 GiB UI 수정 결과를 하나의 정식 Phase로 등록했다.
최초 등록은 파일 이동만 수행했다. 이후 사용자의 명시적 재빌드 지시로 버전을 0.20.0으로 맞추고 기존 경량화 경로를 재빌드했다. 이후 Utf8View 후속 수정으로 공통 Rust 문자열 처리·빈 셀 탐색을 보완했다. React는 유지했다.

| 항목 | 현재 값 |
| --- | --- |
| Phase | 20 |
| Phase 대응 버전 | 0.20.0 |
| 실제 EXE 내장 FileVersion / ProductVersion | **0.20.0 / 0.20.0** — Windows 속성·실제 앱 반환값 확인 |
| 실행 파일 | [data-viewer.exe](../../src-tauri/target/release/data-viewer.exe) |
| 크기 | 58,787,840 bytes |
| SHA-256 | 10275191912bf83dab8e4800e74561d1a38da698d2246064f06be853b2839e3c |
| 앱 식별자 | com.denrew88.data-viewer-native-validation-20261103 — 기존 검증본 그대로 |

Phase 대응 버전과 실제 내장 버전은 모두 0.20.0이다. health_check와 Tauri getVersion도 0.20.0을 반환한다.
새 검증본은 `src-tauri/target/release/data-viewer.exe`에 반영했다. 이 폴더 아래에는 EXE를 두지 않는다.

- [범위](00-scope.md), [기존 검증 대응표](10-test-plan.md), [통합 결과](50-integration.md), [판정·한계](90-review.md)
- [현재 실행 파일 기록](20-build.json), [이동·원본 보존 해시](30-relocation.json)
- [현재 등록 파일·해시](40-manifest.json)
- [불필요 파일 정리 내역](45-cleanup.json): 생성 입력·WebView 프로필·중간 결과·중복 로그를 제거했다.
- [CSV 변환 경량화](native/README.md): 성능·크기 비교와 원래 구현 snapshot.
- [작은 Storage 한도 오류](storage-pressure/90-results.md): 여러 CSV의 예약·hardlink 과금·캐시 복원 수정.
- [소수 GiB UI](storage-decimal/90-results.md): 0.3GiB 저장·재열기·backend 적용.

`prior-*.json`, native/10-manifest.json, snapshot과 원시 결과의 경로·해시는 당시 기록이다.
과거 manifest는 당시 보관 목록이며 현재 파일 존재를 보장하지 않는다. 정리 후 남긴 파일은 40-manifest.json과 각 최종 결과를 따른다.
옛 경로는 30-relocation.json의 folderMoves / executableMoves로 현재 위치를 찾는다.
제품·native variant의 value_format/parquet_source 공통 소스에 Utf8View를 반영했다. 버전은 0.20.0이다.
기존 full-Polars 제품 manifest를 native variant로 교체했다는 뜻도 아니다.
Phase 0~19는 이력으로 유지하고, 이번 Phase로 대체된 세 독립 artifact 폴더는 제거했다.

- [프로젝트 경로 구조](05-layout.md), [중앙 fixture](../../fixtures/phase-20/README.md), [이동 해시](35-fixtures.json), [0.20.0 재빌드 결과](version-0.20.0/90-results.md)
- [585만 행·979MB CSV](../../fixtures/phase-20/performance/main-high/high-5850000x15.csv)와 대응 profile도 중앙 fixture로 이동했다. 이전 experiment 위치에는 사본을 남기지 않았다.

- [Utf8View 후속 수정·정식 교체](utf8-view/90-results.md): 회귀 5개·전체 Rust 319개·fmt/Clippy·실제 Tauri 표시와 캐시 직접 조회 PASS.
