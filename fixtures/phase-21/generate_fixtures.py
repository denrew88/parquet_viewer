"""Deterministic stdlib fixtures and independent distinct-count/TSV oracle."""
import csv
import hashlib
import io
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def tsv(rows):
    output = io.StringIO(newline="")
    csv.writer(output, delimiter="\t", lineterminator="\r\n").writerows(rows)
    return output.getvalue().removesuffix("\r\n")


def main():
    rows = []
    for index in range(237):
        for repetition in range(1 + index % 5):
            rows.append([len(rows) + 1, f"value-{index:03d}", "A" if index % 2 else "B"])
    with (HERE / "distinct-pages.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\r\n")
        writer.writerow(["id", "value", "bucket"])
        writer.writerows(rows)
    text_rows = [
        [1, "short", "01", "9007199254740993", "1.2300", "2026-11-04T00:00:00.000000001Z"],
        [2, "한글🙂 with longer than twelve bytes", "1", "18446744073709551615", "1.2300", "2026-11-04T09:00:00.000000001+09:00"],
        [3, "", "bad", "-9223372036854775808", "-0.0000", "1969-12-31T23:59:59.999999999Z"],
        [4, "NULL", "NULL", "NULL", "NULL", "NULL"],
        [5, "tab\tvalue", "2", "2", "2.0000", "2026-01-01T00:00:00Z"],
        [6, "line\nvalue", "10", "10", "10.0000", "2026-01-01T00:00:00Z"],
        [7, 'quote"value', "1", "1", "1.0000", "2026-01-01T00:00:00Z"],
        [8, "line\r\nvalue", "01", "01", "1.0000", "2026-01-01T00:00:00Z"],
    ]
    with (HERE / "distinct-types.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\r\n")
        writer.writerow(["id", "text", "typed_integer", "precise_integer", "precise_decimal", "precise_timestamp"])
        writer.writerows(text_rows)
    golden = {}
    for scope, source in [("source", rows), ("bucketA", [row for row in rows if row[2] == "A"])]:
        counter = Counter(row[1] for row in source)
        ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0]))
        golden[scope] = {"rows": len(source), "totalCount": len(counter), "valuesCountDescending": ordered,
                         "valuesTsv": tsv([["Value"], *[[value] for value, _ in ordered]]),
                         "valuesCountsTsv": tsv([["Value", "Count"], *ordered])}
    golden["typedInteger"] = {"valid": {"1": 4, "2": 1, "10": 1}, "null": 1, "invalid": {"bad": 1}, "totalCount": 5}
    (HERE / "golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = [{"path": path.name, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                for path in [HERE / "distinct-pages.csv", HERE / "distinct-types.csv", HERE / "golden.json"]]
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sourceRows": len(rows), "distinct": len(set(row[1] for row in rows)), "files": len(manifest)}))


if __name__ == "__main__":
    main()
