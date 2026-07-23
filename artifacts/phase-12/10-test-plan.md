# Phase 12 테스트 계획

- 상태: 실행 완료
- 작성일: 2026-07-21
- 대상: CSV·Parquet query result index/page, 공통 grid navigation, query-aware copy와 H5 구조 판별·복사

## 1. Fixture와 reference

대용량 fixture는 Git에 직접 넣지 않고 `.tmp/phase12-query/`에 결정적으로 생성한다. generator,
인자, schema, row group, cardinality, 실제 byte size와 SHA-256은 `fixture-manifest.json`에 기록한다.

| Fixture | 용도 |
| --- | --- |
| `query-low-5850000-15c.parquet` | 보고된 `group_id` 정렬과 pending page 회귀 |
| `query-high-5850000-15c.parquet` | source row가 흩어진 sparse random page와 high-cardinality 정렬 |
| `query-null-empty-small.parquet` | typed Parquet의 null, empty string과 whitespace query boundary |
| `query-invalid-small.csv` | CSV profile의 invalid/null/empty와 원문 보존 oracle |
| `fixtures/phase-7/small-csv.csv` | CSV null/empty와 정렬 후 navigation 의미 |
| `fixtures/phase-7/large-csv.csv` | CSV checkpoint sparse page와 빠른 PageUp/PageDown 회귀 |
| OEF v3 int32/int64 fixture | query 비지원 유지와 공통 absolute navigation 회귀 |
| H5 structural matrix | `format` missing/`oesh5`/다른 값, signature/version/shape/dataset/type/compression 판별 |
| wide H5 fixture | 소수 time row×다수 wavelength column 적응형 copy batch |

`scripts/generate_phase12_fixtures.py`는 Phase 9의 `full15` batch writer를 재사용하되 Phase 12
manifest와 oracle은 별도로 만든다. `scripts/audit_phase12_fixtures.py`가 schema, row group, cardinality,
파일 SHA-256과 reference를 다시 검사한다. reference는 NumPy와 생성 수식으로
`(group_id ASC, source_row_id ASC)`를 계산한다. first/middle/last/EOF, 986,803과 seed 12,012 기반
20개 page의 source row identity와 typed checksum을 `reference-pages.json`에 저장한다. 제품 DuckDB
결과를 reference 생성에 재사용하지 않는다.

구현 전 기존 제품에서 다음 회귀가 실제로 FAIL하는지 먼저 고정한다: 2열/window index(IDX-001),
source-before-limit join(PAGE-001), permanent pending(RACE-005), 전역 Filter와 typing 자동 조회
(QUX-003/004), filter/sort focus reset(QUX-006), 200행 page copy 반복과 H5 64열 고정 분할
(COPY12-005/006), `format` 필수 검사(H5-003). 마지막 row geometry는 Phase 12 시작 전에 수정된
passing regression이므로 `e2e/phase11.spec.ts`와 native geometry를 재실행해 보존한다.

## 2. 정렬 index

| ID | 계층 | 검증 |
| --- | --- | --- |
| IDX-001 | SQL unit | sort/filter SQL이 `query_result(__dv_row_id)` 한 열만 만들고 ordered window position을 생성하지 않는다. |
| IDX-002 | Rust | empty/1/200/5.85M 결과에서 physical `rowid`가 0..count-1이고 source identity와 1:1이다. |
| IDX-003 | Rust | asc/desc와 Shift 3-column sort가 원본 row identity tie-breaker로 결정적이다. |
| IDX-004 | Rust | 모든 sort 방향에서 nulls-last이며 empty string은 null과 합쳐지지 않는다. |
| IDX-005 | Inspect | result index schema와 plan에 display/raw/source value 복제, 별도 position column과 ordered window가 없다. |
| IDX-006 | Error | rowid 연속성 invariant 실패를 typed query error로 반환하고 partial result를 commit하지 않는다. |
| IDX-007 | Lifecycle | query 교체·취소·실패·tab close 뒤 index와 관련 cache가 해제된다. |
| IDX-008 | Transaction | 같은 result-owned connection에서 materialization transaction을 commit한 뒤 read-only lifetime transaction을 시작하고, page/find/boundary가 그 snapshot을 사용하며 종료 시 rollback한다. |

## 3. Two-stage page와 projection

