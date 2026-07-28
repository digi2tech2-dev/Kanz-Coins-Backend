'use strict';

const crypto = require('crypto');
const { TargetApp, TargetOrder, TARGET_ORDER_STATUS } = require('./target.model');
const { User } = require('../users/user.model');
const {
    NotFoundError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    TARGET_ORDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { Setting } = require('../admin/setting.model');
const { notifyNewTargetOrder, notifyTargetApproved, notifyTargetRejected } = require('../notifications/notification.service');
const whatsappService = require('../whatsapp/whatsapp.service');

const DEFAULT_TARGET_PAYMENT_METHODS = [
    { id: 'vodafone cash', name: 'Vodafone Cash', type: 'mobile_wallet' },
    { id: 'etisalat cash', name: 'Etisalat Cash', type: 'mobile_wallet' },
    { id: 'orange cash', name: 'Orange Cash', type: 'mobile_wallet' },
    { id: 'instapay', name: 'InstaPay', type: 'mobile_wallet' },
    { id: 'site_wallet', name: 'Site Wallet', type: 'site_wallet' },
];

const PAYMENT_METHOD_ALIASES = {
    vodafone: ['vodafone cash'],
    'vodafone cash': ['vodafone'],
    etisalat: ['etisalat cash'],
    'etisalat cash': ['etisalat'],
    orange: ['orange cash'],
    'orange cash': ['orange'],
    instapay: ['insta pay'],
    'insta pay': ['instapay'],
    wallet: ['site wallet'],
    'site wallet': ['wallet'],
};

const normalizePaymentToken = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const paymentTokenVariants = (value) => {
    const token = normalizePaymentToken(value);
    if (!token) return [];
    return [token, ...(PAYMENT_METHOD_ALIASES[token] || [])].map(normalizePaymentToken);
};

const normalizeMethods = (methods) => {
    return [...new Set((methods || []).map((method) => String(method).trim()).filter(Boolean))];
};

const normalizeMethodId = (methodId) => String(methodId || '').trim();

const isLegacyPaymentFallbackEnabled = () => String(process.env.TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED || '')
    .trim()
    .toLowerCase() === 'true';

const getConfiguredPaymentMethods = async () => {
    const setting = await Setting.findOne({ key: 'paymentGroups' }).lean();
    const groups = Array.isArray(setting?.value) ? setting.value : [];
    const configuredMethods = groups.flatMap((group) => (
        (Array.isArray(group.methods) ? group.methods : []).map((method) => ({
            id: normalizeMethodId(method.id),
            name: String(method.name || method.id || '').trim(),
            type: String(method.type || '').trim(),
            isActive: group.isActive !== false && method.isActive !== false,
        }))
    )).filter((method) => method.id && method.name);

    if (configuredMethods.length === 0 && isLegacyPaymentFallbackEnabled()) {
        return {
            methods: DEFAULT_TARGET_PAYMENT_METHODS.map((method) => ({ ...method, isActive: true })),
            usingLegacyFallback: true,
        };
    }

    return { methods: configuredMethods, usingLegacyFallback: false };
};

const getActivePaymentMethods = async () => {
    const { methods } = await getConfiguredPaymentMethods();
    return methods.filter((method) => method.isActive !== false);
};

const findMethodByToken = (methods, value) => {
    const submittedTokens = paymentTokenVariants(value);
    if (!submittedTokens.length) return null;

    return methods.find((method) => {
        const methodTokens = [
            method.id,
            method.name,
        ].flatMap(paymentTokenVariants);
        return submittedTokens.some((token) => methodTokens.includes(token));
    }) || null;
};

const normalizeAllowedPaymentMethods = async (methods) => {
    const activeMethods = await getActivePaymentMethods();
    return normalizeMethods(normalizeMethods(methods).map((method) => {
        const resolved = findMethodByToken(activeMethods, method);
        return resolved?.id || normalizeMethodId(method);
    }));
};

const assertPaymentMethodAllowed = async (app, { paymentMethod, paymentMethodId }) => {
    const { methods: configuredMethods, usingLegacyFallback } = await getConfiguredPaymentMethods();
    const submittedId = normalizeMethodId(paymentMethodId);
    const submittedName = String(paymentMethod || '').trim();
    const resolvedConfigured = findMethodByToken(configuredMethods, submittedId) || findMethodByToken(configuredMethods, submittedName);

    if (configuredMethods.length === 0) {
        throw new BusinessRuleError(
            'Target payment methods are not configured.',
            'TARGET_PAYMENT_CONFIGURATION_MISSING'
        );
    }

    if (!resolvedConfigured) {
        throw new BusinessRuleError(
            'Target payment method was not found.',
            'TARGET_PAYMENT_METHOD_NOT_FOUND'
        );
    }

    if (resolvedConfigured.isActive === false) {
        throw new BusinessRuleError(
            'Target payment method is inactive.',
            'TARGET_PAYMENT_METHOD_INACTIVE'
        );
    }

    const allowedTokens = new Set(normalizeMethods(app.allowedPaymentMethods).flatMap(paymentTokenVariants));
    const resolvedTokens = [
        resolvedConfigured.id,
        resolvedConfigured.name,
        submittedId,
        submittedName,
    ].flatMap(paymentTokenVariants);

    if (!resolvedTokens.some((token) => allowedTokens.has(token))) {
        throw new BusinessRuleError(
            `Payment method '${resolvedConfigured.name}' is not allowed for ${app.name}.`,
            'TARGET_PAYMENT_METHOD_NOT_ALLOWED'
        );
    }

    return {
        id: resolvedConfigured.id,
        name: resolvedConfigured.name,
        type: resolvedConfigured.type || null,
        source: usingLegacyFallback ? 'legacy_fallback' : 'payment_settings',
    };
};

const toMoney = (value) => Number(Number(value).toFixed(2));

const normalizeIdempotencyKey = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
        throw new BusinessRuleError(
            'Invalid idempotency key.',
            'IDEMPOTENCY_KEY_INVALID'
        );
    }
    return normalized;
};

