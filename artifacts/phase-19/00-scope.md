# Phase 19 범위: Arrow dictionary value-type query parity

## 배경

Arrow dictionary categorical은 `Dictionary(key_type, value_type)` 구조를 갖고 row group마다 dictionary
내용과 key/code 배치가 달라질 수 있다. 현재 페이지 표시는 batch-local dictionary를 실제 값으로
해제하지만 schema DTO가 구조화된 Arrow 타입을 문자열로 평탄화한 뒤 frontend와 Rust query가 전체
문자열을 포함 검색한다. 그 결과 `Dictionary(Int8, Utf8)`의 key 타입 `Int8`을 값 타입으로 오인해
문자열 category를 number로 분류한다. 기존 테스트는 단일 row group의 표시·occupancy만 확인해
filter/sort/query 경로 회귀를 발견하지 못했다.

## 목표

- backend가 Arrow `DataType`에서 dictionary의 `value_type`을 구조적으로 재귀 해제하고 schema DTO에
  원래 `logicalType`과 별도의 `valueLogicalType`을 제공한다.
- Rust query validation/result kind와 frontend filter type은 `valueLogicalType`만 사용하고 dictionary
  key/code를 타입 또는 정렬 의미로 사용하지 않는다.
- row group마다 반대 code mapping을 가진 fixture에서도 filter, stable asc/desc sort, distinct, Find,
  query page, copy와 boundary가 실제 decoded value를 기준으로 동작한다.
- dictionary가 감싼 binary/list/struct/map의 full-value 경로도 실제 value를 재귀 처리한다.

## 계약

- `ColumnSchema.logicalType`: 원래 Arrow logical type 표시. 예: `Dictionary(Int8, Utf8)`.
- `ColumnSchema.valueLogicalType`: dictionary wrapper를 재귀 해제한 실제 value type. 비-dictionary는
  `logicalType`과 동일하다.
- dictionary key는 batch/row-group local lookup에만 사용한다. query index, filter, sort, distinct,
  Find, boundary와 copy에 key/code를 저장하거나 비교하지 않는다.
- 기본 categorical 정렬은 decoded value의 native typed order, 양방향 `NULLS LAST`, 동일 값은 source
  row identity tie-breaker다.
- pandas ordered categorical의 사용자 정의 category order는 이번 범위가 아니다. 이를 지원할 때도
  row-group code가 아니라 명시적인 file-wide order metadata를 사용해야 한다.
- wire DTO를 Rust와 TypeScript가 모두 검증하므로 required `valueLogicalType` 조합 parity test를 둔다.

## 소유권

| 담당 | 소유 범위 |
| --- | --- |
| Root Orchestrator | 공통 DTO 계약, `artifacts/phase-19/**`, 명세·개발 계획, 통합·완료 판정 |
| Quality Agent | 구현 전 테스트 설계와 구현 후 독립 검증; 제품 코드 읽기 전용 |
| Rust Data Agent | `src-tauri/src/data/**`, `src-tauri/src/domain/**`, `src-tauri/src/query/**`와 해당 Rust tests |
| Grid UX Agent | `src/query/scalarType.ts`, 관련 frontend unit/component/E2E tests와 필요한 mock fixture |

기존 Phase 18 disk-pressure 변경과 사용자의 다른 작업을 보존하며 되돌리거나 재작성하지 않는다.
공통 DTO 파일은 Root가 먼저 고정하고 Agent는 그 계약을 소비한다.

## 완료 조건

1. 구조화된 Arrow value type이 Rust와 frontend에서 같은 scalar type으로 판정된다.
2. 서로 다른 row-group dictionary code mapping에서도 실제 value 기준 filter/sort/query parity가
   deterministic test로 증명된다.
3. null, empty, duplicate category와 query boundary/copy/distinct/Find 의미가 보존된다.
4. dictionary binary/nested full-value가 non-dictionary 값과 같은 full/preview 계약을 지킨다.
5. 관련 unit/integration, frontend, Rust 전체 suite, format/lint/typecheck/clippy, E2E와 release/NSIS가
   통과한다. UI layout/CSS 변경이 없으면 screenshot·geometry는 적용 제외 근거를 기록한다.
