# Phase 21 — 컬럼 고유값과 CSV 캐시 관리

2026-11-04 시작. 상태: 진행 중. 사용자 요청에 따라 다음 세 기능을 구현한다.

1. 컬럼별 정확한 고유값 수, 검색·값순/빈도순 목록, 전체 고유값 또는 값+빈도 복사.
2. 전체 관리 공간 한도 안에서 적용되는 CSV 캐시 전용 최대 용량.
3. 네이티브 폴더 선택과 다른 드라이브로의 안전한 캐시 이전.

## 제품 계약

- 고유값은 기존 필터 팝오버와 별도 컬럼 정보 패널에서 제공한다. 전체 파일/현재 필터 결과를 명시한다.
- 서버가 취소 가능한 작업으로 고유값 snapshot을 생성한다. exact total과 검색 matching total, 제한된 페이지를 반환한다.
- 동일 타입 값은 한 항목으로 묶고 Null·Empty·Invalid를 구분한다. 정렬의 동률 순서를 고정한다.
- 복사는 현재 검색·정렬·범위의 전체 snapshot을 대상으로 한다. 기존 clipboard byte/cell 상한, atomic publication과 취소를 적용한다.
- 설정 schema 5: csvCacheLimitBytes(64MiB~10GiB, 기본10GiB), csvCacheDirectory(null=앱 기본 위치).
- 캐시 실효 한도는 전용 한도와 전체 예산의 제약을 모두 받는다. 낮은 한도 적용 시 활성 cache를 강제로 지우지 않는다.
- 위치 변경은 picker로 승인한 폴더의 앱 전용 하위 디렉터리를 대상으로 하며 일반 settings Apply로 경로를 바꾸지 않는다.
- 이전 전 문서·진행 작업을 닫아야 한다. 사용 중인 entry가 있으면 원본 보존 및 조치 안내와 함께 거절한다.
- cross-volume 복사: 제한된 buffer, 진행/취소, checksum·새 file identity 검증, destination 확정 및 설정 저장 후 원본 정리.
- 오류·취소·설정 저장 실패에서는 기존 위치와 데이터가 유효해야 한다. 외부 파일·reparse 경로·다른 process의 lease를 보호한다.
- 이전 후 새 CSV의 cross-drive cache publish, 재시작 warm hit와 각각의 디스크 여유 공간도 검증한다.

## 담당과 소유

- Root: 공통 계약·domain/settings.rs·Tauri commands/lib/platform 통합·빌드·공통 문서.
- Rust distinct: query/**, 필요한 copy adapter와 테스트.
- Rust storage: storage/**, settings migration와 테스트.
- Frontend: src/**, UI component tests (quality 초기 계획 후 투입).
- Quality: 테스트 계획 제안, fixture/E2E·geometry·viewport·native 독립 검증.

## 범위와 완료 기준

기존 Phase 20 코드를 이어 사용하고 버전은 0.21.0으로 맞춘다. 새 네이티브 의존성·원본 데이터 편집·외부 배포는 추가하지 않는다.
Phase 0~20의 이력은 보존하고 중복된 이번 임시 자료만 정리한다. fixture는 fixtures/phase-21/, EXE는 artifacts 밖에 둔다.
필수 Rust/frontend/parity/E2E/native와 실제 이전·취소·실패 복구 증거를 검증한 뒤 완료 판정한다.
실제 두 번째 volume이 없는 등 실행 불가능한 검증은 명시하며 PASS로 바꾸지 않는다.
일반 개발·테스트·빌드는 재확인하지 않고 정식 산출물 승격 시점의 기존 사용자 규칙을 따른다.

## 커서 페이지·복사 후속 수정 (2026-11-06)

사용자가 승인한 Column values 패널의 이전·다음 및 전체 결과 복사 경로를 수정한다.
메인 그리드와 패널 배치는 유지한다. 요청에 optional nullable cursor, 응답에 필수 nullable
nextCursor/previousCursor를 추가한다. 토큰은 1..128 UTF-8 bytes, NUL·전체 공백 금지이며,
snapshot/search/order/offset/limit/direction에 귀속하고 snapshot별 256개·30분으로 제한한다.
전체 타입·NULL 정렬 키와 최종 rowid로 keyset 조회하며 이전 방향은 모든 정렬 항목을 역전한다.
기존 cursorless offset 호출은 OFFSET 없이 꼬리 역방향 조회 또는 작은 키 표본·정확한 개수로 기준 행을 선택한다.
최초 전체 rank 정렬 대안은 실제 512MiB 테스트에서 중간 조회가 실패해 대체한다. 실패 기록은 보존한다.
복사 바이트 사전 검사와 부분 배치 재시도도 같은 기준점을 사용하며 실제 반환 행 뒤에서만 전진한다.
Rust/TS는 fixtures/phase-21/column-values-cursor-wire.json 경계 조합을 공통 검사한다.
한도·안전 여유·의존성·권한을 늘리지 않고 1GiB·두 CSV·585만 category의 중간/후반/native copy를 검증한다.
기존 정식 EXE 교체와 Phase 21 정식 승격은 이번 수정 지시만으로 수행하지 않는다.
