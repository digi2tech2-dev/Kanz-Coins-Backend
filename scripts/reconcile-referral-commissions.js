'use strict';

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/database');
const { reconcileReferralCommissions } = require('../src/modules/referrals/referralCommission.service');

const shouldWrite = process.argv.includes('--write');
const includeAll = process.argv.includes('--all');
const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const depositArg = process.argv.find((arg) => arg.startsWith('--deposit-id='));
const fromArg = process.argv.find((arg) => arg.startsWith('--from='));
const toArg = process.argv.find((arg) => arg.startsWith('--to='));

const batchSize = Math.max(1, Math.min(1000, Number(batchArg?.split('=')[1]) || 250));

const parseDateArg = (arg) => {
    if (!arg) return null;
    const value = arg.split('=')[1];
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
    return date;
};

const main = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required.');
    }

    await connectDB();

    const result = await reconcileReferralCommissions({
        dryRun: !shouldWrite,
        batchSize,
        depositId: depositArg?.split('=')[1] || null,
        from: parseDateArg(fromArg),
        to: parseDateArg(toArg),
        failedOnly: !includeAll,
    });

    console.log(`Approved deposits scanned: ${result.scanned}`);
    console.log(`Candidates: ${result.candidates}`);
    console.log(`Processed: ${result.processed}`);
    console.log(`Commissions created: ${result.created}`);
    console.log(`Commissions already existing: ${result.alreadyExists}`);
    console.log(`Still failed: ${result.failed}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Batch size: ${result.batchSize}`);

    if (!shouldWrite) {
        console.log('Dry run only. Re-run with --write to reconcile failed referral commissions.');
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
