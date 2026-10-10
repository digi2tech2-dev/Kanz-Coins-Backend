'use strict';

const { ProductProviderOffer } = require('./productProviderOffer.model');
const { Product } = require('./product.model');
const { Provider } = require('../providers/provider.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { Order } = require('../orders/order.model');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../../shared/errors/AppError');
const { hasPriceSemanticsMismatch } = require('./providerProductPriceSemantics');

const POPULATE_SAFE_OFFER = [
    { path: 'provider', select: 'name slug isActive' },
    { path: 'providerProduct', select: 'provider rawName translatedName externalProductId rawPrice minQty maxQty isActive lastSyncedAt' },
    { path: 'product', select: 'name isActive executionType' },
];

const assertRelation = async ({ product, provider, providerProduct }) => {
    const [productDoc, providerDoc, providerProductDoc] = await Promise.all([
        Product.findById(product).select('_id'),
        Provider.findById(provider).select('_id'),
        ProviderProduct.findById(providerProduct).select('_id provider rawPayload'),
    ]);
    if (!productDoc) throw new NotFoundError('Product');
    if (!providerDoc) throw new NotFoundError('Provider');
    if (!providerProductDoc) throw new NotFoundError('ProviderProduct');
    if (String(providerProductDoc.provider) !== String(provider)) {
        throw new BusinessRuleError(
            'The selected ProviderProduct belongs to a different Provider.',
            'PROVIDER_PRODUCT_PROVIDER_MISMATCH'
        );
    }
    return providerProductDoc;
};

const assertPriceSemantics = ({ providerProduct, priceSemantics }) => {
    if (hasPriceSemanticsMismatch({ providerProduct, priceSemantics })) {
        throw new BusinessRuleError(
            'This amount-based ProviderProduct uses per-unit pricing and must use PER_UNIT price semantics.',
            'INVALID_PRICE_SEMANTICS_FOR_PROVIDER_PRODUCT'
        );
    }
};

const listOffersForProduct = async (productId) => {
    const product = await Product.findById(productId).select('_id');
    if (!product) throw new NotFoundError('Product');
    return ProductProviderOffer.find({ product: productId })
        .populate(POPULATE_SAFE_OFFER)
        .sort({ enabled: -1, priority: 1, _id: 1 });
};

const createOffer = async (payload) => {
    const providerProduct = await assertRelation(payload);
    assertPriceSemantics({ providerProduct, priceSemantics: payload.priceSemantics });
    try {
        const offer = await ProductProviderOffer.create(payload);
        return offer.populate(POPULATE_SAFE_OFFER);
    } catch (err) {
        if (err?.code === 11000) {
            throw new ConflictError('This ProductProviderOffer mapping already exists.');
        }
        throw err;
    }
};

const updateOffer = async (offerId, updates) => {
    const offer = await ProductProviderOffer.findById(offerId);
    if (!offer) throw new NotFoundError('ProductProviderOffer');

    const allowed = [
        'provider', 'providerProduct', 'enabled', 'allowAutomaticRouting',
        'priceSemantics', 'supplierCurrency', 'maxPriceAgeMs', 'providerMapping',
        'priority', 'notes',
    ];
    const safe = Object.fromEntries(Object.entries(updates).filter(([key]) => allowed.includes(key)));
    if (!Object.keys(safe).length) {
        throw new BusinessRuleError('No editable ProductProviderOffer fields were provided.', 'NO_OFFER_UPDATES');
    }

    const provider = safe.provider ?? offer.provider;
    const providerProduct = safe.providerProduct ?? offer.providerProduct;
    const providerProductDoc = await assertRelation({ product: offer.product, provider, providerProduct });
    assertPriceSemantics({
        providerProduct: providerProductDoc,
        priceSemantics: safe.priceSemantics ?? offer.priceSemantics,
    });

    Object.assign(offer, safe);
    try {
        await offer.save();
    } catch (err) {
        if (err?.code === 11000) {
            throw new ConflictError('This ProductProviderOffer mapping already exists.');
        }
        throw err;
    }
    return offer.populate(POPULATE_SAFE_OFFER);
};

const removeOffer = async (offerId) => {
    const offer = await ProductProviderOffer.findById(offerId);
    if (!offer) throw new NotFoundError('ProductProviderOffer');

    const referencedByOrder = await Order.exists({ selectedProviderOffer: offer._id });
    if (referencedByOrder) {
        throw new BusinessRuleError(
            'This offer has historical routed orders and cannot be removed. Disable it instead.',
            'OFFER_HAS_HISTORICAL_ORDERS'
        );
    }
    await offer.deleteOne();
    return { deleted: true, id: String(offerId) };
};

module.exports = {
    listOffersForProduct,
    createOffer,
    updateOffer,
    removeOffer,
};
