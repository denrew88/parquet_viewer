# Phase 15 테스트 계획

## 1. 판정 원칙

모든 성능 수치는 같은 PC, release build, 같은 fixture hash에서 raw sample을 보존해 비교한다.
Python Polars 측정은 가능성을 보여주는 참고값이며 제품 PASS 근거는 Rust 제품 경로에서만 만든다.
timeout을 늘리거나 memory gate를 완화해 PASS 처리하지 않는다.

기준 fixture는 `.tmp/phase13-fixtures/large/csv-5850000-high.csv`다.

- 크기: 979,427,914 bytes
- 형태: 5,850,000행×15열
- SHA-256: `082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd`

low-cardinality와 long-invalid 5.85M fixture도 동일한 lifecycle 검증에 포함한다.

## 2. 즉시 수정 gate

| ID | 검증 | 완료 기준 |
| --- | --- | --- |
| `P15-BITMAP-001` | 21,937,584-byte state bitmap 저장 | 개별 8-byte OS write 0, 큰 buffer/chunk 사용, release p95 250ms 이하 |
| `P15-BITMAP-002` | 저장 후 재개방과 CRC/header audit | 모든 cell state와 word 순서가 기존 format oracle과 동일 |
| `P15-BITMAP-003` | spy writer로 serialize/write 호출과 chunk 크기 측정 | word별 호출 0, 호출 수는 word 수가 아니라 파일 크기/chunk 크기에 비례, 전체 byte golden 동일 |
| `P15-BITMAP-004` | truncate/bit flip/dimension/trailing data | 각 손상이 cache hit로 통과하지 않고 typed corruption error 또는 안전한 재생성 |
| `P15-PUBLISH-001` | cold preparation publish byte 계수 | 완성 artifact의 동일-volume full-file copy 0 |
| `P15-PUBLISH-002` | commit 직전 source 교체·truncate·mtime 변경 | stale generation 게시 0, partial cleanup, direct source 유지 |
| `P15-PUBLISH-003` | crash/disk-full/rename 실패 fault injection | valid cache 손상 0, manifest 없는 partial은 hit 불가, janitor 회수 |
| `P15-PUBLISH-004` | immutable partial directory→stable key directory rename | rename 전 miss, rename 후 full hit만 허용하고 이것을 단일 commit point로 사용 |
| `P15-PUBLISH-005` | 기존 lease, writer 경쟁, 두 process 동시 publish | 기존 reader 중단·valid cache 손상 0, 새 generation은 lease 해제와 lock 계약 준수 |
| `P15-PUBLISH-006` | pinned handle 뒤 same-path/same-size replace와 rename/recreate | 시작·commit fingerprint가 stale source를 탐지하고 잘못된 cache 게시 0 |

## 3. 자동 타입 추론 gate

| ID | 검증 | 완료 기준 |
| --- | --- | --- |
| `P15-TYPE-001` | 최대 10,000 records 또는 8MiB 표본 | 먼저 도달한 상한에서 중단하고 메모리가 입력 전체에 비례하지 않음 |
| `P15-TYPE-002` | 기본 Auto open | 타입 확인 modal 0, preview 후 preparation 자동 시작 |
| `P15-TYPE-003` | integer/unsigned/float/boolean/date/timestamp/duration/string/empty 혼합 | 명확한 값만 해당 타입, 애매한 값과 all-empty 열은 Text |
| `P15-TYPE-004` | 표본 이후 비어 있지 않은 cast 실패 | profile 변경 0, state=`invalid`, raw lexeme 완전 보존 |
| `P15-TYPE-005` | 명시적 Ask Every Time과 사후 Parsing Profile | 이 두 경로에서만 확인·수정 UI, apply 시 새 generation |
| `P15-TYPE-006` | integer epoch와 모호한 날짜 문자열 | 자동 Timestamp 오판 0 |

## 4. cache·frontier 정확성 gate

