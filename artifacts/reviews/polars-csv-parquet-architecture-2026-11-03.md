# Polars 0.54.4 CSV → Parquet 구현 조사

2026-11-03. 제품에 고정된 **0.54.4의 로컬 Cargo source**를 조사했다.
제품 코드·의존성·빌드 설정은 수정하지 않았고 새 성능 실험도 실행하지 않았다.
아래 구현 사실과 우리 설계에 대한 제안을 구분한다. 구조를 확인한 것이며, 특정 구조가
4.55초 중 몇 초를 절감했는지는 CPU profile 없이 확정할 수 없다.

## 실제 제품 진입점

`src-tauri/src/data/csv_polars.rs::build_product_sink`는 모든 CSV 입력 열을 String schema로
읽는다. 원문 보존을 위해 missing-is-null=false이며, row ID를 추가하고 `select` 표현식으로
raw/typed/state 열을 만든다. Zstd, row group target 65,536, maintain_order=true로 sink한다.
별도의 Rust 구조·상태 pass는 이 sink 전에 완료해야 한다.

따라서 Polars CSV reader의 native numeric parsing 기능이 존재한다고 해서 우리 제품이
CSV 입력에서 바로 native 숫자를 읽는다고 설명하면 잘못이다. 우리 경로는 문자열 배열 후 cast다.

## 확인한 처리 구조

```text
로컬 mmap / 기타 byte source
 → CSV 레코드 경계에 맞는 LineBatch 생성
 → 여러 CSV decode 작업자
 → 여러 배치에서 select 표현식 평가
 → sink 배치 크기 조정과 순서 관리
 → row group별 encoding task
     → 컬럼별 인코딩·압축 작업
 → 제출 순서의 task handle을 기다리는 I/O writer
 → footer 및 close
```

### CSV 읽기

- `line_batch_source.rs`: CountLines로 레코드 경계를 계산하고, 끝의 미완성 부분은 다음
  배치에 남긴다. 단순 newline split이 아니다. 순서 번호와 row offset을 붙인다.
- `csv/mod.rs`: 배치를 distributor channel로 여러 작업자에게 분배한다. 각 작업자는
  `ChunkReader::read_chunk`로 배열을 만들고 순서 번호를 다음 단계에 전달한다.
- `chunk_reader.rs`: UTF-8 검증, projection, 배열 생성 및 필요한 cast를 수행한다.
- `builder.rs`: 문자열은 `MutableBinaryViewArray`에 넣는다. 예상 capacity를 미리 잡고
  인용부호 해제용 scratch buffer를 clear/reserve하여 재사용한다. 정상 경로에서 매 필드마다
  별도의 소유 String을 만드는 구조가 아니다. 그렇다고 문자열 전체가 zero-copy인 것은 아니다.
- UTF-8 검증에 simdutf8를 사용한다. 레코드 경계 탐색에는 feature-gated SIMD 및 non-SIMD
  경로가 있다. 소스에 SIMD 코드가 있다는 것만으로 이번 바이너리의 해당 feature 활성화를
  주장하지 않는다.

### 값 변환

`select.rs`는 여러 입력·출력 pipeline을 연결하고 각 배치에서 표현식들을 평가한다.
배치마다 다른 작업자가 진행할 수 있다. 한 배치의 모든 selector를 각각 별도 task로
실행한다고 설명해서는 안 된다. 코드상 해당 loop는 표현식을 순서대로 await한다.

우리 제품은 Int64/UInt64/Float64 cast, Boolean token 비교, null/empty/invalid 판정,
state word 식 등을 컬럼 연산으로 구성한다. 같은 파싱 결과를 직접 변환기에서 value/state/raw
작성에 함께 사용하는 방식은 개선 후보지만, Polars optimizer가 중복을 얼마나 제거하는지는
이번 조사에서 검증하지 않았다.

### Parquet 인코딩·압축

`row_group_encoder.rs`는 row group 처리 task를 만들고, 그 안에서 **컬럼별 작업을 병렬화**한다.
컬럼을 Arrow 배열로 만든 뒤 `array_to_columns`로 인코딩하고 `Compressor`로 압축된 page들을
모은다. 파일 쓰기는 이 CPU 작업과 분리돼 있다.

