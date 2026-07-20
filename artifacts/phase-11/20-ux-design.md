# Phase 11 UX 설계

- 상태: 구현 기준 확정
- 적용: Data grid, Settings, cell detail, query progress/error

## 1. OEF H5 Data 화면

- 첫 열은 `time`, 이후 열은 `/wavelength` 저장 순서다.
- 화면의 `(time=t, wavelength=w)` 셀은 `/oes[w,t]`를 표시한다.
- OEF 전용 table component를 만들지 않고 generic virtual grid를 사용한다.
- Schema와 Metadata에는 format/version, attribute shape, 실제 dataset shape/dtype/chunk/filter를 표시한다.
- 추가 attribute와 전체 HDF5 tree는 표시하지 않는다.

## 2. 대용량 scroll과 마지막 행

- status의 visible row range는 physical scroll position이 아니라 논리 row number를 표시한다.
- segment recenter는 사용자에게 별도 page 전환처럼 보이지 않아야 한다.
- scrollbar drag, wheel, PageUp/Down, keyboard jump와 selection auto-scroll이 같은 논리 좌표 mapper를 쓴다.
- 실제 마지막 행은 가로 scrollbar 바로 위에서 border와 내용이 모두 보여야 한다.
- 마지막 행에 도달했는데 추가 빈 영역이 무제한으로 생기거나 절반이 잘려서는 안 된다.

## 3. 문자열 셀

- 실제 LF와 CRLF를 셀 안의 줄바꿈으로 렌더링한다.
- 모든 data row는 동일한 고정 높이를 사용하며 최대 2줄만 보여준다.
- 긴 한 줄은 wrap하고, 줄바꿈 또는 wrap 결과가 2줄을 넘으면 line clamp/ellipsis를 적용한다.
- literal `\n`은 두 문자 그대로 표시한다.
- hover tooltip이나 `전체 값 보기`는 원문 전체와 실제 줄바꿈을 보여준다.
- 기본 copy는 원래 줄바꿈을 serializer의 quote/escape 규칙으로 보존한다.

## 4. 열 너비 자동 맞춤

- 열 header 오른쪽 resize separator를 더블클릭하면 해당 열에 `Auto Fit Width`를 실행한다.
- column menu에도 `열 너비 자동 맞춤`을 제공하여 keyboard와 screen reader에서 같은 기능을 쓴다.
- 계산 대상은 열 이름과 현재 로딩·캐시된 셀의 화면 표시값이다. raw 값, 미로딩 행과 숨겨진 전체
  파일을 scan하지 않는다.
- 실제 개행이 있는 문자열은 가장 긴 논리 줄을 기준으로 하고 literal `\n`은 한 줄 문자열로 측정한다.
- header와 cell의 실제 font, 좌우 padding, border, sort/filter action 공간을 포함한다.
- 결과는 기존 최소 80 px, 최대 800 px로 clamp한다.
- 실행 뒤 새 page가 로딩되거나 display format이 바뀌어도 너비를 자동 변경하지 않는다. 사용자가 다시
  더블클릭하거나 menu action을 실행할 때 현재 display 기준으로 재계산한다.
- 수동 resize는 언제든 auto-fit 결과를 덮어쓰며 document별 기존 column width 보존 계약을 유지한다.
- row height auto-fit은 제공하지 않고 모든 data row의 최대 2줄 고정 높이를 유지한다.

## 5. 타입별 전역 표시 설정

Settings에 `Display formats` section을 추가한다. 설정은 모든 열린 문서에 적용되며 column별
override UI는 제공하지 않는다.

```text
Display formats
├─ Integer
│  ├─ Thousands separator
│  └─ Negative format
├─ Floating point
│  ├─ General / Fixed / Scientific
│  └─ Significant/fraction digits
├─ Decimal
│  ├─ Preserve source scale
│  └─ Thousands separator
├─ Date
│  └─ Format
├─ Timestamp
│  ├─ YYYY-MM-DD HH24:MI:SS.F...
│  └─ Preserve source fractional precision
├─ Boolean
│  └─ true/false, TRUE/FALSE, 1/0
├─ Binary
│  ├─ Hex/Base64
│  └─ Preview length
├─ String
│  ├─ Render actual line breaks
│  ├─ Maximum visible lines: 2
│  └─ Wrap long lines
└─ Nested values
   └─ Compact/pretty JSON
```

각 option은 preview, validation과 `Reset type default`를 제공한다. display option을 바꿔도 source
schema, filter value, sort order나 copied raw value는 바뀌지 않는다.

초기 전역 기본값은 다음과 같다.

| 타입 | 기본 display |
| --- | --- |
| Integer | 정확한 10진수, grouping 없음 |
| Floating point | General, round-trip 가능한 자릿수 |
| Decimal | source scale 보존, grouping 없음 |
| Date | `YYYY-MM-DD` |
| Timestamp | `YYYY-MM-DD HH24:MI:SS.F...`, timezone 표시 없음 |
| Boolean | `true` / `false` |
| Binary | Hex preview, 최대 32 bytes와 전체 길이 표시 |
| String | 실제 개행 렌더링, wrap, 최대 2줄 |
| Nested | compact canonical JSON preview |

