'use strict';

const Decimal = require('decimal.js');
const { User, USER_STATUS } = require('../users/user.model');
const { Currency } = require('../currency/currency.model');
const {
    DepositRequest,
    REFERRAL_COMMISSION_PROCESSING_STATUS,
} = require('../deposits/deposit.model');
const {
    ReferralCommission,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_COMMISSION_SOURCE_TYPES,
} = require('./referralCommission.model');
const { calculateReferralEligibleUntil } = require('./referral.service');
const { getSettingValue } = require('../admin/admin.settings.service');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { BusinessRuleError, NotFoundError } = require('../../shared/errors/AppError');

const DEFAULT_REFERRAL_COMMISSION_PERCENT = '1';
const MAX_REFERRAL_COMMISSION_PERCENT = 50;
const REFERRAL_COMMISSION_SETTING_KEY = 'referralDefaultCommissionPercent';

const REFERRAL_COMMISSION_OUTCOMES = Object.freeze({
    CREATED: 'CREATED',
    ALREADY_EXISTS: 'ALREADY_EXISTS',
    NOT_REFERRED: 'NOT_REFERRED',
    MISSING_REFERRAL_START: 'MISSING_REFERRAL_START',
    EXPIRED: 'EXPIRED',
    STOPPED: 'STOPPED',
    ZERO_PERCENT: 'ZERO_PERCENT',
    INVALID_REFERRER: 'INVALID_REFERRER',
    NOT_APPROVED: 'NOT_APPROVED',
    IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
    FAILED_CONFIGURATION: 'FAILED_CONFIGURATION',
});

const RETRYABLE_COMMISSION_STATUSES = Object.freeze([
    REFERRAL_COMMISSION_PROCESSING_STATUS.FAILED,
]);

const COMMISSION_LIST_STATUSES = new Set(Object.values(REFERRAL_COMMISSION_STATUS));

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

const isDuplicateKeyError = (err) => err?.code === 11000;

const runTestHook = async (hook, payload) => {
    if (!hook) return;
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('Referral commission test hooks are only available in NODE_ENV=test.');
    }
    await hook(payload);
};

const toStrictDecimal = (value) => {
    try {
        if (typeof value === 'string' && !value.trim()) return null;
        const decimal = new Decimal(value);
        return decimal.isFinite() ? decimal : null;
    } catch (_) {
        return null;
    }
};

const validateCommissionPercent = (value, { allowNull = false } = {}) => {
    if ((value === null || value === undefined) && allowNull) return null;
    const decimal = toStrictDecimal(value);
    if (!decimal) {
        throw new BusinessRuleError('Referral commission percent is invalid.', 'REFERRAL_COMMISSION_PERCENT_INVALID');
    }
    if (decimal.isNegative()) {
        throw new BusinessRuleError('Referral commission percent cannot be negative.', 'REFERRAL_COMMISSION_PERCENT_INVALID');
    }
    if (decimal.greaterThan(MAX_REFERRAL_COMMISSION_PERCENT)) {
        throw new BusinessRuleError(
            `Referral commission percent cannot exceed ${MAX_REFERRAL_COMMISSION_PERCENT}%.`,
            'REFERRAL_COMMISSION_PERCENT_TOO_HIGH'
        );
    }
    return decimal;
};

const resolveDefaultCommissionPercent = async () => {
    const settingValue = await getSettingValue(REFERRAL_COMMISSION_SETTING_KEY, null).catch(() => null);
    const configured = settingValue ?? process.env.REFERRAL_DEFAULT_COMMISSION_PERCENT ?? DEFAULT_REFERRAL_COMMISSION_PERCENT;
    try {
        return validateCommissionPercent(configured);
    } catch (_) {
        return new Decimal(DEFAULT_REFERRAL_COMMISSION_PERCENT);
    }
};

const resolveCommissionPercent = async (referrer) => {
    if (referrer.referralCommissionPercentOverride !== null
        && referrer.referralCommissionPercentOverride !== undefined) {
        return validateCommissionPercent(referrer.referralCommissionPercentOverride);
    }
    return resolveDefaultCommissionPercent();
};

const normalizeCurrencyCode = (value) => String(value || 'USD').trim().toUpperCase();

const fxErrorCode = (kind, role) => `${role}_${kind}`;

