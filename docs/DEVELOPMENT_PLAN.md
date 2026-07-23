# 개발 계획

## 2026-07-21 최신 실행 상태

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
- 64열 source projection 상한을 copy 상한으로 잘못 사용하던 회귀를 수정했다. 65열 이상 선택은
  64열 이하 projection으로 분할하고, 설정 V2의 app-global hard limit(기본 1,000,000셀/64 MiB)을
  적용한다. browser 480x65와 실제 OES 128x65의 전체 Windows clipboard 복사가 PASS했다.
- Phase 11은 실제 OES H5 version 3 구조, 5,850,000행 Parquet scroll/query 회귀, 마지막 행 geometry,
  source-native Ctrl 경계 탐색, column auto-fit과 타입별 전역 display/raw/copy 분리를 확정했다.
  제품 구현과 현재 fixture의 자동·native 검증은 완료했으며 high-cardinality query 성능 근거,
  실제 Excel, 150% DPI와 clean-machine installer 검증은 gate로 남아 있다.
- Phase 12는 5,850,000행 `group_id` 정렬 결과를 source row identity 1열로 줄이고 physical
  rowid를 logical position으로 사용하는 구조로 완료했다. 최대 200개 identity를 먼저 제한한 뒤
  요청 projection만 sparse read하며, query-aware streaming copy, Find, 다중 정렬, 탭·컬럼 순서,
  focus/geometry와 H5 구조 판별을 같은 snapshot 계약으로 통합했다. release 성능, 100회 lifecycle,
  100%·150% WebView2, Windows clipboard/Excel 한도와 NSIS build까지 통과했다.
- Phase 13은 Phase 12 후속 요구사항으로 시작했다. adaptive Ctrl boundary와 query-order occupancy
  bitmap, CSV prepared source, 직접 tab/column drag, Shift 없는 multi-sort panel, transient surface
  lifecycle, Timestamp 설정 완성과 Arrow Duration 지원을 구현한다.
- Phase 14는 CSV Arrow/Parquet persistent cache와 2-bit state bitmap, OS file identity·process lock·lease,
  blank-first multi-sort, Settings inline accordion, mounted-cell live column drag와 source-order restore를
  구현했다. 전체 frontend/Rust/Playwright와 실제 Tauri, release/NSIS build는 PASS했다. 다만 physical
  raw/typed cache 분리, preparation frontier, page p95 20ms와 계획된 성능 표본이 남아 완료 판정은
  BLOCKED다.

이 문서는 구현 순서, 단계별 작업, 테스트, 완료 조건을 관리한다. 상세 제품 계약은
`docs/PROJECT_SPEC.md`를 따른다.

## 진행 규칙

- 단계는 Phase 0부터 Phase 13까지 순서대로 진행한다.
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
| Phase 11 | 구현 완료, 필수 performance·외부 gate BLOCKED (2026-07-20) | OEF H5 v3, 대용량 grid/query, 경계 탐색과 값 표현 안정화     |
| Phase 12 | 완료 (2026-07-21)                                      | query/page, streaming copy, Find·reorder·tab/H5 안정화       |
| Phase 13 | 구현 완료, 필수 performance·external native gate BLOCKED (2026-07-23) | boundary·CSV cache·직접 drag·정렬 UX·Duration·설정 안정화    |
| Phase 14 | 구현 완료, 필수 performance·architecture gate BLOCKED (2026-07-23) | CSV 단일 scan columnar cache·Ctrl bitmap·정렬/설정/live drag UX |

