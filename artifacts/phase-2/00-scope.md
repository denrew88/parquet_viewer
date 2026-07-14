# Phase 2 Scope

- 상태: 준비
- 작성일: 2026-07-14
- 목표: Parquet를 전체 파일 크기에 비례해 메모리에 올리지 않고 임의 페이지와 컬럼으로 조회한다.

## 포함 범위

- row group metadata로 요청 offset과 겹치는 row group만 decode
- 컬럼 이름 projection과 원래 컬럼 순서 보존
- offset 0, 중간, row group 경계, 마지막, EOF 이후 조회
- Int64/UInt64/decimal/date/timestamp/binary와 list/struct의 정밀도 보존 display DTO
- 최대 200행 page, 최대 64 projection columns
- session별 최대 8 page LRU cache
- 프런트 Prev/Next page, 요청 generation으로 stale response 무시
- row group 행 수와 compression 요약 metadata

## 제외 범위

- CSV
- 행·컬럼 가상화와 임의 scroll 연결
- selection과 clipboard
- filter, sort, SQL

## 계약

- `read_page`는 `offset`, `limit`, optional `columns`를 받는다.
- 결과 `columns`와 각 row 값은 projection 순서와 일치한다.
- offset이 EOF 이상이면 정상 empty page를 반환한다.
- 정밀도 손실 가능 값은 JavaScript number로 보내지 않고 display string을 유지한다.
- decoded row 수는 요청과 겹치는 row group 및 page 상한으로 제한한다.
- cache key는 session, offset, limit, projection이며 최대 8 entry다.
- 프런트는 새 요청 generation과 다른 응답을 화면에 적용하지 않는다.

## 역할

- `rust_data_engineer`: row group paging, projection, value model, metadata, unit/benchmark fixture
- `tauri_platform_engineer`: bounded cache와 command 요청 검증
- `grid_ux_engineer`: paging UI, stale response 방지, 타입 표시
- `quality_gate_reviewer`: 사전 테스트 설계와 독립 검증

## 완료 조건

- 여러 row group의 임의 페이지와 projection이 정확하다.
- 정밀도 손실 없이 지원 타입을 표시한다.
- page/cache/projection에 명시적 상한과 테스트가 있다.
- 빠른 페이지 전환에서 오래된 응답이 현재 page를 덮어쓰지 않는다.

