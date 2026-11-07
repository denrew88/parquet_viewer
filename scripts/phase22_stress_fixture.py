"""Bounded-batch, deterministic stress input; no app caches or source files touched."""
import hashlib
import json
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

root = Path(__file__).resolve().parent.parent / '.tmp' / 'phase22-stress'
root.mkdir(parents=True, exist_ok=True)
target = root / 'stress.parquet'
n = 5_850_000
schema = pa.schema([('id', pa.int64()), ('bucket', pa.int64()), ('payload', pa.string())])
with pq.ParquetWriter(target, schema, compression='snappy', use_dictionary=False) as writer:
    for start in range(0, n, 65536):
        end = min(start + 65536, n)
        ids = range(start, end)
        writer.write_batch(pa.RecordBatch.from_arrays([
            pa.array(ids, type=pa.int64()),
            pa.array([i % 1000 for i in ids], type=pa.int64()),
            pa.array([hashlib.sha256(str(i).encode()).hexdigest() for i in ids]),
        ], schema=schema))
summary = {'rows': n, 'bytes': target.stat().st_size, 'path': str(target),
           'idSum': str(n * (n - 1) // 2), 'payloadBytes': 64}
(root / 'fixture.json').write_text(json.dumps(summary, indent=2), encoding='utf8')
print(json.dumps(summary))