const getPlatformRateSnapshot = async (currencyCode, role = 'SOURCE') => {
    const code = normalizeCurrencyCode(currencyCode);
    if (code === 'USD') return { code, rate: new Decimal(1) };

    const currency = await Currency.findOne({ code });
    if (!currency) {
        throw new BusinessRuleError(
            `Currency configuration is required for ${code}.`,
            fxErrorCode('CURRENCY_CONFIGURATION_MISSING', role)
        );
    }
    if (currency.isActive !== true) {
        throw new BusinessRuleError(
            `Currency ${code} is inactive.`,
            fxErrorCode('CURRENCY_INACTIVE', role)
        );
    }

    return { code, rate: validatePositiveRate(currency.platformRate, code, role) };
};

const validatePositiveRate = (value, code, role = 'SOURCE') => {
    const rate = toDecimal(value);
    if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError(
            `Currency ${code} has an invalid platform rate.`,
            fxErrorCode('INVALID_PLATFORM_RATE', role)
        );
    }
    return rate;
};

const buildFxCommissionSnapshot = async ({
    originalAmount,
    originalCurrency,
    referrerCurrency,
    commissionPercent,
}) => {
    const sourceCode = normalizeCurrencyCode(originalCurrency);
    const targetCode = normalizeCurrencyCode(referrerCurrency);
    const source = await getPlatformRateSnapshot(sourceCode, 'SOURCE');
    const target = sourceCode === targetCode
        ? { code: source.code, rate: source.rate }
        : await getPlatformRateSnapshot(targetCode, 'TARGET');
    const original = toDecimal(originalAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const sourceCommission = original
        .times(commissionPercent)
        .dividedBy(100)
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
    const effectiveRate = target.rate.dividedBy(source.rate).toDecimalPlaces(12, Decimal.ROUND_HALF_UP);
    const targetCommission = sourceCommission
        .dividedBy(source.rate)
        .times(target.rate)
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

    return {
        originalAmount: toMoneyString(original, 2),
        originalCurrency: source.code,
        commissionPercentSnapshot: toMoneyString(commissionPercent, 6),
        commissionAmountOriginalCurrency: toMoneyString(sourceCommission, 6),
        referrerCurrency: target.code,
        commissionAmountReferrerCurrency: toMoneyString(targetCommission, 6),
        sourcePlatformRateSnapshot: toMoneyString(source.rate, 6),
        targetPlatformRateSnapshot: toMoneyString(target.rate, 6),
        effectiveFxRateSnapshot: effectiveRate.toFixed(12),
        convertedAt: new Date(),
    };
};

const evaluateReferralEligibility = async ({ referredUserId, sourceCompletedAt, session = null }) => {
    const referred = await User.findById(referredUserId)
        .select('referredBy referredAt referralEligibleUntil referralCommissionStoppedAt')
        .session(session);

    if (!referred?.referredBy) {
        return { eligible: false, outcome: REFERRAL_COMMISSION_OUTCOMES.NOT_REFERRED };
    }

    if (!referred.referredAt) {
        return { eligible: false, outcome: REFERRAL_COMMISSION_OUTCOMES.MISSING_REFERRAL_START };
    }

    const referrer = await User.findOne({
        _id: referred.referredBy,
        deletedAt: null,
        status: USER_STATUS.ACTIVE,
    })
        .select('currency referralCommissionPercentOverride deletedAt status')
        .session(session);

    if (!referrer) {
        return { eligible: false, outcome: REFERRAL_COMMISSION_OUTCOMES.INVALID_REFERRER, referred };
    }

    const completedAt = sourceCompletedAt instanceof Date ? sourceCompletedAt : new Date(sourceCompletedAt);
    const eligibleUntil = referred.referralEligibleUntil || calculateReferralEligibleUntil(referred.referredAt);

    if (!eligibleUntil || completedAt.getTime() > eligibleUntil.getTime()) {
        return {
            eligible: false,
            outcome: REFERRAL_COMMISSION_OUTCOMES.EXPIRED,
            referred,
            referrer,
            eligibleUntil,
        };
    }

    if (referred.referralCommissionStoppedAt
        && completedAt.getTime() >= referred.referralCommissionStoppedAt.getTime()) {
        return {
            eligible: false,
            outcome: REFERRAL_COMMISSION_OUTCOMES.STOPPED,
            referred,
            referrer,
            eligibleUntil,
        };
    }

    return {
        eligible: true,
        referred,
        referrer,
        eligibleUntil,
    };
};

const markDepositCommission = async (depositId, fields, session = null) => {
    const processedAt = Object.prototype.hasOwnProperty.call(fields, 'processedAt')
        ? fields.processedAt
        : new Date();
    await DepositRequest.updateOne(
        { _id: depositId },
        {
            $set: {
                referralCommissionProcessingStatus: fields.processingStatus,
                referralCommissionOutcome: fields.outcome ?? null,
                referralCommissionId: fields.commissionId ?? null,
                referralCommissionProcessedAt: processedAt,
                referralCommissionError: fields.error ?? null,
            },
        },
        { session }
    );
};

const buildCommissionIdempotencyKey = (depositId, referrerUserId) =>
    `deposit:${depositId.toString()}:referrer:${referrerUserId.toString()}`;

const createCommissionRecord = async ({ deposit, referred, referrer, eligibleUntil, percent, fx, sourceCompletedAt, session, testHooks = {} }) => {
    const idempotencyKey = buildCommissionIdempotencyKey(deposit._id, referrer._id);
    const payload = {
        referrerUserId: referrer._id,
        referredUserId: referred._id,
        sourceType: REFERRAL_COMMISSION_SOURCE_TYPES.DEPOSIT_APPROVAL,
        sourceId: deposit._id,
        idempotencyKey,
        originalAmount: fx.originalAmount,
        originalCurrency: fx.originalCurrency,
        commissionPercentSnapshot: fx.commissionPercentSnapshot,
        commissionAmountOriginalCurrency: fx.commissionAmountOriginalCurrency,
        referrerCurrency: fx.referrerCurrency,
        commissionAmountReferrerCurrency: fx.commissionAmountReferrerCurrency,
        sourcePlatformRateSnapshot: fx.sourcePlatformRateSnapshot,
        targetPlatformRateSnapshot: fx.targetPlatformRateSnapshot,
        effectiveFxRateSnapshot: fx.effectiveFxRateSnapshot,
        convertedAt: fx.convertedAt,
        status: REFERRAL_COMMISSION_STATUS.AVAILABLE,
        referralStartedAt: referred.referredAt,
        eligibleUntil,
        sourceCompletedAt,
        metadata: {
            commissionPercentSource:
                referrer.referralCommissionPercentOverride === null || referrer.referralCommissionPercentOverride === undefined
                    ? 'default'
                    : 'referrer_override',
            percentResolved: toMoneyString(percent, 6),
        },
    };

    try {
        const [created] = await ReferralCommission.create([payload], { session });
        await runTestHook(testHooks.afterCommissionCreationBeforeMarker, { commission: created, payload });
        return { commission: created, outcome: REFERRAL_COMMISSION_OUTCOMES.CREATED };
    } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const commission = await ReferralCommission.findOne({ idempotencyKey }).session(session);
        if (commission && (
            commission.originalAmount !== payload.originalAmount
            || commission.originalCurrency !== payload.originalCurrency
            || commission.commissionPercentSnapshot !== payload.commissionPercentSnapshot
            || commission.referrerCurrency !== payload.referrerCurrency
            || commission.commissionAmountReferrerCurrency !== payload.commissionAmountReferrerCurrency
        )) {
            throw new BusinessRuleError(
                'Existing referral commission differs from the requested financial snapshot.',
                'REFERRAL_COMMISSION_IDEMPOTENCY_CONFLICT'
            );
        }
        return { commission, outcome: REFERRAL_COMMISSION_OUTCOMES.ALREADY_EXISTS };
    }
};

