"""Generate deterministic Phase 8 multi-document and cardinality fixtures.

Large Parquet files are written one row group at a time. The default output is
under ``logs`` so generated data cannot be committed accidentally; only the
compact manifest belongs in ``artifacts``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import platform
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


SEED = 20260714
REVISION = "phase8-cardinality-v1"
COMPRESSION = "zstd"
COMPRESSION_LEVEL = 3
PROJECTION_COLUMNS = ["row_id", "category", "amount"]
PROFILES = {
    "gate": {"rows": 50_000, "row_group_size": 10_000},
    "release": {"rows": 10_000_000, "row_group_size": 100_000},
}
SCHEMA = pa.schema(
    [
        pa.field("row_id", pa.int64(), nullable=False),
        pa.field("category", pa.string(), nullable=False),
        pa.field("group_id", pa.int64(), nullable=False),
        pa.field("active", pa.bool_(), nullable=False),
        pa.field("optional_value", pa.int32(), nullable=True),
        pa.field("event_time", pa.timestamp("ms", tz="UTC"), nullable=False),
        pa.field("amount", pa.decimal128(23, 3), nullable=False),
        pa.field("label", pa.string(), nullable=False),
        pa.field("score", pa.float64(), nullable=False),
        pa.field("code", pa.string(), nullable=False),
    ]
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _mixed_values(indices: np.ndarray) -> np.ndarray:
    """Return a deterministic uint64 permutation-like value per row."""
    values = indices.astype(np.uint64, copy=False)
    values = values * np.uint64(11_400_714_819_323_198_485) + np.uint64(SEED)
    values ^= values >> np.uint64(33)
    values *= np.uint64(14_029_467_366_897_019_727)
    values ^= values >> np.uint64(29)
    return values


def make_batch(start: int, count: int, cardinality: str) -> pa.RecordBatch:
    indices = np.arange(start, start + count, dtype=np.int64)
    mixed = _mixed_values(indices)
    active = (indices % 2) == 0
    null_mask = (indices % 97) == 0

    if cardinality == "low":
        category = [f"category-{value:02d}" for value in indices % 16]
        group_id = indices % 128
        optional_value = (indices % 32).astype(np.int32)
        event_time = 1_700_000_000_000 + (indices % 1_024) * 60_000
        amount_source = indices % 1_000
        label = [f"label-{value:03d}" for value in indices % 256]
        score = (indices % 256).astype(np.float64) / 10.0
        code = [f"C{value:03d}" for value in indices % 64]
    elif cardinality == "high":
        category = [f"category-{int(value):016x}" for value in mixed]
        group_id = (mixed & np.uint64(0x7FFF_FFFF_FFFF_FFFF)).astype(np.int64)
        optional_value = (mixed & np.uint64(0x7FFF_FFFF)).astype(np.int32)
        event_time = 1_700_000_000_000 + indices
        amount_source = (mixed % np.uint64(9_000_000_000_000_000)).astype(np.int64)
        label = [f"label-{int(value):016x}-{start + offset:08x}" for offset, value in enumerate(mixed)]
        score = indices.astype(np.float64) / 10.0 + 0.125
        code = [f"H{int(value):016X}" for value in mixed ^ np.uint64(0xA5A5_A5A5_A5A5_A5A5)]
    else:
        raise ValueError(f"unsupported cardinality: {cardinality}")

    arrays = [
        pa.array(indices, type=pa.int64()),
        pa.array(category, type=pa.string()),
        pa.array(group_id, type=pa.int64()),
        pa.array(active, type=pa.bool_()),
        pa.array(optional_value, mask=null_mask, type=pa.int32()),
        pa.array(event_time, type=pa.timestamp("ms", tz="UTC")),
        pa.array(amount_source, type=pa.int64()).cast(pa.decimal128(23, 3)),
        pa.array(label, type=pa.string()),
        pa.array(score, type=pa.float64()),
        pa.array(code, type=pa.string()),
    ]
    return pa.RecordBatch.from_arrays(arrays, schema=SCHEMA)


def write_parquet(path: Path, rows: int, row_group_size: int, cardinality: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    partial.unlink(missing_ok=True)
    writer: pq.ParquetWriter | None = None
    try:
        writer = pq.ParquetWriter(
            partial,
            SCHEMA,
            compression=COMPRESSION,
            compression_level=COMPRESSION_LEVEL,
            use_dictionary=["category", "label", "code"],
            write_statistics=True,
            data_page_version="2.0",
        )
        for start in range(0, rows, row_group_size):
            count = min(row_group_size, rows - start)
            writer.write_batch(make_batch(start, count, cardinality), row_group_size=count)
    finally:
        if writer is not None:
            writer.close()
    partial.replace(path)


def _json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"bytesHex": value.hex()}
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def table_checksum(table: pa.Table) -> str:
    payload = {
        "columns": table.column_names,
        "types": [str(field.type) for field in table.schema],
        "rows": _json_value(table.to_pylist()),
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_rows(
    parquet_file: pq.ParquetFile, offset: int, count: int, columns: list[str] | None = None
) -> pa.Table:
    if offset < 0 or count < 0 or offset + count > parquet_file.metadata.num_rows:
        raise ValueError(f"invalid range: offset={offset}, count={count}")
    chunks: list[pa.Table] = []
    row_group_start = 0
    remaining = count
    cursor = offset
    for row_group_index in range(parquet_file.metadata.num_row_groups):
        group_rows = parquet_file.metadata.row_group(row_group_index).num_rows
        row_group_end = row_group_start + group_rows
        if cursor >= row_group_end:
            row_group_start = row_group_end
            continue
        if remaining == 0:
            break
        local_offset = max(0, cursor - row_group_start)
        take = min(remaining, group_rows - local_offset)
        chunks.append(
            parquet_file.read_row_group(row_group_index, columns=columns).slice(local_offset, take)
        )
        cursor += take
        remaining -= take
        row_group_start = row_group_end
    if remaining != 0:
        raise RuntimeError(f"failed to read {remaining} rows from requested range")
    return pa.concat_tables(chunks) if len(chunks) > 1 else chunks[0]


def representative_pages(
    parquet_file: pq.ParquetFile, row_group_size: int
) -> list[dict[str, Any]]:
    rows = parquet_file.metadata.num_rows
    page_rows = min(200, rows)
    boundary_offset = max(0, min(rows - page_rows, row_group_size))
    locations = [
        ("first", 0),
        ("firstRowGroupBoundary", boundary_offset),
        ("middle", max(0, min(rows - page_rows, rows // 2))),
        ("last", max(0, rows - page_rows)),
    ]
    pages = []
    for name, offset in locations:
        full = read_rows(parquet_file, offset, page_rows)
        projection = read_rows(parquet_file, offset, page_rows, PROJECTION_COLUMNS)
        pages.append(
            {
                "name": name,
                "offset": offset,
                "rows": page_rows,
                "checksumSha256": table_checksum(full),
                "projectionColumns": PROJECTION_COLUMNS,
                "projectionChecksumSha256": table_checksum(projection),
            }
        )
    return pages


def parquet_details(path: Path, fixture_id: str, cardinality: str, row_group_size: int) -> dict[str, Any]:
    parquet_file = pq.ParquetFile(path)
    metadata = parquet_file.metadata
    compressed = 0
    uncompressed = 0
    encodings: dict[str, set[str]] = {name: set() for name in parquet_file.schema_arrow.names}
    codecs: dict[str, set[str]] = {name: set() for name in parquet_file.schema_arrow.names}
    for row_group_index in range(metadata.num_row_groups):
        row_group = metadata.row_group(row_group_index)
        for column_index, name in enumerate(parquet_file.schema_arrow.names):
            column = row_group.column(column_index)
            compressed += column.total_compressed_size
            uncompressed += column.total_uncompressed_size
            encodings[name].update(str(value) for value in column.encodings)
            codecs[name].add(str(column.compression))
    cardinality_sample = parquet_file.read_row_group(0)
    return {
        "id": fixture_id,
        "path": path.as_posix(),
        "format": "parquet",
        "cardinality": cardinality,
        "rows": metadata.num_rows,
        "columns": metadata.num_columns,
        "rowGroupSize": row_group_size,
        "rowGroups": metadata.num_row_groups,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "compression": {
            "codec": COMPRESSION,
            "level": COMPRESSION_LEVEL,
            "compressedBytes": compressed,
            "uncompressedBytes": uncompressed,
            "compressedToUncompressedRatio": round(compressed / uncompressed, 8),
            "uncompressedToCompressedRatio": round(uncompressed / compressed, 8),
        },
        "schema": [
            {"name": field.name, "type": str(field.type), "nullable": field.nullable}
            for field in parquet_file.schema_arrow
        ],
        "columnEncodings": [
            {
                "name": name,
                "encodings": sorted(encodings[name]),
                "compression": sorted(codecs[name]),
            }
            for name in parquet_file.schema_arrow.names
        ],
        "cardinalitySample": {
            "rows": cardinality_sample.num_rows,
            "distinctValues": {
                name: pc.count_distinct(cardinality_sample[name]).as_py()
                for name in cardinality_sample.column_names
            },
        },
        "representativePages": representative_pages(parquet_file, row_group_size),
    }


def _relative_path(path: Path, base: Path) -> str:
    return Path(os.path.relpath(path.resolve(), base.resolve())).as_posix()


def write_small_documents(directory: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    directory.mkdir(parents=True, exist_ok=True)
    documents: list[dict[str, Any]] = []
    for index in range(64):
        if index % 2 == 0:
            path = directory / f"document-{index + 1:02d}.csv"
            with path.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream, lineterminator="\n")
                writer.writerow(["row_id", "document_id", "value"])
                writer.writerows((row, index + 1, f"value-{index + 1:02d}-{row:02d}") for row in range(16))
            data_format = "csv"
        else:
            path = directory / f"document-{index + 1:02d}.parquet"
            table = pa.table(
                {
                    "row_id": pa.array(range(16), type=pa.int64()),
                    "document_id": pa.array([index + 1] * 16, type=pa.int32()),
                    "value": pa.array([f"value-{index + 1:02d}-{row:02d}" for row in range(16)]),
                }
            )
            pq.write_table(table, path, compression=COMPRESSION, row_group_size=8)
            data_format = "parquet"
        documents.append(
            {
                "ordinal": index + 1,
                "path": path.as_posix(),
                "format": data_format,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    overflow = directory / "document-65-overflow.csv"
    overflow.write_text("row_id,value\n0,overflow-boundary\n", encoding="utf-8", newline="")
    overflow_entry = {
        "ordinal": 65,
        "path": overflow.as_posix(),
        "format": "csv",
        "bytes": overflow.stat().st_size,
        "sha256": sha256_file(overflow),
        "purpose": "65th document non-destructive rejection boundary",
    }
    return documents, overflow_entry


def ensure_generated_contract(fixture: dict[str, Any], settings: dict[str, int]) -> None:
    expected_groups = (settings["rows"] + settings["row_group_size"] - 1) // settings["row_group_size"]
    if fixture["rows"] != settings["rows"]:
        raise RuntimeError(f"{fixture['id']}: row count mismatch")
    if fixture["columns"] != len(SCHEMA):
        raise RuntimeError(f"{fixture['id']}: column count mismatch")
    if fixture["rowGroups"] != expected_groups:
        raise RuntimeError(f"{fixture['id']}: row group count mismatch")
    if len(fixture["representativePages"]) != 4:
        raise RuntimeError(f"{fixture['id']}: representative page count mismatch")


def main(argv: Iterable[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=PROFILES, default="gate")
    parser.add_argument("--output", type=Path, default=Path("logs/phase-8/fixtures"))
    parser.add_argument(
        "--manifest", type=Path, default=Path("artifacts/phase-8/fixture-manifest.json")
    )
    parser.add_argument("--skip-small-docs", action="store_true")
    args = parser.parse_args(argv)
    settings = PROFILES[args.profile]
    args.output.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)

    fixtures = []
    definitions = [("F-P8-12", "low"), ("F-P8-13", "high")]
    for fixture_id, cardinality in definitions:
        path = args.output / f"{fixture_id.lower()}-{cardinality}.parquet"
        write_parquet(path, settings["rows"], settings["row_group_size"], cardinality)
        details = parquet_details(path, fixture_id, cardinality, settings["row_group_size"])
        ensure_generated_contract(details, settings)
        fixtures.append(details)

    low_distinct = fixtures[0]["cardinalitySample"]["distinctValues"]
    high_distinct = fixtures[1]["cardinalitySample"]["distinctValues"]
    sample_rows = fixtures[0]["cardinalitySample"]["rows"]
    if low_distinct["label"] > 256 or high_distinct["label"] != sample_rows:
        raise RuntimeError("low/high cardinality label contract was not generated")
    if low_distinct["category"] >= high_distinct["category"]:
        raise RuntimeError("low/high cardinality category contrast was not generated")

    small_documents: list[dict[str, Any]] = []
    overflow_document: dict[str, Any] | None = None
    if not args.skip_small_docs:
        small_documents, overflow_document = write_small_documents(args.output / "small-documents")

    base = Path.cwd()
    for fixture in fixtures:
        fixture["path"] = _relative_path(Path(fixture["path"]), base)
    for document in small_documents:
        document["path"] = _relative_path(Path(document["path"]), base)
    if overflow_document is not None:
        overflow_document["path"] = _relative_path(Path(overflow_document["path"]), base)

    manifest = {
        "schemaVersion": 2,
        "generatorRevision": REVISION,
        "seed": SEED,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "profile": args.profile,
        "settings": {
            "rows": settings["rows"],
            "columns": len(SCHEMA),
            "rowGroupSize": settings["row_group_size"],
            "compression": COMPRESSION,
            "compressionLevel": COMPRESSION_LEVEL,
            "streamingMaxRowsInMemory": settings["row_group_size"],
        },
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "pyarrow": pa.__version__,
            "numpy": np.__version__,
        },
        "cardinalityContract": {
            "sameLogicalSchema": True,
            "sameRowGroupAndCompressionSettings": True,
            "low": "repeated categorical, integer, timestamp, decimal, label, score, and code values",
            "high": "unique or near-unique values for the same logical columns where the type permits",
            "fileBytesArePassCondition": False,
        },
        "fixtures": fixtures,
        "smallDocuments": {
            "id": "F-P8-09",
            "openLimit": 64,
            "batchLimit": 32,
            "documents": small_documents,
            "overflowDocument": overflow_document,
        },
    }
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