const buildTargetIdempotencyFingerprint = ({
    appId,
    coinAmount,
    senderId,
    transferNumber,
    transactionNumber,
    paymentMethodId,
    targetAccountIdSnapshot,
    totalPrice,
    unitPriceSnapshot,
}) => {
    const payload = {
        appId: String(appId || ''),
        coinAmount: Number(coinAmount),
        senderId: String(senderId || '').trim(),
        transferNumber: String(transferNumber || '').trim(),
        transactionNumber: String(transactionNumber || '').trim(),
        paymentMethodId: String(paymentMethodId || '').trim(),
        targetAccountIdSnapshot: String(targetAccountIdSnapshot || '').trim(),
        totalPrice: Number(totalPrice),
        unitPriceSnapshot: Number(unitPriceSnapshot),
    };

    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

const assertIdempotentReplayMatches = (existing, fingerprint) => {
    const existingFingerprint = existing.idempotencyFingerprint || buildTargetIdempotencyFingerprint({
        appId: existing.appId,
        coinAmount: existing.coinAmount,
        senderId: existing.senderId,
        transferNumber: existing.transferNumber,
        transactionNumber: existing.transactionNumber,
        paymentMethodId: existing.paymentMethodIdSnapshot || existing.paymentMethod,
        targetAccountIdSnapshot: existing.targetAccountIdSnapshot,
        totalPrice: existing.totalPrice,
        unitPriceSnapshot: existing.unitPriceSnapshot,
    });
    if (existingFingerprint === fingerprint) return;
    throw new BusinessRuleError(
        'This idempotency key was already used with a different target request payload.',
        'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'
    );
};

const safeNotify = (label, notifyFn, ...args) => {
    if (typeof notifyFn !== 'function') return;
    try {
        Promise.resolve(notifyFn(...args)).catch((err) => {
            console.error(`${label} failed:`, err.message);
        });
    } catch (err) {
        console.error(`${label} failed:`, err.message);
    }
};

// =============================================================================
// TARGET APPS
// =============================================================================

const createTargetApp = async ({
    name,
    unitPrice,
    image = null,
    targetAccountId = '',
    receivingAccountId = '',
    allowedPaymentMethods,
    isActive = true,
}) => {
    const app = await TargetApp.create({
        name,
        unitPrice,
        image,
        targetAccountId: String(targetAccountId || receivingAccountId || '').trim(),
        allowedPaymentMethods: await normalizeAllowedPaymentMethods(allowedPaymentMethods),
        isActive,
    });

    return app;
};

const listTargetApps = async ({ includeInactive = true } = {}) => {
    const filter = includeInactive ? {} : { isActive: true };
    return TargetApp.find(filter).sort({ isActive: -1, name: 1 });
};

const updateTargetApp = async (appId, updates) => {
    const app = await TargetApp.findById(appId);
    if (!app) throw new NotFoundError('TargetApp');

    if (updates.name !== undefined) app.name = updates.name;
    if (updates.unitPrice !== undefined) app.unitPrice = updates.unitPrice;
    if (updates.image !== undefined) app.image = updates.image;
    if (updates.targetAccountId !== undefined || updates.receivingAccountId !== undefined) {
        app.targetAccountId = String(updates.targetAccountId || updates.receivingAccountId || '').trim();
    }
    if (updates.allowedPaymentMethods !== undefined) {
        app.allowedPaymentMethods = await normalizeAllowedPaymentMethods(updates.allowedPaymentMethods);
    }
    if (updates.isActive !== undefined) app.isActive = updates.isActive;

    await app.save();
    return app;
};

const deactivateTargetApp = async (appId) => {
    const app = await TargetApp.findByIdAndUpdate(
        appId,
        { $set: { isActive: false } },
        { new: true }
    );
    if (!app) throw new NotFoundError('TargetApp');
    return app;
};

// =============================================================================
// TARGET ORDERS
// =============================================================================

const createTargetOrder = async ({
    userId,
    appId,
    coinAmount,
    senderId,
    transferNumber,
    transactionNumber,
    paymentMethod,
    paymentMethodId = null,
    screenshotProof,
    idempotencyKey = null,
    auditContext = null,
}) => {
    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);

    const [user, app] = await Promise.all([
        User.findById(userId).select('_id name email'),
        TargetApp.findById(appId),
    ]);

    if (!user) throw new NotFoundError('User');
    if (!app) {
        throw new BusinessRuleError(
            'Target app was not found.',
            'TARGET_APP_NOT_FOUND'
        );
    }
    if (app.isActive === false) {
        throw new BusinessRuleError(
            'Target app is inactive.',
            'TARGET_APP_INACTIVE'
        );
    }

    const resolvedPaymentMethod = await assertPaymentMethodAllowed(app, { paymentMethod, paymentMethodId });
    const unitPrice = app.unitPrice;
    const trustedTargetAccountId = String(app.targetAccountId || '').trim();

    if (typeof unitPrice !== 'number' || unitPrice <= 0) {
        throw new BusinessRuleError(
            'Target app unit price is invalid. Please contact support.',
            'INVALID_UNIT_PRICE'
        );
    }
    if (!trustedTargetAccountId) {
        throw new BusinessRuleError(
            'Target app receiving account is not configured.',
            'TARGET_ACCOUNT_CONFIGURATION_MISSING'
        );
    }

    const totalPrice = toMoney(coinAmount * unitPrice);
    const idempotencyFingerprint = normalizedIdempotencyKey
        ? buildTargetIdempotencyFingerprint({
            appId: app._id,
            coinAmount,
            senderId,
            transferNumber,
            transactionNumber,
            paymentMethodId: resolvedPaymentMethod.id,
            targetAccountIdSnapshot: trustedTargetAccountId,
            totalPrice,
            unitPriceSnapshot: unitPrice,
        })
        : null;

    if (normalizedIdempotencyKey) {
        const existing = await TargetOrder.findOne({ userId, idempotencyKey: normalizedIdempotencyKey });
        if (existing) {
            assertIdempotentReplayMatches(existing, idempotencyFingerprint);
            existing.$locals.idempotentReplay = true;
            return existing;
        }
    }

    const orderData = {
        userId,
        appId: app._id,
        appNameSnapshot: app.name,
        targetAccountIdSnapshot: trustedTargetAccountId,
        coinAmount,
        senderId,
        transferNumber,
        transactionNumber,
        paymentMethod: resolvedPaymentMethod.id,
        paymentMethodIdSnapshot: resolvedPaymentMethod.id,
        paymentMethodNameSnapshot: resolvedPaymentMethod.name,
        paymentMethodTypeSnapshot: resolvedPaymentMethod.type,
        screenshotProof,
        totalPrice,
        unitPriceSnapshot: unitPrice,
        status: TARGET_ORDER_STATUS.PENDING,
    };
    if (normalizedIdempotencyKey) {
        orderData.idempotencyKey = normalizedIdempotencyKey;
        orderData.idempotencyFingerprint = idempotencyFingerprint;
    }

    let order;
    try {
        order = await TargetOrder.create(orderData);
    } catch (err) {
        if (err?.code === 11000 && normalizedIdempotencyKey) {
            const existing = await TargetOrder.findOne({ userId, idempotencyKey: normalizedIdempotencyKey });
            if (existing) {
                assertIdempotentReplayMatches(existing, idempotencyFingerprint);
                existing.$locals.idempotentReplay = true;
                return existing;
            }
        }
        throw err;
    }

    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: TARGET_ORDER_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.TARGET_ORDER,
        entityId: order._id,
        metadata: {
            userId: userId.toString(),
            appId: app._id.toString(),
            appNameSnapshot: app.name,
            coinAmount,
            senderId,
            transferNumber,
            transactionNumber,
            paymentMethod: resolvedPaymentMethod.id,
            paymentMethodNameSnapshot: resolvedPaymentMethod.name,
            totalPrice,
            unitPrice,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    safeNotify('Target order notification', notifyNewTargetOrder, order);

    try {
        whatsappService.sendAdminNotification(
            `🎯 *طلب تارجت جديد!*\nالمستخدم: ${user.name || user.email || userId}\nالتطبيق: ${app.name}\nالكمية: ${coinAmount}`
        ).catch((err) => {
            console.error('WhatsApp Notification failed:', err.message);
        });
    } catch (err) {
        console.error('WhatsApp Notification failed:', err.message);
    }

    return order;
};

const approveTargetOrder = async (orderId, adminId, auditContext = null) => {
    const existing = await TargetOrder.findById(orderId);
    if (!existing) throw new NotFoundError('TargetOrder');

    if (existing.status === TARGET_ORDER_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'This target order has already been approved.',
            'TARGET_ORDER_ALREADY_APPROVED'
        );
    }
    if (existing.status === TARGET_ORDER_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected target order cannot be approved. The customer must submit a new one.',
            'TARGET_ORDER_ALREADY_REJECTED'
        );
    }

    const updated = await TargetOrder.findOneAndUpdate(
        { _id: orderId, status: TARGET_ORDER_STATUS.PENDING },
        {
            $set: {
                status: TARGET_ORDER_STATUS.APPROVED,
                reviewedBy: adminId,
                reviewedAt: new Date(),
            },
        },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This target order has already been reviewed.',
            'TARGET_ORDER_ALREADY_REVIEWED'
        );
    }

    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: TARGET_ORDER_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.TARGET_ORDER,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            appId: updated.appId?.toString?.() ?? null,
            appNameSnapshot: updated.appNameSnapshot ?? null,
            coinAmount: updated.coinAmount,
            totalPrice: updated.totalPrice,
            unitPriceSnapshot: updated.unitPriceSnapshot,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    const populated = await TargetOrder.findById(updated._id)
        .populate('userId', 'name email currency walletBalance')
        .populate('appId', 'name image targetAccountId unitPrice allowedPaymentMethods isActive')
        .populate('reviewedBy', 'name email');

    safeNotify('Target approval notification', notifyTargetApproved, populated);

    return populated;
};

