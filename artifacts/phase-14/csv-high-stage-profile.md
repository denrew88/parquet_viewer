# 5,850,000행 high-cardinality CSV 단계별 측정

## 측정 조건

- 파일: `.tmp/phase13-fixtures/large/csv-5850000-high.csv`
- 크기: 979,427,914 bytes
- 형태: 5,850,000행 × 15열
- SHA-256: `082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd`
- 빌드: Rust `--release`
- 실행: 실제 `QueryService::prepare_csv_session` cold preparation
- 측정일: 2026-07-23
- 표본: 1회 진단 표본

행별 세부 계측을 위해 `Instant` 호출을 추가했으며 추정 wall-time 오버헤드는 1.176초다. 따라서
관측 Ready 시간 59.553초에서 이를 제외한 실제 제품 시간 추정치는 약 58.38초다. 아래 비율은 원시
관측값 기준이다.

## 결과

| 단계 | 시간 | Ready 전체 비율 | 설명 |
| --- | ---: | ---: | --- |
| Parquet batch 압축·쓰기 | 16.505초 | 27.72% | 180개 Arrow batch를 ZSTD level 1 Parquet로 기록 |
| 15열 값 변환 | 15.869초 | 26.65% | 87,750,000개 셀을 normalized/raw/invalid 표현으로 변환 |
| `states.bin` 저장 | 13.804초 | 23.18% | 21.94MB bitmap을 8바이트 단위 반복 write 후 sync |
| provider 미분류 loop 비용 | 6.623초 | 11.12% | 행별 vector 할당·해제, checkpoint/progress, 구조 검사, 계측 오버헤드 포함 |
| persistent publish 및 외부 마무리 | 2.202초 | 3.70% | 약 766.9MB cache 복사, manifest/fingerprint, DuckDB 재개방 포함 |
| Arrow builder append | 2.188초 | 3.67% | normalized/raw/invalid builder에 행 추가 |
| CSV record decode | 1.869초 | 3.14% | `csv` crate의 `ByteRecord` 파싱 및 source read |
| in-memory state bitmap 누적 | 0.339초 | 0.57% | 행별 15개 2-bit 상태 누적 |
| Parquet close | 0.045초 | 0.08% | footer close |
| Parquet fsync | 0.073초 | 0.12% | partial file sync |
| checkpoint 파일 | 0.018초 | 0.03% | `offsets.idx` 저장 및 sync |
| DuckDB view 생성 | 0.013초 | 0.02% | 완성된 Parquet에 `dv_source` view 생성 |
| RecordBatch finish | 0.005초 | 0.01% | Arrow array finish |

- DataSource open: 6.30ms
- header 설정: 1.87ms
- query spec 생성: 0.22ms
- provider 내부 합계: 57.351초
- Ready까지 전체: 59.553초

## parser 기준선

제품 preparation 후 OS cache가 데워진 상태에서 같은 파일을 별도로 측정했다.

- 단순 순차 파일 읽기: 200.69ms, 4,654MiB/s
- `csv` crate 순수 record parsing: 1.487초, 3,933,350 rows/s
- 제품 경로에서 계측된 CSV read/decode: 1.869초

두 parser 측정이 비슷하므로 59초 대기의 주원인은 CSV 문법 parsing이나 디스크 읽기가 아니다.

## 확인된 병목

### 1. `states.bin`이 21.94MB인데 13.80초 걸린다

현재 `CellStateBitmap::write_file`은 15개 컬럼 × 컬럼당 182,813개 word, 총 2,742,195개의
`u64`를 각각 `write_all(8 bytes)`로 호출한다. 작은 write 호출 수가 과도해서 파일 크기에 비해
시간이 비정상적으로 크다. 연속 byte buffer 또는 큰 chunk 단위 `BufWriter`로 바꾸는 것이 가장
명확한 단일 최적화 지점이다.

### 2. 실제 값 하나를 두 문자열로 보존한다

각 셀은 현재 normalized 문자열, raw 문자열, invalid Boolean으로 확장된다. high-cardinality
15열에서는 값 변환 15.87초와 Parquet 압축·쓰기 16.51초가 각각 큰 비중을 차지한다. 물리 typed/raw
cache를 설계대로 분리하거나 동일한 문자열의 중복 materialization을 줄여야 한다.

### 3. cold publish가 cache를 다시 복사한다

생성된 `prepared.parquet`은 744,931,287 bytes, `states.bin`은 21,937,584 bytes다. query temp에
만든 뒤 persistent cache로 다시 `fs::copy`하므로 약 766.9MB를 한 번 더 쓰고 2.20초가 추가된다.
같은 volume에서는 atomic rename 또는 hard link 기반 publish 가능 여부를 검토할 수 있다.

### 4. 진행률 종료 부근의 체감 정지가 크다

5,500,928행 시점은 40.81초였다. row scan pipeline이 끝난 뒤 `states.bin` 저장 13.80초와 publish
2.20초가 이어지므로, 사용자는 행 진행률이 거의 끝난 뒤에도 약 16초를 더 기다리는 것처럼 느낀다.
후처리 stage를 진행 상태에 별도로 표시하지 않는 현재 UI가 체감 지연을 더 크게 만든다.

## 원시 증거

세부 milestone, artifact 크기와 계측 오버헤드는 `csv-high-stage-profile.json`에 기록했다.
