# Phase 13 Rust 대용량 검증 보고서

- 실행일: 2026-07-22 (Asia/Seoul)
- 환경: Windows 10.0.26200, Rust `release`
- 범위: Phase 13 대용량 fixture를 제품 `DataSource`와 `QueryService` 경로에서 직접 열어 page, filter/sort, boundary, prepared CSV, copy, cancel, resource cleanup을 검증
- 종합 상태: **PARTIAL** — 이번에 실행한 핵심 경로는 PASS이며, `10-test-plan.md`의 미측정 전체 gate는 각 JSON에 `BLOCKED`로 남겼다.

## 생성한 실행 증거

- `rust-large-parquet.json`: low/high Parquet raw 측정
- `rust-large-csv.json`: prepared CSV와 direct page raw 측정
- `boundary-performance.json`: boundary 계약 형식의 측정 결과
- `csv-prepared-performance-baseline.json`: direct CSV page baseline
- `csv-prepared-candidate-comparison.json`: direct page와 DuckDB on-disk prepared 비교
- `csv-prepared-performance.json`: CSVPERF gate별 측정/미측정 상태

모든 JSON은 `fixture-manifest.json`의 fixture ID와 SHA-256을 포함한다. 이번 harness가 측정하지 않은 값은 추정하지 않고 `null` 또는 `BLOCKED`로 기록했다.

## Parquet 585만 행

실행 명령:

```powershell
cargo test --release --lib query::phase13_large_tests::phase13_release_large_parquet_product_paths -- --ignored --exact --nocapture --test-threads=1
```

결과: PASS, test body 2.85초.

| Fixture | filtered rows | filter+3-sort | page latency | boundary cold | boundary warm p95 |
| --- | ---: | ---: | --- | ---: | ---: |
| low | 2,925,000 | 1,063.414ms | 5.509~7.360ms | 9.905ms | 0.0105ms |
| high | 2,925,000 | 1,674.976ms | 5.049~6.107ms | 9.997ms | 0.0096ms |

검증한 page offset은 0, 986,803, 마지막 200행이며 `active=true`, `row_id desc`, `group_id asc`, `category asc` 결과의 source row ID를 독립 수식으로 확인했다. nullable `optional_value`의 예상 Ctrl+Down target은 두 fixture 모두 logical row 60이며 cold/warm 모두 일치했다.

빈 값 전이가 없는 `category` 열은 Parquet row-group 통계가 source 전체의 occupied 상태를 증명하는 경우 query의 필터·정렬 순서와 무관하게 결과 마지막 행으로 바로 이동한다. 두 fixture 모두 target 2,924,999가 일치했고 cold 측정은 각각 0.0027ms, 0.0024ms였다. 통계로 증명할 수 없는 열은 최대 65,536개 query row ID만 단계적으로 읽고 source provider에서 boolean occupancy만 복원하며 `DataValue` 문자열은 만들지 않는다.

## CSV 585만 행 prepared 경로

최종 실행 명령:

```powershell
cargo test --release --lib query::phase13_large_tests::phase13_release_large_csv_prepared_product_paths -- --ignored --exact --nocapture --test-threads=1
```

결과: PASS, test body 153.47초.

- low CSV prepare: 151,500.236ms, 38,613.8 rows/s, 정확히 5,850,000행
- prepared page p95: 7.648ms
- 64,000행 × 1열 연속 copy p95: 104.757ms, p95 기준 610,940 rows/s
- filtered + 3-sort query: 658.434ms, 2,925,000행
- source boundary: target 96, 4.390ms
- filtered/sorted query boundary: target 60, 23.649ms
- high CSV prepare cancel: 307.885ms로 terminal `cancelled`
- sampled peak RSS: 676,880,384 bytes (1.5GiB cap 이내)
- temp high-water: 459,288,586 bytes
- cleanup: active query 0, process temp가 owner marker baseline 10 bytes로 복귀
- handle: 132 → 134, 허용한 background/runtime 변동 +2 이내

## Direct CSV page baseline

실행 명령:

```powershell
cargo test --release --lib query::phase13_large_tests::phase13_release_large_csv_direct_page_baseline -- --ignored --exact --nocapture --test-threads=1
```

결과: PASS, test body 2.13초.

| Offset | direct latency | prepared latency |
| ---: | ---: | ---: |
| 0 | 1.054ms | 7.648ms |
| 986,803 | 330.470ms | 5.435ms |
| 5,849,800 | 1,783.437ms | 4.703ms |

세 표본의 recorded p95 비교에서 prepared page는 direct page보다 233.18배 빨랐다. 첫 page는 준비 비용이 없는 direct 경로가 더 빠르며, 멀리 이동할수록 prepared random access의 이점이 커진다.

## 실행 중 발견하고 수정한 제품 버그

1. prepared page/copy가 연속 row 범위도 수만 개 ID의 `IN (...)` SQL로 만들고 있었다. provider에 contiguous range 계약을 추가하고 `__dv_row_id >= ? AND __dv_row_id < ? ORDER BY __dv_row_id` 파라미터 경로로 변경했다. query copy도 source row ID가 연속 오름차순일 때 이 경로를 재사용한다.
2. 숫자형 CSV 빈 필드가 prepared artifact에서 복원될 때 `Empty` 상태를 잃었다. normalized 값이 빈 문자열이면 논리 타입과 무관하게 `DataValue::empty`로 복원하도록 수정하고 회귀 테스트를 추가했다.
3. Windows에서 prepared artifact page 연결을 read-write로 유지한 채 query가 같은 파일을 `ATTACH READ_ONLY`하면 자기 프로세스 파일 잠금으로 실패했다. prepare writer 종료 뒤 artifact 연결을 read-only로 다시 열도록 변경하고 실제 prepared sort/query integration을 추가했다.

## 아직 완료하지 않은 gate

이번 결과로 모든 Phase 13 성능 gate가 완료된 것은 아니다. 특히 long-invalid 전체 prepare, prepare 중 foreground 20-page, query plan 20회 변경, 전체 585만행 copy와 다중열/copy cancel, 100-cycle prepared soak, long-string/no-boundary boundary cancel, Native Tauri와 NSIS installed release는 미측정이다. 상세 상태는 `csv-prepared-performance.json`과 `boundary-performance.json`에 `BLOCKED`로 기록했다.
