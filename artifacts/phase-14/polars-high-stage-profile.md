# Polars+NumPy 5,850,000행 high CSV 비교 측정

## 조건

- 입력: `.tmp/phase13-fixtures/large/csv-5850000-high.csv`
- 크기: 979,427,914 bytes
- 형태: 5,850,000행 × 15열
- Python 3.11.14, Polars 1.39.3, NumPy 1.26.4
- Polars thread pool: 8 threads
- ZSTD level 1, row group 65,536행
- Windows file cache가 데워졌을 수 있는 상태

두 경로를 측정했다.

1. **Viewer 동등 경로:** 원본 15열을 문자열로 한 번 읽고 source row ID와 각 열의
   normalized/raw/invalid를 포함한 46열 Parquet, 2-bit state bitmap, checkpoint, fsync,
   persistent cache 복사, 전체 checksum과 manifest까지 수행한다.
2. **일반 typed streaming:** 15개 실제 타입만 streaming CSV→Parquet로 기록한다. raw shadow,
   bitmap, checkpoint, persistent copy는 만들지 않는다.

## 최종 재현 표본

| 단계 | 시간 | 평균 사용 core |
| --- | ---: | ---: |
| Polars 원본 15열 문자열 parsing | 0.671초 | 6.68 |
| NumPy 2-bit bitmap 구성 | 0.906초 | 1.14 |
| bitmap 21.94MB write+fsync | 0.016초 | 1.01 |
| NumPy checkpoint byte scan | 1.141초 | 0.99 |
| checkpoint write+fsync | 0.001초 | 0.00 |
| Polars 46열 변환+ZSTD Parquet | 4.182초 | 6.59 |
| Parquet fsync | 0.110초 | 0.00 |
| persistent cache copy+fsync | 0.458초 | 0.65 |
| persistent artifact SHA-256 | 0.625초 | 1.00 |
| manifest write+fsync | 0.002초 | 0.00 |
| **Viewer 동등 경로 합계** | **8.110초** | — |
| 일반 15열 typed streaming+fsync | **2.175초** | 약 5.3 |

첫 번째 성공 표본은 동등 경로 8.362초, typed streaming 1.942초였다. 최종 표본과 동등 경로
편차가 약 3%이므로 큰 병목의 순서는 재현됐다.

## Rust 현재 경로와 비교

| 구간 | Rust 현재 경로 | Polars+NumPy | 배수 |
| --- | ---: | ---: | ---: |
| 전체 동등 preparation | 59.553초 | 8.110초 | **7.34×** |
| 계측 오버헤드 보정 Rust 대비 | 58.377초 | 8.110초 | **7.20×** |
| CSV parsing | 1.869초 | 0.671초 | **2.79×** |
| 값 변환+Arrow append+Parquet | 34.563초 | 4.182초 | **8.27×** |
| bitmap 구성+저장 | 14.143초 | 0.921초 | **15.35×** |
| bitmap 저장만 | 13.804초 | 0.016초 | **약 889×** |
| persistent 복사+checksum+manifest | 약 2.202초 | 1.085초 | **2.03×** |

일반 typed streaming 2.175초는 Viewer의 raw/state 계약을 수행하지 않으므로 직접적인 동등 비교는
아니다. 현재 전체 59.553초와 단순 비교하면 약 27.4배 차이다.

## 산출물과 검증

- Polars 동등 `prepared.parquet`: 566,694,661 bytes
- Rust 동등 `prepared.parquet`: 744,931,287 bytes
- `states.bin`: 21,937,584 bytes
- `offsets.idx`: 22,880 bytes
- Polars 일반 typed Parquet: 312,664,768 bytes
- Polars 동등 persistent payload: 588,655,125 bytes

자동 감사에서 다음을 확인했다.

- expanded Parquet 5,850,000행 × 46열
- typed Parquet 5,850,000행 × 15열
- state header/shape/byte length
- checkpoint header/count/마지막 행/실제 source byte 범위

감사 결과는 `PASS`다.

## 중요한 제약

Viewer 동등 Polars 경로의 peak RSS는 약 3.23GB였다. 먼저 15열 raw string DataFrame 전체를
메모리에 올렸기 때문에 Phase 14의 1.5GiB 제한을 약 2배 넘는다. 따라서 **8.11초 구현을 그대로
제품에 넣을 수 있다는 뜻은 아니다.** 속도 우위의 일부는 bounded-memory 대신 큰 메모리를 사용해서
얻었다.

또한 Polars는 CSV record의 원본 byte offset을 공개하지 않으므로 checkpoint는 이 fixture에 quoted
newline이 없다는 사실을 이용해 NumPy로 파일을 두 번째 scan했다. 실제 generic CSV에서는 parser와
offset 수집을 통합하거나 별도 quote-aware indexer가 필요하다.

그럼에도 다음 결론은 분명하다.

- 현재 46열 scalar 변환·Parquet writer는 Polars 병렬 pipeline보다 약 8배 느리다.
- bitmap 파일의 274만 회 8-byte write는 즉시 제거해야 할 독립적인 구현 결함이다.
- bounded-memory Polars/Arrow batch pipeline을 별도로 설계하면 8.11초와 현재 59초 사이에서 상당한
  개선 여지가 있다.
