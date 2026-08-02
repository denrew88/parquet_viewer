# Phase 17 테스트 계획

- 실행 모드: **테스트 설계**
- 상태: **구현 전 계약 확정**
- 작성일: 2026-07-30
- 근거: `artifacts/phase-17/00-scope.md`, `docs/PROJECT_SPEC.md`,
  `docs/DEVELOPMENT_PLAN.md`, `docs/UI_VALIDATION.md`, `docs/PLAYWRIGHT.md`
- page 기준: 아래 경계값과 golden offset은 기본 `limit=200` fixture를 사용한다.

## 1. 판정 원칙과 추적성

요청 수는 초기 page와 시나리오 준비 중 발생한 요청을 제외하고, probe를 reset한 뒤의 delta만 센다.
`foreground`와 `prefetch`는 제품 DTO에 새 필드를 추가하지 않고 요청 시점, visible offset과 adjacent
offset을 기록해 구분한다. 브라우저 mock latency는 실제 WebView2 성능 증거로 사용하지 않는다.

| 완료 조건 | 필수 테스트 ID | PASS 기준 |
| --- | --- | --- |
| 빠른 uncached drag·wheel 중간 조회 억제 | `T-P17-001`~`007`, `010`~`014`, `023`, `024`, `030` | 중간 visible offset의 foreground와 adjacent prefetch가 각각 0회, 최종 foreground만 1회 |
| 느린 이동·cache hit 즉시 반응 | `T-P17-009`, `015`, `025`, `031` | 120ms quiet 대기 없이 전환; cache hit IPC 0; 느린 page 정착 뒤 adjacent prefetch 계약 유지 |
| source/query/projection/stale 정확성 | `T-P17-013`~`017`, `026`, `030`, `031` | 최종 logical offset, projection, document/session/query identity가 일치하고 stale commit 0 |
| keyboard·selection·focus 회귀 없음 | `T-P17-018`, `019`, `027`, `032` | target page 즉시 요청, 논리 좌표와 selection 유지, active cell이 viewport 안에 완전히 보이고 grid focus 유지 |
| segmented first/middle/last·마지막 행 | `T-P17-008`, `020`, `027`~`029`, `032` | 200,000행 physical surface, logical first/middle/last, 마지막 행과 scrollbar geometry가 정량 기준 충족 |
| 전체 품질·패키징 | `T-P17-022`, `029`, `033`~`035` | timer/in-flight 누적 0, frontend/Rust/E2E/native/release·NSIS와 capability audit PASS |

필수 테스트 하나라도 FAIL이면 Phase 판정은 FAIL이다. 필수 native 환경을 실행하지 못하면 브라우저
결과로 대체하지 않고 BLOCKED로 기록한다. HIGH/MEDIUM 결함이나 필수 BLOCKED가 남으면 완료할 수 없다.

## 2. Fixture와 golden data

| Fixture | 용도 | Golden |
| --- | --- | --- |
| `phase17-scroll-controlled` browser fixture | 5,850,000 logical rows, 15 columns, page 200, cache seed/evict, source/query mode, 수동 resolve/reject와 monotonic request log | 빠른 row `0→600→1,800→5,000→9,137`의 요청 log는 quiet 전 `[]`, settle 뒤 `[{offset:9000, limit:200, columns:expectedProjection}]` |
| `phase17-cache-controlled` browser fixture | page `0`, `4,000`, `4,200`을 선택적으로 frontend cache에 seed | scrub 중 row `4,037` 이동은 즉시 offset `4,000` 표시, page IPC delta 0 |
| `phase17-stale-controlled` browser fixture | scrub 진입 전에 최대 2개 source/query request를 deferred 상태로 유지 | 두 old response를 역순 release해도 active offset/query/projection은 최종 golden과 일치, stale cell commit 0 |
| 기존 `large-5850000.parquet` browser mock | segmented first/middle/986,803/last, selection·focus·geometry | middle page offset `986,800`, last logical row `5,849,999`, last page offset `5,849,800` |
| `fixtures/phase-15/boundary-5850000-high.parquet` | 실제 Tauri source scroll, high-cardinality page, 20-cycle scrub와 cache 재방문 | `fixtures/phase-15/manifest.json`의 size/hash와 row count 5,850,000 일치 |
| `phase17-query-controlled` browser fixture | filter/sort query logical scroll와 query·projection 교체 | first/986,803/last identity와 projection이 request log 및 표시 cell과 일치 |

