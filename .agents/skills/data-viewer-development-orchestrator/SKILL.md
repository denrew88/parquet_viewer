---
name: data-viewer-development-orchestrator
description: >-
  CSV·Parquet Tauri 뷰어의 Phase 구현을 여러 subagent에 나누고 통합·검증합니다.
  사용자가 "현재 Phase를 구현해줘", "subagent로 나눠서 진행해줘", "Phase 완료 조건을
  검증해줘", "남은 개발 단계를 진행해줘"처럼 프로젝트 개발 흐름을 요청할 때 사용하세요.
  단순 설명, 아이디어 논의, 상세 문서만 수정하는 요청, 독립적인 한 파일 수정에는 사용하지
  마세요.
---

# Data Viewer Development Orchestrator

## 목적

이 Skill은 `docs/DEVELOPMENT_PLAN.md`의 Phase 0~8을 전문 Agent에게 분배하고, 구현 전
테스트 설계와 구현 후 독립 검증을 연결하며, 파일 충돌을 막는다. Orchestrator는 모든
코드를 직접 작성하는 역할이 아니라 계약, 순서, 소유권, 통합, 완료 판정을 관리하는 실행
입구다.

## 필수 입력

- 사용자의 현재 요청
- `AGENTS.md`
- `docs/PROJECT_SPEC.md`
- `docs/DEVELOPMENT_PLAN.md`
- UI 변경이면 `docs/UI_VALIDATION.md`
- 현재 작업 트리와 기존 변경
- 현재 Phase의 기존 `artifacts/phase-N/` 기록

입력이 부족해 현재 Phase나 최종 산출물을 확정할 수 없을 때만 짧게 질문한다. 합리적으로
판단할 수 있으면 현재 문서와 작업 트리를 기준으로 진행한다.

## 실행 모드

1. `artifacts/phase-N/00-scope.md`가 없으면 Phase의 초기 실행이다.
2. scope가 있고 완료되지 않은 작업이 있으면 이어서 실행한다.
3. 사용자가 일부 수정만 요청하면 관련 담당과 검증만 부분 재실행한다.
4. 완료된 Phase의 계약을 바꾸는 요청이면 영향받는 회귀 범위를 먼저 정한다.
5. 새 입력으로 기존 범위를 폐기해야 하면 기존 기록을 `artifacts/archive/`에 보존한다.

## Agent 역할

| Agent | 책임 | 기본 소유 범위 |
| --- | --- | --- |
| `rust_data_engineer` | CSV·Parquet, 페이지, cache, 타입, 데이터 세션 | `src-tauri/src/data/**`, `src-tauri/src/domain/**` |
| `grid_ux_engineer` | React UI, 가상화, 선택, 키보드, clipboard UX | `src/**` |
| `tauri_platform_engineer` | command, IPC, 파일 열기, capability, 패키징 | `src-tauri/src/platform/**`, `src-tauri/src/commands/**` |
| `quality_gate_reviewer` | 사전 테스트 설계, fixture·E2E, 사후 독립 검증 | 기본 읽기 전용, 할당된 test·fixture·benchmark |

한 Phase에서 모든 Agent를 동시에 호출하지 않는다. `주담당 1 + 협업 0~2 + 품질 1`을
기본으로 한다. `quality_gate_reviewer`는 계약 확정 후 테스트 설계 모드로 한 번, 구현 통합
후 독립 검증 모드로 한 번 호출한다. 루트를 포함한 동시 실행 수를 초과하지 않는다.

## Phase별 라우팅

| Phase | 주담당 | 협업 후보 | 마지막 검증 |
| --- | --- | --- | --- |
| 0 프로젝트 기반 | `tauri_platform_engineer` | `grid_ux_engineer`, `rust_data_engineer` | `quality_gate_reviewer` |
| 1 Parquet 수직 기능 | `rust_data_engineer` | `tauri_platform_engineer`, `grid_ux_engineer` | `quality_gate_reviewer` |
| 2 대용량 Parquet | `rust_data_engineer` | `grid_ux_engineer` | `quality_gate_reviewer` |
| 3 CSV | `rust_data_engineer` | `grid_ux_engineer` | `quality_gate_reviewer` |
| 4 파일 열기 통합 | `tauri_platform_engineer` | `rust_data_engineer`, `grid_ux_engineer` | `quality_gate_reviewer` |
| 5 가상화 그리드 | `grid_ux_engineer` | `rust_data_engineer` | `quality_gate_reviewer` |
| 6 선택·클립보드 | `grid_ux_engineer` | `rust_data_engineer`, `tauri_platform_engineer` | `quality_gate_reviewer` |
| 7 안정화·배포 | `tauri_platform_engineer` | `rust_data_engineer`, `grid_ux_engineer` | `quality_gate_reviewer` |

