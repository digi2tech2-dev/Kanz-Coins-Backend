# Coins Store Backend

Production-oriented Node.js backend for a digital coins and digital-products store. The API manages customer accounts, wallets, deposits, product catalog publishing, provider-backed fulfillment, manual order review, target coin requests, notifications, reseller compatibility APIs, and admin operations.

The source of truth is the code under `src/`. This README documents the implementation inspected in this repository, including route mounts, models, jobs, scripts, environment variables, and operational constraints.

Final release-gate notes, migration order, rollback guidance, and current blockers are tracked in [docs/production-readiness-review.md](docs/production-readiness-review.md).

## Application Overview

Main user types:

- `CUSTOMER`: buys products, manages wallet/deposits, submits target coin requests, and can generate an API token for reseller-compatible access.
- `SUPERVISOR`: operational/admin user with explicit permissions stored on the user document.
- `ADMIN`: privileged admin user. Admins bypass fine-grained permission checks.

Main capabilities:

- Public auth, public catalog/category/currency/payment-settings endpoints.
- Customer APIs under `/api/me`, `/api/orders`, `/api/deposits`, `/api/wallet`, and notification/target routes.
- Admin and supervisor APIs under `/api/admin`, plus older direct admin module mounts.
- Reseller/client-compatible API-key APIs under `/api/v1/reseller`, `/api/client`, `/api/client/api`, and `/client/api`.
- Manual and automatic product fulfillment with provider adapters.
- Wallet balance, credit limit, refunds, transaction history, and quantity-only billing groups.
- Deposit review with receipt upload and image/OCR anti-fraud checks.
- In-app notifications, SMTP email, and optional WhatsApp admin notifications.

## Technology Stack

- Runtime: Node.js, CommonJS modules.
- HTTP: Express `4.21.2`, Helmet `8`, CORS, Morgan.
- Database: MongoDB with Mongoose `8.10.1`.
- Auth/security: JWT `jsonwebtoken`, bcryptjs, Passport Google OAuth 2.0, express-rate-limit.
- Validation: express-validator and Joi.
- Uploads: Multer local disk storage under `uploads/`.
- Financial precision: `decimal.js` plus shared rounding/currency helpers.
- Jobs: `node-cron`.
- Integrations: Axios provider adapters, Nodemailer SMTP, whatsapp-web.js, QR code generation.
- Receipt analysis: Sharp and optional Tesseract OCR.
- Tests: Jest `30.2.0` and `mongodb-memory-server` replica set.
- Process manager config: PM2 `ecosystem.config.js`.

## Architecture

Entry points:

- `src/server.js`: loads environment, connects MongoDB, starts HTTP server, starts wired background jobs, initializes WhatsApp in the background, and installs graceful shutdown handlers.
- `src/app.js`: builds the Express app, applies middleware, registers routes, serves static uploads, seeds default settings, and installs the global error handler.

Initialization order:

1. `dotenv` loads `.env`.
2. `src/config/config.js` validates required `MONGO_URI` and `JWT_SECRET`.
3. `src/server.js` connects to MongoDB.
4. Express starts listening on `PORT` or `5000`.
5. `fulfillmentJob.start()` and `syncProvidersJob.start()` are called.
6. `whatsappService.initializeWhatsAppClient()` is attempted asynchronously.

Middleware order in `src/app.js`:

1. `helmet()` with cross-origin resource policy relaxed for uploaded assets.
2. CORS. Development/test allow all origins; production requires `ALLOWED_ORIGINS`.
3. JSON and URL-encoded body parsing with `10mb` limits.
4. Morgan logging except in tests.
5. `/uploads` static file serving.
6. Passport initialization only when Google credentials are configured.
7. `/health`.
8. General API rate limiter on `/api`, plus `/client/api`.
9. Route mounts.
10. 404 `ROUTE_NOT_FOUND`.
11. Global error handler.

Patterns:

- Domain modules live under `src/modules/<domain>` with routes/controllers/services/models/validators.
- Shared middleware, errors, responses, and utilities live under `src/shared`.
- Controllers are thin HTTP adapters; service files own business rules.
- Mongoose models define enums, indexes, snapshots, and relationships.
- Audit logs are append-only and sensitive metadata is redacted by the audit service.
- Financial operations use atomic MongoDB updates and, when available, MongoDB sessions.

## Project Structure

```text
Backend/
  README.md
  package.json                  npm scripts and dependencies
  package-lock.json             npm lockfile, lockfileVersion 3
  .env.example                  safe environment template
  .gitignore                    ignores .env, node_modules, logs, WhatsApp auth/cache
  ecosystem.config.js           PM2 cluster-mode config
  jest.config.js                Jest configuration
  postman_collection.json       Postman API collection
  fix_wallet_transactions.js    manual legacy repair utility
  scripts/
    backfill-compat-ids.js      assigns missing category/product compatibility IDs
    recalculate-credit-used.js  dry-run/write utility for creditUsed repair
  docs/
    *.md                        detailed feature and API notes
  src/
    app.js                      Express app and route registration
    server.js                   DB connection, jobs, HTTP startup/shutdown
    config/
      config.js                 environment-backed app config
      database.js               Mongoose connection helper
      google.strategy.js        Google OAuth strategy
    jobs/
      exchangeRateSync.job.js   cron-capable exchange-rate sync job, not started by server.js
    scripts/
      seed.js                   seed/clear script
    services/
      currencyConverter.service.js
      email.service.js
      exchangeRateSync.service.js
    modules/
      admin/                    admin dashboard, settings, catalog, users, wallets, providers
      audit/                    immutable audit logs
      auth/                     registration, login, verification, OAuth, 2FA
      categories/               category CRUD/model
      clientCompat/             legacy client-compatible API
      currency/                 currency CRUD and platform rates
      deposits/                 deposit request workflow
      groups/                   pricing and billing groups
      me/                       customer panel API
      notifications/            in-app notification system
      orders/                   pricing, order creation, fulfillment, polling
      products/                 product catalog and dynamic fields
      providers/                providers, provider products, adapters, sync
      reseller/                 API-token reseller API
      targets/                  target apps and target coin requests
      users/                    user self-service and admin user routes
      wallet/                   wallet transaction model and wallet logic
      whatsapp/                 WhatsApp admin notification service/routes
    shared/
      errors/                   AppError classes and global handler
      middlewares/              auth, RBAC, permissions, upload, validation, rate limits
      routes/                   shared upload route
      services/                 receipt analyzer
      utils/                    response, decimal, currency helpers
    tests/                      Jest suites, helpers, global setup/teardown
```

