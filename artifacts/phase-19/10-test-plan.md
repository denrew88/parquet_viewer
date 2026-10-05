# Phase 19 테스트 계획

## 핵심 fixture

`F-P19-A`는 `source_id: Int32`, `category: Dictionary(Int8, Utf8)`와 정확히 두 row group을 갖는다.

| Row group | source_id → decoded value | local dictionary |
| --- | --- | --- |
| RG1 | `0 beta, 1 alpha, 2 "", 3 null, 4 beta, 5 alpha` | `0=beta, 1=alpha, 2=""` |
| RG2 | `6 alpha, 7 gamma, 8 beta, 9 "", 10 null, 11 beta` | `0=alpha, 1=gamma, 2=beta, 3=""` |

fixture audit은 RG별 dictionary와 index를 직접 확인해 code `0`의 의미가 다르고 `beta`가 RG1 code 0,
RG2 code 2인지 증명한다. writer가 dictionary를 전역 통합하면 fixture는 실패다.

## 추적 테스트

| ID | 계층 / 담당 | 시나리오 | 완료 기준 |
| --- | --- | --- | --- |
| `T-P19-001` | Rust unit | recursive Dictionary value type | `Dictionary(Int8, Dictionary(UInt16, Utf8)) → Utf8`; 일반 타입은 동일 |
| `T-P19-002` | Rust unit | signed/unsigned key 8종 | key 폭·부호와 무관하게 decoded value/null/state 동일 |
| `T-P19-003` | Rust+TS unit | scalar type matrix | string→text, numeric→number, decimal/date/time/duration/bool 정확, binary/nested→other |
| `T-P19-004` | Rust unit | 깊은/잘못된 dictionary | panic 없이 bounded typed error |
| `T-P19-005` | Rust serialization+TS parser | required wire field | `logicalType`과 `valueLogicalType` camelCase; 누락/비문자열 거부 |
| `T-P19-006` | Rust+TS regression | CSV/일반 Parquet/OES/mock | 비-dictionary의 `valueLogicalType == logicalType` |
| `T-P19-007` | React unit | Schema 표시 | 원래 `Dictionary(Int8, Utf8)` 표시 유지 |
| `T-P19-008` | Parquet integration | `F-P19-A` audit | 두 row group의 반대 code mapping 정확 |
| `T-P19-009` | Rust domain | query validation | category `text` 허용, `number` 거부 |
| `T-P19-010` | Rust query integration | text filters | equals beta `[0,4,8,11]`; notEquals beta `[1,2,5,6,7,9]`; oneOf alpha/gamma `[1,5,6,7]`; contains mm `[7]`; startsWith al `[1,5,6]`; endsWith ta `[0,4,8,11]`; null/invalid golden 정확 |
| `T-P19-011` | Rust query integration | stable asc | IDs `[2,9,1,5,6,0,4,8,11,7,3,10]` |
| `T-P19-012` | Rust query integration | stable desc | IDs `[7,0,4,8,11,1,5,6,2,9,3,10]`; 양방향 null-last |
| `T-P19-013` | Rust query integration | `Dictionary(Int8, Int64)` | 실제 numeric order `2,10`, 문자열식 `10,2` 금지 |
| `T-P19-014` | Rust query integration | source/query page parity | first/middle/last의 ID/value/null/empty 동일 |
| `T-P19-015` | Rust integration | distinct | `beta×4, alpha×3, ""×2, null×2, gamma×1`; code별 분리 없음 |
| `T-P19-016` | Rust integration | Find | case-insensitive `ALPHA` 3건, sort 후 logical position 정확 |
| `T-P19-017` | Rust integration | source/query boundary | empty/null 전이가 decoded value 기준으로 정확 |
| `T-P19-018` | Rust copy | sorted query copy | asc order와 empty/null state가 serializer 전까지 보존 |
| `T-P19-019` | Rust integration | query index/result kind | index는 source ID만, category kind는 String, code 미노출 |
| `T-P19-020` | Rust value unit | dictionary binary | preview bounded, full은 direct binary full과 동일 |
| `T-P19-021` | Rust value unit | dictionary list/struct/map | full JSON이 direct underlying full과 동일 |
| `T-P19-022` | Rust value unit | nested dictionary recursion | preview/full 모두 underlying 값과 동일 |
| `T-P19-023` | TS unit | frontend semantic field | `valueLogicalType=Utf8`만으로 text; key/physical `Int8` 오염 없음 |
| `T-P19-024` | React component | categorical filter UI | text operator 노출, numeric 비교 미노출, plan `scalarType:text` |
| `T-P19-025` | React unit | Find/plan compatibility | searchable, 이전 number filter는 호환되지 않아 제거 |
| `T-P19-026` | Playwright 3 viewport | filter interaction | text operator 선택·입력·apply와 outgoing plan 정확 |
| `T-P19-027` | native Tauri | 실제 `F-P19-A` | Schema 원형, text filter, asc/desc/null-last backend 결과 정확 |
| `T-P19-028` | Root full gate | 전체 회귀 | Rust/frontend/E2E/native/release/NSIS 통과, Phase 18 회귀 없음 |

## UI 검증 적용

filter operator와 입력 의미가 바뀌므로 component test, 세 viewport Playwright interaction과 실제 Tauri
IPC smoke를 적용한다. markup/CSS/layout 변경이 없으면 신규 screenshot·geometry는 적용 제외한다.
최종 diff에 markup 또는 CSS가 포함되면 제외를 취소한다.

## 판정

- 실행 가능한 `T-P19-001`~`028`의 FAIL이 없어야 한다.
- 외부 대용량 fixture가 필요하지 않은 작은 deterministic `F-P19-A`는 BLOCKED로 넘길 수 없다.
- ordered categorical metadata는 비범위이며 decoded native value order를 기대값으로 고정한다.
