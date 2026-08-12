'use strict';

/**
 * me.controller.js — User Panel: profile, wallet, orders, products, deposits
 *
 * All handlers operate on the authenticated user (req.user).
 * Ownership isolation: users can ONLY see their own data.
 */

const { User } = require('../users/user.model');
const crypto = require('crypto');
const { WalletTransaction } = require('../wallet/walletTransaction.model');
const orderService = require('../orders/order.service');
const depositService = require('../deposits/deposit.service');
const productService = require('../products/product.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { AuthorizationError, BusinessRuleError, NotFoundError } = require('../../shared/errors/AppError');
const { buildPublicWalletSummary } = require('../../shared/utils/walletSummary');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parsePage = (v) => Math.max(1, parseInt(v, 10) || 1);
const parseLimit = (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 20));

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const normalizeOrderFieldAliasPayload = (value) => {
    if (!value) return {};

    if (Array.isArray(value)) {
        return value.reduce((acc, item) => {
            if (!item || typeof item !== 'object') return acc;

            const fieldKey = String(
                item.key ?? item.name ?? item.field ?? item.id ?? item.label ?? ''
            ).trim();
            if (!fieldKey) return acc;

            const resolvedValue = hasOwn(item, 'value')
                ? item.value
                : (item.input ?? item.answer ?? item.data);

            if (resolvedValue !== undefined) {
                acc[fieldKey] = resolvedValue;
            }

            return acc;
        }, {});
    }

    if (typeof value === 'object') {
        return { ...value };
    }

    return {};
};

const resolveOrderFieldsPayload = ({ orderFieldsValues, customInputs, dynamicFields }) => {
    for (const source of [orderFieldsValues, customInputs, dynamicFields]) {
        const normalized = normalizeOrderFieldAliasPayload(source);
        if (Object.keys(normalized).length > 0) {
            return normalized;
        }
    }

    return {};
};

// =============================================================================
// PROFILE  —  GET /api/me
// =============================================================================

/**
 * Return the authenticated user's full profile including wallet and group info.
 */
const getProfile = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id)
        .select('-password -__v')
        .populate('groupId', 'name percentage isActive billingMode');

    if (!user) throw new NotFoundError('User');

    const groupData = user.groupId;
    const billingMode = groupData?.billingMode || 'standard';
    const walletSummary = buildPublicWalletSummary(user);

    sendSuccess(res, {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        verified: user.verified,
        currency: user.currency,
        walletBalance: walletSummary.walletBalance,
        creditLimit: walletSummary.creditLimit,
        creditUsed: walletSummary.creditUsed,
        availableCredit: walletSummary.availableCredit,
        availableBalance: walletSummary.availableBalance,
        coins: walletSummary.walletBalance,
        balance: walletSummary.walletBalance,
        group: groupData,
        billingMode,
        quantityLimit: user.quantityLimit || 0,
        quantityUsed: user.quantityUsed || 0,
        quantityRemaining: user.quantityRemaining || 0,
        isApiEnabled: Boolean(user.isApiEnabled),
        whitelistIps: Array.isArray(user.whitelistIps) ? user.whitelistIps : [],
        webhookUrl: user.webhookUrl || '',
        createdAt: user.createdAt,
    }, 'Profile retrieved.');
});

const generateApiToken = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id).select('+apiToken isApiEnabled');
    if (!user) throw new NotFoundError('User');
    if (!user.isApiEnabled) {
        throw new AuthorizationError('API access is not enabled for your account.');
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.apiToken = rawToken;
    await user.save();

    sendSuccess(res, { rawToken }, 'API token generated. Copy it now; it will not be shown again.');
});

