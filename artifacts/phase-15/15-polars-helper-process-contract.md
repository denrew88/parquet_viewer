# Polars CSV helper process 계약

## 목적

Polars streaming sink는 프로세스 내부의 cooperative cancel만으로 1초 이내 종료를 보장하지
못했다. 5,850,000행 CSV 취소 spike에서 작업이 약 63.3초 뒤 `QueryFailed`로 끝났으므로,
제품 경로는 동일 EXE의 내부 worker mode를 별도 프로세스로 실행한다. 이 문서는 구현과
검증에서 지켜야 할 최소 계약을 고정한다.

## 소유권과 게시 경계

- parent는 기존 Rust 구조 검사와 state/checkpoint 생성을 수행하고 pinned source handle,
  generation, cancel token, staging lease를 계속 소유한다.
- parent는 Pass A 전에 staging root에 pinned handle과 OS file identity가 같은 hardlink snapshot을
  만들 수 있는지 probe한다. 다른 volume이나 filesystem 정책 때문에 불가능하면 helper를 시작하지
  않고 기존 Rust provider를 사용한다.
- classifier가 `PolarsEligible`을 반환한 경우에만 helper를 정확히 한 번 실행한다.
- helper는 parent가 할당한 staging root의 `prepared.parquet.partial`만 생성한다.
- helper는 persistent cache, manifest, stable artifact, DuckDB view와 Ready 상태를 직접
  생성하거나 게시하지 않는다.
- 성공한 helper를 reap한 뒤 parent가 request nonce, source fingerprint, output byte,
  physical schema를 검증한다.
- parent는 현재 generation과 cancel 상태 및 pinned/current source fingerprint를 다시
  검사한 뒤에만 fsync, atomic rename, persistent cache publish와 Ready 전환을 수행한다.
- helper 실행 이후 오류가 발생하면 같은 generation에서 Rust 전체 준비를 자동 재실행하지
  않는다. 사용자에게 typed preparation error를 반환하고 새 요청에서 다시 시작한다.

## 내부 진입점

- 별도 sidecar를 배포하지 않고 최종 `data-viewer.exe`를 내부 worker mode로 실행한다.
- Tauri 초기화와 OS file-open operand 처리보다 먼저 strict worker argv를 판별한다.
- worker request는 절대 경로인 staging root를 기준으로 하며 output 파일명은 worker가
  상수로 파생한다. request가 임의 output 경로를 지정할 수 없어야 한다.
- worker source는 canonical `staging_root/polars-source.snapshot.csv`와 정확히 같아야 하며 원본
  사용자 경로를 직접 다시 열지 않는다.
- request/result는 schema version과 parent가 만든 nonce를 포함한다. result가 없거나,
  64MiB를 넘거나, schema/nonce가 다르면 성공으로 인정하지 않는다. writer도 파일 생성 전에 같은
  상한을 검사한다.
- stdout/stderr는 제품 IPC로 사용하지 않고 닫거나 bounded 처리한다.

## Windows 종료 계약

- parent는 helper를 Windows Job Object에 할당하고 `KILL_ON_JOB_CLOSE`를 적용한다.
- cancel, tab close, session replace와 app shutdown 시 job을 종료하고, direct child kill을
  fallback으로 사용한다.
- 종료 요청 뒤 반드시 `Child::wait()`까지 완료해 reap한다. signal 전송만으로 Cancelled를
  보고하지 않는다.
- reap 뒤에만 request/result/partial을 정리하고 staging lease를 해제한다.
- cancel 이후 progress/write/rename/manifest commit 같은 late activity가 없어야 한다.
- 정상 persistent Ready cache는 leak가 아니지만 helper process, handle, lock, lease와
  현재 generation의 partial은 모두 0이어야 한다.

## 필수 검증

1. tiny CSV worker 성공: row order, raw/typed/empty/null/invalid/state word parity를 확인한다.
2. duplicate/reserved header와 allow-list dialect에서 Rust oracle과 결과를 비교한다.
3. 5,850,000행 high CSV를 시작한 뒤 취소하여 kill, wait, cleanup까지 1초 이내인지 잰다.
4. 취소 뒤 helper PID가 없고 partial/result/request가 남지 않으며 stable cache 증가가
   없는지 확인한다.
5. source 교체, wrong nonce, malformed/oversize result, nonzero exit에서는 publish가 0인지
   확인한다.
6. feature OFF에서는 worker 진입점과 실행이 없어야 한다. feature ON release/NSIS에서는
   별도 sidecar 없이 같은 EXE worker mode가 동작해야 한다.
7. high CSV cold 준비 5회 median 15초 이하, p95 20초 이하, parent와 helper를 합친 peak
   RSS 1.5GiB 이하를 확인한다.
8. Ready 뒤 page, filter, multi-sort, Ctrl navigation과 copy가 원본 CSV를 다시 읽지 않는지
   확인한다.

위 조건을 통과하기 전에는 Polars allow-list를 활성화하거나 Phase 15를 완료로 표시하지
않는다.
