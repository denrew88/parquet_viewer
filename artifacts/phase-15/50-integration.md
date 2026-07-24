# Phase 15 통합 기록

## 2026-07-24 same-EXE Polars worker 1차 연결

- feature ON/OFF all-target check: PASS
- feature ON clippy `-D warnings`: PASS
- classifier unit: 5/5 PASS
- compact-v3/worker/provider parity: 6/6 PASS
- 5,850,000행 worker hard cancel: partial 생성 뒤 Job kill, child wait, cleanup까지 0.07초,
  `TaskCancelled`, request/result/partial 잔존 0
- 알려진 build 경고: 기존 MSVC linker stdout/LNK4098 계열 경고

## 첫 제품 release 표본

실행 명령:

```text
cargo test --manifest-path src-tauri\Cargo.toml --locked --release \
  --features polars-csv-provider phase14_profile_5850000_high_csv_stages \
  -- --ignored --nocapture --test-threads=1
```

- fixture: `csv-5850000-high.csv`, 979,427,914 bytes, 5,850,000행 x 15열
- release build: 16분 27초. 선행 20분 명령은 외부 timeout 뒤 compile cache만 남았고,
  재개 build가 위 시간에 완료됐다.
- test runtime: 47.62초
- Ready: 45,531.1ms
- provider: 43,903.4ms
- publish/outer: 1,627.7ms
- 결과: **FAIL** (`Ready median 15초, p95 20초` gate 이전 단일 표본부터 초과)

단계 artifact는 기존 Rust 준비 경로의 `valueConversion` 18,578.5ms와
`parquetBatchWrite` 13,109.9ms를 기록했다. high fixture의 `amount`가 Decimal로 추론되지만
초기 Polars allow-list가 Decimal을 제외해 `RustRequired(unsupportedProfile)`로 분류된 것이
원인 후보다. Decimal 원문 정밀도를 유지하는 safe lane과 Pass A의 무할당 state-only 판정을
구현한 뒤 같은 release 표본을 다시 측정한다.

이 FAIL 상태에서는 `polars-csv-provider`를 default feature로 전환하지 않는다.

## Decimal safe lane 및 state-only Pass A 표본

Decimal 원문 보존과 재사용 row-state buffer를 적용한 release 제품 경로는 실제 high fixture에서
`provider=polars`, `classifierReason=null`, source read `1,958,855,828 bytes`(두 pass)로
동작했다.

첫 단일 표본은 Ready 15,637.9ms였다. 같은 release 테스트 EXE를 별도 cold cache로 직접
5회 실행하고 50ms마다 parent와 helper process tree RSS를 합산한 결과는 다음과 같다.

| run | Ready | peak tree RSS |
| ---: | ---: | ---: |
| 1 | 13,413.1ms | 1.120GiB |
| 2 | 16,949.8ms | 1.149GiB |
| 3 | 17,434.9ms | 1.121GiB |
| 4 | 17,411.7ms | 1.132GiB |
| 5 | 17,101.9ms | 1.139GiB |

- median: 17,101.9ms — **FAIL** (15초 이하 목표 초과)
- 5표본 p95 정의상 max: 17,434.9ms — PASS (20초 이하)
- peak parent+helper RSS: 1,234,186,240 bytes, 1.149GiB — PASS (1.5GiB 이하)
- 5회 모두 provider Polars, classifier reason 없음

Pass A의 5,500,000행 milestone은 느린 네 표본에서 약 6.0~6.2초였다. inner loop가 각
셀마다 logical type 문자열을 다시 분해하는 것을 확인했으므로 resolved target과 기본 token을
scan 전에 precompute한 뒤 재측정한다. Raw evidence는 `product-benchmark.json`과
`product-benchmark-runs/`에 저장했다.

### Precomputed target/token 최적화 후

Pass A 전에 visible source index와 resolved target을 계산하고, inner loop의 schema lookup,
logical type split과 token Vec 순회를 제거한 최종 release 표본은 다음과 같다.

| run | Ready | peak tree RSS |
| ---: | ---: | ---: |
| 1 | 18,045.1ms | 1.135GiB |
| 2 | 16,360.5ms | 1.130GiB |
| 3 | 16,567.9ms | 1.119GiB |
| 4 | 16,519.4ms | 1.116GiB |
| 5 | 16,072.2ms | 1.115GiB |

- median: 16,519.4ms — **FAIL** (15초 이하 목표보다 1,519.4ms 초과)
- 5표본 p95 정의상 max: 18,045.1ms — PASS
- peak parent+helper RSS: 1,218,908,160 bytes, 1.135GiB — PASS
- 5회 모두 provider Polars, classifier reason 없음, source pass 정확히 2회

