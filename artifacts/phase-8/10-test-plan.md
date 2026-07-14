# Phase 8 컨텍스트 메뉴·다중 실행·다중 파일 탭 테스트 계획

- 작성일: 2026-07-14
- 기준: `docs/PROJECT_SPEC.md`, `docs/DEVELOPMENT_PLAN.md`, `docs/UI_VALIDATION.md`, Phase 6 선택·클립보드 계약, Phase 7 배포·soak 계약
- 상태: 제품 계약 확정, 구현 전 기준선
- 범위: 셀 컨텍스트 메뉴, 동일 설치본의 다중 프로세스 실행, 한 창의 CSV·Parquet 다중 파일 탭

## 판정 원칙

- 자동 unit/component test는 논리 상태와 adapter 계약을 검증한다. 실제 위치, WebView 이벤트, OS clipboard, 프로세스와 파일 연결을 대신하지 않는다.
- 컨텍스트 메뉴의 `복사`는 Phase 6의 기존 논리 선택, TSV quoting, soft/hard limit, progress, cancel, atomic clipboard write 계약을 그대로 사용해야 한다.
- 파일 탭은 Data/Schema/Metadata 뷰 탭과 다른 계층이다. 아래에서 `파일 탭`은 열린 파일 세션, `뷰 탭`은 Data/Schema/Metadata를 뜻한다.
- 프로세스 독립성은 release 설치본의 서로 다른 실제 PID와 각 PID의 창·argv·세션 증거로만 PASS 처리한다. mock PID나 개발 서버 창은 대체 증거가 아니다.
- 다중 파일 탭의 세션, 페이지 요청 generation, CSV worker, cache, selection, copy 작업과 오류는 `fileTabId` 또는 동등한 불변 식별자로 격리되어야 한다.
- crash, panic, 잘못된 탭에 응답 적용, 다른 탭 clipboard payload, 닫힌 탭의 late update, handle/task/cache 누수는 한 건이라도 `FAIL`이다.
- Browser backend, visible native UI, 설치 권한 등 필수 환경이 없어서 실행하지 못한 항목은 근거와 함께 `BLOCKED`로 남기고 하위 계층 결과로 PASS를 대체하지 않는다.

## 제품 계약 가정

테스트를 추적 가능하게 만들기 위해 다음을 Phase 8 MVP 기본안으로 둔다. Root가 변경하면 관련 기대 결과와 ID를 구현 전에 함께 갱신한다.

1. 셀을 우클릭하면 현재 논리 선택을 대상으로 하는 커스텀 메뉴가 열리고 MVP 액션은 `복사`,
   `열 이름 포함 복사`, `셀 값 복사`, `전체 값 보기`다.
2. 선택 범위 안을 우클릭하면 선택을 유지한다. 선택 범위 밖의 셀을 우클릭하면 해당 셀을 단일 선택한 뒤 메뉴를 연다.
3. `Shift+F10`과 Context Menu 키는 active cell에 같은 메뉴를 연다. 메뉴가 열린 상태의 `Escape`는 메뉴만 닫고 선택은 유지한다.
4. 일반 `Open`은 파일을 추가하고 활성 탭으로 만든다. 실패한 열기는 기존 탭을 닫거나 활성 탭을 바꾸지 않는다.
5. 같은 canonical path를 다시 열면 중복 세션을 만들지 않고 기존 파일 탭을 활성화한다.
6. 파일 탭을 닫으면 해당 세션·worker·cache·copy 작업만 정리한다. 마지막 탭을 닫으면 empty workspace로 돌아간다.
7. 파일 연결 또는 startup argv로 실행할 때마다 새 프로세스와 새 창을 만든다. 기존 실행 프로세스로 argv를 전달하지 않는다.
8. 한 프로세스에 여러 유효 경로가 startup argv 또는 drop으로 전달되면 모두 파일 탭으로 열며, 실패 파일은 다른 성공 탭을 막지 않는다.
9. 8개 동시 문서는 일반 사용 검증 기준이며 최대치가 아니다. 한 process는 최대 64개 문서를
   유지하고 한 batch는 최대 32개 경로를 받으며 65번째 문서만 비파괴적으로 거부한다.
10. release/installer 앱은 server와 port를 사용하지 않는다. 개발 모드는 하나의 Vite 1420
    server를 여러 debug process가 공유한다.

## Fixture

