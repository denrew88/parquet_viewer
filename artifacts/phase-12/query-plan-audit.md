# Phase 12 query plan 및 성능 감사

- 판정: **PASS**
- 실행일: 2026-07-21
- 원시 근거: `benchmark-results.json`, `query-plan-audit.json`
- fixture: low/high cardinality 5,850,000행 × 15열 Parquet
- 실행 방식: release child process, case별 cold 5회·warm-up·warm 5회, 총 80회

## 핵심 구조 판정

- 결과 index는 `__dv_row_id` 한 열만 저장한다.
- logical result position은 물리 행 위치로 해석하며 별도 `row_number()` position 열을 만들지 않는다.
- page 조회는 정렬 index에서 최대 200개 identity를 먼저 제한한다.
- identity lock을 놓은 뒤 요청 projection만 source-native sparse read한다.
- page projection은 최대 64열이며 source decode 동안 query mutex를 잡지 않는다.
- 모든 80회 plan/counter에서 unbounded source join, limit 전 source decode, frontend value batch IPC는 0이었다.
- Parquet 필터·정렬은 native logical type을 유지한다. 필터 parameter도 `cast_to_type`으로 source 타입에
  맞춰 2^53을 넘는 int64가 `DOUBLE`로 뭉개지지 않는다.

## 측정 결과

| 시나리오 | cold p95 | warm p95 | 예산 |
| --- | ---: | ---: | ---: |
| low `group_id ASC` index | 1,039.7 ms | 940.7 ms | 1,500 ms |
| high `group_id ASC` index | 1,064.3 ms | 1,041.8 ms | 2,000 ms |
| low selective filter + 3-sort | 1,513.3 ms | 1,509.8 ms | 2,500 ms |
| high selective filter + 3-sort | 1,685.2 ms | 1,765.4 ms | 2,500 ms |
| low nonselective filter + 3-sort | 2,734.4 ms | 2,660.9 ms | 4,000 ms |
| high nonselective filter + 3-sort | 2,499.0 ms | 2,598.1 ms | 4,000 ms |

준비된 random page p95는 low 6.9 ms, high 96.3 ms로 각각 250 ms와 1,000 ms 예산 안이다.
최대 working set은 640,712,704 bytes로 1.5 GiB 한도보다 낮았고, query temp high-water는 owner
marker 10 bytes뿐이었다.

## 결론

IDX/PAGE/PERF 계약과 low/high cardinality 정확성 oracle을 모두 통과했다. 정렬 뒤 PageUp/Down,
Ctrl/Ctrl+Alt navigation과 copy는 같은 query snapshot의 logical position을 사용하며 native smoke에서
첫 행, 986,803번째 행과 마지막 행 identity까지 일치했다.
