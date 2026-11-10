"""Generate typed Phase 24 inputs and an independent arithmetic oracle."""

from argparse import ArgumentParser
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
from statistics import median

import pyarrow as pa
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[2]
PERIOD_ROWS = 320
CATEGORIES = ("Fitness", "Outdoor", "Running", "Yoga")
DAY_NS = 86_400_000_000_000


def epoch_ns(month: int) -> int:
    return int(datetime(2026, month, 1, tzinfo=UTC).timestamp()) * 1_000_000_000


def amount_cents(position: int, month: int) -> int:
    return 1_000 + position * (11 if month == 1 else 23) + (position % 4) * 333


def generate_orders(destination: Path) -> None:
    month_column, ordinal, category, amount, unit_price, quantity, timestamp = ([] for _ in range(7))
    for month in (1, 2):
        for position in range(PERIOD_ROWS):
            month_column.append(f"2026-{month:02d}")
            ordinal.append(position)
            category.append(CATEGORIES[position % len(CATEGORIES)])
            amount.append(Decimal(amount_cents(position, month)).scaleb(-2))
            unit_price.append(Decimal(499 + (position * 79) % 35_000).scaleb(-2))
            quantity.append(position % 11 + 1)
            timestamp.append(epoch_ns(month) + (position % 28) * DAY_NS + position)
    pq.write_table(pa.table({
        "month": pa.array(month_column, pa.string()),
        "ordinal": pa.array(ordinal, pa.int64()),
        "category": pa.array(category, pa.string()),
        "amount": pa.array(amount, pa.decimal128(12, 2)),
        "unit_price": pa.array(unit_price, pa.decimal128(12, 2)),
        "quantity": pa.array(quantity, pa.int32()),
        "ordered_at": pa.array(timestamp, pa.timestamp("ns")),
    }), destination, row_group_size=128)


def generate_precision(destination: Path) -> None:
    origin = Decimal("9007199254.740992")
    rows = 6
    pq.write_table(pa.table({
        "sequence": pa.array([2**53 + step for step in range(rows)], pa.int64()),
        "amount": pa.array([origin + Decimal(step).scaleb(-6) for step in range(rows)], pa.decimal128(20, 6)),
        "at": pa.array([epoch_ns(1) + step for step in range(rows)], pa.timestamp("ns")),
        "measure": pa.array([0.0, 1.0, -1.0, None, float("nan"), float("inf")], pa.float64()),
        "category": pa.array(["A", "A", "B", "B", None, "B"], pa.string()),
    }), destination)


def generate_scale(destination: Path, row_count: int) -> None:
    schema = pa.schema([
        ("position", pa.int64()), ("unit_price", pa.float64()),
        ("quantity", pa.int32()), ("category", pa.string()),
    ])
    chunk_rows = 32_768
    with pq.ParquetWriter(destination, schema, compression="zstd") as writer:
        for first in range(0, row_count, chunk_rows):
            positions = range(first, min(first + chunk_rows, row_count))
            writer.write_table(pa.table({
                "position": pa.array(positions, pa.int64()),
                "unit_price": pa.array([((i * 173) % 40_000) / 100 for i in positions], pa.float64()),
                "quantity": pa.array([i % 20 + 1 for i in positions], pa.int32()),
                "category": pa.array([CATEGORIES[i % 4] for i in positions], pa.string()),
            }, schema=schema))


def file_digest(source: Path) -> str:
    with source.open("rb") as stream:
        digest = sha256()
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
        return digest.hexdigest()


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp" / "phase24-fixtures")
    parser.add_argument("--scale", action="store_true", help="Also generate 10k, 100k and 1m rows.")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    inputs = {"orders.parquet": 2 * PERIOD_ROWS, "precision.parquet": 6}
    generate_orders(args.output / "orders.parquet")
    generate_precision(args.output / "precision.parquet")
    if args.scale:
        for row_count in (10_000, 100_000, 1_000_000):
            filename = f"scale-{row_count}.parquet"
            generate_scale(args.output / filename, row_count)
            inputs[filename] = row_count

    positions = range(319, 108, -1)
    groups = {category: [amount_cents(i, 1) for i in positions if CATEGORIES[i % 4] == category]
              for category in CATEGORIES}
    all_amounts = [amount_cents(i, month) for month in (1, 2) for i in range(PERIOD_ROWS)]
    all_groups = {category: [amount_cents(i, month) for month in (1, 2) for i in range(PERIOD_ROWS)
                             if CATEGORIES[i % 4] == category]
                  for category in CATEGORIES}
    oracle = {
        "files": {name: {"rows": n, "sha256": file_digest(args.output / name)} for name, n in inputs.items()},
        "orders": {"monthRows": PERIOD_ROWS, "dailyRows": 28,
                   "minCents": min(all_amounts), "maxCents": max(all_amounts),
                   "groups": {label: {"count": len(values), "sumCents": sum(values)}
                              for label, values in all_groups.items()}},
        "sqlSelection": {
            "month": "2026-01", "minOrdinal": 30, "filteredRows": PERIOD_ROWS - 30,
            "firstOrdinal": positions.start, "lastOrdinal": positions[-1], "selectedRows": len(positions),
            "groups": {label: {"count": len(values), "medianCents": median(values)}
                       for label, values in groups.items()},
        },
        "precision": {"rows": 6, "finiteMeasures": 3, "sequenceOrigin": str(2**53),
                      "decimalOrigin": "9007199254.740992", "timestampOriginNs": str(epoch_ns(1))},
    }
    (args.output / "golden.json").write_text(json.dumps(oracle, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(oracle, ensure_ascii=False))


if __name__ == "__main__":
    main()
