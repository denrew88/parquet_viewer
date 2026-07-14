# Phase 3 CSV Test Plan (Draft)

- 작성일: 2026-07-14
- 기준: `PROJECT_SPEC` 4·6·7·8·11절, `DEVELOPMENT_PLAN` Phase 3, `UI_VALIDATION`
- 상태: 아래 미확정 계약을 Root가 승인한 뒤 `10-test-plan.md`로 승격
- 불변 조건: CSV 셀은 타입 추론과 무관하게 파싱된 논리 문자열을 `kind=string`으로 반환한다. 빈 문자열은 null이 아니다.

## 제안 상한

명세에 수치가 없으므로 구현 전 확정한다. 테스트는 공개 상수를 참조한다.

| 항목 | 제안값 |
| --- | ---: |
| preview/page | 200 records |
| 컬럼 | 4,096 |
| logical record | 8 MiB |
| checkpoint 초기 간격 | 4,096 records |
| checkpoint 수 | 4,096 (초과 시 간격을 배수로 희소화) |

## Fixture

| ID | 내용 |
| --- | --- |
| `F-P3-01` | UTF-8, 명확한 header `name,age,city`, 5행 |
| `F-P3-02` | header 없이 첫 행부터 데이터, 5행 |
| `F-P3-03` | UTF-8 BOM, 한글 header/값, 데이터 내부 U+FEFF |
| `F-P3-04` | quoted comma, quoted LF/CRLF, escaped quote |
| `F-P3-05` | 0 byte, 빈 줄 전용, `a,b,c\r\n1,,\r\n2,x,\r\n` |
| `F-P3-06` | invalid UTF-8, UTF-16LE/BE BOM |
| `F-P3-07` | record 상한-1/상한/상한+1 byte |
| `F-P3-08` | 1/상한/상한+1 컬럼, 마지막 빈 컬럼 포함 |
| `F-P3-09` | header 대비 짧은/긴 record가 여러 위치에 존재 |
| `F-P3-10` | 20,000 logical records, 결정적 `row_id`, 마지막 partial page |
| `F-P3-11` | checkpoint 한도를 넘는 생성형 대형 CSV, row checksum |
| `F-P3-12` | 진행·cancel·오류를 barrier로 제어하는 느린 Reader/worker double |
| `F-P3-13` | header/data가 모호한 preview |
| `F-P3-14` | 빈·중복·공백·한글·매우 긴 header |
| `F-P3-15` | native용 BOM CSV 450행, multiline/empty last column 포함 |
| `F-P3-16` | frontend adapter: preview→진행→완료, cancel, stale 결과 순서 제어 |

Fixture는 binary write 생성 스크립트와 기대 JSON을 함께 둔다. 줄바꿈과 invalid byte를 text-mode로 정규화하지 않는다.

## Rust 데이터 소스

