const fs=require('node:fs');
const path=require('node:path');
const here=path.resolve(__dirname,'..');
const root=path.resolve(here,'../../..');
const variant=path.join(here,'size-variant');
let converter=fs.readFileSync(path.join(here,'src/main.rs'),'utf8');
const start=converter.indexOf('fn convert(args: &[String]) -> Result<Value> {');
const pool=converter.indexOf('    let pool = rayon::ThreadPoolBuilder',start);
if(start<0||pool<start)throw new Error('converter markers missing');
converter=converter.slice(0,start)+`pub(super) fn convert_profile(source_path: &Path, output_path: &Path, profile_json: &[u8], threads: usize) -> Result<Value> {
    let started = Instant::now();
    let source = fs::canonicalize(source_path).map_err(|e| e.to_string())?;
    let output = output_path.to_path_buf();
    if output.exists() { return Err("output already exists".into()); }
    if profile_json.len() > 1024 * 1024 { return Err("profile limit".into()); }
    let profile: Profile = serde_json::from_slice(profile_json).map_err(|e| e.to_string())?;
    let targets = validate(&profile)?;
    if !(1..=8).contains(&threads) { return Err("threads must be 1..8".into()); }
`+converter.slice(pool);
const main=converter.indexOf('\nfn main() {');
if(main<0)throw new Error('CLI marker missing');
converter=converter.slice(0,main).replace('use std::path::{Path, PathBuf};','use std::path::Path;');
// Parent worker already owns this .partial path and its cancellation cleanup.
// Do not introduce a second, untracked temporary file inside the worker staging directory.
converter=converter.replace('let partial = output.with_extension("parquet.partial");','let partial = output.clone();');
const publication=converter.indexOf('    if let Err(e) = fs::hard_link(&partial, &output) {');
const returned=converter.indexOf('    Ok(',publication);
if(publication<0||returned<publication)throw new Error('publication markers missing');
converter=converter.slice(0,publication)+converter.slice(returned);
fs.writeFileSync(path.join(variant,'src/data/csv_native_size.rs'),converter);
const configPath=path.join(variant,'tauri.conf.json');
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
config.identifier='com.denrew88.data-viewer-native-validation-20261103';
config.build.frontendDist=path.relative(variant,path.join(root,'dist')).split(path.sep).join('/');
if(path.isAbsolute(config.build.frontendDist)||config.build.frontendDist.includes(':'))throw new Error('frontendDist must be relative directory, not URL');
if(!fs.existsSync(path.resolve(variant,config.build.frontendDist,'index.html')))throw new Error('missing dist assets');
fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
console.log(JSON.stringify({identifier:config.identifier,frontendDist:config.build.frontendDist}));
