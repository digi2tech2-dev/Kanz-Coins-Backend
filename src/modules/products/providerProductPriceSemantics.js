'use strict';

/**
 * `product_type: amount` is the explicit Canonical B2B catalog contract for
 * an amount-based product: rawPrice is a price per ordered unit. Do not infer
 * this from minQty/maxQty alone; many providers use ranges for other reasons.
 */
const isDefinitivelyPerUnitProviderProduct = (providerProduct) => (
    String(providerProduct?.rawPayload?.product_type ?? '').trim().toLowerCase() === 'amount'
);

const hasPriceSemanticsMismatch = ({ providerProduct, priceSemantics }) => (
    isDefinitivelyPerUnitProviderProduct(providerProduct)
    && priceSemantics === 'FIXED_OFFER'
);

module.exports = {
    isDefinitivelyPerUnitProviderProduct,
    hasPriceSemanticsMismatch,
};
