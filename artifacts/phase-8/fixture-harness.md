# Phase 8 fixture 및 process harness

- 상태: gate PASS, release 미실행
- 생성기 revision: `phase8-cardinality-v1`
- 생성 파일 기본 경로: `logs/phase-8/fixtures` (`.gitignore`의 `logs` 규칙 적용)
- 추적 대상: 이 문서, `fixture-manifest.json`, `fixture-audit.json`

## Fixture 계약

`F-P8-12`와 `F-P8-13`은 다음 설정을 공유한다.

- 동일한 10열 Arrow schema
- Zstd level 3과 동일한 dictionary 대상 열
- profile별 동일한 row-group size
- 한 번에 row group 하나만 생성하고 기록하는 streaming writer
- `F-P8-12`: 반복값 중심 저카디널리티 데이터
- `F-P8-13`: 자료형이 허용하는 열에서 unique 또는 near-unique인 고카디널리티 데이터
- 파일 크기는 PASS 조건이 아니며 실제 크기와 압축률만 manifest에 기록

manifest에는 seed, revision, 행·열·row-group 수, 파일 bytes, SHA-256, Parquet metadata의
compressed/uncompressed bytes와 양방향 비율, 열별 encoding/codec, first/boundary/middle/last
200행의 전체 열 및 3열 projection checksum을 기록한다.

`F-P8-09`는 CSV와 Parquet이 교차하는 small document 64개와 65번째 거부 경계 파일을 만든다.

## Gate 결과

2026-07-14에 다음 명령을 두 번 실행했다.

```powershell
C:\Users\denrew88\.conda\envs\py311\python.exe scripts/generate_phase8_fixtures.py --profile gate
C:\Users\denrew88\.conda\envs\py311\python.exe scripts/phase8_fixture_audit.py
```

- 생성 시간: 최초 약 4초, 결정성 재실행 약 2초
- `F-P8-12`: 50,000행 × 10열, 5 row groups, 105,165 bytes
- `F-P8-13`: 50,000행 × 10열, 5 row groups, 3,087,747 bytes
- 두 번째 생성의 fixture SHA-256이 첫 번째와 일치
- audit: 두 fixture metadata/SHA/page/projection checksum과 small document 64+1개 모두 PASS

정확한 SHA-256, encoding 및 checksum은 `fixture-manifest.json`, 독립 재검증 결과는
`fixture-audit.json`을 기준으로 한다.

## Release 실행

실제 1,000만 행 fixture는 다음 명령으로 생성한다. 이 검증 작업에서는 시간과 디스크 사용을
피하기 위해 실행하지 않았다.

```powershell
python scripts/generate_phase8_fixtures.py --profile release
python scripts/phase8_fixture_audit.py
```

release profile은 fixture마다 정확히 10,000,000행 × 10열, row group 100,000행으로 총
100 row groups를 만든다. gate 결과의 단순 선형 환산은 저카디널리티 약 20 MiB,
고카디널리티 약 589 MiB이지만 row-group 크기에 따라 실제 결과는 달라진다. 안전한 실행
예산은 다음과 같다.

- 여유 디스크: 2 GiB 이상. 재생성 중 기존 파일과 `.partial` 파일이 동시에 존재할 수 있다.
- 예상 peak memory: 300~600 MiB. generator의 계약상 최대 100,000행만 동시에 생성한다.
- 예상 시간: 일반 개발 PC에서 약 5~20분. 실제 시간은 CPU와 Zstd 처리량에 따라 기록한다.

release PASS 판정은 크기 예상값이 아니라 10,000,000행, 10열, 100 row groups, 동일 schema,
SHA-256 및 대표 checksum 재검증으로 한다.

## Native process harness

`phase8_native_process_harness.py`는 자신이 시작한 process만 추적·정리하며 PID 생존과 Windows
top-level visible window를 기록한다. release executable이 준비된 뒤 다음처럼 실행한다.

```powershell
python scripts/phase8_native_process_harness.py `
  --executable src-tauri/target/release/data-viewer.exe `
  --instances 5 --cycles 1 --hold-seconds 5

python scripts/phase8_native_process_harness.py `
  --executable src-tauri/target/release/data-viewer.exe `
  --instances 5 --cycles 20 --hold-seconds 5 `
  --output artifacts/phase-8/soak-results.json
```

두 번째 명령은 총 100 invocation을 만든다. 이 harness는 PID/window 독립성만 검사하며 파일
열기, 탭, clipboard, context menu의 native pointer 검증을 대체하지 않는다.
