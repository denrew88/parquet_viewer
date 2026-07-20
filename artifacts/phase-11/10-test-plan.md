# Phase 11 테스트 계획

- 상태: 구현 전 확정
- 작성일: 2026-07-20
- 대상: OEF H5 v3, segmented grid, column auto-fit, boundary navigation, Parquet query, typed display/copy

## 1. 판정 규칙

- 모든 테스트는 fixture, 계층, 기대 결과와 증거 파일을 가진다.
- 구현 Agent는 소유 모듈 unit test를 코드와 함께 작성한다.
- Quality Agent는 fixture checksum, E2E, 성능, native와 통합 회귀를 독립 검증한다.
- Browser mock PASS를 실제 HDF5 decode, WebView2 scroll, system clipboard나 DPI PASS로 대체하지 않는다.
- 필수 항목 하나라도 미실행이면 Phase 11 상태는 `BLOCKED`다.

## 2. Fixture

| Fixture | 목적 |
| --- | --- |
| `oefh5-v3-small.h5` | format/version/shape, numeric axis, int32 transpose golden |
| `oefh5-v3-types.h5` | integer/float/string time·wavelength, int32/int64 oes |
| `oefh5-v3-empty-time.h5` | string time의 `""`, 실제 LF와 문자 `\n` 구분 |
| `oefh5-v3-chunks.h5` | 서로 다른 유효 chunk shape와 chunk boundary |
| `oefh5-v3-blosc-zstd.h5` | 실제 filter 32001/Blosc-Zstd decode |
| `oefh5-v3-invalid-*` | attribute/dataset/rank/type/shape/filter/link 오류 matrix |
| `large-parquet-5850000x15.parquet` | 보고된 scroll/query/filter/sort 회귀 |
| 기존 10M low/high Parquet | segmented scroll, query와 resource 회귀 |
| `display-types.parquet` | 모든 scalar, timestamp unit/timezone, binary/nested 표시 |
| `multiline.csv` | LF, CRLF, literal `\n`, 2줄 초과 문자열과 TSV round-trip |

생성 fixture는 generator version, logical schema, row group/chunk, filter pipeline, 실제 byte size와
SHA-256을 manifest에 기록한다. 대용량 fixture는 저장소에 commit하지 않고 generator와 manifest를
commit한다. 작은 H5 golden만 fixture 예외 규칙에 따라 추적한다.

`large-parquet-5850000x15.parquet`는 기존 Phase 9 streaming generator에 `full15` profile을 추가해
5,850,000행, 15열, row group 100,000행, Zstd level 3으로 생성한다. 첫 10열은 기존 `BASE_FIELDS`와
동일하고 추가 5열은 int64 2개, float64 2개, int32 1개로 구성한다. low/high cardinality를 모두 만들고
nullable `optional_value`는 row ordinal `% 97 == 0`에서 null이다. empty-string 경계용 text column은
별도 deterministic profile에서 `% 89 == 0`만 실제 empty로 만들며 null과 겹치는 ordinal의 우선순위를
manifest에 기록한다. filter count와 stable sort first/middle/last checksum은 PyArrow 또는 수식 기반
독립 reference로 생성한다.

## 3. 요구사항 추적

| 요구사항 | 테스트 ID |
| --- | --- |
| OEF H5 v3 구조와 transpose | H5V3-001–012 |
| segmented virtualization | VIRT-001–008 |
| 마지막 행 geometry | GEO-001–006 |
| Column width auto-fit | AFIT-001–008 |
| Ctrl 경계 탐색 | NAV-001–010 |
| 대용량 Parquet query/temp | QRY-001–011 |
| raw/display/copy와 settings | VAL-001–014 |
| Browser/native UI | UI-001–010 |
| build, security와 회귀 | PKG-001–006 |

## 4. OEF H5 v3

