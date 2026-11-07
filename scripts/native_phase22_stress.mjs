// Actual optimized Tauri executable + same-EXE SQL child. Never browser mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from '@playwright/test';

const root=path.resolve(import.meta.dirname,'..');
const scratch=path.join(root,'.tmp/phase22-stress');
const output=path.join(root,'artifacts/phase-22/native');
const binary=path.join(root,'src-tauri/target/release/candidates/phase-22-native/data-viewer.exe');
const identifier='com.denrew88.data-viewer-phase22-acceptance';
const input=path.join(scratch,'stress.parquet');
const runFile=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const terminal=s=>['complete','failed','cancelled'].includes(s.state);
const filter=process.argv[2]??'';assert.ok(['','low-storage','memory','settings','editor','lifecycle','lifecycle-csv','join','usability','identifiers','layout','tables'].includes(filter),'Unknown fixed stress case');
const joinCase=['join','usability','identifiers','layout','tables'].includes(filter);
const startupPaths=joinCase?[input,path.join(root,'fixtures/phase-22/join-completion/orders.parquet'),path.join(root,'fixtures/phase-22/join-completion/customers.parquet')]:filter.startsWith('lifecycle')?[input,path.join(root,'fixtures/phase-22/types.parquet'),path.join(root,'fixtures/phase-22/sales/orders.csv')]:[input];
const report={status:'RUNNING',startedAt:new Date().toISOString(),binary,identifier,filter,checks:[],memoryContract:{duckdbBufferBytes:268435456,threads:2,processRssHardCap:false},samplingMs:20};
const sharedSamples=[];
let owned,browser,page,settings,identity,bindings,baseline,monitor,seq=0;
const samplesFile=path.join(scratch,filter?'samples-'+filter+'.jsonl':'samples.jsonl'),stopFile=path.join(scratch,'monitor.stop');
async function checkpoint(){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,filter?'stress-'+filter+'.json':'stress.json'),JSON.stringify(report,null,2));}
async function ps(script,env={}){const {stdout}=await runFile('powershell',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$ErrorActionPreference='Stop'\n"+script],{windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,...env}});return stdout.trim();}
async function invoke(command,args={}){const r=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!r.ok)throw r.error;return r.value;}
async function poll(read,done,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const s=await read();if(done(s))return s;await pause(50);}throw Error('Timeout '+timeout+'ms');}
async function samples(since=0){const text=await fs.readFile(samplesFile,'utf8').catch(()=> '');return text.split('\n').filter(Boolean).flatMap(line=>{try{const s=JSON.parse(line);return s.at>=since?[s]:[];}catch{return[];}});}
async function summarize(since,until=Date.now()){
 const all=(await samples(since)).filter(s=>s.at<=until),children=all.flatMap(s=>s.processes.filter(p=>!p.parent));
 const max=(items,key)=>Math.max(0,...items.map(x=>x[key]));
 return{samples:all.length,maxSampleGapMs:Math.max(0,...all.slice(1).map((s,i)=>s.at-all[i].at)),workerPids:[...new Set(children.map(p=>p.pid))],peakWorkerWs:max(children,'ws'),peakWorkerPrivate:max(children,'private'),peakParentWs:max(all.flatMap(s=>s.processes.filter(p=>p.parent)),'ws'),peakCombinedWs:Math.max(0,...all.map(s=>s.processes.reduce((n,p)=>n+p.ws,0))),peakTempBytes:max(all,'tempBytes'),peakSpillBytes:max(all,'spillBytes'),peakResultBytes:max(all,'resultBytes'),allowances:[...new Set(all.flatMap(s=>s.jobs.map(j=>j.allowance)))],maxJobOvershoot:max(all.flatMap(s=>s.jobs),'overshoot'),minFreeBytes:Math.min(...all.map(s=>s.freeBytes)),sharedUsage:sharedSamples.filter(s=>s.at>=since&&s.at<=until)};
}
async function start(sql,action='execute'){const runId='p22-stress-'+(++seq);const initial=await invoke('start_sql_query',{request:{runId,sql,action,tables:bindings}});return{runId,initial};}
async function wait(runId,timeout=90000){return poll(async()=>{if(Date.now()-(sharedSamples.at(-1)?.at??0)>500)await usage();const last=(await samples(Date.now()-1500)).at(-1);if(last?.processes.some(p=>!p.parent&&p.private>2147483648)){await invoke('cancel_sql_query',{runId});throw Error('Harness safety cutoff: worker private memory exceeded2GiB; not a product-limit PASS');}return invoke('get_sql_query_status',{runId});},terminal,timeout);}
async function pageOf(s){assert.equal(s.state,'complete',JSON.stringify(s));return invoke('read_sql_query_page',{request:{runId:s.runId,resultId:s.resultId,offset:0,limit:200,columns:s.columns.map(c=>c.id)}});}
async function release(s){if(s?.resultId)await invoke('release_sql_result',{runId:s.runId,resultId:s.resultId});}
async function usage(){const u=await invoke('get_query_temp_usage');sharedSamples.push({at:Date.now(),...u});return u;}
async function run(sql){return wait((await start(sql)).runId);}
async function recovery(){assert.equal((await pageOf(baseline)).rows[0][0].display,'42');const s=await run('SELECT COUNT(*) AS n, SUM(id) AS total FROM stress');try{const p=await pageOf(s);assert.deepEqual(p.rows[0].map(v=>v.display),['5850000','17111247075000']);return{state:s.state,values:p.rows[0].map(v=>v.display)};}finally{await release(s);}}
async function settled(){const since=Date.now();return poll(async()=>{const s=(await samples(since)).at(-1);return{usage:await usage(),fresh:Boolean(s),workers:s?.processes.filter(p=>!p.parent)??[]};},v=>v.fresh&&v.workers.length===0,10000);}
async function limit(bytes){await invoke('update_settings',{settings:{...settings,queryTempLimitBytes:bytes,csvCacheLimitBytes:67108864}});const u=await usage();assert.equal(u.limitBytes,bytes);return u;}
async function check(name,fn){if(filter==='editor'&&!name.startsWith('editor-'))return;if(filter==='settings'&&!name.startsWith('sql-storage-'))return;if(filter==='low-storage'&&name!=='full-sort-low-storage-failure')return;if(filter==='memory'&&!name.includes('memory-pressure'))return;const since=Date.now();try{const details=await fn(since);report.checks.push({name,status:'PASS',elapsedMs:Date.now()-since,...details});console.log(JSON.stringify({name,status:'PASS'}));}catch(error){report.checks.push({name,status:'FAIL',elapsedMs:Date.now()-since,error:error?.stack??JSON.stringify(error)});console.log(JSON.stringify({name,status:'FAIL',error:error?.message??JSON.stringify(error)}));if(seq){await invoke('cancel_sql_query',{runId:'p22-stress-'+seq}).catch(()=>{});await wait('p22-stress-'+seq,10000).catch(()=>{});await settled().catch(()=>{});}}await checkpoint();}
async function stress(sql,{cancel=false,expected='failed',reason='resource',timeout=90000}={}){
 const since=Date.now(),before=await usage(),{runId}=await start(sql);let cancellation;
 if(cancel){
  // Running status alone precedes spawn: require a real child and measured CPU work.
  let proof;await poll(async()=>{const s=await invoke('get_sql_query_status',{runId});const data=await samples(since);const workers=data.flatMap(v=>v.processes.filter(p=>!p.parent));proof=workers.find(p=>p.cpu>=0.25);assert.ok(!workers.some(p=>p.private>2147483648),'Harness2GiB safety cutoff');assert.ok(!terminal(s),JSON.stringify(s));return{status:s,proof};},v=>v.status.state==='running'&&Boolean(v.proof),30000);
  await pause(500);const t=Date.now();await invoke('cancel_sql_query',{runId});const final=await wait(runId,10000);cancellation={proof,requestedAt:t,latencyMs:Date.now()-t};assert.equal(final.state,'cancelled',JSON.stringify(final));assert.ok(cancellation.latencyMs<=5000,'Cancel exceeded5s');
 }
 const final=await wait(runId,timeout);const metrics=await summarize(since);const after=await settled();if(cancellation){cancellation.exitAndCleanupMs=Date.now()-cancellation.requestedAt;assert.ok(cancellation.exitAndCleanupMs<=5000,'Cancel child cleanup exceeded5s');}
 (report.runs??=[]).push({sql,final,cancellation,metrics,before,after});await checkpoint();
 assert.equal(final.state,cancel?'cancelled':expected,JSON.stringify({final,metrics}));
 if(!cancel)assert.match(final.error?.message??'',/1000000 rows|out of memory|failed to offload|temporary|allowance|max_temp_directory|memory limit/i,'Not a resource/row-limit failure');
 if(reason==='rowCap')assert.match(final.error?.message??'',/1000000 rows/);
 if(reason==='spill'){assert.ok(metrics.peakSpillBytes>0,'No running spill observed');assert.equal(final.error?.code,'QueryTempLimitExceeded');assert.match(final.error?.message??'',/temporary|allowance|offload|max_temp_directory/i);assert.doesNotMatch(final.error?.message??'',/PRAGMA/);}
 if(reason==='memory'){assert.match(final.error?.message??'',/out of memory/i);assert.doesNotMatch(final.error?.message??'',/max_temp_directory|offload/i,'Disk cap is not a memory allocation failure');}
 assert.ok(metrics.workerPids.length,'No observed worker execution');
 assert.ok(metrics.minFreeBytes>before.safetyReserveBytes,'Physical safety reserve crossed');
 assert.ok(after.usage.queryTempBytes<=before.queryTempBytes+4096,'Failed query leaked temporary data');
 const next=await recovery();return{sql,final,cancellation,metrics,before,after,next};
}

