'use strict';

/**
 * admin.routes.js — Master Admin Router
 *
 * All routes require:
 *   1. authenticate  — valid JWT
 *   2. authorize('ADMIN') — ADMIN role only
 *
 * Route Map:
 * DEPOSITS
 *   GET    /admin/deposits                    — list + filter (status, page, limit)
 *   GET    /admin/deposits/:id                — get one
 *   PATCH  /admin/deposits/:id/approve        — approve + credit wallet
 *   PATCH  /admin/deposits/:id/reject         — reject
 *
 * USERS
 *   GET    /admin/users                     — list + filter + paginate
 *   GET    /admin/users/:id                 — get one
 *   PATCH  /admin/users/:id                 — update
 *   DELETE /admin/users/:id                 — soft delete
 *   PATCH  /admin/users/:id/approve         — approve
 *   PATCH  /admin/users/:id/reject          — reject
 *   POST   /admin/users/adjust-debt          — bulk debt adjustment for currency devaluation
 *
 * PROVIDERS
 *   GET    /admin/providers                  — list
 *   GET    /admin/providers/:id              — get one
 *   POST   /admin/providers                  — create
 *   PATCH  /admin/providers/:id              — update
 *   DELETE /admin/providers/:id              — soft delete
 *   PATCH  /admin/providers/:id/toggle       — toggle active
 *   GET    /admin/providers/:id/balance      — live provider balance
 *   GET    /admin/providers/:id/products     — live provider product list
 *
 * ORDERS
 *   GET    /admin/orders                     — list + filter + paginate
 *   GET    /admin/orders/:id                 — get one
 *   POST   /admin/orders/:id/retry           — retry failed order
 *   POST   /admin/orders/:id/refund          — manual refund
 *
 * WALLETS
 *   GET    /admin/wallets                    — list all user wallets
 *   GET    /admin/wallets/:userId            — single user wallet
 *   GET    /admin/wallets/:userId/transactions — tx history
 *   POST   /admin/wallets/:userId/add        — add funds
 *   POST   /admin/wallets/:userId/deduct     — deduct funds
 *
 * CURRENCIES  (existing, re-mounted here for cohesion)
 *   GET    /admin/currencies                 — list
 *   PATCH  /admin/currencies/:code          — update platformRate
 *
 * GROUPS  (existing, already mounted separately — proxied here too)
 *   GET    /admin/groups                     — list
 *   POST   /admin/groups                     — create
 *   PATCH  /admin/groups/:id                 — update
 *   DELETE /admin/groups/:id                 — deactivate
 *
 * SETTINGS
 *   GET    /admin/settings                   — list all
 *   GET    /admin/settings/:key              — get one
 *   PATCH  /admin/settings/:key              — update value
 *
 * AUDIT LOGS
 *   GET    /admin/audit                      — get entity audit logs
 *   GET    /admin/audit/actor/:actorId       — get actor audit logs
 * DEPOSITS
 *   GET    /admin/deposits                    — list + filter (status, page, limit)
 *   GET    /admin/deposits/:id                — get one
 *   PATCH  /admin/deposits/:id/approve        — approve + credit wallet
 *   PATCH  /admin/deposits/:id/reject         — reject
 *
 * TARGETS
 *   GET    /admin/targets                     — list + filter (status, page, limit)
 *   PATCH  /admin/targets/:id/approve         — approve a pending target order
 *   PATCH  /admin/targets/:id/reject          — reject a pending target order
 *
 */

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const { createUpload } = require('../../shared/middlewares/upload');
const { walletLimiter } = require('../../shared/middlewares/rateLimiter');
const { BusinessRuleError } = require('../../shared/errors/AppError');

const { validateBody, validateQuery, schemas } = require('./admin.validation');

const avatarUpload = createUpload('avatars');
const targetAppUpload = createUpload('target-apps');
const referralPayoutReceiptUpload = createUpload('referral-payout-receipts');

// ── Controllers ───────────────────────────────────────────────────────────────
const usersCtrl = require('./admin.users.controller');
const providersCtrl = require('./admin.providers.controller');
const ordersCtrl = require('./admin.orders.controller');
const walletCtrl = require('./admin.wallet.controller');
const settingsCtrl = require('./admin.settings.controller');
const statsCtrl = require('./admin.stats.controller');
const categoriesCtrl = require('../categories/category.controller');
const categoryValidation = require('../categories/category.validation');

