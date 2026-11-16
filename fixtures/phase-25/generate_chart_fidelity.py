"""Generate sorted and scrambled versions of the Phase 25 sparse-chart fixture."""

from argparse import ArgumentParser
from contextlib import ExitStack
from hashlib import file_digest
from pathlib import Path
import csv
import json

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
ROWS = 1_000_000
BATCH = 32_768
SCHEMA = pa.schema([
    ("sequence", pa.int64()),
    ("x", pa.float64()),
    ("y", pa.float64()),
    ("category", pa.string()),
])


def observation(i: int) -> tuple[int, float, float, str]:
    if i == ROWS - 1:
        return i, 2_000.0, 100.0, "Rare group"
    if i >= ROWS - 3:
        return i, 1_000.0, 1_000.0, "Pair"
    return i, i / 10_000, (i * 7919 % 10_000) / 1_000, f"Group {i % 40:02}"


def write(output: Path, scrambled: bool) -> None:
    name = "fidelity-scrambled" if scrambled else "fidelity-sorted"
    with ExitStack() as stack:
        parquet = stack.enter_context(pq.ParquetWriter(output / f"{name}.parquet", SCHEMA))
        writer = None
        if scrambled:
            handle = stack.enter_context(
                (output / f"{name}.csv").open("w", encoding="utf-8", newline="")
            )
            writer = csv.writer(handle)
            writer.writerow(SCHEMA.names)
        for start in range(0, ROWS, BATCH):
            indices = range(start, min(start + BATCH, ROWS))
            values = [observation(i * 499_979 % ROWS if scrambled else i) for i in indices]
            arrays = [
                pa.array(column, field.type)
                for column, field in zip(zip(*values), SCHEMA)
            ]
            parquet.write_table(pa.Table.from_arrays(arrays, schema=SCHEMA))
            if writer is not None:
                writer.writerows(values)


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp" / "phase-25" / "fidelity-fixtures")
    output = parser.parse_args().output
    output.mkdir(parents=True, exist_ok=True)
    write(output, False)
    write(output, True)
    files = {}
    for name in ["fidelity-sorted.parquet", "fidelity-scrambled.parquet", "fidelity-scrambled.csv"]:
        with (output / name).open("rb") as handle:
            files[name] = file_digest(handle, "sha256").hexdigest()
    golden = {"rows": ROWS, "files": files, "rarePoint": [2_000, 100], "groupCount": 42}
    (output / "golden.json").write_text(json.dumps(golden, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(golden))


if __name__ == "__main__":
    main()
