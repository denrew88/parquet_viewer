"""Audit Phase 8 generated fixtures independently from manifest creation."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from generate_phase8_fixtures import parquet_details, sha256_file


def require_equal(fixture_id: str, field: str, expected: Any, actual: Any) -> None:
    if expected != actual:
        raise AssertionError(
            f"{fixture_id}.{field} mismatch: expected {expected!r}, got {actual!r}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest", type=Path, default=Path("artifacts/phase-8/fixture-manifest.json")
    )
    parser.add_argument(
        "--output", type=Path, default=Path("artifacts/phase-8/fixture-audit.json")
    )
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))

    results = []
    expected_schema = None
    for expected in manifest["fixtures"]:
        path = Path(expected["path"])
        actual = parquet_details(
            path,
            expected["id"],
            expected["cardinality"],
            expected["rowGroupSize"],
        )
        checked_fields = [
            "rows",
            "columns",
            "rowGroupSize",
            "rowGroups",
            "bytes",
            "sha256",
            "compression",
            "schema",
            "columnEncodings",
            "cardinalitySample",
            "representativePages",
        ]
        for field in checked_fields:
            require_equal(expected["id"], field, expected[field], actual[field])
        if expected_schema is None:
            expected_schema = expected["schema"]
        else:
            require_equal(expected["id"], "crossFixtureSchema", expected_schema, expected["schema"])
        results.append(
            {
                "id": expected["id"],
                "status": "PASS",
                "path": expected["path"],
                "checkedFields": checked_fields,
            }
        )

    small_documents = manifest["smallDocuments"]
    if small_documents["documents"]:
        require_equal("F-P8-09", "documentCount", 64, len(small_documents["documents"]))
        for expected in small_documents["documents"]:
            path = Path(expected["path"])
            require_equal(str(expected["ordinal"]), "bytes", expected["bytes"], path.stat().st_size)
            require_equal(str(expected["ordinal"]), "sha256", expected["sha256"], sha256_file(path))
        overflow = small_documents["overflowDocument"]
        if overflow is None:
            raise AssertionError("F-P8-09 overflow document is missing")
        overflow_path = Path(overflow["path"])
        require_equal("F-P8-09", "overflowBytes", overflow["bytes"], overflow_path.stat().st_size)
        require_equal("F-P8-09", "overflowSha256", overflow["sha256"], sha256_file(overflow_path))

    audit = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "manifest": args.manifest.as_posix(),
        "manifestSha256": sha256_file(args.manifest),
        "status": "PASS",
        "fixtures": results,
        "smallDocumentCount": len(small_documents["documents"]),
        "overflowDocumentVerified": small_documents["overflowDocument"] is not None,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
