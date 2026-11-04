import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const here = import.meta.dirname, root = path.resolve(here, '../../..');
if (process.argv[2] === 'decimal') {
  await import('../storage-decimal/native.mjs');
  process.exit(process.exitCode || 0);
}
if (process.argv[3] === 'both') {
  for (const limit of ['512', '1024']) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [process.argv[1], process.argv[2] || 'fixed', limit, ...process.argv.slice(4)], {cwd: root, windowsHide: true, stdio: 'inherit'});
      child.once('error', reject); child.once('exit', resolve);
    });
    if (code !== 0) process.exit(code || 1);
  }
  process.exit(0);
}
const label = process.argv[2] || 'fixed', mib = Number(process.argv[3] || 512);
assert.ok([512, 1024].includes(mib));
const binary = path.resolve(process.argv[4] || path.join(root, 'src-tauri/target/release/data-viewer.exe'));
const out = path.join(here, `${label}-${mib}`);
await fs.mkdir(out, { recursive: true });
const fixtures = path.join(out, 'fixtures');
await fs.mkdir(fixtures, { recursive: true });
const inputs = [
  'fixtures/phase-20/performance/main-high/high-5850000x15.csv',
  ...Array(3).fill('fixtures/phase-20/performance/wide-65/source.csv'),
];
const paths = [];
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
for (const [i, source] of inputs.entries()) {
  const target = path.join(fixtures, `document-${i}-${Date.now()}.csv`);
  await fs.link(path.join(root, source), target);
  paths.push(target);
}
const result = { status: 'FAIL', label, limitBytes: mib * 1024 * 1024, binary, paths, runs: [] };
result.binarySha256 = await sha256(binary);
result.sourceHashesBefore = await Promise.all(paths.map(sha256));
let app, browser, page, settings, output = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function run(warm) {
  const response = await invoke('open_data_paths', {request: {requestId: `${label}-${mib}-${warm}`, origin: 'startupArg', paths}});
  assert.equal(response.failures.length, 0, JSON.stringify(response.failures));
  assert.equal(response.opened.length, 4);
  const targets = response.opened.map(({documentId, sessionId}) => ({documentId, sessionId}));
  const observation = {warm, targets, initial: [], terminal: [], samples: []};
  result.runs.push(observation);
  for (const target of targets) {
    const status = await invoke('get_csv_preparation_status', target);
    observation.initial.push(status);
    if (!status) await invoke('prepare_csv_session', target).catch(error => observation.initial.push({error}));
  }
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const statuses = await Promise.all(targets.map(t => invoke('get_csv_preparation_status', t)));
    const usage = await invoke('get_query_temp_usage');
    observation.samples.push({states: statuses.map(s => s?.state), processBytes: usage.processBytes, activeQueries: usage.activeQueries});
    if (statuses.every(s => s && ['ready', 'failed', 'cancelled'].includes(s.state))) {
      observation.terminal = statuses;
      break;
    }
    await pause(100);
  }
  observation.usage = await invoke('get_query_temp_usage');
  const ready = observation.terminal.every(s => s.state === 'ready') && observation.terminal.length === 4;
  if (ready) {
    observation.pages = [];
    for (const [i, target] of targets.entries()) {
      assert.equal(observation.terminal[i].totalRows, i === 0 ? 5850000 : 65537);
      const request = {...target, offset: 0, limit: 2, columns: [response.opened[i].summary.columns[0].name]};
      const page = await invoke('read_page', {request});
      assert.equal(page.page.rows.length, 2);
      const digits = value => value.display.replace(/[^0-9-]/g, '');
      assert.equal(digits(page.page.rows[0][0]), i === 0 ? '0' : '9223372036854775808');
      observation.pages.push(page.page.rows);
      const last = await invoke('read_page', {request: {...request, offset: i === 0 ? 5849999 : 65536, limit: 1}});
      assert.equal(last.page.rows.length, 1);
      assert.equal(digits(last.page.rows[0][0]), i === 0 ? '5849999' : '9223372036854775807');
      observation.pages.push(last.page.rows);
    }
    assert.ok(observation.usage.processBytes <= result.limitBytes, 'Actual storage exceeds configured limit');
    if (warm) assert.ok(observation.terminal.every(s => s.sourceReadBytes === 0));
    if (warm && mib === 512) {
      const extraPath = path.join(fixtures, `over-capacity-${Date.now()}.csv`);
      await fs.link(path.join(root, inputs[0]), extraPath);
      const opened = await invoke('open_data_paths', {request: {requestId: 'capacity-boundary', origin: 'startupArg', paths: [extraPath]}});
      assert.equal(opened.failures.length, 0);
      const {documentId, sessionId} = opened.opened[0], extra = {documentId, sessionId};
      async function terminal(target) {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const s = await invoke('get_csv_preparation_status', target);
          if (s && ['ready', 'failed', 'cancelled'].includes(s.state)) return s;
          await pause(100);
        }
        throw new Error('Capacity boundary timed out');
      }
      const failed = await terminal(extra);
      assert.equal(failed.state, 'failed', JSON.stringify(failed));
      assert.equal(failed.error?.code, 'QueryTempLimitExceeded');
      observation.capacityFailure = failed;
      const cleanupDeadline = Date.now() + 3000;
      while (Date.now() < cleanupDeadline) {
        observation.capacityFailureUsage = await invoke('get_query_temp_usage');
        if (observation.capacityFailureUsage.activeQueries === observation.usage.activeQueries &&
            observation.capacityFailureUsage.queryTempBytes <= observation.usage.queryTempBytes + 4096) break;
        await pause(25);
      }
      assert.equal(observation.capacityFailureUsage.activeQueries, observation.usage.activeQueries);
      assert.ok(observation.capacityFailureUsage.queryTempBytes <= observation.usage.queryTempBytes + 4096, 'Failed worker staging remains');
      assert.ok(observation.capacityFailureUsage.processBytes < result.limitBytes);
      const kept = await Promise.all(targets.map(t => invoke('get_csv_preparation_status', t)));
      assert.ok(kept.every(s => s.state === 'ready'), 'Active CSV artifacts were invalidated');
      await invoke('close_document', targets[0]);
      await invoke('prepare_csv_session', extra);
      const retry = await terminal(extra);
      assert.equal(retry.state, 'ready', JSON.stringify(retry));
      observation.capacityRetry = retry;
      await invoke('close_document', extra);
      for (const target of targets.slice(1)) await invoke('close_document', target);
      return;
    }
  }
  for (const target of targets) await invoke('close_document', target);
  assert.ok(ready, JSON.stringify(observation.terminal));
}
try {
  const port = mib === 512 ? 9492 : 9493;
  app = spawn(binary, [], {cwd: root, windowsHide: true, env: {...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`}, stdio: ['ignore', 'pipe', 'pipe']});
  let launchError; app.on('error', e => launchError = e);
  app.stdout.on('data', b => output += b); app.stderr.on('data', b => output += b);
  for (let i = 0; i < 120; i++) {
    if (launchError) throw launchError;
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await pause(250); }
  }
  assert.ok(browser, 'CDP unavailable');
  page = browser.contexts().flatMap(c => c.pages())[0];
  await page.waitForURL(u => u.hostname === 'tauri.localhost', {timeout: 30000});
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  const usage = await invoke('get_query_temp_usage');
  assert.ok(usage.csvCachePath.includes('com.denrew88.data-viewer-native-validation-20261103'), 'Requires isolated validation app');
  settings = await invoke('get_settings');
  // This namespace belongs exclusively to validation; never clear the real app.
  result.cacheCleanup = await invoke('clear_csv_cache');
  result.appliedSettings = await invoke('update_settings', {settings: {...settings, queryTempLimitBytes: result.limitBytes}});
  assert.equal((await invoke('get_query_temp_usage')).limitBytes, result.limitBytes);
  await run(false);
  await run(true);
  result.status = 'PASS';
} catch (error) {
  result.error = String(error.stack || error);
  if (!app && String(error).includes('spawn UNKNOWN')) {
    const diagnostic = spawnSync('C:/ProgramData/miniforge3/python.exe', ['-c',
      'import subprocess,sys\ntry:\n p=subprocess.Popen([sys.argv[1]]);print("Started",p.pid);p.terminate();p.wait(timeout=5)\nexcept OSError as e:\n print(repr(e),"winerror",getattr(e,"winerror",None));sys.exit(1)', binary],
      {encoding:'utf8',windowsHide:true});
    result.launchDiagnosis = {code: diagnostic.status, stdout: diagnostic.stdout, stderr: diagnostic.stderr};
  }
}
finally {
  if (page && settings) await invoke('update_settings', {settings}).catch(e => result.settingsRestoreError = String(e));
  result.output = output;
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null) {
    const closed = new Promise(resolve => app.once('exit', resolve));
    app.kill(); await Promise.race([closed, pause(3000)]);
  }
  result.sourceHashesAfter = await Promise.all(paths.map(sha256));
  assert.deepEqual(result.sourceHashesAfter, result.sourceHashesBefore);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({status: result.status, limitMiB: mib, error: result.error, launchDiagnosis: result.launchDiagnosis, states: result.runs.map(r => r.terminal.map(s => s.state))}));
}
if (result.status !== 'PASS') process.exitCode = 1;