Phase 0~7의 제품 코드와 자동 검증은 완료했지만 미실행 Browser 범위, 실제 Excel,
clean VM이 필요한 필수 품질 gate는 BLOCKED다. 단계별 근거는 각
`artifacts/phase-N/90-review.md`를 따른다. Phase 8의 확정 범위와 테스트 기준은
`artifacts/phase-8/00-scope.md`와 `artifacts/phase-8/10-test-plan.md`를 따른다.
Phase 9 결과는 `artifacts/phase-9/50-integration.md`와 `90-review.md`를 따른다.
Phase 10의 확정 범위와 구현 gate는 `artifacts/phase-10/00-scope.md`부터
`40-implementation-plan.md`까지를 따른다. Phase 9의 외부 환경 BLOCKED 항목은 Phase 10을
시작해도 해소된 것으로 간주하지 않으며 공통 회귀와 최종 배포 판정에서 계속 추적한다.
Phase 11의 확정 범위와 구현 gate는 `artifacts/phase-11/00-scope.md`부터
`40-implementation-plan.md`까지를 따른다. Phase 10의 구현 기록은 보존하지만 실제 OEF H5 입력
계약은 Phase 11이 대체한다. 이전 Phase의 BLOCKED 항목은 Phase 11에서도 계속 추적한다.
Phase 12 계약은 `artifacts/phase-12/00-scope.md`부터 `40-implementation-plan.md`까지다.
2026-07-21 사용자 승인으로 Phase 12를 시작했고 12A~12H 구현과 필수 자동·release·native gate를
완료했다. Phase 11의 high-cardinality 성능과 150% DPI 항목은 Phase 12 증거로 해소했다. 이전
Phase의 clean-machine installer처럼 별도 환경이 필요한 항목은 해당 Phase 기록에서 계속 추적한다.
Phase 13의 확정 범위는 `artifacts/phase-13/00-scope.md`이며 구현 전 Quality 계획부터 시작한다.

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

> 이 절은 2026-07-17 당시 구현 계약과 결과를 보존한다. 실제 OEF H5 v3 입력 구조는 Phase 11과
> `docs/PROJECT_SPEC.md` 12절이 대체한다.

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

## Phase 11. OEF H5 v3와 대용량 탐색·값 표현 안정화

**목표:** 실제 OES H5 version 3의 dataset/transpose 구조를 지원하고, WebView scroll 한계와 마지막
행 geometry를 수정한다. 대용량 Parquet filter/sort와 Ctrl 경계 탐색을 source-native bounded
algorithm으로 가속하며 raw typed value, 타입별 전역 display와 copy 표현을 분리한다.

**상태:** 구현 완료, 필수 performance·외부 gate BLOCKED (2026-07-20)

구현은 `artifacts/phase-11/40-implementation-plan.md`의 11A~11F 순서를 따른다. 제품 동작은
`00-scope.md`, 검증은 `10-test-plan.md`, UI는 `20-ux-design.md`, source/value/grid/query 설계는
`30-technical-design.md`를 따른다.

### 해야 할 일

- writer 권장 `format=oesh5`는 판별에서 제외하고 `format_version=3`,
  `shape=[n_time,n_wavelength]`와 실제 dataset 구조 검증
- `/time`, `/wavelength` 1차원 dataset과 `/oes[wavelength,time]` int32/int64 transpose paging
- Blosc filter 32001/Zstd static decode, decoded 64 MiB 이하의 임의 chunk shape와 unknown compression typed error
- source typed payload, display/copy formatter와 Settings V3 atomic migration
- timestamp `YYYY-MM-DD HH24:MI:SS.F...`, timezone annotation 제거와 raw metadata 보존
- 실제 문자열 개행, 최대 2줄의 고정 row 높이와 전체 값 보기
- 열 header separator 더블클릭/menu의 loaded·cached display 기준 너비 auto-fit과 80..800 px clamp
- logical/physical offset을 분리한 segmented/anchored row virtualization
- 실제 마지막 row의 content/border와 horizontal scrollbar geometry 수정
- OEF/Parquet/CSV/query source-native boundary scanner, cache, cancellation과 target-only IPC
- Parquet predicate/projection pushdown, 최소 result index와 late page materialization
- temp warning의 estimated bytes, 기본 5 GiB safety reserve와 10 GiB hard cap 구분
- 세 viewport, 실제 WebView2 100%/150% DPI, Windows clipboard와 release/NSIS 회귀 검증

### 테스트

