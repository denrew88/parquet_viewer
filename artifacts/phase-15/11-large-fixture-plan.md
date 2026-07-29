# Phase 15 대용량 회귀 fixture 계획

## 생성 계약

Phase 15의 CSV와 Parquet 대용량 fixture는 Phase 13의 `LARGE_SCHEMA`와 생성 수식을
그대로 재사용한다. 행 수는 5,850,000, 열 수는 15이며 low/high cardinality 파일을 각각
CSV와 Parquet로 만든다. Parquet는 65,536행 row group, Zstd level 3, dictionary와 data
page v2를 사용한다.

H5는 논리 shape `(100,000, 2,048)`를 물리 `/oes[2,048, 100,000]`로 전치 저장한다.
`/time`은 int64, `/wavelength`는 int32, `/oes`는 int32이며 Blosc v1 filter 32001,
Zstd level 5, shuffle을 사용한다. chunk는 `(2,048, 128)`이며 decoded 크기는 1MiB이다.
`/oes[w,t] = t*2,048+w`를 golden 수식으로 삼는다.

최종 allowlist는 다음과 같다.

- `fixtures/phase-15/csv-5850000-low.csv`
- `fixtures/phase-15/csv-5850000-high.csv`
- `fixtures/phase-15/boundary-5850000-low.parquet`
- `fixtures/phase-15/boundary-5850000-high.parquet`
- `fixtures/phase-15/oes-v3-100000x2048-int32.oes.h5`
- `fixtures/phase-15/manifest.json`
- `fixtures/phase-15/golden.json`

## 검증 항목

| ID | 검증 | 완료 기준 |
| --- | --- | --- |
| `T-P15-001` | 생성 provenance | seed, generator hash, Python/NumPy/PyArrow/HDF5 버전을 manifest에 기록 |
| `T-P15-002` | 파일 무결성 | 5개 fixture가 존재하고 nonzero이며 manifest SHA-256과 일치 |
| `T-P15-003` | CSV streaming | header 순서, 5,850,000 records, 모든 record 15 fields |
| `T-P15-004` | Parquet metadata | schema fingerprint, 90 row groups, 마지막 17,296행, codec 일치 |
| `T-P15-005` | low cardinality | group/category/label/code가 각각 128/16/256/64종 |
| `T-P15-006` | high cardinality | 대표 표본 unique rate 0.99 이상이며 SplitMix64 수식과 일치 |
| `T-P15-007` | CSV-Parquet parity | 첫/중간/마지막 행의 15열 값이 golden과 일치 |
| `T-P15-008` | H5 구조 | attrs, dtype, rank, shape, filter 32001 계약 일치 |
| `T-P15-009` | H5 자원 상한 | decoded chunk 64MiB 이하, 전체 `/oes` materialization 없음 |
| `T-P15-010` | H5 transpose | 첫/중간/마지막 논리 행과 `/oes[w,t]` golden 일치 |
| `T-P15-011` | 결정성 | 동일 환경 재생성 결과의 payload hash가 동일 |
| `T-P15-012` | 안전한 publish | 공간 부족·예외에서 기존 final 보존, owned partial 정리 |
| `T-P15-013` | 최종 정리 | allowlist 외 `.partial`, `.tmp`, 검증용 복제본이 없음 |

생성 시작 시 여유 공간 12GiB 이상, 완료 후 reserve 5GiB 이상을 hard gate로 둔다. 생성은
bounded batch로 수행하고 final 경로는 완성된 partial만 원자적으로 교체한다. 대형 fixture는
로컬 회귀 시험용이므로 기존 `fixtures/*` ignore 정책을 유지한다.
