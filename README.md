# Data Viewer

Windows용 읽기 전용 CSV·Parquet 데스크톱 뷰어다. Tauri 2, Rust, React로 구성되며 큰 파일을 전체 메모리에 올리지 않고 페이지와 가상화 grid로 탐색한다.

## 주요 기능

- 네이티브 파일 대화상자, OS drag and drop, 시작 인자, 파일 연결로 CSV·Parquet 열기
- Data, Schema, Metadata 화면
- Parquet row group/projection 페이지 조회와 정밀도 보존 값 표시
- CSV UTF-8/BOM, quoted field, background row count/checkpoint, header mode
- CSV Auto/All Text/Ask 기본 모드와 다중 컬럼 Parsing Profile, sample preview·전체 검증
- 행·열 가상화, column 검색·숨김·크기 조절, 전체 값 확인
- Excel 방식 셀·행·열 선택과 키보드 이동
- Excel/TSV/CSV/Custom preset으로 선택 범위를 시스템 clipboard에 복사
- 전체 파일 대상 typed filter, find/search, distinct 값과 nulls-last stable multi-sort

## 선택과 복사

- 클릭·drag: 직사각형 셀 선택
- `Shift`: anchor에서 선택 확장
- 방향키, `Home`, `End`, `PageUp`, `PageDown`: active cell 이동
- `Ctrl`/`Command` 조합: 데이터 경계 이동과 전체 선택
- 행 번호·열 header: 전체 행·열 선택
- `Escape`: 선택 해제
- 복사 형식: 열은 tab, 행은 CRLF, null과 빈 문자열은 빈 field

복사 soft limit은 100,000셀 또는 8MiB, hard limit은 1,000,000셀 또는 64MiB다. 한 번에 projection할 수 있는 열은 64개다.

## 지원 범위

- CSV: comma delimiter, UTF-8/UTF-8 BOM, 최대 4,096열, logical record 최대 8MiB
- Parquet: primitive, decimal, date, timestamp, binary, list, struct, map 표시
- 페이지: 최대 200행
- 읽기 전용이며 편집, 저장, SQL, HDF5는 지원하지 않는다.
- UTF-16과 다른 legacy encoding은 변환하지 않고 오류로 표시한다.

## 개발 환경

- Windows 10/11
- Rust stable MSVC toolchain
- Node.js와 npm
- Windows C++ Build Tools와 WebView2 Runtime
- HDF5 native 빌드용 CMake (`PATH` 또는 target별 `CMAKE` 환경변수로 지정)

```powershell
npm ci
npm run playwright:install
npm run tauri dev
```

브라우저 mock UI만 실행하려면:

```powershell
npm run dev
```

## 검증

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test -- --run
node --test scripts/hdf5_release_build.node-test.mjs
npm run test:e2e
npm run test:native:build
npm run test:native:smoke
npm run build

cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Phase 9 제품 10M query 결과와 최종 판정은 다음 문서에 있다.

- `artifacts/phase-9/product-large-test.md`
- `artifacts/phase-9/50-integration.md`
- `artifacts/phase-9/90-review.md`

Phase 7 benchmark와 soak:

```powershell
python scripts/generate_phase7_fixtures.py
python scripts/run_phase7_bench.py
python scripts/audit_phase7_security.py
```

결과는 `artifacts/phase-7/`에 저장된다.

## 배포

실행 파일만 빌드:

```powershell
npm run release:exe
```

NSIS installer 빌드:

```powershell
npm run release
```

두 명령은 다음 빌드를 위해 Cargo Release 중간 산출물을 유지하고, 성공 후 `clean:temp`로
workspace `.tmp`의 64MiB 이상 생성 항목을 정리한다. Release 중간 산출물을 직접 정리하려면
`npm run clean:release`를 사용한다.

Windows MSVC Release 빌드는 `scripts/hdf5_release_build.mjs`를 거친다. 이 wrapper는 설치된
Visual Studio와 CMake가 함께 지원하는 generator를 명시해 HDF5의 C Release 기본 최적화를
보존한다. 사용자가 지정한 `CMAKE_GENERATOR` 계열 설정은 우선하며, Debug와 다른 플랫폼에는
설정을 추가하지 않는다. Rust profile, DuckDB와 Polars의 기능은 변경하지 않는다.

이 수정 전의 HDF5 CMake cache가 남아 있다면 최초 한 번 다음 명령으로 해당 패키지의 생성
산출물을 지운 뒤 Release를 빌드한다. `CARGO_TARGET_DIR`를 사용한다면 같은 환경에서 실행한다.

```powershell
cargo clean --manifest-path src-tauri/Cargo.toml --release -p hdf5-metno-src
npm run release:exe
```

저수준 Cargo Release 명령에도 wrapper를 적용할 수 있다.

```powershell
node scripts/hdf5_release_build.mjs cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol
node scripts/hdf5_release_build.mjs --print-plan tauri build
```

직접 실행한 `cargo build --release`나 `npm run tauri -- build`에는 wrapper가 적용되지 않는다.
자동 발견 실패 시 경고를 출력하고 원래 환경으로 빌드하므로, 최적화 적용 여부는 출력된 계획과
실제 native compile flags로 확인한다.

HDF5 Release 수정의 동일 조건 EXE 비교는 141.13→114.88MiB(-18.6%)이며, H5 읽기 성능은
5회 A/B에서 유지됐다. [크기·성능·실제 Tauri 검증 결과](artifacts/optimizations/hdf5-msvc-release/50-results.md).

추가로 Rust Release에 `lto = "thin"`, `codegen-units = 1`을 적용했다. 동일 조건 EXE는
114.88→103.67MiB(-9.76%), 최종 Tauri 패키징 EXE는 103.71MiB다. CSV·HDF5 각각 5회
A/B에서 데이터 정합성과 측정 성능을 유지했고, Rust 305개 테스트와 실제 CSV·Parquet·HDF5
앱 검증을 통과했다. [최종 측정과 검증 기록](artifacts/optimizations/rust-thin-lto/50-results.md).

설치본은 CSV·Parquet file association을 등록한다. clean VM 설치·제거, Explorer 더블클릭, 실제 Excel paste는 배포 전 별도 native gate로 확인해야 한다.

## 프로젝트 문서

- `docs/PROJECT_SPEC.md`: 제품·데이터·보안 계약
- `docs/DEVELOPMENT_PLAN.md`: Phase 0~9 개발 및 테스트 계획
- `docs/UI_VALIDATION.md`: Browser/native UI 검증 계약
- `docs/PLAYWRIGHT.md`: Playwright 설치, 실행, 테스트 작성 규칙
- `artifacts/`: 단계별 scope, test plan, 통합 및 review 기록
