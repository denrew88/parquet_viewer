"""Validate and summarize Phase 14 release benchmark samples.

The product/release harness writes the raw JSON.  This script owns the stable fixture
preflight, required operation matrix and hard-gate judgement so a browser mock cannot
be substituted for native measurements.  With ``--plan-only`` it emits a NOT_RUN
contract document without pretending that performance passed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = Path("artifacts/phase-14/fixture-manifest.json")
DEFAULT_AUDIT = Path("artifacts/phase-14/fixture-audit.json")
DEFAULT_OUTPUT = Path("artifacts/phase-14/csv-preparation-performance.json")
BASELINE_PREPARATION_MS = 151_500.0
MIB = 1024 * 1024
GIB = 1024 * MIB


REQUIRED_CASES: dict[str, dict[str, Any]] = {
    "preparation-low": {"samples": 5, "p95Ms": 60_000.0},
    "preparation-high": {"samples": 5, "p95Ms": 60_000.0},
    "ready-page": {"samples": 100, "p95Ms": 20.0},
    "source-ctrl-vertical-cold": {"samples": 50, "p95Ms": 100.0},
    "source-ctrl-vertical-warm": {"samples": 50, "p95Ms": 20.0},
    "source-ctrl-horizontal": {"samples": 50, "p95Ms": 20.0},
    "query-ctrl-cold": {"samples": 50, "p95Ms": 250.0},
    "query-ctrl-warm": {"samples": 50, "p95Ms": 20.0},
    "filter-three-sort": {"samples": 20, "p95Ms": 2_000.0},
    "copy-64000x1": {"samples": 20, "p95Ms": 150.0},
    "persistent-cache-reopen": {"samples": 20, "p95Ms": 1_000.0},
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else REPO_ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def percentile(values: list[float], quantile: float) -> float:
    require(values, "cannot calculate percentile of an empty sample")
    ordered = sorted(values)
    rank = max(0, math.ceil(quantile * len(ordered)) - 1)
    return ordered[rank]


def fixture_preflight(manifest_path: Path, audit_path: Path) -> dict[str, Any]:
    manifest = load_json(manifest_path)
    audit = load_json(audit_path)
    require(manifest["schemaVersion"] == 1, "unsupported fixture manifest schema")
    require(audit["summary"]["status"] == "PASS", "full fixture audit, including large hashes, is required")
    entries = {entry["id"]: entry for entry in manifest["fixtures"]}
    fixture_ids = ["csv-5850000-low", "csv-5850000-high", "csv-5850000-long-invalid"]
    for fixture_id in fixture_ids:
        entry = entries[fixture_id]
        path = resolve(Path(entry["path"]))
        require(path.is_file(), f"missing benchmark fixture {path}")
        require(path.stat().st_size == entry["bytes"], f"benchmark size mismatch for {fixture_id}")
    return {
        "manifest": manifest_path.resolve().relative_to(REPO_ROOT.resolve()).as_posix(),
        "manifestSha256": sha256_file(manifest_path),
        "audit": audit_path.resolve().relative_to(REPO_ROOT.resolve()).as_posix(),
        "auditSha256": sha256_file(audit_path),
        "fixtures": [
            {key: entries[fixture_id][key] for key in ("id", "path", "rows", "columns", "bytes", "sha256")}
            for fixture_id in fixture_ids
        ],
    }


def summarize(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        case_id = sample.get("caseId")
        require(case_id in REQUIRED_CASES, f"unknown benchmark case {case_id!r}")
        require(isinstance(sample.get("elapsedMs"), (int, float)) and sample["elapsedMs"] >= 0, f"invalid elapsedMs for {case_id}")
        grouped.setdefault(case_id, []).append(sample)
    require(set(grouped) == set(REQUIRED_CASES), "raw benchmark is missing one or more required cases")
    result: list[dict[str, Any]] = []
    for case_id, contract in REQUIRED_CASES.items():
        cases = grouped[case_id]
        require(len(cases) >= contract["samples"], f"{case_id} requires at least {contract['samples']} samples")
        elapsed = [float(item["elapsedMs"]) for item in cases]
        result.append(
            {
                "caseId": case_id,
                "samples": len(elapsed),
                "minMs": min(elapsed),
                "medianMs": statistics.median(elapsed),
                "p95Ms": percentile(elapsed, 0.95),
                "maxMs": max(elapsed),
                "budgetP95Ms": contract["p95Ms"],
            }
        )
    return result


def validate_counters(raw: dict[str, Any], fixture_entries: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    audits = raw.get("counterAudits")
    require(isinstance(audits, list) and audits, "raw benchmark has no counterAudits")
    results: list[dict[str, Any]] = []
    for audit in audits:
        fixture_id = audit["fixtureId"]
        fixture = fixture_entries[fixture_id]
        file_size = int(fixture["bytes"])
        prep_read = int(audit["preparationSourceReadBytes"])
        preview_read = int(audit["previewSourceReadBytes"])
        require(prep_read <= file_size + MIB, f"preparation source read gate failed for {fixture_id}")
        require(preview_read + prep_read <= math.floor(file_size * 1.01) + 8 * MIB, f"preview+preparation source read gate failed for {fixture_id}")
        require(int(audit["navigationSourceReadBytesAfterReady"]) == 0, f"Ready navigation read was not zero for {fixture_id}")
        require(int(audit["sourceScanStarted"]) == 1 and int(audit["sourceScanCompleted"]) == 1, f"single scan gate failed for {fixture_id}")
        require(int(audit["peakDecodedBatchBytes"]) <= 64 * MIB, f"decoded batch gate failed for {fixture_id}")
        require(int(audit["writerQueuePeakBatches"]) <= 2, f"writer queue gate failed for {fixture_id}")
        require(int(audit["processPeakRssBytes"]) <= int(1.5 * GIB), f"RSS gate failed for {fixture_id}")
        require(int(audit["partialArtifactBytesAtEnd"]) == 0, f"partial artifact remained for {fixture_id}")
        require(int(audit["staleCommitCount"]) == 0, f"stale commit observed for {fixture_id}")
        cache = audit["cacheBytes"]
        require(
            set(cache) == {"rawParquet", "typedParquet", "stateBitmap", "checkpointIndex", "manifest", "total"},
            f"incomplete cache byte components for {fixture_id}",
        )
        require(sum(int(cache[key]) for key in cache if key != "total") == int(cache["total"]), f"cache byte sum mismatch for {fixture_id}")
        require(int(cache["total"]) <= int(audit["temporaryStorageLimitBytes"]), f"temporary storage gate failed for {fixture_id}")
        results.append({"fixtureId": fixture_id, "result": "PASS", **audit})
    return results


def judge(summary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    judgements = [
        {
            "id": f"{item['caseId']}-p95",
            "actual": item["p95Ms"],
            "budget": item["budgetP95Ms"],
            "result": "PASS" if item["p95Ms"] <= item["budgetP95Ms"] else "FAIL",
        }
        for item in summary
    ]
    low = next(item for item in summary if item["caseId"] == "preparation-low")
    speedup = BASELINE_PREPARATION_MS / low["medianMs"] if low["medianMs"] else float("inf")
    judgements.append(
        {
            "id": "preparation-low-speedup",
            "actual": speedup,
            "budget": 2.5,
            "result": "PASS" if speedup >= 2.5 else "FAIL",
        }
    )
    return judgements


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--raw-input", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--plan-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    require(args.plan_only != bool(args.raw_input), "choose exactly one of --plan-only or --raw-input")
    manifest_path, audit_path, output_path = map(resolve, (args.manifest, args.audit, args.output))
    fixture_evidence = fixture_preflight(manifest_path, audit_path)
    document: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "machine": {"platform": platform.platform(), "python": platform.python_version()},
        "fixtureEvidence": fixture_evidence,
        "baseline": {"fixtureId": "csv-5850000-low", "preparationMs": BASELINE_PREPARATION_MS},
        "caseContract": REQUIRED_CASES,
        "status": "NOT_RUN",
        "reason": "Release benchmark raw input has not been supplied.",
    }
    exit_code = 0
    if args.raw_input:
        raw_path = resolve(args.raw_input)
        raw = load_json(raw_path)
        require(raw.get("schemaVersion") == 1, "unsupported raw benchmark schema")
        manifest_entries = {
            item["id"]: item for item in load_json(manifest_path)["fixtures"]
        }
        summary = summarize(raw.get("samples", []))
        counter_audits = validate_counters(raw, manifest_entries)
        judgements = judge(summary)
        document.update(
            {
                "rawInput": raw_path.resolve().relative_to(REPO_ROOT.resolve()).as_posix(),
                "rawInputSha256": sha256_file(raw_path),
                "summary": summary,
                "counterAudits": counter_audits,
                "judgements": judgements,
                "status": "PASS" if all(item["result"] == "PASS" for item in judgements) else "FAIL",
                "reason": None,
            }
        )
        exit_code = 0 if document["status"] == "PASS" else 1
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output_path), "status": document["status"]}))
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - compact CLI failure is the artifact contract
        print(json.dumps({"status": "FAIL", "error": str(error)}))
        raise SystemExit(1) from error
