# Phase 9 source와 query engine 설계

- 상태: engine-neutral 계약 확정, 구현체는 9D spike 후 결정
- 제품 계약: `00-scope.md`
- 테스트 계약: `10-test-plan.md`
- 신규 native/runtime dependency: 사용자 승인 gate

## 1. 설계 목표

1. CSV와 Parquet의 기존 page/metadata 동작을 유지하면서 포맷 분기를 registry 뒤로 이동한다.
2. 새 tabular handler가 문서, query, grid 핵심 코드 변경 없이 참여하게 한다.
3. CSV raw text와 parsing profile의 typed/invalid 상태를 함께 보존한다.
4. filter/search/sort를 전체 source/result에 적용하고 bounded memory/disk로 page를 제공한다.
5. document/session/query/task generation으로 늦은 결과를 폐기한다.
6. 정상 종료, 취소, 오류와 crash 뒤 temporary data를 안전하게 정리한다.

## 2. Module 경계

목표 디렉터리는 구현 중 기존 구조와 충돌하지 않는 범위에서 다음 책임을 갖는다.

```text
src-tauri/src/
  data/
    source.rs             TabularSource, SourceCapabilities
    registry.rs           FormatRegistry, FormatHandler
    csv/                  CSV handler, raw source, profile transform
    parquet/              Parquet handler
    value_format.rs       공통 DataValue 표현
  query/
    model.rs              QueryPlan, expression, sort, ids
    engine.rs             QueryEngine adapter
    result.rs             result page/index lifecycle
    resource.rs           worker, memory, spill reservation
  storage/
    settings.rs           atomic persistent settings
    query_temp.rs         temp layout, owner lock, janitor
  commands/               얇은 validation/dispatch
  domain/                 IPC DTO와 typed error

src/
  formats/                descriptor store, metadata renderer registry
  copy/                   preset, serializer, settings UI
  csv-profile/            editor state, bulk reducer, preview UI
  query/                  plan reducer, filter/search/sort UI
```

실제 파일 이동은 9A에서 순차적으로 수행한다. 큰 `mod.rs` 교체와 공통 DTO는 루트 또는 지정된 단일
소유자만 편집한다.

## 3. Format registry

### 3.1 Descriptor와 capabilities

```rust
struct FormatDescriptor {
    id: FormatId,
    display_name: &'static str,
    extensions: &'static [&'static str],
    mime_types: &'static [&'static str],
    capabilities: SourceCapabilities,
}

bitflags SourceCapabilities {
    TYPED_SCHEMA;
    COLUMN_PROJECTION;
    FILTER_PUSHDOWN;
    ROW_GROUPS;
    PARSING_PROFILE;
    BACKGROUND_ROW_COUNT;
    MULTIPLE_DATASETS;
    QUERY_PROVIDER;
}
```

capability 표현은 `bitflags` dependency를 반드시 요구하지 않는다. serde가 안정적인 이름 목록을
반환하는 자체 type도 가능하다. frontend는 알 수 없는 capability를 무시하고 공통 UI를 유지한다.

### 3.2 Handler와 source

```rust
trait FormatHandler: Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;
    fn open(&self, path: &Path, context: OpenContext)
        -> Result<Box<dyn TabularSource>, DataError>;
}

trait TabularSource: Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;
    fn summary(&self) -> Result<SourceSummary, DataError>;
    fn read_page(&self, request: SourcePageRequest) -> Result<DataPage, DataError>;
    fn cancel_task(&self, task: TaskId) -> Result<(), DataError>;
    fn query_provider(&self) -> Option<Arc<dyn QueryProvider>>;
}
```

signature는 설계 의도를 나타내며 async/blocking boundary와 lifetime은 spike 전에 확정한다. 중요한
조건은 `DocumentRegistry`가 구체적인 CSV/Parquet enum variant를 match하지 않는 것이다.

`FormatRegistry`는 정적 handler 목록을 compile-time에 등록하고 extension으로 후보를 찾은 뒤 handler가
내용을 검증한다. unknown extension, mismatch와 corrupt 형식을 별도 typed error로 반환한다. CSV처럼
magic이 없는 형식은 parser 구조와 encoding 검증을 사용한다.

### 3.3 Metadata DTO

`FileSummary`의 공통 field는 유지한다.

- file name/path/size
- format descriptor id/display name/capabilities
- row count와 progress
- column schema

포맷별 정보는 새 nullable root field를 계속 추가하지 않는다.

```text
FormatDetails
  sections[]
    id, title, kind
    keyValue[] | table(columns, bounded rows, truncated)
```

