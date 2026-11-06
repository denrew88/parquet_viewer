# Phase 21 품질 계획 제안

실행 모드: **테스트 설계**. 2026-11-04.
Root가 배정한 세 기능과 아래 확정 설계 메시지를 기준으로 정식 10-test-plan.md에 통합할 제안이다.
초기 조사 시 Phase 21 scope 파일은 아직 없었고, Root의 후속 설계 확정 메시지를 받아 최종화했다.
구현·suite·build를 실행하지 않았으며 PASS 판정 문서가 아니다.

## 구현 전 고정할 계약

1. 고유값은 source 전체 / 현재 filtered query 중 선택한 snapshot을 대상으로 한다. 정렬 자체는 빈도를 바꾸지 않는다.
   `totalDistinct`는 해당 scope의 전체 고유값 개수, `matchedDistinct`는 검색 후 개수로 분리한다. loaded page 개수를 total로 표시하지 않는다.
2. grouping identity는 값의 논리 타입과 null/empty/invalid 상태를 보존한다. 기본 권고는 typed 값 기준이며 typed-equal 원문 `01`/`1`은 한 값으로 합친다.
   invalid는 원문별, null은 한 그룹, empty 문자열은 별도 그룹이다. 표시 포맷으로 같아 보이는 값을 조용히 합치지 않는다.
   invalid/null 포함 여부, count 비율 분모, 값순의 typed 정렬과 tie-breaker를 명시한다.
3. 별도 비동기 ColumnValues 작업이 DuckDB에 grouping 결과 snapshot을 materialize한다. start는 operationId/document/session/queryId|null/column을 고정한다.
   null queryId는 source 전체, Some은 immutable filtered snapshot이다. list는 exact totalCount/matchedCount, search, valueAsc/Desc/countAsc/Desc, offset/limit≤200을 사용한다.
   count·정렬·copy는 같은 snapshot을 공유한다. 취소·close 시 statement·table·operation map·reservation을 해제하고 같은 operationId/다른 snapshot의 충돌을 거절한다.
4. 고유값 복사는 backend 작업이며 values-only / values+counts, search 결과 전체 / 선택한 값의 범위를 명시한다.
   loaded pages만 복사하지 않는다. 기존 copy byte/cell 상한·TSV escaping·원자적 clipboard commit·progress/cancel 계약을 재사용한다.
   문자열·정수·decimal·timestamp는 JS Number 변환 없이 보존한다. count/total이 JS safe integer를 넘을 때 DTO 표현도 확정한다.
5. 설정 schema는 5, csvCacheLimitBytes는 64MiB~10GiB·기본 10GiB이다. 유효 cap은 min(overall, configured cache cap)이고 설정 cap이 overall보다 커도 유효하다.
   0.3GiB 반올림·64MiB/10GiB 기존 경계 정책을 새 UI에도 적용한다.
   cap를 낮출 때 inactive만 LRU로 회수하고 active 초과량은 명시한다. 활성 cache 강제 삭제 또는 silent cap 인상은 금지한다.
6. csvCacheDirectory는 Option managed root이며 native picker에서 승인받은 목적지만 사용한다. 임의 폴더 내용 전체를 cache로 취급하지 않는다.
   절대·정규화 경로, 같은 경로/no-op, 부모·자식 cache root, source 내부 경로, symlink/junction/reparse와 충돌 정책을 확정한다.
7. 이전은 별도 progress/cancel 작업이다. 모든 문서를 닫고 pending open이 없어야 하며 command freeze와 query service shutdown 경계를 둔다.
   다른 프로세스의 어떤 entry lease든 whole-move를 actionable busy로 거절한다.
   다른 프로세스와의 lease/publish 경쟁도 방지한다. 닫은 다른 프로세스가 옛 root에 다시 publish하는 stale-root 문제를 marker/generation 검증 등으로 차단한다.
8. 다른 volume에서는 bounded copy → artifact 검증 → 새 OS identity/time으로 manifest 갱신 → 목적지 commit → settings 원자 저장 → 원본 삭제 순서를 따른다.
   실패·취소·crash 때 마지막 유효 root/settings/원본을 유지하고 자신이 만든 partial만 정리한다. 기존 destination/foreign 파일은 보존한다.
