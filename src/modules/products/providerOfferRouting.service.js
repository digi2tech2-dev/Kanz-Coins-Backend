'use strict';

const { ProductProviderOffer, PRICE_SEMANTICS } = require('./productProviderOffer.model');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { normalizeProviderDecimalPrice, isPositive, multiply, compare } = require('../../shared/utils/decimalPrecision');

const ROUTING_CURRENCY = 'USD';

const idOf = (value) => value?._id ?? value;

const toPlainMapping = (mapping) => {
    if (!mapping) return {};
    if (mapping instanceof Map) return Object.fromEntries(mapping.entries());
    if (typeof mapping.toObject === 'function') return mapping.toObject();
    return { ...mapping };
};

const rejected = (reason, base = {}) => ({
    eligible: false,
    reason,
    supplierCost: null,
    supplierCurrency: null,
    normalizedCost: null,
    normalizedCurrency: ROUTING_CURRENCY,
    priceSemantics: base.offer?.priceSemantics ?? null,
    providerQuantity: base.providerQuantity ?? null,
    providerProductId: base.providerProduct?._id?.toString?.() ?? null,
    externalProductId: base.providerProduct?.externalProductId ?? null,
    syncedAt: base.providerProduct?.lastSyncedAt ?? null,
    freshnessAccepted: false,
});

const mappedInputIsSatisfied = (mapping, customerInput) => Object.keys(mapping).every((key) => {
    const value = customerInput?.[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
});

/**
 * Calculate a supplier cost from persisted offer/catalog data only.
 * This deliberately makes no provider HTTP request and never places an order.
 */
const getComparableProviderCost = async ({
    offer,
    provider,
    providerProduct,
    platformQuantity,
    customerInput = {},
    asOf = new Date(),
}) => {
    const providerQuantity = Number(platformQuantity);
    const base = { offer, providerProduct, providerQuantity };

    if (!offer?.enabled) return rejected('OFFER_DISABLED', base);
    if (!offer.allowAutomaticRouting) return rejected('AUTOMATIC_ROUTING_DISABLED', base);
    if (!provider) return rejected('PROVIDER_NOT_FOUND', base);
    if (!provider.isActive) return rejected('PROVIDER_INACTIVE', base);
    if (!providerProduct) return rejected('PROVIDER_PRODUCT_NOT_FOUND', base);
    if (String(idOf(providerProduct.provider)) !== String(idOf(offer.provider))) {
        return rejected('PROVIDER_PRODUCT_PROVIDER_MISMATCH', base);
    }
    if (!providerProduct.isActive) return rejected('PROVIDER_PRODUCT_INACTIVE', base);
    if (!Number.isInteger(providerQuantity) || providerQuantity < 1) return rejected('INVALID_PROVIDER_QUANTITY', base);
    if (providerQuantity < providerProduct.minQty || providerQuantity > providerProduct.maxQty) {
        return rejected('PROVIDER_QUANTITY_OUT_OF_RANGE', base);
    }

    const rawPrice = normalizeProviderDecimalPrice(providerProduct.rawPrice);
    if (!isPositive(rawPrice)) return rejected('INVALID_RAW_PRICE', base);
    if (!offer.supplierCurrency || !/^[A-Z]{3}$/.test(String(offer.supplierCurrency))) {
        return rejected('INVALID_SUPPLIER_CURRENCY', base);
    }
    if (!providerProduct.lastSyncedAt) return rejected('MISSING_PROVIDER_PRICE_TIMESTAMP', base);
    if (!offer.maxPriceAgeMs || Number(asOf) - Number(providerProduct.lastSyncedAt) > offer.maxPriceAgeMs) {
        return rejected('STALE_PROVIDER_PRICE', base);
    }

    const mapping = toPlainMapping(offer.providerMapping);
    if (!mappedInputIsSatisfied(mapping, customerInput)) return rejected('MISSING_MAPPED_CUSTOMER_INPUT', base);

    let supplierCost;
    if (offer.priceSemantics === PRICE_SEMANTICS.FIXED_OFFER) {
        supplierCost = rawPrice;
    } else if (offer.priceSemantics === PRICE_SEMANTICS.PER_UNIT) {
        supplierCost = multiply(rawPrice, String(providerQuantity));
    } else if (offer.priceSemantics === PRICE_SEMANTICS.QUOTE_REQUIRED) {
        return rejected('QUOTE_REQUIRED', base);
    } else {
        return rejected('UNSUPPORTED_PRICE_SEMANTICS', base);
    }

    try {
        // Strict resolution verifies that this is a registered, constructible
        // adapter without issuing a provider request.
        getProviderAdapter(provider, { strict: true });
    } catch (_err) {
        return rejected('UNSUPPORTED_PROVIDER_ADAPTER', base);
    }

    const supplierCurrency = String(offer.supplierCurrency).toUpperCase();
    // Supplier costs must never use Currency.platformRate: that is a customer/
    // wallet billing rate, not a supplier FX rate. V1 only routes USD offers.
    if (supplierCurrency !== ROUTING_CURRENCY) return rejected('UNSUPPORTED_SUPPLIER_CURRENCY', base);

    return {
        eligible: true,
        reason: null,
        supplierCost,
        supplierCurrency,
        normalizedCost: supplierCost,
        normalizedCurrency: ROUTING_CURRENCY,
        normalizationRate: '1',
        priceSemantics: offer.priceSemantics,
        providerQuantity,
        providerProductId: String(providerProduct._id),
        externalProductId: String(providerProduct.externalProductId),
        syncedAt: providerProduct.lastSyncedAt,
        freshnessAccepted: true,
    };
};

/**
 * Resolve exactly one offer for a Product explicitly configured for MULTI_PROVIDER.
 * The caller, not mapping existence, decides when this path is active.
 */
const selectProviderOfferForOrder = async ({ product, quantity, customerInput = {}, asOf = new Date(), session = null }) => {
    const query = ProductProviderOffer.find({ product: product._id })
        .populate('provider')
        .populate('providerProduct');
    if (session) query.session(session);
    const offers = await query;

    if (!offers.length) return { hasOffers: false, selected: null, candidates: [] };

    const candidates = [];
    for (const offer of offers) {
        const cost = await getComparableProviderCost({
            offer,
            provider: offer.provider,
            providerProduct: offer.providerProduct,
            platformQuantity: quantity,
            customerInput,
            asOf,
        });
        candidates.push({ offer, provider: offer.provider, providerProduct: offer.providerProduct, cost });
    }

    const eligible = candidates.filter((candidate) => candidate.cost.eligible);
    eligible.sort((a, b) => {
        const costComparison = compare(a.cost.normalizedCost, b.cost.normalizedCost);
        if (costComparison !== 0) return costComparison;
        const priorityComparison = Number(a.offer.priority || 0) - Number(b.offer.priority || 0);
        if (priorityComparison !== 0) return priorityComparison;
        return String(a.offer._id).localeCompare(String(b.offer._id));
    });

    return { hasOffers: true, selected: eligible[0] ?? null, candidates };
};

module.exports = {
    ROUTING_CURRENCY,
    getComparableProviderCost,
    selectProviderOfferForOrder,
    toPlainMapping,
};
