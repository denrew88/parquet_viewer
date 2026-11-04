import {chromium} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const results=[];
for (const port of [9481,9482,9483,9484]) {
 let browser;
 try {
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});
  const pages=browser.contexts().flatMap(c=>c.pages());
  for(let i=0;i<pages.length;i++) {
   const page=pages[i];
   const state=await page.evaluate(()=>({url:location.href,title:document.title,body:document.body?.innerText,
    internal:!!window.__TAURI_INTERNALS__,gridCount:document.querySelectorAll('[role="grid"]').length,
    buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label')}))}));
   results.push({port,...state});
   await page.screenshot({path:path.join(import.meta.dirname,`ui/inspect-${port}-${i}.png`),fullPage:true});
  }
 } catch(e) { results.push({port,error:String(e)}); }
 finally { await browser?.close().catch(()=>{}); }
}
await fs.writeFile(path.join(import.meta.dirname,'inspect-live.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
