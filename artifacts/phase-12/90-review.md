# Phase 12 최종 검토

- 검토일: 2026-07-21
- 제품 구현 판정: **통과**
- Phase 12 판정: **완료**

## 독립 검토에서 발견하고 수정한 문제

1. Parquet 정렬 column은 native type을 쓰면서 filter parameter는 `DOUBLE`로 변환해, 2^53을 넘는
   인접 int64가 같은 값으로 비교될 수 있었다. source column의 실제 DuckDB 타입으로 parameter를
   변환하도록 고쳤고 `9007199254740992`와 `9007199254740993`을 구분하는 회귀 테스트를 추가했다.
2. query create/scroll/replace/close 100회 생명주기 근거가 없었다. release soak harness를 추가해
   active query/task/result/temp와 handle/RSS tail을 계측했다. handle delta는 0, 50→100회 working-set
   증가는 1,073,152 bytes였고 누적 resource는 없었다.
3. Excel worksheet 한도를 넘는 선택을 copy할 때 제품 경고가 없었다. Excel preset에서 선택 행 수가
   1,048,576을 넘으면 copy가 잘리지 않는다는 경고를 표시하고, backend에는 전체 logical selection을
   보내도록 unit/E2E를 추가했다. 실제 Excel 16.0에서도 1,048,577행이 worksheet 상한에서 잘리는 것을 확인했다.
4. native smoke의 로드 후 invoke hook은 이미 캡처된 Tauri invoke를 계수할 수 없었다. 이를 0회로
   과장하지 않고 `ipcProbeObserved=false`로 기록했으며, 탭 page-read 0회는 로드 전 probe가 가능한
   browser E2E와 unit scheduler test를 근거로 분리했다.
5. 완료 후 Phase 11 low fixture의 `category`에서 Ctrl+↓가 585만 문자열을 전부 decode하는 회귀가
   확인됐다. exact row-group min/max/null 통계로 all-occupied/all-empty를 증명할 수 있는 그룹만
   건너뛰도록 수정했다. 실제 release backend는 ↓ 1.43ms/↑ 43.47ms, native 5회 p95는 47.1ms였고,
   통계가 불충분한 그룹의 Arrow scan과 빈 문자열 정지 규칙은 유지된다.

## 완료 근거

- query index/page plan audit 80회와 low/high 5.85M 정확성·성능 예산 PASS
- backend copy atomicity, cancel, limit, history와 Windows clipboard exact result PASS
- H5 구조 판별 36-case matrix, wide hyperslab copy와 static Blosc/Zstd release runtime PASS
- 197 Rust + 327 frontend + 45 Playwright test PASS
- 100회 lifecycle soak PASS
- 실제 release Tauri/WebView2 100%·150% geometry/focus/navigation/copy/tab restore PASS
- 최종 release EXE와 NSIS bundle build PASS

알려진 HIGH/MEDIUM Phase 12 결함과 필수 BLOCKED 항목은 없다. clean-machine 설치 검증은 Phase 12의
query/grid/copy 완료 판정과 분리된 기존 배포 환경 항목으로 남긴다.
