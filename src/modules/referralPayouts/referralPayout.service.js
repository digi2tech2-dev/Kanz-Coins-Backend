'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const { ReferralPayout, REFERRAL_PAYOUT_METHODS, REFERRAL_PAYOUT_STATUS } = require('./referralPayout.model');
const { ReferralCommission, REFERRAL_COMMISSION_STATUS } = require('../referrals/referralCommission.model');
const { User, USER_STATUS } = require('../users/user.model');
const { creditWalletDirect } = require('../wallet/wallet.service');
const {
    WalletTransaction,
    WALLET_TRANSACTION_SOURCE_TYPES,
} = require('../wallet/walletTransaction.model');
const { createAuditLog } = require('../audit/audit.service');
const { ACTOR_ROLES, ENTITY_TYPES, REFERRAL_PAYOUT_ACTIONS } = require('../audit/audit.constants');
const { BusinessRuleError, NotFoundError, AuthorizationError } = require('../../shared/errors/AppError');

const RECEIPT_UPLOAD_CATEGORY = 'referral-payout-receipts';
const MAX_RECEIPT_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_RECEIPT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_RECEIPT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const EXTERNAL_METHOD_TYPES = new Set(['VODAFONE_CASH', 'INSTAPAY', 'BANK_TRANSFER', 'USDT', 'OTHER']);
const EXTERNAL_DETAIL_FIELDS = new Set([
    'methodType',
    'accountName',
    'phoneNumber',
    'accountNumber',
    'iban',
    'walletAddress',
    'network',
    'notes',
]);
const PROHIBITED_DETAIL_FIELDS = new Set([
    '__proto__',
    'prototype',
    'constructor',
    'cvv',
    'cvc',
    'pin',
    'password',
    'otp',
    'secret',
    'token',
]);

const TEST_HOOK_ERROR = 'Referral payout test hooks are only available in NODE_ENV=test.';

const toDecimal = (value) => {
    try {
        const decimal = new Decimal(value ?? 0);
        return decimal.isFinite() ? decimal : new Decimal(0);
    } catch (_) {
        return new Decimal(0);
    }
};

const toMoneyString = (value, places = 6) =>
    toDecimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);

const normalizeCurrencyCode = (value) => String(value || '').trim().toUpperCase();

const runTestHook = async (hook, payload) => {
    if (!hook) return;
    if (process.env.NODE_ENV !== 'test') {
        throw new Error(TEST_HOOK_ERROR);
    }
    await hook(payload);
};

const isDuplicateKeyError = (err) => err?.code === 11000;

const normalizeMethod = (method) => {
    const raw = String(method || '').trim().toLowerCase();
    if (['wallet', 'wallet_credit', 'wallet-credit', 'app_wallet'].includes(raw)) {
        return REFERRAL_PAYOUT_METHODS.WALLET_CREDIT;
    }
    if (['manual_external', 'manual-external', 'external', 'vodafone', 'vodafone_cash', 'instapay', 'bank', 'bank_transfer', 'usdt', 'other'].includes(raw)) {
        return REFERRAL_PAYOUT_METHODS.MANUAL_EXTERNAL;
    }
    throw new BusinessRuleError('Invalid referral payout method.', 'PAYOUT_METHOD_INVALID');
};

const normalizeIdempotencyKey = (value) => {
    const key = String(value || '').trim();
    if (!key) return null;
    if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
        throw new BusinessRuleError('Invalid payout idempotency key.', 'PAYOUT_IDEMPOTENCY_KEY_INVALID');
    }
    return key;
};

const uniqueObjectIdStrings = (values = []) => {
    const ids = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const id = String(value || '').trim();
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new BusinessRuleError('Invalid referral commission ID.', 'PAYOUT_COMMISSION_ID_INVALID');
        }
        const canonical = new mongoose.Types.ObjectId(id).toString();
        if (!seen.has(canonical)) {
            seen.add(canonical);
            ids.push(canonical);
        }
    }
    return ids;
};

