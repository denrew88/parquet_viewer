"""Independent focused lexical/profile/file-fault tests. No product edits or rebuilds."""
import argparse
import copy
import csv
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[4]
EXPERIMENT=HERE.parents[1]
NATIVE=Path(os.environ.get('CSV_NATIVE_TEST_EXE',str(EXPERIMENT/'csv-native-parquet.exe'))).resolve()
BASE=ROOT/'artifacts/optimizations/rust-thin-lto/thin1-csv-probe.exe'
TEMPLATE=json.loads((ROOT/'artifacts/experiments/csv-engine-compare/fixtures/main-profile.json').read_text(encoding='utf-8-sig'))['profile']['columns'][0]
sys.path.insert(0,str(ROOT/'.tmp/hdf5-fixture-python'))
import pyarrow.parquet as pq

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def profile(targets, header=True):
    cols=[]
    for i,t in enumerate(targets):
        c=copy.deepcopy(TEMPLATE); c.update(sourceIndex=i,sourceName=f'c{i}',targetType=t)
        cols.append(c)
    return {'profile':{'mode':'custom','generation':1,'columns':cols},
            'resolvedTargets':[t for t in targets if t!='skip'],'headerUsed':header}

def content(rows, header=True, width=None):
    f=io.StringIO(newline=''); w=csv.writer(f,lineterminator='\r\n')
    if header: w.writerow([f'c{i}' for i in range(width or len(rows[0]))])
    w.writerows(rows); return f.getvalue().encode('utf8')

def cases():
    result=[]
    def add(name,data,p,kind='parity',reason=None): result.append({'id':name,'data':data,'profile':p,'kind':kind,'reason':reason})
    for name,data,header in [
        ('bom-quoted-first-newline',b'\xef\xbb\xbf"\n",1\r\n"x",2\r\n',False),
        ('bom-quoted-first-escaped',b'\xef\xbb\xbf"a,""b"",c",1\r\n"x",2\r\n',False),
        ('bom-quoted-header',b'\xef\xbb\xbf"c\n0",c1\r\n"a",1\r\n',True),
        ('double-bom-noheader',b'\xef\xbb\xbf\xef\xbb\xbfalpha,1\r\nbeta,2\r\n',False),
        ('cr-only',b'c0,c1\r1,2\r3,4\r',True),
        ('blank-lines',b'c0\n\n1\n\n2\n\n',True),
        ('quoted-empty-one-column',b'c0\n""\n"a"\n""\n',True),
        ('no-final-newline',b'c0,c1\n"x",1',True),
        ('extra-blank-header',b'\n\nc0,c1\n"x",1\n',True),
    ]:
        width=1 if name in ['blank-lines','quoted-empty-one-column'] else 2
        add(name,data,profile(['text']*width,header))
    strings=['+0','-0','+1','01',' 1','1 ','\t1','1\n','1_000','0x10',
             '9223372036854775807','9223372036854775808','-9223372036854775808','-9223372036854775809',
             '18446744073709551615','18446744073709551616','+18446744073709551615','-00','NULL','N/A','']
    for t in ['int64','uint64']:
        add(f'{t}-lexical',content([[s] for s in strings]),profile([t]))
    floats=['0','-0','+0','-0.0','1e-4000','-1e-4000','1e4000','-1e4000','NaN','nan','NAN','-NaN','+NaN',
            'Inf','inf','INF','Infinity','infinity','-inf','+inf',' 1.5','1.5 ','\t1.5','1_000.2','0x1p2','.5','1.','NULL','N/A','']
    add('float-lexical',content([[s] for s in floats]),profile(['float64']))
    add('quote-read-boundary',content([['x'*(256*1024-10)+'"\r\ny','1'],['z','2']]),profile(['text','int64']))
    p=profile(['int64']); p['profile']['mode']='auto'; p['profile']['columns'][0]['targetType']='auto'
    add('source-auto-resolved-int64',b'c0\n1\n2\n',p)
    for name,data in [('unterminated',b'c0\n"bad\n'),('trailing-after-quote',b'c0\n"a"x\n'),
                      ('invalid-utf8',b'c0\n\xff\n'),('inconsistent-width',b'c0\n1,2\n'),
                      ('header-only-mismatched-width',b'c0,c1\n')]:
        add(name,data,profile(['text']),'reject-input')
    for field,value in [('trim',True),('nullTokens',['nil']),('trueTokens',['yes']),
                        ('decimalSeparator',','),('thousandSeparator','.'),
                        ('failurePolicy','fail'),('failurePolicy','asNull'),('failurePolicy','bogus'),
                        ('timezonePolicy','bogus'),('timezonePolicy','fixedOffset'),
                        ('timezoneOffsetMinutes',60),('durationUnit','ns'),
                        ('durationInputFormat','daysClock'),('temporalFormats',['%Y'])]:
        p=profile(['int64']); p['profile']['columns'][0][field]=value
        add(f'profile-{field}-{str(value)}',b'c0\nbad\n',p,'reject-profile',f'outside default admitted profile: {field}={value}')
    for name,mutate in [
        ('resolved-skip',lambda p:p.update(resolvedTargets=['skip'])),
        ('resolved-auto',lambda p:p.update(resolvedTargets=['auto'])),
        ('missing-resolved',lambda p:p.update(resolvedTargets=[])),
        ('extra-resolved',lambda p:p.update(resolvedTargets=['int64','int64'])),
        ('noncontiguous-index',lambda p:p['profile']['columns'][0].update(sourceIndex=2)),
        ('zero-columns',lambda p:(p['profile'].update(columns=[]),p.update(resolvedTargets=[]))),
    ]:
        p=profile(['int64']); mutate(p); add(f'profile-{name}',b'c0\n1\n',p,'reject-profile')
    return result

