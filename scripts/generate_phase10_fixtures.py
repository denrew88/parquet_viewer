from __future__ import annotations

import argparse
import importlib.metadata
import os
import sys
import tempfile
from pathlib import Path
from typing import Callable

PINNED_VERSIONS = {
    "python": "3.10.11",
    "numpy": "1.26.4",
    "h5py": "3.16.0",
    "hdf5": "2.0.0",
    "hdf5plugin": "7.0.0",
}

BLOSC_FILTER_ID = 32_001
UNKNOWN_FILTER_ID = 32_099
CORE_INTENSITY = (
    (-2_147_483_648, -7, 0, 2_147_483_647),
    (100, 101, 102, 103),
    (200, 201, 202, 203),
)

GENERATED_FIXTURE_NAMES = (
    "oes-core-vlen-time.oes.h5",
    "oes-core-numeric.oes.h5",
    "oes-core-unknown-attrs.oes.h5",
    "oes-name-collisions.oes.h5",
    "not-oes.h5",
    "fake.oes.h5",
    "oes-missing-time.oes.h5",
    "oes-missing-wavelength.oes.h5",
    "oes-missing-intensity.oes.h5",
    "oes-axis-datasets.oes.h5",
    "oes-wrong-rank.oes.h5",
    "oes-wrong-dtype.oes.h5",
    "oes-contiguous.oes.h5",
    "oes-wrong-filter.oes.h5",
    "oes-shape-mismatch.oes.h5",
    "oes-soft-link.oes.h5",
    "oes-external-link.oes.h5",
    "oes-vds.oes.h5",
    "oes-external-storage.oes.h5",
    "oes-unknown-filter.oes.h5",
    "oes-truncated.oes.h5",
)


def _load_dependencies() -> tuple[object, object, object]:
    try:
        import h5py
        import hdf5plugin
        import numpy
    except ImportError as error:
        raise SystemExit(
            "Phase 10 fixture generation requires pinned numpy, h5py, and hdf5plugin. "
            f"Missing dependency: {error.name}"
        ) from error
    return h5py, hdf5plugin, numpy


def environment_versions() -> dict[str, str]:
    h5py, _, numpy = _load_dependencies()
    return {
        "python": ".".join(str(value) for value in sys.version_info[:3]),
        "numpy": str(numpy.__version__),
        "h5py": str(h5py.__version__),
        "hdf5": str(h5py.version.hdf5_version),
        "hdf5plugin": importlib.metadata.version("hdf5plugin"),
    }


def require_pinned_environment() -> None:
    actual = environment_versions()
    mismatches = {
        name: {"expected": expected, "actual": actual.get(name)}
        for name, expected in PINNED_VERSIONS.items()
        if actual.get(name) != expected
    }
    if mismatches:
        details = ", ".join(
            f"{name}={values['actual']} (expected {values['expected']})"
            for name, values in mismatches.items()
        )
        raise SystemExit(f"Pinned Phase 10 fixture environment mismatch: {details}")


def _new_file(path: Path):
    h5py, _, _ = _load_dependencies()
    return h5py.File(path, "w", libver="earliest", track_order=True)


def _write_axis_attribute(handle: object, name: str, values: object) -> None:
    h5py, _, numpy = _load_dependencies()
    array = numpy.asarray(values)
    if array.dtype.kind in {"O", "U", "S"}:
        text = numpy.asarray([str(value) for value in array], dtype=object)
        handle.attrs.create(name, text, dtype=h5py.string_dtype(encoding="utf-8"))
    else:
        handle.attrs[name] = numpy.ascontiguousarray(array)


def _write_core_axes(
    handle: object,
    *,
    time: object | None = None,
    wavelength: object | None = None,
) -> None:
    _, _, numpy = _load_dependencies()
    if time is None:
        time = numpy.asarray(
            [
                "2026-07-17T12:00:00.000+09:00",
                "2026-07-17T12:00:00.100+09:00",
                "2026-07-17T12:00:00.200+09:00",
            ],
            dtype=object,
        )
    if wavelength is None:
        wavelength = numpy.asarray([200.0000000001, 201.5, 305.25, 900.0000000001], dtype="<f8")
    _write_axis_attribute(handle, "time", time)
    _write_axis_attribute(handle, "wavelength", wavelength)


def _write_blosc_dataset(
    handle: object,
    data: object = CORE_INTENSITY,
    *,
    name: str = "intensity",
    chunks: tuple[int, ...] | None = (2, 2),
) -> None:
    _, hdf5plugin, numpy = _load_dependencies()
    values = numpy.asarray(data, dtype="<i4")
    compression = hdf5plugin.Blosc(
        cname="zstd",
        clevel=5,
        shuffle=hdf5plugin.Blosc.SHUFFLE,
    )
    handle.create_dataset(
        name,
        data=values,
        chunks=chunks,
        compression=compression,
        track_times=False,
    )


