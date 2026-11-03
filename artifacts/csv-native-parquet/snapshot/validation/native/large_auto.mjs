import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';

const here=import.meta.dirname,root=path.resolve(here,'../../../../..');
const binary=path.resolve(process.argv[2]||path.join(root,'artifacts/experiments/csv-native-parquet/native-validation.exe'));
const identifier=JSON.parse(await fs.readFile(path.join(root,'artifacts/experiments/csv-native-parquet/size-variant/tauri.conf.json'),'utf8')).identifier;
assert.notEqual(identifier,'com.denrew88.data-viewer','Native validation requires a separate app identity');
const original=path.join(root,'artifacts/experiments/csv-engine-compare/fixtures/high-5850000x15.csv');
const source=path.join(here,`fixtures/large-main-${Date.now()}.csv`);
await fs.mkdir(path.dirname(source),{recursive:true});
await fs.link(original,source);
const result={id:'NATIVE-002/006',binary,identifier,source,status:'FAIL',runs:[],started:new Date().toISOString()};
const normalize=s=>s.replace(/[^0-9-]/g,'');
let app,browser,page,originalClipboard,output='';

async function shutdown(){
 await browser?.close().catch(()=>{});browser=undefined;
 if(app&&app.exitCode===null){const exited=new Promise(r=>app.once('exit',r));app.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);}
 app=undefined;page=undefined;
}
async function launch(label,port){
 output='';let launchError;
 app=spawn(binary,['--file',source],{cwd:root,windowsHide:true,env:{...process.env,
  WEBVIEW2_USER_DATA_FOLDER:path.join(here,`ui/large-${label}-webview`),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:['ignore','pipe','pipe']});
 app.on('error',e=>launchError=e);app.stdout.on('data',b=>output+=b);app.stderr.on('data',b=>output+=b);
 for(let i=0;i<240;i++){
  if(launchError)throw launchError;
  if(app.exitCode!==null)throw new Error(`App exited ${app.exitCode}: ${output}`);
  try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{await new Promise(r=>setTimeout(r,250));}
 }
 assert.ok(browser,'CDP unavailable');page=browser.contexts().flatMap(c=>c.pages())[0];assert.ok(page);
 await page.waitForLoadState('domcontentloaded');
 await page.waitForURL(url=>url.protocol==='http:'&&url.hostname==='tauri.localhost',{timeout:30000});
 await page.waitForFunction(()=>typeof window.__TAURI_INTERNALS__?.invoke==='function',{timeout:30000});
 assert.ok(!page.url().startsWith('file:'),`Frontend served as external file URL: ${page.url()}`);
 const cache=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_query_temp_usage'));
 assert.equal(path.basename(path.dirname(cache.csvCachePath)),identifier,'Unexpected shared cache namespace');
 const grid=page.locator('[role="grid"][aria-label="Data preview"]');await grid.waitFor({state:'attached',timeout:30000});
 const target=await grid.evaluate(g=>({documentId:g.dataset.documentId,sessionId:g.dataset.sessionId}));
 return {label,port,url:page.url(),cacheBefore:cache,target};
}
async function waitReady(run){
 const started=Date.now();const samples=[];
 while(Date.now()-started<180000){
  const s=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('get_csv_preparation_status',t),run.target);
  if(samples.length<1000)samples.push(s);
  if(s&&['ready','failed','cancelled'].includes(s.state)){run.preparation=s;break;}
  await new Promise(r=>setTimeout(r,100));
 }
 run.preparationSamples=samples;run.observedWaitMs=Date.now()-started;
 assert.equal(run.preparation?.state,'ready',`CSV preparation failed: ${JSON.stringify(run.preparation)}`);
 await page.getByRole('grid',{name:'Data preview'}).waitFor();
}
async function value(row,column){const c=page.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);await c.waitFor({timeout:30000});return (await c.innerText()).trim();}
async function assertFirst(expected){await page.waitForFunction(expected=>{
 const c=document.querySelector('[data-grid-row="0"][data-grid-column="0"]');return c?.textContent?.replace(/[^0-9-]/g,'')===expected;
 },expected,{timeout:60000});}
async function files(rootDir,depth=0){
 if(depth>7)return[];let entries=[];try{entries=await fs.readdir(rootDir,{withFileTypes:true});}catch{return[];}
 const out=[];for(const e of entries){if(e.isSymbolicLink())continue;const p=path.join(rootDir,e.name);if(e.isDirectory())out.push(...await files(p,depth+1));else out.push(p);}return out;
}

