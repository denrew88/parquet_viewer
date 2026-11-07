// Compile-only module harness. Does not execute project build scripts or binaries.
// This does NOT validate Tauri context generation, linking, tests or native runtime.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const variant = path.join(root, 'artifacts/experiments/csv-native-parquet/size-variant');
const target = path.join(root, '.tmp/phase22-typecheck');
fs.mkdirSync(path.join(target, 'src'), {recursive: true});
let manifest = fs.readFileSync(path.join(variant, 'Cargo.toml'), 'utf8');
manifest = manifest.replace('edition = "2021"', 'edition = "2021"\nbuild = false');
manifest = manifest.replace('crate-type = ["staticlib", "cdylib", "rlib"]', 'crate-type = ["rlib"]');
manifest = manifest.replace(/\[\[example\]\][\s\S]*?(?=\n\[)/g, '');
manifest += '\n[lints.rust]\nunexpected_cfgs = { level = "warn", check-cfg = ["cfg(mobile)", "cfg(desktop)"] }\n';
fs.writeFileSync(path.join(target, 'Cargo.toml'), manifest);
fs.copyFileSync(path.join(variant, 'Cargo.lock'), path.join(target, 'Cargo.lock'));
let source = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
source = source.replace(/^mod (commands|copy|data|domain|platform|query|storage);\r?$/gm, (_, name) => {
  const file = path.join(variant, 'src', name, 'mod.rs').replaceAll('\\', '/');
  return `#[path = ${JSON.stringify(file)}]\nmod ${name};`;
});
const runtime = /\.run\(tauri::generate_context!\(\)\)\s*\.expect\("error while running tauri application"\)/;
if (!runtime.test(source)) throw new Error('Tauri runtime entry changed; update the explicit metadata-only harness.');
source = source.replace(runtime, '').replace('tauri::Builder::default()', 'let _builder = tauri::Builder::default()');
fs.writeFileSync(path.join(target, 'src/lib.rs'), source);
console.log('Prepared module-only Rust metadata check; no project build script, app or test execution.');
