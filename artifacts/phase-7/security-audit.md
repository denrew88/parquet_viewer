# Phase 7 보안 감사

- 생성 시각: `2026-07-14T09:46:09.009547+00:00`

- **PASS** `CSP is non-null`: release CSP must be explicit
- **PASS** `CSP blocks unsafe-eval`: {"default-src": "'self' customprotocol: asset:", "connect-src": "ipc: http://ipc.localhost", "img-src": "'self' asset: http://asset.localhost data:", "style-src": "'self' 'unsafe-inline'"}
- **PASS** `CSP has no wildcard or remote HTTPS`: {"default-src": "'self' customprotocol: asset:", "connect-src": "ipc: http://ipc.localhost", "img-src": "'self' asset: http://asset.localhost data:", "style-src": "'self' 'unsafe-inline'"}
- **PASS** `NSIS is the only bundle target`: ['nsis']
- **PASS** `CSV and Parquet associations exist`: extensions audited
- **PASS** `No shell/fs/http capability`: ['core:default', 'clipboard-manager:allow-write-text']
- **PASS** `Hostile corpus does not panic`: 10 cases probed
- **PASS** `Hostile corpus typed rejection`: every rejected case has a stable error code; bounded valid CSV edge cases may be accepted

## Hostile corpus

- `zero-byte.csv`: `accepted` / `None`
- `invalid-utf8.csv`: `rejected` / `InvalidEncoding`
- `ragged.csv`: `accepted` / `None`
- `quote-bomb.csv`: `accepted` / `None`
- `truncated.parquet`: `rejected` / `InvalidParquet`
- `bad-magic.parquet`: `rejected` / `InvalidParquet`
- `unsupported.txt`: `rejected` / `UnsupportedFormat`
- `too-many-columns.csv`: `rejected` / `CsvLimitExceeded`
- `giant-record.csv`: `rejected` / `CsvLimitExceeded`
- `directory.csv`: `rejected` / `Io`

## 한계

- Static capability audit does not prove Windows ACL behavior.
- CSP violation console evidence requires an installed native WebView run.
- Dependency advisories are recorded separately because registry access can be unavailable.
