"""Small deterministic Phase22 inputs; golden calculations do not use DuckDB.

Requires the project's existing PyArrow environment. Writes only named test-owned files
below this script's directory. Does not read/copy application caches or generate large data.
"""
from __future__ import annotations

import csv
from decimal import Decimal
import hashlib
import io
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent


def csv_file(relative: str, headers: list[str], rows: list[list[object]]) -> None:
    destination = ROOT / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, lineterminator="\r\n")
        writer.writerow(headers)
        writer.writerows(rows)


def parquet_file(relative: str, arrays: list[pa.Array], names: list[str]) -> None:
    destination = ROOT / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_arrays(arrays, names=names), destination, compression="snappy", row_group_size=3)


def tsv(rows: list[list[object]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter="\t", lineterminator="\r\n")
    writer.writerows([["" if cell is None else str(cell) for cell in row] for row in rows])
    return output.getvalue().removesuffix("\r\n")


def main() -> None:
    headers = ["주문 번호", "고객 번호", "결제 금액", "주문 일시", '상품 "표시명"', "메모"]
    orders = [
        [101, 1, "100.10", "2026-11-06T01:02:03.123456789", "alpha", "tab\tvalue"],
        [102, 2, "200.20", "2026-11-06T01:02:03.123456790", "beta", ""],
        [103, 2, "NULL", "2026-11-06T01:02:03.123456791", "gamma", "line\nbreak"],
        [104, 3, "50.00", "2026-11-06T01:02:03.123456792", "delta", 'quote"value'],
        [105, "NULL", "25.05", "2026-11-06T01:02:03.123456793", "한글🙂", "line\r\nbreak"],
        [106, 99, "0.01", "2026-11-06T01:02:03.123456794", "omega", "literal\\nvalue"],
    ]
    csv_file("sales/orders.csv", headers, orders)
    csv_file("archive/orders.csv", headers, [[901, 4, "999.99", "2025-01-01T00:00:00.000000001", "archived", "different file"]])

    customer_rows = [[1, "Alice", "Seoul"], [2, "Bob", "Busan"], [2, "Betty", "Incheon"], [4, "Dana", "Seoul"], [None, "NoID", "Jeju"]]
    parquet_file("customers.parquet", [
        pa.array([row[0] for row in customer_rows], type=pa.int64()),
        pa.array([row[1] for row in customer_rows]),
        pa.array([row[2] for row in customer_rows]),
        pa.array([0, 1, 2, 3, 4], type=pa.date32()),
        pa.array(["a@example.invalid", "b@example.invalid", "bb@example.invalid", None, ""]),
    ], ["고객 번호", "고객명", "지역", "가입 일자", "메일"])

    duplicates = ["name", "name", "name (2)", "Name", "c1", "__dv_row_id"]
    csv_file("headers/duplicates.csv", duplicates, [["first", "second", "suffix", "case", "genuine-c1", "reserved"]])
    parquet_file("headers/duplicates.parquet", [pa.array([str(i)]) for i in range(len(duplicates))], duplicates)
    csv_file("headers/case-duplicates.csv", ["Name", "NAME", "name"], [["a", "b", "c"]])
    csv_file("headers/blank.csv", ["", " ", "valid"], [[1, 2, 3]])
    csv_file("headers/collisions.csv", ["name", "name (2)", "c1", '상품 "표시명"', "__dv_row_id"], [[1, 2, 3, 4, 5]])
    csv_file("headers/no-header.csv", ["1", "alpha", "100.00"], [[2, "beta", "200.00"]])
    long_headers = [f"field_{index + 1}" for index in range(4096)]
    # Duplicate beyond a bounded UI/header-audit preview: eligibility must inspect full source headers.
    long_headers[-1] = long_headers[0]
    csv_file("headers/late-duplicate.csv", long_headers, [list(range(4096))])
    csv_file("wide.csv", [f"원본 컬럼 {index + 1}" for index in range(4096)], [list(range(4096))])

    csv_file("typed-invalid.csv", ["id", "amount", "text", "u64", "timestamp"], [
        [1, "1.20", "", "18446744073709551615", "2026-11-06T01:02:03.123456789"],
        [2, "bad", "NULL", "9007199254740992", "not-a-time"],
        [3, "NULL", "tab\tvalue", "9007199254740993", "2026-11-06T01:02:03.123456790"],
        [4, "2.30", "line\r\nbreak", "0", "NULL"],
    ])

    parquet_file("types.parquet", [
        pa.array([-9223372036854775808, 9223372036854775807, 9007199254740992, 9007199254740993], type=pa.int64()),
        pa.array([18446744073709551615, 0, 9007199254740992, 9007199254740993], type=pa.uint64()),
        pa.array([Decimal("1234567890123456789012345678.1234567890"), Decimal("-0.0000000001"), Decimal("0"), None], type=pa.decimal128(38, 10)),
        pa.array([1767225600000000001, 1767225600000000002, None, -1], type=pa.timestamp("ns")),
        pa.array(["", None, '한글🙂\t"quote"', "line\nline"]),
    ], ["int64", "uint64", "decimal38", "timestamp_ns", "text"])
    parquet_file("temporal-extra.parquet", [
        pa.array([1767225600000000001, -1, None], type=pa.timestamp("ns", tz="UTC")),
        pa.array([1, -1, None], type=pa.duration("ns")),
    ], ["timestamp_ns_utc", "duration_ns"])
    parquet_file("nested-blob.parquet", [
        pa.array([b"\x00\xff\t", None, b""]),
        pa.array([[1, None, 3], [], None], type=pa.list_(pa.int64())),
        pa.array([{"n": 1}, {"n": None}, None], type=pa.struct([("n", pa.int64())])),
    ], ["blob", "list", "struct"])

    left = []
    window = []
    ranks: dict[int | None, int] = {}
    for order in orders:
        order_id, raw_customer, amount = order[:3]
        customer_id = None if raw_customer == "NULL" else int(raw_customer)
        decimal_amount = None if amount == "NULL" else Decimal(str(amount))
        matches = sorted([c for c in customer_rows if customer_id is not None and c[0] == customer_id], key=lambda c: c[1])
        for customer in matches or [[None, None, None]]:
            left.append([order_id, customer[1], None if decimal_amount is None else f"{decimal_amount:.2f}", customer[2]])
        ranks[customer_id] = ranks.get(customer_id, 0) + 1
        window.append([order_id, customer_id, ranks[customer_id]])
    inner = [row for row in left if row[1] is not None]
    sums: dict[str | None, Decimal] = {}
    counts: dict[str | None, int] = {}
    for row in left:
        region = row[3]
        counts[region] = counts.get(region, 0) + 1
        if row[2] is not None:
            sums[region] = sums.get(region, Decimal(0)) + Decimal(row[2])
    grouped = [[region, counts[region], f"{sums[region]:.2f}"] for region in sorted(sums, key=lambda r: (r is None, r or ""))]
    golden = {
        "description": "Independent Python integer/Decimal goldens, no DuckDB execution.",
        "ordersHeaders": headers,
        "profile": {"headerMode": "present", "nullTokens": ["NULL"], "orderIdType": "int64", "customerIdType": "int64", "amountType": "decimal(18,2)", "timestampType": "timestamp-ns", "textType": "text"},
        "innerJoin": {"rows": inner, "rowCount": len(inner), "amountSum": f"{sum((Decimal(r[2]) for r in inner if r[2] is not None), Decimal(0)):.2f}"},
        "leftJoin": {"rows": left, "rowCount": len(left), "amountSum": f"{sum((Decimal(r[2]) for r in left if r[2] is not None), Decimal(0)):.2f}"},
        "groupedLeftJoin": grouped,
        "rowNumberByCustomer": window,
        "leftJoinTsv": tsv([["order_id", "customer_name", "amount", "region"], *left]),
        "duplicateResultLabels": {"headers": ["same", "same"], "ids": ["r0", "r1"], "rows": [["first", "second"]], "tsv": "same\tsame\r\nfirst\tsecond"},
        "typedInvalid": {"amountSum": "3.50", "amountCount": 2, "amountInvalidCount": 1, "timestampInvalidCount": 1},
        "exactScalars": {"int64": ["-9223372036854775808", "9223372036854775807", "9007199254740992", "9007199254740993"], "uint64": ["18446744073709551615", "0", "9007199254740992", "9007199254740993"], "decimal38": ["1234567890123456789012345678.1234567890", "-0.0000000001", "0.0000000000", None], "timestampNs": ["1767225600000000001", "1767225600000000002", None, "-1"]},
    }
    (ROOT / "golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = []
    for name in ["sales/orders.csv", "archive/orders.csv", "customers.parquet", "headers/duplicates.csv", "headers/duplicates.parquet", "headers/case-duplicates.csv", "headers/blank.csv", "headers/collisions.csv", "headers/no-header.csv", "headers/late-duplicate.csv", "wide.csv", "typed-invalid.csv", "types.parquet", "temporal-extra.parquet", "nested-blob.parquet", "golden.json"]:
        data = (ROOT / name).read_bytes()
        manifest.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (ROOT / "manifest.json").write_text(json.dumps({"generator": "generate.py", "pyarrow": pa.__version__, "files": manifest}, indent=2) + "\n", encoding="utf-8")
    assert len(inner) == 5 and len(left) == 8
    assert golden["innerJoin"]["amountSum"] == "500.50"
    assert golden["leftJoin"]["amountSum"] == "575.56"
    assert sum(counts.values()) == 8
    print(json.dumps({"status": "PASS", "fixtureCount": len(manifest), "bytes": sum(f["bytes"] for f in manifest), "innerRows": len(inner), "leftRows": len(left), "pyarrow": pa.__version__}))


if __name__ == "__main__":
    main()
