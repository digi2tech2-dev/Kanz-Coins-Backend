'use strict';

/**
 * admin.catalog.controller.js
 *
 * Thin HTTP adapter for the provider catalog admin endpoints.
 *
 * Responsibilities:
 *   - Trigger provider product syncs
 *   - Browse raw provider products (Layer 2)
 *   - Create / update / toggle platform products (Layer 3)
 *   - List platform products for the admin dashboard
 *
 * No business logic here — all work is delegated to services.
 */

const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { normalizeProviderDecimalPrice } = require('../../shared/utils/decimalPrecision');

const catalogService = require('../providers/providerCatalog.service');
const providerService = require('../providers/provider.service');
const ppService = require('../providers/providerProduct.service');
const productService = require('../products/product.service');
const offerService = require('../products/productProviderOffer.service');

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * POST /admin/catalog/sync/:providerId
 * Manually trigger a sync for a single provider.
 */
const syncProvider = catchAsync(async (req, res) => {
    const result = await catalogService.syncProviderProducts(req.params.providerId);
    sendSuccess(res, result, 'Provider sync completed.');
});

/**
 * POST /admin/catalog/sync
 * Trigger sync for ALL active providers.
 */
const syncAll = catchAsync(async (req, res) => {
    const results = await catalogService.syncAllProviders();
    sendSuccess(res, results, 'All provider syncs completed.');
});

// ── Raw Provider Products (Layer 2) ───────────────────────────────────────────

/**
 * GET /admin/provider-products
 * Browse ALL raw provider products across all providers.
 * Query: ?search= &page= &limit= &providerId= &isActive=
 */
const listAllProviderProducts = catchAsync(async (req, res) => {
    const { search, page = 1, limit = 50, providerId, isActive } = req.query;

    const filter = {};
    if (providerId) filter.provider = providerId;
    if (isActive !== undefined) filter.isActive = isActive !== 'false';

    const { products, pagination } = await ppService.listProviderProducts(filter, {
        page: parseInt(page, 10),
        limit: Math.min(parseInt(limit, 10), 200),
        search,
    });

    sendPaginated(res, products, pagination, 'Provider products retrieved.');
});

/**
 * GET /admin/provider-products/:providerId
 * Raw provider products scoped to a single provider.
 * Query: ?search= &page= &limit= &includeInactive=
 */
const listProviderProducts = catchAsync(async (req, res) => {
    const { search, page = 1, limit = 2000, includeInactive } = req.query;

    const filter = { provider: req.params.providerId };
    if (!includeInactive || includeInactive === 'false') filter.isActive = true;

    const { products, pagination } = await ppService.listProviderProducts(filter, {
        page: parseInt(page, 10),
        limit: Math.min(parseInt(limit, 10), 2000),
        search,
    });

    sendPaginated(res, products, pagination, 'Provider products retrieved.');
});

/**
 * GET /admin/provider-products/item/:id
 * Single raw provider product by its internal _id (includes rawPayload).
 */
const getProviderProduct = catchAsync(async (req, res) => {
    const pp = await ppService.getProviderProductById(req.params.id);
    sendSuccess(res, pp);
});

/**
 * GET /admin/provider-products/item/:id/price
 * Returns the price data for a single provider product (used by sync button).
 */
const getProviderProductPrice = catchAsync(async (req, res) => {
    const pp = await ppService.getProviderProductById(req.params.id);
    // Prefer rawPayload.product_price (original provider precision) over rawPrice.
    // Return a plain decimal string so tiny prices never serialize as `1e-8`.
    const rawPriceValue = pp.rawPayload?.product_price ?? pp.rawPrice ?? 0;
    const rawPrice = normalizeProviderDecimalPrice(rawPriceValue);
    const providerId = pp.provider?._id?.toString?.()
        ?? pp.provider?.toString?.()
        ?? '';

    sendSuccess(res, {
        rawPrice,
        price: rawPrice,
        costPrice: rawPrice,
        rawName: pp.rawName || pp.rawPayload?.product_name || '',
        minQty: pp.minQty ?? null,
        maxQty: pp.maxQty ?? null,
        provider: providerId,
        found: true,
    }, 'Provider product price retrieved.');
});

/**
 * PATCH /admin/provider-products/item/:id/translated-name
 * Set admin-friendly name for a raw provider product.
 * Body: { translatedName: "..." }
 */
const setTranslatedName = catchAsync(async (req, res) => {
    const pp = await ppService.setTranslatedName(req.params.id, req.body.translatedName);
    sendSuccess(res, pp, 'Translated name updated.');
});

// ── Platform Products (Layer 3) ───────────────────────────────────────────────

/**
 * GET /admin/products
 * Admin product list — includes inactive.
 * Query: ?page= &limit= &search= &category=
 */
const listProducts = catchAsync(async (req, res) => {
    const { page = 1, limit = 500 } = req.query;
    const { products, pagination } = await productService.listProducts({
        activeOnly: false,
        page: parseInt(page, 10),
        limit: Math.min(parseInt(limit, 10), 500),
    });
    sendPaginated(res, products, pagination, 'Products retrieved.');
});

