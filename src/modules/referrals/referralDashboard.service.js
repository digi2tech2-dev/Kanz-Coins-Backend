'use strict';

const Decimal = require('decimal.js');
const { User } = require('../users/user.model');
const { ReferralCommission, REFERRAL_COMMISSION_STATUS } = require('./referralCommission.model');
const { ReferralPayout, REFERRAL_PAYOUT_STATUS } = require('../referralPayouts/referralPayout.model');
const { getSettingValue } = require('../admin/admin.settings.service');
const {
    REFERRAL_COMMISSION_SETTING_KEY,
    resolveDefaultCommissionPercent,
} = require('./referralCommission.service');

const REFERRAL_PAYOUT_METHODS_SETTING_KEY = 'referralPayoutMethods';

const DEFAULT_REFERRAL_PAYOUT_METHODS = Object.freeze([
    { id: 'wallet', name: 'محفظة البرنامج', enabled: true, requiresAccount: false, discountPercent: 0, kind: 'wallet_credit', sortOrder: 0 },
    { id: 'vodafone', name: 'فودافون كاش', enabled: true, requiresAccount: true, discountPercent: 0, kind: 'manual_external', sortOrder: 10 },
    { id: 'instapay', name: 'إنستا باي', enabled: true, requiresAccount: true, discountPercent: 0, kind: 'manual_external', sortOrder: 20 },
]);

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

const normalizeCurrencyCode = (value, fallback = 'USD') =>
    String(value || fallback).trim().toUpperCase();

const addGroupedAmount = (target, currency, field, amount) => {
    const code = normalizeCurrencyCode(currency);
    if (!target[code]) {
        target[code] = {
            currency: code,
            available: new Decimal(0),
            locked: new Decimal(0),
            paid: new Decimal(0),
            cancelled: new Decimal(0),
            total: new Decimal(0),
            count: 0,
        };
    }
    const row = target[code];
    const decimal = toDecimal(amount);
    if (field && row[field]) row[field] = row[field].plus(decimal);
    row.total = row.total.plus(decimal);
    row.count += 1;
};

const serializeGroups = (groups = {}) => Object.values(groups).map((row) => ({
    currency: row.currency,
    available: toMoneyString(row.available),
    locked: toMoneyString(row.locked),
    paid: toMoneyString(row.paid),
    cancelled: toMoneyString(row.cancelled),
    total: toMoneyString(row.total),
    count: row.count,
}));

const pickCurrencyAmount = (groups = {}, currency, field, fallback = '0.000000') => {
    const row = groups[normalizeCurrencyCode(currency)];
    if (!row) return fallback;
    return toMoneyString(row[field] || 0);
};

const safeUserSummary = (user) => {
    if (!user) return null;
    return {
        id: user._id?.toString?.() || user.id || null,
        name: user.name || null,
        email: user.email || null,
        phone: user.phone || null,
        avatar: user.avatar || null,
        country: user.country || null,
        currency: normalizeCurrencyCode(user.currency),
        status: user.status || null,
        createdAt: user.createdAt || null,
    };
};

const commissionStatusField = (status) => {
    if (status === REFERRAL_COMMISSION_STATUS.AVAILABLE) return 'available';
    if (status === REFERRAL_COMMISSION_STATUS.LOCKED) return 'locked';
    if (status === REFERRAL_COMMISSION_STATUS.PAID) return 'paid';
    if (status === REFERRAL_COMMISSION_STATUS.CANCELLED) return 'cancelled';
    return null;
};

const payoutStatusField = (status) => {
    if (status === REFERRAL_PAYOUT_STATUS.PAID) return 'paid';
    if (status === REFERRAL_PAYOUT_STATUS.PENDING) return 'locked';
    return null;
};

