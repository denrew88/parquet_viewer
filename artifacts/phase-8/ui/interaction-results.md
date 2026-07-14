# Phase 8 UI interaction 결과

- 실행일: 2026-07-15
- 판정: component/native PASS, Browser BLOCKED

## PASS

- pointer 우클릭이 셀을 선택하고 4개 action 메뉴를 연다.
- `Shift+F10`, Context Menu key, Arrow/Home/End, Enter/Space, Escape와 focus 복귀는
  component test에서 PASS했다.
- Ctrl+C와 메뉴 Copy는 같은 TSV pipeline을 사용하며 chunk copy 취소와 unmount 폐기를 검증했다.
- 실제 Tauri 1024x768에서 메뉴가 셀 선택 위에 열리고 viewport 안에 배치됐다.
- 실제 메뉴 Copy 실행 후 Windows Unicode clipboard 값은 `1`이었다.
- 파일 탭 roving focus, Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W, active close focus를 검증했다.
- pending batch cancel, same-path reopen 양방향 race, late session cleanup을 검증했다.

## BLOCKED

- in-app Browser backend가 `No browser is available`을 반환해 Browser pointer/keyboard trace는
  생성하지 못했다.
- 실제 Excel paste와 150% DPI native pointer interaction은 실행하지 못했다.