const processDepositReferralCommission = async ({
    deposit,
    sourceAmount,
    sourceCurrency,
    sourceCompletedAt,
    session = null,
    testHooks = {},
}) => {
    if (deposit.status !== 'APPROVED') {
        await markDepositCommission(deposit._id, {
            processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE,
            outcome: REFERRAL_COMMISSION_OUTCOMES.NOT_APPROVED,
        }, session);
        return { outcome: REFERRAL_COMMISSION_OUTCOMES.NOT_APPROVED, commission: null };
    }

    await markDepositCommission(deposit._id, {
        processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.PENDING,
        outcome: null,
        processedAt: null,
    }, session);

    const eligibility = await evaluateReferralEligibility({
        referredUserId: deposit.userId,
        sourceCompletedAt,
        session,
    });

    if (!eligibility.eligible) {
        await markDepositCommission(deposit._id, {
            processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE,
            outcome: eligibility.outcome,
        }, session);
        return { outcome: eligibility.outcome, commission: null };
    }

    const percent = await resolveCommissionPercent(eligibility.referrer);
    if (percent.isZero()) {
        await markDepositCommission(deposit._id, {
            processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE,
            outcome: REFERRAL_COMMISSION_OUTCOMES.ZERO_PERCENT,
        }, session);
        return { outcome: REFERRAL_COMMISSION_OUTCOMES.ZERO_PERCENT, commission: null };
    }

    try {
        const fx = await buildFxCommissionSnapshot({
            originalAmount: sourceAmount,
            originalCurrency: sourceCurrency,
            referrerCurrency: eligibility.referrer.currency || 'USD',
            commissionPercent: percent,
        });
        const { commission, outcome } = await createCommissionRecord({
            deposit,
            referred: eligibility.referred,
            referrer: eligibility.referrer,
            eligibleUntil: eligibility.eligibleUntil,
            percent,
            fx,
            sourceCompletedAt,
            session,
            testHooks,
        });
        await markDepositCommission(deposit._id, {
            processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.PROCESSED,
            outcome,
            commissionId: commission?._id ?? null,
        }, session);
        return { outcome, commission };
    } catch (err) {
        if (err.code === 'REFERRAL_COMMISSION_IDEMPOTENCY_CONFLICT') {
            await markDepositCommission(deposit._id, {
                processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.FAILED,
                outcome: REFERRAL_COMMISSION_OUTCOMES.IDEMPOTENCY_CONFLICT,
                error: err.code,
            }, session);
            throw err;
        }
        if (err.isOperational) {
            await markDepositCommission(deposit._id, {
                processingStatus: REFERRAL_COMMISSION_PROCESSING_STATUS.FAILED,
                outcome: REFERRAL_COMMISSION_OUTCOMES.FAILED_CONFIGURATION,
                error: err.code || err.message,
            }, session);
            return {
                outcome: REFERRAL_COMMISSION_OUTCOMES.FAILED_CONFIGURATION,
                commission: null,
                error: err,
            };
        }
        throw err;
    }
};

