# Phase 11 기술 설계

- 상태: 구현 기준 확정
- 원칙: source typed value를 기준으로 하고 display 문자열을 데이터 identity로 사용하지 않는다.

## 1. OEF H5 v3 source

Phase 10의 정적 HDF5 process 초기화와 Blosc 등록은 재사용한다. format handler의 구조 검증과 source
mapping만 실제 v3 계약으로 교체한다.

Open 순서:

1. canonical path와 HDF5 signature를 확인하고 read-only로 연다.
2. plugin/VOL/VFD lockdown과 Blosc filter availability를 process-once로 확인한다.
3. root attribute `format`, `format_version`, `shape`의 rank/type/value를 검증한다.
4. `/time`, `/wavelength`, `/oes`가 root local hard-linked dataset인지 확인한다.
5. dataspace와 dtype을 먼저 읽어 axis length와 `[W,T]` shape를 checked arithmetic으로 검증한다.
6. filter pipeline을 검사하고 static runtime에서 사용할 수 없는 filter/codec을 decode 전에 거부한다.
7. axis budget을 예약하고 time/wavelength를 읽어 column binding과 schema를 만든다.
8. 첫 bounded projection만 읽고 session을 commit한다.

`/oes` page algorithm:

```text
input logical rows [t0, t1), wavelength ordinals w[]
storage selection = oes[w-range or grouped w-ranges, t0..t1)
output row-major cell[t - t0][projection index] = oes[w][t]
```

인접 wavelength projection은 hyperslab으로 coalesce할 수 있지만 비인접 ordinal을 하나의 넓은 range로
읽어 불필요한 열을 대량 decode하지 않는다. output transpose buffer는 `rows × projected columns`와
decoded-byte 상한을 사전 계산한다. int64는 정확한 decimal payload로 전달한다.

Chunk shape는 I/O 최적화 hint일 뿐 shape 의미를 결정하지 않는다. filter가 있는 dataset은 HDF5가
요구하는 chunked layout이어야 하지만 특정 `(W,T)` chunk 크기를 강제하지 않는다. checked arithmetic으로
`chunk_wavelength × chunk_time × element_bytes`를 계산해 decoded 64 MiB를 넘으면 HDF5 read/decode 전에
typed resource-limit 오류로 거부한다.

## 2. DataValue wire model

현재 `display`와 선택적 `rawDisplay`만으로는 Parquet timestamp와 일반 typed raw를 구분할 수 없다.
Phase 11 구현은 기존 wire 크기와 호환성을 유지하면서 source 정밀도와 temporal metadata를 분리한다.

```text
DataValue
├─ kind
├─ state: valid | null | empty | invalid
├─ display: string | null
├─ sourceDisplay?: string | null   # source-native canonical scalar text
├─ rawDisplay?: string | null      # epoch/unit 또는 CSV 원문/invalid 진단용
├─ unit?: string | null
├─ timezone?: string | null
└─ diagnostic?: string | null
```

- Rust와 TypeScript validator는 `kind/state`와 optional metadata 조합 parity test를 갖는다.
- integer/decimal은 decimal digit string, float는 round-trip decimal, timestamp는 epoch digit
  `rawDisplay`와 별도 `unit/timezone`으로 JS number coercion 없이 전달한다.
- binary/nested page 값은 bounded preview이고 전체 값은 16 MiB hard cap의 `read_cell_value`로만 요청한다.
- float의 일반 display/copy에는 round-trip decimal을 사용한다. IEEE bit pattern은 일반 copy가 아니라
  cell detail의 advanced raw metadata로만 필요 시 제공한다.
- timestamp timezone/unit은 cell detail과 raw copy가 source 의미를 복원할 수 있도록 값에 명시한다.
- page JSON과 cache byte estimate는 source payload까지 포함해 기존 상한을 다시 계산한다.

## 3. Formatting pipeline

```text
source typed payload
   ├─ query/filter/sort/boundary state
   ├─ DisplayFormatter(settings.displayFormats) -> grid display
   ├─ CopyFormatter(copy snapshot) -> clipboard field
   └─ RawFormatter -> cell detail/raw copy
```

