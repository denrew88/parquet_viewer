# Phase 8 플랫폼·데이터 수명주기 설계

- 작성일: 2026-07-14
- 담당: Tauri Platform 설계
- 상태: 설계 확정, 구현 대기
- 범위: 다중 프로세스 실행, 한 프로세스의 다중 문서 탭, 문서별 source·worker·cache·취소 수명주기
- 제외: 탭과 컨텍스트 메뉴의 시각 디자인, 선택 reducer 세부 구현, 실제 코드 변경

## 1. 현재 구조와 변경 이유

현재 `AppState`는 `Mutex<SessionSlot<DataSource>>` 하나만 소유한다. 새 파일을 열면
`SessionSlot::replace`가 이전 source, CSV worker, checkpoint, page cache와 handle을 모두
해제한다. `OpenCoordinator`는 전역 `last-started-wins` ticket으로 동시에 시작된 열기 중
하나만 commit한다. 이 계약은 한 번에 파일 하나만 표시할 때는 안전하지만 여러 탭을 동시에
유지할 수 없다.

`tauri-plugin-single-instance`는 두 번째 프로세스의 argv를 첫 프로세스로 전달한 뒤 두 번째
프로세스를 종료한다. 따라서 현재 Phase 4·7의 single-instance 계약은 “프로그램을 여러 개
동시에 실행” 요구사항과 직접 충돌한다.

Phase 8에서는 다음 두 경계를 독립적으로 바꾼다.

1. OS에서 시작한 각 실행은 독립 프로세스와 독립 `AppState`를 가진다.
2. 한 프로세스의 `AppState`는 여러 `Document`를 동시에 소유한다.

프로세스끼리 registry, cache, worker, 활성 탭을 공유하지 않는다. 같은 파일을 서로 다른
프로세스에서 여는 것은 허용하며 각각 독립적인 read-only handle과 session을 가진다. 같은
프로세스에서는 정규화한 경로가 이미 열려 있으면 중복 탭을 만들지 않고 기존 탭을 활성화한다.

## 2. 다중 프로세스 정책

### 2.1 single-instance 제거

- `src-tauri/src/lib.rs`에서 `tauri_plugin_single_instance::init` 등록을 제거한다.
- `src-tauri/Cargo.toml`에서 `tauri-plugin-single-instance` 의존성을 제거하고 lockfile을
  갱신한다. 단순 feature flag 비활성화보다 완전 제거가 권장된다. 배포 설정이나 향후
  refactor에서 singleton이 우발적으로 다시 활성화되는 것을 막기 위해서다.
- 두 번째 프로세스를 첫 창으로 전달하고 기존 창을 show/unminimize/focus하는 callback도
  제거한다.
- Tauri의 앱 identifier와 NSIS product identifier는 설치·association 식별자일 뿐 실행 중인
  프로세스를 하나로 제한하지 않으므로 유지한다.

### 2.2 실행·파일 연결 계약

- 시작 메뉴, 바로가기, executable 직접 실행은 매번 새 빈 프로세스를 만든다.
- Windows CSV·Parquet file association은 현재처럼 executable에 파일 경로를 argv operand로
  전달한다. plugin이 없으므로 더블클릭마다 새 프로세스가 생성되고 그 프로세스가 전달받은
  파일을 연다.
- 한 실행의 argv에 여러 경로가 전달되면 그 프로세스 안에서 입력 순서대로 여러 탭을 연다.
- Windows Explorer가 여러 파일 선택 실행을 파일별 process로 나누는 경우에는 OS 동작을
  억지로 합치지 않는다. 같은 창의 여러 탭으로 열려면 앱의 파일 대화상자 또는 drag and
  drop을 사용한다.
- `startup_request`와 `PendingOpenQueue`는 frontend listener 준비 전 cold-start argv를
  보존하기 위해 유지한다. `second-instance` callback과 event producer는 제거한다.
- cold argv만으로 일반 CLI 실행과 file association 실행을 신뢰성 있게 구분할 수 없으므로
  origin은 기존과 같이 `startupArg`로 기록한다. 설치본 native test에서 association 진입을
  별도 판정한다.