const normalizePayoutMethod = (method = {}, index = 0) => {
    const id = String(method.id || method.code || method.method || '').trim().toLowerCase();
    if (!id || !/^[a-z0-9_-]{2,64}$/.test(id)) return null;
    const name = String(method.name || method.label || id).trim().slice(0, 120);
    return {
        id,
        code: id,
        name: name || id,
        enabled: method.enabled !== false && method.isActive !== false,
        isActive: method.enabled !== false && method.isActive !== false,
        requiresAccount: method.requiresAccount !== false && id !== 'wallet',
        kind: id === 'wallet' ? 'wallet_credit' : 'manual_external',
        discountPercent: Math.min(100, Math.max(0, Number(method.discountPercent || 0) || 0)),
        sortOrder: Number.isFinite(Number(method.sortOrder)) ? Number(method.sortOrder) : index,
    };
};

const getReferralPayoutMethods = async ({ activeOnly = false } = {}) => {
    const configured = await getSettingValue(REFERRAL_PAYOUT_METHODS_SETTING_KEY, DEFAULT_REFERRAL_PAYOUT_METHODS).catch(() => DEFAULT_REFERRAL_PAYOUT_METHODS);
    const raw = Array.isArray(configured) ? configured : DEFAULT_REFERRAL_PAYOUT_METHODS;
    const methods = raw
        .map((method, index) => normalizePayoutMethod(method, index))
        .filter(Boolean)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    const resolved = methods.length ? methods : DEFAULT_REFERRAL_PAYOUT_METHODS.map(normalizePayoutMethod);
    return activeOnly ? resolved.filter((method) => method.enabled) : resolved;
};

const getCustomerReferralDashboard = async (userId, { limit = 50 } = {}) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const [user, invitedUsers, commissions, payouts] = await Promise.all([
        User.findById(userId).select('name email avatar referralCode currency resellerStatus resellerApprovedAt referralCommissionStoppedAt groupId').populate('groupId', 'name percentage billingMode isActive').lean(),
        User.find({ referredBy: userId, deletedAt: null })
            .select('name email phone avatar country currency status createdAt referredAt referralEligibleUntil')
            .sort({ referredAt: -1, createdAt: -1 })
            .limit(safeLimit)
            .lean(),
        ReferralCommission.find({ referrerUserId: userId })
            .select('referredUserId status referrerCurrency commissionAmountReferrerCurrency originalAmount originalCurrency sourceCompletedAt commissionPercentSnapshot createdAt')
            .lean(),
        ReferralPayout.find({ userId })
            .select('status currency amount')
            .lean(),
    ]);

    const walletCurrency = normalizeCurrencyCode(user?.currency);
    const commissionGroups = {};
    const payoutGroups = {};
    const byReferred = new Map();

    for (const commission of commissions) {
        const field = commissionStatusField(commission.status);
        addGroupedAmount(commissionGroups, commission.referrerCurrency, field, commission.commissionAmountReferrerCurrency);
        const key = commission.referredUserId?.toString?.() || String(commission.referredUserId || '');
        const current = byReferred.get(key) || {
            earnings: new Decimal(0),
            addedAmount: new Decimal(0),
            currency: normalizeCurrencyCode(commission.referrerCurrency, walletCurrency),
        };
        if (normalizeCurrencyCode(commission.referrerCurrency) === walletCurrency) {
            current.earnings = current.earnings.plus(toDecimal(commission.commissionAmountReferrerCurrency));
        }
        if (normalizeCurrencyCode(commission.originalCurrency) === walletCurrency) {
            current.addedAmount = current.addedAmount.plus(toDecimal(commission.originalAmount));
        }
        byReferred.set(key, current);
    }

    for (const payout of payouts) {
        const field = payoutStatusField(payout.status);
        if (field) addGroupedAmount(payoutGroups, payout.currency, field, payout.amount);
    }

    const referredCustomers = invitedUsers.map((invited) => {
        const totals = byReferred.get(invited._id.toString());
        return {
            ...safeUserSummary(invited),
            invitedAt: invited.referredAt || invited.createdAt || null,
            expiresAt: invited.referralEligibleUntil || null,
            addedAmount: toMoneyString(totals?.addedAmount || 0),
            earnings: toMoneyString(totals?.earnings || 0),
            currency: walletCurrency,
        };
    });

    return {
        referralCode: user?.referralCode || null,
        referralLinkPath: user?.referralCode ? `/auth?mode=signup&ref=${encodeURIComponent(user.referralCode)}` : null,
        walletCurrency,
        referralCount: invitedUsers.length,
        invitedUsers: referredCustomers,
        referredCustomers,
        commissionSummary: serializeGroups(commissionGroups),
        payoutSummary: serializeGroups(payoutGroups),
        availableEarnings: Object.fromEntries(Object.entries(commissionGroups).map(([currency, row]) => [currency, toMoneyString(row.available)])),
        lockedEarnings: Object.fromEntries(Object.entries(commissionGroups).map(([currency, row]) => [currency, toMoneyString(row.locked)])),
        paidEarnings: Object.fromEntries(Object.entries(commissionGroups).map(([currency, row]) => [currency, toMoneyString(row.paid)])),
        displayCurrency: walletCurrency,
        displayAvailableEarnings: pickCurrencyAmount(commissionGroups, walletCurrency, 'available'),
        resellerStatus: user?.resellerStatus || 'NONE',
        resellerApprovedAt: user?.resellerApprovedAt || null,
        referralCommissionStoppedAt: user?.referralCommissionStoppedAt || null,
        currentGroup: user?.groupId ? {
            id: user.groupId._id?.toString?.() || user.groupId.id,
            name: user.groupId.name,
            percentage: user.groupId.percentage,
            billingMode: user.groupId.billingMode,
            isActive: user.groupId.isActive,
        } : null,
    };
};