`io_writer.rs`는 task handle을 채널에 들어온 순서대로 await한 후 완성된 압축 row group을
기록한다. 따라서 뒤의 계산이 먼저 끝나도 파일에 쓰는 순서는 유지된다.
footer 완료 후 sync 정책에 따라 close한다.

### 메모리와 작업 수 제한

sink의 `SinkMorsel`은 semaphore permit을 소유한다. 이 permit은 압축 결과의 `EncodedRowGroup`
까지 전달되며, writer가 기록하고 데이터를 해제한 뒤 반환한다. 대기 큐에서 꺼냈다고 즉시
허용량을 돌려주지 않는 점이 핵심이다. encoded 결과 채널도 pipeline 수로 제한한다.

이는 in-flight 배치 수 제한이지 프로세스 전체 byte 단위 hard cap은 아니다. 고정 row count만으로
아주 긴 문자열 입력의 메모리 상한을 보장할 수 없다.

## 우리 구현에 적용할 만한 점

| 우선순위 | 적용 후보 | 이유 |
| --- | --- | --- |
| 1 | 컬럼 버퍼 직접 작성, capacity/scratch 재사용 | 셀별 임시 String/객체와 allocation을 줄인다 |
| 1 | 인코딩·압축과 파일 I/O 분리 | writer가 CPU 작업을 수행하며 앞단을 막는 구조를 피한다 |
| 1 | row group 내부 컬럼 병렬화 | 큰 row group 하나에서도 여러 코어를 사용한다 |
| 1 | 입력부터 압축 결과 해제까지 permit 유지 | 완료 후 대기 결과의 무제한 누적을 막는다 |
| 1 | 순서 있는 task/result 제출 | 원본 row ID 순서를 유지하면서 계산을 병렬화한다 |
| 2 | 제한된 공용 worker pool | stage마다 독립적으로 thread 수를 곱해 oversubscription하지 않는다 |
| 2 | raw/typed/state를 한 변환 판단에서 작성 | 제품 의미를 유지하며 중복 파싱·검사를 줄일 후보 |
| 후순위 | CSV 경계 탐색과 decode 분리·병렬화 | 기존 csv crate가 실제 bottleneck인 경우에만 복잡도를 추가한다 |

우리에게는 배치 수와 함께 byte 예산도 필요하다. 원문 버퍼·변환 배열·압축 결과를 포함해
메모리를 계상하고 긴 field/batch에 대한 기존 상한을 지켜야 한다. 중첩 병렬화는 동일한 worker
예산 안에서 스케줄해야 한다. 전체 Polars executor나 planner를 복제할 필요는 없다.

이전 제안은 배치별 병렬화가 중심이었지만, 소스 조사 후에는 **컬럼별 encoding/compression을
별도 작업으로 분리하고, 끝까지 유지하는 in-flight permit을 함께 설계**하는 것이 더 적절하다.
다만 sequential csv crate부터 시작한다는 제안은 유지한다. 기존 parser 진단은 빠르며,
이번 소스 조사만으로 parser 교체 필요성이 입증되지는 않았다.

## 확인한 소스 위치

Cargo registry 기준 경로:
`.tmp/duckdb-size-tools/cargo-home/registry/src/index.crates.io-1949cf8c6b5b557f/`

- `polars-stream-0.54.4/src/nodes/io_sources/csv/{mod.rs,line_batch_source.rs,chunk_reader.rs}`
- `polars-stream-0.54.4/src/nodes/select.rs`
- `polars-stream-0.54.4/src/nodes/io_sinks/writers/parquet/{mod.rs,row_group_encoder.rs,io_writer.rs}`
- `polars-stream-0.54.4/src/nodes/io_sinks/components/{sink_morsel.rs,morsel_resize_pipeline.rs}`
- `polars-io-0.54.4/src/csv/read/{builder.rs,parser.rs}`
- 제품 연결: `src-tauri/src/data/csv_polars.rs`

이번 조사는 고정 버전 소스의 정적 분석이다. standalone polars-parquet 사용 시의 EXE 크기,
직접 converter 성능, 정확한 stage별 CPU 비율은 아직 측정하지 않았다.