| ID | Fixture/경계 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P3-001` | F01 auto open | preview 즉시 반환, `format=csv`, header 제안/사용 상태·3컬럼 정확 | Rust Data |
| `T-P3-002` | F02 no-header | `absent` 확정 시 첫 record 유실 없음 | Rust Data |
| `T-P3-003` | F03 BOM | 시작 BOM만 제거, 한글 정확, 중간 U+FEFF 보존, encoding=`utf-8-bom` | Rust Data |
| `T-P3-004` | F04 quoted comma | comma가 포함된 단일 논리 셀 반환 | Rust Data |
| `T-P3-005` | F04 quoted LF/CRLF | physical line이 아닌 logical record로 paging, 셀 내부 개행 보존 | Rust Data |
| `T-P3-006` | F04 escaped quote | escape를 한 번 해석해 논리 quote 반환 | Rust Data |
| `T-P3-007` | F05 empty file/lines | panic 없이 합의된 0행 정책의 정상 summary/page | Rust Data |
| `T-P3-008` | F05 empty fields | `kind=string, display=""`, null과 구분 | Rust Data |
| `T-P3-009` | F05/F08 last empty column | 끝 delimiter 뒤 빈 셀과 행 너비 보존 | Rust Data |
| `T-P3-010` | F06 invalid UTF-8 | 대체문자 없이 `InvalidEncoding`, 안전한 byte offset 제공 | Rust Data |
| `T-P3-011` | F06 UTF-16 BOM | `UnsupportedEncoding`, 깨진 UTF-8로 노출하지 않음 | Rust Data |
| `T-P3-012` | F07 record cap | 상한 이하는 정확, +1은 `CsvLimitExceeded`, 오류에 record 원문 미포함 | Rust Data |
| `T-P3-013` | F08 column cap | 상한 성공, +1은 preview/index 모두 같은 제한 오류, 부분 행 미반환 | Rust Data |
| `T-P3-014` | F09 inconsistent width | row, expected/actual을 bounded 구조 문제로 기록; 값 truncate 금지 | Rust Data |
| `T-P3-015` | F01/F02 header override | auto/present/absent 전환마다 schema·offset·count 일관, 셀 문자열 불변 | Rust Data |
| `T-P3-016` | F13 ambiguous header | auto는 suggestion이며 명시적 override가 항상 우선 | Rust Data |
| `T-P3-017` | F14 header identity | 유일한 column id, raw header와 문제를 metadata에 보존 | Rust Data |
| `T-P3-018` | F01/F04 inference | 추론 전후 모든 `DataValue.display`가 동일 | Rust Data |
| `T-P3-019` | F10 preview-first | count/index 완료 전에 ≤200행, status=`calculating` 반환 | Rust Data |
| `T-P3-020` | F10 count/progress | header 정책 반영한 정확한 count, progress 단조 증가, terminal 100% | Rust Data |
| `T-P3-021` | F10 checkpoint -1/0/+1 | 정확한 row_id, 누락·중복 없음, 가장 가까운 이전 checkpoint에서 재개 | Rust Data |
| `T-P3-022` | F10 last/EOF | partial 마지막 page 정확, EOF 이상은 columns 유지한 빈 page | Rust Data |
| `T-P3-023` | F11 checkpoint cap | entry≤상한, 희소화 후 전역 접근, 메모리가 파일 크기에 비례하지 않음 | Rust Data |
| `T-P3-024` | F12 cancel | bounded time 내 `cancelled`, preview와 안전한 checkpoint만 유지 | Rust Data |
| `T-P3-025` | F12 cancel/complete race | terminal 상태 하나만 commit, panic/이중 commit 없음 | Rust Data |
| `T-P3-026` | F12 source drop | worker 종료, file handle/index 메모리 해제 | Rust Data |
| `T-P3-027` | F04/F10 projection | 요청 순서와 문자열/개행/빈 값 보존, 기존 projection 제한 동일 적용 | Rust Data |

## Session·Command·DTO

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P3-028` | CSV open/read/close | Parquet와 같은 command/page/error envelope | Tauri Platform |
| `T-P3-029` | DTO JSON | csv, nullable count/status, metadata가 camelCase이고 TS validator와 일치 | Platform + Grid |
| `T-P3-030` | progress payload | session id+generation 포함, 다른 session에 전달 안 됨 | Tauri Platform |
| `T-P3-031` | close 중 worker | cancel 후 늦은 progress/complete 폐기, 이후 `SessionNotFound` | Tauri Platform |
| `T-P3-032` | CSV→Parquet 교체 | 이전 worker/cache/index 해제, 새 session을 덮지 않음 | Tauri Platform |
| `T-P3-033` | CSV→CSV 교체 | 이전 generation의 늦은 성공/실패 모두 무시 | Tauri Platform |
| `T-P3-034` | background parse failure | preview 유지 가능, status=`failed`, UI 응답 유지 | Tauri Platform |
| `T-P3-035` | header 변경 command | unknown/non-CSV 거부; 성공 시 새 generation과 원자적 summary/page | Tauri Platform |
| `T-P3-036` | page cache | header mode/index generation이 key에 반영되고 변경 시 무효화 | Tauri Platform |
| `T-P3-037` | 오류 계약 | `InvalidCsv/InvalidEncoding/UnsupportedEncoding/CsvLimitExceeded` 구조화 | Tauri Platform |