9. 별도 volume의 cache 여유 공간과 query-temp volume 여유 공간을 각각 검사한다. 공통 logical cap과 각 volume physical reserve를 혼동하지 않는다.
   앞으로 새 CSV를 준비할 때 cache publish도 cross-volume rename 실패에 대한 안전한 copy 경로가 있어야 한다.
   이전 동안 새 작업은 금지하며 logical 사용량은 동일 cache를 한 번만 센다. 임시 복제 overhead만 예외로 두되 목적지 physical free는 전체 copy와 5GiB reserve를 확보해야 한다.

## 테스트 대응표

| ID | 완료 조건 / 시나리오 | 계층·fixture | PASS 기준 | 담당 |
| --- | --- | --- | --- | --- |
| T-P21-001 | exact distinct count·frequency | Rust, golden categories | 모든 행 count 합·고유값 총수 oracle 일치; 0/1행 포함 | 구현 unit + 품질 golden |
| T-P21-002 | source vs filtered scope | Rust + E2E, 동일 파일/다른 query | filter/clear/sort 후 scope별 total/count 정확; 원본/결과 혼동 없음 | 구현 + 품질 |
| T-P21-003 | typed/raw와 정밀도 | Rust, uint64>2^53·decimal·timestamp·`01`/`1` | 확정 grouping 기준과 precision 보존, CSV/Parquet 동일 | 구현 unit |
| T-P21-004 | null/empty/invalid | Rust + component + E2E | 빈 항목이 구분 가능한 label로 표시되고 페이지·count에서 누락/중복 없음 | 구현 + 품질 |
| T-P21-005 | 검색 exact totals | Rust + E2E, Unicode/대소문자/공백/quote/SQL 유사 문자열 | matched/overall 구분, 검색 전후 totals 일관, literal parameter 처리 | 구현 + 품질 |
| T-P21-006 | 100 경계·빈 페이지·마지막 페이지 | Rust + E2E, 0/1/99/100/101/237 distinct | offset/hasMore 정확, 중복·누락 없음; null filtering이 offset을 바꾸지 않음 | 구현 + 품질 |
| T-P21-007 | value/count 정렬과 동률 | Rust + component, 237 값·동일 count | 정렬 방향·안정 tie-breaker·pagination 일치; 숫자 2<10 | 구현 unit |
| T-P21-008 | stale·취소·tab/query 변경 | Rust lifecycle + E2E delayed response | 늦은 count/list/copy 결과가 새 column/scope/query에 게시되지 않음 | 구현 + 품질 |
| T-P21-009 | values-only / values+counts 복사 | Rust serializer + browser + native | 전체 검색 결과가 golden TSV와 일치, loaded 100개와 전체 237개 구분 | 구현 + 품질 |
| T-P21-010 | escaping·한글·줄바꿈·formula-like text | Rust + native clipboard | 기존 copy preset/escaping 계약과 일치, raw precision 손실 없음 | 구현 + 품질 |
| T-P21-011 | 대량 복사 상한·진행·cancel·commit | Rust task + E2E + native | byte/cell cap typed 실패, 취소 전 clipboard 불변, 성공 한 번만 atomic commit | 구현 + 품질 |
| T-P21-012 | resource·고카디널리티 | Rust integration/native, 5.85M 또는 합성 1M distinct | 페이지·task·buffer 상한 코드·계측으로 확인; 전체 values JS 적재 없음; cancel 터미널 확인 | 품질 |
| T-P21-013 | cache cap DTO parity | Rust + TS, min/max/±1/0.1/0.3/NaN/fraction byte/overflow | 같은 조합 accept/reject, raw range 확인 후 integer byte rounding·reopen 동일 | 구현 unit |
| T-P21-014 | settings legacy migration·restart | Rust persistence + native | 기존 설정은 명시적 기본값, 저장/재시작 후 cap/root 동일; 손상 설정 안전 복구 | 구현 + 품질 |
| T-P21-015 | overall cap + cache cap 조합 | Rust, 0.3/0.5/1GiB 및 cache cap>overall | configured cap>overall 허용, effective=min(overall,cap); 합산/예약 중복 없음 | 구현 unit |
| T-P21-016 | inactive LRU 회수·active 보호 | Rust subprocess lease + native | 최소 필요한 inactive만 회수, 두 프로세스 active/read-only source 보존 | 구현 + 품질 |
| T-P21-017 | cap 축소 | Rust + UI/native | 축소 전/후 사용량·지울 양 안내, active 초과 정책 명시, 기존 session/page/query 정상 | 구현 + 품질 |
| T-P21-018 | cache root 선택·취소 | component/browser + native dialog | cancel 무변경, backend가 검증한 destination만 적용, 원래 source 불변 | 품질 |
| T-P21-019 | path 경계·foreign 보존 | Rust temp roots | same path no-op; 상대·부모/자식·충돌·권한·junction 등 확정 정책대로; foreign sentinel 전부 보존 | 구현 unit |
| T-P21-020 | 같은 drive 이전 | Rust integration + native | source/dest SHA·schema·행 수 일치; 재시작 warm Ready, 원본 삭제는 commit 뒤에만 | 구현 + 품질 |
| T-P21-021 | 실제 다른 drive 이전 | native, 실제 별도 volume | volume identity가 다름을 기록; copy·manifest 새 identity·warm reopen·새 CSV 준비/page/query PASS | 품질 |
| T-P21-022 | 강제 copy 경로 | Rust injected EXDEV | rename 불가 경로에서 bounded copy·sync·verify·commit 실행; 이를 실제 cross-drive PASS로 부르지 않음 | 구현 unit |
| T-P21-023 | 이전 active/busy·동시 publish | Rust subprocess/native | 열린 문서·pending open·다른 process의 어떤 lease도 whole-move 차단; freeze/shutdown과 lease race에도 active 이동/삭제 없음 | 구현 + 품질 |
| T-P21-024 | 이전 중 cancel | Rust failpoint + UI/native | 복사 중·검증 중 cancel의 terminal/잔여 공간 확인; source/settings 유효, foreign destination 불변 | 구현 + 품질 |
| T-P21-025 | disk full/권한/파일변경/손상 | Rust injected failures | 어느 copy/verify/commit 단계 실패라도 old root 복구; typed actionable 오류·partial 정리 | 구현 unit |
| T-P21-026 | crash·설정 저장 실패·원본 삭제 실패 | Rust child process/failpoint | prepare/copy/commit/settings/delete 경계마다 재시작해 하나의 authoritative root; 삭제 실패는 복사 성공을 잃지 않고 보고 | 구현 + 품질 |
| T-P21-027 | migration 목적지의 새 OS identity | Rust/native | 새 artifact identity로 manifest 갱신되고 warm cache hit, 불필요한 cold 변환 0 | 구현 unit |
| T-P21-028 | volume별 공간과 공통 예산 | Rust mock volumes + native | C/D 여유 공간 독립 검사; migration의 logical cache 1회 과금·임시 copy overhead 예외·새 작업 금지; target copy 전량+5GiB reserve 유지 | 구현 + 품질 |
| T-P21-029 | 이전 후 stale process | Rust child/native 2 processes | 옛 root로 계속 publish/reclaim하지 못하고 안전 재연결/명확한 stale 오류 | 구현 + 품질 |
| T-P21-030 | backend 설정 end-to-end parity | wire→preview→apply→새 session/page/query | 0.3GiB·min/max·custom root 동일조합으로 DTO/실제 결과 일치 | 품질 |
| T-P21-031 | UI keyboard·focus·states | component + Playwright | header 진입, search/sort, Enter/Esc/Tab, loading/empty/error/progress/cancel·focus 복귀, input 중 grid shortcut 차단 | 구현 + 품질 |
| T-P21-032 | UI geometry·visual | Playwright 3 viewport + 이미지 독립 검토 | 1440×900/1024×768/800×600에서 panel·settings·progress·footer 겹침/잘림 없음; grid geometry 회귀 없음 | 품질 |
| T-P21-033 | 기존 회귀 | Rust/frontend/full E2E + lint/typecheck/Clippy/fmt | 기존 suite 통과, Phase 20 Utf8View·CSV warm·copy·selection 계약 유지 | Root 실행 + 품질 검토 |
| T-P21-034 | release/native/package identity | release/NSIS + native smoke | 0.21.0·data-viewer.exe·embedded UI·버전/hash·dialog/clipboard/cross-drive 기록; native 미실행은 별도 BLOCKED | Root + 품질 |
| T-P21-035 | 비동기 snapshot 수명·상한 | Rust lifecycle + E2E | start operation identity 고정; count/list/copy가 같은 immutable 결과; cancel/close/query 교체·동시 start 뒤 task/table/handle/예약 기준선 복귀; operation 수·disk·buffer 상한 명시 | 구현 + 품질 |

