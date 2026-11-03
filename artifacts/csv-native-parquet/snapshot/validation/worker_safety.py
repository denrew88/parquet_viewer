"""Actual application internal-worker DTO, collision, fingerprint and mutation tests."""
import argparse,copy,hashlib,json,os,shutil,subprocess,time
from pathlib import Path
HERE=Path(__file__).resolve().parent;EXP=HERE.parent;ROOT=EXP.parents[2]
APP=EXP/'native-validation.exe';OLD=ROOT/'artifacts/experiments/csv-engine-compare'
def main():
    p=argparse.ArgumentParser();p.add_argument('--label',default='final');a=p.parse_args()
    dest=HERE/'worker-safety'/a.label;dest.mkdir(parents=True,exist_ok=False)
    template=json.loads((OLD/'fixtures/main-profile.json').read_text(encoding='utf-8-sig'))
    small=copy.deepcopy(template);small['profile']['columns']=small['profile']['columns'][:1];small['resolvedTargets']=['int64']
    report={'binarySha256':hashlib.sha256(APP.read_bytes()).hexdigest(),'cases':[]}
    names=['valid-control','schema-version','relative-request','request-parent','outside-snapshot','thread-zero','thread-nine','thread-env-mismatch','stale-length','stale-modified','existing-output','existing-result','unsupported-profile']
    for name in names:
        d=dest/name;d.mkdir();source=d/'polars-source.snapshot.csv';source.write_bytes(b'c0\n1\n2\n')
        request={'schema_version':1,'nonce':name,'source':str(source),'staging_root':str(d),
                 'header_used':True,'profile':small['profile'],'resolved_targets':['int64'],
                 'source_length':source.stat().st_size,'source_modified_ns':source.stat().st_mtime_ns,'thread_limit':2}
        output=d/'prepared.parquet.partial';result_path=d/'polars-worker-result.json'
        env=os.environ.copy();env['POLARS_MAX_THREADS']='2';rpath=d/'polars-worker-request.json'
        if name=='schema-version':request['schema_version']=2
        elif name=='request-parent':request['staging_root']=str(dest)
        elif name=='outside-snapshot':
            other=d/'other.csv';other.write_bytes(source.read_bytes());request['source']=str(other)
        elif name=='thread-zero':request['thread_limit']=0
        elif name=='thread-nine':request['thread_limit']=9
        elif name=='thread-env-mismatch':env['POLARS_MAX_THREADS']='3'
        elif name=='stale-length':request['source_length']+=1
        elif name=='stale-modified':request['source_modified_ns']+=1
        elif name=='existing-output':output.write_bytes(b'preserve-output')
        elif name=='existing-result':result_path.write_bytes(b'preserve-result')
        elif name=='unsupported-profile':
            request=copy.deepcopy(request);request['profile']['columns'][0]['failurePolicy']='asNull'
        rpath.write_text(json.dumps(request),encoding='utf8')
        arg=os.path.relpath(rpath,ROOT) if name=='relative-request' else str(rpath)
        run=subprocess.run([str(APP),'--data-viewer-internal-worker','csv-prepare-v1','--request',arg],
                           env=env,capture_output=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW)
        if name=='valid-control':
            okay=run.returncode==0 and output.exists() and json.loads(result_path.read_text())['nonce']==name
        else:
            okay=run.returncode!=0
            okay=okay and (output.read_bytes()==b'preserve-output' if name=='existing-output' else not output.exists())
            okay=okay and (result_path.read_bytes()==b'preserve-result' if name=='existing-result' else not result_path.exists())
        okay=okay and source.read_bytes()==b'c0\n1\n2\n'
        report['cases'].append({'id':name,'status':'PASS' if okay else 'FAIL','returnCode':run.returncode,'outputExists':output.exists()})
        print(name,report['cases'][-1]['status'],flush=True)
        if name=='valid-control' and not okay:raise RuntimeError('Worker valid control failed; environment is not a valid test')
    # Mutate only an owned COPY, never the shared source hardlinks used by UI tests.
    d=dest/'source-mutation';d.mkdir();source=d/'polars-source.snapshot.csv'
    original=OLD/'fixtures/high-5850000x15.csv';shutil.copyfile(original,source)
    initial=source.stat();request={'schema_version':1,'nonce':'mutation','source':str(source),'staging_root':str(d),
        'header_used':True,'profile':template['profile'],'resolved_targets':template['resolvedTargets'],
        'source_length':initial.st_size,'source_modified_ns':initial.st_mtime_ns,'thread_limit':8}
    rp=d/'polars-worker-request.json';rp.write_text(json.dumps(request),encoding='utf8')
    output=d/'prepared.parquet.partial';env=os.environ.copy();env['POLARS_MAX_THREADS']='8'
    process=subprocess.Popen([str(APP),'--data-viewer-internal-worker','csv-prepare-v1','--request',str(rp)],
                             env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    deadline=time.perf_counter()+15
    while not output.exists() and process.poll() is None and time.perf_counter()<deadline:time.sleep(0.005)
    assert output.exists() and process.poll() is None,'No active worker mutation window'
    with source.open('ab') as f:f.write(b'\r\n');f.flush();os.fsync(f.fileno())
    stdout,stderr=process.communicate(timeout=60)
    okay=process.returncode!=0 and not output.exists() and not (d/'polars-worker-result.json').exists()
    report['cases'].append({'id':'source-mutation','status':'PASS' if okay else 'FAIL','returnCode':process.returncode,
        'sourceBytesBefore':initial.st_size,'sourceBytesAfter':source.stat().st_size,'noPublishedOutput':not output.exists()})
    report['counts']={s:sum(c['status']==s for c in report['cases']) for s in ['PASS','FAIL']}
    (dest/'results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(json.dumps(report['counts']),flush=True)
if __name__=='__main__':main()
