# Phase 16 실행 범위

- 실행 상태: **완료 (2026-07-29)**
- 시작일: 2026-07-28

## 1. 목적

Phase 16은 대용량 CSV의 재사용 가능한 prepared source가 만들어지는 동안 같은 문서의 Data view에서
query·distinct·copy·navigation 요청이 새로 시작되는 경로를 사용자 상호작용 단계에서 차단한다.
동시에 UI 차단만으로 안전성을 대신하지 않고 Phase 15에서 추가한 backend wait/reuse/cancel 계약을
유지한다. 기존 native smoke에서 발견된 `Ctrl+Down` target page 이동 뒤 active cell이 viewport에 완전히
표시되지 않는 회귀도 같은 문서 상호작용 안정화 범위에서 수정한다.

## 2. 포함 범위

- cold CSV preparation의 실제 상태가 `Preparing`인 동안 해당 문서 Data view를 `inert`로 전환
- 그리드 선택·스크롤·키보드 이동, filter, multi-sort, Find, copy, column search·visibility·reorder,
  CSV Parsing Profile 진입 차단
- 준비 진행률·경과·Cancel은 차단 영역 밖에서 계속 접근 가능
- 다른 문서 탭 이동, 문서 닫기, Data/Schema/Metadata view 전환과 전역 Settings는 계속 허용
- preparation이 `Ready`, `Failed` 또는 `Cancelled` terminal 상태가 되면 차단 해제
- 실패·취소 뒤 기존 direct source fallback과 오류·Retry·Dismiss UI 유지
- warm persistent cache의 즉시 `Ready`에서는 preparation gate가 DOM/paint에 나타나지 않음
- preparing 전환 시 열려 있던 filter, Find, sort, context, copy-history 등 transient surface 닫기
- UI 경계를 우회한 IPC와 오래된 요청에 대한 backend wait/reuse/cancel, session·generation 검증 유지
- 준비 중 반복 distinct/query 요청이 UI에서 생성되지 않고 기존 요청의 stale 응답이 적용되지 않음
- `Ctrl+Down`/`Ctrl+Up` target page 이동 뒤 active cell, focus와 selection outline의 viewport visibility 보장

## 3. 허용되는 상호작용

Preparing 중에도 다음 동작은 차단하지 않는다.

- 다른 파일 탭 활성화와 현재 파일 탭 닫기
- Data, Schema, Metadata view 전환
- CSV preparation 진행 상태와 오류 확인
- CSV preparation 취소
- 애플리케이션 Settings 열기와 닫기

## 4. 상태 계약

| preparation 상태 | Data view | 진행 UI | query·distinct 신규 요청 |
| --- | --- | --- | --- |
| 시작 요청 중, 아직 상태 미확정 | 기존 preview 유지 | 표시하지 않음 | backend 안전장치 유지 |
| `Preparing` | inert + 명시적 overlay | progress·Cancel 표시 | UI에서 0건 |
| `Ready` | 즉시 사용 가능 | 표시하지 않음 | prepared artifact 사용 |
| `Failed` | direct source 사용 가능 | 오류·Retry·Dismiss 표시 | direct fallback 허용 |
| `Cancelled` | direct source 사용 가능 | 취소·Retry·Dismiss 표시 | direct fallback 허용 |

`starting`만으로 gate를 표시하지 않는다. 이 규칙은 warm cache hit에서 한 frame의 progress/disabled flash도
만들지 않기 위한 것이다. 실제 `Preparing` 응답을 받은 뒤에는 그 문서의 Data view만 차단한다.

## 5. 비범위

- DuckDB 또는 Polars dependency와 CSV cache 형식 변경
- 준비 중 partial prepared artifact를 query에 공개
- 실패·취소 뒤 direct source fallback 제거
- Schema·Metadata 탐색 차단
- 모든 백그라운드 작업을 애플리케이션 전체에서 전역 중지
- 기존 Phase의 clean-machine, 실제 Excel 등 외부 환경 BLOCKED gate 해소

## 6. 완료 조건

- preparing 중 Data view의 포인터·키보드·전역 shortcut과 모든 query/distinct/copy 진입이 차단된다.
- tab close, tab/view 전환, preparation Cancel과 Settings는 계속 동작한다.
- terminal 상태에서 차단이 풀리고 Ready는 prepared artifact, Failed/Cancelled는 direct source로 동작한다.
- warm Ready에서는 차단 overlay·spinner·Cancel과 layout shift가 한 frame도 나타나지 않는다.
- 반복 사용자 입력, tab close와 session 교체에서 대기 worker·query·distinct·late UI update가 누적되지 않는다.
- native `Ctrl+Down` 연속 경계 이동의 target active cell과 focus가 viewport 안에 완전히 표시된다.
- 세 viewport browser interaction·geometry·screenshot, 실제 5.85M cold/warm Tauri smoke와 전체 회귀가 PASS다.
- HIGH/MEDIUM 결함과 필수 BLOCKED가 없고 `50-integration.md`, `90-review.md`와 UI 증거가 완성된다.
