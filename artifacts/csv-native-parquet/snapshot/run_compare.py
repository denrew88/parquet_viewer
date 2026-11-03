"""Isolated csv + polars-parquet / unchanged product Polars A/B and full output oracle."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OLD = ROOT / 'artifacts/experiments/csv-engine-compare'
BASE = ROOT / 'artifacts/optimizations/rust-thin-lto/thin1-csv-probe.exe'
NATIVE = HERE / 'csv-native-parquet.exe'
spec = importlib.util.spec_from_file_location('metrics', OLD / 'run_benchmark.py')
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()

def save(name, data):
    (HERE / name).write_text(json.dumps(data, indent=2) + '\n', encoding='utf8')

def run(variant, source, profile, label, threads=8):
    destination = HERE / f'outputs/{label}/{variant}/prepared.parquet'
    attempt = 1
    while destination.parent.exists():
        attempt += 1
        destination = HERE / f'outputs/{label}/{variant}-attempt{attempt}/prepared.parquet'
    result = metrics.run_one(BASE if variant == 'polars' else NATIVE, source, profile,
                             destination,
                             variant, threads, 1024, 180)
    print(f"{label} {variant} t{threads}: exit={result['returnCode']} "
          f"ms={result.get('converter',{}).get('totalMs')} "
          f"cpu={result['cpu']['totalSeconds']}", flush=True)
    return result

def verify(left, right, label):
    completed = subprocess.run([str(BASE), '--csv-engine-verify', str(left), str(right)],
                               capture_output=True, timeout=300)
    if completed.returncode:
        raise RuntimeError(completed.stderr.decode(errors='replace')[-3500:])
    result = json.loads(completed.stdout)
    save(f'verify-{label}.json', result)
    if not result['equal']:
        raise RuntimeError(f'{label} decoded output mismatch: {result}')
    return result

def cli(source, output, profile, env=None):
    return subprocess.run([str(NATIVE), '--csv-engine-compare', 'native', str(source),
                           str(output), str(profile), '2', '1024'], env=env,
                          capture_output=True, timeout=30)

def smoke():
    results = {}
    outputs = {}
    source, profile = OLD / 'fixtures/edge-65537x33.csv', OLD / 'fixtures/edge-profile.json'
    for v in ['polars','native']:
        saved = HERE / f'edge-{v}.json'
        result = (json.loads(saved.read_text(encoding='utf8')) if v=='polars' and saved.exists()
                  else run(v, source, profile, 'edge'))
        save(f'edge-{v}.json',result)
        if result['returnCode']:
            raise RuntimeError(result.get('error'))
        outputs[v] = Path(result['output'])
    results['edge'] = verify(outputs['polars'], outputs['native'],'edge')
    tests = HERE / 'outputs/smoke'
    tests.mkdir(parents=True, exist_ok=False)
    main_profile = json.loads((OLD/'fixtures/main-profile.json').read_text(encoding='utf-8-sig'))
    p = copy.deepcopy(main_profile)
    p['profile']['columns'] = p['profile']['columns'][:1]
    p['resolvedTargets'] = ['int64']
    pp = tests / 'profile.json'
    pp.write_text(json.dumps(p),encoding='utf8')
    for name, content in [('width', b'a\n1,2\n'), ('quote', b'a\n"unclosed\r\n'),
                           ('utf8', b'a\n\xff\n')]:
        f = tests/f'{name}.csv'; f.write_bytes(content)
        out = tests/f'{name}.parquet'
        r = cli(f,out,pp)
        results[name] = {'returnCode':r.returncode,'stderr':r.stderr.decode(errors='replace'),
                         'noFinal':not out.exists(),'noPartial':not out.with_suffix('.parquet.partial').exists()}
        assert r.returncode and results[name]['noFinal'] and results[name]['noPartial'], results[name]
    valid = tests/'valid.csv'; valid.write_bytes(b'a\n00123\nabc\nNULL\n\n-1\n')
    digest = sha(valid)
    out = tests/'exists.parquet'; out.write_bytes(b'keep')
    r=cli(valid,out,pp)
    assert r.returncode and out.read_bytes()==b'keep'
    results['overwriteBlocked']=True
    marker=tests/'cancel'; marker.touch()
    env=os.environ.copy(); env['CSV_NATIVE_CANCEL_FILE']=str(marker)
    out=tests/'cancel.parquet'; r=cli(valid,out,pp,env)
    assert r.returncode and not out.exists() and not out.with_suffix('.parquet.partial').exists()
    results['cancellationBeforeStart']=True
    bad=copy.deepcopy(p); bad['profile']['columns'][0]['trim']=True
    badp=tests/'unsupported.json'; badp.write_text(json.dumps(bad),encoding='utf8')
    out=tests/'unsupported.parquet'; r=cli(valid,out,badp)
    assert r.returncode and not out.exists()
    results['unsupportedProfileRejected']=True
    assert sha(valid)==digest
    results['sourceUnchanged']=True
    save('10-smoke.json',results)
    print('SMOKE_ALL_PASS',flush=True)

def benchmark(runs):
    source=OLD/'fixtures/high-5850000x15.csv'
    profile=OLD/'fixtures/main-profile.json'
    report={'source':str(source),'sourceBytes':source.stat().st_size,'sourceSha256':sha(source),
            'profileSha256':sha(profile),'runsPerVariant':runs,'threadSetting':8,
            'scope':'Warmed-cache converter incl sync, not product prepass/index/cache publish/GUI. Native has a sequential parser, 8 Rayon workers and a writer; Polars setting is POLARS_MAX_THREADS=8; exact total OS threads are not equalized.',
            'binaries':{v:{'sha256':sha(p),'bytes':p.stat().st_size} for v,p in [('polars',BASE),('native',NATIVE)]},'runs':[]}
    for repeat in range(1,runs+1):
        for v in (['polars','native'] if repeat%2 else ['native','polars']):
            result=run(v,source,profile,f'main-r{repeat}')
            result.update(variant=v,repeat=repeat)
            report['runs'].append(result); save('30-results.json',report)
            if result['returnCode']:
                raise RuntimeError(result.get('error'))
    reference=next(Path(r['output']) for r in report['runs'] if r['variant']=='polars')
    verified={}
    report['verification']=[]
    expected=json.loads((OLD/'main-v1-verify-8t-r1.json').read_text(encoding='utf-8-sig'))['rowMajorSha256']
    for i,r in enumerate(report['runs']):
        output=Path(r['output']); digest=sha(output); r['outputSha256']=digest
        if digest not in verified:
            oracle=verify(reference,output,f'main-{i}')
            assert oracle['rows']==5_850_000 and oracle['rowMajorSha256']==expected
            verified[digest]=oracle
        report['verification'].append({'runIndex':i,'outputSha256':digest,
                                        'oracle':verified[digest] if i<2 else 'same byte hash as a fully verified output'})
        save('30-results.json',report)
    report['exactResultParity']=True
    report['sourceUnchanged']=sha(source)==report['sourceSha256']
    assert report['sourceUnchanged']
    report['aggregate']={}
    for v in ['polars','native']:
        rr=[r for r in report['runs'] if r['variant']==v]
        values={'converterMs':[r['converter']['totalMs'] for r in rr],
                'cpuSeconds':[r['cpu']['totalSeconds'] for r in rr],
                'wallSeconds':[r['externalWallSeconds'] for r in rr],
                'peakWorkingSetBytes':[r['memory']['osPeakWorkingSetBytes'] for r in rr],
                'peakCommitBytes':[r['memory']['osPeakCommitBytes'] for r in rr],
                'outputBytes':[r['converter']['outputBytes'] for r in rr]}
        report['aggregate'][v]={k:{'median':statistics.median(x),'min':min(x),'max':max(x)} for k,x in values.items()}
    save('30-results.json',report)
    print(json.dumps({'exactResultParity':True,'aggregate':report['aggregate']},indent=2),flush=True)

def extra():
    report=json.loads((HERE/'30-results.json').read_text(encoding='utf8'))
    source=OLD/'fixtures/high-5850000x15.csv'; profile=OLD/'fixtures/main-profile.json'
    expected=next(r['outputSha256'] for r in report['runs'] if r['variant']=='native')
    results={'diagnostics':[], 'note':'Single diagnostic sample per thread count; not repeated performance statistics. Native threads are Rayon workers plus parser/writer.'}
    for threads in [1,4]:
        r=run('native',source,profile,f'diagnostic-t{threads}',threads)
        assert r['returnCode']==0, r
        r['outputSha256']=sha(Path(r['output']))
        assert r['outputSha256']==expected
        results['diagnostics'].append(r)
    tests=HERE/'outputs/extra'; tests.mkdir(parents=True,exist_ok=False)
    main=json.loads(profile.read_text(encoding='utf-8-sig'))
    p=copy.deepcopy(main); p['profile']['columns']=p['profile']['columns'][:1]; p['resolvedTargets']=['int64']
    pp=tests/'profile.json'; pp.write_text(json.dumps(p),encoding='utf8')
    valid=tests/'valid.csv'; valid.write_bytes(b'a\n1\n')
    # Never delete an existing partial file owned by a different invocation.
    out=tests/'existing-partial.parquet'; partial=out.with_suffix('.parquet.partial'); partial.write_bytes(b'keep-partial')
    r=cli(valid,out,pp); assert r.returncode and partial.read_bytes()==b'keep-partial' and not out.exists()
    results['existingPartialPreserved']=True
    huge=tests/'huge.csv'; huge.write_bytes(b'a\n'+b'x'*(8*1024*1024+1)+b'\n')
    out=tests/'huge.parquet'; r=cli(huge,out,pp)
    assert r.returncode and not out.exists() and not out.with_suffix('.parquet.partial').exists()
    results['recordLimitRejected']=True
    empty=tests/'header-only.csv'; empty.write_bytes(b'a\n')
    out=tests/'header-only.parquet'; r=cli(empty,out,pp)
    assert r.returncode==0 and json.loads(r.stdout)['rows']==0
    results['headerOnly']=True
    # Cooperatively cancel an actively parsing/encoding MAIN conversion.
    marker=tests/'cancel'; env=os.environ.copy(); env['CSV_NATIVE_CANCEL_FILE']=str(marker)
    out=tests/'active-cancel.parquet'
    command=[str(NATIVE),'--csv-engine-compare','native',str(source),str(out),str(profile),'8','1024']
    process=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    deadline=time.perf_counter()+15
    while not out.with_suffix('.parquet.partial').exists() and process.poll() is None and time.perf_counter()<deadline:
        time.sleep(0.01)
    assert process.poll() is None
    time.sleep(0.15)
    requested=time.perf_counter(); marker.touch()
    stdout,stderr=process.communicate(timeout=10)
    latency=time.perf_counter()-requested
    assert process.returncode and not out.exists() and not out.with_suffix('.parquet.partial').exists()
    results['activeCancellation']={'returnCode':process.returncode,'latencySeconds':latency,
                                   'stderr':stderr.decode(errors='replace'),'noFinalOrPartial':True}
    save('12-extra.json',results)
    print(json.dumps({'extra':'PASS','activeCancelSeconds':latency},indent=2),flush=True)

def cleanup():
    report= json.loads((HERE/'30-results.json').read_text(encoding='utf8'))
    extra_report=json.loads((HERE/'12-extra.json').read_text(encoding='utf8'))
    assert report['exactResultParity'] and report['sourceUnchanged']
    allowed=(HERE/'outputs').resolve()
    retained={}; removed=[]
    for r in report['runs']+extra_report['diagnostics']:
        p=Path(r['output']).resolve()
        if not p.is_relative_to(allowed) or p.suffix!='.parquet':
            raise RuntimeError(f'Refusing cleanup outside owned outputs: {p}')
        digest=r['outputSha256']
        if digest not in retained:
            assert p.is_file() and sha(p)==digest
            retained[digest]=str(p); r['outputRetained']=True
        else:
            if p.exists():
                assert sha(p)==digest
                size=p.stat().st_size; p.unlink()
                removed.append({'path':str(p),'bytes':size,'sha256':digest,'identicalRetainedOutput':retained[digest]})
            r['outputRetained']=False
            r['identicalRetainedOutput']=retained[digest]
    save('30-results.json',report); save('12-extra.json',extra_report)
    save('45-cleanup.json',{'retained':retained,'removed':removed,'removedBytes':sum(r['bytes'] for r in removed)})
    print(json.dumps({'retainedOutputs':len(retained),'removedDuplicateOutputs':len(removed),
                      'removedBytes':sum(r['bytes'] for r in removed)}),flush=True)

def size_smoke():
    import shutil
    binary=HERE/'native-product-size.exe'
    # Exercise the full app's existing internal worker entry, not the standalone converter CLI.
    staging=HERE/'outputs/size-worker-edge'; staging.mkdir(parents=True,exist_ok=False)
    source=staging/'polars-source.snapshot.csv'
    shutil.copy2(OLD/'fixtures/edge-65537x33.csv',source)
    source_hash=sha(source)
    profile=json.loads((OLD/'fixtures/edge-profile.json').read_text(encoding='utf-8-sig'))
    request={'schema_version':1,'nonce':'isolated-size-worker-smoke','source':str(source),
             'staging_root':str(staging),'header_used':profile['headerUsed'],
             'profile':profile['profile'],'resolved_targets':profile['resolvedTargets'],
             'source_length':source.stat().st_size,'source_modified_ns':source.stat().st_mtime_ns,
             'thread_limit':8}
    request_path=staging/'polars-worker-request.json'
    request_path.write_text(json.dumps(request),encoding='utf8')
    env=os.environ.copy(); env['POLARS_MAX_THREADS']='8'
    result=subprocess.run([str(binary),'--data-viewer-internal-worker','csv-prepare-v1',
                           '--request',str(request_path)],env=env,capture_output=True,timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace'))
    worker=json.loads((staging/'polars-worker-result.json').read_text(encoding='utf8'))
    output=staging/'prepared.parquet.partial'
    assert worker['nonce']==request['nonce'] and worker['physical_columns']==43 and output.stat().st_size==worker['output_bytes']
    baseline=Path(json.loads((HERE/'edge-polars.json').read_text(encoding='utf8'))['output'])
    oracle=verify(baseline,output,'size-worker-edge')
    assert oracle['rows']==65537 and sha(source)==source_hash
    save('63-size-worker-smoke.json',{'status':'PASS','binarySha256':sha(binary),
                                     'workerResult':worker,'fullParity':True,'sourceUnchanged':True,
                                     'scope':'Existing full-app worker invocation, EDGE default admitted profile. No GUI/cache/session full regression claim.'})
    print('FULL_APP_WORKER_EDGE_PARITY_PASS',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--stage',choices=['smoke','benchmark','all','extra','cleanup','size-smoke','quality-matrix','quality-limits','quality-faults','validation-matrix','validation-performance'],required=True)
    parser.add_argument('--label',default='initial')
    parser.add_argument('--validation-binary',action='store_true')
    parser.add_argument('--runs',type=int,default=5); args=parser.parse_args()
    if args.stage in ['smoke','all']: smoke()
    if args.stage in ['benchmark','all']: benchmark(args.runs)
    if args.stage=='extra': extra()
    if args.stage=='cleanup': cleanup()
    if args.stage=='size-smoke': size_smoke()
    if args.stage=='validation-performance':
        import runpy
        import sys
        script=HERE/'validation/performance.py'
        sys.argv=[str(script),'--label',args.label]
        runpy.run_path(str(script),run_name='__main__')
    if args.stage in ['quality-matrix','quality-limits','quality-faults','validation-matrix']:
        import runpy
        import sys
        if args.validation_binary:
            os.environ['CSV_NATIVE_TEST_EXE']=str(HERE/'csv-native-parquet-validation.exe')
        script=HERE/('validation/data_matrix.py' if args.stage=='validation-matrix' else 'validation/quality/quality_matrix.py')
        sys.argv=[str(script),'--label',args.label]
        if args.stage=='quality-limits': sys.argv.append('--limits-only')
        if args.stage=='quality-faults': sys.argv.append('--faults-only')
        runpy.run_path(str(script),run_name='__main__')
