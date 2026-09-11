'use strict';

/**
 * Local-to-local integration coverage for CanonicalB2BAdapter.
 *
 * The upstream app runs in a child process against its own Mongo database and
 * listens only on 127.0.0.1. The downstream test process has a distinct
 * database on the same MongoMemoryReplSet. Neither side imports server.js.
 */

const crypto = require('crypto');
const path = require('path');
const { fork } = require('child_process');
const mongoose = require('mongoose');

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const { executeOrder } = require('../modules/orders/orderFulfillment.service');

const upstreamFixturePath = path.join(__dirname, 'fixtures', 'canonicalB2B.upstreamServer.js');
const upstreamToken = crypto.randomBytes(32).toString('hex');
const compatProductId = 700001;
const directReference = 'LOCAL-TEST-ORDER-001';
const fulfillmentReference = 'DOWNSTREAM-LOCAL-ORDER-001';

let upstream;
let upstreamPort;
let upstreamUserId;
let provider;
let adapter;

const requestUpstream = (type, data = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for upstream ${type}`)), 15000);
    const listener = (message) => {
        if (message.type === 'error') {
            clearTimeout(timeout);
            upstream.off('message', listener);
            reject(new Error(message.message));
            return;
        }
        if (message.type === type) {
            clearTimeout(timeout);
            upstream.off('message', listener);
            resolve(message.data);
        }
    };
    upstream.on('message', listener);
    upstream.send({ type, data });
});

const startUpstream = () => new Promise((resolve, reject) => {
    const upstreamDbName = `kanz_b2b_upstream_test_${process.pid}_${Date.now()}`;
    upstream = fork(upstreamFixturePath, [], {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            SAFE_LOCAL_PRODUCTION_MODE: 'true',
            UPSTREAM_TEST_MONGO_URI: process.env.MONGO_TEST_URI,
            UPSTREAM_TEST_DB_NAME: upstreamDbName,
        },
    });

    const timeout = setTimeout(() => reject(new Error('Timed out starting local upstream')), 30000);
    upstream.once('message', (message) => {
        clearTimeout(timeout);
        if (message.type === 'ready') {
            upstreamPort = message.port;
            resolve();
            return;
        }
        reject(new Error(message.message || 'Local upstream failed to start'));
    });
    upstream.once('error', reject);
});

const stopUpstream = async () => {
    if (!upstream || upstream.killed) return;
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            upstream.kill();
            resolve();
        }, 5000);
        upstream.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        upstream.send({ type: 'shutdown' });
    });
};

const connectDownstreamDatabase = async () => {
    const downstreamDbName = `kanz_b2b_downstream_test_${process.pid}_${Date.now()}`;
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: downstreamDbName });
    await Promise.all(Object.values(mongoose.models).map((model) =>
        model.syncIndexes().catch(() => undefined)
    ));
};

const upstreamSnapshot = (idempotencyKey) => requestUpstream('snapshot', {
    userId: upstreamUserId,
    idempotencyKey,
});

beforeAll(async () => {
    await startUpstream();
    const seeded = await requestUpstream('seed', { token: upstreamToken, compatProductId });
    upstreamUserId = seeded.userId;

    await connectDownstreamDatabase();
    provider = await Provider.create({
        name: 'Local Canonical Upstream',
        slug: 'local-canonical-upstream',
        adapterType: 'canonical-b2b',
        baseUrl: `http://127.0.0.1:${upstreamPort}/client/api`,
        apiToken: upstreamToken,
        isActive: true,
        syncInterval: 0,
    });
    adapter = getProviderAdapter(provider, { timeoutMs: 5000 });
});

afterAll(async () => {
    await mongoose.disconnect();
    await stopUpstream();
});