const rejectTargetOrder = async (orderId, adminId, adminNotes = null, auditContext = null) => {
    const existing = await TargetOrder.findById(orderId);
    if (!existing) throw new NotFoundError('TargetOrder');

    if (existing.status === TARGET_ORDER_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This target order has already been rejected.',
            'TARGET_ORDER_ALREADY_REJECTED'
        );
    }
    if (existing.status === TARGET_ORDER_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved target order cannot be rejected.',
            'TARGET_ORDER_ALREADY_APPROVED'
        );
    }

    const updated = await TargetOrder.findOneAndUpdate(
        { _id: orderId, status: TARGET_ORDER_STATUS.PENDING },
        {
            $set: {
                status: TARGET_ORDER_STATUS.REJECTED,
                reviewedBy: adminId,
                reviewedAt: new Date(),
                adminNotes: adminNotes || null,
            },
        },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This target order has already been reviewed.',
            'TARGET_ORDER_ALREADY_REVIEWED'
        );
    }

    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: TARGET_ORDER_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.TARGET_ORDER,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            appId: updated.appId?.toString?.() ?? null,
            appNameSnapshot: updated.appNameSnapshot ?? null,
            coinAmount: updated.coinAmount,
            totalPrice: updated.totalPrice,
            adminNotes: adminNotes || null,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    const populated = await TargetOrder.findById(updated._id)
        .populate('userId', 'name email currency walletBalance')
        .populate('appId', 'name image targetAccountId unitPrice allowedPaymentMethods isActive')
        .populate('reviewedBy', 'name email');

    safeNotify('Target rejection notification', notifyTargetRejected, populated, adminNotes);

    return populated;
};

