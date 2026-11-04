# 소수 GiB Storage 입력 수정

2026-11-04. 0.3GiB 입력·저장·재열기·실제 backend 적용 PASS.

## 원인과 수정

`0.3 * 1024^3 = 322122547.2`에 정수 byte 조건을 직접 적용해 정상적인 소수 GiB를 거부했다. HTML input도 step=0.0625로 제한했다.

범위(64MiB~10GiB)는 원래 입력값으로 먼저 검사하고, 저장할 때 가장 가까운 정수 byte로 반올림한다. input step은 any로 바꿨다. 재열기 시 저장된 byte로 정확히 되돌아가는 짧은 GiB 소수를 표시해 0.3이 긴 소수로 변하거나 재적용으로 byte가 바뀌지 않게 했다. Rust DTO·한도 정책·의존성 변경은 없다.

## 검증

- component 22개 및 전체 frontend **414 PASS**. 0.1/0.3/1.1/최소/최대의 정수 byte 저장·재열기 동일성과 범위 바로 밖 입력 거부를 확인했다. 루트 실행 tool session 11500의 결과이며 원시 stdout 파일은 별도 보존하지 않았다.
- format, 전체 lint(생성 .tmp 제외), typecheck, Vite production build PASS. 기존 Vite chunk-size 경고는 유지했다.
- 전체 Playwright 최초 실행 **122 PASS / 1 FAIL**. 0.3 설정은 3개 viewport 모두 통과했다. 실패한 Phase 16 Retry test를 그대로 재실행해 이전 쿼리 첫 페이지의 늦은 readQueryPage 요청이 counter에 섞이는 것을 확인했다.
- Phase 16 계약은 새 Data 상호작용 차단이며 모든 기존 background 작업의 전역 중지가 아니다. query 시작만 기다리던 테스트에 실제 첫 페이지 요청·query ID·로딩 종료·결과 셀 표시 완료 조건을 추가했다. 원래 차단 카운터 동일성 단언을 유지했고 임의 sleep은 넣지 않았다.
- 이후 해당 Retry 시나리오와 settings를 3개 viewport에서 실행해 **6/6 PASS**. 최초 122건과 수정 후 한정 재실행으로 전체 123개 시나리오의 통과를 확인했으며, 한 번의 깨끗한 123/123 실행이라고 표시하지 않는다. 원시 실행·실패·진단 로그는 이 폴더에 로컬 보존했다.
- 세 viewport의 [1440](ui/storage-1440.png), [1024](ui/storage-1024.png), [800](ui/storage-800.png) 화면과 geometry JSON을 보존했다. 기존 Phase 원본은 복원했으며, regression/의 중복 캡처와 임시 WebView·HTML report는 후속 정리에서 제거했다.
- [실제 Tauri 결과](native-result.json): UI에 0.3 입력 → Apply → get_settings와 get_query_temp_usage가 **322122547 bytes** → 재열기 0.3 → 새 CSV 준비 Ready와 실제 페이지 값 1/2/3 확인. 최소값 바로 아래·최대값 바로 위 UI 거부도 확인했다. 원래 설정은 복원했다. [Native 화면](ui/native-0.3.png).
- [독립 검토](95-review.md)에서 코드·시각·geometry·native 해시·재실행 증거를 검토한다.

## 실행 파일

[data-viewer.exe](../../../src-tauri/target/release/data-viewer.exe), 58,785,792 bytes.

SHA-256: `d34e48c7a0f04c69166fc7cb2b10e58b926792e0824059ae65319a65f7e62a03`

정상 빌드 환경에서 새 frontend dist를 포함해 빌드했다. backend 소스는 직전 Storage 수정의 314개 Rust 테스트 통과본과 같다. 새 Rust 동작 변경이 없어 전체 Rust suite는 반복하지 않았다. Phase 완료·installer·외부 release 게시를 수행하지 않았다.

재현은 node_modules의 Vitest/TypeScript/ESLint/Vite CLI를 사용한다(npm 실행 파일이 없는 현재 도구 PATH에서도 동작). Playwright는 playwright.config.ts의 기존 프로젝트/검증을 유지하고 Vite 시작 명령만 Node 직접 실행으로 지정했다. 현재 버전 Chromium은 workspace .tmp/playwright-browsers에 설치했다. 실제 앱 검증 명령은 `node artifacts/phase-20/storage-pressure/native_files.mjs decimal`이다.
