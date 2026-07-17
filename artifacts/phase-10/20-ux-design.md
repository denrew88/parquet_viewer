# Phase 10 OES HDF5 UX 설계

- 상태: 구현 전 확정
- 원칙: 새 화면을 만들지 않고 기존 generic tabular UI를 재사용한다.

## 1. 파일 열기

- native dialog의 aggregate Data files와 별도 `OES HDF5` filter에 `h5`, `hdf5`를 표시한다.
- `.oes.h5`는 `.h5` 후보로 처리한다.
- drop 안내의 지원 형식 목록은 runtime descriptor에서 `CSV, Parquet, OES HDF5`로 표시한다.
- non-OES HDF5는 “HDF5 파일이지만 필요한 time, wavelength, intensity 구조가 없습니다”처럼 사용자가
  조치할 수 있는 오류로 표시한다.
- Windows `.h5/.hdf5` association은 노출하거나 설치하지 않는다.

## 2. Data 화면

- 첫 고정 논리 열은 `time`이다.
- 이후 열은 wavelength canonical label이며 stored order를 유지한다.
- 열 이름 충돌 suffix는 Schema, grid, Copy with headers에서 동일하다.
- 최초 화면은 `time`을 포함한 최대 64열만 요청하고 열 가상화로 다음 wavelength window를 읽는다.
- intensity는 기존 정수 cell, 음수, hover, 선택, 전체 값 UI를 그대로 사용한다.
- OES 전용 toolbar나 dataset selector를 추가하지 않는다.
- `queryProvider`가 없으므로 filter/search/sort control은 숨긴다. 비활성 control을 남겨 혼동시키지 않는다.

## 3. Schema와 Metadata

Schema는 다음을 표시한다.

- `time`: 실제 HDF5 axis logical/physical type
- 각 intensity 열: logical `Int32`, physical HDF5 int32, 원래 wavelength label과 ordinal

generic Metadata section은 file size, row/column count에 더해 다음 bounded 값만 표시한다.

- intensity shape, dtype와 chunk shape
- filter ID와 확인 가능한 codec
- time/wavelength storage가 root attribute라는 사실
- decoded axis byte와 적용된 상한

unknown attribute와 전체 HDF5 tree는 표시하지 않는다. metadata section table도 4,096행 전체를 한 번에
DOM으로 만들지 않고 요약과 truncation을 사용한다.

## 4. Selection과 copy

- 기존 논리 좌표, mouse/keyboard selection과 page 경계 copy를 그대로 사용한다.
- time과 intensity를 함께 선택하면 표에 보이는 순서 그대로 TSV를 만든다.
- Copy with headers는 unique public wavelength name을 사용한다.
- 큰 범위는 기존 soft/hard limit, progress와 cancel 계약을 유지한다.
- context menu와 실제 Windows clipboard는 CSV/Parquet와 같은 pipeline을 사용한다.

## 5. 상태와 오류

- loading은 HDF5 open/axis validation과 첫 projected page를 구분할 수 있는 일반 상태 문구를 사용한다.
- axis/chunk/process 상한 오류는 필요한 크기와 제품 상한을 제한된 숫자로 설명한다.
- filter/plugin, external/VDS와 unsupported layout은 손상 파일과 구분한다.
- 오류가 발생해도 다른 tab과 기존 활성 문서는 유지한다.

## 6. Responsive와 접근성

- 긴 wavelength header는 기존 ellipsis와 전체 값 확인 수단을 사용한다.
- `OES HDF5`, Schema type, Metadata label은 screen reader가 읽을 수 있는 text를 갖는다.
- query control이 없는 상태에서도 Data toolbar의 tab order와 focus 이동에 빈 gap을 만들지 않는다.
- 1440x900, 1024x768, 800x600에서 wide grid, error, Schema/Metadata를 확인한다.
- 실제 Tauri 100%/150% DPI와 시스템 clipboard는 Browser 증거와 분리한다.

## 7. UI 완료 조건

- format별 React component 분기 없이 browser mock OES가 generic UI에 표시된다.
- 열 가상화 DOM 수와 최초 backend projection이 4,096 wavelength와 무관하게 bounded다.
- 세 viewport interaction/geometry/screenshot과 실제 Tauri open/copy가 PASS다.
