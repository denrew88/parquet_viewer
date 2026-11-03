# DuckDB 필요성과 실행 파일 크기 검토

검토일: 2026-11-01. 제품 코드·dependency·Phase 상태 변경 없음.

후속 업데이트 (2026-11-02): DuckDB 제거 비교 빌드를 실제로 수행했다. 원본 147,984,896 B,
기능 미완성 제거본 116,613,632 B로 31,371,264 B (21.20%) 감소했다.
[후속 실측 결과](../experiments/duckdb-size/50-results.md)를 우선 참고한다.
아래 내용은 빌드 전 작성한 정적 검토이며, 당시 미측정 항목을 그대로 구분해 기록한다.

## 결론

DuckDB는 제품 요구사항 자체의 필수 조건은 아니다. 다만 현재 구현은 DuckDB를 query뿐 아니라
prepared CSV 읽기에도 사용한다. Polars로의 통합은 가능성을 검증할 후보이며, 즉시 제거해도
동등한 동작을 보장하는 상태는 아니다.

**용량 절감만을 이유로 DuckDB 제거를 먼저 선택할 근거는 부족하다.** 현재 확인된 같은 소스
비교에서 약 65MB를 추가한 것은 Polars다. DuckDB의 제품 EXE 내 비중은 측정되지 않았다.
따라서 우선 release 최적화와 의존성별 크기 비교를 하고, 단일 엔진 전환은 기능·자원 계약을
검증한 뒤 결정하는 것이 타당하다. 이번 검토는 교체 결정이나 구현 승인이 아니다.

## 크기 근거와 정정

출처: `artifacts/phase-15/60-dependency-package-audit.md`의 동일 source feature OFF/ON 비교.

| 구성 | EXE | NSIS |
| --- | ---: | ---: |
| DuckDB 포함, Polars OFF | 78,187,520 B | 13,703,348 B |
| DuckDB 포함, Polars ON | 143,631,872 B | 24,883,629 B |
| Polars ON 증가분 | 65,444,352 B (62.4 MiB) | 11,180,281 B (10.66 MiB) |

- 이는 당시 빌드의 측정값이며 현재 소스 재빌드 결과가 아니다.
- OFF의 78MB는 DuckDB만의 크기가 아니다. Tauri, Arrow/Parquet, HDF5와 제품 코드도 포함한다.
- Polars 증가분은 해당 feature를 켰을 때 함께 링크되는 코드의 순증가량이다. 엔진별 크기는
  공통 dependency와 linker의 도달 가능 코드에 영향을 받으므로 단순 가산·차감으로 확정할 수 없다.
- `artifacts/phase-9/engine-spike.md`의 DuckDB spike EXE는 30,046,720 B다. 다른 소스,
  toolchain 및 기능 조합이므로 제품의 DuckDB 제거 절감량으로 사용할 수 없다.
- 따라서 “140MB의 절반 이상이 DuckDB”도, “DuckDB를 빼면 70MB 미만”도 입증되지 않았다.
- 배포 전송량과 설치 후 EXE 크기는 별개다. 당시 Polars ON installer는 약 25MB였지만
  설치된 EXE가 약 144MB인 문제를 해소하는 것은 아니다. EXE 크기는 실행 시 RSS와도 다르다.

## 현재 결합 범위

| 영역 | 코드 근거 | 제거 시 필요한 작업 |
| --- | --- | --- |
| provider 인터페이스 | `src-tauri/src/data/source.rs`: `QueryPrepareContext.connection`, `prepared_view_sql` | SQL connection 대신 엔진 중립 source/artifact 계약 |
| CSV preparation | `src-tauri/src/data/csv_source.rs`: `prepare_with_polars`, `prepare` | Polars/Rust 준비 산출물은 재사용하되 DuckDB view 생성 분리 |
| CSV cache | `src-tauri/src/query/engine.rs`: `build_csv_cached_database`, `build_csv_prepared_artifact` | `prepared.duckdb` 의존 제거, manifest/호환 cache 복원 정책 |
| CSV Ready page/copy | 같은 파일: `read_prepared_csv_values`, `read_prepared_csv_range` | compact Parquet의 projected/sparse 읽기와 raw/state/display 복원 |
| Parquet query | `src-tauri/src/data/parquet_source.rs`: `ParquetQueryProvider::prepare` | native logical type와 안정 source row identity를 보존하는 scan |
| 필터·다중 정렬 | `src-tauri/src/query/sql.rs`: `materialize_sql` | typed expression 변환, 양방향 null-last, source row ID tie-breaker |
| 결과 위치 | `src-tauri/src/query/engine.rs`: query_result table, `validate_result_index` | 결과 위치→source row ID의 제한된 random access index |
| Find·고유값·경계 | 같은 파일: `find_match`, `distinct`, `find_boundary`; `sql.rs`: `find_matches_sql` | 기존 순서·타입·빈 값 의미와 논리 위치를 보존하는 조회 |
| 취소·자원 제어 | 같은 파일: `QueryBudgetMonitor`, `query_connection_config` | interrupt 대체, memory/temp 제어와 typed 오류·cleanup |