def _core_vlen_time(path: Path) -> None:
    with _new_file(path) as handle:
        _write_core_axes(handle)
        _write_blosc_dataset(handle)


def _core_numeric(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(
            handle,
            time=numpy.asarray(
                [9_007_199_254_740_993, 9_007_199_254_740_995, 9_007_199_254_740_997],
                dtype="<i8",
            ),
        )
        _write_blosc_dataset(handle)


def _core_unknown_attrs(path: Path) -> None:
    with _new_file(path) as handle:
        _write_core_axes(handle)
        handle.attrs["ignored_scalar"] = "not part of the OES contract"
        handle.attrs["ignored_number"] = 42
        handle.create_group("ignored_group", track_order=True)
        _write_blosc_dataset(handle)


def _name_collisions(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    intensity = numpy.asarray(((1, 2, 3, 4), (5, 6, 7, 8)), dtype="<i4")
    with _new_file(path) as handle:
        _write_core_axes(
            handle,
            time=numpy.asarray([1, 2], dtype="<i8"),
            wavelength=numpy.asarray(["", "time", "500", "500"], dtype=object),
        )
        _write_blosc_dataset(handle, intensity, chunks=(1, 2))


def _not_oes(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        handle.create_dataset("ordinary", data=numpy.asarray([1, 2, 3], dtype="<i4"), track_times=False)


def _fake(path: Path) -> None:
    path.write_bytes(b"not an HDF5 file\n")


def _missing_axis(path: Path, missing: str) -> None:
    with _new_file(path) as handle:
        _write_core_axes(handle)
        del handle.attrs[missing]
        _write_blosc_dataset(handle)


def _missing_intensity(path: Path) -> None:
    with _new_file(path) as handle:
        _write_core_axes(handle)


def _axis_datasets(path: Path) -> None:
    h5py, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        handle.create_dataset(
            "time",
            data=numpy.asarray(
                [
                    "2026-07-17T12:00:00.000+09:00",
                    "2026-07-17T12:00:00.100+09:00",
                    "2026-07-17T12:00:00.200+09:00",
                ],
                dtype=object,
            ),
            dtype=h5py.string_dtype("utf-8"),
            track_times=False,
        )
        handle.create_dataset(
            "wavelength",
            data=numpy.asarray([200.0, 201.5, 305.25, 900.0], dtype="<f8"),
            track_times=False,
        )
        _write_blosc_dataset(handle)


def _wrong_rank(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_axis_attribute(handle, "time", numpy.asarray([1, 2, 3], dtype="<i8"))
        _write_axis_attribute(handle, "wavelength", numpy.asarray([200.0], dtype="<f8"))
        _write_blosc_dataset(handle, numpy.asarray([1, 2, 3], dtype="<i4"), chunks=(2,))


def _wrong_dtype(path: Path) -> None:
    _, hdf5plugin, numpy = _load_dependencies()
    values = numpy.asarray(((-32_768, -7, 0, 32_767), (100, 101, 102, 103), (200, 201, 202, 203)), dtype="<i2")
    with _new_file(path) as handle:
        _write_core_axes(handle)
        handle.create_dataset(
            "intensity",
            data=values,
            chunks=(2, 2),
            compression=hdf5plugin.Blosc(cname="zstd", clevel=5, shuffle=hdf5plugin.Blosc.SHUFFLE),
            track_times=False,
        )


def _contiguous(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        handle.create_dataset(
            "intensity",
            data=numpy.asarray(CORE_INTENSITY, dtype="<i4"),
            track_times=False,
        )


def _wrong_filter(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        handle.create_dataset(
            "intensity",
            data=numpy.asarray(CORE_INTENSITY, dtype="<i4"),
            chunks=(2, 2),
            compression="gzip",
            compression_opts=1,
            track_times=False,
        )


def _shape_mismatch(path: Path) -> None:
    _, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle, time=numpy.asarray([1, 2], dtype="<i8"))
        _write_blosc_dataset(handle)


def _soft_link(path: Path) -> None:
    h5py, _, _ = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        payload = handle.create_group("payload", track_order=True)
        _write_blosc_dataset(payload)
        handle["intensity"] = h5py.SoftLink("/payload/intensity")


def _external_link(path: Path) -> None:
    h5py, _, _ = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        handle["intensity"] = h5py.ExternalLink("phase10-missing-target.h5", "/intensity")


def _vds(path: Path) -> None:
    h5py, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        space = h5py.h5s.create_simple((3, 4))
        source_space = h5py.h5s.create_simple((3, 4))
        creation = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
        creation.set_obj_track_times(False)
        creation.set_virtual(
            space,
            b"phase10-missing-vds-source.h5",
            b"/intensity",
            source_space,
        )
        dataset = h5py.h5d.create(
            handle.id,
            b"intensity",
            h5py.h5t.py_create(numpy.dtype("<i4")),
            space,
            dcpl=creation,
        )
        dataset.close()


def _external_storage(path: Path) -> None:
    h5py, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        handle.create_dataset(
            "intensity",
            shape=(3, 4),
            dtype="<i4",
            external=[("phase10-missing-external.raw", 0, h5py.h5f.UNLIMITED)],
            fillvalue=numpy.int32(-1),
            track_times=False,
        )


def _unknown_filter(path: Path) -> None:
    h5py, _, numpy = _load_dependencies()
    with _new_file(path) as handle:
        _write_core_axes(handle)
        space = h5py.h5s.create_simple((3, 4))
        dtype = h5py.h5t.py_create(numpy.dtype("<i4"))
        creation = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
        creation.set_obj_track_times(False)
        creation.set_chunk((2, 2))
        # HDF5 refuses to create a dataset with an unregistered mandatory filter.
        # An optional unknown filter still records the hostile pipeline metadata,
        # which the viewer must reject before attempting any payload read.
        creation.set_filter(UNKNOWN_FILTER_ID, h5py.h5z.FLAG_OPTIONAL, ())
        dataset = h5py.h5d.create(handle.id, b"intensity", dtype, space, dcpl=creation)
        dataset.close()


def _truncated(path: Path, source: Path) -> None:
    payload = source.read_bytes()
    path.write_bytes(payload[: min(512, len(payload) // 2)])


FIXTURE_WRITERS: dict[str, Callable[[Path], None]] = {
    "oes-core-vlen-time.oes.h5": _core_vlen_time,
    "oes-core-numeric.oes.h5": _core_numeric,
    "oes-core-unknown-attrs.oes.h5": _core_unknown_attrs,
    "oes-name-collisions.oes.h5": _name_collisions,
    "not-oes.h5": _not_oes,
    "fake.oes.h5": _fake,
    "oes-missing-time.oes.h5": lambda path: _missing_axis(path, "time"),
    "oes-missing-wavelength.oes.h5": lambda path: _missing_axis(path, "wavelength"),
    "oes-missing-intensity.oes.h5": _missing_intensity,
    "oes-axis-datasets.oes.h5": _axis_datasets,
    "oes-wrong-rank.oes.h5": _wrong_rank,
    "oes-wrong-dtype.oes.h5": _wrong_dtype,
    "oes-contiguous.oes.h5": _contiguous,
    "oes-wrong-filter.oes.h5": _wrong_filter,
    "oes-shape-mismatch.oes.h5": _shape_mismatch,
    "oes-soft-link.oes.h5": _soft_link,
    "oes-external-link.oes.h5": _external_link,
    "oes-vds.oes.h5": _vds,
    "oes-external-storage.oes.h5": _external_storage,
    "oes-unknown-filter.oes.h5": _unknown_filter,
}


def generate(output: Path) -> None:
    require_pinned_environment()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="phase10-fixtures-", dir=output.parent) as temporary:
        staging = Path(temporary)
        for name, writer in FIXTURE_WRITERS.items():
            writer(staging / name)
        _truncated(staging / "oes-truncated.oes.h5", staging / "oes-core-vlen-time.oes.h5")

        output.mkdir(parents=True, exist_ok=True)
        for name in GENERATED_FIXTURE_NAMES:
            os.replace(staging / name, output / name)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate deterministic small Phase 10 OES fixtures.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "fixtures" / "phase-10",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--generate", action="store_true", help="Generate small committed fixtures.")
    mode.add_argument(
        "--check",
        action="store_true",
        help="Audit current files and manifest without regenerating them.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.generate:
        generate(args.output.resolve())
        print(f"Generated {len(GENERATED_FIXTURE_NAMES)} Phase 10 fixtures in {args.output.resolve()}")
        return 0

    require_pinned_environment()
    scripts = Path(__file__).resolve().parent
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    from audit_phase10_fixtures import audit_manifest

    manifest = args.output.resolve() / "manifest.json"
    audit_manifest(manifest, check_reference=False)
    print(f"PASS: {manifest} and committed fixture files match without regeneration.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
