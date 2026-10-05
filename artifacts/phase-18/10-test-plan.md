# Phase 18 테스트 계획

## 검증 원칙

- 실제 volume을 채우지 않고 작은 deterministic budget, 실제 DuckDB forced spill과 test-only fault probe를
  사용한다.
- query temporary data, persistent CSV cache, 전체 app storage 합계, free-space reserve를 별도 계측한다.
- cache 회수는 valid inactive entry만 대상으로 하며 active lease, 다른 process와 원본 파일은 byte/hash로
  불변을 확인한다.
- 오류 판정은 Rust `DataErrorCode`, message와 cleanup 결과를 함께 확인하며 raw SQL과 절대 temp path를
  사용자 메시지에 노출하지 않는다.

## 테스트 행렬

| ID | 계층 / 담당 | fixture·fault | 완료 기준 |
| --- | --- | --- | --- |
| `TMP18-001` | Unit / Rust Data | configured limit, query bytes, cache bytes, free bytes의 대표·경계 조합 | DuckDB allowance가 per-query cap, 공통 budget 잔여, `free-reserve` 잔여의 최솟값이고 exact limit/reserve에서 checked arithmetic으로 0이 된다. |
| `TMP18-002` | Unit+Integration / Rust Data | 작은 cache entry 여러 개와 deterministic access 순서 | query 시작 전 필요한 최소 inactive LRU만 회수하고 allowance를 확보한다. |
| `TMP18-003` | Integration / Rust Data | query 실행 중 scripted usage 증가와 inactive cache | 100ms monitor가 inactive cache를 회수한 뒤 query를 interrupt하지 않고 계속한다. |
| `TMP18-004` | Integration / Rust Data | active cache만 남음, limit 또는 reserve 부족 | active cache를 삭제하지 않고 `QueryTempLimitExceeded`로 실패한다. |
| `TMP18-005` | Unit+Integration / Quality | same-process shared cache lease | reclaim이 leased entry를 건너뛰고 다른 inactive entry만 LRU 삭제한다. |
| `TMP18-006` | subprocess / Quality | 다른 process가 잡은 cache lease와 query owner lock | foreign live entry와 owner directory를 삭제·rename하지 않는다. |
| `TMP18-007` | Security regression / Quality | 원본 옆 유사 이름, cache root 밖 foreign directory | reclaim/cleanup write·delete 대상은 app-owned root의 검증된 entry뿐이며 원본 hash가 같다. |
| `TMP18-008` | Unit+Integration / Rust Data | 동시 query 2개, 기존 result spill과 cache byte | 각 DuckDB max temp와 합계가 process cap/reserve를 넘지 않고 새 query가 이미 사용 중인 byte를 반영한다. |
| `TMP18-009` | Table unit / Rust Data | max-temp, disk-full/no-space, temp open/write/path와 source missing 오류 문자열 | temp storage 오류만 typed 분류하고 source missing·일반 SQL 오류는 `QueryFailed`로 남긴다. |
| `TMP18-010` | Contract / Quality | 각 terminal storage failure | message에 query/cache usage, limit, free/reserve와 Settings의 `Clear inactive CSV cache` 조치가 있으며 raw absolute path·SQL은 없다. |
| `TMP18-011` | Integration soak / Quality | filter/sort rapid replace·cancel·injected failure 100 cycle | terminal 후 task/result/lease/active query가 0이고 query temp bytes와 directory가 baseline으로 복귀한다. |
| `TMP18-012` | Lifecycle / Quality | tab close, shutdown, Windows delete retry와 delete-pending | active handle 종료 뒤 bounded cleanup하며 다음 clear/startup janitor가 pending을 회수한다. |
| `TMP18-013` | 실제 DuckDB integration / Quality | 낮은 memory와 2~16 MiB temp를 사용하는 high-cardinality sort | allowance 내 forced spill은 정확히 성공하고 allowance 밖은 typed storage 오류이며 partial result를 commit하지 않는다. |
| `TMP18-014` | Query regression / Quality | typed filter, 3-sort, null-last와 row identity oracle | reclaim/error hardening 전후 row count, stable order, first/middle/last page checksum이 같다. |
| `TMP18-015` | Windows release soak / Quality | 실제 5.85M fixture와 별도 live process | query plan 반복 중 cap/reserve 준수, raw disk/path error 0, 다른 process 손상 0이다. fixture가 없으면 정확한 BLOCKED 근거를 남긴다. |
| `TMP18-016` | 최종 gate / Root | format, clippy, 관련·전체 test, release/NSIS | 실행 가능한 gate가 PASS하고 기존 categorical 변경을 포함한 회귀가 없다. |

## 구현용 test seam

- production 기본값은 `fs2::available_space`를 사용하되 unit test는 scripted free-space probe를 주입한다.
- cache access 순서와 reclaim failure는 deterministic fixture 또는 test-only hook으로 고정한다.
- DuckDB 오류 분류는 I/O 없이 검증 가능한 pure classifier로 분리한다.
- fault hook은 `cfg(test)`에 한정하고 제품 cap, reserve와 polling 주기를 완화하지 않는다.

## 판정

- `TMP18-001`~`014`, `016`의 실행 가능한 항목에 FAIL이 있으면 Phase 18을 완료하지 않는다.
- 외부 5.85M fixture 또는 별도 Windows process 환경이 없으면 `TMP18-015`만 BLOCKED로 기록하며,
  자동 대체 fixture 결과를 함께 남긴다.
- UI 코드를 변경하지 않으면 screenshot/geometry는 적용 제외다. 오류 surface나 Settings control을 변경하면
  `docs/UI_VALIDATION.md`의 세 viewport interaction·geometry·screenshot과 실제 Tauri 검증을 추가한다.
