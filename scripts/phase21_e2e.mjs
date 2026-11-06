// Preserve historical UI evidence while the common regression suite captures its states.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const backup = path.join(root, '.tmp', `phase21-e2e-evidence-${Date.now()}`);
const saved = [];
async function snapshot(directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true}).catch(() => [])) {
    const original = path.join(directory, entry.name);
    if (entry.isDirectory()) await snapshot(original);
    else if (entry.isFile() && /\.(png|json)$/u.test(entry.name)) {
      const relative = path.relative(root, original);
      const copy = path.join(backup, relative);
      await fs.mkdir(path.dirname(copy), {recursive: true});
      await fs.copyFile(original, copy);
      const stat = await fs.stat(original);
      saved.push({original, copy, atime: stat.atime, mtime: stat.mtime,
        sha256: createHash('sha256').update(await fs.readFile(copy)).digest('hex')});
    }
  }
}
for (let phase = 0; phase <= 20; phase++) await snapshot(path.join(root, `artifacts/phase-${phase}/ui`));
let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
      '--config', 'artifacts/phase-20/storage-decimal/playwright.config.ts',
      ...(process.argv[2] ? ['--grep', process.argv[2]] : [])], {
      cwd: root, windowsHide: true, stdio: 'inherit',
      env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.tmp/playwright-browsers')},
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  for (const item of saved) {
    await fs.copyFile(item.copy, item.original);
    await fs.utimes(item.original, item.atime, item.mtime);
    const restored = createHash('sha256').update(await fs.readFile(item.original)).digest('hex');
    if (restored !== item.sha256) throw new Error(`Historical evidence restore failed: ${item.original}`);
  }
  console.log(`Preserved ${saved.length} historical evidence files; backup: ${path.relative(root, backup)}`);
}
process.exitCode = exitCode;
