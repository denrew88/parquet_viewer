# Phase 17 Native smoke

- 실행일: 2026-07-30
- 실행 파일: `src-tauri/target/release/data-viewer.exe`
- fixture: `fixtures/phase-15/boundary-5850000-high.parquet`
- 판정: PASS

서로 4,000행씩 떨어진 uncached 위치 20곳을 빠르게 이동했다. 각 cycle의 `read_page`는 정확히 1회였고
정착부터 cell populated까지 p95는 75.5ms였다. 마지막 cache page 재방문은 33.6ms, `read_page` 0회였다.
`Ctrl+Alt+ArrowDown`으로 5,849,999행에 이동했을 때 page read는 1회였고 셀 높이 48px, 하단 여백
18px, grid focus를 유지했다. 20회와 마지막 행 이동 사이 working set 증가는 5,685,248 bytes
(약 5.4MiB)였다.

정량 원본은 `native-scroll-performance.json`, 화면 증거는 `native-desktop.png`에 있다.
