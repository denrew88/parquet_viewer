# Phase 3 범위

- 시작일: 2026-07-14
- 목표: 기존 세션·페이지·그리드 계약으로 CSV를 안전하게 열고 원문 문자열을 보존한다.

## 확정 계약

- 형식은 확장자와 내용 검증으로 `csv` 또는 `parquet`를 선택한다.
- CSV delimiter는 이번 단계에서 comma로 고정한다.
- UTF-8과 선두 UTF-8 BOM만 허용한다. UTF-16 BOM과 잘못된 UTF-8은 typed error다.
- 값은 모두 `kind=string`이며 빈 문자열은 null이 아니다. parser가 해석한 quoted comma/newline/escaped quote의 논리 문자열을 그대로 전달한다.
- preview/page 최대 200행, 최대 4,096열, logical record 최대 8 MiB다.
- header mode는 `auto | present | absent`다. 자동 제안과 실제 사용 여부를 metadata에 따로 둔다.
- 자동 header는 첫 record의 필드가 모두 비어 있지 않고 중복이 없으며 후속 preview와 비교해 header 가능성이 있을 때 사용한다. 모호하면 `absent`를 우선한다.
- 빈 파일은 0행·0열이다. 불일치 열 수는 최대 폭으로 schema를 확장하고 짧은 행은 빈 문자열로 채우며 bounded 구조 문제 목록을 남긴다. 값을 조용히 잘라내지 않는다.
- checkpoint는 4,096 logical record 간격, 최대 4,096개다. 상한을 넘으면 간격을 배수로 압축한다.
- CSV summary에는 encoding, delimiter, header mode/suggestion/use, row count 상태, 구조 문제를 포함한다. Parquet row group은 CSV에서 빈 배열이다.
- 파일 열기 실패는 기존 session을 보존하고 성공한 교체·닫기는 worker, checkpoint, cache를 해제한다.

## 구현 소유권

| 역할 | 범위 |
| --- | --- |
| Rust data/platform 주담당 | `src-tauri/src/data/**`, `domain/**`, `commands/**`, `platform/**`, Cargo 계약 |
| Grid UX 협업 | `src/**`, CSV summary/parser, header control, progress·metadata·page UI |
| Quality | fixture, 통합·회귀·native·Browser gate |
| Root | 공통 계약 통합, 문서, 최종 판정 |

## 제외

- 다른 문자 인코딩 변환
- tab/semicolon delimiter 자동 감지
- 데이터 편집과 저장
- CSV 타입 추론 결과로 원문 값을 변경하는 기능

## 완료 조건

- `artifacts/phase-3/10-test-plan.md`의 필수 ID가 PASS하거나 환경 원인이 명시된 BLOCKED다.
- CSV와 기존 Parquet 회귀 테스트가 통과한다.
- 실제 Windows 대화상자로 CSV를 열고 preview, paging, Schema, Metadata를 확인한다.
- Browser 필수 항목은 Browser backend가 없으면 대체하지 않고 BLOCKED로 남긴다.
