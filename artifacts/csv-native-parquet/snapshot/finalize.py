"""Record provenance, footer settings and compact comparison; does not rebuild or rerun timings."""
import hashlib
import json
from pathlib import Path
import sys
import tomllib

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
def save(p,v): p.write_text(json.dumps(v,indent=2)+'\n',encoding='utf8')

report=read(HERE/'30-results.json')
previous=read(ROOT/'artifacts/optimizations/rust-thin-lto/42-provenance.json')
product={p:{'sha256':sha(ROOT/p),'unchanged':sha(ROOT/p)==expected} for p,expected in previous['hashes'].items()}
assert all(v['unchanged'] for v in product.values())
sink=ROOT/'src-tauri/src/data/csv_polars.rs'
reference_sink=ROOT/'artifacts/experiments/csv-engine-compare/variant/src/data/csv_polars.rs'
assert sha(sink)==sha(reference_sink)
lock=tomllib.loads((HERE/'Cargo.lock').read_text(encoding='utf8'))
packages=sorted(p['name'] for p in lock['package'])
for excluded in ['polars','polars-core','polars-lazy','polars-stream','duckdb','libduckdb-sys']:
    assert excluded not in packages
provenance={'date':'2026-11-03','product':product,'productSinkSha256':sha(sink),
            'referenceSinkIdentical':True,'candidatePackageCount':len(packages),
            'candidatePackages':packages,'candidateSources':{p:sha(HERE/p) for p in ['Cargo.toml','Cargo.lock','src/main.rs']},
            'candidateBinary':{'bytes':(HERE/'csv-native-parquet.exe').stat().st_size,'sha256':sha(HERE/'csv-native-parquet.exe')},
            'note':'Standalone converter size is not an integrated product size comparison.'}
save(HERE/'20-provenance.json',provenance)

sys.path.insert(0,str(ROOT/'.tmp/hdf5-fixture-python'))
import pyarrow.parquet as pq
footers={}
for variant in ['polars','native']:
    p=Path(next(r['output'] for r in report['runs'] if r['variant']==variant))
    meta=pq.ParquetFile(p).metadata
    footers[variant]={'rows':meta.num_rows,'columns':meta.num_columns,'rowGroups':meta.num_row_groups,
                     'minRowsPerGroup':min(meta.row_group(i).num_rows for i in range(meta.num_row_groups)),
                     'maxRowsPerGroup':max(meta.row_group(i).num_rows for i in range(meta.num_row_groups)),
                     'codecs':sorted({meta.row_group(i).column(j).compression for i in range(meta.num_row_groups) for j in range(meta.num_columns)}),
                     'firstGroupEncodings':[{'name':meta.row_group(0).column(i).path_in_schema,
                                             'encodings':list(meta.row_group(0).column(i).encodings)} for i in range(meta.num_columns)]}
save(HERE/'22-footers.json',footers)
summary={}
for metric in report['aggregate']['polars']:
    baseline=report['aggregate']['polars'][metric]['median']; candidate=report['aggregate']['native'][metric]['median']
    summary[metric]={'polars':baseline,'native':candidate,'changePercent':(candidate/baseline-1)*100}
save(HERE/'40-summary.json',summary)
print(json.dumps({'summary':summary,'packages':len(packages),'footers':{v:{k:x[k] for k in ['rows','columns','rowGroups','codecs']} for v,x in footers.items()}},indent=2))