def limits(destination):
    folder=destination/'record-limits'; folder.mkdir()
    pp=folder/'profile.json'; pp.write_text(json.dumps(profile(['text'],False)),encoding='utf8')
    metric_path=ROOT/'artifacts/experiments/csv-engine-compare/run_benchmark.py'
    spec=importlib.util.spec_from_file_location('quality_metrics',metric_path)
    metrics=importlib.util.module_from_spec(spec); spec.loader.exec_module(metrics)
    results=[]
    for name,megabytes,quoted in [('unterminated-32m',32,True),('unterminated-128m',128,True),
                                  ('unquoted-128m',128,False),('decoded-over-8m',8,False)]:
        d=folder/name; d.mkdir(); source=d/'input.csv'
        with source.open('wb') as f:
            if quoted: f.write(b'"')
            for _ in range(megabytes): f.write(b'x'*(1024*1024))
            if name=='decoded-over-8m': f.write(b'x\n')
        before=sha(source)
        output=d/'output'/'native.parquet'
        actual=metrics.run_one(NATIVE,source,pp,output,'native',2,1024,20)
        error=actual.get('error','')
        expected='record byte limit exceeded' if name=='decoded-over-8m' else 'raw record byte limit exceeded'
        peak=actual['memory']['osPeakCommitBytes']
        passed=(actual['returnCode']!=0 and expected in error and peak<128*1024*1024
                and not output.exists() and not output.with_suffix('.parquet.partial').exists()
                and sha(source)==before)
        results.append({'id':f'limit-{name}','status':'PASS' if passed else 'FAIL',
                        'sourceBytes':source.stat().st_size,'sourceSha256':before,
                        'peakCommitCeilingBytes':128*1024*1024,'expectedError':expected,'actual':actual})
        print(results[-1]['id'],results[-1]['status'],f'peakCommit={peak}',flush=True)
    return results

def faults(destination):
    folder=destination/'file-faults'; folder.mkdir()
    source=folder/'source.csv'; source.write_bytes(b'c0\n1\n2\n')
    pp=folder/'profile.json'; pp.write_text(json.dumps(profile(['int64'])),encoding='utf8')
    source_hash=sha(source); results=[]
    for name in ['existing-final','existing-partial','source-alias','output-directory','partial-directory','missing-parent']:
        out=folder/f'{name}.parquet'; partial=out.with_suffix('.parquet.partial'); sentinel=b'unchanged-sentinel'
        if name=='existing-final': out.write_bytes(sentinel)
        elif name=='existing-partial': partial.write_bytes(sentinel)
        elif name=='source-alias': out=source; partial=out.with_suffix('.parquet.partial')
        elif name=='output-directory': out.mkdir()
        elif name=='partial-directory': partial.mkdir()
        elif name=='missing-parent': out=folder/'absent'/'out.parquet'; partial=out.with_suffix('.parquet.partial')
        actual=run_one(NATIVE,'native',source,out,pp)
        intact=sha(source)==source_hash
        if name=='existing-final': intact=intact and out.read_bytes()==sentinel
        elif name=='existing-partial': intact=intact and partial.read_bytes()==sentinel
        elif name=='output-directory': intact=intact and out.is_dir()
        elif name=='partial-directory': intact=intact and partial.is_dir()
        else: intact=intact and not partial.exists()
        passed=actual.get('returnCode',0)!=0 and intact
        item={'id':f'fault-{name}','status':'PASS' if passed else 'FAIL','actual':actual,'sentinelsIntact':intact}
        results.append(item); print(item['id'],item['status'],flush=True)
    return results

