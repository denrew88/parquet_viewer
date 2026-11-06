// Fixed native Phase 21 acceptance runner. The actual folder chooser is operated
// by the Root agent; this script never forges its opaque selection grant.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, '.tmp/phase21-native');
const output = path.join(root, 'artifacts/phase-21/native');
const binary = path.join(root, 'src-tauri/target/release/candidates/phase-21-native/data-viewer.exe');
const identifier = 'com.denrew88.data-viewer-phase21-acceptance';
const fixture = path.join(root, 'fixtures/phase-21/distinct-pages.csv');
const largeFixture = path.join(root, 'fixtures/phase-20/performance/main-high/high-5850000x15.csv');
const migrationOnly = process.argv.includes('--migration-only');
const reportName = migrationOnly ? 'migration-only.json' : 'results.json';
const result = { status: 'RUNNING', binary, identifier, startedAt: new Date().toISOString(), checks: [], commands: [] };
const documents = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const nativeNetworkObservers = new WeakMap();
if (process.argv.includes('--probe') || process.argv.includes('--bridge')) {
  await nativeObserverAuxiliary(process.argv.includes('--bridge') ? 'bridge' : 'probe');
  process.exit(0);
}
let app, browser, page, selected, originalSettings, originalClipboard, clipboardCaptured = false, sequence = 0;
await fs.mkdir(scratch, { recursive: true });
await fs.mkdir(output, { recursive: true });
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const invoke = async (command, args = {}) => {
  // Catch native DTO rejections inside WebView; Playwright otherwise reduces
  // non-Error rejections to an Error and loses their code/message fields.
  const response = await page.evaluate(async ({ command, args }) => {
    try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) }; }
    catch (error) { return { ok: false, error }; }
  }, { command, args });
  if (!response.ok) throw response.error;
  return response.value;
};
async function checkpoint(stage, details = {}) {
  await writeJson(path.join(scratch, 'status.json'), { stage, pid: app?.pid, at: new Date().toISOString(), ...details });
  await writeJson(path.join(output, reportName), result);
  console.log(JSON.stringify({ stage, commandId: details.commandId, action: details.action, status: typeof details.status === 'object' ? { operationId: details.status.operationId, state: details.status.state, progress: details.status.progress, error: details.status.error } : details.status, selection: details.selection, destinations: details.destinations ? { parent: details.destinations.parent, cancelledParent: details.destinations.cancelledParent, failureParent: details.destinations.failureParent, committedParent: details.destinations.committedParent } : undefined, sourceInventoryFiles: details.sourceInventory?.length, error: details.error }));
}
async function poll(read, terminal, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await read();
    if (terminal(status)) return status;
    await pause(25);
  }
  throw new Error(`Native operation exceeded ${timeout}ms`);
}
async function launch(startupPath = fixture) {
  // Start-Process uses ShellExecute for the Windows GUI binary; Node's direct
  // CreateProcess launch can return UNKNOWN before exposing a Win32 error.
  const script = `$ErrorActionPreference='Stop'
try {
  $started = Start-Process -FilePath $env:DATA_VIEWER_PHASE21_BINARY -ArgumentList ('"'+$env:DATA_VIEWER_PHASE21_FIXTURE+'"') -WorkingDirectory $env:DATA_VIEWER_PHASE21_ROOT -WindowStyle Hidden -PassThru
  $started.Refresh()
  [pscustomobject]@{pid=$started.Id;path=$started.Path;startedAtTicks=$started.StartTime.Ticks.ToString()} | ConvertTo-Json -Compress
} catch {
  $details=[ordered]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;hresult=$_.Exception.HResult;innerType=$null;innerMessage=$null;nativeErrorCode=$null}
  if ($_.Exception.InnerException) { $details.innerType=$_.Exception.InnerException.GetType().FullName; $details.innerMessage=$_.Exception.InnerException.Message }
  if ($_.Exception -is [ComponentModel.Win32Exception]) { $details.nativeErrorCode=$_.Exception.NativeErrorCode }
  elseif ($_.Exception.InnerException -is [ComponentModel.Win32Exception]) { $details.nativeErrorCode=$_.Exception.InnerException.NativeErrorCode }
  $details | ConvertTo-Json -Compress
  exit 1
}`;
  let launched;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: root, windowsHide: true, timeout: 30000, env: { ...process.env,
      DATA_VIEWER_PHASE21_BINARY: binary, DATA_VIEWER_PHASE21_FIXTURE: startupPath, DATA_VIEWER_PHASE21_ROOT: root,
      WEBVIEW2_USER_DATA_FOLDER: path.join(scratch, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9498' } });
    launched = JSON.parse(stdout);
  } catch (error) {
    result.launchFailure = { message: String(error.message), stdout: error.stdout, stderr: error.stderr };
    throw new Error(`Native Start-Process failed: ${error.stdout || error.stderr || error.message}`);
  }
  assert.ok(Number.isSafeInteger(launched.pid) && launched.pid > 0);
  app = { ...launched, exitCode: null };
  (result.launches ??= []).push(launched);
  for (let attempt = 0; attempt < 160; attempt++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9498'); break; } catch { await pause(250); }
  }
  assert.ok(browser, 'Native CDP unavailable');
  page = browser.contexts().flatMap(context => context.pages())[0];
  await page.waitForURL(url => url.hostname === 'tauri.localhost', { timeout: 30000 });
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  assert.equal(await invoke('plugin:app|identifier'), identifier, 'Refuse to mutate the product namespace');
  result.health = await invoke('health_check');
  assert.equal(result.health.appVersion, '0.21.0');
  assert.equal(await invoke('plugin:app|version'), '0.21.0');
  result.pid = app.pid;
  await page.bringToFront();
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = null;
  if (app && app.exitCode === null) {
    assert.ok(Number.isSafeInteger(app.pid) && app.pid > 0);
    const script = `$ErrorActionPreference='Stop'
$owned = Get-Process -Id ([int]$env:DATA_VIEWER_PHASE21_PID) -ErrorAction SilentlyContinue
if ($null -ne $owned) {
  $actual=[IO.Path]::GetFullPath($owned.Path)
  $expected=[IO.Path]::GetFullPath($env:DATA_VIEWER_PHASE21_BINARY)
  if (-not [string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to terminate a PID whose executable path differs from the owned native candidate.' }
  if ($owned.StartTime.Ticks.ToString() -ne $env:DATA_VIEWER_PHASE21_STARTED_TICKS) { throw 'Refusing to terminate a reused PID.' }
  Stop-Process -Id $owned.Id -ErrorAction Stop
  if (-not $owned.WaitForExit(3000)) { throw 'Owned native candidate did not exit.' }
}
'stopped'`;
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: { ...process.env,
      DATA_VIEWER_PHASE21_PID: String(app.pid), DATA_VIEWER_PHASE21_BINARY: binary,
      DATA_VIEWER_PHASE21_STARTED_TICKS: app.startedAtTicks } });
    app.exitCode = 0;
  }
  documents.clear();
}
async function open(file) {
  const response = await invoke('open_data_paths', { request: { requestId: `p21-open-${++sequence}`, origin: 'startupArg', paths: [file] } });
  assert.equal(response.failures.length, 0, JSON.stringify(response.failures));
  const { documentId, sessionId } = response.opened[0];
  const identity = { documentId, sessionId };
  documents.set(documentId, identity);
  const preparation = await poll(() => invoke('get_csv_preparation_status', identity), value => value?.state === 'ready' || value?.state === 'failed', 300000);
  assert.equal(preparation.state, 'ready', JSON.stringify(preparation));
  return { ...identity, preparation };
}
async function closeDocuments() {
  // The startup tab is React-owned; close it through UI so its local state also clears.
  const panelClose = page.getByRole('button', { name: 'Close column values', exact: true });
  if (await panelClose.count()) await panelClose.click();
  const settingsClose = page.getByRole('button', { name: 'Close settings', exact: true });
  if (await settingsClose.count()) await settingsClose.click();
  const closes = page.getByRole('navigation', { name: 'Open files', exact: true }).getByRole('button', { name: /^Close / });
  while (await closes.count()) { await closes.first().click(); await pause(50); }
  for (const identity of documents.values()) await invoke('close_document', identity).catch(() => {});
  documents.clear();
}
async function values(identity, columnId, queryId = null) {
  const request = { documentId: identity.documentId, sessionId: identity.sessionId, operationId: `p21-values-${++sequence}`, columnId, queryId };
  await invoke('start_column_values', { request });
  const status = await poll(() => invoke('get_column_values_status', request), value => ['ready', 'failed', 'cancelled'].includes(value.state));
  assert.equal(status.state, 'ready', JSON.stringify(status));
  return { request, status };
}
async function copy(request, includeCounts, expected, search = null) {
  const start = await invoke('start_column_values_copy', { request: { documentId: request.documentId, sessionId: request.sessionId, operationId: request.operationId, search, order: 'countDescending', includeCounts } });
  const identity = { documentId: start.documentId, sessionId: start.sessionId, operationId: start.operationId };
  const status = await poll(() => invoke('get_copy_status', { request: identity }), value => ['complete', 'failed', 'cancelled'].includes(value.state));
  assert.equal(status.state, 'complete', JSON.stringify(status));
  const actual = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(actual, expected, 'Actual Windows clipboard differs from independent golden');
  return { operationId: start.operationId, bytes: Buffer.byteLength(actual), rows: status.progress.rowsProcessed, sha256: createHash('sha256').update(actual).digest('hex') };
}
async function checkNewSessionPageAndQuery() {
  const identity = await open(fixture);
  const target = { documentId: identity.documentId, sessionId: identity.sessionId };
  const read = await invoke('read_page', { request: { ...target, offset: 0, limit: 3, columns: ['id', 'value'] } });
  assert.equal(read.page.rows.length, 3);
  const query = { ...target, queryId: `p21-boundary-${++sequence}`, taskId: `p21-boundary-task-${sequence}`, plan: { filters: [], search: null, sort: [], projection: ['id', 'value'] } };
  await invoke('execute_query', { request: query });
  const status = await poll(() => invoke('get_query_status', query), value => ['complete', 'failed', 'cancelled'].includes(value.state));
  assert.equal(status.state, 'complete', JSON.stringify(status));
  assert.equal(status.progress.resultRows, 708);
  const queried = await invoke('read_query_page', { request: { ...target, queryId: query.queryId, offset: 0, limit: 3, columns: ['id', 'value'] } });
  assert.deepEqual(queried.page.rows, read.page.rows);
  await closeDocuments();
  return { preparation: identity.preparation, rows: read.page.rows.length, queryRows: status.progress.resultRows };
}
async function measureAppRss() {
  assert.ok(Number.isSafeInteger(app.pid));
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).WorkingSet64`], { windowsHide: true, timeout: 5000 });
  const bytes = Number(stdout.trim());
  assert.ok(Number.isFinite(bytes) && bytes > 0);
  return bytes;
}
async function cacheInventory(directory) {
  const rows = [];
  async function visit(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Refuse to inspect reparse entries');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file, { bigint: true });
        rows.push({ path: path.relative(directory, file), bytes: String(stat.size), device: String(stat.dev), fileId: String(stat.ino), sha256: await digest(file) });
      }
    }
  }
  await visit(directory);
  return rows;
}
async function attachNativeNetworkObserver(target, { forward = true, onEvent = () => {} } = {}) {
  const session = await target.context().newCDPSession(target);
  await session.send('Network.enable');
  const pending = new Map();
  session.on('Network.responseReceived', event => {
    let url;
    try { url = new URL(event.response.url); } catch { return; }
    if (url.hostname !== 'ipc.localhost' && url.protocol !== 'ipc:') return;
    pending.set(event.requestId, { command: decodeURIComponent(url.pathname.replace(/^\//, '')), url: event.response.url, headers: event.response.headers, status: event.response.status });
  });
  session.on('Network.loadingFinished', async event => {
    const response = pending.get(event.requestId);
    if (!response) return;
    pending.delete(event.requestId);
    try {
      const body = await session.send('Network.getResponseBody', { requestId: event.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const value = JSON.parse(text);
      const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'tauri-response')?.[1];
      const actual = { command: response.command, at: Date.now(), source: 'actual-cdp-network-response', requestId: event.requestId, url: response.url, status: response.status, tauriResponse: header, ...(String(header).toLowerCase() === 'error' ? { error: value } : { value }) };
      onEvent(actual);
      if (forward && ['choose_csv_cache_location', 'start_csv_cache_migration', 'cancel_csv_cache_migration'].includes(actual.command)) {
        await target.evaluate(actual => {
          window.__DATA_VIEWER_PHASE21_NATIVE_OBSERVER__ ??= { events: [] };
          window.__DATA_VIEWER_PHASE21_NATIVE_OBSERVER__.events.push(actual);
        }, actual);
      }
    } catch (error) { onEvent({ command: response.command, url: response.url, observationError: String(error) }); }
  });
  return session;
}
async function nativeObserverAuxiliary(mode) {
  const connected = await chromium.connectOverCDP('http://127.0.0.1:9498', { timeout: 10000 });
  try {
    const target = connected.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('tauri.localhost'));
    assert.ok(target, 'Owned native WebView unavailable');
    assert.equal(await target.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')), identifier);
    const details = await target.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__, 'invoke');
      return { internalFrozen: Object.isFrozen(window.__TAURI_INTERNALS__), invokeDescriptor: { writable: descriptor?.writable, configurable: descriptor?.configurable, enumerable: descriptor?.enumerable, getter: typeof descriptor?.get, setter: typeof descriptor?.set }, observerEvents: window.__DATA_VIEWER_PHASE21_NATIVE_OBSERVER__?.events ?? null };
    });
    console.log(JSON.stringify({ mode, details }));
    const observed = [];
    const session = await attachNativeNetworkObserver(target, { forward: mode === 'bridge', onEvent: event => { observed.push(event); console.log(JSON.stringify({ observed: event })); } });
    const health = await target.evaluate(() => window.__TAURI_INTERNALS__.invoke('health_check'));
    await pause(500);
    console.log(JSON.stringify({ mode, ready: true, health, observedCount: observed.length }));
    if (mode === 'bridge') {
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        await pause(500);
        try { const state = JSON.parse(await fs.readFile(path.join(scratch, 'status.json'), 'utf8')); if (state.stage === 'stopped') break; } catch {}
      }
    }
    await session.detach();
  } finally { await connected.close(); }
}
async function observeNativeUiCalls() {
  if (!nativeNetworkObservers.has(page)) nativeNetworkObservers.set(page, await attachNativeNetworkObserver(page));
  return page.evaluate(() => {
    window.__DATA_VIEWER_PHASE21_NATIVE_OBSERVER__ ??= { events: [] };
    return window.__DATA_VIEWER_PHASE21_NATIVE_OBSERVER__.events.length;
  });
}
async function observedNativeResponse(command, startAt) {
  const event = await poll(() => page.evaluate(({ command, startAt }) => window.__DATA_VIEWER_PHASE21_NATIVE_OBSERVER__.events.slice(startAt).find(event => event.command === command) ?? null, { command, startAt }), value => value !== null, 300000);
  assert.ok(!event.error, `Actual UI ${command} failed: ${JSON.stringify(event.error)}`);
  return event.value;
}
async function settingsUi() {
  const dialog = page.getByRole('dialog', { name: 'Application settings', exact: true });
  if (!(await dialog.count())) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.waitFor();
  return dialog;
}
async function verifyMigration(chosen, before, sourceInventory, status, progress, cancelled) {
  if (cancelled) { assert.equal(status.state, 'cancelled', JSON.stringify(status)); assert.deepEqual(await invoke('get_settings'), before); }
  else { assert.equal(status.state, 'complete', JSON.stringify(status)); assert.equal((await invoke('get_settings')).csvCacheDirectory, chosen.preview.targetPath); }
  const inventory = await cacheInventory(cancelled ? chosen.preview.sourcePath : chosen.preview.targetPath);
  const artifacts = rows => rows.filter(row => ['prepared.parquet', 'states.bin', 'offsets.idx'].includes(path.basename(row.path))).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  assert.deepEqual(artifacts(inventory), artifacts(sourceInventory), 'Migration must preserve every prepared artifact');
  if (cancelled) assert.deepEqual(inventory, sourceInventory, 'Cancelled migration must preserve the complete source cache and identities');
  if (result.destinations) for (const sentinel of result.destinations.sentinels) assert.equal(await digest(sentinel.path), sentinel.sha256);
  if (chosen.preview.sourceUnavailable && result.offlineBackup) assert.deepEqual(await cacheInventory(result.offlineBackup.backup), result.offlineBackup.inventory, 'Replacement must not modify the unavailable cache backup');
  selected = null;
  return { status, progress, sourceInventory, destinationOrPreservedSourceInventory: inventory, settings: await invoke('get_settings'), usage: await invoke('get_query_temp_usage') };
}
async function validate() {
  const golden = JSON.parse(await fs.readFile(path.join(root, 'fixtures/phase-21/golden.json'), 'utf8'));
  const before = await digest(fixture);
  const identity = await open(fixture);
  const whole = await values(identity, 'value');
  assert.equal(whole.status.totalCount, 237);
  const pageRequest = { documentId: identity.documentId, sessionId: identity.sessionId, operationId: whole.request.operationId, search: null, order: 'countDescending', offset: 0, limit: 100 };
  const pages = [];
  for (const offset of [0, 100, 200]) pages.push(await invoke('read_column_values_page', { request: { ...pageRequest, offset } }));
  assert.deepEqual(pages.map(value => value.values.length), [100, 100, 37]);
  assert.deepEqual(pages.flatMap(value => value.values.map(item => [item.value, item.count])), golden.source.valuesCountDescending);
  for (const order of ['valueAscending', 'valueDescending', 'countAscending']) {
    const all = [];
    for (const offset of [0, 100, 200]) all.push(...(await invoke('read_column_values_page', { request: { ...pageRequest, offset, order } })).values);
    const expected = [...golden.source.valuesCountDescending].sort((a, b) => order === 'countAscending' ? a[1] - b[1] || a[0].localeCompare(b[0]) : a[0].localeCompare(b[0]) * (order === 'valueDescending' ? -1 : 1));
    assert.deepEqual(all.map(value => [value.value, value.count]), expected);
  }
  const search = await invoke('read_column_values_page', { request: { ...pageRequest, search: 'value-23' } });
  assert.equal(search.totalCount, 237); assert.equal(search.matchedCount, 7);
  const copies = [await copy(whole.request, false, golden.source.valuesTsv), await copy(whole.request, true, golden.source.valuesCountsTsv)];
  const searched = golden.source.valuesCountDescending.filter(([value]) => value.includes('value-23'));
  copies.push(await copy(whole.request, true, ['Value\tCount', ...searched.map(([value, count]) => `${value}\t${count}`)].join('\r\n'), 'value-23'));
  const sentinel = await page.evaluate(() => navigator.clipboard.readText());
  await assert.rejects(invoke('start_column_values_copy', { request: { ...pageRequest, offset: undefined, limit: undefined, includeCounts: false, search: 'missing-value-xyz' } }));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sentinel);
  await invoke('release_column_values', whole.request);
  await page.getByRole('button', { name: 'Column values value', exact: true }).click();
  const valuesDialog = page.getByRole('dialog', { name: 'Column values: value', exact: true });
  await valuesDialog.getByText('237 distinct values', { exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(output, 'native-column-values.png') });
  await valuesDialog.getByRole('button', { name: 'Close column values', exact: true }).click();
  const query = { documentId: identity.documentId, sessionId: identity.sessionId, queryId: `p21-filter-${++sequence}`, taskId: `p21-task-${sequence}`, plan: { filters: [{ id: 'bucket-a', columnId: 'bucket', scalarType: 'text', operator: 'equals', values: ['A'] }], search: null, sort: [], projection: ['id', 'value', 'bucket'] } };
  await invoke('execute_query', { request: query });
  const status = await poll(() => invoke('get_query_status', query), value => ['complete', 'failed', 'cancelled'].includes(value.state));
  assert.equal(status.state, 'complete', JSON.stringify(status));
  const filtered = await values(identity, 'value', query.queryId);
  assert.equal(filtered.status.totalCount, 118);
  copies.push(await copy(filtered.request, true, golden.bucketA.valuesCountsTsv));
  await invoke('release_column_values', filtered.request);
  assert.equal(await digest(fixture), before);
  result.checks.push({ name: 'native-distinct-snapshot-paging-order-search-filter-clipboard', status: 'PASS', total: 237, filtered: 118, pages: [100, 100, 37], copies, sourceSha256: before });
  await closeDocuments();
  await validateSettings();
}
async function validateSettings() {
  const settings = await invoke('get_settings');
  const next = { ...settings, queryTempLimitBytes: 322122547, csvCacheLimitBytes: 536870912 };
  assert.deepEqual(await invoke('update_settings', { settings: next }), next);
  const usage = await invoke('get_query_temp_usage');
  assert.equal(usage.csvCacheEffectiveLimitBytes, 322122547);
  assert.equal(usage.csvCacheLimitBytes, 536870912);
  for (const bytes of [67108863, 10737418241]) await assert.rejects(invoke('update_settings', { settings: { ...next, csvCacheLimitBytes: bytes } }));
  const boundarySessions = [];
  for (const bytes of [67108864, 10737418240]) {
    assert.equal((await invoke('update_settings', { settings: { ...next, csvCacheLimitBytes: bytes } })).csvCacheLimitBytes, bytes);
    boundarySessions.push({ cacheLimit: bytes, ...await checkNewSessionPageAndQuery() });
  }
  await invoke('update_settings', { settings: next });
  boundarySessions.push({ cacheLimit: next.csvCacheLimitBytes, ...await checkNewSessionPageAndQuery() });
  await invoke('update_settings', { settings: { ...next, queryTempLimitBytes: 10737418240, csvCacheLimitBytes: 10737418240 } });
  result.checks.push({ name: 'native-settings-cap-boundaries-new-session', status: 'PASS', configured: next, usage, boundarySessions });
  await page.screenshot({ path: path.join(output, 'native-after-data-validation.png') });
}
async function command(message) {
  switch (message.action) {
    case 'prepare-destinations': {
      assert.ok(!result.destinations, 'Test destinations were already created in this run');
      const nonce = `${Date.now()}-${randomUUID()}`;
      const parent = path.join('D:\\', `DataViewerPhase21Validation-${nonce}`);
      const owner = { kind: 'data-viewer-phase21-native-acceptance', nonce, identifier, parent };
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', 'Get-Volume -DriveLetter C,D | Select-Object DriveLetter,UniqueId,Path,FileSystemLabel,FileSystem,Size,SizeRemaining | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 10000 });
      const volumes = JSON.parse(stdout);
      assert.ok(Array.isArray(volumes) && volumes.length === 2);
      const cVolume = volumes.find(volume => volume.DriveLetter === 'C');
      const dVolume = volumes.find(volume => volume.DriveLetter === 'D');
      assert.ok(cVolume?.UniqueId && dVolume?.UniqueId);
      assert.notEqual(cVolume.UniqueId, dVolume.UniqueId, 'C: and D: must identify different volumes');
      await fs.mkdir(parent); // Exclusive unique root: never adopt or clear an existing directory.
      await writeJson(path.join(parent, '.phase21-native-owner.json'), owner);
      const cancelledParent = path.join(parent, 'cancel');
      const committedParent = path.join(parent, 'committed');
      const failureParent = path.join(parent, 'failure');
      const recoveryParent = path.join(scratch, `recovery-${nonce}`);
      await fs.mkdir(cancelledParent);
      await fs.mkdir(committedParent);
      await fs.mkdir(failureParent);
      await fs.mkdir(recoveryParent);
      const sentinels = [];
      for (const directory of [parent, cancelledParent, committedParent, failureParent, recoveryParent]) {
        const file = path.join(directory, 'foreign-sentinel.txt');
        await fs.writeFile(file, `Unrelated sibling; preserve exactly. ${nonce}\r\n`, { flag: 'wx' });
        sentinels.push({ path: file, sha256: await digest(file) });
      }
      const destinations = { nonce, parent, cancelledParent, committedParent, failureParent, recoveryParent, owner, volumes, sentinels };
      result.destinations = destinations;
      await writeJson(path.join(scratch, 'destinations.json'), destinations);
      return { destinations };
    }
    case 'validate': await validate(); return { validated: true };
    case 'settings-boundaries': await closeDocuments(); await validateSettings(); return { validated: true };
    case 'pick': {
      const before = await invoke('get_settings');
      await checkpoint('picker-open', { commandId: message.id });
      selected = await invoke('choose_csv_cache_location');
      assert.deepEqual(await invoke('get_settings'), before, 'Choosing or cancelling must not change persisted settings');
      return { selection: selected, settingsUnchanged: true };
    }
    case 'ui-pick': {
      await closeDocuments();
      const before = await invoke('get_settings');
      const dialog = await settingsUi();
      const chooser = dialog.getByRole('button', { name: /^Choose cache location/ });
      await chooser.scrollIntoViewIfNeeded();
      assert.equal(await chooser.isEnabled(), true, 'Native UI chooser must be available with all files closed');
      const startAt = await observeNativeUiCalls();
      await checkpoint('picker-open', { commandId: message.id, actualSettingsUi: true });
      await chooser.click();
      selected = await observedNativeResponse('choose_csv_cache_location', startAt);
      assert.deepEqual(await invoke('get_settings'), before);
      const file = path.join(output, `native-ui-cache-preview-${++sequence}.png`);
      if (selected) {
        const preview = dialog.getByRole('region', { name: 'Cache migration preview' });
        await preview.waitFor();
        assert.ok((await preview.textContent()).includes(selected.preview.targetPath));
        await preview.scrollIntoViewIfNeeded();
        await page.screenshot({ path: file });
      }
      return { selection: selected, settingsUnchanged: true, actualSettingsUi: true, screenshot: selected ? file : null };
    }
    case 'ui-migrate': {
      assert.ok(selected, 'Use ui-pick to populate the actual Settings preview first');
      const chosen = selected;
      const before = await invoke('get_settings');
      const sourceInventory = chosen.preview.sourceUnavailable ? [] : await cacheInventory(chosen.preview.sourcePath);
      const dialog = await settingsUi();
      const startButton = dialog.getByRole('button', { name: chosen.preview.sourceUnavailable ? 'Use this cache location' : 'Move cache here', exact: true });
      assert.equal(await startButton.isEnabled(), true);
      const startAt = await observeNativeUiCalls();
      await startButton.click();
      let status = await observedNativeResponse('start_csv_cache_migration', startAt);
      const operationId = status.operationId;
      const statusArea = dialog.locator('.cache-migration-status');
      await statusArea.waitFor();
      const destination = statusArea.locator('p').first();
      assert.ok((await destination.textContent()).includes(chosen.preview.targetPath), 'Native UI must retain the migration destination');
      await statusArea.scrollIntoViewIfNeeded();
      const progressControl = statusArea.getByRole('progressbar', { name: 'Cache migration progress' });
      const progressVisible = await progressControl.isVisible();
      const progressScreenshot = path.join(output, `native-ui-cache-progress-${++sequence}.png`);
      const uiProgress = { visible: progressVisible, destination: await destination.textContent(), text: await statusArea.textContent(), backendStatusAtCapture: await invoke('get_csv_cache_migration_status', { operationId }) };
      if (progressVisible) uiProgress.control = await progressControl.evaluate(element => ({ value: element.value, max: element.max, bounds: element.getBoundingClientRect().toJSON() }));
      await page.screenshot({ path: progressScreenshot });
      if (message.requireProgress) assert.equal(progressVisible, true, 'Required native progress state was not captured');
      if (message.cancel) {
        await statusArea.getByRole('button', { name: 'Cancel cache move', exact: true }).click();
        await observedNativeResponse('cancel_csv_cache_migration', startAt);
      }
      const progress = [];
      status = await poll(async () => { const value = await invoke('get_csv_cache_migration_status', { operationId }); if (progress.at(-1)?.copiedBytes !== value.progress.copiedBytes || progress.at(-1)?.phase !== value.progress.phase) progress.push(value.progress); return value; }, value => ['complete', 'cancelled', 'failed'].includes(value.state), 300000);
      const verified = await verifyMigration(chosen, before, sourceInventory, status, progress, message.cancel === true);
      const terminalText = message.cancel ? 'Cache move cancelled' : chosen.preview.sourceUnavailable ? 'Cache location updated successfully' : 'Cache moved successfully';
      await dialog.getByText(terminalText, { exact: true }).waitFor({ timeout: 10000 });
      assert.ok((await destination.textContent()).includes(chosen.preview.targetPath));
      const terminalScreenshot = path.join(output, `native-ui-cache-terminal-${++sequence}.png`);
      await statusArea.scrollIntoViewIfNeeded();
      await page.screenshot({ path: terminalScreenshot });
      return { ...verified, actualSettingsUi: true, uiProgress, progressScreenshot, terminalScreenshot };
    }
    case 'close-docs': await closeDocuments(); return { closed: true };
    case 'usage': return { settings: await invoke('get_settings'), usage: await invoke('get_query_temp_usage') };
    case 'prepare-large': {
      const before = await digest(largeFixture);
      const identity = await open(largeFixture);
      if (message.warm) assert.equal(identity.preparation.sourceReadBytes, 0, JSON.stringify(identity.preparation));
      const preparedUsage = await invoke('get_query_temp_usage');
      assert.equal(await digest(largeFixture), before);
      const pageResult = await invoke('read_page', { request: { documentId: identity.documentId, sessionId: identity.sessionId, offset: 5849999, limit: 1, columns: ['row_id'] } });
      assert.equal(pageResult.page.rows[0][0].display.replaceAll(',', ''), '5849999');
      if (message.close !== false) await closeDocuments();
      return { preparation: identity.preparation, usage: preparedUsage, afterClose: await invoke('get_query_temp_usage'), sourceSha256: before, pageResult };
    }
    case 'cap-active-reclaim': {
      await closeDocuments();
      const saved = await invoke('get_settings');
      await invoke('update_settings', { settings: { ...saved, queryTempLimitBytes: 10737418240, csvCacheLimitBytes: 10737418240 } });
      const identity = await open(largeFixture);
      const active = await invoke('get_query_temp_usage');
      assert.ok(active.csvCacheActiveBytes > 67108864, 'Fixture must hold cache larger than new cap');
      await invoke('update_settings', { settings: { ...saved, queryTempLimitBytes: 10737418240, csvCacheLimitBytes: 67108864 } });
      const lowered = await invoke('get_query_temp_usage');
      assert.equal(lowered.csvCacheActiveBytes, active.csvCacheActiveBytes);
      const read = await invoke('read_page', { request: { documentId: identity.documentId, sessionId: identity.sessionId, offset: 5849999, limit: 1, columns: ['row_id'] } });
      assert.equal(read.page.rows[0][0].display.replaceAll(',', ''), '5849999');
      await closeDocuments();
      const afterClose = await invoke('get_query_temp_usage');
      assert.ok(afterClose.csvCacheBytes <= 67108864, JSON.stringify(afterClose));
      const oversized = await open(largeFixture);
      const oversizedUsage = await invoke('get_query_temp_usage');
      assert.equal(oversizedUsage.csvCacheActiveEntries, 0, 'Oversized preparation must remain ephemeral');
      assert.equal(oversized.preparation.state, 'ready');
      await closeDocuments();
      await invoke('update_settings', { settings: { ...saved, queryTempLimitBytes: 10737418240, csvCacheLimitBytes: 10737418240 } });
      return { active, lowered, afterClose, oversizedPreparation: oversized.preparation, oversizedUsage };
    }
    case 'high-cardinality': {
      const identity = await open(largeFixture);
      const target = { documentId: identity.documentId, sessionId: identity.sessionId };
      const rssSamples = [await measureAppRss()];
      let sampling = false;
      const interval = setInterval(async () => { if (sampling) return; sampling = true; try { rssSamples.push(await measureAppRss()); } catch {} finally { sampling = false; } }, 1000);
      try {
        const started = Date.now();
        const operation = await values(identity, 'row_id');
        const elapsedMs = Date.now() - started;
        assert.equal(operation.status.totalCount, 5850000);
        const pageRequest = { ...target, operationId: operation.request.operationId, search: null, order: 'valueAscending', offset: 0, limit: 200 };
        const first = await invoke('read_column_values_page', { request: pageRequest });
        assert.equal(first.values.length, 200);
        assert.equal(first.hasMore, true);
        // Source's default text profile sorts lexical strings; typed profiles sort numerically.
        assert.equal(new Set(first.values.map(value => value.value)).size, 200);
        const oversizedCopy = await invoke('start_column_values_copy', { request: { ...target, operationId: operation.request.operationId, search: null, order: 'valueAscending', includeCounts: false } }).then(async status => {
          const copyStatus = await poll(() => invoke('get_copy_status', { request: { ...target, operationId: status.operationId } }), value => ['complete', 'failed', 'cancelled'].includes(value.state));
          assert.equal(copyStatus.state, 'failed', JSON.stringify(copyStatus));
          assert.ok(['selectionLimit', 'byteLimit'].includes(copyStatus.failure?.reason), `Expected configured copy limit failure, received ${JSON.stringify(copyStatus)}`);
          return copyStatus;
        });
        await invoke('release_column_values', operation.request);
        const cancelled = { ...target, operationId: `p21-cancel-${++sequence}`, columnId: 'row_id', queryId: null };
        await invoke('start_column_values', { request: cancelled });
        const cancellationStart = Date.now();
        await invoke('cancel_column_values', cancelled);
        const cancelledStatus = await poll(() => invoke('get_column_values_status', cancelled), value => ['ready', 'failed', 'cancelled'].includes(value.state));
        assert.equal(cancelledStatus.state, 'cancelled', JSON.stringify(cancelledStatus));
        await invoke('release_column_values', cancelled);
        const small = await values(identity, 'active');
        assert.ok(small.status.totalCount <= 3);
        await invoke('release_column_values', small.request);
        await closeDocuments();
        rssSamples.push(await measureAppRss());
        return { totalCount: operation.status.totalCount, firstPageCount: first.values.length, elapsedMs, cancellationMs: Date.now() - cancellationStart, cancelledStatus, oversizedCopy, rssSamples, peakAppRssBytes: Math.max(...rssSamples), finalUsage: await invoke('get_query_temp_usage') };
      } finally { clearInterval(interval); }
    }
    case 'native-copy-cancel': {
      await closeDocuments();
      const priorSettings = await invoke('get_settings');
      const cellLimit = 1000000, byteLimit = 64 * 1024 * 1024, rows = 500000;
      const file = path.join(scratch, `copy-cancel-${Date.now()}-${randomUUID()}.csv`);
      const stream = await fs.open(file, 'wx');
      try {
        await stream.write('id,value\r\n');
        for (let start = 0; start < rows; start += 1000) await stream.write(Array.from({ length: 1000 }, (_, index) => {
          const id = start + index;
          return `${id},unique-${String(id).padStart(6, '0')}-${'x'.repeat(40)}\r\n`;
        }).join(''));
      } finally { await stream.close(); }
      const sourceSha256 = await digest(file);
      let operation;
      try {
        await invoke('update_settings', { settings: { ...priorSettings, copyLimits: { maxCells: cellLimit, maxBytes: byteLimit } } });
        const identity = await open(file);
        operation = await values(identity, 'value');
        assert.equal(operation.status.totalCount, rows);
        const target = { documentId: identity.documentId, sessionId: identity.sessionId };
        const before = await page.evaluate(() => navigator.clipboard.readText());
        const beforeSha256 = createHash('sha256').update(before).digest('hex');
        const started = await invoke('start_column_values_copy', { request: { ...target, operationId: operation.request.operationId, search: null, order: 'valueAscending', includeCounts: false } });
        assert.ok(['queued', 'running'].includes(started.state), `Expected cancellable in-limit copy, received ${JSON.stringify(started)}`);
        assert.equal(started.progress.totalRows, rows);
        const copyIdentity = { ...target, operationId: started.operationId };
        const cancellationStart = Date.now();
        const cancellation = await invoke('cancel_copy', { request: copyIdentity });
        const terminal = await poll(() => invoke('get_copy_status', { request: copyIdentity }), value => ['complete', 'failed', 'cancelled'].includes(value.state));
        assert.equal(terminal.state, 'cancelled', JSON.stringify(terminal));
        const cancellationMs = Date.now() - cancellationStart;
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), before, 'Cancelling must leave the actual clipboard unchanged');
        await invoke('release_column_values', operation.request);
        operation = null;
        await closeDocuments();
        await pause(1000);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), before, 'No clipboard commit may arrive after snapshot release and document close');
        const small = await open(fixture);
        const smallValues = await values(small, 'value');
        const golden = JSON.parse(await fs.readFile(path.join(root, 'fixtures/phase-21/golden.json'), 'utf8'));
        const recoveryCopy = await copy(smallValues.request, true, golden.source.valuesCountsTsv);
        await invoke('release_column_values', smallValues.request);
        await closeDocuments();
        await pause(1000);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), golden.source.valuesCountsTsv, 'Cancelled worker must not overwrite a later successful copy');
        assert.equal(await digest(file), sourceSha256);
        return { path: file, sourceSha256, rows, cellLimit, byteLimit, expectedOutputUpperBoundBytes: rows * 64, started, cancellation, terminal, cancellationMs, clipboardBeforeSha256: beforeSha256, clipboardUnchangedAfterCancelAndClose: true, lateCommitObservationMs: 2000, recoveryCopy, finalUsage: await invoke('get_query_temp_usage') };
      } finally {
        if (operation) await invoke('release_column_values', operation.request).catch(() => {});
        await closeDocuments();
        const current = await invoke('get_settings');
        await invoke('update_settings', { settings: { ...current, copyLimits: priorSettings.copyLimits } });
      }
    }
    case 'typed-values': {
      const file = path.join(root, 'fixtures/phase-21/distinct-types.csv');
      const sourceSha256 = await digest(file);
      const old = await open(file);
      const current = await invoke('get_csv_profile', { documentId: old.documentId, sessionId: old.sessionId });
      const profile = { ...current.profile, mode: 'custom', generation: current.profile.generation + 1, columns: current.profile.columns.map(column => ({ ...column, targetType: column.sourceName === 'typed_integer' ? 'int64' : 'text', nullTokens: ['NULL'] })) };
      const applied = await invoke('apply_csv_profile', { request: { documentId: old.documentId, sessionId: old.sessionId, profile } });
      const identity = { documentId: applied.documentId, sessionId: applied.sessionId };
      documents.set(identity.documentId, identity);
      const preparation = await poll(() => invoke('get_csv_preparation_status', identity), value => ['ready', 'failed'].includes(value?.state));
      assert.equal(preparation.state, 'ready', JSON.stringify(preparation));
      const typed = await values(identity, 'typed_integer');
      assert.equal(typed.status.totalCount, 5);
      const pageRequest = { ...identity, operationId: typed.request.operationId, search: null, order: 'valueAscending', offset: 0, limit: 100 };
      const typedPage = await invoke('read_column_values_page', { request: pageRequest });
      assert.deepEqual(typedPage.values.map(value => [value.value, value.count, value.isInvalid, value.isNull]), [['1', 4, false, false], ['2', 1, false, false], ['10', 1, false, false], ['bad', 1, true, false], [null, 1, false, true]]);
      await invoke('release_column_values', typed.request);
      const text = await values(identity, 'text');
      const textPage = await invoke('read_column_values_page', { request: { ...pageRequest, operationId: text.request.operationId } });
      assert.ok(textPage.values.some(value => value.isEmpty));
      assert.ok(textPage.values.some(value => value.isNull));
      for (const value of ['tab\tvalue', 'line\nvalue', 'line\r\nvalue', 'quote"value', '한글🙂 with longer than twelve bytes']) assert.ok(textPage.values.some(item => item.value === value), JSON.stringify(textPage));
      await invoke('release_column_values', text.request);
      await closeDocuments();
      assert.equal(await digest(file), sourceSha256);
      return { sourceSha256, profile, typedPage, textPage };
    }
    case 'prepare-fixture': {
      const identity = await open(fixture);
      if (message.warm) assert.equal(identity.preparation.progress?.sourceReadBytes ?? identity.preparation.sourceReadBytes, 0, JSON.stringify(identity.preparation));
      const preparedUsage = await invoke('get_query_temp_usage');
      if (message.close !== false) await closeDocuments();
      return { preparation: identity.preparation, usage: preparedUsage };
    }
    case 'prepare-new': {
      await closeDocuments();
      const file = path.join(scratch, `fresh-publish-${Date.now()}.csv`);
      const stream = await fs.open(file, 'wx');
      try {
        await stream.write('id,value\r\n');
        for (let start = 0; start < 100000; start += 1000) await stream.write(Array.from({ length: 1000 }, (_, index) => `${start + index},fresh-${start + index}\r\n`).join(''));
      } finally { await stream.close(); }
      const cold = await open(file);
      assert.ok(cold.preparation.sourceReadBytes > 0);
      const activeUsage = await invoke('get_query_temp_usage');
      assert.ok(activeUsage.csvCacheActiveEntries > 0, 'New preparation was not published to configured cache');
      await closeDocuments();
      const warm = await open(file);
      assert.equal(warm.preparation.sourceReadBytes, 0, JSON.stringify(warm.preparation));
      const read = await invoke('read_page', { request: { documentId: warm.documentId, sessionId: warm.sessionId, offset: 99999, limit: 1, columns: ['id', 'value'] } });
      assert.equal(read.page.rows[0][1].display, 'fresh-99999');
      await closeDocuments();
      result.freshPublication = { path: file, sha256: await digest(file), cold: cold.preparation, warm: warm.preparation, activeUsage };
      return result.freshPublication;
    }
    case 'warm-new': {
      assert.ok(result.freshPublication);
      const current = await open(result.freshPublication.path);
      assert.equal(current.preparation.sourceReadBytes, 0);
      const read = await invoke('read_page', { request: { documentId: current.documentId, sessionId: current.sessionId, offset: 99999, limit: 1, columns: ['value'] } });
      assert.equal(read.page.rows[0][0].display, 'fresh-99999');
      await closeDocuments();
      return { preparation: current.preparation, page: read };
    }
    case 'warm-small-query': {
      const small = await open(fixture), target = { documentId: small.documentId, sessionId: small.sessionId };
      assert.equal(small.preparation.sourceReadBytes, 0);
      const page = await invoke('read_page', { request: { ...target, offset: 0, limit: 3, columns: ['id', 'value', 'bucket'] } });
      assert.equal(page.page.rows.length, 3);
      const query = { ...target, queryId: `migration-query-${++sequence}`, taskId: `migration-task-${sequence}`, plan: { filters: [{ id: 'bucket-a', columnId: 'bucket', scalarType: 'text', operator: 'equals', values: ['A'] }], search: null, sort: [{ columnId: 'value', direction: 'descending', nullsLast: true }], projection: ['value', 'bucket'] } };
      await invoke('execute_query', { request: query });
      const status = await poll(() => invoke('get_query_status', query), value => ['complete', 'failed', 'cancelled'].includes(value.state));
      assert.equal(status.state, 'complete', JSON.stringify(status));
      const expected = JSON.parse(await fs.readFile(path.join(root, 'fixtures/phase-21/golden.json'), 'utf8')).bucketA;
      assert.equal(status.progress.resultRows, expected.rows);
      const sorted = await invoke('read_query_page', { request: { ...target, queryId: query.queryId, offset: 0, limit: 3, columns: ['value', 'bucket'] } });
      assert.ok(sorted.page.rows.every(row => row[1].display === 'A'));
      assert.equal(sorted.page.rows[0][0].display, 'value-235');
      await closeDocuments();
      return { preparation: small.preparation, sourcePage: page, queryStatus: status, sortedPage: sorted, filteredRowsExpected: expected.rows, filteredDistinctExpected: expected.totalCount };
    }
    case 'obstruct-selected-destination': {
      assert.ok(selected && result.destinations);
      const expected = path.join(result.destinations.failureParent, 'data-viewer-csv-cache');
      assert.equal(path.toNamespacedPath(path.resolve(selected.preview.targetPath)).toLowerCase(), path.toNamespacedPath(expected).toLowerCase());
      await assert.rejects(fs.lstat(expected), { code: 'ENOENT' });
      const settings = await invoke('get_settings'), inventory = await cacheInventory(selected.preview.sourcePath);
      await fs.mkdir(expected);
      const sentinel = path.join(expected, '.phase21-obstruction.txt');
      await fs.writeFile(sentinel, `Preserve this test-owned foreign obstruction ${result.destinations.nonce}`, { flag: 'wx' });
      result.obstruction = { path: expected, sentinel, sha256: await digest(sentinel), settings, inventory };
      return { obstruction: { path: expected, sentinel, sha256: result.obstruction.sha256 } };
    }
    case 'migrate-failure': {
      assert.ok(selected && result.obstruction);
      const attempt = await invoke('start_csv_cache_migration', { selectionId: selected.selectionId }).then(status => ({ status }), error => ({ error }));
      if (attempt.status) attempt.status = await poll(() => invoke('get_csv_cache_migration_status', { operationId: attempt.status.operationId }), value => ['complete', 'failed', 'cancelled'].includes(value.state));
      assert.ok(attempt.error || attempt.status?.state === 'failed', JSON.stringify(attempt));
      assert.deepEqual(await invoke('get_settings'), result.obstruction.settings);
      assert.deepEqual(await cacheInventory(selected.preview.sourcePath), result.obstruction.inventory);
      assert.equal(await digest(result.obstruction.sentinel), result.obstruction.sha256);
      for (const sentinel of result.destinations.sentinels) assert.equal(await digest(sentinel.path), sentinel.sha256);
      selected = null;
      return { actualNativeFailure: attempt, settingsUnchanged: true, sourceCacheUnchanged: true, obstructionPreserved: true };
    }
    case 'migrate': {
      assert.ok(selected, 'Choose the destination through actual native picker first');
      const before = await invoke('get_settings');
      if (message.expectBlocked) {
        const error = await invoke('start_csv_cache_migration', { selectionId: selected.selectionId }).then(() => null, error => error);
        assert.ok(error && /close all documents|files are still opening/i.test(error.message), JSON.stringify(error));
        assert.deepEqual(await invoke('get_settings'), before);
        return { correctlyBlocked: true, error, settingsUnchanged: true, selectionRetained: true };
      }
      const sourceInventory = selected.preview.sourceUnavailable ? [] : await cacheInventory(selected.preview.sourcePath);
      let status = await invoke('start_csv_cache_migration', { selectionId: selected.selectionId });
      const operationId = status.operationId;
      let copyObserved;
      if (message.cancelAfterProgress) {
        const deadline = Date.now() + 30000;
        do {
          copyObserved = await invoke('get_csv_cache_migration_status', { operationId });
          if (copyObserved.progress.copiedBytes > 0 && copyObserved.progress.copiedBytes < copyObserved.progress.totalBytes) break;
          assert.ok(['queued', 'running'].includes(copyObserved.state), `Copy finished before cancellation could be observed: ${JSON.stringify(copyObserved)}`);
          await pause(5);
        } while (Date.now() < deadline);
        assert.ok(copyObserved.progress.copiedBytes > 0 && copyObserved.progress.copiedBytes < copyObserved.progress.totalBytes, JSON.stringify(copyObserved));
        message.cancel = true;
      }
      if (message.cancel) await invoke('cancel_csv_cache_migration', { operationId });
      const progress = [];
      status = await poll(async () => { const value = await invoke('get_csv_cache_migration_status', { operationId }); if (progress.at(-1)?.copiedBytes !== value.progress.copiedBytes || progress.at(-1)?.phase !== value.progress.phase) progress.push(value.progress); return value; }, value => ['complete', 'cancelled', 'failed'].includes(value.state), 300000);
      return { ...await verifyMigration(selected, before, sourceInventory, status, progress, message.cancel === true), copyObservedBeforeCancel: copyObserved };
    }
    case 'restart': await closeDocuments(); await stop(); await launch(); return { restarted: true, settings: await invoke('get_settings') };
    case 'offline-prepare': {
      const destinations = result.destinations;
      assert.ok(destinations, 'Create test-owned destinations first');
      const ownerFile = path.join(destinations.parent, '.phase21-native-owner.json');
      assert.deepEqual(JSON.parse(await fs.readFile(ownerFile, 'utf8')), destinations.owner);
      const expected = path.join(destinations.committedParent, 'data-viewer-csv-cache');
      const configured = (await invoke('get_settings')).csvCacheDirectory;
      const normalized = file => path.toNamespacedPath(path.resolve(file)).toLocaleLowerCase();
      assert.equal(normalized(configured), normalized(expected), 'Offline test is restricted to this run\'s committed D: cache');
      for (const directory of [destinations.parent, destinations.committedParent, expected]) assert.ok(!(await fs.lstat(directory)).isSymbolicLink(), 'Refuse a reparse test directory');
      assert.equal(await fs.readFile(path.join(expected, '.data-viewer-cache.json'), 'utf8'), '{"kind":"data-viewer-csv-cache","version":1}');
      const backup = path.join(destinations.committedParent, `data-viewer-csv-cache-offline-${destinations.nonce}`);
      await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
      await closeDocuments();
      await stop();
      const before = await cacheInventory(expected);
      await fs.rename(expected, backup); // Both absolute targets verified within this unique test parent.
      const after = await cacheInventory(backup);
      assert.deepEqual(after, before, 'Offline backup must preserve all data and identities');
      result.offlineBackup = { original: expected, backup, inventory: after };
      for (const sentinel of destinations.sentinels) assert.equal(await digest(sentinel.path), sentinel.sha256);
      await launch();
      assert.equal((await invoke('get_settings')).csvCacheDirectory, configured);
      const unavailable = await invoke('get_query_temp_usage').then(value => ({ unexpectedSuccess: value }), error => ({ error }));
      assert.ok(unavailable.error, 'Unavailable configured root should surface a storage error');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog', { name: 'Application settings', exact: true }).waitFor();
      await page.getByRole('button', { name: /^Choose cache location/ }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'native-offline-cache-settings.png') });
      return { original: expected, backup, inventory: after, settingsReachable: true, unavailable, recoveryParent: destinations.recoveryParent };
    }
    case 'screenshot': {
      const file = path.join(output, `native-${++sequence}.png`);
      await page.screenshot({ path: file }); return { screenshot: file };
    }
    case 'finish': return { finished: true };
    default: throw new Error('Unknown fixed native action');
  }
}
async function clipboardProbeOnly() {
  const osOnly = process.argv.includes('--clipboard-os-only');
  const diagnostic = { status: 'RUNNING', mode: osOnly ? 'clipboard-os-only' : 'clipboard-probe', appLaunched: !osOnly, startedAt: new Date().toISOString(), binary, identifier, paths: [], osProbes: [] };
  const destination = path.join(output, osOnly ? 'clipboard-os-probe.json' : 'clipboard-probe.json');
  const errorInfo = error => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
  let savedText, textCaptured = false, savedSettings, operation;
  async function probeOs(stage) {
    const inspectedProcessId = osOnly ? process.pid : app.pid;
    assert.ok(Number.isSafeInteger(inspectedProcessId) && inspectedProcessId > 0);
    const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Phase21ClipboardDiagnostics {
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetOpenClipboardWindow();
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetClipboardOwner();
 [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr window);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetThreadDesktop(uint threadId);
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll", EntryPoint="GetUserObjectInformationW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
 [DllImport("user32.dll", EntryPoint="GetUserObjectInformationW", SetLastError=true)] public static extern bool GetUserObjectInformationBool(IntPtr handle, int index, out int value, uint bytes, out uint needed);
 public static string ObjectName(IntPtr handle) {
  if (handle == IntPtr.Zero) return null;
  var value = new StringBuilder(256); uint needed;
  return GetUserObjectInformation(handle, 2, value, 512, out needed) ? value.ToString() : "Win32Error:" + Marshal.GetLastWin32Error();
 }
}
'@
function ProcessMetadata([uint32]$targetProcessId) {
 if ($targetProcessId -eq 0) { return $null }
 $targetProcess=Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue
 if ($null -eq $targetProcess) { return [pscustomobject]@{processId=$targetProcessId;exited=$true} }
 [pscustomobject]@{processId=$targetProcess.Id;name=$targetProcess.ProcessName;sessionId=$targetProcess.SessionId;mainWindow=$targetProcess.MainWindowHandle.ToInt64()}
}
$sequenceBefore=[Phase21ClipboardDiagnostics]::GetClipboardSequenceNumber()
$openWindow=[Phase21ClipboardDiagnostics]::GetOpenClipboardWindow()
$ownerWindow=[Phase21ClipboardDiagnostics]::GetClipboardOwner()
[uint32]$openProcessId=0; [uint32]$ownerProcessId=0
$openThreadId=[Phase21ClipboardDiagnostics]::GetWindowThreadProcessId($openWindow,[ref]$openProcessId)
$ownerThreadId=[Phase21ClipboardDiagnostics]::GetWindowThreadProcessId($ownerWindow,[ref]$ownerProcessId)
$opened=[Phase21ClipboardDiagnostics]::OpenClipboard([IntPtr]::Zero)
$openError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
$closed=$null; $closeError=$null
if ($opened) {
 $closed=[Phase21ClipboardDiagnostics]::CloseClipboard()
 if (-not $closed) { $closeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error() }
}
$appProcess=Get-Process -Id ([int]$env:DATA_VIEWER_PHASE21_PROBE_PID) -ErrorAction Stop
[uint32]$appWindowProcessId=0
$appWindowThreadId=[Phase21ClipboardDiagnostics]::GetWindowThreadProcessId($appProcess.MainWindowHandle,[ref]$appWindowProcessId)
$helperDesktop=[Phase21ClipboardDiagnostics]::GetThreadDesktop([Phase21ClipboardDiagnostics]::GetCurrentThreadId())
[int]$helperInput=0; [uint32]$inputNeeded=0
$inputFlagRead=[Phase21ClipboardDiagnostics]::GetUserObjectInformationBool($helperDesktop,6,[ref]$helperInput,4,[ref]$inputNeeded)
$inputFlagError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
$inputDesktop=[Phase21ClipboardDiagnostics]::OpenInputDesktop(0,$false,1)
$inputDesktopError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
$inputDesktopName=$null; $inputDesktopClosed=$null; $inputDesktopCloseError=$null
if ($inputDesktop -ne [IntPtr]::Zero) {
 $inputDesktopName=[Phase21ClipboardDiagnostics]::ObjectName($inputDesktop)
 $inputDesktopClosed=[Phase21ClipboardDiagnostics]::CloseDesktop($inputDesktop)
 if (-not $inputDesktopClosed) { $inputDesktopCloseError=[Runtime.InteropServices.Marshal]::GetLastWin32Error() }
}
$foregroundWindow=[Phase21ClipboardDiagnostics]::GetForegroundWindow()
[uint32]$foregroundProcessId=0
$foregroundThreadId=[Phase21ClipboardDiagnostics]::GetWindowThreadProcessId($foregroundWindow,[ref]$foregroundProcessId)
[pscustomobject]@{
 openWindow=$openWindow.ToInt64();openThreadId=$openThreadId;openProcess=(ProcessMetadata $openProcessId)
 ownerWindow=$ownerWindow.ToInt64();ownerThreadId=$ownerThreadId;ownerProcess=(ProcessMetadata $ownerProcessId)
 openClipboardSucceeded=$opened;openClipboardLastError=$(if ($opened) {$null} else {$openError});closeClipboardSucceeded=$closed;closeClipboardLastError=$closeError
 sequenceBefore=$sequenceBefore;sequenceAfter=[Phase21ClipboardDiagnostics]::GetClipboardSequenceNumber()
 app=(ProcessMetadata $appProcess.Id);appWindowThreadId=$appWindowThreadId
 appDesktop=$(if ($appWindowThreadId -ne 0) {[Phase21ClipboardDiagnostics]::ObjectName([Phase21ClipboardDiagnostics]::GetThreadDesktop($appWindowThreadId))} else {$null})
 helper=(ProcessMetadata $PID);helperWindowStation=[Phase21ClipboardDiagnostics]::ObjectName([Phase21ClipboardDiagnostics]::GetProcessWindowStation())
 helperDesktop=[Phase21ClipboardDiagnostics]::ObjectName($helperDesktop)
 helperDesktopReceivesInput=$(if ($inputFlagRead) {$helperInput -ne 0} else {$null});helperDesktopInputFlagRead=$inputFlagRead;helperDesktopInputFlagLastError=$(if ($inputFlagRead) {$null} else {$inputFlagError})
 inputDesktopOpened=($inputDesktop -ne [IntPtr]::Zero);inputDesktopName=$inputDesktopName;inputDesktopLastError=$(if ($inputDesktop -ne [IntPtr]::Zero) {$null} else {$inputDesktopError});inputDesktopClosed=$inputDesktopClosed;inputDesktopCloseError=$inputDesktopCloseError
 foregroundWindow=$foregroundWindow.ToInt64();foregroundThreadId=$foregroundThreadId;foregroundProcess=(ProcessMetadata $foregroundProcessId)
} | ConvertTo-Json -Depth 6 -Compress`;
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: { ...process.env, DATA_VIEWER_PHASE21_PROBE_PID: String(inspectedProcessId) } });
      diagnostic.osProbes.push({ stage, observedAt: new Date().toISOString(), ...JSON.parse(stdout) });
    } catch (error) { diagnostic.osProbes.push({ stage, probeError: errorInfo(error), stderr: error.stderr }); }
  }
  try {
    if (osOnly) {
      diagnostic.inspectedProcess = 'diagnostic-node-process; no Viewer launched';
      await probeOs('os-only-readonly-input-desktop');
      diagnostic.status = diagnostic.osProbes.some(probe => probe.probeError) ? 'FAIL' : 'DIAGNOSTIC_COMPLETE';
    } else {
    diagnostic.binarySha256 = await digest(binary);
    await launch();
    savedSettings = await invoke('get_settings');
    await page.bringToFront();
    savedText = await page.evaluate(() => navigator.clipboard.readText());
    textCaptured = true;
    diagnostic.originalTextCaptured = true;
    await probeOs('before-plugin-write');
    const plugin = { name: 'plugin-clipboard-manager-async-ipc', command: 'plugin:clipboard-manager|write_text', signature: '{text,label:null}' };
    diagnostic.paths.push(plugin);
    const pluginStarted = Date.now();
    try {
      await invoke('plugin:clipboard-manager|write_text', { text: savedText, label: null });
      assert.ok(await page.evaluate(text => navigator.clipboard.readText().then(actual => actual === text), savedText), 'Plugin write did not preserve the original text (contents omitted)');
      plugin.status = 'PASS';
    } catch (error) { plugin.status = 'FAIL'; plugin.rawError = errorInfo(error); }
    plugin.elapsedMs = Date.now() - pluginStarted;
    await probeOs('after-plugin-write');
    const background = { name: 'column-values-copy-worker' };
    diagnostic.paths.push(background);
    const copyStarted = Date.now();
    try {
      const source = await open(fixture);
      operation = await values(source, 'value');
      assert.equal(operation.status.totalCount, 237);
      const started = await invoke('start_column_values_copy', { request: { documentId: source.documentId, sessionId: source.sessionId, operationId: operation.request.operationId, search: null, order: 'countDescending', includeCounts: true } });
      const copyIdentity = { documentId: started.documentId, sessionId: started.sessionId, operationId: started.operationId };
      background.terminalStatus = await poll(() => invoke('get_copy_status', { request: copyIdentity }), value => ['complete', 'failed', 'cancelled'].includes(value.state), 30000);
      await probeOs('immediately-after-worker-terminal');
      assert.equal(background.terminalStatus.state, 'complete', JSON.stringify(background.terminalStatus));
      const expected = JSON.parse(await fs.readFile(path.join(root, 'fixtures/phase-21/golden.json'), 'utf8')).source.valuesCountsTsv;
      const matches = await page.evaluate(expected => navigator.clipboard.readText().then(actual => actual === expected), expected);
      assert.ok(matches, 'Worker clipboard payload differs from fixture TSV (contents omitted)');
      background.payloadMatchesFixture = true;
      background.status = 'PASS';
    } catch (error) { background.status = 'FAIL'; background.rawError = errorInfo(error); if (!background.terminalStatus) await probeOs('worker-command-error'); }
    background.elapsedMs = Date.now() - copyStarted;
    diagnostic.status = diagnostic.paths.every(test => test.status === 'PASS') ? 'PASS' : 'FAIL';
    }
  } catch (error) { diagnostic.status = 'FAIL'; diagnostic.rawError = errorInfo(error); }
  finally {
    if (operation) await invoke('release_column_values', operation.request).catch(error => { diagnostic.releaseError = errorInfo(error); diagnostic.status = 'FAIL'; });
    if (page && !page.isClosed()) {
      await closeDocuments().catch(error => { diagnostic.closeError = errorInfo(error); diagnostic.status = 'FAIL'; });
      if (savedSettings) {
        try {
          const current = await invoke('get_settings');
          if (JSON.stringify(current) !== JSON.stringify(savedSettings)) await invoke('update_settings', { settings: savedSettings });
          assert.deepEqual(await invoke('get_settings'), savedSettings);
          diagnostic.settingsPreserved = true;
        } catch (error) { diagnostic.settingsRestoreError = errorInfo(error); diagnostic.status = 'FAIL'; }
      }
      if (textCaptured) {
        try {
          await page.bringToFront();
          await page.evaluate(text => navigator.clipboard.writeText(text), savedText);
          assert.ok(await page.evaluate(text => navigator.clipboard.readText().then(actual => actual === text), savedText), 'Original clipboard text restoration failed (contents omitted)');
          diagnostic.originalTextRestored = true;
        } catch (error) { diagnostic.clipboardRestoreError = errorInfo(error); diagnostic.status = 'FAIL'; }
      }
    }
    await stop().catch(error => { diagnostic.stopError = errorInfo(error); diagnostic.status = 'FAIL'; });
    diagnostic.finishedAt = new Date().toISOString();
    await writeJson(destination, diagnostic);
    console.log(JSON.stringify({ mode: diagnostic.mode, status: diagnostic.status, output: destination, paths: diagnostic.paths, osProbes: diagnostic.osProbes }));
  }
  return ['PASS', 'DIAGNOSTIC_COMPLETE'].includes(diagnostic.status) ? 0 : 1;
}
async function categoryRegressionOnly() {
  const oneGiB = process.argv.includes('--category-1g');
  const cursorRegression = process.argv.includes('--cursor-regression');
  const copyOnly = process.argv.includes('--cursor-copy-only');
  const diagnostic = { status: 'RUNNING', mode: copyOnly ? 'cursor-copy-only' : 'category-only', selectedControls: copyOnly ? ['searched-cursor-pages-and-native-copy'] : null, skippedControls: copyOnly ? [{ name: 'small-fixture-and-native-ui', status: 'NOT_RUN', reason: 'Failed clipboard scope only; prior full regression evidence retained' }] : [], startedAt: new Date().toISOString(), binary, identifier, source: largeFixture, columnId: 'category', scenario: oneGiB ? '1GiB-with-distinct-pages-open' : 'original-settings-single-document', cursorRegression, settingsChanged: false, clipboardAccessed: false, chooserOpened: false, runs: [], samples: [] };
  const file = path.join(output, copyOnly ? 'cursor-copy-1g.json' : cursorRegression ? 'cursor-regression-1g.json' : oneGiB ? 'category-regression-1g.json' : 'category-regression.json');
  const rawError = error => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
  const startedAt = Date.now();
  let timer, sampling = false, samplePromise, queryTempRoot, settingsBefore, cursorClipboard, cursorClipboardCaptured = false;
  let stage = 'launch';
  const sourceBefore = await fs.stat(largeFixture);
  const sample = async () => {
    if (sampling || !app || app.exitCode !== null) return;
    sampling = true;
    try {
      const entry = { elapsedMs: Date.now() - startedAt, stage };
      const results = await Promise.allSettled([measureAppRss(), invoke('get_query_temp_usage'), scanOwnTemp()]);
      for (const [index, key] of ['appRssBytes', 'usage', 'disk'].entries()) entry[key] = results[index].status === 'fulfilled' ? results[index].value : { rawError: rawError(results[index].reason) };
      diagnostic.samples.push(entry);
    } finally { sampling = false; }
  };
  async function scanOwnTemp() {
    if (!queryTempRoot) return null;
    const measured = { root: queryTempRoot, logicalBytes: 0, duckDbSpillBytes: 0, fileCount: 0, files: [] };
    async function visit(folder) {
      let entries;
      try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (measured.fileCount >= 10000) { measured.truncated = true; return; }
        const target = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(target);
        else if (entry.isFile()) {
          let stat;
          try { stat = await fs.stat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          measured.fileCount++;
          measured.logicalBytes += stat.size;
          if (/duckdb_temp|\.tmp$/i.test(entry.name)) measured.duckDbSpillBytes += stat.size;
          if (measured.files.length < 200) measured.files.push({ path: path.relative(queryTempRoot, target), bytes: stat.size });
        }
      }
    }
    let roots;
    try { roots = await fs.readdir(queryTempRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return measured; throw error; }
    for (const entry of roots) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(`${app.pid}-`)) await visit(path.join(queryTempRoot, entry.name));
    return measured;
  }
  async function cursorChecks(request, total, { small = false } = {}) {
    const controls = [];
    const smallGolden = small ? JSON.parse(await fs.readFile(path.join(root, 'fixtures/phase-21/golden.json'), 'utf8')).source.valuesCountDescending : null;
    const target = { documentId: request.documentId, sessionId: request.sessionId, operationId: request.operationId };
    const check = async (name, work) => {
      if (copyOnly && name !== 'searched-cursor-pages-and-native-copy') {
        const control = { name, status: 'NOT_RUN', reason: 'Clipboard failure scope only' };
        controls.push(control);
        return control;
      }
      stage = `cursor:${small ? 'small' : 'category'}:${name}`;
      const control = { name };
      controls.push(control);
      const tick = Date.now();
      try { control.details = await work(); control.status = 'PASS'; }
      catch (error) { control.status = 'FAIL'; control.rawError = rawError(error); }
      finally { control.elapsedMs = Date.now() - tick; }
      return control;
    };
    const token = value => {
      assert.ok(value === null || (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128 && !value.includes('\0')));
    };
    const read = async (order, offset, limit, cursor = null, search = null) => {
      const value = await invoke('read_column_values_page', { request: { ...target, order, offset, limit, cursor, search } });
      assert.equal(value.totalCount, total);
      assert.ok(Number.isSafeInteger(value.matchedCount) && value.matchedCount <= total);
      assert.equal(Object.hasOwn(value, 'nextCursor'), true);
      assert.equal(Object.hasOwn(value, 'previousCursor'), true);
      token(value.nextCursor); token(value.previousCursor);
      assert.ok(value.values.length <= limit);
      assert.equal(value.hasMore, offset + value.values.length < value.matchedCount);
      if (offset === 0) assert.equal(value.previousCursor, null);
      if (!value.hasMore) assert.equal(value.nextCursor, null);
      if (value.hasMore) assert.equal(typeof value.nextCursor, 'string');
      if (offset > 0 && value.values.length) assert.equal(typeof value.previousCursor, 'string');
      if (!small) assert.ok(value.values.every(item => item.count === 1 && !item.isNull && !item.isEmpty && !item.isInvalid && /^category-[0-9a-f]+$/.test(item.value)));
      return value;
    };
    const disjoint = (left, right) => assert.equal(new Set([...left.values, ...right.values].map(value => JSON.stringify([value.value, value.isNull, value.isEmpty, value.isInvalid]))).size, left.values.length + right.values.length);
    const window = async (order, offset, limit, direction = 'next') => {
      const first = await read(order, offset, limit);
      assert.equal(first.values.length, Math.min(limit, total - offset));
      const nextOffset = direction === 'next' ? offset + limit : offset - limit;
      const nextToken = direction === 'next' ? first.nextCursor : first.previousCursor;
      assert.equal(typeof nextToken, 'string');
      const adjacent = await read(order, nextOffset, limit, nextToken);
      disjoint(first, adjacent);
      const backToken = direction === 'next' ? adjacent.previousCursor : adjacent.nextCursor;
      assert.equal(typeof backToken, 'string');
      const roundTrip = await read(order, offset, limit, backToken);
      assert.deepEqual(roundTrip.values, first.values);
      let tail, tailPrevious;
      if (small) {
        tail = await read(order, 200, limit, adjacent.nextCursor);
        assert.equal(tail.values.length, 37);
        disjoint(adjacent, tail);
        tailPrevious = await read(order, 100, limit, tail.previousCursor);
        assert.deepEqual(tailPrevious.values, adjacent.values);
        const expected = [...smallGolden].sort((a, b) => {
          const lexical = a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
          if (order === 'countDescending') return b[1] - a[1] || lexical;
          if (order === 'countAscending') return a[1] - b[1] || lexical;
          return lexical * (order === 'valueDescending' ? -1 : 1);
        });
        assert.deepEqual([...first.values, ...adjacent.values, ...tail.values].map(value => [value.value, value.count]), expected);
      }
      return { order, offset, limit, first, adjacentOffset: nextOffset, adjacent, roundTrip, tail, tailPrevious };
    };
    const orders = small ? ['valueAscending', 'valueDescending', 'countAscending', 'countDescending'] : ['countDescending'];
    for (const order of orders) await check(`first-next-previous-${order}`, () => window(order, 0, 100));
    if (!small) {
      await check('middle-next-previous', () => window('countDescending', Math.floor(total / 2), 100));
      await check('tail-previous-next', () => window('countDescending', total - 200, 200, 'previous'));
      await check('legacy-valueAscending-tail', async () => ({ page: await read('valueAscending', total - 200, 200) }));
    }
    await check('cursor-binding-and-invalid-input', async () => {
      const first = await read('countDescending', 0, 100);
      assert.equal(typeof first.nextCursor, 'string');
      const valid = { ...target, search: null, order: 'countDescending', offset: 100, limit: 100, cursor: first.nextCursor };
      const rejected = [];
      for (const [name, changed] of [
        ['order', { order: 'valueDescending' }], ['search', { search: 'category-000' }],
        ['offset', { offset: 101 }], ['page-size', { limit: 200 }],
        ['nul', { cursor: 'invalid\0cursor' }], ['utf8-over-128', { cursor: '🙂'.repeat(33) }],
        ['unknown', { cursor: 'unknown-cursor' }],
      ]) {
        const rejectedValue = await invoke('read_column_values_page', { request: { ...valid, ...changed } }).then(value => ({ value }), error => ({ error }));
        assert.ok(rejectedValue.error && typeof rejectedValue.error.code === 'string', `Expected typed rejection for ${name}: ${JSON.stringify(rejectedValue)}`);
        rejected.push({ name, rawError: rejectedValue.error });
      }
      assert.deepEqual((await read('countDescending', 100, 100, first.nextCursor)).values, (await read('countDescending', 100, 100)).values);
      return { rejected, validTokenStillWorks: true };
    });
    if (!small) await check('seek-copy-cancel-after-first-batch', async () => {
      const search = 'category-0', order = 'valueAscending';
      const matching = await read(order, 0, 1, null, search);
      assert.ok(matching.matchedCount > 10000, 'Use enough matching rows to observe a real seek-copy batch');
      assert.ok(matching.matchedCount <= settingsBefore.copyLimits.maxCells);
      const upperBoundBytes = matching.matchedCount * 64 + 16;
      assert.ok(upperBoundBytes <= settingsBefore.copyLimits.maxBytes, 'Cancellation fixture must fit the existing byte cap');
      await page.bringToFront();
      const before = await page.evaluate(() => navigator.clipboard.readText());
      let copyIdentity;
      try {
        const started = await invoke('start_column_values_copy', { request: { ...target, search, order, includeCounts: false } });
        copyIdentity = { documentId: started.documentId, sessionId: started.sessionId, operationId: started.operationId };
        const inProgress = await poll(() => invoke('get_copy_status', { request: copyIdentity }), value => ['complete', 'failed', 'cancelled'].includes(value.state) || (value.state === 'running' && value.progress.rowsProcessed > 0), 90000);
        assert.equal(inProgress.state, 'running', `Actual seek copy must still be running after a batch: ${JSON.stringify(inProgress)}`);
        assert.ok(inProgress.progress.rowsProcessed > 0);
        assert.equal(inProgress.progress.totalRows, matching.matchedCount);
        const cancellationStarted = Date.now();
        const cancellation = await invoke('cancel_copy', { request: copyIdentity });
        const terminal = await poll(() => invoke('get_copy_status', { request: copyIdentity }), value => ['complete', 'failed', 'cancelled'].includes(value.state), 30000);
        assert.equal(terminal.state, 'cancelled', JSON.stringify(terminal));
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), before, 'Cancelled seek copy must not publish any clipboard content');
        await pause(500);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), before, 'No late clipboard commit may follow seek-copy cancellation');
        return { search, order, matchedCount: matching.matchedCount, upperBoundBytes, started, inProgress, cancellation, terminal, cancellationMs: Date.now() - cancellationStarted, rowsProcessedBeforeCancel: inProgress.progress.rowsProcessed, clipboardUnchanged: true, lateCommitObservationMs: 500, clipboardBeforeSha256: createHash('sha256').update(before).digest('hex') };
      } finally {
        if (copyIdentity) {
          const current = await invoke('get_copy_status', { request: copyIdentity });
          if (!['complete', 'failed', 'cancelled'].includes(current.state)) {
            await invoke('cancel_copy', { request: copyIdentity });
            await poll(() => invoke('get_copy_status', { request: copyIdentity }), value => ['complete', 'failed', 'cancelled'].includes(value.state), 30000);
          }
        }
      }
    });
    if (!small) await check('searched-cursor-pages-and-native-copy', async () => {
      const search = 'category-000', order = 'valueAscending', limit = 200;
      let offset = 0, cursor = null, matched;
      const reference = [], pages = [];
      do {
        const value = await read(order, offset, limit, cursor, search);
        matched ??= value.matchedCount;
        assert.equal(value.matchedCount, matched);
        assert.ok(matched > 0 && matched <= 10000, 'Keep search reference and copy bounded');
        reference.push(...value.values);
        assert.ok(reference.length <= 10000);
        pages.push({ offset, rows: value.values.length, nextCursor: value.nextCursor, previousCursor: value.previousCursor });
        if (!value.hasMore) break;
        assert.ok(value.values.length > 0);
        offset += value.values.length;
        cursor = value.nextCursor;
      } while (true);
      assert.equal(reference.length, matched);
      assert.equal(new Set(reference.map(value => value.value)).size, matched);
      assert.deepEqual(reference.map(value => value.value), reference.map(value => value.value).sort());
      assert.ok(reference.every(value => value.value.includes(search)));
      const quote = value => /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
      const expected = ['Value\tCount', ...reference.map(value => `${quote(value.value)}\t1`)].join('\r\n');
      assert.ok(reference.length * 2 <= settingsBefore.copyLimits.maxCells);
      assert.ok(Buffer.byteLength(expected) <= settingsBefore.copyLimits.maxBytes);
      await page.bringToFront();
      const copyStart = await invoke('start_column_values_copy', { request: { ...target, search, order, includeCounts: true } });
      const copyStatus = await poll(() => invoke('get_copy_status', { request: { documentId: copyStart.documentId, sessionId: copyStart.sessionId, operationId: copyStart.operationId } }), value => ['complete', 'failed', 'cancelled'].includes(value.state));
      assert.equal(copyStatus.state, 'complete', JSON.stringify(copyStatus));
      const actual = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(actual, expected);
      return { search, order, matchedCount: matched, reference, pages, copyStatus, clipboardBytes: Buffer.byteLength(actual), clipboardSha256: createHash('sha256').update(actual).digest('hex') };
    });
    const executed = controls.filter(control => control.status !== 'NOT_RUN');
    return { status: executed.length > 0 && executed.every(control => control.status === 'PASS') ? 'PASS' : 'FAIL', controls };
  }
  try {
    if (cursorRegression) assert.equal(oneGiB, true, 'Cursor regression requires --category-only --category-1g');
    if (copyOnly) assert.equal(cursorRegression, true, 'Copy-only regression requires --cursor-regression');
    diagnostic.binarySha256 = await digest(binary);
    await launch();
    diagnostic.launchElapsedMs = Date.now() - startedAt;
    diagnostic.health = result.health;
    diagnostic.pid = app.pid;
    settingsBefore = await invoke('get_settings');
    diagnostic.settings = settingsBefore;
    if (cursorRegression) {
      await page.bringToFront();
      cursorClipboard = await page.evaluate(() => navigator.clipboard.readText());
      cursorClipboardCaptured = true;
      diagnostic.clipboardAccessed = true;
    }
    await page.getByRole('button', { name: 'Close distinct-pages.csv', exact: true }).waitFor({ timeout: 30000 });
    if (oneGiB) {
      diagnostic.testSettings = await invoke('update_settings', { settings: { ...settingsBefore, queryTempLimitBytes: 1024 ** 3 } });
      assert.equal(diagnostic.testSettings.queryTempLimitBytes, 1024 ** 3);
      diagnostic.temporarySettingsChanged = true;
    } else {
      const setupCloseStarted = Date.now();
      await closeDocuments();
      diagnostic.setupCloseElapsedMs = Date.now() - setupCloseStarted;
    }
    const localData = await invoke('plugin:path|resolve_directory', { directory: 15 });
    assert.equal(path.basename(path.normalize(localData)), identifier, 'Only inspect this acceptance app\'s temporary directory');
    queryTempRoot = path.join(localData, 'query-temp');
    timer = setInterval(() => { if (!sampling) samplePromise = sample(); }, 1000);
    await sample();
    if (cursorRegression && !copyOnly) {
      let smallOperation;
      try {
        const small = await open(fixture);
        smallOperation = await values(small, 'value');
        diagnostic.smallCursor = await cursorChecks(smallOperation.request, 237, { small: true });
      } catch (error) { diagnostic.smallCursor = { status: 'FAIL', rawError: rawError(error) }; }
      finally { if (smallOperation) await invoke('release_column_values', smallOperation.request).catch(error => { diagnostic.smallCursor.releaseError = rawError(error); diagnostic.smallCursor.status = 'FAIL'; }); }
      const uiStarted = Date.now();
      const ui = { status: 'RUNNING', columnId: 'value', expectedDistinct: 237 };
      diagnostic.nativeCursorUi = ui;
      const dialog = page.getByRole('dialog', { name: 'Column values: value', exact: true });
      try {
        stage = 'cursor:native-ui-small';
        await page.getByRole('button', { name: 'Column values value', exact: true }).click();
        await dialog.getByText('237 distinct values', { exact: true }).waitFor({ timeout: 30000 });
        const navigation = dialog.getByRole('navigation', { name: 'Distinct values pages' });
        const settled = async range => poll(async () => ({ range: await navigation.textContent(), rows: await dialog.locator('tbody tr').count(), busy: await dialog.locator('.column-values-table').getAttribute('aria-busy') }), value => value.range.includes(range) && value.rows === 100 && value.busy === 'false', 30000);
        ui.firstState = await settled('1–100 of 237');
        ui.firstRows = await dialog.locator('tbody tr').allTextContents();
        const next = navigation.getByRole('button', { name: 'Next', exact: true });
        assert.equal(await next.isEnabled(), true);
        await next.click();
        ui.middleState = await settled('101–200 of 237');
        ui.middleRows = await dialog.locator('tbody tr').allTextContents();
        assert.notDeepEqual(ui.middleRows, ui.firstRows);
        const previous = navigation.getByRole('button', { name: 'Previous', exact: true });
        assert.equal(await previous.isEnabled(), true);
        await previous.click();
        ui.returnedState = await settled('1–100 of 237');
        assert.deepEqual(await dialog.locator('tbody tr').allTextContents(), ui.firstRows);
        assert.equal(await previous.isEnabled(), false);
        ui.screenshot = path.join(output, 'native-cursor-panel.png');
        await page.screenshot({ path: ui.screenshot });
        ui.status = 'PASS';
      } catch (error) { ui.status = 'FAIL'; ui.rawError = rawError(error); }
      finally {
        const close = dialog.getByRole('button', { name: 'Close column values', exact: true });
        if (await close.count()) await close.click().catch(error => { ui.status = 'FAIL'; ui.closeError = rawError(error); });
        ui.elapsedMs = Date.now() - uiStarted;
      }
    }
    for (const label of cursorRegression ? ['cursor-snapshot'] : ['cold-first-snapshot', 'warm-repeat-snapshot']) {
      const run = { label, stages: [], elapsed: {} };
      diagnostic.runs.push(run);
      let request, identity;
      const runStarted = Date.now();
      try {
        stage = `${label}:open`;
        if (oneGiB) {
          run.concurrentStartupDocumentVisible = await page.getByRole('button', { name: 'Close distinct-pages.csv', exact: true }).isVisible();
          assert.equal(run.concurrentStartupDocumentVisible, true, 'Keep the small startup CSV open throughout both large-file runs');
        }
        let tick = Date.now();
        const opened = await invoke('open_data_paths', { request: { requestId: `p21-category-${++sequence}`, origin: 'startupArg', paths: [largeFixture] } });
        run.openResponse = opened;
        assert.equal(opened.failures.length, 0, JSON.stringify(opened.failures));
        const { documentId, sessionId } = opened.opened[0];
        identity = { documentId, sessionId };
        documents.set(documentId, identity);
        run.elapsed.openMs = Date.now() - tick;
        stage = `${label}:prepare`;
        tick = Date.now();
        run.preparation = await poll(() => invoke('get_csv_preparation_status', identity), value => ['ready', 'failed', 'cancelled'].includes(value?.state), 300000);
        run.elapsed.prepareWaitMs = Date.now() - tick;
        run.observedPreparedCache = run.preparation.sourceReadBytes === 0 ? 'warm-hit' : 'cold-read';
        assert.equal(run.preparation.state, 'ready', JSON.stringify(run.preparation));
        request = { ...identity, operationId: `p21-category-values-${++sequence}`, columnId: 'category', queryId: null };
        stage = `${label}:distinct`;
        tick = Date.now();
        run.startStatus = await invoke('start_column_values', { request });
        run.terminalStatus = await poll(async () => {
          const value = await invoke('get_column_values_status', request);
          const key = `${value.state}/${value.stage}/${value.totalCount}`;
          if (run.stages.at(-1)?.key !== key) run.stages.push({ key, elapsedMs: Date.now() - tick, rawStatus: value });
          return value;
        }, value => ['ready', 'failed', 'cancelled'].includes(value.state), 300000);
        run.elapsed.distinctMs = Date.now() - tick;
        assert.equal(run.terminalStatus.state, 'ready', JSON.stringify(run.terminalStatus));
        assert.equal(run.terminalStatus.totalCount, 5850000);
        if (cursorRegression) {
          run.cursor = await cursorChecks(request, run.terminalStatus.totalCount);
          run.status = run.cursor.status;
        } else {
        const pageRequest = { ...identity, operationId: request.operationId, search: null, limit: 200 };
        run.pageAttempts = [];
        for (const attempt of [
          { key: 'defaultFirstPage', order: 'countDescending', offset: 0, hasMore: true },
          { key: 'firstPage', order: 'valueAscending', offset: 0, hasMore: true },
          { key: 'lastPage', order: 'valueAscending', offset: run.terminalStatus.totalCount - 200, hasMore: false },
        ]) {
          stage = `${label}:${attempt.key}`;
          const pageStarted = Date.now();
          const observation = { ...attempt };
          run.pageAttempts.push(observation);
          try {
            const value = await invoke('read_column_values_page', { request: { ...pageRequest, order: attempt.order, offset: attempt.offset } });
            run[attempt.key] = value;
            assert.equal(value.totalCount, 5850000);
            assert.equal(value.values.length, 200);
            assert.ok(value.values.every(item => item.count === 1 && !item.isNull && !item.isEmpty && !item.isInvalid));
            assert.deepEqual(value.values.map(item => item.value), value.values.map(item => item.value).sort());
            assert.equal(value.hasMore, attempt.hasMore);
            observation.status = 'PASS';
          } catch (error) { observation.status = 'FAIL'; observation.rawError = rawError(error); }
          finally {
            observation.elapsedMs = Date.now() - pageStarted;
            run.elapsed[`${attempt.key}Ms`] = observation.elapsedMs;
          }
        }
        run.status = run.pageAttempts.every(attempt => attempt.status === 'PASS') ? 'PASS' : 'FAIL';
        }
      } catch (error) { run.status = 'FAIL'; run.rawError = rawError(error); }
      finally {
        stage = `${label}:release`;
        if (request) await invoke('release_column_values', request).catch(error => { run.releaseError = rawError(error); });
        if (cursorRegression && !copyOnly && request && run.terminalStatus?.state === 'ready' && !run.releaseError) {
          const cursor = run.cursor?.controls[0]?.details?.first?.nextCursor ?? null;
          const late = await invoke('read_column_values_page', { request: { documentId: request.documentId, sessionId: request.sessionId, operationId: request.operationId, order: 'countDescending', search: null, offset: 100, limit: 100, cursor } }).then(value => ({ value }), error => ({ error }));
          run.latePageAfterRelease = { status: late.error && typeof late.error.code === 'string' ? 'PASS' : 'FAIL', ...late };
          if (run.latePageAfterRelease.status !== 'PASS') run.status = 'FAIL';
        }
        if (oneGiB) {
          if (identity) {
            await invoke('close_document', identity).catch(error => { run.closeError = rawError(error); });
            documents.delete(identity.documentId);
          }
        } else await closeDocuments().catch(error => { run.closeError = rawError(error); });
        run.elapsed.totalMs = Date.now() - runStarted;
        await sample();
        await writeJson(file, diagnostic);
      }
    }
    diagnostic.settingsAfterRuns = await invoke('get_settings');
    if (oneGiB) assert.deepEqual(diagnostic.settingsAfterRuns, { ...settingsBefore, queryTempLimitBytes: 1024 ** 3 });
    else {
      diagnostic.settingsAfter = diagnostic.settingsAfterRuns;
      diagnostic.settingsChanged = JSON.stringify(diagnostic.settingsAfter) !== JSON.stringify(settingsBefore);
      assert.deepEqual(diagnostic.settingsAfter, settingsBefore);
    }
    const sourceAfter = await fs.stat(largeFixture);
    assert.equal(sourceAfter.size, sourceBefore.size);
    assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs);
    diagnostic.sourceUnchanged = { bytes: sourceBefore.size, mtimeMs: sourceBefore.mtimeMs };
    diagnostic.status = diagnostic.runs.every(run => run.status === 'PASS' && !run.releaseError && !run.closeError) && (!cursorRegression || copyOnly || (diagnostic.smallCursor?.status === 'PASS' && diagnostic.nativeCursorUi?.status === 'PASS')) ? 'PASS' : 'FAIL';
  } catch (error) { diagnostic.status = 'FAIL'; diagnostic.rawError = rawError(error); }
  finally {
    clearInterval(timer);
    await samplePromise;
    if (page && !page.isClosed()) await closeDocuments().catch(error => { diagnostic.closeError = rawError(error); });
    if (oneGiB && settingsBefore && page && !page.isClosed()) {
      try {
        await invoke('update_settings', { settings: settingsBefore });
        diagnostic.settingsAfter = await invoke('get_settings');
        diagnostic.settingsChanged = JSON.stringify(diagnostic.settingsAfter) !== JSON.stringify(settingsBefore);
        assert.deepEqual(diagnostic.settingsAfter, settingsBefore);
        diagnostic.originalSettingsRestored = true;
      } catch (error) { diagnostic.settingsRestoreError = rawError(error); diagnostic.status = 'FAIL'; }
    }
    if (cursorRegression && cursorClipboardCaptured && page && !page.isClosed()) {
      try {
        await page.bringToFront();
        await page.evaluate(text => navigator.clipboard.writeText(text), cursorClipboard);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cursorClipboard);
        diagnostic.clipboardTextRestored = true;
      } catch (error) { diagnostic.clipboardRestoreError = rawError(error); diagnostic.status = 'FAIL'; }
    }
    await stop().catch(error => { diagnostic.stopError = rawError(error); });
    if (diagnostic.closeError || diagnostic.stopError) diagnostic.status = 'FAIL';
    diagnostic.elapsedMs = Date.now() - startedAt;
    diagnostic.finishedAt = new Date().toISOString();
    diagnostic.peakAppRssBytes = Math.max(0, ...diagnostic.samples.map(entry => typeof entry.appRssBytes === 'number' ? entry.appRssBytes : 0));
    diagnostic.peakOwnQueryTempLogicalBytes = Math.max(0, ...diagnostic.samples.map(entry => entry.disk?.logicalBytes ?? 0));
    diagnostic.peakDuckDbSpillBytes = Math.max(0, ...diagnostic.samples.map(entry => entry.disk?.duckDbSpillBytes ?? 0));
    await writeJson(file, diagnostic);
    console.log(JSON.stringify({ mode: copyOnly ? 'cursor-copy-only' : cursorRegression ? 'cursor-regression' : 'category-only', status: diagnostic.status, output: file, elapsedMs: diagnostic.elapsedMs, peakAppRssBytes: diagnostic.peakAppRssBytes, peakDuckDbSpillBytes: diagnostic.peakDuckDbSpillBytes, runs: diagnostic.runs.map(run => ({ label: run.label, status: run.status, elapsed: run.elapsed, terminalStatus: run.terminalStatus, pageAttempts: run.pageAttempts, cursorControls: run.cursor?.controls.map(({ name, status, elapsedMs, rawError }) => ({ name, status, elapsedMs, rawError })), rawError: run.rawError })) }));
  }
  return diagnostic.status === 'PASS' ? 0 : 1;
}
if (process.argv.includes('--clipboard-probe') || process.argv.includes('--clipboard-os-only')) process.exit(await clipboardProbeOnly());
if (process.argv.includes('--category-only')) process.exit(await categoryRegressionOnly());
try {
  result.sha256 = await digest(binary);
  await launch();
  originalSettings = await invoke('get_settings');
  result.originalSettings = originalSettings;
  const usage = await invoke('get_query_temp_usage');
  assert.ok(usage.csvCachePath.includes(identifier), 'Refuse nonisolated cache root');
  result.originalUsage = usage;
  if (migrationOnly) {
    result.mode = 'migration-only';
    assert.ok(path.toNamespacedPath(path.resolve(usage.csvCachePath)).slice(4).toUpperCase().startsWith('C:\\'), 'Dedicated run must begin on C:');
    await page.getByRole('button', { name: 'Close distinct-pages.csv', exact: true }).waitFor({ timeout: 30000 });
    await open(fixture);
    const large = await open(largeFixture);
    await closeDocuments();
    const seededUsage = await invoke('get_query_temp_usage');
    assert.ok(seededUsage.csvCacheEntries >= 2 && seededUsage.csvCacheBytes > 64 * 1024 ** 2, JSON.stringify(seededUsage));
    result.seed = { largePreparation: large.preparation, usage: seededUsage, sourceInventory: await cacheInventory(seededUsage.csvCachePath) };
  } else {
    try { originalClipboard = await page.evaluate(() => navigator.clipboard.readText()); clipboardCaptured = true; } catch (error) { result.clipboardReadError = String(error); }
    try { await validate(); } catch (error) { result.initialValidationError = String(error.stack || error); }
  }
  await checkpoint(result.initialValidationError ? 'validation-failed' : 'ready-for-picker');
  let lastId;
  try { lastId = JSON.parse(await fs.readFile(path.join(scratch, 'control.json'), 'utf8')).id; } catch {}
  const deadline = Date.now() + 90 * 60 * 1000;
  while (Date.now() < deadline) {
    let message;
    try { message = JSON.parse(await fs.readFile(path.join(scratch, 'control.json'), 'utf8')); } catch { await pause(200); continue; }
    if (!message.id || message.id === lastId) { await pause(200); continue; }
    lastId = message.id;
    await checkpoint('executing', { commandId: message.id, action: message.action });
    try {
      const details = await command(message);
      result.commands.push({ id: message.id, action: message.action, status: 'PASS', ...details });
      await checkpoint('ready', { commandId: message.id, action: message.action, ...details });
      if (message.action === 'finish') break;
    } catch (error) {
      const details = { error: String(error.stack || error) };
      result.commands.push({ id: message.id, action: message.action, status: 'FAIL', ...details });
      await checkpoint('command-failed', { commandId: message.id, action: message.action, ...details });
    }
  }
  result.status = result.initialValidationError || result.commands.some(value => value.status === 'FAIL') ? 'FAIL' : 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = String(error.stack || error);
} finally {
  if (page && !page.isClosed()) {
    await closeDocuments().catch(() => {});
    if (clipboardCaptured) {
      try { await page.evaluate(text => navigator.clipboard.writeText(text), originalClipboard); result.clipboardTextRestored = true; } catch (error) { result.clipboardRestoreError = String(error); }
    }
    if (originalSettings) {
      try { const current = await invoke('get_settings'); await invoke('update_settings', { settings: { ...originalSettings, csvCacheDirectory: current.csvCacheDirectory } }); result.originalSettingsRestoredExceptMigratedDirectory = true; } catch (error) { result.settingsRestoreError = String(error); }
    }
  }
  await stop().catch(error => { result.stopError = String(error); });
  result.finishedAt = new Date().toISOString();
  await checkpoint('stopped', { status: result.status });
}
if (result.status !== 'PASS') process.exitCode = 1;
