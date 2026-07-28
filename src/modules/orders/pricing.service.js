'use strict';

/**
 * pricing.service.js — Pure Pricing Engine (Arbitrary Precision)
 * ──────────────────────────────────────────────────────────────
 * All functions here are pure where possible (no side effects, no DB).
 * calculateUserPrice is the only one that touches the DB.
 *
 * Single source of truth for markup math — used by order.service.js
 * at order creation time to produce the price snapshots burned into
 * each Order document.
 *
 * Prices are STRING throughout (up to 50 dp). Only chargedAmount is
 * a 2 dp Number because wallet balances are standard fiat.
 */

const { User } = require('../users/user.model');
const Group = require('../groups/group.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { toDecimal, toStr, isPositive, add } = require('../../shared/utils/decimalPrecision');

// ─────────────────────────────────────────────────────────────────────────────
// PURE CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the final price after applying a group markup percentage.
 *
 * Rules:
 *  - basePrice must be >= 0 (string or number)
 *  - percentage must be >= 0
 *  - finalPrice = basePrice + (basePrice × percentage / 100)
 *
 * @param {string|number} basePrice   - Raw product price (>= 0)
 * @param {number}        percentage  - Group markup percentage (>= 0)
 * @returns {string} finalPrice as an arbitrary-precision string
 * @throws {BusinessRuleError} if inputs are invalid
 */
const calculateFinalPrice = (basePrice, percentage) => {
    if (basePrice === null || basePrice === undefined || String(basePrice).trim() === '') {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }
    if (!Number.isFinite(Number(basePrice))) {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }
    const base = toDecimal(basePrice);
    if (base.isNegative()) {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }
    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct < 0) {
        throw new BusinessRuleError(
            'percentage must be a non-negative number.',
            'INVALID_PERCENTAGE'
        );
    }

    // basePrice + basePrice * (percentage / 100), without native float drift.
    const markup = toStr(base.times(toDecimal(percentage).dividedBy(100)));
    return add(basePrice, markup);
};

// ─────────────────────────────────────────────────────────────────────────────
// DB-BACKED CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the effective price for a specific user by looking up their
 * group's markup percentage, then applying calculateFinalPrice.
 *
 * @param {string|ObjectId} userId    - The buying user's ID
 * @param {string|number}   basePrice - Product's base price
 * @param {Object}          [session] - Optional Mongoose session (for transactions)
 * @returns {Promise<{
 *   basePrice:        string,
 *   markupPercentage: number,
 *   finalPrice:       string,
 *   groupId:          ObjectId
 * }>}
 */
const calculateUserPrice = async (userId, basePrice, session = null) => {
    // Load user with groupId populated so we get percentage in one round-trip
    const query = User.findById(userId).populate('groupId', 'name percentage isActive');
    if (session) query.session(session);
    const user = await query;

    if (!user) throw new NotFoundError('User');

    if (!user.groupId) {
        throw new BusinessRuleError(
            'User is not assigned to any pricing group. Contact an administrator.',
            'NO_GROUP_ASSIGNED'
        );
    }

    const group = user.groupId; // already populated

    if (!group.isActive) {
        throw new BusinessRuleError(
            `User's pricing group '${group.name}' is inactive. Contact an administrator.`,
            'GROUP_INACTIVE'
        );
    }

    // percentage stays as Number — it's a simple integer (e.g. 20 = 20%)
    const markupPercentage = Number.isFinite(Number(group.percentage))
        ? Number(group.percentage)
        : 0;

    // basePrice is a string — ensure it's valid
    const safeBasePrice = isPositive(basePrice) ? String(basePrice) : '0';

    const finalPrice = calculateFinalPrice(safeBasePrice, markupPercentage);

    return {
        basePrice: safeBasePrice,
        markupPercentage,
        finalPrice,
        groupId: group._id,
    };
};

module.exports = { calculateFinalPrice, calculateUserPrice };
