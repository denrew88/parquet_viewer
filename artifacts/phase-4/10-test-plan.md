# Phase 4 파일 열기 통합 테스트 계획 (Draft)

- 작성일: 2026-07-14
- 기준: `PROJECT_SPEC` 3절, `DEVELOPMENT_PLAN` Phase 4, `UI_VALIDATION`, Phase 3 공통 CSV/Parquet 세션 계약
- 상태: Root가 아래 Windows Tauri 2 계약과 fixture를 승인한 뒤 `10-test-plan.md`로 승격
- 핵심 불변 조건: 모든 진입점은 하나의 경로 검증·형식 판별·candidate open·원자적 session commit 절차를 사용한다.

## 완료 판정

다음 항목은 모두 필수다.

1. native dialog, OS drag/drop, startup argv, 설치본 파일 연결, 실행 중 instance 전달에서 CSV와 Parquet가 같은 결과를 낸다.
2. candidate의 검증과 첫 page 생성이 끝나기 전에는 현재 session을 변경하지 않는다.
3. 성공한 최신 요청만 commit하며, commit 직후 이전 CSV worker·checkpoint·page cache·file handle을 해제한다.
4. 지원하지 않는 파일, 다중 경로, 손상 파일, 늦은 성공·실패가 현재 grid를 덮지 않는다.
5. frontend 자동 테스트, Browser interaction/geometry/screenshot, 실제 Windows Tauri 증거를 각각 남긴다. Browser나 native 계층을 다른 계층의 테스트로 대체하지 않는다.

## 제안하는 Windows Tauri 2 구현 계약

### 공통 열기 요청

```text
OpenOrigin = dialog | dragDrop | startupArg | fileAssociation | secondInstance
OpenPathsRequest { requestId, origin, paths[] }
OpenResult { requestId, origin, summary, initialPage }
OpenFailure { requestId, origin, error }
```

- Rust `OpenCoordinator`가 모든 진입점을 받는다. `paths.len() != 1`은 parsing 전에 `MultipleFilesNotSupported`, 0개는 무동작 또는 내부 invalid request다.
- Windows 경로는 Rust 내부에서 `PathBuf`/`OsString`으로 유지한다. 공백·한글·확장 Unicode를 lossless하게 처리하고 UI 표시용 문자열과 실제 파일 접근 경로를 구분한다.
- 단일 경로는 absolute normalization 후 기존 `DataSource::open`으로 보내며, CSV/Parquet 확장자와 내용 검증 및 typed error는 Phase 3 계약을 그대로 쓴다. canonicalize 실패도 구조화된 오류로 변환한다.
- 각 요청은 시작 시 증가하는 backend ticket을 얻는다. source open, summary, initial page는 active session lock 밖의 candidate에서 수행한다.
- candidate가 모두 성공한 뒤에도 ticket이 최신일 때만 `SessionSlot::replace`를 한 번 수행한다. 늦은 candidate는 drop하고 성공/실패 event를 UI에 적용하지 않는다.
- commit 전 오류는 기존 active session과 grid를 보존한다. commit 후 old source drop은 worker cancel/join, checkpoint/index, 8-entry page cache, handle 해제를 포함한다.
- frontend도 `requestId + sessionId + CSV generation`을 검사한다. 열기 중 기존 grid는 유지하고 drop/opening 상태만 overlay 또는 status로 표시한다.

### Tauri 진입점

