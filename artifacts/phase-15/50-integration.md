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

## 2026-07-26 persistent CSV cache 관리와 warm-hit UI 보완

Settings에서 그동안 합계로만 표시하던 query temporary data와 persistent CSV cache를 분리했다.
CSV cache의 크기, 항목 수와 실제 app-local-data 경로를 표시하고, 사용자가 확인한 뒤 비활성 cache만
삭제할 수 있다. frontend는 삭제 경로를 전달하지 않으며 backend가 고정된 `csv-cache-v1`의 16-hex
직접 자식만 대상으로 삼는다. 같은 process와 다른 process의 shared lease는 exclusive lock 실패로
식별해 건너뛰고 삭제·건너뜀·실패·남은 사용량을 별도로 반환한다. query temporary clear와 CSV cache
clear는 서로의 저장물을 삭제하지 않는다.

release에서 이미 준비된 CSV가 다시 계산 중처럼 보이던 원인은 cache hit 복원 시 `states.bin`과
navigation frontier만 복원하고 공유 `row_count_status`를 `Complete`로 게시하지 않은 것이었다.
복원 시 rows/bytes/message를 하나의 완료 상태로 갱신하고, frontend는 최초 `Ready` 응답에서 summary를
즉시 다시 읽어 preparation polling과 `Calculating CSV row count`·`total calculating` 표시를 시작하지
않는다. application version은 cache schema/layout 호환성과 무관하므로 manifest match와 cache key에서
제외했고 source identity, header/profile, schema와 physical layout 검증은 유지했다.

### 검증 결과

| 검증 | 결과 |
| --- | --- |
| Rust format/check/Clippy `-D warnings` | PASS |
| Rust 전체 | 280 PASS, 0 FAIL, 16 ignored |
| cache usage/clear/active·cross-process lease/version compatibility | 11 PASS |
| warm restore row-count `Complete` | 1 PASS |
| frontend typecheck/lint/Prettier | PASS |
| Vitest 전체 | 20 files, 368 PASS |
| storage interaction 3 viewport | 각 viewport PASS; 결과 출력 후 runner 미종료로 outer command timeout |
| UI geometry와 storage screenshot 3 viewport | 각 viewport PASS; 동일 runner 미종료 문제 |
| release EXE·NSIS와 cleanup | PASS; release intermediate 7.4GiB, test debug intermediate 13.3GiB 제거 |

UI 증거는 `artifacts/phase-15/ui/storage-{wide,compact,minimum}.png`에 저장했다. Playwright의 모든
assertion은 완료됐지만 기존 runner 종료 문제 때문에 명령 자체는 timeout 124였으므로 전체 E2E gate를
PASS로 승격하지 않는다. 실제 사용자의 AppData cache는 삭제 테스트에 사용하지 않았다.

최종 산출물:

| 산출물 | 크기 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/data-viewer.exe` | 143,831,040 B | `E1C10426DFA06A183E58499BAFE7F3274AF86AB6B40FCF11DDDC2E3A569279B0` |
| `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe` | 24,907,723 B | `547F4DD77E9265CB0114342A86A6AD6F81E428DE9E2EFACC91DE1D3661042833` |

실제 release high CSV 10회 warm reopen, 설치본 AppData 삭제, cache clear/open/publish의 외부 process
fault matrix는 아직 실행하지 않았으므로 `P15-WARM-004/005/009`, `P15-STORAGE-006/007/011`은
`NOT_RUN` 또는 기존 native 환경 문제에 따른 `BLOCKED`로 유지한다.

생성한 release EXE의 실행을 현재 managed workspace에서 시도하면 app-local-data
`C:\Users\denrew88\AppData\Local\com.denrew88.data-viewer\query-temp` 쓰기가 sandbox에서 거부되어
Tauri setup이 exit 101로 끝났다. 실제 설치 환경의 제품 오류로 판정할 근거는 아니며, 이 실행 환경에서는
AppData를 쓰는 native cache/Settings 검증을 PASS 처리할 수 없으므로 `P15-STORAGE-011`은 `BLOCKED`다.

## 2026-07-27 warm cache 업데이트 호환성 보완

- 새 version-independent key가 없더라도 제품 소유 16-hex entry(최대 16개)의 manifest를 검사해 같은
  source/profile/schema인 이전 version-key compact-v3 cache를 재사용한다.
- canonical key를 우선하고, 호환 legacy 후보가 여러 개면 최근 접근 순으로 검증한다. 손상 후보는 기존
  corruption 처리와 lease 보호를 그대로 적용하고 다음 후보로 진행한다.
- CSV cache 삭제 직후 UI는 이전 query-temp snapshot과 결과를 합성하지 않고 backend storage usage 전체를
  다시 조회한다.
- `legacy_versioned_key_is_discovered_without_repreparing`: PASS.
- cache module: 12 PASS, frontend `P15-WARM-003` 및 `P15-STORAGE-003/004`: PASS.
- Rust 전체 281 PASS·16 ignored, check 및 Clippy `-D warnings`: PASS.
- frontend 전체 368 PASS, typecheck 및 lint: PASS.
- 보완 코드가 포함된 release EXE·NSIS 재빌드: PASS. cleanup이 Cargo release intermediate 7.24GiB를
  제거했으며 최종 3개 파일만 남겼다.

| 최종 산출물 | 크기 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/data-viewer.exe` | 143,874,048 B | `E4CE7A375391FB20AE799D942FCB48AD04CA49AC284ABF47423ACA5672DE6336` |
| `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe` | 24,907,071 B | `3CC1F59F38BE6616752D034177D06602039C357642AEE03A24886F10826D85AA` |
| `src-tauri/target/release/THIRD_PARTY_NOTICES.md` | 10,980 B | `E810B8D9CA158B57168F25380EC7118D55FD5CFD771BBD767D5618A5166CB15E` |

