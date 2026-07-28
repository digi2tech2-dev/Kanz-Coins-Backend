'use strict';

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/database');
const { backfillReferralCodes } = require('../src/modules/referrals/referralBackfill.service');

const shouldWrite = process.argv.includes('--write');
const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const batchSize = Math.max(1, Math.min(1000, Number(batchArg?.split('=')[1]) || 250));

const main = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required.');
    }

    await connectDB();

    const result = await backfillReferralCodes({
        dryRun: !shouldWrite,
        batchSize,
    });

    console.log(`Users scanned: ${result.scanned}`);
    console.log(`Users missing referralCode: ${result.missing}`);
    console.log(`Users updated: ${result.updated}`);
    console.log(`Users skipped because they already had a code: ${result.skipped}`);
    console.log(`Batch size: ${result.batchSize}`);

    if (!shouldWrite) {
        console.log('Dry run only. Re-run with --write to apply referral codes.');
    }
};

main()
    .then(async () => {
        await mongoose.disconnect();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error(err.message || err);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
