# Phase 11 확정 범위: OEF H5 v3와 대용량 탐색·값 표현 안정화

- 상태: 진행 중
- 작성일: 2026-07-20
- 선행 조건: Phase 9의 query/settings, Phase 10의 정적 HDF5/Blosc source와 공통 grid
- 사용자 확정: OEF H5 v3 실제 구조, Blosc-Zstd, 타입별 전역 표시 설정

이 Phase는 이미 확인된 실제 파일 계약과 대용량 회귀를 함께 바로잡는다. 범용 HDF5 탐색기,
데이터 편집이나 charting은 추가하지 않는다. Phase 10 산출물은 당시 구현 기록으로 보존하고,
현재 제품 계약은 이 문서와 `docs/PROJECT_SPEC.md`의 12절을 따른다.

## 1. 목표

1. 실제 `oefh5` format version 3 파일을 정확한 dataset/transpose 계약으로 읽는다.
2. 5,850,000행 Parquet를 WebView 최대 scroll 높이와 무관하게 실제 마지막 행까지 탐색한다.
3. filter/sort가 전체 표시 문자열을 중복 materialize하지 않고 typed source에서 bounded하게 동작한다.
4. 마지막 행이 가로 scrollbar에 가려지지 않도록 grid geometry를 수정한다.
5. `Ctrl+화살표`가 빈 셀 경계를 보존하면서 중간 page를 순차 로딩하지 않도록 가속한다.
6. raw typed value, 화면 표시와 기본 복사 표현을 분리하고 타입별 전역 표시 설정을 제공한다.
7. 열 header 경계 더블클릭과 접근 가능한 메뉴로 현재 로딩·캐시된 표시값에 너비를 자동 맞춘다.

## 2. OEF H5 v3 입력 계약

루트에는 다음 attribute와 dataset이 있어야 한다.

```text
/
├── @format          scalar UTF-8 string: "oefh5"
├── @format_version  scalar integer: 3
├── @shape           integer[2]: [n_time, n_wavelength]
├── time             1-D dataset [n_time]
├── wavelength       1-D dataset [n_wavelength]
└── oes              2-D dataset [n_wavelength, n_time]
```

- `shape` attribute의 순서는 항상 `(n_time, n_wavelength)`이다.
- `/time`과 `/wavelength`는 integer, float 또는 string 1차원 dataset이다.
- `/oes`는 `int32` 또는 `int64` 2차원 dataset이다.
- `/oes` 저장축은 wavelength, time 순서다. viewer는 이를 transpose하여 time을 행,
  wavelength를 열로 표시한다.
- `/time.len == n_time`, `/wavelength.len == n_wavelength`,
  `/oes.shape == [n_wavelength, n_time]`을 모두 검증한다.
- chunk shape의 축별 길이나 대표 shape를 고정하지 않고 축 의미도 추론하지 않는다. 다만 HDF5가
  filter decode 전에 chunk 전체를 메모리에 풀어야 하므로 decoded chunk가 64 MiB를 넘으면 shape와
  필요한 byte를 포함한 typed resource-limit 오류로 거부한다. 상한 안의 어떤 유효한 chunk shape도
  같은 논리 결과를 내야 한다.
- 대표 압축은 HDF5 filter ID `32001`의 Blosc이며 내부 codec은 Zstd다. 정적으로 사용할 수 없는
  filter 또는 codec은 typed unsupported-compression 오류로 거부하고 동적 plugin은 로딩하지 않는다.
- 추가 attribute는 열기 필수 조건이 아니며 알 수 없는 값은 무시한다.
- root의 local hard-linked dataset만 허용한다. soft/external link, VDS와 external storage는 거부한다.

표 매핑은 다음과 같다.

| Viewer 요소 | OEF H5 원본 |
| --- | --- |
| 첫 열 `time` | `/time[t]` |
| intensity 열 제목 | `/wavelength[w]`의 canonical 문자열 |
| intensity 셀 | `/oes[w, t]` |

## 3. 빈 셀 계약