// ── Existing services reused directly ─────────────────────────────────────────
const groupSvc = require('../groups/group.service');
const { Currency } = require('../currency/currency.model');
const { getEntityAuditLogs, getActorAuditLogs } = require('../audit/audit.service');
const depositSvc = require('../deposits/deposit.service');
const referralCommissionSvc = require('../referrals/referralCommission.service');
const referralDashboardSvc = require('../referrals/referralDashboard.service');
const referralPayoutCtrl = require('../referralPayouts/referralPayout.controller');
const referralPayoutSvc = require('../referralPayouts/referralPayout.service');
const subAgentRequestCtrl = require('../subAgentRequests/subAgentRequest.controller');
const targetSvc = require('../targets/target.service');
const targetValidation = require('../targets/target.validation');
const notifSvc = require('../notifications/notification.service');
const notifValidation = require('../notifications/notification.validation');

const router = Router();
const adminOnly = authorize('ADMIN');

// ─── Auth guard — applied to every route in this router ──────────────────────
router.use(authenticate);
router.use(authorize('ADMIN', 'SUPERVISOR'));

const attachTargetAppImage = (req, _res, next) => {
    if (req.file) {
        req.body.image = `uploads/target-apps/${req.file.filename}`;
    }
    next();
};

const uploadReferralPayoutReceipt = (req, res, next) => {
    referralPayoutReceiptUpload.fields([
        { name: 'receiptImage', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
        { name: 'paymentProof', maxCount: 1 },
    ])(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new BusinessRuleError('Referral payout receipt file is too large.', 'PAYOUT_RECEIPT_INVALID'));
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return next(new BusinessRuleError('Unexpected referral payout receipt field.', 'PAYOUT_RECEIPT_INVALID'));
        }
        return next(err);
    });
};

const pickReferralPayoutReceiptFile = (req) => {
    const files = req.files || {};
    return files.receiptImage?.[0] || files.receipt?.[0] || files.paymentProof?.[0] || null;
};