- OEF H5 v3 attribute/dataset/type/shape/filter/link matrix와 `/oes[w,t]` transpose checksum
- time/wavelength integer/float/string, oes int32/int64 경계와 string time `""` empty 판정
- decoded 64 MiB 이하의 서로 다른 chunk shape와 초과 chunk limit 오류, first/middle/chunk-boundary/last/EOF projection
- 5,850,000행의 986,803 전후와 실제 마지막 행, 기존 10M first/middle/last scroll
- 마지막 row full geometry, fixed two-line string과 세 viewport screenshot
- header/menu auto-fit의 font/padding/icon 측정, no-backend-scan과 document별 width 보존
- Ctrl/Ctrl+Shift/Ctrl+Alt/Ctrl+Alt+Shift target, focus, stale cancellation과 page-call count
- OEF no-empty O(1), Parquet vector scan과 반복 boundary cache release 성능
- 5.85M/10M Parquet filter/sort count/checksum, plan pushdown, memory/temp/cleanup
- timestamp unit/timezone, 모든 scalar의 raw/display/copy와 Rust/TypeScript parity
- Settings V2→V3 migration, copy snapshot, actual Windows clipboard와 Excel round-trip
- frontend/Rust 전체 gate, release/NSIS clean runtime과 Phase 1~10 regression

### 완료 조건

- `artifacts/phase-11/10-test-plan.md`의 H5V3/VIRT/GEO/AFIT/NAV/QRY/VAL/UI/PKG 필수 항목이 PASS다.
- 실제 OEF H5 v3를 전체 `/oes` materialization 없이 정확한 transpose mapping으로 읽는다.
- 5.85M과 10M Parquet의 실제 마지막 행을 완전히 표시하고 선택·복사할 수 있다.
- 대용량 filter/sort가 정확하고 전체 display/raw 문자열 복제나 26 GiB 오인 경고가 없다.
- Ctrl 경계 탐색이 empty 의미를 보존하고 중간 page request 없이 성능 예산을 만족한다.
- timestamp, multiline string과 모든 scalar가 raw/display/copy 정밀도 계약을 지킨다.
- column auto-fit이 전체 파일 scan 없이 현재 표시 후보로 동작하고 수동 resize·문서 상태를 보존한다.
- HIGH/MEDIUM 결함과 필수 BLOCKED가 없고 integration/review/UI/native 증거가 완성된다.

## Phase 12. 대용량 query·복사와 grid 작업 흐름 안정화

**목표:** 정렬 결과 index의 불필요한 ordered window/position materialization을 제거하고, query
page가 필요한 source row identity와 column projection만 bounded하게 읽도록 수정한다. 정렬 뒤
scroll/navigation, tab 복귀, logical focus, Find, 파일/컬럼 reorder와 filtered/sorted bulk copy를
하나의 query snapshot 계약으로 안정화한다. H5는 `format` 값 대신 확장자·signature·실제 구조로 판별한다.

**상태:** 완료 (2026-07-21)

구현은 사용자 승인 뒤 `artifacts/phase-12/40-implementation-plan.md`의 12A~12H 순서로 완료했다.
제품 동작은 `00-scope.md`, 검증은 `10-test-plan.md`, UI는 `20-ux-design.md`, query/source/grid 설계는
`30-technical-design.md`를 따른다.

### 해야 할 일

- query result를 정렬된 source row identity 한 열의 물리 table로 축소
- 수정하지 않는 table의 연속 physical rowid를 logical result position으로 사용하고 invariant 검증
- 최대 200개 position/source identity를 먼저 읽고 query connection lock 해제
- `ReadQueryPageRequest.columns`와 query logical columns/page projection 분리
- Parquet ProjectionMask+RowSelection sparse read와 CSV checkpoint sparse read
- foreground page 우선, prefetch 억제, same-key dedupe와 stale generation 폐기
- find, copy, boundary와 first/middle/last page를 새 position 계약으로 이전
- 정렬된 query 순서의 Ctrl boundary, Ctrl+Alt absolute와 PageUp/PageDown target-only navigation
- filter/sort 뒤 logical row·column focus 보존·clamp와 rectangular range의 active cell 축소
- inactive tab virtualizer/request pause와 cache-valid tab 복귀 zero-IPC geometry restore
- 전역 match-only Filter 제거, `Ctrl+F` draft와 명시적 조회, multi-sort priority UI
- 파일 tab과 document별 column ID order의 drag·keyboard reorder
- query-aware 부분/전체 copy의 filtered row, sorted order, visible reordered column 계약
- 5.85M행×1열 backend streaming copy, wide H5 adaptive hyperslab과 copy attempt history/error
- `.h5/.hdf5` signature/version/shape/dataset 구조 판별과 `format` attribute 검사 제거
- low/high 5.85M fixture의 sort/page/pending/RSS/temp/cancel/lifecycle 검증

