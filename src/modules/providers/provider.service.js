'use strict';

const { Provider } = require('./provider.model');
const { ProviderProduct } = require('./providerProduct.model');
const { Product, PRICING_MODES, EXECUTION_TYPES } = require('../products/product.model');
const {
    NotFoundError,
    ConflictError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');
const { normalizeProviderDecimalPrice } = require('../../shared/utils/decimalPrecision');

// =============================================================================
// PROVIDER CRUD
// =============================================================================

const createProvider = async ({ name, baseUrl, apiKey, apiToken, adapterType, syncInterval, isActive }) => {
    const existing = await Provider.findOne({ name: new RegExp(`^${name}$`, 'i') });
    if (existing) throw new ConflictError(`A provider named '${name}' already exists.`);

    return Provider.create({ name, baseUrl, apiKey, apiToken, adapterType, syncInterval, isActive });
};

const listProviders = async ({ includeInactive = false } = {}) => {
    const filter = includeInactive ? {} : { isActive: true };
    return Provider.find(filter).sort({ name: 1 });
};

const getProviderById = async (providerId) => {
    const p = await Provider.findById(providerId);
    if (!p) throw new NotFoundError('Provider');
    return p;
};

const updateProvider = async (providerId, updates) => {
    const allowed = ['name', 'baseUrl', 'apiKey', 'apiToken', 'adapterType', 'syncInterval', 'isActive'];
    const safe = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    const p = await Provider.findByIdAndUpdate(
        providerId,
        { $set: safe },
        { new: true, runValidators: true }
    );
    if (!p) throw new NotFoundError('Provider');
    return p;
};

const deleteProvider = async (providerId) => {
    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('Provider');

    const providerProducts = await ProviderProduct.find({ provider: providerId })
        .select('_id')
        .lean();
    const providerProductIds = providerProducts.map((item) => item._id);

    const detachFilter = providerProductIds.length > 0
        ? {
            $or: [
                { provider: providerId },
                { providerProduct: { $in: providerProductIds } },
            ],
        }
        : { provider: providerId };

    const detachResult = await Product.updateMany(detachFilter, {
        $set: {
            provider: null,
            providerProduct: null,
            pricingMode: PRICING_MODES.MANUAL,
            executionType: EXECUTION_TYPES.MANUAL,
            syncPriceWithProvider: false,
            enableManualPrice: false,
            providerPrice: null,
        },
    });

    await Provider.deleteOne({ _id: providerId });

    return {
        provider,
        detachedProducts: detachResult.modifiedCount || 0,
    };
};

// =============================================================================
// PROVIDER PRODUCT QUERIES
// =============================================================================

/**
 * List ProviderProducts for a provider (admin product-selection screen).
 * By default only active ones are returned; pass includeInactive=true to see all.
 */
const listProviderProducts = async (providerId, { page = 1, limit = 50, includeInactive = false } = {}) => {
    const filter = { provider: providerId };
    if (!includeInactive) filter.isActive = true;

    const skip = (page - 1) * limit;
    const [products, total] = await Promise.all([
        ProviderProduct.find(filter)
            .sort({ rawName: 1 })
            .skip(skip)
            .limit(limit)
            .populate('provider', 'name'),
        ProviderProduct.countDocuments(filter),
    ]);

    return {
        products,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

// =============================================================================
// ADMIN PUBLISH FLOW
// =============================================================================

/**
 * publishProduct(params)
 *
 * Admin selects a ProviderProduct and creates a public Product from it.
 * Admin can change any field before publishing — the form is pre-filled from
 * raw data but every field is overridable.
 *
 * Rules:
 *   - ProviderProduct must exist and belong to an active Provider.
 *   - Duplicate publish: a ProviderProduct may only be linked to ONE Product.
 *     (enforced here — schema does not have a unique index so misuse is caught at service layer)
 *   - pricingMode defaults to 'manual'; admin can choose 'sync' to auto-track provider price.
 *   - If pricingMode === 'sync', basePrice is immediately set to rawPrice.
 *
 * @returns {Promise<Product>}
 */
const publishProduct = async ({
    providerProductId,
    name,
    basePrice,
    minQty,
    maxQty,
    category = null,
    image = null,
    displayOrder = 0,
    isActive = true,
    pricingMode = PRICING_MODES.MANUAL,
    executionType = 'automatic',
}) => {
    // Load the raw product
    const pp = await ProviderProduct.findById(providerProductId).populate('provider');
    if (!pp) throw new NotFoundError('ProviderProduct');
    if (!pp.provider.isActive) {
        throw new BusinessRuleError(
            'The provider for this product is inactive.',
            'PROVIDER_INACTIVE'
        );
    }

    // Prevent duplicate publish
    const alreadyPublished = await Product.findOne({ providerProduct: providerProductId });
    if (alreadyPublished) {
        throw new ConflictError(
            `ProviderProduct '${pp.rawName}' has already been published as Product '${alreadyPublished.name}'.`
        );
    }

    // If sync mode, override basePrice with current rawPrice
    const resolvedBasePrice = pricingMode === PRICING_MODES.SYNC
        ? normalizeProviderDecimalPrice(pp.rawPrice)
        : String(basePrice);

    const product = await Product.create({
        name,
        basePrice: resolvedBasePrice,
        minQty: minQty ?? pp.minQty,
        maxQty: maxQty ?? pp.maxQty,
        category,
        image,
        displayOrder,
        isActive,
        pricingMode,
        executionType,
        provider: pp.provider._id,
        providerProduct: pp._id,
    });

    return product;
};

/**
 * updatePublishedProduct(productId, updates)
 *
 * Admin modifies a published Product.
 * If pricingMode changes from 'manual' → 'sync', basePrice is immediately
 * set to the linked ProviderProduct's current rawPrice.
 *
 * @returns {Promise<Product>}
 */
const updatePublishedProduct = async (productId, updates) => {
    const product = await Product.findById(productId).populate('providerProduct');
    if (!product) throw new NotFoundError('Product');

    const allowed = [
        'name', 'basePrice', 'minQty', 'maxQty',
        'category', 'image', 'displayOrder', 'isActive',
        'pricingMode', 'executionType',
    ];
    const safe = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    // Detect transition to sync mode
    const switchingToSync = (
        safe.pricingMode === PRICING_MODES.SYNC &&
        product.pricingMode !== PRICING_MODES.SYNC &&
        product.providerProduct
    );

    if (switchingToSync) {
        safe.basePrice = normalizeProviderDecimalPrice(product.providerProduct.rawPrice);
    }

    // Manual mode: allow admin to set basePrice freely (already in safe object)
    Object.assign(product, safe);
    await product.save();
    return product;
};

module.exports = {
    createProvider,
    listProviders,
    getProviderById,
    updateProvider,
    deleteProvider,
    listProviderProducts,
    publishProduct,
    updatePublishedProduct,
};
