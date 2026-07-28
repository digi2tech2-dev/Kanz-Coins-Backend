'use strict';

const userService = require('./user.service');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

// ── Customer ──────────────────────────────────────────────────────────────────

const getMyProfile = catchAsync(async (req, res) => {
    const user = await userService.getMyProfile(req.user._id);
    sendSuccess(res, user, 'Profile retrieved successfully.');
});

const updateMyProfile = catchAsync(async (req, res) => {
    const { name, email, phone, username, password, country, currency, referralCode, refCode, ref, inviteCode } = req.body;
    const user = await userService.updateMyProfile(req.user._id, {
        name,
        email,
        phone,
        username,
        password,
        country,
        currency,
        referralCode,
        refCode,
        ref,
        inviteCode,
    });
    sendSuccess(res, user, 'Profile updated successfully.');
});

const updateMyAvatar = catchAsync(async (req, res) => {
    const relativePath = req.file ? `/uploads/avatars/${req.file.filename}` : null;
    const user = await userService.updateMyAvatar(req.user._id, relativePath);
    sendSuccess(res, user, 'Avatar updated successfully.');
});

// ── Admin: Queries ────────────────────────────────────────────────────────────

const listUsers = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { role, status, groupId } = req.query;

    const result = await userService.listUsers({ page, limit, role, status, groupId });
    sendPaginated(res, result.users, result.pagination, 'Users retrieved successfully.');
});

const getUser = catchAsync(async (req, res) => {
    const user = await userService.getUserById(req.params.id);
    sendSuccess(res, user);
});

// ── Admin: General Update ─────────────────────────────────────────────────────

const updateUser = catchAsync(async (req, res) => {
    const { name, groupId, creditLimit, quantityLimit } = req.body;
    const user = await userService.updateUser(req.params.id, { name, groupId, creditLimit, quantityLimit });
    sendSuccess(res, user, 'User updated successfully.');
});

// ── Admin: Activation Lifecycle ───────────────────────────────────────────────

/**
 * PATCH /api/users/:id/approve
 * Approve a PENDING or REJECTED user → ACTIVE.
 */
const approveUser = catchAsync(async (req, res) => {
    const user = await userService.approveUser(req.params.id, req.user._id);
    sendSuccess(res, user, 'User account approved and activated.');
});

/**
 * PATCH /api/users/:id/reject
 * Reject a PENDING or ACTIVE user → REJECTED.
 */
const rejectUser = catchAsync(async (req, res) => {
    const user = await userService.rejectUser(req.params.id, req.user._id);
    sendSuccess(res, user, 'User account rejected.');
});

// ── Admin: Quantity-Only Billing ─────────────────────────────────────────────

/**
 * POST /api/users/:id/reset-quantity
 * Reset quantityUsed to 0 after offline settlement.
 */
const resetQuantity = catchAsync(async (req, res) => {
    const user = await userService.resetQuantityUsed(req.params.id);
    sendSuccess(res, user, 'Quantity usage reset successfully.');
});

/**
 * PATCH /api/users/:id/quantity-limit
 * Update the quantityLimit for a user.
 */
const updateQuantityLimit = catchAsync(async (req, res) => {
    const quantityLimit = parseFloat(req.body.quantityLimit);
    const user = await userService.updateQuantityLimit(req.params.id, quantityLimit);
    sendSuccess(res, user, 'Quantity limit updated successfully.');
});

module.exports = {
    getMyProfile,
    updateMyProfile,
    updateMyAvatar,
    listUsers,
    getUser,
    updateUser,
    approveUser,
    rejectUser,
    resetQuantity,
    updateQuantityLimit,
};
