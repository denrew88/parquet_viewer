# Phase 15 Polars Rust POC 결과

## 결론

Polars 0.54.4의 최신 스트리밍 CSV→Parquet sink는 채택 후보로 복귀한다. 5,850,000행 fixture에서
8스레드 반복 5회가 모두 출력 정합성과 1.5GiB RSS gate를 통과했고, wall 중앙값은 12.206초,
최악값은 12.938초였다. 기존 Polars 0.51 POC의 약 4.55GB RSS 결과는 구 스트리밍 실행기의
in-memory sink 문제이며 최신 경로의 결과로 일반화하지 않는다.

아직 제품 기본 경로로 연결한 것은 아니다. dialect parity, 취소 응답, 실행 파일·installer 증가량,
dependency audit와 제품 통합 회귀 gate를 통과한 뒤 최종 채택한다. DuckDB query 경로는 그대로 둔다.

## 호환성과 구성

- 기존 제품 toolchain: stable Rust 1.88.0
- POC toolchain: stable Rust 1.97.1을 side-by-side 설치하며 기본 toolchain은 바꾸지 않음
- Polars: 0.54.4, `default-features = false`
- feature: `csv`, `lazy`, `streaming`, `parquet`
- 실행 설정: `LazyCsvReader::with_cache(false)`, `with_low_memory(true)`
- 병렬도: `POLARS_MAX_THREADS`로 명시적으로 제한

Polars 0.52~0.54는 Rust 1.88에서 dependency 내부 컴파일 오류가 발생했다. 0.54.4는 Rust 1.97.1에서
컴파일되므로 제품 채택 시 repository toolchain을 1.97.1로 올리고 전체 Rust gate를 다시 검증해야 한다.

## POC 구조

- 입력: `csv-5850000-high.csv`, 979,427,914 bytes, 5,850,000행×15열
- source pass A: `csv` crate로 2-bit state bitmap 생성
- source pass B: Polars lazy CSV scan과 단일 Parquet streaming sink
- 출력: `__dv_row_id` + typed 열 + 필요한 raw shadow = 28개 물리 열
- state: DVST v1, 21,937,584 bytes
- Parquet: 458,057,378 bytes

## 최신 스트리밍 측정

| 스레드 | 외부 wall | 제품 total | peak RSS | 정합성 |
| ---: | ---: | ---: | ---: | --- |
| 1 | 34.733초 | 33.300초 | 1,097,592,832 B | PASS |
| 2 | 22.457초 | 22.389초 | 1,099,304,960 B | PASS |
| 4 | 16.265초 | 16.215초 | 1,128,165,376 B | PASS |
| 8, 최초 | 8.474초 | 8.449초 | 1,183,932,416 B | PASS |

8스레드 동일 조건 반복 5회 결과는 다음과 같다.

| 실행 | wall | peak RSS |
| ---: | ---: | ---: |
| 1 | 8.474초 | 1.103GiB |
| 2 | 10.478초 | 1.093GiB |
| 3 | 12.500초 | 1.101GiB |
| 4 | 12.938초 | 1.103GiB |
| 5 | 12.206초 | 1.101GiB |

- wall 중앙값: 12.206초
- 관측 최악값: 12.938초
- peak RSS 최악값: 1.103GiB
- 모든 실행에서 5,850,000행, 28개 물리 열, state 5,850,000×15와 출력 hash가 일치함

개별 raw 결과는 `polars-rust-poc-054-t1.json`, `polars-rust-poc-054-t2.json`,
`polars-rust-poc-054-t4.json`, `polars-rust-poc-054-t8*.json`에 저장한다.

## 이전 0.51 결과와 RSS 원인

Polars 0.51 POC는 다음 실행 계획으로 전체 projection을 메모리에 물질화했다.

```text
PREFILL CACHES
polars-stream: running in-memory-sink
polars-stream: running multi-scan[csv]
CACHE SET
EXECUTE PHYS PLAN
```

그래서 `with_cache(false)`를 지정해도 peak RSS가 약 4.55GB였다. Polars 0.53 이후에는 single-file
Parquet sink용 새 스트리밍 pipeline이 추가되었고, 0.54.4 POC는 같은 projection을 약 1.10GiB 안에서
처리했다. 메모리 절감의 핵심은 다음 조합이다.

1. 최신 streaming sink 사용
2. 결과를 `collect()`로 DataFrame에 모으지 않고 file sink로 흘려보내기
3. reader cache 끄기와 low-memory 모드 사용
4. `POLARS_MAX_THREADS`로 병렬도 상한 설정
5. 필요 시 `with_chunk_size`를 낮춰 속도와 RSS를 추가 조정

현재 장비에서는 8스레드도 RSS gate 안에 충분히 들어오며 가장 빨랐다. 다른 장비에서는 논리 CPU
전체를 무조건 쓰지 말고 제품 메모리 budget에 따라 스레드 상한을 계산해야 한다.

## 남은 채택 gate

- low/high/문자열·인용·개행·invalid fixture의 raw/typed/empty/invalid parity
- 진행 중 취소와 1초 이내 terminal 상태, partial 파일 cleanup
- 제품 provider 연결 후 page/filter/sort/copy와 source-read-0 회귀
- feature OFF/ON release EXE와 NSIS 크기 차이
- dependency/license/security audit
- Rust 1.97.1 전환 후 format, clippy, 전체 Rust/frontend/E2E/release/native 검증

이 항목을 통과하기 전에는 optional POC feature로 유지하고 제품 Tauri command나 query DTO에 직접
Polars 타입을 노출하지 않는다.
