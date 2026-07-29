"""Independently audit the deterministic large Phase 15 fixtures with bounded memory."""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import tempfile
from pathlib import Path
from typing import Any

import h5py
import hdf5plugin  # noqa: F401 - registers the Blosc filter
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


WORKSPACE = Path(__file__).resolve().parents[1]
ROOT = WORKSPACE / "fixtures" / "phase-15"
GENERATOR = WORKSPACE / "scripts" / "generate_phase13_fixtures.py"
ROWS = 5_850_000
H5_TIME = 100_000
H5_WAVELENGTH = 2_048
H5_NAME = "oes-v3-100000x2048-int32.oes.h5"
FILES = [
    "csv-5850000-low.csv",
    "boundary-5850000-low.parquet",
    "csv-5850000-high.csv",
    "boundary-5850000-high.parquet",
    H5_NAME,
]
EXPECTED_PAYLOADS = {
    "csv-5850000-low.csv": (641_656_312, "64f656af94b1260298217ae78cd9adb7346b41c8bfa8055a49b54a3bf4e3c6c0"),
    "boundary-5850000-low.parquet": (130_394_395, "76f63843ec145047fff0596a5f7cdf9fca777dea2f319b27ceec22632b7f0def"),
    "csv-5850000-high.csv": (979_427_914, "082765c087900be8cbc95dda57bf7ef5f7e4e7e2c973b44c69a1570daf7635cd"),
    "boundary-5850000-high.parquet": (380_618_634, "30fc7b291f7c936311e74dbb785e3005ebb0d4d432f5795fad269b31de9e44ba"),
    H5_NAME: (3_915_120, "fdec7cb50f3f6d2de3af4c84cab7637619100c4c4e38cae0f54d52e4b039f578"),
}


