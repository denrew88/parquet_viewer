# Phase 2 Test Plan

## Fixture

- `F-P2-01`: 14행, row groups `[3,4,2,5]`, `id,label,score`.
- `F-P2-02`: 240행, row groups `[80,80,80]`.
- `F-P2-03`: `c00`~`c64` 65컬럼.
- `F-P2-04`: Int64, UInt64, Decimal128(scale 9), Date32, timestamp ns/timezone, binary, list, struct.
- `F-P2-05`: row groups `[2,3,1]`, compression·statistics metadata.
- `F-P2-06`: offset별 지연·성공·실패를 제어하는 frontend backend.
- `F-P2-07`: native용 240행 다중 타입·row group Parquet.

## Rust·Command

| ID | 검증 | 기대 결과 |
| --- | --- | --- |
| `T-P2-001` | F01 offset 0/3/7/9 | 정확한 시작 row group과 행 |
| `T-P2-002` | offset 2 limit 4 | row group 경계 id 2~5 |
| `T-P2-003` | 모든 경계 전후 | 누락·중복·순서 변경 없음 |
| `T-P2-004` | offset 13/14/99 | 마지막 1행, EOF 빈 page |
| `T-P2-005` | decode instrumentation | 겹치는 row group만 decode, EOF 0회 |
| `T-P2-006` | None, `[label,id]` | 원본 또는 요청 순서 유지 |
| `T-P2-007` | projection+경계 | columns와 row 위치 일치 |
| `T-P2-008` | 빈·중복·미존재 projection | decode 전 InvalidRequest |
| `T-P2-009` | 64/65 projection | 64 성공, 65 거부 |
| `T-P2-010` | limit 1/200/0/201 | 상한 준수 |
| `T-P2-011` | Int64 | MIN/MAX, 2^53 초과 exact string |
| `T-P2-012` | UInt64 | u64 MAX exact string |
| `T-P2-013` | Decimal | precision·scale·trailing zero 보존 |
| `T-P2-014` | Date32 | 음수 epoch·윤일 ISO date |
| `T-P2-015` | Timestamp | ns 9자리·단위·timezone 보존 |
| `T-P2-016` | Binary | Base64·byte length, UTF-8 오인 없음 |
| `T-P2-017` | List | 순서·null·대형 정수 canonical 표시 |
| `T-P2-018` | Struct | 필드 순서·중첩·null canonical 표시 |
| `T-P2-019` | DTO JSON | 정밀도 값이 JSON number가 아님 |
| `T-P2-020` | row group metadata | 행 수 `[2,3,1]` |
| `T-P2-021` | compression/statistics | codec·크기·제공 통계 정확 |
| `T-P2-022` | cache 같은 key | 두 번째 hit, decode 추가 없음 |
| `T-P2-023` | cache key 구성 | offset·limit·projection 순서별 독립 |
| `T-P2-024` | cache 8개 | entry 수 8 이하 |
| `T-P2-025` | LRU 9번째 | least recently used만 축출 |
| `T-P2-026` | close·교체 | session cache 해제 |
| `T-P2-027` | command 왕복 | projection·EOF·상한 유지 |

Rust Data는 T-P2-001~021, Tauri Platform은 T-P2-022~027을 소유한다.

## Frontend·UI

| ID | 검증 | 기대 결과 |
| --- | --- | --- |
| `T-P2-028` | stale 성공 | 최신 generation만 적용 |
| `T-P2-029` | stale 실패 | 현재 page 유지, stale banner 없음 |
| `T-P2-030` | 첫·중간·마지막 | Prev/Next, offset, range 정확 |
| `T-P2-031` | page loading | 기존 grid 유지, layout 안정 |
| `T-P2-032` | adapter type·EOF | 확장 type과 빈 page 검증 |
| `T-P2-033` | 다중 타입 표시 | 정밀도와 구조 표시 정확 |
| `T-P2-034` | Metadata | RG 행 수·compression 표시 |
| `T-P2-035` | Browser 빠른 Next/Prev | stale 방지 |
| `T-P2-036` | Browser page 상태 | 첫·중간·마지막·EOF 정확 |
| `T-P2-037` | DOM 3 viewport | 무겹침·무잘림·정렬 오차 ≤1px |
| `T-P2-038` | loading/populated geometry | workspace 안정, row ≤200 |
| `T-P2-039` | 1440x900 screenshot | populated type page 검토 |
| `T-P2-040` | 1024x768 screenshot | paging·긴 값·metadata 검토 |
| `T-P2-041` | 800x600 screenshot | overflow 없음 |
| `T-P2-042` | native F07 | dialog, Next/Prev IPC, type·metadata |
| `T-P2-043` | native screenshot | Windows WebView 증거 |
| `T-P2-044` | 전체 gate | 모든 자동·UI·native 검증 |

Grid는 T-P2-028~034, Quality는 T-P2-035~041·044, Tauri는 T-P2-042~043을 소유한다.