const buildFingerprint = ({ method, currency, commissionIds, requestedAmount = null, externalDetails }) => {
    const payload = {
        method,
        currency,
        commissionIds: [...commissionIds].sort(),
        requestedAmount: requestedAmount === null || requestedAmount === undefined
            ? null
            : toMoneyString(requestedAmount, 6),
        externalDetails: externalDetails || {},
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

const assertIdempotentReplayMatches = (existing, fingerprint) => {
    if (existing.idempotencyFingerprint !== fingerprint) {
        throw new BusinessRuleError(
            'This payout idempotency key was already used with a different payload.',
            'PAYOUT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'
        );
    }
};

const normalizeExternalMethodType = (value, fallbackMethod = '') => {
    const raw = String(value || fallbackMethod || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (raw === 'VODAFONE') return 'VODAFONE_CASH';
    if (raw === 'BANK') return 'BANK_TRANSFER';
    if (!raw) return 'OTHER';
    return EXTERNAL_METHOD_TYPES.has(raw) ? raw : 'OTHER';
};

const assertPlainShallowObject = (value, code) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BusinessRuleError('External payout details are required.', code);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new BusinessRuleError('External payout details are invalid.', 'PAYOUT_EXTERNAL_DETAILS_INVALID');
    }
};

const normalizeExternalDetails = (input, fallbackMethod = '') => {
    let value = input;
    if (typeof value === 'string') {
        try {
            value = value.trim() ? JSON.parse(value) : {};
        } catch (_) {
            throw new BusinessRuleError('External payout details are invalid JSON.', 'PAYOUT_EXTERNAL_DETAILS_INVALID');
        }
    }
    assertPlainShallowObject(value, 'PAYOUT_EXTERNAL_DETAILS_REQUIRED');

    const normalized = {
        methodType: normalizeExternalMethodType(value.methodType || fallbackMethod, fallbackMethod),
    };

    for (const [key, rawValue] of Object.entries(value)) {
        if (PROHIBITED_DETAIL_FIELDS.has(key) || PROHIBITED_DETAIL_FIELDS.has(String(key).toLowerCase())) {
            throw new BusinessRuleError('External payout details contain a forbidden field.', 'PAYOUT_EXTERNAL_DETAILS_FORBIDDEN');
        }
        if (!EXTERNAL_DETAIL_FIELDS.has(key)) continue;
        if (rawValue && typeof rawValue === 'object') {
            throw new BusinessRuleError('Nested external payout details are not allowed.', 'PAYOUT_EXTERNAL_DETAILS_INVALID');
        }
        const text = String(rawValue ?? '').trim();
        if (text.length > 200) {
            throw new BusinessRuleError('External payout detail is too long.', 'PAYOUT_EXTERNAL_DETAILS_TOO_LONG');
        }
        if (text) normalized[key] = text;
    }

    const hasDestination = Boolean(
        normalized.phoneNumber
        || normalized.accountNumber
        || normalized.iban
        || normalized.walletAddress
    );
    if (!hasDestination) {
        const alias = String(value.phone || value.walletNumber || value.account || '').trim();
        if (alias) normalized.phoneNumber = alias.slice(0, 200);
    }
    if (!normalized.accountName && value.accountHolder) {
        normalized.accountName = String(value.accountHolder).trim().slice(0, 200);
    }
    if (!normalized.phoneNumber && value.phone) {
        normalized.phoneNumber = String(value.phone).trim().slice(0, 200);
    }
    if (!normalized.accountNumber && value.accountNumber) {
        normalized.accountNumber = String(value.accountNumber).trim().slice(0, 200);
    }

    if (!normalized.accountName || !(normalized.phoneNumber || normalized.accountNumber || normalized.iban || normalized.walletAddress)) {
        throw new BusinessRuleError('External payout account name and destination are required.', 'PAYOUT_EXTERNAL_DETAILS_REQUIRED');
    }

    return normalized;
};

const maskValue = (value, visible = 4) => {
    const text = String(value || '').trim();
    if (!text) return null;
    if (text.length <= visible * 2) return `${text.slice(0, 2)}***${text.slice(-2)}`;
    return `${text.slice(0, visible)}***${text.slice(-visible)}`;
};

const summarizeExternalDetails = (details = {}) => ({
    methodType: details.methodType || 'OTHER',
    accountName: details.accountName || null,
    phoneNumber: maskValue(details.phoneNumber),
    accountNumber: maskValue(details.accountNumber),
    iban: maskValue(details.iban),
    walletAddress: maskValue(details.walletAddress, 6),
    network: details.network || null,
});

const normalizePayoutCreationInput = (body = {}) => {
    const method = normalizeMethod(body.method || body.withdrawalMethod || body.withdrawalMethodId || body.methodId);
    const currency = normalizeCurrencyCode(body.currency);
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
        throw new BusinessRuleError('Payout currency is invalid.', 'PAYOUT_CURRENCY_INVALID');
    }

    const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
    const providedIds = uniqueObjectIdStrings(body.commissionIds || []);
    const requestedAmount = body.amount ?? body.requestedAmount ?? null;
    let externalDetails = {};
    if (method === REFERRAL_PAYOUT_METHODS.MANUAL_EXTERNAL) {
        externalDetails = normalizeExternalDetails(
            body.externalDetails || body.paymentDetails || body.details || {
                methodType: body.method || body.withdrawalMethod || body.methodId,
                accountName: body.accountName || body.accountHolder || body.name,
                phoneNumber: body.phone || body.walletNumber,
                accountNumber: body.accountNumber,
                iban: body.iban,
                walletAddress: body.walletAddress || body.address,
                network: body.network,
                notes: body.notes,
            },
            body.method || body.withdrawalMethod || body.methodId
        );
    } else if (body.externalDetails || body.paymentDetails || body.details) {
        throw new BusinessRuleError('Wallet payouts do not accept external payment details.', 'PAYOUT_EXTERNAL_DETAILS_NOT_ALLOWED');
    }

    return {
        method,
        currency,
        commissionIds: providedIds,
        requestedAmount,
        externalDetails,
        idempotencyKey,
    };
};

const resolveAmountOnlyCommissionIds = async ({ userId, currency, requestedAmount, session }) => {
    const target = toDecimal(requestedAmount);
    if (!target.isFinite() || target.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError('Payout amount must be greater than zero.', 'PAYOUT_AMOUNT_INVALID');
    }
    const available = await ReferralCommission.find({
        referrerUserId: userId,
        status: REFERRAL_COMMISSION_STATUS.AVAILABLE,
        payoutRequestId: null,
        referrerCurrency: currency,
    }).sort({ sourceCompletedAt: 1, _id: 1 }).session(session);

    let total = new Decimal(0);
    const ids = [];
    for (const commission of available) {
        if (total.equals(target)) break;
        const amount = toDecimal(commission.commissionAmountReferrerCurrency);
        if (total.plus(amount).greaterThan(target)) break;
        total = total.plus(amount);
        ids.push(commission._id.toString());
    }
    if (!total.equals(target) || ids.length === 0) {
        throw new BusinessRuleError(
            'Requested amount cannot be represented by whole available commissions. Select specific commissions.',
            'PAYOUT_AMOUNT_REQUIRES_COMMISSION_SELECTION'
        );
    }
    return ids;
};