### 테스트

- 1열 result index schema, physical rowid 0..count-1과 source identity 1:1
- asc/desc/3-column stable sort, 원본 row identity tie-breaker와 양방향 nulls-last
- first/middle/986,803/last/EOF와 deterministic random page checksum
- page당 identity 200, projection 64, source-before-limit 전체 join 0
- Parquet high-cardinality sparse row selection과 CSV checkpoint grouping decode audit
- Ctrl/Ctrl+Shift/Ctrl+Alt/Ctrl+Alt+Shift, Home/End, PageUp/PageDown의 query logical target
- 빠른 scroll, projection 변경, query replace/cancel/tab close의 permanent pending·stale page 0
- release에서 low sort p95 1.5초, 첫 visible page p95 2초, low prepared page p95 250ms,
  high random page p95 1초 이하
- query peak RSS 1.5 GiB, process temp 10 GiB 이하와 cleanup
- 5.85M×1 query copy page/value IPC 0, wide H5 fixed 64-column group 제거와 clipboard atomicity
- Find explicit execution, tab/column reorder, focus 보존과 tab 왕복 zero-IPC/flash E2E
- H5 `format` missing/임의 값 구조-valid matrix와 unknown compression typed error
- 세 viewport Playwright interaction/geometry/screenshot과 실제 5.85M Parquet/WebView2 clipboard smoke
- frontend/Rust 전체 gate와 final release/NSIS 회귀

### 완료 조건

- `artifacts/phase-12/10-test-plan.md`의 IDX/PAGE/NAV/RACE/PERF/LIFE/QUX/COPY/H5/UI 필수 항목이 PASS다.
- result index가 source identity 한 열만 저장하고 별도 ordered window position/value 복사본이 없다.
- 모든 query page는 source value 전에 최대 200개 identity를 제한하고 요청 projection만 decode한다.
- 정렬 후 first/middle/last와 연속 scroll/PageDown에서 빈 row 또는 영구 pending이 없다.
- query logical 좌표에서 모든 navigation, Shift selection과 focus visibility가 정확하다.
- low/high cardinality의 correctness, 성능, RSS, temp, cancel과 cleanup 예산을 만족한다.
- filtered/sorted 부분·전체 copy가 backend streaming과 typed operation state로 정확히 동작한다.
- Find, tab/column reorder, logical focus와 H5 구조 판별이 승인된 UX·기술 계약과 일치한다.
- HIGH/MEDIUM 결함과 필수 BLOCKED가 없고 integration/review/UI/native 증거가 완성된다.

## Phase 13. 후속 대용량 탐색·CSV 준비·정렬 UX와 시간 타입 안정화

**목표:** 필터·정렬 결과의 Ctrl 경계 탐색을 adaptive batch와 query-order bitmap으로 가속하고,
CSV를 profile generation마다 한 번 준비해 page/query/copy가 재사용하게 한다. 파일 탭과 컬럼을
직접 pointer drag로 재정렬하고 Shift 의존성이 없는 multi-sort panel을 제공한다. transient UI의
lifecycle을 정리하고 Timestamp 설정과 Arrow Duration을 raw/display/copy/query 전 계층에서 지원한다.

**상태:** 구현 완료, 필수 performance·external native gate BLOCKED (2026-07-23)

구현 범위와 순서, 제외 항목과 완료 조건은 `artifacts/phase-13/00-scope.md`를 따른다. Phase 12의
발견 사항과 상세 계약은 `artifacts/phase-12/95-follow-up-requests.md`가 근거다.

