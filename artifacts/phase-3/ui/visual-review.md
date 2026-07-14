# Phase 3 시각 검토

- 판정: `BLOCKED`
- 대상: T-P3-050, T-P3-051

in-app Browser backend가 없어 1440x900, 1024x768, 800x600 viewport의 DOM geometry와
screenshot을 만들 수 없었다. 실행하지 않은 화면을 PASS로 추정하지 않았으며 빈 이미지나
standalone 도구 결과도 증거로 만들지 않았다.

native 창 역시 이 실행 세션에서 visible window handle을 얻지 못했으므로 Browser screenshot을
native screenshot으로 대체하지 않았다.
