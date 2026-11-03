"""Seeded shape/batch/state matrix with an independent Python/PyArrow full-value oracle."""
import argparse
import copy
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import random
import struct
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
EXP=HERE.parent
ROOT=EXP.parents[2]
BASE=ROOT/'artifacts/optimizations/rust-thin-lto/thin1-csv-probe.exe'
NATIVE=Path(os.environ.get('CSV_NATIVE_TEST_EXE',str(EXP/'csv-native-parquet.exe')))
TEMPLATE=json.loads((ROOT/'artifacts/experiments/csv-engine-compare/fixtures/main-profile.json').read_text(encoding='utf-8-sig'))['profile']['columns'][0]
sys.path.insert(0,str(ROOT/'.tmp/hdf5-fixture-python'))
import pyarrow as pa
import pyarrow.parquet as pq

KINDS=['int64','uint64','float64','boolean','text','decimal','skip']
def profile(kinds,header):
    cols=[]
    for i,k in enumerate(kinds):
        c=copy.deepcopy(TEMPLATE); c.update(sourceIndex=i,sourceName=f'field_{i}',targetType=k)
        cols.append(c)
    return {'profile':{'mode':'custom','generation':1,'columns':cols},
            'resolvedTargets':[k for k in kinds if k!='skip'],'headerUsed':header}

def field(row,col,kind,seed,long=False):
    x=(row*131+col*17+seed)%101
    if x==0: return ''
    if x==1: return 'NULL'
    if x==2: return 'N/A'
    if kind in ['text','skip']:
        if long:
            return (f'한글😀,{row}:{col}"\r\n'+'x'*1024) * (1+(row%4))
        options=['plain','한글😀','comma,value','quote"value','line\nvalue','cr\rvalue','crlf\r\nvalue',' ']
        return options[x%len(options)]+f'-{row}-{col}'
    if kind=='boolean': return ['true','TRUE','1','false','FALSE','0','bad'][x%7]
    if kind=='decimal': return f'{row*1000000000000000001+col}.0012300'
    if x==3: return 'not-a-number'
    if kind=='int64':
        return [str(-(2**63)),str(2**63-1),str(2**63),str(2**53+1),str(-row*1009-col)][x%5]
    if kind=='uint64':
        return [str(2**64-1),str(2**64),'-1',str(2**53+1),str(row*1009+col)][x%5]
    return ['-0.0','0.0',repr(row/7.0+col),'1e-300','1e300'][x%5]

def typed(raw,kind):
    if kind in ['text','skip','decimal']: return raw,True
    if kind=='boolean':
        tokens={'true':True,'TRUE':True,'1':True,'false':False,'FALSE':False,'0':False}
        return tokens.get(raw),raw in tokens
    try:
        if kind=='float64': return float(raw),True
        value=int(raw,10)
        valid=(-(2**63)<=value<2**63) if kind=='int64' else (0<=value<2**64 and not raw.startswith('-'))
        return (value if valid else None),valid
    except ValueError: return None,False

def expected(row,kinds,seed,long=False):
    raw=[field(row,i,k,seed,long) for i,k in enumerate(kinds)]
    values=[]; states=[]
    for r,k in zip(raw,kinds):
        v,valid=typed(r,k)
        if k not in ['text','skip']: values.append(v)
        states.append(2 if r=='' else 0 if k=='skip' else 1 if r in ['NULL','N/A'] else 0 if valid else 3)
    words=[sum(s<<(2*lane) for lane,s in enumerate(states[i:i+32])) for i in range(0,len(states),32)]
    return [row]+raw+values+words