Generated or runtime folders such as `node_modules/`, `uploads/`, logs, coverage, `.wwebjs_auth/`, and `.wwebjs_cache/` should not be committed.

## Authentication And Account Lifecycle

Implemented routes are in `src/modules/auth/auth.routes.js`.

- Registration: `POST /api/auth/register` creates a `CUSTOMER`, assigns the active group with the highest `percentage`, sets `status: ACTIVE`, sets `verified: false`, stores a hashed 24-hour email verification token, and sends a verification email asynchronously.
- Referral signup foundation: new users receive an immutable `referralCode`. Email signup accepts the frontend field `referralCode` and stores `referredBy`/`referredAt` when the code belongs to an active non-deleted user. Google OAuth preserves signup/referral context through signed short-lived state. See `docs/referral-signup-foundation.md`.
- Referral commissions and payouts: approved referred-user deposits create record-only commissions. Customers can request payout of available commissions; admin wallet payouts credit the wallet after review, while manual external payouts only store processing evidence. See `docs/referral-commission-engine.md` and `docs/referral-payout-system.md`.
- Sub-Agent / reseller requests: active customers can submit a proof-backed request; admin review assigns an existing pricing group and sets `resellerApprovedAt` plus `referralCommissionStoppedAt` atomically. Frontend localStorage integration remains deferred. See `docs/sub-agent-reseller-requests.md`.
- Login: `POST /api/auth/login` requires existing user, verified email, `ACTIVE` status, password account, valid password, and then issues a JWT. If 2FA is enabled, login sends a 6-digit email OTP and returns a 5-minute temp token instead of a full JWT.
- JWTs: signed with `{ id, role }` and `JWT_EXPIRES_IN`. There is no refresh-token model or logout/token-revocation store in the current code.
- Email verification: `GET /api/auth/verify-email?token=...` consumes the raw token, looks up the SHA-256 hash, marks the account verified, clears token fields, and redirects to `FRONTEND_VERIFY_REDIRECT_URL` with status query params.
- Resend verification: `POST /api/auth/resend-verification` is rate-limited and avoids user enumeration for unknown emails.
- Google OAuth: enabled only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Google users are found/linked by `googleId` or email, are marked verified, and new Google users are created as `ACTIVE`.
- 2FA: email OTP only. Routes support generate, enable, disable, and verify. The code imports `speakeasy`, but the implemented 2FA flow does not use TOTP secrets.
- Account states: `PENDING`, `ACTIVE`, `REJECTED` exist. Authenticated middleware only allows `ACTIVE`. Registration currently creates `ACTIVE` users, despite older comments mentioning approval-first registration.
- Password reset: admin reset exists at `/api/admin/users/:id/reset-password`; no public forgot-password/reset flow is implemented.
- Logout: no server-side logout endpoint or token blacklist is implemented.
- Rate limits: general API limiter is 1000 requests per 15 minutes per IP; auth limiter is 10 requests per 15 minutes; wallet mutation limiter is 20 per 15 minutes.

## Roles And Permissions

Roles from `user.model.js`:

| Role | Behavior |
| --- | --- |
| `ADMIN` | Full admin role. Passes `requirePermission()` automatically. Some routes additionally require `authorize('ADMIN')`. |
| `SUPERVISOR` | Can access routes that allow supervisor role, but must have the named permission in `user.permissions`. |
| `CUSTOMER` | Customer purchasing, wallet, deposit, target, notification, profile, and reseller API-token flows. |

Permissions found in route enforcement:

| Permission | Used for |
| --- | --- |
| `VIEW_USERS` | User/admin user listing and detail views |
| `MANAGE_USERS` | User profile/admin edits, soft delete/restore, credit limit, avatar, password reset, quantity limits, Sub-Agent request review |
| `CONFIRM_ACCOUNTS` | Approving and rejecting users |
| `MANAGE_SUPPLIERS` | Provider CRUD, provider live checks, provider catalog sync |
| `MANAGE_ORDERS` | Listing and viewing orders |
| `CONFIRM_ORDERS` | Retry, refund, sync, complete, fail, and status updates |
| `MANAGE_WALLET` | Admin wallet reads, balance mutations, and referral payout review |
| `MANAGE_PRODUCTS` | Products, categories, provider-product publishing |
| `MANAGE_CURRENCIES` | Admin currency routes through the master admin router |
| `MANAGE_GROUPS` | Group create/update/delete and user group assignment |
| `MANAGE_DEPOSITS` | Deposit review, approval, rejection, and pending edits |
| `MANAGE_TARGETS` | Target app and target order administration |
| `CONFIRM_TARGET_REQUESTS` | Approving/rejecting target orders |
| `MANAGE_SETTINGS` | WhatsApp admin status/reconnect/reset routes |
| `MANAGE_PAYMENT_METHODS` | Shared payment image upload category |

## Wallet And Financial Behavior

Models: `User` stores current wallet fields; `WalletTransaction` stores immutable transaction records.

Balances:

- `walletBalance`: current balance in the user's currency. It may go negative up to the credit limit.
- `creditLimit`: maximum allowed overdraft.
- `creditUsed`: derived reporting mirror based on negative wallet balance, recalculated by wallet operations.
- `availableBalance` virtual: `walletBalance + creditLimit`.
- `availableCredit` virtual: remaining credit line.
- User `currency`: ISO 4217 code. Orders snapshot currency/rate at creation.

Wallet operations:

- `debitWalletAtomic()` uses a MongoDB aggregation-pipeline `findOneAndUpdate` requiring `status: ACTIVE` and `walletBalance + creditLimit >= amount`.
- `creditWalletDirect()` credits wallet and recalculates credit usage.
- `refundWalletAtomic()` credits the exact originally deducted amount and recalculates credit usage.
- `forcedDebitWallet()` exists for admin force-complete cases after a previous refund.
- Wallet transactions have types `CREDIT`, `DEBIT`, `REFUND`, `DEBT_ADJUSTMENT` and statuses `PENDING`, `COMPLETED`, `FAILED`.

Safeguards:

- Order creation can use MongoDB transactions. `ORDER_CREATION_TRANSACTIONS=true|false` overrides auto-detection.
- If transactions are unavailable and not forced, order creation retries in standalone mode.
- Duplicate order protection uses sparse unique index `{ userId, idempotencyKey }`.
- Refunds use `refunded` and `refundedAt` guards and compare-and-swap updates.
- Pricing, currency, group, provider, and input snapshots are written onto orders at creation.
- Decimal helpers and string price fields are used for provider/product price precision, with wallet balances rounded to two decimals.

