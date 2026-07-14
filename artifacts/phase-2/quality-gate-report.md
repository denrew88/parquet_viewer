# Phase 2 독립 품질 게이트

- 검토일: 2026-07-14
- 검토 범위: `T-P2-001`~`T-P2-044`
- 최종 권고: **FAIL**

## 독립 실행 결과

| 검증 | 결과 |
| --- | --- |
| `npm run format -- --check` | PASS |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test -- --run` | 42/42 PASS |
| `npm run build` | PASS |
| `cargo fmt --check` | PASS |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo test` | 42/42 PASS |
| `npm run tauri build -- --no-bundle` | PASS |

첫 release build 시 실행 중인 `data-viewer.exe`가 산출물을 잠가 실패했으나, 검증 창을 종료한 뒤 같은 명령을 다시 실행해 PASS를 확인했다.

in-app Browser는 Browser Skill 절차로 독립 재확인했다. `agent.browsers.list()`가 빈 목록을 반환했으며 bootstrap troubleshooting 확인 후에도 사용할 backend가 없었다. standalone Playwright로 대체하지 않았다.

## ID별 판정

| ID | 판정 | 근거 |
| --- | --- | --- |
| `T-P2-001`~`T-P2-004` | PASS | `phase2_tests.rs`의 row group 경계, 교차 경계, 마지막 행, EOF 테스트가 통과했다. |
| `T-P2-005` | FAIL | 테스트가 `planned_row_groups` 결과만 확인한다. 계획에서 요구한 실제 decode 계측과 EOF decode 0회는 검증하지 않는다. |
| `T-P2-006`~`T-P2-017` | PASS | projection 순서/상한/오류, page 상한, 정수·decimal·date·timestamp·binary·list 직렬화 테스트가 통과했다. |
| `T-P2-018` | FAIL | struct 필드 순서와 정밀도는 확인하지만, 계획에 명시된 중첩 struct와 struct null canonical 표시를 fixture/assertion이 검증하지 않는다. |
| `T-P2-019`~`T-P2-020` | PASS | 정밀도 값이 JSON string임과 row group 행 수 `[2,3,1]`을 확인한다. |
| `T-P2-021` | FAIL | codec과 통계 열 수는 확인하지만 크기는 `> 0`만 검사한다. 계획의 codec·크기·통계 "정확" 검증 중 크기 정확값 검증이 없다. |
| `T-P2-022`~`T-P2-027` | PASS | cache hit/key/8-entry LRU/close·replace 해제와 command projection·EOF·상한 테스트가 통과했다. |
| `T-P2-028`~`T-P2-034` | PASS | stale 성공/실패 차단, 첫·중간·마지막 페이지, loading 중 grid 유지, DTO/EOF/type/metadata component 테스트가 통과했다. |
| `T-P2-035`~`T-P2-041` | BLOCKED | in-app Browser backend 부재로 interaction, DOM geometry, 1440/1024/800 screenshot을 수행할 수 없다. 필수 browser 증거 파일도 없다. |
| `T-P2-042` | BLOCKED | 실제 dialog와 첫 페이지 IPC/type 표시는 확인했지만 native Next/Prev와 마지막 201~240행, Metadata 화면 검증은 완료되지 않았다. 자동화 중 WebView 창 핸들이 소멸해 추가 캡처가 없으며 이를 PASS로 대체할 수 없다. |
| `T-P2-043` | PASS | 실제 Windows WebView의 `ui/native-desktop.png`가 존재하고 파일명, 240행/6열, 1~200 범위, Next 활성 상태를 육안 확인했다. |
| `T-P2-044` | FAIL | 필수 항목에 FAIL과 BLOCKED가 남아 전체 gate를 통과하지 못한다. |

## 발견사항

1. **테스트 계획과 실제 Rust 검증 간 공백**: `T-P2-005`, `T-P2-018`, `T-P2-021`은 구현이 틀렸다고 단정할 증거는 없지만, 계획에 적힌 행위를 현재 테스트가 증명하지 못한다. 해당 계측/fixture/assertion을 추가해야 한다.
2. **Browser 필수 증거 부재**: `browser-desktop.png`, `browser-compact.png`, `browser-minimum.png`가 없고 geometry/interaction 문서는 backend 부재를 기록한다. UI 계약상 native screenshot으로 대체할 수 없다.
3. **Native page 전환 증거 미완료**: `native-desktop.png`는 첫 페이지 품질을 보여주지만 Next/Prev IPC와 마지막 페이지, Metadata native smoke를 증명하지 않는다. `native-smoke.md`의 해당 BLOCKED 판정은 타당하며 PASS로 승격할 수 없다.

## 해제 조건

- 실제 decode 횟수 계측, 중첩/null struct, 정확한 row group size assertion을 추가하고 Rust 전체 테스트를 재실행한다.
- Browser backend가 제공되는 환경에서 `T-P2-035`~`T-P2-041`과 3개 viewport 증거를 수집한다.
- 실제 Tauri 창에서 Next/Prev로 201~240행을 확인하고 Metadata까지 포함한 native smoke 기록과 증거를 남긴다.