const updateApiSettings = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user) throw new NotFoundError('User');
    if (!user.isApiEnabled) {
        throw new AuthorizationError('API access is not enabled for your account.');
    }

    const whitelistIps = Array.isArray(req.body.whitelistIps)
        ? req.body.whitelistIps.map((ip) => String(ip || '').trim()).filter(Boolean)
        : [];
    const webhookUrl = String(req.body.webhookUrl || '').trim();

    user.whitelistIps = [...new Set(whitelistIps)];
    user.webhookUrl = webhookUrl || null;
    await user.save();

    sendSuccess(res, {
        isApiEnabled: Boolean(user.isApiEnabled),
        whitelistIps: user.whitelistIps,
        webhookUrl: user.webhookUrl || '',
    }, 'API settings updated.');
});

// =============================================================================
// WALLET  —  GET /api/me/wallet
// =============================================================================

/**
 * Wallet summary: balance + last 5 transactions.
 */
const getWallet = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id).select('walletBalance currency creditLimit creditUsed');
    if (!user) throw new NotFoundError('User');
    const walletSummary = buildPublicWalletSummary(user);

    const recent = await WalletTransaction.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('reference', 'orderNumber customerInput status totalPrice')
        .lean();

    sendSuccess(res, {
        walletBalance: walletSummary.walletBalance,
        creditLimit: walletSummary.creditLimit,
        creditUsed: walletSummary.creditUsed,
        availableCredit: walletSummary.availableCredit,
        availableBalance: walletSummary.availableBalance,
        coins: walletSummary.walletBalance,
        balance: walletSummary.walletBalance,
        currency: walletSummary.currency,
        recentTransactions: recent,
    }, 'Wallet summary retrieved.');
});

// =============================================================================
// WALLET TRANSACTIONS  —  GET /api/me/wallet/transactions
// =============================================================================

/**
 * Paginated transaction history for the authenticated user.
 * Query: page, limit, from (ISO date), to (ISO date)
 */
const getTransactions = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const filter = { userId: req.user._id };

    if (req.query.from || req.query.to) {
        filter.createdAt = {};
        if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
        if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
        WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice').lean(),
        WalletTransaction.countDocuments(filter),
    ]);

    sendPaginated(res, transactions, { page, limit, total, pages: Math.ceil(total / limit) }, 'Transactions retrieved.');
});

// =============================================================================
// ORDERS  —  GET /api/me/orders  |  GET /api/me/orders/:id
// =============================================================================

/**
 * Paginated order list for the authenticated user.
 * Query: status, page, limit, from, to
 */
const getOrders = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const filter = {
        userId: req.user._id,
        ...(req.query.status && { status: req.query.status }),
    };

    if (req.query.from || req.query.to) {
        filter.createdAt = {};
        if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
        if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const { Order } = require('../orders/order.model');
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name image')
            .lean(),
        Order.countDocuments(filter),
    ]);

    sendPaginated(res, orders, { page, limit, total, pages: Math.ceil(total / limit) }, 'Orders retrieved.');
});

/**
 * Single order by ID — enforces ownership.
 */
const getOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id, req.user._id);
    sendSuccess(res, order);
});

const uploadOrderFieldImage = catchAsync(async (req, res) => {
    if (!req.file) {
        throw new BusinessRuleError('No image file provided.', 'MISSING_FILE');
    }

    const relativePath = `/uploads/order-fields/${req.file.filename}`;
    sendCreated(res, { path: relativePath, url: relativePath }, 'Image uploaded successfully.');
});

// =============================================================================
// PLACE ORDER  —  POST /api/me/orders
// =============================================================================

/**
 * Place a new order. Only ACTIVE + verified users can place orders.
 * Wallet balance plus credit limit must cover the order cost.
 */