Quantity-only billing:

- `Group.billingMode` can be `standard` or `quantity_only`.
- Quantity-only orders bypass pricing, currency conversion, wallet debit, and credit.
- The user's `quantityUsed` is incremented atomically against `quantityLimit`.
- Failed/refunded quantity-only orders return quota by decrementing `quantityUsed`.

## Product Catalog And Pricing

Models:

- `Category`: hierarchical categories with `parentCategory`, slug, image, sort order, active flag, and compatibility IDs.
- `Provider`: external supplier credentials and sync settings.
- `ProviderProduct`: raw synced provider catalog data, never exposed to customers directly.
- `Product`: platform product visible to customers/admins.
- `Group`: customer pricing tier and billing mode.
- `Currency`: market and platform rates.

Product pricing:

- `Product.basePrice` is the platform selling basis in USD before customer group markup.
- Provider-linked products can store `providerPrice`, `markupType` (`percentage` or `fixed`), `markupValue`, `finalPrice`, `pricingMode` (`manual` or `sync`), `syncPriceWithProvider`, `enableManualPrice`, and `manualPriceAdjustment`.
- Customer order price uses product base price plus group percentage, then converts USD to the user's currency using `Currency.platformRate`.
- Product and order price snapshots keep historical orders immutable.
- Provider live price cache TTL is controlled by `PROVIDER_PRICE_CACHE_TTL_MS`.

Dynamic order fields:

- `Product.orderFields` support `text`, `textarea`, `number`, `select`, `url`, `email`, `tel`, `date`, `image`, and `file`.
- `Product.dynamicFields` is a lighter admin form-builder shape supporting `text`, `number`, `email`, `select`, `image`, and `file`.
- `providerMapping` maps internal submitted keys to provider parameter names.
- Orders snapshot submitted values in `customerInput.values`, `customerInput.fieldsSnapshot`, and `customInputs`.
- `/api/products/:id/verify-field` verifies pre-purchase dynamic fields when provider support exists.

## Order System

Order statuses from `order.model.js`:

| Status | Meaning |
| --- | --- |
| `PENDING` | Manual order awaiting admin fulfillment. |
| `PROCESSING` | Wallet/quota deducted and automatic provider flow is underway. |
| `COMPLETED` | Fulfilled. |
| `CANCELED` | Provider canceled; refund path applies. |
| `PARTIAL` | Provider partially fulfilled; proportional refund path applies. |
| `FAILED` | Failed and refund path applies when financial fields exist. |
| `MANUAL_REVIEW` | Retry limit exceeded; admin must inspect and resolve. |

Execution types:

- `manual`: order lands in `PENDING`; admins complete/fail/refund.
- `automatic`: order lands in `PROCESSING`; provider fulfillment is attempted after order creation commits.

Creation flow:

1. Validate product, active state, quantity bounds, and dynamic fields.
2. Check idempotency key if supplied.
3. Snapshot product, group, pricing, currency, provider code, and customer input.
4. For `standard` billing, debit wallet/credit atomically.
5. For `quantity_only` billing, atomically increment `quantityUsed`.
6. Create order with an `orderNumber`; retry sequence collisions.
7. For automatic orders, call provider fulfillment after the financial transaction commits.
8. Notify admins for manual orders.

Automatic fulfillment:

- Provider dispatch is handled by `orderFulfillment.service.js`.
- Provider placement failures that look transient can leave the order `PROCESSING`.
- Provider hard rejections move the order to `FAILED` and trigger refund.
- Provider `Completed` maps to `COMPLETED`.
- Provider canceled/rejected states map to `CANCELED` or `FAILED` and trigger refund.
- Provider partial states map to `PARTIAL` and trigger proportional refund based on `remains`.
- `MAX_RETRY_COUNT` is `24`; exhausted processing orders are moved to `MANUAL_REVIEW` by `fulfillmentJob`.

Admin order operations:

- Retry failed orders.
- Manual refund.
- Sync provider status.
- Complete orders, including force-complete handling.
- Unified status update for `completed`, `rejected`, and `processing`.

## Provider Integrations

Provider records in MongoDB normally provide `baseUrl`, `apiToken` or `apiKey`, `slug`, `syncInterval`, `supportedFeatures`, and active/deleted flags. Provider tokens are stored on Provider documents in plain text in the current model, so database access must be treated as secret access.

Adapter registry keys:

| Adapter | Registered keys | API shape |
| --- | --- | --- |
| `RoyalCrownAdapter` | `royal-crown`, `royal crown`, `royalcrown` | `api-token` header; `/api/AllProducts`, `/api/PlaceOrder/...`, `/api/CheckOrder`, `/api/CheckListOrders`, `/api/GetMyInfo`. |
| `TorosfonAdapter` | `toros`, `torosfon`, `torosfon store`, `toros-store`, `torosfonstore` | Royal Crown compatible API. |
| `AlkasrVipAdapter` | `alkasr`, `alkasr-vip`, `alkasr vip`, plus several store aliases | `api-token` header; `/client/api/products`, `/client/api/newOrder/...`, `/client/api/check`, `/client/api/profile`. |
| `IbraAdapter` | `ibra-store`, `ibrastore`, `ibra` | `api-token` header; `/client/profile`, `/client/products`, `/client/orders`, `/client/check`. |
| `DealerApiAdapter` | `dealer-api`, `dealer`, `karak`, `ibulala`, and chat aliases | query-string `secretKey`; dynamic products for Karak/Ibulala; account/user-info/sale/list endpoints. |
| `MockProviderAdapter` | `mock` and fallback when unknown in non-strict lookup | No HTTP calls; test/dev sample data. |

Provider behavior:

- HTTP adapters use Axios with a default timeout of `180000` ms.
- `placeOrder()` returns normalized success/failure objects instead of throwing for provider rejections.
- Status checks normalize provider vocabulary into internal status handling.
- Batch status checking is implemented by adapters and jobs where providers support it.
- Catalog sync upserts raw provider products into `ProviderProduct`, marks missing items inactive, and can sync linked Product prices.
- Unknown providers fall back to `MockProviderAdapter` unless strict mode is used.
- `PROVIDER_BASE_URL` and `PROVIDER_API_TOKEN` are read only by the legacy `royalCrownProvider.js` compatibility shim, not the main adapter registry.

## Deposits And Payment Workflows