| ID | 계층 | 검증 |
| --- | --- | --- |
| H5V3-001 | Rust | exact `format=oefh5`, integer `format_version=3`, integer[2] `shape`를 허용한다. |
| H5V3-002 | Rust | missing/wrong format, version과 shape를 각각 typed error로 거부한다. |
| H5V3-003 | Rust | `/time`, `/wavelength` rank-1과 `/oes` rank-2를 검증한다. |
| H5V3-004 | Rust | integer/float/string axis type matrix를 정확한 `ValueKind`로 반환한다. |
| H5V3-005 | Rust | `/oes` int32와 int64의 최솟값·최댓값을 정밀도 손실 없이 반환한다. |
| H5V3-006 | Rust | attribute shape `[T,W]`, axis 길이와 `/oes.shape=[W,T]` 조합 불일치를 거부한다. |
| H5V3-007 | Rust | page `[t0,t1)`와 wavelength projection이 `/oes[w,t]` transpose golden과 일치한다. |
| H5V3-008 | Rust | decoded 64 MiB 이하의 서로 다른 chunk shape는 결과가 같고 초과 chunk는 allocation 전 limit 오류다. |
| H5V3-009 | Native | Python hdf5plugin Blosc-Zstd filter 32001 fixture를 loose plugin 없이 읽는다. |
| H5V3-010 | Rust | unknown filter/codec을 unsupported-compression으로 거부하고 원본을 수정하지 않는다. |
| H5V3-011 | Rust | soft/external link, VDS와 external storage를 외부 접근 전에 거부한다. |
| H5V3-012 | Rust | string time의 `""`만 empty이고 numeric time과 모든 oes 값은 occupied다. |

## 5. Segmented virtualization과 geometry

| ID | 계층 | 검증 |
| --- | --- | --- |
| VIRT-001 | Unit | 논리 row↔segment/physical offset mapping의 0, 경계, last round-trip이 정확하다. |
| VIRT-002 | Unit | physical scroll extent가 WebView 안전 상한을 넘지 않고 arithmetic overflow가 없다. |
| VIRT-003 | Browser | 5,850,000행에서 986,803 전후와 실제 5,849,999행으로 이동한다. |
| VIRT-004 | Browser | 10M first/middle/last random jump 후 표시 row와 status range가 일치한다. |
| VIRT-005 | Browser | recenter 전후 active cell, anchor, selection과 horizontal window를 보존한다. |
| VIRT-006 | Browser | 빠른 wheel/drag/PageDown에서 stale page가 현재 logical range를 덮지 않는다. |
| VIRT-007 | Browser | 렌더링 row/cell 수가 dataset 크기가 아니라 viewport/overscan에 제한된다. |
| VIRT-008 | Native | WebView2 100%/150% DPI에서 last row 이동, 선택과 copy가 정확하다. |
| GEO-001 | Geometry | 실제 last row의 top/bottom/border가 grid client rect 안이고 scrollbar와 겹치지 않는다. |
| GEO-002 | Geometry | header, first/last data row와 horizontal scrollbar 치수 계산이 1 CSS px 허용차 안이다. |
| GEO-003 | Browser | 1440x900, 1024x768, 800x600에서 last row가 완전히 표시된다. |
| GEO-004 | Browser | multiline cell은 실제 개행/wrap을 최대 2줄로 렌더링하고 row 높이가 모두 같다. |
| GEO-005 | Browser | 3줄 이상 값은 clamp되고 전체 값 보기에서 원문 전체를 확인한다. |
| GEO-006 | Native | Windows scrollbar와 DPI가 달라도 last row clipping이 없다. |

## 6. Column width auto-fit

| ID | 계층 | 검증 |
| --- | --- | --- |
| AFIT-001 | Unit | header와 해당 column의 loaded/cached `display` 문자열만 측정 대상으로 사용한다. |
| AFIT-002 | Unit | LF/CRLF 문자열은 가장 긴 논리 줄을 측정하고 literal `\n`은 같은 한 줄로 측정한다. |
| AFIT-003 | Unit | header/cell font, padding, border와 sort/filter action 공간을 포함해 80..800 px로 clamp한다. |
| AFIT-004 | Component | visible header 오른쪽 separator 더블클릭이 해당 column 하나만 auto-fit한다. |
| AFIT-005 | Component | column menu의 `열 너비 자동 맞춤`이 keyboard/focus로 같은 계산을 실행한다. |
| AFIT-006 | Contract | auto-fit 중 backend boundary/page/query command와 전체 column scan 호출이 0회다. |
| AFIT-007 | Component | 수동 resize가 auto-fit 결과를 덮어쓰고 너비가 document 전환 뒤 복원된다. |
| AFIT-008 | E2E | display 설정이나 새 page 로딩이 너비를 자동 변경하지 않고 재실행할 때만 새 display로 계산한다. |

