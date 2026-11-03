"""Exercise the actual app worker with source Auto plus resolved typed targets; no product edits."""
import json,os,shutil,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[4]
EXPERIMENT=ROOT/'artifacts/experiments/csv-native-parquet'
OLD=ROOT/'artifacts/experiments/csv-engine-compare'
attempt=1
staging=HERE/f'auto-worker-staging-{attempt}'
while staging.exists():
    attempt+=1;staging=HERE/f'auto-worker-staging-{attempt}'
staging.mkdir(exist_ok=False)
profile=json.loads((OLD/'fixtures/edge-profile.json').read_text(encoding='utf-8-sig'))
for c in profile['profile']['columns']:
    if c['targetType']!='skip':c['targetType']='auto'
source=staging/'polars-source.snapshot.csv'; shutil.copy2(OLD/'fixtures/edge-65537x33.csv',source)
request={'schema_version':1,'nonce':'validation-auto-worker','source':str(source),'staging_root':str(staging),
         'header_used':True,'profile':profile['profile'],'resolved_targets':profile['resolvedTargets'],
         'source_length':source.stat().st_size,'source_modified_ns':source.stat().st_mtime_ns,'thread_limit':8}
p=staging/'polars-worker-request.json';p.write_text(json.dumps(request),encoding='utf8')
env=os.environ.copy();env['POLARS_MAX_THREADS']='8'
result=subprocess.run([str(EXPERIMENT/'native-validation.exe'),'--data-viewer-internal-worker','csv-prepare-v1','--request',str(p)],
                      capture_output=True,env=env,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
report={'id':'NATIVE-003','status':'PASS' if result.returncode==0 else 'FAIL','returnCode':result.returncode,
        'stdout':result.stdout.decode(errors='replace'),'stderr':result.stderr.decode(errors='replace'),
        'outputExists':(staging/'prepared.parquet.partial').exists()}
(HERE/'auto-worker-result.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,indent=2))
