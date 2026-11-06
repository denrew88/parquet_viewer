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
const tasks = {
  "frontend-check": () => [
    nodeStep("format", "node_modules/prettier/bin/prettier.cjs", ["--check", "src/**/*.{ts,tsx,css}", "e2e/**/*.ts", "vite.config.ts", "playwright.config.ts", "tsconfig.e2e.json", "index.html"]),
    nodeStep("lint", "node_modules/eslint/bin/eslint.js", [".", "--ignore-pattern", ".tmp/", "--max-warnings", "0"]),
    nodeStep("types-app", "node_modules/typescript/bin/tsc", ["--noEmit"]),
    nodeStep("types-node", "node_modules/typescript/bin/tsc", ["-p", "tsconfig.node.json", "--noEmit"]),
    nodeStep("types-e2e", "node_modules/typescript/bin/tsc", ["-p", "tsconfig.e2e.json", "--noEmit"]),
  ],
  "phase21-frontend-format": () => [nodeStep("phase21-frontend-format", "node_modules/prettier/bin/prettier.cjs", ["--write", "src/column-values/backend.ts", "src/column-values/backend.test.ts", "src/column-values/mock.ts", "src/column-values/mock.test.ts", "src/column-values/ColumnValuesPanel.tsx", "src/column-values/ColumnValuesPanel.test.tsx", "e2e/phase21.spec.ts"])],
  "frontend-test": (filter) => [nodeStep("frontend-test", "node_modules/vitest/vitest.mjs", ["run", ...(filter ? [filter] : [])])],
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
    (filter !== undefined && (!["frontend-test", "e2e", "phase21-e2e"].includes(task) || !filter || /^-/.test(filter) || /[\r\n\0]/.test(filter)))) {
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
