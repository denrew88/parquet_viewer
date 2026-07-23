# Phase 13 기술 설계

- 상태: 구현 전 계약 확정
- 범위: `00-scope.md`, `10-test-plan.md`

## 1. Settings V4 wire 계약

`schemaVersion`은 4로 올린다. valid V1/V2/V3는 원래 copy, CSV default, temp limit, copy limit과
V3 display 설정을 보존하며 V4 기본 필드만 채워 atomic migration한다.

```ts
type TimestampDateTimeSeparator = "space" | "t";
type TimestampTimeFormat = "hourMinuteSecond" | "hourMinute" | "hidden";
type TimestampTimezoneSuffix = "hidden" | "offset" | "name";

interface TimestampDisplayFormat {
  dateFormat: "YYYY-MM-DD" | "YYYY/MM/DD" | "DD-MM-YYYY" | "MM-DD-YYYY";
  dateTimeSeparator: TimestampDateTimeSeparator;
  timeFormat: TimestampTimeFormat;
  fractionalDigits: { mode: "preserve" } | { mode: "fixed"; digits: 0 | 1 | ... | 9 };
  timezoneSuffix: TimestampTimezoneSuffix;
}

type DurationDisplayStyle = "daysClock" | "totalHours" | "totalSeconds";
type DurationUnitSuffix = "hidden" | "source";

interface DurationDisplayFormat {
  style: DurationDisplayStyle;
  fractionalDigits: { mode: "preserve" } | { mode: "fixed"; digits: 0 | 1 | ... | 9 };
  unitSuffix: DurationUnitSuffix;
}
```

기본 Timestamp는 `YYYY-MM-DD`, space, `hourMinuteSecond`, Preserve, Hidden이다. 기본 Duration은
`daysClock`, Preserve, Hidden이다. Standard/ISO/Date-only/Custom과 Duration preset 이름은 저장하지
않고 설정 조합에서 파생한다. Date-only는 `timeFormat=hidden`이다.

## 2. 값 DTO

`ValueKind`에 `Duration`/`"duration"`을 추가한다. Duration `DataValue`는 다음 불변식을 가진다.

- `sourceDisplay`: signed i64 source count의 decimal string
- `unit`: `s`, `ms`, `us`, `ns` 중 하나
- `display`: 기본 formatter 결과
- `rawDisplay`: `<count> [unit=<unit>]`
- state: null이 아니면 Valid이며 count 0도 occupied

Arrow Duration만 자동 분류한다. physical INT64, Arrow Interval과 Time32/Time64는 Duration으로
분류하지 않는다. formatter는 TypeScript `number`나 Rust float를 사용하지 않고 BigInt/i128 정수
산술을 사용한다.

Timestamp는 기존 epoch/source/unit/timezone metadata를 보존한다. 화면 formatter는 backend가 만든
source timezone wall-clock field를 재배열하고 suffix만 선택한다. timezone conversion은 하지 않는다.
named timezone의 offset 표시는 epoch/unit/timezone으로 해당 instant의 offset을 계산하며 불가능한 경우
조용히 잘못된 offset을 만들지 않고 typed fallback을 사용한다.

## 3. CSV Duration

`CsvTargetType`에 Duration을 추가하고 column profile에 다음 optional wire field를 둔다.

```ts
durationUnit: "s" | "ms" | "us" | "ns" | null;
durationInputFormat: "rawInteger" | "daysClock" | null;
```

Duration target에는 두 필드가 필수이고 다른 target에서는 null이어야 한다. Auto inference는 일반
정수/문자열을 Duration으로 추측하지 않는다.

- `rawInteger`: signed decimal count
- `daysClock`: `[+|-][<unsigned days>d ]HH:MM:SS[.1..9]`

daysClock은 선택한 source unit으로 정확히 표현되는 경우만 허용한다. 범위 초과, source unit보다 정밀한
fraction과 malformed 입력은 failure policy로 보낸다.

