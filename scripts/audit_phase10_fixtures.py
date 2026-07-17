from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from generate_phase10_fixtures import GENERATED_FIXTURE_NAMES, environment_versions


class AuditFailure(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AuditFailure(message)


def _json_value(value: Any) -> Any:
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def _link_kind(handle: Any, name: str) -> str | None:
    import h5py

    link = handle.get(name, getlink=True)
    if link is None:
        return None
    if isinstance(link, h5py.HardLink):
        target = handle.get(name, getclass=True)
        if target is h5py.Dataset:
            return "dataset"
        if target is h5py.Group:
            return "group"
        return "hardLink"
    if isinstance(link, h5py.SoftLink):
        return "softLink"
    if isinstance(link, h5py.ExternalLink):
        return "externalLink"
    return type(link).__name__


def _dataset_filter_details(dataset: Any) -> list[dict[str, Any]]:
    creation = dataset.id.get_create_plist()
    filters: list[dict[str, Any]] = []
    for index in range(creation.get_nfilters()):
        filter_id, flags, values, name = creation.get_filter(index)
        filters.append(
            {
                "id": int(filter_id),
                "flags": int(flags),
                "cdValues": [int(value) for value in values],
                "name": _json_value(name),
            }
        )
    return filters


def _audit_dataset(path: Path, dataset: Any, expected: dict[str, Any]) -> None:
    if "shape" in expected:
        _require(list(dataset.shape) == expected["shape"], f"{path.name}: intensity shape mismatch")
    if "dtype" in expected:
        _require(str(dataset.dtype) == expected["dtype"], f"{path.name}: intensity dtype mismatch")
    if "chunks" in expected:
        actual_chunks = None if dataset.chunks is None else list(dataset.chunks)
        _require(actual_chunks == expected["chunks"], f"{path.name}: intensity chunks mismatch")
    if "filters" in expected:
        _require(
            _dataset_filter_details(dataset) == expected["filters"],
            f"{path.name}: intensity filter pipeline mismatch",
        )
    if "isVirtual" in expected:
        _require(bool(dataset.is_virtual) == expected["isVirtual"], f"{path.name}: VDS flag mismatch")
    if "externalStorageCount" in expected:
        count = int(dataset.id.get_create_plist().get_external_count())
        _require(count == expected["externalStorageCount"], f"{path.name}: external storage mismatch")
    for sample in expected.get("samples", []):
        row, column = sample["coordinate"]
        actual = int(dataset[row, column])
        _require(actual == sample["value"], f"{path.name}: sample {row},{column} mismatch")
    for slice_contract in expected.get("slices", []):
        import numpy

        row_start, row_end = slice_contract["rows"]
        column_start, column_end = slice_contract["columns"]
        values = numpy.asarray(
            dataset[row_start:row_end, column_start:column_end],
            dtype="<i4",
            order="C",
        )
        digest = hashlib.sha256(values.tobytes(order="C")).hexdigest().upper()
        _require(digest == slice_contract["sha256LeI32"], f"{path.name}: slice checksum mismatch")


def _audit_hdf5_contract(path: Path, expected: dict[str, Any]) -> None:
    import h5py
    import hdf5plugin  # noqa: F401 - registers the fixture's Blosc filter for data checks.

    opens = expected.get("opensAsHdf5", True)
    try:
        handle = h5py.File(path, "r")
    except OSError:
        _require(not opens, f"{path.name}: expected a readable HDF5 container")
        return
    _require(opens, f"{path.name}: unexpectedly opened as HDF5")

    with handle:
        attributes = set(handle.attrs.keys())
        for name in expected.get("rootAttributesPresent", []):
            _require(name in attributes, f"{path.name}: missing root attribute {name}")
        for name in expected.get("rootAttributesAbsent", []):
            _require(name not in attributes, f"{path.name}: unexpected root attribute {name}")
        if "rootAttributeNames" in expected:
            _require(
                sorted(attributes) == sorted(expected["rootAttributeNames"]),
                f"{path.name}: root attribute set mismatch",
            )

        for name, kind in expected.get("rootObjects", {}).items():
            _require(_link_kind(handle, name) == kind, f"{path.name}: root object {name} is not {kind}")

        for name, samples in expected.get("axisSamples", {}).items():
            values = handle.attrs[name]
            actual = [_json_value(values[index]) for index in (0, len(values) // 2, len(values) - 1)]
            _require(actual == samples, f"{path.name}: {name} first/middle/last mismatch")
        for name, expected_values in expected.get("axisValues", {}).items():
            values = handle.attrs[name]
            actual = [_json_value(value) for value in values]
            _require(actual == expected_values, f"{path.name}: {name} values mismatch")

        intensity_contract = expected.get("intensity")
        if intensity_contract is not None:
            _require(_link_kind(handle, "intensity") == "dataset", f"{path.name}: intensity is not hard-linked")
            _audit_dataset(path, handle["intensity"], intensity_contract)


def _audit_committed_fixture(root: Path, fixture: dict[str, Any]) -> None:
    path = root / fixture["file"]
    _require(path.is_file(), f"Missing committed fixture: {path}")
    _require(path.stat().st_size == fixture["sizeBytes"], f"{path.name}: file size mismatch")
    _require(sha256_file(path) == fixture["sha256"], f"{path.name}: SHA-256 mismatch")
    _audit_hdf5_contract(path, fixture["expected"])


def _audit_reference(reference: dict[str, Any], explicit_path: Path | None) -> None:
    path = explicit_path or Path(reference["pathHint"])
    _require(path.is_file(), f"Reference fixture not found: {path}")
    _require(path.stat().st_size == reference["sizeBytes"], "Reference fixture size mismatch")
    _require(sha256_file(path) == reference["sha256"], "Reference fixture SHA-256 mismatch")
    _audit_hdf5_contract(path, reference["expected"])


def audit_manifest(
    manifest_path: Path,
    *,
    check_reference: bool,
    reference_path: Path | None = None,
) -> dict[str, Any]:
    _require(manifest_path.is_file(), f"Manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    _require(manifest.get("schemaVersion") == 1, "Unsupported Phase 10 fixture manifest version")

    current_versions = environment_versions()
    _require(current_versions == manifest["generatorEnvironment"], "Generator environment mismatch")

    fixtures = manifest.get("committedFixtures", [])
    names = [fixture.get("file") for fixture in fixtures]
    _require(len(names) == len(set(names)), "Duplicate committed fixture names in manifest")
    _require(set(names) == set(GENERATED_FIXTURE_NAMES), "Manifest/generated fixture set mismatch")

    root = manifest_path.parent
    for fixture in fixtures:
        _audit_committed_fixture(root, fixture)

    reference = manifest.get("referenceFixture")
    _require(isinstance(reference, dict) and reference.get("included") is False, "Reference must not be included")
    if check_reference:
        _audit_reference(reference, reference_path)

    opt_in = manifest.get("optInFixtures", [])
    _require(all(item.get("included") is False for item in opt_in), "Large fixtures must remain manifest-only")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit Phase 10 OES fixture hashes and HDF5 contracts.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "fixtures" / "phase-10" / "manifest.json",
    )
    parser.add_argument(
        "--reference",
        type=Path,
        help="Also audit the non-committed actual OES reference at this path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit_manifest(
        args.manifest.resolve(),
        check_reference=args.reference is not None,
        reference_path=args.reference.resolve() if args.reference else None,
    )
    scope = "committed fixtures and reference" if args.reference else "committed fixtures"
    print(f"PASS: audited {scope} from {args.manifest.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AuditFailure as error:
        raise SystemExit(f"FAIL: {error}") from error
