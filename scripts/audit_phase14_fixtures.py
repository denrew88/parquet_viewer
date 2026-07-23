"""Audit Phase 14 small CSV oracles and the reused Phase 13 5.85M fixture identities."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = Path("artifacts/phase-14/fixture-manifest.json")
DEFAULT_OUTPUT = Path("artifacts/phase-14/fixture-audit.json")
STATE_CODES = {"valid": 0, "null": 1, "empty": 2, "invalid": 3}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def resolve_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO_ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def classify(raw: str, kind: str, null_token: str) -> tuple[str, Any]:
    if raw == "":
        return "empty", None
    if raw == null_token:
        return "null", None
    if kind == "text":
        return "valid", raw
    try:
        if kind in {"int64", "uint64"}:
            require(bool(re.fullmatch(r"[+-]?\d+", raw)), "not an integer literal")
            value = int(raw, 10)
            low, high = (-(2**63), 2**63 - 1) if kind == "int64" else (0, 2**64 - 1)
            require(low <= value <= high, "integer overflow")
            return "valid", str(value)
        if kind == "boolean":
            value = raw.casefold()
            require(value in {"true", "false"}, "invalid boolean")
            return "valid", value == "true"
        if kind == "decimal":
            value = Decimal(raw)
            require(value.is_finite(), "non-finite decimal")
            return "valid", format(value, "f")
        if kind == "date":
            datetime.strptime(raw, "%Y-%m-%d")
            return "valid", raw
        if kind == "timestamp":
            require(
                bool(
                    re.fullmatch(
                        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?",
                        raw,
                    )
                ),
                "invalid timestamp",
            )
            return "valid", raw
        if kind == "duration_ns":
            require(bool(re.fullmatch(r"[+-]?\d+", raw)), "invalid duration")
            value = int(raw, 10)
            require(-(2**63) <= value <= 2**63 - 1, "duration overflow")
            return "valid", str(value)
    except (InvalidOperation, RuntimeError, ValueError):
        return "invalid", None
    raise RuntimeError(f"unsupported kind {kind}")


def pack_states(columns: list[str], states: list[dict[str, str]]) -> str:
    payload = bytearray((len(columns) * len(states) * 2 + 7) // 8)
    index = 0
    for column in columns:
        for row in states:
            payload[index // 4] |= STATE_CODES[row[column]] << ((index % 4) * 2)
            index += 1
    return payload.hex()


def audit_state_matrix(entry: dict[str, Any]) -> dict[str, Any]:
    path = resolve_path(entry["path"])
    oracle = load_json(resolve_path(entry["oraclePath"]))
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        raw_rows = list(reader)
    columns = oracle["columnOrder"]
    require(reader.fieldnames == columns, "state matrix column order mismatch")
    require(len(raw_rows) == entry["rows"], "state matrix row count mismatch")
    states: list[dict[str, str]] = []
    for row_index, (raw_row, expected_row) in enumerate(zip(raw_rows, oracle["rows"], strict=True)):
        row_states: dict[str, str] = {}
        for column in columns:
            state, typed = classify(
                raw_row[column], oracle["profileKinds"][column], oracle["nullToken"]
            )
            expected = expected_row["cells"][column]
            require(raw_row[column] == expected["raw"], f"state raw mismatch row={row_index} column={column}")
            require(state == expected["state"], f"state mismatch row={row_index} column={column}")
            require(typed == expected["typed"], f"typed mismatch row={row_index} column={column}")
            row_states[column] = state
        states.append(row_states)
    bitmap_hex = pack_states(columns, states)
    require(bitmap_hex == oracle["bitmapHex"], "independent 2-bit bitmap mismatch")
    require(
        len(bytes.fromhex(bitmap_hex)) == (len(columns) * len(raw_rows) * 2 + 7) // 8,
        "2-bit payload length mismatch",
    )
    return {"id": entry["id"], "result": "PASS", "rows": len(raw_rows), "bitmapHex": bitmap_hex}


def logical_record_starts(payload: bytes) -> list[int]:
    starts = [0]
    quoted = False
    index = 0
    while index < len(payload):
        byte = payload[index]
        if byte == 0x22:
            if quoted and index + 1 < len(payload) and payload[index + 1] == 0x22:
                index += 2
                continue
            quoted = not quoted
        elif byte == 0x0A and not quoted and index + 1 < len(payload):
            starts.append(index + 1)
        index += 1
    require(not quoted, "checkpoint CSV ended inside a quoted field")
    return starts


def audit_checkpoint(entry: dict[str, Any]) -> dict[str, Any]:
    path = resolve_path(entry["path"])
    oracle = load_json(resolve_path(entry["oraclePath"]))
    payload = path.read_bytes()
    starts_with_header = logical_record_starts(payload)
    data_starts = starts_with_header[1:]
    require(len(data_starts) == oracle["rows"], "checkpoint logical row count mismatch")
    for row_text, expected in oracle["recordStartBytes"].items():
        row = int(row_text)
        require(data_starts[row] == expected, f"checkpoint byte mismatch at row {row}")
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.reader(stream)
        header = next(reader)
        rows = list(reader)
    require(header == ["row_id", "payload", "optional_value"], "checkpoint header mismatch")
    require(len(rows) == oracle["rows"], "checkpoint parsed row count mismatch")
    for row in oracle["quotedMultilineRows"]:
        require("\n" in rows[row][1], f"quoted newline missing at row {row}")
    require(rows[-1] == oracle["lastRow"], "checkpoint last row mismatch")
    return {
        "id": entry["id"],
        "result": "PASS",
        "rows": len(rows),
        "logicalRecordStarts": len(data_starts),
        "checkedOffsets": len(oracle["recordStartBytes"]),
    }


def audit_typed_raw(entry: dict[str, Any]) -> dict[str, Any]:
    path = resolve_path(entry["path"])
    oracle = load_json(resolve_path(entry["oraclePath"]))
    with path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        raw_rows = list(reader)
    columns = oracle["columnOrder"]
    require(reader.fieldnames == columns, "typed/raw column order mismatch")
    require(len(raw_rows) == len(oracle["rows"]), "typed/raw row count mismatch")
    for row_index, (raw_row, expected_row) in enumerate(zip(raw_rows, oracle["rows"], strict=True)):
        for column in columns:
            state, typed = classify(
                raw_row[column], oracle["profileKinds"][column], oracle["nullToken"]
            )
            expected = expected_row["cells"][column]
            require(raw_row[column] == expected["raw"], f"raw mismatch row={row_index} column={column}")
            require(state == expected["state"], f"typed state mismatch row={row_index} column={column}")
            require(typed == expected["typed"], f"typed value mismatch row={row_index} column={column}")
            if column == "timestamp" and state == "valid":
                display = raw_row[column].replace("T", " ")
                display = re.sub(r"(?:Z|[+-]\d{2}:\d{2})$", "", display)
                require(display == expected["defaultCopy"], "timestamp default copy mismatch")
            require(expected["rawCopy"] == raw_row[column], "raw copy lexeme mismatch")
    require(oracle["rows"][0]["cells"]["int64"]["typed"] == str(-(2**63)), "i64 min missing")
    require(oracle["rows"][0]["cells"]["uint64"]["typed"] == str(2**64 - 1), "u64 max missing")
    require(oracle["rows"][1]["cells"]["int64"]["raw"] == "001", "leading zero raw lexeme missing")
    require(oracle["rows"][4]["cells"]["text"]["state"] == "valid", "text must remain valid")
    return {"id": entry["id"], "result": "PASS", "rows": len(raw_rows), "columns": len(columns)}


def audit_file_identity(entry: dict[str, Any], *, verify_hash: bool) -> dict[str, Any]:
    path = resolve_path(entry["path"])
    require(path.is_file(), f"missing fixture {path}")
    require(path.stat().st_size == entry["bytes"], f"size mismatch for {entry['id']}")
    actual_hash = sha256_file(path) if verify_hash else None
    if verify_hash:
        require(actual_hash == entry["sha256"], f"sha256 mismatch for {entry['id']}")
    return {
        "id": entry["id"],
        "result": "PASS" if verify_hash else "PASS_WITH_HASH_SKIPPED",
        "bytes": path.stat().st_size,
        "sha256": actual_hash,
        "source": entry["source"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--skip-large-hash",
        action="store_true",
        help="development-only: verify referenced large file size but not its full SHA-256",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest if args.manifest.is_absolute() else REPO_ROOT / args.manifest
    output_path = args.output if args.output.is_absolute() else REPO_ROOT / args.output
    manifest = load_json(manifest_path)
    require(manifest["schemaVersion"] == 1, "unsupported Phase 14 manifest schema")
    entries = {entry["id"]: entry for entry in manifest["fixtures"]}
    results: list[dict[str, Any]] = []
    for entry in entries.values():
        results.append(
            audit_file_identity(
                entry,
                verify_hash=entry["source"] != "phase13-reference" or not args.skip_large_hash,
            )
        )
    results.extend(
        [
            audit_state_matrix(entries["csv-state-matrix"]),
            audit_checkpoint(entries["csv-checkpoint-boundaries"]),
            audit_typed_raw(entries["csv-typed-raw"]),
        ]
    )
    phase13_manifest = load_json(REPO_ROOT / "artifacts/phase-13/fixture-manifest.json")
    phase13_entries = {entry["id"]: entry for entry in phase13_manifest["fixtures"]}
    for fixture_id in ("csv-5850000-low", "csv-5850000-high", "csv-5850000-long-invalid"):
        current = entries[fixture_id]
        original = phase13_entries[fixture_id]
        require(current["sha256"] == original["sha256"], f"Phase 13 hash reference changed for {fixture_id}")
        require(current["bytes"] == original["bytes"], f"Phase 13 size reference changed for {fixture_id}")
        require(current["path"] == Path(original["path"]).resolve().relative_to(REPO_ROOT.resolve()).as_posix(), f"Phase 13 path reference changed for {fixture_id}")

    status = "PASS" if not args.skip_large_hash else "PASS_WITH_LARGE_HASH_SKIPPED"
    report = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "manifest": manifest_path.resolve().relative_to(REPO_ROOT.resolve()).as_posix(),
        "manifestSha256": sha256_file(manifest_path),
        "largeHashesVerified": not args.skip_large_hash,
        "results": results,
        "summary": {"status": status, "checks": len(results), "failures": 0},
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"audit": str(output_path), "status": status, "checks": len(results)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - command-line audit must emit a compact terminal reason
        print(json.dumps({"status": "FAIL", "error": str(error)}))
        raise SystemExit(1) from error
