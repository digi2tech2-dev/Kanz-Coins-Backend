'use strict';

const mongoose = require('mongoose');
const { DepositRequest, DEPOSIT_STATUS } = require('./deposit.model');
const { User } = require('../users/user.model');
const { creditWalletDirect } = require('../wallet/wallet.service');
const { processDepositReferralCommission } = require('../referrals/referralCommission.service');
// convertUsdToUserCurrency removed — deposits now credit requestedAmount directly
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { notifyNewDeposit, notifyDepositApproved, notifyDepositRejected } = require('../notifications/notification.service');
const whatsappService = require('../whatsapp/whatsapp.service');

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000001');

const runTestHook = async (hook, payload) => {
    if (!hook) return;
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('Deposit approval test hooks are only available in NODE_ENV=test.');
    }
    await hook(payload);
};

const safeParseJson = (value) => {
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
};

const normalizeSenderDetails = (source = {}) => {
    const rawDetails = source.senderDetails && typeof source.senderDetails === 'object'
        ? source.senderDetails
        : safeParseJson(source.senderDetails);
    const details = rawDetails && typeof rawDetails === 'object' ? rawDetails : {};
    const value = String(
        details.value
        || source.senderDetailValue
        || source.senderWalletAddress
        || source.senderWalletNumber
        || source.transferredFromNumber
        || ''
    ).trim();

    if (!value) return null;

    const methodType = String(
        details.methodType
        || details.type
        || source.paymentMethodType
        || ''
    ).trim().toLowerCase();
    const field = String(
        details.field
        || source.senderDetailField
        || (source.senderWalletAddress ? 'senderWalletAddress' : 'senderWalletNumber')
    ).trim();
    const label = String(
        details.label
        || (field === 'senderWalletAddress' || methodType === 'usdt'
            ? 'عنوان المحفظة المحول منها'
            : 'رقم المحفظة المحول منها')
    ).trim();
    const transactionNumber = String(
        details.transactionNumber
        || details.transactionId
        || details.paymentReference
        || source.transactionNumber
        || source.transactionId
        || source.paymentReference
        || source.transferTransactionId
        || ''
    ).trim();

    return {
        methodType: methodType.slice(0, 64),
        field: field.slice(0, 64),
        label: label.slice(0, 128),
        value: value.slice(0, 200),
        transactionNumber: transactionNumber ? transactionNumber.slice(0, 64) : null,
    };
};

const normalizePaymentTransactionId = (value) => {
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed.slice(0, 64) : null;
};

// =============================================================================
// CREATE
// =============================================================================

