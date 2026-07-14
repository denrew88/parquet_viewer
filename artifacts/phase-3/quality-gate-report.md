# Phase 3 독립 품질 게이트

- 수행일: 2026-07-14 (Asia/Seoul)
- 최종 판정: **FAIL**
- 환경 차단: Browser 및 native UI 항목은 별도로 **BLOCKED**

Phase 3은 현재 완료 처리할 수 없다. 자동 gate 자체는 모두 통과했지만, 필수 golden fixture와
경계/수명주기 직접 검증이 빠져 있고 raw header 문제 보존 계약이 DTO에 구현되어 있지 않다.
또한 Browser와 native 증거는 실행 환경상 수집하지 못했다.

## 실행 결과

| Gate | 결과 | 증거 |
| --- | --- | --- |
| Frontend format | PASS | `npm run format:check` |
| Frontend lint | PASS | `npm run lint` |
| Frontend typecheck | PASS | `npm run typecheck` |
| Frontend test | PASS | Vitest 2 files, 53 tests |
| Frontend build | PASS | Vite production build |
| Rust format | PASS | `cargo fmt --all -- --check` |
| Rust clippy | PASS | `cargo clippy --all-targets --all-features -- -D warnings` |
| Rust test | PASS | 52 tests, 0 failures |
| Tauri release build | PASS (root 증거 참조) | root의 Phase 3 integration build PASS. 독립 offline 재실행은 Phase 4 Cargo contention 때문에 중단 |
| Parquet regression | PASS | Phase 1/2 Parquet tests가 Rust 전체 gate에 포함되어 통과 |
| Browser | BLOCKED | Browser backend 목록 `[]`; standalone 대체 없음 |
| Native | BLOCKED | visible Tauri window handle 없음 |

최초 독립 Tauri build는 crates.io 접근이 차단되어 실패했다. `CARGO_NET_OFFLINE=true` 재실행은
root 요청에 따라 동시 Phase 4 Cargo 작업과의 contention을 피하려고 중단했다. 제품 build 판정은
root가 같은 Phase 3 통합 상태에서 수행한 release build PASS 증거를 참조한다.

## Fixture 감사

실제 `fixtures/phase-3`에는 header, no-header, BOM, quoted, empty/empty-field, invalid UTF-8,
UTF-16LE, inconsistent width, 20,000-row, native 450-row fixture가 있다. Python `csv`로 독립
구조 검사를 수행해 각각의 record 수와 width를 확인했다.

반면 계획의 F-P3-07(8 MiB 경계), F-P3-08(4,096 column 경계), F-P3-11(checkpoint cap),
F-P3-12(worker double), F-P3-13(ambiguous header), F-P3-14(blank/duplicate/long header)와
F01~F14 expected golden JSON은 없다. 현재 Quality 소유 fixture만 보강해도 실제 Rust parser와
golden을 비교할 공개 test seam이 없어서 T-P3-047을 충족할 수 없다.

## 필수 발견 사항

1. **T-P3-017 FAIL**: `CsvMetadata`에는 raw header 또는 blank/duplicate header 문제를 보존하는
   필드가 없다. `build_columns`가 빈 이름을 `Column N`, 중복을 `name (2)`로 바꾸지만 원본과
   변환 사유를 Metadata에서 복구할 수 없다.
2. **T-P3-026 FAIL**: `CsvSource::drop`은 cancellation flag만 설정한다. worker `JoinHandle`을
   보관하거나 종료를 기다리는 bounded teardown이 없어 drop 반환 시점의 worker/file handle/index
   해제를 보장하지 않는다.
3. **T-P3-047 FAIL**: 필수 fixture와 expected golden JSON이 불완전하고 실제 Rust parser 대조
   harness가 없다.
4. 경계, checkpoint, background failure, CSV unknown-total paging, stale progress의 필수 ID는
   제품 코드 경로가 존재하더라도 직접 실행 증거가 없어 엄격한 gate에서 FAIL이다.

## ID별 판정