describe('CanonicalB2BAdapter local-to-local integration', () => {
    test('resolves the real factory adapter and retrieves the upstream profile over HTTP', async () => {
        expect(adapter).toBeInstanceOf(CanonicalB2BAdapter);

        const balance = await adapter.getBalance();
        expect(balance).toEqual(expect.objectContaining({
            balance: '100',
            currency: 'USD',
        }));
        expect(balance.rawResponse).not.toHaveProperty('apiToken');
    });

    test('retrieves canonical products over HTTP and syncs the real ProviderProduct record', async () => {
        const products = await adapter.getProducts();
        expect(products).toHaveLength(1);
        expect(products[0]).toMatchObject({
            externalProductId: String(compatProductId),
            rawName: 'Local Canonical Product',
            rawPrice: '10',
            minQty: 1,
            maxQty: 1,
            isActive: true,
        });
        expect(products[0].externalProductId).not.toMatch(/^[a-f\d]{24}$/i);
        expect(products[0].rawPayload).toMatchObject({
            id: compatProductId,
            currency: 'USD',
            fields: [expect.objectContaining({ key: 'player_id' })],
        });

        const result = await syncProviderProducts(provider._id);
        expect(result).toMatchObject({ totalFetched: 1 });
        expect(result.errors).toEqual([]);

        const providerProduct = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: String(compatProductId),
        }).lean();
        expect(providerProduct).toMatchObject({
            rawName: 'Local Canonical Product',
            rawPrice: '10',
            isActive: true,
        });
        expect(providerProduct.rawPayload).toMatchObject({
            fields: [expect.objectContaining({ key: 'player_id' })],
        });
    });

    test('places one real upstream order, replays its UUID safely, and checks it by ID and reference', async () => {
        const before = await upstreamSnapshot(directReference);
        expect(before).toMatchObject({ orderCount: 0, walletBalance: 100, order: null });

        const first = await adapter.placeOrder({
            externalProductId: String(compatProductId),
            quantity: 1,
            referenceId: directReference,
            player_id: '123456789',
        });
        expect(first.success).toBe(true);
        expect(first.providerOrderId).toMatch(/^ID_/);
        expect(['accept', 'wait', 'reject']).toContain(first.providerStatus);

        const capturedRequest = await requestUpstream('last-order-request');
        expect(capturedRequest).toEqual({
            method: 'POST',
            path: '/client/api/orders',
            body: {
                product_id: compatProductId,
                qty: 1,
                order_uuid: directReference,
                params: { player_id: '123456789' },
            },
        });

        const afterFirst = await upstreamSnapshot(directReference);
        expect(afterFirst).toMatchObject({
            orderCount: 1,
            walletBalance: 90,
            order: expect.objectContaining({ idempotencyKey: directReference }),
        });
        expect(afterFirst.order.compatOrderId).toBe(first.providerOrderId);

        const second = await adapter.placeOrder({
            externalProductId: String(compatProductId),
            quantity: 1,
            referenceId: directReference,
            player_id: '123456789',
        });
        const afterSecond = await upstreamSnapshot(directReference);
        expect(second).toMatchObject({ success: true, providerOrderId: first.providerOrderId });
        expect(afterSecond).toMatchObject({ orderCount: 1, walletBalance: 90 });

        const byOrderId = await adapter.checkOrder(first.providerOrderId);
        expect(byOrderId).toMatchObject({ providerOrderId: first.providerOrderId });
        expect(['accept', 'wait', 'reject']).toContain(byOrderId.providerStatus);
        expect(byOrderId.rawResponse).not.toHaveProperty('apiToken');

        const byReference = await adapter.checkOrderByReference(directReference);
        expect(byReference).toMatchObject({
            found: true,
            providerOrderId: first.providerOrderId,
        });
        expect(byReference.rawResponse).toMatchObject({ order_uuid: directReference });

        const checks = await requestUpstream('check-requests');
        expect(checks).toEqual(expect.arrayContaining([
            { method: 'GET', url: `/client/api/check?orders=${first.providerOrderId}` },
            { method: 'GET', url: `/client/api/check?uuids=${directReference}` },
        ]));
    });

    test('executes the real downstream fulfillment path against the local upstream', async () => {
        const providerProduct = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: String(compatProductId),
        });
        const group = await Group.create({ name: 'Local downstream group', percentage: 0, isActive: true });
        const downstreamUser = await User.create({
            name: 'Local Downstream Customer',
            email: 'local-downstream@test.invalid',
            password: 'TestPassword@1',
            role: ROLES.CUSTOMER,
            status: USER_STATUS.ACTIVE,
            verified: true,
            groupId: group._id,
            walletBalance: 100,
            creditLimit: 0,
            creditUsed: 0,
        });
        const downstreamProduct = await Product.create({
            name: 'Downstream Canonical Product',
            basePrice: '10',
            minQty: 1,
            maxQty: 1,
            isActive: true,
            executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
            provider: provider._id,
            providerProduct: providerProduct._id,
            providerMapping: { player_id: 'player_id' },
        });
        const order = await Order.create({
            userId: downstreamUser._id,
            productId: downstreamProduct._id,
            orderNumber: fulfillmentReference,
            quantity: 1,
            unitPrice: '10',
            totalPrice: '10',
            basePriceSnapshot: '10',
            markupPercentageSnapshot: 0,
            finalPriceCharged: '10',
            groupIdSnapshot: group._id,
            walletDeducted: 10,
            creditUsedAmount: '0',
            chargedAmount: 10,
            currency: 'USD',
            status: ORDER_STATUS.PROCESSING,
            executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
            customerInput: { values: { player_id: '123456789' }, fieldsSnapshot: [] },
        });

        const result = await executeOrder(order._id);
        expect(result.placed).toBe(true);

        const freshOrder = await Order.findById(order._id).lean();
        const upstreamOrder = await upstreamSnapshot(fulfillmentReference);
        expect(freshOrder.status).toBe(ORDER_STATUS.PROCESSING);
        expect(freshOrder.providerStatus).toBe('wait');
        expect(freshOrder.providerOrderId).toBe(upstreamOrder.order.compatOrderId);
        expect(upstreamOrder).toMatchObject({
            orderCount: 2,
            walletBalance: 80,
            order: expect.objectContaining({ idempotencyKey: fulfillmentReference }),
        });
    });
});
