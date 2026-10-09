'use strict';

/**
 * orderFulfillment.service.js
 *
 * Handles the post-payment provider fulfillment lifecycle.
 * Completely decoupled from order.service.js — called after the financial
 * transaction has committed, so no wallet/session logic lives here.
 *
 * Responsibilities:
 *   1. Call provider.placeOrder()      → executeOrder()
 *   2. Atomic idempotent refund        → refundFailedOrder()
 *   3. Process one status update       → processOrderStatusResult()
 *   4. Cron: batch-poll PROCESSING     → pollProcessingOrders()
 *
 * Design contract:
 *   - executeOrder() NEVER throws — returns result object, logs audit.
 *   - refundFailedOrder() is idempotent via the `refunded` boolean guard.
 *   - pollProcessingOrders() is idempotent — safe to run 1× per minute.
 */

const mongoose = require('mongoose');
const { Order, ORDER_STATUS, MAX_RETRY_COUNT, ORDER_EXECUTION_TYPES } = require('../orders/order.model');
const { getExternalProductId } = require('../products/product.service');
const { refundWalletAtomic } = require('../wallet/wallet.service');
const { createAuditLog } = require('../audit/audit.service');
const { applyProviderMapping } = require('./orderFields.validator');
const {
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    PROVIDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { toInternalStatus, isTerminal, requiresRefund } = require('../providers/statusMapper');
const { notifyOrderCompleted, notifyOrderFailed } = require('../notifications/notification.service');

/**
 * Atomically move a provider-fulfilled order out of PROCESSING.
 *
 * Provider responses are asynchronous and may arrive out of order.  Every
 * terminal transition must therefore compare against the persisted state, not
 * a stale document read before an HTTP request.
 */
const transitionFromProcessing = async (orderId, set, extraFilter = {}) => {
    return Order.findOneAndUpdate(
        {
            _id: orderId,
            status: ORDER_STATUS.PROCESSING,
            ...extraFilter,
        },
        { $set: set },
        { new: true }
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENT REFUND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically refund a failed order exactly once.
 *
 * CROSS-CURRENCY SAFE:
 *   Uses order.usdAmount (the USD truth frozen at order time) and converts
 *   it to the user's CURRENT currency rate before crediting the wallet.
 *
 * Guard: the `refunded` boolean is set to true via a compare-and-swap
 * findOneAndUpdate so concurrent refund calls cannot double-credit the wallet.
 *
 * @param {Object} order  - Mongoose Order document
 * @returns {Promise<boolean>} true if refund was applied, false if already refunded
 */
const refundFailedOrder = async (order) => {
    // Compare-and-swap: only proceeds when refunded===false
    const swapped = await Order.findOneAndUpdate(
        { _id: order._id, refunded: false },
        { $set: { refunded: true, refundedAt: new Date() } },
        { new: true }
    );

    if (!swapped) {
        // Already refunded by a concurrent call
        return false;
    }

    // Execute the wallet refund inside its own session
    const session = await mongoose.startSession();
    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        // ── Use the EXACT amounts originally deducted ────────────────────
        // NEVER do a live currency conversion. Exchange rates fluctuate.
        // The user must receive back exactly what was taken from their wallet.
        //
        // Source of truth (frozen at order creation):
        //   walletDeducted   – amount debited from the net wallet balance
        //   creditUsedAmount – informational credit drawn by that debit
        //   chargedAmount    – total (fallback for legacy orders)
        const walletPortion = Number(order.walletDeducted || 0);
        const creditPortion = Number(order.creditUsedAmount || 0);
        const chargedPortion = Number(order.chargedAmount || 0);
        const isLegacySplitRefund = walletPortion > 0
            && creditPortion > 0
            && chargedPortion > 0
            && Math.abs((walletPortion + creditPortion) - chargedPortion) < 0.01;

        // Fallback: if split fields are 0 but chargedAmount exists, use it
        const refundWallet = walletPortion > 0
            ? (isLegacySplitRefund ? walletPortion + creditPortion : walletPortion)
            : (creditPortion > 0 ? creditPortion : Number(order.chargedAmount || 0));
        const refundCredit = creditPortion;
        const totalRefund = refundWallet;

        if (totalRefund <= 0) {
            // Nothing to refund — undo the CAS flag and bail
            await Order.findByIdAndUpdate(order._id, { $set: { refunded: false, refundedAt: null } });
            console.error(`[Fulfillment] refundFailedOrder: order ${order._id} has 0 refundable amount (walletDeducted=${order.walletDeducted}, chargedAmount=${order.chargedAmount})`);
            return false;
        }

        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: refundWallet,
            creditUsedAmount: refundCredit,
            reference: order._id,
            description: `Auto-refund: provider order ${order.providerOrderId ?? 'N/A'} failed (${totalRefund} ${order.currency || 'USD'})`,
            session,
        });

        await session.commitTransaction();

        // Audit — fire-and-forget, after commit
        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                currency: order.currency,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                originalChargedAmount: order.chargedAmount,
                originalWalletDeducted: order.walletDeducted,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                currency: order.currency,
                reason: 'PROVIDER_ORDER_FAILED',
            },
        });

        return true;

    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        // Undo the refunded=true flag so the next retry can attempt again
        await Order.findByIdAndUpdate(order._id, { $set: { refunded: false, refundedAt: null } });
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { Provider } = require('../providers/provider.model');
const { Product } = require('../products/product.model');

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE ORDER (called immediately after createOrder commits)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * executeOrder(orderId, provider?, auditContext?)
 *
 * Calls provider.placeOrder(), interprets the result, and updates the Order.
 *
 * Case A: success=true  + Completed  → COMPLETED
 * Case B: success=true  + Pending    → keep PROCESSING, save providerOrderId
 * Case C: success=true  + Cancelled  → FAILED + refund
 * Case D: success=false              → FAILED + refund
 *
 * If no provider adapter is passed, the function self-resolves it from
 * Product.provider. If that also fails, the order is marked FAILED + refund.
 *
 * This function NEVER throws. Explicit pre-dispatch resolution failures and
 * normalized provider rejections may fail/refund; unexpected failures move a
 * still-processing order to MANUAL_REVIEW without an automatic refund.
 *
 * @param {string|ObjectId} orderId
 * @param {Object|null}     [provider]      - adapter instance (null = self-resolve)
 * @param {Object|null}     [auditContext]
 * @returns {Promise<{ order: Order, placed: boolean, refunded: boolean }>}
 */
