# Phase 14 통합 검증 기록

- 검증일: 2026-07-23
- 판정 기준: `artifacts/phase-14/10-test-plan.md`
- 현재 판정: **완료 불가**

## 결론

Phase 14의 UI 변경은 전체 Vitest 364개, 전체 Playwright 75개, Phase 11~14 선택 회귀 48개를
모두 통과했다. 세 viewport screenshot과 geometry를 직접 확인했고, 최종 release 실행 파일의 실제
Tauri IPC/WebView2에서도 sort, settings, column drag가 통과했다. Fixture audit도 12/12다.

최종 low-cardinality 5.85M release 단일 표본의 cold preparation은 53.9417초로 `<=60초`이며,
baseline 151.5초 대비 약 2.81배다. 다만 고정 gate가 요구하는 cold 5회 median/p95 표본은 아직
없으므로 `P14-GATE-008`을 PASS로 승격하지 않았다. persistent hit는 20회 p50 84.9574ms,
p95 110.6953ms, 최대 113.891ms이며 전부 `Ready`, `source_read_bytes=0`으로 통과했다.

반면 product-path Ready page p95는 42.0566ms로 20ms hard gate를 실패했다. physical typed/raw
cache, preparing frontier, preview/preparation/navigation별 byte counter와 cache 구성별 byte audit도
계획 계약을 충족하지 않는다. 최종 release/NSIS build와 DPR1 native smoke는 통과했지만 Windows
clipboard full-copy, 150% DPI, NSIS 실제 설치 smoke는 없다. 따라서 Phase 상태를 완료로 바꾸면
안 된다.

## 실행 증거

| 검증 | 결과 | 증거 |
| --- | --- | --- |
| Fixture 독립 audit | PASS, 12/12 | `python scripts/audit_phase14_fixtures.py`; `fixture-audit.json` |
| 영향 TS unit/component | PASS, 86/86 | `QueryToolbar`, `AppSettingsDialog`, `VirtualDataGrid`, `gridOrdering` |
| 전체 Vitest | PASS, 364/364 | Root 최종 재검증 결과 |
| 전체 Playwright | PASS, 75/75 | 세 viewport 전체 spec |
| Phase 11~14 선택 E2E | PASS, 48/48 | last-row, query-aware copy, drag/drop, sort, timestamp/duration 포함 |
| Screenshot 직접 검토 | PASS, 제한된 범위 | multi-sort/settings/drag/source-order 이미지 직접 열람 |
| Rust 전체 lib 중간 실행 | FAIL, 229 PASS/2 FAIL/11 ignored | 통합 중 스냅샷에서 progress deadline, same-session reservation timeout |
| Rust 최종 전체 lib | PASS, 239 PASS/0 FAIL/12 ignored | 독립 `cargo test --manifest-path src-tauri\\Cargo.toml --lib`; 8.39초 |
| Rust format/check/clippy | PASS | fmt, check, clippy all-targets `-D warnings` |
| Persistent cache 회귀 | PASS | OS file identity, CRC/fingerprint, pinned handle, stale commit, subprocess lock, orphan cleanup |
| Persistent release | PASS | cold 53.9417s 1회; hit 20회 p95 110.6953ms, source read 0 |
| Release large CSV 1차 | FAIL | `rust-large-csv.json`: prepare 60.112s, page p95 34.889ms |
| Release large CSV 재실행 | FAIL | `rust-large-csv-rerun.json`: prepare 63.130s/2.40x, page p95 42.057ms |
| Release 성능 정규 matrix | NOT_RUN | cold 5회/page 100회 등 전체 표본 계약은 미충족 |
| Native WebView2 | PASS, 제한된 범위 | 최종 exe로 RUNTIME/SORT/SETTINGS/COLUMN-DRAG PASS, DPR1 |
| Release/NSIS build | PASS | EXE 78,997,504B, NSIS 13,763,973B; SHA256 아래 기록 |

`rust-large-csv*.json`의 내부 `status: PASS`는 harness 자체 invariant만 의미한다. Phase 14의
60초, 2.5배, 20ms gate 판정으로 재사용하지 않았다.

최종 EXE SHA256은 `A50AC0022A3B3AD986C53BA5B46330EC0FCF42FEF7B67BC8929CA14BFE2C6AC7`,
NSIS SHA256은 `36493BA299321265E36D117EFA5FCEAFCE21A1ED1C8101418D340A0C3C42FC36`이다.

