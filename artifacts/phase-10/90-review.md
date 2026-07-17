# Phase 10 final review

- 실행일: 2026-07-17
- 판정: 구현 완료, 필수 security·performance·installer gate BLOCKED
- 알려진 제품 코드 FAIL: 없음

## 구현 결과

- 고정 OES HDF5 구조의 `time`, `wavelength`, `/intensity`를 공통 viewer 계약으로 연다.
- 행은 time, 열은 wavelength이며 intensity는 요청된 200행 x 64열 이하 hyperslab만 읽는다.
- Data/Schema/Metadata, 가상화 grid, 논리 셀 선택과 TSV clipboard를 CSV/Parquet와 공유한다.
- dialog, drag-and-drop와 startup path에서 `.h5/.hdf5` 후보를 받되 Windows 전체 HDF5 association은
  등록하지 않는다.
- dynamic HDF5 plugin을 비활성화하고 static Blosc 32001/Zstd decode를 사용한다.

## 최종 자동 검증

- `cargo fmt --check`: PASS
- `cargo clippy --all-targets --all-features -- -D warnings`: PASS
- Rust 전체: 146 PASS, opt-in large performance 2 ignored, 0 FAIL
- frontend format/lint/typecheck: PASS
- frontend 전체: 269 PASS
- Playwright: 27/27 PASS, 1440x900·1024x768·800x600
- fixture: committed 21/21 deterministic hash와 구조 audit PASS
- 실제 기준 OES: first/middle/last와 projection checksum PASS
- native debug Tauri: committed vlen fixture와 실제 OES open/last cell/Windows clipboard PASS

실제 기준 파일은 128행 x 65열로 열렸고 마지막 intensity `24971`이 화면 값과 clipboard에서
일치했다. React Strict Mode copy 수명주기와 멀리 떨어진 mounted column projection 회귀 테스트도
포함한다.

## release와 패키징

- `npm run tauri -- build`: PASS, Rust release compile 35분 11초, 전체 36분 36초
- `src-tauri/target/release/data-viewer.exe`: 75,445,760 bytes
- `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe`: 13,114,498 bytes
- `dumpbin /dependents`: HDF5, Blosc, Zstd, Python DLL import 없음
- `THIRD_PARTY_NOTICES.md`: Tauri bundle resource 설정과 release staging 확인

MSVC runtime은 동적 의존성으로 남는다. clean VM에서 installer가 이를 충족하는지는 아래 installer
gate와 함께 확인해야 한다.

## 독립 리뷰에서 수정한 결함

1. React Strict Mode probe 뒤 clipboard copy가 취소되던 mounted ref 수명주기를 수정했다.
2. 떨어진 두 열을 선택했을 때 중간 인접 열이 필요한 끝 열을 밀어내던 projection을 수정했다.
3. vlen axis 예약이 전체 HDF5 container 크기를 사용해 정상 대형 intensity 파일을 거부하던 문제를
   수정했다.

재검토 결과 위 세 결함은 회귀 테스트와 native 증거로 해소됐다.

## 남은 필수 BLOCKED gate

- HDF5 vlen 문자열은 `H5Aread`가 payload를 할당한 뒤에만 길이를 알 수 있다. process-wide 직렬화와
  128 MiB lease로 동시 retained memory는 제한했지만, 악성 단일 attribute의 allocation-before-limit은
  현재 API로 강제하지 못한다. 별도 격리 또는 bounded decoder가 필요하다.
- 4,096 wavelength initial page, 10M x 64 low/high fixture의 release latency·RSS·random projection,
  8-tab lifecycle와 2~5 release process 측정을 실행하지 못했다.
- 실제 150% DPI와 Excel paste를 실행하지 못했다.
- clean Windows VM에서 install/open/dialog/drop/startup/uninstall, MSVC runtime, loose native DLL과
  Python/Conda/plugin environment 부재 조건을 실행하지 못했다.

따라서 구현과 현재 환경에서 실행 가능한 회귀 gate는 PASS지만, Phase 10 전체 완료 상태는 위 필수
항목 때문에 BLOCKED로 유지한다.
