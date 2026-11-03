# 성능을 유지하면서 크기를 줄이는 후보

아이디어 검토만 수행했다. 제품 코드·빌드 설정을 바꾸거나 새 최적화 빌드를 실행하지 않았다.
추천 순서는 HDF5 C 빌드 확인 → Rust LTO → Polars 로컬 CSV 경로 축소다.

후속 검증(2026-11-03): 사용자가 1번만 승인하여 HDF5 Release defaults 복구를 적용했다.
`HDF5_ENABLE_ASSERTS=OFF`는 강제 비활성화가 아니라 override 없음이며, `/DNDEBUG` 복구도 실제
변화에 포함된다. 동일 조건 제품 EXE 26.25MiB(-18.6%) 감소, H5 읽기 성능 유지와 메모리 감소를
확인했다. [별도 측정 결과](../optimizations/hdf5-msvc-release/50-results.md)를 참조한다.

## 이번에 확인한 근거

- 원본 EXE 147,984,896 B. DuckDB와 해당 query 코드를 뺀 실험본은 116,613,632 B였다.
- 과거 같은 source에서 Polars OFF/ON 차이는 65,444,352 B였다. 현재 source의 OFF 크기는 재측정해야 한다.
- 현재 Rust manifest는 기본 release profile을 사용하며 별도 LTO 설정이 없다. release 자체는 이미 opt-level=3/debug=false다.
- 기존 linker command에는 /OPT:REF,ICF가 있었다. 이를 처음 켜는 것처럼 절감량을 계산하지 않는다.
- frontend JS/CSS는 원시 합계 약0.67MB다. 148MB의 주요 축소 대상은 native/Rust 코드와 데이터다.
- DuckDB 제거본 PE .data raw size는 21,091,328 B였다. 해당 map의 0003 segment symbol 주소 간격을
  소유 object별로 대략 합산하면 HDF5가 약21,089,752 B로 압도적이었다. alias/padding 영향이 있어
  정확한 library 단독 크기나 제거 가능량은 아니다.
- HDF5 실제 생성 vcxproj의 Release Optimization 값이 비어 있고 CMAKE_C_FLAGS_RELEASE는
  `-nologo -MD -Brepro -W0`였다. 실제 CL.command.1.tlog의 C 컴파일 옵션에서도 /O1,/O2,/GF,/Gy가
  확인되지 않았다. 이름이 Release인 것만으로 C 라이브러리의 최적화가 보장되지 않는 후보다.
  HDF5 trace/debug API/assert 옵션은 이미 OFF였다. 이 발견을 곧바로 'debug 기능이 켜져 있다'로
  해석하지 않는다. 문자열 pooling과 native speed optimization의 실제 효과는 재빌드로 확인해야 한다.
- Polars 0.54.4의 streaming은 categorical feature를 켜며, polars-stream이 polars-io의 async와
  file_cache를 요구한다. file_cache는 cloud를, cloud는 object_store/reqwest/http 등을 연결한다.
  Cargo graph에 있다는 것과 최종 EXE 기여도는 같지 않으므로 map으로 확인한 뒤 제거를 설계한다.
- DuckDB Rust wrapper는 Arrow prettyprint/FFI feature를 참조한다. vscalar는 vtab-arrow와 연결되어 있다.
- 현재 제품 source에서는 DuckDB read_csv 호출이 발견되지 않았고, CSV 준비와 query input은
  준비된 Parquet를 사용한다. native CSV reader 등의 제거는 custom DuckDB build 후보이지
  공식 feature 하나로 안전하게 뺄 수 있다는 뜻은 아니다.
- commands/mod.rs는 source preparation thread의 panic을 join 오류로 받아 파일별 실패로 처리한다.
  main 전체에 panic=abort를 적용하면 이 동작이 달라진다.

HDF5 근거 경로: 기존 `artifacts/experiments/duckdb-size/without-duckdb-size-only.map` 및
`.tmp/duckdb-size-target/release/build/hdf5-metno-src-1ae455dd0adef8c3/out/build/`의 CMakeCache,
src/hdf5-static.vcxproj, src/hdf5-static.dir/Release/hdf5-static.tlog/CL.command.1.tlog.

## 실제 코드·데이터 총량을 줄이는 후보

1. **HDF5 native release flags**: /O2 중심으로 /GF 문자열 pooling, /Gy 함수별 제거가 적용되는지
   확인한다. 필요하면 /bigobj, native LTCG도 검토한다. /O1과 비교할 수 있지만 H5 성능도 측정한다.
   Polars/DuckDB 알고리즘을 바꾸지 않고 불필요한 native 부피를 줄일 가능성이 있다. 절감량은 미측정.
