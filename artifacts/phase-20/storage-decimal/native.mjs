import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
const here=import.meta.dirname, root=path.resolve(here,'../../..');
const binary=process.env.DATA_VIEWER_TEST_BINARY || path.join(root,'src-tauri/target/release/data-viewer.exe');
const result={status:'FAIL',binary,sha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex')};
await fs.mkdir(path.join(here,'ui'),{recursive:true});
let app,browser,page,settings;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
try{
 app=spawn(binary,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(here,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9495'}});
 for(let i=0;i<120;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9495');break;}catch{await pause(250);}}
 assert.ok(browser);page=browser.contexts().flatMap(c=>c.pages())[0];
 await page.waitForURL(u=>u.hostname==='tauri.localhost');
 await page.waitForFunction(()=>typeof window.__TAURI_INTERNALS__?.invoke==='function');
 const usage=await invoke('get_query_temp_usage');
 assert.ok(usage.csvCachePath.includes('com.denrew88.data-viewer-native-validation-20261103'));
 settings=await invoke('get_settings');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Application settings'});
 const input=dialog.getByRole('spinbutton',{name:'Query temporary storage limit'});
 await input.scrollIntoViewIfNeeded();
 for(const value of ['0.0624999999','10.0000000001']){await input.fill(value);await page.getByRole('button',{name:'Apply',exact:true}).isDisabled().then(v=>assert.ok(v));}
 await input.fill('0.3');assert.ok(await input.evaluate(e=>e.checkValidity()));
 await dialog.getByRole('button',{name:'Apply',exact:true}).click();await dialog.waitFor({state:'hidden'});
 result.settings=await invoke('get_settings');result.usage=await invoke('get_query_temp_usage');
 assert.equal(result.settings.queryTempLimitBytes,322122547);assert.equal(result.usage.limitBytes,322122547);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await input.scrollIntoViewIfNeeded();
 assert.equal(await input.inputValue(),'0.3');
 await dialog.screenshot({path:path.join(here,'ui/native-0.3.png')});await dialog.press('Escape');
 const fixture=path.join(root,'fixtures/phase-20/storage-decimal.csv');
 const opened=await invoke('open_data_paths',{request:{requestId:'storage-decimal',origin:'startupArg',paths:[fixture]}});
 assert.equal(opened.failures.length,0);
 const {documentId,sessionId}=opened.opened[0],target={documentId,sessionId};
 for(let i=0;i<300;i++){result.preparation=await invoke('get_csv_preparation_status',target);if(result.preparation?.state==='ready'||result.preparation?.state==='failed')break;await pause(50);}
 assert.equal(result.preparation?.state,'ready',JSON.stringify(result.preparation));
 result.page=await invoke('read_page',{request:{...target,offset:0,limit:3,columns:['id']}});
 assert.deepEqual(result.page.page.rows.map(r=>r[0].display),['1','2','3']);
 await invoke('close_document',target);result.status='PASS';
}catch(e){result.error=String(e.stack||e);}
finally{
 if(page&&settings)await invoke('update_settings',{settings}).catch(e=>result.restoreError=String(e));
 await browser?.close().catch(()=>{});
 if(app&&app.exitCode===null){const exit=new Promise(r=>app.once('exit',r));app.kill();await Promise.race([exit,pause(3000)]);}
 await fs.writeFile(path.join(here,'native-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,error:result.error}));
}
if(result.status!=='PASS')process.exitCode=1;
