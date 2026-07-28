# Frozen Referral Frontend Integration

This phase connects the existing customer and admin referral pages to persistent backend APIs without changing visible frontend routes, text, layout, styling, or component structure.

## Production Mode

The frontend must run with:

```bash
VITE_DATA_PROVIDER=real
```

Mock mode remains available for development. In real mode the referral, sub-agent, payout, commission-rate, and withdrawal-method UI must ignore browser-local demo records.

## Customer Contracts

- `GET /api/me/referrals/dashboard` returns the authenticated user's referral code, `/auth?mode=signup&ref=CODE` path, safe invited-user summaries, grouped commission totals, and the display amount for the user's wallet currency.
- `GET /api/me/referral-commissions` returns the authenticated user's commission history.
- `GET /api/me/sub-agent-requests/current` and `GET /api/me/sub-agent-requests` return the current and historical sub-agent requests.
- `POST /api/me/sub-agent-requests` accepts multipart field `proofImage` and text field `message`.
- `GET /api/me/referral-payout-methods` returns active payout methods only.
- `POST /api/me/referral-payouts` accepts amount-only payout requests. The backend selects oldest available whole commissions in the requested currency and rejects amounts that cannot be represented exactly.
- `GET /api/me/referral-payouts` returns persistent payout history.

Customer responses expose safe invited-user summaries only. Passwords, tokens, wallet details, deposit proofs, and internal processing errors are not included in the dashboard aggregation.

## Admin Contracts

- `GET /api/admin/referrals/agents` returns bounded referral-agent rows with safe user summaries, invited-user summaries, grouped commission totals, current/default commission percent, reseller status, group summary, and payout summaries.
- `PATCH /api/admin/referrals/agents/:userId/commission` remains the per-referrer override endpoint.
- The global rate control uses `PATCH /api/admin/settings/referralDefaultCommissionPercent`.
- `GET/PATCH /api/admin/settings/referralPayoutMethods` stores the existing withdrawal-method configuration shape. It contains no credentials or provider secrets.
- `GET /api/admin/sub-agent-requests`, `PATCH /approve`, and `PATCH /reject` power sub-agent review.
- `GET /api/admin/referral-payouts`, `PATCH /reject`, `PATCH /pay-wallet`, and `PATCH /mark-paid` power payout review. Manual mark-paid accepts multipart `receiptImage`; wallet pay does not credit external methods.

## Status Mapping

- Sub-agent: `PENDING -> pending`, `APPROVED -> approved`, `REJECTED -> rejected`.
- Payout: `PENDING -> processing`, `PAID -> completed`, `REJECTED -> failed`.
- Commission statuses remain canonical for API data: `AVAILABLE`, `LOCKED`, `PAID`, `CANCELLED`.

## Currency Rules

Financial totals remain grouped by currency. The frozen customer UI displays only the authenticated user's wallet currency amount and does not sum mixed currencies or perform frontend FX conversion.

## LocalStorage Policy

In mock mode, the legacy keys may still power demo flows:

- `oscar_sub_agent_requests`
- `kanzcoins_referral_withdrawal_requests`
- `kanzcoins_admin_referral_commission_rate`
- `kanzcoins_referral_withdrawal_methods`

In real mode these keys are ignored as a source of financial/business truth. Existing browser values are not deleted or migrated.

## Deferred

This integration does not add WhatsApp automation, Vodafone Cash automation, external payout provider integrations, refresh tokens, source-deposit refund/reversal commission policy, or frontend redesign.
