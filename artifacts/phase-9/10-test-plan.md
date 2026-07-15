# Phase 9 테스트 계획

- 상태: 구현 전 기준선 확정
- 작성일: 2026-07-15
- 범위 기준: `00-scope.md`
- 판정 소유자: `quality_gate_reviewer`, 최종 판정은 루트 Orchestrator

## 1. 목적과 판정 규칙

이 계획은 Phase 9의 완료 조건을 구현 전에 고정한다. 구현 Agent는 소유 모듈의 unit test를
코드와 함께 작성하고, Quality Agent는 contract fixture, E2E, 성능, soak와 독립 UI 검증을
소유한다. 테스트를 실행하지 못하면 PASS로 추정하지 않고 이유와 잔여 위험을 `90-review.md`에
`BLOCKED`로 기록한다.

각 테스트 결과는 다음 중 하나다.

- `PASS`: 명시한 입력, 기대 결과와 증거가 모두 확인됨
- `FAIL`: 재현 가능한 제품 또는 테스트 결함이 있음
- `BLOCKED`: 필수 환경이나 승인 부재로 실행할 수 없음
- `N/A`: 구현체 결정으로 적용되지 않으며 설계 기록에 제외 근거가 있음

HIGH 또는 MEDIUM 결함, 필수 테스트 FAIL, 필수 native/UI 테스트 BLOCKED가 있으면 Phase 9를
완료 처리하지 않는다.

## 2. 요구사항 추적표

| ID | 요구사항 | 주 테스트군 |
| --- | --- | --- |
| P9-FMT | registry와 공통 source 계약으로 입력 포맷을 확장 | FMT |
| P9-CPY | preset/custom 규칙에 따른 clipboard 복사 | CPY |
| P9-CSV | CSV 기본 열기 모드, 타입 profile, bulk edit, preview와 검증 | CSV |
| P9-QRY | 전체 결과 대상 filter, search, stable multi-sort | QRY |
| P9-LIFE | document/session/query/task 세대 격리와 취소 | LIFE |
| P9-TMP | bounded memory, spill, 임시 파일 정리와 crash recovery | TMP |
| P9-UX | 세 viewport, keyboard, focus, geometry와 native 동작 | UI |
| P9-PERF | 1,000만 행 저·고카디널리티 데이터의 bounded 실행 | PERF |

## 3. Fixture와 생성 규칙

큰 fixture는 저장소에 commit하지 않고 결정적인 generator와 manifest만 보존한다. manifest에는
generator version, seed, 논리 schema, row count, row-group 크기, cardinality, 실제 byte size,
compression/encoding, SHA-256을 기록한다.

| Fixture | 내용 | 사용처 |
| --- | --- | --- |
| `fixtures/phase-9/format-contract.csv` | null, 빈 문자열, 앞자리 0과 정밀도 경계 문자열이 있는 작은 CSV | FMT-003~005 |
| `fixtures/phase-9/format-contract.parquet` | Int64/UInt64/Decimal/Timestamp/null/nested 정밀도 경계가 있는 작은 Parquet | FMT-003~005 |
| `fixtures/phase-9/valid-zero-row.parquet` | 정상 footer와 schema가 있고 row만 0개인 유효 Parquet | FMT-004 |
| `fixtures/phase-9/zero-byte.parquet` | 0 byte라서 유효한 빈 테이블이 아닌 손상 Parquet | FMT-004/006 |
| in-memory `registry_stub` | `cfg(test)` 전용 최소 tabular handler이며 실제 `.dvtest` 파일은 만들지 않음 | FMT-008A/008B |
| `profile-ambiguous.csv` | 앞자리 0 ID, 큰 정수, decimal, 여러 date 형식 | CSV |
| `profile-invalid.csv` | 각 타입별 변환 실패와 null token, 빈 문자열 | CSV |
| `profile-wide.csv` | 256개 컬럼, 반복·혼합 타입 | CSV bulk/UI |
| `quoted.csv` | comma, CRLF, quote, quoted newline, Unicode | CPY/CSV |
| `query-small.csv/parquet` | 동일 논리 데이터와 원본 row identity | QRY |
| `query-low-10m.parquet` | 1,000만 행 x 10열 저카디널리티 반복 데이터 | PERF |
| `query-high-10m.parquet` | 1,000만 행 x 10열 고카디널리티 데이터 | PERF |
| `query-10m.csv` | 같은 핵심 schema의 대용량 CSV | PERF/CSV |
| `spill-sort.parquet` | 작은 memory budget에서 강제로 spill되는 데이터 | TMP |
| `corrupt-*` | 잘린 Parquet footer, 잘못된 CSV quote, Parquet magic 불일치와 format별 손상 입력 | FMT/CSV |

