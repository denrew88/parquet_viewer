# Phase 10 OES HDF5 기술 설계

- 상태: 구현 전 확정 설계
- 기준 범위: `00-scope.md`
- 테스트 계약: `10-test-plan.md`

## 1. Dependency와 build 모델

Root가 구현 시작 시 shared manifest를 순차 갱신한다.

```toml
hdf5 = { package = "hdf5-metno", version = "=0.13.0", features = ["static", "blosc-zstd"] }
ndarray = "0.17"
```

고수준 crate가 dynamic plugin 제어 API를 제공하지 않으면 같은 resolved version의
`hdf5-metno-sys`를 직접 dependency로 선언한다. 이는 별도 runtime을 추가하는 것이 아니라 이미
선택한 HDF5 binding의 좁은 초기화 API를 사용하는 것이다.

- `static`은 HDF5 C를 source build하고 실행 파일에 정적으로 링크한다.
- `blosc-zstd`는 c-blosc와 Zstd decoder를 정적으로 포함하고 filter 32001을 등록한다.
- build prerequisite는 stable Rust MSRV, Windows MSVC C++ Build Tools/SDK와 CMake다.
- 10A spike에서 cold build shell의 tool version, Cargo feature tree, lock diff, build 시간과
  release/NSIS 크기 delta를 기록한다.
- CMake 부재, static link 실패, filter availability 실패는 production handler 구현 전에 FAIL이다.

## 2. Module 경계

```text
data/oes_hdf5_source.rs
  - OesHdf5FormatHandler
  - OesHdf5Source
  - OesAxisValue / OesColumnBinding
  - structure validation
  - hyperslab page/projection

platform/hdf5_runtime.rs
  - process-once HDF5 initialization
  - dynamic plugin loading disable
  - static Blosc availability check

data/registry.rs
  - OES handler 등록만 수행

domain/models.rs, domain/error.rs
  - DataFormat::OesHdf5와 typed OES error/diagnostic
```

`DocumentRegistry`, selection, copy, grid와 query executor에는 OES variant 분기를 추가하지 않는다.
공통 initial projection을 제한하는 변경만 format-neutral하게 수행한다.

## 3. Process 초기화

`OnceLock<Result<...>>` 기반 초기화는 첫 HDF5 file open 전에 한 번만 실행한다.

1. HDF5 dynamic plugin loading state를 0으로 설정해 filter/VOL/VFD plugin을 모두 차단한다.
2. 정적 Blosc filter가 decode 가능 상태인지 확인한다.
3. HDF5 내부 진단 출력 policy를 설정한다.
4. 실패 결과를 저장해 이후 open이 같은 typed runtime error를 반환하게 한다.

문서 close에서 global filter를 unregister하거나 `H5close`를 호출하지 않는다. `hdf5-metno`의
process-global lock을 존중하고, Blosc thread 수를 바꾼다면 app init에서 bounded 값으로 한 번만
설정한다.

## 4. Open과 구조 검증 순서

1. 기존 canonical path, regular-file, read-only open 검증을 수행한다.
2. HDF5 8-byte signature를 확인한다.
3. root의 `time`, `wavelength` attribute와 local hard-linked `/intensity` dataset을 찾는다.
4. soft/external link, VDS, external storage를 I/O 전에 거부한다.
5. intensity rank, dtype, shape, chunk layout, filter pipeline을 확인한다.
6. axis dataspace와 datatype으로 element count와 decoded upper bound를 checked arithmetic으로 계산한다.
7. 파일·process axis budget lease를 얻은 뒤 axis를 전체 읽는다.
8. UTF-8, finite wavelength, shape parity와 column name binding을 검증한다.
9. bounded `FileSummary`, Schema와 generic format details를 만든다.

검증 실패 시 열린 handle과 budget lease를 RAII로 해제한다. unknown root object나 attribute는 재귀
탐색하지 않는다.

## 5. Axis 표현과 column binding

```text
OesAxisValue = Int(String) | UInt(String) | Float(canonical String) | Utf8(String)

OesColumnBinding
  public_name: String
  original_label: String
  wavelength_index: usize
```

숫자를 JavaScript number로 보내지 않고 canonical 문자열과 `ValueKind`를 사용한다. column name
collision map은 `time`을 이미 사용 중인 이름으로 넣고 wavelength 저장 순서대로 public name을 만든다.
projection lookup은 `HashMap<public_name, binding>`을 사용하며 public name에서 wavelength 숫자를
역파싱하지 않는다.

`time` attribute는 source가 보유한 bounded array에서 page row 범위만 DTO로 변환한다. optional
datetime hint가 유효한 경우에만 Timestamp display를 만들며 원래 int64 나노초를 보존한다.

## 6. Page와 projection algorithm

`read_page_projected(offset, limit, columns)`은 다음 순서로 동작한다.

