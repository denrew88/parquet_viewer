"""Build the Phase 7 data runner and preserve raw benchmark and soak results."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import statistics
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def run_json(command: list[str]) -> object:
    completed = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    return json.loads(completed.stdout)


def percentile(values: list[float], percentage: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * percentage + 0.999999)))
    return ordered[index]


def metric_summary(samples: list[dict[str, object]], key: str) -> dict[str, float]:
    values = [float(sample[key]) for sample in samples]
    return {
        "medianMs": round(statistics.median(values), 3),
        "p95Ms": round(percentile(values, 0.95), 3),
        "maxMs": round(max(values), 3),
    }


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("artifacts/phase-7/benchmark-manifest.json"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/phase-7/benchmark-results.json"))
    parser.add_argument("--soak-output", type=Path, default=Path("artifacts/phase-7/soak-results.json"))
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=100)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    subprocess.run(
        ["cargo", "build", "--release", "--offline", "--manifest-path", "scripts/phase7-runner/Cargo.toml"],
        check=True,
    )
    executable = Path("scripts/phase7-runner/target/release/phase7-data-runner.exe")
    if os.name != "nt":
        executable = executable.with_suffix("")

    raw = []
    for fixture in manifest["fixtures"]:
        raw.append(
            run_json(
                [
                    str(executable),
                    "benchmark",
                    fixture["path"],
                    str(fixture["rows"]),
                    str(args.runs),
                ]
            )
        )
    summaries = []
    for fixture in raw:
        samples = fixture["samples"]
        summaries.append(
            {
                "fixtureName": fixture["fixtureName"],
                "open": metric_summary(samples, "openMs"),
                "firstPage": metric_summary(samples, "firstPageMs"),
                "cachedPage": metric_summary(samples, "cachedPageMs"),
                "randomPage": metric_summary(samples, "randomPageMs"),
            }
        )

    environment = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "processor": platform.processor(),
        "python": platform.python_version(),
        "powerCondition": "not programmatically pinned",
        "antivirusAndOsCache": "not disabled; results are gate-profile engineering measurements",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "manifestSha256": sha256(args.manifest),
                "environment": environment,
                "measurement": "in-process Rust DataSource and DocumentRegistry; release optimized runner",
                "raw": raw,
                "summary": summaries,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    paths = [fixture["path"] for fixture in manifest["fixtures"]]
    soak = run_json([str(executable), "soak", str(args.iterations), *paths])
    soak["environment"] = environment
    soak["runnerSha256"] = sha256(executable)
    args.soak_output.write_text(json.dumps(soak, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
