# Phase 14 구현 기록

## 1. 구현 결과

Phase 14의 CSV 준비·persistent cache, Ctrl 경계 탐색, 다중 정렬, Settings 재구성,
컬럼 live drag와 원본 순서 복원을 구현했다. 제품 코드와 자동·native 검증은 통과했지만,
`10-test-plan.md`에 정의한 일부 성능·아키텍처 gate가 남아 있으므로 Phase 상태는 완료가 아니라
`구현 완료, 필수 performance·architecture gate BLOCKED`로 유지한다.

## 2. CSV 준비와 persistent cache

- CSV를 Arrow `RecordBatch`로 묶어 ZSTD Parquet cache를 생성한다.
- batch는 16,384행에서 시작해 32,768행, 65,536행으로 증가하고 실제 decoded buffer가
  64MiB를 넘지 않도록 축소한다.
- 같은 scan에서 2-bit cell-state bitmap과 row offset/checkpoint, cache manifest를 만든다.
- bitmap의 `valid`·`invalid`는 occupied, `null`·빈 문자열은 empty로 취급한다.
- cache manifest는 schema version, source fingerprint, 산출물 크기·시간·CRC64를 기록한다.
- Windows에서는 volume serial과 file index를 포함한 파일 identity를 사용한다.
- process 공용 lock과 entry별 shared/exclusive lock, active lease로 여러 프로세스의 중복 publish와
  사용 중인 cache 제거를 막는다.
- manifest를 마지막에 atomic publish하며 취소·오래된 generation은 Ready 상태를 commit할 수 없다.
- 시작 시 안전하게 식별되는 `cache-manifest.json.partial-*` crash orphan을 정리한다.
- persistent cache는 파생 데이터 corruption 탐지용이며 악의적인 local tampering을 막는 보안 경계는
  아니다. 이 위협 모델은 `30-csv-preparation-architecture.md`에 명시했다.

현재 cache의 값 저장은 완전한 physical raw/typed 이중 Parquet 구조까지 도달하지 않았다. raw lexeme와
invalid 상태는 보존하지만 계획한 모든 CSV target type을 Parquet physical type으로 분리하는 작업은
후속 과제로 남는다.

## 3. Ctrl 경계 탐색

- 필터·정렬하지 않은 CSV의 Ctrl+위/아래는 고정 200행 page 반복 대신 source state bitmap의 word
  scan으로 목표 행을 찾는다.
- 필터·정렬된 결과는 logical position에서 source row ID를 얻고 source bitmap state를 gather해
  occupancy를 계산한다.
- Ctrl+Alt+화살표는 occupancy scan 없이 실제 행·표시 컬럼 경계로 이동한다.
- 목표가 정해지면 중간 page를 순서대로 읽지 않고 목표 page만 요청한다.
- persistent cache hit benchmark 20회 모두 `sourceReadBytes=0`이었고 p95는 110.6953ms였다.

준비 도중 공개되는 frontier 내부를 즉시 탐색하는 계약은 아직 완성되지 않았다. 현재 제품 경로는
Ready 전 navigation을 충분히 제공하지 못하므로 이 항목은 BLOCKED다.

## 4. 정렬·Settings·컬럼 UX

- `Add level`은 빈 정렬 level을 먼저 추가한다. 사용자는 이후 컬럼과 오름·내림차순을 결정한다.
- 모든 컬럼을 검색할 수 있고 숨긴 컬럼도 후보에 포함된다. 이미 선택된 컬럼은 중복 선택할 수 없다.
- 불완전한 draft는 Apply할 수 없으며 level은 stable draft ID로 관리한다.
- Settings의 큰 제목과 타입 이름 크기를 정리하고, 각 값 타입의 기본 설정을 첫 화면에 배치했다.
- 세부 설정은 별도 화면 전환 없이 한 번에 하나만 열리는 inline accordion으로 표시한다.
- 컬럼 drag 중 header와 현재 mount된 셀 strip 전체가 pointer를 따라가며, 삽입 위치의 다른 컬럼이
  좌우로 밀려난다. drop 전에는 backend order를 변경하지 않고 drop에서 한 번만 commit한다.
- drag 중 column projection과 page 요청을 고정해 불필요한 조회를 막았다.
- 원본 파일의 schema 컬럼 순서로 되돌리는 action을 추가했으며 visibility, width와 query는 유지한다.

## 5. 검증 결과

| 검증 | 결과 |
| --- | --- |
| Rust 전체 library test | 239 PASS, 0 FAIL, 12 ignored |
| Frontend unit test | 364/364 PASS |
| 전체 Playwright | 75/75 PASS, 세 viewport |
| Phase 11~14 선택 E2E | 48/48 PASS |
| Frontend format/typecheck/lint | PASS |
| Rust fmt/check/clippy `-D warnings` | PASS |
| Phase 14 fixture audit | 12/12 PASS |
| 실제 Tauri Phase 14 smoke | runtime/sort/settings/column-drag PASS |
| Release executable build | PASS |
| NSIS installer build | PASS |
| 독립 Rust 리뷰 | 미해결 HIGH/MEDIUM 없음 |

실제 Tauri drag screenshot의 floating overlay cell 높이와 간격은 약 48.48px로 연속되며,
browser mock과 실제 WebView2에서 동일한 live reflow 동작을 확인했다.

## 6. 성능 측정

- 5,850,000행 low CSV cold persistent preparation 단일 표본: **53.9417249초**
- persistent hit 20회: p50 **84.9574ms**, p95 **110.6953ms**, max **113.891ms**
- persistent hit 20회 source read: 모두 **0 byte**
- 기존 product-path page 표본 p95: **42.0566ms**

cold preparation 단일 표본은 60초 gate 안이지만 계획한 5회 cold 표본이 아니므로 최종 성능 근거로는
부족하다. product-path page p95는 계획한 20ms gate를 넘는다.

## 7. 최종 산출물

| 파일 | 크기 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/data-viewer.exe` | 78,997,504 bytes | `A50AC0022A3B3AD986C53BA5B46330EC0FCF42FEF7B67BC8929CA14BFE2C6AC7` |
| `src-tauri/target/release/bundle/nsis/Data Viewer_0.1.0_x64-setup.exe` | 13,763,973 bytes | `36493BA299321265E36D117EFA5FCEAFCE21A1ED1C8101418D340A0C3C42FC36` |

두 파일의 최종 작성 시각은 `2026-07-23 16:09:08 +09:00`이다.

## 8. 남은 완료 조건

- physical raw/typed cache 분리와 모든 소비 경로의 타입 정확성 증거
- preparation 중 frontier 내부 navigation과 frontier 밖 동일 worker 대기
- preview/preparation/cache 구성별 byte counter의 계획된 전체 matrix
- 5회 cold preparation 측정과 low/high/long-invalid 표본
- page p95 20ms 이하 달성 및 계획된 100회 표본

위 항목은 구현 결과를 무효화하는 알려진 제품 결함은 아니지만 Phase 14에서 스스로 정한 필수 완료
조건이다. 모두 충족하기 전에는 Phase 14를 `완료`로 표시하지 않는다.
