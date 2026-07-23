# Phase 14 네이티브 스모크 결과

- 판정: **PASS**
- 실행 파일: `src-tauri/target/release/data-viewer.exe`
- 입력 파일: `.tmp/phase14-fixtures/small/csv-state-matrix.csv`
- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| NATIVE14-RUNTIME | PASS | Tauri URL, Rust invoke와 WebView2 CDP를 확인했습니다. |
| NATIVE14-SORT | PASS | 빈 level 추가 후 컬럼을 결정하고 명시적으로 Apply했습니다. |
| NATIVE14-SETTINGS | PASS | 기본 표시 설정과 단일 인라인 상세 accordion을 확인했습니다. |
| NATIVE14-COLUMN-DRAG | PASS | 헤더와 mounted 셀 strip, live reflow, 원본 순서 복원을 확인했습니다. |
