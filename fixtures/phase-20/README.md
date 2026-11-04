# Phase 20 fixtures

Phase 20 전용 입력의 기준 위치다. artifacts에는 결과·manifest를 보관한다.

- timestamp.csv 및 timestamp.README.md: 합성 Timestamp 16행. 원문 정밀도·빈 값·null·시간대 offset 사례.
- storage-decimal.csv: id 1~3인 작은 CSV. 실제 앱의 0.3GiB 설정·새 session 조회에 사용한다.
- performance/{long-utf8,low-cardinality,numeric,wide-65}/: 기존 성능 비교 입력 source.csv와 profile.json.
  대용량 CSV는 Git 제외이며 profile과 파일별 크기·SHA-256은 보존한다. 기존 자료를 옮겼으며 다시 생성하지 않았다.
- performance/main-high/high-5850000x15.csv: **5,850,000행, 979,427,914 bytes**. 대응 profile.json도 같은 폴더에 있다.

이동 전후 경로·해시는 ../../artifacts/phase-20/35-fixtures.json을 따른다.
5.85M main-high도 기존 experiment 폴더에서 이곳으로 이동했다. CSV와 profile을 포함해 전용 입력은 총 13개다.
과거 Phase의 다른 fixture는 기존 fixtures/phase-N 경로를 유지한다. experiment 경로를 공용 fixture의 정식 위치로 취급하지 않는다.
Rust 테스트용 생성 mirror와 개별 실행의 hardlink는 원본 fixture의 별도 정식 위치가 아니다.

- utf8-view.parquet: Utf8View 문자열 6행. 짧은 문자열·긴 Unicode·empty·null·개행/탭·공백을 포함하며 일반 Parquet 읽기 회귀에 사용한다.
