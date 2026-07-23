"""Audit Phase 12 fixture hashes, schemas and independent query-page references."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

import generate_phase12_fixtures as phase12
import generate_phase9_large_fixtures as phase9


REPO_ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def resolve_recorded_path(value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def audit_large_fixture(entry: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
    path = resolve_recorded_path(entry["path"])
    require(path.is_file(), f"Missing fixture: {path}")
    require(phase12.sha256_file(path) == entry["sha256"], f"SHA-256 mismatch: {path.name}")
    cardinality = entry["cardinality"]
    actual = phase9.validate_fixture(
        path,
        int(configuration["rows"]),
        int(configuration["rowGroupSize"]),
        "full15",
        cardinality,
    )
    for field in ("rows", "columns", "rowGroupSize", "rowGroups", "schemaFingerprintSha256"):
        require(actual[field] == entry[field], f"{path.name}: {field} mismatch")
    require(actual["cardinalitySample"] == entry["cardinalitySample"], f"{path.name}: sample mismatch")
    return {
        "id": entry["id"],
        "path": phase12.relative_path(path),
        "kind": "large-parquet",
        "sha256": entry["sha256"],
        "result": "PASS",
    }


def audit_small_parquet(entry: dict[str, Any]) -> dict[str, Any]:
    path = resolve_recorded_path(entry["path"])
    require(path.is_file(), f"Missing fixture: {path}")
    require(phase12.sha256_file(path) == entry["sha256"], f"SHA-256 mismatch: {path.name}")
    table = pq.read_table(path)
    require(table.num_rows == entry["rows"], f"{path.name}: row count mismatch")
    require(table.num_columns == entry["columns"], f"{path.name}: column count mismatch")
    require(
        table["nullable_int"].to_pylist() == entry["expected"]["nullableInt"],
        f"{path.name}: nullable_int mismatch",
    )
    require(table["text"].to_pylist() == entry["expected"]["text"], f"{path.name}: text mismatch")
    require(
        table["whitespace"].to_pylist() == entry["expected"]["whitespace"],
        f"{path.name}: whitespace mismatch",
    )
    return {
        "id": entry["id"],
        "path": phase12.relative_path(path),
        "kind": entry["kind"],
        "sha256": entry["sha256"],
        "result": "PASS",
    }


def audit_invalid_csv(entry: dict[str, Any]) -> dict[str, Any]:
    path = resolve_recorded_path(entry["path"])
    require(path.is_file(), f"Missing fixture: {path}")
    require(phase12.sha256_file(path) == entry["sha256"], f"SHA-256 mismatch: {path.name}")
    with path.open("r", encoding="utf-8", newline="") as stream:
        rows = list(csv.reader(stream))
    require(rows == entry["expectedRawRows"], f"{path.name}: raw CSV rows mismatch")
    return {
        "id": entry["id"],
        "path": phase12.relative_path(path),
        "kind": entry["kind"],
        "sha256": entry["sha256"],
        "result": "PASS",
    }


def audit_reference(
    reference: dict[str, Any], configuration: dict[str, Any]
) -> dict[str, Any]:
    rows = int(configuration["rows"])
    seed = int(configuration["referenceSeed"])
    cardinalities = list(configuration["cardinalities"])
    expected = phase12.build_reference(rows, cardinalities, seed)
    require(reference == expected, "Reference JSON does not match the deterministic independent oracle")
    required_labels = {"first", "middle", "reported-986803", "last", "eof"}
    for fixture_id, fixture in reference["fixtures"].items():
        labels = {page["label"] for page in fixture["pages"]}
        require(required_labels <= labels, f"{fixture_id}: fixed reference offsets are incomplete")
        require(
            len([label for label in labels if label.startswith("seed-")]) == 20,
            f"{fixture_id}: expected 20 seeded random pages",
        )
    return {
        "fixtures": len(reference["fixtures"]),
        "pagesPerFixture": 25,
        "referenceSeed": seed,
        "result": "PASS",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest", type=Path, default=Path("artifacts/phase-12/fixture-manifest.json")
    )
    parser.add_argument(
        "--reference", type=Path, default=None, help="Override the reference path in the manifest"
    )
    parser.add_argument(
        "--output", type=Path, default=Path("artifacts/phase-12/fixture-audit.json")
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = load_json(args.manifest)
    require(manifest.get("schemaVersion") == 1, "Unsupported manifest schema version")
    require(manifest.get("revision") == phase12.REVISION, "Unexpected manifest revision")
    require(
        phase12.sha256_file(resolve_recorded_path(manifest["generator"]))
        == manifest["generatorSha256"],
        "Phase 12 generator hash mismatch",
    )
    require(
        phase12.sha256_file(resolve_recorded_path(manifest["reusedGenerator"]))
        == manifest["reusedGeneratorSha256"],
        "Reused Phase 9 generator hash mismatch",
    )

    configuration = manifest["configuration"]
    cardinalities = set(configuration["cardinalities"])
    results = []
    seen_large: set[str] = set()
    for entry in manifest["fixtures"]:
        kind = entry.get("kind")
        if kind == "small-parquet-null-empty":
            results.append(audit_small_parquet(entry))
        elif kind == "small-csv-invalid":
            results.append(audit_invalid_csv(entry))
        else:
            results.append(audit_large_fixture(entry, configuration))
            seen_large.add(entry["cardinality"])
    require(seen_large == cardinalities, "Large low/high fixture set does not match configuration")

    reference_path = (
        args.reference.resolve()
        if args.reference is not None
        else resolve_recorded_path(manifest["reference"]["path"])
    )
    require(reference_path.is_file(), f"Missing reference: {reference_path}")
    require(
        phase12.sha256_file(reference_path) == manifest["reference"]["sha256"],
        "Reference SHA-256 mismatch",
    )
    reference_result = audit_reference(load_json(reference_path), configuration)
    output = {
        "schemaVersion": 1,
        "revision": phase12.REVISION,
        "auditedAtUtc": datetime.now(timezone.utc).isoformat(),
        "manifest": phase12.relative_path(args.manifest),
        "reference": phase12.relative_path(reference_path),
        "fixtures": results,
        "referenceAudit": reference_result,
        "result": "PASS",
    }
    phase12.write_json(args.output, output)
    print(json.dumps({"output": str(args.output.resolve()), "result": "PASS"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