- **Dialog:** 기존 `tauri-plugin-dialog` picker는 CSV/Parquet 단일 선택만 허용하고 cancel은 `None`으로 끝낸다. 선택 경로는 공통 coordinator로 전달한다.
- **OS drag/drop:** main WebView window의 Tauri 2 drag/drop event를 구독한다. `Enter/Over`는 시각 상태만, `Drop`만 coordinator 호출, `Leave`는 상태를 즉시 제거한다. HTML5 synthetic drop은 native PASS 증거가 아니다.
- **Startup argv:** `args_os()`에서 executable과 앱 자체 option을 제외한 파일 operand만 추출해 공통 coordinator에 enqueue한다. frontend listener 등록 전 유실을 막기 위해 Rust pending queue 또는 backend 선처리를 사용한다.
- **파일 연결:** `tauri.conf.json` bundle `fileAssociations`에 `csv`, `parquet`와 viewer role을 선언한다. Windows installer로 등록한 뒤 Explorer 더블클릭을 검증한다. 개발 실행만으로 PASS 처리하지 않는다.
- **Single instance:** Tauri 2 single-instance plugin을 setup 초기에 등록한다. 두 번째 process의 argv/cwd를 첫 instance의 pending-open dispatcher로 전달하고 main window를 show/unminimize/focus한다. callback에서 직접 UI state를 변경하지 않고 공통 coordinator를 호출한다.
- startup과 second-instance 요청이 frontend ready보다 먼저 도착할 수 있으므로 pending queue는 순서를 보존하되 실제 commit은 최신 ticket 우선 정책을 따른다. 처리 완료 항목은 재전달하지 않는다.

## Fixture

| ID | 내용 |
| --- | --- |
| `F-P4-01` | 240행 primitive Parquet, 첫/마지막 row checksum 고정 |
| `F-P4-02` | UTF-8 BOM CSV, header·quoted newline·마지막 빈 열, 450행 |
| `F-P4-03` | `C:\...\파일 열기 통합\공백 한글 😀.csv`와 같은 Unicode/공백 경로의 CSV·Parquet 복제본 |
| `F-P4-04` | `.txt`, 확장자 없는 파일, CSV를 `.parquet`로 이름만 바꾼 파일, 손상 Parquet |
| `F-P4-05` | 존재하지 않는 경로, 가능한 경우 ACL로 읽기 거부된 파일 |
| `F-P4-06` | drop/argv용 `[F01,F02]`, `[F01,F04]`, 빈 경로 목록 |
| `F-P4-07` | open barrier double: candidate open/initial page 성공·실패·완료 순서를 제어 |
| `F-P4-08` | drop event adapter double: Enter→Over→Leave, Enter→Drop, 중첩 Enter 순서 제어 |
| `F-P4-09` | startup/second-instance argv table: quoted 공백, 상대 경로+cwd, Unicode, option, 0/1/2 operand |
| `F-P4-10` | resource probe source: worker, checkpoint, cache entry, handle drop를 counter와 파일 rename/delete로 검증 |
| `F-P4-11` | Browser mock: 각 origin, 다중/unsupported/stale 결과, 느린 open 상태를 결정적으로 방출 |

fixture 생성 스크립트는 기대 summary/first-page checksum과 절대 경로를 기록한다. native 증거에는 fixture hash를 함께 남긴다.

## Rust Coordinator·세션

