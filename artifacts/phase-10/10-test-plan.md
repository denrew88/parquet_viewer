# Phase 10 테스트 계획

- 상태: 구현 전 Quality 설계 완료
- 작성일: 2026-07-17
- 대상: OES HDF5 source, native dependency, generic UI와 packaging
- 판정 기준: 모든 필수 ID PASS, 미실행 필수 native 항목 0

## 1. 판정 규칙

- `PASS`: 고정 fixture, 입력, 기대 DTO/화면/자원 수치와 재현 증거가 모두 일치한다.
- `FAIL`: 실행 가능한 환경에서 값 불일치, panic/abort, 전체 materialize, 상한 초과, 원본 변경,
  stale/wrong-document 적용, native packaging 누락이 재현된다.
- `BLOCKED`: clean VM, Explorer, 150% DPI처럼 필수 외부 환경이 실제로 없어 실행할 수 없는 경우다.
- 구현이나 fixture가 아직 없는 상태는 `BLOCKED`가 아니라 `진행 중` 또는 `FAIL`이다.
- Browser PASS는 native dialog, OS drop, system clipboard, static dependency와 installer를 대신하지 않는다.
- `.h5/.hdf5` Explorer association은 확정 제외 범위이므로 N/A다.

## 2026-07-19 wide copy와 설정 한도 회귀 계획

| ID | 계층 | 시나리오와 기대 결과 |
| --- | --- | --- |
| OES-CPY-001 | TS component | 65열과 129열 선택은 각각 64+1, 64+64+1 projection으로 읽고 원래 행·열 순서의 TSV를 만든다. |
| OES-CPY-002 | Browser E2E | 480x65 OES 전체 선택 복사의 행·열 수, 모서리 값과 checksum이 일치한다. |
| OES-CPY-003 | Native | 실제 OES HDF5 전체 선택이 요청당 64열을 넘지 않고 시스템 clipboard에 완전한 TSV를 기록한다. |
| OES-CPY-004 | Lifecycle | 열 batch 오류, 취소, 문서·session·query 교체 시 부분 clipboard write와 stale 적용이 0건이다. |
| OES-SET-001 | TS/Rust parity | V2 copyLimits 기본값은 1,000,000셀/64 MiB이고 cell 1,000..10,000,000, byte 1..256 MiB 경계를 양쪽이 동일하게 검증한다. |
| OES-SET-002 | Migration | 유효한 V1 설정은 기존 copy/CSV/temp 값을 보존하고 copyLimits 기본값만 채워 V2로 atomic 저장한다. |
| OES-SET-003 | UI | 변경한 hard limit은 다음 copy부터 적용되고 진행 중 copy는 시작 시점 snapshot을 유지한다. soft 확인은 100,000셀/8 MiB로 고정한다. |

## 2. Fixture와 생성 규칙

작은 golden fixture는 `fixtures/phase-10/`에 저장하고 SHA-256을 manifest에 고정한다. Python 생성기는
pinned Python, NumPy, h5py와 hdf5plugin version, seed와 exact shape/chunk/filter option을 기록한다.
제품 test와 release smoke는 Python 설치에 의존하지 않는다.

| Fixture                         | 계약                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `oes-minimal-numeric.oes.h5`    | time int64[3], wavelength float64[4], intensity int32[3,4], chunk 2x2, Blosc/Zstd 32001 |
| `oes-minimal-no-profile.oes.h5` | 핵심 세 객체만 있고 profile/schema/metadata attribute 없음                              |
| `oes-axis-*.oes.h5`             | time int64/float64/UTF-8/datetime hint와 wavelength int64/float64/UTF-8 조합            |
| `oes-precision.oes.h5`          | i32 MIN/MAX/음수, 2^53 초과 time, ns timestamp                                          |
| `oes-chunk-boundary.oes.h5`     | 8,300 x 257, chunk 4096 x 128, 좌표 기반 expected value                                 |
| `oes-duplicate-labels.oes.h5`   | 중복, 빈 label, `time`, 숫자 canonical 충돌                                             |
| `oes-wide.oes.h5`               | 4,096 wavelength, bounded initial projection 검증                                       |
| `oes-low-large.oes.h5`          | opt-in release, 10,000,000 x 64 저카디널리티                                            |
| `oes-high-large.oes.h5`         | opt-in release, 같은 shape·chunk의 고카디널리티                                         |
| `oes-corrupt-*`                 | 잘린 파일, 누락 객체, rank/dtype/shape/filter/chunk 손상                                |
| `oes-external-*`                | soft/external link, VDS, external storage                                               |
| `not-oes.h5` / `fake.oes.h5`    | 정상 non-OES HDF5 / HDF5 signature가 없는 파일                                          |

