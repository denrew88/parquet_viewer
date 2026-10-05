# Phase 18 통합 기록

## 구현 결과

- `QueryTempManager`가 query별 고정 분할 대신 현재 query temp, persistent CSV cache, 기존 reservation과
  `free space - 5 GiB reserve`의 최솟값으로 bounded allowance를 계산한다.
- query와 CSV preparation은 allocation 시 allowance를 원자적으로 예약하고 lease drop에서 해제한다.
  CSV prepared artifact는 생성 완료 뒤 실제 byte로 reservation을 축소한다.
- query 시작과 100ms budget monitor는 budget 초과 전후에 persistent CSV cache를 갱신하고, 제품이
  소유한 stable key와 manifest/artifact 크기가 일치하는 inactive entry만 oldest-first로 회수한다.
- active same-process/shared-process lease는 entry lock으로 보호한다. 검증되지 않은 cache-like directory,
  다른 process의 active query directory와 원본 데이터는 삭제 대상에 포함하지 않는다.
- 동일 access timestamp는 cache key로 tie-break하며, 한 inactive entry 삭제가 실패해도 lock을 해제하고
  다음 검증된 후보를 시도한다. 부분 삭제로 무효가 된 entry는 다음 reclaim 목록에서 제외한다.
- DuckDB의 max-temp, disk-full/no-space와 temp directory open/write 오류는 raw SQL·절대 경로를 숨긴
  `QueryTempLimitExceeded`로 정규화한다. 메시지는 query/cache usage, limit, free space, 5 GiB reserve와
  Settings의 `Clear inactive CSV cache` 조치를 제공한다.

## 변경 파일

- `src-tauri/src/storage/temp.rs`
- `src-tauri/src/storage/csv_cache.rs`
- `src-tauri/src/query/engine.rs`
- `docs/PROJECT_SPEC.md`
- `docs/DEVELOPMENT_PLAN.md`

이번 작업 전에 존재하던 categorical Parquet 지원 변경은 별도 사용자 요청의 작업으로 보존했고,
Phase 18 전체 Rust 회귀와 release build에 함께 포함했다.

## 검증 결과

- Phase 18 focused test: PASS
- CSV cache test: 16 PASS
- temp storage test: PASS
- cancel/replacement/session lifecycle 회귀: PASS
- `cargo test --all-features`: 299 PASS, 16 ignored, 0 failed
- `cargo fmt --all -- --check`: PASS
- `cargo clippy --lib --bins --all-features -- -D warnings`: PASS
- `git diff --check`: PASS
- `npm.cmd run release`: frontend typecheck·Vite release·Rust release·NSIS PASS
- NSIS: `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe`

## 알려진 비차단 경고와 차단 항목

- `cargo clippy --all-targets --all-features -- -D warnings`는 기존
  `examples/phase15_polars_poc.rs:191`의 `field_reassign_with_default` 1건 때문에 FAIL한다. 제품 lib/bin과
  Phase 18 변경에는 새 clippy 경고가 없다.
- debug test link의 기존 Windows `LNK4098` 경고와 Vite 500 kB chunk 경고가 유지된다.
- 저장소에 생성된 Phase 12/15 5.85M fixture가 없어 실제 large forced-spill, release 100-cycle
  replace/cancel soak와 별도 process high-water 측정은 실행하지 못했다.
- frontend 파일과 오류 surface 구조는 변경하지 않아 UI interaction·geometry·screenshot gate는 적용
  대상이 아니다. release build의 frontend typecheck와 bundle은 통과했다.