const loadAndValidateCommissions = async ({ userId, commissionIds, currency, session }) => {
    if (!commissionIds.length) {
        throw new BusinessRuleError('At least one referral commission is required.', 'PAYOUT_COMMISSIONS_REQUIRED');
    }
    const objectIds = commissionIds.map((id) => new mongoose.Types.ObjectId(id));
    const commissions = await ReferralCommission.find({ _id: { $in: objectIds } }).session(session);
    if (commissions.length !== objectIds.length) {
        throw new BusinessRuleError('One or more referral commissions were not found.', 'PAYOUT_COMMISSION_NOT_FOUND');
    }

    const byId = new Map(commissions.map((commission) => [commission._id.toString(), commission]));
    const ordered = commissionIds.map((id) => byId.get(id));
    let total = new Decimal(0);
    for (const commission of ordered) {
        if (String(commission.referrerUserId) !== String(userId)) {
            throw new AuthorizationError('You can only request payout for your own referral commissions.');
        }
        if (commission.status !== REFERRAL_COMMISSION_STATUS.AVAILABLE || commission.payoutRequestId) {
            throw new BusinessRuleError('Referral commission is not available for payout.', 'PAYOUT_COMMISSION_NOT_AVAILABLE');
        }
        if (normalizeCurrencyCode(commission.referrerCurrency) !== currency) {
            throw new BusinessRuleError('All payout commissions must use the requested currency.', 'PAYOUT_CURRENCY_MISMATCH');
        }
        total = total.plus(toDecimal(commission.commissionAmountReferrerCurrency));
    }
    if (total.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError('Payout total must be greater than zero.', 'PAYOUT_ZERO_TOTAL');
    }
    return { commissions: ordered, total: toMoneyString(total, 6) };
};

const findPayoutForUser = async (payoutId, userId, { fullDetails = false } = {}) => {
    const payout = await ReferralPayout.findOne({ _id: payoutId, userId })
        .populate('walletTransactionId', 'sourceKey amount createdAt')
        .lean();
    if (!payout) throw new NotFoundError('ReferralPayout');
    return serializePayout(payout, { fullDetails });
};

const createReferralPayout = async ({ userId, body, testHooks = {} }) => {
    const input = normalizePayoutCreationInput(body);
    const idempotencyFingerprint = input.idempotencyKey
        ? buildFingerprint({
            method: input.method,
            currency: input.currency,
            commissionIds: input.commissionIds,
            requestedAmount: input.requestedAmount,
            externalDetails: input.externalDetails,
        })
        : null;
    const session = await mongoose.startSession();
    let payout;
    let committed = false;

    try {
        await session.withTransaction(async () => {
            const user = await User.findOne({ _id: userId, deletedAt: null, status: USER_STATUS.ACTIVE })
                .select('currency status')
                .session(session);
            if (!user) throw new BusinessRuleError('Only active users can request referral payouts.', 'PAYOUT_USER_NOT_PAYABLE');
            if (input.method === REFERRAL_PAYOUT_METHODS.WALLET_CREDIT && normalizeCurrencyCode(user.currency || 'USD') !== input.currency) {
                throw new BusinessRuleError('Wallet payout currency must match your wallet currency.', 'PAYOUT_WALLET_CURRENCY_MISMATCH');
            }

            if (input.idempotencyKey) {
                const existing = await ReferralPayout.findOne({ userId, idempotencyKey: input.idempotencyKey }).session(session);
                if (existing) {
                    assertIdempotentReplayMatches(existing, idempotencyFingerprint);
                    payout = existing;
                    payout.$locals = payout.$locals || {};
                    payout.$locals.idempotentReplay = true;
                    return;
                }
            }

            let commissionIds = input.commissionIds;
            if (!commissionIds.length && input.requestedAmount !== null && input.requestedAmount !== undefined) {
                commissionIds = await resolveAmountOnlyCommissionIds({
                    userId,
                    currency: input.currency,
                    requestedAmount: input.requestedAmount,
                    session,
                });
            }
            const { total } = await loadAndValidateCommissions({
                userId,
                commissionIds,
                currency: input.currency,
                session,
            });

            const payoutId = new mongoose.Types.ObjectId();
            const claim = await ReferralCommission.updateMany(
                {
                    _id: { $in: commissionIds.map((id) => new mongoose.Types.ObjectId(id)) },
                    referrerUserId: userId,
                    status: REFERRAL_COMMISSION_STATUS.AVAILABLE,
                    payoutRequestId: null,
                    referrerCurrency: input.currency,
                },
                {
                    $set: {
                        status: REFERRAL_COMMISSION_STATUS.LOCKED,
                        payoutRequestId: payoutId,
                    },
                },
                { session }
            );
            if (claim.modifiedCount !== commissionIds.length) {
                throw new BusinessRuleError('One or more commissions are no longer available for payout.', 'PAYOUT_COMMISSION_LOCK_CONFLICT');
            }

            await runTestHook(testHooks.afterCommissionLockBeforePayoutCreate, { payoutId, commissionIds });

            const [created] = await ReferralPayout.create([{
                _id: payoutId,
                userId,
                method: input.method,
                currency: input.currency,
                amount: total,
                status: REFERRAL_PAYOUT_STATUS.PENDING,
                commissionIds: commissionIds.map((id) => new mongoose.Types.ObjectId(id)),
                commissionCount: commissionIds.length,
                externalPaymentDetails: input.externalDetails,
                externalPaymentSummary: summarizeExternalDetails(input.externalDetails),
                idempotencyKey: input.idempotencyKey || undefined,
                idempotencyFingerprint,
            }], { session });
            payout = created;
        });
        committed = true;
    } catch (err) {
        if (isDuplicateKeyError(err) && input.idempotencyKey) {
            const existing = await ReferralPayout.findOne({ userId, idempotencyKey: input.idempotencyKey });
            if (existing) {
                assertIdempotentReplayMatches(existing, idempotencyFingerprint);
                return serializePayout(existing);
            }
        }
        throw err;
    } finally {
        await session.endSession();
    }

    if (committed && payout && !payout.$locals?.idempotentReplay) {
        createAuditLog({
            actorId: userId,
            actorRole: ACTOR_ROLES.CUSTOMER,
            action: REFERRAL_PAYOUT_ACTIONS.CREATED,
            entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
            entityId: payout._id,
            metadata: {
                userId: userId.toString(),
                method: payout.method,
                currency: payout.currency,
                amount: payout.amount,
                commissionCount: payout.commissionCount,
            },
        });
    }

    return serializePayout(payout);
};

