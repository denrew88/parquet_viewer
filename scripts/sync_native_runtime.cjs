// Canonical common Rust modules feed the existing native CSV build variant.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src-tauri/src');
const target = path.join(root, 'artifacts/experiments/csv-native-parquet/size-variant/src');
let updated = 0;
function sync(directory, relative = '') {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) { sync(path.join(directory, entry.name), name); continue; }
    if (!entry.isFile() || !name.endsWith('.rs') || name.replaceAll('\\', '/') === 'data/csv_polars.rs') continue;
    let bytes = fs.readFileSync(path.join(source, name));
    if (name.replaceAll('\\', '/') === 'data/mod.rs') {
      bytes = Buffer.from(bytes.toString('utf8').trimEnd() + '\n\n#[cfg(feature = "polars-csv-provider")]\nmod csv_native_size;\n');
    }
    const destination = path.join(target, name);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    if (!fs.existsSync(destination) || !bytes.equals(fs.readFileSync(destination))) {
      fs.writeFileSync(destination, bytes); updated++;
    }
  }
}
if (!fs.readFileSync(path.join(target, 'data/csv_polars.rs'), 'utf8').includes('super::csv_native_size::convert_profile(')) {
  throw new Error('Native worker adapter missing; refusing to replace it with the full Polars engine.');
}
sync(source);
console.log(`Native runtime synchronized: ${updated} common modules updated; native CSV worker retained.`);
