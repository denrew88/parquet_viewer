# Phase 22 SQL 편집기, 실행계획 및 결과 내보내기

2026-11-07. 이번 후속 변경의 범위는 SQL 편집기, 실행계획, 보관된 결과의 내보내기다.

- HAVING에서 범위에 맞는 컬럼을 추천한다. 열린 후보는 Enter나 Tab으로 적용하고 Shift+Enter는 줄바꿈한다.
- Ctrl+Enter는 커서가 속한 문장만 실행한다. 리터럴과 주석 속 세미콜론을 구분하며 마지막 문장의 세미콜론 직후에도 그 문장을 실행한다.
- 실행계획의 트리와 상세 영역은 각각 스크롤한다. Analyze는 가장 오래 걸린 연산자와 실측 시간, 측정된 연산자 시간 합계 대비 비중을 표시한다.
- Results의 CSV, TSV, Parquet 및 Clipboard 내보내기는 보관된 결과 전체를 사용한다. 파일 내보내기는 저장 대화상자에서 선택한 새 파일에 작성한다. Parquet는 0행에서도 타입을 보존하며, 클립보드는 복사 한도 내에서 헤더를 포함한 TSV를 쓴다.

## 검증

- 프런트엔드 832건, Rust 401건 통과. Rust의 기존 제외 항목은 18건이다. Rust Clippy와 프런트엔드 포맷, 린트, 타입 검사도 통과했다.
- 브라우저 전체 실행에서 223/225건이 통과했다. 마지막 세미콜론 뒤 실행 동작을 보완한 뒤, 기존 실패 두 건과 커서 경계 검증을 세 화면 크기에서 다시 실행해 9/9건이 통과했다.
- Windows 검증용 EXE에서 7/7건이 통과했다. 실제 OS 클립보드 복사, 저장 취소, CSV·TSV의 한글과 CRLF, Parquet 재열기와 타입 확인을 포함한다. [실행 기록](native/sql-editor-export.json) · [Analyze 화면](native/native-sql-analyze.png) · [내보내기 화면](native/native-sql-export-menu.png)

## ordered_at 확인

`fixtures/phase-22/commerce/orders.csv`의 100만 행으로 확인했다. 실제 캐시 Parquet의 물리 타입은 문자열이며, SQL은 컬럼을 `TIMESTAMP_NS`로 변환해 비교한다. 실제 주문 시각으로 엄격한 부등호와 등호를 포함한 부등호의 행 수를 비교했으며 원본 CSV와 일치했다.

2024년 7월 범위 집계는 모든 경로에서 29,898행을 반환했다. 예열 뒤 5회 반복의 DuckDB 실행 시간 중앙값은 현재 앱 캐시 63.80ms, 같은 단일 컬럼의 문자열 CAST 61.29ms, 물리 타임스탬프 21.51ms였다. 물리 타임스탬프에서는 범위 필터가 Parquet 스캔에 직접 적용됐다. [원본 측정값](native/ordered-at-benchmark.json)

## 정식 반영

사용자 승인 후 제품 식별자 `com.denrew88.data-viewer`로 빌드했다. `src-tauri/target/release/data-viewer.exe`의 내장 버전은 0.22.0이며, 최종 크기는 60,677,632바이트로 이전보다 186,880바이트 늘었다. 교체 전후에 제품 후보와 정식 경로의 SHA-256 일치를 확인했다. 동일한 제품 후보 파일은 정식 경로로 이동했다. Windows 동작 검증 기록에는 별도 앱 식별자를 가진 검증용 바이너리의 해시를 보존한다. [실행 파일 기록](sql-editor-export-exe.json)

## 2026-11-08 후속 반영

HAVING 추천에 같은 SELECT에서 `AS`로 선언한 고유 출력 별칭을 추가했다. CSV와 TSV는 Excel이 UTF-8을 감지하도록 헤더 앞에 BOM을 기록한다.

SQL 화면 단위 테스트 283건, 세 화면 크기의 브라우저 테스트 3건, Windows 검증 7건을 통과했다. 실제 앱에서 `HAVING cn`으로 `cnt`를 적용하고, 저장한 CSV와 TSV의 BOM 바이트와 한글을 확인했다. [Windows 검증 기록](native/sql-editor-alias-bom.json)

제품용 0.22.0을 정식 경로에 반영했다. 실행 파일 크기는 60,678,144바이트로 이전보다 512바이트 늘었으며, 제품 후보와 정식 경로의 SHA-256 일치를 확인했다. [최신 실행 파일 기록](sql-editor-alias-bom-exe.json)