| ID | 검증 | 완료 기준 |
| --- | --- | --- |
| `P15-CACHE-001` | compact partition schema | row ID, typed, 필요한 raw shadow, state만 존재하고 invalid Boolean Parquet 열 0 |
| `P15-CACHE-002` | source String/non-String와 profile 변경 | 모든 열의 원문을 source 재scan 없이 재구성 가능 |
| `P15-CACHE-003` | 64k 경계 전후 page/detail/default/raw copy | direct source oracle과 typed/raw/empty/invalid가 동일 |
| `P15-FRONTIER-001` | 준비 중 committed partition 안 page/Ctrl | 닫힌 partition과 bitmap snapshot만 읽고 즉시 응답 |
| `P15-FRONTIER-002` | frontier 밖 page/Ctrl | 같은 coordinator를 기다리고 별도 무제한 source scan 0, 새 요청이 이전 wait 취소 |
| `P15-CACHE-004` | Ready filter, 3-sort, filter→sort, sort→filter | DuckDB logical row identity와 결과 순서가 oracle과 동일 |
| `P15-CACHE-005` | filtered/sorted 부분·전체 선택 copy | 화면의 필터 행·정렬 순서·현재 visible column 순서만 복사 |
| `P15-CACHE-006` | raw 의미와 CSV dialect oracle | raw는 csv parser가 반환한 decoded field이며 quote/escape/CRLF/quoted newline에서 byte-for-byte 동일 |
| `P15-CACHE-007` | Text/numeric/temporal/all-empty/invalid/Skip profile 변경 matrix | source read 0, raw copy 동일, typed/state와 physical mapping 정확 |
| `P15-FRONTIER-003` | frontier 공개 뒤 실패·취소·session replace | 이전 generation page/state 폐기, direct preview 복귀, part/state/checkpoint generation 일치 |

## 5. Rust 1.97.1 toolchain 전환 gate

이 gate는 Polars 제품 통합보다 먼저 실행한다. 현재 dirty worktree를 입력 기준선으로 사용하고
`Cargo.toml`, `Cargo.lock`, source와 fixture는 양쪽에서 같아야 한다. 모든 Cargo 검증은 `--locked`,
`--no-default-features`로 Polars를 비활성화하며 `--all-features`를 사용하지 않는다. 전역 Rust default는
바꾸지 않고 명시적 toolchain 또는 repository pin만 사용한다.

| ID | 검증 | 완료 기준 |
| --- | --- | --- |
| `P15-TC-001` | 입력 snapshot과 dirty worktree 보존 | 실행 전후 기존 tracked/untracked 변경 보존, 의도된 toolchain pin과 증거만 추가 |
| `P15-TC-002` | toolchain identity | 기준선 Rust 1.88.0, 후보와 repository bare `rustc`는 1.97.1, 전역 default 불변 |
| `P15-TC-003` | edition과 pin | edition 2021 유지, `rust-toolchain.toml`은 정확히 1.97.1 고정 |
| `P15-TC-004` | Polars feature OFF | default dependency tree와 최종 제품 link에 Polars 없음, POC example 미빌드 |
| `P15-TC-005` | lockfile/resolver | `Cargo.lock` hash 불변, 양쪽 `cargo metadata --locked` 성공, dependency version/source 동일 |
| `P15-TC-006` | fmt/check/clippy | 양쪽 fmt check와 clippy `-D warnings` PASS, 새 warning 0 |
| `P15-TC-007` | 전체 Rust test | 양쪽 기본 전체 test PASS, PASS/ignored 목록 동일 |
| `P15-TC-008` | CSV와 cache parity | profile/raw/typed/state/invalid/cache lifecycle test 결과 동일 |
| `P15-TC-009` | Parquet parity | typed/timestamp/projection/page/filter/sort test 결과 동일 |
| `P15-TC-010` | OES H5/native library parity | transpose, axes, Blosc-zstd fixture PASS, 외부 HDF5/Blosc DLL 증가 0 |
| `P15-TC-011` | DuckDB query parity | filter/multi-sort/page/navigation/copy test 결과 동일, 외부 DuckDB DLL 증가 0 |
| `P15-TC-012` | Tauri native smoke | 대표 CSV/Parquet/H5가 release WebView2와 Rust IPC에서 PASS |
| `P15-TC-013` | release EXE | 양쪽 release 성공, 실행 PASS, PE import의 설명되지 않은 차이 0 |
| `P15-TC-014` | NSIS | 양쪽 NSIS build 성공, 실제 clean install smoke 전에는 별도 `BLOCKED` 표시 |
| `P15-TC-015` | 성능·RSS 무회귀 | 후보 median/p95와 peak RSS가 기준선 대비 10% 이내, peak RSS 1.5GiB 이하 |
| `P15-TC-016` | rollback | pin 제거와 명시적 1.88 명령으로 기준선 재현 가능, dependency rollback 불필요 |