const listReferralCommissionsForReferrer = async (userId, {
    page = 1,
    limit = 20,
    status,
    currency,
} = {}) => {
    const filter = { referrerUserId: userId };
    if (status) {
        const normalizedStatus = String(status).trim().toUpperCase();
        if (!COMMISSION_LIST_STATUSES.has(normalizedStatus)) {
            throw new BusinessRuleError('Invalid commission status filter.', 'REFERRAL_COMMISSION_STATUS_INVALID');
        }
        filter.status = normalizedStatus;
    }
    if (currency) filter.referrerCurrency = normalizeCurrencyCode(currency);
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [commissions, total] = await Promise.all([
        ReferralCommission.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .populate('referredUserId', 'name createdAt'),
        ReferralCommission.countDocuments(filter),
    ]);

    return {
        commissions,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit),
        },
    };
};

const getReferralCommissionSummaryForReferrer = async (userId) => {
    const commissions = await ReferralCommission.find({ referrerUserId: userId })
        .select('status referrerCurrency commissionAmountReferrerCurrency')
        .lean();
    const grouped = new Map();

    for (const commission of commissions) {
        const currency = normalizeCurrencyCode(commission.referrerCurrency);
        const current = grouped.get(currency) || {
            currency,
            available: new Decimal(0),
            locked: new Decimal(0),
            paid: new Decimal(0),
            cancelled: new Decimal(0),
            total: new Decimal(0),
            count: 0,
        };
        const amount = toDecimal(commission.commissionAmountReferrerCurrency);
        if (commission.status === REFERRAL_COMMISSION_STATUS.AVAILABLE) current.available = current.available.plus(amount);
        if (commission.status === REFERRAL_COMMISSION_STATUS.LOCKED) current.locked = current.locked.plus(amount);
        if (commission.status === REFERRAL_COMMISSION_STATUS.PAID) current.paid = current.paid.plus(amount);
        if (commission.status === REFERRAL_COMMISSION_STATUS.CANCELLED) current.cancelled = current.cancelled.plus(amount);
        current.total = current.total.plus(amount);
        current.count += 1;
        grouped.set(currency, current);
    }

    return [...grouped.values()].map((row) => ({
        currency: row.currency,
        available: toMoneyString(row.available, 6),
        locked: toMoneyString(row.locked, 6),
        paid: toMoneyString(row.paid, 6),
        cancelled: toMoneyString(row.cancelled, 6),
        total: toMoneyString(row.total, 6),
        count: row.count,
    }));
};