Deposit statuses: `PENDING`, `APPROVED`, `REJECTED`.

Customer flow:

- `POST /api/deposits` or `POST /api/me/deposits` with multipart field `receipt`.
- Required fields include `requestedAmount`, `currency`, and `paymentMethodId`.
- Optional notes and sender detail fields are normalized into `senderDetails`.
- Currency must be active; `amountUsd` is calculated as `requestedAmount / Currency.platformRate`.
- Receipt path is stored as `uploads/deposits/<filename>`.
- New deposits notify admins/supervisors in-app.

Receipt validation:

- Deposit uploads accept images and PDFs at the Multer layer.
- Receipt analyzer runs only for images. PDFs bypass image analysis.
- Fast image checks reject invalid/solid/low-information images.
- Optional OCR is enabled by `RECEIPT_ANALYZER_ENABLE_OCR=true`.

Admin flow:

- Approval uses compare-and-swap on `{ _id, status: PENDING }` to prevent duplicate approval.
- Approval credits wallet with the approved amount.
- Rejection is terminal.
- Admin can review via approve/reject endpoints or unified review endpoint under `/api/admin/deposits/:id/review`.
- Pending deposits can be edited through the admin route.

External payment gateway integration is not implemented in code. Payment methods and instructions are stored in admin settings (`paymentGroups`, `paymentCountryAccounts`, `paymentInstructions`) and returned by public payment settings.

## Target Requests

Models:

- `TargetApp`: target app name, unit price, target account ID, image, canonical allowed payment method IDs, active flag.
- `TargetOrder`: customer request with coin amount, sender ID, canonical payment method snapshot, target account snapshot, transfer/transaction numbers, screenshot proof, total price snapshot, idempotency key, and status.

Target order statuses: `PENDING`, `APPROVED`, `REJECTED`.

Customer flow:

