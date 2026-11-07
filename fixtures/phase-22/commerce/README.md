# 쇼핑몰 SQL 실습용 대용량 데이터

실제 개인정보를 사용하지 않은 합성 데이터다. 고정 seed20261106으로 생성하며, 통화는 정수 원(KRW)이다.

| 파일 / 기본 SQL 별칭 | 행 수 | 내용 |
| --- | ---: | --- |
| `customers.parquet` / `customers` | 100,000 | 고객명, 가상 이메일, 17개 지역, 등급, 가입 시각, 출생 연도(NULL 포함), 수신 동의 |
| `orders.csv` / `orders` | 1,000,000 | 고객, 2024~2026 주문 시각, 상태, 유입 채널, 결제 수단, 배송비, 주문 금액, 쿠폰·배송 메모 |
| `order_items.parquet` / `order_items` | 3,999,997 | 주문당1~7품목, 10,000상품, 8카테고리, 수량, 가격, 할인액, 품목 결제 금액 |

정확한 파일 바이트 수와 SHA256은 `manifest.json`에 기록한다. 큰 데이터3개는 Git에서 제외하고
생성 코드·SQL·정답 집계·manifest를 보관한다. 기존 작은 Phase22 fixture는 바꾸지 않는다.
현재 생성본은 합계146,101,612bytes(약146MB)다. 고객2.13MB, 주문 CSV91.31MB,
주문 상세52.66MB이며 출생 연도 NULL은2,439개다. 파일 재읽기 무결성 검증은 PASS다.

## 사용 방법

1. 이 폴더의 위 세 데이터 파일을 앱에서 함께 연다.
2. SQL 화면에서 파일별 **Original names only**를 사용한다. 기본 별칭은 `customers`, `orders`,
   `order_items`다. 같은 이름의 다른 fixture도 열려 있으면 별칭이 달라질 수 있으니 확인한다.
3. `queries.sql`에서 원하는 SQL을 편집기에 복사하고 실행할 문장에 커서를 놓은 뒤 Ctrl+Enter를 누른다.
4. 첫 CSV 조회는 Parquet 캐시 준비 시간이 포함된다. 전체4백만 품목을 그대로 출력하기보다는
   LIMIT 또는 집계를 사용한다. 앱의 결과 행 수 제한은 계속 적용된다.

예제는 행 수 확인, 3테이블 JOIN, 월별·지역별·카테고리 매출, 우수 고객, 주문 금액 검산,
정확한 합계 및 NULL 집계를 포함한다. 생성기에서는 DuckDB나 앱을 실행하지 않는다.
SQL 예제의 실제 앱 성능·저장공간 사용량을 측정한 데이터라는 뜻은 아니다.

## 관계와 금액

- `customers.customer_id` → `orders.customer_id`: 고객1명당 여러 주문, 재구매 고객에 주문이 집중된다.
- `orders.order_id` → `order_items.order_id`: 주문1건당1~7품목. 품목 키는 `(order_id, line_no)`다.
- `line_total_krw = quantity * unit_price_krw - discount_krw`.
- `order_total_krw = SUM(해당 주문 line_total_krw) + shipping_fee_krw`.
- 취소·반품 주문에도 원래 구매 금액과 품목을 남긴다. 매출 예제는 두 상태를 제외한다.
- 주문 합계를 상세 품목과 JOIN한 뒤 그대로 SUM하면 품목 수만큼 중복된다. 품목 금액을 합하거나
  주문 단위로 먼저 집계해야 한다. 배송비를 포함한 주문 매출과 품목 매출은 구분한다.
- CSV 시간은 ISO8601 텍스트이며 시간 계산 예제에서 명시적으로 TIMESTAMP로 CAST한다.
  고객 가입 시각은 Parquet의 timestamp(ms)다. 시간대는 넣지 않은 로컬 테스트 시각이다.
- 이메일은 예약된 `example.invalid` 도메인이다. 한글·쉼표·큰따옴표·여러 줄 배송 메모도 포함한다.

## 재생성과 검증

```powershell
node scripts/dev-check.mjs phase22-commerce-fixtures
```

현재 폴더의 생성 데이터와 정답/manifest를 다시 만든다. 다른 입력·앱 설정·캐시는 건드리지 않는다.
10,000주문 단위로 기록하고 전체 데이터를 메모리에 누적하지 않는다. 파일을 다시 스트리밍으로 읽어
모든 기본·외래 키, 모든 품목 계산, 모든 주문 금액, 상태별 수와 월별 합계를 검증한다.
`golden.json`은 SQL 엔진을 사용하지 않는 Python 정수 계산의 결과다.
