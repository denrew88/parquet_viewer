# AGENTS.md

## 프로젝트

로컬 CSV와 Parquet 파일을 탐색하는 읽기 전용 Tauri 데스크톱 뷰어를 만든다.
대용량 파일을 전체 메모리에 올리지 않고 탐색할 수 있어야 하며, 가상화 그리드에서
Excel 방식의 셀 선택과 스프레드시트로 붙여넣을 수 있는 복사를 제공한다.

## 먼저 읽을 문서

구현 또는 설계 변경 전에 다음 문서를 순서대로 읽는다.

1. `docs/PROJECT_SPEC.md`: 기능, UX, 데이터 형식, 보안의 상세 계약
2. `docs/DEVELOPMENT_PLAN.md`: 현재 Phase, 해야 할 일, 테스트, 완료 조건
3. `docs/UI_VALIDATION.md`: UI 변경의 상호작용, geometry, screenshot, Tauri 검증 계약

이 파일에는 핵심 규칙만 둔다. 상세 동작을 추측하거나 이 파일에 중복해서 추가하지 말고
위 문서를 확인하고 갱신한다.

## Subagent 하네스

Phase 구현, 여러 영역을 가로지르는 기능, subagent 역할 분담, Phase 완료 검증 요청에는
`data-viewer-development-orchestrator` Skill을 먼저 사용한다.

- Orchestrator: `.agents/skills/data-viewer-development-orchestrator/SKILL.md`
- 전문 Agent: `.codex/agents/`
- Phase 실행 기록: `artifacts/`

사용자가 Skill 이름을 직접 말하지 않아도 다음과 같은 요청이면 Orchestrator로 연결한다.

- "현재 Phase를 구현해줘"
- "subagent로 나눠서 진행해줘"
- "Phase 완료 조건을 검증해줘"
- "남은 개발 단계를 계속해줘"

설명, 아이디어 논의, 문서 오타, 독립적인 한 파일 수정에는 Orchestrator를 사용하지 않는다.
사용자가 특정 Agent를 지정한 경우에는 그 역할만 직접 사용할 수 있다. Phase 상태와 공통
문서는 루트 Orchestrator만 변경한다.

## MVP 범위

- CSV와 Parquet 파일 열기
- 네이티브 파일 대화상자, drag and drop, 운영체제 파일 연결
- 한 창의 다중 문서 탭과 독립적인 다중 프로세스 실행
- Data, Schema, Metadata 화면
- 페이지 조회와 가상화된 행·컬럼
- Excel 방식의 마우스·키보드 셀 선택
- 선택 범위를 TSV로 복사해 Excel 등에 붙여넣기
- 선택과 연결된 셀 컨텍스트 메뉴

데이터 편집, 원격 스토리지, SQL, 내보내기, HDF5는 MVP 범위가 아니다.

## 기술 스택

- Tauri 2와 stable Rust
- React, TypeScript, Vite
- Apache Arrow Rust의 `parquet`, `arrow` crate
- Rust `csv` crate
- TanStack Table과 TanStack Virtual
- 기능에 맞는 공식 Tauri 플러그인

lockfile을 커밋한다. 구체적인 요구사항이나 측정된 한계가 없다면 기술 스택을 교체하거나
DataFusion 같은 대형 의존성을 추가하지 않는다.

## 필수 아키텍처 규칙

- 프런트엔드는 데이터 파일을 직접 읽지 않는다.
- Tauri command는 얇게 유지하고 파싱과 조회는 독립적인 Rust 모듈에 둔다.
- CSV와 Parquet는 공통 데이터 소스 계약 뒤에 두되 형식별 동작을 억지로 합치지 않는다.
- 파일 전체를 역직렬화하지 않는다. 페이지, 요청, index, cache에 명시적인 상한을 둔다.
- CPU 사용량이 큰 작업은 UI thread 밖에서 실행하고 진행 상태와 취소를 제공한다.
- 오래된 비동기 응답이 현재 파일이나 페이지 상태를 덮어쓰지 못하게 한다.
- 64비트 정수, decimal, timestamp의 정밀도와 논리 타입을 보존한다.
- 그리드 선택은 DOM이 아닌 논리 행·컬럼 좌표로 관리한다.
- 모든 파일을 신뢰할 수 없는 입력으로 취급하고 읽기 전용으로 연다.
- panic 대신 타입이 명확하고 사용자 메시지로 변환 가능한 오류를 반환한다.

## 작업 방식

`docs/DEVELOPMENT_PLAN.md`에서 현재 Phase를 확인하고 그 단계의 계약과 테스트를 기준으로
작업한다. 사용자의 명시적 요청이 우선하지만 선행 기반 없이 후속 기능을 임시 구현하지
않는다.

변경 범위는 요청된 동작에 한정한다. 기존 경고를 숨기거나 테스트 기준을 낮추지 않는다.
단계에서 확정된 동작, 성능 제한, 설계 결정은 코드와 함께 상세 문서에 반영한다.

Phase 상태는 필수 테스트와 완료 조건을 모두 충족한 뒤에만 `완료`로 바꾼다. 실행하지
못한 테스트가 있으면 이유와 남은 위험을 기록한다.

Phase 구현 전에 Quality Agent가 완료 조건을 추적 가능한 테스트 계획으로 구체화한다.
구현 Agent는 소유 모듈의 단위 테스트를 코드와 함께 작성하고, Quality Agent는 fixture,
E2E, 인수, 성능 테스트와 구현 후 독립 검증을 담당한다.

UI 변경은 `docs/UI_VALIDATION.md`에 정의된 browser interaction, DOM geometry, 세 가지
viewport screenshot, 실제 Tauri 검증을 적용한다. 브라우저 검증만으로 native UI 항목을
PASS 처리하지 않는다.

Rust 변경 후에는 format, clippy, 관련 테스트를 실행한다. 프런트엔드 변경 후에는 format,
lint, typecheck, 관련 테스트를 실행한다. 완료 전에는 실행 가능한 전체 검증을 수행한다.

네이티브 런타임 의존성 추가, 기술 스택 변경, 쓰기 기능 추가, 보안 권한 확대, 산출물
배포 전에는 사용자에게 확인한다.

일반 개발 패키지 설치, 테스트 실행, 개발 서버 시작, UI 검증을 위한 브라우저·Tauri 창
실행은 별도 확인 없이 진행한다. 이 사전 허용은 보안 권한 확대, 데이터 삭제, 외부 배포까지
포함하지 않는다.
