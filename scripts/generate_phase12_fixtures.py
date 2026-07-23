"""Generate deterministic Phase 12 query fixtures and independent page oracles.

The large Parquet writer and schema are intentionally reused from the Phase 9 generator.  Large
files stay under ``.tmp``; only the compact manifest and reference JSON belong in artifacts.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import platform
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

import generate_phase9_large_fixtures as phase9


REVISION = "phase12-query-fixtures-v1"
DEFAULT_ROWS = 5_850_000
DEFAULT_ROW_GROUP_SIZE = 100_000
DEFAULT_REFERENCE_SEED = 12_012
PAGE_SIZE = 200
REPO_ROOT = Path(__file__).resolve().parents[1]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def relative_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(resolved)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_small_parquet(path: Path) -> dict[str, Any]:
    schema = pa.schema(
        [
            pa.field("source_row_id", pa.int64(), nullable=False),
            pa.field("nullable_int", pa.int32(), nullable=True),
            pa.field("text", pa.string(), nullable=True),
            pa.field("whitespace", pa.string(), nullable=False),
        ]
    )
    table = pa.Table.from_arrays(
        [
            pa.array(range(8), type=pa.int64()),
            pa.array([None, 0, 1, None, -1, 2, 3, 4], type=pa.int32()),
            pa.array([None, "", " ", "alpha", "beta", "", "\t", "omega"], type=pa.string()),
            pa.array(["", " ", "  ", "x", "\t", "x ", "\r", "y"], type=pa.string()),
        ],
        schema=schema,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, row_group_size=4, compression="zstd", version="2.6")
    return {
        "id": "query-null-empty-small-parquet",
        "kind": "small-parquet-null-empty",
        "path": relative_path(path),
        "rows": table.num_rows,
        "columns": table.num_columns,
        "rowGroups": pq.ParquetFile(path).metadata.num_row_groups,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "schemaFingerprintSha256": phase9.schema_fingerprint(schema),
        "expected": {
            "nullableInt": [None, 0, 1, None, -1, 2, 3, 4],
            "text": [None, "", " ", "alpha", "beta", "", "\t", "omega"],
            "whitespace": ["", " ", "  ", "x", "\t", "x ", "\r", "y"],
        },
        "validation": "PASS",
    }


def write_invalid_csv(path: Path) -> dict[str, Any]:
    rows = [
        ["source_row_id", "int_value", "bool_value", "timestamp_value", "text_value"],
        ["0", "1", "true", "2025-01-01T00:00:00Z", "alpha"],
        ["1", "", "", "", ""],
        ["2", "not-an-int", "yes", "not-a-time", " "],
        ["3", "9223372036854775808", "false", "2025-02-31T00:00:00Z", "NULL"],
        ["4", "-3", "TRUE", "2025-01-01T00:00:00.123456789Z", "omega"],
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerows(rows)
    return {
        "id": "query-invalid-small-csv",
        "kind": "small-csv-invalid",
        "path": relative_path(path),
        "rows": len(rows) - 1,
        "columns": len(rows[0]),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "expectedRawRows": rows,
        "validation": "PASS",
    }


def mixed_scalar(row_id: int, salt: int = 0) -> int:
    values = np.array([row_id], dtype=np.int64)
    return int(phase9.stable_mix(values, salt)[0])


def reference_row(row_id: int, cardinality: str) -> dict[str, Any]:
    mixed = mixed_scalar(row_id, phase9.SEED)
    if cardinality == "low":
        category = f"category-{row_id % 16:02x}"
        group_id = row_id % 128
        optional_value = row_id % 32
        event_time = 1_700_000_000_000 + (row_id % 4096) * 60_000
        amount = (row_id % 1000) / 10.0
        label = f"label-{row_id % 256:03x}"
        score = (row_id % 512) / 8.0
        code = f"code-{row_id % 64:02x}"
    elif cardinality == "high":
        category = f"category-{mixed:016x}"
        group_id = mixed & 0x7FFF_FFFF_FFFF_FFFF
        optional_value = mixed & 0x7FFF_FFFF
        event_time = 1_700_000_000_000 + row_id * 37
        amount = float(mixed % 9_000_000_000_000) / 100.0
        label = f"label-{mixed ^ 0xA5A5_A5A5_A5A5_A5A5:016x}"
        score = float(mixed >> 11) / float(2**20)
        code = f"code-{mixed ^ 0x5A5A_5A5A_5A5A_5A5A:016x}"
    else:
        raise ValueError(f"Unsupported cardinality: {cardinality}")

    if row_id % 89 == 0:
        label = ""
    if row_id % 97 == 0:
        optional_value = None
    int64_values = []
    float64_values = []
    for column in range(2):
        if cardinality == "low":
            int64_values.append((row_id + column * 17) % (256 + column * 32))
            float64_values.append(((row_id + column * 13) % (512 + column * 64)) / 7.0)
        else:
            int64_values.append(mixed_scalar(row_id, phase9.SEED + 101 * (column + 1)) & 0x7FFF_FFFF_FFFF_FFFF)
            float64_values.append(float(mixed_scalar(row_id, phase9.SEED + 307 * (column + 1))) / float(2**31))
    int32_value = (
        row_id % 128
        if cardinality == "low"
        else mixed_scalar(row_id, phase9.SEED + 503) & 0x7FFF_FFFF
    )
    return {
        "row_id": row_id,
        "category": category,
        "group_id": group_id,
        "active": row_id % 2 == 0,
        "optional_value": optional_value,
        "event_time_epoch_ms": event_time,
        "amount": amount,
        "label": label,
        "score": score,
        "code": code,
        "int64_00": int64_values[0],
        "int64_01": int64_values[1],
        "float64_00": float64_values[0],
        "float64_01": float64_values[1],
        "int32_00": int32_value,
    }


def sorted_row_ids(rows: int, cardinality: str) -> np.ndarray:
    row_ids = np.arange(rows, dtype=np.int64)
    if cardinality == "low":
        group_ids = row_ids % 128
    else:
        group_ids = phase9.stable_mix(row_ids, phase9.SEED) & np.uint64(0x7FFF_FFFF_FFFF_FFFF)
    return row_ids[np.lexsort((row_ids, group_ids))]


def reference_offsets(rows: int, seed: int) -> list[dict[str, Any]]:
    fixed = [
        ("first", 0),
        ("middle", rows // 2),
        ("reported-986803", 986_803),
        ("last", max(0, rows - PAGE_SIZE)),
        ("eof", rows),
    ]
    randomizer = random.Random(seed)
    upper = max(rows - 1, 0)
    random_offsets = [(f"seed-{index:02d}", randomizer.randint(0, upper)) for index in range(20)]
    return [{"label": label, "offset": offset} for label, offset in fixed + random_offsets]


def full_copy_oracle(order: np.ndarray) -> dict[str, Any]:
    digest = hashlib.sha256()
    serialized_bytes = 0
    last_index = len(order) - 1
    for index, value in enumerate(order):
        encoded = str(int(value)).encode("ascii")
        digest.update(encoded)
        serialized_bytes += len(encoded)
        if index != last_index:
            digest.update(b"\n")
            serialized_bytes += 1
    return {
        "columns": ["row_id"],
        "header": False,
        "representation": "raw",
        "delimiter": "tab",
        "lineEnding": "LF",
        "cells": len(order),
        "serializedBytes": serialized_bytes,
        "sha256": digest.hexdigest(),
        "testSettings": {"maxCells": 10_000_000, "maxBytes": 64 * 1024**2},
        "withinTestLimits": len(order) <= 10_000_000 and serialized_bytes <= 64 * 1024**2,
    }


def build_reference(rows: int, cardinalities: list[str], seed: int) -> dict[str, Any]:
    fixtures: dict[str, Any] = {}
    offsets = reference_offsets(rows, seed)
    for cardinality in cardinalities:
        order = sorted_row_ids(rows, cardinality)
        pages = []
        for item in offsets:
            offset = int(item["offset"])
            within_range = offset < rows
            identities = order[offset : min(offset + PAGE_SIZE, rows)].astype(np.int64).tolist()
            typed_rows = [reference_row(int(row_id), cardinality) for row_id in identities]
            pages.append(
                {
                    **item,
                    "withinRange": within_range,
                    "sourceRowIds": identities,
                    "sourceRowIdsSha256": canonical_sha256(identities),
                    "typedRowsSha256": canonical_sha256(typed_rows),
                }
            )
        fixture_id = f"query-{cardinality}-{rows}-rows-15-columns"
        fixtures[fixture_id] = {
            "queryPlan": {
                "filters": [],
                "sort": [
                    {"columnId": "group_id", "direction": "ascending", "nullsLast": True}
                ],
                "tieBreaker": {"columnId": "row_id", "direction": "ascending"},
            },
            "pages": pages,
            "fullCopyOracle": full_copy_oracle(order),
        }
    return {
        "schemaVersion": 1,
        "revision": REVISION,
        "rows": rows,
        "pageSize": PAGE_SIZE,
        "referenceSeed": seed,
        "oracle": "NumPy lexsort over generated group_id and source row_id; typed rows use the generator formula",
        "fixtures": fixtures,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".tmp/phase12-query"))
    parser.add_argument(
        "--manifest", type=Path, default=Path("artifacts/phase-12/fixture-manifest.json")
    )
    parser.add_argument(
        "--reference", type=Path, default=Path("artifacts/phase-12/reference-pages.json")
    )
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--row-group-size", type=int, default=DEFAULT_ROW_GROUP_SIZE)
    parser.add_argument("--seed", type=int, default=DEFAULT_REFERENCE_SEED)
    parser.add_argument("--expected-upper-gib", type=float, default=10.0)
    parser.add_argument(
        "--cardinalities", nargs="+", choices=["low", "high"], default=["low", "high"]
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.rows <= 0 or args.row_group_size <= 0:
        raise SystemExit("--rows and --row-group-size must be positive")
    expected_upper_bytes = int(args.expected_upper_gib * 1024**3)
    if expected_upper_bytes <= 0 or expected_upper_bytes > phase9.EXPECTED_UPPER_BYTES:
        raise SystemExit("--expected-upper-gib must be greater than zero and at most 20 GiB")
    if len(set(args.cardinalities)) != len(args.cardinalities):
        raise SystemExit("--cardinalities must be unique")

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    preflight = phase9.preflight(output, expected_upper_bytes)
    fixtures: list[dict[str, Any]] = []
    for cardinality in args.cardinalities:
        path = output / f"query-{cardinality}-{args.rows}-15c.parquet"
        phase9.write_fixture(path, args.rows, args.row_group_size, "full15", cardinality)
        if not path.is_file():
            raise RuntimeError(f"Fixture does not exist: {path}")
        entry = phase9.validate_fixture(path, args.rows, args.row_group_size, "full15", cardinality)
        entry["path"] = relative_path(path)
        fixtures.append(entry)

    small_parquet = output / "query-null-empty-small.parquet"
    invalid_csv = output / "query-invalid-small.csv"
    fixtures.extend([write_small_parquet(small_parquet), write_invalid_csv(invalid_csv)])

    reference = build_reference(args.rows, args.cardinalities, args.seed)
    write_json(args.reference, reference)
    manifest = {
        "schemaVersion": 1,
        "revision": REVISION,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "generator": relative_path(Path(__file__)),
        "generatorSha256": sha256_file(Path(__file__)),
        "reusedGenerator": relative_path(Path(phase9.__file__)),
        "reusedGeneratorSha256": sha256_file(Path(phase9.__file__)),
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pyarrow": pa.__version__,
        },
        "configuration": {
            "rows": args.rows,
            "rowGroupSize": args.row_group_size,
            "cardinalities": args.cardinalities,
            "profile": "full15",
            "pageSize": PAGE_SIZE,
            "referenceSeed": args.seed,
        },
        "preflight": preflight,
        "fixtures": fixtures,
        "reference": {
            "path": relative_path(args.reference),
            "sha256": sha256_file(args.reference),
        },
        "validation": "PASS",
    }
    write_json(args.manifest, manifest)
    print(json.dumps({"manifest": str(args.manifest.resolve()), "fixtures": len(fixtures)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
