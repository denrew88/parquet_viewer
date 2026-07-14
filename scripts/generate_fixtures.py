from __future__ import annotations

from pathlib import Path
from decimal import Decimal
import csv
import json

import pyarrow as pa
import pyarrow.parquet as pq


def main() -> None:
    fixtures = Path(__file__).resolve().parents[1] / "fixtures"
    root = fixtures / "phase-1"
    root.mkdir(parents=True, exist_ok=True)

    table = pa.table(
        {
            "id": pa.array([1, 2, 3, 4], type=pa.int32()),
            "label": pa.array(["alpha", None, "", "omega"], type=pa.string()),
            "score": pa.array([1.5, -2.25, None, 0.0], type=pa.float64()),
            "enabled": pa.array([True, False, None, True], type=pa.bool_()),
        }
    )
    pq.write_table(table, root / "primitive-null.parquet", row_group_size=2)
    (root / "corrupt.parquet").write_bytes(b"PAR1brokenPAR1")

    phase2 = fixtures / "phase-2"
    phase2.mkdir(parents=True, exist_ok=True)
    count = 240
    large = pa.table(
        {
            "id": pa.array([9_007_199_254_740_992 + index for index in range(count)], type=pa.int64()),
            "label": pa.array([f"row-{index:03}" for index in range(count)]),
            "amount": pa.array(
                [Decimal(f"{index}.{index % 1_000:03}000000") for index in range(count)],
                type=pa.decimal128(20, 9),
            ),
            "event_time": pa.array(
                [1_767_225_600_000_000_000 + index for index in range(count)],
                type=pa.timestamp("ns", tz="UTC"),
            ),
            "payload": pa.array([bytes([index % 256, 0, 255]) for index in range(count)], type=pa.binary()),
            "tags": pa.array([[index, None, index + 1] for index in range(count)], type=pa.list_(pa.int64())),
        }
    )
    pq.write_table(large, phase2 / "large-types.parquet", row_group_size=80, compression="snappy")

    phase3 = fixtures / "phase-3"
    phase3.mkdir(parents=True, exist_ok=True)
    (phase3 / "header.csv").write_text(
        "name,age,city\r\nAlice,30,Seoul\r\nBob,41,Busan\r\nCarol,27,Incheon\r\n",
        encoding="utf-8",
        newline="",
    )
    (phase3 / "no-header.csv").write_text(
        "1,Alice,Seoul\n2,Bob,Busan\n3,Carol,Incheon\n",
        encoding="utf-8",
        newline="",
    )
    (phase3 / "bom-korean.csv").write_bytes(
        b"\xef\xbb\xbf" + "이름,도시\r\n가나다,서울\r\n라마바,부산\r\n".encode("utf-8")
    )
    with (phase3 / "quoted.csv").open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, lineterminator="\r\n")
        writer.writerow(["id", "note", "empty"])
        writer.writerow(["1", "comma, value", ""])
        writer.writerow(["2", "line1\nline2 and \"quote\"", ""])
    (phase3 / "empty.csv").write_bytes(b"")
    (phase3 / "empty-fields.csv").write_bytes(b"a,b,c\r\n1,,\r\n2,x,\r\n")
    (phase3 / "invalid-utf8.csv").write_bytes(b"name\nvalid\n\xff\n")
    (phase3 / "utf16le.csv").write_bytes("name\r\nvalue\r\n".encode("utf-16"))
    (phase3 / "inconsistent.csv").write_text(
        "a,b,c\n1,2\n3,4,5,6\n7,8,9\n", encoding="utf-8", newline=""
    )
    (phase3 / "large-20000.csv").write_text(
        "row_id,label\n"
        + "".join(f"{row},row-{row:05}\n" for row in range(20_000)),
        encoding="utf-8",
        newline="",
    )
    with (phase3 / "native-450.csv").open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.writer(output, lineterminator="\r\n")
        writer.writerow(["row_id", "이름", "note", "empty"])
        for row in range(450):
            writer.writerow([row, f"행-{row}", f"line {row}\ncontinued" if row % 50 == 0 else f"value, {row}", ""])
    max_record_bytes = 8 * 1024 * 1024
    for suffix, size in (("minus-one", max_record_bytes - 1), ("exact", max_record_bytes), ("plus-one", max_record_bytes + 1)):
        (phase3 / f"record-boundary-{suffix}.csv").write_bytes(b"x" * size)
    max_columns = 4_096
    for suffix, count in (("minus-one", max_columns - 1), ("exact", max_columns), ("plus-one", max_columns + 1)):
        (phase3 / f"column-boundary-{suffix}.csv").write_text(
            ",".join("x" for _ in range(count)), encoding="utf-8", newline=""
        )
    (phase3 / "ambiguous-header.csv").write_text(
        "alpha,beta\ngamma,delta\n", encoding="utf-8", newline=""
    )
    long_header = "z" * 300
    (phase3 / "header-audit.csv").write_text(
        f"name,,name,{long_header}\nA,B,C,D\n", encoding="utf-8", newline=""
    )
    background_failure = b"".join(f"{row},valid\n".encode() for row in range(250)) + b"250,\xff\n"
    (phase3 / "background-failure.csv").write_bytes(background_failure)
    (phase3 / "checkpoint-compaction.json").write_text(
        json.dumps(
            {
                "checkpointInterval": 4096,
                "maxCheckpoints": 4096,
                "syntheticCandidates": 16384,
                "expectedCompaction": True,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    golden = [
        {"file": "header.csv", "headerMode": "auto", "state": "complete", "rowCount": 3, "columnCount": 3, "columnNames": ["name", "age", "city"], "firstRow": ["Alice", "30", "Seoul"], "suggestedHeader": True, "headerUsed": True, "structureIssueCount": 0},
        {"file": "no-header.csv", "headerMode": "absent", "state": "complete", "rowCount": 3, "columnCount": 3, "columnNames": ["Column 1", "Column 2", "Column 3"], "firstRow": ["1", "Alice", "Seoul"], "suggestedHeader": False, "headerUsed": False, "structureIssueCount": 0},
        {"file": "bom-korean.csv", "headerMode": "present", "state": "complete", "rowCount": 2, "columnCount": 2, "columnNames": ["이름", "도시"], "firstRow": ["가나다", "서울"], "headerUsed": True, "structureIssueCount": 0},
        {"file": "quoted.csv", "headerMode": "present", "state": "complete", "rowCount": 2, "columnCount": 3, "columnNames": ["id", "note", "empty"], "firstRow": ["1", "comma, value", ""], "headerUsed": True, "structureIssueCount": 0},
        {"file": "empty.csv", "headerMode": "auto", "state": "complete", "rowCount": 0, "columnCount": 0, "columnNames": [], "firstRow": [], "headerUsed": False, "structureIssueCount": 0},
        {"file": "empty-fields.csv", "headerMode": "present", "state": "complete", "rowCount": 2, "columnCount": 3, "columnNames": ["a", "b", "c"], "firstRow": ["1", "", ""], "headerUsed": True, "structureIssueCount": 0},
        {"file": "inconsistent.csv", "headerMode": "present", "state": "complete", "rowCount": 3, "columnCount": 4, "columnNames": ["a", "b", "c", "Column 4"], "firstRow": ["1", "2", "", ""], "headerUsed": True, "structureIssueCount": 2},
        {"file": "large-20000.csv", "headerMode": "present", "state": "complete", "rowCount": 20000, "columnCount": 2, "columnNames": ["row_id", "label"], "firstRow": ["0", "row-00000"], "headerUsed": True, "structureIssueCount": 0},
        {"file": "ambiguous-header.csv", "headerMode": "auto", "state": "complete", "rowCount": 2, "columnCount": 2, "columnNames": ["Column 1", "Column 2"], "firstRow": ["alpha", "beta"], "suggestedHeader": False, "headerUsed": False, "structureIssueCount": 0},
        {"file": "header-audit.csv", "headerMode": "present", "state": "complete", "rowCount": 1, "columnCount": 4, "columnNames": ["name", "Column 2", "name (2)", long_header], "firstRow": ["A", "B", "C", "D"], "headerUsed": True, "structureIssueCount": 0, "headerIssueCount": 2},
        {"file": "background-failure.csv", "headerMode": "absent", "state": "failed", "rowCount": None, "columnCount": 2, "columnNames": ["Column 1", "Column 2"], "firstRow": ["0", "valid"], "headerUsed": False, "structureIssueCount": 0},
        {"file": "record-boundary-minus-one.csv", "headerMode": "absent", "state": "complete", "rowCount": 1, "columnCount": 1},
        {"file": "record-boundary-exact.csv", "headerMode": "absent", "state": "complete", "rowCount": 1, "columnCount": 1},
        {"file": "record-boundary-plus-one.csv", "headerMode": "absent", "expectedError": "CsvLimitExceeded"},
        {"file": "column-boundary-minus-one.csv", "headerMode": "absent", "state": "complete", "rowCount": 1, "columnCount": 4095},
        {"file": "column-boundary-exact.csv", "headerMode": "absent", "state": "complete", "rowCount": 1, "columnCount": 4096},
        {"file": "column-boundary-plus-one.csv", "headerMode": "absent", "expectedError": "CsvLimitExceeded"},
    ]
    (phase3 / "expected-golden.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(root)
    print(phase2)
    print(phase3)


if __name__ == "__main__":
    main()
