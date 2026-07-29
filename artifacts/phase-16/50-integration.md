# Phase 16 통합 결과

- 작성일: 2026-07-29
- 상태: **완료**

## 구현 결과

- CSV preparation이 `Preparing`인 동안 해당 문서의 Data toolbar와 grid를 `inert` 처리한다.
- Filter, Find, 정렬, 복사, 탐색, 컬럼 조작과 CSV Parsing Profile 진입을 차단한다.
- 진행률과 Cancel, 다른 문서 탭, Data/Schema/Metadata 전환, Settings와 문서 닫기는 계속 사용할 수 있다.
- `Ready`, `Failed`, `Cancelled`에서 Data 상호작용을 복원하고 warm Ready에서는 blocker, progress, Cancel 프레임이 나타나지 않는다.
- 취소·query·distinct·prepared artifact 수명주기와 Ctrl navigation focus visibility를 Phase 16 계약대로 구현했다.
- prepared CSV page/query/copy에서 숫자 표시 프로필을 다시 적용한다. DuckDB의 canonical typed 값, raw/source 값, 정렬·필터 의미와 distinct token은 바꾸지 않는다.

## 표시 parity 결함 수정

- 이전 결함: preview는 `10.000.019`였지만 prepared-cache grid는 `10000019`로 표시됐다.
- 수정: `QueryInputProvider::format_prepared_display` hook을 추가하고 CSV provider에서 Int/UInt/Float/Decimal 표시값만 현재 CSV profile로 포맷한다.
- 검증: direct page, prepared page, filter+sort query page, query-aware copy가 같은 표시값을 사용하며 distinct token은 separator 없는 canonical 값으로 유지된다.
- dot, comma, space separator 실제 Tauri smoke가 모두 통과했다.

## 검증 결과

| 영역 | 결과 | 증거 |
| --- | --- | --- |
| Rust format / clippy | PASS | `cargo +1.97.1 fmt --all -- --check`, `cargo +1.97.1 clippy --lib --tests -- -D warnings` |
| Rust unit/integration | PASS | 289 passed, 16 ignored, 0 failed |
| Frontend format/lint/typecheck | PASS | Prettier, ESLint, TypeScript |
| Frontend unit/component | PASS | 20 files, 372 passed |
| Frontend production build | PASS | Vite production build |
| Playwright 전체 | PASS | 별도 Vite 서버에서 3 viewport, 105 passed, exit 0, 2.8m |
| generic native smoke | PASS | dot/comma/space 각각 profile, navigation, sort, filter, copy PASS |
| Phase 16 native cold/warm/cancel | PASS | `artifacts/phase-16/native-cold-warm.json` |
| Release/NSIS build | PASS | 수정 후 release exe와 NSIS installer 재생성 |

Playwright가 자체 시작한 Windows Vite 서버를 종료하지 못하는 runner 현상은 제품 테스트와 분리했다. 같은 서버를 별도로 실행한 뒤 전체 suite를 수행해 105개 PASS와 정상 exit code 0을 확인하고 서버를 종료했다.

## 실제 585만 행 CSV 결과

fixture: `fixtures/phase-15/csv-5850000-high.csv`

- cold preparation: 83,949ms
- blocker hit-test: PASS, 1,180×594px Data 영역 완전 덮음
- 차단 중 query/filter/selection 변경: 0
- warm first interactive: 823ms
- warm observation: 1,841ms, 110 frames
- warm blocker/progress/Cancel visible frame: 각각 0
- cold cancel terminal: 260ms
- terminal 이후 direct filter 진입: PASS
- 종료 후 partial cache, active lease, 잔여 cache: 0

## UI 증거

- `artifacts/phase-16/ui/browser-desktop.png`
- `artifacts/phase-16/ui/browser-compact.png`
- `artifacts/phase-16/ui/browser-minimum.png`
- `artifacts/phase-16/ui/native-desktop.png`
- `artifacts/phase-9/ui/native-csv-profile-dot.png`
- `artifacts/phase-9/ui/native-csv-profile-comma.png`
- `artifacts/phase-9/ui/native-csv-profile-space.png`

## 배포 산출물

| 파일 | 크기 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/data-viewer.exe` | 143,991,808 bytes | `9124832CA96C0AEA0DE72C4B1B33496997AC403175F28BA7BFA982558DE7FE00` |
| `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe` | 24,943,153 bytes | `F442553710BAACD0B20F40138EAD73BC5438ACC60E9E630FCB5AEED8D3CA4911` |

## 잔여 차단 사항

없음.
