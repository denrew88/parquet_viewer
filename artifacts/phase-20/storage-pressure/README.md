# Storage 공간 부족 오류 수정 — 정식 artifacts

2026-11-04 사용자 지시로 정식 승격했다.

- [결과·한계](90-results.md), [독립 검토](95-review.md), [출처와 해시](80-evidence.json)
- [테스트 계획](10-test-plan.md), [통합 기록](50-integration.md)
- 실제 512MiB/1GiB 결과: fixed-512/results.json, fixed-1024/results.json
- 원본·직접 변환기·runtime 공유 소스와 worker patch는 통합 승격 manifest에 해시로 고정한다.

이 기록의 실행 파일 해시는 당시 검증한 Storage 수정본이다. 이후 소수 GiB UI 수정이 포함된
현재 정식 EXE는 [통합 승격 목록](../prior-promotion-manifest.json)과 [현재 build metadata](../20-build.json)를 따른다. 이전 실행 증거를 새 EXE에서 실행한 것처럼 바꾸지 않았다.

대용량 입력·반복 출력·브라우저 profile·중간 로그는 로컬 재현 자료이며 Git 제외 규칙을 유지한다.
전체 Phase 완료와 외부 배포를 뜻하지 않는다.
