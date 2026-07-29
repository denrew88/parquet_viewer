# Phase 16 테스트 계획

- 상태: **구현 전 계약 확정**
- 작성일: 2026-07-28
- 근거: `artifacts/phase-16/00-scope.md`, `docs/UI_VALIDATION.md`, `docs/PLAYWRIGHT.md`

## 1. 계약 교체

Phase 15의 T-P15-UI-205/206/211은 preparation 중에도 Filter를 사용할 수 있다는 이전 계약을 검증한다.
Phase 16에서는 이를 폐기하고 Preparing 동안 해당 CSV 문서의 Data interaction을 전부 차단한다. 기존
Rust wait/reuse/cancel/session/fallback 테스트와 backend 방어 계층은 삭제하거나 완화하지 않는다.

## 2. Frontend 단위·component 테스트

| ID | 계층 | 완료 기준 |
| --- | --- | --- |
| `T-P16-001` | TS unit | blocker는 실제 `Preparing` CSV 문서에만 존재하고 starting/Ready/Failed/Cancelled/non-CSV에는 없음 |
| `T-P16-002` | Component | Preparing에서 grid click·drag·Shift-click·context menu·wheel 시 selection/scroll/page IPC 변화 0 |
| `T-P16-003` | Component | Filter open/distinct/apply 반복 시 dialog와 `listDistinctValues`/`executeQuery` 호출 0 |
| `T-P16-004` | Component | header/multi sort와 Find button·Ctrl+F·Enter에서 panel/query 변화 0 |
| `T-P16-005` | Component | copy와 모든 navigation shortcut에서 copy/boundary/page 호출 및 selection·scroll 변화 0 |
| `T-P16-006` | Component | column resize/auto-fit/hide/search/reorder에서 column 상태와 backend 호출 변화 0 |
| `T-P16-007` | Component/E2E | blocked subtree는 실제 inert이며 focus가 숨은 control에 남지 않고 terminal 뒤 tabbable 상태 복원 |
| `T-P16-008` | Component/E2E | blocked CSV와 Ready Parquet 두 문서의 tab 이동·상태·상호작용이 문서별로 격리 |
| `T-P16-009` | Component/E2E | Preparing 중 Settings와 view tab, progress·Cancel은 접근 가능하고 Data 호출 0 |
| `T-P16-010` | Component/E2E | Preparing→Cancelling 동안 차단 유지, Cancel 중복 불가, Cancelled terminal 뒤 direct Data 사용 가능 |
| `T-P16-011` | Component/E2E | Preparing→Failed 뒤 typed error를 표시하고 direct page/query/distinct/copy 사용 가능 |
| `T-P16-012` | Component/E2E | Failed/Cancelled Retry의 새 Preparing generation만 차단·commit되고 Ready에서 한 번 해제 |
| `T-P16-013` | Component/E2E | immediate warm Ready에서 blocker/progress/Cancel DOM·visible frame 0, polling 0, 첫 frame interactive |
| `T-P16-014` | TS unit | tab close/session replace의 late status가 blocker·query·focus를 commit하지 않고 timer/poll 정리 |
| `T-P16-015` | E2E | 차단 동작 각 10회와 key repeat 뒤 preparation poll/Cancel 외 backend command delta와 popup 누적 0 |

## 3. Backend 회귀 테스트

| ID | 계층 | 완료 기준 |
| --- | --- | --- |
| `T-P16-016` | Rust | preparation 중 query는 permit 점유 전에 Queued로 기다리고 prepare 1회, Ready artifact 재사용 |
| `T-P16-017` | Rust/IPC | distinct도 두 번째 full scan 없이 Ready artifact를 재사용하고 async command가 IPC를 막지 않음 |
| `T-P16-018` | Rust | query waiter 취소는 해당 waiter만 취소하고 공유 preparation과 다른 waiter를 오염시키지 않음 |
| `T-P16-019` | Rust | session replace/tab close에서 waiter·preparation join, stale publish 0, resource/temp/lease 잔존 0 |
| `T-P16-020` | Rust | preparation Failed/명시 Cancelled terminal 뒤에만 direct source를 정확히 한 번 사용 |

## 4. Browser UI 검증

| ID | 계층 | 완료 기준 |
| --- | --- | --- |
| `T-P16-021` | Playwright | 세 viewport에서 T-P16-002~015를 실제 pointer/keyboard와 backend counter delta로 검증 |
| `T-P16-022` | Geometry | blocker가 Data toolbar+grid를 완전히 덮고 progress·Cancel은 hit-test 가능하며 app tabs/Settings는 blocker 밖; 상태 전환 shift <=1px |
| `T-P16-023` | Screenshot | 1440×900, 1024×768, 800×600의 blocked와 Failed/unblocked 상태에서 overlap·clipping·계층·focus PASS |

Browser fixture는 다음 상태를 사용한다.

- `csv-preparing-controlled`: Ready를 수동 release할 수 있고 progress와 모든 backend command counter 제공
- `csv-terminal-controlled`: Failed, Cancelled와 Retry→Preparing→Ready 제어
- `csv-warm-immediate-ready`: observer 설치 뒤 즉시 Ready, polling/worker 0
- `two-doc-isolation`: blocked CSV와 Ready Parquet 문서별 counter 제공

## 5. 실제 Tauri 검증

| ID | 계층 | 완료 기준 |
| --- | --- | --- |
| `T-P16-024` | Native cold | 실제 5.85M high CSV에서 progress 증가, blocker/허용 control geometry와 command delta 0, preparation 1회, Ready 뒤 Data 정상 |
| `T-P16-025` | Native warm | 같은 cache reopen은 1초 이내 Ready, source scan/worker/publish 0, blocker/progress visible frame 0, 첫 frame interactive |
| `T-P16-026` | Native cancel | cold progress Cancel 후 1초 이내 terminal, partial/worker/lease 0, blocker 해제와 direct page/query 사용 가능 |
| `T-P16-027` | Native navigation | `fixtures/phase-7/small-csv.csv` column 2에서 Ctrl+Down target 1→100→102→201의 좌표·cell rect·grid focus PASS |
| `T-P16-028` | 전체 gate | Rust fmt/clippy/test, frontend format/lint/typecheck/Vitest/build, Playwright 전체, native smoke, release/NSIS PASS |

Native cold/warm fixture는 `fixtures/phase-15/csv-5850000-high.csv`, navigation fixture는
`fixtures/phase-7/small-csv.csv`를 사용한다. native test는 별도 Tauri identifier와 WebView data directory를
사용하며 사용자 cache나 원본 fixture를 변경하지 않는다.

## 6. UI 증거

```text
artifacts/phase-16/ui/
  browser-desktop.png
  browser-compact.png
  browser-minimum.png
  csv-failed-unblocked-desktop.png
  csv-failed-unblocked-compact.png
  csv-failed-unblocked-minimum.png
  geometry-results.json
  interaction-results.md
  visual-review.md
  native-desktop.png
  native-smoke.md
```

Browser mock은 실제 WebView2, native focus, persistent cache와 preparation 성능을 대신하지 않는다.
Screenshot은 생성 뒤 이미지 입력으로 열어 독립적으로 검토한다.

## 7. 최종 판정

T-P16-001~028이 모두 PASS하고 HIGH/MEDIUM 결함과 필수 BLOCKED가 없어야 Phase 16을 완료한다.
외부 환경 때문에 실행하지 못한 필수 항목은 PASS로 추정하지 않고 `90-review.md`에 BLOCKED로 기록한다.
