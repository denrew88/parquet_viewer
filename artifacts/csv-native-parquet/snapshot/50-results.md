# csv + polars-parquet 전용 변환기 실험 결과

2026-11-03. **구현과 비교를 완료했다. 이 고정 입력에서는 Polars보다 변환 시간이 약 16%,
누적 CPU 시간이 약 20% 적었다.** 제품 엔진은 교체하지 않았다.

## 구현

기존 Rust `csv` 1.4.0과 `polars-arrow`/`polars-parquet` 0.54.4로 standalone converter를 만들었다.
full Polars, polars-core/lazy/stream, DuckDB를 링크하지 않는다. 필요 하위 crate를 포함한
실험 lockfile은 128 packages이며, source/lock/binary hash를 [provenance](20-provenance.json)에 기록했다.

```text
순차 csv ByteRecord 파서 + default-dialect quote 구조 검사
 → 컬럼별 Utf8View 배치 (raw 보존)
 → Rayon으로 컬럼별 typed 값·상태 생성
 → row ID와 packed state word 구성
 → Rayon으로 컬럼별 Parquet 인코딩·압축
 → 순서대로 압축 결과 기록 → footer/flush/sync → final 게시
```

- 레코드마다 작은 소유 String을 만들지 않고 컬럼 view builder에 넣는다.
- Int64/UInt64/Float64/Boolean은 native 배열에 직접 기록한다. Decimal은 기존 worker와 같이
  원문 문자열로 보존한다. native 정밀도로 변환되지 않는 Decimal을 Float64로 바꾸지 않는다.
- 동일 변환 판단으로 typed value와 valid/null/empty/invalid state를 만든다.
- row group target 65,536행, Zstd 기본 level 3, V1, 동일 기본 statistics/encoding 선택이다.
- parser/compute/writer를 분리하며 각 채널의 대기 용량은 1이다. compute가 입력 배치 하나를
  처리하고 compressed batch 하나를 전송한 뒤 다음 것을 처리한다. 앞의 writer가 막히면
  뒤 단계도 막히므로 무제한 완료 결과가 쌓이지 않는다. row group 순서도 유지한다.
- 최대 stage occupancy는 producer/input queue/compute/output queue/writer의 5배치다.
  행 수 상한과 field byte target, record/column 제한을 둔다. 프로세스 RSS hard cap은 아니다.
- record 8MiB 제한은 csv가 읽은 뒤 확인한다. 악성 입력에 대한 production급 allocation 상한을
  구현한 것은 아니다. 외부에 노출되는 제품 reader로 연결하지 않았다.
- 중간 파일은 create_new, final은 hardlink의 no-overwrite 게시를 사용한다. 원본은 읽기 전용이다.

[Rust 구현](src/main.rs), [범위와 완료 조건](00-scope.md).

## 비교 조건

- 입력: 기존 high-cardinality fixture 979,427,914B, 5,850,000행 × 15열.
- 입력 SHA256: `082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd`.
- 고정 MAIN profile, 기본 토큰/no trim, 현재 worker의 물리 29열(raw/typed/state/row ID).
- 기준: 앞서 ThinLTO+codegen-units=1로 빌드한 unchanged product Polars sink probe.
  제품의 현재 csv_polars.rs와 기준 실험 source가 byte 단위로 같은지 확인했다.
- 후보: standalone converter, 같은 Rust Release 최적화 설정. 각 엔진 fresh process 5회,
  반복마다 실행 순서를 반전했다. 모든 원시 표본을 보존했고 outlier 제거는 하지 않았다.
- Polars는 POLARS_MAX_THREADS=8, 후보는 Rayon worker 8개와 별도 parser/writer다.
  총 OS thread 수를 동일하게 맞춘 실험은 아니다. 따라서 CPU 합계도 함께 비교한다.
- 타이밍은 초기화·CSV 읽기/변환·Parquet 저장과 sync를 포함한다. GUI, 제품 Pass A,
  checkpoint/index, fingerprint/cache publish/session은 포함하지 않는다.