Display와 copy formatter는 같은 검증된 타입별 formatting core를 사용하되 option set은 분리한다.
timestamp 기본 formatter는 source timezone의 wall-clock을 계산하고 timezone suffix 없이
`YYYY-MM-DD HH24:MI:SS[.fraction]`을 만든다. fraction digits는 unit/source precision을 보존한다.
`[unit=ns]`는 metadata renderer의 label이지 값 문자열이 아니다.

Settings V3:

```text
version: 3
copyLimits: existing V2 value
copyOptions: existing preset plus representation
displayFormats:
  integer, floatingPoint, decimal, date, timestamp,
  boolean, binary, string, nested
```

V2 migration은 기존 copy preset, custom delimiter, null/empty, CSV profile default와 copy limit을 보존하고
`displayFormats`만 기본값으로 추가한다. 저장은 기존 atomic canonical/previous file 계약을 유지한다.

## 4. Fixed two-line row geometry

- CSS line height, vertical padding와 border에서 하나의 `GRID_ROW_HEIGHT`를 계산·고정한다.
- virtualizer estimate, actual row style, page size/visible count, keyboard page movement와 selection overlay가
  같은 constant를 사용한다.
- cell content는 `white-space: pre-wrap`, word wrapping과 2-line clamp를 조합한다.
- CRLF는 표시 전에 논리 newline으로 정규화할 수 있지만 source payload와 copy bytes는 변경하지 않는다.
- row별 dynamic measurement는 사용하지 않는다. 고정 높이는 segmented mapping과 scroll 안정성을 보장한다.

## 5. Column width auto-fit

Auto-fit은 frontend의 순수 계산으로 구현하고 backend I/O를 발생시키지 않는다.

```text
candidates = [public column header, loaded/cached DataValue.display values for column]
contentWidth = max(measure header, measure each logical line of each display value)
targetWidth = clamp(contentWidth + padding + border + action/resizer allowance, 80, 800)
```

- header와 cell의 computed font가 다르면 각각의 font descriptor로 `CanvasRenderingContext2D.measureText`
  또는 동등한 deterministic DOM measurement를 사용한다.
- LF/CRLF는 측정용으로만 논리 줄로 나누고 source/display 문자열을 수정하지 않는다. literal `\n`은
  split하지 않는다.
- candidate는 현재 document page cache에서 해당 logical column과 실제 projection identity가 일치하는
  값만 사용한다. stale session/query page는 포함하지 않는다.
- `null`은 빈 표시 문자열로 취급하고 empty/invalid는 실제 `display`를 사용한다.
- separator `dblclick`은 진행 중 pointer resize를 취소하고 하나의 atomic column sizing update를 만든다.
- column menu action은 같은 pure function을 호출한다. 접근 경로별 계산을 중복 구현하지 않는다.
- auto-fit은 page fetch, query, boundary scan이나 full-column worker를 시작하지 않는다.
- display settings generation과 page cache 변경은 기존 width를 자동 invalidation하지 않는다. 재실행만
  현재 후보로 새 너비를 계산한다.
- 결과는 기존 document별 sizing state에 기록하며 이후 수동 resize가 같은 state를 덮어쓴다.
- row height auto-fit과 sparse variable-height index는 구현하지 않는다.

## 6. Segmented row virtualization

WebView의 약 33.55M CSS px scroll 한계를 피하기 위해 전체 logical height를 직접 DOM spacer에 넣지 않는다.

상태:

```text
logicalRowCount
logicalAnchorRow
physicalScrollTop
safePhysicalExtent
visibleLogicalRange
```

- `safePhysicalExtent`는 WebView 한계보다 충분히 작은 고정 상한을 사용하고 테스트에서 실제 최대값을
  assertion한다.
- 중앙 안전 구간을 벗어나면 visible logical row를 보존한 채 anchor를 재설정하고 physical scrollTop을
  중앙으로 recenter한다.
- programmatic jump는 target logical row에서 새 anchor/physical position을 직접 계산한다.
- first/last에서는 recenter 대신 정확한 edge mapping을 사용해 overscroll과 반쪽 last row를 막는다.
- scroll event와 page request는 monotonically increasing generation을 갖고 recenter가 만든 synthetic
  event와 stale user event를 구분한다.
- horizontal virtualizer와 column projection state는 vertical segment 변경과 독립적으로 유지한다.

Last-row geometry는 scroll viewport의 content box에서 header와 실제 horizontal scrollbar 공간을 한 번만
제외하고, final spacer/padding이 last row의 full border box를 수용하도록 계산한다.

