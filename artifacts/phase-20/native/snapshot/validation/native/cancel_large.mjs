import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
const here=import.meta.dirname,root=path.resolve(here,'../../../../..');
const binary=path.join(root,'artifacts/experiments/csv-native-parquet/native-validation.exe');
const identifier='com.denrew88.data-viewer-native-validation-20261103';
const original=path.join(root,'fixtures/phase-20/performance/main-high/high-5850000x15.csv');
const source=path.join(here,`fixtures/cancel-main-${Date.now()}.csv`);await fs.link(original,source);
const result={id:'NATIVE-CANCEL',source,status:'FAIL'};
let app,browser,page,output='';
async function allFiles(dir,depth=0){
 if(depth>6)return[];const out=[];let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return out;}
 for(const e of entries){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await allFiles(p,depth+1));else out.push(p);}return out;
}
try{
 app=spawn(binary,['--file',source],{cwd:root,windowsHide:true,env:{...process.env,
  WEBVIEW2_USER_DATA_FOLDER:path.join(here,'ui/cancel-webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9487'},stdio:['ignore','pipe','pipe']});
 let launchError;app.on('error',e=>launchError=e);app.stdout.on('data',b=>output+=b);app.stderr.on('data',b=>output+=b);
 for(let i=0;i<160;i++){if(launchError)throw launchError;if(app.exitCode!==null)throw Error(`app exit ${app.exitCode}`);
  try{browser=await chromium.connectOverCDP('http://127.0.0.1:9487');break;}catch{await new Promise(r=>setTimeout(r,250));}}
 assert.ok(browser);page=browser.contexts().flatMap(c=>c.pages())[0];
 await page.waitForURL(u=>u.protocol==='http:'&&u.hostname==='tauri.localhost',{timeout:30000});
 await page.waitForFunction(()=>typeof window.__TAURI_INTERNALS__?.invoke==='function');
 const grid=page.locator('[role="grid"][aria-label="Data preview"]');await grid.waitFor({state:'attached'});
 const target=await grid.evaluate(g=>({documentId:g.dataset.documentId,sessionId:g.dataset.sessionId}));result.target=target;
 const usage=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_query_temp_usage'));
 assert.equal(path.basename(path.dirname(usage.csvCachePath)),identifier);
 result.cacheRoot=usage.csvCachePath;
 const workerRoot=path.join(path.dirname(usage.csvCachePath),'query-temp');result.workerRoot=workerRoot;
 const deadline=Date.now()+90000;let staged;
 while(Date.now()<deadline){
  const partials=(await allFiles(workerRoot)).filter(p=>p.endsWith('prepared.parquet.partial'));
  for(const p of partials){if((await fs.stat(p)).size>=4){staged=p;break;}}
  if(staged)break;
  const s=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('get_csv_preparation_status',t),target);
  if(s?.state==='failed')throw Error(JSON.stringify(s));
  assert.notEqual(s?.state,'ready','Native completed before cancellation window');
  await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(staged,'Never observed active native worker output');result.activePartial=staged;
 const requested=Date.now();result.cancelResponse=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('cancel_csv_preparation',t),target);
 for(let i=0;i<200;i++){
  const s=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('get_csv_preparation_status',t),target);
  if(s?.state==='cancelled'){result.cancelled=s;break;}await new Promise(r=>setTimeout(r,25));
 }
 assert.equal(result.cancelled?.state,'cancelled');result.cancelLatencyMs=Date.now()-requested;
 assert.ok(result.cancelLatencyMs<1000,'Cancellation terminal state exceeded 1 second');
 const staging=path.dirname(staged);
 for(let i=0;i<100;i++){if(!(await allFiles(staging)).some(p=>p.endsWith('.partial')||p.endsWith('.snapshot.csv')))break;await new Promise(r=>setTimeout(r,25));}
 result.remainingStagingFiles=await allFiles(staging);
 assert.ok(!result.remainingStagingFiles.some(p=>p.endsWith('prepared.parquet.partial')||p.endsWith('prepared.parquet.parquet.partial')||p.endsWith('.snapshot.csv')),'Orphan native worker files');
 // Source can be prepared again in the same live document after cancellation.
 await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('prepare_csv_session',t),target);
 const retryDeadline=Date.now()+90000;
 while(Date.now()<retryDeadline){const s=await page.evaluate(t=>window.__TAURI_INTERNALS__.invoke('get_csv_preparation_status',t),target);
  if(s&&['ready','failed','cancelled'].includes(s.state)){result.retry=s;break;}await new Promise(r=>setTimeout(r,100));}
 assert.equal(result.retry?.state,'ready',JSON.stringify(result.retry));
 await page.screenshot({path:path.join(here,'ui/cancel-retry-ready.png'),fullPage:true});result.status='PASS';
}catch(e){result.error=String(e.stack||e);}
finally{
 result.appOutput=output;
 if(page){result.body=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(here,'ui/cancel-final.png'),fullPage:true}).catch(()=>{});}
 await browser?.close().catch(()=>{});
 if(app?.exitCode===null){const ended=new Promise(r=>app.once('exit',r));app.kill();await Promise.race([ended,new Promise(r=>setTimeout(r,3000))]);}
 await fs.writeFile(path.join(here,'cancel-result.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({status:result.status,error:result.error,cancelLatencyMs:result.cancelLatencyMs,remaining:result.remainingStagingFiles,retry:result.retry},null,2));
}
