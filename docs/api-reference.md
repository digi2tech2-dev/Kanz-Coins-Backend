# API Reference

All endpoints are prefixed with `/api`. All request/response bodies are `application/json` unless noted.

**Authentication:** Include the JWT in the `Authorization` header:
```
Authorization: Bearer <token>
```

**Standard response envelope:**
```json
{ "success": true, "message": "...", "data": { ... } }
```
**Paginated response envelope:**
```json
{
  "success": true,
  "data": [...],
  "pagination": { "page": 1, "limit": 20, "total": 47, "pages": 3 }
}
```
**Error response:**
```json
{ "success": false, "message": "...", "code": "MACHINE_CODE", "statusCode": 422 }
```

> Canonical B2B API documentation is separate because it uses an API-token
> compatibility contract rather than this JWT envelope. See
> [`client-compat-api.md`](client-compat-api.md) for `/client/api`.

---

## Table of Contents

- [Authentication](#authentication)
- [User Panel — /api/me](#user-panel--apime)
- [Orders](#orders)
- [Products (Public)](#products-public)
- [Wallet](#wallet)
- [Deposits](#deposits)
- [Admin — Users](#admin--users)
- [Admin — Orders](#admin--orders)
- [Admin — Wallets](#admin--wallets)
- [Admin — Products & Catalog](#admin--products--catalog)
- [Admin — Providers](#admin--providers)
- [Admin — Deposits](#admin--deposits)
- [Admin — Groups](#admin--groups)
- [Admin — Currencies](#admin--currencies)
- [Admin — Settings](#admin--settings)
- [Admin — Audit Logs](#admin--audit-logs)

---

## Authentication

### POST /api/auth/register

Create a new customer account. Sends an email verification link.

**Body:**
```json
{ "name": "John Doe", "email": "john@example.com", "password": "securepass123" }
```
**Response `201`:**
```json
{
  "success": true,
  "message": "Registration successful. Please check your email to verify your account.",
  "data": { "user": { "_id": "...", "name": "John Doe", "email": "john@example.com", "status": "PENDING" } }
}
```
**Errors:** `400 VALIDATION_ERROR`, `409 CONFLICT` (email taken)

---

### POST /api/auth/login

Authenticate and receive a JWT. Requires email verification and admin approval.

**Body:**
```json
{ "email": "john@example.com", "password": "securepass123" }
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGci...",
    "user": { "_id": "...", "name": "John Doe", "role": "CUSTOMER", "status": "ACTIVE" }
  }
}
```
**Errors:** `400 VALIDATION_ERROR`, `401 AUTHENTICATION_ERROR`, `403` (not verified / not approved)

---

### GET /api/auth/verify-email?token=RAW_TOKEN

Verify email address via the link in the registration email.

**Response `200`:**
```json
{ "success": true, "message": "Email verified successfully. Your account is now pending admin approval." }
```
**Errors:** `400` (invalid or expired token)

---

### POST /api/auth/resend-verification

Re-send the email verification link.

**Body:** `{ "email": "john@example.com" }`

**Response `200`:** `{ "success": true, "message": "Verification email resent." }`

---

### GET /api/auth/google

Redirect to Google consent screen. Requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to be configured.

---

### GET /api/auth/google/callback

Google OAuth callback. Returns JWT + user on success.

**Response `200`:**
```json
{ "success": true, "data": { "token": "...", "user": { ... } } }
```

---

## User Panel — /api/me

All routes require `Authorization: Bearer <token>` and `status === ACTIVE`.

### GET /api/me

Returns authenticated user's profile and wallet balance.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "...", "name": "John Doe", "email": "john@example.com",
      "walletBalance": 150.00, "currency": "USD",
      "role": "CUSTOMER", "status": "ACTIVE"
    }
  }
}
```

---

### GET /api/me/wallet

Wallet summary with 5 most recent transactions.

**Response `200`:**
```json
{
  "data": {
    "walletBalance": 150.00,
    "currency": "USD",
    "recentTransactions": [ { "type": "DEBIT", "amount": 10, "createdAt": "..." } ]
  }
}
```

---

### GET /api/me/wallet/transactions

Paginated wallet transaction history.

**Query:** `?page=1&limit=20`

**Response `200`:** Paginated list of `WalletTransaction` documents.

---

### GET /api/me/products

Browse the active product catalogue.

**Query:** `?search=diamonds&page=1&limit=20`

**Response `200`:**
```json
{
  "data": [
    {
      "_id": "...", "name": "Free Fire Diamonds", "basePrice": 9.99,
      "category": "games", "orderFields": [ ... ]
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "pages": 1 }
}
```

---

### GET /api/me/products/:id

Single product detail including `orderFields`.

**Response `200`:**
```json
{
  "data": {
    "product": {
      "_id": "...", "name": "Free Fire Diamonds",
      "orderFields": [
        { "id": "f1", "key": "player_id", "label": "Player ID", "type": "text", "required": true },
        { "id": "f2", "key": "server", "label": "Server", "type": "select", "options": ["NA","EU"] }
      ]
    }
  }
}
```

**Errors:** `404 NOT_FOUND`

---

### POST /api/me/orders

Place an order. Validates dynamic fields, debits wallet, and (for automatic products) dispatches to the provider.

**Body:**
```json
{
  "productId": "64abc...",
  "quantity": 1,
  "orderFieldsValues": {
    "player_id": "hero_123",
    "server": "EU"
  },
  "idempotencyKey": "client-generated-uuid"
}
```

**Response `201`:**
```json
{
  "success": true,
  "message": "Order placed successfully.",
  "data": {
    "order": {
      "_id": "...",
      "status": "PENDING",
      "totalPrice": 10.99,
      "customerInput": {
        "values": { "player_id": "hero_123", "server": "EU" },
        "fieldsSnapshot": [ { "key": "player_id", "label": "Player ID", "type": "text" } ]
      }
    }
  }
}
```

**Errors:**
| Code | Meaning |
|------|---------|
| `400 VALIDATION_ERROR` | `productId` or `quantity` invalid |
| `404 NOT_FOUND` | Product not found or inactive |
| `422 INVALID_ORDER_FIELDS` | Dynamic field validation failed |
| `422 INSUFFICIENT_FUNDS` | Wallet balance too low |
| `422 BUSINESS_RULE_VIOLATION` | Product inactive, qty out of range, etc. |
| `409 CONFLICT` | Duplicate idempotency key |

---

### GET /api/me/orders

My order history.

**Query:** `?status=COMPLETED&page=1&limit=20`

**Response `200`:** Paginated list of orders.

---

### GET /api/me/orders/:id

Single order detail (ownership enforced — cannot view other users' orders).

**Errors:** `403 AUTHORIZATION_ERROR`, `404 NOT_FOUND`

---

### POST /api/me/deposits

Submit a wallet deposit request. Accepts multipart/form-data (with screenshot) or JSON (with URL).

**Body (multipart/form-data):**
```
amountRequested: 100
transferredFromNumber: "+1-555-0100"
screenshotProof: <file>
```

**Body (application/json):**
```json
{
  "amountRequested": 100,
  "transferredFromNumber": "+1-555-0100",
  "transferImageUrl": "https://cdn.example.com/receipt.jpg"
}
```

**Response `201`:**
```json
{
  "data": {
    "deposit": {
      "_id": "...", "status": "PENDING",
      "amountRequested": 100, "createdAt": "..."
    }
  }
}
```

---

### GET /api/me/deposits

My deposit history (paginated).

---

### GET /api/me/deposits/:id

Single deposit detail (ownership enforced).

---

## Orders

Legacy/direct order endpoints (also covered by `/api/me/orders`).

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/orders` | Active Customer | Place order |
| `GET` | `/api/orders/my` | Active Customer | My orders |
| `GET` | `/api/orders/my/:id` | Active Customer | My order by ID |
| `GET` | `/api/orders` | Admin | All orders |
| `GET` | `/api/orders/:id` | Admin | Any order by ID |
| `PATCH` | `/api/orders/:id/fail` | Admin | Mark failed + refund |
| `PATCH` | `/api/orders/:id/complete` | Admin | Mark completed |

---

## Products (Public)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/products` | Any | Active product list |
| `GET` | `/api/products/:id` | Any | Product detail |

---

## Admin — Users

All admin routes require `Authorization: Bearer <admin-token>`.

### GET /api/admin/users

List users with pagination and filters.

**Query:** `?status=PENDING&email=john&page=1&limit=20`

**Response `200`:** Paginated user list.

---

### GET /api/admin/users/:id

Full user detail including group population.

---

### PATCH /api/admin/users/:id

Update user profile.

**Body:** `{ "name": "Updated Name", "status": "ACTIVE" }`

**Errors:** `409 CONFLICT` (email), `400 VALIDATION_ERROR`

---

### DELETE /api/admin/users/:id

Soft-delete a user (sets `deletedAt`). Cannot delete admins.

**Errors:** `422 CANNOT_DELETE_ADMIN`

---

### PATCH /api/admin/users/:id/approve

Approve a PENDING user (allows login).

---

### PATCH /api/admin/users/:id/reject

Reject a user (blocks login).

---

## Admin — Orders

### GET /api/admin/orders

**Query:** `?status=PROCESSING&userId=...&page=1&limit=50`

---

### GET /api/admin/orders/:id

Full order detail including `customerInput`.

---

### POST /api/admin/orders/:id/retry

Retry a FAILED automatic order (re-dispatches to provider).

---

### POST /api/admin/orders/:id/refund

Manually fully refund an order.

---

## Admin — Wallets

### GET /api/admin/wallets

Paginated list of all user wallets.

---

### GET /api/admin/wallets/:userId

Single user wallet summary.

---

### GET /api/admin/wallets/:userId/transactions

Paginated transaction history for a user.

---

### POST /api/admin/wallets/:userId/add

Credit a user's wallet.

**Body:** `{ "amount": 100, "reason": "Manual top-up" }`

**Errors:** `422` (amount <= 0 or > 100000)

---

### POST /api/admin/wallets/:userId/deduct

Debit a user's wallet.

**Body:** `{ "amount": 50, "reason": "Correction" }`

**Errors:** `422 INSUFFICIENT_BALANCE`

---

## Admin — Products & Catalog

### GET /api/admin/products

All products including inactive.

**Query:** `?page=1&limit=50`

---

### POST /api/admin/products

Create a standalone platform product (no provider link required).

**Body:**
```json
{
  "name": "Free Fire Diamonds",
  "basePrice": 9.99,
  "minQty": 1,
  "maxQty": 10000,
  "description": "Instant delivery",
  "category": "games",
  "executionType": "automatic",
  "orderFields": [
    {
      "id": "f1", "key": "player_id", "label": "Player ID",
      "type": "text", "required": true, "isActive": true
    }
  ],
  "providerMapping": { "player_id": "link" }
}
```

**Response `201`:** Newly created product document.

---

### POST /api/admin/products/from-provider

Publish a provider product as a platform product.

**Body:**
```json
{
  "providerProductId": "64abc...",
  "name": "Custom Name",
  "basePrice": 9.99,
  "pricingMode": "manual",
  "executionType": "automatic"
}
```

---

### PATCH /api/admin/products/:id

Update a product. Supports partial updates.

**Body (any subset):**
```json
{
  "name": "New Name",
  "isActive": true,
  "orderFields": [ ... ],
  "providerMapping": { "player_id": "link" }
}
```

---

### PATCH /api/admin/products/:id/toggle

Toggle `isActive` flag.

---

### POST /api/admin/catalog/sync

Sync all active providers.

**Response `200`:**
```json
{
  "data": {
    "results": [
      { "providerId": "...", "name": "Royal Crown", "synced": 45, "errors": 0 }
    ]
  }
}
```

---

### POST /api/admin/catalog/sync/:providerId

Sync a single provider.

---

### GET /api/admin/provider-products

All raw provider products.

**Query:** `?page=1&limit=50`

---

### GET /api/admin/provider-products/:providerId

Raw products for one provider.

---

### GET /api/admin/provider-products/item/:id

Single raw provider product by internal ID.

---

### PATCH /api/admin/provider-products/item/:id/translated-name

Set a human-friendly name override (not overwritten by future syncs).

**Body:** `{ "translatedName": "Free Fire Diamonds 100" }`

---

## Admin — Providers

### GET /api/admin/providers

List all providers.

---

### POST /api/admin/providers

Create a new provider.

**Body:**
```json
{
  "name": "Royal Crown",
  "baseUrl": "https://royal-croown.com",
  "apiToken": "secret123",
  "syncInterval": 60
}
```

---

### GET /api/admin/providers/:id

Provider detail.

---

### PATCH /api/admin/providers/:id

Update provider.

---

### DELETE /api/admin/providers/:id

Soft-delete provider.

---

### PATCH /api/admin/providers/:id/toggle

Toggle `isActive`.

---

### GET /api/admin/providers/:id/balance

Fetch live balance from the provider API.

**Response `200`:**
```json
{ "data": { "balance": 1250.50, "currency": "USD" } }
```

---

### GET /api/admin/providers/:id/products

Fetch live product list directly from the provider API (not from cached ProviderProducts).

---

## Admin — Deposits

### GET /api/admin/deposits

**Query:** `?status=PENDING&page=1&limit=20`

---

### GET /api/admin/deposits/:id

Single deposit detail.

---

### PATCH /api/admin/deposits/:id/approve

Approve a deposit. Atomically credits the user's wallet.

**Body:** `{ "overrideAmount": 95 }` (optional — use to correct the amount)

**Response `200`:**
```json
{ "message": "Deposit approved and wallet credited.", "data": { ... } }
```

**Errors:** `422 DEPOSIT_ALREADY_APPROVED`, `422 DEPOSIT_ALREADY_REJECTED`

---

### PATCH /api/admin/deposits/:id/reject

Reject a deposit (wallet not affected).

**Errors:** `422 DEPOSIT_ALREADY_REJECTED`, `422 DEPOSIT_ALREADY_APPROVED`

---

## Admin — Groups

### GET /api/admin/groups

All groups including inactive.

---

### POST /api/admin/groups

**Body:** `{ "name": "VIP", "percentage": 5 }`

---

### PATCH /api/admin/groups/:id

**Body:** `{ "percentage": 10, "isActive": true }`

---

### DELETE /api/admin/groups/:id

Deactivate a group (sets `isActive: false`).

---

## Admin — Currencies

### GET /api/admin/currencies

All currencies sorted by code.

---

### PATCH /api/admin/currencies/:code

Update a currency's platform rate.

**Body:**
```json
{ "platformRate": 3.75, "markupPercentage": 2, "isActive": true }
```

---

## Admin — Settings

### GET /api/admin/settings

All settings.

---

### GET /api/admin/settings/:key

Single setting by key.

---

### PATCH /api/admin/settings/:key

Update a setting value.

**Body:** `{ "value": true }` or `{ "value": 42 }` or `{ "value": "some-string" }`

---

## Admin — Audit Logs

### GET /api/admin/audit

Query audit logs by entity.

**Query:** `?entityType=ORDER&entityId=64abc...&page=1&limit=50`

---

### GET /api/admin/audit/actor/:actorId

All audit logs for a specific actor (admin).

**Query:** `?page=1&limit=50`