const executeOrder = async (orderId, provider = null, auditContext = null) => {
    // ─── TOP-LEVEL CRASH GUARD ─────────────────────────────────────────────
    // Wraps the entire function so ANY crash (parsing, DB, provider resolution)
    // marks the order FAILED + refund instead of leaving it stuck in PROCESSING.
    try {

    const order = await Order.findById(orderId)
        .populate('productId', 'name providerProduct providerMapping provider');
    if (!order) {
        console.error(`[Fulfillment] executeOrder: order ${orderId} not found`);
        return { order: null, placed: false, refunded: false };
    }

    // Guard: only attempt execution once
    if (order.status !== ORDER_STATUS.PROCESSING) {
        return { order, placed: false, refunded: false };
    }

    const actorId = auditContext?.actorId ?? order.userId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.SYSTEM;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;

    const hasRoutingSnapshot = Boolean(
        order.selectedProviderOffer
        && order.providerIdSnapshot
        && order.providerProductIdSnapshot
        && order.providerExternalProductIdSnapshot
        && order.providerQuantitySnapshot
    );

    // ── Resolve provider adapter ──────────────────────────────────────────
    // Routed orders deliberately ignore an injected/legacy adapter and resolve
    // from their immutable supplier snapshot. Legacy orders keep prior behavior.
    let resolvedProvider = hasRoutingSnapshot ? null : provider;
    if (!resolvedProvider) {
        try {
            const productProviderId = hasRoutingSnapshot
                ? order.providerIdSnapshot
                : order.productId?.provider;
            if (!productProviderId) {
                throw new Error(hasRoutingSnapshot
                    ? 'Order has no snapshotted Provider linked.'
                    : 'Product has no Provider linked.');
            }
            const providerDoc = await Provider.findById(productProviderId);
            if (!providerDoc) {
                throw new Error(`Provider ${productProviderId} not found in DB.`);
            }
            if (!providerDoc.isActive) {
                throw new Error(`Provider '${providerDoc.name}' is inactive.`);
            }
            resolvedProvider = getProviderAdapter(providerDoc);
        } catch (resolveErr) {
            console.error(`[Fulfillment] Provider resolution failed for order ${orderId}:`, resolveErr.message);

            // Provider resolution is known to have failed before placeOrder().
            // Still use a CAS transition so a concurrent worker cannot turn an
            // already terminal order into FAILED.
            const now = new Date();
            const failedOrder = await transitionFromProcessing(orderId, {
                status: ORDER_STATUS.FAILED,
                providerRawResponse: { error: resolveErr.message },
                failedAt: now,
                lastCheckedAt: now,
            }, {
                providerOrderId: null,
                providerStatus: null,
            });

            if (!failedOrder) {
                return { order: await Order.findById(orderId), placed: false, refunded: false };
            }

            createAuditLog({
                actorId, actorRole, ipAddress, userAgent,
                action: ORDER_ACTIONS.FAILED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: orderId,
                metadata: { orderId: orderId.toString(), reason: 'PROVIDER_RESOLUTION_FAILED', error: resolveErr.message },
            });

            // Refund the user
            let refundIssued = false;
            try {
                refundIssued = await refundFailedOrder(failedOrder);
            } catch (refundErr) {
                console.error(`[Fulfillment] Refund FAILED for order ${orderId}:`, refundErr.message);
            }

            return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
        }
    }

    // Routed orders use immutable dispatch values. Legacy orders retain the
    // existing Product → ProviderProduct resolution path during migration.
    let externalProductId = hasRoutingSnapshot ? order.providerExternalProductIdSnapshot : null;
    if (!hasRoutingSnapshot) {
        try {
            if (order.productId?._id) {
                externalProductId = await getExternalProductId(order.productId._id);
            }
        } catch (_) { /* non-fatal — fallback to productId below */ }
    }

    // ── Build provider params from customerInput.values + providerMapping ───────
    // Convert internal field keys → provider-expected parameter names.
    // Falls back to identity mapping when no providerMapping is defined.
    const rawCustomerValues = order.customerInput?.values ?? {};
    const mappedCustomerFields = applyProviderMapping(
        rawCustomerValues,
        hasRoutingSnapshot
            ? order.providerMappingSnapshot
            : order.productId?.providerMapping ?? null
    );

    // ── Claim provider dispatch, then call the provider ─────────────────────────
    // A claim is persisted before the outbound request.  A second executeOrder()
    // invocation sees PLACEMENT_UNCERTAIN and must recover by reference instead of
    // submitting another provider order.
    const dispatchClaimedAt = new Date();
    const claimedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            status: ORDER_STATUS.PROCESSING,
            providerOrderId: null,
            providerStatus: null,
        },
        {
            $set: {
                providerStatus: 'PLACEMENT_UNCERTAIN',
                providerRawResponse: { placement: 'dispatching' },
                lastCheckedAt: dispatchClaimedAt,
            },
        },
        { new: true }
    );

    if (!claimedOrder) {
        return { order: await Order.findById(orderId), placed: false, refunded: false };
    }

    console.log(`[Fulfillment] Placing order ${orderId} with provider…`);

    let result;
    try {
        result = await resolvedProvider.placeOrder({
            providerProductId: externalProductId ?? String(order.productId._id),
            externalProductId: externalProductId ?? String(order.productId._id),
            quantity: hasRoutingSnapshot ? order.providerQuantitySnapshot : order.quantity,
            // Stable upstream idempotency reference. It is persisted on Order
            // and must never be regenerated by an adapter or a retry.
            referenceId: order.orderNumber,
            ...mappedCustomerFields,   // ← spread translated customer fields onto params
        });
    } catch (err) {
        // A thrown call has no trustworthy normalized provider outcome.  The
        // provider may have accepted the request before a timeout, reset, HTTP
        // error, DNS failure, or client error was observed.  Never refund or
        // resubmit from this path; recover using the persisted order reference.
        console.warn(`[Fulfillment] Ambiguous error placing order ${orderId} — leaving PROCESSING for reference recovery:`, err.message);
        result = {
            success: true,
            providerOrderId: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
            rawResponse: {
                message: err.message,
                code: err.code ?? null,
                httpStatus: err.response?.status ?? null,
                placement: 'uncertain',
            },
            errorMessage: null,
        };
    }

    console.log(`[Fulfillment] Provider response for order ${orderId}:`, JSON.stringify(result));

    // ── Interpret result ───────────────────────────────────────────────────────
    let newStatus;
    let refundIssued = false;

    if (!result.success) {
        newStatus = ORDER_STATUS.FAILED;
    } else {
        try {
            newStatus = toInternalStatus(result.providerStatus);
        } catch (_) {
            newStatus = ORDER_STATUS.FAILED;
        }
    }

    // ── Persist the provider response onto the order ───────────────────────────
    const now = new Date();

    if (newStatus === ORDER_STATUS.FAILED) {
        const failedOrder = await transitionFromProcessing(orderId, {
            status: ORDER_STATUS.FAILED,
            providerStatus: result.providerStatus,
            providerOrderId: result.providerOrderId,
            providerRawResponse: result.rawResponse,
            failedAt: now,
            lastCheckedAt: now,
        }, {
            // A normalized rejection is safe to refund only while this
            // execution still owns the pre-dispatch PLACEMENT_UNCERTAIN claim.
            providerOrderId: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
        });

        if (!failedOrder) {
            return { order: await Order.findById(orderId), placed: false, refunded: false };
        }

        // Audit: placement failed
        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: PROVIDER_ACTIONS.ORDER_PLACE_FAILED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: {
                orderId: orderId.toString(),
                errorMessage: result.errorMessage,
                providerStatus: result.providerStatus,
                rawResponse: result.rawResponse,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.FAILED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: { orderId: orderId.toString(), reason: 'PROVIDER_REJECTED' },
        });

        // Refund
        try {
            refundIssued = await refundFailedOrder(failedOrder);
        } catch (refundErr) {
            console.error(`[Fulfillment] Refund FAILED for order ${orderId}:`, refundErr.message);
        }

        // Notification: fire-and-forget
        notifyOrderFailed(failedOrder);

        return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
    }

    if (newStatus === ORDER_STATUS.PROCESSING) {
        // Case B: pending — save providerOrderId, cron will poll
        const pendingOrder = await Order.findOneAndUpdate(
            {
                _id: orderId,
                status: ORDER_STATUS.PROCESSING,
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
            },
            {
                $set: {
                    providerOrderId: result.providerOrderId,
                    providerStatus: result.providerStatus,
                    providerRawResponse: result.rawResponse,
                    lastCheckedAt: now,
                },
            },
            { new: true }
        );

        if (!pendingOrder) {
            return { order: await Order.findById(orderId), placed: false, refunded: false };
        }

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: PROVIDER_ACTIONS.ORDER_PLACED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: {
                orderId: orderId.toString(),
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
            },
        });

        return { order: pendingOrder, placed: true, refunded: false };
    }

    if (newStatus === ORDER_STATUS.CANCELED) {
        const canceledOrder = await transitionFromProcessing(orderId, {
            status: ORDER_STATUS.CANCELED,
            providerOrderId: result.providerOrderId,
            providerStatus: result.providerStatus,
            providerRawResponse: result.rawResponse,
            failedAt: now,
            lastCheckedAt: now,
        }, {
            // Do not let a late placement response override a provider order
            // already recovered by reference and returned as still pending.
            providerOrderId: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
        });

        if (!canceledOrder) {
            return { order: await Order.findById(orderId), placed: false, refunded: false };
        }

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: PROVIDER_ACTIONS.ORDER_CANCELLED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: {
                orderId: orderId.toString(),
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
                rawResponse: result.rawResponse,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.CANCELED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: { orderId: orderId.toString(), reason: 'PROVIDER_CANCELLED' },
        });

        try {
            refundIssued = await refundFailedOrder(canceledOrder);
        } catch (refundErr) {
            console.error(`[Fulfillment] Refund FAILED for canceled order ${orderId}:`, refundErr.message);
        }

        notifyOrderFailed(canceledOrder);

        return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
    }

    if (newStatus === ORDER_STATUS.PARTIAL) {
        const pendingPartial = await Order.findOneAndUpdate(
            {
                _id: orderId,
                status: ORDER_STATUS.PROCESSING,
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
            },
            {
                $set: {
                    providerOrderId: result.providerOrderId,
                    providerStatus: result.providerStatus,
                    providerRawResponse: result.rawResponse,
                    lastCheckedAt: now,
                },
            },
            { new: true }
        );
        if (!pendingPartial) {
            return { order: await Order.findById(orderId), placed: false, refunded: false };
        }
        return processOrderStatusResult(
            pendingPartial,
            {
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
                rawResponse: result.rawResponse,
            }
        );
    }

    // Case A: Completed immediately
    const completedOrder = await transitionFromProcessing(orderId, {
        status: ORDER_STATUS.COMPLETED,
        providerOrderId: result.providerOrderId,
        providerStatus: result.providerStatus,
        providerRawResponse: result.rawResponse,
        lastCheckedAt: now,
    });

    if (!completedOrder) {
        return { order: await Order.findById(orderId), placed: false, refunded: false };
    }

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: PROVIDER_ACTIONS.ORDER_COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: orderId,
        metadata: {
            orderId: orderId.toString(),
            providerOrderId: result.providerOrderId,
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: ORDER_ACTIONS.COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: orderId,
        metadata: { orderId: orderId.toString() },
    });

    // Notification: fire-and-forget
    notifyOrderCompleted(completedOrder);

    return { order: completedOrder, placed: true, refunded: false };

    // ─── END OF TOP-LEVEL CRASH GUARD ──────────────────────────────────────
    } catch (fatalErr) {
        // Something completely unexpected crashed.  The provider may already
        // have accepted the request, so preserve funds and require review.
        console.error(`[Fulfillment] FATAL crash in executeOrder for ${orderId}:`, fatalErr);

        try {
            const now = new Date();
            await transitionFromProcessing(orderId, {
                status: ORDER_STATUS.MANUAL_REVIEW,
                providerRawResponse: { fatalError: fatalErr.message, stack: fatalErr.stack },
                lastCheckedAt: now,
            });
        } catch (cleanupErr) {
            console.error(`[Fulfillment] Cleanup also failed for ${orderId}:`, cleanupErr.message);
        }

        return { order: await Order.findById(orderId).catch(() => null), placed: false, refunded: false };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS ONE STATUS RESULT (shared between cron and manual check)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * processOrderStatusResult(order, statusResult)
 *
 * Given a fresh OrderStatusResult from the provider, update the local order.
 * Handles COMPLETED, CANCELLED (→ refund), and PENDING (→ increment retry).
 *
 * @param {Object} order        - Mongoose Order document (must be PROCESSING)
 * @param {Object} statusResult - { providerOrderId, providerStatus, rawResponse }
 * @returns {Promise<{ action: 'completed'|'failed'|'pending'|'manual-review'|'skipped' }>}
 */
const processOrderStatusResult = async (order, statusResult) => {
    if (order.status !== ORDER_STATUS.PROCESSING) {
        return { action: 'skipped' };
    }

    const now = new Date();
    const providerStatus = statusResult.providerStatus;

    if (!isTerminal(providerStatus)) {
        // Still pending — bump retry count
        const newRetry = order.retryCount + 1;

        if (newRetry >= MAX_RETRY_COUNT) {
            // Pending/Processing is not a confirmed provider failure.
            // Escalate for manual investigation and never auto-refund.
            const moved = await Order.findOneAndUpdate(
                {
                    _id: order._id,
                    status: ORDER_STATUS.PROCESSING,
                },
                {
                    $set: {
                        status: ORDER_STATUS.MANUAL_REVIEW,
                        providerStatus,
                        providerRawResponse: statusResult.rawResponse,
                        retryCount: newRetry,
                        lastCheckedAt: now,
                    },
                },
                { new: true }
            );

            if (!moved) {
                return { action: 'skipped' };
            }

            createAuditLog({
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
                action: PROVIDER_ACTIONS.RETRY_LIMIT_EXCEEDED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: {
                    orderId: order._id.toString(),
                    providerOrderId: order.providerOrderId,
                    providerStatus,
                    retryCount: newRetry,
                    reason: 'PENDING_RETRY_LIMIT',
                },
            });

            return { action: 'manual-review' };
        }

        // Not yet at limit — just update retry count and lastCheckedAt
        const pendingOrder = await Order.findOneAndUpdate(
            { _id: order._id, status: ORDER_STATUS.PROCESSING },
            {
                $set: {
                    providerStatus: providerStatus,
                    providerRawResponse: statusResult.rawResponse,
                    retryCount: newRetry,
                    lastCheckedAt: now,
                },
            },
            { new: true }
        );

        return { action: pendingOrder ? 'pending' : 'skipped' };
    }

    // Terminal: Completed — no refund needed
    if (!requiresRefund(providerStatus)) {
        const completedOrder = await transitionFromProcessing(order._id, {
            status: ORDER_STATUS.COMPLETED,
            providerStatus: providerStatus,
            providerRawResponse: statusResult.rawResponse,
            lastCheckedAt: now,
        });

        if (!completedOrder) {
            return { action: 'skipped' };
        }

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: PROVIDER_ACTIONS.ORDER_COMPLETED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                status: providerStatus,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.COMPLETED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: { orderId: order._id.toString() },
        });

        // Notification: fire-and-forget
        notifyOrderCompleted(completedOrder);

        return { action: 'completed' };
    }

    // ── Determine if this is CANCELED or PARTIAL ─────────────────────────
    const mappedStatus = toInternalStatus(providerStatus);

    if (mappedStatus === ORDER_STATUS.PARTIAL) {
        // ── PARTIAL: extract remains from provider response ──────────────
        const remainsStr = statusResult?.rawResponse?.remains
            || statusResult?.rawResponse?.data?.remains
            || '0';
        const remains = parseInt(remainsStr, 10) || 0;

        const partialOrder = await transitionFromProcessing(order._id, {
            status: ORDER_STATUS.PARTIAL,
            providerStatus: providerStatus,
            providerRawResponse: statusResult.rawResponse,
            remains: remains,
            lastCheckedAt: now,
        });

        if (!partialOrder) {
            return { action: 'skipped' };
        }

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.PARTIAL_REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                status: providerStatus,
                remains,
                quantity: order.quantity,
            },
        });

        // Trigger partial refund via processOrderRefund
        const { processOrderRefund } = require('./order.service');
        try {
            await processOrderRefund(partialOrder._id, remains, {
                actorId: partialOrder.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
            });
        } catch (e) {
            console.error(`[Fulfillment] Partial refund error for ${order._id}:`, e.message);
        }

        return { action: 'failed' };
    }

    if (mappedStatus === ORDER_STATUS.CANCELED) {
        // ── CANCELED: full refund ────────────────────────────────────────
        const canceledOrder = await transitionFromProcessing(order._id, {
            status: ORDER_STATUS.CANCELED,
            providerStatus: providerStatus,
            providerRawResponse: statusResult.rawResponse,
            failedAt: now,
            lastCheckedAt: now,
        });

        if (!canceledOrder) {
            return { action: 'skipped' };
        }

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: PROVIDER_ACTIONS.ORDER_CANCELLED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                status: providerStatus,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.CANCELED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: { orderId: order._id.toString(), reason: 'PROVIDER_CANCELLED' },
        });

        // Trigger full refund via processOrderRefund
        const { processOrderRefund } = require('./order.service');
        try {
            await processOrderRefund(canceledOrder._id, 0, {
                actorId: canceledOrder.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
            });
        } catch (e) {
            console.error(`[Fulfillment] Full refund error for ${order._id}:`, e.message);
        }

        return { action: 'failed' };
    }

    // ── FAILED (internal failures, rejected) — existing refund path ──────
    const failedOrder = await transitionFromProcessing(order._id, {
        status: ORDER_STATUS.FAILED,
        providerStatus: providerStatus,
        providerRawResponse: statusResult.rawResponse,
        failedAt: now,
        lastCheckedAt: now,
    });

    if (!failedOrder) {
        return { action: 'skipped' };
    }

    createAuditLog({
        actorId: order.userId,
        actorRole: ACTOR_ROLES.SYSTEM,
        action: PROVIDER_ACTIONS.ORDER_CANCELLED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            orderId: order._id.toString(),
            providerOrderId: order.providerOrderId,
            status: providerStatus,
        },
    });

    createAuditLog({
        actorId: order.userId,
        actorRole: ACTOR_ROLES.SYSTEM,
        action: ORDER_ACTIONS.FAILED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: { orderId: order._id.toString(), reason: 'PROVIDER_FAILED' },
    });

    await refundFailedOrder(failedOrder).catch((e) =>
        console.error(`[Fulfillment] Refund error (failed) for ${order._id}:`, e.message)
    );

    return { action: 'failed' };
};

