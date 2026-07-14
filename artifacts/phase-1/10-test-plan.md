# Phase 1 Test Plan

## Fixture

- `F-P1-01 primitive-null.parquet`: Int32, nullable Utf8/Float64/Boolean 4컬럼, 4행, 2 row groups.
- `F-P1-02 page-cap.parquet`: Int32 `id` 205행.
- `F-P1-03 replacement.parquet`: 다른 스키마의 정상 교체 파일.
- `F-P1-04 invalid`: text `.parquet`, 정상 Parquet `.txt`, magic 손상, footer 절단, 미존재 경로.
- `F-P1-05 long-display.parquet`: 긴 컬럼명과 긴 문자열.
- 정상 fixture는 Rust `ArrowWriter`로 결정적으로 생성한다.

오류 code는 `FileNotFound`, `UnsupportedFormat`, `InvalidParquet`, `InvalidRequest`,
`SessionNotFound`, `Io`를 사용하고 비어 있지 않은 사용자 message를 포함한다.

## 테스트 목록

| ID | 계층·조건 | 입력 | 기대 결과 | 담당 | Native |
| --- | --- | --- | --- | --- | --- |
| `T-P1-001` | Rust 정상 요약·스키마 | F01 | 이름·실제 크기·4행·4컬럼·2 row groups·타입·nullable 일치 | Rust | 아니오 |
| `T-P1-002` | Rust 첫 페이지 | F01, 0/200 | 4행·4컬럼 모든 값과 순서 일치 | Rust | 아니오 |
| `T-P1-003` | Rust 값 모델 | F01 | null과 빈 문자열 구분, primitive type tag 유지 | Rust | 아니오 |
| `T-P1-004` | Rust limit table | F02, 0/1/200/201 | 1·200 성공, 0·201 InvalidRequest, 최대 200행 | Rust | 아니오 |
| `T-P1-005` | Rust 확장자/magic | F01/F04 | 정상 `.parquet`만 성공, `.txt` UnsupportedFormat, fake InvalidParquet | Rust | 아니오 |
| `T-P1-006` | Rust 손상 입력 | F04 | 미존재·footer·magic별 typed error, panic·부분 세션 없음 | Rust | 아니오 |
| `T-P1-007` | Rust 교체 실패 | F01→F04 | 기존 세션과 페이지 유지 | Rust | 아니오 |
| `T-P1-008` | Rust 교체 성공·close | F01→F03 | 이전 ID 무효, close 뒤 handle 해제 | Rust | 아니오 |
| `T-P1-009` | DTO/error 직렬화 | F01/F04 | camelCase, 안정 code, type tag, message 일치 | Rust | 아니오 |
| `T-P1-010` | command 왕복 | F01 | open/read/close와 session ID 일치 | Tauri | 아니오 |
| `T-P1-011` | command 요청 검증 | 음수 offset, 초과 limit, bad session | InvalidRequest 또는 SessionNotFound | Tauri | 아니오 |
| `T-P1-012` | dialog 취소 unit | `None` | Ok(None), open 미호출, 세션 불변 | Tauri | 아니오 |
| `T-P1-013` | dialog 선택 unit | F01 | 공통 open 경로를 거쳐 summary 반환 | Tauri | 아니오 |
| `T-P1-014` | React open 상태 | mock F01 | loading 뒤 Data 표 4행·4컬럼·null 표시 | Grid | 아니오 |
| `T-P1-015` | React Schema·Metadata | mock F01 | 타입/nullability와 요약 값 표시 | Grid | 아니오 |
| `T-P1-016` | React cancel | mock null | empty/기존 화면 유지, 오류 없음 | Grid | 아니오 |
| `T-P1-017` | React typed error | 미존재·unsupported·corrupt | 사용자 메시지, shell 계속 조작 가능 | Grid | 아니오 |
| `T-P1-018` | adapter DTO 검증 | malformed JSON | 명확한 UI 오류, 잘못된 응답 거부 | Grid | 아니오 |
| `T-P1-019` | Browser open·tabs | mock F01 | 실제 click과 상태 전환, 세 화면 값 일치 | Quality | 아니오 |
| `T-P1-020` | Browser cancel·복구 | cancel/F04/F01 | 상태 보존, 오류 뒤 정상 재시도 | Quality | 아니오 |
| `T-P1-021` | Browser focus·keyboard | populated | Open focus, 탭 화살표, ARIA 연결 정확 | Quality | 아니오 |
| `T-P1-022` | DOM geometry 3 viewport | F01/F05 | 무겹침·무overflow, header/cell 오차 ≤1px, 행 ≤200 | Quality | 아니오 |
| `T-P1-023` | screenshot 시각 검토 | F01/F05/error | 1440x900·1024x768·800x600과 보조 상태 검토 | Quality | 아니오 |
| `T-P1-024` | 실제 dialog 취소 | empty/populated | 오류 없이 화면 보존 | Tauri | 예 |
| `T-P1-025` | 실제 dialog 정상 | F01 | Data·Schema·Metadata 정확 | Tauri | 예 |
| `T-P1-026` | 실제 dialog 손상 | F04 | 오류 표시, blank/crash 없음, 재시도 가능 | Tauri | 예 |
| `T-P1-027` | native screenshot | F01 | `native-desktop.png`, 환경·결과 기록 | Tauri | 예 |
| `T-P1-028` | 전체 품질 gate | 전체 | Rust·frontend·Tauri build 모두 통과 | Quality/Root | 예 |

## 완료 조건 추적

- 실제 dialog/path 열기: T-P1-010, T-P1-013, T-P1-025
- 요약·스키마·첫 페이지: T-P1-001~004, T-P1-014~015
- 취소 상태 보존: T-P1-012, T-P1-016, T-P1-020, T-P1-024
- 오류와 형식 검증: T-P1-005~006, T-P1-011, T-P1-017~018, T-P1-026
- Tauri 없는 핵심 로직: T-P1-001~009
- UI·native 증거: T-P1-019~028