## 고정 gate 추적

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P14-GATE-000` | PASS | 전체 Vitest 364/364와 전체 Playwright 75/75 |
| `P14-GATE-001` | PASS | Windows volume serial+file index/Unix dev+ino, profile/schema/app identity와 교체 회귀 통과 |
| `P14-GATE-002` | NOT_RUN | 4개 대용량 탭 queue와 writer queue peak 계측 없음 |
| `P14-GATE-003` | PASS | adaptive batch 단위 테스트와 64 MiB/65,536행 분할 계약 통과 |
| `P14-GATE-004` | PASS | 2-bit state unit/property 및 fixture audit 통과 |
| `P14-GATE-005` | PASS | 4,096 checkpoint와 65,536 row group 경계 테스트 통과 |
| `P14-GATE-006` | FAIL | preview/preparation/source별 실제 byte counter와 정규 표본이 없음 |
| `P14-GATE-007` | FAIL | Ready navigation source-read=0을 증명하는 전용 counter가 없음 |
| `P14-GATE-008` | NOT_RUN | 최종 1회는 53.9417s/2.81x로 수치 통과했으나 필수 cold 5회 median/p95 없음 |
| `P14-GATE-009` | FAIL | RSS는 116,006,912B로 통과했으나 구성별 cache byte audit가 없음 |
| `P14-GATE-010` | PASS | blank-first multi-sort unit/component/E2E 통과 |
| `P14-GATE-011` | PASS | live reflow component/E2E와 drag 중 page read 0 증거 통과 |

## CSV 준비·생명주기 추적

| ID | 판정 | 근거 |
| --- | --- | --- |
| `CSV14-001` | PASS | state matrix, occupancy 및 audit 통과 |
| `CSV14-002` | PASS | column-major 2-bit bitmap/property 테스트 통과 |
| `CSV14-003` | PASS | checkpoint boundary fixture와 Rust 경계 테스트 통과 |
| `CSV14-004` | FAIL | 단일 scan을 요구한 source scan/read counter가 없어 계약을 증명할 수 없음 |
| `CSV14-005` | FAIL | raw/typed가 물리적으로 분리된 typed Arrow/Parquet cache 및 전 소비자 oracle 증거 부족 |
| `CSV14-006` | NOT_RUN | adaptive batch cap unit은 통과했으나 writer queue peak와 raw/typed row-count integration counter 없음 |
| `CSV14-007` | NOT_RUN | raw/typed/state/checkpoint 각 writer fault injection matrix 미실행 |
| `CSV14-008` | NOT_RUN | state/parquet 동일 길이 변조·orphan rebuild는 통과했으나 manifest/footer/index 전수 matrix는 미실행 |
| `CSV14-009` | NOT_RUN | page/find/distinct/full/filter/3-sort/copy 전체 consumer 추가 scan 0 matrix 미실행 |
| `CSV14-010` | NOT_RUN | release filter+3-sort 한 표본과 query unit은 통과했으나 low/high 양쪽 ordered checksum matrix 없음 |
| `CSV14-011` | NOT_RUN | display/layout UI 회귀는 통과했으나 scan/build/cache generation 불변 counter matrix 없음 |
| `CSV14-012` | FAIL | profile 변경 시 원본 scan 0/raw 재사용을 증명하는 물리 raw-cache 경로 없음 |
| `LIFE14-001` | PASS | OS file identity·size/time·profile·schema/app key와 실제 same-path/size/time replacement miss 통과 |
| `LIFE14-002` | NOT_RUN | pinned scan handle, 교체/mutation stale commit은 통과했으나 append/truncate/mtime 전수 matrix 없음 |
| `LIFE14-003` | NOT_RUN | atomic manifest/orphan cleanup은 통과했으나 rename 전후 실제 crash/fault matrix 미실행 |
| `LIFE14-004` | NOT_RUN | 4개 대용량 tab active-1 queue/foreground 우선순위 미실행 |
| `LIFE14-005` | NOT_RUN | same-session reservation 회귀는 최종 통과했으나 20회 요청/10회 profile stress matrix 없음 |
| `LIFE14-006` | NOT_RUN | release cancel 약 103ms는 통과했으나 4,096 경계·close·replace 자원 counter matrix 없음 |
| `LIFE14-007` | NOT_RUN | subprocess lock/orphan cleanup은 통과했으나 실제 강제 종료·실패·cancel janitor matrix 미실행 |
| `LIFE14-008` | NOT_RUN | service reopen 20회 p95 110.6953ms/source read 0은 통과했으나 실제 앱 process 재시작 전체 consumer matrix 없음 |
| `LIFE14-009` | NOT_RUN | process-shared active lease/LRU/live usage 회귀는 통과했으나 구성별 byte와 free-space 경계 matrix 불완전 |
| `LIFE14-010` | NOT_RUN | 100-cycle release soak 미실행 |

## 탐색·성능 추적

| ID | 판정 | 근거 |
| --- | --- | --- |
| `NAV14-001` | PASS | state semantics/경계 property 테스트 통과 |
| `NAV14-002` | FAIL | bitmap 알고리즘은 있으나 source-read=0 counter와 cold/warm matrix 없음 |
| `NAV14-003` | PASS | visible-order horizontal unit/component 회귀 통과 |
| `NAV14-004` | FAIL | 준비 중 frontier 내부 즉시 응답/외부 coordinator wait 증거가 없음 |
| `NAV14-005` | NOT_RUN | adaptive occupancy unit과 release boundary 한 표본은 통과했으나 세 query 형태·네 방향 matrix 없음 |
| `NAV14-006` | NOT_RUN | 같은 query/range 5회 왕복 100% bitmap hit 계측 미실행 |
| `NAV14-007` | PASS | Ctrl+Alt 네 방향과 selection 관련 회귀 통과 |
| `NAV14-008` | NOT_RUN | shortcut당 IPC/target page request 전용 E2E counter matrix 미실행 |
| `NAV14-009` | NOT_RUN | mouse/key/focus/query/tab/page-failure race matrix 미실행 |
| `PERF14-001` | NOT_RUN | low/high cold preview 10회 표본 없음 |
| `PERF14-002` | FAIL | source byte 계측 계약과 low/high/long-invalid 5회 표본 없음 |
| `PERF14-003` | NOT_RUN | 최종 1회 53.9417s/약 2.81x는 통과했으나 요구 cold 5회 표본 없음 |
| `PERF14-004` | FAIL | page p95 42.057ms >20ms; 요구 표본 100개도 미충족 |
| `PERF14-005` | NOT_RUN | source Ctrl cold/warm/horizontal 각 50회 미실행 |
| `PERF14-006` | NOT_RUN | filtered/sorted Ctrl cold/warm 각 50회 미실행 |
| `PERF14-007` | NOT_RUN | 측정값 634.293ms는 예산 내지만 요구 표본 20회가 아님 |
| `PERF14-008` | NOT_RUN | 64k×1 p95 103.427ms는 예산 내지만 요구 표본 20회가 아님 |
| `PERF14-009` | NOT_RUN | 5.85M×1 source/query full copy release 증거 없음 |
| `PERF14-010` | NOT_RUN | Windows clipboard cancel/fault/stale native matrix 없음 |
| `PERF14-011` | NOT_RUN | RSS는 통과했으나 decoded accepted bytes와 queue peak 계측 불완전 |
| `PERF14-012` | FAIL | raw/typed/state/checkpoint/manifest 구성별 byte artifact 없음 |
| `PERF14-013` | PASS | 20회 p50 84.9574ms/p95 110.6953ms/max 113.891ms, 전부 Ready/source read 0 |

## UI 추적

| ID | 판정 | 근거 |
| --- | --- | --- |
| `SORT14-001` | PASS | blank Add level 및 focus unit/component 통과 |
| `SORT14-002` | PASS | column/direction 후결정과 구 DOM 제거 통과 |
| `SORT14-003` | PASS | empty search 전체 column/hidden/duplicate E2E 통과 |
| `SORT14-004` | PASS | incomplete/duplicate/64개 validation unit 통과 |
| `SORT14-005` | PASS | draft reorder identity/priority component/E2E 통과 |
| `SORT14-006` | PASS | Cancel/Clear/Apply query count E2E 통과 |
| `SORT14-007` | NOT_RUN | backend Apply 실패와 offscreen selection 보존 matrix 미실행 |
| `SORT14-008` | NOT_RUN | 실제 WebView2 keyboard-only 검증 없음 |
| `SET14-001` | PASS | 16/13/12/11px geometry JSON과 screenshot 확인 |
| `SET14-002` | PASS | 첫 화면 primary control/preview와 nested modal 제거 통과 |
| `SET14-003` | PASS | 단일 inline accordion 및 draft 유지 E2E 통과 |
| `SET14-004` | NOT_RUN | preview→Apply→backend page/query/copy wire 전 조합 미실행 |
| `SET14-005` | PASS | 세 viewport responsive geometry와 footer 확인 |
| `SET14-006` | NOT_RUN | 실제 WebView2 및 150% DPI 검증 없음 |
| `DRAG14-001` | PASS | preview projection unit 테스트 통과 |
| `DRAG14-002` | PASS | threshold/floating mounted strip component/E2E 통과 |
| `DRAG14-003` | PASS | 세 viewport X geometry와 screenshot 확인 |
| `DRAG14-004` | PASS | drag 중 page read 0, drop commit component/E2E 통과 |
| `DRAG14-005` | PASS | Escape/pointer cancel/gesture 회귀 component 통과 |
| `DRAG14-006` | NOT_RUN | native internal drag와 edge auto-scroll 전체 matrix 미실행 |
| `DRAG14-007` | PASS | floating strip clip/aria/pointer geometry E2E 통과 |
| `RESET14-001` | PASS | source order projection unit 테스트 통과 |
| `RESET14-002` | PASS | accessible button state component/E2E 통과 |
| `RESET14-003` | PASS | source-order restore screenshot/E2E 통과 |
| `RESET14-004` | NOT_RUN | 실제 두 document/tab first-paint native matrix 미실행 |
| `UI14-001` | NOT_RUN | preparing frontier 상태별 screenshot/counter 없음 |
| `UI14-002` | NOT_RUN | source/filter/sort 네 방향 Phase 14 E2E screenshot 없음 |
| `UI14-003` | PASS | multi-sort 세 viewport screenshot/E2E 통과 |
| `UI14-004` | PASS | settings 세 viewport inline/accordion screenshot/E2E 통과 |
| `UI14-005` | PASS | drag 세 viewport screenshot/geometry/E2E 통과 |
| `UI14-006` | PASS | source-order 세 viewport screenshot/E2E 통과 |
| `UI14-007` | PASS | 세 viewport 선택 E2E에서 segmented 마지막 row geometry/navigation 통과 |
| `UI14-008` | PASS | 전체/선택 E2E에서 query-aware copy와 tab/cache 회귀 통과 |

## Native와 최종 gate 추적

| ID | 판정 | 근거 |
| --- | --- | --- |
| `NATIVE14-001` | NOT_RUN | 실제 5.85M CSV native cold open/Ready 증거 없음 |
| `NATIVE14-002` | NOT_RUN | 실제 native Ctrl 조합 cold/warm 증거 없음 |
| `NATIVE14-003` | NOT_RUN | 실제 WebView2 drag/strip geometry는 PASS지만 first/middle/last/edge 전수 matrix 없음 |
| `NATIVE14-004` | NOT_RUN | 실제 native sort/settings는 PASS지만 keyboard-only와 150% DPI matrix 없음 |
| `NATIVE14-005` | NOT_RUN | Windows clipboard full-copy hash 증거 없음 |
| `NATIVE14-006` | NOT_RUN | native cache reopen/tab 왕복 증거 없음 |
| `NATIVE14-007` | NOT_RUN | 100%/150% DPI native screenshot 없음 |
| `GATE14-001` | PASS | frontend format/typecheck/lint와 전체 Vitest 364/364 PASS |
| `GATE14-001A` | NOT_RUN | 영향 관련 86/86은 통과했으나 계획의 기존 76개를 동일 목록으로 분리한 결과가 없음 |
| `GATE14-002` | PASS | 전체 Playwright 75/75 및 Phase 11~14 선택 48/48 PASS |
| `GATE14-003` | PASS | fmt/check/clippy `-D warnings` PASS, 최종 Rust lib 239 PASS/0 FAIL/12 ignored |
| `GATE14-004` | NOT_RUN | fixture manifest SHA와 audit 12/12는 통과했으나 benchmark artifact가 `NOT_RUN` |
| `GATE14-005` | PASS | 최종 release exe 실제 Tauri IPC/WebView2 CDP native smoke PASS |
| `GATE14-006` | NOT_RUN | final release/NSIS build와 hash는 PASS지만 실제 NSIS install smoke/runtime audit 없음 |
| `GATE14-007` | PASS | 전체 Rust/TS/Playwright에서 CSV/Parquet/H5/query/page/copy/display 회귀 PASS |

## 필수 산출물 감사

존재: fixture manifest/audit, large CSV 및 persistent release JSON, UI screenshot/일부 geometry,
native result/screenshot, final EXE/NSIS hash, `visual-review.md`.

누락 또는 불완전: cold preparation 5회, navigation/query-copy 정규 성능 표본, cache 구성별 byte
audit, lifecycle soak, 통합 `geometry-results.json`, UI interaction 결과, Windows clipboard/150% DPI,
NSIS 실제 설치 smoke. `csv-preparation-performance.json`은 파일은 존재하지만 판정이 명시적으로
`NOT_RUN`이다.