## 7. 경계 탐색

| ID | 계층 | 검증 |
| --- | --- | --- |
| NAV-001 | Rust | occupied→occupied, occupied→empty, empty→empty, empty→occupied Excel 경계를 table-driven 검증한다. |
| NAV-002 | Rust | null/empty만 빈 셀이며 invalid, whitespace와 literal `\n`은 occupied다. |
| NAV-003 | Rust | OEF numeric time과 oes up/down, 행 내부 oes left/right target을 O(1)로 계산한다. |
| NAV-004 | Rust | OEF string time의 empty boundary를 dataset block scan으로 찾는다. |
| NAV-005 | Rust | Parquet null/empty boundary를 typed vector scan하며 display 문자열에 의존하지 않는다. |
| NAV-006 | Rust | CSV/query result 경계와 반복 탐색 cache invalidation이 정확하다. |
| NAV-007 | Frontend | command 1회와 target cache miss page 최대 1회만 발생하며 중간 `read_page`가 0회다. |
| NAV-008 | E2E | Ctrl, Ctrl+Shift, Ctrl+Alt, Ctrl+Alt+Shift 네 조합의 target/selection/focus가 일치한다. |
| NAV-009 | Race | 새 입력, mouse selection, focus/session/query 변경이 늦은 탐색 결과를 폐기한다. |
| NAV-010 | Perf | release에서 OEF no-empty fast path p95 100 ms 이하, 5.85M Parquet cold p95 2 s 이하, 같은 경계 cache hit p95 250 ms 이하다. 1회 warm-up 뒤 최소 5회 측정하고 fixture/column/empty 위치와 머신 정보를 기록한다. |

성능 측정은 backend target 계산과 frontend target page 표시를 분리해 기록한다. 환경 차이로 예산을
바꾸려면 측정값과 사용자 승인을 문서에 반영하며 조용히 기준을 낮추지 않는다.

## 8. Parquet query와 temp

| ID | 계층 | 검증 |
| --- | --- | --- |
| QRY-001 | Rust | 5.85M 전체 대상 단일/다중 typed filter 결과 count와 checksum이 reference와 같다. |
| QRY-002 | Rust | asc/desc/multi-column sort와 source-row tie-breaker가 stable하고 nulls-last다. |
| QRY-003 | Rust | query page first/middle/last와 projection이 reference와 같다. |
| QRY-004 | Inspect | scan plan에 적용 가능한 predicate/projection pushdown이 존재한다. |
| QRY-005 | Inspect | result index가 모든 source column의 display/raw 문자열 복사본을 갖지 않는다. |
| QRY-006 | Perf | low/high cardinality에서 filter 첫 결과 10초, stable 3-column sort 120초, peak RSS 1.5 GiB, temp 10 GiB와 prepared random-page p95 1초 예산 안이며 전체 UI row materialization이 없다. |
| QRY-007 | UI | 260 GiB volume에서 안전 여유를 26 GiB의 데이터 필요량으로 경고하지 않는다. |
| QRY-008 | UI | estimated temp, 5 GiB safety reserve와 10 GiB hard cap을 구분해 표시한다. |
| QRY-009 | Rust | disk 부족, hard cap, cancel과 failure가 typed error이며 partial result를 commit하지 않는다. |
| QRY-010 | Lifecycle | success/cancel/failure/replace/close 후 temp와 result index 누적이 없다. |
| QRY-011 | Regression | CSV와 기존 10M Parquet query 정확성·Unicode·invalid/null 계약을 보존한다. |

## 9. Raw, display, copy와 settings