| ID | 계층 | 검증 |
| --- | --- | --- |
| PAGE-001 | SQL/Inspect | 최대 200개의 `(position, source_row_id)`를 source value 접근 전에 확정한다. |
| PAGE-002 | Contract | Rust/TypeScript `ReadQueryPageRequest.columns`가 1..64, unique, non-empty를 동일하게 검사한다. |
| PAGE-003 | Rust | page 응답 column 순서가 요청 projection과 같고 logical result column 목록과 분리된다. |
| PAGE-004 | Rust | first/middle/986,803/last/EOF page의 source identity와 typed checksum이 reference와 같다. |
| PAGE-005 | Parquet audit | selected row group, `RowSelection`, projection과 decoded row/column 수가 요청 범위에 제한된다. |
| PAGE-006 | Parquet | high-cardinality 200개 sparse identity가 전체 15열 또는 전체 row group value decode를 만들지 않는다. |
| PAGE-007 | CSV | checkpoint 기반 sparse read가 profile, invalid/null/empty와 원문 정밀도를 보존한다. |
| PAGE-008 | Value | int64/uint64/decimal/timestamp ns/timezone/binary/nested의 source/raw/display 계약을 보존한다. |
| PAGE-009 | Separation | grid query page만 64열·200행 계약을 사용하고 copy task가 page API 반복으로 구현되지 않는다. |
| PAGE-010 | Regression | filter/search/find/distinct가 새 physical position 계약에서 기존 결과와 같다. |

## 4. Navigation

| ID | 계층 | 검증 |
| --- | --- | --- |
| NAV12-001 | Unit | 일반 화살표, Home/End, PageUp/PageDown target을 query logical position으로 계산한다. |
| NAV12-002 | Unit | Ctrl+Alt 네 방향은 query row count와 logical projection의 절대 경계를 사용한다. |
| NAV12-003 | Rust | Ctrl+Up/Down이 정렬된 query 순서의 occupied/empty 경계를 찾고 source 순서를 사용하지 않는다. |
| NAV12-004 | Rust | Ctrl+Left/Right가 현재 logical row의 query projection 순서와 empty 의미를 사용한다. |
| NAV12-005 | Rust | non-null numeric/Boolean column의 위·아래 경계를 O(1) fast path로 계산한다. |
| NAV12-006 | Rust | nullable/string block scanner와 cache가 null/empty만 비어 있다고 판정한다. |
| NAV12-007 | Frontend | Ctrl target IPC 1회와 target page cache miss 최대 1회이며 intermediate page 요청은 0회다. |
| NAV12-008 | Component | Ctrl/Ctrl+Alt와 두 Shift 조합이 anchor, active, rect와 focus를 보존한다. |
| NAV12-009 | Component | 연속 PageDown/PageUp이 목표 page를 건너뛰거나 이전 page를 다시 표시하지 않는다. |
| NAV12-010 | E2E | sort 전후 first/middle/last에서 모든 key 조합의 logical coordinate와 visible focus가 같다. |
| NAV12-011 | Native | 실제 5.85M Parquet 정렬 뒤 Ctrl·Ctrl+Alt·PageDown/PageUp을 WebView2에서 검증한다. |
| NAV12-012 | Regression | query가 없는 CSV/Parquet/OEF Data view의 Phase 11 navigation 결과가 변하지 않는다. |
| NAV12-013 | Resource | occupancy block은 column 1개, identity 16,384개, estimate 16 MiB 이하이며 DataValue 문자열을 만들지 않는다. |

## 5. 요청 경쟁과 pending

| ID | 계층 | 검증 |
| --- | --- | --- |
| RACE-001 | Unit | 같은 offset/projection 요청을 하나로 병합한다. |
| RACE-002 | Unit | visible foreground가 완료되기 전에 adjacent prefetch를 시작하지 않는다. |
| RACE-003 | Unit | vertical/horizontal generation이 바뀐 늦은 page를 폐기한다. |
| RACE-004 | Rust | connection mutex는 identity slice 조회 뒤 source decode 전에 해제된다. |
| RACE-005 | E2E | 빠른 wheel/scrollbar/PageDown 입력 후 loading cell이 영구 `pending`으로 남지 않는다. |
| RACE-006 | E2E | pending 중 sort/filter 교체, tab 전환과 close가 wrong-document page를 적용하지 않는다. |
| RACE-007 | Error | page 실패·취소가 선택과 scroll을 원자적으로 유지하고 재시도 가능한 오류를 표시한다. |
| RACE-008 | Tab | inactive tab의 virtualizer/request가 정지하고 cache가 유효한 tab 복귀 page IPC가 0이다. |
| RACE-009 | Focus | filter/sort commit 중 target page 검증 전 focus·scroll을 옮기지 않고 stale query 좌표를 commit하지 않는다. |
| RACE-010 | Timeout | foreground page가 15초 안에 terminal state가 되지 않으면 loading key를 제거하고 같은 query/projection으로 Retry 가능한 typed timeout을 표시한다. |

