'use strict';

const { Product } = require('./product.model');
const { Provider } = require('../providers/provider.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { ProductProviderOffer } = require('./productProviderOffer.model');

/**
 * Explicit compatibility backfill. It is intentionally dry-run by default and
 * is never invoked from application startup or tests automatically.
 */
const backfillLegacyProductProviderOffers = async ({ dryRun = true, batchSize = 250 } = {}) => {
    const normalizedBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || 250));
    const stats = {
        dryRun: Boolean(dryRun),
        batchSize: normalizedBatchSize,
        productsInspected: 0,
        validLegacyLinks: 0,
        mappingsWouldCreate: 0,
        mappingsCreated: 0,
        invalidOrMissingLinks: 0,
        skippedExistingMappings: 0,
    };

    const cursor = Product.find({
        provider: { $ne: null },
        providerProduct: { $ne: null },
    })
        .select('_id provider providerProduct')
        .sort({ _id: 1 })
        .batchSize(normalizedBatchSize)
        .cursor();

    for await (const product of cursor) {
        stats.productsInspected += 1;
        const [provider, providerProduct] = await Promise.all([
            Provider.findById(product.provider).select('_id').lean(),
            ProviderProduct.findById(product.providerProduct).select('_id provider').lean(),
        ]);
        if (!provider || !providerProduct || String(providerProduct.provider) !== String(product.provider)) {
            stats.invalidOrMissingLinks += 1;
            continue;
        }

        stats.validLegacyLinks += 1;
        const existing = await ProductProviderOffer.exists({
            product: product._id,
            provider: product.provider,
            providerProduct: product.providerProduct,
        });
        if (existing) {
            stats.skippedExistingMappings += 1;
            continue;
        }

        stats.mappingsWouldCreate += 1;
        if (dryRun) continue;

        await ProductProviderOffer.create({
            product: product._id,
            provider: product.provider,
            providerProduct: product.providerProduct,
            enabled: true,
            // No currency/unit semantics are inferred from legacy scalar links.
            allowAutomaticRouting: false,
        });
        stats.mappingsCreated += 1;
    }

    return stats;
};

module.exports = { backfillLegacyProductProviderOffers };
