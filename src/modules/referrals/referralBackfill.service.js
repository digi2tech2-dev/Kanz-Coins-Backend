'use strict';

const { User } = require('../users/user.model');
const {
    missingReferralCodeFilter,
    assignReferralCodeIfMissing,
    calculateReferralEligibleUntil,
} = require('./referral.service');

const backfillReferralCodes = async ({ dryRun = true, batchSize = 250 } = {}) => {
    const normalizedBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || 250));
    let scanned = 0;
    let missing = 0;
    let updated = 0;
    let skipped = 0;

    const cursor = User.find(missingReferralCodeFilter)
        .select('_id referralCode')
        .sort({ _id: 1 })
        .batchSize(normalizedBatchSize)
        .cursor();

    for await (const user of cursor) {
        scanned += 1;
        missing += 1;

        if (dryRun) continue;

        const result = await assignReferralCodeIfMissing(user._id);
        if (result.updated) {
            updated += 1;
        } else {
            skipped += 1;
        }
    }

    return {
        scanned,
        missing,
        updated,
        skipped,
        batchSize: normalizedBatchSize,
        dryRun,
    };
};

const missingReferralEligibilityFilter = {
    referredBy: { $ne: null },
    referredAt: { $ne: null },
    $or: [
        { referralEligibleUntil: { $exists: false } },
        { referralEligibleUntil: null },
    ],
};

const backfillReferralEligibility = async ({ dryRun = true, batchSize = 250 } = {}) => {
    const normalizedBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || 250));
    let scanned = 0;
    let eligible = 0;
    let updated = 0;
    let skipped = 0;

    const cursor = User.find(missingReferralEligibilityFilter)
        .select('_id referredAt referralEligibleUntil')
        .sort({ _id: 1 })
        .batchSize(normalizedBatchSize)
        .cursor();

    for await (const user of cursor) {
        scanned += 1;
        const referralEligibleUntil = calculateReferralEligibleUntil(user.referredAt);
        if (!referralEligibleUntil) {
            skipped += 1;
            continue;
        }

        eligible += 1;
        if (dryRun) continue;

        const result = await User.collection.updateOne(
            {
                _id: user._id,
                ...missingReferralEligibilityFilter,
            },
            { $set: { referralEligibleUntil } }
        );
        if (result.modifiedCount === 1) {
            updated += 1;
        } else {
            skipped += 1;
        }
    }

    return {
        scanned,
        eligible,
        updated,
        skipped,
        batchSize: normalizedBatchSize,
        dryRun,
    };
};

module.exports = {
    backfillReferralCodes,
    backfillReferralEligibility,
    missingReferralEligibilityFilter,
};
