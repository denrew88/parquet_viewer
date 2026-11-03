# DuckDB 제거 비교 실험: 사전 품질 기준

작성일: 2026-11-01. 실행 모드: 테스트 설계. 신규 Phase 완료 검증이 아닌 제거 비교 실험이다.
제품 완전 대체 여부는 Root가 범위를 확정한다. 제품 코드와 Phase 상태는 변경하지 않는다.

## 실험 구분

1. **제품 baseline**: 현재 source/lockfile/default feature 그대로 release EXE를 빌드한다.
2. **DuckDB 제거 크기 실험**: 격리된 source 복사본에서 DuckDB 도달 경로를 제거한 빌드다.
   기능이 빠졌다면 산출물명·결과 표·실행 화면에 `size-only / 기능 미완성`을 표시한다.
   이는 제거된 코드 전체의 순증가량이지 DuckDB 라이브러리만의 정확한 크기는 아니다.
3. **동등 기능 대체 제품**: 실제 대체 엔진으로 page/copy/filter/sort/Find/distinct/cache와
   lifecycle/resource 계약을 구현하고 회귀 검증을 통과한 제품이다. 이때만 제품 전환을 평가한다.

의존성 manifest에서 항목만 지우거나, 미사용 DuckDB dependency를 넣었다 뺀 별도 hello-world의
크기 차이는 제품의 DuckDB 기여도 측정으로 인정하지 않는다. DuckDB 포함/제외 여부는
dependency graph와 최종 linker 산출물을 함께 확인한다.

## 추적 가능한 테스트

| ID | 완료 조건 | 계층·입력 | PASS 기준 | 담당 |
| --- | --- | --- | --- | --- |
| T-DR-001 | 비교 조건 고정 | build metadata | source hash/patch, lockfile hash, Rust/MSVC/linker, features, profile, target, frontend assets hash가 기록되고 DuckDB 외 변경이 명시됨 | Root |
| T-DR-002 | baseline 재현 | release EXE | 정상 제품 EXE 빌드, bytes/SHA256 기록. 이전 144MB 기록을 새 baseline으로 대체 사용하지 않음 | 구현 |
| T-DR-003 | 제거 빌드 실제 성립 | Cargo tree + link map/symbol 또는 archive audit | 최종 exe에 DuckDB C/C++ object가 남지 않음. DLL로 이동시 총 설치 파일 크기까지 합산 | 구현·품질 |
| T-DR-004 | 비교 artifact 오인 방지 | EXE·측정 JSON/문서 | size-only라면 누락 기능을 열거하고 shipping/replacement PASS를 금지 | 품질 |
| T-DR-005 | 제품별 순크기 비교 | 동일 baseline/제거 EXE | byte 차이, MiB 차이, 비율 및 기능 차이 동시 기록. PDB/debug/installer와 EXE를 혼동하지 않음 | 품질 |
| T-DR-006 | 최소 대체 정확성 | small CSV·native Parquet golden | typed filter + multi-sort 결과 row ID, null-last, source ID tie-breaker 일치 | 구현 unit + 품질 golden |
| T-DR-007 | 페이지·복사 보존 | compact CSV cache, 정렬 결과 | max 200 ID 선확정, projection 1~64, sparse/page/copy raw·typed·state parity | 구현 unit + 품질 integration |
| T-DR-008 | 타입 경계 | Int64/UInt64, Decimal, timestamp/timezone, duration, dictionary row groups | 문자열 우회 정렬·float 정밀도 손실 없이 기존 golden 일치 | 품질 |
| T-DR-009 | 대용량 실행 | 5.85M/10M low/high 및 긴 문자열 | 결과 전체 UI/RAM materialization 없음. RSS(parent+worker), temp high-water, cold/warm 시간 기록 | 품질 benchmark |
| T-DR-010 | 자원·취소 | forced spill, disk pressure, cancel/replace/close | 계약상 예산/안전 여유 보존, cancel terminal ≤1초, worker/partial/reservation/lease 복귀 | 품질 fault/soak |
| T-DR-011 | 완전 대체 인수 | Find/distinct/boundary, cache restore, Tauri | 현재 제품 기능·frontend/Rust/E2E/native/release gate 통과. 기존 BLOCKED 승계 | 품질 |

T-DR-001~005는 크기 실험의 완료 기준이다. T-DR-006~011을 수행하지 않았거나 FAIL/BLOCKED인
빌드는 기능을 유지한 DuckDB 제거 제품으로 보고하지 않는다. 크기 실험 자체를 위해 전체 UI
회귀가 필수는 아니지만 해당 산출물을 사용 가능한 제품으로 전달하면 필수다.

## 제품 EXE 내 기여도 해석

- 가장 강한 실용 근거는 같은 조건의 baseline과 실제 제거/대체 제품 EXE 차이다.
  단, 그 차이는 삭제 코드와 추가 대체 코드의 순효과다.
- MSVC linker map을 baseline 재링크 때 수집하면 DuckDB object별 executable/data section의
  기여를 조사할 수 있다. section alignment, shared/COMDAT folding, linker-generated data 때문에
  object 합계를 파일 크기의 정확한 분할표로 단정하지 않는다.
- static `.lib`나 `.rlib` 파일 크기는 최종 링크되지 않는 object도 포함하므로 제품 EXE의
  DuckDB 크기로 사용할 수 없다. 반대로 `dumpbin /imports`에 DuckDB가 없다고 정적 링크 부재를
  증명할 수는 없다.
- DuckDB 없는 size-only shell은 가능하면 frontend, Tauri plugins, 나머지 format/page/copy
  경로와 Polars 도달 코드를 유지한다. 그렇지 않다면 줄어든 다른 코드도 측정표에 공개한다.

## 실제 환경 확인과 현재 실행 상태

2026-11-01 읽기 전용 확인:

- `src-tauri/target`, `dist`, `node_modules` 없음. 현재 release EXE를 직접 분석할 수 없다.
- `rust-toolchain.toml`은 Rust 1.97.1을 지정한다. 설치 directory에는 `stable-x86_64-pc-windows-msvc`만
  보인다. pinned toolchain availability는 준비/확인이 필요하다.
- `cargo.exe`, `rustc.exe`, `node.exe`는 PATH에서 발견했다. 이 세션 PATH의 `npm`, `cl`, `link`
  command 조회에는 결과가 없었다. 이는 npm 또는 MSVC 미설치의 확정 근거는 아니며,
  runtime npm.cmd 위치와 VS developer environment를 먼저 확인해야 한다.
- Cargo registry source root는 있으나 dependency 전체가 준비되어 있다는 뜻은 아니다.
- 이번 설계에서 compile, package install, source mutation, fixture 실행 또는 승인 요청은 하지 않았다.

환경을 준비할 수 없으면 baseline/제거 크기 결과는 BLOCKED로 남긴다. 추정 수치나 과거
서로 다른 build의 차이를 새 측정으로 보고하지 않는다.

## handoff

구현 담당은 최소한 T-DR-001~005의 증거와 누락 기능 표를 제출한다. full replacement가
범위에 들어오면 Root가 공통 provider/artifact/query 계약과 소유권을 먼저 고정하고
T-DR-006~011의 fixture·golden·native gate를 구체화한다. 이 설계는 테스트 기준을 낮추거나
기능 stub을 승인하지 않는다.