- `GET /api/me/targets/apps` lists active target apps.
- `POST /api/me/targets` accepts multipart `appId`, `coinAmount`, `senderId`, `transferNumber`, `transactionNumber`, `paymentMethod`, optional `paymentMethodId`, optional `targetAccountIdSnapshot`, optional `idempotencyKey`, and required `screenshotProof`.
- The backend resolves `paymentMethodId`/`paymentMethod` against configured `paymentGroups`, requires the selected method to be active, validates it against the selected app's allowed methods, snapshots the app name, backend-owned target account, unit price, payment method ID/name/type, calculates `totalPrice`, and creates a pending request.
- If no usable Target payment configuration exists, new requests fail closed with `TARGET_PAYMENT_CONFIGURATION_MISSING`. Built-in legacy Target payment methods are used only when `TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED=true`; that fallback cannot override an inactive configured method.
- Customer-supplied target account fields are accepted for backward compatibility but ignored. `targetAccountIdSnapshot` is always copied from the selected `TargetApp.targetAccountId`.
- Reusing the same `idempotencyKey` for the same user returns the existing target order instead of creating a duplicate.
- Reusing the same `idempotencyKey` with a different material payload is rejected with `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
- `GET /api/me/targets` lists the customer's target orders.
- Creating a target request attempts in-app admin/supervisor notification and a WhatsApp admin notification as isolated side effects; notification failures do not reject or roll back the target request.

Admin flow:

- Manage target apps under `/api/admin/target-apps`.
- App create/update accepts `allowedPaymentMethods` as a JSON array or array of active payment method IDs/names and stores canonical IDs where resolvable.
- List target requests under `/api/admin/targets`.
- Approve/reject target orders with compare-and-swap on `PENDING`.
- Rejecting a target order requires a non-empty `adminNotes`/`rejectionReason`/`reason` value.
- Approval/rejection sends customer notification.

Target requests do not debit or credit the wallet in the current implementation.

Index/deployment note: `TargetOrder` has a partial unique index named `unique_target_user_idempotency_key` on `{ userId, idempotencyKey }`, applying only to string keys. Before creating/confirming the index on production data, run the dry audit script `node scripts/audit-target-idempotency-index.js` and resolve any duplicate non-empty key groups it reports.

## Notifications

In-app notifications:

- Types: `INFO`, `SUCCESS`, `WARNING`, `ERROR`.
- Scopes: `USER`, `BROADCAST`.
- Customer routes list own plus broadcast notifications, unread count, mark one read, and mark all read.
- Admin route can list all notifications and send to one user, a group, or broadcast.
- Business triggers exist for account approval, deposits, target orders, manual orders, order completed, and order failed.
- Notification helpers are fire-and-forget safe and catch/log their own errors.

Email:

- Nodemailer SMTP is used for verification links and 2FA OTP codes.
- Email sending is skipped in `NODE_ENV=test`.
- Registration does not fail if verification email sending fails because it is fire-and-forget.

WhatsApp:

- `whatsapp-web.js` with `LocalAuth`.
- Session state defaults to `.wwebjs_auth`; cache defaults to `.wwebjs_cache`.
- `ADMIN_NOTIFICATION_NUMBER` is normalized to digits and sent as `<digits>@c.us`.
- Admin routes under `/api/admin/whatsapp` expose status, reconnect, and reset.
- Status states: `IDLE`, `INITIALIZING`, `QR_READY`, `AUTHENTICATED`, `CONNECTED`, `DISCONNECTED`, `ERROR`.
- The QR code is exposed as a data URL while in `QR_READY`.
- Reconnect delay defaults to `5000` ms.
- In production, WhatsApp auth/cache directories must be persistent.
- PM2 cluster mode can start multiple WhatsApp clients unless isolated to one process.

## File Uploads

Storage root: `uploads/`.

Upload categories used by the code:

| Category | Used by | Field | Allowed types |
| --- | --- | --- | --- |
| `avatars` | user/admin avatar routes | `avatar` | images |
| `products` | `/api/upload/products` | `image` | images |
| `categories` | `/api/upload/categories` | `image` | images |
| `payments` | `/api/upload/payments` | `image` | images |
| `deposits` | deposit routes | `receipt` | images and PDF |
| `targets` | target order proof | `screenshotProof` | images |
| `target-apps` | admin target app image | `image` | images |
| `referral-payout-receipts` | admin referral payout manual-payment proof | `receiptImage`, `receipt`, or `paymentProof` | images |
| `order-fields` | `/api/me/upload/order-field-image` | `image` | images |

Limits and validation:

- Maximum file size is 20 MB.
- Image MIME/extensions: JPG, JPEG, PNG, WebP, GIF, SVG, BMP.
- Deposits also allow PDF.
- Both MIME type and file extension are checked.
- Files are stored as `<timestamp>-<random>.<ext>`.
- Static files are served from `/uploads`.
- Production deployments need persistent storage or external object storage in front of `uploads/`.

## Background Jobs

Only jobs called from `src/server.js` start automatically.

| Job | Schedule | Purpose | Entry point | Env vars | Runs in tests | Multi-instance notes |
| --- | --- | --- | --- | --- | --- | --- |
| Fulfillment polling | `*/5 * * * *` | Poll `PROCESSING` automatic orders, update terminal states, refund failures, move exhausted orders to `MANUAL_REVIEW`. | `src/modules/orders/fulfillmentJob.js`, started by `server.js` | `NODE_ENV` | Scheduler skipped when `NODE_ENV=test`; `runOnce()` callable | In-process lock only. PM2 cluster creates one scheduler per worker. |
| Provider catalog sync | `0 0,6,12,18 * * *` | Sync active provider catalogs into `ProviderProduct` and linked Product pricing. | `src/modules/providers/syncProvidersJob.js`, started by `server.js` | `NODE_ENV`, `SYNC_UPSERT_CONCURRENCY` | Scheduler skipped when `NODE_ENV=test`; `runOnce()` callable | In-process lock only. PM2 cluster duplicates sync unless isolated. |
| Order polling job module | `* * * * *` default if started manually | Newer multi-provider polling service wrapper around `orderPolling.service.js`. | `src/modules/orders/orderPolling.job.js` | `NODE_ENV`, `POLL_BATCH_LIMIT`, `POLL_MAX_BATCH_SIZE`, `POLL_MAX_CONCURRENT`, `POLL_INTER_BATCH_DELAY_MS` | Scheduler skipped in tests; `runOrderPolling()` callable | Not started by `server.js` in current code. |
| Exchange-rate sync job module | `0 */6 * * *` default if started manually | Sync raw market rates into `Currency.marketRate`. | `src/jobs/exchangeRateSync.job.js` | `NODE_ENV`, `EXCHANGE_RATE_API_URL`, `EXCHANGE_RATE_API_KEY`, `EXCHANGE_RATE_TIMEOUT_MS` | Scheduler skipped in tests; `runOnce()` callable | Not started by `server.js` in current code. |

## API Surface

Base app health check:

| Path | Purpose | Auth |
| --- | --- | --- |
| `GET /health` | Liveness/health JSON | Public |
| `/uploads/*` | Static uploaded files | Public static serving |

Route groups mounted in `src/app.js`:

| Base path | Route group | Purpose | Auth and role notes |
| --- | --- | --- | --- |
| `/api/auth` | Auth | Register, login, verify email, resend verification, Google OAuth, 2FA | Public except 2FA generate/enable/disable require JWT |
| `/api/users` | Users | Own profile/avatar plus admin user operations | JWT; admin/supervisor permissions for admin operations |
| `/api/groups` | Groups | Pricing groups and user group assignment | JWT; `ADMIN`/`SUPERVISOR`; write routes require `MANAGE_GROUPS` |
| `/api/products` | Products | Authenticated product list/detail, field verification, admin product management | JWT; admin/supervisor plus `MANAGE_PRODUCTS` for mutations |
| `/api/orders` | Orders | Customer order create/list/detail plus admin order view/fail/complete | JWT; customer or admin/supervisor depending route |
| `/api/wallet` | Wallet | Current user wallet stats/transactions and admin user transaction lookup | JWT active user; admin/supervisor for user transaction lookup |
| `/api/audit` | Audit | Entity and actor audit timelines | JWT `ADMIN` |
| `/api/deposits` | Deposits | Customer deposit submit/list and admin approve/reject | JWT; active user for create; admin/supervisor `MANAGE_DEPOSITS` for review |
| `/api/providers` | Providers | Provider CRUD, sync, provider products, provider-product publishing | JWT `ADMIN`/`SUPERVISOR` with `MANAGE_SUPPLIERS` |
| `/api/v1/reseller` | Reseller API | Balance, products, create order, lookup by idempotency key | API token through `api-token`, `x-api-key`, or Bearer |
| `/api/client` | Reseller alias | Alias to reseller API | API token |
| `/api/client/api` | Client compat | Legacy-compatible profile/products/content/newOrder/check | API token, legacy error shape |
| `/client/api` | Client compat alias | Same client-compatible routes outside `/api` | API token, legacy error shape |
| `/api/me` | Customer panel | Profile, API token/settings, wallet, products, orders, deposits, order-field image upload | JWT active user |
| `/api/me/targets` | Target requests | Active target apps and customer target orders | JWT active user |
| `/api/me/notifications` | Notifications | Customer inbox/read/unread routes | JWT active user |
| `/api/categories` | Public categories | Active categories only | Public |
| `/api/currencies/active` | Public currencies | Active currencies for registration/UI | Public |
| `/api/settings/payment` | Public payment settings | Payment settings with no-store cache headers | Public |
| `/api/public/catalog` | Public catalog | Active categories/products with pricing stripped | Public |
| `/api/admin` | Admin master | Dashboard, users, providers, orders, wallets, categories, currencies, groups, settings, deposits, audit, targets, notifications | JWT `ADMIN`/`SUPERVISOR`, plus per-route permissions; some routes admin-only |
| `/api/admin/currencies` | Currency admin | Currency CRUD/status | JWT `ADMIN` |
| `/api/admin/whatsapp` | WhatsApp admin | Status, reconnect, reset | JWT `ADMIN`/`SUPERVISOR` with `MANAGE_SETTINGS` |
| `/api/upload` | Generic uploads | Products/categories/payments image upload | JWT `ADMIN`/`SUPERVISOR`, category permission |

Detailed endpoint docs exist under `docs/`, but some older docs contain examples that may predate recent route additions. Treat source route files as final authority.

## Environment Variables

Do not commit `.env`. The repository `.gitignore` includes `.env`, and `.env.example` contains placeholders only.

| Name | Status | Default | Purpose | Feature |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | Optional | `development` | Runtime mode. `test` disables schedulers/log email behavior. `production` enforces CORS origins. | Runtime |
| `PORT` | Optional | `5000` | HTTP listen port. | Runtime |
| `MONGO_URI` | Required | none | MongoDB connection string. Use replica set for transactions. | Database |
| `JWT_SECRET` | Required | none | JWT signing secret and OTP HMAC secret. Must be long/random in production. | Auth |
| `JWT_EXPIRES_IN` | Optional | `7d` | Full JWT expiry. | Auth |
| `BCRYPT_ROUNDS` | Optional | `12` | Password and API token hash cost. | Auth/security |
| `FRONTEND_URL` | Optional | `http://localhost:3000` | Frontend base for default verification redirect. | Auth/frontend |
| `FRONTEND_VERIFY_REDIRECT_URL` | Optional | `${FRONTEND_URL}/email-verified` in config, but auth controller fallback is `http://localhost:5173/email-verified` | Email verification redirect target. | Auth/frontend |
| `APP_URL` | Optional | `http://localhost:${PORT || 5000}` | Backend base URL used in verification links. | Email/auth |
| `ALLOWED_ORIGINS` | Production-critical | dev/test allow `*`; config fallback `http://localhost:3000` | Comma-separated trusted origins. Required to start in production. | CORS |
| `GOOGLE_CLIENT_ID` | Feature-required | none | Enables Google OAuth with secret. | OAuth |
| `GOOGLE_CLIENT_SECRET` | Feature-required | none | Enables Google OAuth with client ID. | OAuth |
| `GOOGLE_CALLBACK_URL` | Optional | `http://localhost:${PORT || 5000}/api/auth/google/callback` | OAuth callback registered with Google. | OAuth |
| `SMTP_HOST` | Feature-required | `smtp.mailtrap.io` | SMTP host for verification and 2FA email. | Email |
| `SMTP_PORT` | Optional | `587` | SMTP port. Port `465` sets secure mode. | Email |
| `SMTP_USER` | Feature-required | none | SMTP username. | Email |
| `SMTP_PASS` | Feature-required | none | SMTP password/app password. | Email |
| `EMAIL_FROM` | Optional | `noreply@platform.com` | Sender address. | Email |
| `EXCHANGE_RATE_API_URL` | Optional | `https://api.exchangerate.host/latest?base=USD` | External market-rate source. | Exchange-rate service |
| `EXCHANGE_RATE_API_KEY` | Feature-required for keyed APIs | none | Appended as `access_key` query param when present. | Exchange-rate service |
| `EXCHANGE_RATE_TIMEOUT_MS` | Optional | `10000` | Exchange-rate HTTP timeout. | Exchange-rate service |
| `ORDER_CREATION_TRANSACTIONS` | Optional | auto | Force order transaction use on/off. Values: `true/false`, `1/0`, `on/off`, `yes/no`. | Orders |
| `POLL_BATCH_LIMIT` | Optional | `100` | Max processing orders loaded by `orderPolling.service`. | Order polling module |
| `POLL_MAX_BATCH_SIZE` | Optional | `50` | Max order IDs per provider batch status call. | Order polling module |
| `POLL_MAX_CONCURRENT` | Optional | `3` | Max provider groups polled concurrently. | Order polling module |
| `POLL_INTER_BATCH_DELAY_MS` | Optional | `0` | Delay between provider sub-batches. | Order polling module |
| `SYNC_UPSERT_CONCURRENCY` | Optional | `10` | Provider-product upsert concurrency during catalog sync. | Provider sync |
| `PROVIDER_PRICE_CACHE_TTL_MS` | Optional | `300000` | Live provider price cache TTL. | Provider pricing |
| `TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED` | Optional legacy fallback | `false` | Enables built-in Target payment methods only when no `paymentGroups` methods exist. Keep disabled in production after payment settings are configured. | Target requests |
| `PROVIDER_BASE_URL` | Legacy feature-only | none | Fallback base URL for legacy `royalCrownProvider.js` shim. | Legacy provider |
| `PROVIDER_API_TOKEN` | Legacy feature-only | none | Fallback token for legacy `royalCrownProvider.js` shim. | Legacy provider |
| `RECEIPT_ANALYZER_ENABLE_OCR` | Optional | `false` | Enables OCR checks. | Deposits |
| `RECEIPT_ANALYZER_MIN_ENTROPY` | Optional | `1.0` | Minimum image entropy. | Deposits |
| `RECEIPT_ANALYZER_BLACK_MEAN_MAX` | Optional | `8` | Black/blank image threshold. | Deposits |
| `RECEIPT_ANALYZER_WHITE_MEAN_MIN` | Optional | `247` | White/blank image threshold. | Deposits |
| `RECEIPT_ANALYZER_SOLID_STDDEV_MAX` | Optional | `2.5` | Solid image stddev threshold. | Deposits |
| `RECEIPT_ANALYZER_LOW_ENTROPY_STDDEV_MAX` | Optional | `3.2` | Low-entropy stddev threshold. | Deposits |
| `RECEIPT_ANALYZER_MAX_INPUT_PIXELS` | Optional | `40000000` | Max pixels Sharp may process. | Deposits |
| `RECEIPT_ANALYZER_OCR_TIMEOUT_MS` | Optional | `3500` | OCR timeout. | Deposits |
| `RECEIPT_ANALYZER_OCR_RESIZE_WIDTH` | Optional | `1200` | Image width before OCR. | Deposits |
| `RECEIPT_ANALYZER_OCR_MIN_KEYWORD_MATCHES` | Optional | `1` | Required OCR keyword matches. | Deposits |
| `RECEIPT_ANALYZER_OCR_KEYWORDS` | Optional | built-in Arabic/English list | Comma-separated OCR keywords. | Deposits |
| `ADMIN_NOTIFICATION_NUMBER` | Feature-required | none | WhatsApp admin target number, digits only. | WhatsApp |
| `WHATSAPP_CLIENT_ID` | Optional | `admin-notifications` | LocalAuth client ID. | WhatsApp |
| `WHATSAPP_AUTH_DATA_PATH` | Optional | `.wwebjs_auth` in cwd | Persistent WhatsApp auth directory. | WhatsApp |
| `WHATSAPP_CACHE_DATA_PATH` | Optional | `.wwebjs_cache` in cwd | Cache directory deleted on reset. | WhatsApp |
| `WHATSAPP_RECONNECT_DELAY_MS` | Optional | `5000` | Automatic reconnect delay. | WhatsApp |
| `MONGO_TEST_URI` | Test-only | injected by Jest global setup | In-memory test replica-set URI. | Tests |

Provider-specific placeholders `ROYAL_CROWN_API_URL`, `ROYAL_CROWN_API_TOKEN`, `TOROSFON_API_URL`, `TOROSFON_API_TOKEN`, `ALKASR_API_URL`, and `ALKASR_API_TOKEN` are present in `.env.example` for operator reference, but the current code does not read them directly.

## Setup And Local Development

Prerequisites:

- Node.js 18 or newer.
- npm.
- MongoDB. Use a replica set for transaction-backed behavior.

Install dependencies:

```bash
npm install
```

Create local env on Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Create local env on macOS/Linux:

```bash
cp .env.example .env
```

Minimum local `.env`:

```env
NODE_ENV=development
PORT=5000
MONGO_URI=mongodb://localhost:27017/coins-store
JWT_SECRET=replace_with_a_long_random_secret
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=12
```

For local transaction testing, use a MongoDB replica set. A standalone MongoDB can run most flows because order creation can fall back when transactions are unavailable, but transaction-forced production-like behavior requires replica-set support.

Run development server:

```bash
npm run dev
```

Run normal server:

```bash
npm start
```

Seed data:

```bash
npm run seed
```

Clear seed-managed collections and exit:

```bash
npm run seed:clear
```

Health check:

```text
GET /health
```

Example response:

```json
{
  "success": true,
  "status": "healthy",
  "environment": "development",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Optional integrations:

- Configure SMTP before relying on email verification or 2FA.
- Configure Google OAuth credentials and callback URL before exposing Google login.
- Configure provider records through admin/provider APIs, not provider-specific env vars.
- Configure persistent `uploads/` and WhatsApp auth/cache paths before production use.

## Scripts

Scripts from `package.json`:

| Command | Actual command | Purpose |
| --- | --- | --- |
| `npm start` | `node src/server.js` | Start production/normal server. |
| `npm run dev` | `nodemon src/server.js` | Start server with file watching. |
| `npm run seed` | `node src/scripts/seed.js` | Seed groups, admin, supervisor, customer, sample products, and target apps. |
| `npm run seed:clear` | `node src/scripts/seed.js --clear` | Delete seed-managed collections and exit; it does not reseed after clearing. |
| `npm test` | `jest --runInBand --forceExit` | Run Jest serially using global in-memory MongoDB replica-set setup. |

Manual utilities not exposed as npm scripts:

| Command | Purpose |
| --- | --- |
| `node scripts/recalculate-credit-used.js` | Dry-run scan of users whose `creditUsed` differs from wallet/credit limit. |
| `node scripts/recalculate-credit-used.js --write` | Apply `creditUsed` recalculation. |
| `node scripts/backfill-referral-codes.js` | Dry-run scan of users missing immutable referral codes. |
| `node scripts/backfill-referral-codes.js --write` | Assign referral codes to users missing them, with collision retry. |
| `node scripts/audit-referral-payouts.js` | Read-only audit for payout/commission/wallet integrity before index creation or deployment. |
| `node scripts/audit-sub-agent-requests.js` | Read-only audit for duplicate pending Sub-Agent request records before index creation. |
| `node scripts/backfill-compat-ids.js` | Assign missing `compatCategoryId` and `compatProductId` values. |
| `node fix_wallet_transactions.js` | Legacy repair that links old debit wallet transactions to nearby orders. Review before use. |

## Database

Important models:

| Model | Main relationships and notes |
| --- | --- |
| `User` | Belongs to `Group`; stores role, status, permissions, wallet, credit, reseller approval state, API token settings, OAuth/verification/2FA fields, soft delete. |
| `Group` | Pricing percentage and `billingMode`; users reference groups. |
| `Currency` | `platformRate` is used for billing; `marketRate` is informational/sync output. |
| `Category` | Self-referencing parent category tree; compatibility category IDs. |
| `Product` | Optional links to `Provider` and `ProviderProduct`; dynamic fields; provider mapping; compatibility product IDs. |
| `Provider` | External provider credentials, adapter slug, supported features, soft delete. |
| `ProviderProduct` | Raw provider catalog records keyed by `(provider, externalProductId)`. |
| `Order` | References user and product; snapshots pricing/group/currency/provider/customer input; status and provider fields. |
| `WalletTransaction` | Transaction history referencing user and optionally order. |
| `DepositRequest` | Deposit proof workflow and review metadata. |
| `ReferralCommission` / `ReferralPayout` | Record-only referral commissions and admin-reviewed payout requests. |
| `SubAgentRequest` | Customer reseller approval request history, proof metadata, review metadata, and approved group snapshot. |
| `TargetApp` / `TargetOrder` | Target coin request catalog and customer submissions. |
| `Notification` | User-scoped or broadcast in-app notifications. |
| `AuditLog` | Append-only audit events. |
| `Setting` | Key-value admin settings seeded on startup. |
| `Counter` | Atomic counters for order numbers and compatibility IDs. |

Indexes and constraints are defined in the models. Notable ones include unique user email, sparse unique Google ID, sparse unique order idempotency key per user, unique provider/external provider product pair, order polling indexes, audit query indexes, and compatibility ID indexes.

## Testing

Configuration:

- Jest config: `jest.config.js`.
- Test match: `**/__tests__/**/*.test.js` and `**/src/tests/**/*.test.js`.
- Timeout: 60 seconds.
- Global setup starts a one-node `MongoMemoryReplSet` with `wiredTiger`.
- Test env injects `MONGO_TEST_URI`, `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, and `BCRYPT_ROUNDS`.
- Email sending is skipped when `NODE_ENV=test`.
- Cron schedulers skip automatic startup when `NODE_ENV=test`.

