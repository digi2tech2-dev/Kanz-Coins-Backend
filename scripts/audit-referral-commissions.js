'use strict';

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/database');
const { DepositRequest, DEPOSIT_STATUS } = require('../src/modules/deposits/deposit.model');
const { User } = require('../src/modules/users/user.model');
const { ReferralCommission } = require('../src/modules/referrals/referralCommission.model');

const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const batchSize = Math.max(1, Math.min(1000, Number(batchArg?.split('=')[1]) || 250));
const fromArg = process.argv.find((arg) => arg.startsWith('--from='));
const toArg = process.argv.find((arg) => arg.startsWith('--to='));

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

    const reviewedAt = {};
    const from = parseDateArg(fromArg);
    const to = parseDateArg(toArg);
    if (from) reviewedAt.$gte = from;
    if (to) reviewedAt.$lte = to;

    const filter = { status: DEPOSIT_STATUS.APPROVED };
    if (Object.keys(reviewedAt).length > 0) filter.reviewedAt = reviewedAt;

    let scanned = 0;
    let referred = 0;
    let withinWindow = 0;
    let missingEligibility = 0;
    let existingCommissions = 0;
    const markerCounts = {};

    const cursor = DepositRequest.find(filter)
        .select('_id userId reviewedAt referralCommissionProcessingStatus')
        .sort({ _id: 1 })
        .batchSize(batchSize)
        .cursor();

    for await (const deposit of cursor) {
        scanned += 1;
        markerCounts[deposit.referralCommissionProcessingStatus || 'MISSING'] =
            (markerCounts[deposit.referralCommissionProcessingStatus || 'MISSING'] || 0) + 1;

        const user = await User.findById(deposit.userId)
            .select('referredBy referredAt referralEligibleUntil')
            .lean();
        if (!user?.referredBy) continue;
        referred += 1;

        if (!user.referralEligibleUntil) {
            missingEligibility += 1;
        } else if (deposit.reviewedAt && deposit.reviewedAt.getTime() <= user.referralEligibleUntil.getTime()) {
            withinWindow += 1;
        }

        const hasCommission = await ReferralCommission.exists({ sourceId: deposit._id });
        if (hasCommission) existingCommissions += 1;
    }

    const duplicateCommissionSources = await ReferralCommission.aggregate([
        {
            $group: {
                _id: {
                    sourceType: '$sourceType',
                    sourceId: '$sourceId',
                    referrerUserId: '$referrerUserId',
                },
                count: { $sum: 1 },
            },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: 'duplicates' },
    ]).then((rows) => rows[0]?.duplicates || 0);

    console.log(`Approved deposits scanned: ${scanned}`);
    console.log(`Approved deposits from referred users: ${referred}`);
    console.log(`Approved deposits within referral window: ${withinWindow}`);
    console.log(`Referred deposits missing referralEligibleUntil: ${missingEligibility}`);
    console.log(`Existing commission records: ${existingCommissions}`);
    console.log(`Duplicate commission source groups: ${duplicateCommissionSources}`);
    console.log(`Commission marker counts: ${JSON.stringify(markerCounts)}`);
    console.log('Read-only audit. No commissions or user records were modified.');
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
