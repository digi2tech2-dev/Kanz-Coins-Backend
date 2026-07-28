# Wallet System

## Current Wallet-Balance Contract

`walletBalance` is the actual wallet ledger balance. It can be positive, zero, or negative when a user spends against `creditLimit`.

Canonical reporting fields:

```text
walletBalance = actual ledger balance
creditLimit = maximum permitted overdraft
creditUsed = max(0, min(abs(walletBalance), creditLimit)) when walletBalance is negative, otherwise 0
availableCredit = max(0, creditLimit - creditUsed)
availableBalance = max(0, walletBalance + creditLimit)
coins = legacy auth/profile alias for walletBalance
balance = legacy auth/profile alias for walletBalance
```

Reseller and client compatibility balance endpoints expose one `balance` field; on those endpoints `balance` means spendable balance (`availableBalance`).

Example:

```json
{
  "walletBalance": -30,
  "creditLimit": 100,
  "creditUsed": 30,
  "availableCredit": 70,
  "availableBalance": 70,
  "coins": -30,
  "balance": -30,
  "currency": "USD"
}
```

Public API `availableBalance` is clamped to zero for legacy overdrawn data. Internal affordability remains authoritative and compares the raw sum `walletBalance + creditLimit >= authoritativeCost`.

Order affordability and pricing are backend-authoritative. Customer-supplied fields such as `walletBalance`, `creditLimit`, `creditUsed`, `availableBalance`, `balance`, `coins`, or `totalPrice` are ignored for purchase validation.

## Overview

Every user has an embedded wallet (`walletBalance` on the `User` document). All financial operations — order debits, refunds, and deposit credits — are implemented as single atomic MongoDB aggregation-pipeline updates, eliminating all race conditions without requiring a distributed lock.

---

## Design Principles

1. **Wallet-only policy** — orders succeed only when `walletBalance >= orderAmount`. The balance can never go negative.
2. **Atomic operations** — every balance change is a single `findOneAndUpdate` with an aggregation pipeline. The check and the update are inseparable.
3. **Immutable audit trail** — every balance change creates a `WalletTransaction` document that is never modified after creation.
4. **Session-scoped** — all wallet functions require a `ClientSession`. They must be called inside a MongoDB transaction so the balance change and the associated document write (order, deposit) are atomic.

---

## Three Operations

### 1. `debitWalletAtomic` — Order Payments

**File:** `src/modules/wallet/wallet.service.js`

Called by `order.service.js` inside the order-creation transaction.

```js
const { walletDeducted, creditUsedAmount, transaction } = await debitWalletAtomic({
    userId,
    amount,         // total order cost in user currency
    reference,      // order._id (set via update after order creation)
    description,    // e.g. "Order payment for Free Fire Diamonds"
    session,        // REQUIRED — MongoDB ClientSession
});
```

**Internal logic:**

```js
User.findOneAndUpdate(
    {
        _id: userId,
        status: 'ACTIVE',               // must be active
        walletBalance: { $gte: amount } // sufficient funds check
    },
    [{
        $set: {
            walletBalance: { $subtract: ['$walletBalance', amount] }
        }
    }],
    { new: false, session }             // pre-update doc for audit
)
```

If the `findOneAndUpdate` returns `null`:
- A second query checks whether the user exists and is active
- If active but insufficient: throws `InsufficientFundsError(required, available)`
- If inactive: throws `BusinessRuleError('ACCOUNT_INACTIVE')`
- If not found: throws `NotFoundError('User')`

**Returns:**
```js
{
    walletDeducted: amount,   // always equals the debit amount
    creditUsedAmount: 0,      // always 0 (credit system removed)
    transaction: WalletTransaction
}
```

---

### 2. `refundWalletAtomic` — Order Refunds

Called when an order fails (during fulfillment or via admin action).

```js
const { transaction } = await refundWalletAtomic({
    userId,
    walletDeducted,      // from order.walletDeducted
    creditUsedAmount,    // from order.creditUsedAmount (always 0)
    reference,           // order._id
    description,
    session,
});
```

**Internal logic:**

```js
User.findOneAndUpdate(
    { _id: userId },
    [{
        $set: {
            walletBalance: { $add: ['$walletBalance', walletDeducted] },
            creditUsed: {
                $max: [0, { $subtract: ['$creditUsed', creditUsedAmount] }]
            }
        }
    }],
    { new: false, session }
)
```

The `$max: [0, ...]` clamp on `creditUsed` guards against any numeric edge case.

**Idempotency guard:** Before calling `refundWalletAtomic`, the fulfillment service checks `order.refunded === true`. If already `true`, the refund is skipped — preventing double-refunds in retry scenarios.

---

### 3. `creditWalletDirect` — Deposit Top-Ups

Called when an admin approves a deposit request.

```js
const { transaction } = await creditWalletDirect({
    userId,
    amount,         // amountApproved (may differ from amountRequested)
    reference,      // depositRequest._id
    description,    // "Deposit approved by admin"
    session,
});
```

**Internal logic:**

```js
User.findOneAndUpdate(
    { _id: userId },
    [{
        $set: {
            walletBalance: { $add: ['$walletBalance', amount] }
        }
    }],
    { new: false, session }
)
```