## 6. 성능과 자원

release backend와 release Tauri를 분리 측정한다. 1회 warm-up 뒤 최소 5회 실행하고 p50/p95/max,
peak RSS, temp high-water mark, source bytes/row groups decoded와 IPC 횟수를 기록한다.

| ID | 계층 | 필수 예산 |
| --- | --- | --- |
| PERF12-001 | Release Rust | 5.85M low `group_id ASC` index 준비 p95 1.5초 이하 |
| PERF12-002 | Native UI | sort 적용부터 첫 visible page p95 2초 이하 |
| PERF12-003 | Release Rust | 준비된 low first/middle/last page p95 250ms 이하 |
| PERF12-004 | Release Rust | 준비된 high random 20 pages p95 1초 이하 |
| PERF12-005 | Native UI | 연속 20회 PageDown에서 page별 visible settle p95 1초 이하, 영구 pending 0 |
| PERF12-006 | Navigation | non-null Ctrl boundary p95 100ms, nullable/string cold p95 2초와 cache hit p95 250ms 이하 |
| PERF12-007 | Resource | query peak RSS 1.5 GiB, process temp 10 GiB 이하 |
| PERF12-008 | Audit | page당 identity 200, projection 64, 전체 UI row materialization 0 |
| PERF12-009 | Copy | 5.85M행×1열 copy가 page IPC 0, frontend value batch IPC 0이며 backend batch/progress를 사용한다. |
| PERF12-010 | H5 copy | wide H5 copy가 고정 64열 분할보다 적은 hyperslab read를 사용하고 cell/byte/chunk 상한을 지킨다. |
| PERF12-011 | Filter navigation | filter 적용 뒤 Ctrl+Left/Right p95 250ms 이하이고 현재 row 1개 외 full-result join/decode가 없다. |
| PERF12-012 | Release Rust | high-cardinality 1열 index 준비 p95 2초 이하이며 공통 peak RSS/temp 예산을 만족한다. |
| PERF12-013 | Release Rust | low/high selective filter+3-column stable sort 준비·first page p95 2.5초 이하, non-selective는 p95 4초 이하이며 공통 자원 예산을 만족한다. |

PERF12-012/013 hard budget은 2026-07-21 첫 release baseline과 네이티브 타입 정렬 최적화 뒤 확정했다.
성능 예산 실패를 fixture 압축률, thread 수 증가나 timeout 증가만으로 숨기지 않는다. low와 high
cardinality를 별도로 기록하고 하나를 다른 하나의 대체 증거로 사용하지 않는다. 각 run은 이전
result/temp를 정리하고 1회 warm-up 뒤 5회 측정한다. OS file cache를 유지한 warm-file 조건과 첫 실행
cold 조건을 구분하며 DuckDB thread 수, CPU/RAM/storage, RSS 표본 주기와 temp high-water 산식을
`benchmark-results.json`에 기록한다. PERF12-012/013은 위 hard budget을 cold/warm 각각 만족해야 한다.

## 7. Lifecycle과 정리

| ID | 계층 | 검증 |
| --- | --- | --- |
| LIFE12-001 | Rust | query success 뒤 index, sparse provider와 cache가 result lifetime 동안만 유지된다. |
| LIFE12-002 | Rust | cancel/failure가 partial index를 registry에 commit하지 않고 temp를 정리한다. |
| LIFE12-003 | Integration | sort/filter replace가 이전 result index, boundary cache와 page generation을 폐기한다. |
| LIFE12-004 | Integration | tab close/session change가 in-flight foreground/prefetch와 provider read 결과를 적용하지 않는다. |
| LIFE12-005 | Soak | query create/scroll/replace/close 100회 뒤 active query/task/temp는 0, handle은 baseline으로 복귀하고 RSS 증가 추세가 지속되지 않는다. |
| LIFE12-006 | Copy cleanup | copy success/failure/cancel/query replace/tab close 뒤 temp, task와 clipboard staging resource가 누적되지 않는다. |
| LIFE12-007 | Crash cleanup | 강제 종료로 남긴 owner temp를 다음 startup janitor가 정리하고 다른 active process temp는 보존한다. |