| ID | 파일/생성 조건 | 용도와 필수 특성 |
| --- | --- | --- |
| `F-P8-01` | `fixtures/phase-2/large-types.parquet` | 240행, 6열, 3 row group, 64-bit·decimal·timestamp·binary·list; 선택·복사·Parquet 탭 |
| `F-P8-02` | `fixtures/phase-3/native-450.csv` | 450행 CSV; 페이지 이동·CSV 탭·background row count |
| `F-P8-03` | `fixtures/phase-3/quoted.csv`와 `bom-korean.csv` | tab/newline/quote/Unicode가 포함된 exact TSV와 경로·표시 검증 |
| `F-P8-04` | `fixtures/phase-7/large-csv.csv` | 장시간 CSV worker, active switch, close/cancel, memory 검증 |
| `F-P8-05` | `fixtures/phase-7/large-parquet.parquet` | 대용량 Parquet paging·cache·tab switch 검증 |
| `F-P8-06` | Phase 7 hostile corpus | 손상 Parquet, invalid UTF-8, ragged CSV, 0-byte, unsupported 확장자; 탭 열기 실패 격리 |
| `F-P8-07` | 임시 경로 corpus | 공백·한글·quote·긴 경로, 서로 다른 디렉터리의 같은 basename CSV/Parquet, 삭제/교체 경로 |
| `F-P8-08` | 100,000행×500열 CSV와 Parquet | 양방향 가상화, unmount된 셀 컨텍스트 메뉴, wide 탭 성능 |
| `F-P8-09` | 64개 small CSV/Parquet 교차 목록과 65번째 파일 | 8개 일반 탭 UX, 32개 batch, 64/65 방어 상한, cache |
| `F-P8-10` | clipboard adapter fault set | permission denied, unavailable, rejected Promise, delayed success/failure, hard-limit 초과 |
| `F-P8-11` | association argv matrix | 경로 없음, CSV 1개, Parquet 1개, CSV+Parquet, 유효+손상 혼합, Unicode·공백·quote 경로 |
| `F-P8-12` | 저카디널리티 release Parquet | 정확히 10,000,000행×10열, 100개 이상 row group, 검증용 row id와 반복 정수·category string·bool·null pattern·bucket timestamp·decimal, Zstd+dictionary; 약 50MiB는 참고 예상값이고 크기는 PASS 조건이 아님 |
| `F-P8-13` | 고카디널리티 release Parquet | F-P8-12와 같은 논리 타입·row-group·compression 설정, 정확히 10,000,000행×10열, unique/high-cardinality int64·string·timestamp·decimal 값; 실제 encoding과 크기를 manifest에 기록하고 크기는 PASS 조건이 아님 |

모든 생성 fixture는 seed, generator revision, 행·열 수, byte size, SHA-256, 대표 page checksum을 manifest에 기록한다. 실제 사용자 셀 값이나 전체 경로는 로그에 남기지 않는다.

## A. 컨텍스트 메뉴와 선택 계약

