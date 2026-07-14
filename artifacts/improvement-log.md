# Subagent 하네스 개선 기록

실제 Phase 실행에서 역할, 계약, 검증 흐름이 실패하거나 불필요한 비용을 만든 경우에만
기록한다.

## 기록 형식

```md
### YYYY-MM-DD - 제목

- Phase:
- 실행한 요청:
- 기대 결과:
- 실제 결과:
- 막힌 지점:
- 원인:
- 변경한 Agent 또는 Orchestrator 규칙:
- 다음 실행에서 확인할 테스트:
```

### 2026-07-13 - 사전 테스트 설계 단계 추가

- Phase: 전체
- 실행한 요청: 테스트 항목 작성 책임을 명확히 하고 사전 테스트 설계를 추가
- 기대 결과: 구현 전에 완료 조건, 테스트 ID, fixture, 담당 역할이 확정됨
- 실제 결과: 기존 Quality Agent는 구현 통합 후 검증만 담당하도록 정의되어 있었음
- 막힌 지점: 상세 테스트가 구현 이후에 작성될 수 있어 인수 기준이 늦게 고정됨
- 원인: 테스트 설계와 품질 게이트를 하나의 사후 절차로만 정의함
- 변경한 Agent 또는 Orchestrator 규칙: Quality Agent를 테스트 설계와 독립 검증의 두 모드로
  확장하고 `phase-N/10-test-plan.md` 산출물을 추가함
- 다음 실행에서 확인할 테스트: Phase 0 시작 시 구현 전에 `10-test-plan.md`가 생성되고 각
  완료 조건에 테스트 ID와 담당 역할이 배정되는지 확인

### 2026-07-13 - UI 검증 증거 계약 추가

- Phase: UI 변경이 있는 전체 Phase
- 실행한 요청: 스크린샷을 실제로 분석하고 native UI 한계를 구분하는 검증 절차 추가
- 기대 결과: 코드 테스트만으로 UI를 통과시키지 않고 시각·geometry·interaction 증거를 남김
- 실제 결과: 기존 규칙은 screenshot 검증을 언급했지만 viewport, 판정 기준, native 경계,
  증거 파일이 구체적으로 정의되지 않았음
- 막힌 지점: 브라우저 screenshot과 실제 Tauri 동작을 같은 수준의 증거로 오인할 수 있었음
- 원인: UI 검증 계층과 역할별 산출물 계약이 없음
- 변경한 Agent 또는 Orchestrator 규칙: `docs/UI_VALIDATION.md`를 추가하고 Grid, Quality,
  Tauri Agent와 Orchestrator에 browser·geometry·screenshot·native 책임을 연결함
- 다음 실행에서 확인할 테스트: Phase 0 UI 작업에서 세 viewport screenshot, geometry 결과,
  visual review, 실제 Tauri smoke 또는 정확한 BLOCKED 근거가 생성되는지 확인