| ID | Fixture/검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P4-001` | F01/F02, 5 origin 공통 coordinator | origin과 무관하게 동일 summary/initial page/error envelope | Tauri Platform |
| `T-P4-002` | F06 0/2 paths | 0은 무동작, 2개는 `MultipleFilesNotSupported`; 임의 선택·source open 없음 | Tauri Platform |
| `T-P4-003` | F04 unsupported/mismatch/corrupt | 기존 Phase 3 typed error와 메시지, current session 불변 | Platform + Rust Data |
| `T-P4-004` | F05 missing/denied | `NotFound`/`PermissionDenied` 또는 합의한 구조화 I/O code, 경로 내용 유출 제한 | Platform + Rust Data |
| `T-P4-005` | F03 Unicode/공백 | lossless open, file name 표시·page checksum 정확 | Tauri Platform |
| `T-P4-006` | F07 candidate source open 실패 | old session id/page/cache/worker 그대로 사용 가능 | Tauri Platform |
| `T-P4-007` | F07 initial page 실패 | source open 뒤 page 실패해도 old session 유지, candidate 자원 drop | Platform + Rust Data |
| `T-P4-008` | F07 성공 commit | 새 session id가 한 번만 생성되고 old id는 즉시 `SessionNotFound` | Tauri Platform |
| `T-P4-009` | F10 성공 교체 | old worker cancel/join, checkpoint/cache/handle counter 0; old 파일 rename/delete 가능 | Platform + Rust Data |
| `T-P4-010` | F10 실패 교체 | candidate 자원만 해제, old resource counter와 page 접근 유지 | Platform + Rust Data |
| `T-P4-011` | F07 A 시작→B 시작→B 성공→A 성공 | B만 commit, A success event 폐기, A candidate drop | Tauri Platform |
| `T-P4-012` | F07 A 시작→B 시작→B 실패→A 성공 | 최신 요청 B 실패 표시, A 늦은 성공은 current session을 교체하지 않음 | Tauri Platform |
| `T-P4-013` | F07 A 성공→늦은 A 실패/progress | terminal 결과 하나만 적용, panic·중복 close 없음 | Tauri Platform |
| `T-P4-014` | 반복 CSV↔Parquet 100회 | active session 1개, handle/worker/cache 누적 없음 | Quality + Platform |
| `T-P4-015` | 앱 종료 중 candidate/CSV worker | bounded shutdown, callback이 종료된 state/window 접근 안 함 | Tauri Platform |

## Dialog·Drag/Drop·Frontend 상태

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P4-016` | dialog filter/cancel | CSV·Parquet만 filter, 단일 선택; cancel은 banner/session 변화 없음 | Tauri Platform + Grid |
| `T-P4-017` | F08 Enter/Over | 창 전체에 명확한 drop target, 파일 수/지원 여부 안내, 기존 grid 식별 가능 | Grid UX |
| `T-P4-018` | F08 Leave | hover target 즉시 제거, layout/scroll/focus 원복 | Grid UX |
| `T-P4-019` | F08 single Drop F01/F02 | target 제거→opening 표시→Data tab에 새 summary/page 원자 반영 | Grid UX |
| `T-P4-020` | F06 unsupported/multiple Drop | actionable error, 현재 grid/session/active tab/scroll 보존 | Grid UX |
| `T-P4-021` | drop 중 repeated Over/nested Enter | flicker와 counter stuck 없이 한 overlay만 표시 | Grid UX |
| `T-P4-022` | open pending | 기존 grid를 비우지 않고 busy 상태·중복 요청 정책·키보드 focus 일관 | Grid UX |
| `T-P4-023` | 최신 open success | summary/page/tab/error가 한 state transition으로 교체, 이전 오류 제거 | Grid UX |
| `T-P4-024` | 최신 open failure | 기존 summary/page 유지, origin에 무관한 오류 banner와 retry/open 제공 | Grid UX |
| `T-P4-025` | F07 stale success/failure | requestId 불일치 응답은 DOM, banner, busy 상태를 변경하지 않음 | Grid UX |
| `T-P4-026` | component unmount/re-subscribe | Tauri event listener가 1개이고 cleanup 후 callback 없음 | Grid UX |
| `T-P4-027` | keyboard/focus during overlay | focus를 강제로 빼앗지 않고 Open 버튼·tab 접근 가능, Escape 정책 일관 | Grid UX |
| `T-P4-028` | adapter validation | malformed origin/requestId/path/result는 `InvalidResponse`, current session 보존 | Grid UX |

## Startup argv·파일 연결·Single Instance