const validateReferralPayoutPaidBody = (req, res, next) => {
    validateBody(schemas.markReferralPayoutPaid)(req, res, async (err) => {
        if (err) {
            await referralPayoutSvc.cleanupReceiptFile(pickReferralPayoutReceiptFile(req));
            return next(err);
        }
        return next();
    });
};

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard/stats', statsCtrl.getDashboardStats);
router.get('/stats', statsCtrl.getDashboardStats);

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/users', requirePermission('VIEW_USERS'), validateQuery(schemas.listUsersQuery), usersCtrl.listUsers);
router.get('/users/deleted', requirePermission('VIEW_USERS'), usersCtrl.listDeletedUsers); // MUST be before /:id
router.post('/users/adjust-debt', adminOnly, walletLimiter, validateBody(schemas.debtAdjustment), walletCtrl.adjustDebt);
router.get('/users/:id', requirePermission('VIEW_USERS'), usersCtrl.getUserById);
router.patch('/users/:id', requirePermission('MANAGE_USERS'), validateBody(schemas.updateUser), usersCtrl.updateUser);
router.delete('/users/:id', requirePermission('MANAGE_USERS'), usersCtrl.deleteUser);
// approve / reject / restore — specific actions must come BEFORE /:id pattern
router.patch('/users/:id/approve', requirePermission('CONFIRM_ACCOUNTS'), usersCtrl.approveUser);
router.patch('/users/:id/reject', requirePermission('CONFIRM_ACCOUNTS'), usersCtrl.rejectUser);
router.patch('/users/:id/restore', requirePermission('MANAGE_USERS'), usersCtrl.restoreUser);
// Phase 4 gap-bridged routes
router.patch('/users/:id/role', adminOnly, validateBody(schemas.updateUserRole), usersCtrl.updateUserRole);
router.patch('/users/:id/currency', requirePermission('MANAGE_USERS'), validateBody(schemas.updateUserCurrency), usersCtrl.updateUserCurrency);
router.patch('/users/:id/credit-limit', requirePermission('MANAGE_USERS'), validateBody(schemas.updateCreditLimit), usersCtrl.updateUserCreditLimit);
router.post('/users/:id/reset-password', requirePermission('MANAGE_USERS'), validateBody(schemas.resetUserPassword), usersCtrl.resetUserPassword);
router.patch('/users/:id/avatar', requirePermission('MANAGE_USERS'), avatarUpload.single('avatar'), usersCtrl.updateUserAvatar);
router.patch('/users/:id/permissions', adminOnly, validateBody(schemas.updateUserPermissions), usersCtrl.updateUserPermissions);
router.get('/referrals/agents', adminOnly, validateQuery(schemas.listReferralAgentsQuery), catchAsync(async (req, res) => {
    const result = await referralDashboardSvc.listAdminReferralAgents(req.query);
    return res.status(200).json({
        success: true,
        message: 'Referral agents retrieved.',
        data: result.agents,
        pagination: result.pagination,
        defaultCommissionPercent: result.defaultCommissionPercent,
        settingKey: result.settingKey,
    });
}));
router.patch('/referrals/agents/:userId/commission', adminOnly, validateBody(schemas.updateReferralCommissionOverride), catchAsync(async (req, res) => {
    const result = await referralCommissionSvc.setReferralCommissionOverride({
        userId: req.params.userId,
        percent: req.body.percent,
        adminId: req.user._id,
        auditContext: { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') },
    });
    sendSuccess(res, result, 'Referral commission override updated.');
}));

router.get(
    '/sub-agent-requests',
    requirePermission('MANAGE_USERS'),
    validateQuery(schemas.listSubAgentRequestsQuery),
    subAgentRequestCtrl.listAdminRequests
);
router.patch(
    '/sub-agent-requests/:id/approve',
    requirePermission('MANAGE_USERS'),
    validateBody(schemas.approveSubAgentRequest),
    subAgentRequestCtrl.approveRequest
);
router.patch(
    '/sub-agent-requests/:id/reject',
    requirePermission('MANAGE_USERS'),
    validateBody(schemas.rejectSubAgentRequest),
    subAgentRequestCtrl.rejectRequest
);

router.get(
    '/referral-payouts',
    requirePermission('MANAGE_WALLET'),
    validateQuery(schemas.listReferralPayoutsQuery),
    referralPayoutCtrl.listAdminPayouts
);
router.get(
    '/referral-payouts/:id',
    requirePermission('MANAGE_WALLET'),
    referralPayoutCtrl.getAdminPayout
);
router.patch(
    '/referral-payouts/:id/reject',
    requirePermission('MANAGE_WALLET'),
    validateBody(schemas.rejectReferralPayout),
    referralPayoutCtrl.rejectPayout
);
router.patch(
    '/referral-payouts/:id/pay-wallet',
    requirePermission('MANAGE_WALLET'),
    referralPayoutCtrl.payWalletPayout
);
router.patch(
    '/referral-payouts/:id/mark-paid',
    requirePermission('MANAGE_WALLET'),
    uploadReferralPayoutReceipt,
    validateReferralPayoutPaidBody,
    referralPayoutCtrl.markManualPayoutPaid
);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/providers', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.listProviders);
router.post('/providers', requirePermission('MANAGE_SUPPLIERS'), validateBody(schemas.createProvider), providersCtrl.createProvider);
// sub-resource actions BEFORE /:id to avoid param collision
router.get('/providers/:id/balance', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.getProviderBalance);
router.get('/providers/:id/products', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.getProviderLiveProducts);
router.post('/providers/:id/test-connection', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.testProviderConnection);
router.get('/providers/:id/check-order', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.checkProviderOrder);
router.get('/providers/:providerId/products/:externalProductId/price', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.getProductPrice);
router.patch('/providers/:id/toggle', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.toggleProvider);
router.get('/providers/:id', requirePermission('MANAGE_SUPPLIERS'), providersCtrl.getProviderById);
router.patch('/providers/:id', requirePermission('MANAGE_SUPPLIERS'), validateBody(schemas.updateProvider), providersCtrl.updateProvider);
router.delete('/providers/:id', adminOnly, requirePermission('MANAGE_SUPPLIERS'), providersCtrl.deleteProvider);

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/orders', requirePermission('MANAGE_ORDERS'), validateQuery(schemas.listOrdersQuery), ordersCtrl.listOrders);
router.post('/orders/:id/retry', requirePermission('CONFIRM_ORDERS'), ordersCtrl.retryOrder);
router.post('/orders/:id/refund', requirePermission('CONFIRM_ORDERS'), ordersCtrl.refundOrder);
router.post('/orders/:id/sync-status', requirePermission('CONFIRM_ORDERS'), ordersCtrl.syncOrderProviderStatus);
router.post('/orders/:id/complete', requirePermission('CONFIRM_ORDERS'), ordersCtrl.completeOrder);
router.patch('/orders/:id/status', requirePermission('CONFIRM_ORDERS'), validateBody(schemas.updateOrderStatus), ordersCtrl.updateStatus);
router.get('/orders/:id', requirePermission('MANAGE_ORDERS'), ordersCtrl.getOrderById);

// ═══════════════════════════════════════════════════════════════════════════════
// WALLETS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/wallets', requirePermission('MANAGE_WALLET'), walletCtrl.listWallets);
router.get('/wallets/:userId/transactions', requirePermission('MANAGE_WALLET'), walletCtrl.getTransactionHistory);
router.post('/wallets/:userId/add', requirePermission('MANAGE_WALLET'), walletLimiter, validateBody(schemas.walletAdjustment), walletCtrl.addFunds);
router.post('/wallets/:userId/deduct', requirePermission('MANAGE_WALLET'), walletLimiter, validateBody(schemas.walletAdjustment), walletCtrl.deductFunds);
router.put('/wallets/:userId/set', requirePermission('MANAGE_WALLET'), walletLimiter, validateBody(schemas.walletSetBalance), walletCtrl.setBalance);
router.get('/wallets/:userId', requirePermission('MANAGE_WALLET'), walletCtrl.getWallet);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES  (Phase 4b gap-bridged module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/categories', requirePermission('MANAGE_PRODUCTS'), categoriesCtrl.listCategories);
router.get('/categories/:id', requirePermission('MANAGE_PRODUCTS'), categoriesCtrl.getCategoryById);
router.post('/categories', requirePermission('MANAGE_PRODUCTS'), validateBody(categoryValidation.createCategorySchema), categoriesCtrl.createCategory);
router.patch('/categories/:id', requirePermission('MANAGE_PRODUCTS'), validateBody(categoryValidation.updateCategorySchema), categoriesCtrl.updateCategory);
router.patch('/categories/:id/toggle', requirePermission('MANAGE_PRODUCTS'), categoriesCtrl.toggleCategory);
router.delete('/categories/:id', requirePermission('MANAGE_PRODUCTS'), categoriesCtrl.deleteCategory);

// ═══════════════════════════════════════════════════════════════════════════════
// CURRENCIES  (thin proxy — full controller lives in currency module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/currencies', requirePermission('MANAGE_CURRENCIES'), catchAsync(async (req, res) => {
    const currencies = await Currency.find().sort({ code: 1 });
    sendSuccess(res, { currencies }, 'Currencies retrieved');
}));

