# 전체 앱 EXE 크기 비교

> **후속 검증에서 이 크기 비교를 무효화했다.** 복사본의 Windows 절대 frontendDist가
> URL로 해석돼 UI 자산이 포함되지 않았다. 55.85MiB는 전체 앱 동등 비교의 유효 수치가
> 아니다. 원시 기록은 보존하며, 수정된 앱·크기·실제 UI 결과는 validation/ 아래 후속 기록을 따른다.

> **수정된 최종값: UI 포함 56.0356MiB, 기준 103.6714MiB 대비 45.9488% 감소.**
> [확대 검증 및 크기 정정](validation/90-results.md), [수정 PE 측정](validation/60-size-corrected.json).

2026-11-03. standalone 도구의 크기를 빼서 추정하지 않고, **전체 앱에서 CSV worker를
직접 변환기로 연결한 비교본을 실제 Release 빌드**했다. 원본 제품은 수정하지 않았다.

| 동일 Cargo Release 조건 | bytes | MiB |
| --- | ---: | ---: |
| 현재 제품: 전체 Polars CSV provider | 108,707,328 | 103.6714 |
| 비교본: csv + polars-arrow/parquet provider | 58,563,584 | 55.8506 |
| 감소 | **50,143,744** | **47.8208** |

**추가 감소율은 46.1273%다.** 최종 비교본의 SHA256:
`32aaa705f662978a08c2b120b7bd63a633f14654c4a33d05a24e9ec1e8330bef`.

이는 기존 Tauri 패키징 EXE 103.7051MiB와의 비교가 아니라, 같은 Cargo build 경로의
103.6714MiB와 비교한 값이다. 이번에는 Tauri 재패키징/NSIS를 실행하지 않았다.
[PE sections·실측 bytes·SHA·DLL imports](62-product-size.json).

## 교체 내용과 유지한 조건

- 제품 폴더를 별도의 `size-variant`에 복사하고, 기존 내부 worker의 sink 호출만 실험용
  직접 converter로 연결했다. 기존 parent worker 실행·취소·fingerprint·result 검증 구조는
  유지한다. worker protocol과 feature의 기존 이름에 Polars가 남아 있어도 full Polars crate를
  링크한다는 뜻은 아니다.
- 전체 Polars dependency와 lazy/streaming/plan/expr/mem-engine을 제외하고,
  `polars-arrow`, `polars-parquet`, `polars-error`, Rayon을 직접 의존성으로 사용했다.
  하위 Polars utility/compute crate는 남는다.
- DuckDB·Apache Arrow/Parquet·HDF5·Tauri·React assets는 유지한다. 기존 제품 Rust 41개
  파일 중 39개는 byte-identical이며, data/mod.rs와 csv_polars.rs만 바꾸고 native 모듈을 추가했다.
- 실험 lockfile package 수는 716→650. 남은 package의 버전/source는 모두 기존과 같다.
- Release profile은 기존과 같은 ThinLTO + codegen-units=1, 기본 opt-level=3이다.
  HDF5의 정상 MSVC Release generator wrapper도 동일하게 적용했다.
- Tauri frontendDist만 복사 폴더에서 기존 dist를 가리키도록 절대 경로로 바꿨다.
  제품 Cargo manifest/lockfile와 dist HTML/JS/CSS는 기존 최종 검증 상태의 해시와 같다.
- 양쪽 AMD64 PE다. DLL import에 새로 추가된 것은 없다. 비교본에서 bcrypt.dll, crypt32.dll,
  pdh.dll, powrprof.dll, psapi.dll import가 제거됐다. DLL 목록이 완전히 같다고 주장하지 않는다.

[소스·의존성·profile 감사](64-size-provenance.json), [실험 범위](60-size-scope.json),
[variant 생성기](prepare_size_variant.cjs), [빌드/검사](build_size.ps1), [크기 측정기](measure_size.cjs).

## 실제 연결 확인

최종 앱 EXE의 `--data-viewer-internal-worker csv-prepare-v1 --request ...` 진입점을 직접 호출했다.
실험용 standalone CLI를 호출한 것이 아니다.

- 기존 요청 DTO, pinned source 위치, 길이/수정 시각, thread limit 및 nonce/result protocol PASS.
- EDGE CSV 65,537행 × 33 source 열 → 43 physical 열 변환 성공.
- 앱 worker의 출력 전체를 기존 bounded Rust oracle로 읽어 Polars 결과와 비교: PASS.
- 큰 정수, Decimal 원문, float -0/NaN 정책, 인용 개행, Skip, packed state lane 31/32 포함.
- source hash 불변 PASS. 최종 EXE hash가 측정한 파일과 같은지 확인했다.
- 비교본 fmt --check 및 Release Clippy --lib/--bin -D warnings: **PASS**.
  Clippy는 1분 3초에 완료됐으며 size-clippy.log에 기록했다.

[worker 실행 증거](63-size-worker-smoke.json), [출력 전체 oracle](verify-size-worker-edge.json).
앞선 5+5 변환 성능과 전체 MAIN 정합성은 [성능 결과](50-results.md)에 별도로 기록돼 있다.

## 해석 범위

실제 앱에 변환 코드를 연결해 얻은 유의미한 감량이다. 다만 **일반 사용자용 교체 완료본이
아니라, 제한된 파싱 프로필을 지원하는 크기 비교본**이다. 현재 도구는 기본 토큰/no trim의
허용 타입만 지원한다. 나머지 사용자 지정 설정, 전체 제품 preparation/cache/session 계약과
UI/native 회귀를 모두 검증한 상태는 아니다. 제품의 정식 Polars provider는 그대로 유지했다.

변환기와 앱의 기존 worker 수명주기를 연결한 정도의 변경이며, production 통합 시 필요한
일반 설정 지원·추가 검증 코드까지 포함한 최종 배포 크기를 보장하지 않는다. 이번 full-app
variant에서 성능 5+5를 재측정하지는 않았다. 이전 standalone 성능과 이번 앱 크기를 같은
정식 앱에서 동시에 확인한 것으로 해석하지 않는다.

원본 제품 테스트는 수정하지 않았다. 복사한 variant의 옛 Polars sink 전용 테스트는 제거했으므로
이 variant가 제품 전체 suite를 통과했다고 표시하지 않는다. 이번 gate는 Release build,
format/Clippy 및 실제 worker EDGE 전체 parity다. 제품 UI/권한/Phase 상태는 바꾸지 않았다.

최초 sandbox 빌드는 DuckDB archive 갱신 중 LNK1114/error 5로 실패했다. 같은 빌드를 허용된
실행 환경에서 수행해 성공했고, 남은 미사용 import는 정리 후 재빌드했다. 그 전후 EXE byte
크기는 동일했다. 실패 로그와 전후 build metadata를 보존했다. 보안 정책은 변경하지 않았다.
생성 Release cache는 재현을 위해 유지한다.

실행파일: `native-product-size.exe` (실험용 앱 비교본).
기준 실행파일: `artifacts/optimizations/rust-thin-lto/optimized-product.exe`.
