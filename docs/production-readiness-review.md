# Production Readiness Review

Date: 2026-07-28

This document records the final release gate for the implemented referral,
Target, wallet, commission, sub-agent, payout, and frozen frontend integration
scope. It is intentionally operational: no real secrets are included.

## Release Status

Current status: not production ready.

The implemented referral/commission/sub-agent/payout/Target/wallet/deposit
focused suites pass, but the full backend suite still has untriaged or
unfixed failures in provider, polling, pricing, audit, currency, and receipt
analyzer suites. Production deployment must wait until those are either fixed
or formally accepted as out-of-scope baseline failures.

## Environment Requirements

Backend production environment:

```env
NODE_ENV=production
MONGO_URI=<replica-set-or-atlas-uri>
JWT_SECRET=<long-random-secret>
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=12
FRONTEND_URL=<production-frontend-origin>
FRONTEND_VERIFY_REDIRECT_URL=<production-frontend-origin>/email-verified
APP_URL=<production-backend-origin>
ALLOWED_ORIGINS=<comma-separated-production-origins>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_CALLBACK_URL=<production-backend-origin>/api/auth/google/callback
SMTP_HOST=<smtp-host>
SMTP_PORT=<smtp-port>
SMTP_USER=<smtp-user>
SMTP_PASS=<smtp-password>
EMAIL_FROM=<verified-sender>
TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED=false
REFERRAL_DEFAULT_COMMISSION_PERCENT=1
ADMIN_NOTIFICATION_NUMBER=<optional-whatsapp-number>
WHATSAPP_AUTH_DATA_PATH=<persistent-path-if-enabled>
WHATSAPP_CACHE_DATA_PATH=<persistent-path-if-enabled>
```

Frontend production environment:

```env
VITE_DATA_PROVIDER=real
VITE_API_BASE_URL=<production-backend-origin>/api
VITE_PUBLIC_APP_URL=<production-frontend-origin>
VITE_SITE_URL=<production-frontend-origin>
VITE_PUBLIC_SITE_URL=<production-frontend-origin>
VITE_ADMIN_WHATSAPP_NUMBER=<public-support-number>
```

Rules:

- MongoDB must support multi-document transactions.
- `ALLOWED_ORIGINS` must be explicit in production.
- `VITE_DATA_PROVIDER=real` is mandatory for production builds.
- `TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED` must remain `false` unless a
  documented legacy exception is approved.
- Uploads must be stored on persistent disk/object storage mounted at
  `Backend/uploads`.

## Database Index Requirements

Required indexes before traffic:

- `User.referralCode`: unique sparse.
- `OAuthStateNonce.nonce`: unique.
- `OAuthStateNonce.expiresAt`: TTL.
- `TargetOrder { userId, idempotencyKey }`: unique partial on string key.
- `ReferralCommission.idempotencyKey`: unique.
- `ReferralCommission { sourceType, sourceId, referrerUserId }`: unique.
- `SubAgentRequest { userId, status }`: unique partial for `PENDING`.
- `ReferralPayout { userId, idempotencyKey }`: unique partial on string key.
- `ReferralPayout.walletTransactionId`: unique partial on ObjectId.
- `WalletTransaction.sourceKey`: unique partial on string key.
- `ReferralCommission.payoutRequestId`: non-unique lookup index.

Run duplicate audits before index creation on production data.

## Migration And Audit Commands

Dry-run only:

```bash
node scripts/backfill-referral-codes.js
node scripts/backfill-referral-eligibility.js
node scripts/audit-target-idempotency-index.js
node scripts/audit-referral-commissions.js
node scripts/audit-sub-agent-requests.js
node scripts/audit-referral-payouts.js
node scripts/reconcile-referral-commissions.js
```

Write mode only after backup, review, and explicit approval:

```bash
node scripts/backfill-referral-codes.js --write
node scripts/backfill-referral-eligibility.js --write
node scripts/reconcile-referral-commissions.js --write
```

Do not delete financial records as a migration repair. Use reconciliation or
append-only corrective records.

