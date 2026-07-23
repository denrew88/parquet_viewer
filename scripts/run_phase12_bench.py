"""Prepare or execute the Phase 12 release benchmark evidence contract.

Without ``--execute`` this command writes honest ``NOT_RUN`` scaffold files.  Once the ignored
Rust release harness exists, ``--execute`` passes fixture/evidence paths through environment
variables, requires raw JSON from that harness, and summarizes only measured samples.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_TEST_FILTER = "phase12_release"
REQUIRED_COUNTERS = (
    "identityRows",
    "requestedColumns",
    "sourceReadsBeforeIdentityLimit",
    "selectedRowGroups",
    "decodedRows",
    "decodedColumns",
    "pageValueIpcCalls",
    "frontendValueBatchIpcCalls",
)
MAX_QUERY_RSS_BYTES = 1536 * 1024 * 1024
MAX_QUERY_TEMP_BYTES = 10 * 1024 * 1024 * 1024
CASE_DURATION_BUDGET_MS = {
    "index-low-group-id-asc": 1500.0,
    "index-high-group-id-asc": 2000.0,
    "index-low-selective-filter-3-sort": 2500.0,
    "index-high-selective-filter-3-sort": 2500.0,
    "index-low-nonselective-filter-3-sort": 4000.0,
    "index-high-nonselective-filter-3-sort": 4000.0,
}
PAGE_DURATION_BUDGET_MS = {
    "prepared-pages-low": 250.0,
    "prepared-pages-high": 1000.0,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_recorded_path(value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()


def relative_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(resolved)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def percentile(values: list[float], percentile_value: float) -> float:
    require(bool(values), "Cannot summarize an empty measurement list")
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile_value * len(ordered)))
    return ordered[rank - 1]


def machine_info(temp_parent: Path) -> dict[str, Any]:
    usage = shutil.disk_usage(temp_parent)
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "processor": platform.processor() or "unknown",
        "logicalCpuCount": os.cpu_count(),
        "storage": {
            "path": str(temp_parent.resolve()),
            "capacityBytes": usage.total,
            "freeBytes": usage.free,
        },
    }


def fixture_preflight(manifest_path: Path, reference_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("validation") == "PASS", "Fixture manifest is not validated")
    require(sha256_file(reference_path) == manifest["reference"]["sha256"], "Reference hash mismatch")
    fixtures = []
    for entry in manifest["fixtures"]:
        if entry.get("cardinality") not in {"low", "high"}:
            continue
        path = resolve_recorded_path(entry["path"])
        require(path.is_file(), f"Missing benchmark fixture: {path}")
        require(path.stat().st_size == entry["bytes"], f"Fixture size mismatch: {path.name}")
        require(sha256_file(path) == entry["sha256"], f"Fixture hash mismatch: {path.name}")
        fixtures.append(
            {
                "id": entry["id"],
                "cardinality": entry["cardinality"],
                "path": relative_path(path),
                "rows": entry["rows"],
                "columns": entry["columns"],
                "rowGroups": entry["rowGroups"],
                "bytes": entry["bytes"],
                "sha256": entry["sha256"],
            }
        )
    require({fixture["cardinality"] for fixture in fixtures} == {"low", "high"}, "Low/high fixture pair is incomplete")
    return manifest, fixtures


def planned_cases(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cases = []
    for fixture in fixtures:
        suffix = fixture["cardinality"]
        cases.extend(
            [
                {
                    "id": f"index-{suffix}-group-id-asc",
                    "fixtureId": fixture["id"],
                    "operation": "prepareIndex",
                    "plan": {"filters": [], "sort": ["group_id ASC NULLS LAST", "row_id ASC"]},
                },
                {
                    "id": f"index-{suffix}-selective-filter-3-sort",
                    "fixtureId": fixture["id"],
                    "operation": "prepareIndexAndFirstPage",
                    "plan": {
                        "filters": ["active = true", "optional_value IS NOT NULL", "amount >= 10"],
                        "sort": ["group_id ASC NULLS LAST", "event_time DESC NULLS LAST", "label ASC NULLS LAST", "row_id ASC"],
                    },
                },
                {
                    "id": f"index-{suffix}-nonselective-filter-3-sort",
                    "fixtureId": fixture["id"],
                    "operation": "prepareIndexAndFirstPage",
                    "plan": {
                        "filters": ["row_id >= 0"],
                        "sort": ["group_id ASC NULLS LAST", "event_time DESC NULLS LAST", "label ASC NULLS LAST", "row_id ASC"],
                    },
                },
                {
                    "id": f"prepared-pages-{suffix}",
                    "fixtureId": fixture["id"],
                    "operation": "readPreparedPages",
                    "referenceLabels": ["first", "middle", "reported-986803", "last", "eof", "seed-00..19"],
                },
            ]
        )
    return cases


def base_documents(
    manifest_path: Path,
    reference_path: Path,
    fixture_audit_path: Path,
    fixtures: list[dict[str, Any]],
    raw_path: Path,
    temp_parent: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    cargo_command = [
        "cargo",
        "test",
        "--release",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        RUST_TEST_FILTER,
        "--",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]
    common = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "NOT_RUN",
        "reason": "Ignored Rust release benchmark has not been executed.",
        "fixtureManifest": relative_path(manifest_path),
        "reference": relative_path(reference_path),
        "fixtureAudit": relative_path(fixture_audit_path),
        "fixtures": fixtures,
        "machine": machine_info(temp_parent),
        "runner": {
            "workingDirectory": relative_path(REPO_ROOT),
            "command": cargo_command,
            "testFilter": RUST_TEST_FILTER,
            "environment": {
                "PHASE12_FIXTURE_MANIFEST": str(manifest_path.resolve()),
                "PHASE12_REFERENCE": str(reference_path.resolve()),
                "PHASE12_RAW_RESULTS": str(raw_path.resolve()),
                "PHASE12_TEMP_ROOT": str(temp_parent.resolve()),
            },
        },
    }
    benchmark = {
        **common,
        "protocol": {
            "duckDbThreads": "record actual value for every run",
            "coldRuns": 5,
            "coldDefinition": "new process/connection/result/temp and empty application cache; OS file cache is observed, not forcibly purged",
            "warmupRunsBeforeWarm": 1,
            "warmRuns": 5,
            "warmDefinition": "same fixture and OS cache, but a newly created result index/temp lease per run",
            "statistics": ["p50", "p95 nearest-rank", "max"],
            "rssSamplingIntervalMsMaximum": 50,
            "requiredResources": ["peakRssBytes", "tempHighWaterBytes"],
            "requiredCounters": list(REQUIRED_COUNTERS),
        },
        "cases": planned_cases(fixtures),
        "measurements": [],
        "summary": [],
    }
    plan_audit = {
        **common,
        "requiredAssertions": {
            "resultIndexColumns": ["__dv_row_id"],
            "orderedWindowPositionColumns": 0,
            "sourceValueColumnsInIndex": 0,
            "identityRowsPerGridPageMaximum": 200,
            "projectionColumnsPerGridPageMaximum": 64,
            "sourceReadsBeforeIdentityLimit": 0,
            "queryMutexHeldDuringSourceDecode": False,
            "unboundedQueryResultSourceJoin": 0,
        },
        "plans": [],
        "counterAudits": [],
    }
    return benchmark, plan_audit


def validate_raw(raw: dict[str, Any], case_ids: set[str]) -> list[dict[str, Any]]:
    require(raw.get("schemaVersion") == 1, "Unsupported raw benchmark schema")
    runs = raw.get("runs")
    require(isinstance(runs, list) and runs, "Raw benchmark has no runs")
    grouped_samples: dict[tuple[str, str], set[int]] = {}
    for run in runs:
        case_id = run.get("caseId")
        temperature = run.get("temperature")
        require(case_id in case_ids, f"Unknown raw case: {case_id}")
        require(temperature in {"cold", "warm"}, "Raw temperature must be cold or warm")
        sample = run.get("sample")
        require(isinstance(sample, int) and 1 <= sample <= 5, "Raw sample must be an integer from 1 to 5")
        group = grouped_samples.setdefault((case_id, temperature), set())
        require(sample not in group, f"Duplicate raw sample: {case_id}/{temperature}/{sample}")
        group.add(sample)
        require(float(run.get("durationMs", -1)) >= 0, "Raw duration is invalid")
        require(int(run.get("peakRssBytes", -1)) > 0, "Raw peak RSS is unavailable or invalid")
        require(int(run.get("tempHighWaterBytes", -1)) >= 0, "Raw temp high-water is invalid")
        require(int(run.get("duckDbThreads", 0)) > 0, "Raw DuckDB thread count is invalid")
        resource = run.get("resourceMeasurement", {})
        require(bool(resource.get("peakRss")), "Raw peak RSS measurement method is missing")
        require(bool(resource.get("tempHighWater")), "Raw temp measurement method is missing")
        require(
            0 < int(resource.get("samplingIntervalMs", 0)) <= 50,
            "Raw resource sampling interval must be between 1 and 50 ms",
        )
        counters = run.get("counters", {})
        for counter in REQUIRED_COUNTERS:
            require(counter in counters and int(counters[counter]) >= 0, f"Missing counter {counter}")
        page_durations = run.get("pageDurationsMs")
        require(isinstance(page_durations, list), "Raw page durations are missing")
        if case_id.startswith("prepared-pages-"):
            require(len(page_durations) >= 20, f"{case_id}: random page timing coverage is incomplete")
        elif "filter-3-sort" in case_id:
            require(len(page_durations) == 1, f"{case_id}: first-page timing is missing")
        else:
            require(not page_durations, f"{case_id}: unexpected page timings")
        require(
            all(float(duration) >= 0 for duration in page_durations),
            f"{case_id}: page duration is invalid",
        )
    expected_groups = {(case_id, temperature) for case_id in case_ids for temperature in ("cold", "warm")}
    require(set(grouped_samples) == expected_groups, "Raw benchmark is missing a case/temperature group")
    for group, samples in grouped_samples.items():
        require(samples == {1, 2, 3, 4, 5}, f"{group[0]}/{group[1]} does not contain exactly samples 1..5")

    plans = raw.get("plans")
    require(isinstance(plans, list), "Raw benchmark has no plan audits")
    require({plan.get("caseId") for plan in plans} == case_ids, "Plan audits do not cover every case exactly once")
    require(len(plans) == len(case_ids), "Plan audits contain duplicate cases")
    for plan in plans:
        require(plan.get("resultIndexColumns") == ["__dv_row_id"], "Result index schema invariant failed")
        require(bool(plan.get("materializePhysicalPlan")), "Materialize EXPLAIN evidence is missing")
        require(bool(plan.get("pageIdentityPhysicalPlan")), "Page identity EXPLAIN evidence is missing")
        require(int(plan.get("duckDbThreads", 0)) > 0, "Plan DuckDB thread count is invalid")
        assertions = plan.get("assertions", {})
        require(assertions.get("identityOnlyResultIndex") is True, "Result index contains source values")
        require(assertions.get("physicalRowIdsContiguous") is True, "Physical row IDs are not contiguous")
        require(int(assertions.get("orderedWindowPositionColumns", -1)) == 0, "Ordered position column remains")
        require(int(assertions.get("sourceValueColumnsInIndex", -1)) == 0, "Source value column remains in index")
        require(
            0 <= int(assertions.get("identityRowsPerGridPageMaximum", -1)) <= 200,
            "Grid page identity limit exceeds 200",
        )
        require(
            0 <= int(assertions.get("projectionColumnsPerGridPageMaximum", -1)) <= 64,
            "Grid page projection limit exceeds 64",
        )
        require(int(assertions.get("sourceReadsBeforeIdentityLimit", -1)) == 0, "Source read precedes identity limit")
        require(assertions.get("queryMutexHeldDuringSourceDecode") is False, "Query mutex is held during source decode")
        require(int(assertions.get("unboundedQueryResultSourceJoin", -1)) == 0, "Unbounded result/source join remains")

    counter_audits = raw.get("counterAudits")
    require(isinstance(counter_audits, list), "Raw benchmark has no counter audits")
    require(len(counter_audits) == len(runs), "Counter audit count does not match measured runs")
    return runs


def summarize(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for run in runs:
        groups.setdefault((run["caseId"], run["temperature"]), []).append(run)
    summaries = []
    for (case_id, temperature), samples in sorted(groups.items()):
        require(len(samples) == 5, f"{case_id}/{temperature}: expected exactly 5 measured runs")
        durations = [float(sample["durationMs"]) for sample in samples]
        page_durations = [
            float(duration)
            for sample in samples
            for duration in sample["pageDurationsMs"]
        ]
        page_summary = (
            {
                "samples": len(page_durations),
                "p50": percentile(page_durations, 0.50),
                "p95": percentile(page_durations, 0.95),
                "max": max(page_durations),
            }
            if page_durations
            else None
        )
        summaries.append(
            {
                "caseId": case_id,
                "temperature": temperature,
                "runs": len(samples),
                "durationMs": {
                    "p50": percentile(durations, 0.50),
                    "p95": percentile(durations, 0.95),
                    "max": max(durations),
                },
                "peakRssBytes": max(int(sample["peakRssBytes"]) for sample in samples),
                "tempHighWaterBytes": max(int(sample["tempHighWaterBytes"]) for sample in samples),
                "pageDurationMs": page_summary,
            }
        )
    return summaries


def judge(summary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    judgements = []
    for item in summary:
        case_id = item["caseId"]
        checks = {
            "peakRss": {
                "actual": item["peakRssBytes"],
                "maximum": MAX_QUERY_RSS_BYTES,
                "pass": item["peakRssBytes"] <= MAX_QUERY_RSS_BYTES,
            },
            "tempHighWater": {
                "actual": item["tempHighWaterBytes"],
                "maximum": MAX_QUERY_TEMP_BYTES,
                "pass": item["tempHighWaterBytes"] <= MAX_QUERY_TEMP_BYTES,
            },
        }
        if case_id in CASE_DURATION_BUDGET_MS:
            maximum = CASE_DURATION_BUDGET_MS[case_id]
            checks["durationP95"] = {
                "actual": item["durationMs"]["p95"],
                "maximum": maximum,
                "pass": item["durationMs"]["p95"] <= maximum,
            }
        if case_id in PAGE_DURATION_BUDGET_MS:
            maximum = PAGE_DURATION_BUDGET_MS[case_id]
            checks["pageDurationP95"] = {
                "actual": item["pageDurationMs"]["p95"],
                "maximum": maximum,
                "pass": item["pageDurationMs"]["p95"] <= maximum,
            }
        judgements.append(
            {
                "caseId": case_id,
                "temperature": item["temperature"],
                "checks": checks,
                "result": "PASS" if all(check["pass"] for check in checks.values()) else "FAIL",
            }
        )
    return judgements


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("artifacts/phase-12/fixture-manifest.json"))
    parser.add_argument("--reference", type=Path, default=Path("artifacts/phase-12/reference-pages.json"))
    parser.add_argument("--fixture-audit", type=Path, default=Path("artifacts/phase-12/fixture-audit.json"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/phase-12/benchmark-results.json"))
    parser.add_argument("--plan-output", type=Path, default=Path("artifacts/phase-12/query-plan-audit.json"))
    parser.add_argument("--raw-output", type=Path, default=Path(".tmp/phase12-bench/raw-results.json"))
    parser.add_argument("--temp-root", type=Path, default=Path(".tmp/phase12-bench/temp"))
    parser.add_argument("--execute", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest.resolve()
    reference_path = args.reference.resolve()
    fixture_audit_path = args.fixture_audit.resolve()
    raw_path = args.raw_output.resolve()
    temp_root = args.temp_root.resolve()
    temp_root.mkdir(parents=True, exist_ok=True)
    _, fixtures = fixture_preflight(manifest_path, reference_path)
    fixture_audit = json.loads(fixture_audit_path.read_text(encoding="utf-8"))
    require(fixture_audit.get("result") == "PASS", "Fixture audit is not PASS")
    benchmark, plan_audit = base_documents(
        manifest_path,
        reference_path,
        fixture_audit_path,
        fixtures,
        raw_path,
        temp_root,
    )
    write_json(args.output, benchmark)
    write_json(args.plan_output, plan_audit)
    if not args.execute:
        print(json.dumps({"benchmark": str(args.output.resolve()), "planAudit": str(args.plan_output.resolve()), "status": "NOT_RUN"}))
        return 0

    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.unlink(missing_ok=True)
    environment = os.environ.copy()
    environment.update(benchmark["runner"]["environment"])
    completed = subprocess.run(
        benchmark["runner"]["command"], cwd=REPO_ROOT, env=environment, text=True, capture_output=True, check=False
    )
    benchmark["runner"]["exitCode"] = completed.returncode
    benchmark["runner"]["stdoutTail"] = completed.stdout[-8_000:]
    benchmark["runner"]["stderrTail"] = completed.stderr[-8_000:]
    if completed.returncode != 0 or not raw_path.is_file():
        benchmark["status"] = "FAIL"
        benchmark["reason"] = "Ignored Rust release benchmark failed or did not produce raw JSON."
        write_json(args.output, benchmark)
        raise RuntimeError(benchmark["reason"])

    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    runs = validate_raw(raw, {case["id"] for case in benchmark["cases"]})
    benchmark["measurements"] = runs
    benchmark["summary"] = summarize(runs)
    benchmark["budgets"] = {
        "caseDurationP95Ms": CASE_DURATION_BUDGET_MS,
        "pageDurationP95Ms": PAGE_DURATION_BUDGET_MS,
        "peakRssBytes": MAX_QUERY_RSS_BYTES,
        "tempHighWaterBytes": MAX_QUERY_TEMP_BYTES,
    }
    benchmark["judgements"] = judge(benchmark["summary"])
    benchmark["measurementStatus"] = "MEASURED"
    benchmark["status"] = (
        "PASS"
        if all(item["result"] == "PASS" for item in benchmark["judgements"])
        else "FAIL"
    )
    benchmark["reason"] = None
    plan_audit["plans"] = raw.get("plans", [])
    plan_audit["counterAudits"] = raw.get("counterAudits", [])
    plan_audit["status"] = "PASS"
    plan_audit["reason"] = None
    write_json(args.output, benchmark)
    write_json(args.plan_output, plan_audit)
    print(json.dumps({"benchmark": str(args.output.resolve()), "planAudit": str(args.plan_output.resolve()), "status": benchmark["status"]}))
    return 0 if benchmark["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