1. `limit <= 200`, projection `<= 64`, checked `offset + limit`을 검증한다.
2. `None`은 OES source 내부에서 bounded initial projection으로 바꾸며 전체 열 의미로 사용하지 않는다.
3. public column name을 `time` 또는 intensity ordinal로 resolve하고 unknown/duplicate를 거부한다.
4. 요청 행을 dataset 끝으로 clamp한다.
5. time-only 요청이면 intensity dataset I/O 없이 결과를 만든다.
6. intensity ordinal을 정렬하고 인접 범위를 coalesce한다.
7. 각 범위에 `read_slice_2d` hyperslab을 사용하고 선택한 row/column 외 matrix를 읽지 않는다.
8. 결과를 원래 projection 순서로 재배열하고 `DataValue`로 변환한다.
9. 기존 `DataPage` 상한과 cache key에 실제 projection을 기록한다.

HDF5 chunk가 64 MiB decoded 상한을 넘으면 첫 page를 읽기 전에 거부한다. HDF5 raw chunk cache는
10A/10C 측정으로 문서당 2~4 MiB 범위에서 확정하고, app page cache와 합쳐 process resource가 기존
상한을 넘지 않게 한다.

## 7. Wide source의 최초 page

현재 공통 open path의 `columns=None`이 모든 열을 뜻하면 4,096 wavelength OES에서 bounded paging을
위반한다. Phase 10은 format-neutral initial projection helper를 추가한다.

- summary schema에서 첫 최대 64개 public column name을 선택한다.
- OES에서는 `time`과 이후 intensity 열이 포함된다.
- `PreparedSource`와 page cache key에 실제 projection을 저장한다.
- frontend가 열 가상화를 이동하면 새로운 최대 64열 projection을 요청한다.
- CSV/Parquet의 64열 이하 동작은 기존과 동일하고 wide fixture로 회귀를 검증한다.

## 8. Concurrency, cache와 수명주기

- HDF5 I/O는 UI thread와 registry lock 밖의 blocking worker에서 실행한다.
- `OesHdf5Source`가 read-only file/dataset handle과 axis budget lease를 소유한다.
- `hdf5-metno` global lock 때문에 같은 process의 HDF5 decode가 직렬화될 수 있으므로 8-tab과
  2~5-process release benchmark로 throughput과 deadlock을 검증한다.
- 빠른 page 변경과 close는 기존 document/session generation으로 늦은 결과를 폐기한다.
- HDF5 slice 자체를 강제로 중단할 수 있다고 가정하지 않는다. page와 chunk 상한으로 한 번의 native
  call 시간을 제한하고 close 후 결과를 적용하지 않는다.
- close/replace 시 source Arc와 file/dataset handle은 registry lock 밖에서 drop한다.

## 9. Query와 UI 계약

Phase 10 OES source는 `query_source_spec`을 구현하지 않는다. 현재 DuckDB provider 계약은 query가
참조하는 열 projection을 source에 전달하지 않아 wide matrix 전체를 준비할 위험이 있다.
`queryProvider` capability를 노출하지 않고 filter/search/sort UI를 숨긴다.

향후 OES query는 별도 계약에서 `QueryPrepareContext.required_columns`, bounded HDF5 row batch,
cancel/progress와 spill parity를 먼저 설계한 뒤 추가한다. 이번 Phase에서 임시 전체 materialize나
page-only query를 만들지 않는다.

## 10. Error 계약

최소한 다음 원인을 구별한다.

- HDF5 signature가 아님
- HDF5지만 OES 필수 attribute/dataset 누락
- unsupported axis datatype 또는 invalid UTF-8
- intensity rank/dtype/shape/chunk/filter 불일치
- axis 길이와 matrix shape 불일치
- axis, column, chunk 또는 process resource 상한 초과
- external/VDS/dynamic filter 등 보안상 지원하지 않는 storage
- compressed chunk 손상 또는 decode 실패
- runtime static filter 초기화 실패

HDF5 내부 stack 전체를 사용자 메시지에 노출하지 않는다. 진단 code와 제한된 원인을 보존하고 file
path와 민감한 external target을 과도하게 출력하지 않는다.

## 11. Packaging 계약

- release import/payload에 `hdf5.dll`, `blosc.dll`, `zstd.dll`, Python DLL이 없어야 한다.
- `PATH`, Conda와 `HDF5_PLUGIN_PATH`를 제거한 환경에서 fixture를 읽는다.
- third-party license notice를 repository와 NSIS 설치 payload에 포함한다.
- native dialog/drop/startup에는 registry descriptor를 사용한다.
- `.h5/.hdf5` file association은 추가하지 않는다.
- 같은 OES 파일을 2~5개 독립 release process가 동시에 읽어도 process-global state가 섞이지 않는다.

## 12. 설계 완료 gate

- 10A에서 static build, plugin lockdown, actual Blosc fixture decode와 clean runtime을 입증한다.
- 10B에서 structure/axis/name binding contract가 unit fixture로 고정된다.
- 10C에서 page/projection/cache와 wide initial page가 전체 materialize 없이 검증된다.
- 10D에서 generic UI, dialog/drop/startup/copy가 실제 Tauri에서 검증된다.
- 10E에서 release/NSIS, security, performance, soak와 기존 format 회귀가 독립 PASS다.
