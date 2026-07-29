# Phase 16 CSV separator 표시 parity 보강 테스트 계획

- 실행 모드: **테스트 설계**
- 작성일: 2026-07-29
- 대상 결함: `F-P16-001`
- 근거: `docs/PROJECT_SPEC.md` 6·7·10·11절, `artifacts/phase-16/00-scope.md`,
  `artifacts/phase-16/10-test-plan.md`, `artifacts/phase-16/90-review.md`

## 1. 현재 실패와 검증 공백

기존 native smoke의 기대값은 그대로 유지한다. `column_000`을 `UInt64`, Thousands separator를
`.`으로 설정했을 때 preview와 Apply 이후 grid는 모두 원문 `10000019`를 `10.000.019`로 표시해야
한다. 현재 실제 결과는 preview `10.000.019`, `Ready` prepared-cache grid `10000019`이므로 FAIL이다.
테스트를 통과시키기 위해 `10000019`를 허용하거나 대기 시간을 줄이지 않는다.

기존 Rust의 CSV profile matrix는 preview와 `prepare_csv_profile` 직후 direct page를 확인하고,
query matrix도 direct provider를 사용한다. 따라서 background preparation이 `Ready`가 된 뒤
`PreparedQueryProvider`가 persistent artifact의 typed/raw/state 열을 `DataValue`로 다시 만드는 경계는
검증하지 못한다. 이 경계를 page, query, copy가 함께 사용하는 동일 oracle로 보강한다.

## 2. 불변 계약과 golden 값

- Thousands separator는 입력 해석과 converted display에 적용하지만 typed/source 값은 바꾸지 않는다.
- preview, Apply 직후 direct page, cold `Ready` prepared page, persistent cache hit page와 query page의
  `display`, `sourceDisplay`, `rawDisplay`, `state`, `kind`가 단계별 계약과 일치해야 한다.
- filter와 sort는 separator가 제거된 typed 값으로 실행한다. 화면 문자열로 사전식 비교하지 않는다.
- 기본 copy와 `Copy displayed value`는 현재 grid와 같은 grouped display를 쓴다.
  `Copy raw/canonical value`는 CSV의 보존된 원문 lexeme를 쓴다.
- display 문자열을 persistent cache에 중복 저장하지 않는다. 현재 profile metadata를 사용해 page/copy
  경계에서 재구성하며, 수정 뒤에도 cold/warm cache의 typed/raw/state와 source scan 상한은 불변이다.

대표 golden은 다음과 같다.

| target/profile | raw lexeme | typed/source | display | raw copy |
| --- | --- | --- | --- | --- |
| `UInt64`, Thousands `.` | `10000019` | `10000019` | `10.000.019` | `10000019` |
| `Int64`, Thousands `,` | `-10000019` | `-10000019` | `-10,000,019` | `-10000019` |
| `UInt64`, Thousands space | `18446744073709551615` | 동일 문자열 | `18 446 744 073 709 551 615` | 원문 |
| `Float64`, Decimal `,`, Thousands `.` | `10.000.019,25` | `10000019.25` | `10.000.019,25` | `10.000.019,25` |
| `Decimal`, Decimal `.`, Thousands `,` | `10,000,019.2500` | `10000019.2500` | `10,000,019.2500` | `10,000,019.2500` |
| 숫자, Thousands 없음 | `10000019` | `10000019` | `10000019` | `10000019` |
| 숫자 변환 실패 | `bad` | 없음 | `bad`, `invalid` | `bad` |
| 빈 field | 빈 문자열 | 없음 | 빈 cell, `empty` | 빈 문자열 |
| null token | `NULL` | 없음 | null cell, `null` | `NULL` 또는 활성 copy null 계약 |

## 3. 추적 가능한 테스트