저·고카디널리티 Parquet는 Phase 8 fixture를 재사용하되 manifest가 현재 schema와 checksum을
만족하는지 매 실행 전에 감사한다. 대용량 CSV는 별도 disk budget을 확인한 뒤 생성하고, 테스트
종료 후 fixture 정책에 따라 명시적으로 정리한다.

## 4. 입력 포맷과 registry 테스트

| ID | 계층 | 시나리오와 기대 결과 | 담당 |
| --- | --- | --- | --- |
| FMT-001 | Rust unit | descriptor의 id, 표시 이름, 확장자, MIME, capability가 중복 없이 등록된다. | Rust Data |
| FMT-002 | Rust unit | 확장자 대소문자와 Unicode/공백 경로가 같은 handler로 resolve된다. | Rust Data |
| FMT-003 | Rust contract | CSV와 Parquet가 같은 summary/schema/page/projection 계약을 통과한다. | Rust Data |
| FMT-004 | Rust contract | 유효한 zero-row CSV/Parquet는 정상 empty page를 반환한다. `valid-zero-row.parquet`와 달리 0-byte Parquet는 손상 typed error가 되며, 마지막 page, EOF 이후 offset과 없는 projection 컬럼도 계약대로 처리된다. | Rust Data |
| FMT-005 | Rust contract | CSV는 앞자리 0, 큰 정수와 decimal 원문을 raw string 그대로 byte 단위 보존한다. Parquet는 Int64/UInt64/Decimal/Timestamp/null/nested display 정밀도가 기존 golden과 byte 단위로 같다. | Quality |
| FMT-006 | Rust integration | Parquet는 확장자/magic 불일치와 잘린 footer를 구별된 typed error로 반환한다. signature가 없는 CSV는 잘못된 quote/UTF-8/구조 오류를 CSV typed error로 반환하며 어느 입력도 panic하지 않는다. | Quality |
| FMT-007 | IPC | supported-format 응답과 backend open 가능 목록이 일치하고 오래된 frontend 상수에 의존하지 않는다. | Platform |
| FMT-008A | 9A Architecture | in-memory test handler를 registry에만 추가해 source open, DocumentRegistry open/page/close, DTO 직렬화와 grid의 generic metadata/page 표시를 통과한다. DocumentRegistry와 grid/selection 핵심 파일에 format별 분기를 추가하지 않는다. | Quality |
| FMT-008B | 9D Architecture | 같은 test handler가 engine-neutral provider adapter와 query executor contract를 통과하며 query executor 핵심 파일에 format별 분기를 추가하지 않는다. 9A 완료 gate에는 포함하지 않고 9D engine gate에서 필수로 판정한다. | Quality |
| FMT-009 | Frontend | capability가 없는 명령은 숨겨지고 전용 renderer가 없는 format은 generic metadata fallback을 사용한다. | Grid UX |
| FMT-010A | 9A Integration | registry descriptor JSON, `supported_formats` IPC, backend open resolver, native dialog filter builder와 frontend drop 안내 모델의 확장자 목록이 자동 snapshot에서 일치한다. | Platform/Quality |
| FMT-010B | Native deferred | 실제 Tauri native dialog filter와 OS drop 안내가 FMT-010A 목록과 일치한다. 9A 자동 gate와 분리하되 Phase 9 최종 native gate 전에는 필수 PASS이며 정적 file association 차이는 별도 표시한다. | Platform |
| FMT-011 | Regression | 기존 CSV header 변경, Parquet row-group metadata와 다중 문서 open/close 동작이 유지된다. | Quality |

