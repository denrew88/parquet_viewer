"""Small typed JOIN inputs; no CSV inference, cache writes or SQL engine."""
import hashlib
import json
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

root = Path(__file__).resolve().parent
tables = {
    "orders.parquet": pa.table({
        "주문 번호": pa.array([101,102,103,104], type=pa.int64()),
        "고객 번호": pa.array([1,2,None,3], type=pa.int64()),
        "id": pa.array([11,12,13,14], type=pa.int64()),
    }),
    "customers.parquet": pa.table({
        "고객 번호": pa.array([1,2,2,None], type=pa.int64()),
        "고객명": ["Alice","Bob","Betty","No ID"],
        "id": pa.array([21,22,23,24], type=pa.int64()),
    }),
}
files=[]
for name, table in tables.items():
    file=root/name
    pq.write_table(table,file,compression="snappy",row_group_size=2)
    reread=pq.read_table(file)
    assert reread.equals(table)
    files.append({"file":name,"rows":table.num_rows,"bytes":file.stat().st_size,"sha256":hashlib.sha256(file.read_bytes()).hexdigest()})
left=tables["orders.parquet"].to_pydict();right=tables["customers.parquet"].to_pydict()
matches=[(oid,name) for oid,key in zip(left["주문 번호"],left["고객 번호"]) for other,name in zip(right["고객 번호"],right["고객명"]) if key is not None and key==other]
assert matches==[(101,"Alice"),(102,"Bob"),(102,"Betty")]
report={"status":"PASS","files":files,"innerJoinRows":3,"matches":matches,"purpose":"Matching original Korean key with different physical positions; generic id is deliberately unrelated."}
(root/"manifest.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps(report,ensure_ascii=False))
