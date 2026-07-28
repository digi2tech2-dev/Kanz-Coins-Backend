# Referral Payout System

This document covers the first backend-only referral payout phase. It does not implement frontend real-data integration, referral payout automation, Vodafone Cash automation, WhatsApp payout notifications, sub-agent payouts, or commission wallet payouts before admin review.

## Model Contract

`ReferralPayout` stores one customer payout request for locked referral commissions.

Core fields:

- `userId`: payout owner.
- `method`: `WALLET_CREDIT` or `MANUAL_EXTERNAL`.
- `currency`: ISO 4217 currency for all selected commissions.
- `amount`: backend-computed decimal string total of selected commission amounts.
- `status`: `PENDING`, `PAID`, or `REJECTED`.
- `commissionIds`: immutable selected `ReferralCommission` IDs.
- `commissionCount`: immutable selected commission count.
- `externalPaymentDetails`: stored manual destination details for admin detail views only.
- `externalPaymentSummary`: masked destination summary for list/customer views.
- `walletTransactionId`: set only for paid wallet-credit payouts.
- `externalTransactionReference` and payment-proof metadata: set only for manual external payment review when provided.
- `idempotencyKey` and `idempotencyFingerprint`: optional customer request replay control.

Commission locking:

- Creating a payout changes every selected commission from `AVAILABLE` to `LOCKED` and writes `payoutRequestId`.
- Rejection changes those commissions back to `AVAILABLE` and clears `payoutRequestId`.
- Payment changes those commissions to `PAID`.
- `ReferralCommission.payoutRequestId` references `ReferralPayout`.

## Customer API

Mounted under authenticated active-user `/api/me`.

Create:

```http
POST /api/me/referral-payouts
Content-Type: application/json
```

Explicit commission selection:

```json
{
  "method": "wallet",
  "currency": "USD",
  "commissionIds": ["64f000000000000000000001"],
  "idempotencyKey": "customer-generated-key-001"
}
```

Amount-only compatibility:

```json
{
  "method": "vodafone",
  "currency": "EGP",
  "amount": "25.000000",
  "name": "Account Holder",
  "phone": "01000000000"
}
```

Amount-only mode selects oldest whole available commissions only when their exact total equals the requested amount. Otherwise it returns `PAYOUT_AMOUNT_REQUIRES_COMMISSION_SELECTION`.

List and detail:

```http
GET /api/me/referral-payouts?page=1&limit=20&status=pending&method=wallet&currency=USD
GET /api/me/referral-payouts/:id
```

Customers can only see their own payout records. List responses contain masked external-payment summaries and never expose another user's payout.

## Admin API

Mounted under `/api/admin` for `ADMIN`/`SUPERVISOR` users with `MANAGE_WALLET`.

```http
GET /api/admin/referral-payouts
GET /api/admin/referral-payouts/:id
PATCH /api/admin/referral-payouts/:id/reject
PATCH /api/admin/referral-payouts/:id/pay-wallet
PATCH /api/admin/referral-payouts/:id/mark-paid
```

Reject body:

```json
{
  "reason": "Invalid payout destination"
}
```

Manual paid body supports optional multipart receipt fields `receiptImage`, `receipt`, or `paymentProof` and optional reference aliases:

```json
{
  "externalTransactionReference": "manual-bank-reference"
}
```

Manual external payment is record-only. The backend never contacts banks, Vodafone Cash, InstaPay, USDT networks, WhatsApp, or external providers.

## Transactions

All financial state transitions use one MongoDB session transaction:

- Payout creation: commission claim plus `ReferralPayout` creation.
- Rejection: payout status update plus commission release.
- Wallet payment: pending payout claim, wallet balance credit, wallet transaction creation, commission status update, and payout finalization.
- Manual payment: pending payout claim, commission status update, and payout finalization.

Post-commit audit and notification-style side effects are outside the financial transaction. A post-commit side-effect failure is logged and does not roll back committed financial records.

Wallet payout ledger entries use:

```text
sourceType = REFERRAL_PAYOUT
sourceId = payout._id
sourceKey = referral:payout:<payoutId>:wallet-credit
```

`WalletTransaction.sourceKey` has a partial unique index to prevent duplicate wallet credits for the same payout.

## External Payment Validation

Manual payout destination details are allowlisted:

```text
methodType
accountName
phoneNumber
accountNumber
iban
walletAddress
network
notes
```

Forbidden keys include:

```text
__proto__
prototype
constructor
cvv
cvc
pin
password
otp
secret
token
```