Run tests:

```bash
npm test
```

Current suites cover auth, activation, admin, audit, catalog, providers/adapters, provider params, sync upgrades, dealer API, client compat, groups, currency, pricing, order fields, orders, fulfillment, order polling, deposits, receipt analyzer, and target apps.

No lint script is defined in `package.json`.

## Deployment

PM2 config exists at `ecosystem.config.js`:

```bash
pm2 start ecosystem.config.js --env production
pm2 logs digital-platform-api
pm2 restart digital-platform-api
pm2 stop digital-platform-api
```

Important PM2 detail: the config uses `instances: 'max'` and `exec_mode: 'cluster'`. The app's cron locks and WhatsApp state are process-local only. Running multiple workers can duplicate provider syncs, duplicate fulfillment polling, and start multiple WhatsApp clients. For production, run jobs/WhatsApp in a single worker or move them to a separate process.

Production checklist:

- Set `NODE_ENV=production`.
- Set a long random `JWT_SECRET`.
- Set `MONGO_URI` to a reliable MongoDB deployment. Use a replica set for transactions.
- Set `ALLOWED_ORIGINS` to exact trusted frontend origins.
- Configure `APP_URL`, `FRONTEND_URL`, and `FRONTEND_VERIFY_REDIRECT_URL`.
- Configure SMTP if email verification or 2FA must work.
- Configure Google OAuth callback exactly if Google login is used.
- Store provider credentials in Provider records or an external secret management process that writes those records.
- Persist `uploads/`.
- Persist `.wwebjs_auth` and `.wwebjs_cache` or set `WHATSAPP_AUTH_DATA_PATH` and `WHATSAPP_CACHE_DATA_PATH` to persistent paths.
- Use HTTPS behind a reverse proxy.
- Keep `app.set('trust proxy', 1)` in mind when deploying behind more complex proxy chains.
- Monitor process logs and PM2 logs under `logs/`.
- Use `/health` for health checks.

