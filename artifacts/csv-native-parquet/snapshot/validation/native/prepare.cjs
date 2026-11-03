const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../../../../..');
function diagnostics(source,name) {
  if(!source.includes('let page;')) {
    source=source.replace('let browser;','let browser;\nlet page;');
    source=source.replace('  const page = browser','  page = browser');
  }
  const diagnostic=path.join(__dirname,`${name}-failure.json`);
  const screenshot=path.join(__dirname,`ui/${name}-failure.png`);
  const extra=`} catch(error) {
    const diagnostic={error:String(error.stack||error)};
    if(page) {
      diagnostic.page=await page.evaluate(()=>({url:location.href,title:document.title,body:document.body?.innerText,internal:!!window.__TAURI_INTERNALS__,grids:[...document.querySelectorAll('[role="grid"]')].map(g=>({label:g.getAttribute('aria-label'),documentId:g.dataset.documentId,sessionId:g.dataset.sessionId}))})).catch(e=>({error:String(e)}));
      await page.screenshot({path:${JSON.stringify(screenshot)},fullPage:true}).catch(()=>{});
    }
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(diagnostic)},JSON.stringify(diagnostic,null,2));
    throw error;
  } finally {`;
  return source.replace('} finally {',extra);
}
fs.mkdirSync(path.join(__dirname,'generated'),{recursive:true});
fs.mkdirSync(path.join(__dirname,'fixtures'),{recursive:true});
for(const name of ['small-csv.csv','small-parquet.parquet']) {
 fs.copyFileSync(path.join(root,'artifacts/optimizations/rust-thin-lto/fixtures',name),path.join(__dirname,'fixtures',name));
}
let csv=fs.readFileSync(path.join(root,'scripts/native_cdp_smoke.mjs'),'utf8');
csv=csv.replace('path.resolve(import.meta.dirname, "..")',JSON.stringify(root));
csv=csv.replaceAll('9333','9481').replaceAll('windowsHide: false','windowsHide: true');
csv=csv.replace('process.stdout.write(`${JSON.stringify(results, null, 2)}\\n`);',
 `await (await import("node:fs/promises")).writeFile(${JSON.stringify(path.join(__dirname,'csv-result.json'))}, JSON.stringify(results,null,2));\n  process.stdout.write(JSON.stringify(results,null,2));`);
fs.writeFileSync(path.join(__dirname,'generated/csv.mjs'),diagnostics(csv,'csv'));
let parquet=fs.readFileSync(path.join(root,'artifacts/optimizations/rust-thin-lto/native_parquet_smoke.mjs'),'utf8');
parquet=parquet.replace('path.resolve(import.meta.dirname, "../../..")',JSON.stringify(root));
parquet=parquet.replace('path.join(import.meta.dirname, "fixtures/small-parquet.parquet")',JSON.stringify(path.join(__dirname,'fixtures/small-parquet.parquet')));
parquet=parquet.replace('path.join(import.meta.dirname, "ui/native-parquet.png")',JSON.stringify(path.join(__dirname,'ui/native-parquet.png')));
parquet=parquet.replace('path.join(import.meta.dirname, "ui/parquet-webview")',JSON.stringify(path.join(__dirname,'ui/parquet-webview')));
parquet=parquet.replace('path.join(import.meta.dirname, "native-parquet.json")',JSON.stringify(path.join(__dirname,'parquet-result.json'))).replaceAll('9344','9482');
fs.writeFileSync(path.join(__dirname,'generated/parquet.mjs'),diagnostics(parquet,'parquet'));
let hdf=fs.readFileSync(path.join(root,'artifacts/optimizations/hdf5-msvc-release/native_smoke.generated.mjs'),'utf8');
hdf=hdf.replace('path.resolve(import.meta.dirname, "../../..")',JSON.stringify(root)).replaceAll('9333','9483');
fs.writeFileSync(path.join(__dirname,'generated/hdf5.mjs'),diagnostics(hdf,'hdf5'));
console.log('Prepared owned native regression scripts (ports 9481..9483).');
