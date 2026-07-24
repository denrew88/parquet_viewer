"""Run the Rust Polars CSV preparation POC in a fresh process and audit it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import polars as pl
import psutil


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / ".tmp/phase13-fixtures/large/csv-5850000-high.csv"
DEFAULT_BINARY = ROOT / "src-tauri/target/release/examples/phase15_polars_poc.exe"
DEFAULT_OUTPUT = ROOT / "artifacts/phase-15/polars-rust-poc.json"
EXPECTED_SOURCE_SHA256 = "082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sample_process(command: list[str]) -> tuple[subprocess.CompletedProcess[str], int, float]:
    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    peak_rss = 0
    while process.poll() is None:
        try:
            root = psutil.Process(process.pid)
            members = [root, *root.children(recursive=True)]
            rss = sum(member.memory_info().rss for member in members if member.is_running())
            peak_rss = max(peak_rss, rss)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        time.sleep(0.02)
    stdout, stderr = process.communicate()
    completed = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    return completed, peak_rss, (time.perf_counter() - started) * 1_000


def audit(output_directory: Path, expected_rows: int) -> dict[str, Any]:
    parquet_path = output_directory / "prepared.parquet"
    states_path = output_directory / "states.bin"
    schema = pl.scan_parquet(parquet_path).collect_schema()
    row_count = pl.scan_parquet(parquet_path).select(pl.len()).collect().item()
    with states_path.open("rb") as stream:
        header = stream.read(24)
    magic, state_rows, state_columns = struct.unpack("<8sQQ", header)
    expected_state_bytes = 24 + state_columns * ((state_rows + 31) // 32) * 8
    checks = {
        "parquetRows": row_count == expected_rows,
        "parquetPhysicalColumns": len(schema) == 28,
        "stateMagic": magic == b"DVST\x01\0\0\0",
        "stateShape": (state_rows, state_columns) == (expected_rows, 15),
        "stateLength": states_path.stat().st_size == expected_state_bytes,
    }
    return {
        "status": "PASS" if all(checks.values()) else "FAIL",
        "checks": checks,
        "parquetRows": row_count,
        "parquetColumns": {name: str(dtype) for name, dtype in schema.items()},
        "stateRows": state_rows,
        "stateColumns": state_columns,
        "stateBytes": states_path.stat().st_size,
        "parquetSha256": sha256(parquet_path),
        "stateSha256": sha256(states_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source_hash = sha256(args.source)
    if source_hash != EXPECTED_SOURCE_SHA256:
        raise SystemExit(f"unexpected source SHA-256: {source_hash}")
    if not args.binary.is_file():
        raise SystemExit(f"POC binary not found: {args.binary}")

    temporary_root = ROOT / ".tmp"
    temporary_root.mkdir(exist_ok=True)
    run_directory = Path(tempfile.mkdtemp(prefix="phase15-polars-rust-", dir=temporary_root))
    try:
        completed, peak_rss, wall_ms = sample_process(
            [str(args.binary), str(args.source), str(run_directory)]
        )
        if completed.returncode != 0:
            raise SystemExit(completed.stderr or completed.stdout)
        product = json.loads(completed.stdout)
        result = {
            "status": "PASS",
            "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "command": [str(args.binary), str(args.source), "<temporary-output>"],
            "source": {
                "path": str(args.source.relative_to(ROOT)),
                "bytes": args.source.stat().st_size,
                "sha256": source_hash,
            },
            "environment": {
                "platform": platform.platform(),
                "python": platform.python_version(),
                "logicalCpuCount": os.cpu_count(),
                "rssPollIntervalMs": 20,
                "childProcessesIncluded": True,
            },
            "process": {
                "wallMs": wall_ms,
                "absolutePeakRssBytes": peak_rss,
                "rssGateBytes": int(1.5 * 1024**3),
                "rssGatePassed": peak_rss <= int(1.5 * 1024**3),
                "stderr": completed.stderr,
            },
            "product": product,
            "audit": audit(run_directory, 5_850_000),
        }
        result["status"] = (
            "PASS"
            if result["process"]["rssGatePassed"] and result["audit"]["status"] == "PASS"
            else "FAIL"
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        return 0 if result["status"] == "PASS" else 1
    finally:
        shutil.rmtree(run_directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