2. **Thin/Fat LTO**: opt-level=3은 유지하면서 codegen-units=1 및 thin/fat LTO를 비교한다.
   crate 간 중복·불필요한 코드를 줄이는 후보이며 compile/link 시간 증가를 감수한다.
   Rust LTO가 MSVC C/C++ library까지 자동 통합 최적화하는 것은 아니다.
3. **심볼·debug·경로 문자열 정리**: strip/PDB 별도 보관, source path remapping을 비교한다.
   Windows release PDB와 debug 기본값 특성상 큰 절감을 보장하지 않는다.
4. **영역별 최적화**: CSV/Polars/Parquet/압축 등 hot crate는 opt-level=3, cold crate는 s/2를 비교한다.
   전역 z는 loop vectorization에 영향을 주므로 첫 선택으로 삼지 않는다.
5. **Polars local-only fork/feature 분리**: local file의 fast reader는 유지하면서 cloud/HTTP/cache
   범용 경로를 feature로 분리한다. 현재 dependency chain은 app manifest에서 default=false만
   지정해 해결되지 않는다. upstream 변경이나 관리 가능한 작은 fork가 필요할 수 있다.
6. **Polars 미사용 실행 경로 축소**: CSV projection+file sink에서 쓰지 않는 general plan/fallback,
   join/group/sort, categorical/dtype 조합의 링크 기여도를 확인한다. 무조건 제거하지 않고 실제
   streaming planner와 writer가 필요한 타입·기능은 유지한다. 유지보수 비용이 있다.
7. **CSV 전용 병렬 converter**: Polars CSV parser/column kernels/Parquet writer만 재사용하거나
   필요한 좁은 경로를 구현해 lazy optimizer와 범용 실행기를 제외한다. SIMD 파싱, 병렬 압축,
   bounded queue·순서·cancel·raw/state를 그대로 보존해야 한다. 가장 큰 개발 작업 중 하나다.
   과거 느린 Rust 행별 루프로 되돌아가는 방식은 성능 유지 방안으로 간주하지 않는다.
8. **DuckDB Rust adapter 축소**: Unicode lowercase UDF는 유지하면서 vscalar→Arrow bridge 및
   불필요한 prettyprint 등의 기여도를 조사한다. 필요한 경우 얇은 C API wrapper로 교체한다.
   정확한 Unicode 동작·문자열 수명·callback 오류 처리는 유지한다.
9. **DuckDB custom build**: 앱이 쓰지 않는 native reader/함수/확장 구성의 등록·참조를 줄인다.
   현재 JSON/ICU 등을 이미 안 켰으므로 단순 default feature 정리의 추가 이득을 과장하지 않는다.
   고정 SQL template 전체와 precision/type 지원을 검증해야 한다.
10. **중복 구현 통합**: Apache Arrow/Parquet와 Polars 계열 reader/writer의 일부를 공유하도록
    바꾸는 큰 구조 작업. 두 Arrow 구현은 drop-in 호환이 아니며 version 숫자만 맞춰 합칠 수 없다.
11. **압축 codec 중복·feature 정리**: zstd/lz4/snap 등이 Rust·DuckDB·HDF5/Blosc 경계에서
    중복되는지 확인한다. 같은 Cargo package는 이미 공유될 수 있다. 외부 공통 native library
    build는 ABI/build 복잡성이 있다. 지원 파일의 codec을 삭제해서 줄이는 것은 기능 축소다.
12. **Tauri unused commands**: removeUnusedCommands와 실제 사용 ACL에 맞춘 plugin command
    제거를 검토한다. dialog/clipboard/native entrypoint 회귀 검증이 필요하고 이득은 엔진보다 작을 수 있다.
13. **PGO**: CSV/Parquet/H5/query/copy 등 대표 workload를 학습해 hot/cold 분리를 개선한다.
    성능 유지와 크기 균형 후보지만 PGO 자체가 반드시 크기를 줄이는 것은 아니다.
14. **native LTCG/PGO**: MSVC C/C++ dependency의 /GL,/LTCG 및 대표 workload PGO도 별도 후보다.
    toolchain 일치와 native 오류/예외 동작 검증이 필요하다.
15. **dependency/toolchain 버전 비교**: upstream의 feature 분리·codegen 개선이 있는 버전을
    격리 비교한다. 최신 버전이라는 이유만으로 작거나 빠르다고 가정하지 않는다.
16. **Polars 단일 엔진으로 query 대체**: CSV 속도는 유지하고 DuckDB의 query/page/cache 역할을
    대체한다. 기존 size-only 제거 실험은 약31MB였지만 대체 코드가 추가되므로 같은 순감량을
    보장하지 않는다. filter/sort/Find/result index/spill·정밀도 검증을 포함하는 큰 개발 작업이다.
