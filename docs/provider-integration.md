# Provider Integration

## Scope

This document describes the current implementation in `src/modules/providers`
and `src/modules/orders`. It is not a provider API specification.

```text
Provider → ProviderProduct (raw external catalogue) → Product (admin-curated)
```

`ProviderProduct` stores normalized external catalogue data. `Product` owns
public fields, `orderFields`, and `providerMapping`.

## Adapter Factory

**File:** `src/modules/providers/adapters/adapter.factory.js`

The factory lowercases and trims values, then resolves in this order:

1. `provider.adapterType`
2. `provider.slug`
3. `provider.name`
4. `MockProviderAdapter` in non-strict mode

`adapterType` is optional. `getAdapter()` always falls back to Mock.
`getProviderAdapter(provider, { strict: true })` throws `UNSUPPORTED_PROVIDER`
only when no adapterType, slug, or name matches. An unknown adapterType still
falls through to a matching legacy slug or name.

| Registry keys | Adapter |
| --- | --- |
| `canonical-b2b` | `CanonicalB2BAdapter` |
| `royal-crown`, `royal crown`, `royalcrown` | `RoyalCrownAdapter` |
| `toros`, `torosfon`, `torosfon store`, `toros-store`, `torosfonstore` | `TorosfonAdapter` |
| `alkasr`, `alkasr-vip`, `alkasr vip`, `alkasrvip` and configured brand aliases | `AlkasrVipAdapter` |
| `ibra-store`, `ibrastore`, `ibra` | `IbraAdapter` |
| `dealer-api`, `dealer`, `karak`, `ibulala` and configured aliases | `DealerApiAdapter` |
| `mock` | `MockProviderAdapter` |

Multiple Provider records can use `adapterType: "canonical-b2b"` with different
`baseUrl` and token values.

## Base Adapter Contract

**File:** `src/modules/providers/adapters/base.adapter.js`

Concrete adapters implement `getProducts()`, `placeOrder(params)`,
`checkOrder(orderId)`, `checkOrders(orderIds)`, and `getBalance()`.

Base aliases are `fetchProducts()` → `getProducts()`,
`checkOrdersBatch()` → `checkOrders()`, and `getMyInfo()` → `getBalance()`.

Products supplied to synchronization have this normalized shape:

```js
{
  externalProductId: String,
  rawName: String,
  rawPrice: String,
  minQty: Number,       // default 1
  maxQty: Number,       // default 9999
  isActive: Boolean,    // default true
  rawPayload: Object
}
```

`_resolveToken()` prefers `apiToken`, then `apiKey`, then `effectiveToken`.

## Current Adapters

HTTP adapters use Axios with a default 180,000 ms timeout unless an option
overrides it.

| Adapter | Authentication in current code | Products / balance | Placement / status |
| --- | --- | --- | --- |
| RoyalCrownAdapter | `api-token` header | `GET /api/AllProducts`; `GET /api/GetMyInfo` | `GET /api/PlaceOrder/:productId/data`; `GET /api/CheckOrder?order_id=`; `GET /api/CheckListOrders?orders=` |
| TorosfonAdapter | `api-token` header | `GET /api/AllProducts`; `GET /api/GetMyInfo` | `GET /api/PlaceOrder/:productId/data`; `GET /api/CheckOrder?order_id=`; `GET /api/CheckListOrders?orders=` |
| AlkasrVipAdapter | `api-token` header | `GET /client/api/products`; `GET /client/api/profile` | `GET /client/api/newOrder/:productId/params`; `GET /client/api/check?orders=` |
| IbraAdapter | `api-token` header | `GET /client/products`; `GET /client/profile` | `POST /client/orders`; `GET /client/check?orders=` |
| DealerApiAdapter | `secretKey` query parameter; no auth header set by this adapter | dynamic local catalogue; `GET /dealer/account?secretKey=` | `POST /dealer/sale` with `secretKey`, `toUserId`, `coins`; checks return synthetic completed results |
| CanonicalB2BAdapter | `api-token` header | `GET /products`; `GET /profile` | `POST /orders`; `GET /check?orders=`; `GET /check?uuids=` |
| MockProviderAdapter | none | local mock data | local mock behavior |

- Royal Crown and Toros placement sends `amount`, `player_Id`, and
  `referenceId` query fields. Toros normalizes statuses before returning them.
- Alkasr uses the legacy GET creation endpoint and creates its own
  `crypto.randomUUID()` as `order_uuid`; it does not forward `referenceId`.
- Ibra posts `{ productId, qty, order_uuid, ...dynamicFields }`; it uses a
  supplied `referenceId`, but generates a UUID if none is supplied.
- Dealer dynamic products are configured locally for `karak` and `ibulala`.
  Its check methods do not call a remote status endpoint.

## CanonicalB2BAdapter

**File:** `src/modules/providers/adapters/canonicalB2B.adapter.js`

Example Provider configuration:

```text
adapterType=canonical-b2b
baseUrl=https://domain.example/client/api
apiToken=<site-specific-token>
```

`baseUrl` is the complete Canonical B2B API base. The adapter removes only
trailing slashes and never appends `/client/api`.

`GET /products` maps upstream `id`, `name`, `price`, `available`, and
`qty_values` into the base DTO. A numeric `{ min, max }` object maps to a range;
any other quantity form, including `null`, maps to `minQty: 1, maxQty: 1`.

The provider-price pipeline treats raw provider prices as USD. An explicit
non-USD upstream currency makes `getProducts()` throw. Missing currency uses
the current USD-compatible behavior. Upstream `fields` remain in sanitized
`rawPayload`; this adapter does not publish local `Product.orderFields` or alter
`providerMapping`.

