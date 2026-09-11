'use strict';

/**
 * Test-only Canonical B2B upstream.
 *
 * It deliberately imports app.js rather than server.js, then exposes it on an
 * ephemeral loopback port.  That avoids cron jobs, provider sync, WhatsApp,
 * email, and every other server startup integration.
 */

const express = require('express');
const mongoose = require('mongoose');

const { User, ROLES, USER_STATUS } = require('../../modules/users/user.model');
const Group = require('../../modules/groups/group.model');
const { Product } = require('../../modules/products/product.model');
const { Order } = require('../../modules/orders/order.model');

let server;
let lastOrderRequest = null;
const checkRequests = [];

const reply = (message) => {
    if (process.send) process.send(message);
};

const syncIndexes = async () => {
    await Promise.all(Object.values(mongoose.models).map((model) =>
        model.syncIndexes().catch(() => undefined)
    ));
};

const seed = async ({ token, compatProductId }) => {
    const group = await Group.create({
        name: `Local upstream group ${Date.now()}`,
        percentage: 0,
        isActive: true,
    });

    const user = await User.create({
        name: 'Local Canonical Upstream Reseller',
        email: `local-upstream-${Date.now()}@test.invalid`,
        password: 'TestPassword@1',
        role: ROLES.CUSTOMER,
        status: USER_STATUS.ACTIVE,
        verified: true,
        groupId: group._id,
        apiToken: token,
        isApiEnabled: true,
        walletBalance: 100,
        creditLimit: 0,
        creditUsed: 0,
        currency: 'USD',
    });

    const product = await Product.create({
        name: 'Local Canonical Product',
        compatProductId,
        basePrice: '10',
        minQty: 1,
        maxQty: 1,
        isActive: true,
        executionType: 'manual',
        orderFields: [{
            id: 'player',
            key: 'player_id',
            label: 'Player ID',
            type: 'text',
            required: true,
            isActive: true,
        }],
    });

    return {
        userId: String(user._id),
        compatProductId: product.compatProductId,
        walletBalance: user.walletBalance,
    };
};

const snapshot = async ({ userId, idempotencyKey } = {}) => {
    const filter = idempotencyKey ? { userId, idempotencyKey } : { userId };
    const order = await Order.findOne(filter).sort({ createdAt: -1 }).lean();
    const user = await User.findById(userId).select('walletBalance').lean();
    return {
        orderCount: await Order.countDocuments({ userId }),
        walletBalance: user?.walletBalance ?? null,
        order: order ? {
            compatOrderId: order.compatOrderId,
            idempotencyKey: order.idempotencyKey,
            status: order.status,
            customerInput: order.customerInput,
        } : null,
    };
};

const start = async () => {
    await mongoose.connect(process.env.UPSTREAM_TEST_MONGO_URI, {
        dbName: process.env.UPSTREAM_TEST_DB_NAME,
    });
    await syncIndexes();

    // SAFE_LOCAL_PRODUCTION_MODE is supplied by the parent before app.js is
    // loaded, so automatic default-setting seeding is disabled as well.
    const app = require('../../app');
    const upstream = express();
    upstream.use(express.json());
    upstream.use((req, res, next) => {
        if (req.method === 'POST' && req.path === '/client/api/orders') {
            lastOrderRequest = {
                method: req.method,
                path: req.path,
                body: req.body,
            };
        }
        if (req.method === 'GET' && req.path === '/client/api/check') {
            checkRequests.push({ method: req.method, url: req.originalUrl });
        }
        next();
    });
    upstream.use(app);

    await new Promise((resolve) => {
        server = upstream.listen(0, '127.0.0.1', resolve);
    });
    reply({ type: 'ready', port: server.address().port });
};

process.on('message', async (message) => {
    try {
        if (message.type === 'seed') {
            reply({ type: 'seed', data: await seed(message.data) });
            return;
        }
        if (message.type === 'snapshot') {
            reply({ type: 'snapshot', data: await snapshot(message.data) });
            return;
        }
        if (message.type === 'last-order-request') {
            reply({ type: 'last-order-request', data: lastOrderRequest });
            return;
        }
        if (message.type === 'check-requests') {
            reply({ type: 'check-requests', data: checkRequests });
            return;
        }
        if (message.type === 'shutdown') {
            if (server) await new Promise((resolve) => server.close(resolve));
            await mongoose.disconnect();
            process.exit(0);
        }
    } catch (error) {
        // Never echo IPC input (which includes the test API token).
        reply({ type: 'error', message: error.message });
    }
});

start().catch((error) => {
    reply({ type: 'error', message: error.message });
    process.exit(1);
});
