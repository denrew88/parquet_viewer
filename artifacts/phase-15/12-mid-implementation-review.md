# Phase 15 중간 독립 구현 리뷰

- 검토 시점: 2026-07-23
- 검토 범위: buffered DVST writer, same-volume atomic persistent publish, bounded initial Auto
  inference, optional Polars Rust POC와 현재 Phase 15 증거
- 제외 범위: B안 hybrid v3 compact schema와 frontier는 다른 Agent가 구현 중이므로 코드 판정을
  선점하지 않고 `NOT_RUN` blocker로만 기록
- 변경 파일: 이 문서만 추가
- 중간 결론: **Phase 15 완료 불가 — 독립 수정 두 항목은 진전됐지만 compact/frontier, source byte,
  release 성능과 최종 gate가 남아 있음. Polars 기본 provider 채택은 RSS hard gate 실패로 기각하는
  것이 타당함**

## 1. 직접 실행한 검증

| 명령/검증 | 결과 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml cell_state_bitmap::tests -- --test-threads=1` | 8 PASS, 0 FAIL |
| `cargo test ... initial_inference -- --test-threads=1` | 3 PASS, 0 FAIL |
| `cargo test ... initial_auto_inference -- --test-threads=1` | 1 PASS |
| `cargo test ... invalid_data_in_expanded_inference -- --test-threads=1` | 1 PASS |
| `cargo test ... same_volume_publish_relocates_without_copy_and_rolls_back_before_commit` | 1 PASS |
| `cargo test ... concurrent_process_publishers_commit_once_and_active_valid_lease_blocks_eviction` | 1 PASS |
| `cargo test ... csv_persistent_cache_misses_when_same_path_size_and_times_have_a_new_file_identity` | 1 PASS |
| `cargo test ... same_size_source_mutation_during_csv_preparation_discards_the_artifact` | 1 PASS |
| `cargo test ... csv_persistent_cache_rejects_corrupt_entries_and_cleans_partial_staging` | 1 PASS |
| `cargo test ... csv_persistent_cache_survives_restart_and_source_mutation_forces_a_miss` | 1 PASS |
| default feature `cargo tree -i polars` | Polars 미포함 확인 |
| `cargo tree -i polars --features phase15-polars-poc` | optional Polars 0.51.0 포함 확인 |

첫 bitmap 실행은 변경 중인 working tree의 test build 때문에 73.4초가 걸렸고 실제 test body는
0.69초였다. 이는 `P15-BITMAP-001`의 release file-write p95 표본이 아니므로 성능 PASS 근거로
사용하지 않는다.

## 2. `10-test-plan.md` ID별 중간 판정

판정 규칙은 다음과 같다.

- `PASS`: 현재 ID의 필수 기준을 실행 증거가 모두 충족함
- `FAIL`: 실제 실행 또는 측정이 hard gate 위반을 재현함
- `NOT_RUN`: 일부 구현·단위 증거가 있어도 필수 표본이나 matrix가 완성되지 않음

### 2.1 bitmap·publish

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P15-BITMAP-001` | NOT_RUN | word별 write는 1MiB chunk로 제거됐지만 21,937,584B release p95 250ms 표본이 없음 |
| `P15-BITMAP-002` | PASS | DVST v1 header/endian/column-major/padding golden, large reopen parity와 cache CRC scrub이 통과 |
| `P15-BITMAP-003` | PASS | spy writer에서 word별 호출 0, 약 1MiB 단위 호출 수와 전체 byte golden 동일 |
| `P15-BITMAP-004` | PASS | truncate/dimension/trailing unit과 states bit-flip persistent-cache 재생성이 통과 |
| `P15-PUBLISH-001` | PASS | 제품 preparation test에서 `relocated_bytes>0`, `copied_bytes=0`; required artifact는 rename으로 이동 |
| `P15-PUBLISH-002` | PASS | append, same-size in-place mutation과 commit 전 fingerprint 불일치가 stale 게시를 차단 |
| `P15-PUBLISH-003` | NOT_RUN | rename failure와 temp-budget cleanup은 있으나 실제 crash·disk-full·모든 sync 지점 fault matrix 없음 |
| `P15-PUBLISH-004` | PASS | partial에 manifest와 artifact가 있는 동안 stable miss, directory rename 뒤에만 stable hit |
| `P15-PUBLISH-005` | PASS | 두 process publisher 중 1회 commit, 기존 shared lease 유지와 eviction 차단 test 통과 |
| `P15-PUBLISH-006` | PASS | Windows에서 path/size/time을 복원한 replacement도 file identity로 miss, pinned old handle과 path 불일치 검출 |