| ID | Fixture/검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P4-029` | F09 argv parser table | executable/options 제외, cwd 기준 상대 경로·quoted 공백·Unicode 정확 | Tauri Platform |
| `T-P4-030` | cold start without operand | empty workspace, 오류 없음 | Tauri Platform |
| `T-P4-031` | cold start F01/F02 absolute path | window ready 후 파일 자동 표시, pending queue 중복 소비 없음 | Tauri Platform |
| `T-P4-032` | cold start relative path+cwd | 정규화된 정확한 파일 열기 | Tauri Platform |
| `T-P4-033` | cold start F06 multiple | 제한 오류 표시, 임의 파일 열기 없음 | Platform + Grid |
| `T-P4-034` | installed association F01/F02 double-click | 설치본 한 instance에서 각 형식 자동 표시 | Tauri Platform |
| `T-P4-035` | installed association F03 | 공백·Unicode 경로가 손상 없이 전달 | Tauri Platform |
| `T-P4-036` | first instance active, launch exe F01/F02 | 두 번째 process가 잔류하지 않고 첫 창이 show/focus되어 파일 교체 | Tauri Platform |
| `T-P4-037` | first instance minimized, association launch | 기존 창 복원·focus 후 파일 표시 | Tauri Platform |
| `T-P4-038` | second instance F06 multiple/unsupported | 첫 instance에 같은 제한/error, current session 보존 | Platform + Grid |
| `T-P4-039` | startup와 second-instance 경합 | 최신 ticket만 commit, queue replay·두 창·stale overwrite 없음 | Tauri Platform |
| `T-P4-040` | rapid second-instance 20회 | process 1개, 마지막 요청 표시, handle/worker 누적 없음 | Quality + Platform |

## Browser Interaction·Geometry·Screenshot

| ID | 검증 | 기대 결과/증거 | 담당 |
| --- | --- | --- | --- |
| `T-P4-041` | F11 Browser dialog-origin mock | 실제 click로 open pending→success/failure, 기존 grid 보존 확인 | Quality |
| `T-P4-042` | F08/F11 Browser drag adapter | Enter/Over/Leave/Drop 상태·텍스트·ARIA를 실제 event/callback으로 확인 | Quality |
| `T-P4-043` | F11 unsupported/multiple/stale | banner 내용과 최신 session DOM, stale 응답 부재 확인 | Quality |
| `T-P4-044` | desktop 1440x900 geometry | toolbar/tabs/grid/drop overlay 겹침·예상 밖 overflow 없음 | Quality |
| `T-P4-045` | compact 1024x768 geometry | 버튼·파일명·오류·drop 문구 무잘림, scroll surface만 overflow 허용 | Quality |
| `T-P4-046` | minimum 800x600 geometry | overlay가 viewport에 맞고 control/text가 부모 밖으로 나가지 않음 | Quality |
| `T-P4-047` | layout stability | empty/populated/opening/drop/error 전환에서 workspace rect 불필요한 이동 없음 | Quality |
| `T-P4-048` | screenshots | `browser-desktop.png`, `browser-compact.png`, `browser-minimum.png`에 drop target 핵심 상태 포함 | Quality |
| `T-P4-049` | visual review | 겹침·잘림·계층·focus·색 외 상태 표시를 `ui/visual-review.md`에 독립 판정 | Quality |

Browser mock은 UI reducer와 adapter를 검증할 뿐 OS drag/drop, dialog, argv, association, single-instance를 PASS시키지 않는다.

## 실제 Windows Tauri 증거

| ID | 검증 | 필수 증거 | 담당 |
| --- | --- | --- | --- |
| `T-P4-050` | 실제 native dialog F01/F02/cancel | 입력 순서, fixture hash, 화면 결과, `ui/native-smoke.md` | Tauri Platform |
| `T-P4-051` | Explorer→Tauri 실제 drag F01/F02 | Enter overlay와 drop 후 화면 screenshot/log | Tauri Platform |
| `T-P4-052` | 실제 unsupported/multiple drag | 제한/error screenshot, 기존 file/session id 로그 | Tauri Platform |
| `T-P4-053` | release exe cold argv F01/F02/F03 | 실행 command/process id, summary checksum, 한 창 screenshot | Tauri Platform |
| `T-P4-054` | release exe second-instance | 첫/둘째 PID 관찰, 둘째 종료, 첫 창 focus·교체 log | Tauri Platform |
| `T-P4-055` | installer association CSV/Parquet | installer version/hash, 등록 정보, Explorer double-click 결과 | Tauri Platform |
| `T-P4-056` | native 3 viewport/drop target | desktop/compact/minimum 중 최소 desktop screenshot과 크기별 smoke 기록 | Tauri Platform |
| `T-P4-057` | Windows Unicode/공백 | dialog/drop/argv/association 중 적용 경로별 F03 실제 성공 | Tauri Platform |

## 회귀·Gate

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P4-058` | Phase 1~3 회귀 | Parquet paging/types, CSV preview/header/progress/cancel 모두 PASS | Quality |
| `T-P4-059` | 정적 gate | Rust fmt/clippy/test, frontend format/lint/typecheck/test/build, Tauri release build PASS | Quality |
| `T-P4-060` | resource/soak | 100회 교체와 20회 second-instance 뒤 process/worker/handle 안정 | Quality |
| `T-P4-061` | evidence gate | interaction, geometry JSON, 3 browser screenshot, visual review, native smoke가 존재 | Quality + Root |
| `T-P4-062` | 판정 | 필수 미실행은 구체적 환경 원인의 `BLOCKED`; 자동 테스트로 대체해 PASS 금지 | Root |

