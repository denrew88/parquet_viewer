# Phase 8 범위: 컨텍스트 메뉴, 다중 실행, 다중 문서

- 상태: 구현 및 자동/native 검증 완료, 필수 Browser·설치 환경 gate BLOCKED (2026-07-15)
- 작성일: 2026-07-14
- 선행 조건: Phase 0~7 구현 결과와 Phase 6 선택·클립보드 계약
- 상세 설계: `20-ux-design.md`, `30-platform-design.md`
- 테스트 기준: `10-test-plan.md`

## 목표

1. 셀 선택을 보존하는 키보드 접근 가능한 컨텍스트 메뉴를 제공한다.
2. 설치된 Data Viewer를 여러 독립 프로세스로 동시에 실행할 수 있게 한다.
3. 한 창에서 CSV와 Parquet 파일을 문서 탭으로 열고 상태와 자원을 격리한다.

## 확정 제품 계약

### 컨텍스트 메뉴

- 현재 선택 안의 셀을 우클릭하면 선택을 유지하고, 밖의 셀을 우클릭하면 그 셀을 단일
  선택한 뒤 메뉴를 연다.
- `Shift+F10`과 Context Menu 키는 active cell을 대상으로 같은 메뉴를 연다.
- MVP 액션은 `복사`, `열 이름 포함 복사`, `셀 값 복사`, `전체 값 보기`다.
- 복사 액션은 Phase 6의 TSV quoting, chunk 조회, soft/hard limit, progress, cancel, 원자적
  clipboard write를 재사용한다. 별도 복사 구현을 만들지 않는다.
- 메뉴는 viewport 안에 flip/clamp하며 `Escape`, click-away, scroll, resize, 문서 또는 뷰
  전환 시 닫는다. 종료 후 grid focus와 논리 선택을 보존한다.

### 다중 프로세스

- single-instance 플러그인과 두 번째 실행 전달 경로를 제거한다.
- executable, 바로가기, 시작 메뉴, 파일 연결로 시작한 각 invocation은 독립 PID와 창을 만든다.
- 프로세스 간 session, worker, cache, 활성 문서 상태는 공유하지 않는다.
- 파일 연결 또는 startup argv에 여러 경로가 한 invocation으로 들어오면 그 새 창의 문서
  탭으로 연다. Explorer가 invocation을 여러 개로 나누면 여러 프로세스로 여는 OS 동작을
  그대로 허용한다.

### 다중 문서 탭

- 문서 탭은 `Data`/`Schema`/`Metadata` 뷰 탭의 상위 계층이다.
- 한 프로세스의 열린 문서 방어 상한은 64개다. 8개는 일반 사용 검증 기준이며 최대치가
  아니다. 열린 탭을 자동 퇴출하지 않으며 65번째 item만 `TooManyOpenDocuments`로 거부한다.
- dialog, drop, startup argv는 한 요청에 최대 32개 경로를 받고 입력 순서를 보존한다.
  성공 item은 유지하고 실패 item은 파일별 오류로 반환한다.
- batch에서 입력 순서상 첫 성공 또는 재사용 문서를 활성화한다. 전부 실패하면 기존 활성
  문서를 유지한다.
- 같은 프로세스에서 같은 canonical path를 다시 열면 중복 문서를 만들지 않고 기존 탭을
  활성화한다. 다른 프로세스에서는 독립적으로 열 수 있다.
- 문서별로 활성 뷰, page/scroll, selection, 컬럼 폭·숨김·검색, loading/error, worker, cache,
  copy 작업을 보존하고 격리한다.
- 활성 탭을 닫으면 오른쪽 이웃, 없으면 왼쪽 이웃을 활성화한다. 마지막 탭을 닫으면 empty
  workspace로 돌아간다.
- `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+W`와 접근 가능한 tablist 키보드 동작을 제공한다.
- 탭은 한 줄 가로 strip으로 유지하고 overflow control을 제공한다. reorder, pin, middle-click
  close, 창 간 탭 이동, session restore는 이번 범위가 아니다.

## 기술 계약

- `AppState`의 단일 `SessionSlot<DataSource>`를 `DocumentRegistry`로 교체한다.
- 탭 수명인 `documentId`와 source generation인 `sessionId`를 분리한다. 모든 데이터 command는
  두 ID를 검증한다.
- registry lock은 조회·예약·insert/remove에만 사용하고 I/O, decode, worker join 중에는 잡지
  않는다. 문서별 `Arc`/lock/cancel token으로 격리한다.
- source prepare와 CSV worker 동시 실행은 각각 4개로 제한한다.
- cache는 문서당 8 pages, 프로세스 전체 64 pages 또는 추정 256 MiB 중 먼저 도달하는 상한을
  사용한다. cache만 LRU 회수하며 열린 탭을 자동으로 닫지 않는다.
- 전역 `last-started-wins` open coordinator를 제거하고 request/item별 예약과 commit을 사용한다.
- close는 해당 문서의 open/page/copy/index 작업만 취소하고 handle, worker, cache를 정확히 한
  번 해제한다. 늦은 응답은 닫힌 문서나 다른 문서에 적용하지 않는다.
- release/installer 앱은 HTTP 서버나 port를 사용하지 않는다. 개발 모드는 Vite 1420 서버를
  하나만 실행하고 여러 debug 앱 프로세스가 공유하며, 실제 다중 실행 gate는 release에서 한다.
- 1,000만 행×10열 Parquet를 저카디널리티·반복 데이터와 고카디널리티 데이터 두 fixture로
  생성해 전체 materialize 없이 탐색한다. 두 fixture는 같은 논리 스키마와 row-group 설정을
  사용한다. 저카디널리티의 약 50MiB는 참고 예상값이며 어느 fixture도 파일 크기를 PASS
  조건으로 사용하지 않고 실제 byte size, 압축률과 column encoding을 manifest에 기록한다.

## 역할과 소유권

| 역할 | 책임 | 주요 소유 영역 |
| --- | --- | --- |
| Root Orchestrator | 계약, DTO 순서, 통합, 최종 판정 | 공통 문서, 공통 DTO, integration artifact |
| Quality Agent | 구현 전/후 독립 테스트, fixture, UI·native 증거 | `artifacts/phase-8/`, E2E/인수 테스트 |
| Rust Data Agent | document registry, session/cache/worker 수명주기 | Rust data/session 모듈과 unit test |
| Tauri Platform Agent | multi-process, startup/association, IPC | Tauri bootstrap, command, installer/native test |
| Grid UX Agent | document tab store, context menu, focus/keyboard | React grid/shell/component test |

공통 DTO, `Cargo.toml`, lockfile, `lib.rs`, 앱 최상위 store는 한 시점에 한 Agent만 수정한다.
병렬 작업은 DTO 계약이 고정된 뒤 고유 모듈로 나눈다.

## 제외 범위

- 셀 편집, 삭제, 붙여넣기로 원본 수정
- filter/sort/export를 수행하는 컨텍스트 메뉴
- 한 프로세스의 여러 native window와 창 사이 탭 이동
- 탭 reorder, pin, session restore, 최근 파일
- 열린 탭 상한을 넘기기 위한 자동 LRU close

## 완료 판정

`10-test-plan.md`의 자동, Browser, 실제 Tauri, installer, 다중 PID, association, soak 증거가
모두 준비되어야 완료다. 실행하지 못한 native/UI 필수 검증은 하위 계층 테스트로 대체하지
않고 `BLOCKED`로 기록한다.
