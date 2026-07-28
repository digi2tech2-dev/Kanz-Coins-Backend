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
const Provider = require('../providers/provider.model');
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
 * This function NEVER throws — all errors are caught, the order is marked
 * FAILED, and a refund is attempted.
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

    // ── Self-resolve provider adapter if none was passed ──────────────────
    let resolvedProvider = provider;
    if (!resolvedProvider) {
        try {
            const productProviderId = order.productId?.provider;
            if (!productProviderId) {
                throw new Error('Product has no Provider linked.');
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

            // Mark FAILED with clear diagnostic message
            const now = new Date();
            await Order.findByIdAndUpdate(orderId, {
                $set: {
                    status: ORDER_STATUS.FAILED,
                    providerRawResponse: { error: resolveErr.message },
                    failedAt: now,
                    lastCheckedAt: now,
                },
            });

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
                const freshOrder = await Order.findById(orderId);
                refundIssued = await refundFailedOrder(freshOrder);
            } catch (refundErr) {
                console.error(`[Fulfillment] Refund FAILED for order ${orderId}:`, refundErr.message);
            }

            return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
        }
    }

    // ── Resolve externalProductId via the 3-layer chain ─────────────────────
    // Order → Platform Product → ProviderProduct → externalProductId
    let externalProductId = null;
    try {
        if (order.productId?._id) {
            externalProductId = await getExternalProductId(order.productId._id);
        }
    } catch (_) { /* non-fatal — fallback to productId below */ }

    // ── Build provider params from customerInput.values + providerMapping ───────
    // Convert internal field keys → provider-expected parameter names.
    // Falls back to identity mapping when no providerMapping is defined.
    const rawCustomerValues = order.customerInput?.values ?? {};
    const mappedCustomerFields = applyProviderMapping(
        rawCustomerValues,
        order.productId?.providerMapping ?? null
    );

    // ── Call the provider ──────────────────────────────────────────────────────
    console.log(`[Fulfillment] Placing order ${orderId} with provider…`);

    let result;
    try {
        result = await resolvedProvider.placeOrder({
            providerProductId: externalProductId ?? String(order.productId._id),
            externalProductId: externalProductId ?? String(order.productId._id),
            quantity: order.quantity,
            ...mappedCustomerFields,   // ← spread translated customer fields onto params
        });
    } catch (err) {
        // Classify the error: transient (network/timeout) vs hard rejection.
        //
        // TRANSIENT → keep PROCESSING so the cron can retry later.
        //   Refunding immediately on a network blip would cause a double-loss:
        //   the provider may have already accepted and queued the order.
        //
        // HARD FAILURE → order cannot proceed → mark FAILED + refund.
        const isTransient =
            err.code === 'ECONNABORTED'  ||
            err.code === 'ETIMEDOUT'     ||
            err.code === 'ECONNRESET'    ||
            err.code === 'ENOTFOUND'     ||
            err.response?.status === 503 ||
            err.response?.status === 504 ||
            String(err.message ?? '').toLowerCase().includes('timeout');

        if (isTransient) {
            console.warn(`[Fulfillment] Transient error placing order ${orderId} — leaving PROCESSING for cron retry:`, err.message);
            // Return a synthetic "still pending" result — DO NOT refund.
            result = {
                success: true,
                providerOrderId: null,
                providerStatus: 'Pending',         // → stays PROCESSING
                rawResponse: { message: err.message, isTransient: true },
                errorMessage: null,
            };
        } else {
            // Hard failure: provider explicitly rejected or gave an unexpected error.
            result = {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: err.providerBody ?? { message: err.message },
                errorMessage: err.message,
            };
        }
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
        await Order.findByIdAndUpdate(orderId, {
            $set: {
                status: ORDER_STATUS.FAILED,
                providerStatus: result.providerStatus,
                providerOrderId: result.providerOrderId,
                providerRawResponse: result.rawResponse,
                failedAt: now,
                lastCheckedAt: now,
            },
        });

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
            const freshOrder = await Order.findById(orderId);
            refundIssued = await refundFailedOrder(freshOrder);
        } catch (refundErr) {
            console.error(`[Fulfillment] Refund FAILED for order ${orderId}:`, refundErr.message);
        }

        // Notification: fire-and-forget
        notifyOrderFailed(await Order.findById(orderId).catch(() => null));

        return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
    }

    if (newStatus === ORDER_STATUS.PROCESSING) {
        // Case B: pending — save providerOrderId, cron will poll
        await Order.findByIdAndUpdate(orderId, {
            $set: {
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
                providerRawResponse: result.rawResponse,
                lastCheckedAt: now,
            },
        });

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

        return { order: await Order.findById(orderId), placed: true, refunded: false };
    }

    if (newStatus === ORDER_STATUS.CANCELED) {
        await Order.findByIdAndUpdate(orderId, {
            $set: {
                status: ORDER_STATUS.CANCELED,
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
                providerRawResponse: result.rawResponse,
                failedAt: now,
                lastCheckedAt: now,
            },
        });

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
            const freshOrder = await Order.findById(orderId);
            refundIssued = await refundFailedOrder(freshOrder);
        } catch (refundErr) {
            console.error(`[Fulfillment] Refund FAILED for canceled order ${orderId}:`, refundErr.message);
        }

        notifyOrderFailed(await Order.findById(orderId).catch(() => null));

        return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
    }

    if (newStatus === ORDER_STATUS.PARTIAL) {
        return processOrderStatusResult(
            await Order.findByIdAndUpdate(orderId, {
                $set: {
                    providerOrderId: result.providerOrderId,
                    providerStatus: result.providerStatus,
                    providerRawResponse: result.rawResponse,
                    lastCheckedAt: now,
                },
            }, { new: true }),
            {
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
                rawResponse: result.rawResponse,
            }
        );
    }

    // Case A: Completed immediately
    await Order.findByIdAndUpdate(orderId, {
        $set: {
            status: ORDER_STATUS.COMPLETED,
            providerOrderId: result.providerOrderId,
            providerStatus: result.providerStatus,
            providerRawResponse: result.rawResponse,
            lastCheckedAt: now,
        },
    });

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
    notifyOrderCompleted(await Order.findById(orderId));

    return { order: await Order.findById(orderId), placed: true, refunded: false };

    // ─── END OF TOP-LEVEL CRASH GUARD ──────────────────────────────────────
    } catch (fatalErr) {
        // Something completely unexpected crashed — mark FAILED + refund
        console.error(`[Fulfillment] FATAL crash in executeOrder for ${orderId}:`, fatalErr);

        try {
            const now = new Date();
            await Order.findByIdAndUpdate(orderId, {
                $set: {
                    status: ORDER_STATUS.FAILED,
                    providerRawResponse: { fatalError: fatalErr.message, stack: fatalErr.stack },
                    failedAt: now,
                    lastCheckedAt: now,
                },
            });

            const freshOrder = await Order.findById(orderId);
            if (freshOrder) {
                await refundFailedOrder(freshOrder);
            }
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
 * @returns {Promise<{ action: 'completed'|'failed'|'pending'|'skipped' }>}
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
            // Exceeded retry limit → force-fail
            await Order.findByIdAndUpdate(order._id, {
                $set: {
                    status: ORDER_STATUS.FAILED,
                    providerStatus: providerStatus,
                    providerRawResponse: statusResult.rawResponse,
                    retryCount: newRetry,
                    failedAt: now,
                    lastCheckedAt: now,
                },
            });

            createAuditLog({
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
                action: PROVIDER_ACTIONS.RETRY_LIMIT_EXCEEDED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: {
                    orderId: order._id.toString(),
                    providerOrderId: order.providerOrderId,
                    retryCount: newRetry,
                },
            });

            createAuditLog({
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
                action: ORDER_ACTIONS.FAILED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: { orderId: order._id.toString(), reason: 'RETRY_LIMIT_EXCEEDED' },
            });

            const freshOrder = await Order.findById(order._id);
            await refundFailedOrder(freshOrder).catch((e) =>
                console.error(`[Fulfillment] Refund error (retry limit) for ${order._id}:`, e.message)
            );

            return { action: 'failed' };
        }

        // Not yet at limit — just update retry count and lastCheckedAt
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                retryCount: newRetry,
                lastCheckedAt: now,
            },
        });

        return { action: 'pending' };
    }

    // Terminal: Completed — no refund needed
    if (!requiresRefund(providerStatus)) {
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.COMPLETED,
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                lastCheckedAt: now,
            },
        });

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
        notifyOrderCompleted(order);

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

        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.PARTIAL,
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                remains: remains,
                lastCheckedAt: now,
            },
        });

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
            await processOrderRefund(order._id, remains, {
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
            });
        } catch (e) {
            console.error(`[Fulfillment] Partial refund error for ${order._id}:`, e.message);
        }

        return { action: 'failed' };
    }

    if (mappedStatus === ORDER_STATUS.CANCELED) {
        // ── CANCELED: full refund ────────────────────────────────────────
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.CANCELED,
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                failedAt: now,
                lastCheckedAt: now,
            },
        });

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
            await processOrderRefund(order._id, 0, {
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
            });
        } catch (e) {
            console.error(`[Fulfillment] Full refund error for ${order._id}:`, e.message);
        }

        return { action: 'failed' };
    }

    // ── FAILED (internal failures, rejected) — existing refund path ──────
    await Order.findByIdAndUpdate(order._id, {
        $set: {
            status: ORDER_STATUS.FAILED,
            providerStatus: providerStatus,
            providerRawResponse: statusResult.rawResponse,
            failedAt: now,
            lastCheckedAt: now,
        },
    });

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

    const freshOrder = await Order.findById(order._id);
    await refundFailedOrder(freshOrder).catch((e) =>
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
 * pollProcessingOrders(providerOverride?)
 *
 * Called by the cron job every N minutes.
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
 *       Cancelled / reject    → FAILED + refund  (via processOrderStatusResult)
 *       wait / Pending / 5xx  → leave PROCESSING, increment retryCount
 *
 * @param {Object|null} [providerOverride]  - single mock provider (tests only)
 * @returns {Promise<{ checked, completed, failed, pending, errors }>}
 */
const pollProcessingOrders = async (providerOverride = null) => {
    const stats = { checked: 0, completed: 0, failed: 0, pending: 0, manualReview: 0, errors: [] };

    // ── 1. Fetch all PROCESSING automatic orders with a provider-side ID ──────
    const processingOrders = await Order.find({
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerOrderId: { $ne: null },
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
                await Order.findByIdAndUpdate(order._id, {
                    $set: {
                        status: ORDER_STATUS.MANUAL_REVIEW,
                        lastCheckedAt: now,
                    },
                });

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
                if (action === 'completed') stats.completed++;
                else if (action === 'failed') stats.failed++;
                else stats.pending++;
            } catch (err) {
                stats.errors.push(`[${order._id}] ${err.message}`);
                console.error(`[FulfillmentCron] Error processing order ${order._id}:`, err.message);
                stats.pending++;
            }
        }
    };

    // ── Test / single-provider override ──────────────────────────────────────
    if (providerOverride) {
        const ids = healthy.map((o) => o.providerOrderId);
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
        await _applyResults(healthy, statusResults);
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
                    ` skipping ${orders.length} order(s). ` +
                    `(Provider may have been deactivated or renamed.)`
                );
                orders.forEach(() => stats.pending++);
                continue;
            }

            const adapter = getProviderAdapter(providerDoc);
            const ids = orders.map((o) => o.providerOrderId);

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
                orders.forEach(() => stats.pending++);
                stats.errors.push(`[${code}] ${batchErr.message}`);
                continue;   // don't crash the loop for other providers
            }

            await _applyResults(orders, statusResults);

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