const listTargetOrders = async ({ page = 1, limit = 20, status, search } = {}) => {
    const filter = {};
    if (status) filter.status = String(status).toUpperCase();

    if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matchingUsers = await User.find({
            $or: [{ name: regex }, { email: regex }],
        }).select('_id').lean();
        filter.$or = [
            { transferNumber: regex },
            { transactionNumber: regex },
            { senderId: regex },
            { appNameSnapshot: regex },
            ...(matchingUsers.length > 0 ? [{ userId: { $in: matchingUsers.map((u) => u._id) } }] : []),
        ];
    }

    const skip = (page - 1) * limit;

    const [orders, total, summaryStats] = await Promise.all([
        TargetOrder.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance currency')
            .populate('appId', 'name image targetAccountId unitPrice allowedPaymentMethods isActive')
            .populate('reviewedBy', 'name email'),
        TargetOrder.countDocuments(filter),
        TargetOrder.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', TARGET_ORDER_STATUS.PENDING] }, 1, 0] } },
                    approved: { $sum: { $cond: [{ $eq: ['$status', TARGET_ORDER_STATUS.APPROVED] }, 1, 0] } },
                    rejected: { $sum: { $cond: [{ $eq: ['$status', TARGET_ORDER_STATUS.REJECTED] }, 1, 0] } },
                },
            },
        ]).then((r) => r[0] || { total: 0, pending: 0, approved: 0, rejected: 0 }),
    ]);

    return {
        orders,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: {
            totalOrders: summaryStats.total,
            pendingCount: summaryStats.pending,
            approvedCount: summaryStats.approved,
            rejectedCount: summaryStats.rejected,
        },
    };
};

const listMyTargetOrders = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = String(status).toUpperCase();

    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
        TargetOrder.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('appId', 'name image targetAccountId unitPrice allowedPaymentMethods isActive'),
        TargetOrder.countDocuments(filter),
    ]);

    return {
        orders,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

module.exports = {
    createTargetApp,
    listTargetApps,
    updateTargetApp,
    deactivateTargetApp,
    createTargetOrder,
    approveTargetOrder,
    rejectTargetOrder,
    listTargetOrders,
    listMyTargetOrders,
};
