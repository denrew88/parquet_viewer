# Phase 16 native smoke

## Phase 16 전용 cold/warm/cancel

- 결과: PASS
- fixture: `fixtures/phase-15/csv-5850000-high.csv`
- cold preparation: 83,949ms
- warm first interactive: 823ms
- warm observation: 1,841ms, 110 frames
- warm blocker/progress/Cancel frames: 0/0/0
- cancel terminal: 260ms
- blocker hit-test와 terminal 이후 direct filter: PASS
- cache/partial/lease cleanup: PASS
- 상세 측정: `artifacts/phase-16/native-cold-warm.json`
- 캡처: `artifacts/phase-16/ui/native-desktop.png`

## generic native regression smoke

- 결과: PASS
- Ctrl boundary navigation과 Shift 범위: PASS
- CSV Parsing Profile preview와 prepared grid 표시 parity: PASS
- filter, sort, query-aware copy: PASS
- thousands separator: dot, comma, space 모두 PASS
- copy 검증은 transient 안내문이 아니라 새 operation ID의 backend terminal `complete` 상태와 clipboard 결과를 사용한다.
- 연속 native 실행은 Viewer 프로세스 종료를 기다려 query temporary-storage 수명주기 경합을 막는다.

## 표시 증거

- `artifacts/phase-9/ui/native-csv-profile-dot.png`
- `artifacts/phase-9/ui/native-csv-profile-comma.png`
- `artifacts/phase-9/ui/native-csv-profile-space.png`
- `artifacts/phase-9/ui/native-query-copy-dot-passed.png`
- `artifacts/phase-9/ui/native-query-copy-comma-passed.png`
- `artifacts/phase-9/ui/native-query-copy-space-passed.png`