| ID | 완료 조건 | 계층·fixture | 기대 결과 | 담당 역할 |
| --- | --- | --- | --- | --- |
| `T-P16-029` | prepared value 재구성이 profile separator를 적용한다. | Rust unit; 위 golden의 Int64/UInt64/Float64/Decimal 및 None/comma/dot/space | `display/sourceDisplay/rawDisplay/state/kind` 전체가 golden과 같고 signed·u64 정밀도 손실과 double grouping이 없다. | Rust Data 구현 Agent |
| `T-P16-030` | preview→Apply→cold Ready page가 같은 표시 의미를 유지한다. | Rust command/query integration; `fixtures/phase-16/csv-separator-parity.csv` | preview와 direct page, `CsvPreparationState::Ready` 뒤 `read_prepared_csv_page`의 각 valid cell display가 같고 invalid/empty/null 상태도 같다. | Rust Data 구현 Agent + Quality |
| `T-P16-031` | persistent cache hit도 profile 표시를 복원한다. | Rust integration; 같은 local-data에서 service 재생성 후 동일 source/profile identity | warm 상태가 즉시 `Ready`, `sourceReadBytes=0`, cache hit 1이며 cold Ready page와 모든 DTO 필드가 같다. display 문자열을 cache physical schema에 추가하지 않는다. | Rust Data 구현 Agent + Quality |
| `T-P16-032` | separator 변경 generation이 서로 오염되지 않는다. | Rust integration; `.` 적용 session 뒤 `,` 적용 새 session, 늦은 이전 page 포함 | 새 session은 comma display만 반환하고 이전 session 응답은 stale이다. cache identity/lease가 잘못 재사용되지 않는다. | Rust Data 구현 Agent |
| `T-P16-033` | sort는 typed 숫자 순서이고 query page 표시도 grouped다. | Rust query integration; 값 `2`, `1000`, `10000019`, 음수, u64 경계 | asc/desc가 numeric order이며 stable row identity를 보존한다. query page는 각각 `2`, `1.000`, `10.000.019` 같은 profile display를 반환한다. | Rust Data 구현 Agent + Quality |
| `T-P16-034` | filter는 normalized typed 값으로 평가하고 표시만 separator를 쓴다. | Rust query integration; `greaterThan 1000`, 범위/동등, invalid/empty/null 포함 | `10000019` 등 실제 numeric match만 남고 invalid/empty/null은 숫자 문자열로 오인되지 않는다. 결과 page의 display는 grouped다. | Rust Data 구현 Agent + Quality |
| `T-P16-035` | unfiltered prepared copy의 표현별 결과가 정확하다. | Rust copy integration; 1행×대표 numeric 열, 실제 staging/clipboard test double | 기본/display copy는 `10.000.019`; raw/canonical copy는 `10000019` 또는 원래 localized lexeme다. header/delimiter/quote 설정은 기존 계약을 유지한다. | Rust Data 구현 Agent + Quality |
| `T-P16-036` | filtered/sorted query copy가 화면 순서와 표시 표현을 유지한다. | Rust copy integration; T-P16-033/034 query snapshot | display copy는 filtered row만 stable sorted order와 grouped display로, raw copy는 같은 행·열 순서의 raw lexeme로 직렬화한다. page IPC 0과 atomic commit 계약을 유지한다. | Rust Data 구현 Agent + Quality |
| `T-P16-037` | frontend가 prepared DTO를 다시 숫자로 coercion하거나 표시를 잃지 않는다. | Vitest component; prepared/query page DTO golden | JS safe integer 밖 값도 문자열로 유지하고 grid, 셀 상세, displayed/raw copy action이 각 DTO 표현을 정확히 사용한다. | Grid UX 구현 Agent |
| `T-P16-038` | 세 viewport에서 profile preview와 Ready grid의 표시가 같다. | Playwright; browser mock에 direct→Preparing→Ready DTO 전환, 1440×900·1024×768·800×600 | 세 viewport 모두 preview와 Ready grid의 dot/comma/space 대표값이 같고 clipping, 열 폭 붕괴, layout shift가 없다. | Quality Agent |
| `T-P16-039` | 기존 실제 Tauri dot separator smoke를 원래 기대값으로 통과한다. | WebView2 native; `fixtures/phase-7/small-csv.csv`, `NATIVE_THOUSANDS_SEPARATOR=.` | preview와 Apply/Ready grid가 `10.000.019`; sort first cell `99.990.189.981`; filter 결과 전부 50,000,000,000 초과; copy와 Ctrl navigation도 기존 assertion 그대로 PASS다. | Tauri Platform + Quality |
| `T-P16-040` | 지원 separator 대표값도 실제 IPC 경계에서 같다. | WebView2 native; 기존 script를 `,`, space 환경값으로 각각 실행 | preview→Ready page→sort/filter→copy가 comma/space golden으로 PASS하며 기대값 완화가 없다. | Tauri Platform + Quality |
| `T-P16-041` | 수정이 준비 성능·cache 구조·전체 회귀를 악화시키지 않는다. | 전체 gate 및 Phase 16 cold/warm smoke | Rust/frontend/Playwright/native 전체 PASS, cold 준비·warm hit·copy batch/page IPC 상한 회귀 없음, release/NSIS PASS다. | Root + Quality |

