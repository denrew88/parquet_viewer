# Phase 8 구현 순서

- 상태: 8A~8E 구현 및 자동/native 검증 완료, 필수 Browser·설치 환경 gate BLOCKED (2026-07-15)
- 원칙: Quality 테스트 기준선을 먼저 고정하고 아래 순서를 지킨다.

## 8A. 공통 계약과 DocumentRegistry

**목표:** UI를 바꾸기 전에 여러 문서를 안전하게 보존하는 데이터 계층을 만든다.

### 구현

- `DocumentId`, `SessionId`, batch open DTO, typed error를 Rust/TypeScript에 추가
- 단일 `SessionSlot`을 문서별 handle을 가진 `DocumentRegistry`로 이관
- 64개 slot reservation, 32개 batch, canonical path dedupe, 부분 성공, 결정적 입력 순서 구현
- 문서별 page cache, CSV worker, cancel, close와 stale session 검사 구현
- 기존 단일 파일 command를 임시 adapter로 유지한 뒤 새 API 전환 후 제거

### 테스트

- 8개 일반 사용과 64/65개 경계, close 후 slot 재사용, canonical path dedupe
- 서로 다른 문서의 page/cache/worker/session 격리
- slow/fast open, 부분 실패, close/read/configure/copy 경쟁과 late result 폐기
- registry lock을 잡은 I/O/join 부재와 정확히 한 번 drop

## 8B. 파일 열기와 다중 프로세스

**목표:** 모든 파일 진입점을 batch 계약으로 통합하고 invocation마다 독립 프로세스를 만든다.

### 구현

- native dialog multi-select, multi-drop, multi-path startup argv 연결
- single-instance plugin, callback, `SecondInstance` producer와 의존성 제거
- startup pending queue를 cold argv 전용으로 유지
- file association과 installer 회귀 설정 갱신

### 테스트

- dialog/drop/startup의 CSV+Parquet 입력 순서, 부분 실패, 중복 경로
- release exe 2~5회 실행의 실제 PID/window 독립성
- 기존 앱 실행 여부와 무관한 association 새 PID, Unicode·공백 경로
- 한 프로세스 종료가 다른 프로세스에 영향을 주지 않는지 확인

## 8C. 문서 탭 UI

**목표:** 한 창의 여러 문서 UI 상태를 격리하고 빠르게 전환·종료한다.

### 구현

- 문서 collection과 `activeDocumentId`를 가진 store 작성
- 각 문서에 summary/page/view/scroll/selection/column/loading/error/generation 상태 귀속
- 문서 tablist, 닫기, overflow, active tab auto-scroll 구현
- `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+W`, Arrow/Home/End와 roving tabindex 구현
- backend batch 결과와 loading/error tab을 `clientTabId`로 결합

### 테스트

- 탭 전환 왕복 시 모든 per-document 상태 복원
- active/inactive/last close 규칙과 focus 복귀
- stale page/progress/error/clipboard 결과의 wrong-tab 적용 0
- 1440×900, 1024×768, 800×600 geometry와 8-tab overflow

## 8D. 셀 컨텍스트 메뉴

**목표:** 선택과 가상화를 깨지 않고 기존 명령을 pointer와 keyboard에서 실행한다.

### 구현

- 우클릭 대상과 선택 보존 reducer/event 계약 구현
- portal 기반 menu, viewport flip/clamp, click-away와 lifecycle close 구현
- 네 MVP 액션을 기존 copy/full-value pipeline에 연결
- `Shift+F10`, Context Menu 키, Arrow/Home/End, Enter/Space, Escape와 focus 복원 구현

### 테스트

- 선택 내부/외부 우클릭, row/column/all selection
- 네 액션과 Ctrl+C의 TSV byte 동일성, soft/hard limit, cancel, clipboard fault
- 가상화 unmount/remount, 모서리 collision, resize/scroll/tab switch
- role, accessible name, disabled, focus-visible과 keyboard interaction

## 8E. 통합, 성능, 배포 검증

**목표:** 다중 문서와 다중 프로세스가 자원 상한과 설치본 계약을 지키는지 증명한다.

### 구현 및 검증

- frontend format/lint/typecheck/test/build, Rust fmt/clippy/test, release/NSIS build
- Browser 세 viewport interaction, geometry, screenshot과 이미지 검토
- 실제 Tauri 100%/150% scale context menu와 clipboard hash
- 8-tab open/switch/copy/close 100 cycle, 다중 PID 총 100 invocation soak
- 기존 Phase 7 release generator의 500만 행 설정을 1,000만 행 Parquet 목표와 분리·교정하고,
  같은 10열 논리 스키마와 row-group 설정으로 저카디널리티·반복 데이터와 고카디널리티
  fixture를 각각 생성한다. 실제 byte size, 압축률과 column encoding을 manifest에 기록하되
  크기는 PASS 조건으로 두지 않고 두 fixture 모두 checksum 기반 page/projection 검증과
  release 성능을 측정한다.
- installer install/association/upgrade/uninstall/reinstall 회귀
- 측정 결과와 미실행 검증을 `50-integration.md`, `90-review.md`에 기록

## 병렬화 기준

8A의 DTO와 registry 계약이 확정되기 전에는 8B와 8C를 구현하지 않는다. 그 뒤 Platform은
8B, Grid UX는 8C/8D, Rust Data는 worker/cache 경계 테스트, Quality는 fixture와 독립 harness를
병렬 진행할 수 있다. Root만 공통 DTO와 최상위 통합 파일을 병합한다.
