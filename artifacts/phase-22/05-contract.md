# Phase 22 integration contract

Frozen initial wire contract 2026-11-06. All wire names camelCase; enum strings as below. Domain DTO/module
owned by engine; frontend mirror/parity by UI; thin commands/registration by Root. Changes coordinate first.

## Source registration

`SqlSourceIdentity { documentId:string, sessionId:string }`

`describe_sql_tables({ sources: SqlSourceIdentity[] }) -> SqlTableDescriptor[]`

Descriptor: `{documentId,sessionId,fileName,path,defaultColumnMode:'name'|'ordinal',nameModeAllowed:boolean,
nameModeReason:string|null,columns:SqlSourceColumn[]}`. No client-supplied paths accepted.

SourceColumn: `{id:string,sourceIndex:number,originalName:string,sqlType:string,nullable:boolean}`.
SourceIndex is zero-based ORIGINAL physical ordinal. Ordinal SQL name is `c${sourceIndex+1}`, including gaps
when profile skips columns; no renumber after skip/reorder/hide. Name eligibility uses complete raw headers;
never infer from truncated metadata. Only visible/non-skipped profile columns are exposed to SQL.

## Jobs and results

`SqlTableBinding { documentId,sessionId,alias,columnMode:'name'|'ordinal' }`

`StartSqlRequest {runId:string,sql:string,action:'execute'|'explain'|'analyze',tables:SqlTableBinding[]}`

`start_sql_query({request:StartSqlRequest}) -> SqlStatus`

`get_sql_query_status({runId:string}) -> SqlStatus`

`cancel_sql_query({runId:string}) -> SqlStatus`

SqlStatus fields (all required, nullable fields explicit):
`{runId,state:'queued'|'running'|'complete'|'cancelled'|'failed',phase:string,elapsedMs:number,
rowsProduced:number,resultId:string|null,columns:SqlResultColumn[],rowCount:number|null,
planText:string|null,planJson:JSON|null,warnings:string[],error:DataError|null}`.

ResultColumn: `{id:string,name:string,logicalType:string,nullable:boolean}`. IDs `r0`,`r1`… are unique;
display names may duplicate and must not be used as projection identity. IDs are result-local.

`SqlPageRequest {runId,resultId,offset:number,limit:number,columns:string[]}`

`read_sql_query_page({request:SqlPageRequest}) -> DataPage` (existing DataPage wire shape, stable IDs).

`read_sql_query_cell({runId,resultId,row:number,columnId:string}) -> DataValue`

`release_sql_result({runId,resultId}) -> void` (cancels result copies before release).

Results are independent from source page IDs. Frontend synthesizes grid summary with documentId
`sql-workspace`, sessionId=resultId, queryId=runId; it maps to SQL APIs and never calls source read_page.
Old successful result retained while a new run is pending/failed; release only explicit clear, replacement
after successful publication or workspace teardown. Root cancels source-bound SQL jobs on close/profile change.

## Copy

`start_sql_copy({runId,resultId,request:StartCopyRequest}) -> CopyOperationStatus`.
Enforce request documentId=`sql-workspace`, sessionId=resultId, queryId=runId, actual settings cell/byte caps.
Engine supplies `sql_copy_context(runId,resultId,operationId,maxBytes)` with a guarded reader and dedicated
shared-budget staging lease. The reader retains the service and validates snapshot lifetime. Before every
serialized header/row write, `validate_staging_bytes(total)` rejects bytes beyond the reserved allowance.
Root adds `CopyRowReader::column_headers(&[String]) -> Result<Vec<String>,DataError>` default identity;
SQL reader overrides it with display labels (duplicate labels preserved). Existing get_copy_status/cancel_copy/
get_copy_history work with the synthetic identity; no separate copier. Reader lifetime/validate_current prevents
late clipboard commits after release. Engine exposes methods on QueryService; Root owns Tauri wrappers.

## Root/engine integration

Root resolves each source via documents.with_source(identity, source.query_source_spec()), and authoritative
raw-name descriptors via a narrow engine/data helper (no frontend header reconstruction). Engine owns source
snapshot acquisition/CSV readiness/leases, worker manifest/protocol, bounded result storage, pages/status and
security. Request validation runs before spawning. Service shutdown/drop_session integrates registry cancellation.
Engine reports exact method signatures and exports before root integration. Root wires same-EXE worker
entrypoint before Tauri startup, without new capabilities or runtime dependencies.

## Progress and limits

Settings schemaV6 adds required `sqlTempLimitBytes`: integer64MiB..10GiB, default512MiB. Valid versions1..5
migrate preserving all prior fields. CurrentV6 missing/invalid cap is rejected under existing corrupt-settings
backup/recovery semantics. Start SQL command reads the persisted setting; QueryService.start_sql receives
it as a third argument and snapshots it into the task. It bounds combined worker spill/results rather than
retaining an independent hidden512MiB ceiling. Effective allowance is min(snapshot, managed headroom,
physical headroom). Changing settings leaves active task caps and retained results unchanged.

Use `00-scope.md` ceilings. Check Rust+TS boundary parity. Counts above JS safe integer reject. No fabricated
progress percent/metrics, no per-page rerun, no hidden LIMIT, no entire-result Vec/JSON transfer.

SQL blank is Unicode White_Space plus U+FEFF (including U+0085). Aliases are ASCII-case-insensitive unique.
Page offset is at most1,000,000 inclusive; result IDs use canonical `r0`… spelling without leading zeros.
Source/result column names are bounded4096 Unicode scalar values/16,384 UTF-8 bytes with no NUL;
aggregate schema metadata is bounded2MiB. Violations reject explicitly rather than truncate original names.
Cache relocation rejects before service shutdown while SQL jobs or independent results are live; users must
cancel work and clear results first. Failed/cancelled relocation must not destroy a retained SQL result.
