# Phase 7 범위

- 시작일: 2026-07-14
- 목표: 성능·자원·보안·설치 계약을 검증하고 재현 가능한 Windows release를 만든다.

## 확정 계약

- benchmark와 soak는 `artifacts/phase-7/`에 원시 JSON과 요약을 남긴다.
- open, first page, cached page, random page, scroll/input latency, peak memory에 명시적 예산을 둔다.
- open/close/replace/cancel 100회 후 worker, handle, memory가 bounded인지 확인한다.
- CSP는 `null`을 금지하고 필요한 Tauri IPC만 허용하는 최소 정책으로 고정한다.
- capability와 dependency를 감사하고 앱은 읽기 전용 파일 접근만 사용한다.
- Windows 배포 대상은 NSIS로 고정하고 CSV/Parquet file association을 포함한다.
- README에는 지원 범위, 제한, 키보드 선택, 복사 한계, build/test/release 명령을 기록한다.
- 실제 clean VM 설치·Excel·Explorer·Browser가 없는 환경은 정확한 항목만 BLOCKED로 남긴다.

## 완료 조건

- `T-P7-001`~`105`를 판정한다.
- 자동 gate, benchmark, soak, security audit, NSIS bundle 생성이 통과한다.
- 미실행 외부 환경 검증과 알려진 제한이 문서화된다.
