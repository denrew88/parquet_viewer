# Phase 10 native dependency spike

- 실행일: 2026-07-17
- 판정: 구현 dependency PASS, clean VM runtime은 BLOCKED

## 선택한 dependency

- `hdf5-metno = 0.13.0`, features `static`, `blosc-zstd`
- `ndarray = 0.17`
- bundled HDF5 2.0.0, c-blosc와 Zstd source build

HDF5, Blosc와 Zstd는 실행 파일에 정적으로 링크한다. process 최초 초기화에서 dynamic
filter/VOL/VFD plugin mask를 0으로 설정하고 static Blosc filter 32001 availability를 확인한다.
bundled HDF5 2.0 header와 binding의 `H5PLset_loading_state` 인자 ABI 차이는 직접 올바른 C ABI를
선언하고 `hdf5::sync` 안에서 호출하는 좁은 runtime adapter로 격리했다.

## 측정과 검증

- Visual Studio 2022 Community x64 developer environment에서 cold debug static build: 27분 58초
- 후속 native debug build: 1분 19초 Rust compile, 전체 command 1분 36초
- 최종 Tauri release/NSIS build: 35분 11초 Rust release compile, 전체 command 36분 36초
- release EXE: 75,445,760 bytes, NSIS installer: 13,114,498 bytes
- `dumpbin /dependents`에서 `hdf5`, `blosc`, `zstd`, Python DLL import 없음
- runtime subprocess: plugin mask 0과 static Blosc registration PASS
- 실제 기준 OES의 filter 32001/Zstd first/middle/last decode와 checksum PASS
- Python, system HDF5와 loose plugin DLL을 제품 read path에서 사용하지 않음

`THIRD_PARTY_NOTICES.md`를 bundle resource에 포함했고 release resource staging을 확인했다. EXE는
Windows 시스템 DLL과 MSVC runtime을 동적으로 사용한다. clean Windows VM에서 loose HDF5/Blosc/Zstd,
Python, Conda와 plugin environment 없이 설치본을 실행하는 검증은 이 환경에서 수행하지 못했다.
