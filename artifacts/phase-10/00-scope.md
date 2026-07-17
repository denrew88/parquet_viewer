# Phase 10 확정 범위: OES HDF5 읽기 지원

- 상태: 구현 완료, 필수 gate BLOCKED
- 작성일: 2026-07-17
- 선행 조건: Phase 9의 `FormatRegistry`, `TabularSource`, generic Metadata와 다중 문서 계약
- 의존성 선택 승인: 2026-07-17 사용자 승인

이 Phase는 범용 HDF5 탐색기를 만들지 않는다. 루트의 `time`, `wavelength`, `intensity`만 사용하는
현재 OES 행렬 형식을 읽기 전용 tabular source로 추가한다. 실제 데이터 형식이 달라지면 추측으로
호환 범위를 넓히지 않고 새 fixture와 사용자 확인을 받아 계약을 갱신한다.

## 1. 목표

1. `.oes.h5`, `.h5`, `.hdf5` 파일에서 현재 OES 구조를 판별하고 안전하게 연다.
2. `time`을 첫 열로, 각 `wavelength`를 intensity 열로 표시한다.
3. `intensity` 전체를 materialize하지 않고 행 page와 열 projection만 HDF5 hyperslab으로 읽는다.
4. 기존 Data, Schema, generic Metadata, 가상화, 선택과 clipboard를 포맷별 UI 분기 없이 재사용한다.
5. Blosc filter ID 32001과 Zstd로 압축된 실제 Python `hdf5plugin` 파일을 release/NSIS에서 읽는다.
6. 정적 HDF5 배포, 동적 plugin 차단, 외부 파일 참조 거부와 명시적 메모리 상한을 검증한다.

## 2. 입력 형식 계약

파일 루트에 다음 세 객체가 있어야 한다.

```text
/
├── @time             1-D numeric 또는 UTF-8 attribute
├── @wavelength       1-D numeric 또는 UTF-8 attribute
└── intensity         2-D int32 chunked dataset [time, wavelength]
```

- `intensity.shape[0] == len(time)`이고 `intensity.shape[1] == len(wavelength)`이어야 한다.
- `intensity`는 2차원 `int32`, chunked layout, Blosc v1 filter ID `32001`을 사용해야 한다.
- 현재 기준 codec은 Zstd다. 정적 decoder로 읽을 수 없는 codec이나 filter pipeline은 typed error다.
- `time`과 `wavelength`는 signed/unsigned integer, float 또는 fixed/variable UTF-8 문자열을 허용한다.
- 숫자 wavelength의 NaN과 infinity, 잘못된 UTF-8, compound/reference axis는 거부한다.
- wavelength의 저장 순서는 그대로 보존한다. 오름차순 여부는 열기 조건이 아니다.
- 행 수 0은 허용하지만 wavelength는 1개 이상이어야 한다.
- `oes_profile`, schema version, 생성 시각, `metadata_json`, compression 설명 등 다른 attribute는
  없어도 된다. 알 수 없는 attribute와 group은 열기 결과를 바꾸지 않고 읽지 않는다.
- 유효한 `time_kind=datetime64ns`와 `time_timezone`이 있으면 timestamp 표시 hint로만 사용한다.
  hint가 없거나 잘못됐으면 원래 HDF5 primitive 타입으로 표시하며 파일을 거부하지 않는다.
- `time`/`wavelength`가 dataset인 변형, 다른 intensity path·rank·dtype는 이번 계약에 포함하지 않는다.

## 3. 표 매핑

`intensity` shape가 `R x C`이면 viewer 표는 `R`행, `C + 1`열이다.

| Viewer 요소       | OES 원본                                 |
| ----------------- | ---------------------------------------- |
| 첫 열 `time`      | `time[row]`                              |
| intensity 열 제목 | `wavelength[column]`의 canonical display |
| intensity 셀      | `intensity[row, column]`                 |

- time integer는 `ValueKind::Int`, float는 `Float`, UTF-8은 `String`으로 전달한다.
- datetime hint가 유효한 int64 time은 나노초 정밀도의 `Timestamp`로 전달한다.
- intensity는 `ValueKind::Int`와 정확한 10진 문자열로 전달해 음수와 `i32` 경계를 보존한다.
- 숫자 wavelength는 round-trip 가능한 가장 짧은 10진 문자열을 열 이름으로 사용한다.
- 빈 wavelength label은 `wavelength_<1-based ordinal>`로 대체한다.
- `time`, 중복 label, `1`과 `1.0`처럼 canonical 문자열이 충돌하면 저장 순서대로 ` [2]`, ` [3]`
  suffix를 붙인다. projection은 이름을 다시 파싱하지 않고 내부 ordinal binding을 사용한다.
- 원래 wavelength 값과 ordinal은 Schema와 generic Metadata에 보존한다.

## 4. Format registry와 capability

```text
id: oesHdf5
displayName: OES HDF5
extensions: [h5, hdf5]
mimeTypes: [application/x-hdf5]
capabilities: [typedSchema, columnProjection]
```

`.oes.h5`는 compound extension을 descriptor에 넣지 않고 마지막 suffix인 `h5`로 처리한다. extension은
후보 선택에만 사용하며 HDF5 signature와 필수 세 객체 검증이 최종 판정이다. 정상 HDF5라도 이 OES
구조가 아니면 `InvalidOesHdf5` 계열 오류를 반환한다.

