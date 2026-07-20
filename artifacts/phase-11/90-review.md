# Phase 11 최종 검토

- 검토일: 2026-07-20
- 제품 구현 판정: 통과
- Phase 전체 완료 판정: 아래의 성능 및 외부 검증 조건이 남아 있어 보류

## 독립 검토에서 발견한 문제와 조치

1. 이전에 요청한 전체 셀 값 응답이 더 나중에 연 Inspector를 덮어쓰거나, 이미 닫은
   Inspector를 다시 열 수 있었습니다. 결과 식별자와 생명주기에 연결된 Inspector 요청
   세대 번호로 수정했으며, A→B 전환과 응답 전 닫기 경쟁 상황을 각각 테스트합니다.
2. Query 경계 탐색 SQL이 길이가 0인 binary 값을 빈 문자열처럼 처리했습니다. 빈 문자열
   규칙은 string 값에만 적용하고, 그 밖의 타입은 null이 아니면 값이 있는 것으로 처리하도록
   수정했습니다. 실제 Parquet binary query 회귀 테스트도 추가했습니다.
3. 처음에는 전체 행 수를 알 수 없는 CSV에서 선택 위치는 갱신됐지만 분할 스크롤 geometry는
   갱신되지 않았습니다. 확정된 행 수 힌트를 유지하고 새 segment로 직접 스크롤하며, 목표
   위치만 읽는 탐색 주기에는 인접 page 미리 읽기를 생략하도록 수정했습니다. 단위 테스트와
   네이티브 25만 행 CSV 테스트를 통과했습니다.
4. 일반 값의 원본 표준 문자열을 확인할 수 없었습니다. 이제 Inspector에서 Source를
   Display, Copy value, 시간·CSV 원시 metadata와 구분하여 표시합니다.
5. 필수 DOM geometry 증거가 없었습니다. 이제 `ui/geometry-results.json`에 Playwright로
   측정한 마지막 행과 grid, 설정 대화상자의 정확한 사각형 좌표를 기록합니다.

`chrono`와 `chrono-tz`는 실행 파일에 정적으로 컴파일되는 순수 Rust crate입니다. 별도의
네이티브 runtime DLL이나 외부 timezone database를 추가하지 않습니다. Arrow와 Parquet는
두 세대의 Arrow가 함께 포함되지 않도록 DuckDB가 사용하는 58.3.0 세대로 통일했습니다.

## 남아 있는 보류 조건

- QRY-006은 고유값이 많은 생성 fixture, 3개 column의 stable/nulls-last 정렬, 최대 RSS,
  준비된 random page의 p95 측정 증거가 더 필요합니다. 고유값이 적은 585만 행 데이터의
  정확성 및 정렬 테스트는 통과했지만 이를 QRY-006의 대체 증거로 간주하지 않습니다.
- 실제 Excel clipboard 왕복, Windows 150% DPI 화면 검증, 초기 상태 PC에서의 NSIS 설치
  검증은 해당 외부 환경에서 수행해야 합니다.

현재 알려진 심각도 높음 제품 결함은 없습니다. 위 필수 증거를 확보하기 전까지 Phase 상태는
완료로 바꾸지 않고 보류로 유지합니다.