def phase13() -> Any:
    spec = importlib.util.spec_from_file_location("phase13_fixture_audit_oracle", GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def phase15() -> Any:
    path = WORKSPACE / "scripts" / "generate_phase15_fixtures.py"
    spec = importlib.util.spec_from_file_location("phase15_fixture_publish_oracle", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise AssertionError(message)


def audit_csv(path: Path, cardinality: str, oracle: Any) -> dict[int, list[str]]:
    wanted = {0, ROWS // 2, ROWS - 1}
    samples: dict[int, list[str]] = {}
    low_sets = {"group": set(), "category": set(), "label": set(), "code": set()}
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.reader(stream)
        header = next(reader)
        if header != oracle.LARGE_SCHEMA.names:
            fail(f"{path.name}: header mismatch")
        count = 0
        for count, row in enumerate(reader, start=1):
            logical = count - 1
            if len(row) != 15:
                fail(f"{path.name}: row {logical} has {len(row)} fields")
            if logical in wanted:
                samples[logical] = row
            if cardinality == "low":
                low_sets["group"].add(row[1])
                low_sets["category"].add(row[2])
                low_sets["label"].add(row[7])
                low_sets["code"].add(row[8])
        if count != ROWS:
            fail(f"{path.name}: expected {ROWS} rows, found {count}")
    if cardinality == "low":
        observed = {key: len(value) for key, value in low_sets.items()}
        expected = {"group": 128, "category": 16, "label": 256, "code": 64}
        if observed != expected:
            fail(f"{path.name}: cardinality {observed} != {expected}")
    if set(samples) != wanted:
        fail(f"{path.name}: missing sample rows")
    return samples


def parquet_row(parquet: pq.ParquetFile, index: int) -> dict[str, Any]:
    group = index // 65_536
    offset = index % 65_536
    table = parquet.read_row_group(group)
    result = {name: table[name][offset].as_py() for name in table.column_names}
    result["event_time"] = table["event_time"].cast(pa.int64())[offset].as_py()
    return result


def csv_expected(row: list[str]) -> list[str]:
    return row


def parquet_as_csv(row: dict[str, Any]) -> list[str]:
    values = []
    for name, value in row.items():
        if value is None:
            values.append("")
        elif name == "active":
            values.append("true" if value else "false")
        elif name == "event_time":
            values.append(str(value))
        elif name == "amount":
            values.append(f"{value:.2f}")
        else:
            values.append(str(value))
    return values


def audit_parquet(path: Path, samples: dict[int, list[str]], oracle: Any) -> None:
    parquet = pq.ParquetFile(path)
    meta = parquet.metadata
    if meta.num_rows != ROWS or meta.num_columns != 15 or meta.num_row_groups != 90:
        fail(f"{path.name}: metadata dimensions mismatch")
    if meta.row_group(89).num_rows != 17_296:
        fail(f"{path.name}: final row group mismatch")
    if oracle.schema_sha256(parquet.schema_arrow) != "0332cadb7f6b262707504f22b0cdffc15d21a0b0975ed1d7631ca477f7dd9a66":
        fail(f"{path.name}: schema fingerprint mismatch")
    codecs = {meta.row_group(group).column(column).compression for group in range(meta.num_row_groups) for column in range(meta.num_columns)}
    if codecs != {"ZSTD"}:
        fail(f"{path.name}: codecs {codecs}")
    for index, csv_row in samples.items():
        if parquet_as_csv(parquet_row(parquet, index)) != csv_expected(csv_row):
            fail(f"{path.name}: CSV parity failed at row {index}")


def audit_high_sample(path: Path, oracle: Any) -> None:
    parquet = pq.ParquetFile(path)
    table = parquet.read_row_group(44, columns=["row_id", "category"])
    row_ids = table["row_id"].to_numpy()
    categories = table["category"].to_pylist()
    if len(set(categories)) / len(categories) < 0.99:
        fail(f"{path.name}: high-cardinality unique rate below 0.99")
    for offset in np.linspace(0, len(row_ids) - 1, 17, dtype=np.int64):
        row_id = int(row_ids[offset])
        expected = f"category-{oracle.stable_u64(row_id, 101):016x}"
        if categories[int(offset)] != expected:
            fail(f"{path.name}: high-cardinality oracle mismatch at {row_id}")


def audit_h5(path: Path) -> None:
    with h5py.File(path, "r") as handle:
        if str(handle.attrs["format"]) != "oesh5" or int(handle.attrs["format_version"]) != 3:
            fail("H5 format attributes mismatch")
        if list(map(int, handle.attrs["shape"])) != [H5_TIME, H5_WAVELENGTH]:
            fail("H5 logical shape attribute mismatch")
        if handle["time"].shape != (H5_TIME,) or handle["time"].dtype != np.dtype("int64"):
            fail("H5 time contract mismatch")
        if handle["wavelength"].shape != (H5_WAVELENGTH,) or handle["wavelength"].dtype != np.dtype("int32"):
            fail("H5 wavelength contract mismatch")
        oes = handle["oes"]
        if oes.shape != (H5_WAVELENGTH, H5_TIME) or oes.dtype != np.dtype("int32"):
            fail("H5 physical OES contract mismatch")
        if oes.chunks != (H5_WAVELENGTH, 128) or np.prod(oes.chunks) * oes.dtype.itemsize > 64 * 1024**2:
            fail("H5 chunk contract mismatch")
        filters = [oes.id.get_create_plist().get_filter(index) for index in range(oes.id.get_create_plist().get_nfilters())]
        blosc = next((item for item in filters if item[0] == 32_001), None)
        if blosc is None:
            fail(f"H5 Blosc filter 32001 missing: {filters}")
        client_data = blosc[2]
        if len(client_data) < 7 or client_data[4:7] != (5, 1, 5):
            fail(f"H5 Blosc must use clevel=5, shuffle=1, Zstd=5: {client_data}")
        if not isinstance(handle.get("oes", getlink=True), h5py.HardLink):
            fail("H5 /oes must be a local hard link")
        if not np.array_equal(handle["wavelength"][:], np.arange(400, 400 + H5_WAVELENGTH, dtype=np.int32)):
            fail("H5 wavelength values mismatch")
        for logical_row in (0, H5_TIME // 2, H5_TIME - 1):
            expected_time = 1_700_000_000_000_000_000 + logical_row * 1_000_003
            if int(handle["time"][logical_row]) != expected_time:
                fail(f"H5 time mismatch at {logical_row}")
            values = oes[:, logical_row]
            expected = logical_row * H5_WAVELENGTH + np.arange(H5_WAVELENGTH, dtype=np.int32)
            if not np.array_equal(values, expected):
                fail(f"H5 transpose/value mismatch at {logical_row}")


def audit_determinism_and_atomic_publish() -> None:
    generator = phase15()
    temp_root = WORKSPACE / ".tmp"
    temp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="phase15-fixture-audit-", dir=temp_root) as directory:
        root = Path(directory)
        regenerated = root / H5_NAME
        generator.write_h5(regenerated)
        if (regenerated.stat().st_size, sha256_file(regenerated)) != EXPECTED_PAYLOADS[H5_NAME]:
            fail("H5 deterministic regeneration mismatch")

        final = root / "atomic.bin"
        final.write_bytes(b"existing-final")

        def mismatching_writer(partial: Path) -> None:
            partial.write_bytes(b"wrong-new-payload")

        try:
            generator.generate_atomic(final, mismatching_writer, True, (1, "0" * 64))
        except RuntimeError:
            pass
        else:
            fail("atomic publish fault did not fail")
        if final.read_bytes() != b"existing-final" or final.with_name(final.name + ".partial").exists():
            fail("atomic publish fault damaged final or left a partial")


def main() -> int:
    oracle = phase13()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    golden = json.loads((ROOT / "golden.json").read_text(encoding="utf-8"))
    phase15_generator = WORKSPACE / "scripts" / "generate_phase15_fixtures.py"
    if manifest.get("generatorSha256") != sha256_file(phase15_generator):
        fail("manifest Phase 15 generator hash mismatch")
    if manifest.get("sourceGeneratorSha256") != sha256_file(GENERATOR):
        fail("manifest Phase 13 source generator hash mismatch")
    for key in ("python", "numpy", "pyarrow", "h5py", "hdf5", "hdf5plugin", "platform"):
        if not manifest.get("environment", {}).get(key):
            fail(f"manifest environment is missing {key}")
    manifest_files = {entry["path"]: entry for entry in manifest["fixtures"]}
    if set(manifest_files) != set(FILES):
        fail("manifest fixture allowlist mismatch")
    for name in FILES:
        path = ROOT / name
        entry = manifest_files[name]
        if not path.is_file() or path.stat().st_size <= 0:
            fail(f"missing or empty fixture: {name}")
        if path.stat().st_size != entry["bytes"] or sha256_file(path) != entry["sha256"]:
            fail(f"manifest integrity mismatch: {name}")
        if (entry["bytes"], entry["sha256"]) != EXPECTED_PAYLOADS[name]:
            fail(f"deterministic payload mismatch: {name}")

    samples: dict[str, dict[int, list[str]]] = {}
    for cardinality in ("low", "high"):
        samples[cardinality] = audit_csv(ROOT / f"csv-5850000-{cardinality}.csv", cardinality, oracle)
        audit_parquet(ROOT / f"boundary-5850000-{cardinality}.parquet", samples[cardinality], oracle)
        names = oracle.LARGE_SCHEMA.names
        for expected in golden["csvParquet"][cardinality]:
            row_id = expected["row_id"]
            actual = dict(zip(names, samples[cardinality][row_id]))
            normalized = {
                name: "" if value is None else (str(value).lower() if isinstance(value, bool) else str(value))
                for name, value in expected.items()
            }
            if actual != normalized:
                fail(f"golden row mismatch for {cardinality} row {row_id}")
    audit_high_sample(ROOT / "boundary-5850000-high.parquet", oracle)
    audit_h5(ROOT / H5_NAME)
    if golden["h5"]["logicalShape"] != [H5_TIME, H5_WAVELENGTH] or golden["h5"]["physicalOesShape"] != [H5_WAVELENGTH, H5_TIME]:
        fail("H5 golden shape mismatch")
    audit_determinism_and_atomic_publish()

    stray = [path.name for path in ROOT.iterdir() if path.name.endswith((".partial", ".tmp"))]
    if stray:
        fail(f"stray partial files: {stray}")
    print(json.dumps({"status": "PASS", "fixtures": len(FILES), "rowsPerTabularFixture": ROWS, "h5LogicalShape": [H5_TIME, H5_WAVELENGTH]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