CSV profile처럼 편집 동작이 있는 metadata는 dedicated typed DTO/service를 사용하고, generic details는
read-only display에 한정한다. Parquet row groups는 bounded table section으로 이전할 수 있으며 전용
renderer가 있으면 같은 section id를 더 풍부하게 표시한다.

### 3.4 Runtime supported-format 목록

`list_supported_formats` command가 descriptor 목록을 반환한다. native dialog는 같은 Rust registry에서
filter를 구성한다. drop은 frontend에서 extension을 최종 거부하지 않고 안내만 표시한 뒤 backend
registry가 authoritative validation을 한다.

Tauri `fileAssociations`는 build-time 정적 설정이므로 registry와 자동 동기화된다고 가정하지 않는다.
association을 추가할 때 별도 manifest test로 descriptor와 config 차이를 보고한다.

## 4. Settings 저장

전역 설정은 Tauri path resolver의 app config directory 아래 `settings.json`에 저장한다. exe 옆이나
현재 working directory를 사용하지 않는다.

```text
SettingsV1
  schemaVersion
  copyPreset
  copyCustomOptions
  csvDefaultParsingMode
  queryTempLimitBytes
```

- 읽을 때 schema와 범위를 검증한다.
- 쓸 때 같은 directory의 temp file에 serialize/fsync한 뒤 atomic rename한다.
- 손상 파일은 삭제하지 않고 `.invalid-<timestamp>`로 보존한 뒤 기본값과 경고를 사용한다.
- 여러 process가 동시에 설정을 바꿀 수 있으므로 마지막 atomic write가 다음 실행의 값이 된다.
  실행 중 다른 process 설정 hot-reload는 하지 않는다.
- document profile, filter, sort, search와 query result는 설정 파일에 저장하지 않는다.

## 5. CSV parsing model

### 5.1 Profile

```text
CsvParsingProfile
  mode: Auto | AllText | Custom
  columns[]
    sourceIndex, sourceName
    targetType
    trim
    nullTokens[]
    numberFormat
    temporalFormats[]
    timezonePolicy
    failurePolicy
```

profile column은 이름만으로 식별하지 않고 source index와 resolved name을 함께 검증한다. duplicate/blank
header resolution 뒤에도 원본 index가 안정적인 기준이다.

### 5.2 Raw, typed, null과 invalid

원본 CSV byte/text를 덮어쓰지 않는다. 변환 결과는 다음 네 상태를 구분한다.

- valid typed value
- source null
- empty string
- invalid conversion with raw display and error code

query engine이 invalid bitmap을 직접 지원하지 않으면 내부 provider는 typed nullable column과 hidden
`__dv_invalid_<columnId>` bitmap을 함께 만든다. `is null`은 source-null bitmap, `is invalid`는 invalid
bitmap을 사용한다. 일반 typed 비교는 invalid에서 false다. UI page DTO는 raw display와 invalid 상태를
전달할 수 있도록 `DataValue` 또는 cell diagnostic을 확장한다.

### 5.3 Inference와 sample

- 최대 1,000행, 최대 sample byte budget을 동시에 적용한다.
- 파일 앞부분과 checkpoint/index를 이용한 분산 sample을 결합한다.
- 모든 sample 작업은 generation과 cancellation token을 갖는다.
- candidate별 success ratio, ambiguity와 overflow를 측정한다.
- 앞자리 0, 정밀도 초과 integer, 서로 다른 timezone/date 형식은 Text 우선 또는 낮은 confidence다.
- Auto는 추천 profile을 생성하지만 원본 raw source를 계속 보존한다.

### 5.4 Preview, validation과 apply

preview는 immutable profile snapshot과 sample snapshot으로 실행한다. 200ms debounce는 frontend 책임이고
backend는 generation을 검증한다. 전체 validation은 source를 scan하되 bounded per-column error counter와
최대 20개 대표 오류만 보존한다.

apply는 prepare/commit 두 단계다.

1. 현재 document/session 확인
2. 새 profile source/provider prepare
3. 구조 오류와 resource 확인
4. registry write lock에서 새 session을 atomic commit
5. 이전 query/result/cache cancel/drop
6. 새 summary 반환

prepare 실패 시 기존 session은 그대로다. commit 뒤 도착한 이전 task 결과는 sessionId로 폐기한다.

## 6. Query model

### 6.1 ID와 세대

```text
DocumentId  tab의 수명
SessionId   source/profile generation
QueryId     committed QueryPlan generation
TaskId      preview/validation/execute/distinct/copy 작업
```

모든 request/response는 필요한 상위 ID를 포함한다. query page는 documentId, sessionId, queryId가 모두
현재 registry entry와 일치해야 한다. TaskId만으로 document identity를 추론하지 않는다.

### 6.2 QueryPlan

