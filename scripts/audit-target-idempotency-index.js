'use strict';

const mongoose = require('mongoose');
const config = require('../src/config/config');
const { TargetOrder } = require('../src/modules/targets/target.model');

const main = async () => {
    await mongoose.connect(config.db.uri);

    const duplicates = await TargetOrder.aggregate([
        {
            $match: {
                idempotencyKey: { $type: 'string', $ne: '' },
            },
        },
        {
            $group: {
                _id: { userId: '$userId', idempotencyKey: '$idempotencyKey' },
                count: { $sum: 1 },
                orderIds: { $push: '$_id' },
            },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
    ]);

    console.log(`Target idempotency duplicate groups: ${duplicates.length}`);
    for (const item of duplicates) {
        console.log(JSON.stringify({
            userId: item._id.userId,
            idempotencyKey: item._id.idempotencyKey,
            count: item.count,
            orderIds: item.orderIds,
        }));
    }

    if (duplicates.length > 0) {
        process.exitCode = 1;
    }
};

main()
    .catch((err) => {
        console.error('Target idempotency audit failed:', err.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => null);
    });