- `OpenOrigin::SecondInstance`는 frontend와 fixture를 함께 migration한 뒤 제거한다. 한 릴리스
  동안 호환이 필요하면 deserialize만 허용하는 deprecated 값으로 남길 수 있지만 새 요청은
  절대 생성하지 않는다.

### 2.3 다중 프로세스 완료 기준

- executable을 연속 두 번 실행했을 때 서로 다른 PID와 두 개의 독립 창이 5초 이상 유지된다.
- A 프로세스에서 CSV, B 프로세스에서 Parquet를 열고 페이지 이동·CSV header 변경·닫기를
  수행해도 상대 프로세스의 문서가 변하지 않는다.
- 설치본에서 CSV와 Parquet를 각각 더블클릭했을 때 두 PID가 유지되고 각 창의 summary가
  해당 파일과 일치한다.
- 기존 Phase 7의 “두 번째 process가 종료되고 첫 PID만 유지” 테스트는 제거하고 위 계약으로
  대체한다.

### 2.4 개발 서버와 port 계약

- release와 installer 실행 파일은 frontend asset을 bundle하므로 HTTP server나 TCP port를
  사용하지 않는다. Tauri command도 각 process 내부 IPC이며 process별 port 할당이 필요 없다.
- 개발 모드에서는 Vite server 하나만 `localhost:1420`에 실행한다. `tauri dev`가 만든 여러
  debug 앱 process는 같은 Vite/HMR server를 공유한다.
- `strictPort`가 활성화되어 있으므로 `tauri dev`를 여러 번 실행해 server를 중복 기동하지
  않는다. multi-instance 개발 harness는 server readiness를 확인한 뒤 debug executable만
  추가 실행한다.
- 다중 process 완료 판정은 Vite가 없는 release/installer에서 수행한다. 1420을 다른 process가
  점유한 상태에서도 release 앱이 정상 실행되어야 한다.

## 3. 식별자 계약

`documentId`와 `sessionId`는 같은 값으로 합치지 않는다.

- `documentId`: 탭 하나의 논리적 수명 식별자다. open 예약 시 backend가 발급하며 탭을 닫을
  때까지 바뀌지 않는다.
- `sessionId`: 그 문서가 현재 소유한 source generation 식별자다. 최초 open 성공 시 발급하고,
  CSV header mode 변경처럼 source와 worker를 원자적으로 교체하면 새 값을 발급한다.
- 두 ID는 process-local opaque string이다. frontend가 형식을 해석하거나 다음 값을 예측하지
  않는다. 구현은 각각 monotonic counter와 process nonce를 조합해 재시작·다중 process 로그의
  혼동을 막는다.
- 같은 canonical path를 같은 프로세스에서 다시 열면 새 ID를 발급하지 않고 기존
  `documentId`와 현재 `sessionId`를 반환하며 해당 탭을 활성화하라는 disposition을 함께
  반환한다. 서로 다른 프로세스의 ID와 source는 공유하지 않는다.
- 모든 데이터 명령은 두 ID를 함께 받는다. `documentId`가 없으면 `DocumentNotFound`, 문서는
  있지만 `sessionId`가 현재 generation과 다르면 `StaleSession`을 반환한다.
- frontend의 page request generation은 계속 유지한다. backend의 session 검사는 닫기·재구성
  race를 방어하고 frontend generation은 같은 session 안의 느린 페이지 응답을 방어한다.

## 4. AppState와 DocumentRegistry

권장 구조는 다음과 같다.

```text
AppState
├─ documents: Mutex<DocumentRegistry>
├─ open_requests: OpenRequestRegistry
├─ pending_opens: PendingOpenQueue
└─ next_request/document/session counters

DocumentRegistry
├─ entries: HashMap<DocumentId, Arc<DocumentHandle>>
├─ access_order: VecDeque<DocumentId>
├─ reserved_slots
└─ aggregate_cache_budget

DocumentHandle
├─ lifecycle: Atomic(Open | Closing)
├─ session: Mutex<DocumentSession>
└─ in_flight/cancellation state

DocumentSession
├─ session_id
├─ source: DataSource
├─ page_cache
├─ operation_generation
└─ last_access/resource accounting
```