FMT-008A/B는 runtime plugin을 검증하는 테스트가 아니다. compile-time handler 확장 시 핵심 계층의
포맷 분기가 늘지 않는다는 구조 테스트다. FMT-008A의 정적 guard는 source registry 밖의
`DocumentRegistry`, grid와 selection allowlist에 새 `formatId` 비교나 CSV/Parquet match가 없는지
검사한다. FMT-008B는 query contract가 생기는 9D에 같은 검사를 query executor까지 확장한다.
FMT-010A가 PASS여도 OS가 그리는 실제 picker와 WebView drop 동작을 증명하지 않으므로
FMT-010B를 대신하지 않는다.

## 5. Clipboard 설정 테스트

| ID | 계층 | 시나리오와 기대 결과 | 담당 |
| --- | --- | --- | --- |
| CPY-001 | TS unit | Excel/TSV/CSV/Custom preset이 확정 기본값으로 직렬화된다. | Grid UX |
| CPY-002 | TS unit | comma, tab, semicolon, pipe와 custom Unicode 한 문자를 처리하고 CR/LF delimiter는 거부한다. | Grid UX |
| CPY-003 | TS unit | minimal/always와 doubled quote/backslash escape 조합을 round-trip한다. no-quote는 delimiter, CR, LF 또는 quote가 없는 field/header만 허용하고, 하나라도 포함하면 preview/export를 typed validation error로 거부해 clipboard를 변경하지 않는다. | Grid UX |
| CPY-004 | TS unit | CSV 기본에서 null=`NULL`, empty=`""`, 문자열 `NULL`=`"NULL"`로 구분된다. | Grid UX |
| CPY-005 | TS unit | Excel/TSV에서 null/empty 구별 손실을 preview가 명시하고 구조는 유지된다. | Grid UX |
| CPY-006 | TS unit | Int64, UInt64, Decimal, Timestamp는 display 문자열을 사용해 정밀도를 잃지 않는다. | Grid UX |
| CPY-007 | Component | 설정 preview가 최대 행/byte 상한 안에서 실제 serializer와 같은 결과를 보인다. | Grid UX |
| CPY-008 | Integration | toolbar, `Ctrl+C`, context Copy, Copy with headers가 같은 active preset과 serializer를 사용한다. | Quality |
| CPY-009 | Integration | 설정 변경 중 이미 시작한 copy는 immutable snapshot을 사용하고 다음 copy부터 새 설정을 사용한다. | Quality |
| CPY-010 | Settings | 유효 설정은 재시작 후 복원되고 손상된 설정 파일은 기본값과 비파괴 경고로 복구된다. | Platform |
| CPY-011 | Limit | 기존 soft/hard cell·byte limit, progress와 cancel이 preset 변경 후에도 유지된다. | Quality |
| CPY-012 | Native | 실제 Windows clipboard 문자열이 자동 예상값과 같고 Excel 붙여넣기 smoke를 별도 기록한다. | Platform/Quality |

## 6. CSV parsing profile 테스트

