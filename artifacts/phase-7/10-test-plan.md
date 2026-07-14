# Phase 7 안정화·배포 테스트 계획 (Draft)

- 작성일: 2026-07-14
- 기준: `PROJECT_SPEC`, `DEVELOPMENT_PLAN` Phase 7, `UI_VALIDATION`, Phase 5·6 성능/clipboard 계약
- 상태: 구현 전 Root 승인 필요
- 현재 감사 시작점: `tauri.conf.json`의 CSP가 `null`, bundle target은 `all`, CSV/Parquet file association은 선언됨, capability는 `core:default`만 선언됨

## 판정 원칙

- 기준 환경은 Windows 11 x64, 4 physical core 이상, RAM 16 GiB, SSD, WebView2 stable, release installer 설치본이다. CPU, RAM, 디스크, OS/WebView2 버전과 전원 모드를 결과에 기록한다.
- cold 측정은 앱/OS file cache 조건을 명시하고 10회, warm 측정은 30회 실행해 median/p95/max를 기록한다. 처음 1회는 warm-up으로 제외한다.
- native/installer/association/clipboard 항목은 Browser mock으로 대체하지 않는다. 필수 환경이 없으면 `BLOCKED`다.
- 목표 초과, crash, 데이터 좌표 오류, stale apply, handle/task leak, partial clipboard write는 `FAIL`이다.

## Fixture와 benchmark manifest

| ID | Fixture | 규모/특성 |
| --- | --- | --- |
| `F-P7-01` | small Parquet | 10,000×20, 약 5 MiB, primitive/null/decimal/timestamp, 4 row groups |
| `F-P7-02` | small CSV | 10,000×20, 약 12 MiB, quoted newline/empty/null-like text |
| `F-P7-03` | large Parquet | 10,000,000×40, 1~2 GiB, 100 row groups, wide/nested 일부 |
| `F-P7-04` | large CSV | 5,000,000×40, 1 GiB 이상, quoted field/구조 issue 일부, row count background scan |
| `F-P7-05` | wide | 100,000×500 Parquet와 CSV, projection/수평 virtualization 검증 |
| `F-P7-06` | hostile corpus | truncated footer, corrupt metadata, invalid UTF-8, giant field, giant header, ragged CSV, quote bomb, 0-byte, directory, unsupported extension |
| `F-P7-07` | path corpus | Unicode/공백/quote/260자 이상 경로, UNC, read-only, 권한 없음, 삭제·교체 경쟁 |
| `F-P7-08` | soak sequence | small/large CSV·Parquet, invalid file, cancel 가능한 scan/copy를 고정 seed로 순환 |
| `F-P7-09` | clipboard limits | Phase 6 soft/hard 바로 아래·동일·위, 65 MiB 단일 값, 1,000,001셀 |

생성기는 seed, generator revision, row/column count, byte size, SHA-256, page/column checksum을 manifest에 기록한다. fixture 전체와 실제 사용자 경로·셀 값은 로그에 남기지 않는다.

## 성능 예산

| ID | 지표 | PASS 예산 | 담당 |
| --- | --- | --- | --- |
| `T-P7-001` | 설치본 cold launch→usable empty shell | p95 `<=2.0s`, max `<=3.0s` | Quality + Platform |
| `T-P7-002` | small Parquet open→first usable grid | p95 `<=750ms` | Quality |
| `T-P7-003` | small CSV open→preview | p95 `<=1.0s`, row scan은 background | Quality |
| `T-P7-004` | large Parquet open→first grid | p95 `<=2.0s`, 전체 materialize 금지 | Quality + Rust Data |
| `T-P7-005` | large CSV open→preview | p95 `<=3.0s`, 전체 row count 대기 금지 | Quality + Rust Data |
| `T-P7-006` | cold/warm page 200행 | cold p95 `<=300ms`, warm p95 `<=100ms` | Rust Data |
| `T-P7-007` | loaded scroll wheel→paint | p95 `<=50ms`, max `<=100ms` | Grid UX + Quality |
| `T-P7-008` | key/pointer input→selection paint | p95 `<=50ms`, max `<=100ms` | Grid UX + Quality |
| `T-P7-009` | page resolve→correct paint | p95 `<=100ms` | Grid UX |
| `T-P7-010` | 5초 fast scroll | >100ms long task 0, >50ms 2개 이하, RAF p95<=32ms | Quality |
| `T-P7-011` | large fixture steady memory | baseline 대비 working set `+256 MiB` 이하, 파일 크기에 비례 증가 금지 | Quality |
| `T-P7-012` | 30초 scroll 후 memory/DOM | GC·settle 후 `+64 MiB`, Phase 5 DOM 상한 110% 이하 | Quality |