- OS file cache는 비우지 않았다. warmed-cache converter 비교이며 cold I/O 보장이 아니다.
- 큰 파일 측정 중 추가 컴파일/Clippy는 실행하지 않았다. Clippy는 변환 10회가 끝난 뒤
  데이터 oracle 검증 중에 실행했다.

## 5회 중앙값

| 항목 | 현재 Polars | 직접 변환기 | 차이 |
| --- | ---: | ---: | ---: |
| converter total | 6.469초 | 5.431초 | **-16.05%** |
| converter min–max | 5.964–6.606초 | 4.934–5.700초 | 전 표본 보존 |
| 외부 process wall | 6.526초 | 5.487초 | -15.92% |
| 누적 process CPU | 24.016초 | 19.203초 | **-20.04%** |
| peak private commit | 202.33MiB | 99.36MiB | **-50.89%** |
| peak Working Set | 1118.68MiB | 77.35MiB | 아래 해석 주의 |
| Parquet 파일 | 449,566,163B | 450,268,295B | +0.156% |

메모리 표는 각 실행의 OS peak를 모은 중앙값이다. Polars에는 mmap된 원본 파일 페이지가
Working Set에 포함될 수 있다. buffered I/O의 시스템 파일 cache 전체는 후보 process의
Working Set에 포함되지 않는다. 따라서 Working Set 차이를 전체 시스템 RAM 절감률로
해석하지 않는다. private commit 역시 resident private RAM과 같지는 않다.

이전 4.55초 기록과 이번 5.43초를 직접 비교해 개선/퇴보라고 판단하지 않는다. 이번 같은
실행 묶음에서 Polars도 6.47초로 재측정됐다. 이번 판단 근거는 동시기 A/B다.

[전체 10회 표본·정합성](30-results.json), [요약 수치](40-summary.json), [측정 runner](run_compare.py).

## 출력과 정합성

- 양쪽 모두 5,850,000행 × 29열, 90 row groups, 17,296–65,536행/group, ZSTD를 footer에서
  확인했다. compression level은 footer가 아니라 writer 설정/기존 기본 구현에 근거한다.
- 파일 bytes는 엔진 간 다르지만 decoded 값과 순서가 같다. 각 엔진의 반복 출력은 같은
  byte SHA256을 가졌다. unique byte hash별 대표 출력을 기존 bounded Rust oracle로 전체
  169,650,000셀 검사하고, 나머지는 파일 SHA 동일성으로 확인했다.
- logical row-major SHA는 과거 독립 검증된 입력과 동일하다:
  `b9dc8247ae85b8a871a2fdd13d47d54f5423d6fe494d685235fa84985ac64808`.
- EDGE 65,537행 × 33 source 열 / 43 physical 열 전체 parity PASS: 인용 comma/quote/CRLF/
  newline, UTF-8, raw/NULL/empty/invalid, Int64/UInt64 경계, Decimal 원문, Skip,
  packed state lane 31/32, float NaN/infinity/negative zero 포함.
- oracle는 -0의 bit를 보존해 비교하고 NaN payload/sign은 기존 정책대로 canonicalize한다.
- MAIN source hash는 변환 전후 동일했다.

[Footer 감사](22-footers.json), [MAIN 전체 oracle](verify-main-1.json), [EDGE 전체 oracle](verify-edge.json).

## 추가 진단과 검증

- 단일 진단: Rayon worker 1개 8.893초/CPU 11.609초, worker 4개 4.934초/CPU 17.688초.
  두 출력도 8-worker 결과와 byte-identical이다. 각각 1회여서 최적 worker 수를 확정하지 않는다.
  parser/writer는 별도 thread이므로 worker 1개 진단도 완전한 single-thread 프로세스가 아니다.
- Rust 단위 테스트 5 PASS, Release build PASS, fmt --check PASS,
  all-targets Release Clippy -D warnings PASS.