### 2.2 Auto 타입 추론

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P15-TYPE-001` | PASS | header 유무 10,000 data record, decoded 정확히 8MiB/overflow 제외, quoted newline logical record와 bounded retained data test 통과 |
| `P15-TYPE-002` | NOT_RUN | default setting이 Auto이고 코드상 modal을 열지 않지만 실제 open→preview→preparation UI/E2E sequence 증거 없음 |
| `P15-TYPE-003` | NOT_RUN | 기존 scalar inference unit은 있으나 Duration/all-empty/ambiguous와 initial sampler 전체 golden matrix 없음 |
| `P15-TYPE-004` | NOT_RUN | converter의 invalid/raw unit은 있으나 10,001번째 cast 실패가 product cache/page/raw copy까지 유지되는 통합 test 없음 |
| `P15-TYPE-005` | NOT_RUN | Ask Every Time·사후 profile UI와 새 generation 전체 흐름을 Phase 15에서 재검증하지 않음 |
| `P15-TYPE-006` | NOT_RUN | leading-zero 보수 추론은 있으나 integer epoch·모호한 날짜 initial Auto 전용 oracle 없음 |

### 2.3 compact cache·frontier

이 범위는 B안 hybrid v3 구현 중이므로 현재 중간 판정은 모두 blocker `NOT_RUN`이다.

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P15-CACHE-001` | NOT_RUN | 제품 hybrid v3 physical schema 구현·audit 진행 중 |
| `P15-CACHE-002` | NOT_RUN | profile 변경 raw foundation 재사용 경로 진행 중 |
| `P15-CACHE-003` | NOT_RUN | 새 schema의 64k 경계 page/detail/default/raw oracle 미실행 |
| `P15-FRONTIER-001` | NOT_RUN | committed partition 내부 page/Ctrl 미실행 |
| `P15-FRONTIER-002` | NOT_RUN | frontier 밖 coordinator wait/cancel 미실행 |
| `P15-CACHE-004` | NOT_RUN | 새 schema Ready filter·3-sort ordered checksum 미실행 |
| `P15-CACHE-005` | NOT_RUN | 새 schema query-aware 부분·전체 copy 미실행 |
| `P15-CACHE-006` | NOT_RUN | decoded raw dialect oracle 미실행 |
| `P15-CACHE-007` | NOT_RUN | Text/numeric/temporal/all-empty/invalid/Skip profile regeneration matrix 미실행 |
| `P15-FRONTIER-003` | NOT_RUN | 공개 뒤 failure/cancel/session replacement generation 폐기 미실행 |

### 2.4 Polars POC

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P15-POLARS-001` | NOT_RUN | 0.51.0 exact/minimal optional feature는 고정했지만 license와 전체 dependency/중복 audit artifact가 없음 |
| `P15-POLARS-002` | NOT_RUN | high 표본은 4회뿐이라 필수 cold 5회가 아님; 제품 기본 provider 후보도 RSS에서 먼저 탈락 |
| `P15-POLARS-003` | FAIL | 4회 peak RSS 4,547,330,048~4,550,197,248B로 1.5GiB hard gate를 모두 초과; low/long-invalid 전에도 탈락 |
| `P15-POLARS-004` | NOT_RUN | stage별 cancel/close/session replace와 terminal resource 0 미실행 |
| `P15-POLARS-005` | NOT_RUN | canonical high fixture만 실행했고 CSV dialect matrix 없음 |
| `P15-POLARS-006` | NOT_RUN | 제품 Rust fallback coordinator·partial·oracle 통합 미실행 |
| `P15-POLARS-007` | NOT_RUN | RSS 탈락에 따라 같은 commit 제품 EXE/NSIS feature OFF/ON 비교를 중단함 |
| `P15-POLARS-008` | FAIL | 새 process 20ms polling과 child 포함 absolute peak가 매번 1.5GiB 초과; baseline RSS 필드는 빠졌지만 실패 margin은 약 2.82배 |
| `P15-POLARS-009` | FAIL | verbose plan이 `running in-memory-sink`, `CACHE SET/HIT/DROP`을 재현; bounded physical streaming 아님 |
| `P15-POLARS-010` | NOT_RUN | parse/cast/backpressure/sink/sync/publish cancel matrix 미실행 |

### 2.5 제품 성능·source byte

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P15-PERF-001` | NOT_RUN | expanded initial inference 뒤 preview 500ms release/native 표본 없음 |
| `P15-PERF-002` | NOT_RUN | 선택될 Rust product provider high cold 5회 없음 |
| `P15-PERF-003` | NOT_RUN | Ready random page 100회 p95 없음 |
| `P15-PERF-004` | NOT_RUN | 새 cache schema warm persistent p95 없음 |
| `P15-PERF-005` | NOT_RUN | source/query 네 방향 Ctrl cold/warm 정규 표본 없음 |
| `P15-PERF-006` | NOT_RUN | 새 cache filter+3-sort 정규 표본 없음 |
| `P15-PERF-007` | NOT_RUN | 새 cache 64k×1 copy p95 없음 |
| `P15-PERF-008` | NOT_RUN | 새 preparation stage별 cancel terminal 표본 없음 |
| `P15-BYTE-001` | NOT_RUN | 현재 provider metric은 preparation 단일 `source_read_bytes` 중심이며 다섯 stage counting reader 증거 없음 |
| `P15-BYTE-002` | NOT_RUN | 자동 준비의 structure/conversion/preview 2-pass byte audit 없음 |
| `P15-BYTE-003` | NOT_RUN | preparing 중 foreground read와 worker full-scan 재시작 audit 없음 |
| `P15-BYTE-004` | NOT_RUN | Ready page/query/copy/navigation 각각의 원본 CSV read 0 matrix 없음 |

