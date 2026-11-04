# 개발 Orchestration Artifacts

이 디렉터리는 subagent를 사용하는 Phase 실행의 범위, 통합, 검증 근거를 보관한다. 제품
소스나 공식 요구사항을 대신하지 않는다.

## 현재 상태

### Phase 20 — CSV 변환 경량화와 Storage 안정화 (2026-11-04)

사용자 지시로 경량화와 Storage 수정 전체를 [Phase 20](phase-20/README.md)에 통합했다.
실행 파일은 artifacts 밖의 [src-tauri/target/release/data-viewer.exe](../src-tauri/target/release/data-viewer.exe)에 있다.
후속 사용자 지시로 재빌드해 대응 번호·실제 내장 버전은 모두 0.20.0이다. 전용 입력은 fixtures/phase-20/에 있다.
이동 전 기록은 [기존 승격 목록](phase-20/prior-promotion-manifest.json), 현재 경로·무결성은
[이동 목록](phase-20/30-relocation.json)과 [빌드 기록](phase-20/20-build.json)을 따른다.
앞으로의 승격은 작업 종료 후 사용자 확인을 받는다. 임시 로그 저장과 일반 빌드는 승격이 아니다.
승격 뒤 사용자 지시에 따라 원래 위치의 동일 사본 380개(129.78MiB)를 삭제했다.
[삭제·보존 경로와 해시](phase-20/prior-duplicate-cleanup.json)를 기록했으며, 현재 빌드에 필요한 소스와 harness는 유지했다.

- [개발 실행·작업 효율 규칙](development-workflow/README.md): 고정 검증 진입점과 범위·승인·종료 기준.
- [Storage 소수 GiB 입력 수정](phase-20/storage-decimal/90-results.md): 0.3GiB 저장·재열기 및 실제 앱 적용, frontend 414개와 3개 viewport 검증.
- [작은 저장 한도에서 여러 CSV 준비 오류 수정](phase-20/storage-pressure/90-results.md): 0.5~1GiB 예약,
  원본 hardlink 과금·캐시 재열기·외부 변환기 예산 검사를 수정했다. Rust 314개와 실제 두 한도 검증 PASS.
  [독립 검토](phase-20/storage-pressure/95-review.md)에서 이번 버그 수정 범위를 승인했다.
- [CSV native Parquet 변환 정식 artifacts](phase-20/native/README.md): 구현 snapshot, 확대 테스트,
  성능·수정된 EXE 크기, 실제 Tauri 증거, 실행 파일 해시와 Timestamp fixture를 보존한다.
  검증된 비교 구현이며 제품 반영·Phase 완료·외부 배포를 뜻하지 않는다.

### 기존 Phase 기록

Phase 0~19는 과거 이력으로 유지한다. 각 상태는 `docs/DEVELOPMENT_PLAN.md`와 해당 Phase의
검토 기록을 따른다. Phase 20으로 대체된 독립 artifact 폴더 세 개는 제거했다.

## Phase별 파일

| 파일 | 소유자 | 내용 |
| --- | --- | --- |
| `phase-N/00-scope.md` | 루트 Orchestrator | 목표, 계약, Agent, 파일 소유권, 테스트 |
| `phase-N/10-test-plan.md` | 루트 Orchestrator | 테스트 ID, 계층, fixture, 기대 결과, 담당 역할 |
| `phase-N/50-integration.md` | 루트 Orchestrator | 구현 결과, 변경 파일, 통합 테스트, 위험 |
| `phase-N/90-review.md` | 루트 Orchestrator | 독립 검증 결과와 Phase 완료 판정 근거 |
| `phase-N/ui/browser-*.png` | Quality Agent | desktop, compact, minimum 독립 screenshot |
| `phase-N/ui/visual-review.md` | Quality Agent | screenshot 이미지 검토 결과 |
| `phase-N/ui/geometry-results.json` | Quality Agent | DOM 좌표, overflow, 가상화 측정 |
| `phase-N/ui/interaction-results.md` | Quality Agent | 키보드·마우스·상태 전환 결과 |
| `phase-N/ui/native-*` | Tauri Platform Agent | 실제 Tauri screenshot과 native smoke |

Agent는 같은 파일을 동시에 수정하지 않는다. 조정 Markdown은 루트 Orchestrator가 기록하고,
UI 증거는 지정된 Agent가 고유 파일에 기록한다. 루트는 증거의 완전성과 최종 판정을
통합한다.

## 기록 원칙

- 코드와 요구사항의 source of truth는 저장소 소스와 `docs/` 문서다.
- artifact에는 재현 명령, 실제 결과, 실행하지 못한 테스트를 기록한다.
- 이전 기록을 덮어써야 하면 `artifacts/archive/`에 보존한다.
- 반복된 실패와 하네스 규칙 변경은 `improvement-log.md`에 남긴다.
