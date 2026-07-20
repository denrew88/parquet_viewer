"""Generate deterministic Phase 9 large Parquet fixtures without materializing a full table.

The generator writes fixed-size record batches as Parquet row groups. Large data belongs in an
explicit output directory; the compact manifest is the only artifact intended for source control.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


SEED = 20260715
REVISION = "phase9-large-v1"
COMPRESSION = "zstd"
COMPRESSION_LEVEL = 3
DEFAULT_ROWS = 10_000_000
DEFAULT_ROW_GROUP_SIZE = 100_000
EXPECTED_UPPER_BYTES = 20 * 1024**3
FREE_SPACE_RESERVE_BYTES = 5 * 1024**3
SAMPLE_ROWS_PER_GROUP = 4096
CARDINALITY_COLUMNS = ("row_id", "category", "group_id", "label", "score", "code")


BASE_FIELDS = [
    pa.field("row_id", pa.int64(), nullable=False),
    pa.field("category", pa.string(), nullable=False),
    pa.field("group_id", pa.int64(), nullable=False),
    pa.field("active", pa.bool_(), nullable=False),
    pa.field("optional_value", pa.int32(), nullable=True),
    pa.field("event_time", pa.timestamp("ms", tz="UTC"), nullable=False),
    pa.field("amount", pa.float64(), nullable=False),
    pa.field("label", pa.string(), nullable=False),
    pa.field("score", pa.float64(), nullable=False),
    pa.field("code", pa.string(), nullable=False),
]
FULL40_FIELDS = BASE_FIELDS + [
    *[pa.field(f"int64_{index:02d}", pa.int64(), nullable=False) for index in range(10)],
    *[pa.field(f"float64_{index:02d}", pa.float64(), nullable=False) for index in range(10)],
    *[pa.field(f"int32_{index:02d}", pa.int32(), nullable=False) for index in range(10)],
]
FULL15_FIELDS = BASE_FIELDS + [
    *[pa.field(f"int64_{index:02d}", pa.int64(), nullable=False) for index in range(2)],
    *[pa.field(f"float64_{index:02d}", pa.float64(), nullable=False) for index in range(2)],
    pa.field("int32_00", pa.int32(), nullable=False),
]
SCHEMAS = {
    "full40": pa.schema(FULL40_FIELDS),
    "full15": pa.schema(FULL15_FIELDS),
    "repeated10": pa.schema(BASE_FIELDS),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def schema_fingerprint(schema: pa.Schema) -> str:
    return hashlib.sha256(schema.serialize().to_pybytes()).hexdigest()


def stable_mix(indices: np.ndarray, salt: int = 0) -> np.ndarray:
    """Return a deterministic, well-distributed uint64 value for every row index."""
    values = indices.astype(np.uint64, copy=False) + np.uint64(salt)
    values ^= values >> np.uint64(30)
    values *= np.uint64(0xBF58476D1CE4E5B9)
    values ^= values >> np.uint64(27)
    values *= np.uint64(0x94D049BB133111EB)
    values ^= values >> np.uint64(31)
    return values


def string_array(prefix: str, values: Iterable[int], width: int = 16) -> pa.Array:
    return pa.array((f"{prefix}-{int(value):0{width}x}" for value in values), type=pa.string())


def make_batch(start: int, count: int, profile: str, cardinality: str) -> pa.RecordBatch:
    schema = SCHEMAS[profile]
    indices = np.arange(start, start + count, dtype=np.int64)
    mixed = stable_mix(indices, SEED)
    null_mask = indices % 97 == 0

    if cardinality == "low":
        category = string_array("category", indices % 16, width=2)
        group_id = indices % 128
        optional_value = (indices % 32).astype(np.int32)
        event_time = 1_700_000_000_000 + (indices % 4096) * 60_000
        amount = (indices % 1000).astype(np.float64) / 10.0
        label = string_array("label", indices % 256, width=3)
        score = (indices % 512).astype(np.float64) / 8.0
        code = string_array("code", indices % 64, width=2)
    elif cardinality == "high":
        category = string_array("category", mixed)
        group_id = (mixed & np.uint64(0x7FFF_FFFF_FFFF_FFFF)).astype(np.int64)
        optional_value = (mixed & np.uint64(0x7FFF_FFFF)).astype(np.int32)
        event_time = 1_700_000_000_000 + indices * 37
        amount = (mixed % np.uint64(9_000_000_000_000)).astype(np.float64) / 100.0
        label = string_array("label", mixed ^ np.uint64(0xA5A5_A5A5_A5A5_A5A5))
        score = (mixed >> np.uint64(11)).astype(np.float64) / float(2**20)
        code = string_array("code", mixed ^ np.uint64(0x5A5A_5A5A_5A5A_5A5A))
    else:
        raise ValueError(f"Unsupported cardinality: {cardinality}")

    arrays: list[pa.Array] = [
        pa.array(indices, type=pa.int64()),
        category,
        pa.array(group_id, type=pa.int64()),
        pa.array(indices % 2 == 0, type=pa.bool_()),
        pa.array(optional_value, mask=null_mask, type=pa.int32()),
        pa.array(event_time, type=pa.timestamp("ms", tz="UTC")),
        pa.array(amount, type=pa.float64()),
        label,
        pa.array(score, type=pa.float64()),
        code,
    ]

    if profile == "full15":
        label = pa.array(
            ("" if int(index) % 89 == 0 else value.as_py() for index, value in zip(indices, label)),
            type=pa.string(),
        )
        arrays[7] = label

    if profile in {"full15", "full40"}:
        extra_count = 2 if profile == "full15" else 10
        for column in range(extra_count):
            if cardinality == "low":
                values = (indices + column * 17) % (256 + column * 32)
            else:
                values = stable_mix(indices, SEED + 101 * (column + 1)) & np.uint64(
                    0x7FFF_FFFF_FFFF_FFFF
                )
            arrays.append(pa.array(values.astype(np.int64), type=pa.int64()))
        for column in range(extra_count):
            if cardinality == "low":
                values = ((indices + column * 13) % (512 + column * 64)).astype(np.float64) / 7.0
            else:
                values = stable_mix(indices, SEED + 307 * (column + 1)).astype(np.float64) / float(
                    2**31
                )
            arrays.append(pa.array(values, type=pa.float64()))
        int32_count = 1 if profile == "full15" else 10
        for column in range(int32_count):
            if cardinality == "low":
                values = ((indices + column * 11) % (128 + column * 16)).astype(np.int32)
            else:
                values = (
                    stable_mix(indices, SEED + 503 * (column + 1)) & np.uint64(0x7FFF_FFFF)
                ).astype(np.int32)
            arrays.append(pa.array(values, type=pa.int32()))

    return pa.RecordBatch.from_arrays(arrays, schema=schema)


def write_fixture(
    path: Path, rows: int, row_group_size: int, profile: str, cardinality: str
) -> None:
    schema = SCHEMAS[profile]
    partial = path.with_suffix(path.suffix + ".partial")
    partial.unlink(missing_ok=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    writer: pq.ParquetWriter | None = None
    succeeded = False
    try:
        writer = pq.ParquetWriter(
            partial,
            schema,
            compression=COMPRESSION,
            compression_level=COMPRESSION_LEVEL,
            use_dictionary=["category", "label", "code"],
            write_statistics=True,
            data_page_version="2.0",
        )
        for start in range(0, rows, row_group_size):
            count = min(row_group_size, rows - start)
            writer.write_batch(make_batch(start, count, profile, cardinality), row_group_size=count)
            print(
                f"[{path.name}] {start + count:,}/{rows:,} rows",
                file=sys.stderr,
                flush=True,
            )
        writer.close()
        writer = None
        partial.replace(path)
        succeeded = True
    finally:
        if writer is not None:
            writer.close()
        if not succeeded:
            partial.unlink(missing_ok=True)


def table_checksum(table: pa.Table) -> str:
    digest = hashlib.sha256()
    digest.update(table.schema.serialize().to_pybytes())
    for batch in table.to_batches(max_chunksize=4096):
        sink = pa.BufferOutputStream()
        with pa.ipc.new_stream(sink, batch.schema) as writer:
            writer.write_batch(batch)
        digest.update(sink.getvalue().to_pybytes())
    return digest.hexdigest()


def sample_table(parquet_file: pq.ParquetFile) -> tuple[pa.Table, list[int]]:
    group_count = parquet_file.metadata.num_row_groups
    selected_groups = sorted({0, group_count // 2, group_count - 1})
    tables = [
        parquet_file.read_row_group(group, columns=list(CARDINALITY_COLUMNS)).slice(
            0, SAMPLE_ROWS_PER_GROUP
        )
        for group in selected_groups
    ]
    return pa.concat_tables(tables), selected_groups


def validate_fixture(
    path: Path, rows: int, row_group_size: int, profile: str, cardinality: str
) -> dict[str, Any]:
    parquet_file = pq.ParquetFile(path)
    metadata = parquet_file.metadata
    expected_schema = SCHEMAS[profile]
    if not parquet_file.schema_arrow.equals(expected_schema):
        raise RuntimeError(f"Schema mismatch for {path}")
    expected_groups = math.ceil(rows / row_group_size)
    if metadata.num_rows != rows or metadata.num_columns != len(expected_schema):
        raise RuntimeError(f"Shape mismatch for {path}: {metadata.num_rows}x{metadata.num_columns}")
    if metadata.num_row_groups != expected_groups:
        raise RuntimeError(
            f"Row-group mismatch for {path}: {metadata.num_row_groups} != {expected_groups}"
        )
    group_rows = [metadata.row_group(index).num_rows for index in range(expected_groups)]
    if any(value <= 0 or value > row_group_size for value in group_rows) or sum(group_rows) != rows:
        raise RuntimeError(f"Invalid row-group sizes for {path}")
    byte_size = path.stat().st_size
    if byte_size <= 0:
        raise RuntimeError(f"Empty fixture: {path}")

    sample, sampled_groups = sample_table(parquet_file)
    cardinalities = {
        name: len(set(sample[name].to_pylist())) for name in CARDINALITY_COLUMNS
    }
    sampled_rows = sample.num_rows
    unique_rate = cardinalities["category"] / sampled_rows
    if cardinality == "low" and unique_rate > 0.01:
        raise RuntimeError(f"Low-cardinality sample is unexpectedly unique: {unique_rate:.6f}")
    if cardinality == "high" and unique_rate < 0.99:
        raise RuntimeError(f"High-cardinality sample is not unique enough: {unique_rate:.6f}")

    compressed = 0
    uncompressed = 0
    encodings: dict[str, set[str]] = {field.name: set() for field in expected_schema}
    for row_group_index in range(metadata.num_row_groups):
        row_group = metadata.row_group(row_group_index)
        for column_index, field in enumerate(expected_schema):
            column = row_group.column(column_index)
            compressed += column.total_compressed_size
            uncompressed += column.total_uncompressed_size
            encodings[field.name].update(str(value) for value in column.encodings)

    return {
        "id": f"query-{cardinality}-{rows}-rows-{len(expected_schema)}-columns",
        "path": str(path.resolve()),
        "profile": profile,
        "cardinality": cardinality,
        "rows": rows,
        "columns": len(expected_schema),
        "rowGroupSize": row_group_size,
        "rowGroups": metadata.num_row_groups,
        "rowGroupRows": {
            "first": group_rows[0],
            "last": group_rows[-1],
            "minimum": min(group_rows),
            "maximum": max(group_rows),
        },
        "bytes": byte_size,
        "sha256": sha256_file(path),
        "schemaFingerprintSha256": schema_fingerprint(expected_schema),
        "schema": [
            {"name": field.name, "type": str(field.type), "nullable": field.nullable}
            for field in expected_schema
        ],
        "compression": {
            "codec": COMPRESSION,
            "level": COMPRESSION_LEVEL,
            "compressedBytes": compressed,
            "uncompressedBytes": uncompressed,
            "compressedToUncompressedRatio": round(compressed / uncompressed, 8),
        },
        "encodings": {name: sorted(values) for name, values in encodings.items()},
        "cardinalitySample": {
            "rowGroups": sampled_groups,
            "rows": sampled_rows,
            "distinct": cardinalities,
            "categoryUniqueRate": round(unique_rate, 8),
            "checksumSha256": table_checksum(sample),
        },
        "validation": "PASS",
    }


def determinism_check(output_dir: Path, row_group_size: int) -> dict[str, Any]:
    rows = min(2 * row_group_size, 20_000)
    hashes: dict[str, dict[str, str | bool]] = {}
    with tempfile.TemporaryDirectory(prefix="phase9-determinism-", dir=output_dir) as temporary:
        root = Path(temporary)
        for profile in SCHEMAS:
            for cardinality in ("low", "high"):
                first = root / f"{profile}-{cardinality}-a.parquet"
                second = root / f"{profile}-{cardinality}-b.parquet"
                write_fixture(first, rows, min(row_group_size, rows), profile, cardinality)
                write_fixture(second, rows, min(row_group_size, rows), profile, cardinality)
                first_hash = sha256_file(first)
                second_hash = sha256_file(second)
                equal = first_hash == second_hash
                if not equal:
                    raise RuntimeError(f"Determinism check failed: {profile}/{cardinality}")
                hashes[f"{profile}/{cardinality}"] = {
                    "firstSha256": first_hash,
                    "secondSha256": second_hash,
                    "equal": equal,
                }
    return {"rows": rows, "result": "PASS", "pairs": hashes}


def preflight(output_dir: Path, expected_upper_bytes: int) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(output_dir)
    required = expected_upper_bytes + FREE_SPACE_RESERVE_BYTES
    result = {
        "outputDirectory": str(output_dir.resolve()),
        "capacityBytes": usage.total,
        "freeBytesBefore": usage.free,
        "expectedUpperBytes": expected_upper_bytes,
        "reserveBytes": FREE_SPACE_RESERVE_BYTES,
        "requiredFreeBytes": required,
        "result": "PASS" if usage.free >= required else "FAIL",
    }
    if usage.free < required:
        raise RuntimeError(
            f"Insufficient disk space: {usage.free / 1024**3:.2f} GiB free, "
            f"{required / 1024**3:.2f} GiB required"
        )
    return result


def fixture_path(output_dir: Path, profile: str, cardinality: str, rows: int) -> Path:
    row_label = f"{rows // 1_000_000}m" if rows % 1_000_000 == 0 else str(rows)
    return output_dir / f"query-{cardinality}-{row_label}-{len(SCHEMAS[profile])}c.parquet"


def clean_outputs(output_dir: Path) -> list[str]:
    removed: list[str] = []
    for pattern in ("query-*-*-*c.parquet", "query-*-*-*c.parquet.partial"):
        for path in output_dir.glob(pattern):
            path.unlink(missing_ok=True)
            removed.append(str(path.resolve()))
    return sorted(set(removed))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("artifacts/phase-9/large-fixtures-manifest.json"),
    )
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--row-group-size", type=int, default=DEFAULT_ROW_GROUP_SIZE)
    parser.add_argument(
        "--profiles", nargs="+", choices=sorted(SCHEMAS), default=["full40"]
    )
    parser.add_argument(
        "--cardinalities", nargs="+", choices=["low", "high"], default=["low", "high"]
    )
    parser.add_argument("--expected-upper-gib", type=float, default=20.0)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--skip-determinism-check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.rows <= 0 or args.row_group_size <= 0:
        raise SystemExit("--rows and --row-group-size must be positive")
    expected_upper = int(args.expected_upper_gib * 1024**3)
    if expected_upper <= 0 or expected_upper > EXPECTED_UPPER_BYTES:
        raise SystemExit("--expected-upper-gib must be greater than zero and at most 20 GiB")

    output_dir = args.output_dir.resolve()
    removed = clean_outputs(output_dir) if args.clean else []
    disk = preflight(output_dir, expected_upper)
    determinism = (
        {"result": "SKIPPED_BY_EXPLICIT_FLAG"}
        if args.skip_determinism_check
        else determinism_check(output_dir, args.row_group_size)
    )

    fixtures: list[dict[str, Any]] = []
    for profile in args.profiles:
        for cardinality in args.cardinalities:
            path = fixture_path(output_dir, profile, cardinality, args.rows)
            if not args.verify_only:
                write_fixture(path, args.rows, args.row_group_size, profile, cardinality)
            if not path.is_file():
                raise RuntimeError(f"Fixture does not exist for verification: {path}")
            fixtures.append(
                validate_fixture(path, args.rows, args.row_group_size, profile, cardinality)
            )

    disk_after = shutil.disk_usage(output_dir)
    manifest = {
        "schemaVersion": 1,
        "revision": REVISION,
        "generatedAtUtc": utc_now(),
        "generator": str(Path(__file__).resolve()),
        "generatorSha256": sha256_file(Path(__file__)),
        "seed": SEED,
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pyarrow": pa.__version__,
        },
        "configuration": {
            "rows": args.rows,
            "rowGroupSize": args.row_group_size,
            "profiles": args.profiles,
            "cardinalities": args.cardinalities,
            "compression": COMPRESSION,
            "compressionLevel": COMPRESSION_LEVEL,
        },
        "preflight": disk,
        "freeBytesAfter": disk_after.free,
        "cleanedBeforeGeneration": removed,
        "determinism": determinism,
        "fixtures": fixtures,
        "validation": "PASS",
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(args.manifest.resolve()), "fixtures": len(fixtures)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