## 증거 파일 계약

```text
artifacts/phase-4/ui/
  browser-desktop.png
  browser-compact.png
  browser-minimum.png
  visual-review.md
  geometry-results.json
  interaction-results.md
  native-desktop.png
  native-drop.png
  native-smoke.md
```

`interaction-results.md`는 각 테스트 ID의 시작 상태, 실제 입력, 기대 결과, 실제 결과를 기록한다. `geometry-results.json`은 viewport별 toolbar/tabs/workspace/drop-target rect와 scroll/client 치수를 저장한다. native log에는 origin, request ticket, old/new session id를 포함하되 전체 사용자 경로나 셀 원문은 기록하지 않는다.

## 플랫폼 검증 제약과 판정 원칙

- in-app Browser backend가 제공되지 않으면 `T-P4-041`~`049`는 `BLOCKED`다. Vitest/jsdom이나 별도 Playwright로 대체하지 않는다.
- OS drag/drop은 실제 unlocked interactive Windows desktop과 Explorer pointer 입력이 필요하다. 합성 DOM `drop` 또는 Rust unit event는 native PASS가 아니다.
- 파일 연결은 bundle 설정이나 registry 값만으로 충분하지 않다. Windows installer 설치 후 Explorer double-click을 수행해야 `T-P4-034/035/055`가 PASS다.
- single-instance는 release/설치 exe 두 번 실행과 PID 관찰이 필요하다. `cargo test` callback 검증만으로 `T-P4-036/054`를 PASS하지 않는다.
- 화면 잠금, sleep, 비대화형 session에서는 screenshot·pointer·focus 증거가 무효거나 검증 불가다. 이 경우 native 항목은 `BLOCKED`다.
- WebView 합성 때문에 capture가 검은 영역을 만들면 입력 로그와 별도 이미지 캡처를 함께 남기되, 실제 화면을 확인할 수 없는 screenshot 항목은 PASS하지 않는다.
- ACL 거부 fixture를 현재 계정에서 안정적으로 만들 수 없으면 해당 denied 하위 항목만 환경 사유로 `BLOCKED`할 수 있으나, missing path와 unsupported path 검증은 계속 수행한다.

## Root 승인 필요 결정

1. 열기 성공의 기준을 `DataSource::open + summary + initialPage` 완료로 확정할지.
2. 경합 정책을 “가장 최근 시작 요청만 commit(last-request-wins)”으로 확정할지.
3. single-instance plugin 추가와 Windows installer file association 등록을 Phase 4 공유 manifest 변경으로 승인할지.
4. 다중 파일 오류 code를 `MultipleFilesNotSupported`로 추가할지.
