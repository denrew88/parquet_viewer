# Phase 0 Test Plan

## 완료 조건

- `C0-1`: 문서화된 명령으로 설치·빌드·실행 가능
- `C0-2`: Rust 품질 검사 통과
- `C0-3`: 프런트엔드 품질 검사 통과
- `C0-4`: 빈 workspace와 `health_check` 동작
- `C0-5`: 세 viewport UI 검증
- `C0-6`: 실제 Tauri 개발 앱 smoke 또는 정확한 BLOCKED 근거

## 테스트 행렬

| ID | 조건 | 계층 | 입력 | 기대 결과 | 담당 | Native |
| --- | --- | --- | --- | --- | --- | --- |
| `T-P0-001` | C0-1 | 정적 계약 | manifests, lockfiles, 명령 문서 | 설치·개발·품질·빌드 명령과 lockfile 존재 | 루트·Quality | 아니오 |
| `T-P0-002` | C0-1 | clean install | 빈 `node_modules`, `target` | `npm ci`가 lockfile 변경 없이 성공 | Quality | 아니오 |
| `T-P0-003` | C0-1 | desktop build | 설치 완료 workspace | installer 없이 Tauri executable compile 성공 | Tauri·Quality | 아니오 |
| `T-P0-004` | C0-2 | Rust format | 전체 Rust source | `cargo fmt --check` 성공 | Tauri·Quality | 아니오 |
| `T-P0-005` | C0-2 | Rust lint | 모든 target·feature | clippy가 warning 없이 성공 | Tauri·Quality | 아니오 |
| `T-P0-006` | C0-2,C0-4 | Rust unit | app version | `health_check`가 `ok`와 버전 반환 | Tauri | 아니오 |
| `T-P0-007` | C0-2,C0-4 | Rust 회귀 | Cargo version | 응답 버전이 package version과 일치 | Tauri | 아니오 |
| `T-P0-008` | C0-3 | frontend format | TS·TSX·설정 | format check 성공 | Grid·Quality | 아니오 |
| `T-P0-009` | C0-3 | frontend lint | 전체 frontend | warning을 우회하지 않고 lint 성공 | Grid·Quality | 아니오 |
| `T-P0-010` | C0-3 | frontend typecheck | production·test TS | emit 없이 typecheck 성공 | Grid·Quality | 아니오 |
| `T-P0-011` | C0-3,C0-4 | frontend unit | 성공 adapter mock | health 결과를 status에 표시 | Grid | 아니오 |
| `T-P0-012` | C0-3,C0-4 | frontend 오류 | 실패 adapter mock | 빈 화면 없이 오류 상태 표시 | Grid | 아니오 |
| `T-P0-013` | C0-3 | production build | frontend source | 정적 asset 생성 성공 | Grid·Quality | 아니오 |
| `T-P0-014` | C0-4 | Browser interaction | 성공 mock | toolbar·empty workspace·status 표시 | Quality | 아니오 |
| `T-P0-015` | C0-4 | 접근성 | keyboard focus | open control 이름과 visible focus 제공 | Grid·Quality | 아니오 |
| `T-P0-016` | C0-4 | Browser 오류 | 실패 mock | workspace 유지, status만 오류 전환 | Quality | 아니오 |
| `T-P0-017` | C0-5 | geometry | 1440x900 | overlap·clipping·document overflow 없음 | Quality | 아니오 |
| `T-P0-018` | C0-5 | geometry | 1024x768 | control과 text가 부모 영역 내부 | Quality | 아니오 |
| `T-P0-019` | C0-5 | geometry | 800x600 | open affordance와 status가 잘리지 않음 | Quality | 아니오 |
| `T-P0-020` | C0-5 | visual | 세 viewport screenshot | workspace 계층·대비·정렬이 명확 | Quality | 아니오 |
| `T-P0-021` | C0-4,C0-6 | native smoke | `npm run tauri dev` | 실제 invoke와 workspace 표시 | Tauri·Quality | 예 |
| `T-P0-022` | C0-5,C0-6 | native visual | 실제 Tauri desktop 창 | blank·asset 오류·clipping 없음 | Tauri | 예 |
| `T-P0-023` | C0-1,C0-6 | capability audit | Tauri 설정 | 불필요한 shell·filesystem 권한 없음 | Quality | 아니오 |

## Geometry Assertion

- `documentElement.scrollWidth <= innerWidth + 1`
- `documentElement.scrollHeight <= innerHeight + 1`
- toolbar, workspace, status 경계 겹침이 1 CSS px 이하
- toolbar·status control의 `scrollWidth <= clientWidth + 1`
- workspace 높이가 양수이고 status 하단과 root 하단 차이가 1 CSS px 이내
- Phase 0에는 grid, tab, selection, virtualization geometry를 적용하지 않음

## UI 증거

```text
artifacts/phase-0/ui/browser-desktop.png
artifacts/phase-0/ui/browser-compact.png
artifacts/phase-0/ui/browser-minimum.png
artifacts/phase-0/ui/visual-review.md
artifacts/phase-0/ui/geometry-results.json
artifacts/phase-0/ui/interaction-results.md
artifacts/phase-0/ui/native-desktop.png
artifacts/phase-0/ui/native-smoke.md
```

`T-P0-021`과 `T-P0-022`를 실행할 수 없으면 PASS로 추정하지 않고 재현 명령, 로그, 환경
조건과 함께 BLOCKED로 기록한다.