## 8. Query 조합·Find·선택·순서 변경

| ID | 계층 | 검증 |
| --- | --- | --- |
| QUX-001 | Rust/reference | filter→sort와 sort→filter의 최종 plan이 같으면 count, ordered source identity와 checksum이 같다. |
| QUX-002 | Rust | multi-column asc/desc, priority와 source row ID tie-breaker가 nulls-last reference와 같다. |
| QUX-003 | Component | 전역 match-only Filter control은 없고 header typed column filter는 유지된다. |
| QUX-004 | Component/E2E | `Ctrl+F`가 Find를 열어 focus하고 typing과 debounce만으로 backend call이 0이다. |
| QUX-005 | E2E | `조회` 또는 Enter에서 한 번 실행하고 Esc, previous/next가 committed result position을 이동한다. |
| QUX-006 | Component | filter/sort 뒤 column ID와 logical row를 보존·clamp하고 range는 active cell 하나로 축소한다. |
| QUX-007 | E2E/Geometry | 보존한 active cell이 target page commit 뒤 viewport에 완전히 보인다. |
| QUX-008 | Component/E2E | 파일 tab drag와 keyboard로 여는 tab context menu의 `왼쪽으로 이동`/`오른쪽으로 이동`이 session/query/cache identity를 바꾸지 않는다. |
| QUX-009 | Component/E2E | column header drag와 keyboard로 여는 column menu의 `왼쪽으로 이동`/`오른쪽으로 이동`이 document별 ID order, widths, visibility, filter와 sort를 보존한다. |
| QUX-010 | Component/E2E | 다중 정렬 panel의 staged priority·direction·remove·reorder는 Apply에서 한 번 commit되고, Shift+header 즉시 commit과 같은 ordered plan을 만든다. |

## 9. Query-aware copy

| ID | 계층 | 검증 |
| --- | --- | --- |
| COPY12-001 | Contract | 부분 선택이 filtered result의 선택 logical row와 visible reordered column만 sorted 순서로 복사한다. |
| COPY12-002 | Contract | 전체 선택이 filter를 통과한 모든 row만 복사하고 hidden column을 제외한다. |
| COPY12-003 | Regression | Find current match가 selection을 바꾸지 않은 한 copy row 집합과 순서를 바꾸지 않는다. |
| COPY12-004 | Rust | query copy가 position→source identity를 bounded block으로 읽고 source/query 순서로 TSV를 생성한다. |
| COPY12-005 | Rust | 5.85M행×1열이 200행 IPC 반복과 WebView 전체 문자열 누적 없이 progress/cancel 가능하다. |
| COPY12-006 | H5 | wide H5가 row×column cell/byte 예산에 따라 연속 wavelength hyperslab을 병합하고 column 순서를 복원한다. |
| COPY12-007 | Limit | cell, serialized byte, decoded H5 chunk와 temp cap 경계값이 wire/apply/task에서 일치한다. |
| COPY12-008 | Atomicity | success에서만 system clipboard를 한 번 교체하고 실패·취소에서는 이전 clipboard를 보존한다. |
| COPY12-009 | State | operation ID와 시각으로 현재 attempt와 최근 이전 attempt가 구분된다. |
| COPY12-010 | Error | SelectionLimit/ByteLimit/SourceRead/QueryStale/Cancelled/Serialize/ClipboardWrite가 원인과 stage를 표시한다. |
| COPY12-011 | Stale | query/session/projection이 바뀐 copy는 과거 row를 기록하지 않고 typed stale/cancel terminal state가 된다. |
| COPY12-012 | Native | 실제 Windows clipboard와 Excel smoke에서 허용 범위를 붙여넣고 1,048,576행 초과 경고를 확인한다. |

