# 개발 계획

## 2026-07-17 최신 실행 상태

- Phase 0~8 제품 구현과 실행 가능한 자동 gate를 모두 실행했다.
- frontend 266 tests, Playwright 24 tests, Rust 127 tests, format/lint/typecheck/clippy/build가 PASS했다.
- Phase 8은 single-instance를 제거하고 5개 프로세스 x 20 cycle의 총 100 invocation을
  같은 파일로 실행해 독립 PID/window를 확인했다.
- 저·고카디널리티 1,000만 행 x 10열 Parquet fixture 생성·감사, Rust 데이터 계층
  release benchmark와 100회 open/read/close soak가 PASS했다.
- 실제 Tauri에서 다중 탭, 8-tab overflow, 컨텍스트 메뉴, Windows clipboard 복사를 확인했다.
- browser mock과 Playwright Chromium의 24개 시나리오가 1440x900, 1024x768, 800x600에서
  PASS했다. 150% DPI, 실제 Excel, clean VM installer/association 검증은 아직 BLOCKED다.
- 제품 코드와 자동 테스트의 알려진 FAIL은 없다. 각 단계의 최신 판정은 `artifacts/phase-N/90-review.md`를 따른다.
- Phase 9의 9A~9F 제품 구현, 10M 저·고카디널리티 제품 query, 100 invocation
  multi-process와 최종 release/NSIS build가 PASS했다.
- Phase 9 구현과 실행 가능한 Browser/Rust/native gate는 PASS다. 일부 OS/8-tab 필수 gate
  미실행 때문에 전체 완료 판정은 BLOCKED다.
- Phase 10은 단일 `time`/`wavelength` attribute와 `intensity` dataset을 사용하는 OES HDF5
  source, bounded projection, generic grid와 static HDF5/Blosc runtime 구현을 완료했다. 실제 기준
  파일과 Windows clipboard native smoke, release/NSIS build와 static binary import audit는 PASS했다.
  adversarial vlen allocation, large/performance, DPI와 clean installer gate가 남아 전체 Phase 판정은
  BLOCKED다.

이 문서는 구현 순서, 단계별 작업, 테스트, 완료 조건을 관리한다. 상세 제품 계약은
`docs/PROJECT_SPEC.md`를 따른다.

## 진행 규칙

- 단계는 Phase 0부터 Phase 10까지 순서대로 진행한다.
- 사용자 요청이 우선하지만, 선행 단계의 계약과 테스트 기반 없이 후속 기능을 임시로
  구현하지 않는다.
- 각 Phase를 시작할 때 상태를 `진행 중`으로 바꾸고 시작 날짜를 기록한다.
- 구현 전에 Quality Agent가 완료 조건을 테스트 ID, 계층, fixture, 기대 결과로 구체화한다.
- 각 구현 Agent는 소유 모듈의 단위 테스트를 코드와 함께 작성한다.
- Quality Agent는 fixture, E2E, 인수, 성능 테스트를 준비하고 통합 후 독립 검증한다.
- UI 변경은 `docs/UI_VALIDATION.md`의 browser, geometry, screenshot, 실제 Tauri 증거를
  준비해야 한다.
- 필수 테스트와 완료 조건을 모두 충족한 뒤에만 `완료`로 바꾼다.
- 실행하지 못한 테스트가 있으면 완료로 표시하지 않고 이유와 남은 위험을 기록한다.
- 구현 중 확정된 성능 제한과 설계 결정은 이 문서와 상세 명세에 반영한다.

## 현재 상태

| 단계     | 상태                                                     | 결과물                                                       |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Phase 0  | 구현 완료, UI gate BLOCKED                               | 프로젝트 기반과 품질 검사                                    |
| Phase 1  | 구현 완료, UI gate BLOCKED                               | 작은 Parquet 파일 수직 기능                                  |
| Phase 2  | 구현 및 자동 검증 완료                                   | 대용량 Parquet와 타입 지원                                   |
| Phase 3  | 구현 및 자동 검증 완료                                   | CSV 데이터 소스                                              |
| Phase 4  | 구현 및 자동 검증 완료                                   | 모든 파일 열기 경로                                          |
| Phase 5  | 구현 및 자동 검증 완료                                   | 가상화 그리드와 탐색 UI                                      |
| Phase 6  | 구현 및 자동 검증 완료                                   | Excel 방식 선택과 클립보드                                   |
| Phase 7  | 구현 및 자동 검증 완료, 일부 native/UI gate BLOCKED      | 성능, 안정성, 패키징                                         |
| Phase 8  | 구현 및 자동/native 검증 완료, 일부 UI·설치 gate BLOCKED | 컨텍스트 메뉴, 다중 실행, 다중 문서 탭                       |
| Phase 9  | 구현 완료, 필수 UI·soak gate BLOCKED                     | 포맷 registry, copy 설정, CSV profile, filter·search·sort    |
| Phase 10 | 구현 완료, 필수 security·performance·installer gate BLOCKED | OES HDF5 source, static Blosc decode와 bounded matrix paging |