모든 timing은 동일 fixture hash로 3회 이상 독립 run하고 median/p95/max와 raw JSON을 보존한다. antivirus/cache 영향을 제거할 수 없으면 조건을 기록하되 예산을 완화하지 않는다.

## 100회 soak와 자원 회수

| ID | 반복 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P7-020` | open→close 100회 | crash/panic 0, stale UI 0, file handle baseline+5 이하 | Rust Data + Quality |
| `T-P7-021` | A open→B replace 100회 | 최신 session만 표시, 이전 handle/task/cache 해제 | Rust Data |
| `T-P7-022` | CSV scan open→cancel→close 100회 | cancel 후 task 0, late progress/error 0 | Rust Data |
| `T-P7-023` | large copy→cancel 100회 | partial clipboard write 0, buffer/task 회수 | Rust Data + Grid UX |
| `T-P7-024` | valid/invalid/drop/association 혼합 100회 | shell 유지, typed error, 성공 다음 동작 가능 | Platform + Quality |
| `T-P7-025` | soak 종료 30초 settle | 시작 대비 working set `+64 MiB`, handle `+10`, thread `+4` 이하, 단조 증가 없음 | Quality |

각 iteration은 session/task/page-cache count, process handle/thread/working set, clipboard generation을 기록한다. 100회 중 한 번이라도 crash, deadlock, UI freeze 5초 이상이면 즉시 FAIL이다.

## Hostile input·오류·crash

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P7-030` | F-P7-06 전체 corpus | panic/abort 없음, 안정된 typed code와 사용자 메시지 | Rust Data |
| `T-P7-031` | giant field/header·500 columns | bounded read/memory, UI layout 안정, 로그에 원문 없음 | Rust Data + Grid UX |
| `T-P7-032` | invalid UTF-8·quote bomb·ragged CSV | 명세된 encoding/structure error, 무한 loop 없음 | Rust Data |
| `T-P7-033` | path corpus/권한/삭제 경쟁 | shell command 없음, canonical path 안전 처리, TOCTOU crash 없음 | Platform + Rust Data |
| `T-P7-034` | IPC malformed DTO/unknown session/projection | typed reject, 기존 grid/session 불변 | Rust Data + Grid UX |
| `T-P7-035` | background panic injection/test seam | app process 생존 또는 명시 crash report, 다음 실행 복구 | Platform |
| `T-P7-036` | frontend unhandled rejection/error boundary | blank screen 금지, 진단 가능 로그와 안전한 오류 UI | Grid UX |

## CSP·capability·보안 감사

| ID | 감사 | PASS 기준 | 담당 |
| --- | --- | --- | --- |
| `T-P7-040` | CSP | `null` 금지, packaged asset/필수 IPC만 허용, `unsafe-eval`·임의 remote origin 없음 | Platform + Quality |
| `T-P7-041` | capability | window/command/plugin별 최소 allowlist, 미사용 shell/fs/http 권한 0 | Platform |
| `T-P7-042` | dependency audit | npm/cargo advisory 결과와 예외 근거 기록, 알려진 critical/high 0 | Quality |
| `T-P7-043` | read-only boundary | 파일 쓰기/삭제/수정 command 0, clipboard 외 외부 side effect 없음 | Quality |
| `T-P7-044` | path/value privacy | 로그에 전체 path·셀 값·TSV·토큰 없음, path는 basename/hash 또는 opt-in diagnostic | Platform |
| `T-P7-045` | CSP violation smoke | 정상 기능 위반 0, 외부 script/connect 시도 차단 증거 | Quality |

