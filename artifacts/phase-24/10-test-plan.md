# Phase 24 검증 계획

| ID | 계층 | 기준 |
| --- | --- | --- |
| T-P24-001 | React, E2E, WebView2 | A/B 탭 생성·전환·닫기, 별도 쿼리와 실행·결과 유지. A만 재실행 시 연결된 카드만 갱신하고 오류·취소·EXPLAIN 시 이전 성공 결과를 보존한다. |
| T-P24-002 | Rust, React, WebView2 | 결과 pin의 공유 및 마지막 소유자 해제, stale 응답과 상한·취소, 파일 세대 교체 후 재연결, SQL 축 이름·타입 변경 및 중복 처리. |
| T-P24-003 | E2E | Sheet 추가·전환·삭제, 기존/새 Sheet로 보내기, 카드 추가·편집·이동·크기 조절과 개별 설정을 검증한다. |
| T-P24-004 | Rust, E2E, WebView2 | 파일 및 SQL의 필터·역정렬·열 재배치 후 페이지 경계를 넘는 블록이 golden 행 순서와 일치하고 재실행 후 유지된다. 초과 및 이전 세대 요청은 원자적으로 실패한다. |
| T-P24-005 | Rust, WebView2 | 6종 계산 golden, NULL·nonfinite·빈 집합·단일 값·그룹 상한·결정적 표본과 64비트 정수·decimal·나노초 기준점을 검증한다. |
| T-P24-006 | E2E, screenshot | 1440×900, 1024×768, 800×600에서 탭·카드·설정·취소 컨트롤을 사용하고 의도된 스크롤 경계를 기준으로 DOM overflow·겹침·잘림과 screenshot을 검토한다. |
| T-P24-007 | WebView2 | 한 Sheet에 파일 scatter, A violin·선택 block box, B line을 배치한다. A 재실행 뒤 violin만 갱신되며 캔버스 렌더와 CSP 오류 유무를 확인한다. |
| T-P24-008 | 성능, Release | 10k/100k/1m Parquet 및 commerce JOIN에서 집계·첫 렌더·취소, IPC·캐시 상한, 회수와 메모리 추세를 측정한다. EXE 크기·버전·SHA-256을 기록한다. |
| T-P24-009 | 회귀 | 프런트엔드 format/lint/typecheck/unit/all E2E, Rust fmt/clippy/test, 대상 Windows Release를 검증한다. |

작은 Parquet fixture는 `fixtures/phase-24/generate.py`에서 생성한다. 실제 Windows
검증과 브라우저 모의 백엔드의 결과를 별도 기록한다. UI 증거는 세 viewport 이미지와
geometry JSON, interaction 및 visual review, 별도 native screenshot 및 결과로 구성한다.
