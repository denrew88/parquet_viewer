"""Generate bounded-memory inputs for Phase 25 SQL result and source browsing gates."""

from argparse import ArgumentParser
from hashlib import file_digest
from pathlib import Path
import json

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
ROWS = 1_000_257
BATCH = 32_768
LARGE_BASE = 9_007_199_254_740_993
TIME_BASE = 1_704_067_200_123_456_789
PADDING = "retained-sql-selection-payload-" + "x" * 36
SCHEMA = pa.schema([
    ("id", pa.int64()),
    ("value", pa.int64()),
    ("category", pa.string()),
    ("padding", pa.string()),
    ("large_id", pa.int64()),
    ("observed_at", pa.timestamp("ns")),
    ("nullable_text", pa.string()),
    ("extra_a", pa.int32()),
    ("extra_b", pa.int32()),
    ("extra_c", pa.int32()),
    ("tail_marker", pa.string()),
])


def value_sum(rows: int) -> int:
    cycles, remainder = divmod(rows, 100)
    return cycles * 4_950 + remainder * (remainder - 1) // 2


def generate(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    file = output / "sql-scale.parquet"
    with pq.ParquetWriter(file, SCHEMA, compression="snappy") as writer:
        for start in range(0, ROWS, BATCH):
            ids = list(range(start, min(start + BATCH, ROWS)))
            columns = [
                ids,
                [i % 100 for i in ids],
                ["ABCD"[i % 4] for i in ids],
                [PADDING for _ in ids],
                [LARGE_BASE + i for i in ids],
                [TIME_BASE + i for i in ids],
                [None if i % 7 == 0 else "" if i % 7 == 1 else "한글 " + str(i) for i in ids],
                [i % 11 for i in ids],
                [i % 13 for i in ids],
                [i % 17 for i in ids],
                ["LAST-SOURCE-ROW" if i == ROWS - 1 else "row-" + str(i) for i in ids],
            ]
            arrays = [pa.array(values, type=field.type) for values, field in zip(columns, SCHEMA)]
            writer.write_table(pa.Table.from_arrays(arrays, schema=SCHEMA), row_group_size=BATCH)
    with file.open("rb") as handle:
        digest = file_digest(handle, "sha256").hexdigest()
    golden = {
        "rows": ROWS,
        "columns": SCHEMA.names,
        "lastId": ROWS - 1,
        "lastMarker": "LAST-SOURCE-ROW",
        "valueSum": value_sum(ROWS),
        "largeBase": str(LARGE_BASE),
        "timeBaseNs": str(TIME_BASE),
        "paddingUtf8Bytes": len(PADDING.encode("utf-8")),
        "selectionPayloadBytes": len(PADDING.encode("utf-8")) * ROWS,
        "file": file.name,
        "sha256": digest,
    }
    (output / "golden.json").write_text(json.dumps(golden, indent=2) + "\n", encoding="utf-8")
    return golden


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp" / "phase-25" / "sql-scale" / "fixtures")
    print(json.dumps(generate(parser.parse_args().output)))


if __name__ == "__main__":
    main()