## Deployment Order

1. Take a database backup.
2. Confirm MongoDB replica-set/Atlas transaction support.
3. Confirm persistent upload storage and free disk.
4. Confirm production environment variables.
5. Confirm active currencies and `platformRate` values.
6. Confirm active default group and intended reseller groups.
7. Confirm paymentGroups and Target app trusted account snapshots.
8. Deploy backend code that tolerates missing referral fields.
9. Run dry-run migration and audit commands.
10. Review counts and resolve duplicate/index blockers.
11. Run approved backfill write commands.
12. Create or confirm indexes.
13. Build frontend with `VITE_DATA_PROVIDER=real`.
14. Deploy frontend.
15. Run post-deploy smoke tests.

## Post-Deploy Smoke Tests

Customer:

1. Email signup without referral.
2. Email signup with referral.
3. Google signup with referral and profile completion.
4. Referral dashboard reload.
5. Sub-agent request proof upload and reload.
6. Deposit approval generates wallet credit and eligible commission.
7. Payout creation, rejection, wallet payment, and manual payment paths.
8. Target request creation with trusted account and idempotency replay.
9. Wallet balance/available balance reload after purchase and deposit.

Admin:

1. Referral-agent list and search.
2. Default commission setting, including `0`.
3. Sub-agent approval/rejection with active group.
4. Payout review, wallet pay, manual mark-paid with receipt.
5. Target approve/reject exactly once.
6. Currency/platform-rate and payment settings remain readable.

## Rollback

Backend rollback:

- Roll back code through deployment tooling.
- Do not delete `ReferralCommission`, `ReferralPayout`, `WalletTransaction`,
  `DepositRequest`, `TargetOrder`, or `SubAgentRequest` records.
- If older code cannot read new fields, keep API routes disabled rather than
  mutating historical data.

Frontend rollback:

- Roll back the frontend artifact.
- Ensure old frontend does not run in mock mode against production traffic.

Feature disablement:

- Disable frontend entry points or route access at the proxy/application layer.
- Keep reconciliation scripts available for already-created financial records.

Index rollback:

- Do not drop unique financial indexes unless a documented incident procedure
  requires it. Dropping idempotency indexes can re-enable double-credit risks.

Failed backfill:

- Stop the script.
- Keep partial writes.
- Re-run after fixing the cause; scripts are restart-safe by design.

## Monitoring Checklist

Watch for:

- Failed referral commission processing markers.
- Referral payout audit mismatches.
- Duplicate-key/idempotency conflicts.
- Deposit approval conflicts.
- Wallet ledger source-key conflicts.
- OAuth state validation failures.
- Upload validation failures.
- Target payment configuration errors.
- Mongo transaction aborts and transient retries.
- Post-commit notification failures.

Logs must include stable error code, entity ID, and operation. Logs must not
include tokens, proof bytes, full bank details, or private payout details.

## Known Limitations

- Amount-only payout requests may be rejected if the backend cannot match an
  exact safe commission set.
- The frozen admin UI supplies a default sub-agent rejection reason.
- Payout automation is not implemented.
- WhatsApp and Vodafone Cash automation are not implemented.
- Refresh tokens are not implemented.
- Refund/reversal commission policy is not implemented.
- Uploads are served from public static URLs under `/uploads`; filenames are
  random, but there is no authenticated file proxy.

## Current Blockers

P0:

- None remaining from this final review after upload validation was hardened.

P1:

- Full backend suite is not green; remaining failed suites must be triaged or
  accepted with explicit release ownership before deployment.
- Provider/polling/fulfillment suites have existing contract failures outside
  the implemented scope.
- Pricing/currency suites contain stale or contradictory precise-decimal
  expectations that must be accepted or updated.
- Receipt analyzer tests currently fail against mocked image behavior.

P2:

- Public static upload URLs.
- Existing WhatsApp notification noise when not configured.
- Amount-only payout exact-match limitation.

P3:

- Refresh tokens.
- WhatsApp automation.
- Vodafone Cash automation.
- External payout providers.
- UI redesign.