### 2.6 최종 gate

| ID | 판정 | 근거 |
| --- | --- | --- |
| `P15-GATE-001` | NOT_RUN | targeted Rust test만 실행; 전체 test/fmt/clippy/release benchmark 미실행 |
| `P15-GATE-002` | NOT_RUN | frontend 전체 gate 미실행 |
| `P15-GATE-003` | NOT_RUN | 전체 Playwright·세 viewport 새 UI 증거 미실행 |
| `P15-GATE-004` | NOT_RUN | 실제 high CSV Tauri 전체 흐름 미실행 |
| `P15-GATE-005` | NOT_RUN | Windows 5.85M×1 source/query clipboard 미실행 |
| `P15-GATE-006` | NOT_RUN | DPR 100/150% progress·last-row geometry 미실행 |
| `P15-GATE-007` | NOT_RUN | 100-cycle lifecycle/fault cleanup 미실행 |
| `P15-GATE-008` | NOT_RUN | 최종 선택 build와 installer smoke 미실행 |

## 3. 핵심 구현 검토

### 3.1 Polars RSS 탈락 결론 — 타당함

네 유효 실행의 absolute peak RSS는 4.547~4.550GB로 거의 동일하며 1.5GiB gate 대비
2.82배다. `with_new_streaming(true)`와 CSV reader cache off에서도 줄지 않았고 verbose plan에
in-memory sink와 optimizer cache가 직접 남았다. 20ms sampling이 짧은 peak를 놓칠 수는 있어도
관측값을 과대 계상할 이유는 없으므로 **bounded-memory provider 탈락 판정은 안전하다.**

14.09~15.86초 제품 total과 28열/5.85M행 출력은 가능성을 보여주지만 RSS hard gate를 상쇄하지
않는다. Polars를 query나 default preparation provider로 연결하지 않은 결정이 맞다.

다만 POC 문서의 “정합성 PASS”는 과장되어 있다. 현재 auditor는 Parquet row/column 수, DVST
magic/shape/length와 output hash만 확인한다. 실제 typed/raw cell checksum, state bit oracle,
invalid 또는 dialect parity를 비교하지 않는다. 이 문제는 RSS 탈락 결론을 바꾸지는 않지만
`P15-POLARS-005/006` PASS 근거로 재사용하면 안 된다.

Polars는 optional feature라 default dependency graph에는 들어오지 않고 feature를 켰을 때만
0.51.0이 나타난다. 그러나 Cargo manifest/lock에는 남아 있으므로 최종 fallback 결정에서 다음 중
하나를 명확히 해야 한다.

- 재현용 optional POC로 보존하고 all-features clippy/build와 optional license를 최종 gate에 포함
- 제품 저장소에서 제거하고 POC 결과 문서·JSON만 증거로 보존

어느 쪽이든 feature ON 제품 EXE/NSIS를 채택 후보처럼 보고할 필요는 없다.

### 3.2 same-volume publish·rollback·lease — 단위 계약은 통과, crash durability는 미완료

현재 경로는 query artifact의 세 required file을 cache root의 partial directory로 `rename`하고,
manifest를 file sync한 다음 source fingerprint commit check를 수행한다. partial marker 제거 뒤
partial directory를 stable key로 rename하는 시점만 cache hit가 된다. global process-shared lock이
검증과 rename을 감싸므로 다른 lookup이 반쯤 완성된 directory를 lease할 수 없다.

검증된 항목:

- commit check 실패 시 moved artifact를 source directory로 되돌리고 partial을 제거
- stable rename 실패 시 source artifact 복원, 기존 다른 valid generation과 lease 유지
- 동일 key를 두 process가 준비하면 선행 publish 1개만 채택하고 후행 source artifact는 이동하지 않음
- active shared lease는 LRU/cleanup에서 제거되지 않음
- same-path/same-size/time replacement도 Windows file identity와 pinned handle/path 재검사로 차단