Phase 0의 최초 scaffold, 공통 DTO 변경, manifest 변경은 병렬화하지 않는다. 먼저 단일
소유자가 공유 기반을 고정한 뒤 각 Agent가 분리된 경로에서 작업한다.

## 실행 절차

1. 현재 Phase와 사용자의 요청이 일치하는지 확인한다.
2. 작업 트리와 기존 변경을 확인하고 되돌리면 안 되는 사용자 작업을 표시한다.
3. 이번 실행의 목표, 제외 범위, 완료 조건, 테스트를 고정한다.
4. API·DTO·이벤트·오류 계약을 구현 전에 확정한다.
5. Agent별 입력, 출력, 파일 소유권, 선행조건, 병렬 가능 여부를 정한다.
6. `artifacts/phase-N/00-scope.md`를 만들거나 갱신한다.
7. `quality_gate_reviewer`를 테스트 설계 모드로 호출해 완료 조건을 테스트 ID, fixture,
   계층, 기대 결과로 변환한다. UI 변경이면 viewport, 상태, interaction, geometry,
   screenshot, native smoke 증거를 포함한다.
8. 루트가 테스트 설계를 검토하고 `10-test-plan.md`에 기록한다.
9. 구현 Agent에게 코드와 해당 모듈의 단위 테스트를 함께 배정한다. 품질 Agent는 할당된
   fixture, E2E, golden, benchmark를 독립 경로에서 준비할 수 있다.
10. 독립적인 구현 작업만 병렬로 배정한다.
11. Agent 결과를 받아 계약 위반과 파일 충돌을 확인하고 통합한다.
12. 통합 결과와 테스트를 `50-integration.md`에 기록한다. UI 변경이면 Quality Agent와
    Tauri Agent가 독립 증거를 기록할 `ui/` 경로를 준비한다.
13. `quality_gate_reviewer`를 독립 검증 모드로 호출한다.
14. FAIL은 원래 소유 Agent에게 돌려보내고 수정 후 다시 검증한다.
15. 모든 필수 조건과 테스트 ID가 PASS일 때만 루트가 Phase 상태와 문서를 갱신한다.

## 파일 소유권

다음 공유 파일은 병렬 편집을 금지한다. 이번 실행에서 루트가 단일 소유자를 지정하거나
직접 통합한다.

```text
Cargo.toml
Cargo.lock
package.json
frontend lockfile
src-tauri/src/lib.rs
src-tauri/tauri.conf.json
src-tauri/capabilities/**
공통 DTO와 IPC 계약
docs/PROJECT_SPEC.md
docs/DEVELOPMENT_PLAN.md
AGENTS.md
```

- 여러 Agent가 같은 파일을 수정해야 하면 병렬 작업을 중단하고 순차 handoff로 바꾼다.
- Agent가 공유 파일 변경이 필요하다고 판단하면 직접 수정하지 않고 patch 제안을 보고한다.
- 여러 Agent가 동시에 의존성 설치, lockfile 갱신, 전체 formatter를 실행하지 않게 한다.
- 다른 Agent나 사용자가 만든 변경을 발견하면 되돌리지 않고 소유권을 다시 배정한다.

## 산출물 계약

Phase마다 루트 Orchestrator가 다음 조정 문서를 관리한다. UI 증거 파일은 표에 지정된
Agent가 만들고 루트가 완전성과 최종 판정을 확인한다.

| 파일 | 내용 | 다음에 읽는 역할 |
| --- | --- | --- |
| `artifacts/phase-N/00-scope.md` | 목표, 계약, 담당, 소유 파일, 테스트 | 모든 구현 Agent |
| `artifacts/phase-N/10-test-plan.md` | 테스트 ID, 계층, fixture, 기대 결과, 담당 | 구현·품질 Agent |
| `artifacts/phase-N/50-integration.md` | 통합 결과, 변경 파일, 실행 테스트, 위험 | 검증 Agent |
| `artifacts/phase-N/90-review.md` | PASS·FAIL·BLOCKED, 재현, 완료 판정 | 루트와 다음 Phase |
| `artifacts/phase-N/ui/browser-*.png` | 세 viewport의 독립 screenshot | Quality Agent와 루트 |
| `artifacts/phase-N/ui/visual-review.md` | screenshot 이미지 검토 결과 | 루트와 다음 검토 |
| `artifacts/phase-N/ui/geometry-results.json` | DOM 좌표, overflow, 가상화 측정 | Quality Agent와 루트 |
| `artifacts/phase-N/ui/interaction-results.md` | 실제 입력과 상태 검증 결과 | Quality Agent와 루트 |
| `artifacts/phase-N/ui/native-*` | Tauri screenshot과 native smoke | Tauri Agent와 루트 |