## Fixture와 golden 계획

- `fixtures/phase-21/distinct-small.csv` + 대응 Parquet: Unicode, quote/tab/LF/CRLF, numeric 2/10, uint64 경계, decimal, timestamp, null/empty, typed invalid 원문.
- `distinct-pages.csv`: 237개 고유값, count 동률·rare 값·null/invalid 포함. independent stdlib oracle로 source/filtered/search/sort/count/TSV golden 생성.
- 실제 타입별 precision은 Parquet fixture에서 보존하고 CSV profile은 고정한다. frontend mock은 golden과 동일한 identity/scope를 사용한다.
- migration fixture는 테스트 소유 cache root 2개와 foreign sentinel, 실제 유효 cache 2~3개, 손상 entry·partial·leased entry·별도 프로세스 lock으로 구성한다.
- 5.85M main-high는 `fixtures/phase-20/performance/main-high/high-5850000x15.csv`를 공용 참조한다. 복제·재생성하거나 experiment 경로로 되돌리지 않는다.
- 대형 distinct 입력·WebView profile·migration staging은 `.tmp`에 생성하고 최종 증거에 섞지 않는다. 작은 fixture·generator·golden·hash만 정식 후보에 보존한다.

## 실행·증거

- 구현 Agent: 표의 Rust/TS unit, boundary parity, lifecycle/failpoint/subprocess tests를 코드와 함께 작성.
- Quality: 독립 fixture/golden, Playwright interaction/geometry, native harness와 결과 독립 검토.
- UI 증거: `ui/distinct-{1440,1024,800}.png`, `ui/storage-{1440,1024,800}.png`, geometry JSON, interaction-results.md, 이미지 입력으로 검토한 visual-review.md.
- native 증거: 실제 folder chooser 선택/취소, 실제 Windows clipboard content·preservation, 다른 volume identity·전후 hashes·manifest·warm/cold counter·page/query 결과.
- 브라우저 mock은 실제 native chooser/clipboard/drive 이동의 PASS를 대체하지 않는다. 실제 별도 volume이 없다면 T-P21-021은 BLOCKED, 강제 copy unit PASS와 구분한다.
- 필요한 일반 개발 실행 권한은 기존 지시 범위다. Subagent는 승인 요청을 하지 않고 환경/권한 차단을 Root에 보고한다. 새 보안 capability·외부 배포는 Root가 판단한다.
- 실제 Excel 붙여넣기는 시스템 clipboard TSV 검증과 별도이며 미실행 상태를 유지한다. 기존 무관 Phase gate를 새 PASS로 바꾸지 않는다.

## 가장 큰 구현 위험

- 기존 distinct GROUP BY ALL은 raw까지 포함하므로 typed-equal 값이 중복 표시될 수 있다.
- UI가 null/invalid를 제거한 뒤 그 길이를 offset으로 쓰면 pagination 누락·중복을 일으킬 수 있다.
- cache manifest의 artifact identity/time은 복사 후 달라진다. manifest를 그대로 복사하면 warm hit가 깨진다.
- root 이전만 구현하고 cache publish의 cross-volume fs::rename를 유지하면 이후 새 CSV 준비가 실패한다.
- C의 query temp와 D의 cache가 갈라지면 현재 단일-volume free-space 계산을 그대로 재사용할 수 없다.
- source 삭제/manifest/settings switch 순서와 다른 프로세스의 stale root 사용을 빠뜨리면 사용자 cache·foreign data 손상 위험이 있다.