남은 위험:

- rollback의 개별 reverse rename 실패는 best-effort로 무시한다. 원본 CSV는 손상되지 않지만 derived
  artifact가 사라져 재준비가 필요할 수 있으며 fault reason이 남지 않는다.
- artifact/manifest file sync는 있으나 partial marker 제거와 directory/root rename의 실제 power-loss
  durability는 증명되지 않았다.
- 실제 process kill, disk-full, manifest/marker/rename 각 경계 fault가 아직 없다.

따라서 `P15-PUBLISH-001/002/004/005/006`은 PASS지만 `P15-PUBLISH-003`은 `NOT_RUN`으로 유지한다.

### 3.3 initial Auto inference 오류 시점 — 동작은 의도적으로 지연되지만 계약·통합 증거가 필요

`scan_preview`는 synchronous하게 최대 10,000 data records 또는 decoded 8MiB를 읽는다. 다만
기존 preview 가용성을 보존하기 위해 오류 시점을 두 구간으로 나눈다.

- 기존 preview 경계 안의 parse/UTF-8/column-limit 오류: `CsvSource::open`에서 즉시 typed error
- 그 경계 뒤부터 inference cap 사이의 오류: inference sample을 그 직전에서 중단하고 open·preview는
  성공시킨 뒤 index/preparation worker가 full scan에서 오류를 terminal failure로 보고

현재 조건은 `logical_records_read < MAX_PAGE_SIZE + 1`이므로 header 유무에 따라 즉시 오류로 보는
data record 수가 다르다. header present는 header+200 data, header absent는 201 data record까지다.
row 250 invalid UTF-8 fixture가 preview 200행을 유지한 뒤 worker failure가 되는 단위 test는 통과했다.

이 선택은 “초기 inference가 넓어졌다는 이유로 preview 뒤쪽 오류가 파일 open 자체를 늦게 실패시키지
않는다”는 점에서 합리적이다. 그러나 다음이 아직 없다.

- 이 row-dependent 오류 시점의 제품 계약 명시
- 64MiB 이상 파일에서 index worker 대신 preparation coordinator가 같은 terminal error를 내는 통합 test
- sample이 오류로 조기 중단됐을 때 profile을 잠정 추천으로 표시할지에 대한 상태 계약
- synchronous 10k/8MiB scan을 포함한 preview 500ms release/native 측정

오류를 영구히 숨기는 코드는 아니지만, 위 통합 증거 전에는 `P15-TYPE-002/004`와
`P15-PERF-001`을 PASS로 올리면 안 된다.

## 4. 중간 결함과 blocker

### HIGH

1. B안 hybrid v3 compact schema, raw foundation, frontier와 모든 consumer parity가 아직 `NOT_RUN`이다.
2. preview/structure/conversion/foreground/navigation source byte counter가 분리되지 않아 2-pass와
   Ready source read 0을 증명할 수 없다.
3. 선택될 Rust product provider의 high cold 5회, RSS, page/navigation/query/copy 성능 근거가 없다.
4. 실제 Tauri, Windows clipboard, DPR 150%, lifecycle과 installer를 포함한 최종 gate가 전부 남아 있다.

### MEDIUM

1. Polars POC의 parity PASS는 shape/header 수준이며 cell/state/dialect oracle이 아니다.
2. Polars optional dependency를 재현용으로 남길지 제거할지 최종 fallback 정책이 확정되지 않았다.
3. publish rollback 실패와 power-loss directory durability의 fault evidence가 없다.
4. initial inference 오류 노출 시점이 header/row 위치에 따라 달라지지만 제품 계약과 large-file
   coordinator test가 없다.
5. 10k/8MiB synchronous inference 뒤 preview 500ms가 아직 측정되지 않았다.

## 5. 다음 검증 순서

1. compact Agent 결과가 들어오면 hybrid v3 schema, profile raw 재사용과 frontier generation부터
   독립 재검증한다.
2. stage별 counting reader를 연결해 `P15-BYTE-001~004`를 먼저 채운다.
3. 개선된 Rust product provider로 high cold 5회, RSS, page/navigation/query/copy 정규 표본을 수집한다.
4. crash/disk-full publish fault와 large-file initial inference failure timing을 추가한다.
5. optional Polars 보존/제거를 확정한 뒤 전체 Rust/frontend/E2E/native/release/installer gate를 실행한다.

필수 `NOT_RUN`이 남아 있으므로 현재 Phase 상태는 `진행 중`이어야 하며 완료로 변경하면 안 된다.
