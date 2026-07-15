# Phase 9 visual review

- 실행일: 2026-07-15
- Browser 판정: 3 viewport PASS
- WebView2 판정: 최종 release PASS

| 화면 | 파일 | 결과 |
| --- | --- | --- |
| Browser 1440x900 | `browser-wide.png` | 주요 toolbar/dialog/popover clipping 0 |
| Browser 1024x768 | `browser-compact.png` | compact layout clipping 0 |
| Browser 800x600 | `browser-minimum.png` | filter popover 포함 viewport 이탈 0 |
| Native profile | `native-csv-profile-{comma,dot,space}.png` | selection, option, converted preview 정상 |
| Native query/copy | `native-query-copy-{comma,dot,space}-passed.png` | filter chip, sort priority, formatted cells 정상 |
| 최종 배포 화면 | `final-release.png` | blank/overlap 없음, 기본 Copy(EXCEL) 복원 확인 |

Playwright는 각 dialog와 보이는 내부 control의 bounding box, body 수평 overflow를 assertion으로
검사했다. 실제 WebView2에서는 startup argv CSV, profile, query와 clipboard 흐름을 locator로
조작했다. 최종 배포 EXE의 WebView2 command line에서 `remote-debugging-port`가 없음을 확인했다.

150% DPI는 실행하지 않아 별도 Windows 환경 gate로 남긴다.
