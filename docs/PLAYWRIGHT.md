# Playwright 테스트 가이드

이 문서는 브라우저에서 재현 가능한 Data Viewer UI를 Playwright로 검증하는 실행 방법과 작성
규칙을 정의한다. 전체 UI 품질 계약과 네이티브 검증 경계는 `docs/UI_VALIDATION.md`를 따른다.

## 환경 구성

Node 의존성과 Chromium을 설치한다. Chromium 바이너리는 Playwright가 관리하는 사용자 캐시에
설치되며 Git에 포함하지 않는다.

```powershell
npm ci
npm run playwright:install
```

현재 Playwright 프로젝트는 Chromium만 사용한다. Firefox나 WebKit을 추가하려면 실제 지원
범위와 CI 비용을 먼저 문서화한다.

## 실행 명령

```powershell
# headless 전체 E2E와 세 viewport
npm run test:e2e

# 브라우저 창을 보면서 디버깅
npm run test:e2e:headed

# 마지막 HTML report 열기
npm run test:e2e:report

# 한 파일 또는 한 project만 실행
npm run test:e2e -- e2e/csv-profile.spec.ts
npm run test:e2e -- --project=desktop-minimum
```

`playwright.config.ts`가 Vite 개발 서버를 `127.0.0.1:1420`에서 자동 시작한다. 이미 같은 서버가
실행 중이면 로컬에서는 재사용하고 CI에서는 새 서버만 허용한다.

## 테스트 구조

- E2E 파일은 `e2e/*.spec.ts`에 둔다.
- 브라우저에서는 `src/backend.ts`의 `browserMockBackend`를 사용한다.
- `?mock=csv`, `?mock=error` 같은 명시적 scenario로 시작 상태를 고정한다.
- 대용량 논리 row 검증은 실제 row 배열을 만들지 않는 `?mock=largeRows` 계열 scenario로 행 수와
  target page를 결정적으로 고정한다.
- CSS class보다 `role`, accessible name, `aria-*`를 우선 locator로 사용한다.
- click 성공만 확인하지 않고 선택 좌표, 상태 값, option 목록, scroll 또는 clipboard 결과를
  assertion으로 확인한다.
- UI 변경에는 최소한 영향받는 상호작용 하나와 geometry assertion을 함께 추가한다.
- 시간 대기 대신 locator와 상태 기반 대기를 사용한다.

기본 project는 `1440x900`, `1024x768`, `800x600` 세 viewport다. 공통 테스트는 세 project에서
같이 실행해 responsive 회귀를 잡는다.

Phase 11의 segmented grid 테스트는 최소한 5,850,000행의 986,803 전후와 실제 마지막 행,
10,000,000행의 first/middle/last를 검증한다. status의 논리 row, target page request 수, active cell,
focus visibility와 physical `scrollHeight` 상한을 함께 assertion한다. 실제 row 수만 큰 mock을 사용하고
브라우저 메모리에 전체 row fixture를 만들지 않는다. multiline 문자열은 LF/CRLF와 literal `\n`을
구분하고 같은 고정 row 높이, 최대 2줄 clamp와 전체 값 보기를 geometry assertion으로 확인한다.

타입별 display 설정 테스트는 timestamp `YYYY-MM-DD HH24:MI:SS.F...`, timezone annotation 제거,
소수초 정밀도, raw cell detail과 기본/displayed/raw copy 결과를 별도로 확인한다. Browser clipboard
mock 결과는 실제 Windows clipboard PASS로 간주하지 않는다.

Column auto-fit은 header resize separator에 실제 `dblclick`을 보내고 column menu의 keyboard action과
같은 결과인지 비교한다. header와 loaded/cached display 값만으로 계산됐는지 backend command count 0을
assertion하고, LF/CRLF의 가장 긴 줄, literal `\n`, font/padding/action allowance와 80..800 px clamp를
검증한다. 새 page나 display setting 변경만으로 width가 바뀌지 않고 명시적 재실행 때만 갱신되는지도
확인한다. row height auto-fit 시나리오는 작성하지 않는다.

## 증거와 실패 분석

- 로컬 결과: `playwright-report/`
- 실패 trace, screenshot, video: `test-results/`
- 두 디렉터리는 생성물이며 `.gitignore` 대상이다.
- 성공 screenshot은 HTML report attachment로 남긴다.
- Phase 완료 증거가 필요하면 검토가 끝난 최종 이미지만 `artifacts/phase-N/ui/`에 옮기고
  `interaction-results.md`, `geometry-results.json`, `visual-review.md`와 연결한다.
- 기준 이미지는 의도된 UI 변경을 검토한 뒤에만 갱신한다.

실패 trace는 다음 명령으로 연다.

```powershell
npm.cmd exec playwright show-trace <trace.zip 경로>
```

## Tauri 검증 경계

Playwright 테스트는 React UI, 브라우저 모의 백엔드, DOM geometry와 keyboard/mouse 상호작용을
검증한다. 다음 항목은 Playwright PASS만으로 완료하지 않는다.

- 네이티브 파일 대화상자와 OS drag and drop
- 파일 연결과 Explorer 더블클릭
- 실제 시스템 clipboard와 Excel 붙여넣기
- WebView2, Windows DPI, installer 환경
- WebView2의 최대 scroll 범위와 native horizontal scrollbar에 접한 실제 마지막 행 geometry
- 여러 독립 Tauri process의 창과 resource 생명주기

이 항목은 실제 Tauri 실행 또는 설치본 smoke 결과를 별도로 기록한다.

### Windows WebView2 CDP smoke

제품 설정에 원격 디버깅 포트를 넣지 않는다. `src-tauri/tauri.playwright.conf.json`은 테스트
빌드에서만 `9333` 포트를 사용하며 별도 WebView data directory를 사용한다.

```powershell
npm run test:native:build
npm run test:native:smoke
```

`scripts/native_cdp_smoke.mjs`는 실제 Rust IPC와 WebView2를 사용해 CSV profile, sort/filter,
grid selection과 Windows clipboard를 검증한다. 시작 시 app settings snapshot을 읽고 성공이나
실패와 무관하게 종료 전에 원래 값을 복원한다. 최종 배포 빌드는 일반 `npm run tauri -- build`로
다시 만들고 `remote-debugging-port`가 없는지 확인한다.