Duration filter literal은 daysClock 또는 `[+|-]<integer><s|ms|us|ns>`다. column source unit count로
정확히 환산할 수 없는 값은 validation error다. 정렬과 비교는 signed source count를 사용한다.

## 4. Occupancy batch와 bitmap

공통 grid page와 별도인 한 컬럼 occupancy 경로를 사용한다. block row 단계는
`256, 4,096, 16,384, 65,536`, row hard cap은 65,536, provider가 채택하는 실제 decoded block hard
cap은 8 MiB다. Parquet 후보 batch가 실제 측정에서 이를 넘으면 값을 판정하기 전에 폐기하고 반으로
분할한다. `maxObservedDecodedBytes`와 `maxAcceptedDecodedBytes`를 분리해 transient 후보와 제품이
실제로 사용한 block을 혼동하지 않는다. 최대 단계
이후에는 같은 크기로 반복하고 각 block 사이에서 cancel과 identity를 확인한다.

cache key는 `document + session + query generation + column ID + value-semantics generation`이다.
각 entry는 query logical position의 packed `known`과 `occupied` bitmap을 가진다. query당 최근 8컬럼,
process bitmap payload 16 MiB에서 LRU 회수한다. display, width, order, visibility 변경은 cache를
무효화하지 않는다. source/profile/query 교체와 close는 무효화한다.

filtered/sorted query는 requested logical position의 source row ID를 먼저 읽고 provider가 같은 순서로
한 컬럼 state만 반환한다. scan block은 IPC로 보내지 않고 최종 target만 반환한다. horizontal boundary는
현재 logical row와 visible projection을 최대 64컬럼 chunk로 읽고 전체 query page/join을 만들지 않는다.

## 5. CSV prepared source

첫 page는 기존 bounded direct 경로로 즉시 표시한다. background task는 같은 profile generation의 CSV를
한 번 parse해 app-local session-owned typed DuckDB source와 source-order occupancy를 만든다.

```text
NotStarted -> Preparing(progress) -> Ready
                         |-> Cancelled
                         |-> Failed(typed reason)
Preparing/Ready -> Stale on source/profile/session change
```

build는 partial artifact에 쓰고 성공 시 registry에 atomic commit한다. Ready 이후 page/query/boundary/copy는
원본 CSV full reparse 없이 prepared source를 사용한다. 실패/취소 중에는 정확한 direct fallback을 유지한다.
tab close에서 artifact를 삭제하고 startup janitor는 owner lock을 획득한 orphan만 삭제한다. close/reopen
persistent reuse는 범위가 아니다.

## 6. UI 상태 계약

- tab/header/sort criterion reorder는 Pointer Events session을 사용하고 HTML native `draggable`을 제거한다.
- tab/header keyboard reorder는 focused handle에서 `Alt+Shift+Left/Right`, sort criterion은
  `Alt+Shift+Up/Down`이다. visible move button은 만들지 않는다.
- Tauri file overlay는 non-empty path가 확인된 external drag session에서만 시작한다.
- multi-sort panel은 draft이며 Apply만 query를 실행한다. Shift+header는 일반 header click과 같다.
- Copy history와 chooser는 controlled transient surface다. outside pointer/Esc/scroll/resize/tab change에서
  닫고 outside pointer의 원래 action/focus를 보존한다. success status TTL은 3,000 ms다.
- Settings dialog는 그대로 유지하고 Value display formats section 내부만 summary/detail로 전환한다.
  nested popup/modal과 상세 전용 Apply는 만들지 않는다.

## 7. Identity와 오류

모든 async result는 document/session/query/value-semantics generation을 확인한다. stale response는 cache,
selection, focus, clipboard와 prepared registry를 변경하지 않는다. resource cap, invalid Duration,
unsupported temporal type, stale/cancel/cache build failure는 panic이나 영구 pending 대신 field/operation을
식별할 수 있는 typed error로 종료한다.