1차 median 17,101.9ms보다 582.5ms 개선됐지만 median gate는 아직 통과하지 못했다. 최적화
raw evidence는 `product-benchmark-optimized.json`에 저장했다. `states.bin`의 exact 2-bit
계약을 낮추지 않고 다음 병목을 제거하기 전에는 default feature로 승격하지 않는다.
### Worker thread limit 확정 후 최종 표본

POC와 제품의 차이를 비교해 제품 helper가 Polars thread pool 크기를 기본값에 맡기고 있음을
확인했다. 같은 release EXE에 `POLARS_MAX_THREADS=8`만 외부 지정한 비교 표본이 Ready
11,342.8ms, peak RSS 1.129GiB를 기록했다. 이에 부모 Tauri 환경은 바꾸지 않고 helper
`Command`에만 `min(available_parallelism, 8)`을 전달하도록 수정했다. request/result가 같은
thread limit을 기록·검증한다.

외부 thread 환경변수를 제거한 최종 제품 release 5회 결과는 다음과 같다.

| run | Ready | peak tree RSS |
| ---: | ---: | ---: |
| 1 | 12,074.9ms | 1.138GiB |
| 2 | 14,378.8ms | 1.150GiB |
| 3 | 14,770.9ms | 1.121GiB |
| 4 | 14,701.4ms | 1.124GiB |
| 5 | 14,931.0ms | 1.103GiB |

- median: 14,701.4ms — **PASS** (15초 이하)
- 5표본 p95 정의상 max: 14,931.0ms — **PASS** (20초 이하)
- peak parent+helper RSS: 약 1.150GiB — **PASS** (1.5GiB 이하)
- 5회 모두 provider Polars, classifier reason 없음, source pass 정확히 2회

Raw evidence는 `product-benchmark-final.json`과 `product-benchmark-runs/`에 저장했다.

## 2026-07-24 기본 제품 연결과 최종 회귀

- `polars-csv-provider`를 Cargo default feature로 전환했다.
- 기본 feature `cargo fmt --check`: PASS
- 기본 feature `cargo clippy --all-targets -- -D warnings`: PASS
- 기본 feature Rust lib: 267 PASS, 0 FAIL, 16 ignored
- 기본 dependency tree: Polars 0.54.4 포함 PASS; `--no-default-features` all-target check PASS,
  feature OFF tree에는 Polars 없음
- 실제 5.85M high CSV 기본-feature routing: `provider=polars`, fallback reason 없음 PASS
- 실제 5.85M high CSV helper hard-cancel: 0.10초 PASS
- frontend format/lint/typecheck: PASS
- Vitest: 20 files, 364 PASS
- Playwright: 최초 전체 실행에서 75개 중 74개 완료, desktop-wide OES 1건 실패. 같은 OES는
  compact/minimum에서 PASS했고 desktop-wide 단독 재실행도 23.2초에 PASS했다. 단, 결과 출력 뒤
  Playwright 프로세스가 종료되지 않아 명령 timeout으로 분류된 실행기 문제가 남았다.
- WebView2 native CDP: release는 CDP 연결 직후 exit 101, 기존 debug는 CDP endpoint 미개방으로
  `BLOCKED`. Polars debug 링크 재시도는 Windows paging file 부족(`os error 1455`) 뒤 debug symbol을
  끈 재시도도 10분 내 미완료되어 종료했다. 남은 Cargo/rustc 프로세스는 모두 정리했다.
- 기본 feature `npm run tauri -- build`: PASS, release와 NSIS 생성
- 내부 worker strict argv missing-request: 기대 종료 코드 64 PASS
- release small CSV 일반 실행: 4초 생존 PASS
- 최종 검사 시 Cargo/rustc/data-viewer 잔류 프로세스 0

최종 산출물:

| 산출물 | 크기 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/data-viewer.exe` | 143,856,640 B | `C653E476478627F723A650B0E2CCBD5AB93AFB321F572A399F718FACC314C8C7` |
| `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe` | 24,926,061 B | `A1D8A3BCA3052FC55F5A83937233B55A002C8FC9296D2F559FB70EE48C85B73E` |

알려진 비차단 경고는 기존 MSVC linker stdout과 Vite 500kB chunk 경고다. native CDP와 Playwright
runner 종료 문제는 외부/실행기 증거 공백이므로 Phase 상태 판정에서 숨기지 않는다.

### Helper hardening 후 최종 package

- request/result schema version 1, 64MiB bounded read/write, canonical pinned snapshot source를 적용했다.
- hardlink snapshot probe가 실패하는 volume/filesystem은 helper를 시작하기 전에 Rust provider로
  fallback한다.
- same-size/same-time path replacement의 pinned OS identity 거부, Polars targeted 13건, high cancel
  0.13초 cleanup, format/check/Clippy를 통과했다.
- 기본 feature release·NSIS 재빌드, strict worker missing-request exit 64, small CSV 앱 4초 생존을
  다시 확인했고 최종 잔류 Cargo/rustc/data-viewer process는 0이다.