const placeOrder = catchAsync(async (req, res) => {
    const {
        productId,
        quantity,
        orderFieldsValues,
        customInputs,
        dynamicFields,
        link,
        target,
    } = req.body;

    // Merge top-level link/target into orderFieldsValues so they always
    // reach customerInput (SMM providers need these as provider params).
    const mergedFields = resolveOrderFieldsPayload({
        orderFieldsValues,
        customInputs,
        dynamicFields,
    });
    if (link && !mergedFields.link) mergedFields.link = link;
    if (target && !mergedFields.target) mergedFields.target = target;
    const finalFields = Object.keys(mergedFields).length > 0 ? mergedFields : null;

    const auditContext = {
        actorId: req.user._id,
        actorRole: 'CUSTOMER',
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const { order, idempotent } = await orderService.createOrder({
        userId: req.user._id,
        productId,
        quantity: parseInt(quantity, 10) || 1,
        idempotencyKey: req.headers['idempotency-key'] || null,
        orderFieldsValues: finalFields,
        auditContext,
    });

    if (idempotent) {
        return sendSuccess(res, order, 'Order already exists (idempotent response).');
    }
    sendCreated(res, order, 'Order placed successfully.');
});

// =============================================================================
// PRODUCTS  —  GET /api/me/products  |  GET /api/me/products/:id
// =============================================================================

/**
 * Public product catalogue for authenticated customers.
 * Prices follow the full pipeline:
 *   1. Base Price (USD from provider)
 *   2. Group Markup: markedUpUSD = basePrice × (1 + group.percentage / 100)
 *   3. Currency Conversion: displayPrice = markedUpUSD × userCurrencyRate
 */
const getProducts = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { Product } = require('../products/product.model');
    const Group = require('../groups/group.model');
    const { getConversionRate } = require('../../services/currencyConverter.service');
    const { usdToLocal } = require('../../shared/utils/currencyMath');
    const { calculateFinalPrice } = require('../orders/pricing.service');

    const filter = { isActive: true, deletedAt: null };
    if (req.query.search) {
        filter.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } },
        ];
    }

    const skip = (page - 1) * limit;
    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit)
            .select('-providerProduct')
            .lean(),
        Product.countDocuments(filter),
    ]);

    // ── 1. Resolve user's group markup ────────────────────────────────────────
    let markupPercentage = 0;
    if (req.user.groupId) {
        const group = await Group.findById(req.user.groupId).select('percentage isActive').lean();
        if (group?.isActive) markupPercentage = group.percentage ?? 0;
    }

    // ── 2. Resolve user's currency rate ───────────────────────────────────────
    const userCurrency = req.user.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    // ── 3. Apply pipeline: Base → Markup → Currency ───────────────────────────
    const converted = products.map((p) => {
        const markedUpUSD = calculateFinalPrice(p.basePrice, markupPercentage);
        const showAccountNumber = Boolean(p.showAccountNumber);
        return {
            ...p,
            showAccountNumber,
            displayAccountNumber: showAccountNumber ? (p.displayAccountNumber || null) : null,
            markedUpPriceUSD: markedUpUSD,
            displayPrice: usdToLocal(markedUpUSD, rate),
            displayCurrency: userCurrency,
        };
    });

    sendPaginated(res, converted, { page, limit, total, pages: Math.ceil(total / limit) }, 'Products retrieved.');
});

/**
 * Single product detail — full pricing pipeline applied.
 */
const getProduct = catchAsync(async (req, res) => {
    const { Product } = require('../products/product.model');
    const Group = require('../groups/group.model');
    const { getConversionRate } = require('../../services/currencyConverter.service');
    const { usdToLocal } = require('../../shared/utils/currencyMath');
    const { calculateFinalPrice } = require('../orders/pricing.service');

    const product = await Product.findOne({ _id: req.params.id, isActive: true, deletedAt: null })
        .select('-providerProduct')
        .lean();

    if (!product) throw new NotFoundError('Product');

    // ── 1. Group markup ───────────────────────────────────────────────────────
    let markupPercentage = 0;
    if (req.user.groupId) {
        const group = await Group.findById(req.user.groupId).select('percentage isActive').lean();
        if (group?.isActive) markupPercentage = group.percentage ?? 0;
    }

    // ── 2. Currency rate ──────────────────────────────────────────────────────
    const userCurrency = req.user.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    // ── 3. Pipeline: Base → Markup → Currency ─────────────────────────────────
    const markedUpUSD = calculateFinalPrice(product.basePrice, markupPercentage);
    const showAccountNumber = Boolean(product.showAccountNumber);

    sendSuccess(res, {
        ...product,
        showAccountNumber,
        displayAccountNumber: showAccountNumber ? (product.displayAccountNumber || null) : null,
        markedUpPriceUSD: markedUpUSD,
        displayPrice: usdToLocal(markedUpUSD, rate),
        displayCurrency: userCurrency,
    });
});

