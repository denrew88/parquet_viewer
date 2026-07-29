# Phase 16 독립 품질 검토

- 실행 모드: **독립 검증**
- 검토일: 2026-07-29
- 전체 판정: **PASS**
- `F-P16-001` 판정: **해소됨**
- Phase 완료 판정: **완료 가능**

CSV Parsing Profile의 숫자 separator가 preview에는 보이지만 `Ready` prepared-cache page에서
사라지던 `F-P16-001`은 수정됐다. 새 구현은 prepared artifact의 canonical typed 값을 그대로 두고
`DataValue.display`만 source provider의 profile formatter로 복원한다. `sourceDisplay`, `rawDisplay`,
DuckDB filter/sort, distinct token과 raw copy 의미는 바꾸지 않는다.

새 Rust prepared 경계 테스트와 기존 numeric matrix를 독립 재실행했고, 실제 WebView2 native smoke의
dot/comma/space 세 경우에서 preview, Apply 이후 prepared grid, typed sort/filter와 Windows clipboard
흐름이 모두 통과했다. 기존 dot 기대값 `10000019` → `10.000.019`는 낮추거나 우회하지 않았다.

기존 full Playwright command의 240초 미종료는 제품 assertion이 아니라 Playwright `webServer` 종료
경계로 분리됐다. Vite 서버를 별도 수명으로 시작한 뒤 `npx.cmd playwright test --reporter=line`을
실행한 결과 exit code 0, 105 passed, 2.8분이었고 서버도 이후 종료됐다. post-fix release와 NSIS도
재빌드했으며 파일 크기와 SHA-256을 독립 재확인했다. 따라서 이전 두 BLOCKED는 모두 해소됐다.

## 1. 기존 Phase 16 테스트 판정

| 테스트 ID | 판정 | 근거와 실제 결과 |
| --- | --- | --- |
| T-P16-001~015 | PASS | 실제 `Preparing` 문서만 inert, 금지 Data 입력/IPC 0, 허용된 tab/view/Settings/Cancel과 terminal/warm 상태 계약의 component·E2E 검증 PASS |
| T-P16-016~020 | PASS | preparation wait/permit 순서, Ready artifact 재사용, distinct, waiter cancel, session cleanup과 Failed/Cancelled direct fallback Rust 회귀 PASS |
| T-P16-021 | PASS | Vite를 별도 수명으로 실행한 full Playwright가 exit code 0, 105 passed, 2.8분으로 종료됐다. 세 viewport 전체 assertion이 통과했고 서버도 이후 종료됨 |
| T-P16-022 | PASS | 세 viewport blocker/Data surface rect, hit-test와 terminal layout shift 0px 증거 유지 |
| T-P16-023 | PASS | blocked/failed 상태 browser screenshot과 native screenshot의 기존 독립 시각 검토에 새 clipping/overlap 회귀 없음 |
| T-P16-024 | PASS | 실제 5.85M CSV cold 준비 83,949ms, blocker coverage와 차단 중 command delta 0, Ready 뒤 interaction PASS |
| T-P16-025 | PASS | warm first interactive 823ms, 110 frame 동안 blocker/progress/Cancel frame 0 |
| T-P16-026 | PASS | cold Cancel terminal 260ms, partial/cache/lease cleanup과 direct fallback PASS |
| T-P16-027 | PASS | generic native smoke의 Ctrl boundary 1→100→102→201, source/table boundary와 Shift 범위 PASS |
| T-P16-028 | PASS | Rust/frontend/Playwright/native와 post-fix release/NSIS 재빌드가 모두 PASS |

## 2. Display parity 보강 계획 판정

