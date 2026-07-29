"""Generate deterministic large Phase 15 CSV, Parquet, and OES HDF5 fixtures."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import hdf5plugin
import numpy as np
import pyarrow as pa


WORKSPACE = Path(__file__).resolve().parents[1]
OUTPUT_DIR = WORKSPACE / "fixtures" / "phase-15"
PHASE13_GENERATOR = WORKSPACE / "scripts" / "generate_phase13_fixtures.py"
MIN_START_FREE = 12 * 1024**3
MIN_FINAL_FREE = 5 * 1024**3
H5_TIME = 100_000
H5_WAVELENGTH = 2_048
H5_CHUNK_TIME = 128
H5_FILE = "oes-v3-100000x2048-int32.oes.h5"
EXPECTED = {
    "csv-5850000-low.csv": (641_656_312, "64f656af94b1260298217ae78cd9adb7346b41c8bfa8055a49b54a3bf4e3c6c0"),
    "boundary-5850000-low.parquet": (130_394_395, "76f63843ec145047fff0596a5f7cdf9fca777dea2f319b27ceec22632b7f0def"),
    "csv-5850000-high.csv": (979_427_914, "082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd"),
    "boundary-5850000-high.parquet": (380_618_634, "30fc7b291f7c936311e74dbb785e3005ebb0d4d432f5795fad269b31de9e44ba"),
    H5_FILE: (3_915_120, "fdec7cb50f3f6d2de3af4c84cab7637619100c4c4e38cae0f54d52e4b039f578"),
}


def load_phase13() -> Any:
    spec = importlib.util.spec_from_file_location("phase13_fixture_generator", PHASE13_GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {PHASE13_GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def check_output_path(path: Path) -> None:
    if path.resolve() != OUTPUT_DIR.resolve():
        raise ValueError(f"output must be exactly {OUTPUT_DIR}")


def check_free_space(path: Path, minimum: int, stage: str) -> None:
    free = shutil.disk_usage(path).free
    if free < minimum:
        raise RuntimeError(f"{stage}: need {minimum:,} free bytes, found {free:,}")


def generate_atomic(path: Path, writer: Any, force: bool, expected: tuple[int, str] | None = None) -> None:
    if path.exists() and not force:
        print(f"[skip] {path.name} already exists", flush=True)
        return
    partial = path.with_name(path.name + ".partial")
    partial.unlink(missing_ok=True)
    try:
        writer(partial)
        if expected is not None:
            actual = (partial.stat().st_size, sha256_file(partial))
            if actual != expected:
                raise RuntimeError(f"determinism mismatch for {path.name}: {actual} != {expected}")
        check_free_space(path.parent, MIN_FINAL_FREE, f"before publishing {path.name}")
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)


def write_h5(path: Path) -> None:
    time_values = 1_700_000_000_000_000_000 + np.arange(H5_TIME, dtype=np.int64) * 1_000_003
    wavelength_values = np.arange(400, 400 + H5_WAVELENGTH, dtype=np.int32)
    with h5py.File(path, "w") as handle:
        handle.attrs["format"] = "oesh5"
        handle.attrs["format_version"] = np.int32(3)
        handle.attrs["shape"] = np.asarray([H5_TIME, H5_WAVELENGTH], dtype=np.int64)
        handle.create_dataset("time", data=time_values)
        handle.create_dataset("wavelength", data=wavelength_values)
        oes = handle.create_dataset(
            "oes",
            shape=(H5_WAVELENGTH, H5_TIME),
            dtype=np.int32,
            chunks=(H5_WAVELENGTH, H5_CHUNK_TIME),
            **hdf5plugin.Blosc(cname="zstd", clevel=5, shuffle=hdf5plugin.Blosc.SHUFFLE),
        )
        wavelengths = np.arange(H5_WAVELENGTH, dtype=np.int32)[:, None]
        for start in range(0, H5_TIME, H5_CHUNK_TIME):
            stop = min(start + H5_CHUNK_TIME, H5_TIME)
            times = np.arange(start, stop, dtype=np.int64)[None, :]
            block = (times * H5_WAVELENGTH + wavelengths).astype(np.int32)
            oes[:, start:stop] = block
            if stop == H5_TIME or stop % 12_800 == 0:
                print(f"[{path.name}] {stop:,}/{H5_TIME:,}", file=sys.stderr, flush=True)


def h5_golden() -> dict[str, Any]:
    rows = [0, H5_TIME // 2, H5_TIME - 1]
    return {
        "logicalShape": [H5_TIME, H5_WAVELENGTH],
        "physicalOesShape": [H5_WAVELENGTH, H5_TIME],
        "chunkShape": [H5_WAVELENGTH, H5_CHUNK_TIME],
        "valueFormula": "oes[w,t] = t*2048+w",
        "rows": [
            {
                "logicalRow": row,
                "time": 1_700_000_000_000_000_000 + row * 1_000_003,
                "first": row * H5_WAVELENGTH,
                "last": row * H5_WAVELENGTH + H5_WAVELENGTH - 1,
            }
            for row in rows
        ],
    }


def tabular_golden(phase13: Any, cardinality: str) -> list[dict[str, Any]]:
    result = []
    for row in (0, phase13.LARGE_ROWS // 2, phase13.LARGE_ROWS - 1):
        columns = phase13.large_columns(row, 1, cardinality)
        result.append(
            {
                "row_id": row,
                "group_id": int(columns["group_id"][0]),
                "category": str(columns["category"][0]),
                "active": bool(row % 2 == 0),
                "optional_value": None if row % 97 == 0 else row % 10_000,
                "event_time": 1_700_000_000_000_000_000 + row * 1_000_003,
                "amount": f"{float(columns['amount'][0]):.2f}",
                "label": str(columns["label"][0]),
                "code": str(columns["code"][0]),
                **{f"metric_{column:02d}": int(columns[f"metric_{column:02d}"][0]) for column in range(6)},
            }
        )
    return result


def write_json_atomic(path: Path, value: Any) -> None:
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(partial, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="atomically replace existing fixtures")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    check_output_path(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    check_free_space(OUTPUT_DIR, MIN_START_FREE, "generation start")
    phase13 = load_phase13()

    for cardinality in ("low", "high"):
        csv_path = OUTPUT_DIR / f"csv-5850000-{cardinality}.csv"
        generate_atomic(csv_path, lambda partial, c=cardinality: phase13.write_large_csv(partial, c, False), args.force, EXPECTED[csv_path.name])
        parquet_path = OUTPUT_DIR / f"boundary-5850000-{cardinality}.parquet"
        generate_atomic(parquet_path, lambda partial, c=cardinality: phase13.write_large_parquet(partial, c), args.force, EXPECTED[parquet_path.name])

    h5_path = OUTPUT_DIR / H5_FILE
    generate_atomic(h5_path, write_h5, args.force, EXPECTED[h5_path.name])

    golden = {
        "schemaVersion": 1,
        "csvParquet": {
            "rows": phase13.LARGE_ROWS,
            "columns": phase13.LARGE_COLUMNS,
            "schemaSha256": phase13.schema_sha256(phase13.LARGE_SCHEMA),
            "seed": phase13.SEED,
            "sampleRows": [0, phase13.LARGE_ROWS // 2, phase13.LARGE_ROWS - 1],
            "low": tabular_golden(phase13, "low"),
            "high": tabular_golden(phase13, "high"),
        },
        "h5": h5_golden(),
    }
    write_json_atomic(OUTPUT_DIR / "golden.json", golden)

    fixture_names = [
        "csv-5850000-low.csv",
        "boundary-5850000-low.parquet",
        "csv-5850000-high.csv",
        "boundary-5850000-high.parquet",
        H5_FILE,
    ]
    fixtures = []
    for name in fixture_names:
        path = OUTPUT_DIR / name
        size = path.stat().st_size
        digest = sha256_file(path)
        expected = EXPECTED.get(name)
        if expected is not None and (size, digest) != expected:
            raise RuntimeError(f"determinism mismatch for {name}: {(size, digest)} != {expected}")
        fixtures.append({"path": name, "bytes": size, "sha256": digest})

    manifest = {
        "schemaVersion": 1,
        "generatorVersion": "phase15-large-fixtures-v1",
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "generator": PHASE13_GENERATOR.name + "+" + Path(__file__).name,
        "generatorSha256": sha256_file(Path(__file__)),
        "sourceGeneratorSha256": sha256_file(PHASE13_GENERATOR),
        "seed": phase13.SEED,
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pyarrow": pa.__version__,
            "h5py": h5py.__version__,
            "hdf5": h5py.version.hdf5_version,
            "hdf5plugin": importlib.metadata.version("hdf5plugin"),
            "platform": platform.platform(),
        },
        "configuration": {
            "tabularRows": phase13.LARGE_ROWS,
            "tabularColumns": phase13.LARGE_COLUMNS,
            "csvBatchRows": phase13.LARGE_BATCH_ROWS,
            "parquetRowGroupRows": phase13.PARQUET_ROW_GROUP_ROWS,
            "h5LogicalShape": [H5_TIME, H5_WAVELENGTH],
            "h5PhysicalShape": [H5_WAVELENGTH, H5_TIME],
            "h5ChunkShape": [H5_WAVELENGTH, H5_CHUNK_TIME],
        },
        "fixtures": fixtures,
        "totalBytes": sum(item["bytes"] for item in fixtures),
    }
    write_json_atomic(OUTPUT_DIR / "manifest.json", manifest)
    print(json.dumps({"output": str(OUTPUT_DIR), "fixtures": len(fixtures), "bytes": manifest["totalBytes"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
