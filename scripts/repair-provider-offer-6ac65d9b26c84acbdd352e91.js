'use strict';

/**
 * One-off guarded repair for the known amount-priced ProductProviderOffer.
 *
 * Dry run (default):
 *   node scripts/repair-provider-offer-6ac65d9b26c84acbdd352e91.js
 *
 * Apply (intentional production operation, not for normal application use):
 *   APPLY=true CONFIRM_OFFER_ID=6ac65d9b26c84acbdd352e91 node scripts/repair-provider-offer-6ac65d9b26c84acbdd352e91.js
 */
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/database');
const { ProductProviderOffer } = require('../src/modules/products/productProviderOffer.model');
const { ProviderProduct } = require('../src/modules/providers/providerProduct.model');
const { isDefinitivelyPerUnitProviderProduct } = require('../src/modules/products/providerProductPriceSemantics');

const TARGET_OFFER_ID = '6ac65d9b26c84acbdd352e91';
const EXPECTED_PRODUCT_ID = '6a69573f6eeaac29e5c9b340';
const EXPECTED_PROVIDER_ID = '6ac52eacaa107cc4223dbabd';
const EXPECTED_PROVIDER_PRODUCT_ID = '6ac52ec5ee714b576bc30615';
const EXPECTED_EXTERNAL_PRODUCT_ID = '1000';
const APPLY = process.env.APPLY === 'true';
const CONFIRM_OFFER_ID = process.env.CONFIRM_OFFER_ID;

const toSafeOfferSummary = (offer, providerProduct) => ({
    offerId: String(offer._id),
    productId: String(offer.product),
    providerId: String(offer.provider),
    providerProductId: String(offer.providerProduct),
    externalProductId: providerProduct.externalProductId,
    providerProductType: String(providerProduct.rawPayload?.product_type ?? '').trim().toLowerCase() || null,
    enabled: offer.enabled,
    allowAutomaticRouting: offer.allowAutomaticRouting,
    priceSemantics: offer.priceSemantics,
});

const requireExpectedState = (offer, providerProduct) => {
    if (String(offer._id) !== TARGET_OFFER_ID) throw new Error('Loaded offer does not match the fixed target ID.');
    if (String(offer.product) !== EXPECTED_PRODUCT_ID) throw new Error('Offer Product does not match the expected Product. Aborting.');
    if (String(offer.provider) !== EXPECTED_PROVIDER_ID) throw new Error('Offer Provider does not match the expected Provider. Aborting.');
    if (String(offer.providerProduct) !== EXPECTED_PROVIDER_PRODUCT_ID) throw new Error('Offer ProviderProduct does not match the expected ProviderProduct. Aborting.');
    if (offer.priceSemantics !== 'FIXED_OFFER') throw new Error('Offer is not in the expected FIXED_OFFER state. Aborting.');
    if (offer.enabled !== true) throw new Error('Offer is not enabled. Aborting.');
    if (offer.allowAutomaticRouting !== true) throw new Error('Offer is not enabled for automatic routing. Aborting.');
    if (!providerProduct) throw new Error('ProviderProduct does not exist. Aborting.');
    if (String(providerProduct._id) !== EXPECTED_PROVIDER_PRODUCT_ID) {
        throw new Error('Loaded ProviderProduct does not match the expected ProviderProduct. Aborting.');
    }
    if (String(providerProduct.provider) !== String(offer.provider)) {
        throw new Error('ProviderProduct does not belong to the offer Provider. Aborting.');
    }
    if (String(providerProduct.externalProductId) !== EXPECTED_EXTERNAL_PRODUCT_ID) {
        throw new Error('ProviderProduct externalProductId does not match the expected value. Aborting.');
    }
    if (providerProduct.isActive !== true) throw new Error('ProviderProduct is not active. Aborting.');
    if (!isDefinitivelyPerUnitProviderProduct(providerProduct)) {
        throw new Error('ProviderProduct is not explicitly marked product_type=amount. Aborting.');
    }
};

const main = async () => {
    if (!mongoose.isValidObjectId(TARGET_OFFER_ID)) throw new Error('Configured target offer ID is invalid.');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
    if (APPLY && CONFIRM_OFFER_ID !== TARGET_OFFER_ID) {
        throw new Error('APPLY=true requires CONFIRM_OFFER_ID to exactly match the target offer ID.');
    }

    await connectDB();
    try {
        const offer = await ProductProviderOffer.findById(TARGET_OFFER_ID)
            .select('_id product provider providerProduct enabled allowAutomaticRouting priceSemantics')
            .lean();
        if (!offer) throw new Error('Target ProductProviderOffer was not found. Aborting.');

        const providerProduct = await ProviderProduct.findById(offer.providerProduct)
            .select('_id provider externalProductId isActive rawPayload.product_type')
            .lean();
        requireExpectedState(offer, providerProduct);
        console.log(JSON.stringify({ dryRun: !APPLY, target: toSafeOfferSummary(offer, providerProduct) }, null, 2));

        if (!APPLY) {
            console.log('Dry run only. Set APPLY=true to change exactly this offer.');
            return;
        }

        const updateResult = await ProductProviderOffer.updateOne(
            {
                _id: TARGET_OFFER_ID,
                product: EXPECTED_PRODUCT_ID,
                provider: EXPECTED_PROVIDER_ID,
                providerProduct: EXPECTED_PROVIDER_PRODUCT_ID,
                enabled: true,
                allowAutomaticRouting: true,
                priceSemantics: 'FIXED_OFFER',
            },
            { $set: { priceSemantics: 'PER_UNIT' } }
        );
        console.log(JSON.stringify({ matchedCount: updateResult.matchedCount, modifiedCount: updateResult.modifiedCount }, null, 2));
        if (updateResult.matchedCount !== 1 || updateResult.modifiedCount !== 1) {
            throw new Error('Guarded update did not modify exactly one offer. Aborting.');
        }

        const repaired = await ProductProviderOffer.findById(TARGET_OFFER_ID)
            .select('_id product provider providerProduct enabled allowAutomaticRouting priceSemantics')
            .lean();
        if (
            !repaired
            || String(repaired.product) !== EXPECTED_PRODUCT_ID
            || String(repaired.provider) !== EXPECTED_PROVIDER_ID
            || String(repaired.providerProduct) !== EXPECTED_PROVIDER_PRODUCT_ID
            || repaired.priceSemantics !== 'PER_UNIT'
        ) {
            throw new Error('Read-back verification failed: offer identity or priceSemantics is incorrect.');
        }
        console.log(JSON.stringify({ verified: toSafeOfferSummary(repaired, providerProduct) }, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch(async (err) => {
        console.error(`[ProductProviderOffer repair] ${err.message}`);
        await mongoose.disconnect().catch(() => {});
        process.exitCode = 1;
    });
}

module.exports = { main };