router.patch('/currencies/:code', adminOnly, validateBody(schemas.updateCurrency), catchAsync(async (req, res) => {
    const { platformRate, markupPercentage, isActive, applyDebtAdjustment } = req.body;
    const code = req.params.code.toUpperCase();

    // Delegate to the canonical currency service (handles debt adjustment internally)
    const currencyService = require('../currency/currency.service');
    const { currency, debtAdjustment } = await currencyService.updateCurrencyRate(code, {
        platformRate,
        markupPercentage,
        applyDebtAdjustment,
        adminId: req.user._id,
    });

    // Handle isActive separately (toggle status)
    if (isActive !== undefined && currency.isActive !== isActive) {
        currency.isActive = isActive;
        currency.lastUpdatedAt = new Date();
        await currency.save();
    }

    const message = debtAdjustment?.usersAdjusted
        ? `Currency '${currency.code}' updated. Debt adjustment applied to ${debtAdjustment.usersAdjusted} users.`
        : `Currency '${currency.code}' updated.`;

    sendSuccess(res, { currency, debtAdjustment }, message);
}));

router.post('/currencies', adminOnly, validateBody(schemas.createCurrency), catchAsync(async (req, res) => {
    const { code, name, symbol, platformRate, marketRate, markupPercentage, isActive } = req.body;

    // Check for duplicate code
    const existing = await Currency.findOne({ code: code.toUpperCase() });
    if (existing) {
        const { ConflictError } = require('../../shared/errors/AppError');
        throw new ConflictError(`Currency with code '${code.toUpperCase()}' already exists.`);
    }

    const currency = await Currency.create({
        code: code.toUpperCase(),
        name,
        symbol,
        platformRate,
        marketRate: marketRate ?? null,
        markupPercentage: markupPercentage ?? 0,
        isActive: isActive !== false,
        lastUpdatedAt: new Date(),
    });

    res.status(201).json({ success: true, message: 'Currency created', data: { currency } });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUPS  (thin proxy — full controller lives in groups module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/groups', catchAsync(async (req, res) => {
    const groups = await groupSvc.listGroups({ includeInactive: true });
    sendSuccess(res, { groups }, 'Groups retrieved');
}));

router.post('/groups', requirePermission('MANAGE_GROUPS'), validateBody(schemas.createGroup), catchAsync(async (req, res) => {
    const { name, percentage, billingMode } = req.body;
    const group = await groupSvc.createGroup({ name, percentage, billingMode });
    res.status(201).json({ success: true, message: 'Group created', data: { group } });
}));

router.patch('/groups/:id', requirePermission('MANAGE_GROUPS'), validateBody(schemas.updateGroup), catchAsync(async (req, res) => {
    const { name, percentage, isActive, billingMode } = req.body;
    const group = await groupSvc.updateGroup(req.params.id, {
        name,
        percentage,
        isActive,
        billingMode,
    });
    sendSuccess(res, { group }, 'Group updated');
}));

router.delete('/groups/:id', requirePermission('MANAGE_GROUPS'), catchAsync(async (req, res) => {
    const group = await groupSvc.deleteGroup(req.params.id);
    sendSuccess(res, { group }, 'Group deleted');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/settings', adminOnly, settingsCtrl.listSettings);
router.get('/settings/:key', adminOnly, settingsCtrl.getSettingByKey);
router.patch('/settings/:key', adminOnly, validateBody(schemas.updateSetting), settingsCtrl.updateSetting);

// ═══════════════════════════════════════════════════════════════════════════════
// DEPOSITS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/deposits', requirePermission('MANAGE_DEPOSITS'), catchAsync(async (req, res) => {
    const page = parseInt(req.query.page ?? 1, 10);
    const limit = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const { status, search } = req.query;
    const result = await depositSvc.listDeposits({ page, limit, status, search });
    res.status(200).json({
        success: true,
        message: 'Deposit requests retrieved',
        data: result.deposits,
        pagination: result.pagination,
        summary: result.summary,
    });
}));

router.get('/deposits/:id', requirePermission('MANAGE_DEPOSITS'), catchAsync(async (req, res) => {
    const deposit = await depositSvc.getDepositById(req.params.id);
    sendSuccess(res, deposit);
}));

router.patch('/deposits/:id/approve', requirePermission('MANAGE_DEPOSITS'), validateBody(schemas.approveDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.approveDeposit(
        req.params.id,
        req.user._id,
        {
            // Admin overrides (optional — fallback to original deposit values in service)
            amount: req.body.amount,
            currency: req.body.currency,
            adminNotes: req.body.adminNotes,
        },
        { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    sendSuccess(res, deposit, 'Deposit approved and wallet credited.');
}));

router.patch('/deposits/:id/reject', requirePermission('MANAGE_DEPOSITS'), validateBody(schemas.approveDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.rejectDeposit(
        req.params.id,
        req.user._id,
        req.body.adminNotes ?? null,
        { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    sendSuccess(res, deposit, 'Deposit request rejected.');
}));

/**
 * PATCH /admin/deposits/:id/review
 * Unified review endpoint — approve or reject a deposit in one call.
 * Body: { status: 'APPROVED' | 'REJECTED', adminNotes?: string }
 */
router.patch('/deposits/:id/review', requirePermission('MANAGE_DEPOSITS'), validateBody(schemas.reviewDeposit), catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;
    const auditCtx = { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') };

    let deposit;
    if (status === 'APPROVED') {
        deposit = await depositSvc.approveDeposit(id, req.user._id, {
            amount: req.body.amount,
            currency: req.body.currency,
            adminNotes,
        }, auditCtx);
        sendSuccess(res, deposit, 'Deposit approved and wallet credited.');
    } else {
        deposit = await depositSvc.rejectDeposit(id, req.user._id, adminNotes || null, auditCtx);
        sendSuccess(res, deposit, 'Deposit request rejected.');
    }
}));

router.patch('/deposits/:id', requirePermission('MANAGE_DEPOSITS'), validateBody(schemas.updateDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.updatePendingDeposit(req.params.id, req.body, req.user._id);
    sendSuccess(res, { deposit }, 'Deposit request updated');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/audit', adminOnly, catchAsync(async (req, res) => {
    const { entityType, entityId, page, limit } = req.query;
    const result = await getEntityAuditLogs(entityType, entityId, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 50, 10),
    });
    sendPaginated(res, result.logs, result.pagination, 'Audit logs retrieved');
}));