const assertPayoutCommissionsLocked = async (payout, session) => {
    const count = await ReferralCommission.countDocuments({
        _id: { $in: payout.commissionIds },
        referrerUserId: payout.userId,
        status: REFERRAL_COMMISSION_STATUS.LOCKED,
        payoutRequestId: payout._id,
        referrerCurrency: payout.currency,
    }).session(session);
    if (count !== payout.commissionCount) {
        throw new BusinessRuleError('Payout commission lock state is inconsistent.', 'PAYOUT_COMMISSION_STATE_INCONSISTENT');
    }
};

const normalizeReason = (value) => {
    const reason = String(value || '').trim();
    if (!reason) throw new BusinessRuleError('Payout rejection reason is required.', 'PAYOUT_REJECTION_REASON_REQUIRED');
    if (reason.length > 500) throw new BusinessRuleError('Payout rejection reason is too long.', 'PAYOUT_REJECTION_REASON_TOO_LONG');
    return reason;
};

const throwReviewedConflict = async (payoutId, session = null) => {
    const existing = await ReferralPayout.findById(payoutId).session(session);
    if (!existing) throw new NotFoundError('ReferralPayout');
    throw new BusinessRuleError('Referral payout has already been reviewed.', 'PAYOUT_ALREADY_REVIEWED');
};

const rejectReferralPayout = async ({ payoutId, reason, adminId, auditContext = {}, testHooks = {} }) => {
    const rejectionReason = normalizeReason(reason);
    const reviewedAt = new Date();
    const session = await mongoose.startSession();
    let payout;
    let releasedCount = 0;

    try {
        await session.withTransaction(async () => {
            payout = await ReferralPayout.findOneAndUpdate(
                { _id: payoutId, status: REFERRAL_PAYOUT_STATUS.PENDING },
                {
                    $set: {
                        status: REFERRAL_PAYOUT_STATUS.REJECTED,
                        rejectionReason,
                        reviewedBy: adminId,
                        reviewedAt,
                    },
                },
                { new: true, session }
            );
            if (!payout) await throwReviewedConflict(payoutId, session);
            await assertPayoutCommissionsLocked(payout, session);
            const update = await ReferralCommission.updateMany(
                {
                    _id: { $in: payout.commissionIds },
                    referrerUserId: payout.userId,
                    status: REFERRAL_COMMISSION_STATUS.LOCKED,
                    payoutRequestId: payout._id,
                },
                {
                    $set: { status: REFERRAL_COMMISSION_STATUS.AVAILABLE },
                    $unset: { payoutRequestId: '' },
                },
                { session }
            );
            releasedCount = update.modifiedCount;
            if (releasedCount !== payout.commissionCount) {
                throw new BusinessRuleError('Payout commission release count mismatch.', 'PAYOUT_COMMISSION_STATE_INCONSISTENT');
            }
            await runTestHook(testHooks.afterCommissionReleaseBeforeCommit, { payout });
        });
    } finally {
        await session.endSession();
    }

    createAuditLog({
        actorId: auditContext.actorId || adminId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: REFERRAL_PAYOUT_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
        entityId: payout._id,
        metadata: {
            userId: payout.userId.toString(),
            payoutId: payout._id.toString(),
            reason: rejectionReason,
            releasedCommissionCount: releasedCount,
            reviewedAt: reviewedAt.toISOString(),
        },
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
    });

    await runPostCommitHook(testHooks.afterCommit, { payout });
    return getAdminPayoutById(payout._id);
};