| ID | 계층 | Fixture/입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-001` | reducer/component | F-P8-01 단일 셀 선택 후 해당 셀 우클릭 | anchor·active·rect 불변, 메뉴 대상은 현재 selection generation | Grid UX |
| `T-P8-002` | reducer/component | F-P8-01 4×3 범위 안 셀 우클릭 | 범위와 active cell을 유지하고 `복사`가 4×3을 대상으로 함 | Grid UX |
| `T-P8-003` | reducer/component | 선택 범위 밖의 mounted 셀 우클릭 | 우클릭 셀로 단일 선택을 원자적으로 바꾼 뒤 메뉴 표시 | Grid UX |
| `T-P8-004` | component | row/column/all 선택 후 포함된 셀 우클릭 | 선택 kind와 header 포함 규칙이 Phase 6 계약대로 유지됨 | Grid UX |
| `T-P8-005` | component | 우클릭 이벤트 | 브라우저 기본 메뉴를 막고 앱 메뉴 하나만 표시, grid focus 유지 | Grid UX |
| `T-P8-006` | component | 네 MVP 메뉴 액션 click | 대상 선택·context cell에 맞는 기존 copy/full-value pipeline을 정확히 1회 호출하고 메뉴를 닫음 | Grid UX |
| `T-P8-007` | component | 메뉴 `복사` Enter/Space | pointer와 같은 selection·TSV·호출 수, 중복 write 0 | Grid UX |
| `T-P8-008` | keyboard | active cell에서 `Shift+F10` | active cell 근처에 메뉴가 열리고 첫 enabled item에 focus | Grid UX |
| `T-P8-009` | keyboard | Context Menu 키 지원 환경 | `Shift+F10`과 동일 동작, 키 미지원 환경은 플랫폼 비적용으로 기록 | Grid UX + Quality |
| `T-P8-010` | keyboard | 메뉴에서 ArrowUp/Down, Home/End, Enter | enabled item 순환·실행이 WAI-ARIA menu keyboard 계약과 일치 | Grid UX |
| `T-P8-011` | interaction | 메뉴 열린 상태에서 `Escape` | 메뉴만 닫힘, selection·scroll·active file tab 불변, focus가 grid active cell로 복귀 | Grid UX + Quality |
| `T-P8-012` | interaction | 메뉴 밖 grid/toolbar/파일 탭 click | click-away로 메뉴가 닫히고 해당 click의 본래 동작은 1회 수행 | Grid UX + Quality |
| `T-P8-013` | interaction | 메뉴 내부 click과 pointerdown | click-away handler가 먼저 닫아 액션을 유실하지 않음 | Grid UX |
| `T-P8-014` | interaction | menu open 후 scroll/resize/뷰 탭 전환 | 메뉴가 닫히며 stale 좌표·떠 있는 메뉴가 남지 않음 | Grid UX |
| `T-P8-015` | geometry | 네 viewport 모서리 셀 우클릭 | 메뉴 rect가 viewport 안에 clamp/flip되고 셀·menu gap은 설계 허용치 이내 | Quality |
| `T-P8-016` | geometry | 800×600, 150% scale, 긴 locale label | 메뉴 text clipping·가로 overflow·toolbar/status overlap 0 | Quality + Platform |
| `T-P8-017` | virtualization | F-P8-08 셀 선택→멀리 scroll해 unmount→복귀→keyboard menu | 논리 selection 유지, remount된 active cell 기준으로 메뉴가 열림 | Grid UX + Quality |
| `T-P8-018` | virtualization | unmounted active cell에서 keyboard menu 요청 | 필요한 최소 scroll 후 mount·focus·menu 표시, 잘못된 셀 사용 0 | Grid UX |
| `T-P8-019` | stale | 메뉴 open 후 file tab switch/close | 이전 메뉴 즉시 제거, 이전 selection 액션·clipboard write 0 | Grid UX |
| `T-P8-020` | accessibility | 메뉴 DOM | `role=menu/menuitem`, accessible name, focus order, focus-visible, disabled 상태가 정확 | Grid UX + Quality |

## B. 컨텍스트 메뉴 복사·클립보드 회귀

| ID | 계층 | Fixture/입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-021` | unit/component | F-P8-03 special values 범위의 메뉴 복사 | Ctrl+C와 byte-for-byte 동일한 UTF-8 TSV, tab·CRLF·quote 규칙 유지 | Grid UX |
| `T-P8-022` | component | row/column/all selection 메뉴 복사 | Phase 6 header 포함 여부와 논리 행×열 구조가 동일 | Grid UX |
| `T-P8-023` | component | soft limit 바로 아래/동일/위 | Phase 6 확인 임계값과 메시지가 Ctrl+C 경로와 동일 | Grid UX + Quality |
| `T-P8-024` | integration | hard cell/byte limit 바로 아래/동일/위 | 초과는 조회·write 전에 `CopyLimitExceeded`, clipboard hash 불변 | Rust Data + Grid UX |
| `T-P8-025` | integration | 미로딩 3개 page를 포함한 범위 | bounded chunk fetch, 정확한 순서, progress 표시, 마지막에 atomic write 1회 | Rust Data + Grid UX |
| `T-P8-026` | interaction | 복사 진행 중 메뉴/버튼 cancel | 다음 chunk 중단, partial clipboard write 0, buffer/task 회수 | Grid UX + Rust Data |
| `T-P8-027` | fault injection | F-P8-10 permission/unavailable/reject | typed 사용자 오류, 메뉴 닫힘, selection 유지, clipboard와 grid 불변 | Grid UX + Platform |
| `T-P8-028` | stale | delayed clipboard response 중 tab switch/close | 이전 탭 성공·실패가 현재 탭 banner/state를 덮지 않음 | Grid UX |
| `T-P8-029` | native | Windows Tauri 메뉴 복사 | 실제 시스템 clipboard SHA-256과 예상 TSV SHA-256 일치, write 1회 | Platform + Quality |

## C. 여러 프로그램 동시 실행

