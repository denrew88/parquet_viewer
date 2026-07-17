# Phase 10 UI interaction results

- `npm run test:e2e`: 27/27 PASS
- viewport: 1440x900, 1024x768, 800x600

OES mock을 generic open flow로 열고 65개 logical column을 확인했다. 마지막 wavelength `463`까지
수평 scroll한 뒤 논리 좌표 `[0,64]`의 값 `63`을 선택하고 clipboard에서 같은 값을 확인했다.
OES query capability가 없으므로 search/filter/sort control이 표시되지 않는 것도 검증했다.

DOM geometry는 세 viewport 모두 body horizontal overflow 0, header-cell 시작점/너비 오차 0px,
selection `[0,64]`, viewport 기반 mounted cell 152~308개를 기록했다.
