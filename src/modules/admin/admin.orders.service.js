'use strict';

/**
 * admin.orders.service.js
 *
 * Admin-level order inspection, retry, and manual refund.
 */

const mongoose = require('mongoose');
const { Order, ORDER_STATUS } = require('../orders/order.model');
const { markOrderAsFailed, processOrderRefund } = require('../orders/order.service');
const { forcedDebitWallet } = require('../wallet/wallet.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { Provider } = require('../providers/provider.model');
const { applyProviderMapping } = require('../orders/orderFields.validator');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

const resolveAuditContext = (adminId, auditContext = null) => ({
    actorId: auditContext?.actorId ?? adminId,
    actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
    ipAddress: auditContext?.ipAddress ?? null,
    userAgent: auditContext?.userAgent ?? null,
});

// ─── List (admin) ─────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string}  [opts.status]
 * @param {string}  [opts.userId]
 * @param {string}  [opts.providerId]  - filter by provider on the linked product
 * @param {string}  [opts.search]      - free-text search (orderNumber, _id, playerID)
 * @param {Date}    [opts.from]
 * @param {Date}    [opts.to]
 * @param {number}  [opts.page]
 * @param {number}  [opts.limit]
 */
const listOrders = async ({
    status,
    userId,
    providerId,
    search,
    from,
    to,
    page = 1,
    limit = 20,
} = {}) => {
    limit = Math.min(limit, 500);
    const skip = (page - 1) * limit;

    // 1. Single queryFilter — every condition goes directly onto this object.
    const queryFilter = {};
    if (status) queryFilter.status = status;
    if (userId) queryFilter.userId = new mongoose.Types.ObjectId(userId);
    if (from || to) {
        queryFilter.createdAt = {};
        if (from) queryFilter.createdAt.$gte = new Date(from);
        if (to) queryFilter.createdAt.$lte = new Date(to);
    }

    // 2. Search conditions — appended as queryFilter.$or
    if (search && String(search).trim()) {
        const s = String(search).trim();
        const searchRegex = new RegExp(s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');

        const orConditions = [
            { 'customerInput.values.playerId': searchRegex },
            { 'customerInput.values.player_id': searchRegex },
            { 'customerInput.values.uid': searchRegex },
            { 'customerInput.values.userId': searchRegex },
            { 'customerInput.values.username': searchRegex },
            { providerOrderId: searchRegex },
        ];

        // Safe ObjectId match
        if (s.length === 24 && /^[a-f\d]{24}$/i.test(s)) {
            orConditions.push({ _id: s });
        }

        // Partial number match for orderNumber (stored as Number)
        orConditions.push({
            $expr: {
                $regexMatch: {
                    input: { $toString: '$orderNumber' },
                    regex: s,
                    options: 'i',
                },
            },
        });

        queryFilter.$or = orConditions;
    }

    // 3. CRITICAL: Pass the EXACT SAME queryFilter to BOTH countDocuments and find.
    const total = await Order.countDocuments(queryFilter);
    const orders = await Order.find(queryFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('productId', 'name basePrice executionType provider')
        .populate('userId', 'name email');

    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Get One ──────────────────────────────────────────────────────────────────

const getOrderById = async (id) => {
    const order = await Order.findById(id)
        .populate('productId', 'name basePrice minQty maxQty executionType provider')
        .populate('userId', 'name email walletBalance');
    if (!order) throw new NotFoundError('Order');
    return order;
};

// ─── Retry ────────────────────────────────────────────────────────────────────

/**
 * Re-submit a FAILED order to the provider.
 *
 * This sets the order back to PROCESSING and attempts a fresh fulfillment.
 * The wallet is NOT re-debited (money was already taken; we're retrying the
 * provider call only).
 *
 * @param {string} orderId
 * @param {string} adminId
 */
const retryOrder = async (orderId, adminId, auditContext = null) => {
    const ctx = resolveAuditContext(adminId, auditContext);
    const order = await Order.findById(orderId)
        .populate({ path: 'productId', select: 'provider providerMapping', populate: { path: 'provider' } });

    if (!order) throw new NotFoundError('Order');

    if (order.status !== ORDER_STATUS.FAILED) {
        throw new BusinessRuleError(
            `Only FAILED orders can be retried. Current status: ${order.status}`,
            'INVALID_STATUS_FOR_RETRY'
        );
    }

    const isRoutedOrder = Boolean(
        order.selectedProviderOffer
        && order.providerIdSnapshot
        && order.providerExternalProductIdSnapshot
        && order.providerQuantitySnapshot
    );
    const providerDoc = isRoutedOrder
        ? await Provider.findById(order.providerIdSnapshot)
        : order.productId?.provider;
    if (!providerDoc) {
        throw new BusinessRuleError(
            isRoutedOrder ? 'The snapshotted Provider no longer exists.' : 'No provider linked to this order\'s product.',
            'NO_PROVIDER'
        );
    }
    if (!providerDoc.isActive) {
        throw new BusinessRuleError('The selected Provider is inactive.', 'PROVIDER_INACTIVE');
    }

    const adapter = getProviderAdapter(providerDoc);
    const externalProductId = isRoutedOrder
        ? order.providerExternalProductIdSnapshot
        : order.providerProductId ?? order.externalProductId;
    if (!externalProductId) {
        throw new BusinessRuleError('Order has no externalProductId — cannot retry.', 'NO_EXTERNAL_ID');
    }

    // Place the order at the provider
    const providerResult = await adapter.placeOrder({
        productId: externalProductId,
        externalProductId,
        quantity: isRoutedOrder ? order.providerQuantitySnapshot : order.quantity,
        referenceId: order.orderNumber,
        ...applyProviderMapping(
            order.customerInput?.values ?? order.orderFieldsValues ?? {},
            isRoutedOrder ? order.providerMappingSnapshot : order.productId?.providerMapping ?? null
        ),
    });

    // Update order with new provider reference
    order.status = ORDER_STATUS.PROCESSING;
    order.providerOrderId = providerResult.orderId ?? order.providerOrderId;
    order.retryCount = (order.retryCount ?? 0) + 1;
    await order.save();

    createAuditLog({
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        action: ADMIN_ACTIONS.ORDER_RETRIED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: { orderId, providerOrderId: order.providerOrderId, retryCount: order.retryCount },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
    });

    return order;
};

// ─── Manual Refund ────────────────────────────────────────────────────────

/**
 * Admin-forced refund of an order.
 *
 * Supports full refund (CANCELED/FAILED) and partial refund (PARTIAL).
 *
 * For non-refunded orders:
 *   - If remains > 0: triggers partial refund via processOrderRefund
 *   - If remains === 0: triggers full refund via markOrderAsFailed
 *
 * @param {string} orderId
 * @param {string} adminId
 * @param {number} [remains=0] - undelivered units for partial refund
 */
const refundOrder = async (orderId, adminId, remains = 0, auditContext = null) => {
    const ctx = resolveAuditContext(adminId, auditContext);
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    // Guard: already refunded
    if (order.refunded === true) {
        throw new BusinessRuleError('A refund has already been issued for this order.', 'ALREADY_REFUNDED');
    }

    // Guard: terminal non-refundable states
    if (order.status === ORDER_STATUS.FAILED || order.status === ORDER_STATUS.CANCELED) {
        if (order.refundedAt) {
            throw new BusinessRuleError('Order is already in a refunded state.', 'ALREADY_REFUNDED');
        }
    }

    const remainsCount = parseInt(remains, 10) || 0;
    let refunded;

    if (remainsCount > 0) {
        // Partial refund — set status to PARTIAL first
        if (order.status !== ORDER_STATUS.PARTIAL) {
            order.status = ORDER_STATUS.PARTIAL;
            await order.save();
        }
        refunded = await processOrderRefund(orderId, remainsCount, ctx);
    } else {
        // Full refund — use existing markOrderAsFailed for FAILED status path
        refunded = await markOrderAsFailed(orderId, ctx);
    }

    createAuditLog({
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        action: ADMIN_ACTIONS.ORDER_REFUNDED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            userId: order.userId,
            totalPrice: order.totalPrice,
            remains: remainsCount,
            isPartial: remainsCount > 0,
        },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
    });

    return refunded;
};

// ─── Sync Order Provider Status ───────────────────────────────────────────────

/**
 * Fetch the latest status for this order from the external provider API.
 * Maps provider status → internal ORDER_STATUS and updates the order.
 *
 * Provider status mapping:
 *   'Completed'  → ORDER_STATUS.COMPLETED
 *   'Cancelled'  → ORDER_STATUS.FAILED
 *   'Pending'    → ORDER_STATUS.PROCESSING (no change if already PROCESSING)
 */
const syncOrderProviderStatus = async (orderId, adminId, auditContext = null) => {
    const ctx = resolveAuditContext(adminId, auditContext);
    const order = await Order.findById(orderId).populate('productId', 'provider');
    if (!order) throw new NotFoundError('Order');

    if (!order.providerOrderId) {
        throw new BusinessRuleError(
            'This order has no provider order ID — it was not sent to any provider.',
            'NO_PROVIDER_ORDER'
        );
    }

    // Routed orders retain their selected provider; legacy orders use the
    // historical Product linkage for compatibility.
    const providerId = order.providerIdSnapshot ?? order.productId?.provider;
    if (!providerId) {
        throw new BusinessRuleError(
            'This order has no linked provider.',
            'NO_PROVIDER_LINKED'
        );
    }

    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('Provider');

    const adapter = getProviderAdapter(provider);

    let statusResult;
    try {
        statusResult = await adapter.checkOrder(order.providerOrderId);
    } catch (err) {
        throw new BusinessRuleError(
            `Failed to fetch status from provider: ${err.message}`,
            'PROVIDER_API_ERROR'
        );
    }

    const before = {
        providerStatus: order.providerStatus,
        status: order.status,
    };

    // Update provider-level fields
    order.providerStatus = statusResult.providerStatus || order.providerStatus;
    order.providerRawResponse = statusResult.rawResponse || order.providerRawResponse;
    order.lastCheckedAt = new Date();

    // Map provider status → internal order status
    const ps = (statusResult.providerStatus || '').toLowerCase();
    let statusChanged = false;
    let newStatus = null;

    if (ps === 'completed' && order.status !== ORDER_STATUS.COMPLETED) {
        order.status = ORDER_STATUS.COMPLETED;
        statusChanged = true;
        newStatus = 'COMPLETED';
    } else if ((ps === 'cancelled' || ps === 'canceled') && order.status !== ORDER_STATUS.CANCELED) {
        order.status = ORDER_STATUS.CANCELED;
        statusChanged = true;
        newStatus = 'CANCELED';
    } else if ((ps === 'partial' || ps === 'partially_completed') && order.status !== ORDER_STATUS.PARTIAL) {
        const remainsStr = statusResult.rawResponse?.remains
            || statusResult.rawResponse?.data?.remains
            || '0';
        order.remains = parseInt(remainsStr, 10) || 0;
        order.status = ORDER_STATUS.PARTIAL;
        statusChanged = true;
        newStatus = 'PARTIAL';
    }
    // 'Pending' → no status change (stays PROCESSING)

    await order.save();

    // ── Trigger refund if status changed to CANCELED or PARTIAL ──────────
    if (statusChanged && (newStatus === 'CANCELED' || newStatus === 'PARTIAL')) {
        const remains = newStatus === 'PARTIAL' ? (order.remains || 0) : 0;
        try {
            await processOrderRefund(order._id, remains, {
                actorId: ctx.actorId,
                actorRole: ctx.actorRole,
                ipAddress: ctx.ipAddress,
                userAgent: ctx.userAgent,
            });
        } catch (refundErr) {
            // Don't break the sync — log the refund failure
            console.error(`[AdminOrders] Refund failed after sync for order ${orderId}:`, refundErr.message);
        }
    }

    createAuditLog({
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        action: ADMIN_ACTIONS.ORDER_RETRIED,  // reuse — closest existing action
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            action: 'sync_provider_status',
            before,
            after: { providerStatus: order.providerStatus, status: order.status },
            providerOrderId: order.providerOrderId,
            statusChanged,
            newStatus,
        },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
    });

    return order;
};


// ─── Manual Complete ──────────────────────────────────────────────────────────

/**
 * Manually mark an order as COMPLETED.
 * Used by admin when fulfillment was done outside the automated engine.
 *
 * Guards:
 *   - Cannot complete an already COMPLETED order
 *   - Cannot complete a FAILED (refunded) order
 */
const completeOrder = async (orderId, adminId, auditContext = null) => {
    const ctx = resolveAuditContext(adminId, auditContext);
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    // Hard stop — already completed, nothing to do
    if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BusinessRuleError('Order is already completed.', 'ALREADY_COMPLETED');
    }

    const before = order.status;

    // ── Forced-completion path ────────────────────────────────────────────
    // If the order was previously refunded (FAILED / PARTIAL / CANCELED),
    // the user has already received their money back. The admin is explicitly
    // overriding — we must re-deduct the original amount unconditionally,
    // even if it drives the wallet into debt.
    const wasRefunded = order.refunded === true ||
        [ORDER_STATUS.FAILED, ORDER_STATUS.PARTIAL, ORDER_STATUS.CANCELED].includes(order.status);

    if (wasRefunded) {
        // Determine the exact amount to re-deduct:
        //   chargedAmount is the total the user originally paid.
        //   Fall back to walletDeducted for legacy orders.
        const reDeductAmount = Number(order.chargedAmount || order.walletDeducted || 0);

        if (reDeductAmount > 0) {
            await forcedDebitWallet({
                userId: order.userId,
                amount: reDeductAmount,
                reference: order._id,
                description: `Admin forced completion re-deduction for order #${order.orderNumber || order._id} (previously refunded ${reDeductAmount} ${order.currency || 'USD'})`,
            });
        }

        // Clear the refund flags so the order is in a clean completed state
        order.refunded    = false;
        order.refundedAt  = null;
    }

    order.status = ORDER_STATUS.COMPLETED;
    await order.save();

    createAuditLog({
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        action: ADMIN_ACTIONS.ORDER_COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            action: wasRefunded ? 'forced_complete_with_rededuction' : 'manual_complete',
            previousStatus: before,
            newStatus: ORDER_STATUS.COMPLETED,
            reDeducted: wasRefunded,
        },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
    });

    return order;
};

