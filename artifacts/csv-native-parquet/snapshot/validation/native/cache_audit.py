"""Verify the ACTUAL app Auto cache against unchanged Polars with identical resolved schema."""
import hashlib,json,os,subprocess,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
EXP=HERE.parents[1];ROOT=EXP.parents[2]
BASE=ROOT/'artifacts/optimizations/rust-thin-lto/thin1-csv-probe.exe'
sys.path.insert(0,str(ROOT/'.tmp/hdf5-fixture-python'))
import pyarrow as pa
import pyarrow.parquet as pq
result=json.loads((HERE/'large-auto-result.json').read_text())
assert result['status']=='PASS'
assert result['identifier']=='com.denrew88.data-viewer-native-validation-20261103'
files=result['runs'][0]['cacheFiles']
manifest_path=next(Path(p) for p in files if p.endswith('cache-manifest.json'))
cache=next(Path(p) for p in files if p.endswith('prepared.parquet'))
assert result['identifier'] in cache.parts
manifest=json.loads(manifest_path.read_text())
parquet=pq.ParquetFile(cache)
assert parquet.metadata.created_by=='Polars','Actual app fell back to Apache Rust converter'
assert parquet.metadata.num_rows==5850000
profile=json.loads(manifest['profileIdentity'].split('|header=true|',1)[1])
resolved=[]
for i,c in enumerate(profile['columns']):
    if c['targetType']=='skip':continue
    name=f'__dv_value_{i}'
    if name not in parquet.schema_arrow.names:resolved.append('text');continue
    t=parquet.schema_arrow.field(name).type
    target={pa.int64():'int64',pa.uint64():'uint64',pa.float64():'float64',pa.bool_():'boolean'}.get(t)
    resolved.append(target or 'decimal')
audit=HERE/'cache-audit';audit.mkdir(exist_ok=False)
p=audit/'profile.json';p.write_text(json.dumps({'profile':profile,'resolvedTargets':resolved,'headerUsed':True}),encoding='utf8')
source=Path(result['source']);output=audit/'polars-reference.parquet'
env=os.environ.copy();env['POLARS_MAX_THREADS']='8'
done=subprocess.run([str(BASE),'--csv-engine-compare','polars',str(source),str(output),str(p),'8','1024'],
                    capture_output=True,env=env,timeout=120,creationflags=subprocess.CREATE_NO_WINDOW)
assert done.returncode==0,done.stderr.decode(errors='replace')
verify=subprocess.run([str(BASE),'--csv-engine-verify',str(output),str(cache)],capture_output=True,timeout=300,creationflags=subprocess.CREATE_NO_WINDOW)
assert verify.returncode==0,verify.stderr.decode(errors='replace')
oracle=json.loads(verify.stdout);assert oracle['equal'] and oracle['rows']==5850000
(audit/'full-oracle.json').write_text(json.dumps(oracle,indent=2)+'\n',encoding='utf8')
report={'status':'PASS','createdBy':parquet.metadata.created_by,'rows':parquet.metadata.num_rows,
        'physicalColumns':parquet.metadata.num_columns,'cache':str(cache),'manifest':str(manifest_path),
        'resolvedTargets':resolved,'rowMajorSha256':oracle['rowMajorSha256'],
        'nativeAppSha256':hashlib.sha256((EXP/'native-validation.exe').read_bytes()).hexdigest(),
        'baselinePolarsSha256':hashlib.sha256(BASE.read_bytes()).hexdigest()}
(HERE/'cache-audit-result.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:report[k] for k in ['status','createdBy','rows','physicalColumns','rowMajorSha256']},indent=2))