const payWalletReferralPayout = async ({ payoutId, adminId, auditContext = {}, testHooks = {} }) => {
    const paidAt = new Date();
    const sourceKey = `referral:payout:${payoutId}:wallet-credit`;
    const session = await mongoose.startSession();
    let payout;
    let walletTransaction;

    try {
        await session.withTransaction(async () => {
            payout = await ReferralPayout.findOneAndUpdate(
                { _id: payoutId, status: REFERRAL_PAYOUT_STATUS.PENDING },
                { $set: { reviewedBy: adminId, reviewedAt: paidAt } },
                { new: true, session }
            );
            if (!payout) await throwReviewedConflict(payoutId, session);
            if (payout.method !== REFERRAL_PAYOUT_METHODS.WALLET_CREDIT) {
                throw new BusinessRuleError('This payout is not a wallet-credit payout.', 'PAYOUT_METHOD_ACTION_MISMATCH');
            }

            const user = await User.findOne({ _id: payout.userId, deletedAt: null, status: USER_STATUS.ACTIVE })
                .select('currency status')
                .session(session);
            if (!user) throw new BusinessRuleError('Payout user is not payable.', 'PAYOUT_USER_NOT_PAYABLE');
            if (normalizeCurrencyCode(user.currency || 'USD') !== payout.currency) {
                throw new BusinessRuleError('Wallet payout currency must match user wallet currency.', 'PAYOUT_WALLET_CURRENCY_MISMATCH');
            }
            await assertPayoutCommissionsLocked(payout, session);

            const amount = Number(toDecimal(payout.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString());
            const credit = await creditWalletDirect({
                userId: payout.userId,
                amount,
                reference: null,
                sourceType: WALLET_TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
                sourceId: payout._id,
                sourceKey,
                description: `Referral payout ${payout._id}`,
                session,
                testHooks: testHooks.wallet,
            });
            walletTransaction = credit.transaction;

            await runTestHook(testHooks.afterWalletCreditBeforeCommissionPaid, { payout, walletTransaction });

            const paidCommissions = await ReferralCommission.updateMany(
                {
                    _id: { $in: payout.commissionIds },
                    referrerUserId: payout.userId,
                    status: REFERRAL_COMMISSION_STATUS.LOCKED,
                    payoutRequestId: payout._id,
                },
                { $set: { status: REFERRAL_COMMISSION_STATUS.PAID } },
                { session }
            );
            if (paidCommissions.modifiedCount !== payout.commissionCount) {
                throw new BusinessRuleError('Payout commission paid count mismatch.', 'PAYOUT_COMMISSION_STATE_INCONSISTENT');
            }

            await runTestHook(testHooks.afterCommissionPaidBeforePayoutFinal, { payout, walletTransaction });

            const final = await ReferralPayout.updateOne(
                { _id: payout._id, status: REFERRAL_PAYOUT_STATUS.PENDING },
                {
                    $set: {
                        status: REFERRAL_PAYOUT_STATUS.PAID,
                        walletTransactionId: walletTransaction._id,
                        reviewedBy: adminId,
                        reviewedAt: paidAt,
                        paidAt,
                    },
                },
                { session }
            );
            if (final.modifiedCount !== 1) {
                throw new BusinessRuleError('Payout finalization failed.', 'PAYOUT_ALREADY_REVIEWED');
            }
        });
    } finally {
        await session.endSession();
    }

    createAuditLog({
        actorId: auditContext.actorId || adminId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: REFERRAL_PAYOUT_ACTIONS.WALLET_PAID,
        entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
        entityId: payout._id,
        metadata: {
            userId: payout.userId.toString(),
            payoutId: payout._id.toString(),
            amount: payout.amount,
            currency: payout.currency,
            walletTransactionId: walletTransaction._id.toString(),
            paidAt: paidAt.toISOString(),
        },
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
    });

    await runPostCommitHook(testHooks.afterCommit, { payout, walletTransaction });
    return getAdminPayoutById(payout._id);
};

const normalizeExternalReference = (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    if (text.length > 160) {
        throw new BusinessRuleError('External transaction reference is too long.', 'PAYOUT_EXTERNAL_REFERENCE_TOO_LONG');
    }
    return text;
};

const readFileBytes = async (file) => {
    if (Buffer.isBuffer(file?.buffer)) return file.buffer;
    if (file?.path) return fs.promises.readFile(file.path);
    return null;
};

const assertImageSignature = (buffer, mimeType) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        throw new BusinessRuleError('Payout receipt file is invalid.', 'PAYOUT_RECEIPT_INVALID');
    }
    if (mimeType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return;
    if (mimeType === 'image/png' && buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return;
    if (mimeType === 'image/webp' && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return;
    throw new BusinessRuleError('Payout receipt file is invalid.', 'PAYOUT_RECEIPT_INVALID');
};

const validateReceiptFile = async (file) => {
    if (!file) return;
    const mimeType = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(String(file.originalname || file.filename || '')).toLowerCase();
    const size = Number(file.size || 0);
    if (!ALLOWED_RECEIPT_MIME_TYPES.has(mimeType) || !ALLOWED_RECEIPT_EXTENSIONS.has(ext)) {
        throw new BusinessRuleError('Payout receipt must be a JPEG, PNG, or WebP image.', 'PAYOUT_RECEIPT_INVALID');
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_RECEIPT_SIZE_BYTES) {
        throw new BusinessRuleError('Payout receipt file is too large or empty.', 'PAYOUT_RECEIPT_INVALID');
    }
    assertImageSignature(await readFileBytes(file), mimeType);
};

const cleanupReceiptFile = async (file) => {
    if (!file?.path) return;
    await fs.promises.unlink(file.path).catch(() => {});
};

const receiptMetadata = (file) => {
    if (!file) return {};
    return {
        paymentProofPath: `uploads/${RECEIPT_UPLOAD_CATEGORY}/${file.filename}`,
        paymentProofFileName: file.filename,
        paymentProofMimeType: String(file.mimetype || '').toLowerCase(),
        paymentProofSize: Number(file.size || 0),
    };
};

const markManualReferralPayoutPaid = async ({
    payoutId,
    externalTransactionReference,
    receiptFile = null,
    adminId,
    auditContext = {},
    testHooks = {},
}) => {
    await validateReceiptFile(receiptFile);
    const reference = normalizeExternalReference(externalTransactionReference);
    const paidAt = new Date();
    const session = await mongoose.startSession();
    let payout;
    let committed = false;

    try {
        await session.withTransaction(async () => {
            payout = await ReferralPayout.findOneAndUpdate(
                { _id: payoutId, status: REFERRAL_PAYOUT_STATUS.PENDING },
                { $set: { reviewedBy: adminId, reviewedAt: paidAt } },
                { new: true, session }
            );
            if (!payout) await throwReviewedConflict(payoutId, session);
            if (payout.method !== REFERRAL_PAYOUT_METHODS.MANUAL_EXTERNAL) {
                throw new BusinessRuleError('This payout is not a manual external payout.', 'PAYOUT_METHOD_ACTION_MISMATCH');
            }
            await assertPayoutCommissionsLocked(payout, session);

            const paidCommissions = await ReferralCommission.updateMany(
                {
                    _id: { $in: payout.commissionIds },
                    referrerUserId: payout.userId,
                    status: REFERRAL_COMMISSION_STATUS.LOCKED,
                    payoutRequestId: payout._id,
                },
                { $set: { status: REFERRAL_COMMISSION_STATUS.PAID } },
                { session }
            );
            if (paidCommissions.modifiedCount !== payout.commissionCount) {
                throw new BusinessRuleError('Payout commission paid count mismatch.', 'PAYOUT_COMMISSION_STATE_INCONSISTENT');
            }

            await runTestHook(testHooks.afterCommissionPaidBeforePayoutFinal, { payout });

            const final = await ReferralPayout.updateOne(
                { _id: payout._id, status: REFERRAL_PAYOUT_STATUS.PENDING },
                {
                    $set: {
                        status: REFERRAL_PAYOUT_STATUS.PAID,
                        externalTransactionReference: reference,
                        reviewedBy: adminId,
                        reviewedAt: paidAt,
                        paidAt,
                        ...receiptMetadata(receiptFile),
                    },
                },
                { session }
            );
            if (final.modifiedCount !== 1) {
                throw new BusinessRuleError('Payout finalization failed.', 'PAYOUT_ALREADY_REVIEWED');
            }
        });
        committed = true;
    } catch (err) {
        if (!committed) await cleanupReceiptFile(receiptFile);
        throw err;
    } finally {
        await session.endSession();
    }

    createAuditLog({
        actorId: auditContext.actorId || adminId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: REFERRAL_PAYOUT_ACTIONS.MANUAL_PAID,
        entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
        entityId: payout._id,
        metadata: {
            userId: payout.userId.toString(),
            payoutId: payout._id.toString(),
            amount: payout.amount,
            currency: payout.currency,
            externalTransactionReference: maskValue(reference),
            paidAt: paidAt.toISOString(),
        },
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
    });

    await runPostCommitHook(testHooks.afterCommit, { payout });
    return getAdminPayoutById(payout._id);
};

const runPostCommitHook = async (hook, payload) => {
    if (!hook) return;
    try {
        await runTestHook(hook, payload);
    } catch (err) {
        if (err.message === TEST_HOOK_ERROR) throw err;
        console.error('Referral payout post-commit side effect failed:', err.message);
    }
};

const normalizeStatusFilter = (status) => {
    if (!status) return null;
    const normalized = String(status).trim().toUpperCase();
    if (!Object.values(REFERRAL_PAYOUT_STATUS).includes(normalized)) {
        throw new BusinessRuleError('Invalid payout status filter.', 'PAYOUT_STATUS_INVALID');
    }
    return normalized;
};

const normalizeMethodFilter = (method) => {
    if (!method) return null;
    return normalizeMethod(method);
};

const proofUrl = (proofPath) => proofPath ? `/${String(proofPath).replace(/^\/+/, '')}` : null;

const legacyStatus = (status) => {
    if (status === REFERRAL_PAYOUT_STATUS.PENDING) return 'processing';
    if (status === REFERRAL_PAYOUT_STATUS.PAID) return 'completed';
    if (status === REFERRAL_PAYOUT_STATUS.REJECTED) return 'failed';
    return String(status || '').toLowerCase();
};

const legacyMethod = (method, details = {}) =>
    method === REFERRAL_PAYOUT_METHODS.WALLET_CREDIT
        ? 'wallet'
        : String(details.methodType || 'external').toLowerCase();

const serializePayout = (payout, { admin = false, fullDetails = false, includeCommissions = false } = {}) => {
    if (!payout) return null;
    const obj = typeof payout.toObject === 'function' ? payout.toObject() : payout;
    const externalSummary = obj.externalPaymentSummary || summarizeExternalDetails(obj.externalPaymentDetails || {});
    const serialized = {
        id: obj._id?.toString?.() || obj.id,
        userId: obj.userId?._id?.toString?.() || obj.userId?.toString?.() || null,
        method: obj.method,
        methodAlias: legacyMethod(obj.method, externalSummary),
        withdrawalMethod: legacyMethod(obj.method, externalSummary),
        currency: obj.currency,
        amount: obj.amount,
        status: String(obj.status || '').toLowerCase(),
        statusCode: obj.status,
        legacyStatus: legacyStatus(obj.status),
        commissionCount: obj.commissionCount,
        createdAt: obj.createdAt || null,
        updatedAt: obj.updatedAt || null,
        reviewedAt: obj.reviewedAt || null,
        paidAt: obj.paidAt || null,
        completedAt: obj.paidAt || null,
        rejectionReason: obj.rejectionReason || null,
        externalPaymentSummary: externalSummary,
        externalTransactionReference: maskValue(obj.externalTransactionReference),
        paymentProofUrl: proofUrl(obj.paymentProofPath),
        receiptImage: proofUrl(obj.paymentProofPath),
        walletTransactionId: obj.walletTransactionId?._id?.toString?.() || obj.walletTransactionId?.toString?.() || null,
    };
    if (admin && obj.userId && typeof obj.userId === 'object') {
        serialized.user = {
            id: obj.userId._id?.toString?.() || obj.userId.id || null,
            name: obj.userId.name || null,
            email: obj.userId.email || null,
            avatar: obj.userId.avatar || null,
            currency: obj.userId.currency || null,
        };
        serialized.ownerName = serialized.user.name;
        serialized.ownerEmail = serialized.user.email;
    }
    if (fullDetails) {
        serialized.externalPaymentDetails = obj.externalPaymentDetails || {};
        serialized.externalTransactionReferenceFull = obj.externalTransactionReference || null;
    }
    if (includeCommissions) {
        serialized.commissions = (obj.commissionIds || []).map((commission) => {
            if (!commission || typeof commission !== 'object' || !commission._id) {
                return { id: commission?.toString?.() || String(commission) };
            }
            return {
                id: commission._id.toString(),
                sourceType: commission.sourceType,
                sourceId: commission.sourceId?.toString?.() || null,
                amount: commission.commissionAmountReferrerCurrency,
                currency: commission.referrerCurrency,
                status: commission.status,
                sourceCompletedAt: commission.sourceCompletedAt,
            };
        });
    }
    return serialized;
};

const listPayoutsForUser = async (userId, { page = 1, limit = 20, status, method, currency } = {}) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const filter = { userId };
    const normalizedStatus = normalizeStatusFilter(status);
    if (normalizedStatus) filter.status = normalizedStatus;
    const normalizedMethod = normalizeMethodFilter(method);
    if (normalizedMethod) filter.method = normalizedMethod;
    if (currency) filter.currency = normalizeCurrencyCode(currency);

    const [payouts, total] = await Promise.all([
        ReferralPayout.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
        ReferralPayout.countDocuments(filter),
    ]);
    return {
        payouts: payouts.map((payout) => serializePayout(payout)),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit),
        },
    };
};

