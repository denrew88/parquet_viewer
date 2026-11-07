"""Deterministic, bounded-batch commerce fixtures. No app/cache access or SQL engine."""
from __future__ import annotations

import csv
from collections import Counter, defaultdict
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import random

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent
CUSTOMERS = 100_000
ORDERS = 1_000_000
BATCH = 10_000
SEED = 20261106
REGIONS = ["서울", "경기", "인천", "부산", "대구", "대전", "광주", "울산", "세종", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"]
CATEGORIES = ["생활용품", "식품", "의류", "가전", "문구", "스포츠", "뷰티", "반려동물"]
PRODUCTS = ["수납함", "드립 커피", "면 티셔츠", "무선 청소기", "노트 세트", "요가 매트", "보습 크림", "반려동물 간식"]
BASE_PRICES = [3900, 12900, 19900, 89900, 2900, 24900, 14900, 7900]
STATES = ["delivered"] * 65 + ["shipped"] * 10 + ["paid"] * 8 + ["processing"] * 7 + ["cancelled"] * 6 + ["returned"] * 4
HEADERS = ["order_id", "customer_id", "ordered_at", "status", "channel", "payment_method", "shipping_region", "shipping_fee_krw", "order_total_krw", "coupon_code", "delivery_note"]
CUSTOMER_SCHEMA = pa.schema([
    ("customer_id", pa.int64()), ("customer_name", pa.string()),
    ("email", pa.string()), ("region", pa.string()), ("tier", pa.string()),
    ("signed_up_at", pa.timestamp("ms")), ("birth_year", pa.int16()),
    ("marketing_opt_in", pa.bool_()),
])
ITEM_SCHEMA = pa.schema([
    ("order_id", pa.int64()), ("line_no", pa.int16()), ("product_id", pa.int64()),
    ("product_name", pa.string()), ("category", pa.string()), ("quantity", pa.int16()),
    ("unit_price_krw", pa.int64()), ("discount_krw", pa.int64()), ("line_total_krw", pa.int64()),
])


def region(customer_id):
    return REGIONS[(customer_id * 7 + customer_id // 97) % len(REGIONS)]


def write_batch(writer, rows, schema):
    writer.write_table(pa.Table.from_pylist(rows, schema=schema), row_group_size=64_000)
    rows.clear()


def digest(file):
    value = hashlib.sha256()
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def generate():
    rng = random.Random(SEED)
    with pq.ParquetWriter(ROOT / "customers.parquet", CUSTOMER_SCHEMA, compression="snappy") as writer:
        rows = []
        for cid in range(1, CUSTOMERS + 1):
            rows.append({
                "customer_id": cid,
                "customer_name": ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"][cid % 10] + ["민준", "서연", "지우", "도윤", "하은", "수빈", "지훈", "예린", "현우", "서준", "유진", "나연", "태현"][cid // 10 % 13],
                "email": f"customer{cid:06d}@example.invalid",
                "region": region(cid),
                "tier": ["bronze", "silver", "silver", "gold", "vip"][cid % 5],
                "signed_up_at": datetime(2022, 1, 1) + timedelta(seconds=(cid * 7919) % (730 * 86400)),
                "birth_year": None if cid % 41 == 0 else 1960 + cid % 46,
                "marketing_opt_in": cid % 3 != 0,
            })
            if len(rows) == BATCH:
                write_batch(writer, rows, CUSTOMER_SCHEMA)
        if rows:
            write_batch(writer, rows, CUSTOMER_SCHEMA)

    counts = Counter()
    monthly = defaultdict(lambda: {"orders": 0, "gross_krw": 0})
    item_rows = []
    with (ROOT / "orders.csv").open("w", encoding="utf-8", newline="") as output, pq.ParquetWriter(ROOT / "order_items.parquet", ITEM_SCHEMA, compression="snappy") as writer:
        csv_writer = csv.writer(output, lineterminator="\r\n")
        csv_writer.writerow(HEADERS)
        for oid in range(1, ORDERS + 1):
            # Repeat buyers and skew: 65% of orders target the first20% of customers.
            cid = rng.randint(1, CUSTOMERS // 5 if rng.random() < 0.65 else CUSTOMERS)
            ordered = datetime(2024, 1, 1) + timedelta(seconds=rng.randrange(1036 * 86400))
            state = rng.choice(STATES)
            subtotal = 0
            for line in range(1, 2 + (oid - 1) % 7):
                product = rng.randint(1, 10_000)
                category = product % len(CATEGORIES)
                quantity = rng.choices([1, 2, 3], [75, 20, 5])[0]
                price = BASE_PRICES[category] + (product // 8 % 30) * 100
                discount = quantity * price * rng.choice([0, 0, 0, 5, 10, 15]) // 100
                net = quantity * price - discount
                item_rows.append({"order_id": oid, "line_no": line, "product_id": product,
                    "product_name": f"{PRODUCTS[category]} {product:05d}", "category": CATEGORIES[category],
                    "quantity": quantity, "unit_price_krw": price, "discount_krw": discount, "line_total_krw": net})
                subtotal += net
                counts["item_count"] += 1
                counts["item_quantity"] += quantity
                counts["line_total_krw"] += net
            fee = 0 if subtotal >= 50_000 else (3500 if region(cid) == "제주" else 3000)
            total = subtotal + fee
            note = "배송 메모:\n문 앞에 두세요" if oid % 3133 == 0 else rng.choice(["", "", "문 앞에 두세요", '포장 "주의"', "부재 시, 경비실", "선물 포장 요청"])
            csv_writer.writerow([oid, cid, ordered.isoformat(timespec="seconds"), state,
                rng.choice(["web", "android", "android", "ios", "marketplace"]),
                rng.choice(["card", "card", "kakaopay", "naverpay", "bank_transfer"]),
                region(cid), fee, total, "WELCOME10" if oid % 11 == 0 else "", note])
            counts["order_count"] += 1
            counts["order_total_krw"] += total
            counts["shipping_fee_krw"] += fee
            counts["status:" + state] += 1
            if state not in {"cancelled", "returned"}:
                key = ordered.strftime("%Y-%m")
                monthly[key]["orders"] += 1
                monthly[key]["gross_krw"] += total
            if oid % BATCH == 0:
                write_batch(writer, item_rows, ITEM_SCHEMA)
            if oid % 200_000 == 0:
                print(f"Generated {oid:,} orders / {counts['item_count']:,} items", flush=True)
        if item_rows:
            write_batch(writer, item_rows, ITEM_SCHEMA)
    golden = {"seed": SEED, "customers": CUSTOMERS, "totals": dict(counts), "active_monthly": dict(sorted(monthly.items()))}
    (ROOT / "golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verify():
    """Re-read output; merge ordered CSV and Parquet, checking every PK/FK and amount."""
    expected = json.loads((ROOT / "golden.json").read_text(encoding="utf-8"))
    customer_count = 0
    null_birth_years = 0
    for batch in pq.ParquetFile(ROOT / "customers.parquet").iter_batches(columns=["customer_id", "birth_year"]):
        ids, years = batch.to_pydict().values()
        for cid, year in zip(ids, years):
            customer_count += 1
            assert cid == customer_count
            null_birth_years += year is None
    assert customer_count == CUSTOMERS
    actual = Counter()
    monthly = defaultdict(lambda: {"orders": 0, "gross_krw": 0})
    columns = ["order_id", "line_no", "quantity", "unit_price_krw", "discount_krw", "line_total_krw"]
    with (ROOT / "orders.csv").open(encoding="utf-8", newline="") as source:
        orders = iter(csv.DictReader(source))
        order = next(orders)
        subtotal, previous_line = 0, 0

        def finish():
            cid = int(order["customer_id"])
            assert 1 <= cid <= CUSTOMERS
            assert order["shipping_region"] == region(cid)
            assert previous_line == 1 + (int(order["order_id"]) - 1) % 7
            fee, total = int(order["shipping_fee_krw"]), int(order["order_total_krw"])
            assert total == subtotal + fee
            actual["order_count"] += 1
            actual["shipping_fee_krw"] += fee
            actual["order_total_krw"] += total
            state = order["status"]
            actual["status:" + state] += 1
            if state not in {"cancelled", "returned"}:
                bucket = monthly[order["ordered_at"][:7]]
                bucket["orders"] += 1
                bucket["gross_krw"] += total

        for batch in pq.ParquetFile(ROOT / "order_items.parquet").iter_batches(columns=columns):
            values = batch.to_pydict()
            for oid, line, qty, price, discount, net in zip(*(values[c] for c in columns)):
                if oid != int(order["order_id"]):
                    finish()
                    order = next(orders)
                    assert oid == int(order["order_id"]) == actual["order_count"] + 1
                    subtotal, previous_line = 0, 0
                assert line == previous_line + 1
                assert qty in (1, 2, 3) and price > 0 and 0 <= discount <= qty * price
                assert net == qty * price - discount
                previous_line = line
                subtotal += net
                actual["item_count"] += 1
                actual["item_quantity"] += qty
                actual["line_total_krw"] += net
        finish()
        assert next(orders, None) is None
    assert actual == Counter(expected["totals"])
    assert actual["order_count"] == ORDERS
    assert dict(monthly) == expected["active_monthly"]
    files = [{"file": name, "bytes": (ROOT / name).stat().st_size, "sha256": digest(ROOT / name),
              "rows": customer_count if name == "customers.parquet" else actual["order_count"] if name == "orders.csv" else actual["item_count"]}
             for name in ["customers.parquet", "orders.csv", "order_items.parquet"]]
    report = {"status": "PASS", "seed": SEED, "pyarrow": pa.__version__, "checks": ["all primary/foreign keys", "every item calculation", "every order total", "all status counts", "monthly totals"], "null_birth_years": null_birth_years, "files": files, "total_bytes": sum(f["bytes"] for f in files)}
    (ROOT / "manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    generate()
    verify()
