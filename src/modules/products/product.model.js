'use strict';

const mongoose = require('mongoose');
const { computeMarkup, isPositive } = require('../../shared/utils/decimalPrecision');
const { getNextSequence } = require('../orders/counter.model');

// ─── Constants ────────────────────────────────────────────────────────────────

/** How the product's basePrice tracks the provider's rawPrice. */
const PRICING_MODES = Object.freeze({
    MANUAL: 'manual',   // admin controls basePrice exclusively
    SYNC: 'sync',     // auto-updated on each sync run
});

/** How the markup is applied on top of the provider cost. */
const MARKUP_TYPES = Object.freeze({
    PERCENTAGE: 'percentage',  // finalPrice = providerPrice * (1 + markupValue/100)
    FIXED: 'fixed',       // finalPrice = providerPrice + markupValue
});

/** How the order is fulfilled after payment. */
const EXECUTION_TYPES = Object.freeze({
    MANUAL: 'manual',     // admin fulfils it manually
    AUTOMATIC: 'automatic',  // sent to provider fulfillment engine
});

/** Which supplier-routing path an automatic Product is allowed to use. */
const PROVIDER_ROUTING_MODES = Object.freeze({
    LEGACY: 'LEGACY',
    MULTI_PROVIDER: 'MULTI_PROVIDER',
});

/**
 * All field types the frontend form builder supports.
 * Validated server-side during order creation.
 */
const FIELD_TYPES = Object.freeze({
    TEXT: 'text',
    TEXTAREA: 'textarea',
    NUMBER: 'number',
    SELECT: 'select',
    URL: 'url',      // URL format validated by backend
    // Future-ready (accepted without special backend validation for now)
    EMAIL: 'email',
    TEL: 'tel',
    DATE: 'date',
    IMAGE: 'image',
    FILE: 'file',
});

const DYNAMIC_FIELD_TYPES = Object.freeze(['text', 'number', 'email', 'select', 'image', 'file']);

// ─── Schema ───────────────────────────────────────────────────────────────────