/**
 * Customer creates a new deposit request (multi-currency).
 *
 * Business rules:
 *   - User must exist and be ACTIVE (enforced upstream by requireActiveUser middleware).
 *   - requestedAmount must be > 0 (enforced by schema).
 *   - amountUsd is pre-calculated by the controller using the frozen exchangeRate.
 *   - No wallet credit at this stage; the request is PENDING until admin review.
 *   - Multiple concurrent PENDING deposits are allowed.
 *
 * Audit: DEPOSIT_REQUESTED — fire-and-forget after save.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {string}          params.paymentMethodId
 * @param {number}          params.requestedAmount
 * @param {string}          params.currency
 * @param {number}          params.exchangeRate
 * @param {number}          params.amountUsd
 * @param {string}          params.receiptImage
 * @param {string|null}     [params.notes]
 * @param {Object|null}     [params.senderDetails]
 * @param {Object|null}     [params.auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const createDepositRequest = async ({
    userId,
    paymentMethodId,
    requestedAmount,
    currency,
    exchangeRate,
    amountUsd,
    receiptImage,
    notes = null,
    senderDetails = null,
    paymentTransactionId = null,
    auditContext = null,
}) => {
    // Confirm user exists (belt-and-suspenders — middleware already checks ACTIVE)
    const user = await User.findById(userId).select('_id role name email');
    if (!user) throw new NotFoundError('User');

    const normalizedPaymentTransactionId = normalizePaymentTransactionId(
        paymentTransactionId
        || senderDetails?.transactionNumber
    );

    const deposit = await DepositRequest.create({
        userId,
        paymentMethodId,
        requestedAmount: Number(parseFloat(requestedAmount).toFixed(2)),
        currency,
        exchangeRate,
        amountUsd: Number(parseFloat(amountUsd).toFixed(2)),
        receiptImage,
        notes,
        senderDetails,
        paymentTransactionId: normalizedPaymentTransactionId,
        status: DEPOSIT_STATUS.PENDING,
    });

    // Audit: fire-and-forget
    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: DEPOSIT_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: userId.toString(),
            paymentMethodId,
            requestedAmount: deposit.requestedAmount,
            currency,
            exchangeRate,
            amountUsd: deposit.amountUsd,
            senderDetails,
            paymentTransactionId: normalizedPaymentTransactionId,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    notifyNewDeposit(deposit);

    try {
        whatsappService.sendAdminNotification(
            `💰 *طلب شحن رصيد!*\nالمستخدم: ${user.name || user.email || userId}\nالمبلغ: ${deposit.requestedAmount} ${deposit.currency}\nوسيلة الدفع: ${paymentMethodId}`
        ).catch((err) => {
            console.error('WhatsApp Notification failed:', err.message);
        });
    } catch (err) {
        console.error('WhatsApp Notification failed:', err.message);
    }

    try {
        const paymentEventService = require('../paymentEvents/paymentEvent.service');
        paymentEventService.matchExistingUnmatchedPaymentForDeposit(deposit._id).catch((err) => {
            console.error('[PaymentEvent] Post-deposit matching failed:', err.message);
        });
    } catch (err) {
        console.error('[PaymentEvent] Post-deposit matching unavailable:', err.message);
    }

    return deposit;
};

// =============================================================================
// APPROVE
// =============================================================================

/**
 * Admin approves a deposit request and credits the user's wallet with amountUsd.
 *
 * All mutations use an atomic compare-and-swap on { _id, status: PENDING }:
 *   1. Load and validate the deposit.
 *   2. Atomic findOneAndUpdate — prevents double-approval even under
 *      concurrent requests (no-op if status changed).
 *   3. Atomically credit the user's wallet with the pre-calculated amountUsd.
 *
 * Concurrency safety:
 *   findOneAndUpdate with { _id, status: PENDING } acts as a compare-and-swap.
 *   The first concurrent approve wins; the second finds no matching document
 *   (status is no longer PENDING) and throws DEPOSIT_ALREADY_APPROVED.
 *
 * Audit: DEPOSIT_APPROVED + WALLET_CREDIT — both fire-and-forget AFTER commit.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const approveDeposit = async (depositId, adminId, adminOverrides = {}, auditContext = null, testHooks = {}) => {
    const session = await mongoose.startSession();
    let existing;
    let updated;
    let finalAmount;
    let finalCurrency;
    let walletCurrency;
    let walletCreditAmount;
    let conversionNote;
    let commissionOutcome = null;
    const reviewerId = adminId || null;

    try {
        await session.withTransaction(async () => {
    // Pre-read to give clear error messages if status is already wrong
    existing = await DepositRequest.findById(depositId).session(session);
    if (!existing) throw new NotFoundError('DepositRequest');

    if (existing.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }
    if (existing.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected deposit cannot be approved. Create a new request.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }

    // ── Resolve final amount & currency (admin overrides take priority) ────
    finalAmount = Number(parseFloat(
        adminOverrides.amount ?? existing.requestedAmount
    ).toFixed(2));
    finalCurrency = (
        adminOverrides.currency || existing.currency || 'USD'
    ).toUpperCase();

    if (finalAmount <= 0) {
        throw new BusinessRuleError('Deposit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    // ── Atomic compare-and-swap on { _id, status: PENDING } ──────────────
    const $setFields = {
        status: DEPOSIT_STATUS.APPROVED,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewSource: adminOverrides.reviewSource || 'ADMIN',
    };

    // Persist admin overrides on the deposit document if provided
    if (adminOverrides.amount != null) {
        $setFields.requestedAmount = finalAmount;
    }
    if (adminOverrides.currency) {
        $setFields.currency = finalCurrency;
    }
    if (adminOverrides.adminNotes) {
        $setFields.adminNotes = String(adminOverrides.adminNotes).trim();
    }
    if (adminOverrides.paymentEventId) {
        $setFields.paymentEventId = adminOverrides.paymentEventId;
    }
    if (adminOverrides.autoVerifiedAt) {
        $setFields.autoVerifiedAt = adminOverrides.autoVerifiedAt;
    }

    updated = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        { $set: $setFields },
        { new: true, session }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    // ── Determine the wallet credit amount (smart cross-currency) ─────────
    // walletBalance is stored in the user's local currency.
    //
    // Case 1 (same currency): Deposit SAR, wallet SAR → credit exact amount.
    // Case 2 (cross-currency): Deposit EGP, wallet SAR → EGP → USD → SAR.
    const userDoc = await User.findById(updated.userId).select('currency').session(session);
    walletCurrency = (userDoc?.currency ?? 'USD').toUpperCase();

    if (finalCurrency === walletCurrency) {
        // Same currency — direct credit, no conversion loss
        walletCreditAmount = finalAmount;
        conversionNote = `${finalAmount} ${finalCurrency} (direct, no conversion)`;
    } else {
        // Cross-currency: finalCurrency → USD → walletCurrency
        const { getConversionRate } = require('../../services/currencyConverter.service');
        const fromRate = await getConversionRate(finalCurrency);   // e.g. EGP → 1 USD = 50 EGP  → rate=50
        const toRate   = await getConversionRate(walletCurrency);  // e.g. SAR → 1 USD = 3.75 SAR → rate=3.75

        const amountInUsd = Number((finalAmount / fromRate).toFixed(6));
        walletCreditAmount = Number((amountInUsd * toRate).toFixed(2));
        conversionNote = `${finalAmount} ${finalCurrency} → ${amountInUsd} USD → ${walletCreditAmount} ${walletCurrency}`;
    }

    await runTestHook(testHooks.beforeWalletUpdate, { deposit: updated });

    // Credit the wallet
    await creditWalletDirect({
        userId: updated.userId,
        amount: walletCreditAmount,
        reference: updated._id,
        description: `Deposit #${updated._id.toString().slice(-6)} (${finalAmount} ${finalCurrency})`,
        session,
        testHooks: testHooks.wallet,
    });

    await runTestHook(testHooks.afterWalletCreditBeforeCommission, { deposit: updated });

    commissionOutcome = await processDepositReferralCommission({
        deposit: updated,
        sourceAmount: finalAmount,
        sourceCurrency: finalCurrency,
        sourceCompletedAt: updated.reviewedAt,
        session,
        testHooks: testHooks.commission,
    });
        });
    } finally {
        await session.endSession();
    }

    // ── Audit: fire-and-forget ────────────────────────────────────────────
    const actorId = auditContext?.actorId ?? adminId ?? SYSTEM_ACTOR_ID;
    const actorRole = auditContext?.actorRole ?? (adminId ? ACTOR_ROLES.ADMIN : ACTOR_ROLES.SYSTEM);
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: DEPOSIT_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            finalAmount,
            finalCurrency,
            originalRequestedAmount: existing.requestedAmount,
            originalCurrency: existing.currency,
            adminOverrideApplied: !!(adminOverrides.amount || adminOverrides.currency),
            walletCurrency,
            walletCreditAmount,
            conversionNote,
            referralCommissionOutcome: commissionOutcome?.outcome ?? null,
            referralCommissionId: commissionOutcome?.commission?._id?.toString() ?? null,
            reviewedBy: adminId?.toString?.() ?? null,
            reviewSource: updated.reviewSource,
            paymentEventId: updated.paymentEventId?.toString?.() ?? null,
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: WALLET_ACTIONS.CREDIT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: updated.userId,
        metadata: {
            depositId: updated._id.toString(),
            walletCurrency,
            walletCreditAmount,
            reason: 'DEPOSIT_APPROVED',
        },
    });

    // ── Populate refs before returning to the frontend ────────────────────
    // Without this, the Zustand store overwrites the populated userId object
    // with a raw string ID, breaking the admin table's user column.
    const populated = await DepositRequest.findById(updated._id)
        .populate('userId', 'name email avatar currency walletBalance')
        .populate('reviewedBy', 'name email');

    const notificationFn = testHooks.notifyDepositApproved || notifyDepositApproved;
    try {
        Promise.resolve(notificationFn(populated)).catch((err) => {
            console.error('Deposit approval notification failed:', err.message);
        });
    } catch (err) {
        console.error('Deposit approval notification failed:', err.message);
    }

    return populated;
};

// =============================================================================
// REJECT
// =============================================================================

/**
 * Admin rejects a deposit request.
 *
 * Only PENDING requests can be rejected.
 * No financial operation is performed — wallet is untouched.
 *
 * Audit: DEPOSIT_REJECTED — fire-and-forget after save.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {string|null}     [adminNotes]      - optional reason for rejection
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const rejectDeposit = async (depositId, adminId, adminNotes = null, auditContext = null) => {
    const existing = await DepositRequest.findById(depositId);
    if (!existing) throw new NotFoundError('DepositRequest');

    if (existing.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This deposit request has already been rejected.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }
    if (existing.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved deposit cannot be rejected. It has already been credited.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    const setFields = {
        status: DEPOSIT_STATUS.REJECTED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
    };
    if (adminNotes) setFields.adminNotes = adminNotes;

    const deposit = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        { $set: setFields },
        { new: true }
    );

    if (!deposit) {
        const current = await DepositRequest.findById(depositId);
        if (!current) throw new NotFoundError('DepositRequest');
        if (current.status === DEPOSIT_STATUS.APPROVED) {
            throw new BusinessRuleError(
                'An approved deposit cannot be rejected. It has already been credited.',
                'DEPOSIT_ALREADY_APPROVED'
            );
        }
        throw new BusinessRuleError(
            'This deposit request has already been rejected.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }

    // Audit: fire-and-forget after save
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: deposit.userId.toString(),
            requestedAmount: existing.requestedAmount,
            currency: existing.currency,
            amountUsd: existing.amountUsd,
            adminNotes: adminNotes || null,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    // Notification: fire-and-forget
    notifyDepositRejected(deposit, adminNotes);

    return deposit;
};

// =============================================================================
// QUERIES
// =============================================================================

/**
 * Admin: list deposit requests with optional status filter, paginated.
 * Sorted newest-first so the most recent requests appear on Page 1.
 */
