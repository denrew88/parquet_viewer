# Phase 4 범위

- 시작일: 2026-07-14
- 목표: 대화상자, OS drag and drop, 시작 인자, 파일 연결, 이미 실행 중인 앱 전달이 하나의 안전한 파일 열기 수명주기를 사용하게 한다.

## 확정 계약

- 모든 진입점은 하나의 OpenCoordinator와 `open_data_file` 계약을 사용한다.
- 새 source의 summary와 첫 페이지를 모두 검증한 뒤 active session을 원자적으로 교체한다. 실패하면 기존 session과 UI를 유지한다.
- 동시에 여러 요청이 진행되면 마지막으로 시작한 request ticket만 commit한다. 이전 결과는 성공·실패와 무관하게 stale로 폐기한다.
- 단일 CSV 또는 Parquet만 허용한다. 다중 drop은 `MultipleFilesNotSupported`, 그 외 형식은 `UnsupportedFormat`이다.
- Tauri OS drag event의 enter/over/drop/cancel을 사용하고 실제 drop 가능 상태만 전체 workspace 경계로 표시한다.
- 첫 실행은 `OsString` argv에서 지원 파일 경로를 찾고, 실행 중인 앱에는 single-instance callback으로 경로를 전달한다.
- Windows bundle에 CSV/Parquet file association을 등록한다.
- 경로는 Rust까지 `PathBuf`/`OsString`으로 유지하고 사용자 메시지·로그에 파일 전체 내용을 기록하지 않는다.
- 성공한 교체와 close는 이전 worker, checkpoint, page cache, handle을 해제한다.

## 소유권

| 역할 | 범위 |
| --- | --- |
| Tauri platform 주담당 | `src-tauri/**`, single-instance, argv, file association, coordinator |
| Grid UX 협업 | `src/**`, drag state, drop/open event, stale UI |
| Quality | native/Browser/soak/회귀 증거 |
| Root | manifest·공통 계약 통합과 최종 판정 |

## 완료 조건

- `T-P4-001`~`T-P4-062`가 PASS 또는 구체적 환경 원인의 BLOCKED다.
- 네 진입점이 동일한 검증, 오류, session 교체 규칙을 사용한다.
- 실제 Windows native dialog와 가능한 OS 진입점 증거를 남긴다.
- Browser와 Explorer 조작이 불가능하면 자동 테스트로 대체 판정하지 않고 BLOCKED로 남긴다.
