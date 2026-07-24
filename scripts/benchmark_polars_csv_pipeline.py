"""Profile a Polars+NumPy equivalent of the viewer CSV preparation pipeline."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import mmap
import os
import platform
import shutil
import struct
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

import numpy as np
import polars as pl
import psutil


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / ".tmp/phase13-fixtures/large/csv-5850000-high.csv"
DEFAULT_OUTPUT = ROOT / "artifacts/phase-14/polars-high-stage-profile.json"
ROWS = 5_850_000
CHECKPOINT_INTERVAL = 4_096
EXPECTED_SHA256 = "082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd"
T = TypeVar("T")


COLUMNS = [
    "row_id",
    "group_id",
    "category",
    "active",
    "optional_value",
    "event_time",
    "amount",
    "label",
    "code",
    "metric_00",
    "metric_01",
    "metric_02",
    "metric_03",
    "metric_04",
    "metric_05",
]

TARGET_DTYPES: dict[str, pl.DataType] = {
    "row_id": pl.Int64,
    "group_id": pl.Int64,
    "category": pl.String,
    "active": pl.Boolean,
    "optional_value": pl.Int32,
    # The viewer's default CSV inference sees this integer lexeme as Int64.
    "event_time": pl.Int64,
    "amount": pl.Float64,
    "label": pl.String,
    "code": pl.String,
    "metric_00": pl.Int64,
    "metric_01": pl.Int64,
    "metric_02": pl.Int64,
    "metric_03": pl.Int64,
    "metric_04": pl.Int64,
    "metric_05": pl.Int64,
}


class Sampler:
    def __init__(self) -> None:
        self.process = psutil.Process()
        self.phase = "idle"
        self.peaks: dict[str, int] = {}
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop.wait(0.02):
            rss = self.process.memory_info().rss
            self.peaks[self.phase] = max(self.peaks.get(self.phase, 0), rss)

    def start(self) -> None:
        self.thread.start()

    def close(self) -> None:
        self.stop.set()
        self.thread.join(timeout=1)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sync_file(path: Path) -> None:
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def measure(
    name: str,
    sampler: Sampler,
    results: list[dict[str, Any]],
    operation: Callable[[], T],
) -> T:
    sampler.phase = name
    process = psutil.Process()
    cpu_before = process.cpu_times()
    started = time.perf_counter()
    value = operation()
    elapsed = time.perf_counter() - started
    cpu_after = process.cpu_times()
    cpu_seconds = (cpu_after.user - cpu_before.user) + (cpu_after.system - cpu_before.system)
    results.append(
        {
            "name": name,
            "elapsedMs": elapsed * 1_000,
            "cpuSeconds": cpu_seconds,
            "averageCoreUtilization": cpu_seconds / elapsed if elapsed else 0,
        }
    )
    sampler.phase = "idle"
    return value


def read_raw_strings(path: Path) -> pl.DataFrame:
    return pl.read_csv(
        path,
        schema={name: pl.String for name in COLUMNS},
        has_header=True,
        missing_utf8_is_empty_string=True,
        n_threads=None,
        low_memory=False,
        rechunk=False,
    )


def build_state_bitmap(frame: pl.DataFrame) -> bytes:
    words_per_column = (frame.height + 31) // 32
    weights = np.left_shift(
        np.uint64(2), np.arange(32, dtype=np.uint64) * np.uint64(2)
    )
    output = bytearray(struct.pack("<8sQQ", b"DVST\x01\0\0\0", frame.height, frame.width))
    for name in COLUMNS:
        empty = frame.get_column(name).eq("").fill_null(False).to_numpy()
        if empty.size % 32:
            empty = np.pad(empty, (0, 32 - empty.size % 32), constant_values=False)
        words = (empty.reshape(-1, 32).astype(np.uint64) * weights).sum(
            axis=1, dtype=np.uint64
        )
        assert words.size == words_per_column
        output.extend(words.astype("<u8", copy=False).tobytes())
    return bytes(output)


def build_checkpoints(path: Path) -> bytes:
    checkpoints: list[tuple[int, int]] = []
    newline_ordinal = 0
    chunk_bytes = 64 * 1024 * 1024
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
        size = len(mapped)
        for offset in range(0, size, chunk_bytes):
            count = min(chunk_bytes, size - offset)
            view = memoryview(mapped)[offset : offset + count]
            array = np.frombuffer(view, dtype=np.uint8)
            newlines = np.flatnonzero(array == 10)
            ordinals = newline_ordinal + np.arange(newlines.size, dtype=np.int64)
            selected = np.flatnonzero(ordinals % CHECKPOINT_INTERVAL == 0)
            for index in selected:
                source_row = int(ordinals[index])
                if source_row < ROWS:
                    checkpoints.append((source_row, offset + int(newlines[index]) + 1))
            newline_ordinal += newlines.size
            del selected, ordinals, newlines, array, view
    checkpoint_count = (ROWS + CHECKPOINT_INTERVAL - 1) // CHECKPOINT_INTERVAL
    if len(checkpoints) != checkpoint_count:
        raise RuntimeError(f"unexpected checkpoint count: {len(checkpoints)}")
    payload = bytearray(b"DVOF\x01\0\0\0")
    payload.extend(struct.pack("<Q", checkpoint_count))
    for row, byte_offset in checkpoints:
        payload.extend(struct.pack("<QQ", row, byte_offset))
    return bytes(payload)


def expanded_expressions() -> list[pl.Expr]:
    expressions: list[pl.Expr] = [
        pl.int_range(0, pl.len(), dtype=pl.UInt64).alias("__dv_row_id")
    ]
    for index, name in enumerate(COLUMNS):
        raw = pl.col(name)
        dtype = TARGET_DTYPES[name]
        if dtype == pl.Boolean:
            lowered = raw.str.to_lowercase()
            typed = (
                pl.when(lowered == "true")
                .then(pl.lit(True))
                .when(lowered == "false")
                .then(pl.lit(False))
                .otherwise(pl.lit(None, dtype=pl.Boolean))
            )
        else:
            typed = raw.cast(dtype, strict=False)
        normalized = raw if dtype == pl.String else typed.cast(pl.String)
        invalid = ((raw != "") & typed.is_null()).fill_null(False)
        expressions.extend(
            [
                normalized.alias(name),
                raw.alias(f"__dv_raw_{index}"),
                invalid.alias(f"__dv_invalid_{index}"),
            ]
        )
    return expressions


def write_expanded_parquet(frame: pl.DataFrame, path: Path) -> None:
    frame.lazy().select(expanded_expressions()).sink_parquet(
        path,
        compression="zstd",
        compression_level=1,
        statistics=True,
        row_group_size=65_536,
        maintain_order=True,
        engine="streaming",
    )


def write_typed_streaming(path: Path, output: Path) -> None:
    pl.scan_csv(
        path,
        schema=TARGET_DTYPES,
        has_header=True,
        missing_utf8_is_empty_string=True,
        rechunk=False,
    ).sink_parquet(
        output,
        compression="zstd",
        compression_level=1,
        statistics=True,
        row_group_size=65_536,
        maintain_order=True,
        engine="streaming",
    )


def write_bytes_synced(path: Path, payload: bytes) -> None:
    with path.open("wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def copy_persistent(files: list[Path], destination: Path) -> None:
    destination.mkdir()
    for source in files:
        target = destination / source.name
        shutil.copyfile(source, target)
        sync_file(target)


def checksum_artifacts(files: list[Path]) -> dict[str, str]:
    return {path.name: file_sha256(path) for path in files}


def audit_outputs(
    source: Path,
    expanded_parquet: Path,
    typed_parquet: Path,
    states_path: Path,
    offsets_path: Path,
) -> dict[str, Any]:
    expanded = pl.scan_parquet(expanded_parquet)
    expanded_schema = expanded.collect_schema()
    expanded_rows = expanded.select(pl.len()).collect().item()
    typed = pl.scan_parquet(typed_parquet)
    typed_schema = typed.collect_schema()
    typed_rows = typed.select(pl.len()).collect().item()
    with states_path.open("rb") as stream:
        magic, state_rows, state_columns = struct.unpack("<8sQQ", stream.read(24))
    with offsets_path.open("rb") as stream:
        offset_magic = stream.read(8)
        checkpoint_count = struct.unpack("<Q", stream.read(8))[0]
        last_row = 0
        last_byte_offset = 0
        for _ in range(checkpoint_count):
            last_row, last_byte_offset = struct.unpack("<QQ", stream.read(16))
    expected_state_bytes = 24 + len(COLUMNS) * ((ROWS + 31) // 32) * 8
    expected_checkpoint_count = (ROWS + CHECKPOINT_INTERVAL - 1) // CHECKPOINT_INTERVAL
    checks = {
        "expandedRows": expanded_rows == ROWS,
        "expandedColumns": len(expanded_schema) == 46,
        "typedRows": typed_rows == ROWS,
        "typedColumns": len(typed_schema) == 15,
        "stateHeader": magic == b"DVST\x01\0\0\0",
        "stateShape": (state_rows, state_columns) == (ROWS, len(COLUMNS)),
        "stateBytes": states_path.stat().st_size == expected_state_bytes,
        "offsetHeader": offset_magic == b"DVOF\x01\0\0\0",
        "offsetCount": checkpoint_count == expected_checkpoint_count,
        "offsetLastRow": last_row == (expected_checkpoint_count - 1) * CHECKPOINT_INTERVAL,
        "offsetLastByteInSource": 0 < last_byte_offset < source.stat().st_size,
    }
    if not all(checks.values()):
        raise RuntimeError(f"output audit failed: {checks}")
    return {
        "result": "PASS",
        "checks": checks,
        "expandedSchema": {name: str(dtype) for name, dtype in expanded_schema.items()},
        "typedSchema": {name: str(dtype) for name, dtype in typed_schema.items()},
        "lastCheckpoint": {"row": last_row, "byteOffset": last_byte_offset},
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if source.stat().st_size != 979_427_914:
        raise RuntimeError("fixture byte size changed")
    if file_sha256(source) != EXPECTED_SHA256:
        raise RuntimeError("fixture SHA-256 changed")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_parent = (ROOT / ".tmp").resolve()
    temp_parent.mkdir(exist_ok=True)
    stages: list[dict[str, Any]] = []
    sampler = Sampler()
    sampler.start()
    total_started = time.perf_counter()
    try:
        with tempfile.TemporaryDirectory(prefix="polars-csv-profile-", dir=temp_parent) as raw_temp:
            temp = Path(raw_temp)
            expanded_parquet = temp / "prepared.parquet"
            states_path = temp / "states.bin"
            offsets_path = temp / "offsets.idx"
            persistent = temp / "persistent"
            typed_parquet = temp / "typed-streaming.parquet"

            frame = measure("polarsReadAllRawStrings", sampler, stages, lambda: read_raw_strings(source))
            if frame.shape != (ROWS, len(COLUMNS)):
                raise RuntimeError(f"unexpected frame shape: {frame.shape}")
            state_payload = measure("numpyBuildStateBitmap", sampler, stages, lambda: build_state_bitmap(frame))
            measure("writeAndSyncStateBitmap", sampler, stages, lambda: write_bytes_synced(states_path, state_payload))
            del state_payload
            checkpoint_payload = measure("numpyScanCheckpointIndex", sampler, stages, lambda: build_checkpoints(source))
            measure("writeAndSyncCheckpointIndex", sampler, stages, lambda: write_bytes_synced(offsets_path, checkpoint_payload))
            del checkpoint_payload
            measure("polarsExpandedParquetZstd1", sampler, stages, lambda: write_expanded_parquet(frame, expanded_parquet))
            measure("fsyncExpandedParquet", sampler, stages, lambda: sync_file(expanded_parquet))
            prepared_files = [expanded_parquet, states_path, offsets_path]
            measure("persistentCacheCopyAndSync", sampler, stages, lambda: copy_persistent(prepared_files, persistent))
            checksums = measure("persistentCacheSha256", sampler, stages, lambda: checksum_artifacts([persistent / path.name for path in prepared_files]))
            manifest_payload = json.dumps(
                {
                    "rows": ROWS,
                    "columns": len(COLUMNS),
                    "files": {
                        path.name: {
                            "bytes": (persistent / path.name).stat().st_size,
                            "sha256": checksums[path.name],
                        }
                        for path in prepared_files
                    },
                },
                sort_keys=True,
            ).encode()
            measure("manifestWriteAndSync", sampler, stages, lambda: write_bytes_synced(persistent / "cache-manifest.json", manifest_payload))

            equivalent_elapsed_ms = sum(stage["elapsedMs"] for stage in stages)
            equivalent_sizes = {path.name: path.stat().st_size for path in prepared_files}
            frame_estimated_bytes = frame.estimated_size()
            del frame
            gc.collect()
            measure("polarsTypedStreamingCsvToParquet", sampler, stages, lambda: write_typed_streaming(source, typed_parquet))
            measure("fsyncTypedParquet", sampler, stages, lambda: sync_file(typed_parquet))
            typed_size = typed_parquet.stat().st_size
            audit = measure(
                "auditOutputs",
                sampler,
                stages,
                lambda: audit_outputs(source, expanded_parquet, typed_parquet, states_path, offsets_path),
            )
            total_ms = (time.perf_counter() - total_started) * 1_000

            document = {
                "schemaVersion": 1,
                "fixture": {
                    "path": str(source),
                    "bytes": source.stat().st_size,
                    "rows": ROWS,
                    "columns": len(COLUMNS),
                    "sha256": EXPECTED_SHA256,
                },
                "environment": {
                    "python": platform.python_version(),
                    "polars": pl.__version__,
                    "numpy": np.__version__,
                    "polarsThreadPoolSize": pl.thread_pool_size(),
                    "logicalCpuCount": psutil.cpu_count(logical=True),
                    "physicalCpuCount": psutil.cpu_count(logical=False),
                },
                "equivalentPipeline": {
                    "elapsedMs": equivalent_elapsed_ms,
                    "rawFrameEstimatedBytes": frame_estimated_bytes,
                    "artifactBytes": equivalent_sizes,
                    "persistentBytes": sum((persistent / path.name).stat().st_size for path in prepared_files),
                    "semantics": "46 columns: source row id plus normalized/raw/invalid per original column; NumPy 2-bit states; checkpoint scan; zstd1; fsync; persistent copy; full checksum; manifest",
                },
                "typedStreaming": {
                    "elapsedMs": sum(stage["elapsedMs"] for stage in stages if stage["name"] in {"polarsTypedStreamingCsvToParquet", "fsyncTypedParquet"}),
                    "parquetBytes": typed_size,
                    "semantics": "15 physical typed columns, streaming CSV-to-Parquet zstd1; no raw shadow, state bitmap, checkpoint, persistent copy or manifest",
                },
                "stages": stages,
                "peakRssBytesByStage": sampler.peaks,
                "audit": audit,
                "totalProcessElapsedMs": total_ms,
                "notes": [
                    "Input may be warm in the Windows file cache; CPU-heavy stage comparisons remain useful.",
                    "Checkpoint byte scan is fixture-specific because Polars does not expose CSV record byte positions.",
                    "SHA-256 substitutes for the viewer's CRC64-ECMA so both paths perform a complete persistent artifact checksum read.",
                ],
            }
            output.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(json.dumps({"output": str(output), "equivalentMs": equivalent_elapsed_ms, "typedStreamingMs": document["typedStreaming"]["elapsedMs"]}))
    finally:
        sampler.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