router.get('/audit/actor/:actorId', adminOnly, catchAsync(async (req, res) => {
    const { page, limit } = req.query;
    const result = await getActorAuditLogs(req.params.actorId, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 50, 10),
    });
    sendPaginated(res, result.logs, result.pagination, 'Actor audit logs retrieved');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

const categoryRoutes = require('../categories/category.routes');
router.use('/categories', categoryRoutes);

// TARGET APPS

router.post(
    '/target-apps',
    requirePermission('MANAGE_TARGETS'),
    targetAppUpload.single('image'),
    attachTargetAppImage,
    targetValidation.validateBody(targetValidation.schemas.createTargetApp),
    catchAsync(async (req, res) => {
        const app = await targetSvc.createTargetApp(req.body);
        res.status(201).json({
            success: true,
            message: 'Target app created.',
            data: { app },
        });
    })
);

router.get('/target-apps', requirePermission('MANAGE_TARGETS'), catchAsync(async (_req, res) => {
    const apps = await targetSvc.listTargetApps({ includeInactive: true });
    sendSuccess(res, { apps }, 'Target apps retrieved.');
}));

router.patch(
    '/target-apps/:id',
    requirePermission('MANAGE_TARGETS'),
    targetAppUpload.single('image'),
    attachTargetAppImage,
    targetValidation.validateBody(targetValidation.schemas.updateTargetApp),
    catchAsync(async (req, res) => {
        const app = await targetSvc.updateTargetApp(req.params.id, req.body);
        sendSuccess(res, { app }, 'Target app updated.');
    })
);

router.delete('/target-apps/:id', requirePermission('MANAGE_TARGETS'), catchAsync(async (req, res) => {
    const app = await targetSvc.deactivateTargetApp(req.params.id);
    sendSuccess(res, { app }, 'Target app deactivated.');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/targets', requirePermission('MANAGE_TARGETS'), targetValidation.validateQuery(targetValidation.schemas.listTargetOrders), catchAsync(async (req, res) => {
    const page = parseInt(req.query.page ?? 1, 10);
    const limit = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const { status, search } = req.query;
    const result = await targetSvc.listTargetOrders({ page, limit, status, search });
    res.status(200).json({
        success: true,
        message: 'Target orders retrieved',
        data: result.orders,
        pagination: result.pagination,
        summary: result.summary,
    });
}));

router.patch('/targets/:id/approve', requirePermission('CONFIRM_TARGET_REQUESTS'), catchAsync(async (req, res) => {
    const auditContext = req.auditContext ?? {
        actorId: req.user._id,
        actorRole: String(req.user.role || '').toUpperCase(),
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const order = await targetSvc.approveTargetOrder(
        req.params.id,
        req.user._id,
        auditContext
    );
    sendSuccess(res, order, 'Target order approved.');
}));

router.patch('/targets/:id/reject', requirePermission('CONFIRM_TARGET_REQUESTS'), targetValidation.validateBody(targetValidation.schemas.rejectTargetOrder), catchAsync(async (req, res) => {
    const auditContext = req.auditContext ?? {
        actorId: req.user._id,
        actorRole: String(req.user.role || '').toUpperCase(),
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const order = await targetSvc.rejectTargetOrder(
        req.params.id,
        req.user._id,
        req.body.adminNotes,
        auditContext
    );
    sendSuccess(res, order, 'Target order rejected.');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/notifications', adminOnly, notifValidation.validateQuery(notifValidation.schemas.listAllNotifications), catchAsync(async (req, res) => {
    const page = parseInt(req.query.page ?? 1, 10);
    const limit = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const { scope, type } = req.query;
    const result = await notifSvc.listAllNotifications({ page, limit, scope, type });
    res.status(200).json({
        success: true,
        message: 'Notifications retrieved',
        data: result.notifications,
        pagination: result.pagination,
    });
}));

router.post('/notifications/send', adminOnly, notifValidation.validateBody(notifValidation.schemas.adminSendNotification), catchAsync(async (req, res) => {
    const result = await notifSvc.adminSendNotification(req.body);
    sendSuccess(res, result, `Notification sent successfully (${result.mode}, ${result.sent} recipient(s)).`);
}));

module.exports = router;
