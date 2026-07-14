# Phase 6 범위

- 시작일: 2026-07-14
- 목표: 가상화·페이지 경계를 넘어 Excel 방식의 논리 선택과 안전한 TSV 복사를 제공한다.

## 확정 계약

- 선택 state는 anchor, active cell, 정규화된 직사각형 범위를 DOM과 분리해 관리한다.
- click, drag, Shift-click, 행·열 header, Arrow/Shift/Ctrl/Ctrl+Shift/Home/End/PageUp/PageDown/Ctrl+A/Escape와 macOS Meta를 지원한다.
- input, search, resize control에 focus가 있으면 grid 키를 가로채지 않는다.
- 선택 active cell은 가상화 unmount와 page fetch 후에도 유지하고 필요 시 자동 scroll한다.
- TSV는 열 tab, 행 CRLF를 사용한다. null은 빈 field, 빈 문자열도 빈 field이며 header는 명시적 선택 때만 포함한다.
- soft limit은 100,000셀 또는 8 MiB, hard limit은 1,000,000셀 또는 64 MiB다.
- 복사 chunk는 200행 또는 4 MiB이며 progress, cancel, generation 기반 stale 차단을 제공한다.
- OS clipboard는 Tauri 공식 clipboard manager plugin을 사용한다.

## 완료 조건

- `T-P6-001`~`104` 자동·Browser·native·Excel gate를 판정한다.
- 실제 clipboard와 Excel paste는 unit TSV roundtrip으로 대체하지 않는다.