const listPayoutsForAdmin = async ({ page = 1, limit = 20, status, method, currency, search = '', from, to } = {}) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const filter = {};
    const normalizedStatus = normalizeStatusFilter(status);
    if (normalizedStatus) filter.status = normalizedStatus;
    const normalizedMethod = normalizeMethodFilter(method);
    if (normalizedMethod) filter.method = normalizedMethod;
    if (currency) filter.currency = normalizeCurrencyCode(currency);
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }
    const term = String(search || '').trim();
    if (term) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const users = await User.find({
            $or: [
                { name: { $regex: escaped, $options: 'i' } },
                { email: { $regex: escaped, $options: 'i' } },
            ],
        }).select('_id').limit(100).lean();
        filter.userId = { $in: users.map((user) => user._id) };
    }

    const [payouts, total] = await Promise.all([
        ReferralPayout.find(filter)
            .sort({ createdAt: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit)
            .populate('userId', 'name email avatar currency')
            .populate('walletTransactionId', 'sourceKey amount createdAt')
            .lean(),
        ReferralPayout.countDocuments(filter),
    ]);
    return {
        payouts: payouts.map((payout) => serializePayout(payout, { admin: true })),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit),
        },
    };
};

const getAdminPayoutById = async (payoutId) => {
    const payout = await ReferralPayout.findById(payoutId)
        .populate('userId', 'name email avatar currency')
        .populate('reviewedBy', 'name email')
        .populate('walletTransactionId', 'sourceKey amount createdAt')
        .populate('commissionIds', 'sourceType sourceId commissionAmountReferrerCurrency referrerCurrency status sourceCompletedAt')
        .lean();
    if (!payout) throw new NotFoundError('ReferralPayout');
    return serializePayout(payout, { admin: true, fullDetails: true, includeCommissions: true });
};