17. **DuckDB 준비 경로 추가 최적화 후 통합**: CPU profile로 CSV scan/projection/regex/state/write
    병목을 찾고 선행 Rust 검사의 결과 재사용, 중복 계산 제거와 병렬도를 개선한다. 현재 측정은
    Polars보다 느리므로 성능 유지 조건을 아직 충족하지 않는다. 기존 의미 검증을 생략하지 않고
    목표 성능에 도달한 경우에만 Polars 제거를 검토한다.

## EXE 분리·배포 중심의 후보

18. **Polars 전용 worker EXE**: 이미 같은 EXE를 helper로 실행하므로 기존 request/result 파일
    protocol과 hard cancel 구조를 재사용할 여지가 크다. worker에 UI/HDF5/DuckDB를 넣지 않는다.
    main EXE는 작아지지만 두 파일 합계는 자동 감소하지 않으며 공통 Rust 코드 중복으로 늘 수 있다.
19. **DuckDB/HDF5 DLL**: 같은 엔진 코드를 동적 library로 옮긴다. EXE 단독 크기를 줄일 수 있으나
    총 설치 용량과 DLL load/call 경계, 검색 경로·version·서명 배포를 함께 평가한다.
20. **선택 모듈·Full/Lite 배포**: H5나 고속 CSV worker를 별도 선택 설치/지연 설치한다.
    설치된 기능의 정상 속도를 유지할 여지는 있지만 offline/첫 사용/배포 계약이 달라진다.
21. **압축 installer/ZIP**: download size를 줄인다. 과거144MB EXE가 약25MB NSIS였지만
    설치 후 EXE 총량의 감소는 아니다.
22. **압축 helper 내장·첫 사용 추출**: main 한 파일을 작게 보이게 할 수 있으나 추출 비용,
    cache·서명 검증·업데이트·정리가 필요하고 설치 footprint가 그대로일 수 있다.
23. **UPX 같은 executable packing**: disk bytes를 줄일 수 있지만 시작 때 압축해제와 배포 호환성
    검증이 추가된다. 성능 유지가 우선인 첫 단계로 선택하지 않는다.
24. **지원 CPU별 build**: 특정 CPU 기능만 대상으로 하면 범용 경로를 줄일 여지는 있지만
    hardware 호환성이 달라진다. 전체 사용자에 대한 동일 기능·성능 유지 방안으로 보지 않는다.

## 효과를 과장하지 않을 항목

- crate-type을 rlib-only로 바꾸면 불필요한 .dll/.lib 중간 산출물·build 시간을 줄일 수 있으나
  이미 EXE에 링크된 코드가 그만큼 제거되는 것은 아니다.
- target/Cargo cache 정리는 workspace disk 정리이며 배포 EXE 최적화가 아니다.
- use prelude::*를 좁히거나 dependency 이름을 umbrella에서 subcrate로 바꾸기만 해서 필요한
  실행 엔진이 자동 사라지지는 않는다. Cargo tree만으로 실제 EXE MB를 계산하지 않는다.
- frontend minify/icon 정리는 가능하지만 현재 수백KB 규모로 주요 해결책이 아니다.
- panic=abort는 파일별 panic 격리를 깨뜨릴 수 있다. 필요하면 분리 worker에 한정해 검토한다.
- DuckDB C++ 예외, 입력 검증, precision, Parquet codec 지원을 없애는 방식은 조건에 맞지 않는다.

## 우선 실험

1. HDF5 실제 native flags와 map attribution 재확인 후 optimized build A/B.
2. 현재 opt3 baseline에 thin LTO+codegen1, fat LTO+codegen1 비교.
3. Polars local-only cloud/fallback/dtype의 실제 map 기여도 분석 후 좁은 제거 POC.

각 후보는 EXE와 전체 설치 bytes, 기존 CSV 5회 반복, query/page/copy/H5, peak memory,
startup와 데이터 정합성을 비교한다. 아직 특정 절감 MB나 성능 무회귀를 달성했다고 주장하지 않는다.

공식 근거:
- [Cargo release/LTO/size optimization](https://doc.rust-lang.org/cargo/reference/profiles.html)
- [MSVC /GF](https://learn.microsoft.com/en-us/cpp/build/reference/gf-eliminate-duplicate-strings)
- [MSVC /O1,/O2](https://learn.microsoft.com/en-us/cpp/build/reference/o1-o2-minimize-size-maximize-speed)
- [MSVC /OPT](https://learn.microsoft.com/en-us/cpp/build/reference/opt-optimizations)
- [Rust PGO](https://doc.rust-lang.org/rustc/profile-guided-optimization.html)
- [Tauri app size / unused commands](https://v2.tauri.app/concept/size/)
- [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)
