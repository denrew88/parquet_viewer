# Phase 20 기존 검증 대응표

이 문서는 완료된 작업의 증거를 Phase 20에 연결한다. 새로운 테스트 실행 결과가 아니다.

| ID | 대상 | 기존 결과 / 근거 |
| --- | --- | --- |
| P20-CSV | CSV 변환 정확성·성능·크기 | native/snapshot/validation/90-results.md; 5입력·34회 성능 비교, 979MB 중앙값 6.009→5.958초 |
| P20-RUST | Storage 및 백엔드 회귀 | storage-pressure/90-results.md; 314 PASS, 기존 16 ignored, fmt/Clippy PASS |
| P20-SPACE | 실제 다중 CSV·작은 한도 | storage-pressure/fixed-512/results.json 및 fixed-1024/results.json; cold/warm 각 4/4 Ready |
| P20-FAIL | 용량 초과·복구 | 512MiB typed 실패·기존 4개 보존·문서 닫기 후 재시도 PASS; 별도 1GiB 초과 변형 미실행 |
| P20-UI | 소수 GiB UI 및 프런트 | storage-decimal/90-results.md; frontend 414 PASS, 최초 E2E 122 PASS/1 FAIL 후 관련 6/6 PASS |
| P20-NATIVE | 0.3GiB 실제 앱 적용 | storage-decimal/native-result.json 및 ui/; 322122547 bytes·재열기·새 CSV page PASS |
| P20-MOVE | 이번 이동의 무결성 | 30-relocation.json; 소스·설정과 원시 증거 해시, EXE 동일성 확인 |

검토: storage-pressure/95-review.md, storage-decimal/95-review.md, native/snapshot/validation/quality/.
전체 installer/clean-machine/DPI/Excel·soak 등 미실행 항목은 각 원래 보고서에 남겨 둔다.
단일 clean E2E 123/123 실행이나 Phase 18의 미완료 gate 해소를 주장하지 않는다.

후속 P20-VERSION: 버전 재빌드 1회, Windows 두 버전·health_check·Tauri 버전 0.20.0, 실제 CSV 3행·Timestamp CSV 16행 page와 원본 해시 보존 PASS. 자세한 내용은 version-0.20.0/90-results.md. 전체 suite 재실행은 하지 않았다.

P20-VIEW-1~7: Utf8View scalar/dictionary/nested/Parquet roundtrip/occupancy와 전체 Rust·native PASS. [세부 계획](utf8-view/00-scope.md), [결과](utf8-view/90-results.md).
