# Phase 23 통합 검증

## 구현

- 그리드와 QueryToolbar에 파일 뷰어의 정렬, 타입 필터, Find를 연결했다. 보기는 동일한 SQL 결과 스냅샷에서 계산한다.
- 보기 ID를 페이지, 상세 셀, Find, 내보내기에 전달한다. 새 보기 첫 페이지가 준비될 때까지 기존 보기를 유지한다. 새 SQL 결과가 확정되거나 Clear를 누르면 보기 자원을 정리한다.
- 현재 보기와 전체 결과의 CSV, TSV, Parquet, Windows 클립보드 내보내기를 제공한다. 파일 CSV·TSV는 UTF-8 BOM과 CRLF를 유지한다.
- Query와 출력 사이에 마우스·키보드 분할 경계를 추가했다. 800×600에서도 Find와 내보내기 조작을 확인했다.

## 검증 결과

- 프런트엔드 포맷·린트·타입 PASS. 전체 단위 테스트 841건 PASS.
- 브라우저 회귀 234건 PASS. Phase 23의 세 화면 크기에서 정렬·필터·Find, 내보내기, 높이 조절을 확인했다. [시각 검증](ui/visual-review.md)
- Rust 포맷과 Clippy PASS. 전체 Rust 재검증 404건 PASS, 18건 기존 제외. 초기 실행의 하드링크·CSV 캐시 검사 14건은 제한된 실행에서 Windows 파일 접근 오류로 실패했고, 샌드박스 밖 재검증에서 통과했다.
- 실제 Windows WebView 및 OS 검증 6건 PASS. 원본 탭을 닫은 뒤 460행이 유지됐다. 230행 보기에서 페이지 경계를 넘는 정렬과 Find를 확인했다. 실제 Clipboard와 CSV·TSV·Parquet에는 현재 보기 230행, 전체 CSV에는 원래 순서의 460행이 담겼다. [Windows 검증](native/report.json)
- 검증용 EXE는 `src-tauri/target/release/candidates/phase-23-native/data-viewer.exe`의 0.23.0이며 67,526,144바이트다.

## 정식 반영

2026-11-08에 제품 식별자 `com.denrew88.data-viewer`로 빌드한 0.23.0을 `src-tauri/target/release/data-viewer.exe`에 반영했다. 정식 EXE는 60,955,136바이트다. 기존 0.23.0의 67,525,632바이트에서 6,570,496바이트 줄었으며 0.22.0보다 276,992바이트 크다. 제품 EXE의 내장 버전과 식별자, 교체 전후 SHA-256을 확인했다. [제품 EXE 기록](product-exe.json)

같은 JOIN 결과 180,000행을 내보내는 10개 비교에서 CSV 바이트 또는 Parquet 타입·값·행 순서가 일치했다. Windows 앱 6건은 별도 검증용 식별자의 경량화 빌드로 통과했다. [경량화 검증과 측정 원본](export-optimization/verification.md)

## 타임스탬프 정밀도와 결과 저장 후속 반영

2026-11-08에 CSV 나노초 필터, SQL Results의 `TIMESTAMP_S` 필터, SQL 결과 파일 묶음을 포함한 제품
Release 0.23.0을 정식 EXE 경로에 반영했다. 제품 식별자·버전·Windows WebView 시작을 확인했고,
검증한 후보와 교체 후 정식 EXE의 SHA-256이 일치한다. [제품 EXE 기록](storage-followup/product-exe.json)

같은 커머스 JOIN 124,769행에서 첫 그리드 표시까지 기존 52.0–70.1초, 변경 후 1.09–1.10초였다.
새 후보는 결과 파일 4개를 생성했다. Windows 후보에서 타임스탬프 필터 8건, 정렬 전후 파일 경계 조회,
70,000행 CSV 전체 내보내기, 임시 공간 초과와 취소를 검증했다. Rust 포맷·Clippy는 통과했고,
Rust 전체 테스트 실행은 Windows 앱 제어 오류 4551에 막혔다. [Windows 검증](storage-followup/native-precision-and-storage.json)

## SQL 내보내기 덮어쓰기 후속 반영

2026-11-08에 저장 대화상자에서 승인한 기존 CSV·TSV·Parquet 파일을 교체할 수 있도록 수정하고
제품 Release 0.23.0을 정식 EXE 경로에 반영했다. Windows에서 덮어쓰기 승인·거절, 새 파일 저장,
열린 원본과 닫힌 쿼리 원본 보호를 확인했다. 제품 WebView 시작과 정식 EXE의 SHA-256도 확인했다.
[제품 EXE 기록](export-overwrite/product-exe.json) · [Windows 내보내기 검증](export-overwrite/native-export.json)
