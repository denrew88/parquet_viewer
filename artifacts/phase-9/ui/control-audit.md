# Phase 9 UI 전수 감사

- 실행일: 2026-07-15
- 상태: 실행 가능한 Browser, Rust/IPC, release Tauri 범위 PASS
- 자동 결과: Vitest 266개, Playwright 24개, Rust 127개 통과(대형 opt-in 2개 제외)
- 원칙: component test나 mock 단독 통과를 실제 사용자 흐름 PASS로 간주하지 않는다.

## 감사 매트릭스

| ID | 화면 | 검증 범위 | Playwright | Rust/IPC | Native | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| AUD-OPEN-01 | Empty/Open | empty, Open, 취소, 오류, 재시도 | PASS | PASS | dialog 실행 PASS | PASS |
| AUD-OPEN-02 | Tabs | 다중 파일 tab 선택과 파일별 view 상태 | PASS | PASS | 100회 다중 process PASS | PASS |
| AUD-OPEN-03 | Views | Data/Schema/Metadata 전환과 상태 유지 | PASS | N/A | startup argv PASS | PASS |
| AUD-GRID-01 | Grid | click, Shift 범위, context selection | unit PASS | N/A | Shift+ArrowRight PASS | PASS |
| AUD-GRID-02 | Grid | 방향키와 spreadsheet shortcut, auto-scroll | unit PASS | N/A | 핵심 범위 선택 PASS | PASS |
| AUD-GRID-03 | Columns | 검색, chooser, hide/show/reset, resize | unit PASS | N/A | 화면 확인 | PASS |
| AUD-GRID-04 | Value/Page | full value, 이전/다음 page | unit PASS | PASS | 화면 확인 | PASS |
| AUD-COPY-01 | Copy menu | main copy, preset, headers, settings | PASS | PASS | 실제 menu/copy PASS | PASS |
| AUD-COPY-02 | Copy dialog | preset과 Custom controls, preview, Cancel/Apply | PASS | settings round-trip PASS | 실제 Apply PASS | PASS |
| AUD-COPY-03 | Clipboard | 2셀 선택과 custom delimiter | PASS | serializer PASS | Windows clipboard PASS | PASS |
| AUD-CSV-01 | Profile selection | 재선택 해제, Ctrl/Shift/Ctrl+A, filtered selection | PASS | N/A | checkbox/hover 화면 확인 | PASS |
| AUD-CSV-02 | Type controls | 타입별 동적 control 노출 | PASS | 20개 조합 PASS | UInt64 PASS | PASS |
| AUD-CSV-03 | Numeric | None/comma/dot/space, 충돌, preview/apply/page/query | PASS | 20개 조합 PASS | comma/dot/space PASS | PASS |
| AUD-CSV-04 | Bulk details | trim, tokens, date/timezone, policy, reset/undo | PASS | PASS | 대표 흐름 PASS | PASS |
| AUD-CSV-05 | Preview | Raw/Converted, debounce, stale, invalid/null/empty | PASS | PASS | converted preview PASS | PASS |
| AUD-CSV-06 | Validation | 검증, 취소, 실패 확인, Apply/Cancel 원자성 | PASS | PASS | Apply PASS | PASS |
| AUD-QUERY-01 | Search | Find/Filter, option, previous/next | PASS | PASS | 화면 확인 | PASS |
| AUD-QUERY-02 | Filter | typed operator, distinct, Clear/Cancel/Apply | PASS | PASS | `> 50000000000` PASS | PASS |
| AUD-QUERY-03 | Sort | asc/desc/clear, multi-sort, nulls-last | PASS | PASS | UInt64 desc PASS | PASS |
| AUD-QUERY-04 | Lifecycle | progress, cancel, disk-limit, stale result | unit PASS | PASS | 10M product test PASS | PASS |
| AUD-SET-01 | Settings | Auto/All Text/Ask, 저장, Escape, focus | PASS | round-trip PASS | 기존 화면 PASS | PASS |
| AUD-SET-02 | Storage | limit 경계, invalid, temp clear | PASS | PASS | 기존 temp clear PASS | PASS |
| AUD-LAYOUT-01 | Responsive | 1440x900, 1024x768, 800x600 clipping 0 | PASS | N/A | 3 viewport PASS | PASS |
| AUD-A11Y-01 | Accessibility | name, role, focus trap/복원, keyboard menu | PASS | N/A | CDP locator PASS | PASS |
| AUD-NATIVE-01 | Windows | dialog, drop, association, clipboard, DPI, Excel | N/A | N/A | 일부 BLOCKED | BLOCKED |

`AUD-NATIVE-01`의 BLOCKED 항목은 OS drag-and-drop, 설치본 Explorer file association,
150% DPI, 실제 Excel 붙여넣기다. 설치 환경을 변경하지 않고는 재현할 수 없어 Browser PASS로
대체하지 않았다.

## 발견 및 수정한 결함

| ID | 심각도 | 재현 | 상태 |
| --- | --- | --- | --- |
| BUG-CSV-SEP-01 | HIGH | UInt64에서 Thousands `.` 응답을 TypeScript가 invalid로 거부 | FIXED, native release PASS |
| BUG-CSV-AUTO-01 | HIGH | Auto가 Float/Decimal로 해석된 뒤 decimal과 thousands가 충돌 | FIXED, Rust typed error PASS |
| BUG-CSV-LAYOUT-01 | MEDIUM | 800x600 profile bulk toolbar control clipping | FIXED, 3 viewport PASS |
| BUG-CSV-FOCUS-01 | MEDIUM | 비동기 profile 로딩 뒤 Escape 시 trigger focus 미복원 | FIXED, Playwright PASS |
| BUG-QUERY-CLAMP-01 | MEDIUM | distinct 로딩 후 filter popover가 800x600 하단을 2px 초과 | FIXED, geometry PASS |
| BUG-TEST-STATE-01 | MEDIUM | native test가 실제 사용자 copy settings를 변경 | FIXED, 시작 snapshot 자동 복원 PASS |

## 증거

- Browser: `browser-wide.png`, `browser-compact.png`, `browser-minimum.png`
- Native: `release-native-{comma,dot,space}.png`, `final-release.png`
- 대형 데이터: `../large-benchmark.md`, `../product-large-test.md`
- 다중 process: `../multi-process-results-final-release.json`
