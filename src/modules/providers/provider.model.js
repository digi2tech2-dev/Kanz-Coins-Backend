'use strict';

const mongoose = require('mongoose');

/**
 * Provider — an external data source that supplies raw product inventory.
 *
 * Layer 1 of the 3-layer architecture:
 *   Provider → ProviderProduct → Product
 *
 * Each provider has its own HTTP API adapter. The sync engine calls the
 * adapter and writes raw data into ProviderProducts. Admins then
 * cherry-pick which raw products to expose as platform Products.
 */
const providerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Provider name is required'],
            trim: true,
            unique: true,
            minlength: [2, 'Provider name must be at least 2 characters'],
            maxlength: [100, 'Provider name cannot exceed 100 characters'],
        },

        /**
         * URL-safe identifier, e.g. "royal-crown".
         * Auto-generated from name if not supplied.
         * Used as adapter registry key.
         */
        slug: {
            type: String,
            trim: true,
            unique: true,
            sparse: true,
            lowercase: true,
        },

        /**
         * Optional adapter registry key. When set it takes precedence over
         * slug/name resolution, allowing several provider records to share one
         * adapter implementation without changing their existing slugs.
         */
        adapterType: {
            type: String,
            trim: true,
            lowercase: true,
            default: null,
        },

        /**
         * Base URL of the provider's API.
         * The adapter uses this as the root for all HTTP calls.
         */
        baseUrl: {
            type: String,
            required: [true, 'baseUrl is required'],
            trim: true,
        },

        /**
         * Primary API token / key for this provider.
         * Stored in plain text — use env vars for production secrets.
         * Aliased as apiKey for backward compatibility with existing code.
         */
        apiToken: {
            type: String,
            trim: true,
            default: null,
        },

        /**
         * @deprecated — kept for backward compatibility, maps to apiToken.
         */
        apiKey: {
            type: String,
            trim: true,
            default: null,
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        /**
         * How often (in minutes) the scheduler should sync this provider.
         * 0 = never sync automatically (manual-only).
         */
        syncInterval: {
            type: Number,
            default: 60,
            min: [0, 'syncInterval cannot be negative'],
        },

        /**
         * List of feature strings this provider supports.
         * Examples: ['placeOrder', 'checkOrder', 'checkOrdersBatch', 'fetchProducts']
         * Used by the adapter factory to validate capabilities before calling.
         */
        supportedFeatures: {
            type: [String],
            default: [],
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// ─── Virtuals ──────────────────────────────────────────────────────────────────

/**
 * effectiveToken — resolves apiToken → apiKey for backward compatibility.
 * Always use this in adapters instead of reading either field directly.
 */
providerSchema.virtual('effectiveToken').get(function () {
    return this.apiToken || this.apiKey || null;
});

// ─── Pre-save: auto-generate slug ───────────────────────────────────────────────

providerSchema.pre('save', function (next) {
    if (!this.slug && this.name) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }
    next();
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

providerSchema.index({ isActive: 1 });

const Provider = mongoose.model('Provider', providerSchema);

module.exports = { Provider };
