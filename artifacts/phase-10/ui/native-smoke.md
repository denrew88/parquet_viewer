# Phase 10 native Tauri smoke

- 실행일: 2026-07-17
- 환경: Windows WebView2, debug static HDF5 build, 100% scale

`scripts/native_oes_smoke.mjs`가 실제 Tauri executable을 startup `--file` 경로로 실행하고 CDP를
통해 generic grid와 Windows clipboard를 검사했다.

- committed `oes-core-vlen-time.oes.h5`: 3 rows, 5 columns, final header
  `900.0000000001`, final value와 clipboard `203` PASS
- external `sample_current_rules.oes.h5`: 128 rows, 65 columns, final header
  `900.0000000001`, final value와 clipboard `24971` PASS
- query search control count 0 PASS

native app은 `%LOCALAPPDATA%`의 기존 query-temp lifecycle을 사용하므로 workspace sandbox 밖 실행을
허용한 뒤 검증했다. dialog를 사람 입력으로 선택하는 동작, OS drop, 150% DPI, installer 설치본과
clean VM은 BLOCKED다.
