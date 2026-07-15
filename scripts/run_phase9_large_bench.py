"""Benchmark Phase 9 large fixtures with DuckDB Python or an external product runner.

DuckDB runs in disposable child processes so peak RSS, cancellation, and temporary-file cleanup
can be measured independently. Unless ``--keep`` is supplied, manifest fixture files are removed
after the result JSON has been preserved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

import psutil


REVISION = "phase9-large-bench-v1"
GIB = 1024**3
MEMORY_LIMIT_BYTES = int(1.5 * GIB)
TEMP_LIMIT_BYTES = 10 * GIB
MINIMUM_FREE_BYTES = 15 * GIB
PAGE_SIZE = 200
RANDOM_OFFSET_SEED = 20260715
OPERATIONS = ("first_result", "random_page", "simple_filter", "stable_sort", "cancel")
SAFE_FIXTURE_NAME = re.compile(r"^query-(?:low|high)-[0-9]+m?-[0-9]+c\.parquet$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return {"bytesHex": value.hex()}
    if isinstance(value, tuple):
        return [json_value(item) for item in value]
    if isinstance(value, list):
        return [json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: json_value(item) for key, item in value.items()}
    return value


def rows_checksum(rows: list[tuple[Any, ...]]) -> str:
    payload = json.dumps(json_value(rows), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def directory_size(root: Path) -> int:
    total = 0
    if not root.exists():
        return 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except FileNotFoundError:
            continue
    return total


def process_tree_rss(process: psutil.Process) -> int:
    total = 0
    processes = [process]
    try:
        processes.extend(process.children(recursive=True))
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    for current in processes:
        try:
            total += current.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return total


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * fraction + 0.999999)))
    return ordered[index]


def metric_summary(samples: list[dict[str, Any]], key: str = "elapsedMs") -> dict[str, float]:
    values = [float(sample[key]) for sample in samples]
    return {
        "minimumMs": round(min(values), 3),
        "medianMs": round(statistics.median(values), 3),
        "p95Ms": round(percentile(values, 0.95), 3),
        "maximumMs": round(max(values), 3),
    }


def duckdb_connect(temp_dir: Path):
    try:
        import duckdb
    except ImportError as error:
        raise RuntimeError("duckdb is required: python -m pip install duckdb") from error

    connection = duckdb.connect(database=":memory:")
    escaped = str(temp_dir.resolve()).replace("'", "''")
    connection.execute(f"SET temp_directory='{escaped}'")
    connection.execute("SET max_temp_directory_size='10GiB'")
    connection.execute("SET memory_limit='1GB'")
    connection.execute("SET threads=4")
    connection.execute("SET preserve_insertion_order=true")
    connection.execute("SET autoinstall_known_extensions=false")
    connection.execute("SET autoload_known_extensions=false")
    return connection


def duckdb_worker(
    operation: str,
    fixture: Path,
    temp_dir: Path,
    offset: int,
    cancel_after_seconds: float,
) -> dict[str, Any]:
    connection = duckdb_connect(temp_dir)
    fixture_text = str(fixture.resolve())
    started = time.perf_counter()
    try:
        if operation == "first_result":
            rows = connection.execute(
                "SELECT row_id, category, group_id, score FROM read_parquet(?) LIMIT ?",
                [fixture_text, PAGE_SIZE],
            ).fetchall()
            elapsed = (time.perf_counter() - started) * 1000
            return {"elapsedMs": elapsed, "rows": len(rows), "checksumSha256": rows_checksum(rows)}

        if operation == "random_page":
            rows = connection.execute(
                """
                SELECT row_id, category, group_id, score
                FROM read_parquet(?)
                WHERE row_id >= ? AND row_id < ?
                LIMIT ?
                """,
                [fixture_text, offset, offset + PAGE_SIZE, PAGE_SIZE],
            ).fetchall()
            elapsed = (time.perf_counter() - started) * 1000
            return {
                "elapsedMs": elapsed,
                "offset": offset,
                "pageAccess": "row_id range predicate with Parquet row-group statistics",
                "rows": len(rows),
                "checksumSha256": rows_checksum(rows),
            }

        if operation == "simple_filter":
            rows = connection.execute(
                """
                SELECT row_id, category, group_id, score
                FROM read_parquet(?)
                WHERE row_id % 97 = 0 AND active = true
                LIMIT ?
                """,
                [fixture_text, PAGE_SIZE],
            ).fetchall()
            elapsed = (time.perf_counter() - started) * 1000
            return {"elapsedMs": elapsed, "rows": len(rows), "checksumSha256": rows_checksum(rows)}

        if operation == "stable_sort":
            rows = connection.execute(
                """
                SELECT row_id, category, group_id, score
                FROM read_parquet(?)
                ORDER BY category ASC NULLS LAST,
                         group_id ASC NULLS LAST,
                         score DESC NULLS LAST,
                         row_id ASC
                LIMIT ?
                """,
                [fixture_text, PAGE_SIZE],
            ).fetchall()
            elapsed = (time.perf_counter() - started) * 1000
            return {
                "elapsedMs": elapsed,
                "rows": len(rows),
                "stableTieBreaker": "row_id ASC",
                "checksumSha256": rows_checksum(rows),
            }

        if operation == "cancel":
            # The parent terminates this isolated worker at the cancellation deadline. DuckDB's
            # Python connection interrupt can wait behind the active connection mutex on Windows.
            (temp_dir / "cancel-ready").touch()
            connection.execute(
                """
                SELECT SUM(hash(a.row_id, b.row_id))
                FROM read_parquet(?) a CROSS JOIN read_parquet(?) b
                WHERE a.row_id < 100000 AND b.row_id < 100000
                """,
                [fixture_text, fixture_text],
            ).fetchall()
            return {
                "elapsedMs": (time.perf_counter() - started) * 1000,
                "cancelLatencyMs": 0.0,
                "completedBeforeCancel": True,
                "cancellationMode": "completed-before-process-termination",
            }

        raise ValueError(f"Unknown operation: {operation}")
    finally:
        connection.close()


def worker_main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("operation", choices=OPERATIONS)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("temp_dir", type=Path)
    parser.add_argument("offset", type=int)
    parser.add_argument("cancel_after_seconds", type=float)
    args = parser.parse_args(arguments)
    result = duckdb_worker(
        args.operation, args.fixture, args.temp_dir, args.offset, args.cancel_after_seconds
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


def monitored_process(
    command: list[str], temp_dir: Path, terminate_after_seconds: float | None = None
) -> dict[str, Any]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    ps_process = psutil.Process(process.pid)
    peak_rss = 0
    peak_temp = 0
    started = time.perf_counter()
    cancel_started: float | None = None
    cancel_ready_at: float | None = None
    while process.poll() is None:
        peak_rss = max(peak_rss, process_tree_rss(ps_process))
        peak_temp = max(peak_temp, directory_size(temp_dir))
        if terminate_after_seconds is not None and (temp_dir / "cancel-ready").exists():
            cancel_ready_at = cancel_ready_at or time.perf_counter()
        if (
            cancel_ready_at is not None
            and cancel_started is None
            and time.perf_counter() - cancel_ready_at >= terminate_after_seconds
        ):
            cancel_started = time.perf_counter()
            process.terminate()
        time.sleep(0.02)
    stdout, stderr = process.communicate()
    peak_temp = max(peak_temp, directory_size(temp_dir))
    duration = (time.perf_counter() - started) * 1000
    if cancel_started is not None:
        result = {
            "elapsedMs": duration,
            "cancelLatencyMs": (time.perf_counter() - cancel_started) * 1000,
            "completedBeforeCancel": False,
            "cancellationMode": "isolated-worker-process-termination",
        }
    elif process.returncode != 0:
        raise RuntimeError(
            f"Runner failed with exit code {process.returncode}: {stderr.strip() or stdout.strip()}"
        )
    else:
        lines = [line for line in stdout.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError("Runner returned no JSON output")
        result = json.loads(lines[-1])
    result["processDurationMs"] = duration
    result["peakRssBytes"] = peak_rss
    result["tempPeakBytes"] = peak_temp
    if stderr.strip():
        result["stderr"] = stderr.strip()
    return result


def duckdb_command(
    operation: str,
    fixture: Path,
    temp_dir: Path,
    offset: int,
    cancel_after_seconds: float,
) -> list[str]:
    return [
        sys.executable,
        str(Path(__file__).resolve()),
        "_duckdb_worker",
        operation,
        str(fixture),
        str(temp_dir),
        str(offset),
        str(cancel_after_seconds),
    ]


def product_command(
    template: str,
    operation: str,
    fixture: Path,
    temp_dir: Path,
    offset: int,
    cancel_after_seconds: float,
) -> list[str]:
    rendered = template.format(
        operation=operation,
        fixture=str(fixture.resolve()),
        temp_dir=str(temp_dir.resolve()),
        offset=offset,
        page_size=PAGE_SIZE,
        cancel_after_seconds=cancel_after_seconds,
    )
    return shlex.split(rendered, posix=os.name != "nt")


def run_sample(
    command_factory: Callable[[str, Path, Path, int, float], list[str]],
    operation: str,
    fixture: Path,
    temp_root: Path,
    offset: int,
    cancel_after_seconds: float,
    process_cancel: bool,
) -> dict[str, Any]:
    temp_dir = Path(tempfile.mkdtemp(prefix=f"{fixture.stem}-{operation}-", dir=temp_root))
    cleanup_succeeded = False
    try:
        result = monitored_process(
            command_factory(operation, fixture, temp_dir, offset, cancel_after_seconds),
            temp_dir,
            cancel_after_seconds if process_cancel and operation == "cancel" else None,
        )
    finally:
        shutil.rmtree(temp_dir, ignore_errors=False)
        cleanup_succeeded = not temp_dir.exists()
    result["cleanupSucceeded"] = cleanup_succeeded
    return result


def verify_fixture(entry: dict[str, Any]) -> dict[str, Any]:
    path = Path(entry["path"])
    if not path.is_file():
        raise RuntimeError(f"Fixture missing: {path}")
    actual_size = path.stat().st_size
    actual_hash = sha256_file(path)
    expected_hash = entry["sha256"]
    result = {
        "path": str(path.resolve()),
        "expectedBytes": entry["bytes"],
        "actualBytes": actual_size,
        "expectedSha256": expected_hash,
        "actualSha256": actual_hash,
        "schemaFingerprintSha256": entry["schemaFingerprintSha256"],
        "cardinalitySampleChecksumSha256": entry["cardinalitySample"]["checksumSha256"],
    }
    result["result"] = (
        "PASS"
        if actual_size == entry["bytes"] and actual_hash == expected_hash
        else "FAIL"
    )
    if result["result"] != "PASS":
        raise RuntimeError(f"Fixture checksum/size mismatch: {path}")
    return result


def benchmark_fixture(
    entry: dict[str, Any],
    temp_root: Path,
    command_factory: Callable[[str, Path, Path, int, float], list[str]],
    warmups: int,
    runs: int,
    cancel_after_seconds: float,
    process_cancel: bool,
) -> dict[str, Any]:
    fixture = Path(entry["path"])
    row_count = int(entry["rows"])
    rng = random.Random(RANDOM_OFFSET_SEED + (1 if entry["cardinality"] == "high" else 0))
    offsets = [rng.randrange(0, max(1, row_count - PAGE_SIZE)) for _ in range(runs)]
    operations: dict[str, Any] = {}

    for operation in OPERATIONS:
        operation_warmups = 0 if operation == "cancel" else warmups
        for index in range(operation_warmups):
            run_sample(
                command_factory,
                operation,
                fixture,
                temp_root,
                offsets[index % len(offsets)] if offsets else 0,
                cancel_after_seconds,
                process_cancel,
            )
        samples = [
            run_sample(
                command_factory,
                operation,
                fixture,
                temp_root,
                offsets[index] if operation == "random_page" else 0,
                cancel_after_seconds,
                process_cancel,
            )
            for index in range(runs)
        ]
        checksum_values = {
            sample["checksumSha256"] for sample in samples if "checksumSha256" in sample
        }
        if operation != "random_page" and len(checksum_values) > 1:
            raise RuntimeError(f"Non-deterministic checksum for {fixture.name}/{operation}")
        summary_key = "cancelLatencyMs" if operation == "cancel" else "elapsedMs"
        operations[operation] = {
            "warmups": operation_warmups,
            "runs": runs,
            "summary": metric_summary(samples, summary_key),
            "peakRssBytes": max(sample["peakRssBytes"] for sample in samples),
            "tempPeakBytes": max(sample["tempPeakBytes"] for sample in samples),
            "allCleanupSucceeded": all(sample["cleanupSucceeded"] for sample in samples),
            "checksums": sorted(checksum_values),
            "samples": samples,
        }

    peak_rss = max(value["peakRssBytes"] for value in operations.values())
    temp_peak = max(value["tempPeakBytes"] for value in operations.values())
    gates = {
        "PERF-004-filter-first-result-under-10s": operations["simple_filter"]["summary"][
            "p95Ms"
        ]
        <= 10_000,
        "PERF-004-random-page-p95-under-1s": operations["random_page"]["summary"]["p95Ms"]
        <= 1_000,
        "PERF-005-stable-sort-under-120s": operations["stable_sort"]["summary"]["p95Ms"]
        <= 120_000,
        "PERF-006-peak-rss-under-1.5GiB": peak_rss <= MEMORY_LIMIT_BYTES,
        "PERF-007-temp-under-10GiB": temp_peak <= TEMP_LIMIT_BYTES,
        "PERF-007-temp-cleanup": all(
            value["allCleanupSucceeded"] for value in operations.values()
        ),
        "PERF-008-cancel-p95-under-2s": operations["cancel"]["summary"]["p95Ms"] <= 2_000,
        "PERF-008-cancel-observed": all(
            not sample.get("completedBeforeCancel", False)
            for sample in operations["cancel"]["samples"]
        ),
        "PERF-010-fixture-checksum": True,
    }
    return {
        "fixtureId": entry["id"],
        "path": str(fixture.resolve()),
        "profile": entry["profile"],
        "cardinality": entry["cardinality"],
        "rows": row_count,
        "columns": entry["columns"],
        "randomOffsets": offsets,
        "operations": operations,
        "peakRssBytes": peak_rss,
        "tempPeakBytes": temp_peak,
        "gates": {key: "PASS" if passed else "FAIL" for key, passed in gates.items()},
        "result": "PASS" if all(gates.values()) else "FAIL",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("artifacts/phase-9/large-fixtures-manifest.json"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts/phase-9/large-benchmark-results.json"),
    )
    parser.add_argument("--temp-root", type=Path, default=Path("logs/phase9-bench-temp"))
    parser.add_argument(
        "--engine", choices=["duckdb-python", "product-runner"], default="duckdb-python"
    )
    parser.add_argument(
        "--runner-command",
        help=(
            "Command template for product-runner. Available placeholders: {operation}, {fixture}, "
            "{temp_dir}, {offset}, {page_size}, {cancel_after_seconds}. The last stdout line must be JSON."
        ),
    )
    parser.add_argument("--warmups", type=int, default=3)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--cancel-after-seconds", type=float, default=0.25)
    parser.add_argument("--keep", action="store_true")
    return parser.parse_args()


def validate_cleanup_scope(manifest: dict[str, Any]) -> Path:
    if manifest.get("revision") != "phase9-large-v1":
        raise RuntimeError("Refusing cleanup for a manifest from an unknown generator revision")
    fixture_root = Path(manifest["preflight"]["outputDirectory"]).resolve()
    for entry in manifest["fixtures"]:
        path = Path(entry["path"]).resolve()
        if path.parent != fixture_root or not SAFE_FIXTURE_NAME.fullmatch(path.name):
            raise RuntimeError(f"Unsafe fixture cleanup path in manifest: {path}")
    return fixture_root


def main() -> int:
    args = parse_args()
    if args.runs <= 0 or args.warmups < 0 or args.cancel_after_seconds <= 0:
        raise SystemExit("--runs must be positive; warmups non-negative; cancel delay positive")
    if args.engine == "product-runner" and not args.runner_command:
        raise SystemExit("--runner-command is required with --engine product-runner")

    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    fixture_root = validate_cleanup_scope(manifest)
    temp_root = args.temp_root.resolve()
    temp_root.mkdir(parents=True, exist_ok=True)
    free_before = shutil.disk_usage(temp_root).free
    if free_before < MINIMUM_FREE_BYTES:
        raise RuntimeError(
            f"Benchmark requires at least 15 GiB free for bounded spill; found {free_before / GIB:.2f} GiB"
        )

    if args.engine == "duckdb-python":
        import duckdb

        engine_version = duckdb.__version__
        command_factory = duckdb_command
        runner_contract = None
    else:
        engine_version = "external"
        template = args.runner_command
        command_factory = lambda operation, fixture, temp_dir, offset, cancel: product_command(
            template, operation, fixture, temp_dir, offset, cancel
        )
        runner_contract = template

    fixtures = manifest["fixtures"]
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "revision": REVISION,
        "startedAtUtc": utc_now(),
        "status": "RUNNING",
        "manifest": str(manifest_path),
        "manifestSha256": sha256_file(manifest_path),
        "fixtureRoot": str(fixture_root),
        "engine": args.engine,
        "engineVersion": engine_version,
        "runnerCommandTemplate": runner_contract,
        "configuration": {
            "warmups": args.warmups,
            "runs": args.runs,
            "pageSize": PAGE_SIZE,
            "randomOffsetSeed": RANDOM_OFFSET_SEED,
            "cancelAfterSeconds": args.cancel_after_seconds,
            "deleteFixturesAfterRun": not args.keep,
        },
        "environment": {
            "platform": platform.platform(),
            "processor": platform.processor(),
            "python": platform.python_version(),
            "logicalCpuCount": psutil.cpu_count(logical=True),
            "physicalCpuCount": psutil.cpu_count(logical=False),
            "totalMemoryBytes": psutil.virtual_memory().total,
            "freeDiskBytesBefore": free_before,
        },
        "fixtureVerification": [],
        "benchmarks": [],
        "deletedFixtures": [],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    error: Exception | None = None
    try:
        for entry in fixtures:
            result["fixtureVerification"].append(verify_fixture(entry))
        for entry in fixtures:
            print(f"Benchmarking {Path(entry['path']).name}", file=sys.stderr, flush=True)
            result["benchmarks"].append(
                benchmark_fixture(
                    entry,
                    temp_root,
                    command_factory,
                    args.warmups,
                    args.runs,
                    args.cancel_after_seconds,
                    args.engine == "duckdb-python",
                )
            )
        result["status"] = (
            "PASS"
            if all(item["result"] == "PASS" for item in result["benchmarks"])
            else "FAIL"
        )
    except Exception as caught:
        error = caught
        result["status"] = "ERROR"
        result["error"] = {"type": type(caught).__name__, "message": str(caught)}
    finally:
        shutil.rmtree(temp_root, ignore_errors=False)
        result["tempRootCleanupSucceeded"] = not temp_root.exists()
        if not args.keep:
            for entry in fixtures:
                path = Path(entry["path"])
                if path.is_file():
                    path.unlink()
                    result["deletedFixtures"].append(str(path.resolve()))
        result["finishedAtUtc"] = utc_now()
        result["freeDiskBytesAfter"] = shutil.disk_usage(args.output.parent).free
        args.output.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    if error is not None:
        raise error
    print(json.dumps({"output": str(args.output.resolve()), "status": result["status"]}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "_duckdb_worker":
        raise SystemExit(worker_main(sys.argv[2:]))
    raise SystemExit(main())
