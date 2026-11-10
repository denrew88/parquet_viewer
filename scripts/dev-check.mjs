// Stable entry point for explicitly scoped, local development checks.
// No arbitrary shell, installs, Git index/history changes, deployment, or policy changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const draftBinary = path.join(root, "artifacts/experiments/csv-native-parquet/data-viewer.exe");
const validationBinary = fs.existsSync(draftBinary) ? draftBinary : path.join(root, "src-tauri/target/release/data-viewer.exe");
const viewCandidate = path.join(root, "src-tauri/target/release/candidates/phase-20-utf8-view/data-viewer.exe");
const scripts = {
  backend: "artifacts/phase-20/storage-pressure/run_checks.ps1",
  build: "artifacts/phase-20/native/build.ps1",
  native: "artifacts/phase-20/storage-pressure/native_files.mjs",
  playwright: "node_modules/@playwright/test/cli.js",
};
const nodeStep = (name, entry, args = [], env = {}) => ({
  name, program: node, args: [entry, ...args], env,
});
const psStep = (name, entry, args = []) => ({
  name, program: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", entry, ...args], env: {},
});
const phase23Rust = (stage) => psStep(`phase23-${stage}`, "scripts/phase22_checks.ps1", ["-Phase", "23", "-Stage", stage]);
const phase24Rust = (stage) => psStep(`phase24-${stage}`, "scripts/phase22_checks.ps1", ["-Phase", "24", "-Stage", stage]);
const frontendBuild = () => nodeStep("frontend-build", "node_modules/vite/bin/vite.js", ["build"]);
const tasks = {
  "phase24-format": () => [phase24Rust("format")],
  "phase24-check": () => [phase24Rust("check")],
  "phase24-clippy": () => [phase24Rust("clippy")],
  "phase24-test": () => [phase24Rust("test")],
  "phase24-chart-unit": () => [phase24Rust("chart-unit")],
  "phase24-native-build": () => [frontendBuild(), phase24Rust("native-build")],
  "phase24-chart-followup-build": () => [frontendBuild(), phase24Rust("chart-followup-build")],
  "phase24-chart-options-build": () => [frontendBuild(), phase24Rust("chart-options-build")],
  "phase24-chart-analysis-build": () => [frontendBuild(), phase24Rust("chart-analysis-build")],
  "chart-image-export-build": () => [frontendBuild(), phase24Rust("chart-image-export-build")],
  "chart-image-export-native": () => [nodeStep("chart-image-export-native", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_IMAGE_EXPORT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-chart-image-export/data-viewer.exe") })],
  "chart-image-release-build": () => [frontendBuild(), phase24Rust("chart-image-release-build"), phase24Rust("chart-image-release-bundle")],
  "chart-image-release-native": () => [nodeStep("chart-image-release-native", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_IMAGE_EXPORT: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-chart-image-release/data-viewer.exe") })],
  "chart-image-direct-build": () => [frontendBuild(), phase24Rust("chart-image-direct-build")],
  "chart-image-direct-native": () => [nodeStep("chart-image-direct-native", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_IMAGE_EXPORT: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/data-viewer.exe") })],
  "chart-image-rebuild": () => [frontendBuild(), phase24Rust("chart-image-rebuild")],
  "chart-image-rebuild-native": () => [nodeStep("chart-image-rebuild-native", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_IMAGE_EXPORT: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/chart-image-rebuild/release/data-viewer.exe") })],
  "chart-image-rebuild-transaction": () => [nodeStep("chart-image-rebuild-transaction", "scripts/phase24_native_smoke.mjs", ["--chart-transaction-only"], { P24_CHART_IMAGE_EXPORT: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/chart-image-rebuild/release/data-viewer.exe") })],
  "chart-image-baseline-launch": () => [nodeStep("chart-image-baseline-launch", "scripts/phase24_native_smoke.mjs", [], { P24_LAUNCH_ONLY: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-chart-analysis/data-viewer.exe") })],
  "sql-cte-native-build": () => [frontendBuild(), phase24Rust("cte-completion-build")],
  "sql-cte-native": () => [nodeStep("sql-cte-native", "scripts/phase24_native_smoke.mjs", [], { P24_CTE_COMPLETION: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-cte-completion/data-viewer.exe") })],
  "sql-grid-navigation-build": () => [frontendBuild(), phase24Rust("sql-grid-navigation-build")],
  "sql-grid-navigation-native": () => [nodeStep("sql-grid-navigation-native", "scripts/phase24_native_smoke.mjs", [], { P24_SQL_GRID_NAVIGATION: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-sql-grid-navigation/data-viewer.exe") })],
  "sql-editor-e2e": () => [nodeStep("sql-editor-e2e", "node_modules/@playwright/test/cli.js", ["test", "--config", "artifacts/phase-20/storage-decimal/playwright.config.ts", "--grep", "SQL tab naming|CTE completion", "--workers", "1", "--output", ".tmp/sql-editor-e2e", "--reporter", "list"], { PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".tmp/playwright-browsers") })],
  "phase24-build": () => [frontendBuild(), phase24Rust("build")],
  "phase24-bundle": () => [phase24Rust("bundle")],
  "phase24-native": () => [nodeStep("phase24-native", "scripts/phase24_native_smoke.mjs", [], { P24_SCALE: "1" })],
  "phase24-chart-followup": () => [nodeStep("phase24-chart-followup", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_FOLLOWUP: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-chart-followup/data-viewer.exe") })],
  "phase24-chart-source": () => [nodeStep("phase24-chart-source", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_SOURCE_ONLY: "1" })],
  "phase24-chart-options": () => [nodeStep("phase24-chart-options", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_OPTIONS: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-chart-options/data-viewer.exe") })],
  "phase24-chart-analysis": () => [nodeStep("phase24-chart-analysis", "scripts/phase24_native_smoke.mjs", [], { P24_CHART_ANALYSIS: "1", P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24-chart-analysis/data-viewer.exe") })],
  "phase24-native-commerce": () => [nodeStep("phase24-native-commerce", "scripts/phase24_native_smoke.mjs", [], { P24_COMMERCE_ONLY: "1" })],
  "phase24-product-smoke": () => [nodeStep("phase24-product-smoke", "scripts/phase24_native_smoke.mjs", [], { P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/candidates/phase-24/data-viewer.exe") })],
  "phase24-release-smoke": () => [nodeStep("phase24-release-smoke", "scripts/phase24_native_smoke.mjs", [], { P24_REQUIRE_PRODUCT: "1", P24_BINARY: path.join(root, "src-tauri/target/release/data-viewer.exe") })],
  "phase24-fixtures": () => [{name: "phase24-fixtures", program: "C:/ProgramData/miniforge3/python.exe", args: ["fixtures/phase-24/generate.py", "--scale"], env: {PYTHONPATH: path.join(root, ".tmp/hdf5-fixture-python")}}],
  "phase24-frontend-format": () => [nodeStep("phase24-frontend-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "src/App.tsx", "src/App.css", "src/VirtualDataGrid.tsx", "src/chartTransport.ts", "src/chart-workspace/**/*.{ts,tsx,css}", "src/sql-workspace/**/*.{ts,tsx,css}", "e2e/phase24-chart*.spec.ts"])],
  "phase24-e2e": (filter) => [nodeStep("phase24-e2e", "scripts/phase22_e2e.mjs", [filter ?? "Phase 24"])],
  "phase24-e2e-full": () => [nodeStep("phase24-e2e-full", "scripts/phase22_e2e.mjs")],
  "phase24-frontend-test": () => [nodeStep("phase24-frontend-test", "node_modules/vitest/vitest.mjs", ["run", "--maxWorkers=2"])],
  "phase23-format": () => [phase23Rust("format")],
  "phase23-check": () => [phase23Rust("check")],
  "phase23-clippy": () => [phase23Rust("clippy")],
  "phase23-test": () => [phase23Rust("test")],
  "phase23-sql-unit": () => [phase23Rust("sql-unit")],
  "phase23-build": () => [frontendBuild(), phase23Rust("build")],
  "phase23-native-build": () => [frontendBuild(), phase23Rust("native-build")],
  "phase23-storage-draft-build": () => [frontendBuild(), phase23Rust("storage-draft-build")],
  "phase23-storage-draft": () => [nodeStep("phase23-storage-draft", "scripts/native_phase23_results.mjs", ["--storage-draft"])],
  "phase23-storage-baseline": () => [nodeStep("phase23-storage-baseline", "scripts/native_phase23_results.mjs", ["--storage-baseline"])],
  "phase23-storage-precision": () => [nodeStep("phase23-storage-precision", "scripts/native_phase23_results.mjs", ["--timestamp-precision", "--storage-draft"])],
  "phase23-product-smoke": () => [nodeStep("phase23-product-smoke", "scripts/native_phase23_results.mjs", ["--product-smoke"])],
  "phase23-export-overwrite-build": () => [frontendBuild(), phase23Rust("export-overwrite-build")],
  "phase23-export-overwrite": () => [nodeStep("phase23-export-overwrite", "scripts/native_phase23_results.mjs", ["--export-overwrite"])],
  "phase23-native": () => [nodeStep("phase23-native", "scripts/native_phase23_results.mjs")],
  "phase23-native-timestamp": () => [nodeStep("phase23-native-timestamp", "scripts/native_phase23_results.mjs", ["--timestamp-followup"])],
  "phase23-native-precision": () => [nodeStep("phase23-native-precision", "scripts/native_phase23_results.mjs", ["--timestamp-precision"])],
  "phase23-frontend-format": () => [nodeStep("phase23-frontend-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "src/sql-workspace/**/*.{ts,tsx,css}", "src/VirtualDataGrid.tsx", "src/backend.ts", "src/query/QueryToolbar.tsx"])],
  "phase23-e2e-format": () => [nodeStep("phase23-e2e-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "e2e/phase23-results.spec.ts"])],
  "phase23-e2e": (filter) => [nodeStep("phase23-e2e", "scripts/phase22_e2e.mjs", filter ? [filter] : [])],
  "phase22-identifier-keywords": () => [nodeStep("phase22-identifier-keywords", "scripts/sync_sql_identifier_keywords.mjs")],
  "frontend-check": () => [
    nodeStep("format", "node_modules/prettier/bin/prettier.cjs", ["--check", "src/**/*.{ts,tsx,css}", "e2e/**/*.ts", "vite.config.ts", "playwright.config.ts", "tsconfig.e2e.json", "index.html"]),
    nodeStep("lint", "node_modules/eslint/bin/eslint.js", [".", "--ignore-pattern", ".tmp/", "--max-warnings", "0"]),
    nodeStep("types-app", "node_modules/typescript/bin/tsc", ["--noEmit"]),
    nodeStep("types-node", "node_modules/typescript/bin/tsc", ["-p", "tsconfig.node.json", "--noEmit"]),
    nodeStep("types-e2e", "node_modules/typescript/bin/tsc", ["-p", "tsconfig.e2e.json", "--noEmit"]),
  ],
  "phase21-frontend-format": () => [nodeStep("phase21-frontend-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "src/column-values/backend.ts", "src/column-values/backend.test.ts", "src/column-values/mock.ts", "src/column-values/mock.test.ts", "src/column-values/ColumnValuesPanel.tsx", "src/column-values/ColumnValuesPanel.test.tsx", "e2e/phase21.spec.ts"])],
  "frontend-test": (filter) => [nodeStep("frontend-test", "node_modules/vitest/vitest.mjs", ["run", ...(filter ? [filter] : [])])],
  "phase22-frontend-format": () => [nodeStep("phase22-frontend-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "src/sql-workspace/**/*.{ts,tsx,css}", "src/settings/**/*.{ts,tsx,css}", "src/App.tsx", "src/backend.ts", "src/backend.test.ts", "src/VirtualDataGrid.tsx", "src/VirtualDataGrid.test.tsx"])],
  "phase22-e2e-format": () => [nodeStep("phase22-e2e-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "e2e/phase16.spec.ts", "e2e/phase22-sql.spec.ts", "e2e/phase22-sql-storage.spec.ts", "e2e/phase22-intellisense.spec.ts", "e2e/phase22-source-lifecycle.spec.ts", "e2e/phase22-join-completion.spec.ts", "e2e/phase22-editor-usability.spec.ts", "e2e/phase22-editor-layout.spec.ts", "e2e/phase24-sql-grid-navigation.spec.ts"])],
  "phase22-types": () => [nodeStep("phase22-types", "node_modules/typescript/bin/tsc", ["--noEmit"])],
  "phase22-fixtures": () => [{name: "phase22-fixtures", program: "C:/ProgramData/miniforge3/python.exe", args: ["fixtures/phase-22/generate.py"], env: {PYTHONPATH: path.join(root, ".tmp/hdf5-fixture-python")}}],
  "phase22-commerce-fixtures": () => [{name: "phase22-commerce-fixtures", program: "C:/ProgramData/miniforge3/python.exe", args: ["fixtures/phase-22/commerce/generate.py"], env: {PYTHONPATH: path.join(root, ".tmp/hdf5-fixture-python")}}],
  "phase22-join-fixtures": () => [{name: "phase22-join-fixtures", program: "C:/ProgramData/miniforge3/python.exe", args: ["fixtures/phase-22/join-completion/generate.py"], env: {PYTHONPATH: path.join(root, ".tmp/hdf5-fixture-python")}}],
  "phase22-stress-fixture": () => [{name: "phase22-stress-fixture", program: "C:/ProgramData/miniforge3/python.exe", args: ["scripts/phase22_stress_fixture.py"], env: {PYTHONPATH: path.join(root, ".tmp/hdf5-fixture-python")}}],
  "phase22-stress": (filter) => [nodeStep("phase22-stress", "scripts/native_phase22_stress.mjs", filter ? [filter] : [])],
  "phase22-sql-diagnostics": () => [psStep("phase22-sql-diagnostics", "scripts/phase22_diagnostics.ps1")],
  "phase22-csv-waiter": () => [psStep("phase22-csv-waiter", "scripts/phase22_checks.ps1", ["-Stage", "csv-waiter"])],
  "phase22-csv-corrupt": () => [psStep("phase22-csv-corrupt", "scripts/phase22_checks.ps1", ["-Stage", "csv-corrupt"])],
  "phase22-format": () => [psStep("phase22-format", "scripts/phase22_checks.ps1", ["-Stage", "format"])],
  "phase22-check": () => [psStep("phase22-check", "scripts/phase22_checks.ps1", ["-Stage", "check"])],
  "phase22-static-check": () => [psStep("phase22-static-check", "scripts/phase22_static_check.ps1")],
  "phase22-static-test-check": () => [psStep("phase22-static-test-check", "scripts/phase22_static_check.ps1", ["-Stage", "test-check"])],
  "phase22-static-clippy": () => [psStep("phase22-static-clippy", "scripts/phase22_static_check.ps1", ["-Stage", "clippy"])],
  "phase22-test": () => [psStep("phase22-test", "scripts/phase22_checks.ps1", ["-Stage", "test"])],
  "phase22-sql-unit": () => [psStep("phase22-sql-unit", "scripts/phase22_checks.ps1", ["-Stage", "sql-unit"])],
  "phase22-clippy": () => [psStep("phase22-clippy", "scripts/phase22_checks.ps1", ["-Stage", "clippy"])],
  "phase22-build": () => [nodeStep("frontend-build", "node_modules/vite/bin/vite.js", ["build"]), psStep("phase22-build", "scripts/phase22_checks.ps1", ["-Stage", "build"])],
  "phase22-native-build": () => [nodeStep("frontend-build", "node_modules/vite/bin/vite.js", ["build"]), psStep("phase22-native-build", "scripts/phase22_checks.ps1", ["-Stage", "native-build"])],
  "phase22-native": () => [nodeStep("phase22-native", "scripts/native_phase22_sql.mjs")],
  "phase22-native-export": () => [nodeStep("phase22-native-export", "scripts/native_phase22_sql.mjs", ["--export-only"])],
  "phase22-native-export-candidate": () => [nodeStep("phase22-native-export-candidate", "scripts/native_phase22_sql.mjs", ["--export-only", "--export-candidate"])],
  "phase22-bundle": () => [psStep("phase22-bundle", "scripts/phase22_checks.ps1", ["-Stage", "bundle"])],
  "phase22-e2e": (filter) => [nodeStep("phase22-e2e", "scripts/phase22_e2e.mjs", filter ? [filter] : [])],
  "phase22-restore-evidence": () => [nodeStep("phase22-restore-evidence", "scripts/phase22_restore_evidence.mjs")],
  "backend-test": () => [psStep("backend-test", scripts.backend, ["-Stage", "full"])],
  "backend-check": () => [psStep("backend-check", scripts.backend, ["-Stage", "clippy"])],
  "backend-format": () => [psStep("backend-format", scripts.backend, ["-Stage", "format"])],
  "backend-view": () => [psStep("backend-view", scripts.backend, ["-Stage", "utf8-view"])],
  e2e: (filter) => [nodeStep("e2e", scripts.playwright, ["test", "--config", "artifacts/phase-20/storage-decimal/playwright.config.ts", ...(filter ? ["--grep", filter] : [])], {
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".tmp/playwright-browsers"),
  })],
  "frontend-build": () => [nodeStep("frontend-build", "node_modules/vite/bin/vite.js", ["build"])],
  "native-build": () => [psStep("native-build", scripts.build)],
  "phase21-format": () => [psStep("phase21-format", "scripts/phase21_checks.ps1", ["-Stage", "format"])],
  "phase21-check": () => [psStep("phase21-check", "scripts/phase21_checks.ps1", ["-Stage", "check"])],
  "phase21-test": () => [psStep("phase21-test", "scripts/phase21_checks.ps1", ["-Stage", "test"])],
  "phase21-category": () => [psStep("phase21-category", "scripts/phase21_checks.ps1", ["-Stage", "category"])],
  "phase21-cursor": () => [psStep("phase21-cursor", "scripts/phase21_checks.ps1", ["-Stage", "cursor"])],
  "phase21-cursor-unit": () => [psStep("phase21-cursor-unit", "scripts/phase21_checks.ps1", ["-Stage", "cursor-unit"])],
  "phase21-cache-identity": () => [psStep("phase21-cache-identity", "scripts/phase21_checks.ps1", ["-Stage", "cache-identity"])],
  "phase21-clippy": () => [psStep("phase21-clippy", "scripts/phase21_checks.ps1", ["-Stage", "clippy"])],
  "phase21-build": () => [psStep("phase21-build", "scripts/phase21_checks.ps1", ["-Stage", "build"])],
  "phase21-native-build": () => [psStep("phase21-native-build", "scripts/phase21_checks.ps1", ["-Stage", "native-build"])],
  "phase21-e2e": (filter) => [nodeStep("phase21-e2e", "scripts/phase21_e2e.mjs", filter ? [filter] : [])],
  "phase21-native": () => [nodeStep("phase21-native", "scripts/native_phase21_smoke.mjs")],
  "phase21-native-migration": () => [nodeStep("phase21-native-migration", "scripts/native_phase21_smoke.mjs", ["--migration-only"])],
  "phase21-native-category": () => [nodeStep("phase21-native-category", "scripts/native_phase21_smoke.mjs", ["--category-only"])],
  "phase21-native-category-1g": () => [nodeStep("phase21-native-category-1g", "scripts/native_phase21_smoke.mjs", ["--category-only", "--category-1g"])],
  "phase21-native-cursor": () => [nodeStep("phase21-native-cursor", "scripts/native_phase21_smoke.mjs", ["--category-only", "--category-1g", "--cursor-regression"])],
  "phase21-native-cursor-copy": () => [nodeStep("phase21-native-cursor-copy", "scripts/native_phase21_smoke.mjs", ["--category-only", "--category-1g", "--cursor-regression", "--cursor-copy-only"])],
  "phase21-native-clipboard-probe": () => [nodeStep("phase21-native-clipboard-probe", "scripts/native_phase21_smoke.mjs", ["--clipboard-probe"])],
  "phase21-native-clipboard-os": () => [nodeStep("phase21-native-clipboard-os", "scripts/native_phase21_smoke.mjs", ["--clipboard-os-only"])],
  "phase21-native-probe": () => [nodeStep("phase21-native-probe", "scripts/native_phase21_smoke.mjs", ["--probe"])],
  "phase21-native-observer": () => [nodeStep("phase21-native-observer", "scripts/native_phase21_smoke.mjs", ["--bridge"])],
  "phase21-bundle": () => [psStep("phase21-bundle", "scripts/phase21_checks.ps1", ["-Stage", "bundle"])],
  "native-version": () => [nodeStep("native-version", "scripts/native_phase20_version_smoke.mjs", [], { DATA_VIEWER_TEST_BINARY: validationBinary })],
  "native-view": () => [nodeStep("native-view", "scripts/native_phase20_version_smoke.mjs", ["--utf8-view"], { DATA_VIEWER_TEST_BINARY: fs.existsSync(viewCandidate) ? viewCandidate : validationBinary })],
  "native-storage": () => [nodeStep("native-storage", scripts.native, ["fixed", "both", validationBinary])],
  "native-decimal": () => [nodeStep("native-decimal", scripts.native, ["decimal"], { DATA_VIEWER_TEST_BINARY: validationBinary })],
};

const args = process.argv.slice(2);
const dryRun = args[0] === "--dry-run";
if (dryRun) args.shift();
if (args.length === 1 && args[0] === "--list") {
  console.log(Object.keys(tasks).join("\n"));
  process.exit(0);
}
const [task, filter] = args;
if (!Object.hasOwn(tasks, task) || args.length > 2 ||
    (filter !== undefined && (!["frontend-test", "e2e", "phase21-e2e", "phase22-e2e", "phase23-e2e", "phase24-e2e", "phase22-stress"].includes(task) || !filter || /^-/.test(filter) || /[\r\n\0]/.test(filter)))) {
  console.error("Usage: node scripts/dev-check.mjs [--dry-run] TASK [FILTER]\nUse --list for the fixed task list. Filters are supported only for frontend-test and e2e.");
  process.exit(2);
}
const steps = tasks[task](filter);
for (const step of steps) {
  const entry = step.program === node ? step.args[0] : step.args[step.args.indexOf("-File") + 1];
  if (!fs.existsSync(path.join(root, entry))) throw new Error(`Required local entry is missing: ${entry}. No installation was attempted.`);
}
if (dryRun) {
  console.log(JSON.stringify({ task, cwd: root, steps }, null, 2));
  process.exit(0);
}

const logs = path.join(root, "artifacts/dev-check");
fs.mkdirSync(logs, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
function tail(file) {
  const handle = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const buffer = Buffer.alloc(Math.min(size, 16384));
    fs.readSync(handle, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8").split(/\r?\n/).slice(-18).join("\n");
  } finally { fs.closeSync(handle); }
}
for (const step of steps) {
  const log = path.join(logs, `${stamp}-${step.name}.log`);
  console.log(`Running ${step.name}; log: ${path.relative(root, log)}`);
  const handle = fs.openSync(log, "wx");
  let result;
  try {
    result = spawnSync(step.program, step.args, { cwd: root, env: { ...process.env, ...step.env }, windowsHide: true, shell: false, stdio: ["ignore", handle, handle] });
  } finally { fs.closeSync(handle); }
  console.log(tail(log));
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || `Failed: ${step.name} (exit ${result.status}, signal ${result.signal})`);
    process.exit(result.status || 1);
  }
}
console.log(`PASS: ${task}`);
