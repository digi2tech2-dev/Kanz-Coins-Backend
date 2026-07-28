# Sub-Agent / Reseller Requests

This phase implements the backend contract for reseller approval. It does not wire the existing frontend referral/admin pages to live APIs yet.

## Referrer Versus Reseller

Every user can own a `referralCode` and earn eligible referral commissions from users they invited. That does not require admin approval and does not change pricing.

A reseller/sub-agent is different. A customer submits a request with a message and proof image. An admin reviews it and, on approval, assigns the user to an existing pricing `Group`.

Approval does not create referral payouts, credit wallets, clear referral relationships, change roles, or grant admin permissions.

## User State

`User` stores only durable reseller state:

- `resellerStatus`: `NONE` or `APPROVED`
- `resellerApprovedAt`: server approval timestamp
- `referralCommissionStoppedAt`: same timestamp as approval
- `subAgentRequestPending`: internal concurrency claim for the active pending request

Pending and rejected states are request history, not user profile state.

## Request Lifecycle

`SubAgentRequest.status` values:

- `PENDING`
- `APPROVED`
- `REJECTED`

Reapplication policy:

- one pending request per user
- rejected users may submit a new request
- approved resellers may not submit another request

## Customer API

Create:

```http
POST /api/me/sub-agent-requests
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Fields:

- `message` or `notes`: required, max 1000 chars
- `proofImage`: required image file

Response:

```json
{
  "success": true,
  "data": {
    "request": {
      "id": "66...",
      "status": "pending",
      "statusCode": "PENDING",
      "message": "I have recurring customers.",
      "proofImage": "/uploads/sub-agent-proofs/...",
      "createdAt": "2026-07-28T..."
    }
  }
}
```

Read current:

```http
GET /api/me/sub-agent-requests/current
```

History:

```http
GET /api/me/sub-agent-requests?page=1&limit=20
```

Customers can read only their own requests.

## Proof Upload

Multipart field: `proofImage`

Allowed:

- JPEG
- PNG
- WebP

Maximum size: 5 MB

The shared Multer storage writes to:

```text
uploads/sub-agent-proofs/<timestamp>-<random>.<ext>
```

The database stores only relative metadata:

- `proofPath`
- `proofFileName`
- `proofMimeType`
- `proofSize`

The API returns `/uploads/sub-agent-proofs/...`, never an absolute filesystem path.

Cleanup:

- validation failure after upload
- duplicate pending request
- already-approved reseller
- database creation failure

Current limitation: the application publicly serves `/uploads`. Customer APIs remain scoped, but anyone with a proof URL may access the file while this static-file architecture remains public.

## Admin API

List:

```http
GET /api/admin/sub-agent-requests?status=PENDING&search=email&page=1&limit=20
```

Requires existing admin/supervisor route guard plus `MANAGE_USERS`.

Approve:

```http
PATCH /api/admin/sub-agent-requests/:id/approve
Content-Type: application/json

{ "groupId": "66..." }
```

Reject:

```http
PATCH /api/admin/sub-agent-requests/:id/reject
Content-Type: application/json

{ "reason": "Need more proof." }
```

Aliases `rejectionReason` and `adminNotes` are accepted for reject compatibility.

## Approval Transaction

Approval uses one MongoDB session and one timestamp for:

- `SubAgentRequest.reviewedAt`
- `User.resellerApprovedAt`
- `User.referralCommissionStoppedAt`

Transaction writes:

1. Claim pending request with `{ _id, status: PENDING }`
2. Validate selected active, non-deleted `Group`
3. Validate active, non-deleted `User`
4. Set `User.groupId`
5. Set `User.resellerStatus = APPROVED`
6. Set `User.resellerApprovedAt`
7. Set `User.referralCommissionStoppedAt`
8. Set request `APPROVED`, `approvedGroupId`, `reviewedBy`, `reviewedAt`

If any step fails, request and user state roll back together.

## Commission Stop

Approval stops future commissions generated from deposits made by the newly approved reseller:

```text
deposit.reviewedAt >= user.referralCommissionStoppedAt
=> no new commission for the previous referrer
```

Historical commissions remain unchanged. The approved user keeps their own referral code and can still earn commissions from customers they personally invited.

## Errors

Stable error codes include:

- `SUB_AGENT_REQUEST_ALREADY_PENDING`
- `USER_ALREADY_RESELLER`
- `SUB_AGENT_PROOF_REQUIRED`
- `SUB_AGENT_PROOF_INVALID`
- `SUB_AGENT_NOTES_REQUIRED`
- `SUB_AGENT_NOTES_TOO_LONG`
- `SUB_AGENT_REQUEST_NOT_FOUND`
- `SUB_AGENT_REQUEST_ALREADY_REVIEWED`
- `SUB_AGENT_REJECTION_REASON_REQUIRED`
- `SUB_AGENT_REJECTION_REASON_TOO_LONG`
- `SUB_AGENT_GROUP_NOT_FOUND`
- `SUB_AGENT_GROUP_INACTIVE`
- `SUB_AGENT_REQUEST_STATUS_INVALID`

## Audit

Audit actions:

- `SUB_AGENT_REQUEST_CREATED`
- `SUB_AGENT_REQUEST_APPROVED`
- `SUB_AGENT_REQUEST_REJECTED`

Audit metadata excludes proof content and absolute paths.

## Frontend LocalStorage Limitation

Current frontend demo data uses:

```text
oscar_sub_agent_requests
```

Shape:

```json
{
  "id": "sub-agent-...",
  "userId": "...",
  "name": "...",
  "email": "...",
  "message": "...",
  "proofImage": "data:image/...",
  "status": "pending",
  "createdAt": "..."
}
```

Browser localStorage is not a trusted central source. The backend cannot discover arbitrary customers' local browser records, so no automatic migration is possible. Demo records are not production approvals. A later frontend integration phase can replace localStorage reads/writes with the APIs above.

## Indexes

`SubAgentRequest` indexes:

- `{ userId: 1 }`
- partial unique `{ userId: 1, status: 1 }` where `status = PENDING`
- `{ status: 1, createdAt: -1 }`
- `{ reviewedAt: -1 }`

Run the audit before creating/enforcing the partial unique index on any environment that may already contain backend records:

```bash
node scripts/audit-sub-agent-requests.js
```

## Deployment

1. Deploy schema/model changes.
2. Confirm code tolerates users with missing reseller fields.
3. Run `node scripts/audit-sub-agent-requests.js`.
4. Resolve any duplicate pending backend records before index creation.
5. Create/confirm the partial unique pending-request index.
6. Confirm pricing groups are active and configured.
7. Confirm `uploads/sub-agent-proofs` is persistent and served.
8. Enable customer request and admin review endpoints.
9. Perform manual approval/rejection QA.
10. Proceed later to frontend real-data integration.

Deferred: referral payouts, wallet-credit payouts, manual external payouts, frontend integration, WhatsApp, Vodafone Cash, and refresh-token changes.