const buildReconciliationFilter = ({ depositId, from, to, failedOnly = true } = {}) => {
    const filter = { status: 'APPROVED' };
    if (depositId) filter._id = depositId;
    if (failedOnly) {
        filter.referralCommissionProcessingStatus = { $in: RETRYABLE_COMMISSION_STATUSES };
    }
    const reviewedAt = {};
    if (from) reviewedAt.$gte = from;
    if (to) reviewedAt.$lte = to;
    if (Object.keys(reviewedAt).length > 0) filter.reviewedAt = reviewedAt;
    return filter;
};

const reconcileReferralCommissions = async ({
    dryRun = true,
    batchSize = 250,
    depositId = null,
    from = null,
    to = null,
    failedOnly = true,
} = {}) => {
    const normalizedBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || 250));
    const filter = buildReconciliationFilter({ depositId, from, to, failedOnly });
    let scanned = 0;
    let candidates = 0;
    let processed = 0;
    let created = 0;
    let alreadyExists = 0;
    let failed = 0;
    let skipped = 0;

    const cursor = DepositRequest.find(filter)
        .select('_id userId status requestedAmount currency reviewedAt referralCommissionProcessingStatus referralCommissionOutcome')
        .sort({ _id: 1 })
        .batchSize(normalizedBatchSize)
        .cursor();

    for await (const deposit of cursor) {
        scanned += 1;
        if (deposit.status !== 'APPROVED') {
            skipped += 1;
            continue;
        }
        candidates += 1;
        if (dryRun) continue;

        const outcome = await processDepositReferralCommission({
            deposit,
            sourceAmount: deposit.requestedAmount,
            sourceCurrency: deposit.currency,
            sourceCompletedAt: deposit.reviewedAt,
        });

        processed += 1;
        if (outcome.outcome === REFERRAL_COMMISSION_OUTCOMES.CREATED) created += 1;
        if (outcome.outcome === REFERRAL_COMMISSION_OUTCOMES.ALREADY_EXISTS) alreadyExists += 1;
        if (outcome.outcome === REFERRAL_COMMISSION_OUTCOMES.FAILED_CONFIGURATION) failed += 1;
    }

    return {
        scanned,
        candidates,
        processed,
        created,
        alreadyExists,
        failed,
        skipped,
        batchSize: normalizedBatchSize,
        dryRun,
    };
};

const setReferralCommissionOverride = async ({
    userId,
    percent,
    adminId,
    auditContext = null,
}) => {
    const nextPercent = validateCommissionPercent(percent, { allowNull: true });
    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) throw new NotFoundError('User');

    const previousPercent = user.referralCommissionPercentOverride ?? null;
    user.referralCommissionPercentOverride = nextPercent === null ? null : nextPercent.toNumber();
    await user.save();

    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            type: 'REFERRAL_COMMISSION_OVERRIDE',
            previousPercent,
            nextPercent: user.referralCommissionPercentOverride,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return {
        userId: user._id,
        referralCommissionPercentOverride: user.referralCommissionPercentOverride,
    };
};

module.exports = {
    DEFAULT_REFERRAL_COMMISSION_PERCENT,
    MAX_REFERRAL_COMMISSION_PERCENT,
    REFERRAL_COMMISSION_SETTING_KEY,
    REFERRAL_COMMISSION_OUTCOMES,
    validateCommissionPercent,
    resolveDefaultCommissionPercent,
    resolveCommissionPercent,
    buildFxCommissionSnapshot,
    evaluateReferralEligibility,
    processDepositReferralCommission,
    reconcileReferralCommissions,
    buildReconciliationFilter,
    listReferralCommissionsForReferrer,
    getReferralCommissionSummaryForReferrer,
    setReferralCommissionOverride,
};
