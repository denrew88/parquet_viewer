# Phase 11 native smoke

- Debug WebView2 CSV/query/copy smoke: PASS
- OEF H5 v3 fixture: PASS (`480 x 65`, final wavelength `463`, final value `479063`)
- Optimized release executable OEF H5 v3 smoke: PASS
- 64+1 projected-column boundary: PASS
- Windows clipboard custom delimiter/header copy: PASS
- 250,000-row initially unknown CSV final cell visibility: PASS
- 5,850,000-row Parquet boundary p95: 60.8 ms

The tests used the compiled Tauri executable and application LocalAppData. They did not use the
browser mock for native PASS decisions.
