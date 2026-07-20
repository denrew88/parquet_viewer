# Phase 11 UI interaction results

- Playwright 33/33 PASS in 1440x900, 1024x720 and 800x600 projects.
- Ctrl, Ctrl+Shift, Ctrl+Alt and Ctrl+Alt+Shift reach the expected 5,850,000-row targets and retain
  grid focus.
- The resolved cell is visible after movement; unknown-row-count CSV also passes in native WebView2.
- Column separator double-click auto-fits within 80..800 px without a backend column scan.
- Multiline strings render as real line breaks in a fixed 48 px/two-line row.
- Settings apply immediately and timestamp display contains no timezone suffix.
- Input and settings controls retain their own keyboard shortcuts.