| ID | 판정 | 근거 |
| --- | --- | --- |
| T-P3-001 | PASS | CSV open/summary/preview command test |
| T-P3-002 | PASS | absent header 첫 record 및 projection test |
| T-P3-003 | PASS | UTF-8 BOM/한글 fixture와 Rust BOM test |
| T-P3-004 | PASS | quoted comma Rust test |
| T-P3-005 | PASS | quoted multiline Rust test |
| T-P3-006 | PASS | escaped quote Rust test |
| T-P3-007 | PASS | 0-byte CSV 및 empty record 처리 test |
| T-P3-008 | PASS | empty string이 string kind로 보존됨 |
| T-P3-009 | PASS | 마지막 empty column 폭 보존 test |
| T-P3-010 | PASS | InvalidEncoding typed error test |
| T-P3-011 | PASS | UTF-16LE UnsupportedEncoding test |
| T-P3-012 | FAIL | 상한 -1/상한/+1 직접 fixture와 경계 test 없음 |
| T-P3-013 | FAIL | 4,095/4,096/4,097 column 직접 경계 test 없음 |
| T-P3-014 | PASS | 폭 불일치 pad 및 bounded issue test |
| T-P3-015 | PASS | header 재설정 generation/page test |
| T-P3-016 | FAIL | ambiguous auto suggestion/override 직접 test 없음 |
| T-P3-017 | FAIL | raw/blank/duplicate header 문제 Metadata 계약 없음 |
| T-P3-018 | PASS | CSV 값은 추론 없이 모두 string DTO로 유지 |
| T-P3-019 | PASS | open 직후 calculating/null count test |
| T-P3-020 | FAIL | progress 단조 증가 표본과 terminal 100% 직접 test 없음 |
| T-P3-021 | FAIL | checkpoint -1/0/+1 random access test 없음 |
| T-P3-022 | FAIL | CSV partial last page 및 EOF 직접 test 없음 |
| T-P3-023 | FAIL | 4,096 checkpoint 초과 재소거/메모리 test 없음 |
| T-P3-024 | PASS | cancel terminal state Rust test |
| T-P3-025 | PASS | cancel/complete 단일 terminal state test |
| T-P3-026 | FAIL | Drop가 cancel flag만 설정하고 worker 종료를 join하지 않음 |
| T-P3-027 | PASS | CSV projection 순서/값 보존 test |
| T-P3-028 | PASS | CSV open/read/close 공통 command envelope test |
| T-P3-029 | PASS | camelCase DTO 및 TS validator tests |
| T-P3-030 | PASS | status 응답에 sessionId와 generation 포함 |
| T-P3-031 | PASS | close 후 SessionNotFound command test |
| T-P3-032 | FAIL | CSV worker가 실행 중인 성공적 Parquet 교체 teardown 직접 test 없음 |
| T-P3-033 | FAIL | CSV-to-CSV 성공/실패 stale generation 직접 test 없음 |
| T-P3-034 | FAIL | preview 이후 background parse failure fixture/test 없음 |
| T-P3-035 | FAIL | unknown/non-CSV configure 거절 직접 test가 없음 |
| T-P3-036 | PASS | configure 후 cache 초기화와 새 page 확인 test |
| T-P3-037 | PASS | CSV typed error enum/serialization 계약 확인 |
| T-P3-038 | PASS | 정상/모순 CSV adapter validator tests |
| T-P3-039 | PASS | preview/progress/Metadata UI test |
| T-P3-040 | PASS | 활성 scan cancel 및 preview 유지 test |
| T-P3-041 | FAIL | stale page는 검증됐지만 stale CSV progress/success/error 직접 test 없음 |
| T-P3-042 | PASS | header suggestion/used 표시 및 atomic override test |
| T-P3-043 | PASS | comma/newline/quote/empty string 표시 test |
| T-P3-044 | PASS | Metadata structure issue row/width 표시 test |
| T-P3-045 | FAIL | unknown total의 CSV middle/last/EOF UI paging 직접 test 없음 |
| T-P3-046 | FAIL | encoding/limit/index 오류별 retry/open UI test 없음 |
| T-P3-047 | FAIL | F07/F08/F11~F14 및 expected golden JSON/harness 누락 |
| T-P3-048 | BLOCKED | in-app Browser backend 없음 |
| T-P3-049 | BLOCKED | in-app Browser backend 없음 |
| T-P3-050 | BLOCKED | 3 viewport geometry 실행 불가 |
| T-P3-051 | BLOCKED | Browser screenshots 실행 불가 |
| T-P3-052 | BLOCKED | visible native window handle 없음 |
| T-P3-053 | BLOCKED | native BOM/invalid encoding dialog 실행 불가 |
| T-P3-054 | BLOCKED | native progress/cancel 실행 불가 |
| T-P3-055 | BLOCKED | native screenshot/smoke 실행 불가 |
| T-P3-056 | PASS | 전체 자동 gate와 root release build 증거, Parquet regression 통과 |
| T-P3-057 | FAIL | 필수 FAIL과 BLOCKED가 남아 evidence gate 미충족 |

## 결론

자동 gate 회귀는 없지만 Phase 3 완료 조건은 충족하지 않는다. 우선 raw header 문제 DTO와
bounded worker teardown을 제품 코드에서 보완하고, 누락된 boundary/checkpoint/stale/error fixture와
직접 테스트를 추가해야 한다. 이후 Browser backend와 visible native desktop이 있는 세션에서
T-P3-048~055를 다시 실행해야 한다.
