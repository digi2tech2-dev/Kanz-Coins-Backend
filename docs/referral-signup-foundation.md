# Referral Signup Foundation

This phase adds referral identity and signup-time referral linking only. It does not implement commissions, sub-agent requests, payout workflows, or admin referral dashboards.

## User Fields

`User` documents now include:

- `referralCode`: immutable, public-safe uppercase alphanumeric code generated once for new users.
- `referredBy`: immutable `User` reference for the invitation owner.
- `referredAt`: immutable timestamp set when the relationship is created.
- `country`: two-letter ISO-style country code used by the existing signup/profile-completion form.

Existing users are tolerated without `referralCode` until the explicit backfill script is run.

## Email Signup

The frontend canonical request field is `referralCode`.

Accepted compatibility aliases are `refCode`, `ref`, and `inviteCode`.

Example:

```json
{
  "name": "New Customer",
  "email": "new@example.com",
  "password": "SecurePass@1",
  "country": "EG",
  "currency": "USD",
  "referralCode": "ABCD234567"
}
```

Invalid, unknown, deleted-owner, or malformed codes reject registration and do not create an account. Inactive owners return `REFERRAL_OWNER_INACTIVE`. Self-referral returns `SELF_REFERRAL_NOT_ALLOWED`.

Registration still assigns the default pricing group from the existing highest-percentage group rule. Referral usage does not change group, role, reseller state, wallet, or commission data.

## Google OAuth State

`GET /api/auth/google` accepts non-secret query context:

```text
?intent=signup&referralCode=ABCD234567
```

The backend signs a short-lived Google OAuth state payload with the existing JWT secret. The state contains purpose, nonce, intent, and normalized referral code. The callback verifies issuer, audience, expiry, purpose, and stores the consumed nonce in MongoDB before resolving the Google profile. The nonce collection uses a unique nonce and TTL expiry so replay protection works across app workers that share the same database.

The callback redirects to the existing frontend `/auth?token=...` or `/auth?status=pending` contract.

## Profile Completion

Google users continue using the existing visible completion form. The authenticated `PATCH /api/users/me` endpoint now accepts:

```json
{
  "country": "EG",
  "currency": "USD",
  "referralCode": "ABCD234567"
}
```

Only the authenticated user's own profile can be updated. Currency must exist in `Currency` and be active. Country must be a two-letter code.

This endpoint does not create new referral relationships from a browser-supplied code. Google referral assignment happens during the validated OAuth callback. During completion, a matching already-assigned referral code is treated as idempotent; a missing or different referral relationship is rejected and cannot be created or replaced through the generic profile endpoint.

## Error Codes

- `REFERRAL_CODE_INVALID`
- `SELF_REFERRAL_NOT_ALLOWED`
- `REFERRAL_OWNER_INACTIVE`
- `OAUTH_STATE_INVALID`
- `OAUTH_STATE_EXPIRED`
- `PROFILE_COMPLETION_REQUIRED`
- `CURRENCY_INVALID`
- `CURRENCY_INACTIVE`
- `REFERRAL_ALREADY_ASSIGNED`

Errors use the existing API envelope:

```json
{
  "success": false,
  "code": "REFERRAL_CODE_INVALID",
  "message": "Invitation code is invalid."
}
```

## Backfill

Dry-run is the default:

```bash
node scripts/backfill-referral-codes.js
```

Explicit write mode:

```bash
node scripts/backfill-referral-codes.js --write
```

Optional bounded batch size:

```bash
node scripts/backfill-referral-codes.js --write --batch-size=250
```

The script scans users missing `referralCode`, skips users that already have a code, retries rare unique collisions, and prints summary counts without private user data.

## Deployment Order

1. Deploy code that tolerates missing `referralCode`.
2. Run dry-run backfill and review counts.
3. Run explicit write-mode backfill.
4. Verify active users have codes.
5. Confirm the unique sparse referral-code index.
6. Enable frontend referral-link usage.

Do not infer historical referral relationships from browser localStorage.

## Deferred Features

Referral commissions, sub-agent/reseller approval, payout requests, admin referral backend APIs, and referral dashboard real-data replacement are intentionally deferred.
