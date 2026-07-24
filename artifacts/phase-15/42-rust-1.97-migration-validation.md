# Phase 15 Rust 1.97.1 전환 검증

## 1. 범위와 판정

이 문서는 Polars 제품 통합 전 Stage 1인 Rust 1.88.0→1.97.1 toolchain 전환만 검증한다. Polars
dependency는 optional 상태로 유지했고 `phase15-polars-poc` feature를 활성화하지 않았다.

현재 판정은 **Stage 1 미완료**다. 기능·빌드·패키징은 PASS했지만 성능·clipboard 환경 검증이
BLOCKED이고 새 linker warning 0 기준을 충족하지 못했다. Rust 1.97.1에서 기존
제품이 컴파일되지 않거나 데이터 결과가 달라지는 결함은 발견하지 못했다. 다만 장시간 native build
뒤 Windows clipboard가 1.88과 1.97 양쪽에서 사용할 수 없게 됐고 시스템 전반 성능도 불안정해져,
clipboard 완주와 동일 환경 성능 비교는 다시 실행해야 한다. 이 항목을 숨기고 Stage 1 전체를 완료로
표시하지 않는다.

## 2. 변경

- repository `rust-toolchain.toml`에 stable Rust 1.97.1, minimal profile, Clippy와 Rustfmt 고정
- 전역 default toolchain은 stable 1.88.0으로 유지
- Rust edition은 2021 유지
- Rust 1.97의 새 진단에 맞춰 다음 의미 무변경 호환 수정
  - page decode가 끝난 뒤 읽히지 않는 `current_row += 1` 제거
  - 세 개의 `% ... == 0` 표현을 `is_multiple_of`로 변경
- optional Polars POC example에 Rustfmt 적용
- `Cargo.toml`, `Cargo.lock` dependency를 toolchain 전환 과정에서 변경하지 않음

## 3. 입력 고정

| 항목 | 값 |
| --- | --- |
| 기준 compiler | `rustc 1.88.0 (6b00bc388 2025-06-23)` |
| 후보 compiler | `rustc 1.97.1 (8bab26f4f 2026-07-14)` |
| repository edition | 2021 |
| `Cargo.lock` SHA-256 | `114C2F72473D6667E975A8BE0F7FC0EFFBADC2DB0BC12D03221E7C6D02DC1F5E` |
| Polars product feature | OFF |

`cargo metadata --locked --offline --no-default-features`가 성공했고 default feature tree에서 Polars가
나오지 않았다. 전환 전후 lockfile hash가 같다.

## 4. Rust 검증

| Toolchain | 검증 | 결과 |
| --- | --- | --- |
| 1.88 | debug 직렬 전체 test | 252 PASS, 0 FAIL, 13 ignored |
| 1.88 | 현재 호환 수정 source의 release 전체 test | 252 PASS, 0 FAIL, 13 ignored |
| 1.97.1 | Rustfmt check | PASS |
| 1.97.1 | Clippy `-D warnings`, Polars OFF | PASS |
| 1.97.1 | debug 직렬 전체 test | 252 PASS, 0 FAIL, 13 ignored |

최초 1.88 병렬 test에서 query temp directory `os error 5`가 한 번 발생했다. 해당 test 단독 실행과
직렬 전체 실행은 PASS했으며, compiler 전환 전의 Windows temp/병렬 환경성 실패로 분류했다.

Rust 1.97은 MSVC linker의 한국어 정상 stdout인 “라이브러리 생성 중”도 `linker_messages` warning으로
표시한다. debug test link에서는 기존 CRT 조합의 `LNK4098`도 새 compiler가 표시했다. Clippy
`-D warnings`, unit test와 release/NSIS 결과에는 실패가 없으며 warning을 숨기는 allow 설정은 추가하지
않았다. release runtime 회귀와 별도로 build diagnostic 개선 후보로 남긴다.

## 5. Release와 패키징

동일 source와 Polars OFF 조건의 산출물을 비교했다.

| 산출물 | Rust 1.88 | Rust 1.97.1 | 차이 | 판정 |
| --- | ---: | ---: | ---: | --- |
| `data-viewer.exe` | 79,132,160 B | 78,359,552 B | -772,608 B (-0.9764%) | PASS |
| NSIS setup | 13,791,918 B | 13,703,348 B | -88,570 B (-0.6422%) | PASS |