Browser fixture는 전체 row 배열을 만들지 않고 요청한 200행만 결정적으로 생성한다. 각 request log는
endpoint, monotonic timestamp, document/session/query ID, offset, limit, projection, resolve order를 가진다.
`scrollend` 지원·미지원 경로는 명시적 event와 fake timer quiet 경로로 각각 실행한다.

## 3. 구현 Agent가 작성할 단위·component 테스트

| ID | 분류·계층 | Fixture/입력 | 정량 기대 결과 | 담당 역할 |
| --- | --- | --- | --- | --- |
| `T-P17-001` | 정상/TS unit | 첫 표본 뒤 `row 0→399`, elapsed `121ms` 이상 | 2 page 미만 jump이고 빠른 시간 조건도 아니므로 scrub 진입하지 않음 | Grid 구현 Agent |
| `T-P17-002` | 경계/TS unit | `0→400`과 `400→0` | elapsed와 무관하게 `abs(delta)>=400`이면 즉시 scrub 진입 | Grid 구현 Agent |
| `T-P17-003` | 경계/TS unit | `0→199/120ms`, `0→200/120ms`, `0→200/121ms` | 각각 false, true, false; 상·하 방향 대칭 | Grid 구현 Agent |
| `T-P17-004` | 오류/TS unit | 첫 표본, 동일 timestamp, 역행 timestamp, 동일 row | NaN/Infinity 없이 첫·비단조 표본을 안전하게 재기준화하고 false positive scrub 0 | Grid 구현 Agent |
| `T-P17-005` | 회귀/TS unit | scrub 진입 뒤 느린 표본 10개 | 중간 표본으로 해제 0; `scrollend` 또는 마지막 event+120ms에서만 해제 | Grid 구현 Agent |
| `T-P17-006` | 경계/TS unit(fake timer) | quiet 119/120ms, timer reset, `scrollend`와 timer 경쟁 | 119ms settle 0, 120ms settle 1; 새 event마다 기준 재설정; 두 종료 신호가 와도 settle 1회 | Grid 구현 Agent |
| `T-P17-007` | 회귀/TS unit | segmented recenter가 만든 synthetic scroll 표본 | velocity history·scrub state·quiet deadline 변화 0 | Grid 구현 Agent |
| `T-P17-008` | 경계/TS unit | 5,850,000행의 0, 986,803, 5,849,999 | segment는 항상 0..5,650,000, 길이 최대 200,000; visible offset은 0/986,800/5,849,800 | Grid 구현 Agent |
| `T-P17-009` | 정상/Component(fake timer) | 121ms보다 긴 느린 scroll로 uncached page 경계 통과 | clock을 120ms advance하지 않아도 foreground 1회; page commit 뒤 해당 edge의 adjacent prefetch 최대 1회 | Grid 구현 Agent |
| `T-P17-010` | 정상/Component | 빠른 uncached row sequence `0→600→1800→5000→9137` | quiet 전 모든 중간 foreground/prefetch 0, 마지막 event+120ms에 offset 9,000 foreground 정확히 1회 | Grid 구현 Agent |
| `T-P17-011` | 경계/Component | 같은 sequence 뒤 `scrollend`, 이어서 quiet timer 만료 | `scrollend`에서 offset 9,000 요청 1회, 이후 timer duplicate 0 | Grid 구현 Agent |
| `T-P17-012` | 회귀/Component | 빠른 wheel과 scrollbar 표본을 교차 입력 | scrub state가 흔들리지 않고 마지막 visible offset 하나만 commit | Grid 구현 Agent |
| `T-P17-013` | 회귀/Component | 동일 final offset/projection에 scrollend·quiet·React effect 재실행 | same-key in-flight/cache dedupe로 read 호출 총 1회 | Grid 구현 Agent |
| `T-P17-014` | 경쟁/Component | scrub 전 deferred request 2개, final request 뒤 old response 역순 resolve | final offset만 active; old cell·error·loading commit 0; terminal 후 loading key/in-flight 0 | Grid 구현 Agent |
| `T-P17-015` | 정상/Component | scrub 중 offset 4,000 compatible cached page | timer advance 전 active page/cell 전환, `readPage` 0, selection·focus 변화 0 | Grid 구현 Agent |
| `T-P17-016` | 정상/Component | source page, reordered/hidden column projection | final request가 정확한 source session과 visible projection을 1회 전송; adjacent prefetch는 final foreground 완료 뒤만 가능 | Grid 구현 Agent |
| `T-P17-017` | 경쟁/Component | filter/sort query 교체와 projection 교체 중 scrub | 최신 document/session/query/projection의 final page만 commit; 이전 query/projection cell과 page error 0 | Grid 구현 Agent |
| `T-P17-018` | 회귀/Component | Arrow, Home/End, PageUp/Down, Ctrl·Ctrl+Alt 조합 | scrub quiet를 기다리지 않고 target page cache miss 최대 1회; active/anchor/range가 query logical 좌표와 일치 | Grid 구현 Agent |
| `T-P17-019` | 회귀/Component | Shift selection auto-scroll과 mouse drag edge-scroll | target visible page가 즉시 결정되고 active cell/selection outline 오차 2px 이하, grid focus 유지 | Grid 구현 Agent |
| `T-P17-020` | 회귀/Component | segment edge recenter 전후 | synthetic event로 scrub 진입·추가 IPC 0; 첫 visible logical row 차이 0, active/selection 좌표 차이 0 | Grid 구현 Agent |
| `T-P17-021` | 오류/Component | final foreground reject 후 같은 위치 재정착 | 오류는 final offset에만 1회 표시, stale error 0; retry는 같은 key를 새로 정확히 1회 요청하고 성공 시 pending 0 | Grid 구현 Agent |
| `T-P17-022` | 수명주기/Component(fake timer) | scrub 중 unmount, inactive tab, session/query replace | timer listener 해제, 이후 read/state update 0; 재활성 cached tab prefetch 재시작 0 | Grid 구현 Agent |