registry lock은 ID 조회, slot 예약, insert/remove, LRU accounting에만 짧게 사용한다. 파일 open,
Parquet decode, CSV page scan, worker join을 registry lock을 잡은 채 수행해서는 안 된다. 명령은
`Arc<DocumentHandle>`을 clone한 뒤 registry lock을 놓고 해당 문서 lock만 사용한다. 따라서 A
탭의 느린 CSV 작업이 B 탭의 page read·close·status를 막지 않는다.

현재 `SessionSlot<T>`의 page cache 동작은 `DocumentSession<T>` 안으로 옮긴다. 직접
`HashMap<DocumentId, SessionSlot<T>>`를 전역 mutex 아래 두는 방식은 I/O 동안 전체 map을
잠글 위험이 있으므로 사용하지 않는다.

### 4.1 LRU와 자원 상한

초기 상한은 측정 가능한 상수로 고정한다.

| 자원 | 초기 상한 | 초과 동작 |
| --- | ---: | --- |
| 열린 문서 | process당 64 | 65번째에 `TooManyOpenDocuments`, 기존 탭 유지 |
| 한 open batch의 경로 | 32 | 파일을 읽기 전에 `InvalidRequest` |
| 문서별 page cache | 8 pages | 해당 문서 LRU page 제거 |
| process 전체 page cache | 64 pages 또는 추정 256 MiB 중 먼저 도달 | 전체 document LRU에서 page 제거 |
| 동시 source prepare | 4 | 나머지 open item은 bounded queue에서 대기 |
| 동시 CSV index worker | 4 | worker permit을 얻을 때까지 queued 상태 |
| 완료 request ID 기록 | 256 | 오래된 dedupe 항목 LRU 제거 |

열려 있는 탭 자체를 LRU로 몰래 닫지 않는다. `access_order`는 aggregate page cache 회수 순서와
상한 도달 시 UI에 제시할 “가장 오래 사용하지 않은 탭” 정보에만 사용한다. 회수 가능한 cache가
없고 문서 상한에 도달하면 새 open을 거부하고 사용자가 탭을 닫도록 안내한다.

cache byte는 `DataPage`의 문자열·binary preview·row/column vector heap 사용량을 보수적으로
계산한다. 정확한 allocator 값이 아니어도 항상 실제보다 작지 않은 추정 규칙을 테스트로
고정한다. 파일 크기만으로 cache budget을 계산하지 않는다.

## 5. 문서별 worker·cache·close·cancel

### 5.1 페이지와 상태

- page cache key는 현재의 offset, limit, projection 순서를 유지하되 document session에 귀속한다.
- 다른 document의 같은 page key는 절대 cache hit가 아니다.
- `read_page`, `get_data_file_status`, `configure_csv`, selection copy의 backend read는 모두
  `{documentId, sessionId}`를 검증한다.
- 탭을 activate하거나 성공적으로 읽으면 document access order를 touch한다. 단순 hover는
  touch하지 않는다.

### 5.2 CSV worker

- 각 CSV generation은 자신의 cancel token, index state, worker handle을 가진다.
- CSV header 재설정은 같은 `documentId`에서 candidate source를 먼저 준비하고 성공한 경우에만
  새 `sessionId`로 교체한다. 실패하면 기존 session과 cache·worker를 유지한다.
- 교체 commit 후 이전 worker에 cancel을 설정하고 registry lock 밖에서 join한다.
- worker completion/progress는 document와 session generation이 모두 일치할 때만 적용한다.
- 동시 CSV worker 상한을 위해 process-local permit을 사용한다. queued worker도 cancel 가능해야
  하며 닫힌 탭은 permit을 얻은 뒤 작업을 시작하면 안 된다.

### 5.3 close

`close_document({documentId, sessionId})`는 다음 순서를 따른다.

1. registry에서 document와 expected session을 확인한다.
2. lifecycle을 `Closing`으로 원자 변경하고 map에서 제거한다. 같은 close의 재호출은 idempotent
   success로 처리할 수 있으나 알려지지 않은 ID와는 구분한다.
