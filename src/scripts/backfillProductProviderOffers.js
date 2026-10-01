'use strict';

/**
 * Usage:
 *   node src/scripts/backfillProductProviderOffers.js            # dry run
 *   node src/scripts/backfillProductProviderOffers.js --apply    # explicit write
 *
 * This script is never called by startup code. It creates enabled legacy mappings
 * that are not automatically routable, without inventing currency or semantics.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { backfillLegacyProductProviderOffers } = require('../modules/products/productProviderOfferBackfill.service');

const run = async () => {
    const args = new Set(process.argv.slice(2));
    const dryRun = !args.has('--apply');
    if (args.has('--dry-run') && args.has('--apply')) {
        throw new Error('Use either --dry-run or --apply, not both.');
    }

    await connectDB();
    try {
        const result = await backfillLegacyProductProviderOffers({ dryRun });
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    run().catch(async (err) => {
        console.error(`[ProductProviderOffer backfill] ${err.message}`);
        try { await mongoose.disconnect(); } catch (_) { /* no active connection */ }
        process.exitCode = 1;
    });
}

module.exports = { run };