| ID | 계층 | 시나리오와 기대 결과 | 담당 |
| --- | --- | --- | --- |
| CSV-001 | Settings | 기본 모드는 Auto이며 Auto/All Text/Ask Every Time 변경이 새 문서에만 적용된다. | Platform/Grid UX |
| CSV-002 | Rust unit | sample inference가 Boolean, Int64, UInt64, Float64, Decimal, Date, Timestamp, Text 후보와 confidence를 반환한다. | Rust Data |
| CSV-003 | Rust unit | 앞자리 0, 정밀도 초과 ID와 혼합 값은 보수적으로 Text를 추천하거나 낮은 confidence를 표시한다. | Rust Data |
| CSV-004 | Integration | All Text도 delimiter/quote/header 구조는 정상 parsing하고 모든 논리 값 타입만 Text로 둔다. | Quality |
| CSV-005 | Component | click, Ctrl+click, Shift+click, Ctrl+A와 filtered-select-all이 별도 profile selection model로 동작한다. | Grid UX |
| CSV-006 | Component | bulk type 적용은 명시적으로 바꾼 field만 변경하고 서로 다른 값은 `혼합됨`으로 표시한다. | Grid UX |
| CSV-007 | Component | bulk undo, 추천 타입 초기화와 한 컬럼 설정 복사가 정확한 컬럼만 되돌린다. | Grid UX |
| CSV-008 | Rust unit | trim, null token, decimal/thousand separator, Boolean token, date format 우선순위와 timezone을 적용한다. | Rust Data |
| CSV-009 | Rust unit | invalid 원문 보존은 raw display와 error를 유지하며 source null과 별도 bitmap/state로 구분된다. | Rust Data |
| CSV-010 | Query contract | invalid 값은 typed 비교에 match하지 않고 `is invalid`에는 match하며 `is null`에는 match하지 않는다. | Rust Data |
| CSV-011 | Preview | 최대 1,000행을 2단계로 sample한다. Stage A는 open 직후 앞에서 최대 400 logical row를 표시하고, Stage B는 row count/checkpoint가 준비되면 전체 범위의 최대 600개 등간격 logical row를 합쳐 중복을 제거한다. 200ms debounce 후 같은 profile generation의 최신 결과만 표시한다. | Quality |
| CSV-012 | Preview | 원본/변환 전환, 추천→설정 타입, 성공/실패 수, null/invalid/변경 컬럼 상태가 정확하다. | Grid UX |
| CSV-013 | Race | 빠른 설정 변경, dialog 취소, tab 전환/닫기 뒤 늦은 preview가 현재 UI를 갱신하지 않는다. | Quality |
| CSV-014 | Validation | 전체 검증이 모든 행을 검사해 컬럼별 실패 수, 최초 row와 제한된 대표 값을 반환한다. | Quality |
| CSV-015 | Validation | 전체 검증 progress/cancel이 UI를 막지 않고 취소 후 기존 document/session/query가 유지된다. | Quality |
| CSV-016 | Apply | 적용 성공은 새 sessionId를 만들고 cache/result를 폐기하며 원본 파일을 변경하지 않는다. | Rust Data/Platform |
| CSV-017 | Apply | 새 타입과 호환되는 query만 재실행하고 비호환 조건은 이유와 함께 비활성화한다. | Quality |
| CSV-018 | Apply | 컬럼 순서가 같으면 가능한 scroll/selection을 복원하고 불가능하면 결정적으로 초기화한다. | Grid UX |
| CSV-019 | Scope | profile은 document session에만 유지되고 같은 파일을 다른 tab/process에서 열어도 공유되지 않는다. | Quality |
| CSV-020 | Error | parser 구조 오류는 적용을 막고, 변환 경고는 확인 후 적용 가능하며 취소는 완전한 no-op이다. | Quality |
| CSV-021 | Cross-layer matrix | `None`, `,`, `.`, `Space`와 Auto/Int64/UInt64/Float64/Decimal의 허용 조합을 TypeScript DTO, Rust profile, preview, apply page, numeric query와 Playwright에서 같은 표로 검증한다. 정수의 Thousands `.`은 허용하고 fractional의 Decimal=Thousands만 거부한다. | Grid UX/Rust Data/Quality |

CSV-011의 Stage B row index는 전체 row 수가 `R`, 목표 분산 sample 수가 `N`일 때
`floor(i * (R - 1) / (N - 1))`, `i=0..N-1`로 고정한다. `R < N`이면 모든 row를 한 번만
사용하고 Stage A와 겹친 row도 deduplicate한다. quoted newline은 physical line이 아니라 CSV
logical row 하나로 센다. Stage B 준비 전에는 Stage A임을 UI에 표시하며, index 실패나 취소가
Stage A 결과와 현재 document session을 지우지 않는다.

## 7. Filter, search, sort 테스트