기본 copy는 integer/float/decimal 정밀도, string 원문과 nested 구조를 보존하는 타입별 canonical
표현을 사용한다. timestamp만 위에서 확정한 공백 구분 형식과 timezone 생략 규칙을 적용한다.

첫 구현의 허용값과 경계는 다음으로 제한한다.

- Integer grouping: `none`, `comma`, `dot`
- Floating notation: `general`, `fixed`, `scientific`; precision은 `1..17`
- Decimal scale: `preserve` 또는 `0..38`; grouping은 `none`, `comma`, `dot`
- Date format: `YYYY-MM-DD`, `YYYY/MM/DD`, `DD-MM-YYYY`, `MM-DD-YYYY`
- Timestamp fractional digits: `preserve` 또는 `0..9`; timezone 표시 option은 제공하지 않고 항상 off
- Boolean: `lowercase`, `uppercase`, `numeric`
- Binary: `hex`, `base64`; preview는 `1..256` bytes
- String: 실제 개행 렌더링 on/off, wrap on/off; maximum visible lines는 이번 Phase에서 2로 고정
- Nested: `compact`, `pretty`

범위 밖 숫자, 알 수 없는 enum과 타입 간 모순은 Rust와 TypeScript가 같은 wire path의 오류로 거부한다.

## 6. Timestamp

기본 display와 `Ctrl+C` copy value는 같다.

```text
원본:       2025-12-18T10:23:34.123456+09:00
화면:       2025-12-18 10:23:34.123456
기본 복사:  2025-12-18 10:23:34.123456
```

- timezone 표기, `T`, `Z`, `[unit=ns]`는 넣지 않는다.
- timezone의 wall-clock을 다른 timezone으로 바꾸지 않는다.
- source unit/timezone은 cell detail에 보존한다.
- 원본에 소수초가 없으면 trailing dot을 표시하지 않는다.

Cell detail 예시:

```text
Displayed:   2025-12-18 10:23:34.123456
Copy value:  2025-12-18 10:23:34.123456
Type:        timestamp
Unit:        µs
Timezone:    +09:00
Raw:         2025-12-18T10:23:34.123456+09:00
```

## 7. Copy action

- `Ctrl+C`와 `Copy`: 활성 preset과 타입별 기본 copy 표현을 사용한다.
- `Copy displayed value`: grid에 보이는 formatting을 사용한다.
- `Copy raw/canonical value`: annotation이 아니라 source 의미를 보존하는 canonical/raw 표현을 사용한다.
- `Copy with headers`: 선택 범위 copy 표현과 동일한 값 규칙에 header만 추가한다.
- copy 시작 뒤 설정이 바뀌어도 시작 시점 snapshot을 끝까지 사용한다.

메뉴 label은 representation 차이를 사용자가 예측할 수 있게 tooltip/설명을 제공한다. timestamp는
기본 copy와 displayed가 기본 설정에서 같을 수 있지만 두 경로의 의미와 테스트는 분리한다.

## 8. 경계 탐색 피드백

- 빠른 O(1)/cache hit 탐색은 별도 progress를 깜박이지 않는다.
- cold scan이 짧은 임계값을 넘으면 grid에 귀속된 `경계 찾는 중` 상태와 cancel을 표시한다.
- 완료되면 active cell을 target page 안으로 scroll하여 focus outline이 반드시 보이게 한다.
- 실패/cancel 시 선택과 scroll은 이동 전 상태를 유지한다.
- Ctrl+Alt는 전체 끝 이동임을 shortcut 도움말에 Ctrl과 구분해 표시한다.

## 9. Query와 디스크 경고

잘못된 문구:

```text
이 작업에는 26 GB가 필요합니다.
```

대신 가능한 값을 구분한다.

```text
예상 임시 데이터: 약 1.4 GB
디스크 안전 여유: 5 GB
작업 hard limit: 10 GB
```

추정이 불가능하면 `임시 데이터는 작업 중 증가할 수 있으며 10 GB에서 중단됩니다`라고 표시한다.
안전 여유는 데이터가 차지할 예상 용량으로 표현하지 않는다. filter/sort progress, cancel과 실패는 활성
문서에만 귀속한다.

## 10. Responsive와 접근성

- Settings와 cell detail은 800x600에서도 footer action과 scroll 영역이 잘리지 않는다.
- 2줄 cell의 selection/focus outline은 cell 전체 경계와 일치한다.
- timestamp raw/display label은 screen reader가 구분할 수 있는 accessible name을 가진다.
- loading/progress/empty/invalid 상태를 색상만으로 구분하지 않는다.
- 세 viewport screenshot과 실제 Tauri 100%/150% DPI 검증을 수행한다.

## 11. UI 완료 조건

- 5.85M/10M 마지막 행, 2줄 string, timestamp와 settings가 세 viewport에서 geometry PASS다.
- Ctrl 계열 탐색 뒤 active cell이 viewport 안에 있고 논리 target과 focus가 일치한다.
- display 변경과 세 copy action의 clipboard 결과가 계약과 일치한다.
- header separator 더블클릭과 column menu auto-fit이 같은 너비를 만들고 backend scan을 시작하지 않는다.
- 실제 WebView2와 Windows clipboard 항목이 별도로 검증된다.