| ID | 계층 | 검증 |
| --- | --- | --- |
| VAL-001 | Rust/TS parity | 모든 `DataValue` variant의 canonical `sourceDisplay`, `rawDisplay`, state와 unit/timezone metadata validation 조합이 같다. |
| VAL-002 | Contract | int64/uint64/decimal/timestamp가 JavaScript number 왕복 없이 정확하다. |
| VAL-003 | Unit | display 설정 변경이 raw payload, state, filter와 sort 결과를 바꾸지 않는다. |
| VAL-004 | Unit | timestamp ns/µs/ms/s 소수초를 source 정밀도대로 표시한다. |
| VAL-005 | Unit | timestamp display/default copy가 `YYYY-MM-DD HH24:MI:SS.F...`이고 T/Z/offset/unit annotation이 없다. |
| VAL-006 | Unit | source timezone wall-clock은 유지하고 raw detail에는 unit/timezone/원본이 남는다. |
| VAL-007 | Unit | integer/float/decimal/Boolean/date/binary/nested 전역 option과 default가 결정적이다. |
| VAL-008 | Unit | string LF/CRLF는 실제 개행으로 display되고 literal `\n`은 그대로다. |
| VAL-009 | Clipboard | multiline, tab, quote가 있는 string을 Excel/TSV serializer로 round-trip한다. |
| VAL-010 | Clipboard | Ctrl+C default, Copy displayed와 Copy raw/canonical 결과를 각각 검증한다. |
| VAL-011 | Detail | cell detail이 Displayed, Copy value, Type, Unit, Timezone와 Raw를 구분한다. |
| VAL-012 | Settings | V2→V3 migration이 copy limit/preset/CSV 설정을 보존하고 새 기본값을 채운다. |
| VAL-013 | Settings | invalid V3는 전체 설정을 부분 적용하지 않고 기존 backup 복구 계약을 유지한다. |
| VAL-014 | Resource | 긴 binary/nested/string raw를 모든 grid page에 무제한 중복하지 않는다. |

## 10. UI와 native

| ID | 계층 | 검증 |
| --- | --- | --- |
| UI-001 | Component | 타입별 전역 Display formats control의 label, default, validation과 reset을 검증한다. |
| UI-002 | Component | column별 override control이 존재하지 않는다. |
| UI-003 | E2E | 설정 변경 즉시 visible grid에 반영되고 document/query 전환 후에도 전역 유지된다. |
| UI-004 | E2E | timestamp, multiline string, int/float/decimal/binary/nested populated 상태를 검증한다. |
| UI-005 | E2E | input focus 중 grid shortcut이 설정 입력을 가로채지 않는다. |
| UI-006 | Geometry | settings와 cell detail이 세 viewport에서 overlap/clipping이 없다. |
| UI-007 | Screenshot | desktop/compact/minimum populated, last-row, multiline, settings 상태를 독립 검토한다. |
| UI-008 | Native | 실제 OEF H5와 Parquet를 Tauri에서 열어 display와 navigation을 확인한다. |
| UI-009 | Native | Windows system clipboard의 timestamp/multiline TSV hash와 Excel 붙여넣기를 분리 기록한다. |
| UI-010 | Native | 100%/150% DPI screenshot과 geometry 수치를 기록한다. |

## 11. Build, security와 전체 gate

| ID | 계층 | 검증 |
| --- | --- | --- |
| PKG-001 | Rust | dynamic HDF5 plugin/VOL/VFD 차단과 static Blosc availability를 유지한다. |
| PKG-002 | Native | release/NSIS가 Python, Conda, loose HDF5/Blosc/Zstd DLL 없이 OEF v3를 연다. |
| PKG-003 | Security | 모든 fixture의 size/mtime/hash가 open/page/query/copy 뒤 동일하다. |
| PKG-004 | Build | frontend format/lint/typecheck/test/build와 Rust fmt/clippy/test가 PASS다. |
| PKG-005 | E2E | `npm run test:e2e`의 세 viewport 전체가 PASS다. |
| PKG-006 | Regression | CSV/Parquet/OES legacy error, multi-tab/process, copy limit과 package 회귀가 없다. |

## 12. 산출물

```text
artifacts/phase-11/
  fixture-manifest.json
  benchmark-results.json
  query-plan-audit.md
  50-integration.md
  90-review.md
  ui/
    browser-desktop.png
    browser-compact.png
    browser-minimum.png
    geometry-results.json
    interaction-results.md
    visual-review.md
    native-desktop.png
    native-smoke.md
```

구현 전에는 실행 결과, 빈 증거 파일이나 PASS 판정을 만들지 않는다.