No status check is required here — admin-approved deposits credit the wallet unconditionally.

---

## WalletTransaction Model

Every balance change writes an immutable `WalletTransaction` record:

```json
{
  "_id":           "64def...",
  "userId":        "64abc...",
  "type":          "DEBIT",
  "amount":        10.99,
  "balanceBefore": 150.00,
  "balanceAfter":  139.01,
  "reference":     "64ord...",
  "status":        "COMPLETED",
  "description":   "Order payment for Free Fire Diamonds",
  "createdAt":     "2024-03-10T04:00:00Z"
}
```

| Type | When Created |
|------|-------------|
| `DEBIT` | Order placed |
| `REFUND` | Order failed / manual admin refund |
| `CREDIT` | Deposit approved / admin manually adds funds |

Indexes ensure fast per-user history queries:
```
userId + createdAt DESC  → transaction history
reference               → look up by order ID
```

---

## Transaction History

```js
getTransactionHistory(userId, { page = 1, limit = 20 })
```

Returns paginated transactions sorted newest-first, with the referenced order populated (`status`, `totalPrice`).

### Customer API

```http
GET /api/me/wallet/transactions?page=1&limit=20
```

### Admin API

```http
GET /api/admin/wallets/:userId/transactions?page=1&limit=50
```

---

## Admin Direct Wallet Adjustments

Admins can add or deduct funds outside the normal order/deposit flow. Both operations use the same atomic wrappers.

### Add Funds

```http
POST /api/admin/wallets/:userId/add
{
  "amount": 100,
  "reason": "Promotional credit"
}
```

→ Calls `creditWalletDirect()` inside a session.
→ Writes a `CREDIT` WalletTransaction.

### Deduct Funds

```http
POST /api/admin/wallets/:userId/deduct
{
  "amount": 50,
  "reason": "Correction"
}
```

→ Calls `debitWalletAtomic()` inside a session.
→ Writes a `DEBIT` WalletTransaction.
→ Fails with `422 INSUFFICIENT_BALANCE` if wallet is too low.

---

## Currency Handling

Users hold wallets in their own currency (e.g. SAR, EGP, USD). Product prices are always in USD internally. At order creation:

```
usdAmount    = finalPriceUSD × quantity
rateSnapshot = Currency.platformRate  (at that moment)
chargedAmount = usdAmount × rateSnapshot
```

The wallet is debited `chargedAmount` in the user's currency. All three values are frozen on the order document.

### Currency Conversion Example

```
Product basePrice:   $9.99 USD
User markup:         15%
USD order total:     $11.49 USD

User currency: SAR
platformRate: 3.75 SAR/USD
Charged:  11.49 × 3.75 = 43.09 SAR
```

The user's wallet is debited **43.09 SAR**.

---

## Deposit Request Flow

```
Customer POSTs deposit request
    amountRequested: 100
    transferredFromNumber: "+1-555-0100"
    screenshotProof: <file>    ← multer uploads to /uploads/
              │
              ▼
DepositRequest created (status=PENDING)
              │
    (Admin reviews uploaded screenshot)
              │
              ▼
Admin: PATCH /api/admin/deposits/:id/approve
    { overrideAmount: 95 }    ← optional amount override
              │
              ▼ Inside MongoDB session:
    creditWalletDirect({ userId, amount: 95 })
    DepositRequest.status = APPROVED
    DepositRequest.amountApproved = 95
    DepositRequest.reviewedBy = adminId
    DepositRequest.reviewedAt = now
    AuditLog written
              │
              ▼
User wallet balance += 95
WalletTransaction (CREDIT) created
```

### Rejected Deposit

```
Admin: PATCH /api/admin/deposits/:id/reject
    → DepositRequest.status = REJECTED
    → Wallet NOT credited
    → AuditLog written
```

---

## State Invariants

| Invariant | Enforced By |
|-----------|-------------|
| `walletBalance >= 0` | Atomic update filter: `walletBalance: { $gte: amount }` |
| No double-debit per order | MongoDB transaction rolls back entire session on error |
| No double-refund | `order.refunded` boolean checked before `refundWalletAtomic()` |
| No double-deposit-approval | `DepositRequest.status` checked; `ALREADY_APPROVED` error thrown |
| All money changes audited | `_createTransactionRecord` called inside every wallet function |

---

## Edge Cases

### Concurrent Orders Same User

Two simultaneous orders from the same user both reach `debitWalletAtomic`. MongoDB processes them sequentially (document-level lock). Only one will see `walletBalance >= amount` after the first debit — the second correctly throws `InsufficientFundsError`.

### Refund to Deleted User

`refundWalletAtomic` does not check `status` — it always restores the balance. Even if a user account is soft-deleted, the refund is credited back. The referenced `WalletTransaction` preserves the audit trail.

### Zero-Amount Guard

Both `debitWalletAtomic` and `creditWalletDirect` throw `BusinessRuleError('INVALID_AMOUNT')` if `amount <= 0`, preventing silent no-ops.

### Session Requirement

All three wallet functions hard-require `session`. If called without one, they throw `BusinessRuleError('SESSION_REQUIRED')` immediately — preventing unchecked balance changes outside of MongoDB transactions.