### 해야 할 일

- one-column adaptive occupancy scan과 query logical known/occupied bitmap
- CSV background prepared source, generation invalidation, cleanup과 release 성능 gate
- 파일 탭·컬럼 header 직접 pointer drag와 external file drop state 분리
- Shift 기능이 없는 draft/apply multi-sort editor와 criteria row drag
- Copy history, Column chooser와 transient status의 outside/Esc/focus lifecycle
- Timestamp preset/advanced 설정과 Value display formats 내부 summary/detail 전환
- Arrow Duration/CSV Duration profile의 signed count·unit·precision·query/copy 지원
- 세 viewport와 실제 Tauri/Release/NSIS 통합 검증

### 완료 조건

- `artifacts/phase-13/10-test-plan.md`의 필수 테스트가 PASS다.
- 5.85M filtered/sorted Ctrl boundary와 prepared CSV가 정확성·성능·자원 상한을 만족한다.
- pointer drag, multi-sort, transient surface와 설정 상세가 세 viewport와 실제 Tauri에서 동작한다.
- Timestamp와 Duration의 source/display/default/raw copy 및 filter/sort 의미가 일치한다.
- HIGH/MEDIUM 결함과 필수 BLOCKED가 없고 integration/review/UI/native 증거가 완성된다.

## Phase 14. CSV 단일 스캔 columnar cache와 UI 재구성

**목표:** 5,850,000행 CSV의 row index와 query preparation 중복 scan, 행 단위 DuckDB 적재와
unfiltered Ctrl 200행 반복을 제거한다. 같은 scan에서 Arrow RecordBatch 기반 raw/typed Parquet,
cell-state bitmap, checkpoint와 manifest를 만들고 DuckDB는 typed cache의 filter/multi-sort에 사용한다.
multi-sort blank level, Settings inline accordion, column live reflow와 source-order restore를 함께 구현한다.

**상태:** 구현 완료, 필수 performance·architecture gate BLOCKED (2026-07-23)

Arrow/Parquet persistent cache, 2-bit cell-state bitmap, OS file identity와 process 공용 lock·lease,
bitmap Ctrl 탐색, blank-first multi-sort, Settings inline accordion, mounted-cell live column drag와
source-order restore를 구현했다. 전체 frontend/Rust/Playwright, 실제 Tauri smoke, release executable과
NSIS build는 PASS했다. 최신 측정과 미충족 gate는 `artifacts/phase-14/40-implementation.md`,
`50-integration.md`, `90-review.md`에 기록한다.

확정 범위는 `artifacts/phase-14/00-scope.md`, UI는 `20-ui-design.md`, CSV 준비 아키텍처는
`30-csv-preparation-architecture.md`를 따른다.

### 해야 할 일

- session별 `CsvPrepareCoordinator`와 단일 source scan lifecycle
- Arrow RecordBatch→raw/typed Parquet, 2-bit state bitmap, row checkpoint와 atomic manifest
- source read/decoded/cache byte 계수와 temporary storage budget
- unfiltered source bitmap Ctrl, filtered/sorted query logical bitmap gather
- persistent fingerprint cache와 profile generation invalidation
- blank-first searchable multi-sort draft
- Settings typography와 Value display formats inline accordion
- full mounted-column floating strip과 live reflow drag
- source schema column order restore
- 5.85M low/high release benchmark, 세 viewport와 실제 Tauri/NSIS 검증

### 완료 조건

- `artifacts/phase-14/10-test-plan.md`의 필수 테스트가 PASS다.
- 원본 CSV background scan 1회, preparation 60초/2.5배 개선, RSS/temp/cancel 상한을 만족한다.
- Ready 이후 Ctrl navigation source read 0과 네 방향 latency/correctness gate를 만족한다.
- sort/settings/drag/reset UI가 세 viewport와 실제 WebView2에서 동작한다.
- 전체 frontend/Rust/E2E/release/NSIS gate가 PASS하고 HIGH/MEDIUM 결함과 필수 BLOCKED가 없다.
