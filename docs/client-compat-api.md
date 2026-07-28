# Client Compatibility API

This API mimics common reseller website integrations so clients can switch to Coins Store by changing the base URL and API token.

## Base URLs

Primary:

```text
https://coins-stores.com/client/api
```

Alias:

```text
https://coins-stores.com/api/client/api
```

The existing `/api/v1/reseller` and `/api/client` APIs keep their existing response format.

## Authentication

Send one of these headers:

```http
api-token: YOUR_API_TOKEN
x-api-key: YOUR_API_TOKEN
Authorization: Bearer YOUR_API_TOKEN
```

The account must be active, API-enabled, and allowed by any configured IP whitelist.

## Profile

```http
GET /profile
```

Response:

```json
{
  "balance": "8788.683",
  "email": "user@email.com"
}
```

`balance` is the authenticated reseller spendable balance in the user's currency. It is derived from `availableBalance = max(0, walletBalance + creditLimit)` and does not subtract `creditUsed` again.

## Products

```http
GET /products
GET /products?products_id=365,366,367
GET /products?base=1
GET /products?products_id=365,366&base=1
```

Full response:

```json
[
  {
    "id": 365,
    "name": "UC 60",
    "price": 0.104,
    "params": ["Player ID"],
    "category_name": "PUBG Global ID UC",
    "available": true,
    "qty_values": null,
    "product_type": "package",
    "parent_id": 7,
    "base_price": 0.104,
    "category_img": "images/category/1710948113.webp"
  }
]
```

Minimal response with `base=1`:

```json
[
  {
    "id": 365,
    "name": "UC 60"
  }
]
```

`id` is the stable numeric compatibility product ID. It is not the internal MongoDB ID.

`qty_values` meanings:

- `null`: fixed/package product.
- `{ "min": "1", "max": "50" }`: amount/range product.
- `["110", "150"]`: fixed allowed quantities, only when the internal product explicitly supports fixed allowed quantities.

## Content

```http
GET /content/0
GET /content/:parentId
```

`parentId` is a stable numeric compatibility category ID. `0` means root content.

Response:

```json
{
  "status": "OK",
  "data": {
    "categories": [
      {
        "id": 7,
        "name": "PUBG Global ID UC",
        "parent_id": 0,
        "image": "images/category/1710948113.webp",
        "available": true
      }
    ],
    "products": [
      {
        "id": 365,
        "name": "UC 60",
        "price": 0.104,
        "params": ["Player ID"],
        "category_name": "PUBG Global ID UC",
        "available": true,
        "qty_values": null,
        "product_type": "package",
        "parent_id": 7,
        "base_price": 0.104,
        "category_img": "images/category/1710948113.webp"
      }
    ]
  }
}
```

## New Order

```http
GET /newOrder/:productId/params?qty=1&playerId=test&server=EU&order_uuid=abc-123
```

Rules:

- `productId` is the numeric compatibility product ID.
- `qty` is required and must be valid for the product.
- `order_uuid` is required and is used as the internal idempotency key.
- All query params except `qty` and `order_uuid` become order field values.
- Repeating the same `order_uuid` for the same reseller returns the original order and does not debit again.
- This endpoint returns `Cache-Control: no-store`.

Success response:

```json
{
  "status": "OK",
  "data": {
    "order_id": "ID_9fffb0d849a45215",
    "status": "wait",
    "price": 1.26048,
    "data": {
      "playerId": "test",
      "server": "EU"
    },
    "replay_api": null
  }
}
```

## Check Orders

```http
GET /check?orders=[ID_1,ID_2]
GET /check?orders=ID_1,ID_2
GET /check?orders=[uuid1,uuid2]&uuid=1
```

Rules:

- Without `uuid=1`, lookup is by compatibility order ID with order number fallback.
- With `uuid=1`, lookup is by `order_uuid` / idempotency key.
- Only orders owned by the authenticated reseller are returned.
- This endpoint returns `Cache-Control: no-store`.

Response:

```json
{
  "status": "OK",
  "data": [
    {
      "order_id": "ID_9fffb0d849a45215",
      "quantity": 1,
      "data": {
        "playerId": "test"
      },
      "created_at": "2025-04-10 13:55:48",
      "product_name": "A-60UC-stock",
      "price": "1.2604800000000000",
      "status": "accept",
      "replay_api": null
    }
  ]
}
```

## Status Values

- `accept`: completed.
- `reject`: failed or canceled.
- `wait`: pending, processing, manual review, or partial.

## Error Format

Compatibility endpoints return:

```json
{
  "status": "ERROR",
  "code": 100,
  "message": "Insufficient balance"
}
```

Codes:

| Code | Meaning |
| --- | --- |
| 100 | Insufficient balance |
| 105 | Quantity not available |
| 106 | Quantity not allowed |
| 109 | Product deleted or not found |
| 110 | Product not available now |
| 111 | Try again after 1 minute / rate limited |
| 112 | Quantity is too small |
| 113 | Quantity is too large |
| 114 | Unknown order creation error |
| 120 | API token is required |
| 121 | Token error |
| 122 | Not allowed to use API / suspended / API disabled / inactive account |
| 123 | IP not allowed or validation error |
| 130 | Site under maintenance, if maintenance mode is enabled |
| 500 | Unknown internal error |

## Backfill

Existing products and categories need numeric compatibility IDs before integrators use product/category IDs.

Run from `Backend`:

```bash
node scripts/backfill-compat-ids.js
```

The script is idempotent and only assigns IDs to records missing `compatProductId` or `compatCategoryId`.

## Security Notes

- The API reuses reseller API-token authentication.
- Order creation reuses the existing safe order service, including wallet deduction, idempotency, validation, audit, provider dispatch, refunds, and status lifecycle.
- Provider tokens, internal cost-only fields, and admin-only fields are not returned.
- GET-based order creation is supported only for compatibility; clients should always provide a unique `order_uuid`.