### Placement and uncertain recovery

`executeOrder()` passes the persisted `Order.orderNumber` as `referenceId`.
CanonicalB2BAdapter requires a positive numeric external product ID and that
reference, then sends:

```json
{
  "product_id": 1000,
  "qty": 1,
  "order_uuid": "<Order.orderNumber>",
  "params": { "...mapped customer fields": "..." }
}
```

It removes recognized internal price, balance, and currency fields before
building `params`, and never generates a substitute reference. A normal
`{ status: "OK", data: { order_id, status } }` response returns the real remote
ID as `providerOrderId` and preserves the raw status for the central mapper.
Deterministic compatibility errors and HTTP 4xx responses return failed
placement results.

Timeouts, resets, network interruptions, and eligible unknown 5xx placement
errors trigger `GET /check?uuids=<Order.orderNumber>`:

- A match returns the actual remote `order_id` and status.
- No match, or a failed reference lookup, returns `success: true` with
  `providerStatus: "PLACEMENT_UNCERTAIN"` and no remote ID.

Adapter raw values with token, API-key, authorization, password, or secret keys
are redacted.

## Product Synchronization

**Scheduled job:** `src/modules/providers/syncProvidersJob.js`
**Actual sync implementation:** `src/modules/providers/providerProductSync.service.js`

`server.js` starts `syncProvidersJob` unless safe local production mode is
enabled. The job does not start in tests. Its default schedule is:

```text
0 0,6,12,18 * * *
```

That runs at 00:00, 06:00, 12:00, and 18:00 UTC. The job calls
`syncAllProviders()` from `providerCatalog.service.js`, which re-exports the
implementation in `providerProductSync.service.js`.

For each active Provider, synchronization:

1. Resolves an adapter with `getAdapter(provider, adapterOptions)`.
2. Calls `adapter.fetchProducts()`.
3. Upserts `ProviderProduct` by `(provider, externalProductId)`.
4. Deactivates previous active products absent from a non-empty response.
5. Updates linked Products in `pricingMode: SYNC` with provider and calculated
   final/base prices.

The implementation has an in-process per-provider lock, batches upserts using
`SYNC_UPSERT_CONCURRENCY` (default 10), collects individual upsert errors, and
does not deactivate products for an empty catalogue response.

## Fulfillment and Active Polling

**Active job:** `src/modules/orders/fulfillmentJob.js`
**Active polling function:** `pollProcessingOrders()` in
`src/modules/orders/orderFulfillment.service.js`

`server.js` starts `fulfillmentJob` unless safe local production mode is enabled.
Its default cron expression is `*/5 * * * *` (every five minutes); it does not
start in tests.

`executeOrder()` obtains the provider external product ID, applies:

```js
applyProviderMapping(order.customerInput.values, product.providerMapping)
```

and invokes the adapter with external IDs, `quantity`,
`referenceId: order.orderNumber`, and mapped customer fields.

The active poller loads up to 200 automatic PROCESSING orders, oldest checked
first, where `providerOrderId` exists or
`providerStatus === "PLACEMENT_UNCERTAIN"`. It groups them by immutable
`order.providerCode`, resolves active providers by slug/name, and batch-checks
orders with remote IDs.

For an uncertain placement with no remote ID, it feature-detects
`checkOrderByReference` and calls it with `order.orderNumber`:

- On recovery it saves the real remote ID, status, and raw response, then runs
  the result through `processOrderStatusResult()`. Future checks use normal
  `checkOrders()` calls by the recovered remote ID.
- On no match, unsupported lookup, or lookup failure it remains PROCESSING with
  `PLACEMENT_UNCERTAIN`, increments retry data, and never submits another order.

### Status mapping

`src/modules/providers/statusMapper.js` is case-insensitive:

| Provider status forms | Local order status |
| --- | --- |
| `accept`, `completed`, `success`, `done`, `ok`, `delivered`, `fulfilled` | `COMPLETED` |
| `wait`, `pending`, `queued`, `processing`, in-progress forms, `PLACEMENT_UNCERTAIN` | `PROCESSING` |
| `partial`, partial-complete forms | `PARTIAL` |
| `cancelled`, `canceled`, `cancel` | `CANCELED` |
| `reject`, `rejected`, `failed`, `error`, `refunded`, `expired` | `FAILED` |
| unknown | `PROCESSING` |

### Retry and refunds

`MAX_RETRY_COUNT` is **24**. The current code has two distinct exhaustion paths:

- At poll start, an already PROCESSING order with `retryCount >= 24` moves to
  `MANUAL_REVIEW` without a provider call or automatic refund. Deferred
  uncertain recovery reaches this path at the limit.
- For an ordinary non-terminal status passed to `processOrderStatusResult()`,
  incrementing retryCount to 24 marks the order `FAILED` and runs the normal
  refund path.

Explicit terminal failed, canceled, and partial outcomes retain their current
refund handling. Uncertain placement alone does not cause a refund.

## Dormant Alternate Poller

`src/modules/orders/orderPolling.service.js` and
`src/modules/orders/orderPolling.job.js` implement another multi-provider
poller. Its `start()` defaults to every minute if explicitly called, but
`server.js` neither imports nor starts it. It is not the polling implementation
used by normal server startup.

## Adapter Error Conventions

There is no shared AppError-based adapter error contract. Concrete adapters use
their own Axios wrappers and result shapes. Legacy `placeOrder()` methods
generally return `{ success: false, ... }` for provider rejection or request
failure; product, check, and balance methods can reject. Fulfillment applies the
local status and refund behavior.
