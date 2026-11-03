import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
const here=import.meta.dirname, root=path.resolve(here,'../../../../..');
const binary=path.resolve(process.argv[2]||path.join(root,'artifacts/experiments/csv-native-parquet/native-product-size.exe'));
const label=process.argv[3]||'candidate';
const fixture=path.join(here,'fixtures/small-parquet.parquet');
const port=9485;
const result={label,binary,fixture,fixtureBytes:(await fs.stat(fixture)).size,started:new Date().toISOString(),events:[]};
await fs.mkdir(path.join(here,'ui'),{recursive:true});
let app,browser,page,output='';
try {
 app=spawn(binary,['--file',fixture],{cwd:root,windowsHide:true,env:{...process.env,
  LOCALAPPDATA:path.join(here,'diagnose-appdata'),WEBVIEW2_USER_DATA_FOLDER:path.join(here,`ui/diagnose-${label}-webview`),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:['ignore','pipe','pipe']});
 let launchError;app.on('error',e=>launchError=e);app.stdout.on('data',v=>output+=v);app.stderr.on('data',v=>output+=v);
 for(let i=0;i<120;i++) {
  if(launchError)throw launchError;
  if(app.exitCode!==null)throw new Error(`App exited ${app.exitCode}: ${output}`);
  try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{await new Promise(r=>setTimeout(r,200));}
 }
 assert.ok(browser,'CDP unavailable');
 result.pages=browser.contexts().flatMap(c=>c.pages()).map(p=>p.url());
 page=browser.contexts().flatMap(c=>c.pages())[0];assert.ok(page);
 page.on('console',m=>result.events.push({kind:'console',type:m.type(),text:m.text()}));
 page.on('pageerror',e=>result.events.push({kind:'pageerror',text:String(e)}));
 page.on('requestfailed',r=>result.events.push({kind:'requestfailed',url:r.url(),failure:r.failure()}));
 await new Promise(r=>setTimeout(r,2500));
 const capture=()=>page.evaluate(()=>({url:location.href,title:document.title,body:document.body?.innerText,
  html:document.documentElement?.outerHTML.slice(0,15000),internal:!!window.__TAURI_INTERNALS__,
  scripts:[...document.scripts].map(s=>({src:s.src,type:s.type})),resources:performance.getEntriesByType('resource').map(r=>({name:r.name,duration:r.duration,transferSize:r.transferSize})),
  grids:[...document.querySelectorAll('[role="grid"]')].map(g=>({label:g.getAttribute('aria-label'),documentId:g.dataset.documentId,sessionId:g.dataset.sessionId}))}));
 result.initial=await capture();
 result.invokes=await page.evaluate(async fixture=>{
  const invoke=window.__TAURI_INTERNALS__?.invoke;
  if(!invoke)return {error:'No Tauri invoke bridge'};
  const result={};
  for(const command of ['get_settings','get_query_temp_usage','take_pending_open_requests']) {
   try{result[command]={ok:true,value:await invoke(command)};}catch(e){result[command]={ok:false,error:e};}
  }
  try{
   const response=await invoke('open_data_paths',{request:{requestId:'native-startup-diagnose',origin:'startupArg',paths:[fixture]}});
   result.open_data_paths={ok:true,failures:response.failures,opened:response.opened?.map(o=>({documentId:o.documentId,sessionId:o.sessionId,disposition:o.disposition,summary:o.summary,firstRows:o.initialPage?.rows?.slice(0,1)}))};
  }catch(e){result.open_data_paths={ok:false,error:e};}
  return result;
 },fixture);
 await new Promise(r=>setTimeout(r,1000));
 result.afterInvokes=await capture();
 await page.screenshot({path:path.join(here,`ui/diagnose-${label}.png`),fullPage:true});
 // Reload preserves the same app backend while capturing JS startup errors from the beginning.
 await page.reload({waitUntil:'domcontentloaded'});
 await new Promise(r=>setTimeout(r,2000));
 result.afterReload=await capture();
 await page.screenshot({path:path.join(here,`ui/diagnose-${label}-reload.png`),fullPage:true});
}catch(e){result.error=String(e.stack||e);}
finally{
 result.appOutput=output;
 if(page&&!result.afterReload) await page.screenshot({path:path.join(here,`ui/diagnose-${label}-failure.png`),fullPage:true}).catch(()=>{});
 await browser?.close().catch(()=>{});
 if(app&&app.exitCode===null){app.kill();await new Promise(r=>setTimeout(r,500));}
 await fs.writeFile(path.join(here,`diagnose-${label}.json`),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({label,error:result.error,initial:result.initial?.body,invokes:result.invokes,events:result.events},null,2));
}