5.85M×1 성공 fixture는 `row_id` 한 열, header 없음, raw TSV와 query sort 순서를 사용한다. copy 시작
snapshot은 `maxCells=10,000,000`, `maxBytes=64 MiB`로 고정하고 manifest의 정확한 serialized byte와
SHA-256 oracle이 한도 안에 있음을 preflight한다. backend batch는 한 번에 최대 64,000 cell 또는
8 MiB serialized estimate 중 먼저 도달하는 경계로 제한한다. 5회 release 측정에서 throughput,
peak RSS, temp high-water를 기록하고, progress event 간격은 1초를 넘지 않으며 Cancel은 2초 안에
terminal state가 되어야 한다. 성공은 clipboard write 1회와 전체 hash 일치, 실패·취소는 사전 sentinel
유지로 검증한다. current+history는 최근 5개 operation만 보존하며 Retry는 새 operation ID와 새 snapshot을
만든다. copy 시작 뒤 column reorder는 시작 snapshot의 column 순서를 유지하고 query/session 교체는
`QueryStale` 또는 `Cancelled`로 끝난다.

## 10. H5 구조 판별

| ID | 계층 | 검증 |
| --- | --- | --- |
| H5-001 | Registry | 대소문자 무관 `.h5`/`.hdf5`만 H5 후보가 되고 broad Windows association은 추가하지 않는다. |
| H5-002 | Rust | HDF5 signature가 없으면 dataset open 전에 typed invalid-container 오류를 반환한다. |
| H5-003 | Rust | `format` missing, `oesh5`, `oefh5`, `oesf5`, 임의 문자열, integer/array attribute가 모두 동일한 유효 구조라면 열린다. |
| H5-004 | Rust | `format_version=3`, `shape=[n_time,n_wavelength]`와 실제 axis/oes shape 불일치를 거부한다. |
| H5-005 | Rust | time/wavelength integer·float·string과 oes int32/int64 matrix를 허용하고 다른 rank/type은 거부한다. |
| H5-006 | Rust | `/oes[n_wavelength,n_time]` transpose checksum이 reference와 같다. |
| H5-007 | Runtime | Blosc v1 32001/Zstd를 clean runtime에서 읽고 미지원 filter/codec은 typed 오류다. |
| H5-008 | Security | soft/external link, VDS, external storage, oversized decoded chunk와 overflow 입력을 거부한다. |

H5 matrix는 valid structure에 `format`이 없는 경우와 string `oesh5`, `oefh5`, `oesf5`, 임의 문자열,
integer scalar와 integer array인 경우를 포함하며 모두 같은 checksum으로 열려야 한다. 확장자는
`.h5/.H5/.hdf5/.HDF5`, valid signature의 잘못된 확장자, fake signature를 분리한다. `format_version`의
signed/unsigned integer scalar와 잘못된 값/rank/type, `shape`의 integer width·길이·rank/type,
axis와 `/oes`의 missing/rank/dtype/shape, int32/int64, 알려지지 않은 filter마다 expected typed error
code를 manifest에 기록한다. clean-runtime Blosc/Zstd와 unknown compression 결과는
`h5-matrix-results.json`에 남긴다.

## 11. UI·geometry·native

| ID | 계층 | 검증 |
| --- | --- | --- |
| UI12-001 | Component | foreground loading, prefetch와 typed page error 상태가 구분된다. |
| UI12-002 | Geometry | pending→populated 전환에서 row/header/selection geometry가 움직이지 않는다. |
| UI12-003 | Geometry | PageUp/PageDown과 Ctrl target 뒤 active cell이 viewport 내부에 완전히 보인다. |
| UI12-004 | E2E | 1440×900, 1024×768, 800×600에서 정렬 후 scroll/navigation interaction이 PASS다. |
| UI12-005 | Screenshot | populated, foreground loading과 page error 상태에 clipping/overlap이 없다. |
| UI12-006 | Native | 실제 WebView2 scroll, IPC, focus와 system resource 기록이 browser mock과 일치한다. |
| UI12-007 | Geometry | 실제 마지막 row의 content/border가 horizontal scrollbar 위에 완전히 보인다. |
| UI12-008 | Visual | Find, multi-sort, copy current/history와 drag 상태가 세 viewport에서 clipping·overlap 없이 보인다. |
| UI12-009 | E2E | 5.85M tab을 다른 파일과 20회 왕복해 blank/blur/loading flash와 focus 이탈이 없다. |