3. open/page/copy/index cancellation token을 설정한다.
4. registry lock을 놓는다.
5. 남은 `Arc`가 해제될 때 source handle, cache, checkpoint, worker가 정확히 한 번 drop된다.
   CSV worker join처럼 기다릴 수 있는 정리는 UI thread 밖에서 수행한다.

close 전에 handle을 clone한 page read가 이미 시작됐다면 OS read 자체를 항상 즉시 중단할 수는
없다. 작업 종료 후 lifecycle/session을 다시 확인해 결과를 폐기하고 `DocumentClosed`를 반환한다.
닫힌 탭의 결과나 오류를 다른 탭에 적용하지 않는다.

### 5.4 취소 범위

- open 취소: `requestId`와 선택적 `documentId` 예약에 적용한다. 아직 commit되지 않은 candidate만
  폐기한다.
- CSV index 취소: `{documentId, sessionId, generation}`에만 적용한다.
- selection copy 취소: `{documentId, sessionId, operationId}`에만 적용한다.
- 탭 close: 그 document의 모든 작업을 취소하지만 다른 document 작업은 유지한다.
- 앱 process 종료: 모든 document를 `Closing`으로 표시한 뒤 bounded shutdown을 수행한다. 각
  worker는 cooperative cancel을 받아야 하며 무기한 join하지 않는다.

## 6. 여러 파일 열기와 경쟁 계약

전역 `OpenCoordinator::last-started-wins`는 제거한다. 서로 다른 파일을 여는 요청은 모두 탭으로
commit할 수 있어야 하므로 전역 최신 ticket 하나가 이전 요청을 stale로 만드는 것은 잘못이다.

### 6.1 batch 규칙

- `open_data_paths`는 1~32개 경로를 받는다. 빈 목록과 32개 초과는 파일 I/O 전에 거부한다.
- 요청 시작 시 canonical path 중복을 먼저 찾고, 새 문서 item은 입력 순서대로 현재 열린 수와
  다른 request의 reservation을 합쳐 slot을 원자적으로 예약한다. 남은 slot을 넘는 item은
  item별 `TooManyOpenDocuments` 실패가 되며 앞에서 예약된 item과 기존 탭은 유지한다.
- 각 item은 독립적으로 format 검증, source open, summary, initial page 준비를 수행한다. 준비는
  최대 4개까지 병렬화할 수 있지만 응답과 탭 삽입 순서는 입력 순서를 유지한다.
- 지원 파일 성공과 손상 파일 실패가 섞이면 성공 item만 새 문서로 commit하고 실패 item은
  typed error로 반환한다. 이미 열려 있던 문서는 항상 유지한다.
- batch의 기본 활성 탭은 입력 순서상 첫 성공 또는 기존 탭 재사용 item이다. 성공이 하나도
  없으면 기존 활성 탭을 유지한다.
- 같은 경로가 batch에 두 번 들어오면 첫 item만 열고 이후 item은 같은 기존 탭을 가리키는
  `existing` disposition을 반환한다.
- request 취소 시 아직 commit되지 않은 item은 취소한다. 이미 commit된 item을 rollback해서
  사용자가 본 탭을 갑자기 닫지 않는다.

### 6.2 동시 요청

- `requestId`는 process 안에서 unique해야 한다. 같은 ID의 재전달은 두 번 열지 않고 기존
  완료 결과를 돌려주거나 `DuplicateOpenRequest`를 반환한다. 어느 정책을 택하든 256-entry
  bounded dedupe test로 고정한다.
- 서로 다른 request는 reservation으로 상한을 지키고 각 성공 문서를 독립 commit한다.
- commit 순서는 `(request sequence, item index)`로 결정해 준비 완료 속도가 탭 순서를 바꾸지
  않게 한다. frontend가 먼저 loading tab을 만든 경우에는 `clientTabId`로 정확히 결합한다.
- close와 page/status가 경쟁하면 lifecycle/session 검사로 close가 선형화 지점이다. close 이후
  시작된 작업은 즉시 실패하고, close 이전 작업은 결과 적용 전에 재검사한다.
- CSV configure가 page read와 경쟁하면 configure commit의 새 `sessionId`가 선형화 지점이다.
  이전 session page 결과는 `StaleSession`으로 폐기한다.
