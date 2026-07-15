"""Generate deterministic, small Phase 9 CSV and Parquet fixtures."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import tempfile
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError as error:  # pragma: no cover - exercised only in an incomplete toolchain
    raise SystemExit(
        "pyarrow is required to generate Phase 9 Parquet fixtures. "
        "Install it in the fixture-generation environment before retrying."
    ) from error


SEED = 20260715
REVISION = "phase9-small-fixtures-v1"
LOGICAL_ROOT = Path("fixtures/phase-9")
NULL_TOKEN = "NULL"
WIDE_COLUMNS = 256
WIDE_ROWS = 16
GENERATED_FILE_NAMES = {
    "profile-ambiguous.csv",
    "profile-invalid.csv",
    "profile-wide.csv",
    "query-small.csv",
    "query-small.parquet",
    "valid-zero-row.parquet",
    "zero-byte.parquet",
}

QUERY_SCHEMA = pa.schema(
    [
        pa.field("row_id", pa.int64(), nullable=False),
        pa.field("category", pa.string(), nullable=False),
        pa.field("group_id", pa.int64(), nullable=False),
        pa.field("active", pa.bool_(), nullable=False),
        pa.field("optional_value", pa.int64(), nullable=True),
        pa.field("event_time", pa.timestamp("ms", tz="UTC"), nullable=False),
        pa.field("amount", pa.decimal128(12, 2), nullable=False),
        pa.field("label", pa.string(), nullable=False),
    ]
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (datetime, date)):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, dict):
        return {key: json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


def arrow_schema_json(schema: pa.Schema) -> list[dict[str, Any]]:
    return [
        {"name": field.name, "type": str(field.type), "nullable": field.nullable}
        for field in schema
    ]


def write_csv(path: Path, columns: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
        writer.writerow(columns)
        writer.writerows(rows)


def csv_details(
    path: Path, rows: int, columns: list[str], expected: dict[str, Any]
) -> dict[str, Any]:
    expected_types = expected.get("configuredTypes", expected.get("recommendedTypes", {}))
    return {
        "path": (LOGICAL_ROOT / path.name).as_posix(),
        "format": "csv",
        "rows": rows,
        "columns": len(columns),
        "columnNames": columns,
        "schema": [
            {"name": column, "expectedType": expected_types.get(column, "Text")}
            for column in columns
        ],
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "expected": expected,
    }


def parquet_details(path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    parquet_file = pq.ParquetFile(path)
    metadata = parquet_file.metadata
    return {
        "path": (LOGICAL_ROOT / path.name).as_posix(),
        "format": "parquet",
        "rows": metadata.num_rows,
        "columns": metadata.num_columns,
        "rowGroups": metadata.num_row_groups,
        "schema": arrow_schema_json(parquet_file.schema_arrow),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "expected": expected,
    }


def generate_profile_ambiguous(output: Path) -> dict[str, Any]:
    columns = [
        "leading_zero_id",
        "huge_unsigned",
        "signed_int",
        "mixed_numeric",
        "precise_decimal",
        "mixed_date",
        "event_time",
        "boolean_token",
        "free_text",
    ]
    rows = [
        ["00001", "18446744073709551615", "-9223372036854775808", "1", "0.10", "2026-01-02", "2026-01-02T03:04:05Z", "true", "alpha"],
        ["00002", "0", "9223372036854775807", "2", "123456789.01", "03/02/2026", "2026-02-03T04:05:06Z", "false", "beta"],
        ["00100", "42", "-1", "3.5", "-0.01", "20260304", "2026-03-04T05:06:07Z", "TRUE", "gamma"],
        ["01000", "9007199254740993", "0", "4", "9999999999.99", "2026-04-05", "2026-04-05T06:07:08.123Z", "FALSE", "delta"],
        ["10000", "17", "17", "not-a-number", "12.34", "06/05/2026", "2026-05-06T07:08:09+00:00", "yes", "epsilon"],
        ["00000", "999", "-999", "6", "0.00", "20260607", "2026-06-07T08:09:10Z", "no", "zeta"],
        ["00420", "12345678901234567890", "123", "7", "7.000", "2026-07-08", "2026-07-08T09:10:11Z", "1", "한글"],
        ["00007", "7", "-7", "8", "8.25", "09/08/2026", "2026-08-09T10:11:12Z", "0", "quoted, value"],
        ["00008", "8", "8", "9", "9.50", "20260910", "2026-09-10T11:12:13Z", "true", "line one\nline two"],
        ["00009", NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, "literal NULL stays text"],
        ["00010", "10", "10", "10", "10.00", "2026-10-11", "2026-10-11T12:13:14Z", "false", ""],
        ["00011", "11", "11", "11", "11.11", "12/11/2026", "2026-11-12T13:14:15Z", "TRUE", "omega"],
    ]
    expected_types = {
        "leading_zero_id": "Text",
        "huge_unsigned": "UInt64",
        "signed_int": "Int64",
        "mixed_numeric": "Text",
        "precise_decimal": "Decimal",
        "mixed_date": "Date",
        "event_time": "Timestamp",
        "boolean_token": "Boolean",
        "free_text": "Text",
    }
    expected = {
        "nullTokens": [NULL_TOKEN],
        "recommendedTypes": expected_types,
        "confidence": {
            "leading_zero_id": "conservative-text",
            "mixed_numeric": "mixed-values-text",
            "mixed_date": "multi-format",
        },
        "acceptedDateFormats": ["%Y-%m-%d", "%d/%m/%Y", "%Y%m%d"],
        "precisionStrings": ["18446744073709551615", "12345678901234567890", "123456789.01"],
    }
    path = output / "profile-ambiguous.csv"
    write_csv(path, columns, rows)
    return csv_details(path, len(rows), columns, expected)


def generate_profile_invalid(output: Path) -> dict[str, Any]:
    columns = ["boolean_value", "int64_value", "uint64_value", "float64_value", "decimal_value", "date_value", "timestamp_value", "text_value"]
    rows = [
        ["true", "0", "0", "0.0", "0.00", "2026-01-01", "2026-01-01T00:00:00Z", "alpha"],
        ["maybe", "12.5", "-1", "not-a-float", "12.3.4", "2026-02-30", "2026-01-01T25:00:00Z", "invalid row"],
        ["false", "9223372036854775808", "18446744073709551616", "1.5", "1.25", "not-a-date", "not-a-timestamp", "bounds"],
        [NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, NULL_TOKEN, "null tokens"],
        ["1", "-9223372036854775808", "18446744073709551615", "-1.25e3", "-999999.99", "2024-02-29", "2024-02-29T23:59:59.999Z", "valid limits"],
        ["0", "9223372036854775807", "42", "3.141592653589793", "123456789.01", "2026-12-31", "2026-12-31T23:59:59+00:00", "valid max"],
        ["TRUE", "+17", "+17", "+2.5", "+2.50", "2026-06-15", "2026-06-15T10:30:00Z", "explicit plus"],
        ["FALSE", " 7 ", " 7 ", " 7.0 ", " 7.00 ", " 2026-07-01 ", " 2026-07-01T01:02:03Z ", "trimmed"],
    ]
    configured_types = {
        "boolean_value": "Boolean",
        "int64_value": "Int64",
        "uint64_value": "UInt64",
        "float64_value": "Float64",
        "decimal_value": "Decimal",
        "date_value": "Date",
        "timestamp_value": "Timestamp",
        "text_value": "Text",
    }
    expected = {
        "rowIndexBase": 0,
        "trim": True,
        "nullTokens": [NULL_TOKEN],
        "configuredTypes": configured_types,
        "invalidRows": {
            "boolean_value": [1],
            "int64_value": [1, 2],
            "uint64_value": [1, 2],
            "float64_value": [1],
            "decimal_value": [1],
            "date_value": [1, 2],
            "timestamp_value": [1, 2],
            "text_value": [],
        },
        "nullRows": {column: [3] for column in columns[:-1]},
    }
    path = output / "profile-invalid.csv"
    write_csv(path, columns, rows)
    return csv_details(path, len(rows), columns, expected)


def wide_value(row: int, column: int, value_type: str) -> str:
    if (row + column + SEED) % 37 == 0:
        return NULL_TOKEN
    if value_type == "Text":
        return f"text-{row:02d}-{column:03d}"
    if value_type == "Int64":
        return str((row - 8) * (column + 1))
    if value_type == "UInt64":
        return str(row * 1_000_000 + column)
    if value_type == "Float64":
        return f"{(row + 1) * (column + 1) / 7:.6f}"
    if value_type == "Decimal":
        return f"{(row - 4) * (column + 1) / 100:.2f}"
    if value_type == "Boolean":
        return "true" if (row + column) % 2 == 0 else "false"
    if value_type == "Date":
        return (date(2026, 1, 1) + timedelta(days=row + column)).isoformat()
    if value_type == "Timestamp":
        value = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=row * 3 + column)
        return value.isoformat().replace("+00:00", "Z")
    raise ValueError(value_type)


def generate_profile_wide(output: Path) -> dict[str, Any]:
    pattern = ["Text", "Int64", "Float64", "Boolean", "Decimal", "Date", "Timestamp", "UInt64"]
    expected_types = [pattern[index % len(pattern)] for index in range(WIDE_COLUMNS)]
    columns = [f"column_{index:03d}_{expected_types[index].lower()}" for index in range(WIDE_COLUMNS)]
    rows = [
        [wide_value(row, column, expected_types[column]) for column in range(WIDE_COLUMNS)]
        for row in range(WIDE_ROWS)
    ]
    expected = {
        "nullTokens": [NULL_TOKEN],
        "boundedRows": WIDE_ROWS,
        "typePattern": pattern,
        "recommendedTypes": dict(zip(columns, expected_types, strict=True)),
        "selectionCases": {
            "firstRange": columns[:32],
            "filteredDateColumns": [
                column for column, value_type in zip(columns, expected_types, strict=True) if value_type == "Date"
            ],
        },
    }
    path = output / "profile-wide.csv"
    write_csv(path, columns, rows)
    return csv_details(path, len(rows), columns, expected)


def query_rows() -> list[dict[str, Any]]:
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    categories = ["alpha", "beta", "gamma", "beta"]
    rows: list[dict[str, Any]] = []
    for index in range(24):
        cents = ((index * 37 + SEED) % 1000) - 300
        rows.append(
            {
                "row_id": index,
                "category": categories[index % len(categories)],
                "group_id": (index * 7 + SEED) % 5,
                "active": index % 3 != 0,
                "optional_value": None if index % 5 == 0 else ((index * 13) % 17) - 8,
                "event_time": base + timedelta(hours=index * 3),
                "amount": (Decimal(cents) / Decimal(100)).quantize(Decimal("0.01")),
                "label": f"needle-item-{index:02d}" if index in {2, 7, 19} else f"item-{index:02d}",
            }
        )
    return rows


def query_csv_value(value: Any) -> str:
    if value is None:
        return NULL_TOKEN
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def read_typed_query_csv(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", newline="") as stream:
        for raw in csv.DictReader(stream):
            rows.append(
                {
                    "row_id": int(raw["row_id"]),
                    "category": raw["category"],
                    "group_id": int(raw["group_id"]),
                    "active": raw["active"].lower() == "true",
                    "optional_value": (
                        None if raw["optional_value"] == NULL_TOKEN else int(raw["optional_value"])
                    ),
                    "event_time": datetime.fromisoformat(
                        raw["event_time"].replace("Z", "+00:00")
                    ),
                    "amount": Decimal(raw["amount"]),
                    "label": raw["label"],
                }
            )
    return rows


def row_ids(rows: list[dict[str, Any]]) -> list[int]:
    return [int(row["row_id"]) for row in rows]


def query_case(
    query_id: str,
    plan: dict[str, Any],
    rows: list[dict[str, Any]],
    operation: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
) -> dict[str, Any]:
    result = row_ids(operation(rows))
    return {"id": query_id, "plan": plan, "rowIds": result, "rowIdChecksum": sha256_json(result)}


def expected_query_cases(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        query_case(
            "category-beta",
            {"filter": {"column": "category", "operator": "equals", "value": "beta"}},
            rows,
            lambda values: [row for row in values if row["category"] == "beta"],
        ),
        query_case(
            "label-contains-needle",
            {"search": {"columns": ["label"], "mode": "contains", "value": "needle"}},
            rows,
            lambda values: [row for row in values if "needle" in row["label"]],
        ),
        query_case(
            "combined-filter-stable-sort",
            {
                "filter": {"active": True, "categoryIn": ["beta", "gamma"]},
                "sort": [
                    {"column": "group_id", "direction": "asc"},
                    {"column": "amount", "direction": "desc"},
                    {"column": "row_id", "direction": "asc", "stableIdentity": True},
                ],
            },
            rows,
            lambda values: sorted(
                [row for row in values if row["active"] and row["category"] in {"beta", "gamma"}],
                key=lambda row: (row["group_id"], -row["amount"], row["row_id"]),
            ),
        ),
        query_case(
            "optional-ascending-nulls-last",
            {
                "sort": [
                    {"column": "optional_value", "direction": "asc", "nulls": "last"},
                    {"column": "row_id", "direction": "asc", "stableIdentity": True},
                ]
            },
            rows,
            lambda values: sorted(
                values,
                key=lambda row: (
                    row["optional_value"] is None,
                    row["optional_value"] if row["optional_value"] is not None else 0,
                    row["row_id"],
                ),
            ),
        ),
    ]


def generate_query_pair(output: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    rows = query_rows()
    columns = QUERY_SCHEMA.names
    csv_path = output / "query-small.csv"
    write_csv(csv_path, columns, [[query_csv_value(row[column]) for column in columns] for row in rows])

    table = pa.Table.from_pylist(rows, schema=QUERY_SCHEMA)
    parquet_path = output / "query-small.parquet"
    pq.write_table(
        table,
        parquet_path,
        row_group_size=8,
        compression="zstd",
        compression_level=3,
        use_dictionary=False,
        write_statistics=True,
        data_page_version="2.0",
    )
    typed_rows = json_value(rows)
    logical_checksum = sha256_json({"schema": arrow_schema_json(QUERY_SCHEMA), "rows": typed_rows})
    queries = expected_query_cases(rows)
    expected_types = {
        "row_id": "Int64",
        "category": "Text",
        "group_id": "Int64",
        "active": "Boolean",
        "optional_value": "Int64",
        "event_time": "Timestamp",
        "amount": "Decimal",
        "label": "Text",
    }
    shared_expected = {
        "nullTokens": [NULL_TOKEN],
        "typedSchema": arrow_schema_json(QUERY_SCHEMA),
        "configuredTypes": expected_types,
        "logicalChecksum": logical_checksum,
        "queries": queries,
    }
    csv_fixture = csv_details(csv_path, len(rows), columns, shared_expected)
    parquet_fixture = parquet_details(parquet_path, shared_expected)
    if read_typed_query_csv(csv_path) != rows:
        raise AssertionError("query-small CSV typed round-trip changed logical rows")
    if pq.read_table(parquet_path).to_pylist() != table.to_pylist():
        raise AssertionError("query-small Parquet round-trip changed logical rows")
    return csv_fixture, parquet_fixture


def generate_zero_row_and_corrupt(output: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    valid_path = output / "valid-zero-row.parquet"
    empty_table = pa.Table.from_arrays(
        [pa.array([], type=field.type) for field in QUERY_SCHEMA], schema=QUERY_SCHEMA
    )
    pq.write_table(
        empty_table,
        valid_path,
        compression="zstd",
        compression_level=3,
        use_dictionary=False,
        write_statistics=True,
        data_page_version="2.0",
    )
    valid = parquet_details(
        valid_path,
        {"outcome": "accepted", "firstPageRows": 0, "schemaPreserved": True},
    )
    corrupt_path = output / "zero-byte.parquet"
    corrupt_path.write_bytes(b"")
    corrupt = {
        "path": (LOGICAL_ROOT / corrupt_path.name).as_posix(),
        "format": "parquet",
        "rows": None,
        "columns": None,
        "bytes": 0,
        "sha256": sha256_file(corrupt_path),
        "expected": {"outcome": "rejected", "errorCategory": "InvalidParquet", "panic": False},
    }
    return valid, corrupt


def generate(output: Path, manifest_path: Path) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    expected_names = GENERATED_FILE_NAMES | {manifest_path.name}
    for existing in output.iterdir():
        if existing.is_file() and existing.name not in expected_names:
            raise RuntimeError(f"unexpected file in fixture directory: {existing}")

    fixtures = [
        generate_profile_ambiguous(output),
        generate_profile_invalid(output),
        generate_profile_wide(output),
    ]
    fixtures.extend(generate_query_pair(output))
    fixtures.extend(generate_zero_row_and_corrupt(output))
    fixtures.sort(key=lambda fixture: fixture["path"])

    manifest = {
        "schemaVersion": 1,
        "generatorRevision": REVISION,
        "seed": SEED,
        "toolchain": {"pyarrow": pa.__version__},
        "csvDialect": {
            "encoding": "UTF-8",
            "delimiter": ",",
            "quote": '"',
            "lineTerminator": "LF",
            "header": True,
            "nullTokens": [NULL_TOKEN],
        },
        "fixtures": fixtures,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest


def verify_determinism(output: Path, manifest_path: Path) -> None:
    expected_bytes = {
        path.name: path.read_bytes() for path in sorted(output.iterdir()) if path.is_file()
    }
    with tempfile.TemporaryDirectory(prefix="phase9-fixtures-") as temporary:
        check_output = Path(temporary) / "phase-9"
        check_manifest = check_output / manifest_path.name
        generate(check_output, check_manifest)
        actual_bytes = {
            path.name: path.read_bytes() for path in sorted(check_output.iterdir()) if path.is_file()
        }
    if expected_bytes.keys() != actual_bytes.keys():
        raise AssertionError("determinism check generated a different file set")
    mismatches = [name for name in expected_bytes if expected_bytes[name] != actual_bytes[name]]
    if mismatches:
        raise AssertionError(f"determinism check failed for: {', '.join(mismatches)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=LOGICAL_ROOT)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--verify-determinism", action="store_true")
    args = parser.parse_args()

    output = args.output
    manifest = args.manifest or output / "manifest.json"
    if args.clean:
        for name in GENERATED_FILE_NAMES:
            (output / name).unlink(missing_ok=True)
        manifest.unlink(missing_ok=True)
    generated = generate(output, manifest)
    if args.verify_determinism:
        verify_determinism(output, manifest)
    print(
        json.dumps(
            {
                "output": str(output),
                "manifest": str(manifest),
                "fixtures": len(generated["fixtures"]),
                "determinismVerified": args.verify_determinism,
                "manifestSha256": sha256_file(manifest),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
