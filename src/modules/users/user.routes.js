'use strict';

const { Router } = require('express');
const userController = require('./user.controller');
const { updateUserValidation, updateMyProfileValidation } = require('./user.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const { createUpload } = require('../../shared/middlewares/upload');

const avatarUpload = createUpload('avatars');

const router = Router();

// All user routes require authentication
router.use(authenticate);

// ── Customer: Self-service ────────────────────────────────────────────────────

/**
 * @route  GET /api/users/me
 * @desc   Get authenticated user's own profile
 * @access Any authenticated user
 */
router.get('/me', userController.getMyProfile);

/**
 * @route  PATCH /api/users/me
 * @desc   Update own profile (name, email, phone, username, password)
 * @access Any authenticated user
 */
router.patch('/me', updateMyProfileValidation, validate, userController.updateMyProfile);

/**
 * @route  PATCH /api/users/me/avatar
 * @desc   Update own avatar
 * @access Any authenticated user
 */
router.patch('/me/avatar', avatarUpload.single('avatar'), userController.updateMyAvatar);

// ── Admin: Queries ────────────────────────────────────────────────────────────

/**
 * @route  GET /api/users
 * @desc   List all users. Supports ?status=PENDING|ACTIVE|REJECTED
 * @access Admin
 */
router.get('/', authorize('ADMIN', 'SUPERVISOR'), requirePermission('VIEW_USERS'), userController.listUsers);

/**
 * @route  GET /api/users/:id
 * @desc   Get user by ID
 * @access Admin
 */
router.get('/:id', authorize('ADMIN', 'SUPERVISOR'), requirePermission('VIEW_USERS'), userController.getUser);

// ── Admin: General Update ─────────────────────────────────────────────────────

/**
 * @route  PATCH /api/users/:id
 * @desc   Update user (group, credit limit, name)
 * @access Admin
 * @note   Activation lifecycle is handled via /approve and /reject endpoints
 */
router.patch('/:id', authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_USERS'), updateUserValidation, validate, userController.updateUser);

// ── Admin: Activation Lifecycle ───────────────────────────────────────────────

/**
 * @route  PATCH /api/users/:id/approve
 * @desc   Approve account (PENDING or REJECTED → ACTIVE)
 * @access Admin
 */
router.patch('/:id/approve', authorize('ADMIN', 'SUPERVISOR'), requirePermission('CONFIRM_ACCOUNTS'), userController.approveUser);

/**
 * @route  PATCH /api/users/:id/reject
 * @desc   Reject account (PENDING or ACTIVE → REJECTED)
 * @access Admin
 */
router.patch('/:id/reject', authorize('ADMIN', 'SUPERVISOR'), requirePermission('CONFIRM_ACCOUNTS'), userController.rejectUser);

// ── Admin: Quantity-Only Billing ─────────────────────────────────────────────

/**
 * @route  POST /api/users/:id/reset-quantity
 * @desc   Reset quantityUsed to 0 after offline settlement
 * @access Admin
 */
router.post('/:id/reset-quantity', authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_USERS'), userController.resetQuantity);

/**
 * @route  PATCH /api/users/:id/quantity-limit
 * @desc   Update quantityLimit for a user
 * @access Admin
 */
router.patch('/:id/quantity-limit', authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_USERS'), userController.updateQuantityLimit);

module.exports = router;
