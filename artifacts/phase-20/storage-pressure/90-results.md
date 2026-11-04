# 작은 Storage 한도에서 여러 CSV 준비 오류 수정

2026-11-04. **수정·전체 Rust 회귀·현재 EXE 빌드·실제 Tauri IPC 검증 PASS**. Phase 상태나 외부 릴리스를 변경하지 않았다.

[독립 최종 검토](95-review.md): 버그 수정 범위 PASS. 계획의 별도 1GiB 용량 초과 변형과 전체 UI/installer gate는 미실행으로 구분했다.

## 수정한 원인

1. 실제 변환을 기다리는 CSV까지 저장 예산을 선점했다. 이제 단일 변환 permit을 얻은 작업만 예약한다.
2. 원본을 고정하는 hardlink를 CSV 전체 크기만큼 다시 과금했다. 정확한 lease 경로와 열린 원본의 OS file identity가 일치할 때만 제외한다. 복사본·미등록 링크·교체된 파일은 정상 과금한다.
3. 외부 변환기가 쓰는 동안에도 25ms poll로 공통 예산을 확인한다. 부족하면 child 종료·회수·staging 정리 후 typed 오류를 반환한다.
4. 실제 CSV 출력이 초기 예약량을 넘으면 둘 중 큰 값을 과금해 다른 작업의 중복 예약을 방지한다.
5. probe 생성 실패의 부분 파일 정리, 기존 파일 및 AlreadyExists 경쟁 생성자의 파일 보호를 함께 검증했다.
6. 캐시 재열기는 현재 여유 공간으로 작은 metadata를 먼저 복원한다. cold 변환 예산을 요구해 다른 캐시를 불필요하게 지우지 않는다. 여유 공간 24MiB·2MiB에서도 재변환 없이 복원하는 회귀를 추가했다.

## 재현과 결과

기존 EXE는 [격리한 baseline](before-isolated-512/results.json)에서 512MiB 설정으로 4개 CSV를 열 때 준비 전 예약 실패와 첫 원본 hardlink의 979,446,771-byte 과금을 재현했다. 앞선 before/before-clean 결과에는 별도로 실행 중이던 검증 앱의 active cache 약 407MB도 포함돼 있어 이를 원인 분리 후 재실행했다. 실제 다른 프로세스의 active lease는 정당한 사용량이며 강제로 회수하지 않았다.

최종 실제 앱은 **979,427,914-byte / 5,850,000행 CSV 한 개 + 68,064,912-byte / 65,537행 CSV 세 개**를 함께 열었다. 모든 파일은 고속 변환 대상 크기다. 첫/마지막 행의 정확한 정수 값, 행 수, 원본 SHA-256 보존과 캐시 재사용을 확인했다.
최종 4개 cache의 footer creator가 모두 `Polars`(polars-parquet writer)이고 행 수가 일치해, Rust fallback만 검사한 결과가 아님을 확인했다.

| 설정 한도 | 첫 준비 | 캐시 재열기 | 첫 준비 완료 사용량 |
|---|---|---|---:|
| 512MiB | 4/4 Ready | 4/4 Ready, sourceReadBytes 0 | 413.59MiB |
| 1024MiB | 4/4 Ready | 4/4 Ready, sourceReadBytes 0 | 413.59MiB |

`sourceReadBytes`는 preparation 단계의 계수이며 파일 열기 시 bounded header/type inference 읽기까지 0임을 뜻하지는 않는다.

512MiB에서 활성 4개를 유지한 채 추가 대용량 CSV를 열면 실제로 예산이 부족하므로 `QueryTempLimitExceeded`를 반환한다. 기존 4개는 Ready로 보존되고 실패 작업의 공간은 정리된다. 첫 대용량 문서를 닫은 뒤 같은 실패 문서를 재시도하면 585만 행 Ready가 된다. 활성 캐시를 삭제하거나 한도를 자동으로 올리지 않았다. [512MiB 실제 결과](fixed-512/results.json), [1GiB 실제 결과](fixed-1024/results.json).

중간 실제 앱 검증에서 cold 4개는 성공했지만 warm 재열기 중 캐시 3개가 불필요하게 지워져 재변환되는 문제를 발견했다. [수정 전 결과](before-warm-fix-512.json)를 보존하고 warm 예약 정책을 고친 뒤 같은 검증을 다시 수행했다.

## 자동 검사와 빌드

- 최종 전체 Rust: **314 PASS / 0 FAIL / 기존 16 ignored**. 새 storage_pressure 테스트 9개 포함.
- format 및 all-targets/custom-protocol Clippy `-D warnings`: PASS.
- 최초 전체 suite에서 probe 부분 생성 오류의 기존 테스트 1개가 실패해 수정했다. 관련 probe 테스트 3개 재실행 후, 예약량 초과 계수 변경이 전 query budget에 영향을 주므로 최종 전체 suite를 다시 실행했다. 실패 로그도 로컬에 보존했다.
- 기본 sandbox의 임시 Parquet 접근 거부와 잘못된 warm test identity를 분리했으며, warm test는 정확한 원래 spec과 cache hit 증가를 단언한다. 테스트를 약화하거나 경고를 억제하지 않았다.
- 제품의 storage/query/csv_source와 실제 native 빌드 variant의 해시 일치를 확인했다. worker는 공통 수정 patch 적용을 검사하면서 기존 native converter를 유지했다.
- 제한된 환경에서 생성된 중간 EXE는 Windows App Control 4551로 실행이 차단됐다. 보안 정책을 변경하지 않고 동일 소스를 정상 빌드 환경에서 재빌드한 뒤 위 실제 검증을 완료했다. [중간 실행 차단 기록](blocked-launch-512.json)을 보존했다.
- [현재 data-viewer.exe](../../../src-tauri/target/release/data-viewer.exe), [현재 빌드 해시](../20-build.json), [출처·검증 요약](80-evidence.json).

재현 명령:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/phase-20/storage-pressure/run_checks.ps1 -Stage full
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/phase-20/storage-pressure/run_checks.ps1 -Stage clippy
powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/phase-20/native/build.ps1
node artifacts/phase-20/storage-pressure/native_files.mjs fixed both
```

native 명령은 검증용 identifier를 확인하고 해당 namespace의 비활성 cache만 정리하며 설정은 종료 시 복원한다. 실제 프로덕션 cache를 대상으로 실행하지 않는다. UI interaction/geometry/viewport 전체 gate, installer/NSIS, 외부 게시를 수행한 것으로 표시하지 않는다. 프런트 코드·DTO·의존성은 변경하지 않았다. 원래 full-Polars 제품을 별도로 재빌드하지 않고 실제 사용하는 native variant의 전체 백엔드를 검증했다.

## 유지한 용량 제한

활성 캐시와 실제 출력이 한도를 초과하거나 실제 디스크 여유 공간이 **5GiB 이하**이면 기존 안전 정책에 따라 공간 부족 오류가 계속 발생한다. 한도 검사는 주기적으로 수행하므로 순간적인 쓰기 overshoot까지 0바이트로 보장하는 파일 시스템 quota는 아니다. 데이터 손실이나 무제한 사용으로 오류를 숨기지 않는다. release 중간 캐시는 후속 빌드를 위해 유지했으며 공유 .tmp의 전역 삭제는 실행하지 않았다.