def run_one(exe,engine,source,out,p):
    env=os.environ.copy(); env['POLARS_MAX_THREADS']='2'
    started=time.perf_counter()
    try:
        r=subprocess.run([str(exe),'--csv-engine-compare',engine,str(source),str(out),str(p),'2','1024'],
                         capture_output=True,env=env,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        value={'returnCode':r.returncode,'stdout':r.stdout.decode('utf8',errors='replace'),
               'stderr':r.stderr.decode('utf8',errors='replace'),'wallSeconds':time.perf_counter()-started,
               'finalExists':out.exists(),'partialExists':out.with_suffix('.parquet.partial').exists()}
        return value
    except (OSError,subprocess.TimeoutExpired) as e:
        return {'launchOrTimeout':str(e),'wallSeconds':time.perf_counter()-started}

def normalize(v):
    if isinstance(v,float): return 'NaN' if math.isnan(v) else ('floatbits',struct.pack('<d',v).hex())
    return v
def decoded(p): return {k:[normalize(v) for v in vs] for k,vs in pq.read_table(p).to_pydict().items()}

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--label',default='initial'); parser.add_argument('--only',default=''); parser.add_argument('--faults-only',action='store_true'); parser.add_argument('--limits-only',action='store_true')
    args=parser.parse_args(); destination=HERE/'runs'/args.label; destination.mkdir(parents=True,exist_ok=False)
    report={'label':args.label,'binary':{'path':str(NATIVE),'sha256':sha(NATIVE)},
            'baselineSha256':sha(BASE),'cases':[]}
    if args.limits_only:
        report['cases']=limits(destination)
        report['counts']={s:sum(x['status']==s for x in report['cases']) for s in ['PASS','FAIL','BLOCKED']}
        (destination/'results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
        print(json.dumps(report['counts']),flush=True); return
    if args.faults_only:
        report['cases']=faults(destination)
        report['counts']={s:sum(x['status']==s for x in report['cases']) for s in ['PASS','FAIL','BLOCKED']}
        (destination/'results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
        print(json.dumps(report['counts']),flush=True); return
    for index,c in enumerate(cases()):
        if args.only and args.only not in c['id']: continue
        d=destination/f'{index:02d}'; d.mkdir(); source=d/'input.csv'; pp=d/'profile.json'
        source.write_bytes(c['data']); pp.write_text(json.dumps(c['profile']),encoding='utf8'); source_sha=sha(source)
        native=run_one(NATIVE,'native',source,d/'native.parquet',pp)
        item={'id':c['id'],'kind':c['kind'],'reason':c['reason'],'directory':str(d),'native':native}
        if c['kind']=='parity':
            baseline=run_one(BASE,'polars',source,d/'polars.parquet',pp); item['polars']=baseline
            if native.get('returnCode')==baseline.get('returnCode')==0:
                left,right=decoded(d/'polars.parquet'),decoded(d/'native.parquet')
                item['status']='PASS' if left==right else 'FAIL'
                if left!=right:
                    item['differences']={k:{'polars':left.get(k),'native':right.get(k)} for k in set(left)|set(right) if left.get(k)!=right.get(k)}
            elif 'error 5' in native.get('stderr','') or 'os error 5' in native.get('stderr',''):
                item['status']='BLOCKED'
            else: item['status']='FAIL'; item['difference']='conversion outcome differs or valid fixture rejected'
        else:
            if 'os error 5' in native.get('stderr',''): item['status']='BLOCKED'
            else: item['status']='PASS' if native.get('returnCode',0)!=0 and not native.get('finalExists',False) and not native.get('partialExists',False) else 'FAIL'
        item['sourceUnchanged']=sha(source)==source_sha
        if not item['sourceUnchanged']: item['status']='FAIL'
        report['cases'].append(item)
        report['counts']={s:sum(x['status']==s for x in report['cases']) for s in ['PASS','FAIL','BLOCKED']}
        (destination/'results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
        print(c['id'],item['status'],flush=True)
    print(json.dumps(report['counts']),flush=True)

if __name__=='__main__': main()