// =============================================================================
// DEPOSITS  —  POST /api/me/deposits  |  GET /api/me/deposits  |  GET /api/me/deposits/:id
// =============================================================================

/**
 * Create a new deposit request.
 * Accepts multipart/form-data with a `receipt` file (via upload middleware).
 * The uploaded file path is stored as `receiptImage`.
 */
const createDeposit = catchAsync(async (req, res) => {
    // ── Validate file upload ─────────────────────────────────────────────
    if (!req.file) {
        const { BusinessRuleError } = require('../../shared/errors/AppError');
        throw new BusinessRuleError(
            'Receipt image is required. Please upload a file.',
            'RECEIPT_REQUIRED'
        );
    }

    const { requestedAmount, currency, paymentMethodId, notes } = req.body;
    const senderDetails = depositService.normalizeSenderDetails(req.body);
    const paymentTransactionId = req.body.transactionId
        || req.body.transactionNumber
        || req.body.paymentReference
        || senderDetails?.transactionNumber
        || null;

    // ── Fetch current exchange rate ──────────────────────────────────────
    const { Currency } = require('../currency/currency.model');
    const currencyDoc = await Currency.findOne({
        code: currency.toUpperCase(),
        isActive: true,
    });

    if (!currencyDoc) {
        const { BusinessRuleError } = require('../../shared/errors/AppError');
        throw new BusinessRuleError(
            `Currency '${currency}' is not supported or is inactive.`,
            'INVALID_CURRENCY'
        );
    }

    const exchangeRate = currencyDoc.platformRate;

    // ── Calculate USD equivalent ─────────────────────────────────────────
    const parsedAmount = parseFloat(requestedAmount);
    const amountUsd = Number((parsedAmount / exchangeRate).toFixed(2));

    // ── Build relative receipt path ──────────────────────────────────────
    const receiptImage = `uploads/deposits/${req.file.filename}`;

    // ── Persist ──────────────────────────────────────────────────────────
    const deposit = await depositService.createDepositRequest({
        userId: req.user._id,
        paymentMethodId,
        requestedAmount: parsedAmount,
        currency: currency.toUpperCase(),
        exchangeRate,
        amountUsd,
        receiptImage,
        notes: notes || null,
        senderDetails,
        paymentTransactionId,
        auditContext: {
            actorId: req.user._id,
            actorRole: 'CUSTOMER',
            ipAddress: req.ip ?? null,
            userAgent: req.get('User-Agent') ?? null,
        },
    });

    sendCreated(res, deposit, 'Deposit request submitted successfully. Pending admin review.');
});

/**
 * List authenticated user's own deposit requests.
 * Query: status, page, limit
 */
const getDeposits = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status } = req.query;

    const result = await depositService.listMyDeposits(req.user._id, { page, limit, status });
    sendPaginated(res, result.deposits, result.pagination, 'Deposit requests retrieved.');
});

/**
 * Single deposit by ID — user may only see their own.
 */
const getDeposit = catchAsync(async (req, res) => {
    const deposit = await depositService.getDepositById(req.params.id, req.user._id);
    sendSuccess(res, deposit);
});

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    getProfile,
    generateApiToken,
    updateApiSettings,
    getWallet,
    getTransactions,
    getOrders,
    getOrder,
    uploadOrderFieldImage,
    placeOrder,
    getProducts,
    getProduct,
    createDeposit,
    getDeposits,
    getDeposit,
};