```text
QueryPlan
  filters[]
    columnId, typed operator, typed literal(s)
  search
    mode: none | find | filter
    text, caseSensitive, exact, targetColumnIds[]
  sort[]
    columnId, direction, nullsLast=true, priority
  projection[]
```

literal parsing과 operator/type 검증은 backend에서 다시 수행한다. frontend 검증은 사용자 feedback용이며
보안 경계가 아니다. filter는 column 간 AND, 같은 column의 value set은 OR다. regex는 schema에 없다.

sort는 마지막 tie-breaker로 stable source row identity를 자동 추가한다. 이 key는 UI에 노출하지 않는다.
query 결과의 표시 row offset과 source row identity를 분리한다.

### 6.3 QueryResult

QueryResult는 전체 row를 UI DTO로 materialize하지 않는다. 구현체에 따라 다음 중 하나를 사용한다.

- engine의 spill 가능한 execution/result handle
- source row identity를 chunked/bounded index로 저장한 result
- 이미 정렬된 temporary columnar result

공통 API는 result count 상태, progress, projected page, cancel과 drop이다. page cache key에는 sessionId,
queryId, offset, limit, projection을 모두 포함한다.

## 7. Query engine adapter와 spike

```rust
trait QueryEngine: Send + Sync {
    fn prepare_source(&self, source: Arc<dyn QueryProvider>) -> Result<EngineSource, QueryError>;
    fn execute(&self, source: EngineSource, plan: QueryPlan, budget: QueryBudget)
        -> Result<Box<dyn QueryResult>, QueryError>;
}
```

후보는 DataFusion, DuckDB embedded와 기존 Arrow 위 직접 구현이다. product query code는 adapter 밖에서
후보별 SQL 문자열이나 expression type을 사용하지 않는다.

### 선택 순서

1. 동일 logical fixture와 expected checksum 고정
2. 각 후보를 별도 spike branch/module에서 release build
3. correctness와 lifecycle test 실행
4. memory/spill/cancel/performance/package 측정
5. `engine-spike.md`에 비교표와 추천 기록
6. native/runtime dependency가 필요하면 사용자 승인
7. 한 adapter만 product path에 연결하고 spike-only code 제거

정확성, cancel/drop과 disk 상한을 만족하지 않는 후보는 속도가 빨라도 제외한다. DuckDB를 선택해도
persistent database 파일은 만들지 않고 direct scan/in-memory connection과 bounded temp directory를
사용한다. DataFusion을 선택하면 DiskManager와 runtime memory pool을 명시적으로 설정한다.

## 8. IPC 계약

command 이름은 구현 중 naming convention에 맞출 수 있지만 책임은 다음처럼 분리한다.

| Command | 핵심 입력 | 결과 |
| --- | --- | --- |
| `list_supported_formats` | 없음 | descriptor[] |
| `get_settings` / `update_settings` | versioned patch | validated settings |
| `preview_csv_profile` | document/session/task/profile | sample result+diagnostics |
| `validate_csv_profile` | document/session/task/profile | accepted task/status |
| `apply_csv_profile` | document/session/profile | 새 session summary |
| `execute_query` | document/session/plan | queryId/status |
| `get_query_status` | document/session/query | progress/count/error |
| `read_query_page` | document/session/query/page/projection | DataPage |
| `list_distinct_values` | document/session/query/column/cursor | bounded values page |
| `cancel_data_task` | document/session/task 또는 query | final status |
| `get_temp_usage` / `clear_temp_files` | 없음 | byte/result summary |

긴 command는 UI event를 무제한 전송하지 않는다. status polling 또는 throttled event를 사용하고 동일 task
progress는 최신 값으로 합친다. DTO collection에는 page/count/byte 상한을 둔다.

## 9. Concurrency와 resource manager

Phase 8 상한을 유지하고 query worker를 별도 resource manager로 조정한다.

- open documents: 64
- batch open: 32
- 동시 source prepare: 4
- 동시 CPU-heavy query: 기본 2
- process query memory budget: 기본 1 GiB, 전체 RSS gate 1.5 GiB
- process query temp hard cap: 기본 10 GiB
- preview rows: 1,000
- validation 대표 오류: column당 20
- query page limit: 기존 page hard cap 유지

worker semaphore를 기다리는 작업도 취소 가능해야 한다. registry/document lock을 잡은 채 file I/O,
engine execute, worker join 또는 temp delete를 수행하지 않는다. cancel 순서는 token signal, worker 종료 대기,
engine/result drop, file handle close, temp delete다.

## 10. Temporary disk와 정리 정책

### 10.1 경로

Tauri path resolver의 app-local-data 아래를 사용한다. Windows 절대 경로를 코드에 고정하지 않는다.