- 한 탭의 open·read 실패는 다른 탭의 active state, cache, selection, 오류 배너를 변경하지 않는다.

## 7. 제안 IPC·DTO

새 이름으로 계약을 명확히 하되 한 Phase 동안 기존 단일 파일 command를 adapter로 유지할 수
있다.

```text
OpenDataFilesRequest {
  requestId: string,
  origin: dialog | dragDrop | startupArg | fileAssociation,
  items: [{ clientTabId: string, path: string }]
}

OpenDataFilesResponse {
  requestId: string,
  opened: [{
    itemIndex: number,
    clientTabId: string,
    documentId: string,
    sessionId: string,
    summary: FileSummary,
    initialPage: DataPage,
    disposition: opened | existing
  }],
  failures: [{
    itemIndex: number,
    clientTabId: string,
    fileName: string,
    error: DataError
  }],
  activeDocumentId: string | null
}

DocumentSessionRef { documentId: string, sessionId: string }
ReadPageRequest { documentId, sessionId, offset, limit, columns }
CloseDocumentRequest { documentId, sessionId }
ConfigureCsvRequest { documentId, sessionId, headerMode }
CancelDataFileTaskRequest { documentId, sessionId, generation }
```

추가 command 제안:

- `open_data_files(request) -> OpenDataFilesResponse`
- `select_data_files(requestId) -> OpenDataFilesResponse | null`: native dialog multi-select 활성화
- `list_open_documents() -> DocumentDescriptor[]`: frontend reload/recovery와 진단용
- `close_document(request) -> CloseDocumentResponse`
- `cancel_open_request(requestId, clientTabId?)`
- `touch_document(DocumentSessionRef)`: tab activate 시 backend LRU 갱신; 데이터 변경 없음

`open_data_file`, `select_data_file`, sessionId-only `read_page`, `close_data_file`는 내부 adapter로
한 migration 동안 유지한다. 새 frontend가 모두 `{documentId, sessionId}`를 사용한 뒤 제거한다.
adapter가 여러 문서 중 임의의 문서를 추측해서는 안 된다.

추가 typed error:

- `TooManyOpenDocuments { limit, open, reserved }`
- `DocumentNotFound`
- `DocumentClosed`
- `StaleSession`
- `DuplicateOpenRequest`
- `OpenRequestCancelled`

기존 `MultipleFilesNotSupported`는 새 batch API에서 사용하지 않으며 legacy adapter에만 남겼다가
제거한다. `StaleOpenRequest`의 전역 latest 의미도 제거하고 session/operation 단위 오류로
대체한다.

## 8. 마이그레이션 순서

1. Phase 8 scope와 Quality test ID를 확정한다. 기존 Phase 4·7 single-instance 기대값을
   다중 process 기대값으로 명시적으로 폐기한다.
2. `DocumentId`, `SessionId`, 새 error와 batch DTO를 추가한다. frontend와 Rust parser fixture를
   먼저 고정한다.
3. `DocumentRegistry`와 문서별 lock/cache를 구현하고 `SessionSlot` unit test를 다중 document,
   독립 cache, 상한, 정확히 한 번 drop 테스트로 이관한다.
4. 기존 단일 파일 command를 registry 기반 adapter로 바꿔 회귀를 유지한다. 이 시점에는 UI가
   아직 한 탭이어도 데이터 계층은 여러 문서를 보존해야 한다.
5. 전역 `OpenCoordinator`를 request registry·slot reservation으로 교체하고 multi-path partial
   success, deterministic order, cancel race를 구현한다.
6. CSV worker permit, document close, session generation 교체를 통합한다. registry lock을 잡은
   I/O가 없는지 clippy 외 별도 concurrency test로 확인한다.
7. frontend tab store와 모든 command를 `{documentId, sessionId}`로 전환한다. 탭별 selection,
   page generation, loading/error/context menu state를 격리한다.
8. startup argv와 dialog/drop을 batch API에 연결한 뒤 single-instance plugin과
   `SecondInstance` producer를 제거한다.
9. release·installer에서 다중 PID, file association, 여러 탭, close/cancel/soak를 검증하고
   README와 Phase 7 회귀 문서를 갱신한다.