async function launchRuntime(){
 owned=JSON.parse(await ps('$p=Start-Process -FilePath $env:P22_BINARY -ArgumentList (\'"\'+$env:P22_INPUT+\'"\') -WorkingDirectory $env:P22_ROOT -WindowStyle Hidden -PassThru\n[pscustomobject]@{pid=$p.Id;path=$p.Path;ticks=$p.StartTime.Ticks.ToString()}|ConvertTo-Json -Compress',{P22_BINARY:binary,P22_INPUT:startupPaths.join('" "'),P22_ROOT:root,WEBVIEW2_USER_DATA_FOLDER:path.join(scratch,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9502'}));report.owner=owned;
 await poll(async()=>{try{browser=await chromium.connectOverCDP('http://127.0.0.1:9502');return true;}catch{return false;}},Boolean,45000);
 page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'))??browser.contexts()[0].pages()[0];await page.waitForFunction(()=>typeof window.__TAURI_INTERNALS__?.invoke==='function');
 assert.equal(await invoke('plugin:app|identifier'),identifier,'Refuse production namespace');report.health=await invoke('health_check');assert.equal(report.health.appVersion,'0.22.0');
}
async function stopRuntime(){
 await browser?.close().catch(()=>{});browser=null;
 if(owned)await ps('$p=Get-Process -Id ([int]$env:P22_PID) -ErrorAction SilentlyContinue\nif($p){if($p.Path -ne $env:P22_BINARY -or $p.StartTime.Ticks.ToString() -ne $env:P22_TICKS){throw "Unowned PID"};Stop-Process -Id $p.Id;if(-not $p.WaitForExit(3000)){throw "Process did not stop"}}',{P22_PID:String(owned.pid),P22_BINARY:binary,P22_TICKS:owned.ticks});owned=null;
}
async function reopenSource(){
 const previous=identity;if(previous)await invoke('close_document',previous);
 const r=await invoke('open_data_paths',{request:{requestId:'settings-open-'+(++seq),origin:'startupArg',paths:[input]}});assert.equal(r.failures.length,0,JSON.stringify(r));identity={documentId:r.opened[0].documentId,sessionId:r.opened[0].sessionId};bindings=[{...identity,alias:'stress',columnMode:'name'}];
 if(previous)assert.notEqual(identity.sessionId,previous.sessionId);
 const p=await invoke('read_page',{request:{...identity,offset:0,limit:1,columns:['id']}});assert.equal(p.page.rows[0][0].display,'0');return{previous,current:identity,page:p};
}
async function uiCap(text,overall='2'){
 const before=await invoke('get_settings');await page.getByRole('button',{name:'Settings',exact:true}).click();const d=page.getByRole('dialog',{name:'Application settings',exact:true});
 const field=d.getByRole('spinbutton',{name:'SQL temporary storage per query (GiB)',exact:true});await field.fill(text);await d.getByRole('spinbutton',{name:'Overall managed storage limit',exact:true}).fill(overall);
 assert.deepEqual(await invoke('get_settings'),before,'Draft must not persist before Apply');assert.equal(await field.inputValue(),text);
 if(!report.nativeSettingsScreenshot){await d.getByRole('button',{name:'Reset SQL temporary storage',exact:true}).scrollIntoViewIfNeeded();await fs.mkdir(output,{recursive:true});const image=path.join(output,'native-sql-storage-settings.png');await d.screenshot({path:image});report.nativeSettingsScreenshot=image;}
 await d.getByRole('button',{name:'Apply',exact:true}).click();await d.waitFor({state:'hidden'});
 const saved=await invoke('get_settings');assert.equal(saved.schemaVersion,6);assert.equal(saved.sqlTempLimitBytes,Math.round(Number(text)*1024**3));assert.equal(saved.queryTempLimitBytes,Math.round(Number(overall)*1024**3));return saved;
}
async function liveJob(sql){
 async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const f=path.join(dir,e.name);if(e.isDirectory()){const found=await walk(f);if(found)return found;}else if(e.name==='job.json'){try{const job=JSON.parse(await fs.readFile(f,'utf8'));if(job.parent_pid===owned.pid&&job.sql===sql)return{path:f,...job};}catch{}}}return null;}
 return poll(()=>walk(report.tempRoot),Boolean,10000);
}
async function settingsCases(){
 for(const text of ['0.0625','0.3','0.5','1','10'])await check('sql-storage-ui-wire-session-query-'+text,async()=>{const saved=await uiCap(text),source=await reopenSource(),next=await recovery();return{saved,source,next};});
 const sql='SELECT SUM(rn) AS total FROM (SELECT ROW_NUMBER() OVER (ORDER BY payload) AS rn FROM stress) ranked';
 await check('sql-storage-same-query-lower-fails-higher-succeeds',async()=>{
  await uiCap('0.0625');const plan=await wait((await start(sql,'explain')).runId);assert.equal(plan.state,'complete');assert.match(plan.planText??JSON.stringify(plan.planJson),/WINDOW/i,'Require blocking window/order plan');
  const low=await stress(sql,{reason:'spill'});
  await uiCap('1');const since=Date.now(),{runId}=await start(sql),job=await liveJob(sql);assert.ok(job.allowance>536870912,'Hidden512MiB cap remains');assert.ok(job.allowance<=1073741824);
  const high=await wait(runId);try{const p=await pageOf(high);assert.equal(p.rows[0][0].display,'17111252925000');return{sql,plan,low,high,job,metrics:await summarize(since),page:p};}finally{await release(high);}
 });
 await check('sql-storage-active-job-keeps-snapshot',async()=>{
  await uiCap('0.0625');const cross='SELECT SUM(SQRT(CAST(a.id AS DOUBLE)+CAST(b.id AS DOUBLE)+1)) FROM stress a CROSS JOIN stress b';const since=Date.now(),{runId}=await start(cross),oldJob=await liveJob(cross);assert.equal(oldJob.allowance,67108864);
  await poll(async()=> (await samples(since)).flatMap(s=>s.processes).some(p=>!p.parent&&p.cpu>0.25),Boolean,10000);
  const saved=await uiCap('1'),still=JSON.parse(await fs.readFile(oldJob.path,'utf8'));assert.equal(still.allowance,oldJob.allowance);assert.equal((await invoke('get_sql_query_status',{runId})).state,'running');
  await invoke('cancel_sql_query',{runId});const cancelled=await wait(runId);assert.equal(cancelled.state,'cancelled');await settled();return{saved,oldJob,still,cancelled,next:await recovery()};
 });
 await check('sql-storage-global-budget-remains-binding',async()=>{const saved=await uiCap('1','0.0625');const result=await stress(sql,{reason:'spill'});assert.ok(result.metrics.allowances.some(n=>n<67108864));return{saved,result};});
 await check('sql-storage-persist-restart-source-page-query',async()=>{
  const saved=await uiCap('1');await release(baseline);baseline=null;await invoke('close_document',identity);identity=null;
  await fs.writeFile(stopFile,'stop');const err=await monitor;monitor=null;assert.equal(err,null);const previousOwner=owned;await stopRuntime();await launchRuntime();assert.notEqual(owned.pid,previousOwner.pid);
  assert.deepEqual(await invoke('get_settings'),saved);const source=await reopenSource();baseline=await run('SELECT 42 AS retained');await pageOf(baseline);const next=await recovery();return{saved,previousOwner,owner:owned,source,next};
 });
}
async function lifecycleCheck(name,fn){if(filter==='lifecycle-csv'&&!name.includes('referenced-csv'))return;return check(name,fn);}
async function lifecycleCases(){
 const otherHashes=await Promise.all(startupPaths.slice(1).map(async file=>({file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')})));
 await lifecycleCheck('lifecycle-native-binding-reference-cases',async()=>{
  const fake={documentId:'lifecycle-not-open',sessionId:'lifecycle-detached',alias:'unused',columnMode:'name'};
  const registered=[{...identity,alias:'stress',columnMode:'name'},fake];
  const cases=[
   {sql:'SELECT id FROM stress LIMIT 1',value:'0',tables:registered},
   {sql:"SELECT id, 'FROM unused' AS note FROM stress /* JOIN unused */ LIMIT 1",value:'0',tables:registered},
   {sql:'WITH unused AS (SELECT 7 AS n) SELECT n FROM unused',value:'7',tables:registered},
   {sql:'WITH never_used AS (SELECT * FROM unused) SELECT id FROM stress LIMIT 1',value:'0',tables:registered},
   {sql:'SELECT id FROM (SELECT id FROM stress) nested_source ORDER BY id LIMIT 1',value:'0',tables:registered},
   {sql:'SELECT a.id FROM stress a JOIN stress b ON a.id=b.id WHERE a.id<1',value:'0',tables:registered},
   {sql:'SELECT 42 AS n',value:'42',tables:[fake]},
   {sql:'SELECT id FROM stress LIMIT 1',action:'explain',tables:registered},
   {sql:'SELECT id FROM stress LIMIT 1',action:'analyze',tables:registered},
  ],outcomes=[];
  for(const item of cases){const runId='p22-stress-'+(++seq);await invoke('start_sql_query',{request:{runId,sql:item.sql,action:item.action??'execute',tables:item.tables}});const status=await wait(runId);try{assert.equal(status.state,'complete',JSON.stringify(status));if(item.action){assert.ok(status.planText||status.planJson);outcomes.push({sql:item.sql,action:item.action,state:status.state});}else{const data=await pageOf(status);assert.equal(data.rows[0][0].display,item.value);outcomes.push({sql:item.sql,status:status.state,value:data.rows[0][0].display});}}finally{await release(status);}}
  const rejected=[];
  for(const sql of ['SELECT 1 FROM unused WHERE FALSE',"SELECT * FROM read_parquet('not-an-authorized-file.parquet')",'SELECT * FROM unknown_relation']){
   const runId='p22-stress-'+(++seq);let cause;
   try{await invoke('start_sql_query',{request:{runId,sql,action:'execute',tables:registered}});}catch(error){cause=error;}
   assert.ok(cause,'Unresolved or forbidden referenced sources must fail before a task is admitted');
   rejected.push({sql,error:cause});
  }
  return{outcomes,rejected,unusedDetachedIdentityNeverResolved:true,optimizerPrunedSourceStillDependency:true};
 });
 await lifecycleCheck('lifecycle-actual-tabs-dependencies-cancellation-result',async()=>{
  await page.getByRole('button',{name:'SQL workspace',exact:true}).click();
  const workspace=page.getByRole('region',{name:'SQL workspace',exact:true});
  const source=name=>workspace.getByRole('button',{name,exact:true});
  for(const name of ['stress','types','orders'])await source(name).waitFor({state:'visible'});
  await source('types').locator('.sql-table__path').click();assert.equal(await source('types').getAttribute('aria-pressed'),'true');
  await workspace.getByRole('button',{name:'Rename table stress',exact:true}).click();
  await workspace.getByRole('textbox',{name:'Table alias',exact:true}).waitFor({state:'visible'});
  assert.equal(await source('types').getAttribute('aria-pressed'),'true','Pencil must not select another table');
  await workspace.getByRole('button',{name:'Cancel alias edit',exact:true}).click();
  await source('orders').locator('.sql-table__mode').click();assert.equal(await source('orders').getAttribute('aria-pressed'),'true');
  await source('stress').scrollIntoViewIfNeeded();const card=await source('stress').boundingBox();assert.ok(card);await page.mouse.click(card.x+card.width-5,card.y+card.height-5);
  assert.equal(await source('stress').getAttribute('aria-pressed'),'true','Blank card padding must select the table');
  await page.evaluate(()=>{
   const original=window.fetch,probe={starts:[],acknowledged:[],describes:0,original};Reflect.set(window,'__p22LifeProbe',probe);
   const observed=function(input,options,...rest){let runId;const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.hostname==='ipc.localhost'){const command=decodeURIComponent(url.pathname.slice(1));if(command==='describe_sql_tables')probe.describes++;if(command==='start_sql_query'){const r=JSON.parse(options.body).request;runId=r.runId;probe.starts.push({runId:r.runId,sql:r.sql,aliases:r.tables.map(t=>t.alias)});}}const pending=Reflect.apply(original,this,[input,options,...rest]);return runId?pending.then(response=>{probe.acknowledged.push({runId,ok:response.headers.get('Tauri-Response')==='ok'});return response;}):pending;};
   if(!Reflect.set(window,'fetch',observed)||window.fetch!==observed)throw Error('Lifecycle observer installation failed');
  });
  const probe=()=>page.evaluate(()=>{const p=Reflect.get(window,'__p22LifeProbe');return{starts:structuredClone(p.starts),acknowledged:structuredClone(p.acknowledged),describes:p.describes};});
  const editor=workspace.getByRole('textbox',{name:'SQL editor',exact:true});
  const text=()=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
  const clickRun=async sql=>{await editor.fill(sql);await poll(text,v=>v===sql);const count=(await probe()).starts.length;await workspace.getByRole('button',{name:'Run',exact:true}).click();await poll(probe,p=>p.starts.length>count);const p=await probe();assert.equal(p.starts.length,count+1);const started=p.starts.at(-1);const acknowledged=await poll(probe,p=>p.acknowledged.some(a=>a.runId===started.runId));assert.equal(acknowledged.acknowledged.find(a=>a.runId===started.runId).ok,true);return started;};
  let activeRun;
  try{
   await invoke('describe_sql_tables',{sources:[identity]});assert.equal((await probe()).describes,1,'Observer must detect a real control call');
   const initial=await clickRun('SELECT 42 AS retained FROM stress LIMIT 1');baseline=await wait(initial.runId);await pageOf(baseline);
   await workspace.getByRole('gridcell',{name:'42',exact:true}).waitFor({state:'visible'});
   assert.deepEqual((await liveJob(initial.sql)).tables.map(t=>t.alias),['stress'],'Completed baseline must actually depend on the source closed later');
   const sql='SELECT SUM(SQRT(CAST(a.id AS DOUBLE)+CAST(b.id AS DOUBLE)+1)) AS total FROM stress a CROSS JOIN stress b';
   const since=Date.now(),started=await clickRun(sql);activeRun=started.runId;
   assert.deepEqual([...started.aliases].sort(),['orders','stress','types'],'UI must still register all opened files');
   let worker;
   await poll(async()=>{worker=(await samples(since)).flatMap(s=>s.processes).find(p=>!p.parent&&p.cpu>=0.25);return worker;},Boolean,30000);
   const job=await liveJob(sql);assert.deepEqual(job.tables.map(t=>t.alias),['stress'],'Worker must only receive the parsed source dependency');
   const unrelated=[];
   for(const file of ['types.parquet','orders.csv']){
    await page.getByRole('button',{name:'Close '+file,exact:true}).click();
    await page.getByRole('tab',{name:file,exact:true}).waitFor({state:'hidden'});
    const status=await invoke('get_sql_query_status',{runId:activeRun});assert.equal(status.state,'running','Unrelated tab close cancelled SQL');
    assert.equal(await text(),sql,'Closing a file rewrote authored SQL');unrelated.push({file,status});
   }
   await poll(async()=> (await samples(since)).flatMap(s=>s.processes).find(p=>p.pid===worker.pid&&p.cpu>worker.cpu),Boolean,10000);
   const closeAt=Date.now();await page.getByRole('button',{name:'Close stress.parquet',exact:true}).click();
   const cancelled=await wait(activeRun,10000);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.error.code,'TaskCancelled');assert.match(cancelled.error.message,/referenced source.*closed|closed.*source/i);
   const after=await settled();assert.ok(Date.now()-closeAt<=5000,'Source-close child cleanup exceeded5seconds');
   await workspace.getByText(cancelled.error.message,{exact:true}).first().waitFor({state:'visible'});
   await poll(()=>workspace.locator('.sql-table__select').count(),n=>n===0);
   assert.equal(await text(),sql);await workspace.getByRole('gridcell',{name:'42',exact:true}).waitFor({state:'visible'});
   assert.equal((await pageOf(baseline)).rows[0][0].display,'42');
   const cell=await invoke('read_sql_query_cell',{runId:baseline.runId,resultId:baseline.resultId,row:0,columnId:'r0'});assert.equal(cell.display,'42');
   const screenshot=path.join(output,'native-sql-source-lifecycle.png');await page.screenshot({path:screenshot});
   return{initial,baseline,started,jobTables:job.tables.map(t=>t.alias),worker,unrelated,cancelled,after,closeCleanupMs:Date.now()-closeAt,authoredSqlPreserved:true,completedGridAndCellPreserved:true,wholeCardAndPencil:true,probe:await probe(),screenshot};
  }catch(error){
   report.lifecycleFailure={sql:await text().catch(()=>null),probe:await probe().catch(()=>null),alerts:await workspace.getByRole('alert').allTextContents()};
   await page.screenshot({path:path.join(output,'native-sql-source-lifecycle-failure.png')}).catch(()=>{});throw error;
  }finally{
   if(activeRun)await invoke('cancel_sql_query',{runId:activeRun}).catch(()=>{});
   await page.evaluate(()=>{const p=Reflect.get(window,'__p22LifeProbe');if(p)window.fetch=p.original;}).catch(()=>{});
  }
 });
 await lifecycleCheck('lifecycle-referenced-csv-cache-cancel-release-recovery',async()=>{
  const opened=await invoke('open_data_paths',{request:{requestId:'lifecycle-csv-open-'+(++seq),origin:'startupArg',paths:[startupPaths[2]]}});assert.equal(opened.failures.length,0);
  let id={documentId:opened.opened[0].documentId,sessionId:opened.opened[0].sessionId};
  let status,runId;
  try{
   const applied=await invoke('configure_csv',{...id,headerMode:'present'});
   id={documentId:applied.documentId,sessionId:applied.sessionId};
   assert.equal((await invoke('get_csv_profile',id)).profile.columns[0].sourceName,'주문 번호','CSV fixture header must be explicitly enabled');
   await invoke('prepare_csv_session',id);
   const prepared=await poll(()=>invoke('get_csv_preparation_status',id),s=>s?.state==='ready',30000);
   const before=await usage();assert.ok(before.csvCacheActiveEntries>=1);
   const aliases=Array.from({length:12},(_,i)=>String.fromCharCode(97+i));
   const sql='SELECT SUM(SQRT('+aliases.map(a=>'CAST('+a+'.c1 AS DOUBLE)').join('+')+'+1)) FROM '+aliases.map(a=>'csv_orders '+a).join(' CROSS JOIN ');
   const since=Date.now();runId='p22-stress-'+(++seq);
   await invoke('start_sql_query',{request:{runId,sql,action:'execute',tables:[{...id,alias:'csv_orders',columnMode:'ordinal'}]}});
   let worker;await poll(async()=>{status=await invoke('get_sql_query_status',{runId});report.csvLifecycleCheckpoint={status,prepared,before};assert.ok(!terminal(status),JSON.stringify(status));worker=(await samples(since)).flatMap(s=>s.processes).find(p=>!p.parent&&p.cpu>=0.25);return worker;},Boolean,30000);
   const job=await liveJob(sql);assert.equal(job.tables.length,1);assert.equal(job.tables[0].csv,true);assert.match(job.tables[0].path,/prepared\.parquet$/i);
   await fs.access(job.tables[0].path);
   const protectedCleanup=await invoke('clear_csv_cache');assert.ok(protectedCleanup.skippedActiveEntries>=1,'Active CSV cache was not protected');
   const closeAt=Date.now();await invoke('close_document',id);
   const cleanupDuringCancel=await invoke('clear_csv_cache');
   status=await wait(runId,10000);report.csvLifecycleCheckpoint={status,prepared,job,protectedCleanup,cleanupDuringCancel,before};assert.equal(status.state,'cancelled',JSON.stringify(status));assert.equal(status.error.code,'TaskCancelled');assert.match(status.error.message,/referenced source.*closed/i);
   const after=await settled();assert.equal(after.usage.csvCacheActiveEntries,0,'CSV lease remained after source close and worker exit');
   const closeCleanupMs=Date.now()-closeAt;assert.ok(closeCleanupMs<=5000,'Referenced CSV cancel/worker cleanup exceeded5seconds');
   const reopened=await invoke('open_data_paths',{request:{requestId:'lifecycle-csv-recover-'+(++seq),origin:'startupArg',paths:[startupPaths[2]]}});
   assert.equal(reopened.failures.length,0);let nextId={documentId:reopened.opened[0].documentId,sessionId:reopened.opened[0].sessionId};assert.notEqual(nextId.sessionId,id.sessionId,'Reopened CSV must use a new source generation');
   let recovered;
   try{
    const nextApplied=await invoke('configure_csv',{...nextId,headerMode:'present'});
    nextId={documentId:nextApplied.documentId,sessionId:nextApplied.sessionId};
    await invoke('prepare_csv_session',nextId);await poll(()=>invoke('get_csv_preparation_status',nextId),s=>s?.state==='ready',30000);
    const nextRun='p22-stress-'+(++seq);await invoke('start_sql_query',{request:{runId:nextRun,sql:'SELECT c1 FROM csv_orders ORDER BY c1 LIMIT 1',action:'execute',tables:[{...nextId,alias:'csv_orders',columnMode:'ordinal'}]}});
    recovered=await wait(nextRun);assert.equal((await pageOf(recovered)).rows[0][0].display,'101');
   }finally{await release(recovered);await invoke('close_document',nextId);}
   return{prepared,before,worker,jobTables:job.tables.map(t=>({alias:t.alias,csv:t.csv,path:t.path})),protectedCleanup,cleanupDuringCancel,cancelled:status,after,closeCleanupMs,recovered,leaseOrderingEvidence:'Existing worker kill/wait-before-CSV-guards drop reviewed; native active protection and post-exit release observed'};
  }finally{if(runId)await invoke('cancel_sql_query',{runId}).catch(()=>{});await release(status).catch(()=>{});await invoke('close_document',id).catch(()=>{});}
 });
 await lifecycleCheck('lifecycle-start-close-race-no-unpublished-results',async()=>{
  const outcomes=[];
  for(const delay of [0,1,5,15,30,60]){
   const opened=await invoke('open_data_paths',{request:{requestId:'lifecycle-race-open-'+(++seq),origin:'startupArg',paths:[input]}});assert.equal(opened.failures.length,0);
   const id={documentId:opened.opened[0].documentId,sessionId:opened.opened[0].sessionId};
   const runId='p22-stress-'+(++seq),before=await usage();let final;
   try{
    const starting=invoke('start_sql_query',{request:{runId,sql:'SELECT id FROM race_source LIMIT 1',action:'execute',tables:[{...id,alias:'race_source',columnMode:'name'}]}}).then(value=>({ok:true,value}),error=>({ok:false,error}));
    await pause(delay);await invoke('close_document',id);const admission=await starting;
    final=await invoke('get_sql_query_status',{runId}).catch(()=>null);
    if(final)final=await wait(runId,10000);
    if(admission.ok){assert.ok(final&&['complete','cancelled'].includes(final.state),JSON.stringify(final));if(final.state==='complete')assert.equal((await pageOf(final)).rows[0][0].display,'0');}
    else{assert.match(JSON.stringify(admission.error),/document|session|source|closed|cancel/i);assert.ok(!final||!final.resultId,'Failed admission leaked an unpublished result');}
    await release(final);const after=await settled();assert.ok(after.usage.queryTempBytes<=before.queryTempBytes+4096,'Admission race leaked a temporary result');
    outcomes.push({delayMs:delay,admission,final,queryTempBytesBefore:before.queryTempBytes,queryTempBytesAfter:after.usage.queryTempBytes});
   }finally{await invoke('cancel_sql_query',{runId}).catch(()=>{});await release(final).catch(()=>{});await invoke('close_document',id).catch(()=>{});}
  }
  return{outcomes,sourceBytesUnchanged:true};
 });
 report.lifecycleSourceHashes=await Promise.all(otherHashes.map(async before=>{const after=createHash('sha256').update(await fs.readFile(before.file)).digest('hex');assert.equal(after,before.sha256,'Fixture changed');return{...before,sha256After:after};}));
}
async function editorCases(){
 await check('editor-native-intellisense-and-two-mode-query',async()=>{
  await page.getByRole('button',{name:'SQL workspace',exact:true}).click();
  const workspace=page.getByRole('region',{name:'SQL workspace',exact:true});
  const source=workspace.getByRole('button',{name:/^stress(?:_\d+)?$/,exact:true}).first();
  await source.waitFor({state:'visible'});await source.click();const alias=await source.getAttribute('aria-label');
  assert.ok(alias,'No actual UI source alias');
  const editor=workspace.getByRole('textbox',{name:'SQL editor',exact:true}),popup=page.locator('.cm-tooltip-autocomplete');
  const text=()=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
  const option=label=>popup.getByRole('option').filter({has:page.locator('.cm-completionLabel').filter({hasText:new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})}).first();
  const document=async marked=>{const cursor=marked.indexOf('|'),value=cursor<0?marked:marked.slice(0,cursor)+marked.slice(cursor+1);await editor.fill(value);await poll(text,t=>t===value);if(cursor>=0){await editor.press('Control+Home');for(let i=0;i<cursor;i++)await page.keyboard.press('ArrowRight');}return value;};
  const quote=value=>'"'+value.replace(/"/g,'""')+'"';
  await workspace.getByRole('radio',{name:/^Original names only/}).check();
  await page.evaluate(()=>{
   const original=window.fetch,probe={counts:{},starts:[],original};Reflect.set(window,'__p22EditorProbe',probe);
   const observed=function(input,options,...rest){const url=typeof input==='string'?input:input.url;const parsed=new URL(url,location.href),command=decodeURIComponent(parsed.pathname.slice(1));if(parsed.hostname==='ipc.localhost'&&/^(describe_sql_tables|start_sql_query|get_sql_query_status|read_sql_query_page|read_sql_query_cell)$/.test(command)){probe.counts[command]=(probe.counts[command]??0)+1;if(command==='start_sql_query'){const payload=JSON.parse(options.body);probe.starts.push({runId:payload.request.runId,sql:payload.request.sql});}}return Reflect.apply(original,this,[input,options,...rest]);};
   if(!Reflect.set(window,'fetch',observed)||window.fetch!==observed)throw Error('Native IPC observer was not installed');
  });
  const probe=()=>page.evaluate(()=>{const p=Reflect.get(window,'__p22EditorProbe');return{counts:{...p.counts},starts:p.starts.map(s=>({...s}))};});
  await invoke('describe_sql_tables',{sources:[identity]});assert.equal((await probe()).counts.describe_sql_tables,1,'Native IPC observer must detect a real control call');
  report.editorObserver={layer:'forwarded window.fetch IPC transport',controlDescribeCalls:1,recordsInvokeKeysOrHeaders:false};
  await page.evaluate(()=>{const p=Reflect.get(window,'__p22EditorProbe');p.counts={};p.starts=[];});
  const outcomes=[];let activeRun;
  try{
   const before=await probe();
   await document('SELECT ');await pause(600);await editor.press('(');await poll(text,t=>t==='SELECT ()');
   await poll(()=>editor.locator('.cm-matchingBracket').count(),n=>n>=2);await editor.press('Control+z');assert.equal(await text(),'SELECT ','Bracket-pair insertion must undo together');
   await editor.press('Control+f');const find=workspace.getByRole('textbox',{name:'Find',exact:true});await find.waitFor({state:'visible'});await find.fill('SELECT');await find.press('Escape');await find.waitFor({state:'hidden'});assert.equal(await text(),'SELECT ');
   await document(`SELECT COALESCE(s."id", |) FROM ${quote(alias)} s LIMIT 3`);
   const signature=page.getByRole('tooltip',{name:'SQL function signature',exact:true});await signature.waitFor({state:'visible'});assert.match(await signature.textContent(),/COALESCE/);assert.match(await signature.textContent(),/Argument 2/);
   await editor.press('Control+Space');await option('id').waitFor({state:'visible'});
   const screenshot=path.join(output,'native-sql-editor-intellisense.png');await fs.mkdir(output,{recursive:true});await page.screenshot({path:screenshot});report.nativeEditorScreenshot=screenshot;
   const composingText=await text();await editor.evaluate(element=>{for(const key of ['Enter','Tab'])element.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:key==='Enter',isComposing:true,bubbles:true,cancelable:true}));});assert.equal(await text(),composingText,'Synthetic composition shortcut changed SQL');
   assert.deepEqual((await probe()).counts,before.counts,'Typing/completion/find/signatures must not query native SQL backend');
   for(const mode of ['name','ordinal']){
    await workspace.getByRole('radio',{name:mode==='name'?/^Original names only/:/^c-numbers only/}).check();
    const column=mode==='name'?'id':'c1',sql=mode==='name'?`SELECT s.| FROM ${quote(alias)} s ORDER BY s."id" LIMIT 3`:`SELECT s.c| FROM ${quote(alias)} s ORDER BY s.c1 LIMIT 3`;
    await document(sql);await editor.press('Control+Space');await option(column).waitFor({state:'visible'});await option(column).click();
    const expected=`SELECT s.${mode==='name'?'id':'c1'} FROM ${quote(alias)} s ORDER BY s.${mode==='name'?'"id"':'c1'} LIMIT 3`;assert.equal(await text(),expected,'Completion must insert safe bare name or fixed physical ordinal, preserving authored quoting');
    await editor.press('Control+z');assert.equal(await text(),sql.replace('|',''),'Completion undo must preserve previous SQL');
    await editor.press('Control+Space');await option(column).waitFor({state:'visible'});await option(column).click();assert.equal(await text(),expected);
    await editor.press('Control+Space');await popup.waitFor({state:'visible'});const startsBefore=(await probe()).starts.length;
    await editor.press('Control+Enter');await poll(probe,p=>p.starts.length===startsBefore+1);activeRun=(await probe()).starts.at(-1).runId;
    const status=await wait(activeRun),data=await pageOf(status);assert.equal(status.rowCount,3);assert.deepEqual(data.rows.map(row=>row[0].display),['0','1','2']);
    const clear=workspace.getByRole('button',{name:'Clear result',exact:true});await clear.waitFor({state:'visible'});assert.match(await workspace.locator('.sql-result-heading').textContent(),/3 rows/);
    for(const value of ['0','1','2'])await workspace.getByRole('gridcell',{name:value,exact:true}).waitFor({state:'visible'});
    if(mode==='ordinal')await page.screenshot({path:path.join(output,'native-sql-editor-result.png')});
    assert.equal((await probe()).starts.length,startsBefore+1,'Ctrl+Enter with active suggestions started more than one query');
    outcomes.push({mode,sql:expected,status,values:data.rows.map(row=>row[0].display)});await clear.click();await clear.waitFor({state:'hidden'});activeRun=null;
   }
   return{alias,localOnlyCountsBefore:before,queryCalls:await probe(),outcomes,syntheticImeOnly:true,actualOsImeProven:false,bracketPairAndMatching:true,undo:true,find:true,screenshot};
  }catch(error){
   report.editorFailure={sql:await text().catch(()=>null),probe:await probe().catch(()=>null),alerts:await workspace.getByRole('alert').allTextContents(),runEnabled:await workspace.getByRole('button',{name:'Run',exact:true}).isEnabled()};
   await workspace.screenshot({path:path.join(output,'native-sql-editor-failure.png')}).catch(()=>{});
   throw error;
  }finally{
   if(activeRun){await invoke('cancel_sql_query',{runId:activeRun}).catch(()=>{});const status=await invoke('get_sql_query_status',{runId:activeRun}).catch(()=>null);await release(status).catch(()=>{});}
   await page.evaluate(()=>{const p=Reflect.get(window,'__p22EditorProbe');if(p)window.fetch=p.original;}).catch(()=>{});
  }
 });
}
try{
 await fs.mkdir(scratch,{recursive:true});report.input=JSON.parse(await fs.readFile(path.join(scratch,'fixture.json'),'utf8'));const inputHash=createHash('sha256');for await(const chunk of createReadStream(input))inputHash.update(chunk);report.input.sha256=inputHash.digest('hex');report.sha256=createHash('sha256').update(await fs.readFile(binary)).digest('hex');
 await fs.rm(stopFile,{force:true});await launchRuntime();
 settings=await invoke('get_settings');report.originalSettings=settings;const u=await usage();assert.ok(u.csvCachePath.includes(identifier),'Refuse product cache');
 const tempRoot=await ps('[IO.Path]::Combine([Environment]::GetFolderPath("LocalApplicationData"),$env:P22_IDENTIFIER,"query-temp")',{P22_IDENTIFIER:identifier});report.tempRoot=tempRoot;
 monitor=runFile('powershell',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/phase22_stress_monitor.ps1','-OwnerPid',String(owned.pid),'-OwnerTicks',owned.ticks,'-Binary',binary,'-TempRoot',tempRoot,'-Output',samplesFile,'-StopFile',stopFile],{cwd:root,windowsHide:true,timeout:900000}).then(()=>null,e=>({message:e.message,stderr:e.stderr}));
 await poll(async()=>{const s=await samples(Date.now()-1000);return s.length>0;},Boolean,10000);
 await limit(1073741824);
 const opened=await invoke('open_data_paths',{request:{requestId:'stress-open',origin:'startupArg',paths:[input]}});assert.equal(opened.failures.length,0,JSON.stringify(opened));identity={documentId:opened.opened[0].documentId,sessionId:opened.opened[0].sessionId};bindings=[{...identity,alias:'stress',columnMode:'name'}];
 report.descriptor=await invoke('describe_sql_tables',{sources:[identity]});
 baseline=await run('SELECT 42 AS retained');await pageOf(baseline);
 if(!filter.startsWith('lifecycle')&&!joinCase){
 await check('large-input-exact-aggregate',async()=>({recovery:await recovery()}));
 await check('cross-join-running-cancel-1GiB',async()=>stress('SELECT SUM(SQRT(CAST(a.id AS DOUBLE) + CAST(b.id AS DOUBLE) + 1)) AS total FROM stress a CROSS JOIN stress b',{cancel:true}));
 await check('cross-join-result-row-cap',async()=>stress('SELECT a.id AS a_id,b.id AS b_id FROM stress a CROSS JOIN stress b',{reason:'rowCap'}));
 await check('full-sort-1GiB',async()=>stress('SELECT id,payload FROM stress ORDER BY payload DESC, id'));
 await check('high-cardinality-aggregate-1GiB',async()=>stress('SELECT payload, COUNT(*) AS n, SUM(id) AS total FROM stress GROUP BY payload'));
 await check('unspillable-list-memory-pressure',async()=>stress("SELECT array_length(list(regexp_replace(payload, '[a-f]', 'x', 'g'))) AS n FROM stress",{reason:'memory'}));
 await limit(536870912);
 await check('full-sort-running-cancel-0.5GiB',async()=>stress('SELECT id,payload FROM stress ORDER BY payload || payload || payload DESC, id',{cancel:true}));
 await check('high-cardinality-aggregate-0.5GiB',async()=>stress('SELECT payload, COUNT(*) AS n, SUM(id) AS total FROM stress GROUP BY payload'));
 await limit(67108864);
 await check('full-sort-low-storage-failure',async()=>stress("SELECT id,payload FROM stress ORDER BY regexp_replace(payload, '[a-f]', 'x', 'g') DESC, id",{reason:'spill'}));
 await limit(1073741824);
 await check('large-low-cardinality-aggregate-success',async()=>{const since=Date.now(),s=await run('SELECT bucket,COUNT(*) AS n,SUM(id) AS total FROM stress GROUP BY bucket ORDER BY bucket');try{await pageOf(s);assert.equal(s.rowCount,1000);const checked=[];for(const bucket of [0,500,999]){const p=await invoke('read_sql_query_page',{request:{runId:s.runId,resultId:s.resultId,offset:bucket,limit:1,columns:s.columns.map(c=>c.id)}});const expected=[String(bucket),'5850',String(5850n*BigInt(bucket)+1000n*5850n*5849n/2n)];assert.deepEqual(p.rows[0].map(v=>v.display),expected);checked.push(expected);}return{queryStatus:s,metrics:await summarize(since),checked};}finally{await release(s);}});
 }
 if(filter==='settings')await settingsCases();
 if(filter==='editor'){await release(baseline);baseline=null;await editorCases();}
 if(filter.startsWith('lifecycle')){await release(baseline);baseline=null;await lifecycleCases();}
 if(joinCase){
  await release(baseline);baseline=null;
  await invoke('update_settings',{settings});
  const fixtureDir=path.join(root,'fixtures/phase-22/join-completion');
  const sourceHashes=await Promise.all(startupPaths.slice(1).map(async file=>({file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')})));
  const {runJoinAcceptance}=await import('./native_phase22_join.mjs');
  await check('join-quiet-editor-four-modes-settings-restart',async()=>{try{return await runJoinAcceptance({page,invoke,poll,wait,pageOf,release,output,fixtureDir,usability:['usability','identifiers','layout'].includes(filter),identifiers:filter==='identifiers',layout:filter==='layout',tableSuggestions:filter==='tables',primaryIdentity:identity,restart:async()=>{
   await fs.writeFile(stopFile,'stop');if(monitor){const issue=await monitor;monitor=null;assert.equal(issue,null,'Native monitor failed before restart');}
   await stopRuntime();await launchRuntime();return page;
  }});}catch(error){report.joinFailure={sql:await page.getByRole('textbox',{name:'SQL editor',exact:true}).locator('.cm-line').allTextContents().catch(()=>null),alerts:await page.getByRole('alert').allTextContents().catch(()=>null),probe:await page.evaluate(()=>{const p=Reflect.get(window,'__p22JoinProbe');return p?{counts:p.counts,starts:p.starts,acknowledged:p.acknowledged}:null;}).catch(()=>null)};await page.screenshot({path:path.join(output,'native-sql-join-failure.png')}).catch(()=>{});throw error;}});
  report.joinSourceHashes=await Promise.all(sourceHashes.map(async before=>{const after=createHash('sha256').update(await fs.readFile(before.file)).digest('hex');assert.equal(after,before.sha256,'JOIN fixture changed');return{...before,sha256After:after};}));
 }
 report.status=report.checks.some(c=>c.status==='FAIL')?'FAIL':'PASS';
}catch(error){report.status='FAIL';report.error=error?.stack??JSON.stringify(error);console.error(report.error);}
finally{
 if(page&&!page.isClosed()){
  // Interrupt any outstanding work before restoring isolated settings.
  if(seq)await invoke('cancel_sql_query',{runId:'p22-stress-'+seq}).catch(()=>{});
  await release(baseline).catch(()=>{});if(identity)await invoke('close_document',identity).catch(()=>{});
  if(settings)try{await invoke('update_settings',{settings});assert.deepEqual(await invoke('get_settings'),settings);report.settingsRestored=true;}catch(error){report.restoreError=JSON.stringify(error);report.status='FAIL';}
 }
 await fs.writeFile(stopFile,'stop');if(monitor){const e=await monitor;if(e){report.monitorError=e;report.status='FAIL';}}
 await browser?.close().catch(()=>{});
 if(owned)try{await ps('$p=Get-Process -Id ([int]$env:P22_PID) -ErrorAction SilentlyContinue\nif($p){if($p.Path -ne $env:P22_BINARY -or $p.StartTime.Ticks.ToString() -ne $env:P22_TICKS){throw "Unowned PID"};Stop-Process -Id $p.Id;if(-not $p.WaitForExit(3000)){throw "Process did not stop"}}',{P22_PID:String(owned.pid),P22_BINARY:binary,P22_TICKS:owned.ticks});report.ownerStopped=true;}catch(error){report.stopError=String(error);report.status='FAIL';}
 report.finishedAt=new Date().toISOString();await checkpoint();
 const finalHash=createHash('sha256');for await(const chunk of createReadStream(input))finalHash.update(chunk);report.inputSha256After=finalHash.digest('hex');if(report.inputSha256After!==report.input?.sha256){report.status='FAIL';report.inputChanged=true;}await checkpoint();
}
if(report.status!=='PASS')process.exitCode=1;
