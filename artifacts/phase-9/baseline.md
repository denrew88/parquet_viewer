# Phase 9 구현 전 기준선

- 측정일: 2026-07-15
- 측정 환경: Windows, repository workspace, Asia/Seoul
- 목적: 9A source registry refactor 전 correctness와 source/fixture identity 고정
- 상태: 자동 correctness 기준선 PASS, release performance 기준선은 기존 Phase 8 결과를 참조하며
  보완된 PERF-001 harness로 다시 측정해야 함

이 workspace에서는 신뢰할 수 있는 Git commit identity를 사용할 수 없다. 따라서 아래 파일
SHA-256과 fixture manifest SHA-256을 이 기준선의 identity로 사용한다. 테스트는 10:09~10:10
KST에 실행했고 hash는 10:15 KST에 수집했다.

## 1. 자동 gate 결과

| 명령 | 결과 | 관측값 |
| --- | --- | --- |
| `npm.cmd test -- --reporter=verbose` | PASS | 5 files, 124 tests PASS, Vitest duration 10.07s |
| `cargo test` (`src-tauri`) | PASS | 78 tests PASS, Rust unit duration 2.86s; bin/doc test 0 |
| `npm.cmd run format:check` | PASS | Prettier 대상 전체 일치, 3.5s |
| `npm.cmd run lint` | PASS | ESLint warning/error 0, 7.2s |
| `npm.cmd run typecheck` | PASS | app/node TypeScript project 모두 PASS, 6.8s |
| `cargo fmt --check` (`src-tauri`) | PASS | diff 0, 1.6s |
| `cargo clippy --all-targets --all-features -- -D warnings` (`src-tauri`) | PASS | warning 0, 10.2s |

이번 사전 감사에서는 production build, Tauri/NSIS build와 native UI를 다시 실행하지 않았다.
이는 9A 자동 source contract 기준선이며 Phase 9 최종 build/native gate를 대체하지 않는다.

## 2. Source identity

| 파일 | Bytes | SHA-256 |
| --- | ---: | --- |
| `src-tauri/src/data/mod.rs` | 2,326 | `83f71ad8bd7d1d085509123fdadbfb28970507d0a28777656ae5e62401b74917` |
| `src-tauri/src/data/csv_source.rs` | 45,400 | `1f72e3c7095a3500ba8da15bfa48ddbf5f65cabe130750e085d6ecf4efc82432` |
| `src-tauri/src/data/parquet_source.rs` | 24,041 | `f46e3c0d923f58905c17b79112a485d4b59030b1ea839233613d35f9684e767f` |
| `src-tauri/src/domain/models.rs` | 3,939 | `9239b44d9e8cebb47b6f3c46b1c7cb60b1db9a3ee955b149c3b84ab709c38585` |
| `src-tauri/src/commands/mod.rs` | 40,489 | `b7ad5c1a675958033eb002251f47fb3c07c1991f71fefc62b2a7b98d329eb2cb` |
| `src-tauri/src/platform/dialog.rs` | 2,675 | `e701b1b4da1cfc534c86fceecc8796df0b109e19181524662afdf5d796f7e340` |
| `src-tauri/src/platform/session.rs` | 37,125 | `e36dc33e57ca08b594721313ca40392de551fa33803568f0f1f019412938da0b` |
| `src/backend.ts` | 41,092 | `1d83afaf659d0d53341288e49c754a301cf383cc1d2de91113a3bff9adcb1deb` |
| `src/App.tsx` | 59,332 | `4b2d1f3b46a0b316919cbb8280d4b50ac3cd8604fe19a0754ada0685ed8d4c54` |
| `src/dragDrop.ts` | 1,213 | `272ebc6bc8da363157730389c9abc413bd4e19e18b0da0a215df52963617c31b` |
| `scripts/phase7-runner/src/main.rs` | 11,872 | `7a6b0bd34637dc126dce85ec51ac7e805a2999c842d46795d536695791c559a6` |

9A 전후 성능을 비교할 때 production source뿐 아니라 runner hash도 함께 기록한다. 기존 runner는
warm-up과 여러 random offset을 지원하지 않으므로, 현재 hash의 runner 결과만으로 PERF-001을
PASS 처리하지 않는다.

## 3. Fixture identity

| Manifest | SHA-256 | 용도 |
| --- | --- | --- |
| `artifacts/phase-7/benchmark-manifest.json` | `28baea7bff42c941e06bbd79a693dc48f8796e22c5b13026b2017efdb79f1b81` | Phase 7 CSV/Parquet baseline fixture |
| `artifacts/phase-8/release-fixture-manifest.json` | `ad1674667f055a51b1075daf6972c488edc5a70e89ddb3fc30f5a891de321a02` | 10M low/high Parquet release fixture |

Phase 8 release fixture 실파일도 manifest와 다시 대조했다.

| Fixture | Rows x columns | Bytes | SHA-256 | 결과 |
| --- | ---: | ---: | --- | --- |
| `f-p8-12-low.parquet` | 10,000,000 x 10 | 11,757,872 | `eb38e4baef3406f43bfb192b6f748699addd547b7f37dbf330cbc9651006bc06` | manifest 일치 |
| `f-p8-13-high.parquet` | 10,000,000 x 10 | 579,719,187 | `d5c46ec70876e5f050e44d7e1bdc77cf6f507e37f50e8ca0e0a545f6fd3d1b08` | manifest 일치 |

## 4. PERF-001 후속 기준

9A 전후 비교에는 다음 fixture를 같은 composite manifest와 같은 release runner로 사용한다.

- Phase 7 `large-csv.csv`
- Phase 8 `f-p8-12-low.parquet`
- Phase 8 `f-p8-13-high.parquet`

fixture마다 3회 warm-up 뒤 10회를 측정하고, manifest seed에서 만든 동일한 10개 logical offset을
pre/post에 사용한다. source hash, runner hash, composite manifest hash, 원시 sample과 환경을
결과 JSON에 함께 기록해야 한다. 이 조건을 지원하는 harness가 준비되기 전에는 기존
`release-benchmark-results.json`을 참고값으로만 사용한다.
