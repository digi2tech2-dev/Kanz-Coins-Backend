'use strict';

const { AppError } = require('../../shared/errors/AppError');
const { User, USER_STATUS } = require('../users/user.model');
const {
    generateReferralCode,
    normalizeReferralCode,
    isDuplicateReferralCodeError,
} = require('../../shared/utils/referralCode');

const MAX_REFERRAL_CODE_RETRIES = 8;
const REFERRAL_ELIGIBILITY_DAYS = 30;

const missingReferralCodeFilter = {
    $or: [
        { referralCode: { $exists: false } },
        { referralCode: null },
        { referralCode: '' },
    ],
};

const createReferralError = (message, code, statusCode = 400) =>
    new AppError(message, statusCode, code);

const normalizeIncomingReferralCode = (...values) => {
    for (const value of values) {
        const normalized = normalizeReferralCode(value);
        if (normalized) return normalized;
    }
    return '';
};

const findReferralOwnerByCode = async (rawCode) => {
    const referralCode = normalizeReferralCode(rawCode);
    if (!referralCode) {
        throw createReferralError('Invitation code is invalid.', 'REFERRAL_CODE_INVALID');
    }

    const owner = await User.findOne({
        referralCode,
        deletedAt: null,
    });

    if (!owner) {
        throw createReferralError('Invitation code is invalid.', 'REFERRAL_CODE_INVALID');
    }

    if (owner.status !== USER_STATUS.ACTIVE) {
        throw createReferralError('Invitation code owner is not active.', 'REFERRAL_OWNER_INACTIVE');
    }

    return owner;
};

const resolveReferralOwnerForNewUser = async (rawCode, newUserEmail) => {
    const referralCode = normalizeReferralCode(rawCode);
    if (!referralCode) return null;

    const owner = await findReferralOwnerByCode(referralCode);
    const ownerEmail = String(owner.email || '').trim().toLowerCase();
    const nextEmail = String(newUserEmail || '').trim().toLowerCase();

    if (ownerEmail && nextEmail && ownerEmail === nextEmail) {
        throw createReferralError('You cannot use your own invitation code.', 'SELF_REFERRAL_NOT_ALLOWED');
    }

    return owner;
};

const buildReferralAssignment = (owner) => {
    if (!owner) return {};
    const referredAt = new Date();
    return {
        referredBy: owner._id,
        referredAt,
        referralEligibleUntil: calculateReferralEligibleUntil(referredAt),
    };
};

const calculateReferralEligibleUntil = (referredAt) => {
    const start = referredAt instanceof Date ? referredAt : new Date(referredAt);
    if (Number.isNaN(start.getTime())) return null;
    return new Date(start.getTime() + REFERRAL_ELIGIBILITY_DAYS * 24 * 60 * 60 * 1000);
};

const createUserWithReferralCodeRetry = async (payload, options = {}) => {
    const maxRetries = options.maxRetries || MAX_REFERRAL_CODE_RETRIES;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const referralCode = payload.referralCode || generateReferralCode();
        try {
            return await User.create({
                ...payload,
                referralCode,
            });
        } catch (err) {
            if (!isDuplicateReferralCodeError(err) || payload.referralCode) {
                throw err;
            }
            lastError = err;
        }
    }

    throw lastError || createReferralError('Unable to generate a unique invitation code.', 'REFERRAL_CODE_GENERATION_FAILED', 500);
};

const assignReferralCodeIfMissing = async (userId, options = {}) => {
    const maxRetries = options.maxRetries || MAX_REFERRAL_CODE_RETRIES;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const referralCode = generateReferralCode();
        try {
            const result = await User.collection.updateOne(
                {
                    _id: userId,
                    ...missingReferralCodeFilter,
                },
                { $set: { referralCode } }
            );
            return {
                updated: result.modifiedCount === 1,
                referralCode: result.modifiedCount === 1 ? referralCode : null,
            };
        } catch (err) {
            if (!isDuplicateReferralCodeError(err)) {
                throw err;
            }
            lastError = err;
        }
    }

    throw lastError || createReferralError('Unable to generate a unique invitation code.', 'REFERRAL_CODE_GENERATION_FAILED', 500);
};

module.exports = {
    MAX_REFERRAL_CODE_RETRIES,
    REFERRAL_ELIGIBILITY_DAYS,
    missingReferralCodeFilter,
    calculateReferralEligibleUntil,
    normalizeIncomingReferralCode,
    findReferralOwnerByCode,
    resolveReferralOwnerForNewUser,
    buildReferralAssignment,
    createUserWithReferralCodeRetry,
    assignReferralCodeIfMissing,
};