| ID | 계층 | Fixture/입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-030` | Rust/config | Tauri plugin·startup 설정 감사 | single-instance 강제가 없고 두 번째 실행을 기존 프로세스로 전달하는 경로가 없음 | Platform + Quality |
| `T-P8-031` | native release | 설치본을 경로 없이 2회 실행 | 제한 시간 내 서로 다른 실제 PID 2개와 top-level window 2개, 둘 다 usable | Platform + Quality |
| `T-P8-032` | native release | 설치본을 5회 동시 실행 | PID·창 5개, crash/deadlock 0, 각 창 독립 empty workspace | Platform + Quality |
| `T-P8-033` | native | PID A에서 F-P8-01, PID B에서 F-P8-02 열기 | 파일명·형식·행 checksum·selection·active view가 서로 독립 | Platform + Quality |
| `T-P8-034` | native | A에서 page/selection/menu, B에서 tab close/open | B 동작이 A의 UI/session/cache/worker에 영향 0 | Platform + Quality |
| `T-P8-035` | native | A clipboard copy 후 B copy | OS clipboard는 마지막 성공 write만 포함하며 앱 내부 progress/error는 각 PID에 귀속 | Platform + Quality |
| `T-P8-036` | native | PID A 종료, PID B 유지 | B 창·session·worker 정상, shared lock 때문에 종료/오류 없음 | Platform |
| `T-P8-037` | association | 설치 후 F-P8-11 CSV 더블클릭, 기존 앱 실행 중 | 기존 PID 외 새 PID가 생성되고 새 창은 argv CSV를 정확히 엶 | Platform + Quality |
| `T-P8-038` | association | 설치 후 Parquet 더블클릭 2회 | 각 invocation이 서로 다른 PID·창이며 각 argv/checksum이 올바른 창에만 적용 | Platform + Quality |
| `T-P8-039` | association | Unicode·공백·quote 경로 | argv 경계 손실·shell 해석·경로 분할 없이 정확히 1개 파일 탭 | Platform |
| `T-P8-040` | association | 유효+손상 파일 invocation 조합 | 각 프로세스가 자신의 typed 성공/오류만 표시, 다른 PID 종료·오염 0 | Platform + Quality |
| `T-P8-041` | resource | 5 PID에서 F-P8-04/05 혼합 | PID별 handle/task/cache 분리, 종료한 PID 자원 회수, 공유 temp/lock 충돌 0 | Platform + Rust Data |
| `T-P8-042` | installer | upgrade/uninstall/reinstall 후 2회 실행·association | 다중 실행 정책 유지, stale single-instance 등록·mutex·registry 없음 | Platform + Quality |
| `T-P8-043` | release/dev | 1420 점유 상태의 release 실행과 Vite 하나에 debug 앱 3개 연결 | release는 포트와 무관하게 동작, debug는 server 중복 기동 없이 3개 PID가 HMR server 공유 | Platform + Quality |

## D. 한 창의 다중 파일 탭 기능

| ID | 계층 | Fixture/입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-050` | Rust unit | F-P8-01과 F-P8-02를 session registry에 open | 서로 다른 sessionId/fileTabId로 동시에 조회 가능, 기존 session 교체 없음 | Rust Data |
| `T-P8-051` | Rust unit | 같은 canonical path 재open | 새 handle/worker/session 없이 기존 tab 식별자를 반환 또는 활성화 신호 반환 | Rust Data + Platform |
| `T-P8-052` | component | 빈 창에서 CSV open 후 Parquet open | 파일 탭 2개, 마지막 성공 파일 활성, 각 label·format indicator 정확 | Grid UX |
| `T-P8-053` | integration | dialog multi-select CSV+Parquet | 선택 순서로 탭 생성, 둘 다 usable, requestId/path/result 매핑 정확 | Platform + Grid UX |
| `T-P8-054` | integration | multi-drop/startup argv CSV+Parquet | 유효 파일을 각각 탭으로 열며 한 파일 실패가 전체 batch rollback을 만들지 않음 | Platform + Grid UX |
| `T-P8-055` | component | F-P8-01 Data에서 range 선택 후 F-P8-02 전환 | CSV page/selection/scroll/뷰 상태 표시, Parquet state는 보존 | Grid UX |
| `T-P8-056` | component | 파일 탭 왕복 전환 | 각 탭의 page offset, column visibility/width/search, selection, Data/Schema/Metadata 상태가 계약대로 복원 | Grid UX |
| `T-P8-057` | component | 같은 basename의 F-P8-07 두 파일 | 탭을 구별할 accessible label/title/tooltip 존재, canonical session 혼동 0 | Grid UX + Quality |
| `T-P8-058` | failure | 활성 탭이 있는 상태에서 F-P8-06 open | typed error 표시, 기존 탭 수·활성 탭·grid·selection·clipboard 불변 | Grid UX + Rust Data |
| `T-P8-059` | batch failure | valid CSV+corrupt Parquet+valid Parquet | 성공 탭 2개만 usable, 실패 1건은 파일별 오류, session leak 0 | Platform + Rust Data |
| `T-P8-060` | close | 비활성 중간 파일 탭 닫기 | 해당 session만 close, 활성 탭·focus·selection 불변, 탭 목록 순서 정상 | Grid UX + Rust Data |
| `T-P8-061` | close | 활성 파일 탭 닫기 | 인접 탭 활성화 규칙 일관, focus가 새 활성 탭 또는 grid로 이동 | Grid UX |
| `T-P8-062` | close | 마지막 파일 탭 닫기 | handle/worker/cache/copy 정리 후 empty workspace, 잔여 파일명·오류·selection 없음 | Grid UX + Rust Data |
| `T-P8-063` | close/stale | page fetch 중 탭 close | late success/failure/progress가 다른 탭이나 empty workspace에 적용되지 않음 | Grid UX + Rust Data |
| `T-P8-064` | close/copy | 큰 copy 중 탭 close | copy cancel, partial clipboard write 0, buffer/task 회수, 다른 탭 copy 가능 | Grid UX + Rust Data |
| `T-P8-065` | CSV worker | F-P8-04 indexing 중 F-P8-01 활성 전환 | CSV worker는 background에서 bounded 진행, Parquet UI latency 예산 유지 | Rust Data + Grid UX |
| `T-P8-066` | CSV worker | 두 CSV worker 동시 진행 | 상태·generation·cancel이 탭별 독립, worker concurrency 상한 준수 | Rust Data |
| `T-P8-067` | CSV worker | 비활성 CSV cancel/close | 해당 worker만 중단, 다른 CSV worker와 active Parquet session 불변 | Rust Data |
| `T-P8-068` | stale | A/B에서 page 요청 후 역순 resolve | 응답이 해당 fileTabId+sessionId+generation에만 적용, wrong-tab 0 | Grid UX |
| `T-P8-069` | stale | A close 후 같은 경로 A2 재open, A의 late response | 새 session A2에 이전 session 결과 적용 0 | Grid UX + Rust Data |
| `T-P8-070` | cache | A/B 같은 offset·projection 요청 | cache key에 session 귀속 포함, 페이지 checksum 교차 오염 0 | Rust Data |
| `T-P8-071` | cache | 8 탭에서 paging 후 일부 close | process-level 및 탭별 cache 상한 준수, 닫힌 탭 entry 0 | Rust Data + Quality |
| `T-P8-072` | memory/limit | F-P8-09 8개 일반 사용, 32개 batch, 64개 open 후 65번째 open | 8/32/64는 계약대로 동작하고 65번째만 기존 탭을 유지한 채 typed error | Rust Data + Quality |
| `T-P8-073` | tab strip | F-P8-09 8 탭, 1440×900 | tab strip 한 줄 유지, 필요한 경우에만 horizontal overflow, workspace 밀림 0 | Grid UX + Quality |
| `T-P8-074` | tab overflow | F-P8-09 8 탭, 800×600 | active tab 항상 노출, close/icon/text 겹침 0, grid 최소 치수 유지 | Grid UX + Quality |
| `T-P8-075` | keyboard/a11y | file tablist ArrowLeft/Right, Home/End | roving tabindex, focus 이동과 activation 정책 일관, viewport 밖 focus auto-scroll | Grid UX + Quality |
| `T-P8-076` | keyboard/a11y | Ctrl+Tab/Ctrl+Shift+Tab | 파일 탭 순환, grid의 Ctrl 기반 선택 키와 충돌 0 | Grid UX + Quality |
| `T-P8-077` | keyboard/a11y | 파일 탭 close button keyboard | accessible name에 파일명 포함, Enter/Space 한 번으로 닫고 예측 가능한 focus 복귀 | Grid UX + Quality |
| `T-P8-078` | interaction | 파일 탭 전환 후 cell context menu | 현재 파일 탭 selection만 대상, 이전 탭 TSV/메뉴 state 사용 0 | Grid UX |
| `T-P8-079` | error isolation | 비활성 탭 worker/page error | 해당 탭에 non-destructive indicator, 활성 grid를 error 화면으로 교체하지 않음 | Grid UX |
| `T-P8-080` | shutdown | 여러 파일 탭이 열린 창 종료 | 모든 session handle·worker·cache·copy task가 제한 시간 내 정리 | Platform + Rust Data |