- `DataValue.state`가 `null` 또는 `empty`일 때만 경계 탐색에서 빈 셀이다.
- string `/time`의 실제 빈 문자열 `""`은 `empty`다.
- integer/float `/time`과 `/wavelength` 값은 유효한 값이면 occupied다.
- `int32`/`int64` `/oes`는 별도 sentinel 계약이 없으므로 모든 셀이 occupied다.
- 문자열 안의 문자 두 개 `\`와 `n`은 실제 LF가 아니며 개행이나 빈 셀로 변환하지 않는다.
- NaN과 infinity의 허용 여부는 axis dtype validation에서 명시적으로 판정하며 empty로 취급하지 않는다.

## 4. 대용량 grid와 마지막 행

- 논리 행 수에 고정 row 높이를 곱한 값을 하나의 DOM `scrollHeight`로 만들지 않는다.
- browser/WebView scroll surface는 안전한 유한 높이 안에 두고, 논리 row offset과 물리 scroll offset을
  분리하는 segmented 또는 anchored virtualization을 사용한다.
- 5,850,000행뿐 아니라 10,000,000행 fixture에서도 처음, 임의 위치와 실제 마지막 행을 정확히 매핑한다.
- scroll recenter 중 선택, active cell, page, header와 visible row가 튀거나 stale page로 바뀌지 않는다.
- 실제 마지막 행의 border와 내용 전체는 가로 scrollbar 위에 표시되어야 한다. viewport 높이 계산은
  header, border와 scrollbar가 차지하는 공간을 포함한다.
- string cell은 실제 LF/CRLF를 줄바꿈으로 렌더링하고 모든 data row는 최대 2줄의 같은 고정 높이를
  사용한다. wrap 후 2줄을 넘는 내용은 line clamp/ellipsis로 줄이고 전체 값 보기를 제공한다.
- 열 header 오른쪽 resize separator를 더블클릭하면 header와 해당 열의 현재 로딩·캐시된 display
  문자열을 기준으로 너비를 자동 맞춘다. 실제 개행이 있는 문자열은 가장 긴 논리 줄을 측정한다.
- auto-fit은 현재 grid의 실제 header/cell font, padding, border와 sort/filter action 공간을 포함하고
  기존 `GRID_MIN_COLUMN_WIDTH=80`, `GRID_MAX_COLUMN_WIDTH=800` 범위로 clamp한다.
- auto-fit은 backend page나 전체 column scan을 시작하지 않으며 계산 시점에 메모리에 있는 값만 쓴다.
  이후 page나 display 설정이 바뀌어도 layout을 자동 변경하지 않고 다시 실행할 때만 재계산한다.
- 수동 resize는 auto-fit 결과를 덮어쓸 수 있고 결과 너비는 기존 document별 column state에 보존한다.
  mouse를 쓰지 않는 사용자를 위해 column menu에 `열 너비 자동 맞춤` action을 함께 제공한다.

## 5. 경계 탐색 단축키

- `Ctrl+화살표`와 `Ctrl+Shift+화살표`는 Excel 방식의 occupied/empty 경계를 유지한다.
- frontend는 200행 page를 반복 호출하지 않고 backend에 현재 좌표, 방향, source/query identity를
  한 번 전달한다. backend는 목표 논리 좌표만 반환한다.
- frontend는 반환된 target이 cache miss일 때 target page를 최대 한 번 읽는다.
- `Ctrl+Alt+화살표`와 Shift 조합은 값 상태를 검사하지 않고 표의 실제 끝으로 이동한다.
- OEF H5의 numeric time과 `/oes`처럼 빈값이 불가능한 축은 O(1)로 끝 좌표를 계산한다.
- string time, CSV text, Parquet string처럼 empty가 가능한 source는 source-native vector/block scan과
  경계 cache를 사용한다. 공통 200행 `read_page` loop는 fallback으로도 사용하지 않는다.
- 새 selection, focus 이탈, source/query 교체와 뒤따른 navigation은 기존 cancellation/identity 계약을
  유지한다.

## 6. Parquet filter/sort와 임시 공간

- filter/search/sort는 현재 page가 아닌 5,850,000행 전체 source에 적용한다.
- Parquet scan에는 가능한 predicate와 column projection을 push down한다.
- query preparation은 모든 source column의 표시 문자열과 raw 문자열 복사본을 임시 결과에 저장하지
  않는다. 결과 index는 source row identity와 predicate/sort/page에 필요한 최소 typed 값만 가진다.
- 안정 정렬은 원본 row identity를 최종 tie-breaker로 사용하고 nulls-last 계약을 유지한다.
- result page는 요청 projection만 bounded batch로 읽고 `DataValue`를 그때 구성한다.
- process query temp hard cap 10 GiB는 유지한다. 디스크 안전 여유는 기본 5 GiB의 별도 정책으로
  취급하며 volume 크기의 10%를 데이터 필요량처럼 경고하지 않는다.
- UI는 `예상 임시 데이터`, `안전 여유 공간`, `hard cap`을 서로 다른 값과 문구로 표시한다.
  추정할 수 없는 경우 거짓 정밀도의 byte 값을 만들지 않고 상한 기반 문구를 사용한다.
- 취소, 실패, query 교체와 tab close에서 결과 index와 spill을 정리한다.
- 기존 Phase 9 release 예산을 유지한다: simple filter 첫 결과 10초 이하, stable 3-column sort
  120초 이하, query peak RSS 1.5 GiB 이하, process temp 10 GiB 이하. 결과 준비 뒤 random page는
  p95 1초 이하를 목표로 한다.

## 7. Raw, display와 copy 표현

값 모델은 다음 세 표현을 구분한다.

1. source/raw: 원본 논리 값, 정밀도, 단위, timezone과 CSV 원문
2. display: 타입별 전역 설정으로 grid에 렌더링하는 값
3. copy: 활성 copy 설정 snapshot으로 직렬화하는 값

64비트 정수, unsigned, decimal, timestamp는 JavaScript `number`로 축소하지 않는다. binary와 긴 nested
값은 page에서 bounded preview를 사용하고 전체 raw 값은 명시적 전체 값 요청이나 copy pipeline에서만
읽는다. 필터와 정렬은 display 문자열이 아니라 raw typed value를 사용한다.

설정은 app-global, logical-type 단위로 적용하며 첫 구현에서 column override를 제공하지 않는다.
settings wire schema는 V3으로 올리고 유효한 V2를 기존 설정 손실 없이 atomic migration한다.

## 8. 확정 기본 표시와 복사

- Timestamp display와 기본 copy 형식은 `YYYY-MM-DD HH24:MI:SS.F...`다.
- `F...`는 source가 가진 소수초 정밀도를 보존하며 소수초가 없으면 점도 출력하지 않는다.
- display와 기본 copy에는 `T`, `Z`, timezone offset과 `[unit=ns]` 같은 annotation을 넣지 않는다.
- source timezone과 unit은 변환하거나 버리지 않고 raw metadata와 셀 상세 정보에 보존한다.
- timezone이 있는 timestamp는 그 source timezone의 wall-clock field를 사용한 뒤 timezone 표기만
  생략한다. UTC나 다른 timezone으로 암묵 변환하지 않는다.
- string의 실제 개행은 grid에서 최대 2줄로 렌더링하고 기본 copy에는 원래 개행을 보존한다.
- `Copy displayed value`와 `Copy raw/canonical value`는 context menu에서 명시적으로 구분한다.
- integer, float, decimal, Boolean, date, binary, string과 nested 값도 타입별 전역 표시 option을
  가질 수 있어야 하며 표시 변경이 raw 값, filter와 sort 의미를 바꾸지 않는다.

## 9. 제외 범위

- 범용 HDF5 tree/dataset browser와 여러 dataset 선택
- OEF H5 writer, 데이터 수정, transpose 저장 또는 export
- HDF5 dynamic filter/VOL/VFD plugin
- column별 display override
- SQL editor, aggregation, join, pivot와 charting
- 원본에 없는 결측 sentinel 추측
- named timezone을 화면이나 기본 copy에 다시 표시하는 기본값
- 전체 파일 또는 전체 column을 scan하는 exact auto-fit
- row height auto-fit과 row별 variable-height virtualization

## 10. 완료 조건

1. `10-test-plan.md`의 H5V3/VIRT/GEO/AFIT/NAV/QRY/VAL/UI/PKG 필수 테스트가 PASS다.
2. 실제 Blosc-Zstd OEF H5 v3를 transpose mapping으로 읽고 int64 정밀도를 보존한다.
3. 5,850,000행과 10,000,000행 Parquet의 실제 마지막 행을 완전히 표시하고 선택·복사한다.
4. 대용량 Parquet filter/sort가 정확하며 전체 표시/raw 문자열 materialization과 26 GiB 오인 경고가 없다.
5. `Ctrl+화살표`가 empty 경계를 보존하고 중간 page 요청 없이 합의된 release 성능 예산을 만족한다.
6. timestamp, multiline string과 각 scalar 타입의 raw/display/copy 구분 및 settings V3 migration이 검증된다.
7. 세 viewport, 실제 Tauri WebView2 100%/150% DPI와 Windows clipboard 증거가 존재한다.
8. 실행하지 못한 필수 native/installer gate가 있으면 Phase를 완료로 표시하지 않는다.
9. column auto-fit이 backend scan 없이 display 기준 80..800 px로 동작하고 manual resize·문서 상태를 보존한다.