준비된 CSV도 DuckDB를 사용하므로 “필터·정렬을 쓰지 않으니 dependency만 삭제”할 수는 없다.
반면 Tauri IPC·React grid의 공개 계약은 유지한 채 backend를 옮길 수 있어 UI 전면 교체는
필수 조건이 아니다.

## Polars 통합에서 미검증인 핵심 사항

1. **대용량 정렬의 메모리와 spill.** 제품의 기존 Polars 실험은 CSV→compact Parquet 변환이다.
   전량 정렬·Find·distinct의 자원 상한을 입증하지 않는다. DuckDB 현재 설정은 connection당
   `max_memory("1GiB")`와 temp allowance다. 이것도 프로세스 RSS 전체의 엄격한 상한을 뜻하지
   않는다. 후보 역시 parent+worker peak RSS와 실제 temp high-water를 따로 측정해야 한다.
2. **streaming이라는 명칭만으로 bounded memory를 보장할 수 없다.** 공식 Polars 문서도
   일부 연산의 in-memory fallback을 설명한다. 고정된 Rust 0.54.4의 실제 physical plan과
   spill 동작을 검증해야 하며 최신 Python/Polars 기능을 이 버전에 그대로 적용하면 안 된다.
3. **타입 기능과 크기의 추가 증가 가능성.** 현재 Polars feature는 `csv`, `lazy`, `streaming`,
   `parquet`다. CSV 준비의 Decimal은 문자열로 남긴다(`csv_polars.rs::typed_value_expr`).
   이 경로가 native Decimal query를 이미 대체한다는 뜻은 아니다. Decimal·시간·dictionary
   지원에 필요한 feature와 canonical expression을 확정하고 그 구성으로 크기를 재측정해야 한다.
4. **결과 전체를 RAM에 collect하면 안 된다.** 현재 결과는 source row ID 한 열만 유지한다.
   후보도 필터·정렬에 필요한 컬럼만 scan하고 row-ID 결과를 디스크로 순차 저장해야 한다.
   `u64` row ID 1천만 개만 해도 약 80MB이며, 정렬 키·중간 buffer·Find index는 별도다.
5. **페이지마다 sort/filter를 다시 실행하면 안 된다.** 완료된 결과 index에서 최대 200개의 ID를
   먼저 읽고 source에서 요청한 1~64개 컬럼만 읽는 기존 계약을 유지해야 한다. 고정폭 u64
   index 파일은 후보이나, atomic publish·개수 검증·세션 격리·정리까지 구현해야 한다.
6. **취소와 디스크 예산은 별도 이식 대상이다.** CSV 준비는 이미 same-EXE worker와 hard cancel을
   사용한다. 이를 query worker로 확장할 수 있지만 동시 실행, partial 정리, cache lease,
   예산 초과 후 오류 변환과 stale 결과 차단을 새로 검증해야 한다. 실행 중 감지만으로
   엄격한 hard cap을 지켰다고 판단해서도 안 된다.
7. **의미 동등성.** Int64/UInt64 경계, Decimal 정밀도, timestamp 단위/timezone, duration,
   row group별 dictionary mapping, raw/typed/empty/null/invalid, Unicode lowercase와 Find의
   문자열 표현, null-last와 동점 정렬을 현재 golden 결과와 비교해야 한다.

