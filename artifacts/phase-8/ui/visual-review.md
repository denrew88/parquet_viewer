# Phase 8 visual review

- 실행일: 2026-07-15
- 판정: native 3 viewport PASS, Browser screenshot BLOCKED

## Native screenshot

| Viewport | 파일 | 확인 결과 |
| --- | --- | --- |
| 1440x900 | `native-main-1440x900.png` | CSV/Parquet 탭, grid, pager, status 겹침 없음 |
| 1024x768 | `native-context-1024x768.png` | 선택 셀과 메뉴 4 actions, clipping 없음 |
| 800x600 | `native-tabs-800x600.png` | 8개 문서 중 가시 탭과 overflow 이동 control, grid 겹침 없음 |

선택은 fill과 border로, active tab은 underline과 배경으로 구분된다. 컨텍스트 메뉴는
선택 셀을 가리지 않는 위치에 표시되고 command label과 단축키가 잘리지 않는다.

Browser backend가 없어 DOM geometry와 Browser screenshot은 BLOCKED다. 실제 150% DPI
스크린샷도 남기지 못했다.