| ID | 계층 | 시나리오와 기대 결과 | 담당 |
| --- | --- | --- | --- |
| QRY-001 | Rust unit | typed expression validation이 컬럼 타입에 허용된 operator만 승인한다. | Rust Data |
| QRY-002 | Rust unit | 여러 컬럼 filter는 AND, 한 컬럼의 여러 값은 OR로 결합된다. | Rust Data |
| QRY-003 | Integration | filter/search/sort는 현재 page가 아니라 전체 source 또는 현재 result 전체에 적용된다. | Quality |
| QRY-004 | Rust unit | number/decimal/date/timestamp 경계와 timezone 비교가 display 문자열이 아닌 typed value를 사용한다. | Rust Data |
| QRY-005 | Rust unit | source null과 CSV invalid를 `is null`/`is invalid`로 정확히 구별한다. | Rust Data |
| QRY-006 | Integration | distinct value 목록은 page/search 방식이며 전체 cardinality를 UI 메모리에 올리지 않는다. | Quality |
| QRY-007 | Component | 활성 filter가 header와 query bar에 표시되고 개별/전체 해제가 같은 plan을 만든다. | Grid UX |
| QRY-008 | Search | global search 기본 대상은 표시 중인 scalar 컬럼이며 column selector로 제한할 수 있다. | Quality |
| QRY-009 | Search | case-insensitive contains/exact는 양쪽 문자열에 locale-independent Unicode scalar lowercase mapping을 적용하며 normalization은 하지 않는다. case-sensitive는 원본 code point sequence를 비교한다. ASCII, 한글, `İ`/`i\u{307}`, `ß`/`SS`, NFC/NFD fixture가 규칙대로 동작한다. | Rust Data |
| QRY-010 | Search | find navigation과 match-only filter가 서로 다른 상태와 결과를 유지한다. | Grid UX |
| QRY-011 | Search | binary/nested/hidden column 제외 상태가 UI에 표시되고 regex option은 노출되지 않는다. | Grid UX |
| QRY-012 | Sort | ascending/descending/clear와 Shift multi-sort가 우선순위 순서대로 plan을 만든다. | Grid UX/Rust Data |
| QRY-013 | Sort | 같은 값은 원본 row identity로 안정 정렬되고 null은 양 방향 모두 마지막이다. | Quality |
| QRY-014 | Sort | filter + global search + 3-column sort 조합을 CSV와 Parquet 동일 논리 fixture에서 비교한다. | Quality |
| QRY-015 | Paging | result 첫/중간/마지막/random page와 projection이 queryId에 맞는 정확한 행을 반환한다. | Quality |
| QRY-016 | Empty | 0건 결과, 모든 null, 모든 invalid와 빈 source에서 명확한 empty state를 반환한다. | Quality |
| QRY-017 | Error | 잘못된 literal, 존재하지 않는 컬럼과 지원하지 않는 operator가 typed 사용자 오류가 된다. | Rust Data/Grid UX |
| QRY-018 | Selection | query commit 시 오래된 논리 selection을 지우고 focus를 결정적으로 복원해 잘못된 범위를 복사하지 않는다. | Grid UX |

## 8. 수명주기, 임시 디스크와 다중 프로세스

| ID | 계층 | 시나리오와 기대 결과 | 담당 |
| --- | --- | --- | --- |
| LIFE-001 | Rust | 모든 query/page/status 응답이 documentId/sessionId/queryId를 검증한다. | Rust Data |
| LIFE-002 | Race | 느린 query 뒤 빠른 query, profile 교체, tab close에서 늦은 결과가 폐기된다. | Quality |
| LIFE-003 | Cancel | query/validation cancel은 해당 작업만 멈추고 다른 document와 process에 영향을 주지 않는다. | Quality |
| LIFE-004 | Soak | 8개 tab에서 profile/query/open/close 100 cycle 후 task, handle, result가 기준선으로 돌아온다. | Quality |
| TMP-001 | Rust | query temp root는 Tauri가 resolve한 app-local-data 아래이며 exe/source 옆에 쓰지 않는다. | Platform |
| TMP-002 | Rust | process/document/query마다 nonce가 있는 독립 경로와 owner lock을 사용한다. | Platform |
| TMP-003 | Integration | 완료, 실패, 취소, query 교체, profile 교체, tab close 순서에서 handle drop 후 temp를 삭제한다. | Quality |
| TMP-004 | Crash recovery | 강제 종료 orphan은 다음 시작에서 lock 획득 가능한 경우만 삭제된다. 활성 다른 process 경로는 보존한다. | Platform |
| TMP-005 | Recovery | 즉시 삭제 실패는 `delete-pending-*` rename 후 다음 시작에서 재시도한다. | Platform |
| TMP-006 | Disk limit | 기본 process hard cap 10 GiB와 최소 여유 공간 `max(5 GiB, 10%)`를 넘기기 전에 query만 실패한다. | Quality |
| TMP-007 | Disk limit | 실행 중 disk 감소도 감지해 query를 취소하고 source/config/다른 process 파일을 삭제하지 않는다. | Quality |
| TMP-008 | Settings | `Clear temporary files`는 lock 없는 orphan/delete-pending만 제거하고 결과와 실패 목록을 반환한다. | Platform/Grid UX |
| TMP-009 | Shutdown | 정상 종료 정리는 최대 3초만 기다리고 남은 orphan은 다음 startup janitor에 맡긴다. | Platform |