Nested objects are rejected. Customer list responses expose masked summaries only. Admin detail can view full stored destination details for payout processing.

Receipt uploads are optional, image-only, max 5 MB, and are checked by MIME type, extension, and image magic bytes. Accepted formats are JPEG, PNG, and WebP.

## Idempotency

Customer `idempotencyKey` is optional. Missing and blank keys are stored as missing, so customers can create multiple payout requests without a key.

When present:

- Key length is 8-128 characters.
- Allowed characters are letters, digits, `.`, `_`, `:`, and `-`.
- The unique index is scoped to `{ userId, idempotencyKey }`.
- Replaying the same normalized payload returns the existing payout.
- Reusing the same key with a different method, currency, commission selection, amount-only request, or external details returns `PAYOUT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.

## Summary Contract

`GET /api/me/referral-commissions/summary` preserves the existing `summary` field and adds grouped payout-ready totals:

```json
{
  "summary": { "...": "existing commission summary" },
  "availableEarnings": { "USD": "10.000000" },
  "lockedEarnings": { "USD": "5.000000" },
  "paidEarnings": { "USD": "20.000000" }
}
```

Totals are grouped by `ReferralCommission.referrerCurrency`; currencies are not mixed in a payout.

## Indexes

New/changed indexes:

- `ReferralPayout`: `{ userId: 1, createdAt: -1 }`.
- `ReferralPayout`: `{ status: 1, createdAt: -1 }`.
- `ReferralPayout`: `{ method: 1, status: 1, createdAt: -1 }`.
- `ReferralPayout`: partial unique `{ userId: 1, idempotencyKey: 1 }` where `idempotencyKey` is a string.
- `ReferralPayout`: partial unique `{ walletTransactionId: 1 }` where `walletTransactionId` is an ObjectId.
- `ReferralCommission`: `{ payoutRequestId: 1 }`.
- `WalletTransaction`: partial unique `{ sourceKey: 1 }` where `sourceKey` is a string.

Deployment-safe order:

1. Deploy code that can read commissions with no payout fields.
2. Run `node scripts/audit-referral-payouts.js` against production.
3. Confirm zero integrity issues and duplicate wallet payout references.
4. Create/confirm the new indexes.
5. Enable backend payout endpoints for admins/customers.
6. Integrate the frozen frontend in the next phase.

## Audit

Run:

```bash
node scripts/audit-referral-payouts.js
```

The script is read-only. It prints aggregate mismatch counts only and exits non-zero if it detects payout/commission/wallet state issues. It does not print private payout destinations, receipt data, wallet balances, or user PII beyond aggregate counts.

## Error Codes

Common payout-specific codes:

```text
PAYOUT_METHOD_INVALID
PAYOUT_CURRENCY_INVALID
PAYOUT_WALLET_CURRENCY_MISMATCH
PAYOUT_COMMISSIONS_REQUIRED
PAYOUT_COMMISSION_ID_INVALID
PAYOUT_COMMISSION_NOT_FOUND
PAYOUT_COMMISSION_NOT_AVAILABLE
PAYOUT_COMMISSION_LOCK_CONFLICT
PAYOUT_COMMISSION_STATE_INCONSISTENT
PAYOUT_AMOUNT_INVALID
PAYOUT_AMOUNT_REQUIRES_COMMISSION_SELECTION
PAYOUT_ZERO_TOTAL
PAYOUT_IDEMPOTENCY_KEY_INVALID
PAYOUT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
PAYOUT_EXTERNAL_DETAILS_REQUIRED
PAYOUT_EXTERNAL_DETAILS_INVALID
PAYOUT_EXTERNAL_DETAILS_FORBIDDEN
PAYOUT_EXTERNAL_DETAILS_TOO_LONG
PAYOUT_EXTERNAL_DETAILS_NOT_ALLOWED
PAYOUT_EXTERNAL_REFERENCE_TOO_LONG
PAYOUT_RECEIPT_INVALID
PAYOUT_REJECTION_REASON_REQUIRED
PAYOUT_REJECTION_REASON_TOO_LONG
PAYOUT_ALREADY_REVIEWED
PAYOUT_METHOD_ACTION_MISMATCH
PAYOUT_USER_NOT_PAYABLE
```

## Deferred Features

Deferred intentionally:

- Frontend real-data referral and payout integration.
- Referral payout automation.
- Referral payout wallet credit before admin review.
- Referral manual payout external-provider integration.
- Vodafone Cash automation.
- WhatsApp payout notifications.
- Sub-agent payout rules.
- Refresh tokens.
