# Canonical B2B API v1

The canonical public integration base is:

```text
https://your-domain.com/client/api
```

Each deployment changes only the domain and API token. Numeric product and
category IDs are compatibility IDs; never use MongoDB IDs in a B2B client.

## Authentication

Use the canonical header on every request:

```http
api-token: YOUR_API_TOKEN
```

`x-api-key` and `Authorization: Bearer YOUR_API_TOKEN` remain accepted legacy
aliases. The account must be active, API-enabled, non-deleted, and pass any
configured exact IP whitelist.

## Profile

```http
GET /profile
```

```json
{
  "balance": "150",
  "email": "user@example.com",
  "currency": "USD"
}
```

`balance` is the spendable balance under the existing wallet and credit rules.

## Products

```http
GET /products
GET /products?products_id=1000,1001
GET /products?base=1
```

The regular response includes canonical fields plus legacy aliases:

```json
{
  "id": 1000,
  "name": "PUBG Mobile UC 60",
  "price": 1.5,
  "currency": "USD",
  "available": true,
  "product_type": "package",
  "parent_id": 7,
  "category_name": "PUBG",
  "category_img": "uploads/categories/pubg.png",
  "qty_values": null,
  "params": ["Player ID"],
  "fields": [
    {
      "key": "player_id",
      "label": "Player ID",
      "type": "text",
      "required": true,
      "options": []
    }
  ],
  "cost": 1.5,
  "rate": 1.5,
  "api_price": 1.5,
  "provider_price": 1.5,
  "base_price": 1.5,
  "original_price": 1.5
}
```

`fields` is the canonical structured field list. `params` remains a
labels-only legacy field. Existing price and min/max aliases remain for legacy
clients. `qty_values` is `null` for package products or the existing min/max
range object for range products; fixed quantity arrays are not a supported
canonical feature.

`base=1` is legacy minimization behavior and retains its existing compact
response shape.

## Content

```http
GET /content/0
GET /content/:parentId
```

`0` returns root categories and uncategorized products. `parentId` is a numeric
compatibility category ID. The response remains:

```json
{ "status": "OK", "data": { "categories": [], "products": [] } }
```

## Create an order

Canonical endpoint:

```http
POST /orders
Content-Type: application/json
```

```json
{
  "product_id": 1000,
  "qty": 1,
  "order_uuid": "client-generated-idempotency-key",
  "params": {
    "player_id": "123456789",
    "server": "EU"
  }
}
```

```json
{
  "status": "OK",
  "data": {
    "order_id": "ID_0123456789abcdef",
    "order_uuid": "client-generated-idempotency-key",
    "status": "wait",
    "price": 1.5,
    "currency": "USD",
    "data": { "player_id": "123456789", "server": "EU" },
    "replay_api": null
  }
}
```

The server resolves the product, validates fields and quantity, calculates the
price, debits the wallet, creates the order, and dispatches provider fulfillment
using the existing order service. Client-supplied price or balance values are
ignored. `order_uuid` maps to the unique `(userId, idempotencyKey)` constraint;
repeating it returns the original order without another debit.

### Legacy GET order creation

```http
GET /newOrder/:productId/params?qty=1&playerId=123&order_uuid=uuid-1
```

This endpoint remains permanently supported for legacy clients. New clients
should use POST `/orders`.

## Check orders

```http
GET /check?orders=ID_1,ID_2
GET /check?orders=uuid-1,uuid-2&uuid=1
GET /check?uuids=uuid-1,uuid-2
```

Only orders owned by the authenticated account are returned. `uuid=1` remains
the legacy UUID lookup; `uuids` is the canonical convenience alias.

Every returned order now also includes its idempotency reference additively:

```json
{
  "order_id": "ID_0123456789abcdef",
  "order_uuid": "uuid-1",
  "quantity": 1,
  "status": "wait"
}
```

## Status values

| External | Internal |
| --- | --- |
| `accept` | `COMPLETED` |
| `reject` | `FAILED`, `CANCELED` |
| `wait` | `PENDING`, `PROCESSING`, `MANUAL_REVIEW`, `PARTIAL`, in-flight |

## Errors

```json
{ "status": "ERROR", "code": 100, "message": "Insufficient balance" }
```

| Code | Meaning |
| --- | --- |
| 100 | Insufficient balance |
| 105 | Quantity not available |
| 106 | Invalid quantity |
| 109 | Product not found |
| 110 | Product unavailable |
| 111 | Rate limited |
| 112 | Quantity too small |
| 113 | Quantity too large |
| 114 | Order/business rule error |
| 120 | API token required |
| 121 | Invalid API token |
| 122 | API access disabled or account inactive |
| 123 | IP not allowed |
| 124 | Validation error |
| 130 | Site under maintenance (order creation only) |
| 500 | Internal server error |

Order creation and order checking send no-store cache headers. The existing
numeric compatibility-ID backfill remains the recommended deployment step:

```bash
node scripts/backfill-compat-ids.js
```

## Legacy route families

- `/api/client/api/*` is an alias of the compatibility API.
- `/api/v1/reseller/*` and `/api/client/*` remain separate standard reseller
  APIs with their existing envelopes and MongoDB-ID order contract.
