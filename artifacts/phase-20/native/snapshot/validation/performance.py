"""Broader converter performance matrix; run only after builds/native functional tests stop."""
import argparse
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
EXP=HERE.parent
ROOT=EXP.parents[2]
OLD=ROOT/'artifacts/experiments/csv-engine-compare'
BASE=ROOT/'artifacts/optimizations/rust-thin-lto/thin1-csv-probe.exe'
NATIVE=EXP/'csv-native-parquet-validation.exe'
sys.path.insert(0,str(HERE))
import data_matrix as fixtures
spec=importlib.util.spec_from_file_location('performance_metrics',OLD/'run_benchmark.py')
metrics=importlib.util.module_from_spec(spec);spec.loader.exec_module(metrics)
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def save(p,x):p.write_text(json.dumps(x,indent=2)+'\n',encoding='utf8')

def prepare(folder):
    workloads=[{'id':'main-high','source':str(ROOT/'fixtures/phase-20/performance/main-high/high-5850000x15.csv'),
                'profile':str(ROOT/'fixtures/phase-20/performance/main-high/profile.json'),'rows':5850000,'repetitions':5}]
    for name,rows,width,low,long in [('low-cardinality',300000,15,True,False),
                                    ('numeric',300000,12,False,False),
                                    ('wide-65',65537,65,False,False),
                                    ('long-utf8',8192,7,False,True)]:
        d=folder/name;d.mkdir()
        kinds=([['int64','uint64','float64','boolean'][i%4] for i in range(width)] if name=='numeric'
               else [fixtures.KINDS[i%len(fixtures.KINDS)] for i in range(width)])
        source=d/'source.csv';profile=d/'profile.json'
        save(profile,fixtures.profile(kinds,True))
        with source.open('w',encoding='utf8',newline='') as f:
            w=csv.writer(f,lineterminator='\r\n');w.writerow([f'field_{i}' for i in range(width)])
            for row in range(rows):
                w.writerow([fixtures.field(row%16 if low else row,i,k,113,long) for i,k in enumerate(kinds)])
        workloads.append({'id':name,'source':str(source),'profile':str(profile),'rows':rows,'repetitions':3})
    for w in workloads:
        source=Path(w['source']);w.update(sourceBytes=source.stat().st_size,sourceSha256=sha(source),profileSha256=sha(Path(w['profile'])))
    return workloads

def main():
    p=argparse.ArgumentParser();p.add_argument('--label',default='final');p.add_argument('--prepare-only',action='store_true');a=p.parse_args()
    folder=HERE/'performance'/a.label
    if a.prepare_only:
        folder.mkdir(parents=True,exist_ok=False)
        workloads=prepare(folder);save(folder/'workloads.json',workloads)
        print(json.dumps([{k:w[k] for k in ['id','rows','sourceBytes','repetitions']} for w in workloads]),flush=True);return
    workloads=json.loads((folder/'workloads.json').read_text())
    report={'note':'Converter-only warmed OS cache; current binaries, all CPU timings retained. Main5 pairs, other workloads3 pairs. Native has8 Rayon workers plus parser/writer; Polars8 setting; total OS threads not equalized.',
            'binaries':{name:{'path':str(binary),'sha256':sha(binary)} for name,binary in [('polars',BASE),('native',NATIVE)]},
            'workloads':[]}
    for w in workloads:
        sample={**w,'runs':[],'verification':[]};report['workloads'].append(sample)
        for repetition in range(1,w['repetitions']+1):
            for name in (['polars','native'] if repetition%2 else ['native','polars']):
                output=folder/w['id']/f'{name}-{repetition}'/'prepared.parquet'
                r=metrics.run_one(BASE if name=='polars' else NATIVE,Path(w['source']),Path(w['profile']),output,name,8,1024,180)
                r.update(variant=name,repetition=repetition);sample['runs'].append(r);save(folder/'results.json',report)
                if r['returnCode']!=0:raise RuntimeError(r.get('error'))
                print(w['id'],name,repetition,round(r['converter']['totalMs'],2),round(r['cpu']['totalSeconds'],3),flush=True)
        reference=Path(next(r['output'] for r in sample['runs'] if r['variant']=='polars'))
        verified={}
        for i,r in enumerate(sample['runs']):
            output=Path(r['output']);digest=sha(output);r['outputSha256']=digest
            if digest not in verified:
                result=subprocess.run([str(BASE),'--csv-engine-verify',str(reference),str(output)],capture_output=True,timeout=300)
                if result.returncode:raise RuntimeError(result.stderr.decode(errors='replace')[-3000:])
                oracle=json.loads(result.stdout);assert oracle['equal'] and oracle['rows']==w['rows']
                if w['id']=='main-high':assert oracle['rowMajorSha256']=='b9dc8247ae85b8a871a2fdd13d47d54f5423d6fe494d685235fa84985ac64808'
                verified[digest]=oracle
                save(folder/w['id']/f'verify-{i}.json',oracle)
            sample['verification'].append({'run':i,'sha256':digest,'logicalSha256':verified[digest]['rowMajorSha256']})
        sample['sourceUnchanged']=sha(Path(w['source']))==w['sourceSha256'];assert sample['sourceUnchanged']
        sample['fullParity']=True;sample['aggregate']={}
        for name in ['polars','native']:
            rr=[r for r in sample['runs'] if r['variant']==name]
            values={'converterMs':[r['converter']['totalMs'] for r in rr],
                    'cpuSeconds':[r['cpu']['totalSeconds'] for r in rr],
                    'wallSeconds':[r['externalWallSeconds'] for r in rr],
                    'peakWorkingSetBytes':[r['memory']['osPeakWorkingSetBytes'] for r in rr],
                    'peakCommitBytes':[r['memory']['osPeakCommitBytes'] for r in rr],
                    'outputBytes':[r['converter']['outputBytes'] for r in rr]}
            sample['aggregate'][name]={k:{'median':statistics.median(v),'min':min(v),'max':max(v)} for k,v in values.items()}
        save(folder/'results.json',report)
    report['status']='PASS';save(folder/'results.json',report)
    print(json.dumps({'status':'PASS','workloads':[{ 'id':w['id'],'aggregate':w['aggregate']} for w in report['workloads']]},indent=2),flush=True)

if __name__=='__main__':main()