## Frontend·공통 UI

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P3-038` | adapter validation | 정상 CSV DTO 수락, 누락·모순 응답은 `InvalidResponse` | Grid |
| `T-P3-039` | preview→progress | grid 즉시 사용, status/Metadata만 갱신, layout 불변 | Grid |
| `T-P3-040` | cancel control | 계산 중에만 활성, pending/terminal 구분, preview 유지 | Grid |
| `T-P3-041` | stale progress/success/error | 현재 session+generation 외 결과가 UI를 변경하지 않음 | Grid |
| `T-P3-042` | header suggestion/override | suggestion과 used 상태 구분; 변경 결과를 원자적으로 교체 | Grid |
| `T-P3-043` | CSV 값 표시 | 한글/comma/개행/quote/빈 문자열/마지막 빈 열 정확 | Grid |
| `T-P3-044` | 구조 문제 Metadata | 문제 수·첫 row·expected/actual 표시, 목록은 bounded | Grid |
| `T-P3-045` | count 중/완료 paging | 허용 범위와 첫/중간/마지막/EOF 버튼 상태 일관 | Grid |
| `T-P3-046` | encoding/limit/index 오류 | 사용자 메시지와 retry/open 제공, 기존 유효 session 정책 준수 | Grid |

## 통합·Browser·Native 증거

| ID | 검증 | 기대 결과/증거 | 담당 |
| --- | --- | --- | --- |
| `T-P3-047` | F01~F14 golden | 실제 Rust parser와 독립 기대 JSON의 값/count 일치 | Quality |
| `T-P3-048` | Browser CSV mock | open, header 전환, progress/cancel, Metadata 실제 click 기록 | Quality |
| `T-P3-049` | Browser stale | 역전된 progress/success/error 후 최신 상태만 DOM에 존재 | Quality |
| `T-P3-050` | DOM 3 viewport | 1440x900/1024x768/800x600 무겹침·무잘림, header/cell ≤1px | Quality |
| `T-P3-051` | screenshots | 세 viewport populated/Metadata와 필요시 progress/error 이미지 직접 검토 | Quality |
| `T-P3-052` | native dialog F15 | 실제 Windows dialog CSV 선택, preview/paging/metadata IPC | Tauri Platform |
| `T-P3-053` | native F03/F06 | BOM 성공, invalid encoding 사용자 오류 | Tauri Platform |
| `T-P3-054` | native progress/cancel | UI 응답, cancel, close/reopen 뒤 stale 없음 | Tauri Platform |
| `T-P3-055` | native screenshot | `ui/native-desktop.png`, `ui/native-smoke.md`에 입력/결과 기록 | Tauri Platform |
| `T-P3-056` | 전체 gate | Rust fmt/clippy/test, frontend format/lint/typecheck/test/build, Tauri build, Parquet 회귀 | Quality |
| `T-P3-057` | evidence gate | Browser/geometry/screenshots/native가 존재하거나 구체 원인의 `BLOCKED`; 누락을 PASS 금지 | Quality + Root |

## API·DTO 계약 제안

현재 필수 `rowCount: u64`로는 계산 중을 표현할 수 없다.

```text
DataFormat = Parquet | Csv
FileSummary {
  ...existing,
  rowCount: u64 | null,
  rowCountStatus: RowCountStatus,
  csvMetadata: CsvMetadata | null,
  rowGroups: RowGroupSummary[] // CSV는 []
}
RowCountStatus {
  state: calculating | complete | cancelled | failed,
  rowsScanned, bytesScanned, totalBytes, generation,
  message: string | null
}
CsvMetadata {
  delimiter, encoding,
  headerMode: auto | present | absent,
  suggestedHeader: boolean | null,
  headerUsed,
  structureIssueCount,
  structureIssues // bounded preview
}
```

- CSV 계산 중 `DataPage.totalRows`도 nullable이어야 하며 `hasMore` 또는 `knownRowsThrough`가 필요하다.
- `open_data_file(path, csvOptions?)`: 기본 `headerMode=auto`, preview 반환 후 background generation 시작.
- `configure_csv(sessionId, headerMode)`: generation 증가, cache/index/count 원자적 재시작.
- `get_data_file_status(sessionId)`: polling. event 사용 시에도 `sessionId+generation` 필수.
- `cancel_data_file_task(sessionId, generation)`: 현재 generation만 취소, 멱등.
- 제안 오류: `InvalidCsv`, `InvalidEncoding`, `UnsupportedEncoding`, `CsvLimitExceeded`, `TaskCancelled`.

## 명세상 불명확점

1. Header 자동 판정 알고리즘/confidence와 auto의 초기 `headerUsed` 기본값.
2. Header override가 같은 session의 generation 변경인지 새 session인지. 이 초안은 전자를 제안.
3. 0 byte와 빈 줄을 0행·0컬럼으로 볼지, 빈 문자열 record로 볼지.
4. 불일치 컬럼을 pad/확장할지 오류로 중단할지. silent truncate는 금지해야 함.
5. 빈·중복 header의 raw label과 projection용 unique id 분리 정책.
6. “원문 보존”이 source lexical quoting인지 파싱된 논리 문자열인지. 초안은 후자이며 내부 CRLF는 보존.
7. delimiter를 comma 고정할지 tab/semicolon 감지·사용자 설정까지 포함할지.
8. count 미확정 중 Next/임의 offset 허용 범위와 마지막 page 판단 방식.
9. cancel 후 재시작 command와 기존 checkpoint 재사용 여부.
10. record/column/checkpoint 상한 제안값의 제품 계약 확정.

## 완료 조건 추적

| 조건 | 필수 ID |
| --- | --- |
| preview 우선 | 001, 019, 039, 052 |
| count 중 UI 응답·취소 | 020, 024~026, 030~033, 040~041, 054 |
| 값 보존 | 004~009, 018, 027, 043, 047 |
| bounded random access | 012~013, 021~023, 036 |
| encoding 안전성 | 003, 010~011, 037, 053 |
| UI/native 증거 | 048~057 |
