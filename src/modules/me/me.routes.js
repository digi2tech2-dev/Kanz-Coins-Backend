'use strict';

/**
 * me.routes.js — User Panel API
 *
 * All routes require:
 *  1. authenticate  — valid JWT
 *  2. requireActiveUser — account status === ACTIVE (admin-approved)
 *
 * Route map:
 *
 *  GET  /api/me                        Profile + wallet balance
 *  GET  /api/me/wallet                 Wallet summary + 5 recent txns
 *  GET  /api/me/wallet/transactions    Paginated transaction history
 *
 *  GET  /api/me/products               Active product catalogue (search, page, limit)
 *  GET  /api/me/products/:id           Single product detail
 *
 *  POST /api/me/orders                 Place a new order
 *  GET  /api/me/orders                 My orders (status, date, page, limit)
 *  GET  /api/me/orders/:id             My order detail (ownership enforced)
 *
 *  POST /api/me/deposits               Submit deposit request (multipart: receipt)
 *  GET  /api/me/deposits               My deposit history
 *  GET  /api/me/deposits/:id           My deposit detail (ownership enforced)
 */

const { Router } = require('express');
const me = require('./me.controller');
const depositController = require('../deposits/deposit.controller');
const referralCommissionService = require('../referrals/referralCommission.service');
const referralDashboardService = require('../referrals/referralDashboard.service');
const referralPayoutController = require('../referralPayouts/referralPayout.controller');
const referralPayoutService = require('../referralPayouts/referralPayout.service');
const subAgentRequestController = require('../subAgentRequests/subAgentRequest.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const { createUpload } = require('../../shared/middlewares/upload');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const { body, param, query } = require('express-validator');
const validate = require('../../shared/middlewares/validate');

const depositUpload = createUpload('deposits');
const orderFieldUpload = createUpload('order-fields');
const subAgentProofUpload = createUpload('sub-agent-proofs');

const router = Router();

// ── Global guards ─────────────────────────────────────────────────────────────
router.use(authenticate, requireActiveUser);

// ─── Profile ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/me
 * @desc   Authenticated user's own profile
 * @access Active user
 */
router.get('/', me.getProfile);

router.post('/api-token/generate', me.generateApiToken);

router.put(
    '/api-settings',
    [
        body('whitelistIps')
            .optional()
            .isArray().withMessage('whitelistIps must be an array'),
        body('whitelistIps.*')
            .optional()
            .isString().trim()
            .isLength({ min: 1, max: 64 }).withMessage('Each whitelist IP must be 1-64 characters'),
        body('webhookUrl')
            .optional({ nullable: true })
            .isString().trim()
            .isLength({ max: 500 }).withMessage('webhookUrl cannot exceed 500 characters')
            .custom((value) => !value || /^https?:\/\//.test(value))
            .withMessage('webhookUrl must start with http:// or https://'),
    ],
    validate,
    me.updateApiSettings
);

// ─── Wallet ───────────────────────────────────────────────────────────────────

router.get('/wallet', me.getWallet);
router.get('/wallet/transactions', me.getTransactions);

router.get('/referrals/dashboard', catchAsync(async (req, res) => {
    const dashboard = await referralDashboardService.getCustomerReferralDashboard(req.user._id, {
        limit: req.query.limit,
    });
    sendSuccess(res, { dashboard }, 'Referral dashboard retrieved');
}));

router.get('/referral-payout-methods', catchAsync(async (_req, res) => {
    const methods = await referralDashboardService.getReferralPayoutMethods({ activeOnly: true });
    sendSuccess(res, { methods }, 'Referral payout methods retrieved');
}));

router.get('/referral-commissions', catchAsync(async (req, res) => {
    const result = await referralCommissionService.listReferralCommissionsForReferrer(req.user._id, {
        page: req.query.page,
        limit: req.query.limit,
        status: req.query.status,
        currency: req.query.currency,
    });
    sendPaginated(res, result.commissions, result.pagination, 'Referral commissions retrieved');
}));

router.get('/referral-commissions/summary', catchAsync(async (req, res) => {
    const [summary, grouped] = await Promise.all([
        referralCommissionService.getReferralCommissionSummaryForReferrer(req.user._id),
        referralPayoutService.buildSummaryGroups(req.user._id),
    ]);
    sendSuccess(res, { summary, ...grouped }, 'Referral commission summary retrieved');
}));

router.post('/referral-payouts', catchAsync(referralPayoutController.createMyPayout));
router.get(
    '/referral-payouts',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('status').optional().isString().trim(),
        query('method').optional().isString().trim(),
        query('currency').optional().isString().trim().isLength({ min: 3, max: 3 }),
    ],
    validate,
    catchAsync(referralPayoutController.listMyPayouts)
);
router.get(
    '/referral-payouts/:id',
    [param('id').isMongoId().withMessage('Invalid payout ID')],
    validate,
    catchAsync(referralPayoutController.getMyPayout)
);

const uploadSubAgentProof = (req, res, next) => {
    subAgentProofUpload.single('proofImage')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new BusinessRuleError('Sub-agent proof file is too large.', 'SUB_AGENT_PROOF_INVALID'));
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return next(new BusinessRuleError('Unexpected sub-agent proof field.', 'SUB_AGENT_PROOF_INVALID'));
        }
        return next(err);
    });
};