Phase 0~7의 제품 코드와 자동 검증은 완료했지만 미실행 Browser 범위, 실제 Excel,
clean VM이 필요한 필수 품질 gate는 BLOCKED다. 단계별 근거는 각
`artifacts/phase-N/90-review.md`를 따른다. Phase 8의 확정 범위와 테스트 기준은
`artifacts/phase-8/00-scope.md`와 `artifacts/phase-8/10-test-plan.md`를 따른다.
Phase 9 결과는 `artifacts/phase-9/50-integration.md`와 `90-review.md`를 따른다.
Phase 10의 확정 범위와 구현 gate는 `artifacts/phase-10/00-scope.md`부터
`40-implementation-plan.md`까지를 따른다. Phase 9의 외부 환경 BLOCKED 항목은 Phase 10을
시작해도 해소된 것으로 간주하지 않으며 공통 회귀와 최종 배포 판정에서 계속 추적한다.

## Phase 0. 프로젝트 기반

**목표:** 반복 개발과 자동 검증이 가능한 Tauri 2 애플리케이션 기반을 만든다.

### 해야 할 일

- Tauri 2, React, TypeScript, Vite 프로젝트 생성
- Rust와 프런트엔드 디렉터리 책임 경계 설정
- Rust formatting, clippy, unit test 명령 구성
- 프런트엔드 formatting, lint, typecheck, unit test 명령 구성
- Tauri command 호출이 동작하는 최소 IPC smoke 기능 작성
- 빈 뷰어 workspace와 기본 오류 경계 작성
- Cargo와 프런트엔드 lockfile 커밋 대상 확인

### 테스트

- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test`
- 프런트엔드 lint, typecheck, unit test, production build
- Tauri 개발 앱 실행과 IPC smoke command 확인
- 빈 상태가 작은 창과 일반 데스크톱 창에서 잘리지 않는지 확인

### 완료 조건

- 새 환경에서 문서화된 명령으로 앱을 빌드하고 실행할 수 있다.
- Rust와 프런트엔드의 기본 품질 검사가 모두 통과한다.
- 앱이 빈 workspace를 표시하고 최소 command 호출 결과를 받을 수 있다.

## Phase 1. Parquet 수직 기능

**목표:** 작은 Parquet 파일을 선택해 메타데이터와 첫 데이터 페이지를 실제 UI에 표시한다.

### 해야 할 일

- 파일 세션, 공통 응답 DTO, 타입이 명확한 오류 모델 작성
- 네이티브 파일 대화상자와 `open_data_file` command 연결
- Parquet 형식 판별, footer, 스키마, 파일 요약 읽기
- 첫 페이지를 읽는 제한된 `read_page` 구현
- Data, Schema, Metadata 기본 화면 작성
- 파일 선택 취소, 손상 파일, 지원하지 않는 파일 오류 표시

### 테스트

- primitive 타입과 null이 있는 작은 fixture 열기
- 파일 이름, 행 수, 컬럼 수, row group 수 검증
- 첫 페이지 행과 컬럼 값 검증
- 취소된 파일 대화상자가 오류를 만들지 않는지 확인
- 존재하지 않는 파일, 잘린 파일, 잘못된 확장자와 내용 조합 검증
- Rust unit test와 실제 Tauri UI smoke test

### 완료 조건

- 사용자가 대화상자에서 작은 Parquet 파일을 열어 첫 페이지를 볼 수 있다.
- 오류가 panic이나 빈 화면이 아닌 사용자 메시지로 표시된다.
- 핵심 Parquet 로직이 Tauri 없이 unit test에서 검증된다.

## Phase 2. 대용량 Parquet

**목표:** Parquet를 파일 크기에 비례해 메모리에 올리지 않고 정확하게 탐색한다.

### 해야 할 일

- row group 위치를 이용한 페이지 조회
- 컬럼 projection, offset, limit 구현
- 요청 세대 번호 또는 cancellation을 이용한 stale response 방지
- 크기가 제한된 페이지와 row group cache 구현
- 64비트 정수, unsigned 정수, decimal, date, timestamp 정밀도 보존
- binary와 list, struct, map 표시 모델 구현
- row group 통계와 압축 메타데이터 표시

### 테스트

- 여러 row group 경계를 가로지르는 페이지
- 처음, 중간, 마지막 offset과 파일 끝을 넘는 요청
- 선택한 컬럼만 반환하는 projection
- JavaScript 안전 정수 범위를 벗어난 값의 왕복
- decimal scale, timestamp 단위와 timezone, nested 값 검증
- 빠른 페이지 변경에서 오래된 응답이 표시되지 않는지 확인
- 큰 fixture에서 메모리 사용량이 파일 크기에 비례해 증가하지 않는지 확인

### 완료 조건

- 임의의 페이지와 컬럼을 정확하게 조회할 수 있다.
- 지원 타입이 정밀도 손실 없이 표시된다.
- cache와 요청 크기에 명시적인 상한이 있고 테스트로 검증된다.

## Phase 3. CSV 데이터 소스

**목표:** 같은 파일 세션과 그리드 계약으로 CSV를 안전하게 탐색한다.

### 해야 할 일

- 공통 데이터 소스 인터페이스에 CSV 구현 추가
- UTF-8과 UTF-8 BOM, header 설정, preview 구현
- quoted delimiter, newline, escape를 처리하는 표준 parser 연결
- 백그라운드 행 수 계산과 진행 상태, 취소 구현
- 크기가 제한된 checkpoint index와 랜덤 페이지 접근 구현
- CSV 파싱 정보와 구조 문제를 Metadata 화면에 표시
- 타입 추론과 원문 문자열 보존을 분리

### 테스트

- header가 있는 파일과 없는 파일
- 빈 파일, 빈 필드, 마지막 빈 컬럼
- quoted comma, quoted newline, escaped quote
- UTF-8 BOM과 지원하지 않는 encoding 오류
- 매우 긴 record와 일관되지 않은 컬럼 수
- index checkpoint 전후와 파일 마지막 페이지 조회
- 행 수 계산 취소와 닫힌 세션 결과 무시

### 완료 조건

- 사용자가 CSV를 빠르게 열어 preview를 먼저 볼 수 있다.
- 전체 행 수 계산 중에도 UI가 응답하고 취소할 수 있다.
- CSV 원문 값이 타입 추론 때문에 변경되지 않는다.

## Phase 4. 파일 열기 통합

**목표:** 모든 파일 열기 진입점이 같은 검증과 세션 생명주기를 사용하게 한다.

이 단계는 당시의 단일 세션과 single-instance 계약으로 완료되었다. 아래 교체·다중 파일 제한
항목은 Phase 8의 `DocumentRegistry`, batch open, 다중 프로세스 계약으로 대체한다.

### 해야 할 일

- 창 전체 drag and drop과 drop target 구현
- 운영체제 파일 연결과 시작 경로 처리
- 실행 중인 앱에 전달된 파일 열기 처리
- 새 파일 성공 후 기존 세션을 안전하게 교체
- 여러 파일이 전달된 경우 명확한 제한 메시지 표시
- 최근 열기 실패와 세션 교체 중 UI 상태 정리

### 테스트

- 대화상자, drag and drop, 파일 더블클릭, 시작 인자 각각으로 CSV와 Parquet 열기
- 모든 진입점이 같은 형식 검증과 오류 코드를 사용하는지 확인
- 지원하지 않는 파일 drop과 여러 파일 drop
- 새 파일 열기 실패 시 기존 파일이 유지되는지 확인
- 새 파일 성공 후 이전 handle, index, cache가 해제되는지 확인
- Windows installer 또는 개발용 등록 환경에서 파일 연결 검증

### 완료 조건

- 지원되는 모든 진입점에서 동일한 결과와 오류 경험을 제공한다.
- 파일을 반복해서 교체해도 handle과 세션이 누적되지 않는다.
- 파일을 drag하는 동안 drop 가능 상태가 명확히 보인다.

## Phase 5. 가상화 그리드

**목표:** 대량 데이터 탐색에 적합한 안정적이고 반응성 있는 작업 화면을 완성한다.

### 해야 할 일

- 행과 컬럼 가상화
- 고정 header와 안정적인 grid 치수
- 컬럼 크기 조절, 숨기기, 이름 검색
- 긴 값 축약과 전체 값 확인 UI
- 현재 행 범위, 로딩, 행 수 계산 상태 표시
- Data, Schema, Metadata 화면 완성
- 빠른 스크롤의 요청 병합, 선행 읽기, stale response 처리 조정

### 테스트

- 많은 논리 행과 컬럼에서 렌더링 DOM 수가 제한되는지 확인
- 첫 행부터 마지막 행까지 빠른 스크롤
- 컬럼 resize, hide, search 이후 레이아웃 안정성
- 로딩, 빈 파일, 오류, 부분 메타데이터 상태
- 긴 문자열, 긴 컬럼 이름, nested 값이 주변 UI를 덮지 않는지 확인
- 일반 데스크톱과 작은 창 크기의 screenshot 검증
- 스크롤 중 UI thread 장시간 block 여부 확인

### 완료 조건

- 데이터 크기와 무관하게 렌더링되는 셀 수가 제한된다.
- 동적 상태 변화가 그리드와 주변 레이아웃을 불필요하게 움직이지 않는다.
- 빠른 탐색 중 잘못된 페이지가 순간적으로 표시되지 않는다.

## Phase 6. Excel 방식 선택과 클립보드

**목표:** 가상화와 페이지 경계를 넘어 일관된 셀 선택과 복사를 제공한다.

### 해야 할 일

- anchor, active cell, 직사각형 범위를 갖는 논리 선택 모델 작성
- 클릭, drag, `Shift+클릭`, 행·컬럼 header 선택 구현
- 화살표, `Shift`, `Ctrl`, `Ctrl+Shift`, `Ctrl+Alt`, `Ctrl+Alt+Shift`, `Home`, `End`,
  `PageUp`, `PageDown` 구현
- `Ctrl+A`, `Escape`, macOS `Command` 대응
- 선택 영역과 focus 시각 상태 및 자동 스크롤 구현
- TSV quoting과 clipboard 기록 구현
- 미로딩 페이지의 chunk 조회와 복사 진행 상태, 취소 구현
- 측정 결과를 바탕으로 복사 soft limit와 hard limit 확정

### 테스트

- 선택 reducer의 anchor, active cell, 범위 정규화 unit test
- 모든 키 조합의 이동과 확장 table-driven test
- 비어 있는 셀과 연속 데이터 영역에서 `Ctrl+화살표` 경계 동작
- `Ctrl+Alt+화살표`의 전체 표 경계 이동과 두 단축키의 `Shift` 범위 확장
- 미로딩 page와 projection을 넘는 경계 탐색, unknown row count의 EOF 탐색, 오래된 탐색 취소
- source/query backend가 target 좌표를 1회 응답하고 frontend가 중간 page 없이 target page만
  cache miss 시 읽는 경계 탐색 fast path
- `large-csv.csv` 250,000×40 release native Ctrl+Down p95 2초 이하 성능 회귀
- 가상 스크롤과 페이지 교체 후 선택 유지
- tab, CRLF, quote, null, 빈 문자열이 있는 TSV 직렬화
- TSV를 다시 파싱했을 때 원래 직사각형 구조와 일치하는지 확인
- 큰 범위의 확인, 진행 상태, 취소, soft/hard limit
- 검색 input에 focus가 있을 때 그리드 단축키가 입력을 가로채지 않는지 확인

### 완료 조건

- 명세된 마우스와 키보드 선택 동작이 가상화 여부와 무관하게 일치한다.
- 복사한 범위를 Excel에 붙여넣었을 때 행과 컬럼 구조가 유지된다.
- 큰 선택 범위가 무제한 메모리 사용이나 UI 정지를 만들지 않는다.

## Phase 7. 안정화와 배포

**목표:** 대표적인 실제 파일에서 성능과 안정성을 검증하고 설치 가능한 앱을 만든다.

### 해야 할 일

- 대표 크기와 타입 조합의 benchmark fixture와 생성 도구 작성
- 열기 시간, 페이지 응답 시간, 스크롤, cache, 메모리 측정
- 파일 교체와 취소 반복 시 handle, task, memory leak 점검
- 오류 메시지, logging, crash 대응 정리
- 최소 Tauri capability와 배포 설정 검토
- Windows installer와 파일 연결 구성
- 사용자 README와 지원 범위, 알려진 제한 작성
- 전체 회귀 테스트와 실제 UI 검증

### 테스트

- 작은 파일과 대용량 CSV·Parquet benchmark
- 반복적인 열기, 닫기, 교체, 취소 soak test
- 손상되거나 의도적으로 큰 metadata와 record를 가진 입력
- clipboard hard limit과 메모리 상한 회귀 테스트
- production build와 깨끗한 환경의 installer 설치·제거
- 설치 후 파일 더블클릭, drag and drop, 일반 파일 열기
- 데스크톱과 작은 창 크기의 최종 screenshot 검증

### 완료 조건

- 합의된 성능 예산과 메모리 상한을 만족한다.
- 지원 기능의 전체 자동 테스트와 실제 데스크톱 검증이 통과한다.
- installer에서 CSV와 Parquet 파일 연결 및 실행이 동작한다.
- 알려진 제한과 실행하지 못한 테스트가 문서화되어 있다.

## Phase 8. 컨텍스트 메뉴, 다중 실행, 다중 문서

**목표:** 선택과 복사 계약을 유지하는 셀 컨텍스트 메뉴를 추가하고, 독립적인 다중
프로세스와 한 창의 CSV·Parquet 다중 문서 탭을 제공한다.

구현은 `artifacts/phase-8/40-implementation-plan.md`의 8A~8E 순서를 따른다.

### 해야 할 일

- `documentId`와 `sessionId`를 분리한 `DocumentRegistry`와 batch open API 구현
- 문서별 source, page cache, CSV worker, cancel, close, stale response 수명주기 격리
- native dialog multi-select, multi-drop, multi-path startup argv의 입력 순서와 부분 성공 지원
- single-instance plugin과 두 번째 실행 전달 경로 제거, invocation별 독립 PID/window 보장
- 문서 탭 store, 64개 방어 상한, batch 32개, canonical path dedupe, close와 overflow UI 구현
- 문서별 Data/Schema/Metadata, page/scroll, selection, column, loading/error 상태 보존
- `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+W`와 접근 가능한 tablist 구현
- 선택 내부/외부 우클릭 계약과 네 액션의 셀 컨텍스트 메뉴 구현
- 컨텍스트 메뉴 viewport collision, keyboard, focus 복원, lifecycle close 구현
- cache, 동시 open, CSV worker의 프로세스 단위 자원 상한 적용
- 1,000만 행×10열 저카디널리티·반복 데이터와 고카디널리티 Parquet release fixture를 같은
  논리 스키마·row-group 설정으로 생성하고 manifest/checksum/실제 byte size/압축률 기록

### 테스트

- registry 8개 일반 사용과 64/65개 경계, 중복 경로 재사용, 부분 실패, deterministic order,
  slot race
- 여러 문서의 page/cache/worker/selection/copy/error 격리와 close 후 정확한 자원 해제
- context menu 선택 보존, 네 액션, Ctrl+C byte 동일성, keyboard와 clipboard fault
- dialog/drop/startup argv로 CSV와 Parquet 여러 파일 열기와 파일별 오류
- release 설치본 2~5개 PID/window, association invocation 독립성, Unicode·공백 경로
- 1440×900, 1024×768, 800×600 Browser interaction·geometry·screenshot
- 실제 Tauri 100%/150% scale, 시스템 clipboard hash, 8-tab overflow screenshot
- 단일 프로세스 100-cycle과 총 100 invocation 다중 프로세스 soak
- 저카디널리티와 고카디널리티 1,000만 행 Parquet 각각의 cold open, 첫·중간·row-group
  경계·마지막 page, projection, random jump, steady memory 검증
- frontend 전체 gate, Rust 전체 gate, release Tauri와 NSIS build/install 회귀

### 완료 조건

- 컨텍스트 메뉴가 마우스와 키보드에서 같은 논리 선택과 기존 복사 파이프라인을 사용한다.
- 한 창에서 8개 문서의 일반 사용 상태와 backend 자원이 격리되고, 64개까지 열 수 있으며
  65번째 파일만 비파괴적으로 거부된다.
- 앱과 파일 연결의 각 invocation이 실제 독립 PID/window를 만들며 서로 영향을 주지 않는다.
- close, configure, page, copy, worker 경쟁에서 wrong-tab 또는 닫힌 탭 late update가 없다.
- 합의된 cache·worker·memory 상한과 soak 기준을 만족한다.
- 저카디널리티와 고카디널리티 1,000만 행 Parquet를 모두 전체 materialize하지 않고
  성능·메모리 예산 안에서 탐색한다.
- `artifacts/phase-8/10-test-plan.md`의 자동, Browser, native, installer 증거가 모두 존재한다.
  필수 환경 때문에 실행하지 못한 항목은 완료로 표시하지 않고 `BLOCKED`로 기록한다.

## Phase 9. 입력 포맷 구조, CSV profile과 전체 query

**목표:** 입력 포맷을 확장 가능한 공통 source 계약으로 정리하고, configurable copy, CSV typed
profile과 전체 파일 대상 filter·search·stable sort를 bounded memory/disk로 제공한다.

**상태:** 구현 완료, 필수 UI·soak gate BLOCKED (2026-07-15)

구현은 `artifacts/phase-9/40-implementation-plan.md`의 9A~9F 순서를 따른다. 제품 기본값과
세부 동작은 `00-scope.md`, UI는 `20-ux-design.md`, source/query/temp 계약은
`30-query-engine-design.md`를 따른다.

### 해야 할 일

- compile-time `FormatRegistry`, `FormatDescriptor`, `TabularSource`와 capability 계약 구현
- CSV/Parquet handler 이전, generic metadata fallback과 runtime supported-format 목록 연결
- Excel/TSV/CSV/Custom clipboard preset, preview와 atomic 전역 settings 구현
- CSV Auto/All Text/Ask 기본 열기와 사후 Parsing Profile 변경
- profile column 다중 선택, bulk apply/undo, sample preview와 전체 파일 검증
- invalid 원문, source null과 empty string을 구별하는 typed CSV 변환 계층 구현
- engine-neutral QueryPlan/QueryResult/QueryBudget와 document/session/query/task generation 구현
- 동일 fixture로 DataFusion/DuckDB/direct spike 후 query engine 선택과 dependency 승인
- 전체 source/result 대상 typed filter, global/column search와 distinct paging 구현
- nulls-last multi-column stable sort, result paging, progress와 cancel 구현
- app-local-data의 process/document/query temp, owner lock, startup janitor와 disk budget 구현
- 세 viewport UI, 실제 Tauri, 8-tab/5-process와 10M low/high cardinality 통합 검증

### 테스트

- 모든 format handler의 공통 summary/schema/page/projection/precision/error contract
- test-only handler가 DocumentRegistry/query/grid 핵심 분기 변경 없이 generic UI에 표시되는지 확인
- copy preset/custom serializer round-trip, null/empty/정밀도와 실제 clipboard
- CSV inference, bulk selection, invalid/null, preview generation, validation cancel과 apply rollback
- filter/search/sort가 현재 page가 아닌 전체 결과에 적용되는지 cross-format checksum으로 검증
- 늦은 preview/query/page/status의 wrong-document/session/result 적용 0
- forced spill, disk cap/free-space, 정상/취소/실패/crash cleanup과 다른 process temp 보호
- 1,000만 행 x 10열 저·고카디널리티 Parquet와 대용량 CSV 성능/resource budget
- frontend/Rust 전체 gate, release/NSIS build와 Phase 1~8 regression
- Playwright Chromium으로 1440x900, 1024x768, 800x600 interaction·geometry·screenshot
- `docs/UI_VALIDATION.md`의 Browser interaction, geometry, screenshot과 실제 Tauri/native gate

### 완료 조건

- `artifacts/phase-9/10-test-plan.md`의 필수 FMT/CPY/CSV/QRY/LIFE/TMP/PERF/UI 테스트가 PASS다.
- 새 tabular handler 추가가 reader, registry, 선택적 metadata renderer와 contract fixture로 제한된다.
- CSV profile 변경이 원본을 수정하지 않고 invalid/null/empty와 typed precision을 보존한다.
- filter/search/sort가 10M low/high fixture에서 정확하고 memory/spill/cancel budget 안에 동작한다.
- query/profile/tab/process 종료 후 active resource와 temporary data가 누적되지 않는다.
- query engine 선택, dependency 승인과 측정 결과가 `engine-spike.md`와 최종 설계에 기록된다.
- HIGH/MEDIUM 결함과 필수 BLOCKED가 없고 `50-integration.md`, `90-review.md`, UI 증거가 완성된다.

## Phase 10. OES HDF5 읽기 지원

**목표:** 루트의 `time`, `wavelength` attribute와 2차원 int32 `intensity` dataset을 사용하는
OES HDF5를 정적 HDF5/Blosc runtime으로 안전하게 열고, 기존 tabular grid에서 bounded page와
projection으로 탐색한다.

**상태:** 구현 완료, 필수 security·performance·installer gate BLOCKED (2026-07-17)

구현은 `artifacts/phase-10/40-implementation-plan.md`의 10A~10E 순서를 따른다. 제품 동작은
`00-scope.md`, 검증은 `10-test-plan.md`, UI는 `20-ux-design.md`, native/source 설계는
`30-hdf5-design.md`를 따른다.

### 해야 할 일

- `hdf5-metno 0.13.0` static+blosc-zstd와 `ndarray 0.17` dependency/build/license spike
- process 최초 HDF5 초기화, dynamic filter/VOL/VFD plugin 차단과 static Blosc availability 확인
- `OES HDF5` format descriptor, handler와 typed structure/error 계약
- local hard-linked `/intensity` 검증과 external link/VDS/external storage 거부
- numeric/UTF-8 time·wavelength axis, optional datetime hint와 deterministic unique column binding
- 파일당 128 MiB/process 256 MiB axis lease, 4,096 wavelength와 64 MiB decoded chunk 상한
- 200행 x 64열 hyperslab page/projection, time-only intensity I/O 0과 coalesced column slice
- 64열을 넘는 source의 공통 bounded initial projection과 actual projection cache key
- generic Data/Schema/Metadata, virtual grid, selection과 clipboard 연결
- `.h5/.hdf5` dialog/drop/startup 지원과 broad Windows file association 제외
- actual Python hdf5plugin golden, corrupt/security/large fixture와 release/NSIS clean-runtime 검증

### 테스트

- profile attribute 없이 핵심 세 객체만 있는 OES와 axis type/precision matrix
- missing object, rank/dtype/shape/filter mismatch, truncated chunk와 arbitrary HDF5 typed error
- duplicate/blank/time wavelength label의 deterministic projection 이름
- first/middle/chunk boundary/last/EOF와 1/64/65열 projection
- wide 4,096 wavelength initial page와 10M x 64 low/high release fixture
- 전체 intensity materialize 0, axis/chunk/page cache/process memory 상한
- dynamic plugin, soft/external link, VDS와 external storage 차단
- mixed CSV/Parquet/OES batch, 8-tab lifecycle와 2~5 release process
- 세 viewport Browser interaction·geometry·screenshot과 실제 Tauri dialog/drop/startup/clipboard
- static binary import, license notice, release/NSIS clean install과 기존 format 회귀

### 완료 조건

- `artifacts/phase-10/10-test-plan.md`의 모든 필수 OES 테스트 ID가 PASS다.
- 실제 Blosc filter 32001/Zstd 파일을 Python, system HDF5, plugin env와 loose native DLL 없이 읽는다.
- page와 projection이 전체 intensity를 materialize하지 않고 axis/chunk/cache/process 상한을 지킨다.
- unknown attribute는 무시하고 현재 계약 밖의 layout과 외부 참조는 안전한 typed error로 거부한다.
- OES가 전용 grid 분기 없이 generic UI, selection과 clipboard에 표시된다.
- CSV/Parquet와 Phase 9 query의 정확성·성능·native packaging 회귀가 없다.
- HIGH/MEDIUM 결함, 필수 BLOCKED가 없고 integration/review/UI/native 증거가 완성된다.