공식 문서 참고:
- [Polars streaming과 in-memory fallback](https://docs.pola.rs/user-guide/concepts/streaming/)
- [Polars sources/sinks](https://docs.pola.rs/user-guide/lazy/sources_sinks/)

공식 문서는 일반 실행 모델 참고용이다. 이번 세션에서 docs.rs의 고정 0.54.4 API/source 페이지를
열지 못했으므로 해당 버전의 external-sort·memory/temp API 유무는 확정하지 않았다.

## 선택지 비교

| 선택 | 크기 근거 | 대가·위험 | 판단 |
| --- | --- | --- | --- |
| 두 엔진 유지 + release 최적화 | 절감량 미측정 | LTO·codegen·size optimization의 build 시간/성능 영향 | 첫 비교 실험으로 적합 |
| Polars OFF, Rust CSV + DuckDB | 과거 EXE 약 78MB | cold CSV 준비 성능 저하; 현재 Phase 15 성능 gate 재검증 필요 | 용량 우선 후보 중 근거가 가장 명확 |
| Polars만 유지, DuckDB 제거 | 제품 절감량 미측정 | 위 query/cache/lifecycle 이식 전부 필요; feature 추가가 절감을 상쇄할 수 있음 | 장기 통합 후보, POC 후 결정 |
| 두 엔진 제거, 직접 Rust 구현 | 절감량 미측정 | typed expression·external merge sort·Find·index·자원 제어 직접 유지보수 | 용량만을 위해 바로 선택할 이유 부족 |

현재 `Cargo.toml`에는 별도 `[profile.release]` 최적화 설정이 없다. Cargo 기본 release도
최적화된 빌드이므로 “현재 최적화가 전혀 없다”는 뜻은 아니다. Rust LTO는 bundled C++ DuckDB
전체에 동일하게 적용된다고 보장할 수 없다. 최적화만으로 특정 크기에 도달한다고 약속하지 않는다.

Polars를 제거했을 때 과거의 58.38초가 그대로 재현된다고도 단정할 수 없다. Phase 15의 다른
Rust 준비 개선이 포함되어 있으므로 최신 source의 feature OFF cold/warm 성능 비교가 필요하다.

## 결정에 필요한 최소 실험

1. 동일 source·Rust/MSVC·frontend assets로 기본 build와 release 최적화 build를 비교한다.
   EXE/NSIS bytes, hash, build 설정·시간을 함께 남기며 실행 성능 회귀를 확인한다.
2. 같은 source의 Polars OFF/ON을 다시 비교한다. CSV 5.85M low/high cold 5회와 warm,
   peak RSS(parent+child), 취소, page/query/copy parity를 기록한다.
3. DuckDB 없는 Polars 후보는 격리된 작은 실행 파일에서 먼저 검증한다. 처음에는 prepared
   CSV Parquet와 native Parquet를 대상으로 typed filter→multi-sort→row-ID disk index→page
   순서를 구현한다. 미사용 DuckDB dependency만 빼서 나온 크기를 완성 제품 절감량처럼 보고하지 않는다.
4. 5.85M 및 10M low/high, 긴 문자열·다중 키·null/invalid·Decimal/시간/dictionary fixture로
   결과 ID checksum과 typed page/copy golden을 비교한다. 작은 filter 성공만으로 통과시키지 않는다.
5. 메모리보다 큰 sort를 강제로 실행해 실제 spill, 공통 디스크 예산·안전 여유, cancel ≤1초,
   failure/replace/close 후 worker·partial·lease·예약량 복귀를 검증한다.
6. 최소 POC가 통과한 경우에만 cache compatibility, Find/distinct/경계, 동일 source의 제품
   DuckDB ON/OFF 최종 EXE/installer까지 비교한다. 교체 확정에는 기존 필수 native/soak도 필요하다.

## 이번 검토의 검증 범위

- 작업 트리 clean 상태에서 manifest, provider, query SQL/engine, Polars worker, Phase 9/15/18
  측정·검증 기록과 상세 계약을 읽었다.
- 이 checkout에는 `src-tauri/target`과 기존 release EXE가 없어 현재 바이너리의 symbol/link map
  분석이나 새 A/B 빌드는 수행하지 않았다. 기록의 byte 수를 새 측정값으로 제시하지 않았다.
- 제품 코드를 바꾸지 않았으므로 unit/E2E/release/native suite를 재실행하지 않았다.
- Phase 15와 18에 남은 native·spill·soak BLOCKED를 유지한다. 기존 구현도 모든 대용량
  자원 gate가 완료된 것으로 평가하지 않았다.

최종 권고: **우선 크기 원인을 정확히 분리하고, 용량이 최우선이면 Polars OFF 경로부터 비교한다.
Polars 단일 엔진화는 검증할 가치가 있지만, 지금 DuckDB를 제거하는 결정을 내릴 근거는 부족하다.**