```text
<app-local-data>/query-temp/
  process-<pid>-<nonce>/
    owner.lock
    document-<document-id>/
      query-<query-id>/
      validation-<task-id>/
```

source 파일과 exe가 있는 directory에는 쓰지 않는다. 각 process는 자신의 active subtree만 삭제한다.

### 10.2 정상 정리

다음 시점에 해당 작업 temp를 즉시 정리한다.

- query 완료 후 더 이상 result가 필요하지 않을 때
- query cancel/failure/replacement
- CSV profile validation 완료/cancel과 session 교체
- tab close
- 정상 app 종료

result paging에 필요한 spill은 QueryResult가 살아 있는 동안 유지하고 result drop 직후 정리한다. 첫
구현에는 재사용 가능한 persistent query cache를 만들지 않는다.

### 10.3 Crash recovery

- process 시작 시 `owner.lock`을 열고 process 수명 동안 exclusive lock을 유지한다.
- startup janitor는 다른 process directory의 lock을 exclusive 획득할 수 있을 때만 orphan으로 판단한다.
- PID만 확인하지 않는다. PID reuse 때문에 nonce와 lock을 함께 사용한다.
- 삭제 실패는 같은 root 안 `delete-pending-<uuid>`로 rename하고 다음 startup/수동 clear에서 재시도한다.
- 활성 lock, config, source와 registry 밖 경로는 janitor가 절대 삭제하지 않는다.
- 정상 shutdown은 최대 3초만 정리에 사용하고 남은 것은 다음 janitor에 맡긴다.

cross-process file lock 구현에 신규 dependency가 필요하면 9D dependency gate에 포함한다.

### 10.4 Disk budget

- process hard cap 기본값: 10 GiB
- 실행 전/중 최소 여유 공간: `max(5 GiB, volume size의 10%)`
- 여러 process의 app temp 사용량은 query 시작 전 best-effort로 합산해 UI에 표시한다.
- engine 자체 temp limit과 app monitor를 모두 설정한다.
- cap 또는 여유 공간 위반 시 해당 query만 취소한다.
- source, settings와 다른 active process temp를 정리해서 공간을 만들지 않는다.

정확한 app-wide hard reservation은 cross-process coordinator 없이는 보장하지 않는다. Phase 9에서는
각 process hard cap과 free-space floor를 강제하고, app-wide 값은 진단용으로 표시한다.

## 11. Error 계약

기존 `DataError`에 다음 범주를 추가하거나 equivalent typed context를 둔다.

- `UnknownFormat`, `FormatContentMismatch`, `InvalidFormat`
- `InvalidCsvProfile`, `CsvConversionInvalid`
- `InvalidQuery`, `UnsupportedOperator`, `QueryCancelled`, `QueryFailed`
- `QueryMemoryLimit`, `QueryDiskLimit`, `InsufficientDiskSpace`
- `StaleQuery`, `TaskNotFound`
- `SettingsInvalid`, `TempCleanupFailed`

사용자 메시지에는 파일 경로, column, row와 필요한 공간을 안전한 범위에서 포함한다. raw CSV 오류
대표 값은 크기를 제한하고 control character를 escape한다. engine 내부 SQL, stack trace와 임시 인증정보는
UI에 노출하지 않는다.

## 12. 보안과 무결성

- 모든 source는 read-only handle로 연다.
- query/profile은 source 파일을 수정하거나 export하지 않는다.
- extension, descriptor, IPC enum과 numeric limit을 backend에서 검증한다.
- custom delimiter/quote는 Unicode 문자 하나이며 CR/LF와 NUL을 거부한다.
- regex는 이번 Phase에 없어 unbounded regex 실행을 허용하지 않는다.
- search/filter literal과 column name을 SQL string concatenation하지 않고 engine expression/bind parameter로 전달한다.
- temp path component는 내부 UUID/ID만 사용하고 source filename을 직접 넣지 않는다.
- settings와 temp file permission은 Tauri/OS 사용자 app directory 기본 권한을 따른다.

## 13. 설계 완료 조건

1. CSV/Parquet가 registry/trait 뒤에서 기존 contract test를 통과한다.
2. test-only handler가 core document/query/grid 분기 추가 없이 표시된다.
3. engine 후보가 같은 QueryPlan/QueryResult adapter와 fixture를 사용한다.
4. invalid/null, stable row identity와 multi-sort 의미가 engine에 무관하게 같다.
5. query/profile 교체와 cancel에서 stale 결과와 temp leak이 없다.
6. 10M low/high fixture에서 memory/disk/cancel budget이 측정된다.
7. 선택한 engine과 dependency 승인 결과가 이 문서와 `engine-spike.md`에 반영된다.
