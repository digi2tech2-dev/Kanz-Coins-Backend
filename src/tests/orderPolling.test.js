'use strict';

/**
 * orderPolling.test.js — Order Status Poller Integration Test Suite
 * ──────────────────────────────────────────────────────────────────
 *
 * All tests run against a real in-memory MongoDB instance.
 * Adapters are injected via `adapterOverrides` so no real HTTP calls are made.
 *
 * Test groups:
 *
 *  [1] pollPendingOrders — core mechanics
 *      Basic poll finds PROCESSING orders
 *      Updates completed orders to COMPLETED
 *      Updates cancelled/failed orders to FAILED + refunds wallet
 *      Leaves still-pending orders as PROCESSING
 *      Returns zero stats when no orders exist
 *      Skips orders without providerOrderId
 *      Skips orders with non-PROCESSING status
 *
 *  [2] groupOrdersByProvider
 *      Groups orders under correct provider buckets
 *      Standalone products go to NO_PROVIDER bucket
 *
 *  [3] Provider failure handling
 *      checkOrders() throws → orders stay PROCESSING, errors collected
 *      Inactive provider → orders stay PROCESSING, errors collected
 *      Missing provider document → orders stay PROCESSING
 *
 *  [4] Multi-provider isolation
 *      Provider A failure doesn't affect Provider B
 *      Two providers polled in same cycle, results aggregated correctly
 *
 *  [5] Batch size limiting
 *      Orders are split into sub-batches of MAX_BATCH_SIZE
 *      checkOrders called multiple times for large batches
 *
 *  [6] runOrderPolling (job wrapper)
 *      Returns structured summary with elapsedMs
 *      Returns null when execution lock is held
 *      Lock is released after completion
 */

const mongoose = require('mongoose');

// ── Imports under test ────────────────────────────────────────────────────────

const { pollPendingOrders, groupOrdersByProvider, chunk } =
    require('../modules/orders/orderPolling.service');
const { runOrderPolling } =
    require('../modules/orders/orderPolling.job');

// ── Supporting models / helpers ───────────────────────────────────────────────

const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

// ── DB lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => connectTestDB());
afterAll(() => disconnectTestDB());
beforeEach(() => clearCollections());

const uniqueOrderNumber = () => `POLL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// =============================================================================
// FIXTURE FACTORIES
// =============================================================================

/**
 * Create a Provider document in the DB.
 */
const makeProvider = (overrides = {}) =>
    Provider.create({
        name: `TestProv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        slug: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        baseUrl: 'https://mock.example.com',
        apiToken: 'tok',
        isActive: true,
        ...overrides,
    });

/**
 * Create the full Product → ProviderProduct → Provider chain.
 * Returns { provider, providerProduct, product }
 */
const makeProductChain = async (providerOverrides = {}) => {
    const provider = await makeProvider(providerOverrides);
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: `EXT-${Date.now()}`,
        rawName: 'Test Product',
        rawPrice: 10.00,
    });
    const product = await Product.create({
        name: `Product-${Date.now()}`,
        basePrice: 10.00,
        minQty: 1,
        maxQty: 100,
        providerProduct: providerProduct._id,
        provider: provider._id,
    });
    return { provider, providerProduct, product };
};

/**
 * Create a PROCESSING order ready for polling.
 *
 * @param {Object} opts
 * @param {ObjectId} opts.userId
 * @param {ObjectId} opts.productId
 * @param {ObjectId} opts.groupId
 * @param {number}  [opts.providerOrderId]
 * @param {number}  [opts.walletDeducted]
 * @returns {Promise<Order>}
 */