현재 CSP `null`은 release gate FAIL 상태이며 Phase 7 완료 전에 명시 정책으로 바뀌어야 한다.

## Logging·진단·crash 대응

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P7-050` | open/page/copy/cancel 로그 | requestId, origin, duration, typed code, byte/count만 구조화 기록 | Platform |
| `T-P7-051` | 로그 rotation | 기본 off 또는 bounded, 파일당 5 MiB×3 이하, 사용자 데이터 없음 | Platform |
| `T-P7-052` | expected error | stack/panic noise 없이 code와 correlation ID 제공 | Rust Data |
| `T-P7-053` | unexpected crash | version/build/OS/WebView와 sanitized backtrace 수집 절차 README에 존재 | Platform |
| `T-P7-054` | 재시작 | 불완전 temp/buffer 정리, 손상된 session 자동 복원 시도 없음 | Platform |

## Clipboard hard-limit 회귀

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P7-060` | soft/hard cell·byte 경계 | Phase 6 확정값 바로 아래/동일/위 판정 정확 | Quality |
| `T-P7-061` | hard 초과 10회 | `CopyLimitExceeded`, clipboard hash 불변, memory 누적 없음 | Rust Data |
| `T-P7-062` | 직렬화 중 byte hard 초과 | 즉시 cancel, partial clipboard write 0 | Rust Data |
| `T-P7-063` | 64-bit overflow/거대 rect | checked arithmetic, 조회 전 거부 | Rust Data |

## Windows bundle·설치·제거

NSIS를 기본 산출물로 제안한다. 정책상 MSI가 필요하면 동일 항목을 MSI로 반복하며, 최소 하나는 필수다.

| ID | 검증 | 기대 결과 | 담당 |
| --- | --- | --- | --- |
| `T-P7-070` | clean Windows VM NSIS install | 비관리자/관리자 정책 명시, 앱/아이콘/버전 정상 | Platform |
| `T-P7-071` | 설치본 launch | WebView2 prerequisite 처리, console 창 없음, usable shell | Platform |
| `T-P7-072` | CSV association/double-click | 설치본 단일 창에서 해당 파일 grid 표시 | Platform |
| `T-P7-073` | Parquet association/double-click | 동일, fileName/row/column checksum 정확 | Platform |
| `T-P7-074` | 실행 중 두 번째 파일 double-click | 기존 창 focus, single-instance event로 원자 교체 | Platform |
| `T-P7-075` | startup arg/경로 quote/Unicode | 경로 1개만 정확히 전달, shell parsing 오염 없음 | Platform |
| `T-P7-076` | Explorer single/multi/unsupported drop | 단일 성공, 나머지 typed error와 기존 grid 보존 | Platform + Quality |
| `T-P7-077` | upgrade same identifier | 설정/association 정상, 중복 등록·프로세스 없음 | Platform |
| `T-P7-078` | uninstall while app closed | binary/shortcut/association 제거, 재부팅 요구 여부 기록 | Platform |
| `T-P7-079` | uninstall 후 재설치 | stale registry/association/session 없음 | Platform |
| `T-P7-080` | Apps & Features metadata | product/version/publisher/icon/uninstall command 정확 | Platform |

설치·제거 전후 registry association, 설치 경로, shortcut, running process, file handle snapshot을 증거로 남긴다. 개발 실행 결과로 설치본 항목을 PASS하지 않는다.

## 최종 UI·native 증거

| ID | 검증 | 필수 증거 | 담당 |
| --- | --- | --- | --- |
| `T-P7-090` | Browser 1440×900/1024×768/800×600 | empty/loading/populated/error/selection/progress 최종 screenshot | Quality |
| `T-P7-091` | geometry | overlap/clipping 0, grid/header/selection 허용 오차와 DOM 상한 JSON | Quality |
| `T-P7-092` | installed native 100%/150% scale | 실제 grid, dialog/drop, selection screenshot | Platform + Quality |
| `T-P7-093` | installed native clipboard/Excel | clipboard hash와 Excel used-range manifest | Platform + Quality |
| `T-P7-094` | fast scroll/cancel native video 또는 trace | freeze/black grid/stale flash 0, 성능 raw trace | Quality |

