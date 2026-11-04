# 개발 실행과 작업 효율 — 정식 기록

2026-11-04 사용자 지시로 정식 승격했다.

- 실행 도구: [dev-check.mjs](../../scripts/dev-check.mjs)
- 필수 지침: [AGENTS.md](../../AGENTS.md), [AI_WORK_POLICY.md](../../docs/AI_WORK_POLICY.md)
- 핵심: 시작 시 범위와 종료 조건 고정, 환경 먼저 확인, 실패 범위만 재실행, 코드 확정 뒤 필요한 빌드, 기존 명령 승인 재사용, 완료 후 불필요한 작업 추가 금지.
- 개발 명령은 `node scripts/dev-check.mjs TASK [FILTER]`로 고정하고 환경변수·로그 처리는 내부에서 수행한다. 9개 dry-run 계획과 literal filter 전달, 지원하지 않는 동작 거부를 확인했다. 이 도구 정리 때문에 제품 전체 테스트나 빌드를 다시 실행하지 않았다.
- 네트워크 설치·Git index/이력 변경·배포·보안 정책 변경을 이 실행 범위에 넣지 않았다. host가 강제하는 새 승인을 없애거나 보안 권한을 확대한 것이 아니다.
- 앞으로는 결과가 준비된 뒤 **정식 artifacts 편입 직전에 한 번 확인**한다. 사용자 지시가 명시적이면 재확인하지 않는다. 이번 승격은 이미 승인받았다.

당시 파일 해시는 [기존 승격 manifest](../phase-20/prior-promotion-manifest.json)에 보존한다.
현재 경로는 [Phase 20](../phase-20/README.md)과 [이동 목록](../phase-20/30-relocation.json)을 따른다.