## 7. Boundary navigator

공통 `find_boundary` command/interface는 유지하되 `TabularSource`가 source-native boundary scan을 제공한다.

```text
find_boundary(document/session/query, row, column, direction, mode)
  -> target row/column + identity
```

- Edge mode(Ctrl+Alt)는 row/column count만 사용한다.
- OEF numeric axis와 oes는 schema/state invariant로 O(1) target을 반환한다.
- OEF string time은 HDF5 dataset을 큰 bounded block으로 읽고 empty string state vector를 검사한다.
- Parquet는 요청 column만 Arrow batch로 scan하여 null bitmap과 string length를 vector 단위로 검사한다.
- CSV는 checkpoint index에서 시작해 bounded record block을 parse하고 해당 column state만 검사한다.
- query result는 최소 result index와 필요한 typed column을 사용하며 UI page DTO를 경유하지 않는다.
- cache key는 document/session/query generation, column ordinal, direction과 inspected interval을 포함한다.
  profile/query/source 교체 시 관련 cache를 폐기한다.
- cancel check는 block 사이에 수행하고 target coordinate만 IPC로 반환한다.

## 8. Parquet query result 구조

현재 `dv_source`/`query_result`가 모든 column의 display와 raw companion을 materialize하는 구조를 제거한다.

계약:

1. source adapter는 typed Parquet column을 DuckDB에 노출하고 display formatting을 SQL source view에 넣지 않는다.
2. query plan에서 filter/search/sort에 필요한 column만 projection한다.
3. 가능한 predicate는 Parquet scan으로 push down한다.
4. result index는 source row identity, result position과 필요한 sort/predicate state만 저장한다.
5. page 요청 때 visible projection만 source/result identity로 bounded fetch하고 Rust formatting layer에서
   `DataValue`를 만든다.
6. stable tie-break, nulls-last, invalid/empty semantics와 source row identity를 보존한다.

구현 spike에서 DuckDB가 stable source ordinal의 bounded late materialization을 제공하지 못하면 대안 index
구조를 측정해 선택한다. 어떤 대안도 전체 15열의 display/raw 문자열 복제나 unbounded in-memory row vector를
허용하지 않는다. 선택 근거와 EXPLAIN/byte 측정은 `query-plan-audit.md`에 기록한다.

## 9. Temp budget

```text
process hard cap: 10 GiB
default safety reserve: 5 GiB
estimated temp: plan/observed spill 기반 값 또는 unknown
```

- admission은 hard cap, 현재 process usage와 실제 free space를 함께 확인한다.
- safety reserve는 free space 판단용이며 query 필요량으로 합산해 표시하지 않는다.
- volume 전체 크기의 비율을 `필요 공간`으로 표시하지 않는다.
- estimate가 없으면 hard cap까지만 증가할 수 있음을 알리고 진행 중 observed usage를 갱신한다.
- warning DTO는 `estimatedTempBytes?`, `safetyReserveBytes`, `hardCapBytes`, `freeBytes`를 구분한다.
- TypeScript/Rust wire validation과 representative/boundary parity test를 둔다.

## 10. Lifecycle와 보안

- 모든 H5/Parquet source는 read-only이고 원본 hash/size/mtime을 변경하지 않는다.
- display settings generation은 grid cache의 display 결과만 무효화하며 source/query identity를 바꾸지 않는다.
- source/profile/query 교체는 page, boundary와 result index generation을 함께 무효화한다.
- background scan/query는 registry lock을 잡은 채 I/O하지 않는다.
- dynamic HDF5 plugin과 external storage 차단을 유지한다.
- partial query/copy/navigation 결과는 commit하지 않는다.

## 11. 설계 완료 gate

- H5 v3 transpose, DataValue V3, segmented mapping과 query result index가 unit-test 가능한 독립 모듈 경계를 가진다.
- JS/WebView scroll maximum에 의존하는 전체-height spacer가 없다.
- display string이 filter/sort/boundary identity로 사용되지 않는다.
- column auto-fit은 display 전용 pure measurement이며 backend 또는 전체 column scan을 호출하지 않는다.
- memory/page/chunk/temp/copy 상한과 overflow-safe arithmetic이 코드와 테스트에 존재한다.
- frontend/Rust DTO 중복 검증은 parity test를 갖는다.
