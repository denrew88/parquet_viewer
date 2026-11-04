# CSV native Parquet 변환 — 정식 검증 기록

2026-11-04 기존 경량화 결과를 **Phase 20**으로 통합 등록했다. [현재 Phase 범위·버전·경로](../README.md)를 따른다. 기존 비교 구현과 검증본을 보존했으며 원래 full-Polars 제품 manifest는 이번 정리에서 교체하지 않았다. 전체 gate나 외부 배포 완료를 뜻하지 않는다.

## 최신 결과

- [소수 GiB Storage 입력 수정](../storage-decimal/90-results.md): 0.3GiB 등 소수 입력·정수 byte 저장·재열기와 새 EXE의 실제 UI 검증.
- [작은 Storage 한도에서 여러 CSV 오류 수정](../storage-pressure/90-results.md): 현재 EXE의 후속 수정과 실제 512MiB/1GiB 검증 기록. 현재 크기·해시는 [20-build.json](../20-build.json)을 따른다.
- [확대 검증 보고서](snapshot/validation/90-results.md): 수정한 결함, 검증 범위, 성능과 남은 제한.
- [이전 검증본 전체 앱 크기](snapshot/validation/60-size-corrected.json): UI 포함 **56.0356MiB**, 기준 103.6714MiB 대비 **45.9488% 감소**. 이전 55.85MiB는 UI 누락으로 무효다. 후속 수정 EXE와 당시 해시를 혼동하지 않는다.
- [성능 원시 값](snapshot/validation/performance/final/results.json): 5개 입력 형태, 34회 변환. 979MB CSV는 중앙값 6.009→5.958초로 동급, CPU 25.047→20.578초.
- [최종 출처·판정](snapshot/validation/80-final-evidence.json), [파일별 SHA-256](10-manifest.json).
- [검증 계획](snapshot/validation/00-scope.md), [초기 독립 리뷰](snapshot/validation/quality/30-initial-review.md), [기존 Polars와 다른 2건의 판정](snapshot/validation/quality/90-final-adjudication.json).

## 실행 파일과 fixture

- [현재 GUI EXE](../../../src-tauri/target/release/data-viewer.exe): [현재 빌드 해시](../20-build.json). 기존 제품과 다른 앱 identifier로 캐시·설정을 분리한다.
- [독립 변환기](../../../src-tauri/target/release/phase20-reference/csv-native-parquet-validation.exe): 성능 비교용 CLI. 앱 UI가 아니다.
- [Timestamp CSV](../../../fixtures/phase-20/timestamp.csv), [내용·예상 결과](../../../fixtures/phase-20/timestamp.README.md). 생성 시 CSV 구조·정수 나노초를 확인했으며, 이후 앱 실행 검증은 Phase 20 재빌드 기록에서 구분한다.

EXE는 로컬에 실제 복사하고 해시를 검증했으며 Git에는 넣지 않는다. 외부 배포나 설치를 수행하지 않았다. 승격본과 해시가 같은 원래 EXE·증거·fixture 사본은 사용자 지시로 삭제했다. [정리 목록](../prior-duplicate-cleanup.json)에 삭제 경로와 남겨 둔 정식 경로를 기록했다.

## 현재 빌드

GUI 빌드의 기본 파일명은 `data-viewer.exe`이며 현재 진입점은 `artifacts/phase-20/native/build.ps1`이다. 일반 빌드의 draft와 컴파일 cache는 기존 experiment/.tmp 경로를 사용하며 정식 EXE는 `src-tauri/target/release/data-viewer.exe`다. 승인된 승격만 정식 EXE와 Phase 20 build 기록을 교체한다. 이미 검증한 draft를 승격하려고 재빌드하지 않는다. 이번 등록에서는 빌드하지 않고 기존 EXE를 이동했다.

이번 현재 EXE는 2026-11-04 사용자의 명시적 승격 지시로 정식 보존했다. [현재 파일 해시](../20-build.json)와 [승격 목록](../prior-promotion-manifest.json)을 확인한다. 빌드 전 `storage-pressure/sync_runtime.cjs`가 공유 storage/query 소스와 worker 수정 patch를 실제 native 빌드에 동기화한다. 앱 identifier는 유지했다. 과거 snapshot·10-manifest.json의 이전 파일명·해시는 당시 증거로 보존한다.

## 보존 내용과 재현

`snapshot/`에는 최종 검증 결과·성능 원시 집계·핵심 변환 소스·설정과 재현 harness를 선별 보존한다. 사용자 정리 지시에 따라 중간 실행별 JSON·로그, 중복 앱 소스와 폐기된 일회성 승격 도구는 제거했다. 과거 10-manifest.json은 최초 보관 당시의 목록이며 현재 목록은 상위 40-manifest.json과 45-cleanup.json을 따른다.

현재 GUI 빌드는 위 정식 진입점을 사용한다. 현재 빌드·테스트가 직접 사용하는 소스와 harness는 experiment 경로에 유지했다. 보존된 테스트 harness는 **원래 experiment 경로에서 실행**한다. snapshot 내부 harness를 직접 실행하면 상대 경로가 달라진다. 정리로 삭제한 과거 입력·실행 파일이 필요한 harness는 정리 목록의 정식 보관 경로에서 필요한 파일만 원래 위치로 복원한 뒤 실행한다. 현재 native 검증 runner는 새 draft 빌드 후 실행하며, 정리된 draft EXE가 계속 있다고 가정하지 않는다. 다른 checkout에서 재현할 때 snapshot 내용을 manifest의 `canonicalExperimentPath`에 복원한 뒤 harness를 사용해야 한다. 기존 Polars 기준 EXE, 공유 대용량 fixture와 오프라인 toolchain은 별도 로컬 의존성이며 manifest/result JSON에 원래 경로·해시가 남아 있다. 이 보관본이 독립 실행 가능한 전체 빌드 환경이라는 뜻은 아니다.

대표 명령(저장소 루트 PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/experiments/csv-native-parquet/build.ps1 -Stage build -OutputName csv-native-parquet-validation.exe
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/phase-20/native/build.ps1
C:/ProgramData/miniforge3/python.exe artifacts/experiments/csv-native-parquet/run_compare.py --stage validation-matrix --label final --validation-binary
```

실제 앱 검증본의 고유 identifier 및 frontendDist 정정은 [동기화 스크립트](snapshot/validation/sync_variant.cjs), [보존한 config](snapshot/size-variant/tauri.conf.json)를 따른다. 이전 잘못된 빌드 결과를 최신값으로 사용하지 않는다. 성능 비교는 Timestamp/Duration fast lane을 검증하지 않았으며 해당 타입은 기존 Rust fallback을 사용한다. 수정 후 독립 재리뷰는 agent provider 사용량 제한으로 실행하지 못했고 루트가 최종 gate를 실행했다.

대용량 변환 출력·임시 파일·WebView profile·Cargo build cache는 snapshot에 포함하지 않았다. 원시 JSON의 외부 절대 경로는 당시 실행 증거이며 이동된 경로로 고쳐 쓰지 않았다. 이번 승격은 기존 측정을 다시 실행하지 않고 증거의 동일성을 확인한 문서·산출물 정리다.
