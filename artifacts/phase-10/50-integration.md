# Phase 10 integration result

- 실행일: 2026-07-17
- 판정: 제품 구현 완료, 필수 외부·대용량 gate BLOCKED

## 통합 결과

- `OES HDF5` format handler를 compile-time registry에 등록했다.
- root `time`, `wavelength` attribute와 `/intensity` dataset의 signature, shape, dtype, chunk,
  filter와 local hard-link 계약을 검증한다.
- soft/external link, VDS, external raw storage와 dynamic HDF5 plugin을 거부한다.
- axis 정밀도와 결정적 wavelength 이름을 보존하고 200행 x 64열 hyperslab만 읽는다.
- `time`만 요청하면 intensity I/O를 생략한다.
- open initial page, session cache와 frontend horizontal window가 실제 projection을 key로 사용한다.
- 65열 이상 grid는 mounted logical column을 우선 포함해 숨긴 열이 있어도 필요한 양 끝 열을
  동시에 읽는다.
- OES는 전용 React renderer 없이 기존 Data/Schema/Metadata, selection과 clipboard를 사용한다.
- `.h5/.hdf5`는 dialog/drop/startup 후보지만 broad Windows file association은 추가하지 않았다.

## 확인된 회귀 수정

React Strict Mode의 mount-effect probe 뒤 `mounted` ref가 false로 남아 browser copy를 취소하던
기존 수명주기 결함을 수정했다. StrictMode component test와 세 viewport clipboard E2E가 이를
회귀 검증한다.

vlen axis의 lease가 전체 container 크기를 사용해 큰 intensity 파일을 잘못 거부하던 문제도
수정했다. vlen read는 container 크기와 무관하게 128 MiB를 예약하고 직렬화한 뒤 실제 retained
axis 크기로 줄인다.

## 자동 검증 요약

- Rust 전체: 146 PASS, 2 opt-in performance test ignored, 0 FAIL
- Frontend 전체: 269 PASS
- Playwright: 27 PASS, 3 viewport
- fixture: committed 21개 hash/구조 audit와 실제 기준 slice checksum PASS
- native Tauri: committed vlen fixture와 실제 기준 OES 마지막 셀/clipboard PASS

최종 Rust 재검증과 release/NSIS 결과는 `90-review.md`에 기록했다.

## 2026-07-19 wide copy와 설정 V2 통합

- grid copy는 선택 열을 최대 64열 projection으로 나누고 같은 행 batch의 응답을 logical column
  순서로 결합한다. 행 batch는 약 64,000 working cell, 최대 200행으로 제한한다.
- clipboard hard limit을 Settings의 `copyLimits`로 옮겼다. 기본값은 1,000,000셀/64 MiB이고
  허용 범위는 1,000..10,000,000셀/1..256 MiB다.
- settings wire schema를 V2로 올리고 유효한 V1의 copy preset/custom options, CSV mode와 query temp
  limit을 보존해 atomic 저장한다.
- 65열·129열 component test, 480x65 browser 전체 복사, 실제 128x65 OES Windows clipboard 전체
  복사가 PASS했다. 오류·취소·stale 응답에서는 clipboard write가 발생하지 않는다.
- 독립 리뷰 후 known row count의 짧은 page를 오류로 처리하고, clipboard commit이 시작되면 취소
  control을 비활성화했다. settings 교체 도중 종료되어 backup만 남은 경우 다음 load에서 복구한다.
