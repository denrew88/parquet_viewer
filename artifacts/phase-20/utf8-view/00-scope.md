# Phase 20 후속 — Utf8View 문자열 지원

사용자 요청: 캐시 prepared.parquet를 일반 Parquet로 열 때 Unsupported value가 나오는 문제 수정·재빌드.

- 범위: 공통 Arrow 값 변환의 Utf8View scalar/dictionary/nested preview/full-value, Parquet 빈 셀 occupancy.
- 새 의존성·UI 구조·캐시 포맷·writer·압축·앱 버전 변경은 없다. 0.20.0 유지.
- 원래 제품과 현재 native variant에 같은 공통 Rust 수정을 반영한다.
- 입력: fixtures/phase-20/utf8-view.parquet 및 기존 Polars writer 생성 실제 prepared.parquet.

## 검증 계획

| ID | 검사 | 기대 결과 |
| --- | --- | --- |
| P20-VIEW-1 | scalar preview/full value의 Utf8와 Utf8View parity | inline·긴 Unicode·탭/개행·empty·null 일치 |
| P20-VIEW-2 | dictionary Utf8View | 값·empty·값 null·key null 보존 |
| P20-VIEW-3 | nested Utf8View | preview 길이 제한과 full canonical JSON parity |
| P20-VIEW-4 | ArrowWriter → ParquetSource 왕복 | 실제 Utf8View 스키마, page와 full value 정상 |
| P20-VIEW-5 | flat/dictionary occupancy | empty/null 비점유, 공백 포함 일반 문자열 점유 |
| P20-VIEW-6 | 전체 Rust·fmt·all-targets Clippy | 기존 무시 gate 외 실패 없음 |
| P20-VIEW-7 | 실제 재빌드 앱으로 fixture·캐시 직접 열기 | 원문 일치·Unsupported 제거·전체 값 정상·입력 불변 |

제품 동작 확정 뒤 release EXE를 한 번 빌드한다. React 변경이 없어 frontend 전체 suite·세 viewport·installer는 재실행하지 않는다.
사용자의 명시적 교체 지시를 받아 정식 실행 파일·기준 manifest 갱신을 완료했다.