구현 Agent는 새 순수 helper와 `VirtualDataGrid` component test를 제품 코드와 함께 작성한다. 테스트를
통과시키기 위해 120ms, 200행 page와 요청 수 계약을 완화하거나 backend cancellation DTO를 추가하지 않는다.

## 4. Quality Agent가 작성할 Playwright 독립 테스트

`e2e/phase17.spec.ts`는 `desktop-wide` 1440×900, `desktop-compact` 1024×768,
`desktop-minimum` 800×600 세 project에서 모두 실행한다. 실제 pointer/wheel/scroll event와 backend
counter delta를 사용하고 고정 sleep 대신 request log, accessible loading 상태와 populated cell을 기다린다.

| ID | 분류·계층 | 상호작용과 fixture | 정량 기대 결과 | 담당 역할 |
| --- | --- | --- | --- | --- |
| `T-P17-023` | 정상/Playwright 3 viewport | controlled source의 scrollbar를 uncached offset 10개 이상 빠르게 scrub | 이동 중 foreground 0, prefetch 0; scrollend/quiet 뒤 final offset·projection 1회; 중간 offset request 0 | Quality Agent |
| `T-P17-024` | 정상/Playwright 3 viewport | 실제 `mouse.wheel` burst 20회와 scrollend 미지원 quiet 경로 | 마지막 wheel 뒤 119ms request 0, 120ms quiet 이후 final foreground 1회, 영구 pending 0 | Quality Agent |
| `T-P17-025` | 정상/Playwright 3 viewport | 느린 wheel/scrollbar와 seeded cache hit | 느린 uncached foreground는 quiet 대기 0, settled page의 adjacent prefetch 계약 유지; cache hit IPC 0이고 즉시 cell 표시 | Quality Agent |
| `T-P17-026` | 경쟁/Playwright 3 viewport | source와 filter/sort query 각각 scrub, projection 교체와 deferred stale resolve | endpoint, queryId, final offset 986,800과 projection 일치; stale row/cell/error commit 0 | Quality Agent |
| `T-P17-027` | 회귀/Playwright 3 viewport | PageUp/Down, Ctrl boundary, Shift auto-scroll, segment first/middle/last/last row | keyboard target마다 cache miss 최대 1회; active/selection 논리 좌표 정확; focus와 target cell 완전 가시; synthetic recenter request 0 | Quality Agent |
| `T-P17-028` | Geometry/Playwright 3 viewport | scrub 중·settled·last-row DOM 측정 | header/cell 시작·너비 오차 <=1px, selection <=2px, 상태 전환 workspace shift <=1px, physical `scrollHeight<=9,600,054px`, 마지막 cell bottom이 clearance 포함 grid 안 | Quality Agent |
| `T-P17-029` | Screenshot/이미지 검토 | 세 viewport의 scrub 중 row-number-only 상태와 final populated selection | overlap/clipping/예상 밖 overflow 0; loading·selection·focus 계층 구분; 캡처를 이미지 입력으로 열어 독립 시각 검토 PASS | Quality Agent |