대형 fixture는 commit하지 않고 manifest, generator, checksum, 실제 byte size와 압축률을 기록한다.
저카디널리티만으로 성능을 PASS 처리하지 않는다.

## 3. 요구사항 추적

| 요구사항                      | 테스트 묶음 |
| ----------------------------- | ----------- |
| 구조 판별과 registry          | OES-FMT     |
| axis 타입·정밀도·열 이름      | OES-AXIS    |
| bounded page/projection/cache | OES-PAGE    |
| 보안·손상 입력·원본 보존      | OES-SEC     |
| 문서·copy·capability 통합     | OES-INT     |
| 성능·memory·soak              | OES-PERF    |
| Browser와 실제 Tauri          | OES-UI      |
| static build와 installer      | OES-PKG     |

## 4. Format과 구조 검증

| ID          | 계층             | 시나리오와 기대 결과                                                                                    | 담당             |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| OES-FMT-001 | Rust unit        | `oesHdf5`, `OES HDF5`, h5/hdf5, MIME, typedSchema/columnProjection descriptor가 중복 없이 등록된다.     | Rust Data        |
| OES-FMT-002 | Rust integration | minimal fixture의 signature와 핵심 세 객체를 확인해 연다.                                               | Rust Data        |
| OES-FMT-003 | Rust integration | profile 없는 fixture와 unknown attribute 추가본이 같은 summary/page를 반환한다.                         | Quality          |
| OES-FMT-004 | Rust integration | non-OES HDF5, fake, truncated, 잘못된 extension/content 조합을 typed error로 구분하고 panic하지 않는다. | Quality          |
| OES-FMT-005 | Rust contract    | intensity 2-D int32, chunked, filter 32001, axis-shape parity만 성공한다.                               | Rust Data        |
| OES-FMT-006 | Rust contract    | axis dataset, 다른 intensity path, wrong rank/dtype/filter는 unsupported-layout 원인을 반환한다.        | Quality          |
| OES-FMT-007 | IPC              | supported formats, dialog filter, backend resolver와 frontend drop 안내 snapshot이 일치한다.            | Platform/Quality |
| OES-FMT-008 | Regression       | CSV/Parquet descriptor, resolver, dialog와 startup 결과가 변하지 않는다.                                | Quality          |

## 5. Axis와 schema

| ID           | 계층          | 시나리오와 기대 결과                                                                              | 담당      |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------- | --------- |
| OES-AXIS-001 | Rust matrix   | time int/uint/float/string이 정확한 ValueKind와 문자열을 보존한다.                                | Rust Data |
| OES-AXIS-002 | Rust matrix   | 유효 datetime64ns/timezone hint는 ns Timestamp, hint가 없으면 원래 int64다.                       | Rust Data |
| OES-AXIS-003 | Rust matrix   | wavelength int/uint/float/string이 저장 순서의 결정적 열 이름과 schema를 만든다.                  | Rust Data |
| OES-AXIS-004 | Rust contract | fixed/vlen UTF-8, 한글, 공백과 quote를 보존하고 invalid UTF-8/compound는 거부한다.                | Quality   |
| OES-AXIS-005 | Rust contract | finite numeric wavelength는 순서와 무관하게 열리고 NaN/Inf는 거부된다.                            | Quality   |
| OES-AXIS-006 | Cross-layer   | duplicate/blank/`time`/canonical 충돌 이름이 같은 suffix 규칙으로 unique하며 projection 가능하다. | Quality   |
| OES-AXIS-007 | Boundary      | 0행은 empty page, 0 wavelength와 shape mismatch는 typed error다.                                  | Quality   |
| OES-AXIS-008 | Precision     | 2^53 초과 axis integer, ns timestamp와 i32 MIN/MAX가 JS number 손실 없이 전달된다.                | Quality   |
| OES-AXIS-009 | Limit         | 4,096 wavelength와 axis 128 MiB 경계는 성공하고 +1/초과는 allocation 전 typed error다.            | Quality   |

## 6. Page, projection과 cache

