-- Open only customers.parquet, orders.csv and order_items.parquet from this folder.
-- Use Original names only, aliases customers / orders / order_items.
-- Ctrl+Enter runs the statement at the cursor. Run, Explain, and Analyze use the editor text.

-- 1. Row counts. Exact expected counts are in manifest.json.
SELECT 'customers' AS table_name, COUNT(*) AS row_count FROM customers
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items;

-- 2. Real three-table JOIN: the first100 purchased lines, not100 orders.
SELECT o.order_id, o.ordered_at, c.customer_name, c.region,
       i.product_name, i.category, i.quantity, i.line_total_krw, o.status
FROM orders o
JOIN customers c ON c.customer_id = o.customer_id
JOIN order_items i ON i.order_id = o.order_id
ORDER BY o.order_id, i.line_no
LIMIT 100;

-- 3. Monthly, regional and category product sales; shipping excluded.
-- CSV time is explicitly cast, independent of the selected inference profile.
SELECT DATE_TRUNC('month', CAST(o.ordered_at AS TIMESTAMP)) AS sales_month,
       c.region, i.category,
       COUNT(DISTINCT o.order_id) AS order_count,
       SUM(i.quantity) AS units,
       SUM(i.line_total_krw) AS product_sales_krw
FROM orders o
JOIN customers c ON c.customer_id = o.customer_id
JOIN order_items i ON i.order_id = o.order_id
WHERE o.status NOT IN ('cancelled', 'returned')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 4. Top100 customers by product sales. May spill under small memory/storage limits.
SELECT c.customer_id, c.customer_name, c.tier, c.region,
       COUNT(DISTINCT o.order_id) AS order_count,
       SUM(i.quantity) AS units,
       SUM(i.line_total_krw) AS product_sales_krw
FROM customers c
JOIN orders o ON o.customer_id = c.customer_id
JOIN order_items i ON i.order_id = o.order_id
WHERE o.status NOT IN ('cancelled', 'returned')
GROUP BY c.customer_id, c.customer_name, c.tier, c.region
ORDER BY product_sales_krw DESC, c.customer_id
LIMIT 100;

-- 5. Check order totals against line totals plus shipping: expected0rows.
SELECT o.order_id, o.order_total_krw,
       SUM(i.line_total_krw) + o.shipping_fee_krw AS calculated_total_krw
FROM orders o
JOIN order_items i ON i.order_id = o.order_id
GROUP BY o.order_id, o.order_total_krw, o.shipping_fee_krw
HAVING o.order_total_krw <> SUM(i.line_total_krw) + o.shipping_fee_krw
LIMIT 100;

-- 6. Numeric golden values: compare golden.json totals (includes every status).
SELECT COUNT(*) AS order_count, SUM(order_total_krw) AS order_total_krw,
       SUM(shipping_fee_krw) AS shipping_fee_krw
FROM orders;

-- 7. Nullable demographic data: expected2439null birth years.
SELECT COUNT(*) AS customers, COUNT(birth_year) AS known_birth_year,
       SUM(CASE WHEN birth_year IS NULL THEN 1 ELSE 0 END) AS null_birth_year
FROM customers;

-- 8. Monthly active gross totals, including shipping: matches golden.json active_monthly.
SELECT SUBSTRING(CAST(ordered_at AS VARCHAR), 1, 7) AS sales_month,
       COUNT(*) AS orders, SUM(order_total_krw) AS gross_krw
FROM orders
WHERE status NOT IN ('cancelled', 'returned')
GROUP BY 1
ORDER BY 1;