EXE 증가는 `max(2%, 2MiB)`, NSIS 증가는 `max(2%, 512KiB)` 이내를 자동 PASS 범위로 한다. 초과하면
원인을 기록하고 `DECISION_REQUIRED`로 둔다. compiler 변경으로 binary hash가 달라지는 것은 정상이며
hash는 산출물 식별에만 사용한다. 기존 Rust CSV preparation의 절대 성능 FAIL은 toolchain 후보가
10% 이내여도 그대로 유지하고 `P15-TC-015`의 무회귀 판정과 섞지 않는다.

Cargo 1.97이 lockfile을 변경하거나 Rust 1.97 호환 수정이 필요하면 후보만 재실행하지 않는다. 변경된
같은 source/lockfile로 1.88과 1.97 matrix를 다시 실행한다.

## 6. Polars POC 채택 gate

`P15-POLARS-001`의 `default features off`는 채택 전 POC 격리 조건이다. 제품 gate 통과와 사용자의
통합 진행 승인 뒤에는 `polars-csv-provider`를 제품 default로 전환하되,
`--no-default-features` build와 Rust fallback 경로가 계속 통과해야 한다.

| ID | 검증 | 완료 기준 |
| --- | --- | --- |
| `P15-POLARS-001` | minimal feature dependency tree | pin version/features, default features off, 중복 Arrow/Parquet와 license 기록 |
| `P15-POLARS-002` | high CSV cold 5회 | Ready median 15초 이하, p95 20초 이하 |
| `P15-POLARS-003` | low/high/long-invalid resource | peak RSS 1.5GiB 이하, decoded batch 64MiB 이하, bounded queue 최대 2 batch |
| `P15-POLARS-004` | cancel/close/session replace | 요청 후 terminal 1초 이하, late commit 0, worker/handle/partial/lease 0 |
| `P15-POLARS-005` | CSV dialect matrix parity | delimiter/header/quote/escape/quoted LF·CRLF/BOM/trailing empty/long·invalid record를 사전 분류하고 기존 지원 축소 0 |
| `P15-POLARS-006` | 사전 분류된 Rust fallback | Polars partial hit 0, 중복 coordinator 0, csv crate page/raw/state/checkpoint oracle 동일 |
| `P15-POLARS-007` | 같은 commit feature OFF/ON release EXE/NSIS와 clean build | byte·증가율·build time·hash를 비교하고 채택 전까지 `DECISION_REQUIRED` |
| `P15-POLARS-008` | 새 process RSS sampling | baseline/absolute peak/poll interval/child 포함 여부 기록, absolute peak 1.5GiB 이하 |
| `P15-POLARS-009` | physical streaming plan과 내부 materialization audit | full collect 없음, product batch/queue와 dependency 내부 buffer를 구분하고 전체는 RSS에 포함 |
| `P15-POLARS-010` | parse/cast/backpressure/sink/sync/publish stage cancel | worker/handle/queue/partial/lock/lease가 0이 되는 terminal p95·max 1초 이하 |

## 7. 성능·관측 gate

| ID | 항목 | 완료 기준 |
| --- | --- | ---: |
| `P15-PERF-001` | preview | 500ms 이하 |
| `P15-PERF-002` | high cold preparation | 5회 median 15초 이하, p95 20초 이하 |
| `P15-PERF-003` | Ready random page | 100회 p95 20ms 이하 |
| `P15-PERF-004` | warm persistent hit | source scan 0, p95 1초 이하 |
| `P15-PERF-005` | Ready Ctrl navigation | source read 0, unfiltered warm 20ms, filtered/sorted warm 20ms 이하 |
| `P15-PERF-006` | filter+3-sort | 목표 1초, hard gate 2초 |
| `P15-PERF-007` | 64k×1 copy | p95 150ms 이하 |
| `P15-PERF-008` | cancel | terminal 1초 이하 |

