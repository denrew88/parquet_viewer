# Timestamp 수동 확인용 CSV

`timestamp.csv`: 헤더 포함, 데이터 16행 × 5열. 생성된 합성 데이터다.

- `timestamp_local`, `timestamp_utc`, `timestamp_offset` 세 컬럼은 Auto에서 Timestamp가 예상된다.
- 소수 초 0/3/6/9자리, 공백 구분자, 윤일, 연도 경계, 1970년 이전, 음수·30분·45분 offset을 포함한다.
- 각 행의 UTC와 offset 컬럼은 같은 순간을 나타낸다. local 컬럼에는 시간대가 없으므로 UTC와 같다고 가정하면 안 된다.
- 12행 소수 초 `.000000001`, 13행 `.120000000`의 원문 정밀도를 확인한다.
- 14행은 Empty, 15~16행은 Null이 예상된다.
- 잘못된 Timestamp를 섞으면 Auto가 Text로 추론하므로 이 파일에는 정상 값과 빈 값·null만 넣었다.

이 파일 생성 시 CSV 구조와 정상 13행의 UTC/offset 동일 순간을 Python 정수 나노초 계산으로 확인했다. 앱을 실행한 수동 검증 결과를 뜻하지는 않는다.