const buildSummaryGroups = async (userId) => {
    const commissions = await ReferralCommission.find({ referrerUserId: userId })
        .select('status referrerCurrency commissionAmountReferrerCurrency')
        .lean();
    const result = {
        availableEarnings: {},
        lockedEarnings: {},
        paidEarnings: {},
    };
    for (const commission of commissions) {
        const currency = normalizeCurrencyCode(commission.referrerCurrency);
        const amount = toDecimal(commission.commissionAmountReferrerCurrency);
        if (commission.status === REFERRAL_COMMISSION_STATUS.AVAILABLE) {
            result.availableEarnings[currency] = toMoneyString(toDecimal(result.availableEarnings[currency]).plus(amount), 6);
        }
        if (commission.status === REFERRAL_COMMISSION_STATUS.LOCKED) {
            result.lockedEarnings[currency] = toMoneyString(toDecimal(result.lockedEarnings[currency]).plus(amount), 6);
        }
        if (commission.status === REFERRAL_COMMISSION_STATUS.PAID) {
            result.paidEarnings[currency] = toMoneyString(toDecimal(result.paidEarnings[currency]).plus(amount), 6);
        }
    }
    return result;
};

const auditReferralPayouts = async () => {
    const [
        lockedMissingPayout,
        pendingMismatch,
        paidMismatch,
        rejectedStillLocked,
        walletPaidMissingTxn,
        duplicateWalletSourceKeys,
        amountMismatches,
        currencyMismatches,
    ] = await Promise.all([
        ReferralCommission.countDocuments({
            status: REFERRAL_COMMISSION_STATUS.LOCKED,
            $or: [{ payoutRequestId: null }, { payoutRequestId: { $exists: false } }],
        }),
        countPayoutCommissionStateMismatch(REFERRAL_PAYOUT_STATUS.PENDING, REFERRAL_COMMISSION_STATUS.LOCKED),
        countPayoutCommissionStateMismatch(REFERRAL_PAYOUT_STATUS.PAID, REFERRAL_COMMISSION_STATUS.PAID),
        countPayoutCommissionStateMismatch(REFERRAL_PAYOUT_STATUS.REJECTED, null),
        ReferralPayout.countDocuments({
            method: REFERRAL_PAYOUT_METHODS.WALLET_CREDIT,
            status: REFERRAL_PAYOUT_STATUS.PAID,
            walletTransactionId: null,
        }),
        WalletTransaction.aggregate([
            { $match: { sourceType: WALLET_TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT, sourceKey: { $type: 'string' } } },
            { $group: { _id: '$sourceKey', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $count: 'groups' },
        ]),
        countPayoutAmountMismatches(),
        countPayoutCurrencyMismatches(),
    ]);

    return {
        lockedCommissionsMissingPayout: lockedMissingPayout,
        pendingPayoutCommissionStateMismatches: pendingMismatch,
        paidPayoutCommissionStateMismatches: paidMismatch,
        rejectedPayoutsWithLockedCommissions: rejectedStillLocked,
        walletPaidPayoutsMissingWalletTransaction: walletPaidMissingTxn,
        duplicateWalletPayoutReferences: duplicateWalletSourceKeys[0]?.groups || 0,
        payoutAmountMismatches: amountMismatches,
        payoutCurrencyMismatches: currencyMismatches,
    };
};

const countPayoutCommissionStateMismatch = async (payoutStatus, expectedCommissionStatus) => {
    const payouts = await ReferralPayout.find({ status: payoutStatus }).select('_id userId commissionIds commissionCount currency').lean();
    let mismatches = 0;
    for (const payout of payouts) {
        const filter = {
            _id: { $in: payout.commissionIds },
            referrerUserId: payout.userId,
            referrerCurrency: payout.currency,
        };
        if (expectedCommissionStatus) {
            filter.status = expectedCommissionStatus;
            filter.payoutRequestId = payout._id;
        } else {
            filter.$or = [
                { status: REFERRAL_COMMISSION_STATUS.LOCKED },
                { payoutRequestId: payout._id },
            ];
        }
        const count = await ReferralCommission.countDocuments(filter);
        if (expectedCommissionStatus ? count !== payout.commissionCount : count > 0) mismatches += 1;
    }
    return mismatches;
};

const countPayoutAmountMismatches = async () => {
    const payouts = await ReferralPayout.find().select('_id commissionIds amount').lean();
    let mismatches = 0;
    for (const payout of payouts) {
        const commissions = await ReferralCommission.find({ _id: { $in: payout.commissionIds } })
            .select('commissionAmountReferrerCurrency')
            .lean();
        const total = commissions.reduce((sum, commission) => sum.plus(toDecimal(commission.commissionAmountReferrerCurrency)), new Decimal(0));
        if (!toDecimal(payout.amount).equals(total)) mismatches += 1;
    }
    return mismatches;
};

const countPayoutCurrencyMismatches = async () => {
    const payouts = await ReferralPayout.find().select('_id commissionIds currency').lean();
    let mismatches = 0;
    for (const payout of payouts) {
        const count = await ReferralCommission.countDocuments({
            _id: { $in: payout.commissionIds },
            referrerCurrency: payout.currency,
        });
        if (count !== payout.commissionIds.length) mismatches += 1;
    }
    return mismatches;
};

module.exports = {
    RECEIPT_UPLOAD_CATEGORY,
    MAX_RECEIPT_SIZE_BYTES,
    REFERRAL_PAYOUT_METHODS,
    REFERRAL_PAYOUT_STATUS,
    normalizeMethod,
    normalizeExternalDetails,
    serializePayout,
    validateReceiptFile,
    cleanupReceiptFile,
    createReferralPayout,
    listPayoutsForUser,
    findPayoutForUser,
    listPayoutsForAdmin,
    getAdminPayoutById,
    rejectReferralPayout,
    payWalletReferralPayout,
    markManualReferralPayoutPaid,
    buildSummaryGroups,
    auditReferralPayouts,
    runTestHook,
};
