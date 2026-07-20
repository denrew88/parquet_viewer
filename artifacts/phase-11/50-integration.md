# Phase 11 integration record

- Date: 2026-07-20
- Product implementation: complete
- Phase status: implementation complete; high-cardinality/multi-sort query performance evidence,
  external Excel, 150% DPI, and clean-machine installer checks remain gates

## Integrated behavior

- Exact OEF H5 v3 root attributes and `/time`, `/wavelength`, `/oes[wavelength,time]` datasets
- int32/int64 OES transpose paging, integer/float/string axes, and Blosc-Zstd filter 32001
- Typed rejection of malformed rank, dtype, shape, links, external storage, oversized chunks and
  unsupported compression
- Segmented fixed-height grid for multi-million-row files and full final-row geometry
- Fixed two-line multiline strings and loaded/cache-only column auto-fit by separator double-click
- Source-native Ctrl boundaries plus Ctrl+Alt absolute boundaries, including Shift selection
- Unknown-row-count CSV boundary results update the virtual geometry before scrolling to the target
- Minimal query row-id index with late projected value materialization
- Settings V3 type-wide display formats, timezone-free timestamp display/default copy, raw metadata,
  and explicit configured/display/raw copy choices
- Bounded page previews plus a 16 MiB explicit full-cell path for binary/nested values
- Configurable copy limits and separated estimated/reserve/hard-cap temporary-storage reporting

## Automated verification

- Rust: 177 passed, 3 fixture-dependent tests ignored in the default suite
- Rust 5.85M ignored gate: PASS; stable sort 15.139 s
- Frontend: 316 passed
- Format, lint, typecheck, frontend production build: PASS
- Playwright: 33/33 passed across wide, compact and minimum viewports
- Native CSV/query/copy smoke: PASS
- Native OEF H5 v3: 480 rows, 65 columns, final wavelength `463`, final value `479063`
- Release OEF H5 v3 smoke: PASS using the optimized `data-viewer.exe`
- NSIS: `Data Viewer_0.1.0_x64-setup.exe` built successfully (13,161,682 bytes); no loose
  HDF5/Blosc/Zstd/Python/Conda DLL is present in the bundle tree
- Native 5.85M Parquet Ctrl boundary: p95 60.8 ms, one boundary IPC, at most one target-page IPC,
  RSS delta 3.07 MB
- Native 250k unknown-count CSV Ctrl boundary after geometry fix: p95 84.4 ms after warm-up,
  one boundary IPC, at most one target-page IPC
- Fixture SHA-256 comparison after open/page/query/copy: PASS

## Remaining external gates

- QRY-006 high-cardinality, three-column/nulls-last sort, peak RSS and prepared random-page p95 need
  a separately generated high-cardinality fixture run. The current PASS claim is limited to the
  checked low-cardinality 5.85M fixture and does not substitute for that gate.
- Excel round-trip must be checked in a real Excel process.
- 150% Windows DPI geometry needs a separately configured desktop session.
- Release/NSIS is built and the release executable passes OEF loading locally; clean-machine
  installation still requires a separate Windows environment.
