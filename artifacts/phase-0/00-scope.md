# Phase 0 Scope

## 상태

- Phase: 0 - 프로젝트 기반
- 시작일: 2026-07-13
- 상태: 진행 중

## 목표

Tauri 2, React, TypeScript, Vite 기반의 앱을 생성하고 Rust·프런트엔드 품질 검사를 자동으로
실행할 수 있게 한다. 빈 데이터 뷰어 workspace와 최소 IPC smoke command를 제공한다.

## 제외 범위

- CSV·Parquet 실제 파싱
- 가상화 그리드 완성
- 파일 drag and drop과 OS 파일 연결
- Excel 방식 선택과 clipboard
- installer 배포

## 초기 계약

- 프런트엔드 개발 서버는 Vite를 사용한다.
- Tauri command `health_check`는 `{ status: "ok", appVersion: string }` 형태를 반환한다.
- 프런트엔드는 Tauri command를 adapter 뒤에서 호출하며 브라우저 테스트에서는 mock할 수 있다.
- 첫 화면은 toolbar, 파일이 없는 empty workspace, 하단 status 영역으로 구성한다.
- UI는 `docs/UI_VALIDATION.md`의 desktop, compact, minimum viewport를 만족해야 한다.

## 역할과 파일 소유권

| 역할 | 작업 | 소유 범위 |
| --- | --- | --- |
| 루트 Orchestrator | scaffold, manifests, lockfile, 공유 설정, 통합 | 공유 파일 전체 |
| `tauri_platform_engineer` | health command, Tauri entry, capability 검토 | 배정 후 `src-tauri/src/**` |
| `grid_ux_engineer` | empty workspace, adapter, frontend test | 배정 후 `src/**` |
| `rust_data_engineer` | Phase 0에서는 구조 검토와 Rust test 보조 | 명시적으로 배정된 Rust 파일 |
| `quality_gate_reviewer` | 사전 테스트 설계와 사후 독립 검증 | test, fixture, UI 증거 |

## 공유 파일 규칙

다음 파일은 루트만 수정하거나 한 번에 한 역할에게 단독 배정한다.

```text
package.json
package-lock.json
Cargo.toml
Cargo.lock
src-tauri/src/lib.rs
src-tauri/tauri.conf.json
src-tauri/capabilities/**
vite.config.*
tsconfig*.json
```

## 완료 조건

1. 문서화된 명령으로 앱을 설치, 빌드, 실행할 수 있다.
2. Rust format, clippy, test가 통과한다.
3. 프런트엔드 lint, typecheck, unit test, production build가 통과한다.
4. Tauri 앱이 빈 workspace를 표시하고 `health_check` 결과를 받을 수 있다.
5. 세 viewport의 UI geometry와 screenshot 검증이 완료된다.
6. 실제 Tauri 개발 앱 smoke가 완료되거나 정확한 BLOCKED 근거가 기록된다.

## 승인 필요

- 일반적인 Tauri·React 개발 의존성 설치는 승인된 전체 구현 범위에 포함한다.
- 테스트 실행과 UI 검증을 위한 개발 서버·브라우저·Tauri 창 실행은 사전 승인됐다.
- 보안 권한 확대, 네이티브 런타임 의존성, 배포는 별도 사용자 승인이 필요하다.
