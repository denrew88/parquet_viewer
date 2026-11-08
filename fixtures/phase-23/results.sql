-- Generate 460 typed result rows with stable source offsets 0–459.
WITH source AS (SELECT range AS i FROM range(460) CROSS JOIN "input")
SELECT
    9007199254740992::BIGINT + i AS row_key,
    CASE WHEN i % 2 = 0 THEN '팀-A' ELSE '팀-B' END AS group_name,
    CASE WHEN i % 10 = 0 THEN NULL ELSE i % 7 END AS score,
    92233720368547758.00 + (i % 100) * 0.01 AS amount,
    make_timestamp_ns(1794096000000000000::BIGINT + i + 1) AS event_time,
    CASE WHEN i % 11 = 0 THEN NULL ELSE i % 3 <> 0 END AS active,
    CASE
        WHEN i IN (12, 414, 415) THEN 'Needle'
        WHEN i = 408 THEN 'needle'
        WHEN i % 13 = 0 THEN NULL
        WHEN i % 9 = 0 THEN ''
        ELSE '서울, "가"'
    END AS detail
FROM source
ORDER BY i;
