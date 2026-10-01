'use strict';

/**
 * product.service.js  (Layer 3 — Platform Products)
 *
 * Admin-controlled catalogue of products exposed to users.
 * This is the ONLY layer users ever interact with — they never see
 * ProviderProducts or raw provider data.
 *
 * Flow:
 *   User places order
 *     → Platform Product  (Layer 3 — this service)
 *     → ProviderProduct   (Layer 2)
 *     → Provider API      (Layer 1, via adapter)
 *
 * Key responsibilities:
 *   - CRUD for platform products (manual + provider-linked)
 *   - Publish a ProviderProduct as a platform product (admin flow)
 *   - Override name, price, qty, image at publish time
 *   - Compute finalPrice = providerPrice + markup
 *   - If pricingMode=sync: basePrice auto-tracks providerPrice on each sync
 *   - Toggle active / deactivate
 */

const {
    Product,
    PRICING_MODES,
    MARKUP_TYPES,
    EXECUTION_TYPES,
    PROVIDER_ROUTING_MODES,
    computeFinalPrice,
} = require('./product.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { ProductProviderOffer, PRICE_SEMANTICS } = require('./productProviderOffer.model');
const { isPositive, add, normalizeProviderDecimalPrice } = require('../../shared/utils/decimalPrecision');
const {
    NotFoundError,
    ConflictError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');

const getCanonicalProviderProductPrice = (providerProduct) => normalizeProviderDecimalPrice(
    providerProduct?.rawPrice
    ?? providerProduct?.rawPayload?.product_price
    ?? providerProduct?.rawPayload?.price
    ?? 0
);

const assertAutomaticMultiProviderConfiguration = async (productId) => {
    const eligibleMetadataExists = await ProductProviderOffer.exists({
        product: productId,
        enabled: true,
        allowAutomaticRouting: true,
        priceSemantics: { $in: [PRICE_SEMANTICS.FIXED_OFFER, PRICE_SEMANTICS.PER_UNIT] },
        // V1 supplier-cost comparison is deliberately USD-only.
        supplierCurrency: 'USD',
        maxPriceAgeMs: { $gt: 0 },
    });
    if (!eligibleMetadataExists) {
        throw new BusinessRuleError(
            'Automatic MULTI_PROVIDER routing requires at least one enabled offer with automatic-routing metadata.',
            'MULTI_PROVIDER_ROUTING_NOT_CONFIGURED'
        );
    }
};

// =============================================================================
// USER-FACING QUERIES
// =============================================================================

/**
 * listProducts({ activeOnly, page, limit })
 *
 * Public-facing product list. Returns only active products for customers;
 * admins pass activeOnly=false to see everything.
 */
const listProducts = async ({ activeOnly = true, page = 1, limit = 50 } = {}) => {
    const filter = { deletedAt: null };
    if (activeOnly) filter.isActive = true;
    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort({ displayOrder: 1, name: 1 })
            .skip(skip)
            .limit(limit)
            .populate('provider', 'name slug')
            .populate('providerProduct', 'rawName externalProductId'),
        Product.countDocuments(filter),
    ]);

    return {
        products,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * getProductById(id)
 * Throws NotFoundError if missing.
 */
const getProductById = async (id, { activeOnly = false } = {}) => {
    const filter = activeOnly
        ? { _id: id, isActive: true, deletedAt: null }
        : { _id: id };

    const product = await Product.findOne(filter)
        .populate('provider', 'name slug baseUrl isActive')
        .populate('providerProduct', 'rawName externalProductId rawPrice lastSyncedAt');
    if (!product) throw new NotFoundError('Product');
    return product;
};

// =============================================================================
// ADMIN — MANUAL PRODUCT CREATION (no provider link)
// =============================================================================

/**
 * createProduct(params, adminUserId)
 *
 * Create a standalone platform product with no provider linkage.
 * Used when admin wants full manual control over all aspects.
 */
const createProduct = async ({
    name,
    description = null,
    basePrice,
    minQty,
    maxQty,
    category = null,
    image = null,
    displayOrder = 0,
    displayAccountNumber = null,
    showAccountNumber = false,
    isActive = true,
    executionType = 'manual',
    costPrice = 0,
    orderFields = [],
    dynamicFields = [],
    providerMapping = {},
    provider = null,
    providerProduct = null,
    pricingMode = PRICING_MODES.MANUAL,
    markupType = MARKUP_TYPES.PERCENTAGE,
    markupValue = 0,
}, adminUserId = null) => {
    const existing = await Product.findOne({ name: new RegExp(`^${name}$`, 'i') });
    if (existing) throw new ConflictError(`A product named '${name}' already exists.`);

    if (Number(maxQty) < Number(minQty)) {
        throw new BusinessRuleError('maxQty must be >= minQty.', 'INVALID_QTY_RANGE');
    }

    // If a provider link is supplied, default executionType to 'automatic'
    const resolvedExecutionType = (provider && executionType === 'manual')
        ? 'automatic'
        : executionType;

    // ── Pricing calculation ───────────────────────────────────────────────
    let resolvedBasePrice = String(basePrice);
    let resolvedFinalPrice = null;
    let resolvedProviderPrice = null;

    if (providerProduct) {
        // Fetch provider product's raw price for markup calculation
        const pp = await ProviderProduct.findById(providerProduct).select('rawPrice rawPayload');
        if (pp) {
            const effectiveRawPrice = getCanonicalProviderProductPrice(pp);
            resolvedProviderPrice = effectiveRawPrice;

            if (pricingMode === PRICING_MODES.SYNC) {
                resolvedFinalPrice = computeFinalPrice(resolvedProviderPrice, markupType, markupValue);
                resolvedBasePrice = resolvedFinalPrice ?? resolvedProviderPrice;
            } else if (markupValue > 0) {
                // Manual mode with markup: apply one-time markup on top of provider price
                resolvedFinalPrice = computeFinalPrice(resolvedProviderPrice, markupType, markupValue);
                resolvedBasePrice = resolvedFinalPrice ?? resolvedProviderPrice;
            } else {
                // Manual mode, no markup: use admin's basePrice as-is
                resolvedFinalPrice = resolvedBasePrice;
            }
        }
    }

    // Guard: if computed price is 0 but admin supplied a valid basePrice, use it
    if (!isPositive(resolvedBasePrice) && isPositive(basePrice)) {
        resolvedBasePrice = String(basePrice);
        resolvedFinalPrice = resolvedBasePrice;
    }

    return Product.create({
        name,
        description,
        basePrice: resolvedBasePrice,
        providerPrice: resolvedProviderPrice,
        finalPrice: resolvedFinalPrice,
        minQty,
        maxQty,
        category,
        image,
        displayOrder,
        displayAccountNumber,
        showAccountNumber,
        isActive,
        pricingMode,
        markupType,
        markupValue,
        executionType: resolvedExecutionType,
        costPrice,
        orderFields,
        dynamicFields,
        providerMapping,
        provider,
        providerProduct,
        createdBy: adminUserId,
    });
};


// =============================================================================
// ADMIN — PUBLISH FROM PROVIDER PRODUCT (3-layer flow)
// =============================================================================

/**
 * publishFromProviderProduct(params, adminUserId)
 *
 * Admin selects a ProviderProduct and publishes it as a public Platform Product.
 *
 * Rules:
 *   - ProviderProduct must exist and its Provider must be active.
 *   - One ProviderProduct → at most one Platform Product (enforced here).
 *   - Admin may override name, qty bounds, image, and all pricing fields.
 *   - markupType + markupValue → finalPrice = providerPrice + markup
 *   - If pricingMode=sync: basePrice is immediately set from providerPrice+markup
 *     and will auto-update on each future sync.
 *   - executionType defaults to 'automatic' (provider-linked products are
 *     usually auto-fulfilled).
 *
 * @returns {Promise<Product>}
 */
const publishFromProviderProduct = async ({
    providerProductId,
    name,
    description = null,
    basePrice = null,            // used when pricingMode=manual and no markup
    minQty = null,
    maxQty = null,
    category = null,
    image = null,
    displayOrder = 0,
    displayAccountNumber = null,
    showAccountNumber = false,
    isActive = true,
    pricingMode = PRICING_MODES.MANUAL,
    markupType = MARKUP_TYPES.PERCENTAGE,
    markupValue = 0,
    executionType = 'automatic',
    costPrice = 0,
    dynamicFields = [],
    createdBy = null,            // accepted here for the createProductFromProvider alias
}, adminUserId = null) => {
    // Resolve createdBy from either param location
    const resolvedCreatedBy = createdBy ?? adminUserId;

    // ── Validate ProviderProduct ───────────────────────────────────────────────
    const pp = await ProviderProduct.findById(providerProductId).populate('provider');
    if (!pp) throw new NotFoundError('ProviderProduct');
    if (!pp.provider.isActive) {
        throw new BusinessRuleError(
            'The provider for this product is currently inactive.',
            'PROVIDER_INACTIVE'
        );
    }
    if (!pp.isActive) {
        throw new BusinessRuleError(
            'Cannot publish an inactive provider product.',
            'PROVIDER_PRODUCT_INACTIVE'
        );
    }

    // ── Prevent duplicate publish ─────────────────────────────────────────────
    const alreadyPublished = await Product.findOne({ providerProduct: providerProductId });
    if (alreadyPublished) {
        throw new ConflictError(
            `ProviderProduct '${pp.rawName}' has already been published as '${alreadyPublished.name}'.`
        );
    }

    // ── Compute pricing ───────────────────────────────────────────────────────
    // Fallback: if rawPrice is 0 but rawPayload has the real price, use that
    const effectiveRawPrice = getCanonicalProviderProductPrice(pp);
    const providerPrice = effectiveRawPrice;

    let resolvedFinalPrice;
    let resolvedBasePrice;

    if (pricingMode === PRICING_MODES.SYNC) {
        // Compute from providerPrice + markup; basePrice tracks it forever
        resolvedFinalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
        resolvedBasePrice = resolvedFinalPrice ?? providerPrice;
    } else {
        // Manual — admin either supplies basePrice directly OR markup is applied one-time
        if (markupValue > 0) {
            resolvedFinalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
            resolvedBasePrice = resolvedFinalPrice ?? providerPrice;
        } else if (basePrice != null) {
            resolvedBasePrice = String(basePrice);
            resolvedFinalPrice = resolvedBasePrice;
        } else {
            resolvedBasePrice = providerPrice;
            resolvedFinalPrice = providerPrice;
        }
    }

    // Guard: if computed price is 0 but admin supplied a valid basePrice, use it
    if (!isPositive(resolvedBasePrice) && basePrice != null && isPositive(basePrice)) {
        resolvedBasePrice = String(basePrice);
        resolvedFinalPrice = resolvedBasePrice;
    }

    return Product.create({
        name,
        description,
        basePrice: resolvedBasePrice,
        providerPrice,
        finalPrice: resolvedFinalPrice,
        minQty: minQty ?? pp.minQty,
        maxQty: maxQty ?? pp.maxQty,
        category,
        image,
        displayOrder,
        displayAccountNumber,
        showAccountNumber,
        isActive,
        pricingMode,
        markupType,
        markupValue,
        executionType,
        costPrice,
        dynamicFields,
        provider: pp.provider._id,
        providerProduct: pp._id,
        createdBy: resolvedCreatedBy,
    });
};

// =============================================================================
// ADMIN — UPDATE PUBLISHED PRODUCT
// =============================================================================

/**
 * updateProduct(productId, updates, adminUserId?)
 *
 * Admin modifies a published product.
 *
 * Safe fields (all optional):
 *   name, description, image, category, displayOrder, isActive,
 *   basePrice, minQty, maxQty, pricingMode, markupType, markupValue, executionType
 *
 * Pricing rules on update:
 *   - If pricingMode changes to 'sync' AND providerProduct is linked:
 *       recompute basePrice from current providerPrice + markup immediately.
 *   - If markupType or markupValue changes while in 'sync' pricingMode:
 *       recompute basePrice immediately.
 *   - In 'manual' pricingMode: basePrice is whatever admin sets.
 *
 * @returns {Promise<Product>}
 */
const updateProduct = async (productId, updates) => {
    const product = await Product.findById(productId).populate('providerProduct', 'rawPrice rawPayload');
    if (!product) throw new NotFoundError('Product');

    const ALLOWED = [
        'name', 'description', 'image', 'category', 'displayOrder', 'isActive',
        'displayAccountNumber', 'showAccountNumber',
        'basePrice', 'minQty', 'maxQty', 'pricingMode', 'markupType', 'markupValue',
        'executionType', 'providerRoutingMode', 'costPrice', 'orderFields', 'dynamicFields', 'providerMapping',
        'provider', 'providerProduct',
        'syncPriceWithProvider', 'enableManualPrice', 'manualPriceAdjustment', 'finalPrice',
    ];
    const safe = Object.fromEntries(
        Object.entries(updates).filter(([k]) => ALLOWED.includes(k))
    );

    const effectiveExecutionType = safe.executionType ?? product.executionType;
    const effectiveProviderRoutingMode = safe.providerRoutingMode ?? product.providerRoutingMode;
    if (
        effectiveExecutionType === EXECUTION_TYPES.AUTOMATIC
        && effectiveProviderRoutingMode === PROVIDER_ROUTING_MODES.MULTI_PROVIDER
    ) {
        // Metadata only: runtime freshness/availability remains an order-time check.
        await assertAutomaticMultiProviderConfiguration(product._id);
    }

    // ── Determine effective pricing fields ────────────────────────────────
    const effectivePricingMode = safe.pricingMode ?? product.pricingMode;
    const effectiveMarkupType = safe.markupType ?? product.markupType;
    const effectiveMarkupValue = safe.markupValue ?? product.markupValue;

    const pricingModeChanged = safe.pricingMode != null && safe.pricingMode !== product.pricingMode;
    const markupChanged = safe.markupType != null || safe.markupValue != null;
    const basePriceChanged = safe.basePrice != null;
    const hasProviderLink = product.providerProduct != null;

    // ── Fix 5 — Safety net: provider link changed ─────────────────────────
    //
    // When the admin changes the providerProduct reference (switches to a
    // different provider service), the frontend's price payload may be stale
    // or corrupted by the state mutation bug.  We treat the DB as the single
    // source of truth: fetch the NEW ProviderProduct and forcefully override
    // all pricing fields with its canonical rawPrice.
    //
    const incomingProviderProduct = safe.providerProduct ?? undefined;
    const currentProviderProductId = product.providerProduct?._id?.toString()
        ?? product.providerProduct?.toString()
        ?? null;
    const providerLinkChanged = incomingProviderProduct != null
        && String(incomingProviderProduct) !== currentProviderProductId;

    if (providerLinkChanged) {
        const newPP = await ProviderProduct.findById(incomingProviderProduct)
            .select('rawPrice rawPayload provider');
        if (newPP) {
            const canonicalRawPrice = getCanonicalProviderProductPrice(newPP);
            const newFinalPrice = computeFinalPrice(
                canonicalRawPrice, effectiveMarkupType, effectiveMarkupValue
            );
            safe.providerPrice = canonicalRawPrice;
            safe.finalPrice = newFinalPrice ?? canonicalRawPrice;
            safe.basePrice = safe.finalPrice;
            // Update provider reference to match the new ProviderProduct's provider
            if (newPP.provider) {
                safe.provider = newPP.provider;
            }
        }
    }

    // ── Recompute pricing ────────────────────────────────────────────────
    // Skip recomputation if we already handled this in the safety-net above.
    if (!providerLinkChanged && effectivePricingMode === PRICING_MODES.SYNC && hasProviderLink) {
        // SYNC mode: always compute from providerPrice + markup
        if (pricingModeChanged || markupChanged) {
            const pp = product.providerProduct;
            const effectiveRawPrice = getCanonicalProviderProductPrice(pp);
            const rawPrice = effectiveRawPrice;
            const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
            safe.providerPrice = rawPrice;
            safe.finalPrice = newFinalPrice;
            safe.basePrice = newFinalPrice ?? rawPrice;
        }
    } else if (!providerLinkChanged && effectivePricingMode === PRICING_MODES.MANUAL) {
        // MANUAL mode: admin controls basePrice
        if (basePriceChanged && !markupChanged) {
            // Admin directly set a basePrice — use it as-is
            safe.basePrice = String(safe.basePrice);
            safe.finalPrice = safe.basePrice;
        } else if (markupChanged && hasProviderLink) {
            // Admin changed markup while in manual mode — apply one-time markup
            const pp = product.providerProduct;
            const effectiveRawPrice = getCanonicalProviderProductPrice(pp);
            const rawPrice = effectiveRawPrice;
            const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
            safe.providerPrice = rawPrice;
            safe.finalPrice = newFinalPrice;
            safe.basePrice = newFinalPrice ?? rawPrice;
        } else if (basePriceChanged && markupChanged && hasProviderLink) {
            // Both changed — markup takes precedence over basePrice
            const pp = product.providerProduct;
            const effectiveRawPrice = getCanonicalProviderProductPrice(pp);
            const rawPrice = effectiveRawPrice;
            const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
            safe.providerPrice = rawPrice;
            safe.finalPrice = newFinalPrice;
            safe.basePrice = newFinalPrice ?? rawPrice;
        }
    }

    // ── Manual price adjustment recalculation ─────────────────────────────
    // When enableManualPrice is on and a provider link exists, enforce:
    //   finalPrice = providerPrice + manualPriceAdjustment
    const effectiveEnableManual = safe.enableManualPrice ?? product.enableManualPrice;
    const effectiveManualAdj = safe.manualPriceAdjustment ?? product.manualPriceAdjustment ?? 0;

    if (!providerLinkChanged && effectiveEnableManual && hasProviderLink) {
        const pp = product.providerProduct;
        const effectiveRawPrice = getCanonicalProviderProductPrice(pp);
        const rawPrice = effectiveRawPrice;
        const computedFinal = add(rawPrice, String(effectiveManualAdj));
        safe.providerPrice = rawPrice;
        safe.finalPrice = computedFinal;
        safe.basePrice = computedFinal;
    }

    // Keep syncPriceWithProvider in sync with pricingMode
    if (safe.syncPriceWithProvider !== undefined && safe.pricingMode === undefined) {
        safe.pricingMode = safe.syncPriceWithProvider ? PRICING_MODES.SYNC : PRICING_MODES.MANUAL;
    }
    if (safe.pricingMode !== undefined && safe.syncPriceWithProvider === undefined) {
        safe.syncPriceWithProvider = safe.pricingMode === PRICING_MODES.SYNC;
    }

    Object.assign(product, safe);
    await product.save();
    return product.populate([
        { path: 'provider', select: 'name slug' },
        { path: 'providerProduct', select: 'rawName externalProductId rawPrice' },
    ]);
};

// =============================================================================
// ADMIN — TOGGLE STATUS
// =============================================================================

const toggleProductStatus = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new NotFoundError('Product');
    product.isActive = !product.isActive;
    await product.save();
    return product;
};

// =============================================================================
// ADMIN — SOFT DELETE
// =============================================================================

/**
 * deleteProduct(productId)
 *
 * Soft-delete a product by setting deletedAt + isActive = false.
 * The product is excluded from all future list queries.
 * Throws NotFoundError if missing, BusinessRuleError if already deleted.
 */
const deleteProduct = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new NotFoundError('Product');
    if (product.deletedAt) throw new BusinessRuleError('Product is already deleted.', 'ALREADY_DELETED');

    product.deletedAt = new Date();
    product.isActive = false;
    await product.save();
    return product;
};

// =============================================================================
// INTERNAL — ORDER FULFILLMENT HELPER
// =============================================================================

/**
 * getExternalProductId(productId)
 *
 * Resolves the externalProductId for a Platform Product.
 * Used by the fulfillment engine to know what ID to send to the provider.
 *
 * Chain: Order.productId → Product.providerProduct → ProviderProduct.externalProductId
 *
 * @param {string|ObjectId} productId — Platform Product _id
 * @returns {Promise<string|null>} externalProductId, or null if not provider-linked
 */
const getExternalProductId = async (productId) => {
    const product = await Product.findById(productId)
        .select('providerProduct')
        .populate('providerProduct', 'externalProductId');
    return product?.providerProduct?.externalProductId ?? null;
};

module.exports = {
    listProducts,
    getProductById,
    createProduct,
    publishFromProviderProduct,
    updateProduct,
    toggleProductStatus,
    deleteProduct,
    getExternalProductId,

    // Canonical alias names used by admin catalog API
    createProductFromProvider: publishFromProviderProduct,  // prompt-specified name
    toggleProduct: toggleProductStatus,                     // prompt-specified name
};
