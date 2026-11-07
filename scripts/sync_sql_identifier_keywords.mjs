// Compile-time quoting catalogue from the bundled engine; no runtime query.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const build=path.join(root,'.tmp/duckdb-size-target/release/build');
const files=fs.readdirSync(build).filter(name=>name.startsWith('libduckdb-sys-')).map(name=>path.join(build,name,'out/duckdb/third_party/libpg_query/include/parser/kwlist.hpp')).filter(file=>fs.existsSync(file));
if(!files.length)throw Error('Build the bundled DuckDB before synchronizing identifier keywords.');
const sources=files.map(file=>fs.readFileSync(file,'utf8'));
if(new Set(sources.map(source=>createHash('sha256').update(source).digest('hex'))).size!==1)throw Error('Bundled keyword sources disagree; inspect engine versions before synchronizing.');
const lock=fs.readFileSync(path.join(root,'artifacts/experiments/csv-native-parquet/size-variant/Cargo.lock'),'utf8');
const version=lock.match(/name = "libduckdb-sys"\r?\nversion = "([^"]+)"/)?.[1];
if(!version)throw Error('Bundled DuckDB crate version not found.');
const keywords=[...sources[0].matchAll(/^PG_KEYWORD\("([a-z_]+)",/gm)].map(match=>match[1]).sort();
if(keywords.length<400||new Set(keywords).size!==keywords.length)throw Error('Unexpected parser keyword catalogue.');
fs.writeFileSync(path.join(root,'src/sql-workspace/identifierKeywords.json'),JSON.stringify({engineCrateVersion:version,sourceSha256:createHash('sha256').update(sources[0]).digest('hex'),keywords},null,2)+'\n');
console.log(`Synchronized ${keywords.length} parser keywords from libduckdb-sys ${version}.`);