UI 색상이나 layout을 의도적으로 바꾸지 않더라도 loading/pending 상호작용과 focus geometry가
변하므로 `docs/UI_VALIDATION.md`의 interaction, geometry, 세 viewport와 실제 Tauri 검증을 적용한다.
tab 복귀는 20회 동안 page IPC 0, `aria-busy`/loading 전환 0, rendered data row가 0인 animation frame 0과
active-cell focus 유지를 계측한다. 마지막 row와 tab 복귀 geometry는 실제 WebView2 100%와 150% DPI에서
검증하며 해당 환경이 없으면 PASS가 아니라 BLOCKED다.

## 12. 전체 gate

### 실행 명령

```powershell
python scripts/generate_phase12_fixtures.py --output .tmp/phase12-query --manifest artifacts/phase-12/fixture-manifest.json --reference artifacts/phase-12/reference-pages.json --rows 5850000 --row-group-size 100000 --seed 12012 --expected-upper-gib 10
python scripts/audit_phase12_fixtures.py --manifest artifacts/phase-12/fixture-manifest.json --reference artifacts/phase-12/reference-pages.json --output artifacts/phase-12/fixture-audit.json
python scripts/generate_phase12_h5_matrix.py --output .tmp/phase12-h5 --manifest .tmp/phase12-h5/manifest.json
python scripts/audit_phase12_h5_matrix.py --manifest .tmp/phase12-h5/manifest.json --output artifacts/phase-12/h5-matrix-results.json
cargo test --manifest-path src-tauri/Cargo.toml phase12_
python scripts/run_phase12_bench.py --manifest artifacts/phase-12/fixture-manifest.json --reference artifacts/phase-12/reference-pages.json --fixture-audit artifacts/phase-12/fixture-audit.json --output artifacts/phase-12/benchmark-results.json --plan-output artifacts/phase-12/query-plan-audit.json
npm run test:e2e -- e2e/phase12.spec.ts
npm run test:native:build
node scripts/native_phase12_smoke.mjs --manifest artifacts/phase-12/fixture-manifest.json --output artifacts/phase-12/native-results.json
```

`run_phase12_bench.py`는 `--execute`가 없으면 수치를 만들지 않고 `NOT_RUN` evidence scaffold만 쓴다.
Rust ignored release harness가 raw counter JSON을 구현한 뒤에만 `--execute`로 실제 측정한다. native script는
12A Platform handoff에서 추가한다. 최종 공통 gate는 아래 명령을 각각 한 번 실행한다.

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

- Rust: format, clippy, unit/integration, ignored release performance test
- Frontend: format, lint, typecheck, unit/component
- Playwright: 영향 spec 후 최종 `npm run test:e2e` 1회
- Native: 실제 5.85M Parquet의 sort/scroll/navigation/query copy/tab restore와 wide H5 copy smoke
- Release: 최종 코드 확정 뒤 Tauri/NSIS build 1회
- Security: source read-only, bound parameter/quoted identifier, temp path와 resource cap 회귀
- Quality: 구현 Agent와 다른 Quality Agent가 plan, sparse decode audit와 pending 재현을 독립 검토

### 증거 경로와 소유 역할

- Quality: `fixture-manifest.json`, `reference-pages.json`, `fixture-audit.json`,
  `query-plan-audit.{json,md}`, `benchmark-results.json`, `lifecycle-results.json`,
  `copy-results.json`, `h5-matrix-results.json`, `e2e/phase12.spec.ts`와 browser UI evidence
- Rust Data: 소유 모듈 unit/integration test와 test-only plan/decode counters
- Grid UX: component/unit test; Phase 12 E2E와 최종 screenshot 판정은 Quality가 독립 소유
- Platform: `native-results.json`, `ui/native-smoke.md`, native screenshot과 clipboard/DPI evidence
- Root: ID→완료조건 trace, 공통 DTO parity와 최종 PASS/FAIL/BLOCKED 판정

UI screenshot은 generic 3장으로 여러 상태를 덮어쓰지 않는다.
`ui/{query-loading,find,multisort,column-reorder,copy-failure-history,tab-restore,last-row}-{wide,compact,minimum}.png`
형식을 사용하고 `geometry-results.json`과 `interaction-results.md`에 test ID와 파일을 연결한다.

필수 performance/native 증거가 없거나 HIGH/MEDIUM 결함이 남으면 Phase 12는 완료가 아니라
`BLOCKED` 또는 `FAIL`로 판정한다.
