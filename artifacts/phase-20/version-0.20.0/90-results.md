# Phase 20 — 0.20.0 재빌드와 fixture 정리

사용자의 명시적 후속 재빌드 지시로 수행했다. Rust/React 동작 코드는 변경하지 않았다.

- 프로젝트 package·Rust/Tauri와 lockfile 총 8개 버전 기록을 0.20.0으로 정렬했다.
- 기존 native variant release 빌드 1회. 새 dependency 다운로드·전체 benchmark·installer 빌드는 하지 않았다.
- Windows FileVersion·ProductVersion, 실제 앱 health_check·Tauri getVersion 모두 **0.20.0**.
- 중앙 fixture에서 storage-decimal.csv 3행과 timestamp.csv 16행을 실제 앱으로 열고 Ready·첫/마지막 id page를 확인했다. 원본 SHA-256도 보존했다.
- Timestamp 논리 타입·정밀도·모든 파싱 규칙에 대한 전체 인수 검증으로 확대 해석하지 않는다.
- [현재 EXE](../../../src-tauri/target/release/data-viewer.exe): 58,786,816 bytes, SHA-256 `7c9b3db2f698bd9d237005ad5caf39ba9174f13dfbf730a02f41a12e5dd7ce4f`.
- [실제 앱 결과](native-result.json), [Windows 버전](windows-version.json), [fixture 이동](../35-fixtures.json), [경로 구조](../05-layout.md).

fixture 11개: Timestamp CSV·설명, Storage 소형 CSV, 성능 입력 4개 CSV와 대응 profile 4개.
기존 성능 CSV 4개와 소형 입력은 이동했고, profile은 불변 snapshot을 유지하면서 실행 입력으로 복원했다.
대용량 CSV는 Git 제외이며 작은 CSV·설명·profile과 해시 manifest는 추적한다. 이후 누락됐던 5.85M main-high CSV와 profile도 중앙 fixture로 이동했다. 현재 총 13개이며 35-fixtures.json이 현재 목록이다. 다른 Phase 입력은 fixtures/phase-N, 테스트용 생성 mirror는 각 실행 경로를 유지한다.

기존 314 Rust·414 frontend·E2E·성능 결과는 앞선 검증으로 유지한다. 이번 버전 변경 때문에 전체 suite를 반복하지 않았으며 새 결과로 표시하지 않는다.
외부 배포·Git commit·새 보안 권한 또는 앱 identifier 변경은 수행하지 않았다.
