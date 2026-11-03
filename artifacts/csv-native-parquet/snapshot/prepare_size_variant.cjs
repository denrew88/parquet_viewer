// Generate a disposable full-app size comparison; never modify the product checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const product = path.join(root, 'src-tauri');
const variant = path.join(__dirname, 'size-variant');
if (fs.existsSync(variant)) throw new Error('Refusing to overwrite existing size variant');
fs.mkdirSync(variant);
for (const name of ['src','examples','icons','capabilities','build.rs','Cargo.toml','Cargo.lock','tauri.conf.json','THIRD_PARTY_NOTICES.md']) {
  fs.cpSync(path.join(product,name),path.join(variant,name),{recursive:true});
}
function replaceOnce(text, before, after) {
  if (!text.includes(before) || text.indexOf(before)!==text.lastIndexOf(before)) throw new Error(`Expected unique source marker: ${before.slice(0,60)}`);
  return text.replace(before,after);
}
// Preserve the worker IPC, pinned snapshot/fingerprint, cancellation and cache boundary.
const workerPath=path.join(variant,'src/data/csv_polars.rs');
let worker=fs.readFileSync(workerPath,'utf8');
worker=replaceOnce(worker,'use polars::prelude::*;','');
worker=replaceOnce(worker,'        Arc,\n','');
const specStart=worker.indexOf('pub(super) struct PolarsPreparedSinkSpec');
const productWorker=worker.indexOf('pub(super) fn run_product_worker(');
if (specStart<0 || productWorker<specStart) throw new Error('sink block not found');
worker=worker.slice(0,specStart)+worker.slice(productWorker);
const expressionStart=worker.indexOf('fn product_expressions(');
const validationStart=worker.indexOf('fn validate_product_shape(');
if (expressionStart<0 || validationStart<expressionStart) throw new Error('expression block not found');
worker=worker.slice(0,expressionStart)+worker.slice(validationStart);
worker=replaceOnce(worker,`    let sink = build_product_sink(PolarsPreparedSinkSpec {
        source: &source,
        output_partial: &output,
        header_used: request.header_used,
        resolved_targets: &request.resolved_targets,
        profile: &request.profile,
    })?;
    sink.collect().map_err(polars_error)?;`, `    let native_profile = serde_json::to_vec(&serde_json::json!({
        "profile": request.profile,
        "resolvedTargets": request.resolved_targets,
        "headerUsed": request.header_used,
    })).map_err(|e| DataError::query_failed(e.to_string()))?;
    super::csv_native_size::convert_profile(&source, &output, &native_profile, request.thread_limit)
        .map_err(DataError::query_failed)?;`);
worker=replaceOnce(worker,`fn polars_error(error: PolarsError) -> DataError {
    DataError::query_failed(format!("Polars CSV preparation failed: {error}"))
}
`, '');
// Original sink-specific tests use Expr/LazyFrame and are not applicable to this size-only variant.
// Keep original tests unedited in the product checkout; this artifact is not a full integration gate.
worker=worker.slice(0,worker.indexOf('#[cfg(test)]\nmod tests'));
fs.writeFileSync(workerPath,worker);

let converter=fs.readFileSync(path.join(__dirname,'src/main.rs'),'utf8');
const start=converter.indexOf('fn convert(args: &[String]) -> Result<Value> {');
const pool=converter.indexOf('    let pool = rayon::ThreadPoolBuilder',start);
if (start<0 || pool<start) throw new Error('converter entry markers missing');
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
converter=converter.slice(0,converter.indexOf('\nfn main() {'));
converter=converter.replace('use std::path::{Path, PathBuf};','use std::path::Path;');
converter=converter.replace('let partial = output.with_extension("parquet.partial");','let partial = output.clone();');
const publication=converter.indexOf('    if let Err(e) = fs::hard_link(&partial, &output) {');
const returned=converter.indexOf('    Ok(',publication);
if(publication<0||returned<publication)throw new Error('publication markers missing');
converter=converter.slice(0,publication)+converter.slice(returned);
fs.writeFileSync(path.join(variant,'src/data/csv_native_size.rs'),converter);
const modPath=path.join(variant,'src/data/mod.rs');
fs.appendFileSync(modPath,'\n#[cfg(feature = "polars-csv-provider")]\nmod csv_native_size;\n');

const manifestPath=path.join(variant,'Cargo.toml');
let manifest=fs.readFileSync(manifestPath,'utf8');
manifest=replaceOnce(manifest,'phase15-polars-poc = ["dep:polars"]','phase15-polars-poc = []');
manifest=replaceOnce(manifest,'polars-csv-provider = ["dep:polars"]','polars-csv-provider = []');
manifest=manifest.replace(/^polars = .*\r?$/m,`polars-arrow = { version = "=0.54.4", default-features = false }
polars-parquet = { version = "=0.54.4", default-features = false, features = ["zstd"] }
polars-error = "=0.54.4"
rayon = "1"`);
if (/^polars = /m.test(manifest)) throw new Error('full Polars dependency still present');
fs.writeFileSync(manifestPath,manifest);
const configPath=path.join(variant,'tauri.conf.json');
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
config.build.frontendDist=path.relative(variant,path.join(root,'dist')).split(path.sep).join('/');
fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.writeFileSync(path.join(__dirname,'60-size-scope.json'),JSON.stringify({
  baseline:'artifacts/optimizations/rust-thin-lto/optimized-product.exe',
  scope:'Full app with existing worker IPC redirected to experimental native converter. Limited admitted profiles; not a production replacement.',
  sameReleaseProfile:true, productManifestSha256:hash(path.join(product,'Cargo.toml')),
  productLockSha256:hash(path.join(product,'Cargo.lock')),
  standaloneConverterSha256:hash(path.join(__dirname,'src/main.rs')),
  variantEdits:['Cargo.toml','Cargo.lock','tauri.conf.json (same dist assets, relative directory)','src/data/mod.rs','src/data/csv_polars.rs','src/data/csv_native_size.rs'],
  note:'Original sink-specific tests are omitted only from the generated variant; product tests are unchanged. Measure Release size, plus representative existing worker invocation. No full app regression claim.'
},null,2)+'\n');
console.log('Prepared isolated full-app native-converter size variant.');
