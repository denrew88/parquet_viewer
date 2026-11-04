# Phase 20 — Utf8View 수정 검증본

**수정·검증·재빌드 완료, 사용자 지시로 정식 EXE 교체 완료.** 버전 0.20.0 유지.

## 변경

일반 Parquet 읽기에서 Arrow Utf8View 문자열을 지원한다. scalar 표시·전체 값 조회·복사에 쓰이는 변환,
dictionary 값, 중첩 값의 bounded preview와 full canonical JSON에 적용했다.
빈 문자열·null을 건너뛰는 Parquet boundary occupancy에도 같은 의미를 적용했다.
CSV 변환기·캐시 형식·압축·React UI·의존성은 바꾸지 않았다.
원래 제품과 native variant의 공통 수정 두 파일은 해시가 같다.

## 검증

- 새 회귀 5/5 PASS: 짧은 inline·긴 Unicode·empty·null·tab/newline, dictionary, nested, Parquet 왕복, occupancy.
- 전체 Rust **319 PASS / 0 FAIL / 기존 16 ignored**, format 및 all-targets Clippy -D warnings PASS.
- release EXE 1회 빌드. Windows FileVersion/ProductVersion·실제 health_check·Tauri 버전 모두 0.20.0.
- 실제 Tauri 화면에서 Utf8View fixture의 Unicode 문자열이 보이고 Unsupported value가 없음을 확인했다.
- 실제 앱 IPC로 fixture 6행과 기존 Polars 생성 prepared.parquet의 원문 5행을 직접 조회했다.
  전체 셀 값 조회도 원문과 같고 입력 파일 해시가 보존됐다.
- 기존 CSV·Timestamp fixture도 실제 Ready/page 검증을 통과했다.

Prepared 캐시를 일반 Parquet로 열 때 내부 컬럼 이름은 그대로 보인다. CSV 원래 헤더를 복원하는 기능을 추가한 것은 아니다.
실제 clipboard 덮어쓰기는 수행하지 않았다. 복사에 쓰이는 값 변환은 단위·전체 회귀로 검증했다.
React 변경이 없어 frontend 전체 suite·viewport geometry·installer·성능 benchmark는 반복하지 않았다.
16 ignored 및 과거 Phase 미실행 gate는 새 PASS로 바꾸지 않는다.

## 실행 파일

- 정식 EXE: `src-tauri/target/release/data-viewer.exe`
- 크기: 58,787,840 bytes
- SHA-256: `10275191912bf83dab8e4800e74561d1a38da698d2246064f06be853b2839e3c`
- 사용자 명시적 교체 지시로 검증본을 정식 위치에 반영하고 중복 candidate는 제거했다. 교체를 위한 추가 빌드는 하지 않았다.

증거: 20-build.json, native-result.json, windows-version.json 및 targeted/rust-full/clippy/cargo-build.log.
