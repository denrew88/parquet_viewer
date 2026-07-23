"""Generate the deterministic Phase 12 H5 structure-detection matrix.

The files are test inputs only.  They exercise extension/signature gates, ignored ``format``
attributes, the OES v3 dataset contract and typed compression failures.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import hdf5plugin
import numpy as np

import generate_phase10_fixtures as phase10
import generate_phase11_h5_fixtures as phase11


REVISION = "phase12-h5-matrix-v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
N_TIME = 4
N_WAVELENGTH = 3
WIDE_N_TIME = 4
WIDE_N_WAVELENGTH = 256
LOGICAL_VALUES = np.asarray(
    [[0, 1, 2], [100, 101, 102], [200, 201, 202], [300, 301, 302]], dtype="<i8"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def relative_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(resolved)


def format_value(handle: h5py.File, variant: str) -> None:
    if variant == "missing":
        return
    if variant in {"oesh5", "oefh5", "oesf5", "arbitrary"}:
        value = "not-the-format" if variant == "arbitrary" else variant
        handle.attrs.create("format", value, dtype=h5py.string_dtype("utf-8"))
        return
    if variant == "integer":
        handle.attrs["format"] = np.int32(17)
        return
    if variant == "array":
        handle.attrs["format"] = np.asarray([1, 2, 3], dtype="<i2")
        return
    raise ValueError(f"Unknown format variant: {variant}")


def axis_values(kind: str) -> tuple[np.ndarray, np.ndarray]:
    if kind == "integer":
        return np.asarray([10, 20, 30, 40], dtype="<i8"), np.asarray(
            [400, 500, 600], dtype="<i4"
        )
    if kind == "float":
        return np.asarray([0.0, 0.25, 0.5, 0.75], dtype="<f8"), np.asarray(
            [400.5, 500.25, 600.125], dtype="<f8"
        )
    if kind == "string":
        dtype = h5py.string_dtype("utf-8")
        return np.asarray(["t0", "", "t2", "t3"], dtype=dtype), np.asarray(
            ["UV", "VIS", "IR"], dtype=dtype
        )
    raise ValueError(f"Unknown axis kind: {kind}")


def write_unknown_filter_dataset(handle: h5py.File, dtype: np.dtype[Any]) -> None:
    space = h5py.h5s.create_simple((N_WAVELENGTH, N_TIME))
    creation = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    creation.set_obj_track_times(False)
    creation.set_chunk((N_WAVELENGTH, N_TIME))
    creation.set_filter(phase10.UNKNOWN_FILTER_ID, h5py.h5z.FLAG_OPTIONAL, ())
    dataset = h5py.h5d.create(
        handle.id,
        b"oes",
        h5py.h5t.py_create(dtype),
        space,
        dcpl=creation,
    )
    dataset.close()


def write_case(path: Path, case: dict[str, Any]) -> None:
    if case.get("mutation") == "bad-signature":
        path.write_bytes(b"not an HDF5 file\n")
        return

    if case.get("wide"):
        time = np.arange(WIDE_N_TIME, dtype="<i8")
        wavelength = np.linspace(200.0, 900.0, WIDE_N_WAVELENGTH, dtype="<f8")
        logical_values = (
            np.arange(WIDE_N_TIME, dtype="<i8")[:, None] * 10_000
            + np.arange(WIDE_N_WAVELENGTH, dtype="<i8")[None, :]
        )
        n_time, n_wavelength = WIDE_N_TIME, WIDE_N_WAVELENGTH
    else:
        time, wavelength = axis_values(case.get("axisKind", "float"))
        logical_values = LOGICAL_VALUES
        n_time, n_wavelength = N_TIME, N_WAVELENGTH
    oes_dtype = np.dtype(case.get("oesDtype", "<i4"))
    mutation = case.get("mutation")
    with h5py.File(path, "w", libver="earliest", track_order=True) as handle:
        format_value(handle, case.get("formatVariant", "oesh5"))
        if mutation != "missing-version":
            if mutation == "wrong-version-value":
                handle.attrs["format_version"] = np.int32(2)
            elif mutation == "wrong-version-rank":
                handle.attrs["format_version"] = np.asarray([3], dtype="<i4")
            elif mutation == "wrong-version-type":
                handle.attrs["format_version"] = np.float64(3.0)
            else:
                handle.attrs["format_version"] = np.int32(3)

        if mutation != "missing-shape":
            if mutation == "wrong-shape-length":
                handle.attrs["shape"] = np.asarray([n_time], dtype="<i8")
            elif mutation == "wrong-shape-type":
                handle.attrs["shape"] = np.asarray([n_time, n_wavelength], dtype="<f8")
            elif mutation == "wrong-shape-value":
                handle.attrs["shape"] = np.asarray([n_time + 1, n_wavelength], dtype="<i8")
            else:
                handle.attrs["shape"] = np.asarray([n_time, n_wavelength], dtype="<i8")

        if mutation != "missing-time":
            time_data = time.reshape(2, 2) if mutation == "time-wrong-rank" else time
            if mutation == "time-wrong-type":
                time_data = np.asarray([True, False, True, False], dtype=np.bool_)
            handle.create_dataset("time", data=time_data, track_times=False)

        if mutation != "missing-wavelength":
            wavelength_data = wavelength[:2] if mutation == "wavelength-wrong-shape" else wavelength
            handle.create_dataset("wavelength", data=wavelength_data, track_times=False)

        if mutation == "missing-oes":
            return
        if mutation == "unknown-filter":
            write_unknown_filter_dataset(handle, oes_dtype)
            return

        physical = logical_values.astype(oes_dtype, copy=False).T
        if mutation == "oes-wrong-rank":
            physical = physical.reshape(-1)
        elif mutation == "oes-wrong-shape":
            physical = logical_values.astype(oes_dtype, copy=False)
        if mutation == "oes-wrong-type":
            physical = logical_values.astype("<i2").T
        chunks = tuple(min(size, limit) for size, limit in zip(physical.shape, (128, 4)))
        handle.create_dataset(
            "oes",
            data=physical,
            chunks=chunks,
            compression=phase11.blosc_zstd(),
            track_times=False,
        )


def valid_case(case_id: str, filename: str, **options: Any) -> dict[str, Any]:
    return {
        "id": case_id,
        "file": filename,
        "expectedOutcome": "open",
        "expectedErrorCode": None,
        **options,
    }


def invalid_case(
    case_id: str, filename: str, error_code: str = "InvalidOesHdf5", **options: Any
) -> dict[str, Any]:
    return {
        "id": case_id,
        "file": filename,
        "expectedOutcome": "error",
        "expectedErrorCode": error_code,
        **options,
    }


def matrix_cases() -> list[dict[str, Any]]:
    cases = [
        valid_case("format-missing", "valid-format-missing.h5", formatVariant="missing"),
        valid_case("format-oesh5", "valid-format-oesh5.h5", formatVariant="oesh5"),
        valid_case("format-oefh5", "valid-format-oefh5.h5", formatVariant="oefh5"),
        valid_case("format-oesf5", "valid-format-oesf5.h5", formatVariant="oesf5"),
        valid_case("format-arbitrary", "valid-format-arbitrary.h5", formatVariant="arbitrary"),
        valid_case("format-integer", "valid-format-integer.h5", formatVariant="integer"),
        valid_case("format-array", "valid-format-array.h5", formatVariant="array"),
        valid_case("extension-uppercase-h5", "valid-extension.H5"),
        valid_case("extension-hdf5", "valid-extension.hdf5"),
        valid_case("extension-uppercase-hdf5", "valid-extension.HDF5"),
        valid_case("oes-int32", "valid-oes-int32.h5", oesDtype="<i4"),
        valid_case("oes-int64", "valid-oes-int64.h5", oesDtype="<i8"),
        valid_case("axis-integer", "valid-axis-integer.h5", axisKind="integer"),
        valid_case("axis-float", "valid-axis-float.h5", axisKind="float"),
        valid_case("axis-string", "valid-axis-string.h5", axisKind="string"),
        valid_case("wide-copy", "valid-wide-copy.h5", wide=True),
        invalid_case(
            "wrong-extension",
            "valid-structure.bin",
            error_code="UnsupportedFormat",
        ),
        invalid_case("bad-signature", "invalid-signature.h5", mutation="bad-signature"),
        invalid_case("missing-version", "invalid-missing-version.h5", mutation="missing-version"),
        invalid_case(
            "wrong-version-value", "invalid-version-value.h5", mutation="wrong-version-value"
        ),
        invalid_case(
            "wrong-version-rank", "invalid-version-rank.h5", mutation="wrong-version-rank"
        ),
        invalid_case(
            "wrong-version-type", "invalid-version-type.h5", mutation="wrong-version-type"
        ),
        invalid_case("missing-shape", "invalid-missing-shape.h5", mutation="missing-shape"),
        invalid_case(
            "wrong-shape-length", "invalid-shape-length.h5", mutation="wrong-shape-length"
        ),
        invalid_case("wrong-shape-type", "invalid-shape-type.h5", mutation="wrong-shape-type"),
        invalid_case("wrong-shape-value", "invalid-shape-value.h5", mutation="wrong-shape-value"),
        invalid_case("missing-time", "invalid-missing-time.h5", mutation="missing-time"),
        invalid_case(
            "missing-wavelength", "invalid-missing-wavelength.h5", mutation="missing-wavelength"
        ),
        invalid_case("missing-oes", "invalid-missing-oes.h5", mutation="missing-oes"),
        invalid_case("time-wrong-rank", "invalid-time-rank.h5", mutation="time-wrong-rank"),
        invalid_case("time-wrong-type", "invalid-time-type.h5", mutation="time-wrong-type"),
        invalid_case(
            "wavelength-wrong-shape",
            "invalid-wavelength-shape.h5",
            mutation="wavelength-wrong-shape",
        ),
        invalid_case("oes-wrong-rank", "invalid-oes-rank.h5", mutation="oes-wrong-rank"),
        invalid_case("oes-wrong-type", "invalid-oes-type.h5", mutation="oes-wrong-type"),
        invalid_case("oes-wrong-shape", "invalid-oes-shape.h5", mutation="oes-wrong-shape"),
        invalid_case(
            "unknown-filter",
            "invalid-unknown-filter.h5",
            error_code="UnsupportedOesHdf5Compression",
            mutation="unknown-filter",
        ),
    ]
    names = [case["file"] for case in cases]
    if len(names) != len(set(names)):
        raise RuntimeError("H5 matrix filenames must be unique")
    return cases


def case_record(output: Path, case: dict[str, Any]) -> dict[str, Any]:
    path = output / case["file"]
    record = {
        **case,
        "path": relative_path(path),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }
    if case["expectedOutcome"] == "open":
        if case.get("wide"):
            logical_values = (
                np.arange(WIDE_N_TIME, dtype="<i8")[:, None] * 10_000
                + np.arange(WIDE_N_WAVELENGTH, dtype="<i8")[None, :]
            )
            logical_shape = [WIDE_N_TIME, WIDE_N_WAVELENGTH]
        else:
            logical_values = LOGICAL_VALUES.astype(np.int64)
            logical_shape = [N_TIME, N_WAVELENGTH]
        record["logicalShape"] = logical_shape
        record["physicalOesShape"] = [logical_shape[1], logical_shape[0]]
        logical = {
            "shape": logical_shape,
            "values": logical_values.tolist(),
        }
        record["logicalChecksumSha256"] = canonical_sha256(logical)
        record["schemaChecksumSha256"] = canonical_sha256(
            {
                "axisKind": case.get("axisKind", "float"),
                "oesDtype": str(np.dtype(case.get("oesDtype", "<i4"))),
                "logicalShape": logical_shape,
                "physicalOesShape": [logical_shape[1], logical_shape[0]],
            }
        )
    return record


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".tmp/phase12-h5"))
    parser.add_argument("--manifest", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases = matrix_cases()
    for case in cases:
        write_case(output / case["file"], case)
    manifest_path = (args.manifest or output / "manifest.json").resolve()
    manifest = {
        "schemaVersion": 1,
        "revision": REVISION,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "generator": relative_path(Path(__file__)),
        "generatorSha256": sha256_file(Path(__file__)),
        "reusedAssets": [
            {
                "path": relative_path(Path(phase10.__file__)),
                "sha256": sha256_file(Path(phase10.__file__)),
                "use": "unknown filter ID and low-level HDF5 fixture pattern",
            },
            {
                "path": relative_path(Path(phase11.__file__)),
                "sha256": sha256_file(Path(phase11.__file__)),
                "use": "Blosc v1/Zstd filter 32001 configuration",
            },
        ],
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "h5py": h5py.__version__,
            "hdf5": h5py.version.hdf5_version,
            "hdf5plugin": importlib.metadata.version("hdf5plugin"),
        },
        "contract": {
            "formatAttribute": "ignored without reading its datatype or value",
            "formatVersion": 3,
            "logicalShape": [N_TIME, N_WAVELENGTH],
            "physicalOesShape": [N_WAVELENGTH, N_TIME],
            "compression": "Blosc v1 filter 32001 with Zstd",
        },
        "cases": [case_record(output, case) for case in cases],
        "cleanRuntimeAudit": {
            "fixtureCase": "format-oesh5",
            "dynamicPluginPathClearedPythonRead": "REQUIRED",
            "productStaticRuntime": "NOT_RUN",
            "productEvidence": "artifacts/phase-12/h5-matrix-results.json",
        },
        "validation": "GENERATED_NOT_AUDITED",
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"manifest": str(manifest_path), "cases": len(cases)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
