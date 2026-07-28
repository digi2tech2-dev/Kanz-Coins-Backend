# Database Schema

All collections use **Mongoose ODM** over MongoDB. Unless noted, all schemas include `createdAt` and `updatedAt` via the `{ timestamps: true }` option.

---

## Table of Contents

- [User](#user)
- [OAuthStateNonce](#oauthstatenonce)
- [Group](#group)
- [Product](#product)
- [ProviderProduct](#providerproduct)
- [Provider](#provider)
- [Order](#order)
- [WalletTransaction](#wallettransaction)
- [DepositRequest](#depositrequest)
- [SubAgentRequest](#subagentrequest)
- [Currency](#currency)
- [AuditLog](#auditlog)
- [Setting](#setting)
- [Indexes Summary](#indexes-summary)
- [Schema Relationships](#schema-relationships)

---

## User

**Collection:** `users`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | 2–100 chars |
| `email` | String | ✅ | Unique, lowercase, sparse index |
| `referralCode` | String | ❌ | Immutable public invitation code. Unique sparse index |
| `referredBy` | ObjectId → User | ❌ | Immutable inviter relationship |
| `referredAt` | Date | ❌ | Immutable referral assignment timestamp |
| `password` | String | ❌ | Bcrypt hashed. Omitted for OAuth users. Never returned by default (`select: false`) |
| `googleId` | String | ❌ | Google OAuth sub. Sparse unique index |
| `verified` | Boolean | — | Default `false`. Google users auto-verified |
| `emailVerificationToken` | String | ❌ | SHA-256 hash. `select: false`. Null after verification |
| `emailVerificationExpires` | Date | ❌ | 24hr TTL. `select: false` |
| `role` | String | — | `ADMIN` \| `CUSTOMER`. Default `CUSTOMER` |
| `status` | String | — | `PENDING` \| `ACTIVE` \| `REJECTED`. Default `PENDING` |
| `approvedBy` | ObjectId → User | ❌ | Admin who approved |
| `approvedAt` | Date | ❌ | Timestamp of approval |
| `rejectedBy` | ObjectId → User | ❌ | Admin who rejected |
| `rejectedAt` | Date | ❌ | Timestamp of rejection |
| `groupId` | ObjectId → Group | ✅ | Pricing tier. Auto-assigned on registration |
| `resellerStatus` | String | — | Durable reseller state: `NONE` or `APPROVED` |
| `resellerApprovedAt` | Date | ❌ | Server timestamp set during Sub-Agent approval |
| `referralCommissionStoppedAt` | Date | ❌ | Same timestamp as reseller approval; stops future commissions from this user's deposits |
| `walletBalance` | Number | — | Ledger balance. May be negative when credit is used. Default `0` |
| `creditLimit` | Number | — | Maximum permitted overdraft. Default `0` |
| `creditUsed` | Number | — | Derived reporting mirror of used credit. Default `0` |
| `currency` | String | — | ISO 4217, 3 letters. Default `USD` |
| `country` | String | ❌ | 2-letter country code used by signup/profile completion |
| `deletedAt` | Date | ❌ | Soft-delete timestamp. Null = not deleted |

**Virtuals:**
- `isActive` → `status === 'ACTIVE'` (backward-compat shim)
- `availableBalance` -> `max(0, walletBalance + creditLimit)` rounded to 2 dp
- `availableCredit` -> `max(0, creditLimit - creditUsed)` rounded to 2 dp

**Indexes:**
```
email       unique
referralCode unique sparse
referredBy  1
googleId    unique sparse
status      1
role        1
groupId     1
resellerStatus 1
deletedAt   1 sparse
```

---

## OAuthStateNonce

**Collection:** `oauthstatenonces`

Stores consumed Google OAuth state nonces so callback replay is rejected across all application workers that share MongoDB.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `nonce` | String | yes | Unique state nonce from the signed OAuth payload |
| `expiresAt` | Date | yes | TTL expiry matching the OAuth state expiration |

**Indexes:**
```
nonce      unique
expiresAt  TTL expireAfterSeconds=0
```

---

## Group

**Collection:** `groups`

Pricing tiers. Every user belongs to exactly one group. The group's `percentage` is applied as a markup on top of the product's base price.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | Unique, 2–100 chars |
| `percentage` | Number | ✅ | Non-negative. e.g. `15` means 15% markup |
| `isActive` | Boolean | — | Default `true` |

**Indexes:**
```
name        unique
percentage  -1   (supports "highest percentage" queries for default group)
```

---

## Product

**Collection:** `products`

Admin-curated product catalogue. Decoupled from `ProviderProduct` to allow independent pricing, presentation, and form customization.

### Core Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | Unique, 2–200 chars |
| `description` | String | ❌ | Max 2000 chars |
| `basePrice` | Number | ✅ | USD, non-negative |
| `minQty` | Number | — | Default `1` |
| `maxQty` | Number | — | Default `9999` |
| `category` | String | ❌ | Free-form tag |
| `image` | String | ❌ | Image URL |
| `displayOrder` | Number | — | Sort order. Default `0` |
| `isActive` | Boolean | — | Default `true` |
| `executionType` | String | — | `manual` \| `automatic`. Default `manual` |

### Pricing Mode

| Field | Type | Notes |
|-------|------|-------|
| `pricingMode` | String | `manual` \| `sync`. `sync` auto-updates `basePrice` when the raw provider price changes |
| `markupType` | String | `percentage` \| `fixed` |
| `markupValue` | Number | Default `0` |

### Provider Link

| Field | Type | Notes |
|-------|------|-------|
| `providerProduct` | ObjectId → ProviderProduct | Null for standalone products |
| `createdBy` | ObjectId → User | Admin who created this product |

### Order Fields (Dynamic Form Schema)

`orderFields` is an array of field definition subdocuments:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | String | ✅ | Stable internal identifier (e.g. `"f1"`) |
| `label` | String | ✅ | Human-readable label shown to customer |
| `key` | String | ✅ | Programmatic key (lowercase snake_case, e.g. `player_id`) |
| `type` | String | ✅ | Enum: `text`, `textarea`, `number`, `select`, `url`, `email`, `tel`, `date` |
| `placeholder` | String | ❌ | Input hint text |
| `required` | Boolean | — | Default `true` |
| `options` | [String] | — | Only meaningful for `type=select` |
| `min` | Number | ❌ | Lower bound for `type=number` |
| `max` | Number | ❌ | Upper bound for `type=number` |
| `sortOrder` | Number | — | Default `0` |
| `isActive` | Boolean | — | Default `true` |

### Provider Mapping

```
providerMapping: Map<String, String>
```

Translates internal `orderField.key` values to the parameter names the provider API expects. Example:
```js
{ player_id: "link", server: "server_id" }
```

---

## ProviderProduct

**Collection:** `providerproducts`

Raw inventory data fetched and refreshed by the sync engine. **Never exposed to customers.** Internal to admin and sync systems only.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `provider` | ObjectId → Provider | ✅ | Source provider |
| `externalProductId` | String | ✅ | Provider's own product ID |
| `rawName` | String | ✅ | Name as returned by provider API |
| `translatedName` | String | ❌ | Admin-set friendly name. Never overwritten by sync |
| `rawPrice` | Number | ✅ | Price as returned by provider (USD) |
| `minQty` | Number | — | Default `1` |
| `maxQty` | Number | — | Default `9999` |
| `isActive` | Boolean | — | Provider-reported availability |
| `lastSyncedAt` | Date | ❌ | Most recent sync timestamp |
| `rawPayload` | Mixed | ❌ | Full raw JSON response, preserved verbatim |

**Unique constraint:** `(provider, externalProductId)`

---

## Provider

**Collection:** `providers`

External API connection configuration.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | Unique, 2–100 chars |
| `slug` | String | ❌ | URL-safe key (e.g. `royal-crown`). Auto-generated from `name` on first save |
| `baseUrl` | String | ✅ | API root URL |
| `apiToken` | String | ❌ | Primary authentication token |
| `apiKey` | String | ❌ | Deprecated alias for `apiToken` |
| `isActive` | Boolean | — | Default `true` |
| `syncInterval` | Number | — | Minutes between auto-syncs. `0` = manual only. Default `60` |
| `supportedFeatures` | [String] | — | e.g. `["placeOrder","checkOrder","getBalance"]` |
| `deletedAt` | Date | ❌ | Soft-delete |

**Virtual:** `effectiveToken` → `apiToken || apiKey || null`

---

## Order

**Collection:** `orders`

The single most complex document. Contains full point-in-time snapshots of pricing, group membership, customer inputs, and fulfillment state.

### Identity

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId → User | ✅ | |
| `productId` | ObjectId → Product | ✅ | |
| `quantity` | Number | ✅ | Min 1 |
| `idempotencyKey` | String | ❌ | Sparse unique per `(userId, idempotencyKey)` |

### Pricing Snapshots (Written Once, Immutable)

| Field | Type | Notes |
|-------|------|-------|
| `basePriceSnapshot` | Number | `product.basePrice` at order time |
| `markupPercentageSnapshot` | Number | `group.percentage` at order time |
| `finalPriceCharged` | Number | `basePriceSnapshot × (1 + markup/100)` |
| `groupIdSnapshot` | ObjectId → Group | User's group at order time |
| `unitPrice` | Number | Alias for `finalPriceCharged` (legacy) |
| `totalPrice` | Number | `finalPriceCharged × quantity` |
| `walletDeducted` | Number | Amount taken from wallet (always = `totalPrice`) |
| `creditUsedAmount` | Number | Always `0` (credit system removed) |

### Currency Snapshots (Written Once, Immutable)

| Field | Type | Notes |
|-------|------|-------|
| `currency` | String | User's wallet currency at order time. Default `USD` |
| `rateSnapshot` | Number | `Currency.platformRate` at order time. Default `1` |
| `usdAmount` | Number | Total cost in USD (before currency conversion) |
| `chargedAmount` | Number | Wallet amount deducted in user's currency |

### Status

| Field | Type | Notes |
|-------|------|-------|
| `status` | String | `PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED` |
| `executionType` | String | `manual` \| `automatic` |
| `refundedAt` | Date | Set when wallet is credited back |
| `failedAt` | Date | Set when status moves to FAILED |

### Provider Fulfillment Fields

| Field | Type | Notes |
|-------|------|-------|
| `providerOrderId` | Number | Provider's numeric order ID (null until placed) |
| `providerStatus` | String | Raw status string from provider |
| `providerRawResponse` | Mixed | Full provider JSON response |
| `retryCount` | Number | Status-check attempts. Force-failed at `MAX_RETRY_COUNT` (5) |
| `lastCheckedAt` | Date | Last status poll timestamp |
| `refunded` | Boolean | Idempotency guard for refunds. Default `false` |

### Dynamic Customer Input

| Field | Type | Notes |
|-------|------|-------|
| `customerInput.values` | Mixed | Key→value map of submitted field values. e.g. `{ player_id: "hero_123" }` |
| `customerInput.fieldsSnapshot` | [Mixed] | Simplified copy of active `orderFields` at time of order |

`customerInput` is `null` when the product has no `orderFields`.

**Indexes:**
```
userId + createdAt        compound
status                    1
groupIdSnapshot           1
userId + idempotencyKey   unique sparse  (name: unique_user_idempotency_key)
status + providerOrderId + lastCheckedAt  (name: processing_orders_poll)
```

---

## WalletTransaction

**Collection:** `wallettransactions`

Immutable audit record for every wallet balance change. Never updated or deleted after creation.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId → User | ✅ | |
| `type` | String | ✅ | `CREDIT` \| `DEBIT` \| `REFUND` |
| `amount` | Number | ✅ | Min 0.01 |
| `balanceBefore` | Number | ✅ | Balance before this transaction |
| `balanceAfter` | Number | ✅ | Balance after this transaction |
| `reference` | ObjectId → Order | ❌ | Source order or deposit |
| `status` | String | — | `PENDING` \| `COMPLETED` \| `FAILED`. Default `COMPLETED` |
| `description` | String | ❌ | Max 255 chars |

**Indexes:**
```
userId + createdAt   compound
reference            1
```

---

## DepositRequest

**Collection:** `depositrequests`

Manual funding requests submitted by customers and reviewed by admins.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId → User | ✅ | |
| `status` | String | — | `PENDING` \| `APPROVED` \| `REJECTED`. Default `PENDING` |
| `amountRequested` | Number | ✅ | > 0 |
| `amountApproved` | Number | ❌ | Set on approval. May differ from requested amount |
| `transferImageUrl` | String | ✅ | URL of transfer receipt screenshot (max 2048 chars) |
| `transferredFromNumber` | String | ✅ | Sender account/phone (max 100 chars) |
| `reviewedBy` | ObjectId → User | ❌ | Admin who reviewed |
| `reviewedAt` | Date | ❌ | Timestamp of review |

**Virtuals:** `isApproved`, `isRejected`, `isPending`

**State machine:** `PENDING → APPROVED` or `PENDING → REJECTED`. Both transitions are one-way.

**Indexes:**
```
status + createdAt      (admin pending queue)
userId + createdAt -1   (customer history)
```

---

## SubAgentRequest

**Collection:** `subagentrequests`

Customer-submitted request history for becoming an approved reseller/sub-agent.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId -> User | yes | Request owner |
| `status` | String | yes | `PENDING`, `APPROVED`, `REJECTED`; default `PENDING` |
| `notes` | String | yes | Customer message, max 1000 chars |
| `proofPath` | String | yes | Relative upload path only |
| `proofFileName` | String | yes | Generated filename |
| `proofMimeType` | String | yes | JPEG, PNG, or WebP |
| `proofSize` | Number | yes | Uploaded file size |
| `requestedGroupId` | ObjectId -> Group | no | Reserved snapshot, currently null |
| `approvedGroupId` | ObjectId -> Group | no | Group selected during approval |
| `reviewedBy` | ObjectId -> User | no | Admin/supervisor reviewer |
| `reviewedAt` | Date | no | Server review timestamp |
| `rejectionReason` | String | no | Customer-visible rejection reason, max 500 chars |

**Indexes:**
```
userId
userId + status unique partial where status = PENDING
status + createdAt -1
reviewedAt -1
```

---

## Currency

**Collection:** `currencies`

Two-layer exchange rate system. Products are priced in USD internally; `platformRate` converts to user currency at order time.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | String | ✅ | ISO 4217, e.g. `USD`, `SAR`. Unique |
| `name` | String | ✅ | e.g. `"Saudi Riyal"` |
| `symbol` | String | ✅ | e.g. `"﷼"` |
| `marketRate` | Number | ❌ | Raw rate from external exchange API. 1 USD = N units |
| `platformRate` | Number | ✅ | Admin-controlled rate used in all billing calculations |
| `markupPercentage` | Number | — | Admin spread on top of market rate. Default `0` |
| `isActive` | Boolean | — | Default `true` |
| `lastUpdatedAt` | Date | ❌ | Last time rates were synced/updated |

**Virtuals:**
- `effectiveRate` = `marketRate × (1 + markupPercentage/100)`
- `spreadPercent` = `((platformRate - marketRate) / marketRate) × 100`

---

## AuditLog

**Collection:** `auditlogs`

Immutable event records. The schema's pre-hooks block all update/delete operations at the database level.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `actorId` | ObjectId → User | ❌ | Who performed the action |
| `actorRole` | String | ❌ | `ADMIN` \| `CUSTOMER` \| `SYSTEM` |
| `action` | String | ✅ | Enum of ALL_ACTIONS constants |
| `entityType` | String | ✅ | Enum: `USER`, `ORDER`, `PRODUCT`, `WALLET`, `DEPOSIT`, `PROVIDER`, `SETTING` |
| `entityId` | ObjectId | ❌ | The affected document's ID |
| `metadata` | Mixed | ❌ | Contextual data. Sensitive keys auto-redacted |
| `ipAddress` | String | ❌ | Client IP |
| `userAgent` | String | ❌ | Client user-agent string |

**Notable audit actions:**
`USER_REGISTERED`, `USER_LOGIN`, `USER_LOGIN_BLOCKED`, `USER_APPROVED`, `USER_REJECTED`, `ORDER_CREATED`, `WALLET_DEBIT`, `WALLET_CREDIT`, `ORDER_REFUNDED`, `DEPOSIT_REQUESTED`, `DEPOSIT_APPROVED`, `DEPOSIT_REJECTED`, `PROVIDER_ORDER_PLACED`, `PROVIDER_ORDER_PLACE_FAILED`

---

## Setting

**Collection:** `settings`

Key-value store for runtime platform configuration. Seeded with defaults on startup (idempotent).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `key` | String | ✅ | Unique identifier |
| `value` | Mixed | ✅ | Boolean, number, string, or object |
| `description` | String | ❌ | Human-readable setting description |
| `updatedBy` | ObjectId → User | ❌ | Last admin who changed this setting |

---

## Indexes Summary

| Collection | Index | Type |
|-----------|-------|------|
| `users` | `email` | unique |
| `users` | `googleId` | unique sparse |
| `users` | `status`, `role`, `groupId` | single |
| `orders` | `userId + createdAt` | compound |
| `orders` | `userId + idempotencyKey` | unique sparse |
| `orders` | `status + providerOrderId + lastCheckedAt` | compound (cron) |
| `providerproducts` | `provider + externalProductId` | unique |
| `wallettransactions` | `userId + createdAt` | compound |
| `depositrequests` | `status + createdAt` | compound |
| `depositrequests` | `userId + createdAt` | compound |
| `subagentrequests` | `userId + status` where `status = PENDING` | partial unique |
| `subagentrequests` | `status + createdAt`, `reviewedAt` | compound/single |

---

## Schema Relationships

```
Group ←────────── User ←────────── Order ──────────────── Product
                    │                │                        │
                    │                └──── WalletTransaction  │
                    │                                         │
                    └──────────── DepositRequest         ProviderProduct
                    └──────────── SubAgentRequest
                                                               │
                                                           Provider
```

- Every `User` belongs to one `Group`
- Every `Order` references one `User` and one `Product` (snapshot-frozen at creation)
- Every `Order` may reference one `WalletTransaction` (debit), and another on refund
- Every `SubAgentRequest` references one `User`; approval snapshots an existing `Group`
- Every `Product` may link to one `ProviderProduct`
- Every `ProviderProduct` belongs to one `Provider`
- `AuditLog` references any entity by `entityId + entityType` (polymorphic, no FK)
