# 소수 GiB Storage 설정 — 정식 artifacts

2026-11-04 사용자 지시로 정식 승격했다.

- [결과·검증 범위](90-results.md), [독립 검토](95-review.md)
- [실제 Tauri 결과](native-result.json), ui/의 세 viewport 화면·geometry와 native 화면
- 컴포넌트·E2E 소스, 설정 UI 수정, 실행 harness, 현재 EXE는 [통합 승격 목록](../prior-promotion-manifest.json)에 경로와 해시를 고정했다. 같은 소스를 다시 복제하지 않았다.

Frontend 414개와 최초 E2E 122개 통과 후 실패 1건의 테스트 동기화를 수정해 관련 6개를
재실행했다. 단일 clean 123/123 실행으로 표시하지 않는다. 판정에 쓰인 원시 로그와 대표 화면은
유지하고, 중복 로그·과거 Phase capture 임시 복사본·브라우저 프로필은 후속 정리에서 제거했다.