## README·known limits Gate

| ID | 문서 항목 | PASS 기준 | 담당 |
| --- | --- | --- | --- |
| `T-P7-100` | 지원 환경/형식 | Windows/WebView2, CSV UTF-8/BOM, Parquet, read-only 명시 | Root |
| `T-P7-101` | 사용 흐름 | dialog/drop/association, grid selection/copy의 실제 동작과 제한 | Root |
| `T-P7-102` | known limits | HDF5/편집/저장 미지원, copy soft/hard, CSV encoding/구조 제한 | Root |
| `T-P7-103` | 오류/진단 | 로그 위치·privacy·재현 정보·issue 제출 절차 | Root |
| `T-P7-104` | build/install | prerequisites, 고정 명령, 산출물 위치, uninstall 절차 | Root |
| `T-P7-105` | license/third-party | 앱/의존성 배포 고지와 아이콘 출처 확인 | Root + Quality |

## 재현 가능한 release 명령

깨끗한 checkout과 lockfile 기준 PowerShell에서 다음 순서로 실행한다.

```powershell
git clean -xfd
npm.cmd ci
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features
npm.cmd run build
npm.cmd run tauri build -- --bundles nsis
Get-FileHash src-tauri/target/release/bundle/nsis/*.exe -Algorithm SHA256
```

`git clean -xfd`는 release 전용 disposable checkout에서만 실행한다. 결과에는 git commit, dirty 여부, Node/npm/Rust/Tauri/WebView2 버전, lockfile hash, installer/app binary hash를 저장한다. 독립 clean checkout 2회에서 app binary가 동일해야 하며 installer timestamp/signing 차이가 있으면 payload hash와 차이 원인을 기록한다.

## 추적 artifact

```text
artifacts/phase-7/
  benchmark-manifest.json
  benchmark-results.json
  soak-results.json
  security-audit.md
  dependency-audit.md
  release-build.md
  installer-smoke.md
  uninstall-audit.md
  known-limits-review.md
  ui/
    geometry-results.json
    visual-review.md
    browser-desktop.png
    browser-compact.png
    browser-minimum.png
    native-100.png
    native-150.png
    native-smoke.md
```

## 최종 PASS/BLOCKED 기준

1. `T-P7-001`~`105`의 적용 가능한 필수 항목이 모두 PASS하고 raw evidence가 존재한다.
2. 성능 예산은 release 설치본에서 충족하며 100회 soak에 crash, leak, stale apply가 없다.
3. CSP는 non-null 최소 정책이고 capability/dependency/privacy 감사에 미해결 high 위험이 없다.
4. clipboard hard limit은 checked arithmetic, memory 상한, atomic write를 만족한다.
5. clean VM에서 installer 설치·association·single instance·drop·제거·재설치가 통과한다.
6. 최종 Browser/native screenshot과 geometry가 필수 viewport/배율에 존재한다.
7. README와 known limits가 실제 동작·배포물과 일치한다.
8. Windows VM, 실제 설치 권한, WebView2, Excel처럼 필수 native 환경이 없으면 해당 항목은 `BLOCKED`다. Browser mock, 개발 실행, 코드 검토만으로 PASS로 대체하지 않는다.

## Root 승인 필요 결정

1. large fixture를 Parquet 1~2 GiB/CSV 1 GiB로 확정할지.
2. open/page/input/memory 예산과 soak 종료 `+64 MiB`, handle `+10`, thread `+4` 상한을 확정할지.
3. Windows 기본 bundle을 NSIS로 확정하고 MSI는 배포 정책 요구 시에만 추가할지.
4. release CSP에서 허용할 정확한 `default-src`, `connect-src`, `img-src`, `style-src` 정책을 Platform 구현 전에 승인할지.
5. 진단 로그 기본값을 off로 둘지, bounded sanitized 로그를 기본 활성화할지.