| ID           | 계층             | 시나리오와 기대 결과                                                                              | 담당      |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------- | --------- |
| OES-PAGE-001 | Rust contract    | 첫/중간/마지막/EOF 이후 page의 offset, row count, hasMore가 정확하다.                             | Rust Data |
| OES-PAGE-002 | Rust integration | 4096x128 chunk 내부와 행/열 경계를 가로지르는 checksum이 일치한다.                                | Quality   |
| OES-PAGE-003 | Rust contract    | 1/64열, 역순 projection은 요청 순서를 보존하고 0/65/duplicate/unknown은 typed error다.            | Rust Data |
| OES-PAGE-004 | Instrumented     | time-only는 intensity I/O 0, intensity projection은 선택 hyperslab만 읽고 전체 matrix read 0이다. | Quality   |
| OES-PAGE-005 | Wide open        | 4,096 wavelength open의 initial page가 최대 64열이며 `None` 전체 projection을 만들지 않는다.      | Quality   |
| OES-PAGE-006 | Cache            | actual projection이 cache key를 구분하고 문서 8/process 64 pages와 256 MiB 상한을 지킨다.         | Quality   |
| OES-PAGE-007 | Race             | 빠른 page, tab 전환/close 뒤 late response가 다른 document/session에 적용되지 않는다.             | Quality   |
| OES-PAGE-008 | Chunk limit      | decoded chunk 64 MiB 경계는 성공하고 초과는 decode 전에 거부된다.                                 | Quality   |

## 7. 보안, 손상 입력과 read-only

| ID          | 계층         | 시나리오와 기대 결과                                                                       | 담당             |
| ----------- | ------------ | ------------------------------------------------------------------------------------------ | ---------------- |
| OES-SEC-001 | Corruption   | 잘린 superblock/object header/chunk가 abort, panic, hang 없이 typed error다.               | Quality          |
| OES-SEC-002 | Validation   | missing axis/dataset, rank/dtype/shape/filter 불일치를 서로 구분한다.                      | Rust Data        |
| OES-SEC-003 | Security     | soft/external link, external storage와 VDS를 거부하고 target 파일을 열지 않는다.           | Quality          |
| OES-SEC-004 | Runtime      | dynamic filter/VOL/VFD loading이 꺼지고 unknown filter가 외부 DLL을 load하지 않는다.       | Platform/Quality |
| OES-SEC-005 | Arithmetic   | dimension product, byte count, offset+limit overflow를 checked error로 반환한다.           | Rust Data        |
| OES-SEC-006 | Filter fault | 위조 filter metadata와 손상 payload가 제한된 decode error가 되고 stderr가 폭주하지 않는다. | Quality          |
| OES-SEC-007 | Path         | 공백·한글·긴 경로, canonical duplicate, not found와 access denied가 기존 계약을 따른다.    | Platform         |
| OES-SEC-008 | Isolation    | 정상/손상 CSV·Parquet·OES batch는 부분 성공하며 기존 활성 문서를 보존한다.                 | Quality          |
| OES-SEC-009 | Read-only    | open/page/copy/close 전후 원본 SHA-256, size, mtime이 같다.                                | Quality          |

## 8. DocumentRegistry, capability와 copy

| ID          | 계층           | 시나리오와 기대 결과                                                                                 | 담당             |
| ----------- | -------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| OES-INT-001 | Registry       | OES 8개와 CSV/Parquet 혼합 tab의 source/cache/close가 격리된다.                                      | Quality          |
| OES-INT-002 | Registry       | canonical 재열기, 64/65 tab과 batch 32 제한이 유지된다.                                              | Platform/Quality |
| OES-INT-003 | Architecture   | OES 분기는 handler/reader/registry에 한정되고 grid/selection/copy/query core에 추가되지 않는다.      | Quality          |
| OES-INT-004 | Generic UI     | 전용 renderer 없이 Data/Schema/Metadata에 time/wavelength/intensity가 표시된다.                      | Grid UX/Quality  |
| OES-INT-005 | Query          | queryProvider가 없고 filter/search/sort가 숨겨지며 직접 query는 문서를 유지하는 unsupported error다. | Quality          |
| OES-INT-006 | Copy           | time 포함 단일/range/page·chunk 경계 선택의 Excel TSV byte가 golden과 같다.                          | Quality          |
| OES-INT-007 | Copy headers   | unique wavelength header 순서와 intensity 값 순서가 projection과 일치한다.                           | Quality          |
| OES-INT-008 | Copy lifecycle | soft/hard limit, progress/cancel, tab close/전환과 wrong-document 방지가 유지된다.                   | Quality          |

## 9. 성능과 resource budget

