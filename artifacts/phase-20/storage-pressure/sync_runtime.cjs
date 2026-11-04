// Keep the native converter's storage/query runtime aligned with product fixes.
// The archived snapshot stays immutable; only the live build variant is updated.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const variant = path.join(root, 'artifacts/experiments/csv-native-parquet/size-variant/src');
const patch = path.join(__dirname, 'worker-adapter.patch');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function applies(reverse) {
  try {
    execFileSync('git', ['apply', '-C1', ...(reverse ? ['--reverse'] : []), '--check', patch], {cwd:root, stdio:'pipe'});
    return true;
  } catch { return false; }
}
if (!applies(true)) {
  if (!applies(false)) throw new Error('Native worker adapter differs from both expected pre-fix and fixed source; review before building.');
  execFileSync('git', ['apply', '-C1', patch], {cwd:root, stdio:'pipe'});
}
const files = ['query/engine.rs', 'storage/temp.rs', 'storage/csv_cache.rs', 'data/csv_source.rs', 'data/value_format.rs', 'data/parquet_source.rs'];
for (const relative of files) {
  const source = path.join(root, 'src-tauri/src', relative), target = path.join(variant, relative);
  if (hash(source) !== hash(target)) fs.copyFileSync(source, target);
  if (hash(source) !== hash(target)) throw new Error(`Runtime source mismatch: ${relative}`);
}
console.log('Storage/query runtime sync PASS; native converter implementation retained.');