Agent의 handoff에는 다음 항목이 반드시 포함되어야 한다.

- 구현 또는 검증 요약
- 수정한 파일
- 요구사항과 완료 조건 대응
- 계약·의존성·권한 변경
- 실행한 테스트와 실제 결과
- 실행하지 못한 테스트와 이유
- 알려진 위험과 다음 담당에게 필요한 정보

## 품질 게이트

`quality_gate_reviewer`는 구현 전과 구현 후에 서로 다른 책임으로 참여한다.

- 테스트 설계 모드: 완료 조건을 추적 가능한 테스트 ID로 바꾸고 fixture, 계층, 기대 결과,
  담당 역할을 정한다.
- 독립 검증 모드: 합의된 테스트 ID를 실행하고 각 완료 조건을 `PASS`, `FAIL`, `BLOCKED`로
  판정한다.
- 구현 Agent는 자신이 소유한 모듈의 unit test를 코드와 함께 작성한다.
- 품질 Agent는 fixture, golden data, cross-module integration, E2E, screenshot, benchmark,
  soak test를 소유한다.

- `FAIL`: 재현 가능한 제품 또는 테스트 결함이 있어 원래 소유 Agent가 수정해야 한다.
- `BLOCKED`: 환경이나 사용자 승인이 없어 필수 검증을 실행할 수 없다.
- 높은 심각도의 FAIL 또는 필수 테스트 BLOCKED가 있으면 Phase를 완료하지 않는다.
- 브라우저 E2E는 실제 Tauri WebView, 파일 연결, native dialog, clipboard 검증을 대체하지
  않는다.
- 실제 Excel 붙여넣기는 TSV 자동 왕복 테스트와 별도의 smoke 검증으로 나눈다.
- UI 변경은 `docs/UI_VALIDATION.md`의 interaction, geometry, desktop·compact·minimum
  screenshot 이미지 검토를 완료해야 한다.
- native dialog, OS drag and drop, 파일 연결, 실제 clipboard는 브라우저 증거만으로 PASS
  처리하지 않는다.
- 필수 native 검증을 자동화할 수 없으면 사람 확인 전까지 BLOCKED로 유지한다.

## 실패 처리

- Agent 결과가 계약과 다르면 해당 Agent의 작업만 범위를 줄여 재실행한다.
- API 계약 자체가 잘못되었으면 병렬 작업을 중단하고 계약부터 다시 확정한다.
- 테스트 실패는 파일 소유권에 따라 원래 구현 Agent에게 반환한다.
- 같은 원인으로 반복 실패하면 Agent를 추가하지 말고 책임 범위와 계약을 더 작게 나눈다.
- 사용자 변경과 충돌하면 통합을 멈추고 되돌리지 않은 상태에서 새 소유권을 정한다.
- 필수 외부 환경이 없으면 가능한 검증을 계속하고 정확한 BLOCKED 근거를 남긴다.

## 사용자 승인 지점

다음 작업은 실행 전에 사용자 승인을 받는다.

- 네이티브 런타임 의존성 추가
- 기술 스택 또는 주요 라이브러리 교체
- Tauri 보안 권한 확대
- 데이터 쓰기나 편집 기능 추가
- installer 배포 또는 외부 게시
- 명세된 MVP 범위를 바꾸는 결정

## 최종 보고 형식

```md
## Phase 결과

- Phase:
- 상태: PASS | FAIL | BLOCKED | 진행 중
- 구현 요약:
- Agent별 결과:
- 테스트:
- UI 증거:
- 문서 갱신:
- 남은 위험:
- 다음 작업:
```

## 테스트 시나리오

| 유형 | 요청 예시 | 기대 동작 |
| --- | --- | --- |
| 정상 | "Phase 1을 subagent로 나눠 구현해줘" | 계약과 소유권, 테스트 계획을 고정하고 구현 후 독립 검증 |
| 이어서 실행 | "현재 Phase의 남은 작업을 계속해줘" | 기존 artifacts와 diff를 읽고 미완료 작업만 재개 |
| 애매함 | "뷰어를 더 빠르게 해줘" | 현재 Phase와 측정 근거를 확인하고 범위를 확정 |
| 실패 위험 | "모든 Agent가 package 파일도 알아서 고치게 해줘" | 공유 파일 병렬 편집을 거부하고 단일 소유자 지정 |
| 부정 | "PROJECT_SPEC.md 오타 하나 고쳐줘" | Orchestrator 없이 일반 단일 파일 작업으로 처리 |

## 직접 호출

```text
$data-viewer-development-orchestrator 현재 Phase를 subagent로 나눠 구현하고 완료 조건을 검증해줘.
```
