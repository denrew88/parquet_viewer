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
npm run tauri build -- --no-bundle
```

NSIS installer 빌드:

```powershell
npm run tauri build
```

설치본은 CSV·Parquet file association을 등록한다. clean VM 설치·제거, Explorer 더블클릭, 실제 Excel paste는 배포 전 별도 native gate로 확인해야 한다.

## 프로젝트 문서

- `docs/PROJECT_SPEC.md`: 제품·데이터·보안 계약
- `docs/DEVELOPMENT_PLAN.md`: Phase 0~9 개발 및 테스트 계획
- `docs/UI_VALIDATION.md`: Browser/native UI 검증 계약
- `docs/PLAYWRIGHT.md`: Playwright 설치, 실행, 테스트 작성 규칙
- `artifacts/`: 단계별 scope, test plan, 통합 및 review 기록