Docker configuration is not present in this repository.

## Security

Implemented protections:

- Helmet is enabled.
- Production CORS refuses startup without `ALLOWED_ORIGINS`.
- JWT authentication checks token validity, user existence, active status, and rejects 2FA-pending temp tokens.
- Passwords and API tokens are bcrypt-hashed in the `User` model.
- Email verification tokens are SHA-256 hashed; 2FA email OTPs are HMAC-SHA256 hashed.
- Role and permission middleware protect admin/supervisor routes.
- Input validation uses express-validator and Joi.
- Upload validation checks category, MIME type, extension, file count, and file size.
- Receipt analyzer rejects suspicious image receipts.
- Audit logs are append-only and update/delete hooks throw.
- Audit service redacts sensitive metadata keys.

Production responsibilities:

- Keep `.env` out of git and secret scans clean.
- Rotate any secrets that were ever committed or shared.
- Treat Provider records as secret-bearing database rows.
- Use HTTPS and secure reverse-proxy headers.
- Restrict MongoDB network access and credentials.
- Persist and protect uploaded files.
- Ensure PM2 clustering does not duplicate cron/WhatsApp side effects.
- Do not log provider tokens, SMTP passwords, JWT secrets, raw OTPs, or API tokens.

## Error Response Format

Standard errors from the global handler:

