"""Generate deterministic Phase 7 benchmark and hostile-input fixtures."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


SEED = 20260714
REVISION = "phase7-v1"
PROFILES = {
    "gate": {"small_rows": 10_000, "large_rows": 250_000, "small_cols": 20, "large_cols": 40},
    "release": {
        "small_rows": 10_000,
        "large_rows": 5_000_000,
        "small_cols": 20,
        "large_cols": 40,
    },
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parquet_batch(start: int, count: int, columns: int) -> pa.RecordBatch:
    values: dict[str, pa.Array] = {}
    for column in range(columns):
        kind = column % 7
        name = f"column_{column:03d}"
        rows = range(start, start + count)
        if kind == 0:
            values[name] = pa.array((row * 10_000_019 + column for row in rows), type=pa.int64())
        elif kind == 1:
            values[name] = pa.array((row / 7.0 + column for row in rows), type=pa.float64())
        elif kind == 2:
            values[name] = pa.array(((row + column) % 3 == 0 for row in rows), type=pa.bool_())
        elif kind == 3:
            values[name] = pa.array(
                (None if row % 101 == 0 else f"value-{row}-{column}" for row in rows),
                type=pa.string(),
            )
        elif kind == 4:
            values[name] = pa.array((19_000 + row % 3_650 for row in rows), type=pa.date32())
        elif kind == 5:
            values[name] = pa.array(
                (1_700_000_000_000 + row * 1_000 for row in rows),
                type=pa.timestamp("ms", tz="UTC"),
            )
        else:
            values[name] = pa.array(
                (Decimal(row * 1_000 + column).scaleb(-3) for row in rows),
                type=pa.decimal128(20, 3),
            )
    return pa.RecordBatch.from_pydict(values)


def write_parquet(path: Path, rows: int, columns: int) -> None:
    writer: pq.ParquetWriter | None = None
    try:
        for start in range(0, rows, 10_000):
            batch = parquet_batch(start, min(10_000, rows - start), columns)
            if writer is None:
                writer = pq.ParquetWriter(path, batch.schema, compression="zstd")
            writer.write_batch(batch, row_group_size=10_000)
    finally:
        if writer is not None:
            writer.close()


def write_csv(path: Path, rows: int, columns: int) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow([f"column_{column:03d}" for column in range(columns)])
        for row in range(rows):
            record = []
            for column in range(columns):
                if row % 997 == 0 and column == 1:
                    record.append(f"quoted, row {row}\nsecond line")
                elif row % 101 == 0 and column == 2:
                    record.append("")
                elif column % 5 == 0:
                    record.append(str(row * 10_000_019 + column))
                else:
                    record.append(f"value-{row}-{column}")
            writer.writerow(record)


def write_hostile(directory: Path) -> list[dict[str, object]]:
    directory.mkdir(parents=True, exist_ok=True)
    cases: list[tuple[str, bytes]] = [
        ("zero-byte.csv", b""),
        ("invalid-utf8.csv", b"name,value\nvalid,1\nbad,\xff\xfe\n"),
        ("ragged.csv", b"a,b,c\n1,2\n3,4,5,6\n"),
        ("quote-bomb.csv", b'a,b\n"' + b'quote,""' * 50_000 + b'",end\n'),
        ("truncated.parquet", b"PAR1metadata-without-footer"),
        ("bad-magic.parquet", b"not-a-parquet-file"),
        ("unsupported.txt", b"a,b\n1,2\n"),
    ]
    header = ",".join(f"header-{column}" for column in range(4_097)).encode("utf-8") + b"\n"
    cases.append(("too-many-columns.csv", header))
    cases.append(("giant-record.csv", b"value\n" + b"x" * (8 * 1024 * 1024 + 1) + b"\n"))
    manifest = []
    for name, contents in cases:
        path = directory / name
        path.write_bytes(contents)
        manifest.append({"name": name, "bytes": len(contents), "sha256": sha256(path)})
    (directory / "directory.csv").mkdir(exist_ok=True)
    manifest.append({"name": "directory.csv", "kind": "directory"})
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=PROFILES, default="gate")
    parser.add_argument("--output", type=Path, default=Path("fixtures/phase-7"))
    parser.add_argument(
        "--manifest", type=Path, default=Path("artifacts/phase-7/benchmark-manifest.json")
    )
    args = parser.parse_args()
    settings = PROFILES[args.profile]
    args.output.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)

    definitions = [
        ("small-parquet", "parquet", settings["small_rows"], settings["small_cols"]),
        ("small-csv", "csv", settings["small_rows"], settings["small_cols"]),
        ("large-parquet", "parquet", settings["large_rows"], settings["large_cols"]),
        ("large-csv", "csv", settings["large_rows"], settings["large_cols"]),
    ]
    fixtures = []
    for name, data_format, rows, columns in definitions:
        path = args.output / f"{name}.{data_format}"
        if data_format == "parquet":
            write_parquet(path, rows, columns)
        else:
            write_csv(path, rows, columns)
        fixtures.append(
            {
                "id": name,
                "path": path.as_posix(),
                "format": data_format,
                "rows": rows,
                "columns": columns,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )

    hostile = write_hostile(args.output / "hostile")
    manifest = {
        "schemaVersion": 1,
        "generatorRevision": REVISION,
        "seed": SEED,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "profile": args.profile,
        "host": {"os": os.name},
        "releaseTarget": {
            "largeParquet": "10,000,000 x 40, 1-2 GiB target",
            "largeCsv": "5,000,000 x 40, >=1 GiB target",
            "note": "gate profile is intentionally smaller; release profile generates the full CSV row target",
        },
        "fixtures": fixtures,
        "hostile": hostile,
    }
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
