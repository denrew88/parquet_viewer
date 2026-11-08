// Restore only this Phase's owned pre-run UI backup; never reset Git/user edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const scratch=path.join(root,'.tmp');
const candidates=(await fs.readdir(scratch,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^phase22-e2e-evidence-\d+$/.test(e.name)).map(e=>e.name).sort();
if(!candidates.length)throw Error('No owned Phase22 pre-run backup exists.');
const backup=path.join(scratch,candidates.at(-1));
let checked=0,restored=0;
async function visit(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Refuse backup reparse entry.');const saved=path.join(dir,e.name);if(e.isDirectory()){await visit(saved);continue;}if(!e.isFile())continue;
 const relative=path.relative(backup,saved);if(!/^artifacts[\\/]phase-(?:[0-9]|1[0-9]|2[0-2])[\\/]ui[\\/].+\.(png|json)$/.test(relative))throw Error('Unexpected backup target.');
 const target=path.resolve(root,relative);if(!target.toLowerCase().startsWith((path.join(root,'artifacts')+path.sep).toLowerCase()))throw Error('Target escapes evidence root.');
 const before=await fs.readFile(saved),current=await fs.readFile(target);if(!before.equals(current)){await fs.writeFile(target,before);restored++;}
 const expected=createHash('sha256').update(before).digest('hex'),actual=createHash('sha256').update(await fs.readFile(target)).digest('hex');if(expected!==actual)throw Error('Evidence content verification failed.');checked++;
}}
await visit(backup);
console.log(JSON.stringify({status:'PASS',backup:path.relative(root,backup),checked,restored,contentShaVerified:true}));