Development includes stack traces:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "errors": [
    { "field": "email", "message": "Please provide a valid email address", "value": "bad" }
  ],
  "stack": "..."
}
```

Production operational errors:

```json
{
  "success": false,
  "code": "AUTHENTICATION_ERROR",
  "message": "No token provided. Please log in.",
  "errors": []
}
```

Unknown production errors return:

```json
{
  "success": false,
  "code": "INTERNAL_SERVER_ERROR",
  "message": "Something went wrong. Please try again later."
}
```

Common codes include `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `INSUFFICIENT_FUNDS`, `BUSINESS_RULE_VIOLATION`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `ROUTE_NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, `AUTH_RATE_LIMIT_EXCEEDED`, and `WALLET_RATE_LIMIT_EXCEEDED`.

Client compatibility routes intentionally return a legacy shape:

```json
{
  "status": "ERROR",
  "code": 121,
  "message": "Token error"
}
```

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Startup fails with missing env vars | `MONGO_URI` and `JWT_SECRET` are required by `src/config/config.js`. |
| Production startup fails with CORS security error | Set `ALLOWED_ORIGINS` to a comma-separated trusted origin list. |
| MongoDB transaction errors | Use a MongoDB replica set, or leave `ORDER_CREATION_TRANSACTIONS` unset/false for fallback behavior. Tests use a memory replica set. |
| Invalid or expired JWT | Check `JWT_SECRET`, token expiry, and that the user still exists and has `status: ACTIVE`. |
| Email verification link points to wrong host | Set `APP_URL` for backend links and `FRONTEND_VERIFY_REDIRECT_URL` for the final redirect. |
| Google OAuth returns 503 | Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Verify `GOOGLE_CALLBACK_URL` matches Google Console. |
| SMTP send fails | Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM`. Gmail needs an app password. |
| Provider timeout or rejected order | Check Provider record `baseUrl`, `apiToken`/`apiKey`, adapter slug/name, and provider balance. Provider placement failures may refund or leave orders processing depending on failure class. |
| Automatic orders stuck in `PROCESSING` | Check provider status endpoints, `providerCode` snapshot, active Provider records, fulfillment job logs, and `retryCount`. At 24 retries, fulfillment polling moves orders to `MANUAL_REVIEW`. |
| Upload rejected | Check file field name, category, extension/MIME pair, and 20 MB size limit. |
| Uploaded files disappear after deploy | Mount persistent storage for `uploads/` or use external storage. |
| WhatsApp QR never appears | Check `whatsapp-web.js`/Chromium dependencies, `/api/admin/whatsapp/status`, and PM2 logs. |
| WhatsApp reconnect loops | Persist auth/cache paths and avoid multiple PM2 workers initializing the same WhatsApp session. |
| Cron jobs run more than once | PM2 cluster mode starts one scheduler per worker. Run jobs in one process. |
| Tests fail starting MongoDB memory server | First run may need binary download and enough time. Ensure local environment permits `mongodb-memory-server` binaries. |

## Documentation Index

| File | Description |
| --- | --- |
| `docs/admin-panel.md` | Admin panel API and operational notes. |
| `docs/api-reference.md` | Detailed API examples and endpoint notes. May lag behind newer route additions. |
| `docs/architecture.md` | Architectural overview and module responsibilities. |
| `docs/client-compat-api.md` | Reseller/client-compatible API details and error codes. |
| `docs/database-schema.md` | Model fields, indexes, and relationships. |
| `docs/dynamic-order-fields.md` | Dynamic product order fields and provider mapping. |
| `docs/order-system.md` | Order lifecycle and fulfillment notes. |
| `docs/provider-integration.md` | Provider adapter and catalog sync notes. |
| `docs/referral-commission-engine.md` | Referral commission creation, FX, processing markers, reconciliation, and audit notes. |
| `docs/referral-payout-system.md` | Referral payout request, locking, admin review, wallet credit, manual external payment, indexes, and audit notes. |
| `docs/referral-signup-foundation.md` | Referral identity, email signup, Google OAuth state, completion, and backfill notes. |
| `docs/sub-agent-reseller-requests.md` | Sub-Agent request lifecycle, upload contract, admin approval, commission stop behavior, and deployment notes. |
| `docs/testing.md` | Test setup, suites, and helper patterns. |
| `docs/user-panel.md` | Customer panel flow documentation. |
| `docs/wallet-system.md` | Wallet, credit, debit, and refund notes. |