| 테스트 ID | 판정 | 근거와 실제 결과 |
| --- | --- | --- |
| T-P16-029 | PASS | `format_prepared_display` hook은 non-CSV 기본 identity이고 CSV numeric profile만 기존 `format_numeric_display`를 재사용한다. 기존 Auto/Int64/UInt64/Float64/Decimal × None/comma/dot/space matrix와 새 prepared test PASS |
| T-P16-030 | PASS | 새 Rust test에서 direct profiled page와 cold `Ready` prepared page의 전체 `DataValue` 행을 equality 비교했다. 실제 native도 preview→Apply→Ready를 통과했다. |
| T-P16-031 | PASS | 기존 persistent cache restart/hit 회귀가 전체 Rust suite에 포함되어 PASS했고 provider가 artifact와 함께 유지되어 동일 display hook을 사용한다. cache physical schema에 display 열을 추가하지 않았다. |
| T-P16-032 | PASS | profile은 source/provider와 reusable identity에 귀속되고 기존 session replacement/stale test가 PASS했다. 변경은 cache identity와 generation 경계를 수정하지 않았다. |
| T-P16-033 | PASS | 새 prepared query는 `amount > 2` 뒤 `ratio DESC`를 typed 값으로 실행하고 `10.001`/`1.234,5`, `3`/`3,25` 순서와 grouped display를 확인했다. native dot/comma/space sort도 PASS했다. |
| T-P16-034 | PASS | prepared query filter는 canonical numeric token을 사용하고 query page에서만 separator display를 복원한다. native 세 separator에서 50,000,000,000 초과 결과만 남는 assertion PASS |
| T-P16-035 | PASS | `read_prepared_csv_copy`의 행이 direct profiled page의 `DataValue`와 동일함을 Rust에서 확인했다. serializer의 기존 display/raw 표현 회귀와 실제 native clipboard commit도 PASS했다. |
| T-P16-036 | PASS | query `read_copy_rows`와 query page 행 equality, filtered/sorted native Windows clipboard atomic commit PASS. query/distinct의 canonical token도 별도 assertion으로 유지됨 |
| T-P16-037 | PASS | frontend 전체 372 tests, lint/typecheck/build PASS. Rust DTO가 JS number로 바뀌지 않고 string `display/sourceDisplay/rawDisplay` 경계를 유지한다. |
| T-P16-038 | PASS | full Playwright 세 viewport 105 tests PASS. 기존 geometry/screenshot 산출물에도 표시로 인한 clipping·layout 회귀가 없다. |
| T-P16-039 | PASS | 실제 dot native에서 preview `10.000.019`, prepared/filter/sort grid `99.990.189.981`과 기존 Ctrl/copy assertion PASS. 기존 기대값 완화 없음 |
| T-P16-040 | PASS | 동일 native script의 `--thousands-separator=comma`, `space`가 각각 PASS. `native-csv-profile-*`와 `native-query-copy-*-passed.png` 증거를 직접 열어 separator별 grouped grid를 확인함 |
| T-P16-041 | PASS | Rust 289/16 ignored, frontend 372, Playwright 105, native dot/comma/space와 Phase 16 cold/warm/cancel, post-fix release/NSIS가 모두 PASS |

## 3. 발견 사항

### F-P16-001 — MEDIUM — 해소됨

- 이전 재현: UInt64 thousands `.` preview는 `10.000.019`, prepared grid는 `10000019`.
- 수정 위치: `QueryInputProvider::format_prepared_display`, `CsvQueryProvider`의 profile-aware numeric
  formatter, `prepared_csv_value`의 display 복원.
- 수정 후 실제 결과: dot/comma/space 모두 preview와 prepared/filter/sort grid가 같은 separator를
  사용한다.
- 데이터 의미: `sourceDisplay`는 `10001`/`1234.5`처럼 canonical 값을 유지하고 distinct도 `10001`,
  `3`을 반환한다. 따라서 표시 수정이 typed query 의미로 역류하지 않는다.
- 판정: **CLOSED**.

### B-P16-002 — 품질 인프라 — 해소됨

- 이전 증상: Playwright가 내장 `webServer`를 사용한 명령에서 assertion 완료 뒤 종료되지 않음.
- 분리 검증: Vite 서버를 별도 셀로 시작하고 `npx.cmd playwright test --reporter=line` 실행.
- 실제 결과: exit code 0, 105 passed, 2.8분. 별도 Vite 서버도 이후 종료됐고 1420 port listener가 남지
  않았다.
- 판정: 제품 E2E assertion과 테스트 전체 범위는 **PASS**. 이전 hang은 분리 가능한 test harness
  teardown 문제이며 Phase gate를 더 이상 차단하지 않는다.

### B-P16-003 — 배포 검증 — 해소됨

- post-fix `npm.cmd run release`: PASS.
- `data-viewer.exe`: 143,991,808 bytes,
  SHA-256 `9124832CA96C0AEA0DE72C4B1B33496997AC403175F28BA7BFA982558DE7FE00`.