TMP-006/007 자동 테스트는 실제 10 GiB 파일이나 실제 volume 고갈을 만들지 않는다. disk budget
판정기는 `capacity`, `free`, 현재 process temp 사용량과 app 전체 진단 사용량을 반환하는 probe를
주입받는다. production probe는 OS와 실제 temp tree를 읽고, test probe는 각 값을 런타임에
감소시킬 수 있는 가짜 snapshot을 사용한다. preflight와 실행 중 monitor는 같은 순수 budget
판정 함수를 호출하며, 임계값 직전/동일/초과, 다른 process 사용량, overflow-safe arithmetic과
query-only cancel을 table-driven test로 검증한다. 실제 filesystem integration은 작은 임시
directory에서 cleanup/lock 보호만 검증한다.

## 9. 성능과 resource budget

성능은 release build, 전원 연결, fixture가 있는 로컬 SSD에서 3회 warm-up 후 10회 측정한다.
절대 시간은 기준 장비 결과와 함께 기록하며, 다른 장비에서는 정확성·상한과 Phase 8 대비 회귀율을
우선 판정한다.

| ID | 대상 | 필수 기준 |
| --- | --- | --- |
| PERF-001 | 9A source refactor | CSV/Parquet open과 random page median이 Phase 8 기준선 대비 15% 이상 악화되지 않음 |
| PERF-002 | CSV sample preview | 1,000 sample 변환 p95 500ms 이하, UI main-thread long task 100ms 미만 |
| PERF-003 | CSV full validation | 시작 1초 안에 progress 또는 determinate 준비 상태 표시, cancel 요청 후 2초 안에 중단 |
| PERF-004 | 10M Parquet filter | 단순 typed filter 첫 결과 10초 이내, 결과 준비 후 random page p95 1초 이하 |
| PERF-005 | 10M Parquet sort | 저·고카디널리티 3-column stable sort 각각 120초 이내 또는 spike에서 승인된 더 엄격한 기준 |
| PERF-006 | Memory | 대용량 query peak RSS 1.5 GiB 이하, memory budget 초과분은 bounded spill 사용 |
| PERF-007 | Spill | process query temp 10 GiB hard cap을 넘지 않고 정리 후 query 디렉터리 0개 |
| PERF-008 | Cancel | filter/search/sort cancel p95 2초 이하, UI 입력은 계속 응답 |
| PERF-009 | Multi-document | 8개 tab 중 2개 동시 query에서 worker 상한을 지키고 다른 tab page p95가 2초를 넘지 않음 |
| PERF-010 | Cardinality | low/high fixture 모두 checksum 정확성 PASS, 파일 크기는 PASS 조건으로 사용하지 않음 |

