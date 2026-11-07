import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const application=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const queue=Object.keys(application.dependencies).filter(name=>name.startsWith('@codemirror/'));
const packages=new Map();
while(queue.length){const name=queue.shift();if(packages.has(name))continue;const directory=path.join(root,'node_modules',name);const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));const file=['LICENSE','LICENSE.md','LICENSE.txt'].map(file=>path.join(directory,file)).find(file=>fs.existsSync(file));if(!file)throw Error('Missing licence: '+name);packages.set(name,{version:pkg.version,license:fs.readFileSync(file,'utf8')});queue.push(...Object.keys(pkg.dependencies??{}));}
const text=['CodeMirror SQL editor third-party notices','Exact dependency versions are locked in package-lock.json.','',...[...packages].sort(([a],[b])=>a.localeCompare(b)).map(([name,pkg])=>`${name} ${pkg.version}\n${'='.repeat(72)}\n${pkg.license.trim()}\n`)].join('\n');
fs.mkdirSync(path.join(root,'public'),{recursive:true});fs.writeFileSync(path.join(root,'public/third-party-codemirror.txt'),text);
console.log(`Embedded licence notices for ${packages.size} editor dependencies.`);
