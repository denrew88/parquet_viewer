// Compile-time editor catalogue only; the Rust SQL guard remains authoritative.
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src-tauri/src/query/sql_workspace/security.rs',import.meta.url),'utf8');
const block=source.match(/let functions = \[([\s\S]*?)\n\s*\];/);
if(!block)throw Error('SQL guard allow-list changed; inspect before regenerating');
const names=[...block[1].matchAll(/"([a-z_0-9]+)"/g)].map(match=>match[1]);
if(names.length<50||new Set(names).size!==names.length)throw Error('Unexpected SQL function catalogue');
fs.writeFileSync(new URL('../src/sql-workspace/allowedFunctions.json',import.meta.url),JSON.stringify(names,null,2)+'\n');
console.log(`Synchronized ${names.length} read-only SQL function names.`);