## E. 회귀·성능·soak

| ID | 계층 | Fixture/입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-081` | regression | Phase 6 전체 selection/keyboard/TSV suite | 기존 Ctrl+C와 선택 계약의 알려진 회귀 0 | Grid UX + Quality |
| `T-P8-082` | regression | Phase 7 hostile/security/dependency suite | read-only/CSP/capability/privacy 계약 유지, high 위험 0 | Platform + Quality |
| `T-P8-083` | performance | 파일 탭 1개 대 10개에서 active grid 입력·scroll | p95 `<=50ms`, background tab 때문에 >100ms long task 발생 0 | Quality |
| `T-P8-084` | performance | 10 탭 전환 100회 | switch→correct paint p95 `<=100ms`, stale flash·blank grid 0 | Grid UX + Quality |
| `T-P8-085` | soak | 한 PID에서 open/switch/page/menu copy/close 100 cycle | crash·deadlock·wrong-tab·partial clipboard 0 | Quality + Rust Data + Grid UX |
| `T-P8-086` | soak | F-P8-04 CSV open→background scan→switch→close 100회 | late progress 0, worker/task 단조 증가 0 | Quality + Rust Data |
| `T-P8-087` | soak | 5 PID launch/open/copy/close를 20 cycle | 총 100 process invocation, orphan PID/window 0, shared resource 충돌 0 | Platform + Quality |
| `T-P8-088` | resource | soak 종료 후 30초 settle | 시작 대비 working set `+64 MiB`, handle `+10`, thread `+4` 이하 또는 Root 승인 상한 | Quality |
| `T-P8-089` | resource | 파일 탭 close 전후 snapshot | 닫힌 session·worker·page cache 0, 열린 탭 수에만 비례하고 파일 byte size에 비례하지 않음 | Rust Data + Quality |
| `T-P8-090` | failure recovery | soak 중 매 10회 hostile open/clipboard reject | typed error 뒤 다음 open/switch/copy 가능, shell blank/crash 0 | Quality |

## F. 1,000만 행 Parquet 카디널리티 매트릭스

`F-P8-12`와 `F-P8-13`은 일반 unit gate의 축소 fixture나 현재 Phase 7의 25만 행 gate/500만 행
release 설정으로 대체하지 않는다. 두 fixture는 cardinality를 제외한 논리 스키마, row-group,
compression 설정을 같게 유지한다. 로컬 생성 파일 자체는 저장소에 commit하지 않지만 seed,
generator revision, schema, row-group 수, byte size, uncompressed/compressed size로 계산한 압축률,
column encoding, SHA-256, 대표 page와 projection checksum을 `fixture-manifest.json`에 기록한다.
저카디널리티 생성 결과가 약 50MiB와 다르거나 고카디널리티 파일이 훨씬 커도 행·스키마·데이터
패턴이 맞으면 크기만으로 실패 처리하지 않는다.

| ID | 계층 | Fixture/입력 | 기대 결과 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-091` | fixture | F-P8-12/13 생성 직후 metadata scan | 각각 정확히 10,000,000행×10열·100개 이상 row group, cardinality 패턴·schema·SHA-256·대표 checksum 일치, byte size·압축률·encoding 기록 | Quality + Rust Data |
| `T-P8-092` | release performance | 별도 cold process에서 F-P8-12/13 각각 open→첫 200행 grid | fixture별 p95 `<=2.0s`, open 중 전체 row decode/materialize 0 | Quality + Rust Data |
| `T-P8-093` | Rust/native | 각 fixture에서 offset 0, 대표 row-group 경계 전후, 5,000,000, 9,999,800 조회 | 행 순서·값·null·정밀 타입 checksum 일치, 마지막 page는 정확히 200행 | Rust Data + Quality |
| `T-P8-094` | instrumentation | 각 fixture에서 3개 컬럼 projection으로 첫·중간·마지막 page 조회 | 요청 컬럼과 필요한 row group만 decode, 다른 컬럼·row group 전체 scan 0 | Rust Data |
| `T-P8-095` | performance | 각 fixture의 cold/warm 200행 page와 random page 30회 | fixture별 cold p95 `<=300ms`, warm p95 `<=100ms`, timeout·stale apply 0 | Rust Data + Quality |
| `T-P8-096` | memory | 각 fixture open, 30초 random scroll, GC/settle | fixture별 steady working set baseline 대비 `+256MiB` 이하, 파일 크기 비례 증가·전체 materialize 0 | Quality |
| `T-P8-097` | navigation | 각 fixture에서 첫→중간→마지막→임의 row group 100회 jump | 올바른 visible range와 checksum, cache key 교차 오염·blank/stale flash 0 | Grid UX + Quality |
| `T-P8-098` | selection/copy | 각 fixture의 마지막 두 page와 row-group 경계를 가로지르는 선택·복사 | bounded chunk read, TSV checksum 일치, hard limit과 cancel 계약 유지 | Grid UX + Rust Data |
| `T-P8-099` | multi-document | F-P8-12/13과 small 문서 6개를 열고 100회 전환 | 8개 일반 사용 latency·cache 예산 충족, 두 대행수 파일 때문에 다른 탭 worker/UI 정지 0 | Quality + Rust Data |