const listDeposits = async ({ page = 1, limit = 20, status, search } = {}) => {
    const filter = {};
    // Enforce uppercase to match DEPOSIT_STATUS enum (PENDING, APPROVED, REJECTED)
    if (status) filter.status = String(status).toUpperCase();

    // Search by user name or email
    if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matchingUsers = await User.find({
            $or: [{ name: regex }, { email: regex }],
        }).select('_id').lean();
        filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const skip = (page - 1) * limit;

    const [deposits, total, summaryStats] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance currency')
            .populate('reviewedBy', 'name email'),
        DepositRequest.countDocuments(filter),
        // Base stats — always unfiltered so dashboard cards remain stable
        DepositRequest.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.PENDING] }, 1, 0] } },
                    approved: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.APPROVED] }, 1, 0] } },
                },
            },
        ]).then((r) => r[0] || { total: 0, pending: 0, approved: 0 }),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: {
            totalDeposits: summaryStats.total,
            pendingCount: summaryStats.pending,
            approvedCount: summaryStats.approved,
        },
    };
};

/**
 * Customer: list their own deposit requests, paginated.
 * Sorted newest-first.
 */
const listMyDeposits = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const [deposits, total] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        DepositRequest.countDocuments(filter),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Get a single deposit request by ID.
 * Customers may only see their own; admins may see any.
 *
 * @param {string|ObjectId}      depositId
 * @param {string|ObjectId|null} [requestingUserId] - if set, enforces ownership
 */
