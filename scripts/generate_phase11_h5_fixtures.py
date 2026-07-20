from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import h5py
import hdf5plugin
import numpy


def blosc_zstd() -> hdf5plugin.Blosc:
    return hdf5plugin.Blosc(
        cname="zstd",
        clevel=5,
        shuffle=hdf5plugin.Blosc.SHUFFLE,
    )


def write_contract(handle: h5py.File, time: numpy.ndarray, wavelength: numpy.ndarray) -> None:
    handle.attrs.create("format", "oefh5", dtype=h5py.string_dtype("utf-8"))
    handle.attrs["format_version"] = numpy.int32(3)
    handle.attrs["shape"] = numpy.asarray((len(time), len(wavelength)), dtype="<i8")
    handle.create_dataset("time", data=time, track_times=False)
    handle.create_dataset("wavelength", data=wavelength, track_times=False)


def write_numeric(path: Path) -> None:
    time = numpy.arange(1_000_000, 1_000_480, dtype="<i8")
    wavelength = numpy.arange(400, 464, dtype="<i4")
    logical = numpy.arange(480, dtype="<i4")[:, None] * 1_000 + numpy.arange(
        64, dtype="<i4"
    )[None, :]
    with h5py.File(path, "w", libver="earliest", track_order=True) as handle:
        write_contract(handle, time, wavelength)
        handle.create_dataset(
            "oes",
            data=logical.T,
            chunks=(64, 128),
            compression=blosc_zstd(),
            track_times=False,
        )


def write_string_int64(path: Path) -> None:
    time = numpy.asarray(
        ["2026-07-20 00:00:00.000000001", "", "2026-07-20 00:00:00.000000003"],
        dtype=h5py.string_dtype("utf-8"),
    )
    wavelength = numpy.asarray(["UV", "VIS"], dtype=h5py.string_dtype("utf-8"))
    logical = numpy.asarray(
        [
            [numpy.iinfo(numpy.int64).min, -1],
            [0, 1],
            [numpy.iinfo(numpy.int64).max, 42],
        ],
        dtype="<i8",
    )
    with h5py.File(path, "w", libver="earliest", track_order=True) as handle:
        write_contract(handle, time, wavelength)
        handle.create_dataset(
            "oes",
            data=logical.T,
            chunks=(2, 3),
            compression=blosc_zstd(),
            track_times=False,
        )


def file_record(path: Path) -> dict[str, object]:
    payload = path.read_bytes()
    return {
        "name": path.name,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "fixtures" / "phase-11",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    numeric = args.output / "oef-v3-int32.oes.h5"
    string_int64 = args.output / "oef-v3-string-int64.oes.h5"
    write_numeric(numeric)
    write_string_int64(string_int64)

    manifest = {
        "contract": {
            "format": "oefh5",
            "formatVersion": 3,
            "logicalShape": "[time,wavelength]",
            "physicalOesShape": "[wavelength,time]",
            "compression": "Blosc/Zstd filter 32001",
        },
        "generator": {
            "python": ".".join(str(part) for part in sys.version_info[:3]),
            "numpy": numpy.__version__,
            "h5py": h5py.__version__,
            "hdf5": h5py.version.hdf5_version,
            "hdf5plugin": "7.0.0",
        },
        "files": [file_record(numeric), file_record(string_int64)],
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
