# CSV native Parquet 변환 — 정식 검증 기록

2026-11-04 정식 artifacts로 승격했다. 판정은 **검증된 비교 구현 보존 / 제품 채택 미적용**이다. Phase 완료, 정식 배포, 전체 UI gate 승인으로 해석하지 않는다.

## 최신 결과

- [확대 검증 보고서](snapshot/validation/90-results.md): 수정한 결함, 검증 범위, 성능과 남은 제한.
- [수정된 전체 앱 크기](snapshot/validation/60-size-corrected.json): UI 포함 **56.0356MiB**, 기준 103.6714MiB 대비 **45.9488% 감소**. 이전 55.85MiB는 UI 누락으로 무효다.
- [성능 원시 값](snapshot/validation/performance/final/results.json): 5개 입력 형태, 34회 변환. 979MB CSV는 중앙값 6.009→5.958초로 동급, CPU 25.047→20.578초.
- [최종 출처·판정](snapshot/validation/80-final-evidence.json), [파일별 SHA-256](10-manifest.json).
- [검증 계획](snapshot/validation/00-scope.md), [초기 독립 리뷰](snapshot/validation/quality/30-initial-review.md), [기존 Polars와 다른 2건의 판정](snapshot/validation/quality/90-final-adjudication.json).

## 실행 파일과 fixture

- [검증된 GUI EXE](bin/native-validation.exe): SHA-256 `cd10b4d667c1959679449d60bc2ef3cc5e42924408a3a7f568c7b716ac48563a`. 기존 제품과 다른 앱 identifier로 캐시·설정을 분리한다.
- [독립 변환기](bin/csv-native-parquet-validation.exe): 성능 비교용 CLI. 앱 UI가 아니다.
- [Timestamp CSV](fixtures/timestamp.csv), [내용·예상 결과](fixtures/timestamp.README.md). Fixture 생성·정수 나노초 검사는 완료했지만 이 fixture의 앱 실행 검증을 수행했다는 뜻은 아니다.

EXE는 로컬에 실제 복사하고 해시를 검증했으며 Git에는 넣지 않는다. 외부 배포나 설치를 수행하지 않았다. 원래 EXE 경로도 유지했다.

## 보존 내용과 재현

`snapshot/`은 기존 `artifacts/experiments/csv-native-parquet/`의 소스, Cargo manifest/lock, 비교 앱 Rust source/config, 빌드·테스트 harness, 정상·실패 원시 JSON, 로그와 스크린샷의 불변 복사본이다. 원래 상대 경로 구조를 유지했다. `promote.py`는 다른 내용의 기존 보관 파일 덮어쓰기를 거절하고 원본/복사본 해시를 검사한다.

빌드·테스트 명령은 **원래 experiment 경로에서 실행**한다. snapshot 내부 harness를 직접 실행하면 상대 경로가 달라진다. 다른 checkout에서 재현할 때 snapshot 내용을 manifest의 `canonicalExperimentPath`에 복원한 뒤 harness를 사용해야 한다. 기존 Polars 기준 EXE, 공유 대용량 fixture와 오프라인 toolchain은 별도 로컬 의존성이며 manifest/result JSON에 원래 경로·해시가 남아 있다. 이 보관본이 독립 실행 가능한 전체 빌드 환경이라는 뜻은 아니다.

대표 명령(저장소 루트 PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/experiments/csv-native-parquet/build.ps1 -Stage build -OutputName csv-native-parquet-validation.exe
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/experiments/csv-native-parquet/build_size.ps1 -OutputName native-validation.exe
C:/ProgramData/miniforge3/python.exe artifacts/experiments/csv-native-parquet/run_compare.py --stage validation-matrix --label final --validation-binary
```

실제 앱 검증본의 고유 identifier 및 frontendDist 정정은 [동기화 스크립트](snapshot/validation/sync_variant.cjs), [보존한 config](snapshot/size-variant/tauri.conf.json)를 따른다. 이전 잘못된 빌드 결과를 최신값으로 사용하지 않는다. 성능 비교는 Timestamp/Duration fast lane을 검증하지 않았으며 해당 타입은 기존 Rust fallback을 사용한다. 수정 후 독립 재리뷰는 agent provider 사용량 제한으로 실행하지 못했고 루트가 최종 gate를 실행했다.

대용량 변환 출력·임시 파일·WebView profile·Cargo build cache는 snapshot에 포함하지 않았다. 원시 JSON의 외부 절대 경로는 당시 실행 증거이며 이동된 경로로 고쳐 쓰지 않았다. 이번 승격은 기존 측정을 다시 실행하지 않고 증거의 동일성을 확인한 문서·산출물 정리다.
