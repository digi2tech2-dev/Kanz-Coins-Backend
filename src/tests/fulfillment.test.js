'use strict';

/**
 * fulfillment.test.js -- Provider Fulfillment Engine Test Suite
 *
 * [1] Status Mapper
 * [2] executeOrder - cases A/B/C/D
 * [3] refundFailedOrder - idempotency
 * [4] processOrderStatusResult
 * [5] pollProcessingOrders - cron batch
 * [6] createOrder with AUTOMATIC executionType
 */

const mongoose = require('mongoose');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES, MAX_RETRY_COUNT } = require('../modules/orders/order.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { toInternalStatus, isTerminal, requiresRefund } = require('../modules/providers/statusMapper');
const { executeOrder, refundFailedOrder, processOrderStatusResult, pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const { createOrder } = require('../modules/orders/order.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');
const { PROVIDER_ACTIONS, ORDER_ACTIONS } = require('../modules/audit/audit.constants');
const { User } = require('../modules/users/user.model');

// Lifecycle
beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

// Mock provider factory
const makeMockProvider = (overrides = {}) => ({
    placeOrder: overrides.placeOrder ?? jest.fn(),
    checkOrder: overrides.checkOrder ?? jest.fn(),
    checkOrdersBatch: overrides.checkOrdersBatch ?? jest.fn().mockResolvedValue([]),
    fetchProducts: overrides.fetchProducts ?? jest.fn().mockResolvedValue([]),
    getMyInfo: overrides.getMyInfo ?? jest.fn().mockResolvedValue({}),
});

const uniqueOrderNumber = () => `T-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Create an Order document bypassing the service.
 * makeOrderDoc does NOT modify the user's walletBalance in MongoDB.
 * Use walletDeducted in overrides to set what should be refunded.
 */
const makeOrderDoc = async (userId, overrides = {}) => {
    const { group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    const product = await createProduct({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });

    const [order] = await Order.create([{
        userId,
        productId: product._id,
        orderNumber: uniqueOrderNumber(),
        quantity: 1,
        unitPrice: 50,
        totalPrice: 50,
        basePriceSnapshot: 50,
        markupPercentageSnapshot: 0,
        finalPriceCharged: 50,
        groupIdSnapshot: group._id,
        walletDeducted: 50,
        creditUsedAmount: 0,
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        ...overrides,
    }]);
    return order;
};

// ============================================================================
// [1] Status Mapper
// ============================================================================

describe('[1] Status Mapper', () => {
    it("maps 'Completed' to COMPLETED", () => {
        expect(toInternalStatus('Completed')).toBe(ORDER_STATUS.COMPLETED);
    });

    it("maps 'Pending' to PROCESSING", () => {
        expect(toInternalStatus('Pending')).toBe(ORDER_STATUS.PROCESSING);
    });

    it("maps 'Cancelled' to CANCELED", () => {
        expect(toInternalStatus('Cancelled')).toBe(ORDER_STATUS.CANCELED);
    });

    it('is case-insensitive', () => {
        expect(toInternalStatus('COMPLETED')).toBe(ORDER_STATUS.COMPLETED);
        expect(toInternalStatus('pending')).toBe(ORDER_STATUS.PROCESSING);
        expect(toInternalStatus('cancelled')).toBe(ORDER_STATUS.CANCELED);
        expect(toInternalStatus('canceled')).toBe(ORDER_STATUS.CANCELED);
    });

    it('keeps unknown status in PROCESSING for safe retry', () => {
        expect(toInternalStatus('Unknown')).toBe(ORDER_STATUS.PROCESSING);
    });

    it('isTerminal returns true for Completed and Cancelled', () => {
        expect(isTerminal('Completed')).toBe(true);
        expect(isTerminal('Cancelled')).toBe(true);
        expect(isTerminal('Pending')).toBe(false);
    });

    it('requiresRefund returns true only for Cancelled', () => {
        expect(requiresRefund('Cancelled')).toBe(true);
        expect(requiresRefund('canceled')).toBe(true);
        expect(requiresRefund('Completed')).toBe(false);
        expect(requiresRefund('Pending')).toBe(false);
    });
});

// ============================================================================
// [2] executeOrder -- Cases A / B / C / D
// ============================================================================

describe('[2] executeOrder -- provider cases', () => {
    let customer;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 }));
    });

    it('Case A: success=true + Completed -> order COMPLETED, no refund', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 9001,
                providerStatus: 'Completed',
                rawResponse: { order: 9001, status: 'Completed' },
                errorMessage: null,
            }),
        });

        const { order: updated } = await executeOrder(order._id, provider);

        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerOrderId).toBe(9001);
        expect(updated.refunded).toBe(false);
    });

    it('Case B: success=true + Pending -> stays PROCESSING, providerOrderId saved', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 9002,
                providerStatus: 'Pending',
                rawResponse: { order: 9002, status: 'Pending' },
                errorMessage: null,
            }),
        });

        const { order: updated } = await executeOrder(order._id, provider);

        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerOrderId).toBe(9002);
        expect(updated.refunded).toBe(false);
    });

    it('Case C: success=true + Cancelled -> CANCELED + wallet refunded', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: { error: 'Out of stock' },
                errorMessage: 'Out of stock',
            }),
        });

        // makeOrderDoc does NOT debit the user wallet, so read current DB balance first
        const walletBefore = (await User.findById(customer._id)).walletBalance;

        const { order: updated, refunded } = await executeOrder(order._id, provider);

        expect(updated.status).toBe(ORDER_STATUS.CANCELED);
        expect(updated.refunded).toBe(true);
        expect(refunded).toBe(true);

        // Wallet must have increased by exactly walletDeducted (50)
        const freshCustomer = await User.findById(customer._id);
        expect(freshCustomer.walletBalance).toBe(walletBefore + order.walletDeducted);
    });

    it('Case D: success=false -> FAILED + wallet refunded', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: { error: 'API Error' },
                errorMessage: 'API Error',
            }),
        });

        const { order: updated } = await executeOrder(order._id, provider);

        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);

        const refundTxns = await WalletTransaction.find({
            userId: customer._id,
            type: 'REFUND',
        });
        expect(refundTxns.length).toBe(1);
        expect(refundTxns[0].amount).toBe(50);
    });

    it('provider placement failure never marks the order COMPLETED', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: false,
                providerOrderId: null,
                providerStatus: 'Completed',
                rawResponse: {
                    status: 'ERROR',
                    msg: 'Missing provider target/player ID',
                },
                errorMessage: 'Missing provider target/player ID',
            }),
        });

        const { order: updated } = await executeOrder(order._id, provider);

        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.status).not.toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerRawResponse).toMatchObject({
            status: 'ERROR',
            msg: 'Missing provider target/player ID',
        });
    });

    it('Guard: non-PROCESSING order -> executeOrder is a no-op', async () => {
        const order = await makeOrderDoc(customer._id, { status: ORDER_STATUS.COMPLETED });

        const provider = makeMockProvider({ placeOrder: jest.fn() });

        const { order: returned, placed } = await executeOrder(order._id, provider);

        expect(placed).toBe(false);
        expect(provider.placeOrder).not.toHaveBeenCalled();
        expect(returned.status).toBe(ORDER_STATUS.COMPLETED);
    });

    it('Audit: PROVIDER_ORDER_PLACED log written on Case B', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 9003,
                providerStatus: 'Pending',
                rawResponse: { order: 9003 },
                errorMessage: null,
            }),
        });

        await executeOrder(order._id, provider);
        await new Promise((r) => setImmediate(r));

        const log = await AuditLog.findOne({
            action: PROVIDER_ACTIONS.ORDER_PLACED,
            entityId: order._id,
        });
        expect(log).not.toBeNull();
        expect(log.metadata.providerOrderId).toBe(9003);
    });

    it('Audit: PROVIDER_ORDER_PLACE_FAILED log written on Case D', async () => {
        const order = await makeOrderDoc(customer._id);

        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: {},
                errorMessage: 'Network error',
            }),
        });

        await executeOrder(order._id, provider);
        await new Promise((r) => setImmediate(r));

        const log = await AuditLog.findOne({
            action: PROVIDER_ACTIONS.ORDER_PLACE_FAILED,
            entityId: order._id,
        });
        expect(log).not.toBeNull();
    });
});

// ============================================================================
// [3] refundFailedOrder -- idempotency
// ============================================================================

describe('[3] refundFailedOrder -- idempotency', () => {
    let customer;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup({ walletBalance: 200, creditLimit: 0 }, { percentage: 0 }));
    });

    it('first call credits wallet and sets refunded=true', async () => {
        const order = await makeOrderDoc(customer._id, {
            walletDeducted: 80,
            creditUsedAmount: 0,
            totalPrice: 80,
            unitPrice: 80,
        });

        const walletBefore = (await User.findById(customer._id)).walletBalance;

        const result = await refundFailedOrder(order);
        expect(result).toBe(true);

        const fresh = await Order.findById(order._id);
        expect(fresh.refunded).toBe(true);

        const freshCustomer = await User.findById(customer._id);
        expect(freshCustomer.walletBalance).toBe(walletBefore + 80);
    });

    it('second call returns false (no double-credit)', async () => {
        const order = await makeOrderDoc(customer._id);

        await refundFailedOrder(order);
        const secondResult = await refundFailedOrder(order);

        expect(secondResult).toBe(false);
    });

    it('creates exactly one REFUND WalletTransaction', async () => {
        const order = await makeOrderDoc(customer._id);

        await refundFailedOrder(order);
        await refundFailedOrder(order); // second attempt -- no-op

        const txns = await WalletTransaction.find({
            userId: customer._id,
            type: 'REFUND',
        });
        expect(txns.length).toBe(1);
    });
});

// ============================================================================
// [4] processOrderStatusResult
// ============================================================================

describe('[4] processOrderStatusResult', () => {
    let customer;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 }));
    });

    it('Completed -> order COMPLETED, no refund', async () => {
        const order = await makeOrderDoc(customer._id);

        const result = await processOrderStatusResult(order, {
            providerOrderId: 100,
            providerStatus: 'Completed',
            rawResponse: { status: 'Completed' },
        });

        expect(result.action).toBe('completed');
        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.COMPLETED);
        expect(fresh.refunded).toBe(false);
    });

    it('Cancelled -> order CANCELED + wallet refunded', async () => {
        const order = await makeOrderDoc(customer._id);

        const result = await processOrderStatusResult(order, {
            providerOrderId: 100,
            providerStatus: 'Cancelled',
            rawResponse: { status: 'Cancelled' },
        });

        expect(result.action).toBe('failed');
        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.CANCELED);
        expect(fresh.refunded).toBe(true);
    });

    it('Pending (below limit) -> retryCount incremented, stays PROCESSING', async () => {
        const order = await makeOrderDoc(customer._id, { retryCount: 2 });

        const result = await processOrderStatusResult(order, {
            providerOrderId: 100,
            providerStatus: 'Pending',
            rawResponse: { status: 'Pending' },
        });

        expect(result.action).toBe('pending');
        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
        expect(fresh.retryCount).toBe(3);
    });

    it(`Pending at retry limit (${MAX_RETRY_COUNT}) -> FAILED + refund`, async () => {
        const order = await makeOrderDoc(customer._id, { retryCount: MAX_RETRY_COUNT - 1 });

        const result = await processOrderStatusResult(order, {
            providerOrderId: 100,
            providerStatus: 'Pending',
            rawResponse: { status: 'Pending' },
        });

        expect(result.action).toBe('failed');
        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.FAILED);
        expect(fresh.refunded).toBe(true);
    });

    it('skips order that is not PROCESSING', async () => {
        const order = await makeOrderDoc(customer._id, { status: ORDER_STATUS.COMPLETED });

        const result = await processOrderStatusResult(order, {
            providerOrderId: 100,
            providerStatus: 'Completed',
            rawResponse: {},
        });

        expect(result.action).toBe('skipped');
    });
});

// ============================================================================
// [5] pollProcessingOrders -- cron batch
// ============================================================================

describe('[5] pollProcessingOrders -- cron batch', () => {
    let customer;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup({ walletBalance: 5000 }, { percentage: 0 }));
    });

    it('processes all PROCESSING orders and returns correct stats', async () => {
        // Unique idempotencyKeys avoid the sparse-null-index collision when
        // creating multiple orders directly for the same userId
        const o1 = await makeOrderDoc(customer._id, { providerOrderId: 1001, idempotencyKey: 'poll-k1' });
        const o2 = await makeOrderDoc(customer._id, { providerOrderId: 1002, idempotencyKey: 'poll-k2' });
        const o3 = await makeOrderDoc(customer._id, { providerOrderId: 1003, idempotencyKey: 'poll-k3' });

        const provider = makeMockProvider({
            checkOrdersBatch: jest.fn().mockResolvedValue([
                { providerOrderId: 1001, providerStatus: 'Completed', rawResponse: {} },
                { providerOrderId: 1002, providerStatus: 'Pending', rawResponse: {} },
                { providerOrderId: 1003, providerStatus: 'Cancelled', rawResponse: {} },
            ]),
        });

        const stats = await pollProcessingOrders(provider);

        expect(stats.completed).toBe(1);
        expect(stats.failed).toBe(1);
        expect(stats.pending).toBe(1);
        expect(stats.errors).toHaveLength(0);

        const freshO1 = await Order.findById(o1._id);
        const freshO3 = await Order.findById(o3._id);
        expect(freshO1.status).toBe(ORDER_STATUS.COMPLETED);
        expect(freshO3.status).toBe(ORDER_STATUS.CANCELED);
    });

    it('completed orders are NOT included in the next poll', async () => {
        const o1 = await makeOrderDoc(customer._id, { providerOrderId: 2001 });

        const provider = makeMockProvider({
            checkOrdersBatch: jest.fn().mockResolvedValue([
                { providerOrderId: 2001, providerStatus: 'Completed', rawResponse: {} },
            ]),
        });

        await pollProcessingOrders(provider);

        // Second poll -- o1 is now COMPLETED, should not appear
        const provider2 = makeMockProvider({
            checkOrdersBatch: jest.fn().mockResolvedValue([]),
        });

        const stats = await pollProcessingOrders(provider2);
        expect(stats.checked).toBe(0);
    });

    it('returns zero stats when queue is empty', async () => {
        const provider = makeMockProvider();
        const stats = await pollProcessingOrders(provider);

        expect(stats.checked).toBe(0);
        expect(stats.completed).toBe(0);
        expect(stats.failed).toBe(0);
        expect(stats.pending).toBe(0);
    });

    it('handles provider batch error gracefully - returns error in stats', async () => {
        await makeOrderDoc(customer._id, { providerOrderId: 3001 });

        const provider = makeMockProvider({
            checkOrdersBatch: jest.fn().mockRejectedValue(new Error('Timeout')),
        });

        const stats = await pollProcessingOrders(provider);

        expect(stats.errors.length).toBe(1);
        expect(stats.errors[0]).toContain('Timeout');
        expect(stats.checked).toBe(1);
    });

    it('order with no provider response stays PROCESSING', async () => {
        const order = await makeOrderDoc(customer._id, { providerOrderId: 4001 });

        const provider = makeMockProvider({
            checkOrdersBatch: jest.fn().mockResolvedValue([]),
        });

        await pollProcessingOrders(provider);

        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
    });
});

// ============================================================================
// [6] createOrder with AUTOMATIC executionType
// ============================================================================

describe('[6] createOrder -- AUTOMATIC executionType', () => {
    let customer;
    let autoProduct;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup({ walletBalance: 1000, creditLimit: 0 }, { percentage: 0 }));
        autoProduct = await createProduct({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC, basePrice: 50 });
    });

    it('AUTOMATIC product with provider injected -> order status is PROCESSING', async () => {
        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 5001,
                providerStatus: 'Pending',
                rawResponse: {},
                errorMessage: null,
            }),
        });

        const { order } = await createOrder({
            userId: customer._id,
            productId: autoProduct._id,
            quantity: 1,
            provider,
        });

        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(order.executionType).toBe(ORDER_EXECUTION_TYPES.AUTOMATIC);
    });

    it('AUTOMATIC product WITHOUT provider -> order starts PROCESSING', async () => {
        const { order } = await createOrder({
            userId: customer._id,
            productId: autoProduct._id,
            quantity: 1,
            provider: null,
        });

        // executeOrder self-resolves the provider after commit, so automatic
        // products start in PROCESSING even when no test provider is injected.
        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
    });

    it('MANUAL product always stays PENDING regardless of provider', async () => {
        const manualProduct = await createProduct({ executionType: 'manual', basePrice: 30 });
        const provider = makeMockProvider({ placeOrder: jest.fn() });

        const { order } = await createOrder({
            userId: customer._id,
            productId: manualProduct._id,
            quantity: 1,
            provider,
        });

        expect(order.status).toBe(ORDER_STATUS.PENDING);
        expect(provider.placeOrder).not.toHaveBeenCalled();
    });

    it('wallet is correctly debited regardless of executionType', async () => {
        const { order } = await createOrder({
            userId: customer._id,
            productId: autoProduct._id,
            quantity: 2,
            provider: null,
        });

        expect(order.totalPrice).toBe('100');

        const freshCustomer = await User.findById(customer._id);
        expect(freshCustomer.walletBalance).toBe(900);
    });

    it('idempotency still works for AUTOMATIC orders', async () => {
        const provider = makeMockProvider({
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 6001,
                providerStatus: 'Pending',
                rawResponse: {},
                errorMessage: null,
            }),
        });

        const key = 'idempotency-auto-001';

        const { order: o1, idempotent: i1 } = await createOrder({
            userId: customer._id,
            productId: autoProduct._id,
            quantity: 1,
            idempotencyKey: key,
            provider,
        });

        const { order: o2, idempotent: i2 } = await createOrder({
            userId: customer._id,
            productId: autoProduct._id,
            quantity: 1,
            idempotencyKey: key,
            provider,
        });

        expect(o1._id.toString()).toBe(o2._id.toString());
        expect(i1).toBe(false);
        expect(i2).toBe(true);

        // Wallet debited only once
        const freshCustomer = await User.findById(customer._id);
        expect(freshCustomer.walletBalance).toBe(950);
    });
});
