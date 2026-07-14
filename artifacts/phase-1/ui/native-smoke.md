# Phase 1 Native Smoke

- 날짜: 2026-07-14
- 실행: release `data-viewer.exe`
- 결과: PASS
- fixture: `fixtures/phase-1/primitive-null.parquet`, `corrupt.parquet`

## 결과

- 실제 native dialog 정상 선택: PASS
- 실제 native dialog 취소와 기존 화면 보존: PASS
- primitive/null 첫 페이지: PASS
- Schema·Metadata 전환: PASS
- 손상 파일 typed error와 기존 session 보존: PASS
- 800x600 창 layout: PASS

## 증거

- `native-desktop.png`: 정상 Data 화면
- `native-schema.png`: 스키마
- `native-metadata.png`: 메타데이터
- `native-error.png`: 손상 파일 오류와 기존 화면 보존
- `native-minimum.png`: 800x600