// ─────────────────────────────────────────────────────────────────────────────
// CRON: POLL ALL PROCESSING ORDERS (batch, grouped by providerCode snapshot)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 * @private
 */
const _escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A timeout after dispatch is not a confirmed provider rejection. Keep these
 * orders out of the normal fail/refund path until a reference lookup has
 * either recovered the remote ID or exhausted the manual-review policy.
 */
const recoverUncertainPlacement = async (order, adapter, unavailableRecovery = 'unsupported') => {
    const now = new Date();
    const defer = async (recovery) => {
        const retryCount = Number(order.retryCount || 0) + 1;
        const exhausted = retryCount >= MAX_RETRY_COUNT;
        const filter = {
            providerOrderId: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
        };
        const updated = exhausted
            ? await transitionFromProcessing(order._id, {
                status: ORDER_STATUS.MANUAL_REVIEW,
                providerStatus: 'PLACEMENT_UNCERTAIN',
                providerRawResponse: { placement: 'uncertain', recovery },
                retryCount,
                lastCheckedAt: now,
            }, filter)
            : await Order.findOneAndUpdate(
                { _id: order._id, status: ORDER_STATUS.PROCESSING, ...filter },
                {
                    $set: {
                        providerStatus: 'PLACEMENT_UNCERTAIN',
                        providerRawResponse: { placement: 'uncertain', recovery },
                        retryCount,
                        lastCheckedAt: now,
                    },
                },
                { new: true }
            );
        return { action: updated ? (exhausted ? 'manual-review' : 'pending') : 'skipped' };
    };

    if (!adapter || typeof adapter.checkOrderByReference !== 'function') {
        return defer(unavailableRecovery);
    }

    try {
        const result = await adapter.checkOrderByReference(order.orderNumber);
        if (!result?.found || !result.providerOrderId) {
            return defer('not_found');
        }

        const recovered = await Order.findOneAndUpdate(
            {
                _id: order._id,
                status: ORDER_STATUS.PROCESSING,
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
            },
            {
                $set: {
                    providerOrderId: result.providerOrderId,
                    providerStatus: result.providerStatus,
                    providerRawResponse: result.rawResponse,
                    lastCheckedAt: now,
                },
            },
            { new: true }
        );
        if (!recovered) return { action: 'skipped' };
        return processOrderStatusResult(recovered, result);
    } catch (error) {
        return defer('lookup_failed');
    }
};