/**
 * POST /admin/products
 * Create a standalone platform product without a provider link.
 * Supports orderFields and providerMapping.
 *
 * Body:
 * {
 *   "name":           "Free Fire Diamonds",
 *   "basePrice":      9.99,
 *   "minQty":         1,
 *   "maxQty":         10000,
 *   "description":    "...",
 *   "category":       "games",
 *   "image":          "https://...",
 *   "displayOrder":   0,
 *   "isActive":       true,
 *   "executionType":  "manual" | "automatic",
 *   "orderFields":    [...],
 *   "providerMapping": { "player_id": "link" }
 * }
 */
const createProduct = catchAsync(async (req, res) => {
    const {
        name,
        basePrice,
        minQty,
        maxQty,
        description,
        category,
        image,
        displayOrder,
        displayAccountNumber,
        showAccountNumber,
        isActive,
        executionType,
        orderFields,
        providerMapping,
    } = req.body;

    const product = await productService.createProduct({
        name,
        basePrice,
        minQty,
        maxQty,
        description: description ?? null,
        category: category ?? null,
        image: image ?? null,
        displayOrder: displayOrder ?? 0,
        displayAccountNumber: displayAccountNumber ?? null,
        showAccountNumber: showAccountNumber ?? false,
        isActive: isActive ?? true,
        executionType: executionType ?? 'manual',
        orderFields: orderFields ?? [],
        providerMapping: providerMapping ?? {},
    }, req.user._id);

    sendCreated(res, product, 'Product created.');
});

/**
 * POST /admin/products/from-provider
 * Admin selects a ProviderProduct and publishes it as a platform product.
 *
 * Body:
 * {
 *   "providerProductId": "<ObjectId>",
 *   "name":              "Free Fire Diamonds",
 *   "basePrice":         0.003,
 *   "imageUrl":          "https://...",
 *   "category":          "games",
 *   "description":       "...",
 *   "minQty":            1,
 *   "maxQty":            1000,
 *   "pricingMode":       "manual" | "sync",
 *   "executionType":     "manual" | "automatic"
 * }
 */
const createProductFromProvider = catchAsync(async (req, res) => {

    const {
        providerProductId,
        name,
        basePrice,
        imageUrl,
        image,
        category,
        description,
        minQty,
        maxQty,
        pricingMode,
        executionType,
        displayOrder,
        displayAccountNumber,
        showAccountNumber,
        markupType,
        markupValue,
        isActive,
    } = req.body;

    try {
        const product = await productService.createProductFromProvider({
            providerProductId,
            name,
            basePrice,
            image: imageUrl ?? image ?? null,   // accept both field names
            category: category ?? null,
            description: description ?? null,
            minQty,
            maxQty,
            pricingMode,
            markupType,
            markupValue,
            isActive,
            executionType,
            displayOrder,
            displayAccountNumber,
            showAccountNumber,
            createdBy: req.user._id,
        });


        sendCreated(res, product, 'Product published from provider product.');
    } catch (err) {

        throw err; // re-throw so catchAsync sends proper response
    }
});

/**
 * PATCH /admin/products/:id
 * Update any field of a published platform product.
 */
const updateProduct = catchAsync(async (req, res) => {
    const product = await productService.updateProduct(req.params.id, req.body);
    sendSuccess(res, product, 'Product updated.');
});

/**
 * PATCH /admin/products/:id/toggle
 * Activate / deactivate a platform product.
 */
const toggleProduct = catchAsync(async (req, res) => {
    const product = await productService.toggleProduct(req.params.id);
    sendSuccess(res, product, `Product ${product.isActive ? 'activated' : 'deactivated'}.`);
});

/**
 * DELETE /admin/products/:id
 * Soft-delete a platform product (sets deletedAt + isActive = false).
 */
const deleteProduct = catchAsync(async (req, res) => {
    const product = await productService.deleteProduct(req.params.id);
    sendSuccess(res, product, 'Product deleted.');
});

// ── Product Provider Offers (admin-owned routing configuration) ───────────────

const listProductProviderOffers = catchAsync(async (req, res) => {
    const offers = await offerService.listOffersForProduct(req.params.productId);
    sendSuccess(res, offers, 'Product provider offers retrieved.');
});

const createProductProviderOffer = catchAsync(async (req, res) => {
    const offer = await offerService.createOffer({
        ...req.body,
        product: req.params.productId,
    });
    sendCreated(res, offer, 'Product provider offer created.');
});

const updateProductProviderOffer = catchAsync(async (req, res) => {
    const offer = await offerService.updateOffer(req.params.offerId, req.body);
    sendSuccess(res, offer, 'Product provider offer updated.');
});

const deleteProductProviderOffer = catchAsync(async (req, res) => {
    const result = await offerService.removeOffer(req.params.offerId);
    sendSuccess(res, result, 'Product provider offer removed.');
});

module.exports = {
    // Sync
    syncProvider,
    syncAll,
    // Layer 2
    listAllProviderProducts,
    listProviderProducts,
    getProviderProduct,
    getProviderProductPrice,
    setTranslatedName,
    // Layer 3
    listProducts,
    createProduct,
    createProductFromProvider,
    updateProduct,
    toggleProduct,
    deleteProduct,
    // ProductProviderOffer routing configuration
    listProductProviderOffers,
    createProductProviderOffer,
    updateProductProviderOffer,
    deleteProductProviderOffer,
};
