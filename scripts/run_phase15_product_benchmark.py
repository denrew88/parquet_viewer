#!/usr/bin/env python3
"""Run the release product-path CSV benchmark and sample the whole process tree."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import time
from pathlib import Path

import psutil


TEST_NAME = "query::phase13_large_tests::phase14_profile_5850000_high_csv_stages"
POLL_SECONDS = 0.05


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def process_tree_rss(root: psutil.Process) -> tuple[int, int]:
    processes = [root]
    try:
        processes.extend(root.children(recursive=True))
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    total = 0
    child_total = 0
    for process in processes:
        try:
            rss = process.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        total += rss
        if process.pid != root.pid:
            child_total += rss
    return total, child_total


def run_once(executable: Path, profile_path: Path) -> dict[str, object]:
    environment = os.environ.copy()
    environment["DV_CSV_STAGE_PROFILE_OUTPUT"] = str(profile_path.resolve())
    command = [
        str(executable.resolve()),
        "--exact",
        TEST_NAME,
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]
    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    root = psutil.Process(process.pid)
    peak_tree_rss = 0
    peak_children_rss = 0
    samples = 0
    while process.poll() is None:
        tree_rss, children_rss = process_tree_rss(root)
        peak_tree_rss = max(peak_tree_rss, tree_rss)
        peak_children_rss = max(peak_children_rss, children_rss)
        samples += 1
        time.sleep(POLL_SECONDS)
    stdout, stderr = process.communicate()
    wall_ms = (time.perf_counter() - started) * 1_000.0
    if process.returncode != 0:
        raise RuntimeError(
            f"benchmark failed with {process.returncode}\nstdout:\n{stdout[-4000:]}\n"
            f"stderr:\n{stderr[-4000:]}"
        )
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    return {
        "wallMs": wall_ms,
        "readyTotalMs": profile["readyTotalMs"],
        "providerTotalMs": profile["providerTotalMs"],
        "provider": profile["metrics"].get("csvPreparationProvider"),
        "classifierReason": profile["metrics"].get("csvClassifierReason"),
        "sourceReadBytes": profile["metrics"]["sourceReadBytes"],
        "cacheOutputBytes": profile["metrics"]["cacheOutputBytesBeforePersistentCopy"],
        "peakTreeRssBytes": peak_tree_rss,
        "peakChildrenRssBytes": peak_children_rss,
        "rssPollMs": int(POLL_SECONDS * 1_000),
        "rssSamples": samples,
        "stdoutTail": stdout[-2000:],
        "stderrTail": stderr[-2000:],
        "profilePath": str(profile_path.resolve()),
    }


def main() -> None:
    args = parse_args()
    if args.runs < 1:
        raise SystemExit("--runs must be positive")
    if not args.executable.is_file():
        raise SystemExit(f"release test executable not found: {args.executable}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    profile_directory = args.output.parent / "product-benchmark-runs"
    profile_directory.mkdir(parents=True, exist_ok=True)
    runs = []
    for index in range(args.runs):
        profile = profile_directory / f"run-{index + 1}.json"
        result = run_once(args.executable, profile)
        result["run"] = index + 1
        runs.append(result)
        print(
            f"run {index + 1}: ready={result['readyTotalMs']:.1f}ms "
            f"peak={result['peakTreeRssBytes'] / (1024 ** 3):.3f}GiB "
            f"provider={result['provider']}"
        )
    ready = sorted(float(run["readyTotalMs"]) for run in runs)
    evidence = {
        "schemaVersion": 1,
        "executable": str(args.executable.resolve()),
        "executableBytes": args.executable.stat().st_size,
        "runs": runs,
        "summary": {
            "samples": len(runs),
            "readyMedianMs": statistics.median(ready),
            "readyP95MsFiveSampleMax": max(ready),
            "peakTreeRssBytes": max(int(run["peakTreeRssBytes"]) for run in runs),
            "allPolars": all(run["provider"] == "polars" for run in runs),
            "allClassifierReasonsEmpty": all(
                run["classifierReason"] is None for run in runs
            ),
        },
    }
    args.output.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
