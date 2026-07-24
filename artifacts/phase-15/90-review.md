# Phase 15 최종 독립 Quality 리뷰

## 판정

제품 구현과 기본 Polars 연결, release/NSIS 생성까지는 완료했다. 다만
`artifacts/phase-15/10-test-plan.md`가 필수로 지정한 native·DPI·lifecycle·fault·clean-install
증거가 남아 있으므로 Phase 15를 `완료`로 표시하지 않는다.

최종 상태는 **구현 완료, 필수 native·soak gate BLOCKED**다.

## 통과한 핵심 gate

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 기본 제품 provider | PASS | Cargo default `polars-csv-provider`, Polars 0.54.4 |
| high CSV cold 5회 | PASS | median 14.7014초, 5표본 p95=max 14.9310초 |
| process tree RSS | PASS | peak 약 1.150GiB, 상한 1.5GiB |
| source pass | PARTIAL | 성공 경로는 구조 pass+helper pass이나 helper byte는 실제 counting reader가 아닌 파일 크기 기반 추정 |
| hard cancel 대표 실행 | PASS | 실제 5.85M partial 생성 뒤 0.07~0.13초, snapshot/partial/request/result 0 |
| Rust | PASS_WITH_WARNING | fmt, Clippy `-D warnings`, 267 PASS·16 ignored; 기존 MSVC linker warning 유지 |
| Frontend | PASS | format, lint, typecheck, Vitest 364 PASS |
| Release package | PASS | 기본 feature release EXE와 NSIS 생성, same-EXE worker |
| Dependency/license | PASS | OFF/ON 크기·109 package license·중복 Arrow/Parquet·notice 기록 |

사용자는 Stage 2 개발과 최종 제품 연결을 연속해서 지시했으므로 Polars runtime dependency 채택
결정은 완료된 것으로 해석했다. 최종 EXE는 143,856,640 B, NSIS는 24,926,061 B다.

## 남은 필수 gate

| 항목 | 상태 | 이유 |
| --- | --- | --- |
| Playwright 전체 명령 | BLOCKED | 1건 최초 실패 뒤 단독 재실행 PASS이나 runner가 결과 출력 후 종료되지 않음 |
| 최종 default-Polars native high CSV | BLOCKED | WebView2 CDP 미개방/exit 101, Polars debug link는 paging file 부족 |
| native clipboard·DPR 100/150 geometry | BLOCKED | 최종 default build 증거 없음 |
| Ready random page 100·warm hit·navigation source read 0 | NOT_RUN | 제품 최종 표본 수 계약 미충족 |
| low/high/long-invalid 전체 resource matrix | NOT_RUN | decoded 64MiB·queue 2 batch를 조합별로 완결하지 못함 |
| cancel/close/session replace 단계 matrix | NOT_RUN | 대표 hard-cancel 외 parse/cast/backpressure/sink/sync/publish p95/max 없음 |
| dialect/fallback 전체 matrix | NOT_RUN | tiny parity는 통과했지만 전체 CSV 계약 표본 미완결 |
| byte gate 001 | FAIL | helper 실제 counting reader 없이 파일 크기로 conversion read를 추정 |
| byte gate 002~004 | NOT_RUN | 단계별 동작 raw counting artifact 미완결 |
| 100-cycle·fault·cleanup | NOT_RUN | lifecycle 및 publish fault matrix 미실행 |
| clean install | BLOCKED | installer 생성까지만 확인 |
| toolchain warning gate | FAIL | 기존 `linker_messages`/LNK4098이 남아 문서의 warning 0 조건 미충족 |

## Quality 지적과 조치

독립 리뷰에서 발견한 두 HIGH 구현 결함은 다음처럼 보완했다.

- request/result JSON은 schema version 1과 공통 64MiB read/write 상한을 사용한다. metadata 선검사,
  `limit+1` 실제 read 재검사, malformed/oversize/write-before-create 회귀가 통과했다.
- helper는 pinned handle과 OS identity·길이·mtime이 같은 staging hardlink snapshot만 읽는다.
  canonical snapshot 경로를 강제하고 same-size/same-time 원본 교체, success/error/cancel cleanup을
  검증했다. hardlink가 불가능한 volume/filesystem은 Pass A 전에 기존 Rust provider로 fallback한다.
  outer query coordinator의 pinned/current OS identity 검사는 worker 후·publish 직전·publish 후에도
  유지된다.

국소 Rust 검증은 Polars 13 PASS, 실제 high cancel 0.13초 PASS, same-size/time 새 file identity 거부
PASS, format/check/Clippy PASS다.

잔여 MEDIUM은 Windows `GetFileInformationByHandle` 자체가 실패하는 특수 filesystem/driver에서
query coordinator의 identity가 creation-time fallback으로 약화되는 점이다. 일반 NTFS 대표 경로는
volume serial+file index 검증을 통과하지만, 엄격한 publish 무결성 계약에서는 이 fallback을
fail-closed로 바꾸는 후속 보완이 필요하다.

그 외 남은 항목은 제품 코드를 임의로 PASS 처리하지 않는다. WebView2 CDP, 150% DPI, clean install은
해당 환경에서 다시 실행하고, 성능·fault·soak는 계획의 표본 수와 원시 artifact를 채운 뒤에만 Phase를
`완료`로 전환한다.
