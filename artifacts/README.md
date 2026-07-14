# 개발 Orchestration Artifacts

이 디렉터리는 subagent를 사용하는 Phase 실행의 범위, 통합, 검증 근거를 보관한다. 제품
소스나 공식 요구사항을 대신하지 않는다.

## 현재 상태

Phase 0~7 구현과 자동 검증을 진행했고 Phase 8 설계를 완료했다. 현재 추가 기능 범위와 역할은
`artifacts/phase-8/00-scope.md`, 구현 순서는 `artifacts/phase-8/40-implementation-plan.md`를
확인한다.

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