try{
 await fs.mkdir(path.join(here,'ui'),{recursive:true});
 const cold=await launch('cold',9484);result.runs.push(cold);await waitReady(cold);
 assert.ok(cold.preparation.sourceReadBytes>0,'Cold unique source unexpectedly used a warm cache');
 assert.equal(cold.preparation.totalRows,5850000);
 const grid=page.getByRole('grid',{name:'Data preview'});
 assert.equal(await grid.getAttribute('aria-rowcount'),'5850000');
 assert.equal(normalize(await value(0,0)),'0');
 await page.locator('[data-grid-row="0"][data-grid-column="0"]').click();await grid.press('Control+Alt+ArrowDown');
 assert.equal(normalize(await value(5849999,0)),'5849999');
 cold.lastRowGeometry=await page.locator('[data-grid-row="5849999"][data-grid-column="0"]').evaluate(c=>{
  const a=c.getBoundingClientRect(),g=c.closest('[role="grid"]').getBoundingClientRect();return {cellTop:a.top,cellBottom:a.bottom,gridTop:g.top,gridBottom:g.bottom};});
 assert.ok(cold.lastRowGeometry.cellBottom<=cold.lastRowGeometry.gridBottom+1);
 assert.ok(cold.lastRowGeometry.cellTop>=cold.lastRowGeometry.gridTop+36);
 await page.screenshot({path:path.join(here,'ui/large-last-row.png'),fullPage:true});
 await grid.press('Control+Alt+ArrowUp');await assertFirst('0');
 await page.getByRole('tab',{name:'Schema',exact:true}).click();
 assert.equal(await page.getByRole('table',{name:'File schema'}).getByRole('row').count(),16);
 await page.getByRole('tab',{name:'Metadata',exact:true}).click();
 assert.ok((await page.locator('.metadata-content').innerText()).includes('CSV'));
 await page.getByRole('tab',{name:'Data',exact:true}).click();
 const sort=page.getByRole('button',{name:/Sort row_id:/});await sort.click();
 await page.getByRole('button',{name:'Sort row_id: ascending, priority 1'}).waitFor();
 await sort.click();await page.getByRole('button',{name:'Sort row_id: descending, priority 1'}).waitFor();
 await assertFirst('5849999');cold.sort='PASS';
 await page.getByRole('button',{name:'Filter row_id',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Filter row_id',exact:true});
 await dialog.getByLabel('Filter operator').selectOption('greaterThan');
 await dialog.getByRole('textbox',{name:'Value',exact:true}).fill('5849989');
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();await dialog.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.querySelector('[role="grid"][aria-label="Data preview"]')?.getAttribute('aria-rowcount')==='10',undefined,{timeout:60000});
 await assertFirst('5849999');cold.filter='PASS';
 originalClipboard=await page.evaluate(()=>navigator.clipboard.readText()).catch(()=>undefined);
 await page.locator('[data-grid-row="0"][data-grid-column="0"]').click();await grid.press('Shift+ArrowRight');
 const oldCopy=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('get_copy_history',t),cold.target);
 await page.getByRole('button',{name:'Copy selection',exact:true}).click();
 for(let i=0;i<300;i++){
  const h=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('get_copy_history',t),cold.target);
  if(h.current?.state==='complete'&&h.current.operationId!==oldCopy.current?.operationId){cold.copyHistory=h;break;}
  await new Promise(r=>setTimeout(r,100));
 }
 assert.equal(cold.copyHistory?.current?.state,'complete');
 cold.clipboardText=await page.evaluate(()=>navigator.clipboard.readText());
 const copiedRow=cold.clipboardText.trimEnd().split(/\r?\n/).at(-1).split('\t');
 assert.equal(normalize(copiedRow[0]),'5849999');assert.equal(copiedRow.length,2);cold.copy='PASS';
 await page.screenshot({path:path.join(here,'ui/large-query-copy.png'),fullPage:true});
 if(typeof originalClipboard==='string')await page.evaluate(text=>navigator.clipboard.writeText(text),originalClipboard);
 originalClipboard=undefined;
 cold.cacheAfter=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_query_temp_usage'));
 cold.cacheFiles=(await files(cold.cacheAfter.csvCachePath)).filter(p=>p.endsWith('prepared.parquet')||p.endsWith('cache-manifest.json'));
 assert.ok(cold.cacheFiles.some(p=>p.endsWith('prepared.parquet')),'No published cache file');
 await shutdown();
 const warm=await launch('warm',9486);result.runs.push(warm);await waitReady(warm);
 assert.equal(warm.preparation.sourceReadBytes,0,'Warm cache re-read source');
 assert.equal(normalize(await value(0,0)),'0');
 warm.cacheAfter=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_query_temp_usage'));
 await page.screenshot({path:path.join(here,'ui/large-warm.png'),fullPage:true});
 result.status='PASS';
}catch(e){result.error=String(e.stack||e);}
finally{
 result.appOutput=output;
 if(page){
  result.finalBody=await page.locator('body').innerText().catch(e=>String(e));result.finalUrl=page.url();
  await page.screenshot({path:path.join(here,'ui/large-final.png'),fullPage:true}).catch(()=>{});
  if(typeof originalClipboard==='string')await page.evaluate(text=>navigator.clipboard.writeText(text),originalClipboard).catch(()=>{});
 }
 await shutdown();
 await fs.writeFile(path.join(here,'large-auto-result.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({id:result.id,status:result.status,error:result.error,runs:result.runs.map(r=>({label:r.label,preparation:r.preparation,cache:r.cacheAfter}))},null,2));
}
