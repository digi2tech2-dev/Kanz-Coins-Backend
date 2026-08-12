'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config/config');
const globalErrorHandler = require('./shared/errors/errorHandler');
const { AppError } = require('./shared/errors/AppError');
const { apiLimiter } = require('./shared/middlewares/rateLimiter');

// ── Module Routers ────────────────────────────────────────────────────────────
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const groupRoutes = require('./modules/groups/group.routes');
const productRoutes = require('./modules/products/product.routes');
const orderRoutes = require('./modules/orders/order.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const depositRoutes = require('./modules/deposits/deposit.routes');
const providerRoutes = require('./modules/providers/provider.routes');
const paymentEventRoutes = require('./modules/paymentEvents/paymentEvent.routes');
const adminCatalogRoutes = require('./modules/admin/admin.catalog.routes');
const adminSettingsService = require('./modules/admin/admin.settings.service');
const adminRoutes = require('./modules/admin/admin.routes');    // ← dashboard router
const meRoutes = require('./modules/me/me.routes');          // ← user panel
const targetRoutes = require('./modules/targets/target.routes'); // ← target coin purchases
const notificationRoutes = require('./modules/notifications/notification.routes'); // ← notifications
const currencyRoutes = require('./modules/currency/currency.routes');
const whatsappRoutes = require('./modules/whatsapp/whatsapp.routes');
const resellerRoutes = require('./modules/reseller/reseller.routes');
const clientCompatRoutes = require('./modules/clientCompat/clientCompat.routes');
const uploadRoutes = require('./shared/routes/upload.routes');
const path = require('path');
// Seed default settings on startup (idempotent, no-op if already seeded)
require('./modules/admin/setting.model').seedDefaultSettings().catch(() => { });


const app = express();
app.set('trust proxy', 1);

// ── Security Middlewares ──────────────────────────────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));
// ── CORS ──────────────────────────────────────────────────────────────────────
const getAllowedOrigins = () => {
    if (config.env === 'production') {
        const raw = process.env.ALLOWED_ORIGINS;
        if (!raw || !raw.trim()) {
            throw new Error(
                '[SECURITY] ALLOWED_ORIGINS env var is not set. ' +
                'Refusing to start in production with open CORS. ' +
                'Set ALLOWED_ORIGINS to a comma-separated list of allowed origins.'
            );
        }
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return '*'; // development / test — allow all
};

app.use(
    cors({
        origin: getAllowedOrigins(),
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
        credentials: true,
    })
);

// ── Request Parsing ───────────────────────────────────────────────────────────
app.use('/api/payment-events', apiLimiter, paymentEventRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (config.env !== 'test') {
    app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

// ── Static Files ──────────────────────────────────────────────────────────────
// Serve uploaded files (deposit receipts, etc.) from /uploads
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ── Passport (OAuth strategies) ───────────────────────────────────────────────
// Only initialize when Google credentials are configured.
// Tests and environments without GOOGLE_CLIENT_ID skip this safely.
if (config.google.clientId && config.google.clientSecret) {
    const passport = require('./config/google.strategy');
    app.use(passport.initialize());
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        status: 'healthy',
        environment: config.env,
        timestamp: new Date().toISOString(),
    });
});

// ── API Routes ────────────────────────────────────────────────────────────────
const API_PREFIX = '/api';

// Apply general rate limiter to all API routes (500 req / 15 min per IP)
app.use(API_PREFIX, apiLimiter);

app.use('/client/api', apiLimiter, clientCompatRoutes);

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/groups`, groupRoutes);
app.use(`${API_PREFIX}/products`, productRoutes);
app.use(`${API_PREFIX}/orders`, orderRoutes);
app.use(`${API_PREFIX}/wallet`, walletRoutes);
app.use(`${API_PREFIX}/audit`, auditRoutes);
app.use(`${API_PREFIX}/deposits`, depositRoutes);
app.use(`${API_PREFIX}/providers`, providerRoutes);
app.use(`${API_PREFIX}/v1/reseller`, resellerRoutes);
app.use(`${API_PREFIX}/client/api`, clientCompatRoutes);
app.use(`${API_PREFIX}/client`, resellerRoutes);

// ── User Panel ─────────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/me`, meRoutes);
app.use(`${API_PREFIX}/me/targets`, targetRoutes);
app.use(`${API_PREFIX}/me/notifications`, notificationRoutes);

// ── Public Categories (no auth required — used by storefront/guest pages) ─────
app.get(`${API_PREFIX}/categories`, async (req, res) => {
    try {
        const categorySvc = require('./modules/categories/category.service');
        const categories = await categorySvc.listCategories({ includeInactive: false });
        res.json({ success: true, message: 'Categories retrieved', data: { categories } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load categories' });
    }
});

// ── Public Currencies (no auth required — used by registration page) ──────────
app.get(`${API_PREFIX}/currencies/active`, async (req, res) => {
    try {
        const { Currency } = require('./modules/currency/currency.model');
        const currencies = await Currency.find({ isActive: true })
            .select('code name symbol platformRate')
            .sort({ code: 1 });
        res.json({ success: true, message: 'Active currencies', data: { currencies } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load currencies' });
    }
});

// ── Public Payment Settings (no auth required — used by customer deposit pages) ─
app.get(`${API_PREFIX}/settings/payment`, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        const paymentSettings = await adminSettingsService.getPaymentSettings();
        res.json({
            success: true,
            message: 'Payment settings',
            data: paymentSettings,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load payment settings' });
    }
});

// ── Public Catalog (no auth — showcase only, ALL pricing stripped) ─────────────
app.get(`${API_PREFIX}/public/catalog`, async (req, res) => {
    try {
        const { Category } = require('./modules/categories/category.model');
        const { Product } = require('./modules/products/product.model');

        const [categories, products] = await Promise.all([
            Category.find({ isActive: true })
                .select('name nameAr image slug sortOrder parentCategory')
                .sort({ sortOrder: 1 })
                .lean(),
            Product.find({ isActive: true, deletedAt: null })
                .select('name description image category displayOrder displayAccountNumber showAccountNumber minQty maxQty orderFields')
                .sort({ displayOrder: 1 })
                .lean(),
        ]);

        // Double-check: strip any financial field that might leak via virtuals or getters
        const safeProducts = products.map((p) => ({
            _id: p._id,
            name: p.name,
            description: p.description || null,
            image: p.image || null,
            category: p.category || null,
            displayOrder: p.displayOrder || 0,
            showAccountNumber: Boolean(p.showAccountNumber),
            displayAccountNumber: p.showAccountNumber ? (p.displayAccountNumber || null) : null,
            minQty: p.minQty || 1,
            maxQty: p.maxQty || 999,
        }));

        res.json({
            success: true,
            message: 'Public catalog',
            data: { categories, products: safeProducts },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load public catalog' });
    }
});

// ── Admin Routes ──────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/admin`, adminCatalogRoutes);
app.use(`${API_PREFIX}/admin/currencies`, currencyRoutes);
app.use(`${API_PREFIX}/admin/whatsapp`, whatsappRoutes);

// ── Generic Upload ────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/upload`, uploadRoutes);


// ── 404 Handler ────────────────────────────────────────────────────────────────
// Express 5 uses path-to-regexp v8 – use middleware (not app.all) for catch-all
app.use((req, res, next) => {
    next(new AppError(`Route '${req.originalUrl}' not found on this server.`, 404, 'ROUTE_NOT_FOUND'));
});

// ── Global Error Handler (must be last) ───────────────────────────────────────
app.use(globalErrorHandler);

module.exports = app;