- NSIS installer: 24,943,153 bytes,
  SHA-256 `F442553710BAACD0B20F40138EAD73BC5438ACC60E9E630FCB5AEED8D3CA4911`.
- Quality가 실제 파일의 크기, 수정 시각과 SHA-256을 다시 계산해 위 값과 일치함을 확인했다.
- 판정: **PASS**.

## 4. 실행한 테스트와 증거

| 계층 | 결과 | 재현 명령 또는 증거 |
| --- | --- | --- |
| Quality targeted Rust | PASS | `cargo +1.97.1 test csv_prepared_numeric_display_matches_direct_page_query_copy_and_distinct_tokens --lib`: 1 passed |
| Quality numeric matrix | PASS | `cargo +1.97.1 test csv_numeric_profile_matrix --lib`: 2 passed |
| Quality separator direct page | PASS | `cargo +1.97.1 test integer_thousands_separators_format_applied_pages --lib`: 1 passed |
| Rust 전체 | PASS | 통합 결과: 289 passed, 16 ignored, 0 failed; fmt/clippy PASS |
| Frontend 전체 | PASS | 통합 결과: 20 files, 372 passed; format/lint/typecheck/build PASS |
| Playwright 전체 | PASS | 별도 Vite server + `npx.cmd playwright test --reporter=line`: exit 0, 105 passed, 2.8분 |
| Playwright targeted compact | PASS | 이전 실패 지점 단독 실행 7.2초 `ok`; 이후 full 105에서도 PASS |
| Generic native dot/comma/space | PASS | `scripts/native_cdp_smoke.mjs`; separator별 profile와 query-copy screenshot 생성 |
| Phase 16 native cold/warm/cancel | PASS | `artifacts/phase-16/native-cold-warm.json`: 83,949ms / 823ms / 0 frames / 260ms |
| Release/NSIS | PASS | post-fix release 성공; 실제 산출물 크기와 SHA-256 독립 재확인 |

targeted Rust 실행에서는 MSVC `LNK4098` warning이 출력됐지만 테스트는 PASS했다. 별도 full clippy
`-D warnings`는 통합 결과에서 PASS했으며, warning을 숨기거나 기준을 완화하지 않았다.

## 5. UI와 native 시각 검토

- `native-csv-profile-dot.png`, `native-csv-profile-comma.png`, `native-csv-profile-space.png`를 직접
  열어 converted preview가 각각 `10.000.019`, `10,000,019`, `10 000 019`로 표시됨을 확인했다.
- `native-query-copy-dot-passed.png`, `native-query-copy-comma-passed.png`,
  `native-query-copy-space-passed.png`를 직접 열어 Apply 이후 filtered/sorted grid도 각각
  `99.990.189.981`, `99,990,189,981`, `99 990 189 981` 형식임을 확인했다.
- 숫자 길이 증가로 인한 셀/헤더 겹침, 행 높이 변화, selection outline 이탈은 보이지 않았다.
- 실제 Windows clipboard commit은 native smoke가 검증했다. Browser clipboard mock만으로 이를
  PASS 처리하지 않았다.

## 6. 실행하지 못했거나 완료되지 않은 테스트

- Phase 16과 display parity 계획의 필수 자동·browser·native·release 테스트 중 미실행 항목은 없다.
- 150% DPI, 실제 Excel, clean-machine installer처럼 이전 Phase 기록에 남은 외부 환경 항목은 이번
  separator 수정으로 새로 PASS 처리하지 않으며 해당 Phase의 기존 판정을 그대로 유지한다.

## 7. 남은 위험과 최종 결론

Playwright config가 자체 `webServer`를 시작·종료하는 원래 명령의 teardown hang은 품질 인프라 부채로
남는다. 그러나 동일 production frontend를 별도 Vite 수명으로 실행한 full suite가 exit 0과 105/105를
반환했고 서버 cleanup도 확인했으므로 제품 Phase gate를 차단하지 않는다. 추후 runner 종료 문제를
별도 수정하더라도 E2E 기대값이나 retry 기준을 낮춰서는 안 된다.

제품 코드에서 재현되는 separator parity 결함, HIGH/MEDIUM 결함 또는 Phase 16 필수 BLOCKED는 없다.
`F-P16-001`과 T-P16-001~041이 모두 PASS이므로 Phase 16은 완료 조건을 충족한다.