PERF-001은 Phase 7 `large-csv.csv`와 Phase 8 release low/high Parquet를 하나의 baseline manifest로
묶고 fixture SHA-256을 먼저 감사한다. 같은 release runner에서 fixture별 3회 warm-up 후 10회를
측정한다. random page는 매번 중간 offset 하나를 읽는 방식이 아니라 manifest seed로 만든 서로
다른 10개 logical offset을 pre/post에 동일하게 사용한다. 기존 runner가 warm-up과 offset 목록을
지원하지 않으면 측정 전에 harness를 보완하며, 보완 전 결과를 PERF-001 PASS 근거로 쓰지 않는다.

PERF-005의 120초 기준을 만족하지 못한 후보는 기본 engine으로 선택하지 않는다. 모든 후보가 실패하면
Phase 9D를 FAIL로 두고 기능을 축소하거나 budget을 사용자와 다시 합의한다.

## 10. UI와 native 검증

`docs/UI_VALIDATION.md`를 전부 적용한다.

| ID | 계층 | 검증 항목 | 담당 |
| --- | --- | --- | --- |
| UI-001 | Component | copy settings, CSV profile, filter popover, query bar의 loading/empty/error/populated 상태 | Grid UX |
| UI-002 | Interaction | profile grid Ctrl/Shift 선택, bulk apply/undo와 input focus shortcut 차단 | Quality |
| UI-003 | Interaction | filter/search/sort keyboard 동작, Escape, focus 복원과 screen-reader status | Quality |
| UI-004 | Geometry | 1440x900, 1024x768, 800x600에서 dialog/popover/grid overlap과 예상 밖 overflow 0 | Quality |
| UI-005 | Geometry | profile 설정 grid와 sample grid header/cell 오차 1px 이하, 가상 DOM 수 bounded | Quality |
| UI-006 | Screenshot | 세 viewport의 CSV profile, filter+sort active, query progress, disk error 상태 이미지 검토 | Quality |
| UI-007 | Accessibility | icon accessible name/tooltip, role, label, focus-visible, 색상 외 invalid/sort 표시 | Quality |
| UI-008 | Native | Tauri WebView에서 settings persistence, file dialog descriptor, clipboard preset을 확인 | Platform |
| UI-009 | Native | OS drag-and-drop과 기존 CSV/Parquet association 회귀를 확인 | Platform |
| UI-010 | Native | 100%/150% DPI에서 popover와 profile 화면 clipping이 없음 | Platform/Quality |

필수 screenshot과 결과 파일은 `artifacts/phase-9/ui/`에 저장한다. Browser shell 검증은 실제
clipboard, native dialog, OS drop, file association과 WebView 배율 검증을 대체하지 않는다.

## 11. Engine spike gate

DataFusion, DuckDB embedded, 직접 구현 후보를 같은 release harness로 비교한다.

- compile 시간과 release binary 증가량
- CSV/Parquet adapter 복잡도와 정밀도
- filter first result, global search, 3-column sort, random page
- low/high cardinality peak RSS와 spill byte
- cancel latency, temp cleanup과 panic/error 경계
- Windows NSIS packaging과 5개 독립 process 실행

결과는 `artifacts/phase-9/engine-spike.md`에 원시 명령, version, fixture checksum과 함께 기록한다.
선택 기준은 정확성/수명주기, memory/disk 상한, 성능, packaging, 유지보수 순이다. 신규
native/runtime dependency가 필요한 후보는 기록만 하고 사용자 승인 전 product dependency에
추가하지 않는다.

## 12. 전체 gate와 완료 조건

구현 완료 전 다음을 실행한다.

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
npm run tauri build
```

Phase 9 완료 조건은 다음과 같다.

1. FMT, CPY, CSV, QRY, LIFE, TMP 필수 테스트가 PASS다.
2. 저·고카디널리티 1,000만 행 fixture에서 정확성과 resource budget을 모두 만족한다.
3. 실행 가능한 UI/browser/native gate가 PASS이고 미실행 필수 항목이 없다.
4. 기존 Phase 1~8 회귀 테스트가 PASS다.
5. engine 선택, dependency 승인, 실제 resource 측정값이 문서에 반영됐다.
6. source, query, temp directory와 설정 파일에 무제한 collection 또는 명시되지 않은 쓰기가 없다.
7. `50-integration.md`와 독립 `90-review.md`에 재현 가능한 증거가 기록됐다.
