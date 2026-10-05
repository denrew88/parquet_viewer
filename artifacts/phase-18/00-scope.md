# Phase 18 범위: query disk-pressure와 temporary storage 오류 안정화

## 배경

대용량 파일에서 filter/sort를 반복하면 DuckDB spill과 persistent CSV cache가 공통 disk budget을
사용한다. 현재 query monitor는 합계가 설정 limit 또는 free-space reserve에 닿으면 실행을 중단하지만,
회수 가능한 비활성 CSV cache를 먼저 정리하지 않는다. DuckDB의 temp I/O 원문도 제품 오류로 충분히
정규화되지 않아 사용자가 실제 원인과 조치를 알기 어렵다.

## 목표

- query temporary data와 persistent CSV cache의 합계가 설정 limit과 5 GiB safety reserve를 넘지 않는다.
- query 시작과 실행 중 disk pressure에서 다른 process나 active lease를 건드리지 않고 비활성 CSV cache를
  LRU로 회수한 뒤 query를 계속한다.
- 현재 query가 사용할 DuckDB temp 상한은 설정 최대치가 아니라 이미 사용 중인 query/cache byte와
  free-space reserve를 반영한 bounded allowance다.
- 공간을 확보할 수 없으면 DuckDB 원문 I/O·path 오류 대신 `QueryTempLimitExceeded`와 사용량·limit·reserve,
  Settings에서 가능한 정리 조치를 포함한 안정적인 메시지를 반환한다.
- 빠른 query 교체, cancel, failure, tab close와 process 종료 뒤 query temp directory와 active lease가
  기준선으로 복귀한다.

## 보존 계약

- 기본 hard cap 10 GiB와 safety reserve 5 GiB를 높이지 않는다.
- persistent cache와 query temporary 사용량·삭제 UI는 계속 분리하되 공통 disk budget은 유지한다.
- active cache/query lease, 다른 process owner directory, 원본 데이터 파일은 자동 삭제하지 않는다.
- DuckDB, Tauri, DTO와 기술 스택을 교체하거나 네이티브 런타임 의존성을 추가하지 않는다.
- query result는 source row identity 한 열만 materialize하고 기존 typed filter/sort 의미를 유지한다.

## 제외 범위

- 원본 데이터 편집 또는 이동
- remote storage와 사용자 지정 temp directory
- hard cap 상향 또는 safety reserve 완화
- UI layout 재설계; backend typed error 문구로 충분하지 않을 때만 기존 query error surface를 보완한다.

## 소유권

| 역할 | 소유 범위 |
| --- | --- |
| Root Orchestrator | 계약, `artifacts/phase-18/**`, 공통 문서, 통합과 완료 판정 |
| Quality Agent | 사전 테스트 설계와 구현 후 독립 검증; 제품 코드 읽기 전용 |
| Rust Data Agent | `src-tauri/src/storage/temp.rs`, `src-tauri/src/storage/csv_cache.rs`, `src-tauri/src/query/engine.rs`와 해당 unit/integration test |
| Grid UX Agent | backend 오류만으로 부족하다고 판정될 때 `src/**`의 최소 오류 UX와 테스트 |

현재 작업 트리의 categorical 지원 변경은 별도 사용자 변경으로 보존하며 Phase 18 담당이 되돌리거나
재작성하지 않는다. 공유 문서와 공통 DTO는 Root만 수정한다.

## 완료 조건

1. 작은 deterministic budget과 forced spill fixture에서 회수 가능한 inactive cache가 있으면 query가 성공한다.
2. active cache만 남거나 free-space reserve를 침범하면 source/raw DuckDB path 오류가 아닌 typed actionable
   storage 오류로 실패한다.
3. 빠른 filter/sort 교체·cancel·failure 반복에서 active query 수, temp byte와 directory가 기준선으로 복귀한다.
4. 다른 process/active cache lease와 원본 파일은 변경되지 않는다.
5. Rust 관련 테스트, format, clippy, 전체 suite와 release/NSIS build가 통과한다. UI 변경 시
   `docs/UI_VALIDATION.md`의 해당 interaction·geometry·screenshot·native 검증을 추가한다.