## 2026-07-27 release 증분 산출물 유지 정책

- 기본 `npm run release`와 `npm run release:exe`는 Cargo release 중간 산출물을 유지해 다음 빌드가
  증분 빌드를 사용할 수 있게 했다.
- 사용자가 디스크 정리를 요청한 경우에만 `npm run clean:release`를 실행한다.
- release artifact 보존용 staging 위치를 workspace `.tmp`에서 시스템 임시 디렉터리로 옮겼다.
- 기본 release 뒤에는 `npm run clean:temp`가 workspace `.tmp`의 64MiB 이상 생성 항목을 정리한다.
- `clean_workspace_temp.ps1 -WhatIf`로 삭제 범위를 먼저 검증할 수 있으며, reparse point와 workspace
  밖 경로는 건드리지 않는다.
- 기존 `.tmp`에서 확인된 4개 대용량 생성 항목 7.786GiB를 정리했다.

## 2026-07-27 CSV 준비 진행률 및 표시 형식 선택 상자 보완

- cold CSV 준비 상태에 행 수뿐 아니라 읽은 원본 바이트와 전체 바이트, 실제 진행 막대를 표시한다.
- warm cache가 즉시 `Ready`를 반환하면 준비 UI를 한 프레임도 표시하지 않는 기존 계약을 유지한다.
- 준비 카드가 `query-toolbar` 뒤에 가려지던 stacking 순서를 수정하고, Playwright에서 카드가 실제 hit-test 최상단에 있는지 검증한다.
- Value display formats의 선택 상자는 기본 브라우저 화살표 대신 전용 chevron과 충분한 오른쪽 여백을 사용한다. Decimal처럼 한 행에 선택 상자가 두 개 있는 경우에도 선택값이 잘리지 않도록 기본 너비와 grid 비율을 조정한다.

검증 결과:

| 검증 | 결과 |
| --- | --- |
| Vitest 전체 | 20 files, 368 PASS |
| typecheck / lint / Prettier | PASS |
| production frontend build | PASS |
| cold progress + display formats Playwright, 3 viewport | 6 PASS; 모든 assertion 완료 후 기존 runner 미종료로 outer command timeout |
| screenshot 시각 검토 | wide / compact / minimum PASS |

UI 증거는 `artifacts/phase-15/ui/csv-progress-{wide,compact,minimum}.png`와
`artifacts/phase-15/ui/display-formats-{wide,compact,minimum}.png`에 저장했다.

`npm run release`도 PASS했다. Cargo release 중간 산출물 7.4GiB를 정리한 뒤 release 폴더에는
아래 세 파일만 남았다.

| 최종 산출물 | 크기 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/data-viewer.exe` | 143,874,048 B | `03A74E7AEC1A5FED10202358716993A170A4C50EC6CD22230FD693734602A888` |
| `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe` | 24,924,377 B | `7EF2966F5258242D69F66C0046F139B30A74CC169D56D625987A30D4580EA67C` |
| `src-tauri/target/release/THIRD_PARTY_NOTICES.md` | 10,980 B | `E810B8D9CA158B57168F25380EC7118D55FD5CFD771BBD767D5618A5166CB15E` |
