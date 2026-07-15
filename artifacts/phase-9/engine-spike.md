# Phase 9 query engine spike

- 실행일: 2026-07-15
- 환경: Windows x86_64, Rust 1.88.0, MSVC
- fixture manifest: `fixtures/phase-9/manifest.json`
- fixture manifest SHA-256: `0af7e09361cfabc0faa49f7c3096f8e18c89c6b864c1f5bdcd9f0bf0fd5c216d`
- 실행 코드: `scripts/phase9-engine-spike`
- DuckDB Rust package: <https://docs.rs/crate/duckdb/1.10504.0>
- DuckDB resource settings: <https://duckdb.org/docs/stable/configuration/overview>
- DataFusion disk manager: <https://docs.rs/datafusion/54.0.0/datafusion/execution/disk_manager/>

## Decision

제품 query adapter는 DuckDB embedded를 사용한다.

```toml
duckdb = { version = "~1.10504.0", features = ["bundled", "parquet"] }
```

사용자는 이 Phase 구현 전에 테스트, 패키지 설치와 GUI 검증을 별도 확인 없이 진행하도록 명시했다.
이 지시를 신규 runtime dependency 승인으로 기록한다. persistent database는 만들지 않으며 in-memory
connection과 Tauri가 resolve한 app-local-data의 bounded query temp만 사용한다.

## Candidate comparison

| Candidate | Correctness/resource | Packaging | Decision |
| --- | --- | --- | --- |
| DuckDB embedded | CSV/Parquet scan, typed expression, external sort, memory/temp cap, interrupt 제공 | `bundled` MSVC static build PASS, first build가 김 | 선택 |
| DataFusion 54 | Rust-native memory pool/disk manager가 있으나 현재 Arrow 58.3 계열 | 프로젝트 Arrow/Parquet 59와 concrete type 경계가 달라 downgrade 또는 복사 adapter 필요 | 제외 |
| 현재 reader 위 직접 구현 | 기존 binary 증가는 작음 | expression, CSV typed provider, external stable sort, spill/cancel을 모두 신규 구현해야 함 | 제외 |

선택 우선순위는 correctness/lifecycle, resource bound, performance, packaging, 유지보수 순이다.
DuckDB는 spike에서 앞의 네 항목을 실제로 통과했고, 다른 후보는 Phase 9 범위에서 더 큰 정합성 또는
구현 위험을 가진다.

## Command

```powershell
cargo run --release --manifest-path scripts/phase9-engine-spike/Cargo.toml
```

첫 bundled C++ release build는 약 23분이 걸렸다. incremental Rust compile과 실행은 6.6초였다.
생성된 spike EXE는 30,046,720 bytes이고 SHA-256은
`3f0e4d74cf8c772942b91f16fad5fc143a4d13d52eb5a0025afece23cf0f94ba`다.

## Correctness result

메모리 256 MiB, temp 1 GiB, worker thread 2, insertion order 보존, nulls last로 실행했다.

| Fixture | 전체 4 query 시간 | Result |
| --- | ---: | --- |
| `query-small.csv` | 27.24 ms | 4/4 expected row-id checksum 일치 |
| `query-small.parquet` | 7.08 ms | 4/4 expected row-id checksum 일치 |

검증 query:

1. category typed equality
2. case-insensitive contains search
3. Boolean + one-of filter와 3-column stable sort
4. ascending sort, nulls last, source row identity tie-breaker

CSV와 Parquet는 아래 checksum 네 개가 각각 동일했다.

- `2abefa67957a7d1f77b97f879b6cb05335e9a11ee1a1620b2534723a0b8458f1`
- `2a025928f4b9e49302e3c9808b1c72774be80da156d3ec607f189e25ebf84249`
- `c30bb856ad6286042071f484488ad798fed514427e709bf69d07630dbeabdfa5`
- `1b3ac23597ae9a8286cf89cf4401fc15dfef397d466e942a383b03cb58666678`

소형 fixture에서는 spill이 필요하지 않아 temp peak는 0 bytes였다. 종료 후
`artifacts/phase-9/engine-temp-spike`가 존재하지 않는 것을 확인했다. 10M low/high cardinality의
spill, RSS, cancel, cleanup 수치는 large benchmark 결과에 별도로 기록한다.

## Product constraints

- connection은 in-memory로만 연다.
- `temp_directory`, `memory_limit`, `max_temp_directory_size`, `threads`를 모든 connection에 설정한다.
- external extension install/autoload와 persistent secret 저장을 허용하지 않는다.
- source path는 canonical path만 받고 SQL literal escape를 적용한다.
- column identifier는 allowlisted schema와 quoted identifier builder만 사용한다.
- filter/search literal은 bind parameter로 전달한다.
- sort 끝에는 숨겨진 source row identity를 추가하고 모든 방향에서 nulls last를 명시한다.
- query/profile/session/tab drop에서 interrupt, handle drop, temp delete 순서를 지킨다.