## G. Browser·geometry·screenshot 증거

| ID | 환경 | Fixture/상태 | 필수 결과와 증거 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-100` | Browser 1440×900 | F-P8-01+02, single/range context menu | 실제 pointer·keyboard interaction log, selection 좌표, menu rect, clipboard payload, screenshot | Quality |
| `T-P8-101` | Browser 1024×768 | 6 파일 탭, active switch, menu click-away | tab strip/grid/menu geometry, focus trace, overlap·clipping 0, screenshot | Quality |
| `T-P8-102` | Browser 800×600 | F-P8-09 8 탭 overflow, viewport 모서리 menu | active tab 노출, menu collision 처리, control text 잘림 0, screenshot | Quality |
| `T-P8-103` | Browser 3 viewport | keyboard menu·Escape·file-tab keyboard 이동 | 시작/입력/논리 selection/active tab/focus/종료 상태를 interaction 결과에 기록 | Quality |
| `T-P8-104` | Browser geometry | populated/loading/error/background worker | toolbar·file tablist·view tablist·grid·status/menu rect, scroll/client 크기 JSON | Quality |
| `T-P8-105` | Browser virtualization | F-P8-08 scroll/unmount/remount/menu | mounted logical range·DOM count·selection·menu anchor·outline 허용 오차 JSON | Quality |
| `T-P8-106` | Browser visual review | context menu, 2 tabs, 8-tab overflow, open error | focus·selection·active/inactive·error 상태가 색상 외 신호로 구분되고 layout shift 없음 | Quality |

필수 파일명은 `browser-desktop-context.png`, `browser-compact-tabs.png`, `browser-minimum-overflow.png`다. `geometry-results.json`에는 viewport, file tablist rect/scrollWidth/clientWidth, active tab rect, grid rect, menu rect, selected logical rect, mounted row/column/cell 수를 포함한다.

## H. 실제 Tauri·설치본 증거

| ID | 환경 | Fixture/입력 | 필수 결과와 증거 | 담당 |
| --- | --- | --- | --- | --- |
| `T-P8-110` | Tauri release | F-P8-01 cell 우클릭→복사 | native screenshot, 실제 clipboard hash, selection 좌표와 메뉴 action 로그 | Platform + Quality |
| `T-P8-111` | Tauri release | 100%/150% Windows scale, 모서리 메뉴 | menu/grid/tab clipping 0, 배율별 native screenshot | Platform + Quality |
| `T-P8-112` | Tauri release | 한 창 CSV+Parquet+8-tab overflow | 실제 WebView file tab 전환·close·keyboard 접근, native screenshot | Platform + Quality |
| `T-P8-113` | installer | clean install 후 exe 2회 실행 | 실제 PID/window manifest, process command line, usable 상태 screenshot | Platform + Quality |
| `T-P8-114` | installer association | 기존 앱 실행 중 CSV·Parquet 각각 더블클릭 | invocation마다 새 PID, 해당 argv 파일 탭 checksum, 기존 PID 불변 | Platform + Quality |
| `T-P8-115` | installer argv | F-P8-11 multi-path/Unicode/quote | 탭 수·순서·오류 격리 정확, command line 원문은 artifact에서 sanitize | Platform |
| `T-P8-116` | installer lifecycle | upgrade→launch 2개→uninstall→reinstall | association와 다중 실행 정책 유지, orphan process·stale mutex/registry 0 | Platform + Quality |
| `T-P8-117` | native soak | T-P8-085~090 release 설치본 반복 | process/resource raw JSON, crash·leak·stale apply 0 | Quality |

## 필수 artifact

```text
artifacts/phase-8/
  00-scope.md
  10-test-plan.md
  fixture-manifest.json
  context-menu-results.json
  multi-process-results.json
  multi-tab-results.json
  soak-results.json
  50-integration.md
  90-review.md
  ui/
    interaction-results.md
    geometry-results.json
    visual-review.md
    browser-desktop-context.png
    browser-compact-tabs.png
    browser-minimum-overflow.png
    native-context-100.png
    native-context-150.png
    native-multi-tabs.png
    native-smoke.md
