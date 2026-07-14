# Phase 2 품질 보강

- 보강일: 2026-07-14
- 대상: `T-P2-005`, `T-P2-018`, `T-P2-021`
- 상태: 대상 테스트 PASS, 전체 gate는 Phase 3 통합 후 루트 재실행

## 변경

### T-P2-005 실제 decode·projection 계측

- `ParquetSource`의 실제 `read_page_projected` 경로에 테스트 전용 `DecodeAudit`를 연결했다.
- reader build 시 `with_row_groups`에 전달되는 row group과 projected root column 수를 기록한다.
- reader가 반환한 batch 수, decode 행 수, decode 컬럼 수도 기록한다.
- row group 2의 `label` 한 컬럼만 요청했을 때 선택 row group `[2]`, decode 컬럼 1개,
  decode 행 2개임을 검증한다.
- EOF 요청은 reader build와 decode가 모두 0회임을 검증한다.

### T-P2-018 nested·null canonical 표시

- 실제 Parquet 왕복 fixture에 nested struct와 map을 추가했다.
- list 내부 null, null list, null struct, nested null struct, map value null, null map,
  empty map을 검증한다.
- nested Int64 값은 canonical display 안에서도 문자열로 유지해 JavaScript 정밀도 손실을
  방지하는지 확인한다.

### T-P2-021 metadata 크기 정확성

- fixture를 독립적으로 다시 열어 Parquet footer metadata를 읽는다.
- 각 row group의 `totalByteSize`를 footer의 `total_byte_size`와 정확히 비교한다.
- `compressedSize`를 footer column chunk의 compressed size 합과 정확히 비교한다.
- compression 목록과 statistics 보유 컬럼 수도 footer에서 독립 계산해 DTO와 비교한다.

## 수정 파일

- `src-tauri/src/data/parquet_source.rs`
- `src-tauri/src/data/phase2_tests.rs`

## 검증

| 검증 | 결과 |
| --- | --- |
| `cargo test t_p2_005_actual_reader_decodes_only_selected_row_groups_and_projection` | PASS |
| `cargo test t_p2_011_018_preserves_precision_and_structured_value_displays` | PASS |
| `cargo test t_p2_020_021_exposes_row_group_size_compression_and_statistics_metadata` | PASS |
| `cargo fmt --all -- --check` | PASS |

Phase 2의 전체 Rust 테스트에서 보강 대상은 모두 PASS했다. 전체 실행은 동시 개발 중인 Phase 3
CSV 테스트 `inconsistent_width_is_padded_and_reported` 한 건 때문에 47/48 PASS였고, 전체
clippy도 Phase 3 CSV·공통 `DataSource`의 미완료 경고 때문에 실패했다. 이 항목들은 Phase 2
보강 변경과 무관하며 Phase 3 통합 완료 후 루트가 전체 gate를 재실행한다.
