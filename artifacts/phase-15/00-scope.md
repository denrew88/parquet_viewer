# Phase 15 실행 범위

- 실행 상태: **진행 중**
- 시작일: 2026-07-23

## 1. 목적

Phase 15는 Phase 14 기능을 다시 만드는 단계가 아니다. 실제 5,850,000행×15열
high-cardinality CSV의 cold preparation을 계측해 확인한 병목을 제거하고, Polars Rust가 제품의
CSV 준비 엔진으로 적합한지를 bounded-memory 제품 조건에서 검증한 뒤 채택 여부를 결정한다.

현재 Rust 제품 경로의 관측 시간은 59.553초이며 행별 계측 오버헤드를 뺀 추정치는 58.377초다.
같은 의미를 모사한 Python Polars+NumPy 비교 경로는 8.110초였지만 peak RSS가 약 3.23GB이므로
그 구현을 그대로 제품에 넣을 수 없다.

## 2. 확인된 원인

| 원인 | 현재 측정 | 판단 |
| --- | ---: | --- |
| 셀 값 변환 | 15.869초 | scalar 문자열 변환과 행별 할당을 columnar 병렬식으로 교체할 후보 |
| Parquet batch 압축·쓰기 | 16.505초 | 46열 확장과 단일 writer 경로를 compact schema·병렬 sink로 재설계 |
| `states.bin` 저장 | 13.804초 | 2,742,195회의 8-byte write를 하는 명백한 구현 결함 |
| cache publish | 2.202초 | 약 767MB를 query temp에서 persistent cache로 다시 복사 |
| CSV record decode | 1.869초 | 전체 병목의 주원인이 아니므로 parser 교체만으로는 해결되지 않음 |

## 3. 포함 범위

- 비트맵 연속·buffered write와 checksum/fsync 유지
- persistent cache 디렉터리에 직접 `.partial` artifact를 쓰고 manifest를 마지막에 atomic publish
- 자동 타입 추론의 시점, 보수적 판정, invalid 처리와 profile regeneration 계약
- raw·typed·state 중복을 줄인 partitioned prepared cache
- 준비 중 committed frontier와 Ready 이후 DuckDB view
- Polars Rust minimal-feature POC와 현재 Rust 개선 경로의 동일 fixture 비교
- 시간, source/cache byte, RSS, CPU, 취소, fault, lifecycle, EXE·NSIS 증가량 계측
- Phase 14 미충족 cold 5회, page p95, byte audit, frontier, full copy와 native 회귀

## 4. 비범위

- DuckDB filter/sort/query 엔진 교체
- Polars를 UI query engine이나 일반 DataFrame API로 노출
- CSV 외 Parquet/H5 source의 데이터 경로 변경
- 모든 애매한 값을 날짜·시간으로 공격적으로 추론
- 사용자에게 매번 CSV 타입 확인을 요구하는 흐름
- raw 데이터 의미를 display 문자열로 대체
- POC gate를 통과하기 전 제품 runtime dependency 추가

## 5. 의사결정 원칙

1. 의존성 없이 고칠 수 있는 비트맵 write와 cache publish부터 고친다.
2. Polars POC는 실제 제품 계약과 같은 raw/state/parity를 수행해야 하며 단순 typed CSV→Parquet
   benchmark만으로 채택하지 않는다.
3. 8.110초 비교 결과보다 느리더라도 15초 median, 1.5GiB RSS와 취소 계약을 함께 만족하면
   채택 후보가 된다.
4. Polars가 실패하면 개선된 기존 Rust 경로를 유지한다. 기술 스택 변경을 위해 정확성이나 메모리
   상한을 낮추지 않는다.
5. 제품 통합 전 executable/installer 크기, clean build 시간, 라이선스와 중복 Arrow/Parquet
   의존성을 측정하고 사용자 승인을 받는다.

## 6. 사용자에게 보이는 계약

- 파일을 열면 preview는 500ms 안에 우선 표시한다.
- 기본 `Auto`는 표본으로 타입을 결정하고 확인창 없이 preparation을 시작한다.
- 애매한 열은 `Text`로 두며 상태 영역에 비차단형 `CSV types` 진입점만 제공할 수 있다.
- full scan 중 뒤늦게 변환할 수 없는 비어 있지 않은 값은 열 타입을 몰래 바꾸지 않고 `invalid`로
  보존한다. 원문은 raw 보기·복사에서 손실 없이 사용할 수 있다.
- 준비 진행률은 `구조 검사`, `변환·cache 작성`, `검증·게시` 단계를 구분한다.
- 준비 실패·취소 시 원본은 변경하지 않고 partial artifact를 제거하며 direct preview는 유지한다.

## 7. 선행 승인

사용자는 2026-07-23 Phase 15 계획을 확인한 뒤 구현 진행을 명시적으로 승인했다. 이 승인은 optional
Polars Rust POC dependency 추가와 측정을 포함한다. 제품 기본 feature 채택 여부는 POC gate와 같은
commit의 feature OFF/ON binary 비교 결과를 근거로 판정하며, 다른 보안 권한 확대나 외부 배포까지
승인한 것은 아니다.