```

## MVP 완료 조건

1. `T-P8-001`~`117` 중 플랫폼 비적용 항목을 제외한 모든 필수 테스트가 PASS하고 ID별 raw evidence가 존재한다.
2. 우클릭·`Shift+F10`·Context Menu 키로 연 메뉴에서 복사한 결과가 Phase 6의 Ctrl+C와 byte-for-byte 같고, Escape·click-away·viewport collision·가상화·clipboard 오류가 모두 검증된다.
3. release 설치본을 반복 실행했을 때 서로 다른 실제 PID와 창이 생성되고, 파일 연결 argv가 invocation별 새 PID에 정확히 귀속된다.
4. 한 창에서 CSV와 Parquet를 동시에 유지하며 open failure, close, active switch, page/selection/view 상태, background worker, stale response, cache가 파일 탭별로 격리된다.
5. 8개 일반 탭 UX, 32개 batch, 64/65개 방어 경계, 좁은 화면 overflow와 키보드 접근이 검증된다.
6. 100-cycle 단일 프로세스 탭 soak와 총 100 invocation 다중 프로세스 soak에 crash, orphan PID, wrong-tab update, partial clipboard write, handle/task/cache/memory 누수가 없다.
7. installer install·association·upgrade·uninstall·reinstall 후에도 다중 실행 및 다중 탭 계약이 유지된다.
8. frontend format/lint/typecheck/test/build와 Rust fmt/clippy/test, release Tauri/NSIS build가 모두 통과한다.
9. 실제 1,000만 행 저카디널리티와 고카디널리티 Parquet 각각의 first/boundary/middle/last
   page, projection, random jump, selection, 성능과 메모리 검증이 축소 fixture가 아닌 release
   fixture에서 PASS한다.

## PASS·FAIL·BLOCKED 판정

- `PASS`: 요구된 계층에서 테스트를 실제 실행했고 기대 결과와 raw evidence가 모두 일치한다.
- `FAIL`: 실행 결과가 기대와 다르거나 crash, wrong-tab/stale apply, data/TSV 오류, partial clipboard write, 자원 상한 초과가 발생한다. 하위 계층 PASS로 덮지 않는다.
- `BLOCKED`: Browser backend, visible native pointer/screenshot, clean installer 환경, 파일 연결 권한처럼 필수 환경이 없어 해당 검증을 실행하지 못했다. 환경, 시도한 명령, 관찰된 오류, 남은 위험을 `90-review.md`에 기록한다.
- 제품 코드와 자동 테스트가 모두 PASS여도 Browser 3 viewport, 실제 Tauri clipboard/context menu, 실제 다중 PID, 설치본 association 중 하나라도 미실행이면 Phase 8 최종 상태는 `BLOCKED`다.
- 여러 필수 항목 중 일부가 `FAIL`이면 환경 차단 여부와 관계없이 Phase 8은 `FAIL`이며, 실패가 해결된 뒤 독립 Quality 재검증을 수행한다.

## 확정 제품 결정

1. 선택 밖 셀 우클릭은 해당 셀을 단일 선택하고, 선택 안 우클릭은 기존 범위를 유지한다.
2. 컨텍스트 메뉴 MVP 액션은 네 가지이며 기존 copy/full-value 경로를 재사용한다.
3. 같은 canonical path 재open은 같은 프로세스에서 기존 탭을 활성화한다.
4. multi-select dialog, multi-drop, 여러 startup argv는 입력 순서로 탭을 만들고 부분 성공을 허용한다.
5. active 파일 탭 close 후 오른쪽 인접 탭, 없으면 왼쪽 탭을 활성화한다.
6. 파일 탭별 Data/Schema/Metadata, page/scroll, column 설정, selection, loading/error 상태를 보존한다.
7. 8개는 일반 사용 검증 기준, 64개는 문서 방어 상한, 32개는 batch 상한이며 동시 open과
   CSV worker는 각각 4개로 제한한다.
8. `Ctrl+Tab`/`Ctrl+Shift+Tab`은 파일 탭 전환, `Ctrl+W`는 활성 파일 탭 닫기로 사용한다.