def names(kinds):
    return ['__dv_row_id']+[f'__dv_base_raw_{i}' for i in range(len(kinds))]+[
        f'__dv_value_{i}' for i,k in enumerate(kinds) if k not in ['text','skip']]+[
        f'__dv_state_word_{i}' for i in range((len(kinds)+31)//32)]

def equivalent(a,b):
    if isinstance(b,float):
        return isinstance(a,float) and (math.isnan(a) and math.isnan(b) or struct.pack('<d',a)==struct.pack('<d',b))
    return a==b and (b is None or isinstance(a,bool)==isinstance(b,bool))

def oracle(output,kinds,rows,seed,long):
    parquet=pq.ParquetFile(output)
    assert parquet.schema_arrow.names==names(kinds),parquet.schema_arrow
    assert parquet.metadata.num_rows==rows
    fields=parquet.schema_arrow
    expected_types=['uint64']+['string']*len(kinds)+[k if k!='decimal' else 'string' for k in kinds if k not in ['text','skip']]+['uint64']*((len(kinds)+31)//32)
    for f,k in zip(fields,expected_types):
        if k=='string': ok=pa.types.is_string(f.type) or pa.types.is_large_string(f.type) or pa.types.is_string_view(f.type)
        else: ok=str(f.type)=={'float64':'double','boolean':'bool'}.get(k,k)
        assert ok,(f,k)
    count=0; checked=0; digest=hashlib.sha256()
    # Bound decoded cells as well as rows; long strings use much smaller batches.
    batch_rows=8 if long else max(1,min(512,16384//len(fields)))
    for batch in parquet.iter_batches(batch_size=batch_rows):
        columns=[batch.column(i).to_pylist() for i in range(batch.num_columns)]
        for local in range(batch.num_rows):
            want=expected(count,kinds,seed,long)
            got=[c[local] for c in columns]
            for i,(a,b) in enumerate(zip(got,want)):
                if not equivalent(a,b): raise AssertionError(f'row={count} col={fields[i].name} got={a!r} expected={b!r}')
            digest.update(json.dumps(got,ensure_ascii=False,separators=(',',':'),allow_nan=True).encode())
            count+=1; checked+=len(want)
    assert count==rows
    return {'rows':count,'cells':checked,'physicalColumns':len(fields),'rowGroups':parquet.metadata.num_row_groups,'logicalSha256':digest.hexdigest()}

def matrix():
    out=[]
    for n in [0,1,65535,65536,65537]: out.append((f'rows-{n}',n,7,False,False,41))
    for width in [1,31,32,33,64,65,255,256]: out.append((f'width-{width}',257,width,False,False,83))
    out.extend([('no-header',1031,33,False,True,97),('long-utf8',129,7,True,False,113)])
    rng=random.Random(20261103)
    for i in range(64):
        out.append((f'random-{i:02}',rng.randrange(1,257),rng.randrange(1,18),False,bool(i%2),rng.randrange(100000)))
    return out

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--label',default='initial'); args=parser.parse_args()
    if not args.label.replace('-','').replace('_','').isalnum(): raise ValueError('invalid label')
    folder=HERE/'data'/args.label; folder.mkdir(parents=True,exist_ok=False)
    report={'label':args.label,'nativeBinary':str(NATIVE),'nativeSha256':hashlib.sha256(NATIVE.read_bytes()).hexdigest(),
            'note':'Functional matrix under possible concurrent validation load; elapsed times are not benchmark results.',
            'cases':[]}
    for label,rows,width,long,no_header,seed in matrix():
        case=folder/label; case.mkdir()
        kinds=[KINDS[i%len(KINDS)] for i in range(width)]
        source=case/'source.csv'; pp=case/'profile.json'
        pp.write_text(json.dumps(profile(kinds,not no_header)),encoding='utf8')
        with source.open('w',encoding='utf8',newline='') as f:
            writer=csv.writer(f,lineterminator='\r\n')
            if not no_header: writer.writerow([f'field_{i}' for i in range(width)])
            for row in range(rows): writer.writerow([field(row,i,k,seed,long) for i,k in enumerate(kinds)])
        before=hashlib.sha256(source.read_bytes()).hexdigest()
        result={'id':label,'rows':rows,'sourceColumns':width,'seed':seed,'engines':{}}
        for engine,binary in [('polars',BASE),('native',NATIVE)]:
            output=case/f'{engine}.parquet'; env=os.environ.copy(); env['POLARS_MAX_THREADS']='2'
            try:
                done=subprocess.run([str(binary),'--csv-engine-compare',engine,str(source),str(output),str(pp),'2','1024'],
                                    capture_output=True,env=env,timeout=60)
                observation={'returnCode':done.returncode,'stderr':done.stderr.decode(errors='replace')[-1500:]}
                if done.returncode==0:
                    try: observation.update(status='PASS',oracle=oracle(output,kinds,rows,seed,long))
                    except Exception as exc: observation.update(status='FAIL',error=str(exc))
                else: observation['status']='FAIL'
            except Exception as exc: observation={'status':'FAIL','error':repr(exc)}
            result['engines'][engine]=observation
        result['sourceUnchanged']=hashlib.sha256(source.read_bytes()).hexdigest()==before
        result['status']='PASS' if result['sourceUnchanged'] and all(v['status']=='PASS' for v in result['engines'].values()) else 'FAIL'
        report['cases'].append(result)
        report['counts']={s:sum(c['status']==s for c in report['cases']) for s in ['PASS','FAIL']}
        (folder/'results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
        print(label,result['status'],flush=True)
    print(json.dumps(report['counts']),flush=True)

if __name__=='__main__': main()