10. legacy command와 sessionId-only adapter는 사용처가 0이고 native 회귀가 통과한 뒤 제거한다.

## 9. 필수 테스트 제안

- registry: 8개 일반 사용, 64개 open, 65번째 거부, close 후 slot 재사용, 중복 path 기존 ID 재사용
- cache: 탭별 key 격리, per-document LRU, aggregate page/byte LRU, 열린 document 비퇴출
- concurrency: A slow open + B fast open 모두 commit, 입력 순서 보존, reservation 초과 없음
- batch: all success, partial corrupt/unsupported, all failure, cancel 중 일부 commit
- lifecycle: read/configure/copy 중 close, close 정확히 한 번 drop, late result 폐기
- CSV: 탭별 worker·generation·cancel 격리, worker 4개 상한, queued close
- session: configure 후 documentId 유지·sessionId 변경·구 session 요청 거부
- process: release exe 2~4개 PID/창 유지, 각기 다른 파일과 동일 파일 동시 open
- port: Vite 하나를 공유하는 debug multi-instance와 1420 점유에 영향받지 않는 release 실행
- association: 실행 중인 앱 유무와 관계없이 새 process 생성, Unicode·공백 경로 보존
- soak: process 하나에서 8탭 open/read/close 100회와 4 process 병렬 20회, handle/thread/cache
  baseline 회복
- large-row-count Parquet: 같은 스키마의 실제 10,000,000행×10열 저카디널리티와
  고카디널리티 fixture 각각의 metadata-only open, row-group 경계·중간·마지막
  page, projection, random jump, steady memory 검증
- regression: dialog/drop/startup argv, 페이지, CSV status, selection copy와 컨텍스트 메뉴 copy가
  항상 올바른 document/session만 참조

## 10. 주요 위험과 대응

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| 전역 registry mutex에서 decode/join 수행 | 모든 탭 멈춤, deadlock | Arc document handle과 문서별 lock, lock-order test |
| 탭 수만큼 CSV worker 생성 | thread·I/O 폭증 | worker permit 4, queued cancel |
| 문서별 cache가 열린 탭 수에 따라 증가 | 64탭에서 메모리 급증 | aggregate 64-page/256 MiB LRU 추가 |
| close 이후 늦은 응답 적용 | 닫힌 탭 재생성·다른 탭 오염 | lifecycle + document/session + frontend generation 재검사 |
| 전역 last-started-wins 잔존 | 먼저 연 탭이 사라짐 | coordinator 제거, request/item 독립 commit test |
| partial batch 오류 UX 불명확 | 일부 성공 사실 누락 | opened/failures 동시 response, item별 상태 표시 |
| plugin만 callback 제거하고 의존성 잔존 | singleton 재발·불필요 binary | Cargo 의존성까지 제거, PID native gate |
| OS가 multi-select association을 여러 process로 분리 | 예상과 다른 탭 묶음 | OS 정책을 허용하고 앱 내 dialog/drop batch를 공식 경로로 명시 |
| 같은 파일을 여러 handle로 open | 파일 잠금·자원 증가 | read-only, 명시 상한, 독립 탭 정책 문서화 |
| process 종료 시 worker join 지연 | 창 종료 hang | cooperative cancel, bounded shutdown, soak 측정 |

## 11. 확정 결정과 구현 시 측정 항목

- 열린 문서는 프로세스당 64개, 한 batch는 32개, 동시 source prepare와 CSV worker는 각각
  4개, cache는 문서당
  8 pages와 전체 64 pages 또는 추정 256 MiB 중 먼저 도달하는 상한을 사용한다.
- batch partial success를 허용하고 입력 순서상 첫 성공 또는 재사용 탭을 활성화한다.
- 동일 canonical path는 같은 프로세스에서 기존 탭을 활성화하고, 다른 프로세스에서는 독립
  session으로 연다.
- legacy IPC adapter는 Phase 8 통합 중에만 유지하고 새 frontend 전환과 회귀 테스트 후 제거한다.
- worker shutdown timeout의 정확한 값은 8A 구현 시 benchmark로 정하고 테스트에 고정한다.

공통 DTO, error, manifest, `lib.rs`는 단일 소유자가 순차 통합한다.
