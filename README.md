# Data Viewer

Windows용 읽기 전용 CSV·Parquet 데스크톱 뷰어다. 큰 파일을 전체 메모리에 올리지 않고 페이지와 가상화 그리드로 탐색하며, DuckDB SQL로 열린 파일을 조회할 수 있다. Tauri 2, Rust, React를 사용한다.

**v0.23.0**에서 SQL 결과의 정렬·필터·검색, 현재 보기 내보내기, 저장 대화상자에서 승인한 파일의 덮어쓰기를 지원한다. [GitHub 릴리스에서 Windows EXE 다운로드](https://github.com/denrew88/parquet_viewer/releases/latest)

## 주요 기능

- 네이티브 파일 대화상자, OS drag and drop, 시작 인자, 파일 연결로 CSV·Parquet 열기
- 한 창에서 여러 파일 탭 열기
- Data, Schema, Metadata 화면
- Parquet row group/projection 페이지 조회와 정밀도 보존 값 표시
- CSV UTF-8/BOM, quoted field, background row count/checkpoint, header mode
- CSV Auto/All Text/Ask 기본 모드와 다중 컬럼 Parsing Profile, sample preview·전체 검증
- 행·열 가상화, column 검색·숨김·크기 조절, 전체 값 확인
- Excel 방식 셀·행·열 선택과 키보드 이동
- Excel/TSV/CSV/Custom preset으로 선택 범위를 시스템 clipboard에 복사
- 전체 파일 대상 typed filter, find/search, distinct 값과 nulls-last stable multi-sort
- 컬럼 값 목록의 검색·빈도·복사와 CSV 준비 캐시 재사용

## SQL 작업 공간

CSV 또는 Parquet를 열고 **SQL workspace**에서 파일을 테이블로 등록한다. 읽기 전용 `SELECT`와 CTE, JOIN, 집계, 윈도 함수, 실행 계획 분석을 지원한다. SQL은 파일 뷰어에 적용한 정렬이나 필터와 독립적으로 전체 입력을 조회한다.

- **Results**에서 타입별 필터, 다중 정렬, Find를 사용할 수 있다. 타임스탬프 필터는 타입이 지원하는 소수초 정밀도를 보존한다.
- **Export results**에서 전체 결과나 필터·정렬을 적용한 현재 보기를 CSV, TSV, Parquet 또는 클립보드로 내보낸다.
- 기존 출력 파일은 저장 대화상자에서 승인하면 교체한다. 열린 원본과 해당 쿼리에 사용된 원본은 보호한다.

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
- HDF5는 OEF H5 v3 구조의 `.h5`, `.hdf5` 파일을 읽을 수 있다. SQL 입력은 CSV·Parquet로 제한한다.
- 원본 파일은 읽기 전용이며, 내보내기는 SQL 결과를 별도 파일에 저장한다.
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

현재 릴리스의 SQL Results 및 Windows 내보내기 검증은 [Phase 23 통합 기록](artifacts/phase-23/50-integration.md)에 있다.

Phase 9 제품의 1,000만 행 쿼리 결과는 다음 문서에 있다.

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

## 로컬 Release 빌드

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

이전 빌드의 크기·성능 비교는 [HDF5 MSVC 최적화 기록](artifacts/optimizations/hdf5-msvc-release/50-results.md)과
[Rust ThinLTO 최적화 기록](artifacts/optimizations/rust-thin-lto/50-results.md)에 있다.

설치본은 CSV·Parquet file association을 등록한다. clean VM 설치·제거, Explorer 더블클릭, 실제 Excel paste는 배포 전 별도 native gate로 확인해야 한다.

## 프로젝트 문서

- `docs/PROJECT_SPEC.md`: 제품·데이터·보안 계약
- [개발 계획](docs/DEVELOPMENT_PLAN.md)에서 현재 Phase와 테스트 이력을 확인할 수 있다.
- `docs/UI_VALIDATION.md`: Browser/native UI 검증 계약
- `docs/PLAYWRIGHT.md`: Playwright 설치, 실행, 테스트 작성 규칙
- `artifacts/`: 단계별 scope, test plan, 통합 및 review 기록
