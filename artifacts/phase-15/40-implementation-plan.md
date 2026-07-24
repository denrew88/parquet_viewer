# Phase 15 구현 순서

이 문서는 Phase 15 전체 작업 순서를 정의한다. Polars 최신 streaming provider의 제품 통합 상세는
`41-polars-product-integration-plan.md`를 따른다. 계획과 POC 작성은 코드 통합 완료나 Phase 완료를
의미하지 않는다.

## 1. Quality 기준선 고정

- Phase 14 high profile JSON/Markdown과 fixture hash를 기준선으로 고정한다.
- 제품 계측의 행별 `Instant` 오버헤드는 최종 benchmark에서 제거한다.
- `10-test-plan.md`의 gate별 test owner, 명령, raw artifact 경로를 먼저 확정한다.
- 현재 EXE 78,997,504 bytes와 NSIS 13,763,973 bytes를 dependency 도입 전 기준으로 기록한다.

## 2. 의존성 없는 병목 수정

1. `CellStateBitmap::write_file`을 연속/buffered write로 변경한다.
2. bitmap format parity, corruption과 fault test를 추가한다.
3. persistent cache 최종 위치의 `.partial` 디렉터리에 직접 쓰도록 publish lifecycle을 바꾼다.
4. source mutation, stale generation, disk-full, crash janitor와 lease를 재검증한다.
5. 동일 fixture를 다시 측정해 이 두 수정의 독립 개선 시간을 기록한다.

이 단계는 Polars 도입 여부와 관계없이 제품에 남길 수 있다.

## 3. 자동 타입 profile 고정

- preview sampler에 10,000 records/8MiB 상한과 보수적 inference를 구현한다.
- Auto에서는 modal을 열지 않고 profile hash를 확정한다.
- full scan cast 실패는 invalid+raw로 기록한다.
- Ask Every Time과 사후 Parsing Profile만 명시적 사용자 확인 경로로 둔다.
- TypeScript/Rust profile validation과 preview/apply/session parity test를 추가한다.

## 4. compact cache와 frontier

- 46열 normalized/raw/invalid layout을 typed+필요한 raw shadow+state layout으로 바꾼다.
- 65,536행/64MiB 경계의 part writer와 최대 2 batch bounded queue를 만든다.
- 닫힌 part, bitmap word와 coordinator frontier를 같은 generation snapshot으로 게시한다.
- profile 변경 시 모든 raw 열을 source scan 없이 재구성하는 test를 만든다.
- DuckDB view와 raw page/copy projection을 새 schema에 연결한다.

## 5. Polars Rust POC

최신 Polars 0.54.4 POC의 시간·RSS·기본 출력 parity는 완료했다. 상세 결과는
`31-polars-rust-poc.md`에 기록한다. 남은 dialect·취소·패키징 gate와 제품 통합은
`41-polars-product-integration-plan.md` 순서로 수행한다.

- 별도 provider/benchmark feature로 exact version과 최소 feature를 pin한다.
- 제품과 같은 fixture, compact schema, state, checksum, publish를 수행한다.
- 전체 collect 없이 streaming plan인지 physical plan과 RSS로 확인한다.
- 5회 cold 시간, CPU, RSS, cancel, dialect parity와 source/cache byte를 수집한다.
- 도입 전후 clean release EXE, NSIS와 build 시간을 측정한다.

단순 typed Parquet 2.175초 수치를 제품 POC 결과로 간주하지 않는다.

## 6. 채택 판단

다음 조건을 모두 만족하면 Polars provider를 기본 CSV preparation 경로로 연결한다.

- high cold median 15초, p95 20초 이하
- peak RSS 1.5GiB와 decoded batch 64MiB 이하
- cancel 1초 이하
- raw/typed/state/dialect parity 전부 PASS
- source/cache lifecycle과 fault test PASS
- executable/installer 증가량을 사용자에게 보고하고 통합 승인 획득

하나라도 실패하면 dependency를 제품 기본 feature에 포함하지 않고 개선된 Rust 경로를 유지한다.

## 7. 제품 통합

- `CsvPrepareCoordinator` 뒤 provider만 교체하고 Tauri command와 frontend DTO는 유지한다.
- progress stage와 계측을 Settings/Metadata가 아닌 기존 상태 영역에 간결하게 표시한다.
- stale response, tab 전환, foreground 우선순위, close/reopen과 cache lease를 통합한다.
- query/page/navigation/copy는 같은 generation의 manifest와 frontier만 읽게 한다.

## 8. 최종 검증

1. low/high/long-invalid release 성능 표본을 모두 수집한다.
2. Rust/frontend/Playwright 전체 suite를 한 번 실행한다.
3. 세 viewport geometry/screenshot과 실제 Tauri를 검증한다.
4. 100회 lifecycle, writer fault, full copy, 150% DPI 가능한 항목을 검증한다.
5. release EXE와 NSIS를 최종 한 번 빌드하고 hash·크기를 기록한다.
6. 독립 리뷰에서 HIGH/MEDIUM과 필수 NOT_RUN을 확인한다.

필수 gate가 남아 있으면 Phase 15를 완료로 바꾸지 않는다.
