"""Generate deterministic Phase 14 CSV correctness fixtures and reference Phase 13 large files.

This script never regenerates the 5,850,000-row inputs.  It records the existing
Phase 13 fixture identity in the Phase 14 manifest so both phases measure the same
bytes.  Only the small fixtures below ``.tmp/phase14-fixtures`` are owned here.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import platform
import re
import shutil
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


GENERATOR_VERSION = "phase14-fixtures-v1"
SCHEMA_VERSION = 1
SEED = 20260723
CHECKPOINT_INTERVAL = 4_096
ROW_GROUP_ROWS = 65_536
CHECKPOINT_ROWS = 65_537
DEFAULT_OUTPUT = Path(".tmp/phase14-fixtures")
DEFAULT_MANIFEST = Path("artifacts/phase-14/fixture-manifest.json")
PHASE13_MANIFEST = Path("artifacts/phase-13/fixture-manifest.json")
LARGE_IDS = (
    "csv-5850000-low",
    "csv-5850000-high",
    "csv-5850000-long-invalid",
)
STATE_CODES = {"valid": 0, "null": 1, "empty": 2, "invalid": 3}
NULL_TOKEN = "__NULL__"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_bytes(payload)
    partial.replace(path)


def write_json(path: Path, payload: Any) -> None:
    write_bytes(path, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode())


def portable_path(path: Path, workspace: Path) -> str:
    try:
        return path.resolve().relative_to(workspace.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def fixture_entry(
    fixture_id: str,
    path: Path,
    workspace: Path,
    *,
    rows: int | None,
    columns: int | None,
    profile: dict[str, Any],
    oracle_path: Path | None = None,
) -> dict[str, Any]:
    return {
        "id": fixture_id,
        "kind": path.suffix.removeprefix("."),
        "path": portable_path(path, workspace),
        "rows": rows,
        "columns": columns,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "profile": profile,
        "oraclePath": portable_path(oracle_path, workspace) if oracle_path else None,
        "oracleSha256": sha256_file(oracle_path) if oracle_path else None,
        "source": "phase14-generated",
    }


def classify(raw: str, kind: str) -> tuple[str, Any]:
    if raw == "":
        return "empty", None
    if raw == NULL_TOKEN:
        return "null", None
    if kind == "text":
        return "valid", raw
    try:
        if kind in {"int64", "uint64"}:
            value = int(raw, 10)
            minimum, maximum = (
                (-(2**63), 2**63 - 1) if kind == "int64" else (0, 2**64 - 1)
            )
            if not minimum <= value <= maximum or not re.fullmatch(r"[+-]?\d+", raw):
                raise ValueError
            return "valid", str(value)
        if kind == "boolean":
            value = raw.casefold()
            if value not in {"true", "false"}:
                raise ValueError
            return "valid", value == "true"
        if kind == "decimal":
            value = Decimal(raw)
            if not value.is_finite():
                raise ValueError
            return "valid", format(value, "f")
        if kind == "date":
            datetime.strptime(raw, "%Y-%m-%d")
            return "valid", raw
        if kind == "timestamp":
            if not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?",
                raw,
            ):
                raise ValueError
            return "valid", raw
        if kind == "duration_ns":
            if not re.fullmatch(r"[+-]?\d+", raw):
                raise ValueError
            value = int(raw, 10)
            if not -(2**63) <= value <= 2**63 - 1:
                raise ValueError
            return "valid", str(value)
    except (InvalidOperation, ValueError):
        return "invalid", None
    raise ValueError(f"Unsupported profile kind: {kind}")


def pack_states(columns: list[str], rows: list[dict[str, Any]]) -> str:
    payload = bytearray((len(columns) * len(rows) * 2 + 7) // 8)
    cell_index = 0
    for column in columns:
        for row in rows:
            code = STATE_CODES[row["cells"][column]["state"]]
            payload[cell_index // 4] |= code << ((cell_index % 4) * 2)
            cell_index += 1
    return payload.hex()


def make_state_matrix(root: Path, workspace: Path) -> list[dict[str, Any]]:
    path = root / "small" / "csv-state-matrix.csv"
    oracle_path = root / "small" / "csv-state-matrix.oracle.json"
    profiles = {
        "row_id": "int64",
        "text_value": "text",
        "int_value": "int64",
        "boolean_value": "boolean",
        "decimal_value": "decimal",
        "date_value": "date",
        "timestamp_value": "timestamp",
        "duration_value": "duration_ns",
    }
    raw_rows = [
        ["0", "alpha", "42", "true", "1234.500", "2026-07-23", "2025-12-18T01:23:34.111111111Z", "1"],
        ["1", "", "", "", "", "", "", ""],
        ["2", *([NULL_TOKEN] * 7)],
        ["3", "text-is-valid", "x", "maybe", "1.2.3", "2025-02-30", "not-ts", "1.5"],
        ["4", "   ", "0", "false", "0", "1970-01-01", "1970-01-01T00:00:00Z", "0"],
        ["5", "line1\nline2", "001", "TRUE", "001.00", "2024-02-29", "2025-12-18T01:23:34.111111111+09:00", "-1"],
    ]
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    columns = list(profiles)
    writer.writerow(columns)
    writer.writerows(raw_rows)
    write_bytes(path, stream.getvalue().encode())

    rows: list[dict[str, Any]] = []
    for raw_row in raw_rows:
        cells: dict[str, Any] = {}
        for column, raw in zip(columns, raw_row, strict=True):
            state, typed = classify(raw, profiles[column])
            cells[column] = {"raw": raw, "state": state, "typed": typed}
        rows.append({"rowId": int(raw_row[0]), "cells": cells})
    oracle = {
        "schemaVersion": 1,
        "columnOrder": columns,
        "profileKinds": profiles,
        "nullToken": NULL_TOKEN,
        "stateCodes": STATE_CODES,
        "occupancy": {"occupied": ["valid", "invalid"], "empty": ["null", "empty"]},
        "bitmapLayout": "column-major, four 2-bit cells per byte, least-significant cell first",
        "bitmapHex": pack_states(columns, rows),
        "rows": rows,
    }
    write_json(oracle_path, oracle)
    return [
        fixture_entry(
            "csv-state-matrix",
            path,
            workspace,
            rows=len(raw_rows),
            columns=len(columns),
            profile={"header": True, "nullToken": NULL_TOKEN, "columns": profiles},
            oracle_path=oracle_path,
        ),
        fixture_entry(
            "csv-state-matrix-oracle",
            oracle_path,
            workspace,
            rows=len(raw_rows),
            columns=len(columns),
            profile={"kind": "independent-state-oracle"},
        ),
    ]


def make_checkpoint_fixture(root: Path, workspace: Path) -> list[dict[str, Any]]:
    path = root / "small" / "csv-checkpoint-boundaries.csv"
    oracle_path = root / "small" / "csv-checkpoint-boundaries.oracle.json"
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(["row_id", "payload", "optional_value"])
    row_starts: list[int] = []
    special = {4_095, 4_096, 4_097, 65_535, 65_536}
    for row_id in range(CHECKPOINT_ROWS):
        row_starts.append(stream.tell())
        payload = f"line-{row_id}-a\nline-{row_id}-b" if row_id in special else f"value-{row_id}"
        writer.writerow([row_id, payload, "" if row_id % 97 == 0 else row_id % 10_000])
    write_bytes(path, stream.getvalue().encode())
    observed_rows = sorted(
        set(range(0, CHECKPOINT_ROWS, CHECKPOINT_INTERVAL))
        | special
        | {0, 1, CHECKPOINT_ROWS - 1}
    )
    oracle = {
        "schemaVersion": 1,
        "rows": CHECKPOINT_ROWS,
        "columns": 3,
        "checkpointInterval": CHECKPOINT_INTERVAL,
        "rowGroupRows": ROW_GROUP_ROWS,
        "recordStartBytes": {str(row): row_starts[row] for row in observed_rows},
        "quotedMultilineRows": sorted(special),
        "emptyOptionalRowsRule": "row_id % 97 == 0",
        "lastRow": [str(CHECKPOINT_ROWS - 1), "line-65536-a\nline-65536-b", "5536"],
    }
    write_json(oracle_path, oracle)
    return [
        fixture_entry(
            "csv-checkpoint-boundaries",
            path,
            workspace,
            rows=CHECKPOINT_ROWS,
            columns=3,
            profile={"header": True, "checkpointInterval": CHECKPOINT_INTERVAL},
            oracle_path=oracle_path,
        ),
        fixture_entry(
            "csv-checkpoint-boundaries-oracle",
            oracle_path,
            workspace,
            rows=CHECKPOINT_ROWS,
            columns=3,
            profile={"kind": "logical-record-offset-oracle"},
        ),
    ]


def make_typed_raw_fixture(root: Path, workspace: Path) -> list[dict[str, Any]]:
    path = root / "small" / "csv-typed-raw.csv"
    oracle_path = root / "small" / "csv-typed-raw.oracle.json"
    columns = ["int64", "uint64", "decimal", "boolean", "date", "timestamp", "duration", "text"]
    kinds = {
        "int64": "int64",
        "uint64": "uint64",
        "decimal": "decimal",
        "boolean": "boolean",
        "date": "date",
        "timestamp": "timestamp",
        "duration": "duration_ns",
        "text": "text",
    }
    raw_rows = [
        ["-9223372036854775808", "18446744073709551615", "001.2300", "TRUE", "2024-02-29", "2025-12-18T01:23:34.111111111Z", "9223372036854775807", "001.2300"],
        ["001", "000", "-0.0100", "false", "1970-01-01", "2025-12-18T01:23:34.111111111+09:00", "-1", "line1\nline2"],
        [NULL_TOKEN] * len(columns),
        [""] * len(columns),
        ["9223372036854775808", "-1", "1.2.3", "maybe", "2025-02-30", "not-ts", "1.5", "invalid-looking text remains valid"],
    ]
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(raw_rows)
    write_bytes(path, stream.getvalue().encode())
    rows: list[dict[str, Any]] = []
    for raw_row in raw_rows:
        cells: dict[str, Any] = {}
        for column, raw in zip(columns, raw_row, strict=True):
            state, typed = classify(raw, kinds[column])
            default_copy = typed
            if column == "timestamp" and state == "valid":
                default_copy = raw.replace("T", " ")
                default_copy = re.sub(r"(?:Z|[+-]\d{2}:\d{2})$", "", default_copy)
            cells[column] = {
                "raw": raw,
                "state": state,
                "typed": typed,
                "defaultCopy": default_copy,
                "rawCopy": raw,
            }
        rows.append({"cells": cells})
    oracle = {
        "schemaVersion": 1,
        "columnOrder": columns,
        "profileKinds": kinds,
        "nullToken": NULL_TOKEN,
        "rows": rows,
        "timestampDefault": "YYYY-MM-DD HH24:MI:SS.F... without timezone annotation",
        "copyRule": "default uses typed formatter snapshot; raw preserves source lexeme",
    }
    write_json(oracle_path, oracle)
    return [
        fixture_entry(
            "csv-typed-raw",
            path,
            workspace,
            rows=len(raw_rows),
            columns=len(columns),
            profile={"header": True, "nullToken": NULL_TOKEN, "columns": kinds},
            oracle_path=oracle_path,
        ),
        fixture_entry(
            "csv-typed-raw-oracle",
            oracle_path,
            workspace,
            rows=len(raw_rows),
            columns=len(columns),
            profile={"kind": "typed-raw-copy-oracle"},
        ),
    ]


def large_references(workspace: Path) -> list[dict[str, Any]]:
    manifest_path = workspace / PHASE13_MANIFEST
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    by_id = {entry["id"]: entry for entry in manifest["fixtures"]}
    references: list[dict[str, Any]] = []
    for fixture_id in LARGE_IDS:
        source = by_id.get(fixture_id)
        if not source:
            raise RuntimeError(f"Phase 13 manifest is missing {fixture_id}")
        recorded = Path(source["path"])
        path = recorded if recorded.is_absolute() else workspace / recorded
        references.append(
            {
                "id": fixture_id,
                "kind": "csv",
                "path": portable_path(path, workspace),
                "rows": source["rows"],
                "columns": source["columns"],
                "bytes": source["bytes"],
                "sha256": source["sha256"],
                "profile": source["profile"],
                "source": "phase13-reference",
                "sourceManifest": portable_path(manifest_path, workspace),
                "sourceManifestSha256": sha256_file(manifest_path),
                "available": path.is_file(),
            }
        )
    return references


def ensure_owned_output(workspace: Path, output: Path) -> None:
    relative = output.resolve().relative_to(workspace.resolve())
    if len(relative.parts) < 2 or relative.parts[0] != ".tmp" or not relative.parts[1].startswith("phase14-"):
        raise ValueError("output must be below .tmp/phase14-*")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--clean", action="store_true", help="remove only this generator's small directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = Path(__file__).resolve().parents[1]
    output = args.output_dir if args.output_dir.is_absolute() else workspace / args.output_dir
    manifest_path = args.manifest if args.manifest.is_absolute() else workspace / args.manifest
    ensure_owned_output(workspace, output)
    if args.clean and (output / "small").exists():
        shutil.rmtree(output / "small")
    output.mkdir(parents=True, exist_ok=True)

    fixtures: list[dict[str, Any]] = []
    fixtures.extend(make_state_matrix(output, workspace))
    fixtures.extend(make_checkpoint_fixture(output, workspace))
    fixtures.extend(make_typed_raw_fixture(output, workspace))
    fixtures.extend(large_references(workspace))
    generator_path = Path(__file__).resolve()
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "generator": portable_path(generator_path, workspace),
        "generatorSha256": sha256_file(generator_path),
        "seed": SEED,
        "generatedAtUtc": utc_now(),
        "outputDirectory": portable_path(output, workspace),
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
        "configuration": {
            "checkpointInterval": CHECKPOINT_INTERVAL,
            "rowGroupRows": ROW_GROUP_ROWS,
            "largeRows": 5_850_000,
            "largeFixturePolicy": "reference Phase 13; never regenerate",
        },
        "fixtures": fixtures,
        "summary": {
            "generatedFixtureCount": sum(item["source"] == "phase14-generated" for item in fixtures),
            "referencedLargeFixtureCount": sum(item["source"] == "phase13-reference" for item in fixtures),
            "allLargeReferencesAvailable": all(
                item.get("available", True) for item in fixtures if item["source"] == "phase13-reference"
            ),
        },
        "validation": "PENDING_AUDIT",
    }
    write_json(manifest_path, manifest)
    print(json.dumps({"manifest": portable_path(manifest_path, workspace), **manifest["summary"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
