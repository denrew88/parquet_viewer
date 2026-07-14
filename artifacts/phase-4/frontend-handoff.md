# Phase 4 Frontend Handoff

## 구현 범위

- `src/dragDrop.ts`에 실제 Tauri Webview `onDragDropEvent` 어댑터와 브라우저 테스트 어댑터를 추가했다.
- workspace 전체를 드롭 대상으로 사용하며 `enter`, `over`, `leave`, `drop` 상태를 처리한다.
- 단일 CSV/Parquet 드롭은 `open_data_paths`로 열고, 여러 파일 및 미지원 확장자는 typed error를 표시한다.
- 파일 대화상자는 `select_data_file_paths({ requestId })`를 사용하며 summary와 initial page를 원자적으로 받는다.
- 시작 인자, 파일 연결, 두 번째 인스턴스 요청은 `open-paths-requested` 이벤트와 `take_pending_open_requests`를 통해 소비한다.
- pending queue와 event에 같은 요청이 들어오는 경우 `requestId` 기준으로 한 번만 처리한다.
- 새 파일을 읽는 동안 기존 grid/tab을 유지하고, 성공 시 summary와 initial page를 함께 교체한다.
- 최신 generation보다 늦은 성공 및 실패는 grid, error banner, busy 상태를 변경하지 않는다.
- 드롭 오버레이는 반복 `over`에서 중복 생성되지 않으며 `leave` 또는 Escape로 제거된다. Escape는 현재 focus를 이동시키지 않는다.
- Tauri reject envelope의 nested `{ error: { code, message } }`를 typed `DataViewerError`로 정규화한다.
- 브라우저 mock은 CSV/Parquet 열기, multiple/unsupported error, 느린 요청, 외부 open event를 지원한다.

## 주요 계약

- `open_data_paths`: `{ request: { requestId, origin, paths } }`
- `select_data_file_paths`: `{ requestId }`, 취소 시 `null`
- `take_pending_open_requests`: 인자 없음
- `open-paths-requested`: `OpenDataRequest` payload
- origin: `dialog | dragDrop | startupArg | fileAssociation | secondInstance`
- 성공: `{ requestId, origin, sessionId, summary, initialPage }`
- 실패: `{ requestId, origin, error: { code, message } }`

## 변경 파일

- `src/App.tsx`
- `src/App.css`
- `src/App.test.tsx`
- `src/backend.ts`
- `src/backend.test.ts`
- `src/dragDrop.ts`

## 자동 검증

- `npm run format:check`: PASS
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test -- --run`: PASS, 64/64
- `npm run build`: PASS

## 다음 단계 확인 사항

- 실제 Tauri 창에서 탐색기 drag enter/over/leave/drop 이벤트와 좌표 변환을 확인한다.
- Windows 시작 인자, 파일 연결, 두 번째 인스턴스 전달을 패키징된 앱에서 확인한다.
- 1280x800 및 800x600에서 드롭 오버레이, 기존 grid 보존, error banner 겹침 여부를 스크린샷으로 확인한다.
- 실제 다중 파일 및 미지원 파일 드롭에서 backend typed error 문구와 기존 scroll 위치 보존을 확인한다.