- malformed width, unterminated quote, invalid UTF-8: 오류 및 final/partial 미잔존 PASS.
- 기존 final overwrite 차단, 기존 partial 보존, unsupported trim profile 거부, header-only
  0행 결과, record byte 제한, 원본 불변 PASS.
- 시작 전 취소 및 active MAIN 처리 중 협력적 취소 PASS. active 취소 요청 이후 약 17ms에
  종료했고 final/partial이 남지 않았다. 한 표본이며 모든 OS/I/O 상태의 보장은 아니다.
- Windows sandbox의 hardlink 게시가 os error 5로 실패해 동일 검사를 허용된 실행 환경에서
  수행했다. Windows 보안 정책과 제품 권한은 변경하지 않았다.
- 초기 실험의 uint64 serde 이름 매핑 오류는 수정 후 EDGE와 MAIN을 모두 재검증했다.

[기본 오류 검사](10-smoke.json), [추가 진단·취소](12-extra.json), test.log/clippy.log/fmt.log.

## 판정과 남은 범위

**좁은 전용 변환기로 현재 고정 profile의 의미와 속도를 유지할 가능성은 실제로 확인했다.**
다음 제품 통합을 검토할 근거가 된다. 하지만 제품 교체 완료 판정은 아니다.

- 날짜/시간/Duration, 사용자 지정 토큰/trim/구분자, 전체 Auto inference/Pass A 계약,
  모든 CSV dialect, cache identity/lease/lifecycle, 재프로파일·진행률과 IPC는 이 converter가
  전부 구현한 것이 아니다. 허용 profile 밖은 실패하도록 제한했다.
- MAIN의 대용량 성능이 Float64-heavy/긴 문자열/다른 cardinality/열 수에서도 유지되는지
  추가 matrix가 필요하다. EDGE 정확성 통과가 그 성능까지 입증하지 않는다.
- 제품 전체 Ready 시간, query/copy/Find, UI/설치·다른 OS 검증은 이번 실험 대상이 아니다.
- standalone EXE는 6,571,520B = 6.27MiB다. Tauri/쿼리/HDF5 등이 없는 도구이므로 제품
  103.71MiB와 빼서 용량 절감량으로 계산하면 안 된다. 통합 제품 EXE의 순감량은 미측정이다.
- 제품 Cargo manifest/lockfile 및 frontend assets는 이전 최종 검증 상태와 hash가 같다.
  제품 엔진, UI, 권한과 Phase 상태를 바꾸지 않았다. 전체 앱 suite/release/installer는
  변경이 없는 제품에 대해 재실행하지 않았다.

재현: `build.ps1 -Stage build`, `run_compare.py --stage all`, `--stage extra`.
빌드는 workspace 오프라인 Cargo cache를 사용한다. 실험 Cargo.lock을 보존한다.
생성 Release cache는 후속 재현을 위해 유지하며, 원본 fixture는 기존 실험의 것을 읽기 전용으로
재사용했다. 반복 출력의 중복 파일은 해시 기록을 보존한 뒤 정리할 수 있다.
실제로 동일 해시의 중복 출력 10개(4,499,874,422B)를 정리했다. MAIN 대표 출력은 엔진별
하나씩, EDGE 출력과 모든 검증·측정 기록은 보존했다. [정리 내역](45-cleanup.json).

후속 55.85MiB 앱 크기 기록은 UI 자산이 포함되지 않은 설정 오류가 발견돼 동등 비교로는
무효화했다. 내부 worker EDGE parity 자체는 유효하지만 전체 앱 검증을 뜻하지 않는다.
[원시 크기 기록 및 정정](65-size-results.md), 후속 대규모 검증은 validation/ 아래에 기록한다.

최신 수정본의 확대 검증을 완료했다. 979MB CSV 변환 중앙값은 Polars 6.009초 → 새 구현
5.958초로 동급이며 CPU 시간은 25.047초 → 20.578초다. UI 포함 전체 앱은 56.0356MiB다.
과거 속도·크기 수치보다 [최신 결과와 한계](validation/90-results.md)를 우선한다.