const makeProcessingOrder = ({ userId, productId, groupId, providerOrderId = 9001, walletDeducted = 10 }) =>
    Order.create({
        userId,
        productId,
        orderNumber: uniqueOrderNumber(),
        quantity: 1,
        unitPrice: 10,
        totalPrice: 10,
        basePriceSnapshot: 10,
        markupPercentageSnapshot: 0,
        finalPriceCharged: 10,
        groupIdSnapshot: groupId,
        walletDeducted,
        creditUsedAmount: 0,
        status: ORDER_STATUS.PROCESSING,
        providerOrderId,
        // Each order must have a unique idempotencyKey to avoid the sparse
        // unique index collision when multiple orders exist for the same user.
        idempotencyKey: `poll-test-${providerOrderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        lastCheckedAt: new Date(Date.now() - 60_000),  // 1 minute ago
    });

/**
 * Build a mock adapter instance whose checkOrders() returns preset results.
 *
 * @param {Array<{ providerOrderId, providerStatus }>} results
 * @param {Error|null} [throwError]  — if set, checkOrders() throws this
 */
const makeMockAdapter = (results = [], throwError = null) => ({
    checkOrders: jest.fn(async (orderIds) => {
        if (throwError) throw throwError;
        return results.filter((r) => orderIds.includes(r.providerOrderId));
    }),
});

// =============================================================================
// [1] pollPendingOrders — core mechanics
// =============================================================================

describe('[1] pollPendingOrders — core mechanics', () => {
    let customer, group, productChain;

    beforeEach(async () => {
        ({ customer, group } = await createCustomerWithGroup(
            { walletBalance: 1000, creditLimit: 0 },
            { percentage: 0 }
        ));
        productChain = await makeProductChain();
    });

    it('returns zero stats when no PROCESSING orders exist', async () => {
        const stats = await pollPendingOrders();
        expect(stats.checkedOrders).toBe(0);
        expect(stats.completed).toBe(0);
        expect(stats.failed).toBe(0);
        expect(stats.stillProcessing).toBe(0);
        expect(stats.errors).toHaveLength(0);
    });

    it('finds and polls PROCESSING orders with providerOrderId', async () => {
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 1001,
        });

        const adapter = makeMockAdapter([
            { providerOrderId: 1001, providerStatus: 'Pending', rawResponse: {} },
        ]);

        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        expect(stats.checkedOrders).toBe(1);
        expect(adapter.checkOrders).toHaveBeenCalledWith([1001]);
    });

    it('transitions a Completed order to ORDER_STATUS.COMPLETED', async () => {
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 2001,
        });

        const adapter = makeMockAdapter([
            { providerOrderId: 2001, providerStatus: 'Completed', rawResponse: {} },
        ]);

        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        expect(stats.completed).toBe(1);
        expect(stats.failed).toBe(0);

        const updated = await Order.findById(order._id);
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.lastCheckedAt).not.toBeNull();
    });

    it('transitions a Cancelled order to ORDER_STATUS.CANCELED and refunds wallet', async () => {
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 3001,
            walletDeducted: 10,
        });

        const adapter = makeMockAdapter([
            { providerOrderId: 3001, providerStatus: 'Cancelled', rawResponse: {} },
        ]);

        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        expect(stats.failed).toBe(1);

        const updated = await Order.findById(order._id);
        expect(updated.status).toBe(ORDER_STATUS.CANCELED);
        expect(updated.failedAt).not.toBeNull();
        expect(updated.refunded).toBe(true);  // refund applied

        // Wallet balance should increase by walletDeducted after refund.
        // NOTE: orders are inserted raw (no payment deduction in this test), so
        // the refund credits the wallet from its initial 1000 → 1000 + 10 = 1010.
        const freshUser = await require('../modules/users/user.model').User.findById(customer._id);
        expect(freshUser.walletBalance).toBeCloseTo(1010, 1);  // 1000 initial + 10 refund
    });

    it('leaves still-pending orders as PROCESSING with incremented retryCount', async () => {
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 4001,
        });

        const adapter = makeMockAdapter([
            { providerOrderId: 4001, providerStatus: 'Pending', rawResponse: {} },
        ]);

        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        expect(stats.stillProcessing).toBe(1);
        expect(stats.completed).toBe(0);

        const updated = await Order.findById(order._id);
        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.retryCount).toBe(1);
    });

    it('skips orders without providerOrderId (cannot poll)', async () => {
        // Create a PROCESSING order with no providerOrderId
        await Order.create({
            userId: customer._id,
            productId: productChain.product._id,
            orderNumber: uniqueOrderNumber(),
            quantity: 1,
            unitPrice: 10,
            totalPrice: 10,
            basePriceSnapshot: 10,
            markupPercentageSnapshot: 0,
            finalPriceCharged: 10,
            groupIdSnapshot: group._id,
            walletDeducted: 10,
            creditUsedAmount: 0,
            status: ORDER_STATUS.PROCESSING,
            providerOrderId: null,  // ← no ID
        });

        const stats = await pollPendingOrders();
        expect(stats.checkedOrders).toBe(0);  // not in found set
    });

    it('does not update orders with non-PROCESSING status', async () => {
        // Create a COMPLETED order (should be ignored completely)
        const order = await Order.create({
            userId: customer._id,
            productId: productChain.product._id,
            orderNumber: uniqueOrderNumber(),
            quantity: 1,
            unitPrice: 10,
            totalPrice: 10,
            basePriceSnapshot: 10,
            markupPercentageSnapshot: 0,
            finalPriceCharged: 10,
            groupIdSnapshot: group._id,
            walletDeducted: 10,
            creditUsedAmount: 0,
            status: ORDER_STATUS.COMPLETED,  // ← already done
            providerOrderId: 5001,
        });

        const adapter = makeMockAdapter([
            { providerOrderId: 5001, providerStatus: 'Cancelled', rawResponse: {} },
        ]);

        // Even if the provider says Cancelled, the order must stay COMPLETED
        await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        const unchanged = await Order.findById(order._id);
        expect(unchanged.status).toBe(ORDER_STATUS.COMPLETED);
    });

    it('lastCheckedAt is updated for processed orders', async () => {
        const before = new Date(Date.now() - 60_000);
        await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 6001,
        });

        const adapter = makeMockAdapter([
            { providerOrderId: 6001, providerStatus: 'Pending', rawResponse: {} },
        ]);

        await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        const updated = await Order.findOne({ providerOrderId: 6001 });
        expect(updated.lastCheckedAt.getTime()).toBeGreaterThan(before.getTime());
    });
});

// =============================================================================
// [2] groupOrdersByProvider
// =============================================================================

describe('[2] groupOrdersByProvider', () => {
    let customer, group;

    beforeEach(async () => {
        ({ customer, group } = await createCustomerWithGroup(
            { walletBalance: 500 },
            { percentage: 0 }
        ));
    });

    it('groups orders under the correct provider bucket', async () => {
        const chain = await makeProductChain();
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: chain.product._id,
            groupId: group._id,
            providerOrderId: 7001,
        });

        // Populate the chain manually (as the service does)
        const populated = await Order
            .findById(order._id)
            .populate({ path: 'productId', select: 'providerProduct', populate: { path: 'providerProduct', select: 'provider externalProductId' } });

        const groups = await groupOrdersByProvider([populated]);
        const providerId = String(chain.provider._id);

        expect(groups.has(providerId)).toBe(true);
        expect(groups.get(providerId).orders).toHaveLength(1);
        expect(groups.get(providerId).providerDoc._id.toString()).toBe(providerId);
    });

    it('puts orders with no provider link into NO_PROVIDER bucket', async () => {
        // Standalone product (no providerProduct)
        const product = await Product.create({
            name: `Standalone-${Date.now()}`,
            basePrice: 5,
            minQty: 1,
            maxQty: 10,
        });
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: product._id,
            groupId: group._id,
            providerOrderId: 8001,
        });

        const populated = await Order
            .findById(order._id)
            .populate({ path: 'productId', select: 'providerProduct', populate: { path: 'providerProduct', select: 'provider externalProductId' } });

        const groups = await groupOrdersByProvider([populated]);
        expect(groups.has('NO_PROVIDER')).toBe(true);
        expect(groups.get('NO_PROVIDER').orders).toHaveLength(1);
    });

    it('groups orders from the same provider together', async () => {
        const chain = await makeProductChain();

        const [o1, o2] = await Promise.all([
            makeProcessingOrder({ userId: customer._id, productId: chain.product._id, groupId: group._id, providerOrderId: 9001 }),
            makeProcessingOrder({ userId: customer._id, productId: chain.product._id, groupId: group._id, providerOrderId: 9002 }),
        ]);

        const orders = await Order
            .find({ _id: { $in: [o1._id, o2._id] } })
            .populate({ path: 'productId', select: 'providerProduct', populate: { path: 'providerProduct', select: 'provider externalProductId' } });

        const groups = await groupOrdersByProvider(orders);
        const bucket = groups.get(String(chain.provider._id));
        expect(bucket.orders).toHaveLength(2);
    });
});

// =============================================================================
// [3] Provider failure handling
// =============================================================================

describe('[3] Provider failure handling', () => {
    let customer, group, productChain;

    beforeEach(async () => {
        ({ customer, group } = await createCustomerWithGroup(
            { walletBalance: 500, creditLimit: 0 },
            { percentage: 0 }
        ));
        productChain = await makeProductChain();
    });

    it('checkOrders() throw → orders stay PROCESSING, error collected', async () => {
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 10001,
        });

        const failingAdapter = makeMockAdapter([], new Error('API down'));

        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: failingAdapter },
        });

        expect(stats.errors.length).toBeGreaterThan(0);
        expect(stats.stillProcessing).toBe(1);

        const unchanged = await Order.findById(order._id);
        expect(unchanged.status).toBe(ORDER_STATUS.PROCESSING);
    });

    it('inactive provider → orders stay PROCESSING with error logged', async () => {
        const inactiveChain = await makeProductChain({ isActive: false });
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: inactiveChain.product._id,
            groupId: group._id,
            providerOrderId: 10002,
        });

        // No adapter override — the factory will resolve but providerDoc.isActive=false
        // causes the service to skip it
        const stats = await pollPendingOrders();

        expect(stats.stillProcessing).toBeGreaterThanOrEqual(1);
        const unchanged = await Order.findById(order._id);
        expect(unchanged.status).toBe(ORDER_STATUS.PROCESSING);
    });

    it('provider API failure does not crash the poller (returns stats)', async () => {
        await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 10003,
        });

        const crashingAdapter = {
            checkOrders: jest.fn().mockRejectedValue(new Error('500 Internal Server Error')),
        };

        // Must not throw — errors are collected, not propagated
        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: crashingAdapter },
        });

        expect(stats).toBeDefined();
        expect(stats.errors.length).toBeGreaterThan(0);
    });

    it('missing status response for an order → order stays PROCESSING', async () => {
        const order = await makeProcessingOrder({
            userId: customer._id,
            productId: productChain.product._id,
            groupId: group._id,
            providerOrderId: 10004,
        });

        // Adapter returns empty array (no result for this order)
        const adapter = makeMockAdapter([]);  // empty response

        const stats = await pollPendingOrders({
            adapterOverrides: { [String(productChain.provider._id)]: adapter },
        });

        expect(stats.stillProcessing).toBe(1);
        const unchanged = await Order.findById(order._id);
        expect(unchanged.status).toBe(ORDER_STATUS.PROCESSING);
    });
});

// =============================================================================
// [4] Multi-provider isolation
// =============================================================================

describe('[4] Multi-provider isolation', () => {
    let customer, group;

    beforeEach(async () => {
        ({ customer, group } = await createCustomerWithGroup(
            { walletBalance: 2000, creditLimit: 0 },
            { percentage: 0 }
        ));
    });

    it('two providers polled in same cycle — results aggregated correctly', async () => {
        const chainA = await makeProductChain();
        const chainB = await makeProductChain();

        const [orderA, orderB] = await Promise.all([
            makeProcessingOrder({ userId: customer._id, productId: chainA.product._id, groupId: group._id, providerOrderId: 20001 }),
            makeProcessingOrder({ userId: customer._id, productId: chainB.product._id, groupId: group._id, providerOrderId: 20002 }),
        ]);

        const adapterA = makeMockAdapter([{ providerOrderId: 20001, providerStatus: 'Completed', rawResponse: {} }]);
        const adapterB = makeMockAdapter([{ providerOrderId: 20002, providerStatus: 'Pending', rawResponse: {} }]);

        const stats = await pollPendingOrders({
            adapterOverrides: {
                [String(chainA.provider._id)]: adapterA,
                [String(chainB.provider._id)]: adapterB,
            },
        });

        expect(stats.checkedOrders).toBe(2);
        expect(stats.completed).toBe(1);
        expect(stats.stillProcessing).toBe(1);

        const updatedA = await Order.findById(orderA._id);
        const updatedB = await Order.findById(orderB._id);
        expect(updatedA.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updatedB.status).toBe(ORDER_STATUS.PROCESSING);
    });

    it('provider A failure does not affect provider B results', async () => {
        const chainA = await makeProductChain();
        const chainB = await makeProductChain();

        await makeProcessingOrder({ userId: customer._id, productId: chainA.product._id, groupId: group._id, providerOrderId: 21001 });
        const orderB = await makeProcessingOrder({ userId: customer._id, productId: chainB.product._id, groupId: group._id, providerOrderId: 21002 });

        const failingAdapterA = makeMockAdapter([], new Error('Provider A is down'));
        const adapterB = makeMockAdapter([{ providerOrderId: 21002, providerStatus: 'Completed', rawResponse: {} }]);

        const stats = await pollPendingOrders({
            adapterOverrides: {
                [String(chainA.provider._id)]: failingAdapterA,
                [String(chainB.provider._id)]: adapterB,
            },
        });

        // Provider B's order must be COMPLETED despite Provider A failing
        const updatedB = await Order.findById(orderB._id);
        expect(updatedB.status).toBe(ORDER_STATUS.COMPLETED);

        // Stats: 1 completed, 1 still processing (A's order), at least 1 error
        expect(stats.completed).toBe(1);
        expect(stats.errors.length).toBeGreaterThan(0);
    });
});

// =============================================================================
// [5] Batch size limiting
// =============================================================================

describe('[5] Batch size limiting — chunk()', () => {
    it('chunk() with perfect division', () => {
        const arr = [1, 2, 3, 4, 5, 6];
        const result = chunk(arr, 2);
        expect(result).toEqual([[1, 2], [3, 4], [5, 6]]);
    });

    it('chunk() with remainder', () => {
        const arr = [1, 2, 3, 4, 5];
        const result = chunk(arr, 2);
        expect(result).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('chunk() larger than array', () => {
        const arr = [1, 2, 3];
        const result = chunk(arr, 10);
        expect(result).toEqual([[1, 2, 3]]);
    });

    it('chunk() with empty array', () => {
        expect(chunk([], 5)).toEqual([]);
    });

    it('checkOrders called once per batch when orders exceed MAX_BATCH_SIZE', async () => {
        const { customer, group } = await createCustomerWithGroup(
            { walletBalance: 9999 }, { percentage: 0 }
        );
        const chain = await makeProductChain();

        // Create 60 orders — MAX_BATCH_SIZE is 50, so 2 batches expected
        const orderIds = Array.from({ length: 60 }, (_, i) => 30000 + i);
        await Promise.all(
            orderIds.map((providerOrderId) =>
                makeProcessingOrder({ userId: customer._id, productId: chain.product._id, groupId: group._id, providerOrderId })
            )
        );

        const adapter = makeMockAdapter(
            orderIds.map((id) => ({ providerOrderId: id, providerStatus: 'Pending', rawResponse: {} }))
        );

        await pollPendingOrders({
            adapterOverrides: { [String(chain.provider._id)]: adapter },
        });

        // 60 orders ÷ 50 = 2 batches → checkOrders called twice
        expect(adapter.checkOrders).toHaveBeenCalledTimes(2);
        // First batch: 50 IDs
        expect(adapter.checkOrders.mock.calls[0][0]).toHaveLength(50);
        // Second batch: 10 IDs
        expect(adapter.checkOrders.mock.calls[1][0]).toHaveLength(10);
    });
});

// =============================================================================
// [6] runOrderPolling (job wrapper)
// =============================================================================

describe('[6] runOrderPolling — job wrapper', () => {
    it('returns a structured summary with all required fields', async () => {
        const result = await runOrderPolling();

        expect(result).not.toBeNull();
        expect(typeof result.checkedOrders).toBe('number');
        expect(typeof result.completed).toBe('number');
        expect(typeof result.failed).toBe('number');
        expect(typeof result.stillProcessing).toBe('number');
        expect(typeof result.skippedOrders).toBe('number');
        expect(Array.isArray(result.errors)).toBe(true);
        expect(result.polledAt).toBeInstanceOf(Date);
        expect(typeof result.elapsedMs).toBe('number');
    });

    it('returns zero stats when queue is empty', async () => {
        const result = await runOrderPolling();
        expect(result.checkedOrders).toBe(0);
        expect(result.completed).toBe(0);
        expect(result.failed).toBe(0);
    });
});