// ─── Unified Status Update ────────────────────────────────────────────────────

/**
 * Unified admin order status update.
 *
 * Dispatches to the correct action based on the target status:
 *   'completed' | 'approved'  → completeOrder
 *   'failed' | 'rejected' | 'refunded' | 'cancelled' | 'canceled' → refundOrder (+ sets rejectionReason)
 *   'processing' | 'retry' | 'pending' → retryOrder
 *
 * This is the SINGLE entry point the frontend should call via
 *   PATCH /admin/orders/:id/status   { status, rejectionReason? }
 *
 * @param {string} orderId
 * @param {string} status - target status string
 * @param {string} adminId
 * @param {Object} [opts]
 * @param {string} [opts.rejectionReason] - required when rejecting
 * @returns {Promise<Order>}
 */
const updateOrderStatus = async (orderId, status, adminId, { rejectionReason, auditContext } = {}) => {
    const normalised = String(status || '').trim().toLowerCase();

    if (['completed', 'approved'].includes(normalised)) {
        return completeOrder(orderId, adminId, auditContext);
    }

    if (['failed', 'rejected', 'denied', 'refunded', 'cancelled', 'canceled'].includes(normalised)) {
        // Persist the admin's rejection reason on the order BEFORE the refund
        // so the customer can see why.
        if (rejectionReason) {
            await Order.findByIdAndUpdate(orderId, {
                rejectionReason: String(rejectionReason).trim(),
            });
        }
        return refundOrder(orderId, adminId, 0, auditContext);
    }

    if (['processing', 'retry', 'pending'].includes(normalised)) {
        return retryOrder(orderId, adminId, auditContext);
    }

    throw new BusinessRuleError(
        `Unknown target status '${status}'. Use: completed, rejected, processing.`,
        'INVALID_TARGET_STATUS'
    );
};

module.exports = { listOrders, getOrderById, retryOrder, refundOrder, syncOrderProviderStatus, completeOrder, updateOrderStatus };
