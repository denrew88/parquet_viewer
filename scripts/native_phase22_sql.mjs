// Real isolated Tauri/worker acceptance. No browser mock or product cache migration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {chromium} from '@playwright/test';
import {operateOwnedSaveDialog} from './native_owned_save_dialog.mjs';

const exportOnly = process.argv.includes('--export-only');
const root=path.resolve(import.meta.dirname,'..');
const scratch=path.join(root, exportOnly ? '.tmp/phase22-native-export' : '.tmp/phase22-native');
const output=exportOnly ? scratch : path.join(root,'artifacts/phase-22/native');
const candidate = process.argv.includes('--export-candidate') ? 'phase-22-export' : 'phase-22-native';
const binary=path.join(root,'src-tauri/target/release/candidates',candidate,'data-viewer.exe');
const identifier='com.denrew88.data-viewer-phase22-acceptance';
const webviewPort = candidate === 'phase-22-export' ? 9502 : exportOnly ? 9501 : 9499;
const fixture=relative=>path.join(root,'fixtures/phase-22',relative);
const runFile=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={status:'RUNNING',startedAt:new Date().toISOString(),binary,identifier,checks:[]};
let browser,page,owned,settings,clipboard,server,sequence=0,httpRequests=0;
const docs=new Map();
async function checkpoint(){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'sql-runtime.json'),JSON.stringify(report,null,2));}
async function digest(file){return createHash('sha256').update(await fs.readFile(file)).digest('hex');}
async function invoke(command,args={}){const response=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!response.ok)throw response.error;return response.value;}
async function poll(read,done,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const s=await read();if(done(s))return s;await pause(30);}throw Error('Native SQL acceptance timed out');}
async function ps(script,env={}){const {stdout}=await runFile('powershell',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$ErrorActionPreference='Stop'\n"+script],{windowsHide:true,timeout:30000,env:{...process.env,...env}});return stdout.trim();}
async function readClipboard(){return JSON.parse(await ps('Get-Clipboard -Raw | ConvertTo-Json -Compress'));}
async function launch(){
  const result=await ps('$p=Start-Process -FilePath $env:P22_BINARY -ArgumentList (\'"\'+$env:P22_FIXTURE+\'"\') -WorkingDirectory $env:P22_ROOT -WindowStyle Hidden -PassThru\n[pscustomobject]@{pid=$p.Id;path=$p.Path;ticks=$p.StartTime.Ticks.ToString()} | ConvertTo-Json -Compress',{
    P22_BINARY:binary,P22_FIXTURE:fixture('sales/orders.csv'),P22_ROOT:root,
    WEBVIEW2_USER_DATA_FOLDER:path.join(scratch, exportOnly ? `webview-${process.pid}` : 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${webviewPort}`,
  });
  owned=JSON.parse(result);assert.ok(owned.pid>0&&owned.path);
  (report.launches??=[]).push(owned);
  for(let i=0;i<160;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${webviewPort}`);break;}catch{await pause(250);}}
  assert.ok(browser,'Native WebView unavailable');page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'))??browser.contexts()[0].pages()[0];
  await page.waitForFunction(()=>typeof window.__TAURI_INTERNALS__?.invoke==='function');
  assert.equal(await invoke('plugin:app|identifier'),identifier,'Refuse product namespace');
  report.health=await invoke('health_check');assert.equal(report.health.appVersion,'0.22.0');
  await page.getByRole('button',{name:'Close orders.csv',exact:true}).waitFor({timeout:30000});
}
async function stop(){await browser?.close().catch(()=>{});browser=null;if(!owned)return;
 await ps('$p=Get-Process -Id ([int]$env:P22_PID) -ErrorAction SilentlyContinue\nif($p){if(-not [string]::Equals([IO.Path]::GetFullPath($p.Path),[IO.Path]::GetFullPath($env:P22_BINARY),[StringComparison]::OrdinalIgnoreCase)){throw \'Unowned PID path\'}\nif($p.StartTime.Ticks.ToString() -ne $env:P22_TICKS){throw \'Reused PID\'}\nStop-Process -Id $p.Id\nif(-not $p.WaitForExit(3000)){throw \'Owned process did not stop\'}}',{P22_PID:String(owned.pid),P22_BINARY:binary,P22_TICKS:owned.ticks});owned=null;
}
async function open(relative){const file=path.isAbsolute(relative)?relative:fixture(relative);const r=await invoke('open_data_paths',{request:{requestId:'p22-open-'+(++sequence),origin:'startupArg',paths:[file]}});assert.equal(r.failures.length,0,JSON.stringify(r.failures));const identity={documentId:r.opened[0].documentId,sessionId:r.opened[0].sessionId};docs.set(identity.documentId,identity);if(file.toLowerCase().endsWith('.csv')){const s=await poll(()=>invoke('get_csv_preparation_status',identity),s=>['ready','failed'].includes(s?.state),300000);assert.equal(s.state,'ready',JSON.stringify(s));}return identity;}
async function profileOrders(identity){const {profile}=await invoke('get_csv_profile',identity);const applied=await invoke('apply_csv_profile',{request:{...identity,profile:{...profile,mode:'custom',generation:profile.generation+1,columns:profile.columns.map((c,i)=>({...c,targetType:i<2?'int64':i===2?'decimal':i===3?'timestamp':'text',nullTokens:['NULL']}))}}});const next={documentId:applied.documentId,sessionId:applied.sessionId};docs.set(next.documentId,next);const s=await poll(()=>invoke('get_csv_preparation_status',next),s=>['ready','failed'].includes(s?.state),300000);assert.equal(s.state,'ready',JSON.stringify(s));return next;}
async function start(sql,tables,action='execute'){const runId='p22-run-'+(++sequence);try{let status=await invoke('start_sql_query',{request:{runId,sql,action,tables}});status=await poll(()=>invoke('get_sql_query_status',{runId}),s=>['complete','failed','cancelled'].includes(s.state),300000);return status;}catch(error){return{runId,state:'rejected',error};}}
async function rows(status){assert.equal(status.state,'complete',JSON.stringify(status));assert.ok(status.resultId);const columns=status.columns.map(c=>c.id);return invoke('read_sql_query_page',{request:{runId:status.runId,resultId:status.resultId,offset:0,limit:200,columns}});}
async function release(status){if(status.resultId)await invoke('release_sql_result',{runId:status.runId,resultId:status.resultId});}
const values=page=>page.rows.map(row=>row.map(v=>v.state==='null'?null:v.display));
async function check(name,fn){const started=Date.now();try{const details=await fn();report.checks.push({name,status:'PASS',elapsedMs:Date.now()-started,...details});console.log(JSON.stringify({name,status:'PASS'}));}catch(error){report.checks.push({name,status:'FAIL',error:error?.stack??JSON.stringify(error)});console.log(JSON.stringify({name,status:'FAIL',error:error?.message??JSON.stringify(error)}));}await checkpoint();}

async function checkNativeExport() {
  await page.getByRole('button', {name: 'SQL workspace', exact: true}).click();
  const workspace = page.getByRole('region', {name: 'SQL workspace', exact: true});
  await workspace.getByRole('button', {name: 'orders', exact: true}).waitFor();
  const editor = workspace.getByRole('textbox', {name: 'SQL editor', exact: true});
  const results = workspace.getByRole('tabpanel', {name: 'Results', exact: true});
  const grid = results.getByRole('grid', {name: 'Data preview'});
  const first = grid.locator('[data-grid-row="0"][data-grid-column="0"]');

  await check('actual-having-completion-and-cursor-statement', async () => {
    await workspace.getByRole('radio', {name: /^c-numbers only/}).check();
    const having = 'SELECT c1 FROM orders GROUP BY c1 HAVING';
    await editor.fill(having);
    await page.keyboard.type(' c');
    const popup = page.locator('.cm-tooltip-autocomplete');
    await popup.getByText('c1', {exact: true}).waitFor();
    await editor.press('Enter');
    assert.equal(await editor.innerText(), `${having} c1`);
    const aggregate = 'SELECT c.c1, count(*) AS cnt FROM orders c GROUP BY c.c1 HAVING';
    await editor.fill(aggregate);
    await page.keyboard.type(' cn');
    await popup.getByText('cnt', {exact: true}).waitFor();
    await editor.press('Enter');
    assert.equal(await editor.innerText(), `${aggregate} cnt`);
    const script = "SELECT ';' AS ignored;\nSELECT 2 AS chosen;";
    await editor.fill(script);
    await editor.press('Control+End');
    await editor.press('ArrowLeft');
    await editor.press('Control+Enter');
    await first.waitFor({timeout: 120000});
    assert.equal(await first.textContent(), '2');
    assert.equal(await editor.innerText(), script);
    return {cursorResult: 2};
  });

  await check('actual-analyze-timing-and-independent-panes', async () => {
    const query = Array.from({length: 32}, (_, index) => `SELECT ${index} AS n FROM orders`).join('\nUNION ALL\n');
    await editor.fill(query);
    await workspace.getByRole('button', {name: 'Analyze', exact: true}).click();
    const plan = workspace.getByRole('tabpanel', {name: 'Execution plan', exact: true});
    const summary = plan.getByRole('region', {name: 'Operator timing summary', exact: true});
    await summary.waitFor({timeout: 120000});
    const timings = await summary.innerText();
    assert.match(timings, /Slowest operator/);
    assert.match(timings, /ms.*%/);
    const nodes = plan.getByRole('region', {name: 'Execution plan nodes', exact: true});
    const detail = plan.getByRole('region', {name: 'Execution plan detail', exact: true});
    await detail.getByText('Raw execution plan', {exact: true}).click();
    await detail.evaluate((pane) => { pane.scrollTop = 0; });
    const position = (pane) => pane.evaluate((element) => element.scrollTop);
    await nodes.hover();
    await page.mouse.wheel(0, 180);
    const nodesScrolled = await poll(() => position(nodes), (value) => value > 0, 5000);
    assert.equal(await position(detail), 0);
    await detail.hover();
    await page.mouse.wheel(0, 180);
    const detailScrolled = await poll(() => position(detail), (value) => value > 0, 5000);
    assert.equal(await position(nodes), nodesScrolled);
    await page.screenshot({path: path.join(output, 'native-analyze.png')});
    return {timings, nodesScrolled, detailScrolled};
  });

  await editor.fill("SELECT 1 AS id, '서울' AS city UNION ALL SELECT 2, '부산' ORDER BY id;");
  await workspace.getByRole('button', {name: 'Run', exact: true}).click();
  await first.waitFor({timeout: 120000});
  await poll(() => first.textContent(), (value) => value === '1', 30000);
  await first.click();
  await editor.fill('SELECT 999;');
  const exportButton = results.getByRole('button', {name: 'Export results', exact: true});
  const formats = results.getByRole('group', {name: 'Export format', exact: true});

  await check('actual-result-export-clipboard', async () => {
    const expected = 'id\tcity\r\n1\t서울\r\n2\t부산';
    clipboard = await readClipboard();
    // Set a distinct value so a matching clipboard can only be a fresh write.
    await invoke('plugin:clipboard-manager|write_text', {text: 'phase22-export-clipboard-probe'});
    await exportButton.click();
    await page.screenshot({path: path.join(output, 'native-export-menu.png')});
    await formats.getByRole('button', {name: 'Clipboard', exact: true}).click();
    await poll(readClipboard, (text) => text === expected, 15000);
    assert.equal(await first.textContent(), '1');
    return {rows: 2, clipboardSha256: createHash('sha256').update(expected).digest('hex')};
  });

  async function operateDialog(format, destination = '') {
    const title = `Export SQL result as ${format}`;
    await exportButton.click();
    await formats.getByRole('button', {name: format, exact: true}).click();
    return operateOwnedSaveDialog(ps, {pid: owned.pid, title, destination});
  }

  let dialogAccessible = false;
  await check('actual-result-export-save-dialog-cancel', async () => {
    let observed;
    try {
      observed = await operateDialog('CSV');
    } catch (cause) {
      const ui = await results.innerText({timeout: 3000}).catch(() => 'Results panel unavailable.');
      throw new Error(`${cause.stderr ?? cause.message}\nResults panel:\n${ui}`);
    }
    await results.getByText('Export cancelled.', {exact: true}).waitFor();
    assert.equal(await first.textContent(), '1');
    dialogAccessible = true;
    return observed;
  });
  if (!dialogAccessible) return;

  const saveDirectory = await fs.mkdtemp(path.join(scratch, 'save-'));
  for (const [format, separator] of [['CSV', ','], ['TSV', '\t']]) {
    await check(`actual-result-export-save-${format.toLowerCase()}`, async () => {
      const destination = path.join(saveDirectory, `result.${format.toLowerCase()}`);
      await assert.rejects(fs.stat(destination), {code: 'ENOENT'});
      const observed = await operateDialog(format, destination);
      await results.getByText('Result exported.', {exact: true}).waitFor();
      const contents = await fs.readFile(destination);
      const expected = [
        ['id', 'city'].join(separator),
        ['1', '서울'].join(separator),
        ['2', '부산'].join(separator),
        '',
      ].join('\r\n');
      assert.deepEqual(contents, Buffer.from('\uFEFF' + expected, 'utf8'));
      return {...observed, destination, sha256: await digest(destination)};
    });
  }
  await check('actual-result-export-save-parquet', async () => {
    const destination = path.join(saveDirectory, 'result.parquet');
    await assert.rejects(fs.stat(destination), {code: 'ENOENT'});
    const observed = await operateDialog('Parquet', destination);
    await results.getByText('Result exported.', {exact: true}).waitFor();
    const opened = await invoke('open_data_paths', {
      request: {requestId: `p22-open-${++sequence}`, origin: 'startupArg', paths: [destination]},
    });
    assert.equal(opened.failures.length, 0, JSON.stringify(opened.failures));
    const [exported] = opened.opened;
    try {
      const columns = exported.summary.columns.map(({name, logicalType}) => ({name, logicalType}));
      assert.deepEqual(columns.map(({name}) => name), ['id', 'city']);
      assert.match(columns[0].logicalType, /int32|integer/i);
      assert.match(columns[1].logicalType, /string|utf8|varchar/i);
      assert.deepEqual(values(exported.initialPage), [['1', '서울'], ['2', '부산']]);
      return {...observed, destination, columns, sha256: await digest(destination)};
    } finally {
      await invoke('close_document', {documentId: exported.documentId, sessionId: exported.sessionId});
    }
  });
}

try{
 await fs.mkdir(scratch,{recursive:true});report.sha256=await digest(binary);await launch();settings=await invoke('get_settings');report.originalSettings=settings;
 assert.ok((await invoke('get_query_temp_usage')).csvCachePath.includes(identifier),'Refuse non-isolated cache');
 if (exportOnly) {
   await checkNativeExport();
 } else {
 clipboard=await readClipboard();await invoke('update_settings',{settings:{...settings,queryTempLimitBytes:1073741824,csvCacheLimitBytes:536870912}});
 let orders=await open('sales/orders.csv');orders=await profileOrders(orders);const customers=await open('customers.parquet');
 const bindings=[{...orders,alias:'orders',columnMode:'name'},{...customers,alias:'customers',columnMode:'ordinal'}];
 const golden=JSON.parse(await fs.readFile(fixture('golden.json'),'utf8'));
 const sql='SELECT o."주문 번호" AS order_id, c.c2 AS customer_name, o."결제 금액" AS amount, c.c3 AS region FROM orders o LEFT JOIN customers c ON o."고객 번호" = c.c1 ORDER BY order_id, customer_name NULLS LAST';
 await check('mixed-csv-parquet-join-and-cache-budget',async()=>{const s=await start(sql,bindings);try{const result=await rows(s);assert.equal(s.rowCount,8);assert.deepEqual(values(result),golden.leftJoin.rows.map(r=>r.map(v=>v===null?null:String(v))));return{status:s,usage:await invoke('get_query_temp_usage')};}finally{await release(s);}});
 await check('per-table-exclusive-modes-and-raw-duplicates',async()=>{const duplicate=await open('headers/duplicates.csv');const descriptors=await invoke('describe_sql_tables',{sources:[orders,customers,duplicate]});assert.equal(descriptors[0].defaultColumnMode,'name');assert.equal(descriptors[2].nameModeAllowed,false);const bad=await start('SELECT * FROM d',[{...duplicate,alias:'d',columnMode:'name'}]);assert.notEqual(bad.state,'complete');const mismatch=await start('SELECT o.c1 FROM orders o',bindings);assert.notEqual(mismatch.state,'complete');const valid=await start('SELECT o.c1 FROM orders o LIMIT 1',[{...orders,alias:'orders',columnMode:'ordinal'}]);try{assert.equal((await rows(valid)).rows[0][0].display,'101');}finally{await release(valid);}return{descriptors,bad,mismatch};});
 await check('duplicate-result-labels-and-native-tsv-clipboard',async()=>{const s=await start("SELECT 'first' AS same,'second' AS same",bindings);try{const result=await rows(s);assert.deepEqual(s.columns.map(c=>c.name),['same','same']);assert.equal(new Set(s.columns.map(c=>c.id)).size,2);assert.deepEqual(values(result),[['first','second']]);const operationId='p22-copy-'+(++sequence);const request={operationId,documentId:'sql-workspace',sessionId:s.resultId,queryId:s.runId,selection:{rowStart:0,rowEndExclusive:1,columnIds:s.columns.map(c=>c.id)},options:{delimiter:'\t',includeHeaders:true,quoteMode:'minimal',quoteCharacter:'"',escapeMode:'double',lineEnding:'crlf',nullRepresentation:'',emptyStringRepresentation:'empty',booleanRepresentation:'lowercase',dateTimeRepresentation:'display',representation:'rawCanonical'},maxCells:settings.copyLimits.maxCells,maxBytes:settings.copyLimits.maxBytes};await invoke('start_sql_copy',{runId:s.runId,resultId:s.resultId,request});const identity={operationId,documentId:'sql-workspace',sessionId:s.resultId};const copied=await poll(()=>invoke('get_copy_status',{request:identity}),s=>['complete','failed','cancelled'].includes(s.state));assert.equal(copied.state,'complete',JSON.stringify(copied));assert.equal(await readClipboard(),golden.duplicateResultLabels.tsv);return{status:s,copied,clipboardSha256:createHash('sha256').update(golden.duplicateResultLabels.tsv).digest('hex')};}finally{await release(s);}});
 await check('security-real-existing-canary-and-no-http',async()=>{const corpus=JSON.parse(await fs.readFile(fixture('security-cases.json'),'utf8'));const canary=path.join(scratch,'canary.txt'),out=path.join(scratch,'must-not-exist.csv');await fs.writeFile(canary,'PRIVATE-P22-CANARY');const before=await digest(canary);await assert.rejects(fs.stat(out),{code:'ENOENT'});server=http.createServer((request,response)=>{httpRequests++;response.end('forbidden');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port+'/private.csv';const details=[];for(const c of corpus.denied){const source=c.sql.replaceAll('{canary}',canary.replaceAll('\\','/')).replaceAll('{input}',fixture('customers.parquet').replaceAll('\\','/')).replaceAll('{output}',out.replaceAll('\\','/')).replaceAll('{url}',url);const s=await start(source,bindings);assert.notEqual(s.state,'complete',c.id);details.push({id:c.id,state:s.state,error:s.error});}assert.equal(await digest(canary),before);await assert.rejects(fs.stat(out),{code:'ENOENT'});assert.equal(httpRequests,0);await new Promise(resolve=>server.close(resolve));server=null;return{denied:details,canaryUnchanged:true,httpRequests};});
 await check('explain-analyze-plan-and-previous-result',async()=>{const old=await start('SELECT 42 AS answer',bindings);try{await rows(old);for(const action of ['explain','analyze']){const s=await start('SELECT COUNT(*) AS n FROM orders',bindings,action);assert.equal(s.state,'complete',JSON.stringify(s));assert.ok(s.planText||s.planJson);assert.equal(s.resultId,null);}const failed=await start('SELECT missing_column FROM orders',bindings);assert.notEqual(failed.state,'complete');assert.equal((await rows(old)).rows[0][0].display,'42');return{failed,previousReadable:true};}finally{await release(old);}});
 await check('queued-cancel-next-run-and-owned-worker-cleanup',async()=>{const runId='p22-cancel-'+(++sequence);await invoke('start_sql_query',{request:{runId,sql:'SELECT COUNT(*) FROM orders a CROSS JOIN orders b CROSS JOIN orders c CROSS JOIN orders d CROSS JOIN orders e CROSS JOIN orders f',action:'execute',tables:bindings}});await invoke('cancel_sql_query',{runId});const cancelled=await poll(()=>invoke('get_sql_query_status',{runId}),s=>['complete','failed','cancelled'].includes(s.state));assert.equal(cancelled.state,'cancelled',JSON.stringify(cancelled));const next=await start('SELECT COUNT(*) AS n FROM orders',bindings);try{assert.equal((await rows(next)).rows[0][0].display,'6');}finally{await release(next);}return{cancelled};});
 for(const identity of docs.values())await invoke('close_document',identity).catch(()=>{});docs.clear();
 await stop();await launch();
 await check('actual-workspace-ui-through-rust',async()=>{await page.getByRole('button',{name:'SQL workspace',exact:true}).click();const ui=page.getByRole('region',{name:'SQL workspace',exact:true});await ui.getByRole('button',{name:'orders',exact:true}).waitFor();await ui.getByRole('textbox',{name:'SQL editor',exact:true}).fill('SELECT COUNT(*) AS rows FROM orders');await ui.getByRole('button',{name:'Run',exact:true}).click();await ui.getByRole('grid').waitFor({timeout:120000});await page.screenshot({path:path.join(output,'native-sql-workspace.png')});return{actualUi:true};});
 }
 report.status=report.checks.some(c=>c.status==='FAIL')?'FAIL':'PASS';
}catch(error){report.status='FAIL';report.error=error?.stack??JSON.stringify(error);console.error(report.error);}
finally{
 if(server)await new Promise(resolve=>server.close(resolve));
 if(page&&!page.isClosed()){for(const identity of docs.values())await invoke('close_document',identity).catch(()=>{});if(settings&&!exportOnly)try{await invoke('update_settings',{settings});report.settingsRestored=true;}catch(error){report.settingsRestoreError=JSON.stringify(error);}if(clipboard!==undefined)try{await invoke('plugin:clipboard-manager|write_text',{text:clipboard??''});report.clipboardTextRestored=true;}catch(error){report.clipboardRestoreError=JSON.stringify(error);}}
 try{await stop();}catch(error){report.stopError=String(error);report.status='FAIL';}
 report.finishedAt=new Date().toISOString();await checkpoint();
}
if(report.status!=='PASS')process.exitCode=1;
