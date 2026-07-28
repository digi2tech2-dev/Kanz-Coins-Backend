# Referral Commission Engine

This phase creates referral commission records only. It does not credit referrer wallets, create payout requests, approve sub-agents, or change frontend referral dashboards.

## Eligibility

When a user is referred, `referralEligibleUntil` is set once to `referredAt + 30 days`. A deposit is eligible when its approval timestamp is less than or equal to that timestamp. The relationship fields `referredBy`, `referredAt`, and `referralEligibleUntil` are immutable in normal user lifecycle flows.

`referralCommissionStoppedAt` is reserved for future reseller/sub-agent stop behavior. Deposits approved at or after that timestamp are not commissioned.

## Percentage

The default percentage is `REFERRAL_DEFAULT_COMMISSION_PERCENT`, falling back to `1`. Admin settings may also provide `referralDefaultCommissionPercent`.

Each referrer can have `referralCommissionPercentOverride`:

- `null`: use the default percentage.
- positive value up to `50`: use that value.
- `0`: intentionally create no commission record, while marking the deposit as processed with `ZERO_PERCENT`.

Admin override endpoint:

```http
PATCH /api/admin/referrals/agents/:userId/commission
Content-Type: application/json

{ "percent": 2.5 }
```

Use `{ "percent": null }` to clear the override.

## Deposit Integration

Deposit approval, wallet credit, and referral commission processing run in one MongoDB transaction. Notifications and audit logs are emitted after commit.

Deposits store processing markers:

- `NOT_APPLICABLE`
- `PENDING`
- `PROCESSED`
- `FAILED`

Expected non-eligible outcomes do not block deposit approval. Configuration failures such as a missing active FX currency mark the commission status as `FAILED` and still keep the wallet credit committed.

Marker outcomes:

- `CREATED`: commission record created.
- `ALREADY_EXISTS`: idempotent replay found the existing commission.
- `NOT_REFERRED`: depositor has no referrer.
- `MISSING_REFERRAL_START`: referred user has no trusted referral start timestamp.
- `EXPIRED`: approval timestamp is after `referralEligibleUntil`.
- `STOPPED`: approval timestamp is at or after `referralCommissionStoppedAt`.
- `ZERO_PERCENT`: referrer override is explicitly `0`.
- `INVALID_REFERRER`: referrer is inactive or deleted.
- `FAILED_CONFIGURATION`: retryable processing failure, usually FX configuration.

The deterministic no-commission outcomes use `NOT_APPLICABLE`. Retryable unresolved failures use `FAILED`.

## Currency and FX

Commission is calculated in the approved deposit currency first:

```text
commissionAmountOriginalCurrency = approvedDepositAmount * percent / 100
```

It is then converted to the referrer's wallet currency through USD using active `Currency.platformRate` snapshots:

```text
source USD = commissionAmountOriginalCurrency / sourcePlatformRate
referrer amount = source USD * referrerPlatformRate
```

USD always has platform rate `1`. There is no 1:1 fallback for different non-USD currencies.

`Currency.platformRate` means units of that currency per 1 USD. Example:

```text
1000 EGP deposit, 2% commission = 20 EGP
EGP platformRate = 50
SAR platformRate = 3.75
20 / 50 = 0.4 USD
0.4 * 3.75 = 1.5 SAR
```

Commission amounts and FX snapshots are stored as decimal strings with six decimal places, except `effectiveFxRateSnapshot`, which stores twelve decimal places. The implementation uses `decimal.js` and `ROUND_HALF_UP`.

## Customer API

```http
GET /api/me/referral-commissions
GET /api/me/referral-commissions/summary
```

The list returns commission records for the authenticated referrer. The summary groups totals by referrer wallet currency and status.

## Backfill and Audit

Dry-run eligibility backfill:

```bash
node scripts/backfill-referral-eligibility.js
```

Explicit write mode:

```bash
node scripts/backfill-referral-eligibility.js --write
```

Historical approved-deposit audit, read-only:

```bash
node scripts/audit-referral-commissions.js
```

Optional range:

```bash
node scripts/audit-referral-commissions.js --from=2026-01-01 --to=2026-12-31
```

Failed commission reconciliation dry-run:

```bash
node scripts/reconcile-referral-commissions.js
```

Explicit write mode:

```bash
node scripts/reconcile-referral-commissions.js --write
```

Target one deposit:

```bash
node scripts/reconcile-referral-commissions.js --deposit-id=<depositObjectId>
```

By default, reconciliation processes only approved deposits with `FAILED` commission markers. Use `--all` only for a deliberate idempotency audit/replay. Reconciliation never credits wallets and never changes deposit approval state.

## Deployment Order

1. Deploy code that tolerates missing `referralEligibleUntil`.
2. Run eligibility backfill dry-run.
3. Review counts.
4. Run eligibility backfill with `--write`.
5. Run the historical approved-deposit audit.
6. Confirm the audit reports zero duplicate commission source groups.
7. Confirm commission indexes build successfully.
8. Reconcile failed commission markers after fixing FX configuration.
9. Enable any frontend real-data replacement in a later phase.

## Deferred

Referral payouts, referral wallet credits, payout administration, and frontend referral real-data replacement are not implemented in the commission phase. Backend Sub-Agent / reseller request approval is documented separately in `docs/sub-agent-reseller-requests.md`.
