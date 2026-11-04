import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.resolve(process.env.DATA_VIEWER_TEST_BINARY || path.join(root, 'src-tauri/target/release/data-viewer.exe'));
const viewMode = process.argv.includes('--utf8-view');
const output = path.join(root, 'artifacts/phase-20', viewMode ? 'utf8-view' : 'version-0.20.0');
const profile = path.join(root, '.tmp/phase20-version-webview');
await fs.mkdir(output, {recursive: true});
const result = {status: 'FAIL', binary, sha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'), fixtures: []};
let app, browser, page;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
try {
  const startupPaths = viewMode ? [path.join(root, 'fixtures/phase-20/utf8-view.parquet')] : [];
  app = spawn(binary, startupPaths, {cwd: root, windowsHide: true, stdio: 'ignore', env: {...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9497'}});
  let launchError;
  app.once('error', error => { launchError = error; });
  for (let i = 0; i < 120; i++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error(`Application exited: ${app.exitCode}`);
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9497'); break; } catch { await pause(250); }
  }
  assert.ok(browser, 'Native app CDP endpoint unavailable');
  page = browser.contexts().flatMap(context => context.pages())[0];
  await page.waitForURL(url => url.hostname === 'tauri.localhost', {timeout: 30000});
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  result.health = await invoke('health_check');
  result.tauriVersion = await invoke('plugin:app|version');
  assert.equal(result.health.appVersion, '0.20.0');
  assert.equal(result.tauriVersion, '0.20.0');
  if (viewMode) {
    await page.getByText('긴 문자열🙂 with more than twelve bytes', {exact: true}).waitFor({timeout: 30000});
    assert.equal(await page.getByText(/Unsupported value/).count(), 0);
    result.nativeUiStringViewVisible = true;
  }
  for (const [name, rows, column] of [['storage-decimal.csv', 3, 'id'], ['timestamp.csv', 16, 'case_id']]) {
    const fixture = path.join(root, 'fixtures/phase-20', name);
    const before = createHash('sha256').update(await fs.readFile(fixture)).digest('hex');
    const response = await invoke('open_data_paths', {request: {requestId: `phase20-version-${name}`, origin: 'startupArg', paths: [fixture]}});
    assert.equal(response.failures.length, 0, JSON.stringify(response.failures));
    const {documentId, sessionId} = response.opened[0], target = {documentId, sessionId};
    let preparation;
    for (let i = 0; i < 600; i++) {
      preparation = await invoke('get_csv_preparation_status', target);
      if (preparation?.state === 'ready' || preparation?.state === 'failed') break;
      await pause(50);
    }
    assert.equal(preparation?.state, 'ready', JSON.stringify(preparation));
    const data = await invoke('read_page', {request: {...target, offset: 0, limit: rows, columns: [column]}});
    assert.equal(data.page.rows.length, rows);
    assert.equal(data.page.rows[0][0].display, '1');
    assert.equal(data.page.rows.at(-1)[0].display, String(rows));
    await invoke('close_document', target);
    const after = createHash('sha256').update(await fs.readFile(fixture)).digest('hex');
    assert.equal(after, before);
    result.fixtures.push({path: fixture, rows, sha256: before, unchanged: true});
  }
  if (viewMode) {
    const sample = JSON.parse(await fs.readFile(path.join(output, 'cache-sample.json'), 'utf8'));
    const checks = [
      {path: path.join(root, 'fixtures/phase-20/utf8-view.parquet'), column: 'value', values: ['short', '긴 문자열🙂 with more than twelve bytes', '', null, 'line\nwith\ttab', ' ']},
      sample,
    ];
    result.stringViews = [];
    for (const check of checks) {
      const before = createHash('sha256').update(await fs.readFile(check.path)).digest('hex');
      const response = await invoke('open_data_paths', {request: {requestId: `phase20-view-${check.column}`, origin: 'startupArg', paths: [check.path]}});
      assert.equal(response.failures.length, 0, JSON.stringify(response.failures));
      const {documentId, sessionId} = response.opened[0], target = {documentId, sessionId};
      const data = await invoke('read_page', {request: {...target, offset: 0, limit: check.values.length, columns: [check.column]}});
      assert.equal(data.page.rows.length, check.values.length);
      for (const [index, expected] of check.values.entries()) {
        const value = data.page.rows[index][0];
        if (expected === null) assert.equal(value.state, 'null');
        else {
          assert.equal(value.display, expected);
          assert.equal(value.kind, 'string');
          const full = await invoke('read_cell_value', {request: {...target, queryId: null, row: index, columnId: check.column}});
          assert.equal(full.value.display, expected);
        }
      }
      await invoke('close_document', target);
      assert.equal(createHash('sha256').update(await fs.readFile(check.path)).digest('hex'), before);
      result.stringViews.push({path: check.path, column: check.column, rows: check.values.length, unchanged: true});
    }
  }
  result.status = 'PASS';
} catch (error) {
  result.error = String(error.stack || error);
} finally {
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve));
    app.kill();
    await Promise.race([exited, pause(3000)]);
  }
  await fs.writeFile(path.join(output, 'native-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
if (result.status !== 'PASS') process.exitCode = 1;
