# Phase 25 정식 실행 파일

2026-11-16 사용자 승인으로 Settings 개편과 두 관리 폴더 열기를 검증한 v0.25.0 EXE를
`src-tauri/target/release/data-viewer.exe`에 복사했다. 실행 파일은62,542,848바이트다.
재빌드는 하지 않았고, 복사 후 검증 후보와 SHA-256이 같은 것을 확인했다.

최신 EXE는 SQL 임시 저장 공간 설명과 Reset 버튼 사이에12px 여백을 추가한 수정본이다.
이 후보의 Release 재빌드와 정적 검사·세 화면 크기 검사를 마친 뒤 별도 사용자 승인으로
정식 경로에 그대로 복사했다. SHA-256은
`176B5037FED2F67F8C518BB66B10988B43F07426FA8A61643CEC650B14F3F07E`다.
승격 중에는 다시 빌드하지 않았다. [이전 Settings 승격 기록](promotion-history/2026-11-16-settings-folders.json)을
보존하며, 간격 수정의 빌드·검증 정보는 [현재 승격 기록](release-promotion.json)에 포함한다.

[승격 기록](release-promotion.json)에 크기·해시·전체 프런트엔드/브라우저 검증과 실제 Windows 검증 결과를 보관한다.
EXE 자체는 이 artifacts 폴더에 중복 보관하지 않는다.

[Settings 구현·검증](settings/50-integration.md) · [독립 검토](settings/90-review.md) ·
[실제 탐색기 검증 기록](promotion-history/2026-11-16-settings-folders.json) ·
[이전 승격 기록](promotion-history/2026-11-16-sql-scale-ctrl-a.json)

전체 Phase는 진행 중이며 기존 실제 OS 파일 드롭 검증은 별도다. 설치 파일 생성·외부 게시는 이번 승격에 포함하지 않는다.