의도된 grid scroll surface만 overflow 예외다. `geometry-results.json`에는 viewport, logical row,
segment start, scrollTop/scrollHeight/clientHeight, header/cell/selection/focus rect, request counter를 저장한다.

## 5. 실제 Tauri WebView2·성능·soak

Browser 결과는 WebView2 native scrollbar, 실제 Rust IPC/page latency와 segmented geometry를 대신하지
않는다. 별도 Tauri test identifier와 WebView data directory에서 자동화하며, test-only CDP 계측은 제품
release config나 capability에 남기지 않는다. 화면 배율별 수동 확인은 scheduling 변경과 독립적인
설치·환경 검증으로 분리한다.

| ID | 분류·계층 | 실제 환경/입력 | 정량 기대 결과 | 담당 역할 |
| --- | --- | --- | --- | --- |
| `T-P17-030` | Native source performance | high 5.85M Parquet, 서로 다른 uncached final offset으로 scrollbar·wheel 각 20 cycle | cycle별 중간 page/prefetch 0, final IPC 1; quiet 경로 last event→IPC p95 120..250ms, scrollend→IPC p95 <=50ms, IPC→populated p95 <=1s, 15s 영구 pending 0 | Quality + Tauri Platform |
| `T-P17-031` | Query/cache correctness | browser controlled source/query에서 query·projection 교체와 warmed page 재방문, native source cache 재방문 | query logical identity/checksum 일치; stale commit 0; native cache hit IPC 0, next-paint p95 <=50ms | Quality + Tauri Platform |
| `T-P17-032` | Native geometry/soak | 실제 5.85M source 20 scrub cycle와 keyboard/selection/segment recenter | physical surface <=200,000 rows, first/middle/last 및 마지막 row 완전 가시; focus 유지; pending timer/in-flight 증가 0, renderer RSS 증가 <=64MiB | Quality + Tauri Platform |

Native request count를 계측할 수 없거나 실제 5.85M source fixture를 열 수 없으면 해당 항목은 BLOCKED다.
브라우저 mock request count나 Chromium screenshot으로 PASS 처리하지 않는다.

## 6. 전체 gate와 재현 명령

