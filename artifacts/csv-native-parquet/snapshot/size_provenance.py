import hashlib
import json
from pathlib import Path
import tomllib

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
VARIANT=HERE/'size-variant'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def lock(p): return tomllib.loads(p.read_text(encoding='utf8'))['package']
baseline=lock(ROOT/'src-tauri/Cargo.lock')
candidate=lock(VARIANT/'Cargo.lock')
old={(p['name'],p['version'],p.get('source')) for p in baseline}
new={(p['name'],p['version'],p.get('source')) for p in candidate}
assert not new-old, f'Unexpected new package versions: {new-old}'
excluded=['polars','polars-core','polars-lazy','polars-stream','polars-plan','polars-expr','polars-mem-engine']
names={p['name'] for p in candidate}
assert not set(excluded)&names
for name in ['duckdb','libduckdb-sys','hdf5-metno','hdf5-metno-src','arrow-array','parquet','polars-arrow','polars-parquet']:
    assert name in names,name
unchanged=[]; changed=[]; added=[]
for p in (ROOT/'src-tauri/src').rglob('*.rs'):
    relative=p.relative_to(ROOT/'src-tauri')
    q=VARIANT/relative
    (unchanged if q.exists() and sha(p)==sha(q) else changed).append(str(relative))
for p in (VARIANT/'src').rglob('*.rs'):
    if not (ROOT/'src-tauri'/p.relative_to(VARIANT)).exists(): added.append(str(p.relative_to(VARIANT)))
assert sorted(changed)==sorted(['src\\data\\mod.rs','src\\data\\csv_polars.rs'])
previous=json.loads((ROOT/'artifacts/optimizations/rust-thin-lto/42-provenance.json').read_text(encoding='utf8'))
product={p:sha(ROOT/p)==h for p,h in previous['hashes'].items()}
assert all(product.values())
result={'productInputsUnchanged':product,'retainedPackageVersionsIdentical':True,
        'baselinePackages':len(old),'candidatePackages':len(new),
        'removedPackages':[{'name':n,'version':v} for n,v,_ in sorted(old-new,key=lambda p:(p[0],p[1]))],
        'excludedFullPolarsCrates':excluded,'variantChangedRustFiles':changed,
        'variantAddedRustFiles':added,'unchangedRustFileCount':len(unchanged),
        'variantProfileRelease':tomllib.loads((VARIANT/'Cargo.toml').read_text(encoding='utf8'))['profile']['release'],
        'nativeWorkerModuleSha256':sha(VARIANT/'src/data/csv_native_size.rs'),
        'variantManifestSha256':sha(VARIANT/'Cargo.toml'),'variantLockSha256':sha(VARIANT/'Cargo.lock')}
(HERE/'64-size-provenance.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:result[k] for k in ['retainedPackageVersionsIdentical','baselinePackages','candidatePackages','variantChangedRustFiles','variantAddedRustFiles','unchangedRustFileCount','variantProfileRelease']},indent=2))