router.post(
    '/sub-agent-requests',
    uploadSubAgentProof,
    subAgentRequestController.createMyRequest
);

router.get('/sub-agent-requests/current', subAgentRequestController.getMyCurrentRequest);
router.get(
    '/sub-agent-requests',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validate,
    subAgentRequestController.listMyRequests
);

router.post(
    '/upload/order-field-image',
    orderFieldUpload.single('image'),
    me.uploadOrderFieldImage
);

// ─── Products (read-only catalogue) ──────────────────────────────────────────

router.get(
    '/products',
    [
        query('search').optional().isString().trim(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validate,
    me.getProducts
);

router.get(
    '/products/:id',
    [param('id').isMongoId().withMessage('Invalid product ID')],
    validate,
    me.getProduct
);

// ─── Orders ───────────────────────────────────────────────────────────────────

const createOrderValidation = [
    body('productId')
        .notEmpty().withMessage('productId is required')
        .isMongoId().withMessage('productId must be a valid Mongo ID'),
    body('quantity')
        .optional()
        .isInt({ min: 1 }).withMessage('quantity must be a positive integer'),
];

router.post('/orders', createOrderValidation, validate, me.placeOrder);
router.get('/orders', me.getOrders);
router.get(
    '/orders/:id',
    [param('id').isMongoId().withMessage('Invalid order ID')],
    validate,
    me.getOrder
);

// ─── Deposits ─────────────────────────────────────────────────────────────────

const createDepositValidation = [
    body('requestedAmount')
        .notEmpty().withMessage('requestedAmount is required')
        .isFloat({ gt: 0 }).withMessage('requestedAmount must be a positive number'),
    body('currency')
        .notEmpty().withMessage('currency is required')
        .isString().trim()
        .isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter ISO 4217 code')
        .toUpperCase(),
    body('paymentMethodId')
        .notEmpty().withMessage('paymentMethodId is required')
        .isString().trim(),
    body('notes')
        .optional()
        .isString().trim()
        .isLength({ max: 500 }).withMessage('notes cannot exceed 500 characters'),
    body('senderDetails')
        .optional()
        .custom((value) => typeof value === 'string' || (value && typeof value === 'object'))
        .withMessage('senderDetails must be an object or JSON string'),
    body('senderWalletNumber')
        .optional()
        .isString().trim()
        .isLength({ max: 200 }).withMessage('senderWalletNumber cannot exceed 200 characters'),
    body('senderWalletAddress')
        .optional()
        .isString().trim()
        .isLength({ max: 200 }).withMessage('senderWalletAddress cannot exceed 200 characters'),
    body('transferredFromNumber')
        .optional()
        .isString().trim()
        .isLength({ max: 200 }).withMessage('transferredFromNumber cannot exceed 200 characters'),
    body('transactionId')
        .optional()
        .isString().trim()
        .isLength({ max: 64 }).withMessage('transactionId cannot exceed 64 characters'),
    body('transactionNumber')
        .optional()
        .isString().trim()
        .isLength({ max: 64 }).withMessage('transactionNumber cannot exceed 64 characters'),
    body('paymentReference')
        .optional()
        .isString().trim()
        .isLength({ max: 64 }).withMessage('paymentReference cannot exceed 64 characters'),
];

/**
 * @route  POST /api/me/deposits
 * @desc   Submit a deposit request with receipt upload (multi-currency)
 * @access Active user
 * @body   multipart/form-data: requestedAmount, currency, paymentMethodId, receipt (file), notes?
 */
router.post(
    '/deposits',
    depositUpload.single('receipt'),
    depositController.analyzeReceiptUpload,
    createDepositValidation,
    validate,
    me.createDeposit
);

router.get('/deposits', me.getDeposits);
router.get(
    '/deposits/:id',
    [param('id').isMongoId().withMessage('Invalid deposit ID')],
    validate,
    me.getDeposit
);

module.exports = router;