두 번의 의도적인 source pass를 사용하는 후보에서는 다음을 따로 계수한다.

```text
preview_source_read_bytes
structure_source_read_bytes
conversion_source_read_bytes
foreground_source_read_bytes
navigation_source_read_bytes
```

- `structure_source_read_bytes <= source_file_size + 1MiB`
- `conversion_source_read_bytes <= source_file_size + 1MiB`
- preview를 포함한 자동 준비 총 source read는 `source_file_size×2.01 + 8MiB` 이하
- Ready 이후 `navigation_source_read_bytes = 0`

이 상한은 원본 CSV read 양이다. typed memory나 cache 파일 크기에 1.1배 제한을 적용하지 않는다.
cache는 raw/typed/state/checkpoint/manifest/total을 별도로 기록하고 사용자의 temporary storage hard
limit으로 판정한다.

| ID | source byte 검증 | 완료 기준 |
| --- | --- | --- |
| `P15-BYTE-001` | counting reader의 실제 `Read` 반환 byte | preview/structure/conversion/foreground/navigation을 분리하고 cache/output byte 혼입 0 |
| `P15-BYTE-002` | 사용자 동작 없는 자동 준비 | structure·conversion 각 file+1MiB, preview 포함 총 file×2.01+8MiB 이하 |
| `P15-BYTE-003` | preparing 중 direct foreground page/raw | 별도 계수하되 structure/conversion full scan 재시작 0 |
| `P15-BYTE-004` | Ready page/query/copy/navigation | 각 동작의 원본 CSV read 0 |

## 8. 회귀와 최종 증거

- Rust format, clippy `-D warnings`, 관련/전체 test
- frontend format, lint, typecheck, Vitest 전체
- Playwright 전체와 1440×900, 1024×768, 800×600 geometry/screenshot
- 실제 Tauri high CSV open/progress/cancel/Ready/page/query/Ctrl/copy
- release EXE, NSIS build와 runtime smoke
- 100회 open/cancel/close/reopen lifecycle soak
- bitmap/cache writer fault matrix와 원본 변경 race
- Parquet/H5, Timestamp/Duration, display/default/raw copy 회귀

Phase 14에서 남은 Windows clipboard full-copy, 150% DPI와 installer 실행 증거도 계속 추적한다.
외부 환경 때문에 실행하지 못한 항목은 숨기지 않고 `BLOCKED`로 남긴다.

## 9. 최종 Phase gate

| ID | 계층·담당 | 필수 결과 |
| --- | --- | --- |
| `P15-GATE-001` | Rust / Rust+Quality | 전체 test, fmt, clippy `-D warnings`, release benchmark PASS |
| `P15-GATE-002` | Frontend / Quality | format, lint, typecheck, Vitest 전체 PASS |
| `P15-GATE-003` | Browser / Quality | Playwright 전체와 세 viewport geometry·screenshot PASS |
| `P15-GATE-004` | Native / Tauri+Quality | 실제 high CSV open/progress/cancel/Ready/page/query/navigation PASS |
| `P15-GATE-005` | Native clipboard / Quality | 5.85M×1 source/query copy checksum, atomic clipboard, cancel/RSS PASS |
| `P15-GATE-006` | Native geometry / Quality | DPR 100%·150%에서 clipping·마지막 행·progress geometry PASS |
| `P15-GATE-007` | Lifecycle / Quality | 100-cycle open/cancel/close/reopen, fault와 cleanup PASS |
| `P15-GATE-008` | Packaging / Tauri+Quality | feature OFF/ON release·NSIS audit, 최종 선택 build와 installer smoke PASS |

각 결과는 `artifacts/phase-15/50-integration.md`에 명령, commit/EXE hash, raw artifact 경로와 함께
`PASS`, `FAIL`, `BLOCKED`, `DECISION_REQUIRED`로 기록한다. 하나라도 필수 PASS가 아니면 Phase 15를
완료로 바꾸지 않는다.
