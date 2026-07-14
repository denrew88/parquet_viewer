# Phase 3 native smoke 결과

- 판정: `BLOCKED`
- 대상: T-P3-052 ~ T-P3-055
- 환경: Windows desktop session

root 및 독립 Quality 실행 모두에서 Tauri 프로세스의 visible window handle을 확보하지 못했다.
따라서 실제 Windows 파일 선택 대화상자에서 `native-450.csv`, `bom-korean.csv`,
`invalid-utf8.csv`를 선택하고 preview/paging/Metadata/progress/cancel을 검증할 수 없었다.

실행하지 못한 native 상호작용을 unit test나 브라우저 mock으로 대체하지 않았다.
`native-desktop.png`도 허위 또는 빈 증거가 되므로 생성하지 않았다.