- Rust 1.97.1 Cargo release build: PASS
- Tauri production frontend build와 NSIS 생성: PASS
- `dumpbin /dependents`의 1.88/1.97 DLL 집합: 동일
- 외부 DuckDB, HDF5 또는 Blosc DLL 추가: 없음
- clean-machine 실제 설치·실행: 이번 환경에서 NOT_RUN이므로 `P15-TC-014`의 install smoke는 BLOCKED

1.97 첫 release native build는 반복 timeout 뒤 최종 uninterrupted run에서 23분 34초가 걸렸다.
1.88과 1.97의 완전히 같은 clean-cache 교차 측정이 아니므로 이를 정량 성능 회귀로 판정하지 않지만,
bundled DuckDB/HDF5 때문에 compiler fingerprint가 바뀌면 build 비용이 매우 크다는 위험은 확정한다.

## 6. 실제 Tauri 검증

### 6.1 Rust 1.88 기준선

`.tmp/phase15-toolchain/rust-1.88/native-phase12.json`의 최초 실행은 전체 PASS했다.

- low/high 5,850,000행 Parquet 정렬과 first/986,803/last identity
- Ctrl/Ctrl+Alt 모든 방향과 PageUp/PageDown, focus와 마지막 행 geometry
- query-aware 5,850,000×1 raw copy와 실제 Windows clipboard
- 65열 OES H5 전체 copy와 마지막 행 geometry
- 20회 tab 왕복의 blank/blur/busy frame 0

### 6.2 Rust 1.97.1 후보

후보 native 재실행에서 다음은 PASS했다.

- 실제 Tauri URL, WebView2 CDP와 Rust IPC
- low/high 5,850,000행 Parquet 정렬과 first/986,803/last identity
- Ctrl/Ctrl+Alt 모든 방향, PageUp/PageDown과 focus/geometry
- H5 open, 데이터 표시와 copy 시작 전 interaction

후보는 5,850,000×1 Windows clipboard copy 완료를 120초 안에 받지 못했다. 직후 같은 현재 환경에서
1.88 기준 EXE를 다시 실행해도 정확히 같은 copy 단계가 120초 timeout됐고, 이후 양쪽의 작은 copy와
직접 clipboard 교체도 실패했다. 따라서 compiler별 결과 차이가 아니라 Windows clipboard/session
공통 장애로 판정한다. OS clipboard나 Explorer를 강제로 재시작하면 사용자의 다른 앱 상태를 변경할 수
있어 수행하지 않았다.

이 장애는 재부팅 뒤 해소됐으며 10절의 전체 native smoke 재실행으로 `P15-TC-012`를 PASS로
변경했다.

## 7. 성능 검증

기존 1.88 high CSV 준비 기록은 Ready 46.734초와 67.001초였다. 장시간 native build와 clipboard
장애가 발생한 뒤 실행한 1.97 단발은 Ready 91.730초였고 다음 즉시 재실행은 4분 안에 끝나지 않았다.
CSV read, value conversion, Arrow append와 Parquet write가 모두 함께 느려져 특정 compiler code path
회귀보다 시스템 전반 부하 형태를 보였다.

동일 시점 1.88 재측정은 compiler별 release test artifact를 다시 전환하는 데 큰 native rebuild가
필요하고, 현재 머신 상태가 이미 안정적인 benchmark 조건을 잃었으므로 중단했다. 이 결과는 1.97
성능 PASS나 FAIL 근거로 사용하지 않는다. 재부팅 또는 동등한 clean session에서 다음 순서의 교차 측정이
필요하다.

```text
1.88 → 1.97 → 1.97 → 1.88
```

같은 fixture hash와 fresh process로 high 준비 5회, page/query/navigation/copy와 peak RSS를 비교해
후보 median/p95가 기준선 대비 10% 이내인지 확인한다. 따라서 현재 `P15-TC-015`는 BLOCKED다.

## 8. Gate 판정

