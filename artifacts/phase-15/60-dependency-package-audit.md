# Phase 15 dependency·package audit

## 결론

- 제품 기본 feature를 `polars-csv-provider`로 전환했다.
- Polars는 CSV preparation helper에만 연결되며 DuckDB query, Apache Arrow 58 page 계약,
  Parquet/H5 provider에는 노출되지 않는다.
- Polars 0.54.4는 `default-features = false`와 `csv`, `lazy`, `streaming`, `parquet`만 사용한다.
- feature OFF 대비 Cargo metadata package는 109개가 추가된다. 추가 package의 SPDX 표기는 MIT,
  Apache-2.0, BSD, ISC, Zlib, CC0, BSL-1.0 계열이며 copyleft/GPL 계열은 없다.
- Apache Arrow 58과 Polars의 `polars-arrow`/`polars-parquet` 구현이 함께 링크된다. 두 구현 사이의
  메모리 타입 변환은 하지 않고 compact-v3 Parquet 파일을 안정 경계로 사용한다.
- `src-tauri/THIRD_PARTY_NOTICES.md`에 Polars MIT 및 Arrow2 유래 Apache-2.0 고지를 추가했다.

## 재현

```text
python -c "import runpy; runpy.run_path(r'scripts\audit_phase15_dependencies.py', run_name='__main__')"
cargo +1.97.1 tree --manifest-path src-tauri/Cargo.toml --features polars-csv-provider -e normal
```

## 동일 source feature OFF/ON 크기 비교

| 산출물 | feature OFF | feature ON | 증가량 |
| --- | ---: | ---: | ---: |
| `data-viewer.exe` | 78,187,520 B | 143,631,872 B | 65,444,352 B (62.4 MiB, +83.7%) |
| NSIS installer | 13,703,348 B | 24,883,629 B | 11,180,281 B (10.66 MiB) |

최종 bundle 과정에서 리소스와 helper hardening이 반영된 feature ON EXE는 143,856,640 B다. NSIS에는 별도 Polars
DLL이나 worker sidecar가 없으며 같은 `data-viewer.exe`가 strict internal worker argv로 재실행된다.

## 최종 기본-feature package hash

- EXE: 143,856,640 B  
  SHA-256 `C653E476478627F723A650B0E2CCBD5AB93AFB321F572A399F718FACC314C8C7`
- NSIS: 24,926,061 B  
  SHA-256 `A1D8A3BCA3052FC55F5A83937233B55A002C8FC9296D2F559FB70EE48C85B73E`

최종 기본-feature NSIS에는 `THIRD_PARTY_NOTICES.md`가 resource로 포함되며 별도 Polars DLL이나
worker sidecar가 없다.