const listAdminReferralAgents = async ({ search = '', page = 1, limit = 20 } = {}) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const query = { deletedAt: null };
    const term = String(search || '').trim();
    if (term) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.$or = [
            { name: { $regex: escaped, $options: 'i' } },
            { email: { $regex: escaped, $options: 'i' } },
            { referralCode: { $regex: escaped, $options: 'i' } },
        ];
    }

    const [users, total, defaultPercent] = await Promise.all([
        User.find(query)
            .select('name email phone avatar referralCode currency referralCommissionPercentOverride resellerStatus resellerApprovedAt referralCommissionStoppedAt groupId createdAt')
            .populate('groupId', 'name percentage billingMode isActive')
            .sort({ createdAt: -1, _id: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit)
            .lean(),
        User.countDocuments(query),
        resolveDefaultCommissionPercent(),
    ]);

    const userIds = users.map((user) => user._id);
    const [invitedUsers, commissions, payouts] = await Promise.all([
        User.find({ referredBy: { $in: userIds }, deletedAt: null })
            .select('name email avatar currency status createdAt referredAt referralEligibleUntil referredBy')
            .sort({ referredAt: -1, createdAt: -1 })
            .lean(),
        ReferralCommission.find({ referrerUserId: { $in: userIds } })
            .select('referrerUserId referredUserId status referrerCurrency commissionAmountReferrerCurrency originalAmount originalCurrency sourceCompletedAt commissionPercentSnapshot createdAt')
            .lean(),
        ReferralPayout.find({ userId: { $in: userIds } })
            .select('userId status method methodAlias withdrawalMethod currency amount createdAt paidAt reviewedAt rejectionReason')
            .sort({ createdAt: -1 })
            .lean(),
    ]);

    const invitedByReferrer = new Map();
    for (const invited of invitedUsers) {
        const key = invited.referredBy?.toString?.() || String(invited.referredBy || '');
        if (!invitedByReferrer.has(key)) invitedByReferrer.set(key, []);
        invitedByReferrer.get(key).push(invited);
    }

    const commissionByReferrer = new Map();
    const commissionByReferred = new Map();
    for (const commission of commissions) {
        const referrerKey = commission.referrerUserId?.toString?.() || String(commission.referrerUserId || '');
        const referredKey = commission.referredUserId?.toString?.() || String(commission.referredUserId || '');
        if (!commissionByReferrer.has(referrerKey)) commissionByReferrer.set(referrerKey, {});
        addGroupedAmount(
            commissionByReferrer.get(referrerKey),
            commission.referrerCurrency,
            commissionStatusField(commission.status),
            commission.commissionAmountReferrerCurrency
        );
        const current = commissionByReferred.get(referredKey) || {};
        addGroupedAmount(current, commission.referrerCurrency, commissionStatusField(commission.status), commission.commissionAmountReferrerCurrency);
        commissionByReferred.set(referredKey, current);
    }

    const payoutByUser = new Map();
    for (const payout of payouts) {
        const key = payout.userId?.toString?.() || String(payout.userId || '');
        if (!payoutByUser.has(key)) payoutByUser.set(key, []);
        payoutByUser.get(key).push(payout);
    }

    const agents = users.map((user) => {
        const id = user._id.toString();
        const currency = normalizeCurrencyCode(user.currency);
        const grouped = commissionByReferrer.get(id) || {};
        const referrals = (invitedByReferrer.get(id) || []).slice(0, 100).map((invited) => {
            const referredGroups = commissionByReferred.get(invited._id.toString()) || {};
            return {
                ...safeUserSummary(invited),
                invitedAt: invited.referredAt || invited.createdAt || null,
                expiresAt: invited.referralEligibleUntil || null,
                addedAmount: '0.000000',
                earnings: pickCurrencyAmount(referredGroups, currency, 'total'),
                currency,
            };
        });
        const withdrawals = (payoutByUser.get(id) || []).map((payout) => ({
            id: payout._id?.toString?.() || payout.id,
            method: payout.methodAlias || payout.withdrawalMethod || payout.method,
            amount: payout.amount,
            currency: payout.currency,
            status: payout.status === REFERRAL_PAYOUT_STATUS.PAID ? 'completed' : payout.status === REFERRAL_PAYOUT_STATUS.REJECTED ? 'failed' : 'processing',
            statusCode: payout.status,
            createdAt: payout.createdAt || null,
            completedAt: payout.paidAt || null,
            reviewedAt: payout.reviewedAt || null,
            rejectionReason: payout.rejectionReason || null,
        }));

        return {
            ...safeUserSummary(user),
            code: user.referralCode || null,
            referralCode: user.referralCode || null,
            referrals,
            referralCount: referrals.length,
            commissionSummary: serializeGroups(grouped),
            earnings: pickCurrencyAmount(grouped, currency, 'total'),
            availableEarnings: pickCurrencyAmount(grouped, currency, 'available'),
            lockedEarnings: pickCurrencyAmount(grouped, currency, 'locked'),
            paidEarnings: pickCurrencyAmount(grouped, currency, 'paid'),
            withdrawn: withdrawals
                .filter((payout) => payout.status === 'completed' && normalizeCurrencyCode(payout.currency) === currency)
                .reduce((sum, payout) => sum.plus(toDecimal(payout.amount)), new Decimal(0))
                .toNumber(),
            withdrawals,
            currentCommissionPercent: user.referralCommissionPercentOverride ?? defaultPercent.toNumber(),
            referralCommissionPercentOverride: user.referralCommissionPercentOverride ?? null,
            defaultCommissionPercent: defaultPercent.toNumber(),
            resellerStatus: user.resellerStatus || 'NONE',
            resellerApprovedAt: user.resellerApprovedAt || null,
            referralCommissionStoppedAt: user.referralCommissionStoppedAt || null,
            group: user.groupId ? {
                id: user.groupId._id?.toString?.() || user.groupId.id,
                name: user.groupId.name,
                percentage: user.groupId.percentage,
                billingMode: user.groupId.billingMode,
                isActive: user.groupId.isActive,
            } : null,
        };
    }).filter((agent) =>
        agent.referralCode
        || agent.referrals.length
        || toDecimal(agent.earnings).greaterThan(0)
        || agent.withdrawals.length
        || agent.referralCommissionPercentOverride !== null
        || agent.resellerStatus === 'APPROVED'
    );

    return {
        agents,
        defaultCommissionPercent: defaultPercent.toNumber(),
        settingKey: REFERRAL_COMMISSION_SETTING_KEY,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit),
        },
    };
};

module.exports = {
    REFERRAL_PAYOUT_METHODS_SETTING_KEY,
    DEFAULT_REFERRAL_PAYOUT_METHODS,
    getReferralPayoutMethods,
    getCustomerReferralDashboard,
    listAdminReferralAgents,
};