const productSchema = new mongoose.Schema(
    {
        // ── Identity ──────────────────────────────────────────────────────────

        name: {
            type: String,
            required: [true, 'Product name is required'],
            trim: true,
            minlength: [2, 'Product name must be at least 2 characters'],
            maxlength: [200, 'Product name cannot exceed 200 characters'],
        },

        compatProductId: {
            type: Number,
            unique: true,
            sparse: true,
            index: true,
        },

        description: {
            type: String,
            trim: true,
            default: null,
        },

        /** Public image URL shown to users. */
        image: {
            type: String,
            trim: true,
            default: null,
        },

        /** Optional category tag for filtering / display grouping. */
        category: {
            type: String,
            trim: true,
            default: null,
        },

        /** Lower numbers appear first in listings. */
        displayOrder: {
            type: Number,
            default: 0,
        },

        displayAccountNumber: {
            type: String,
            trim: true,
            default: null,
        },

        showAccountNumber: {
            type: Boolean,
            default: false,
        },

        // ── Quantity Bounds ───────────────────────────────────────────────────

        minQty: {
            type: Number,
            required: [true, 'Minimum quantity is required'],
            min: [1, 'minQty must be at least 1'],
        },

        maxQty: {
            type: Number,
            required: [true, 'Maximum quantity is required'],
            validate: {
                validator: function (v) { return v >= this.minQty; },
                message: 'maxQty must be >= minQty',
            },
        },

        // ── Pricing ─────────────────────────────────────────────────────────

        /**
         * The admin-set selling price (after markup is applied).
         *
         * For MANUAL pricingMode:   set freely by admin — markup fields optional.
         * For SYNC pricingMode:     auto-computed from providerPrice + markup each sync.
         *
         * Also stored as `basePrice` for backward-compatibility with the pricing engine
         * (calculateUserPrice) which adds the group markup on top of this.
         */
        basePrice: {
            type: String,
            required: [true, 'Base price is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        /**
         * Manual product unit cost (in USD) used for profit calculations.
         * For provider-linked products, providerPrice remains the cost source.
         */
        costPrice: {
            type: Number,
            default: 0,
            min: [0, 'costPrice cannot be negative'],
        },

        /**
         * Snapshot of the provider's raw cost at time of last sync.
         * Null for manually-created products (no provider link).
         */
        providerPrice: {
            type: String,
            default: null,
            get: (v) => v != null ? String(v) : null,
            set: (v) => v != null ? String(v) : null,
        },

        /**
         * Markup type applied on top of providerPrice to compute basePrice.
         *   'percentage' → basePrice = providerPrice * (1 + markupValue / 100)
         *   'fixed'      → basePrice = providerPrice + markupValue
         *
         * Only meaningful when providerProduct is linked.
         */
        markupType: {
            type: String,
            enum: Object.values(MARKUP_TYPES),
            default: MARKUP_TYPES.PERCENTAGE,
        },

        /**
         * The markup amount.
         *   percentage markup: value in percent points (e.g. 20 = 20%)
         *   fixed markup:      absolute amount added to providerPrice
         */
        markupValue: {
            type: Number,
            default: 0,
            min: [0, 'markupValue cannot be negative'],
        },

        /**
         * Pre-computed final price = providerPrice + markup.
         * This is what gets stored as basePrice; kept as a separate field
         * so the breakdown is visible and auditable.
         * Null for manual products without provider link.
         */
        finalPrice: {
            type: String,
            default: null,
            get: (v) => v != null ? String(v) : null,
            set: (v) => v != null ? String(v) : null,
        },

        /**
         * Controls whether basePrice tracks the provider's rawPrice.
         *   'manual' (default) → admin-owned price, sync never overwrites.
         *   'sync'             → price auto-updates on each sync run.
         */
        pricingMode: {
            type: String,
            enum: Object.values(PRICING_MODES),
            default: PRICING_MODES.MANUAL,
        },

        /**
         * Whether to auto-sync basePrice from providerPrice on each sync run.
         * Semantic alias for pricingMode=sync, used by the frontend toggle.
         */
        syncPriceWithProvider: {
            type: Boolean,
            default: true,
        },

        /**
         * When true, admin has set a manual price adjustment (manualPriceAdjustment)
         * on top of the provider's raw price, instead of using standard markup logic.
         */
        enableManualPrice: {
            type: Boolean,
            default: false,
        },

        /**
         * Absolute amount added to (or subtracted from) providerPrice.
         * Only applied when enableManualPrice is true.
         *   finalPrice = providerPrice + manualPriceAdjustment
         */
        manualPriceAdjustment: {
            type: String,
            default: '0',
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        // ── Lifecycle ──────────────────────────────────────────────────────────

        isActive: {
            type: Boolean,
            default: true,
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },

        executionType: {
            type: String,
            enum: Object.values(EXECUTION_TYPES),
            default: EXECUTION_TYPES.MANUAL,
        },

        /**
         * LEGACY keeps the existing scalar provider/providerProduct behavior.
         * MULTI_PROVIDER requires an explicitly configured ProductProviderOffer.
         * Existing Products deliberately default to LEGACY even if mappings exist.
         */
        providerRoutingMode: {
            type: String,
            enum: Object.values(PROVIDER_ROUTING_MODES),
            default: PROVIDER_ROUTING_MODES.LEGACY,
        },

        // ── Provider Linkage ──────────────────────────────────────────────────

        /**
         * The Provider this product originates from.
         * Null for manually-created platform products.
         */
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            default: null,
            index: true,
        },

        /**
         * The raw ProviderProduct this Product was published from.
         * The sync engine reads this reference to push price updates.
         * UNIQUE: one ProviderProduct → at most one published Product.
         */
        providerProduct: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ProviderProduct',
            default: null,
        },

        // ── Audit ─────────────────────────────────────────────────────────────

        /** Admin user who created this product. */
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        // ── Dynamic Order Fields ───────────────────────────────────────────────

        /**
         * Ordered list of custom input fields the customer must fill in when
         * placing an order for this product.
         *
         * Examples: Player ID, Server, Account Email, Gift Note, etc.
         *
         * The frontend builds its order form dynamically from this array.
         * The backend validates submitted values against these definitions
         * before accepting the order.
         */
        orderFields: {
            type: [
                {
                    /** Internal stable identifier (e.g. "field_1"). Admin-managed. */
                    id: {
                        type: String,
                        trim: true,
                        required: [true, 'orderField.id is required'],
                    },

                    /** Human-readable label shown to the customer. */
                    label: {
                        type: String,
                        trim: true,
                        required: [true, 'orderField.label is required'],
                    },

                    /**
                     * Programmatic key used as the map key in Order.customerInput.values.
                     * Must be unique within the product's orderFields array.
                     * Use snake_case (e.g. "player_id", "server").
                     */
                    key: {
                        type: String,
                        trim: true,
                        required: [true, 'orderField.key is required'],
                        match: [/^[a-z][a-z0-9_]*$/, 'orderField.key must be lowercase snake_case'],
                    },

                    /** Input type — controls frontend widget and backend type validation. */
                    type: {
                        type: String,
                        enum: {
                            values: Object.values(FIELD_TYPES),
                            message: `orderField.type must be one of: ${Object.values(FIELD_TYPES).join(', ')}`,
                        },
                        required: [true, 'orderField.type is required'],
                    },

                    /** Input placeholder text shown to the customer. */
                    placeholder: {
                        type: String,
                        trim: true,
                        default: null,
                    },

                    /** If true, the backend rejects the order when this field is missing. */
                    required: {
                        type: Boolean,
                        default: true,
                    },

                    /**
                     * Allowed options for type=select.
                     * Backend validation rejects any value not in this list.
                     */
                    options: {
                        type: [String],
                        default: [],
                    },

                    /**
                     * Min / max bounds for type=number fields.
                     * Backend validator enforces these constraints.
                     * Ignored for non-number types.
                     */
                    min: {
                        type: Number,
                        default: null,
                    },

                    max: {
                        type: Number,
                        default: null,
                    },

                    /** Controls display order in the frontend form. Lower = first. */
                    sortOrder: {
                        type: Number,
                        default: 0,
                    },

                    /**
                     * Inactive fields are invisible to customers and skipped by
                     * the backend validator — they do NOT appear in the order snapshot.
                     */
                    isActive: {
                        type: Boolean,
                        default: true,
                    },

                    isVerifiable: {
                        type: Boolean,
                        default: false,
                    },
                },
            ],
            default: [],
        },

        /**
         * Lightweight dynamic fields definition used by the admin form builder.
         * Supports frontend payloads like:
         *   { "Player ID": "123", "Server": "MENA" }
         */
        dynamicFields: {
            type: [
                {
                    name: {
                        type: String,
                        trim: true,
                        required: [true, 'dynamicField.name is required'],
                    },
                    label: {
                        type: String,
                        trim: true,
                        required: [true, 'dynamicField.label is required'],
                    },
                    type: {
                        type: String,
                        enum: DYNAMIC_FIELD_TYPES,
                        default: 'text',
                    },
                    required: {
                        type: Boolean,
                        default: true,
                    },
                    isVerifiable: {
                        type: Boolean,
                        default: false,
                    },
                },
            ],
            default: [],
        },

        // ── Provider Field Mapping ─────────────────────────────────────────────

        /**
         * Maps internal order field keys → provider parameter names.
         *
         * When placing an order with a provider, the fulfillment engine
         * uses this map to translate customerInput.values into the
         * exact parameter names the provider API expects.
         *
         * Example:
         *   Internal key   → Provider param
         *   { player_id → "link", server → "server_id" }
         *
         * Keys NOT present in this map are passed through unchanged.
         * Only applies to AUTOMATIC products with a provider link.
         */
        providerMapping: {
            type: Map,
            of: String,
            default: {},
        },
    },
    {
        timestamps: true,
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

productSchema.index({ name: 1 });
productSchema.index({ isActive: 1 });
productSchema.index({ provider: 1, isActive: 1 });        // provider product listings
productSchema.index({ providerProduct: 1 });               // price-sync: find Products by ProviderProduct
productSchema.index({ pricingMode: 1, provider: 1 });     // price-sync: find 'sync' mode candidates
productSchema.index({ isActive: 1, displayOrder: 1 });    // user-facing product list
productSchema.index({ deletedAt: 1 }, { sparse: true });   // fast filter for non-deleted products

productSchema.pre('save', async function (next) {
    try {
        if (this.isNew && !this.compatProductId) {
            this.compatProductId = await getNextSequence('compatProductId', 999);
        }
        next();
    } catch (err) {
        next(err);
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute finalPrice = providerPrice + markup.
 * Pure function — does not mutate anything.
 *
 * @param {string|number} providerPrice
 * @param {'percentage'|'fixed'} markupType
 * @param {string|number} markupValue
 * @returns {string|null} arbitrary-precision string (up to 50 dp)
 */
const computeFinalPrice = (providerPrice, markupType, markupValue) => {
    if (!isPositive(providerPrice)) return null;
    return computeMarkup(providerPrice, markupType, markupValue);
};

const Product = mongoose.model('Product', productSchema);

module.exports = {
    Product,
    PRICING_MODES,
    MARKUP_TYPES,
    EXECUTION_TYPES,
    PROVIDER_ROUTING_MODES,
    FIELD_TYPES,
    DYNAMIC_FIELD_TYPES,
    computeFinalPrice,
};