| ID | 계층 | 명령/검사 | PASS 기준 | 담당 역할 |
| --- | --- | --- | --- | --- |
| `T-P17-033` | Frontend 전체 gate | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` | warning 은폐나 test 제외 없이 전부 exit 0; 세 viewport Phase 17 포함 | Root + Quality |
| `T-P17-034` | Rust/native 회귀 | `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-targets --all-features`, `npm run test:native:build`, 기존 native smoke와 Phase 17 smoke | 전부 exit 0; source/query/clipboard/Ctrl focus 회귀 0 | Root + Quality |
| `T-P17-035` | Release/보안/package | `npm run release`, EXE·NSIS 산출물 실행 smoke, manifest/lock/capability diff audit | release와 NSIS build exit 0; release에 remote debugging 0; 새 dependency·DTO·filesystem/shell/capability 확대 0 | Root + Tauri Platform |

집중 재검증은 `npm test -- VirtualDataGrid`, `npm run test:e2e -- e2e/phase17.spec.ts`와 Phase 17 native
smoke로 시작한다. 수정 뒤에는 집중 테스트뿐 아니라 `T-P17-033`~`035` 전체 회귀를 다시 실행한다.

## 7. UI·성능 증거 파일

```text
artifacts/phase-17/ui/
  browser-desktop.png
  browser-compact.png
  browser-minimum.png
  settled-desktop.png
  settled-compact.png
  settled-minimum.png
  geometry-results.json
  interaction-results.md
  visual-review.md
  native-desktop.png
  native-smoke.md
  native-scroll-performance.json
```

Quality Agent는 browser screenshot, geometry, interaction, visual review와 성능 원자료를 작성한다.
Tauri Platform Agent가 native 실행을 맡는 경우 native screenshot/smoke 원자료를 제공하고 Quality Agent가
독립 판정한다. screenshot은 존재 여부만 보지 않고 이미지 입력으로 열어 겹침, 잘림, 계층, selection,
focus와 row-number-only scrub 상태를 검토한다. 기준 이미지는 자동 갱신하지 않는다.

## 8. 필요한 실제 환경과 승인

- Windows WebView2, 실제 5.85M Parquet fixture와 충분한 임시 디스크
- Playwright Chromium 세 viewport와 fake timer를 지원하는 Vitest/jsdom
- release EXE와 NSIS builder; native test 전용 remote debugging port는 test config에서만 사용
- 새 dependency, backend DTO, Tauri capability와 보안 권한은 필요하지 않으며 이번 범위에서 승인 대상이 아니다.
- installer를 외부 배포하지 않는다. clean-machine 설치 검증은 이번 scheduling 변경의 필수 증거가 아니지만
  NSIS build와 로컬 실행 smoke는 필수다.

## 9. 설계 단계에서 확인된 위험

- `scrollend` 지원 여부가 WebView2 버전에 따라 달라질 수 있으므로 quiet fallback과 중복 종료 경쟁을 모두
  검증해야 한다.
- React effect의 visible row 변경과 native scroll event 순서가 달라 요청 counter를 잘못 셀 수 있다.
  probe reset 시점과 monotonic timestamp를 증거에 남긴다.
- segmented recenter가 dispatch하는 synthetic scroll을 사용자 표본으로 세면 scrub이 영구 연장되거나 마지막
  page가 중복 요청될 수 있다.
- scrub 중 row number만 이동하는 상태에서 이전 page의 값이 새 logical row처럼 보이면 데이터 무결성 결함이다.
  screenshot과 cell logical coordinate assertion을 함께 사용한다.
- backend cancellation을 추가하지 않으므로 scrub 진입 전 최대 2개 요청은 남을 수 있다. 요청 수를 숨기지 않고
  stale generation 폐기와 loading 정리를 독립 검증한다.
- native 성능의 page populated 시간은 backend cache·디스크 상태 영향을 받는다. scheduling latency와 backend
  page latency를 분리 기록하고, browser mock latency를 native PASS 근거로 사용하지 않는다.