첫 구현은 `queryProvider`, `multipleDatasets`, `rowGroups`, `filterPushdown`을 제공하지 않는다.
따라서 전체 filter/search/sort control은 capability에 따라 숨기고, 직접 query 요청은 문서를 유지한 채
typed unsupported error를 반환한다. Data paging, Schema, Metadata, selection과 copy는 지원한다.

## 5. 명시적 상한

- page limit: 기존 최대 200행
- projection: time을 포함해 요청당 최대 64열
- wavelength: 최대 4,096개
- decoded `time` + `wavelength` attribute: 파일당 최대 128 MiB
- process-wide 활성 OES axis memory: 최대 256 MiB
- UTF-8 axis element 하나: 최대 1 MiB, 위 전체 axis 상한을 동시에 적용
- decoded HDF5 chunk: 최대 64 MiB
- page cache: 기존 문서당 8 pages, process 64 pages 또는 추정 256 MiB 중 먼저 도달하는 상한

HDF5 attribute는 부분 조회가 불가능하므로 `time`과 `wavelength`는 전체를 읽어야 한다. 이 구조적
한계를 숨기지 않고 open 전에 dataspace, datatype과 checked arithmetic으로 가능한 크기를 계산한다.
상한을 넘으면 allocation을 시도하지 않고 typed resource-limit error를 반환한다. 향후 axis가 dataset인
형식으로 바뀌면 사용자 확인 후 별도 계약에서 axis paging을 추가한다.

64개를 넘는 wide source의 최초 page는 모든 열을 요청하지 않는다. 공통 open pipeline이 `time`과
첫 intensity 열 window를 합쳐 최대 64열만 명시적으로 projection하고, 이후 열 가상화 요청도 같은
상한을 사용한다.

## 6. 보안과 native runtime

- `hdf5-metno 0.13.0`의 정적 HDF5와 `blosc-zstd`, 호환 `ndarray 0.17`을 사용한다.
- HDF5 동적 plugin loading은 프로세스 최초 HDF5 open 전에 모두 비활성화한다.
- 정적으로 등록된 Blosc decoder availability와 실제 filter 32001 decode를 startup/test에서 확인한다.
- `intensity`는 루트의 local hard-linked dataset이어야 한다. soft/external link, VDS, external storage는
  외부 경로를 읽기 전에 거부한다.
- source는 read-only로 열며 close 시 file/dataset handle만 drop한다. process-global `H5close`는 호출하지 않는다.
- HDF5 C 진단은 제한된 typed error로 변환하고 반복 stderr 폭주, panic과 unchecked allocation을 막는다.
- clean Windows에서 Python, system HDF5, Conda, `HDF5_PLUGIN_PATH`, loose HDF5/Blosc/Zstd DLL 없이
  release와 NSIS 설치본이 실제 fixture를 읽어야 한다.
- HDF5, hdf5-metno, c-blosc, Zstd의 정확한 lock version과 재배포 고지를 감사하고 설치본에 포함한다.

이번 요청은 위 dependency 선택을 문서화하도록 승인한 것이다. 실제 manifest와 lockfile 변경은 Phase 10
구현 요청에서 Root가 단독으로 수행한다.

## 7. 파일 열기 진입점

- native dialog, OS drag-and-drop, startup argv와 직접 경로 열기는 `.h5`, `.hdf5`를 지원한다.
- `sample.oes.h5`, 대소문자 suffix, 공백·한글 경로는 같은 handler로 처리한다.
- CSV/Parquet/OES/invalid HDF5 혼합 batch는 기존 입력 순서와 부분 성공 계약을 유지한다.
- Windows 정적 file association은 이번 Phase에서 추가하지 않는다. `.oes.h5`만 선택적으로 연결할 수
  없고 `.h5` 전체를 선점하기 때문이다. 사용자가 broad `.h5/.hdf5` association을 별도로 승인하면
  후속 변경으로 추가한다.

## 8. 제외 범위

- 범용 HDF5 tree/group/dataset browser
- 여러 dataset 선택과 `multipleDatasets` UI
- `time`/`wavelength` dataset 변형 또는 다른 path 자동 탐색
- intensity의 int32 이외 dtype와 2차원 이외 rank
- OES filter/search/sort/query provider
- writer, 편집, 변환, export
- remote HDF5, external link, VDS, external raw storage
- runtime HDF5 filter/VOL/VFD plugin과 system HDF5 의존
- `.h5/.hdf5` Windows file association

## 9. 완료 조건

1. `10-test-plan.md`의 OES-FMT/AXIS/PAGE/SEC/INT/PERF/UI/PKG 필수 항목이 PASS다.
2. Python `hdf5plugin`이 만든 Blosc 32001/Zstd golden fixture를 debug, release와 NSIS에서 읽는다.
3. wide/tall fixture의 open과 page가 intensity 전체를 materialize하지 않고 상한 안에서 동작한다.
4. CSV/Parquet open, page, query, selection, copy와 packaging 회귀가 없다.
5. dynamic plugin과 외부 HDF5 참조가 차단되고 원본 hash, size, mtime이 변하지 않는다.
6. Browser 세 viewport와 실제 Tauri dialog/drop/startup/clipboard 증거가 존재한다.
7. clean installer, 150% DPI처럼 필수 환경에서 실행하지 못한 항목이 남으면 Phase를 완료로 표시하지 않는다.
