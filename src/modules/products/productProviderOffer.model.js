'use strict';

const mongoose = require('mongoose');
const { hasPriceSemanticsMismatch } = require('./providerProductPriceSemantics');

const PRICE_SEMANTICS = Object.freeze({
    FIXED_OFFER: 'FIXED_OFFER',
    PER_UNIT: 'PER_UNIT',
    QUOTE_REQUIRED: 'QUOTE_REQUIRED',
});

/**
 * Admin-owned routing metadata between a platform Product and one provider offer.
 * ProviderProduct remains the synced catalog source; this model must never be
 * overwritten by provider catalog syncs.
 */
const productProviderOfferSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'product is required'],
            index: true,
        },
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            required: [true, 'provider is required'],
            index: true,
        },
        providerProduct: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ProviderProduct',
            required: [true, 'providerProduct is required'],
            index: true,
        },
        enabled: {
            type: Boolean,
            default: true,
        },
        allowAutomaticRouting: {
            type: Boolean,
            default: false,
        },
        priceSemantics: {
            type: String,
            enum: [...Object.values(PRICE_SEMANTICS), null],
            default: null,
        },
        supplierCurrency: {
            type: String,
            uppercase: true,
            trim: true,
            default: null,
            match: [/^[A-Z]{3}$/, 'supplierCurrency must be a 3-letter ISO currency code'],
        },
        /** Maximum accepted age of ProviderProduct.lastSyncedAt for automatic routing. */
        maxPriceAgeMs: {
            type: Number,
            default: null,
            min: [1, 'maxPriceAgeMs must be a positive integer'],
            validate: {
                validator: (value) => value == null || Number.isInteger(value),
                message: 'maxPriceAgeMs must be an integer',
            },
        },
        /** Internal customer-input key -> provider parameter-name mapping. */
        providerMapping: {
            type: Map,
            of: String,
            default: {},
        },
        /** Lower values win after normalized cost; ObjectId is the final tie-break. */
        priority: {
            type: Number,
            default: 0,
            validate: {
                validator: Number.isInteger,
                message: 'priority must be an integer',
            },
        },
        notes: {
            type: String,
            trim: true,
            maxlength: [1000, 'notes cannot exceed 1000 characters'],
            default: null,
        },
    },
    { timestamps: true }
);

productProviderOfferSchema.pre('validate', async function validateRoutingMetadata(next) {
    try {
        if (this.allowAutomaticRouting) {
            if (!this.supplierCurrency) {
                this.invalidate('supplierCurrency', 'supplierCurrency is required for automatic routing');
            }
            if (!this.maxPriceAgeMs) {
                this.invalidate('maxPriceAgeMs', 'maxPriceAgeMs is required for automatic routing');
            }
            if (![PRICE_SEMANTICS.FIXED_OFFER, PRICE_SEMANTICS.PER_UNIT].includes(this.priceSemantics)) {
                this.invalidate('priceSemantics', 'automatic routing requires FIXED_OFFER or PER_UNIT price semantics');
            }
        }

        // Keep this invariant at the model boundary too, so direct model writes
        // cannot create a provider/product mismatch outside the admin service.
        if (this.provider && this.providerProduct) {
            const { ProviderProduct } = require('../providers/providerProduct.model');
            const providerProduct = await ProviderProduct.findById(this.providerProduct)
                .select('provider rawPayload')
                .lean();
            if (!providerProduct) {
                this.invalidate('providerProduct', 'providerProduct does not exist');
            } else if (String(providerProduct.provider) !== String(this.provider)) {
                this.invalidate('providerProduct', 'providerProduct must belong to provider');
            } else if (hasPriceSemanticsMismatch({ providerProduct, priceSemantics: this.priceSemantics })) {
                this.invalidate(
                    'priceSemantics',
                    'INVALID_PRICE_SEMANTICS_FOR_PROVIDER_PRODUCT: amount provider products must use PER_UNIT price semantics'
                );
            }
        }

        next();
    } catch (err) {
        next(err);
    }
});

productProviderOfferSchema.index(
    { product: 1, provider: 1, providerProduct: 1 },
    { unique: true, name: 'unique_product_provider_offer' }
);
productProviderOfferSchema.index(
    { product: 1, enabled: 1, allowAutomaticRouting: 1, priority: 1 },
    { name: 'product_routable_offers' }
);

const ProductProviderOffer = mongoose.model('ProductProviderOffer', productProviderOfferSchema);

module.exports = { ProductProviderOffer, PRICE_SEMANTICS };