const getDepositById = async (depositId, requestingUserId = null) => {
    const deposit = await DepositRequest.findById(depositId)
        .populate('userId', 'name email')
        .populate('reviewedBy', 'name email');

    if (!deposit) throw new NotFoundError('DepositRequest');

    if (requestingUserId && deposit.userId._id.toString() !== requestingUserId.toString()) {
        throw new AuthorizationError('You do not have permission to view this deposit request.');
    }

    return deposit;
};

// =============================================================================
// UPDATE PENDING DEPOSIT
// =============================================================================

/**
 * Update a PENDING deposit request (admin editing fields).
 *
 * Guard: strictly rejects updates if the deposit is NOT in PENDING status.
 *
 * @param {string}          depositId
 * @param {Object}          data
 * @param {number}          [data.requestedAmount]
 * @param {string|ObjectId} adminId
 *
 * @returns {Promise<DepositRequest>}
 */
const updatePendingDeposit = async (depositId, data, adminId) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('Deposit request');

    if (deposit.status !== DEPOSIT_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot update a ${deposit.status.toLowerCase()} deposit. Only PENDING deposits can be edited.`,
            'DEPOSIT_NOT_PENDING'
        );
    }

    const before = {
        requestedAmount: deposit.requestedAmount,
    };

    if (data.requestedAmount !== undefined) {
        deposit.requestedAmount = Number(parseFloat(data.requestedAmount).toFixed(2));
        // Recalculate amountUsd with stored exchangeRate
        deposit.amountUsd = Number((deposit.requestedAmount / deposit.exchangeRate).toFixed(2));
    }

    await deposit.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            before,
            after: {
                requestedAmount: deposit.requestedAmount,
                amountUsd: deposit.amountUsd,
            },
        },
    });

    return deposit;
};

module.exports = {
    createDepositRequest,
    approveDeposit,
    rejectDeposit,
    listDeposits,
    listMyDeposits,
    getDepositById,
    updatePendingDeposit,
    normalizeSenderDetails,
};
