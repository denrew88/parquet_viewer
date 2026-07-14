# Phase 1 Scope

- 상태: 준비
- 작성일: 2026-07-14
- 목표: 작은 Parquet 파일을 네이티브 대화상자에서 열어 요약, 스키마, 첫 페이지를 표시한다.

## 포함 범위

- 읽기 전용 파일 세션과 한 개의 활성 세션
- 타입이 명확한 `DataError`, 파일·스키마·페이지 DTO
- 확장자와 실제 Parquet magic/footer 검증
- 파일 크기, 행 수, 컬럼 수, row group 수, Arrow 스키마 읽기
- 최대 200행의 첫 페이지와 전체 컬럼 반환
- 네이티브 파일 선택 취소를 정상 흐름으로 처리
- Data, Schema, Metadata의 loading, populated, error 상태
- 존재하지 않는 경로, 지원하지 않는 형식, 잘린 Parquet 오류

## 제외 범위

- 임의 row group paging과 projection 최적화
- CSV
- OS drag and drop과 파일 연결
- 행·컬럼 가상화
- Excel 방식 선택과 clipboard

## 계약 초안

- `select_data_file() -> Result<Option<FileSummary>, DataError>`
- `open_data_file(path) -> Result<FileSummary, DataError>`
- `read_page(session_id, offset, limit, columns) -> Result<DataPage, DataError>`
- `close_data_file(session_id) -> Result<(), DataError>`
- 페이지 limit은 `1..=200`, offset은 0 이상이다.
- 새 세션은 완전히 열린 뒤 기존 세션을 교체한다.
- 정밀도가 필요한 값은 문자열 또는 타입이 포함된 값 DTO로 반환한다.

## 역할과 소유권

| 역할 | 책임 | 소유 경로 |
| --- | --- | --- |
| `rust_data_engineer` | Parquet source, DTO, 오류, fixture, unit test | `src-tauri/src/data/**`, `src-tauri/src/domain/**` |
| `tauri_platform_engineer` | session state, dialog, command, capability | `src-tauri/src/commands/**`, `src-tauri/src/platform/**` |
| `grid_ux_engineer` | backend adapter, Data/Schema/Metadata 상태와 표 | `src/**` |
| `quality_gate_reviewer` | 테스트 설계, fixture·인수·UI 독립 검증 | 제품 코드 읽기 전용 |

공유 manifest, lockfile, `src-tauri/src/lib.rs`, 공통 IPC 계약은 루트가 통합한다.

## 완료 조건

- 작은 primitive/null Parquet fixture를 실제 대화상자와 경로 command로 열 수 있다.
- 파일 요약, 스키마, 첫 200행 이하 페이지가 정확하다.
- 취소는 기존 화면을 유지하고 오류를 만들지 않는다.
- 손상·미존재·지원하지 않는 파일은 panic이나 blank screen 없이 오류를 표시한다.
- 핵심 Parquet 로직은 Tauri 없이 Rust unit test에서 검증된다.
- 적용되는 자동, Browser, geometry, screenshot, native smoke 검증이 기록된다.

