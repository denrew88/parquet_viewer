"""Audit the Phase 12 H5 matrix and run a plugin-path-cleared decoder smoke."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import numpy as np

import generate_phase12_h5_matrix as phase12


REPO_ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def resolve_recorded_path(value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()


def filter_details(dataset: h5py.Dataset) -> list[dict[str, Any]]:
    creation = dataset.id.get_create_plist()
    details = []
    for index in range(creation.get_nfilters()):
        filter_id, flags, values, name = creation.get_filter(index)
        details.append(
            {
                "id": int(filter_id),
                "flags": int(flags),
                "cdValues": [int(value) for value in values],
                "name": name.decode("utf-8") if isinstance(name, bytes) else str(name),
            }
        )
    return details


def format_observation(handle: h5py.File) -> dict[str, Any]:
    if "format" not in handle.attrs:
        return {"present": False}
    value = handle.attrs["format"]
    array = np.asarray(value)
    if array.dtype.kind in {"O", "S", "U"}:
        flat = [
            item.decode("utf-8") if isinstance(item, bytes) else str(item)
            for item in array.reshape(-1).tolist()
        ]
    else:
        flat = [int(item) if array.dtype.kind in {"i", "u"} else float(item) for item in array.reshape(-1)]
    return {
        "present": True,
        "dtype": str(array.dtype),
        "shape": list(array.shape),
        "values": flat,
    }


def assert_format_variant(handle: h5py.File, variant: str, case_id: str) -> None:
    observed = format_observation(handle)
    if variant == "missing":
        require(not observed["present"], f"{case_id}: format should be missing")
    elif variant in {"oesh5", "oefh5", "oesf5"}:
        require(observed["values"] == [variant], f"{case_id}: format string mismatch")
    elif variant == "arbitrary":
        require(observed["values"] == ["not-the-format"], f"{case_id}: arbitrary format mismatch")
    elif variant == "integer":
        require(observed["values"] == [17], f"{case_id}: integer format mismatch")
    elif variant == "array":
        require(observed["values"] == [1, 2, 3], f"{case_id}: array format mismatch")
    else:
        raise RuntimeError(f"{case_id}: unsupported format variant {variant}")


def assert_valid_structure(handle: h5py.File, case: dict[str, Any]) -> str:
    logical_shape = case.get("logicalShape", [phase12.N_TIME, phase12.N_WAVELENGTH])
    n_time, n_wavelength = logical_shape
    require(int(handle.attrs["format_version"]) == 3, f"{case['id']}: format_version mismatch")
    require(list(handle.attrs["shape"]) == logical_shape, f"{case['id']}: shape mismatch")
    assert_format_variant(handle, case.get("formatVariant", "oesh5"), case["id"])
    for name in ("time", "wavelength", "oes"):
        require(name in handle and isinstance(handle[name], h5py.Dataset), f"{case['id']}: missing /{name}")
    require(list(handle["time"].shape) == [n_time], f"{case['id']}: time shape")
    require(list(handle["wavelength"].shape) == [n_wavelength], f"{case['id']}: wavelength shape")
    require(list(handle["oes"].shape) == [n_wavelength, n_time], f"{case['id']}: oes shape")
    expected_itemsize = np.dtype(case.get("oesDtype", "<i4")).itemsize
    require(handle["oes"].dtype.kind == "i" and handle["oes"].dtype.itemsize == expected_itemsize, f"{case['id']}: oes dtype")
    filters = filter_details(handle["oes"])
    require(len(filters) == 1 and filters[0]["id"] == 32_001, f"{case['id']}: expected Blosc filter 32001")
    logical = np.asarray(handle["oes"][:], dtype="<i8").T
    checksum = phase12.canonical_sha256(
        {"shape": logical_shape, "values": logical.tolist()}
    )
    require(checksum == case["logicalChecksumSha256"], f"{case['id']}: logical checksum mismatch")
    return checksum


def assert_invalid_structure(handle: h5py.File, case: dict[str, Any]) -> None:
    mutation = case.get("mutation")
    if case["id"] == "wrong-extension":
        assert_valid_structure(handle, {**case, "expectedOutcome": "open", "logicalChecksumSha256": phase12.canonical_sha256({"shape": [phase12.N_TIME, phase12.N_WAVELENGTH], "values": phase12.LOGICAL_VALUES.astype(np.int64).tolist()})})
    elif mutation == "missing-version":
        require("format_version" not in handle.attrs, "missing-version fixture has version")
    elif mutation == "wrong-version-value":
        require(int(handle.attrs["format_version"]) == 2, "wrong version value mismatch")
    elif mutation == "wrong-version-rank":
        require(np.asarray(handle.attrs["format_version"]).shape == (1,), "version rank mismatch")
    elif mutation == "wrong-version-type":
        require(np.asarray(handle.attrs["format_version"]).dtype.kind == "f", "version type mismatch")
    elif mutation == "missing-shape":
        require("shape" not in handle.attrs, "missing-shape fixture has shape")
    elif mutation == "wrong-shape-length":
        require(np.asarray(handle.attrs["shape"]).shape == (1,), "shape length mismatch")
    elif mutation == "wrong-shape-type":
        require(np.asarray(handle.attrs["shape"]).dtype.kind == "f", "shape type mismatch")
    elif mutation == "wrong-shape-value":
        require(list(handle.attrs["shape"]) == [phase12.N_TIME + 1, phase12.N_WAVELENGTH], "shape value mismatch")
    elif mutation in {"missing-time", "missing-wavelength", "missing-oes"}:
        require(mutation.removeprefix("missing-") not in handle, f"{mutation} fixture contains dataset")
    elif mutation == "time-wrong-rank":
        require(handle["time"].ndim == 2, "time rank mismatch")
    elif mutation == "time-wrong-type":
        require(handle["time"].dtype.kind == "b", "time type mismatch")
    elif mutation == "wavelength-wrong-shape":
        require(list(handle["wavelength"].shape) == [phase12.N_WAVELENGTH - 1], "wavelength shape mismatch")
    elif mutation == "oes-wrong-rank":
        require(handle["oes"].ndim == 1, "oes rank mismatch")
    elif mutation == "oes-wrong-type":
        require(handle["oes"].dtype == np.dtype("<i2"), "oes type mismatch")
    elif mutation == "oes-wrong-shape":
        require(list(handle["oes"].shape) == [phase12.N_TIME, phase12.N_WAVELENGTH], "oes shape mismatch")
    elif mutation == "unknown-filter":
        filters = filter_details(handle["oes"])
        require(len(filters) == 1 and filters[0]["id"] == phase12.phase10.UNKNOWN_FILTER_ID, "unknown filter mismatch")
    else:
        raise RuntimeError(f"Unhandled invalid case: {case['id']}")


def audit_cases(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    results = []
    ids = [case["id"] for case in manifest["cases"]]
    require(len(ids) == len(set(ids)), "Duplicate H5 matrix case IDs")
    for case in manifest["cases"]:
        path = resolve_recorded_path(case["path"])
        require(path.is_file(), f"Missing matrix file: {path}")
        require(path.stat().st_size == case["bytes"], f"{case['id']}: size mismatch")
        require(phase12.sha256_file(path) == case["sha256"], f"{case['id']}: SHA-256 mismatch")
        if case.get("mutation") == "bad-signature":
            try:
                h5py.File(path, "r").close()
            except OSError:
                pass
            else:
                raise RuntimeError("bad-signature unexpectedly opened as HDF5")
        else:
            with h5py.File(path, "r") as handle:
                if case["expectedOutcome"] == "open":
                    checksum = assert_valid_structure(handle, case)
                    require(case["expectedErrorCode"] is None, f"{case['id']}: unexpected error code")
                else:
                    assert_invalid_structure(handle, case)
                    checksum = None
        expected_code = (
            "UnsupportedFormat"
            if case["id"] == "wrong-extension"
            else "UnsupportedOesHdf5Compression"
            if case.get("mutation") == "unknown-filter"
            else None
            if case["expectedOutcome"] == "open"
            else "InvalidOesHdf5"
        )
        require(case["expectedErrorCode"] == expected_code, f"{case['id']}: expected error code contract mismatch")
        results.append({"id": case["id"], "sha256": case["sha256"], "logicalChecksumSha256": checksum, "result": "PASS"})
    return results


def clean_read(path: Path) -> int:
    import hdf5plugin  # noqa: F401 - registers the wheel-bundled Blosc decoder without plugin path discovery.

    with h5py.File(path, "r") as handle:
        logical = np.asarray(handle["oes"][:], dtype="<i8").T
    checksum = phase12.canonical_sha256(
        {"shape": [phase12.N_TIME, phase12.N_WAVELENGTH], "values": logical.tolist()}
    )
    print(json.dumps({"checksum": checksum, "filter": "Blosc/Zstd 32001"}))
    return 0


def run_clean_runtime_smoke(path: Path, expected_checksum: str, output_dir: Path) -> dict[str, Any]:
    empty_plugin_dir = output_dir / "empty-plugin-path"
    empty_plugin_dir.mkdir(exist_ok=True)
    environment = os.environ.copy()
    environment["HDF5_PLUGIN_PATH"] = str(empty_plugin_dir.resolve())
    environment.pop("HDF5_VOL_CONNECTOR", None)
    environment.pop("HDF5_DRIVER", None)
    command = [sys.executable, str(Path(__file__).resolve()), "--clean-read", str(path.resolve())]
    completed = subprocess.run(command, capture_output=True, text=True, env=environment, check=False)
    require(completed.returncode == 0, f"Clean decoder smoke failed: {completed.stderr.strip()}")
    payload = json.loads(completed.stdout.strip())
    require(payload["checksum"] == expected_checksum, "Clean decoder checksum mismatch")
    return {
        "scope": "Python wheel-bundled decoder smoke; not product static-runtime evidence",
        "hdf5PluginPath": str(empty_plugin_dir.resolve()),
        "command": command,
        "checksum": payload["checksum"],
        "result": "PASS",
        "productStaticRuntime": "NOT_RUN",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(".tmp/phase12-h5/manifest.json"))
    parser.add_argument("--output", type=Path, default=Path(".tmp/phase12-h5/audit.json"))
    parser.add_argument("--clean-read", type=Path, default=None, help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.clean_read is not None:
        return clean_read(args.clean_read)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    require(manifest.get("schemaVersion") == 1, "Unsupported H5 matrix manifest schema")
    require(manifest.get("revision") == phase12.REVISION, "Unexpected H5 matrix revision")
    require(phase12.sha256_file(resolve_recorded_path(manifest["generator"])) == manifest["generatorSha256"], "Generator hash mismatch")
    for asset in manifest["reusedAssets"]:
        require(phase12.sha256_file(resolve_recorded_path(asset["path"])) == asset["sha256"], f"Reused asset hash mismatch: {asset['path']}")
    results = audit_cases(manifest)
    canonical = next(case for case in manifest["cases"] if case["id"] == "format-oesh5")
    clean_runtime = run_clean_runtime_smoke(
        resolve_recorded_path(canonical["path"]),
        canonical["logicalChecksumSha256"],
        args.manifest.resolve().parent,
    )
    output = {
        "schemaVersion": 1,
        "revision": phase12.REVISION,
        "auditedAtUtc": datetime.now(timezone.utc).isoformat(),
        "manifest": phase12.relative_path(args.manifest),
        "cases": results,
        "cleanRuntimeAudit": clean_runtime,
        "productStaticRuntime": {
            "result": "NOT_RUN",
            "requiredEvidence": "release Rust/native open of the canonical Blosc/Zstd fixture with dynamic plugin discovery disabled",
        },
        "result": "PASS_WITH_PRODUCT_RUNTIME_NOT_RUN",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), "cases": len(results), "result": output["result"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