| ID | 상태 | 근거 |
| --- | --- | --- |
| `P15-TC-001` | BLOCKED | 실행 전 snapshot의 영구 raw artifact가 없어 독립 재확인 불가 |
| `P15-TC-002` | PASS | repository 1.97.1, 전역 default 1.88.0 |
| `P15-TC-003` | PASS | edition 2021 유지, exact toolchain pin |
| `P15-TC-004` | PASS | Polars feature OFF와 default tree 미포함 |
| `P15-TC-005` | PASS | lockfile hash 불변, locked metadata 성공 |
| `P15-TC-006` | FAIL | fmt·Clippy는 PASS했지만 `linker_messages`와 debug `LNK4098`로 새 warning 0 불충족 |
| `P15-TC-007` | PASS | 양쪽 252 PASS, 13 ignored |
| `P15-TC-008` | PASS | CSV profile/raw/typed/state/cache unit matrix 동일 |
| `P15-TC-009` | PASS | Parquet unit와 native low/high identity 동일 |
| `P15-TC-010` | PASS | H5/Blosc unit PASS, candidate native open·표시 확인 |
| `P15-TC-011` | PASS | DuckDB query/sort/page/navigation 결과 동일, DLL 증가 0 |
| `P15-TC-012` | PASS | 재부팅 후 candidate full native smoke와 실제 5.85M×1 Windows clipboard, H5, navigation, geometry, tab restore 통과 |
| `P15-TC-013` | BLOCKED | release build·실행·크기와 import 비교는 성공했지만 독립 raw audit artifact 부족 |
| `P15-TC-014` | BLOCKED | NSIS build PASS, clean-machine install smoke NOT_RUN |
| `P15-TC-015` | BLOCKED | 현재 system benchmark 상태 불안정, clean 교차 재측정 필요 |
| `P15-TC-016` | PASS | 명시적 stable 1.88 release 전체 test 재현 PASS |

## 9. 다음 결정

Rust 1.97.1에서 기존 기능의 compile/data/package 결함은 발견되지 않았지만 toolchain pin은 아직
검토용 working-tree 변경이며 전환 완료로 확정하지 않는다. clipboard와 1.97 full native smoke는
재검증을 마쳤지만 안정된 시스템의 필수 성능·RSS 표본, temp cleanup 실패, linker warning 처리와
독립 binary audit를 마친 뒤 다시 판정한다. 이 FAIL/BLOCKED 항목을 해소하기 전에는 Stage 2 Polars
제품 통합으로 넘어가지 않는다.

## 10. 재부팅 후 재검증 (2026-07-24)

재부팅 뒤 PowerShell clipboard 왕복이 정상임을 확인하고 같은 Rust 1.97.1 후보 EXE를 재빌드 없이
검증했다.

- native 전체 smoke: 37.2초, `overall=PASS`
- 실제 Windows clipboard: 5,850,000행×1열, 51,538,888자, 첫 행과 마지막 행 일치
- H5 copy: 480행×65열 일치
- low/high Parquet query, Ctrl/Ctrl+Alt 네 방향, PageUp/PageDown, 마지막 행 geometry, 20회 tab 복귀 PASS
- raw evidence: `.tmp/phase15-toolchain/rust-1.97.1/native-phase12-after-reboot.json`
- candidate EXE SHA-256: `0697FAB0E68318E9169B0306FAD1E41528807C5F8679FA4DEB49C123B88FFA0F`

high-cardinality 5.85M CSV stage profile은 동일 release test binary의 fresh process로 두 번 실행했다.

| 실행 | Ready | provider | source read | cache output | peak decoded batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 38,314.633 ms | 36,871.058 ms | 979,427,914 B | 524,544,969 B | 25,709,464 B |
| 2 | 38,551.691 ms | 37,229.885 ms | 979,427,914 B | 524,544,969 B | 25,709,464 B |

두 후보 평균은 38,433.162ms로 기존 1.88 기록 46,734.546ms와 67,000.831ms보다 느려지지 않았다.
따라서 재부팅 전 91.730초와 timeout은 불안정한 당시 시스템 상태의 결과로 분류한다. 다만 gate가
요구하는 5회 median/p95와 peak RSS가 아직 없으므로 `P15-TC-015`는 Quality 판정에 따라 BLOCKED를
유지한다.

추가로 `phase13_release_large_csv_prepared_product_paths`를 실행했으나 준비·페이지·복사·query 뒤
임시 저장소 정리 assertion에서 `process_bytes=289,164,521`, baseline `9`가 되어 실패했다. 이 실행은
결과 JSON을 쓰기 전에 종료되어 peak RSS 증거로 사용할 수 없다. 같은 조건의 1.88 비교 전에는
toolchain 회귀로 단정하지 않으며, 현재 cache lease와 test cleanup 계약을 별도 HIGH 항목으로 추적한다.
