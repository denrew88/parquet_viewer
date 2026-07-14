# Phase 4 Platform Handoff

작성일: 2026-07-14

## 구현 범위

- `OpenCoordinator`가 backend ticket을 발급하고, candidate에서 source open, summary, initial page를 모두 검증한 뒤 최신 ticket만 active session에 commit한다.
- 최종 latest 확인과 `SessionSlot::replace`를 같은 coordinator lock 구간에서 실행해 begin/commit 경쟁을 막는다.
- invalid, unsupported, corrupt, multiple, stale candidate는 기존 active session을 바꾸지 않는다.
- `MultipleFilesNotSupported`, `StaleOpenRequest` typed error를 추가했다.
- 상대 경로는 Rust에서 현재 작업 디렉터리 기준 절대 경로로 바꾸고 `PathBuf`로 유지한다.
- 초기 실행은 `args_os()`를 사용하며 option을 제외한 operand를 pending queue에 넣는다.
- `tauri-plugin-single-instance` callback은 두 번째 실행의 argv/cwd를 정규화해 같은 pending queue와 event로 전달하고 main window를 복원, 표시, focus한다.
- Windows bundle에 CSV와 Parquet viewer file association을 선언했다.
- 기존 `open_data_file`과 `select_data_file`은 호환을 유지하면서 내부적으로 coordinator를 사용한다.

## Frontend 계약

### `open_data_paths`

invoke args:

```json
{
  "request": {
    "requestId": "drag-1",
    "origin": "dragDrop",
    "paths": ["C:\\data\\file.parquet"]
  }
}
```

origin은 `dialog | dragDrop | startupArg | fileAssociation | secondInstance`이다.

success:

```text
{ requestId, origin, sessionId, summary: FileSummary, initialPage: DataPage }
```

reject:

```text
{ requestId, origin, error: { code, message } }
```

### `select_data_file_paths`

- args: `{ requestId: string }`
- cancel: `null`
- success/reject: `open_data_paths`와 같은 envelope

### Startup/Second Instance

- command: `take_pending_open_requests() -> OpenPathsRequest[]`
- event: `open-paths-requested`, payload `OpenPathsRequest`
- listener 유실을 막기 위해 queue와 event를 함께 사용한다. 양쪽에서 같은 request ID를 관찰할 수 있으므로 frontend adapter는 request ID로 dedupe해야 한다.

## 변경 파일

- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/domain/error.rs`
- `src-tauri/src/platform/mod.rs`
- `src-tauri/src/platform/open_coordinator.rs`
- `src-tauri/src/platform/startup.rs`
- `src-tauri/src/platform/session.rs`

## 검증 결과

- `cargo test`: PASS, 63 tests
- `cargo clippy --all-targets --all-features -- -D warnings`: PASS
- `cargo fmt --all -- --check`: PASS
- `cargo build`: PASS
- 포함 테스트: summary+initial page 원자 응답, multiple path session 보존, invalid request session 보존, Unicode/공백 경로, argv 상대 경로/cwd, pending queue 순서와 단일 drain, stale ticket commit 차단, replace/close source drop 1회.

## Root 통합 Gate에서 남은 항목

- frontend adapter와 response parser 통합 후 전체 frontend/Rust 회귀
- release Tauri build
- 실제 cold argv CSV/Parquet/Unicode 경로 실행
- 실제 두 번째 process 종료, 첫 window focus와 파일 교체 확인
- 실제 native drag/drop과 multiple drop 증거
- Windows installer 설치 후 CSV/Parquet Explorer file association 확인
- 20회 second-instance 및 100회 session 교체 soak

초기 argv만으로 association 실행인지 일반 CLI 실행인지 Windows가 별도 표식을 주지 않으므로 cold start origin은 `startupArg`, 실행 중 전달은 `secondInstance`로 기록한다. 설치 association의 실제 동작 여부는 native installer gate에서 별도로 판정해야 한다.
