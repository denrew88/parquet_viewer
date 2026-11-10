# Phase 24 차트 검증 fixture

`node scripts/dev-check.mjs phase24-fixtures`로 검증 입력 전체를 생성한다.

`generate.py`는 `orders.parquet`, `precision.parquet`, `golden.json`을 `.tmp/phase24-fixtures`에 생성한다. `--scale`을 지정하면 10,000·100,000·1,000,000행의 Parquet 입력을 함께 생성한다. 생성된 입력은 PyArrow의 버전 영향을 받으므로 파일 해시를 함께 기록한다.

`orders.parquet`은 월별 320행씩 총 640행을 가진다. 1월과 2월은 같은 그룹·행 수에 서로 다른 금액 분포를 가진다. `month = '2026-01'`에서 `ordinal >= 30` 필터를 적용하고 `ordinal` 역순으로 정렬한다. 첫 211행의 ordinal 범위와 그룹별 건수·중앙값은 생성기의 정수 센트 계산을 기준으로 한다. 211행 선택은 200행 페이지 경계를 넘는다.

`precision.parquet`은 `2^53` 이상의 연속 정수, 매우 큰 decimal의 마이크로 단위 차이, 같은 초의 연속 나노초 timestamp, NULL·NaN·무한대를 포함한다. 차트 좌표의 원점 차감과 제외 행 수를 확인하는 입력이다.