## 4. fixture와 oracle

`fixtures/phase-16/csv-separator-parity.csv`는 작은 결정적 fixture로 만든다. 최소 세 개의 정렬 가능한
valid row(`2`, `1000`, `10000019`), 음수, `u64::MAX`, localized fractional lexeme, `bad`, 빈 field와
`NULL`을 포함한다. comma가 값에 들어간 열은 CSV quoting을 사용해 parser 자체의 delimiter 계약도
보존한다. 기대 결과는 코드 formatter를 호출해 다시 계산하지 않고 위 표의 literal golden으로 둔다.

대용량 성능과 실제 제품 경로는 기존 `fixtures/phase-7/small-csv.csv`와 Phase 16의 5.85M cold/warm
fixture를 재사용한다. 새 대용량 fixture는 만들지 않는다.

## 5. 구현 Agent가 작성할 단위·통합 테스트

- prepared artifact에서 `DataValue`를 만드는 함수에 profile column 정보가 전달되는 최소 unit test
- cold preparation Ready와 warm persistent hit의 동일 page DTO integration test
- prepared provider를 사용하는 typed sort/filter query page test
- source/query 각각의 display와 raw copy test
- separator generation 교체와 stale session test

테스트 편의를 위해 display 문자열을 persistent artifact에 저장하거나 query SQL에 formatting을 넣는
방식은 허용하지 않는다. test-only 우회 source로 prepared 경계를 건너뛰어서도 안 된다.

## 6. Quality Agent 독립 테스트와 증거

- `T-P16-030~036`을 literal golden으로 독립 재검증하고 cold와 warm 경로를 구분해 기록한다.
- 기존 `scripts/native_cdp_smoke.mjs`의 dot 기대값을 변경하지 않고 우선 재실행한다.
- comma와 space는 같은 script의 기존 `NATIVE_THOUSANDS_SEPARATOR` 경로로 추가 실행한다.
- Playwright 세 viewport에서 preview, Ready grid와 filtered/sorted 상태의 텍스트 및 geometry를 검사한다.
- UI 증거는 `artifacts/phase-16/ui/display-parity-{desktop,compact,minimum}.png`와
  `display-parity-results.md`에 남긴다. native는 기존 `native-csv-profile-{dot,comma,space}.png` 및
  `native-query-copy-*-passed.png`를 사용한다.
- screenshot은 파일 존재만 확인하지 않고 grouped digit, sign, 긴 u64 clipping, header/cell 정렬과
  Apply 전후 layout shift를 이미지로 직접 검토한다.

## 7. 필요한 실제 환경과 승인

- 브라우저 검증은 prepared Rust artifact의 증거가 아니므로 실제 Windows Tauri/WebView2 IPC smoke가
  필수다.
- 실제 Windows clipboard commit은 native smoke로 확인한다. Browser clipboard mock만으로 PASS 처리하지
  않는다.
- 일반 테스트·개발 Tauri 실행은 기존 프로젝트 사전 허용 범위이며 추가 사용자 승인이 필요하지 않다.
- 외부 배포는 이 결함 수정 검증 범위가 아니다.

## 8. 판정 기준과 위험

`T-P16-029~041`이 모두 PASS하고 기존 T-P16-001~028 회귀가 없어야 `F-P16-001`을 해소한다.
특히 T-P16-039의 기존 native 기대값이 한 건이라도 실패하면 Phase 16 전체 판정은 계속 FAIL이다.

주요 위험은 profile 정보가 prepared wrapper 또는 warm cache 복원에서 다시 유실되는 것, formatting을
SQL/cache에 넣어 typed sort/filter 의미와 cache 크기를 오염시키는 것, display copy만 고치고 raw copy를
바꾸는 것, 그리고 app-global numeric grouping과 CSV profile grouping을 중복 적용하는 것이다. 각 위험은
page DTO의 세 표현 필드와 source/query copy를 별도로 비교해 차단한다.