release build와 local SSD에서 3회 warm-up 후 10회 측정한다.

| ID           | 필수 기준                                                                                             | 담당              |
| ------------ | ----------------------------------------------------------------------------------------------------- | ----------------- |
| OES-PERF-001 | low/high 10M x 64 open median 2초 이하                                                                | Quality           |
| OES-PERF-002 | manifest seed 10 offset의 1/64열 random page p95 1초 이하                                             | Quality           |
| OES-PERF-003 | open/page peak RSS가 intensity 전체 decoded bytes에 비례하지 않고 단일 active read delta 256 MiB 이하 | Quality           |
| OES-PERF-004 | file axis 128 MiB/process 256 MiB lease 경계와 해제가 정확함                                          | Rust Data/Quality |
| OES-PERF-005 | 8 tab random page/open/close 100 cycle 뒤 handle·axis lease·page cache가 기준선으로 복귀              | Quality           |
| OES-PERF-006 | 같은 OES를 2~5 release process에서 열어 deadlock/early exit 없이 독립 PID 유지                        | Platform/Quality  |
| OES-PERF-007 | CSV/Parquet open/random page median이 Phase 9 baseline 대비 15% 이상 악화되지 않음                    | Quality           |

HDF5 native slice는 강제 cancel을 보장하지 않는다. 한 page/chunk 상한과 stale response 폐기로 UI를
보호하며, close 요청 후 결과 적용 0과 native call p95 2초 이하를 별도로 기록한다.

## 10. UI와 native 검증

`docs/UI_VALIDATION.md`를 적용한다.

| ID         | 계층             | 검증 항목                                                                     | 담당             |
| ---------- | ---------------- | ----------------------------------------------------------------------------- | ---------------- |
| OES-UI-001 | Component        | OES loading/error/empty/populated, Schema와 generic Metadata 렌더링           | Grid UX          |
| OES-UI-002 | Playwright       | wide column virtualization, selection, keyboard와 copy 논리 좌표              | Quality          |
| OES-UI-003 | Geometry         | 1440x900, 1024x768, 800x600에서 overlap/clipping 0, header-cell 오차 1px 이하 | Quality          |
| OES-UI-004 | Screenshot       | 세 viewport의 populated OES grid와 invalid-OES 오류 독립 시각 검토            | Quality          |
| OES-UI-005 | Native           | 실제 Tauri dialog, OS drop와 startup argv로 Blosc fixture open                | Platform         |
| OES-UI-006 | Native clipboard | 실제 Windows clipboard OES TSV hash가 golden과 동일                           | Platform/Quality |
| OES-UI-007 | Native DPI       | 100%/150%에서 긴 wavelength header와 minimum viewport clipping 0              | Platform/Quality |
| OES-UI-008 | Regression       | CSV/Parquet dialog/drop/startup와 Data/Schema/Metadata 유지                   | Quality          |

## 11. Static build와 installer

| ID          | 계층          | 검증 항목                                                                           | 담당             |
| ----------- | ------------- | ----------------------------------------------------------------------------------- | ---------------- |
| OES-PKG-001 | Rust          | `blosc_available`와 실제 filter 32001/Zstd first/middle/last decode PASS            | Platform/Quality |
| OES-PKG-002 | Build         | cold debug/release, fmt, clippy `-D warnings`, Rust tests PASS                      | Platform         |
| OES-PKG-003 | Binary audit  | release import/payload에 loose hdf5/blosc/zstd/Python DLL 없음                      | Platform         |
| OES-PKG-004 | Clean runtime | system HDF5, Python, Conda, plugin env 없이 release EXE가 fixture를 읽음            | Platform/Quality |
| OES-PKG-005 | Installer     | NSIS 설치/실행/uninstall과 dialog/drop/startup OES smoke PASS                       | Platform         |
| OES-PKG-006 | Audit         | Phase 9 대비 EXE/NSIS/build-time delta, Cargo feature tree와 native dependency 기록 | Platform         |
| OES-PKG-007 | License       | resolved HDF5/hdf5-metno/c-blosc/Zstd 고지가 repository와 설치 payload에 존재       | Root/Platform    |

## 12. 전체 gate

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
npm run test:native:build
npm run test:native:smoke
npm run tauri build
```

결과는 `50-integration.md`, 독립 판정은 `90-review.md`에 실제 실행 후 작성한다. 빈 결과 문서와 UI
증거 파일을 구현 전에 만들지 않는다.