/**
 * pollProcessingOrders(providerOverride?)
 *
 * Called by the active cron job every minute.
 *
 * Finds all PROCESSING automatic orders with a providerOrderId, then groups
 * them by order.providerCode — the immutable slug snapshotted at order-creation
 * time. This is the race-condition fix: we never traverse product→provider,
 * so an admin changing a product's provider cannot corrupt in-flight orders.
 *
 * Per-group:
 *   1. Resolve the provider doc from DB by slug (not by product)
 *   2. Call adapter.checkOrders(ids) — one HTTP batch call per provider
 *   3. For each result:
 *       Completed / accept    → COMPLETED
 *       Cancelled / reject    → CANCELED/FAILED + refund (after CAS transition)
 *       wait / Pending        → leave PROCESSING, increment retryCount
 *
 * @param {Object|null} [providerOverride]  - single mock provider (tests only)
 * @returns {Promise<{ checked, completed, failed, pending, errors }>}
 */
const pollProcessingOrders = async (providerOverride = null) => {
    const stats = { checked: 0, completed: 0, failed: 0, pending: 0, manualReview: 0, errors: [] };

    // ── 1. Fetch normal provider-side IDs plus uncertain placement attempts ──
    const processingOrders = await Order.find({
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        $or: [
            { providerOrderId: { $ne: null } },
            { providerStatus: 'PLACEMENT_UNCERTAIN' },
        ],
    }).sort({ lastCheckedAt: 1 }).limit(200);  // oldest-checked first, cap 200/run

    if (!processingOrders.length) return stats;

    // ── 2. Dead-Letter Kill-Switch ────────────────────────────────────────────
    // Partition orders into exhausted (retryCount >= MAX_RETRY_COUNT) and healthy.
    // Exhausted orders are moved to MANUAL_REVIEW RIGHT NOW — NO provider API call
    // is made for them. This prevents infinite loops when a provider goes offline.
    const exhausted = [];
    const healthy   = [];

    for (const order of processingOrders) {
        if (order.retryCount >= MAX_RETRY_COUNT) {
            exhausted.push(order);
        } else {
            healthy.push(order);
        }
    }

    if (exhausted.length) {
        const now = new Date();
        console.warn(
            `[FulfillmentCron] Kill-switch: ${exhausted.length} order(s) exceeded ` +
            `MAX_RETRY_COUNT (${MAX_RETRY_COUNT}) — moving to MANUAL_REVIEW.`
        );

        await Promise.all(exhausted.map(async (order) => {
            try {
                const moved = await transitionFromProcessing(order._id, {
                    status: ORDER_STATUS.MANUAL_REVIEW,
                    lastCheckedAt: now,
                }, { retryCount: { $gte: MAX_RETRY_COUNT } });

                if (!moved) return;

                createAuditLog({
                    actorId:    order.userId,
                    actorRole:  ACTOR_ROLES.SYSTEM,
                    action:     PROVIDER_ACTIONS.RETRY_LIMIT_EXCEEDED,
                    entityType: ENTITY_TYPES.ORDER,
                    entityId:   order._id,
                    metadata: {
                        orderId:        order._id.toString(),
                        providerOrderId: order.providerOrderId,
                        providerCode:   order.providerCode,
                        retryCount:     order.retryCount,
                        maxRetryCount:  MAX_RETRY_COUNT,
                        reason:         'PROVIDER_OFFLINE_OR_STUCK',
                    },
                });

                stats.manualReview++;
                console.warn(
                    `[FulfillmentCron] Order ${order._id} (provider: ${order.providerCode}) ` +
                    `→ MANUAL_REVIEW (retryCount=${order.retryCount})`
                );
            } catch (err) {
                stats.errors.push(`[DLQ:${order._id}] ${err.message}`);
                console.error(
                    `[FulfillmentCron] Failed to move order ${order._id} to MANUAL_REVIEW:`,
                    err.message
                );
            }
        }));
    }

    // Bail early if every order was exhausted
    if (!healthy.length) {
        console.log(
            `[FulfillmentCron] Done (all orders exhausted). ` +
            `manualReview=${stats.manualReview} errors=${stats.errors.length}`
        );
        return stats;
    }

    stats.checked = healthy.length;
    console.log(`[FulfillmentCron] Checking ${healthy.length} healthy PROCESSING order(s)…`);


    // ── Helper: process results from a single provider batch ─────────────────
    const _recordAction = (action) => {
        if (action === 'completed') stats.completed++;
        else if (action === 'failed') stats.failed++;
        else if (action === 'manual-review') stats.manualReview++;
        else stats.pending++;
    };

    const _applyResults = async (orders, statusResults) => {
        const resultMap = new Map(
            statusResults.map((r) => [String(r.providerOrderId), r])
        );

        for (const order of orders) {
            const statusResult = resultMap.get(String(order.providerOrderId));

            if (!statusResult) {
                // Provider didn't include this order  — skip this cycle
                stats.pending++;
                continue;
            }

            try {
                const { action } = await processOrderStatusResult(order, statusResult);
                _recordAction(action);
            } catch (err) {
                stats.errors.push(`[${order._id}] ${err.message}`);
                console.error(`[FulfillmentCron] Error processing order ${order._id}:`, err.message);
                stats.pending++;
            }
        }
    };

    // ── Test / single-provider override ──────────────────────────────────────
    if (providerOverride) {
        const uncertain = healthy.filter((order) => order.providerStatus === 'PLACEMENT_UNCERTAIN' && !order.providerOrderId);
        const normal = healthy.filter((order) => order.providerOrderId != null);
        for (const order of uncertain) {
            try {
                _recordAction((await recoverUncertainPlacement(order, providerOverride)).action);
            } catch (err) {
                stats.errors.push(`[${order._id}] ${err.message}`);
                stats.pending++;
            }
        }
        if (!normal.length) return stats;

        const ids = normal.map((o) => o.providerOrderId);
        let statusResults = [];
        try {
            // Support both method names for test mocks
            const batchFn = providerOverride.checkOrdersBatch ?? providerOverride.checkOrders;
            statusResults = await batchFn.call(providerOverride, ids);
        } catch (err) {
            stats.errors.push(`Batch check failed: ${err.message}`);
            console.error('[FulfillmentCron] checkOrders error (override):', err.message);
            return stats;
        }
        await _applyResults(normal, statusResults);
        console.log(`[FulfillmentCron] Done (override). completed=${stats.completed} failed=${stats.failed} pending=${stats.pending}`);
        return stats;
    }

    // ── Production: group by order.providerCode (snapshot, race-condition safe) ──
    const groupsByCode = new Map();
    for (const order of healthy) {
        const code = String(order.providerCode || '').toLowerCase().trim() || '_unknown';
        if (!groupsByCode.has(code)) groupsByCode.set(code, []);
        groupsByCode.get(code).push(order);
    }

    for (const [code, orders] of groupsByCode) {
        try {
            // ── Resolve provider doc by slug snapshot (not by product) ────────
            const { Provider } = require('../providers/provider.model');
            const providerDoc = await Provider.findOne({
                $or: [
                    { slug: code },
                    { name: { $regex: `^${_escapeRegex(code)}$`, $options: 'i' } },
                ],
                isActive: true,
            });

            if (!providerDoc) {
                console.warn(
                    `[FulfillmentCron] No active provider for code "${code}" —` +
                    ` deferring uncertain placement recovery for ${orders.length} order(s). ` +
                    `(Provider may have been deactivated or renamed.)`
                );
                const uncertain = orders.filter((order) =>
                    order.providerStatus === 'PLACEMENT_UNCERTAIN' && !order.providerOrderId
                );
                const normal = orders.filter((order) => order.providerOrderId != null);

                for (const order of uncertain) {
                    try {
                        _recordAction((await recoverUncertainPlacement(
                            order,
                            null,
                            'provider_resolution_unavailable'
                        )).action);
                    } catch (err) {
                        stats.errors.push(`[${order._id}] ${err.message}`);
                        stats.pending++;
                    }
                }
                normal.forEach(() => stats.pending++);
                continue;
            }

            const adapter = getProviderAdapter(providerDoc);
            const uncertain = orders.filter((order) => order.providerStatus === 'PLACEMENT_UNCERTAIN' && !order.providerOrderId);
            const normal = orders.filter((order) => order.providerOrderId != null);

            for (const order of uncertain) {
                try {
                    _recordAction((await recoverUncertainPlacement(order, adapter)).action);
                } catch (err) {
                    stats.errors.push(`[${order._id}] ${err.message}`);
                    stats.pending++;
                }
            }
            if (!normal.length) continue;

            const ids = normal.map((o) => o.providerOrderId);

            // ── Call the provider batch-check endpoint ────────────────────────
            let statusResults = [];
            try {
                // Adapters expose checkOrders(); base may also alias checkOrdersBatch()
                const batchFn = adapter.checkOrders?.bind(adapter)
                    ?? adapter.checkOrdersBatch?.bind(adapter);

                if (!batchFn) {
                    throw new Error(`Adapter for "${code}" has no checkOrders / checkOrdersBatch method.`);
                }

                statusResults = await batchFn(ids);
            } catch (batchErr) {
                // Classify: transient network / 5xx → leave PROCESSING, do NOT fail orders.
                // Hard error (adapter bug, auth failure) → log as error.
                const isTransient =
                    batchErr.code === 'ECONNABORTED' ||
                    batchErr.code === 'ETIMEDOUT'    ||
                    batchErr.code === 'ECONNRESET'   ||
                    (batchErr.response?.status ?? 0) >= 500 ||
                    String(batchErr.message ?? '').toLowerCase().includes('timeout');

                console[isTransient ? 'warn' : 'error'](
                    `[FulfillmentCron] ${isTransient ? 'Transient error' : 'Error'} ` +
                    `checking batch for "${code}" (${orders.length} orders):`,
                    batchErr.message
                );

                // Leave all orders in this group PROCESSING  — cron will retry.
                normal.forEach(() => stats.pending++);
                stats.errors.push(`[${code}] ${batchErr.message}`);
                continue;   // don't crash the loop for other providers
            }

            await _applyResults(normal, statusResults);

        } catch (groupErr) {
            // Unexpected crash (e.g. DB error) — log but keep going
            console.error(`[FulfillmentCron] Group "${code}" crashed:`, groupErr.message);
            orders.forEach(() => stats.errors.push(`[${code}] ${groupErr.message}`));
        }
    }

    console.log(
        `[FulfillmentCron] Done. ` +
        `checked=${stats.checked} completed=${stats.completed} ` +
        `failed=${stats.failed} pending=${stats.pending} ` +
        `manualReview=${stats.manualReview} errors=${stats.errors.length}`
    );
    return stats;
};

module.exports = {
    executeOrder,
    refundFailedOrder,
    processOrderStatusResult,
    pollProcessingOrders,
};
