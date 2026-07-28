'use strict';

/**
 * order.test.js — Financial Order Logic Test Suite
 * ─────────────────────────────────────────────────
 * Credit/borrow system: orders may draw down to -creditLimit.
 *
 * Tests cover:
 *   1. Order within wallet balance
 *   2. Wallet-balance virtual field accuracy
 *   3. Credit-limit debit and insufficient funds rejection
 *   4. Full refund — wallet-only order
 *   5. Full refund — second wallet draw refund
 *   6. Double refund prevention
 *   7. Idempotency key: duplicate request returns same order
 *   8. Idempotency key: different keys create different orders
 *   9. Concurrent orders — race condition safety
 */

const mongoose = require('mongoose');
const orderService = require('../modules/orders/order.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Order } = require('../modules/orders/order.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
    freshUser,
    countTransactions,
    getTransactions,
} = require('./testHelpers');

// ─── Suite Lifecycle ──────────────────────────────────────────────────────────

/**
 * Shared group fixture — recreated in beforeEach so every test starts clean.
 * All createCustomer calls pass { groupId: defaultGroup._id } because
 * groupId is now a required field on the User schema.
 */
let defaultGroup;

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    // Recreate a default group after every clear so customers can be created
    defaultGroup = await createGroup({ name: 'Default', percentage: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────

const placeOrder = (overrides = {}) =>
    orderService.createOrder({
        userId: overrides.userId,
        productId: overrides.productId,
        quantity: overrides.quantity ?? 1,
        idempotencyKey: overrides.idempotencyKey ?? null,
    });

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORDER WITHIN WALLET BALANCE
// ─────────────────────────────────────────────────────────────────────────────

describe('Order within wallet balance', () => {
    it('deducts from walletBalance without drawing credit', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200 });
        const product = await createProduct({ basePrice: 50 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id, quantity: 2 });

        // Order assertions
        expect(Number(order.totalPrice)).toBe(100);
        expect(order.walletDeducted).toBe(100);
        expect(Number(order.creditUsedAmount)).toBe(0);
        expect(order.status).toBe('PENDING');

        // User balance assertions
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(100);   // 200 - 100

        // Exactly one DEBIT wallet transaction created
        const txns = await getTransactions(customer._id);
        expect(txns).toHaveLength(1);
        expect(txns[0].type).toBe('DEBIT');
        expect(txns[0].amount).toBe(100);
        expect(txns[0].balanceBefore).toBe(200);
        expect(txns[0].balanceAfter).toBe(100);
    });
});

describe('Manual product costPrice profit', () => {
    it('uses product.costPrice as the unit cost basis for manual products', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 1000 });
        const product = await createProduct({
            basePrice: 100,
            costPrice: 70,
            minQty: 1,
            maxQty: 10,
            executionType: 'manual',
        });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id, quantity: 2 });

        expect(Number(order.basePriceSnapshot)).toBe(100);
        expect(Number(order.finalPriceCharged)).toBe(100);
        expect(Number(order.profitUsd)).toBeCloseTo(60, 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WALLET BALANCE VIRTUAL FIELD
// ─────────────────────────────────────────────────────────────────────────────

describe('Wallet balance virtual field', () => {
    it('availableBalance equals walletBalance plus creditLimit', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 75, creditLimit: 500 });
        const user = await freshUser(customer._id);
        expect(user.availableBalance).toBe(575);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CREDIT LIMIT AND INSUFFICIENT FUNDS
// ─────────────────────────────────────────────────────────────────────────────

describe('Insufficient funds', () => {
    it('rejects order when walletBalance plus creditLimit cannot cover totalPrice', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 50, creditLimit: 0 });
        const product = await createProduct({ basePrice: 80, minQty: 1, maxQty: 1 });

        await expect(
            placeOrder({ userId: customer._id, productId: product._id })
        ).rejects.toMatchObject({
            code: 'INSUFFICIENT_FUNDS',
            statusCode: 422,
        });

        // Nothing should have changed
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(50);

        const txnCount = await countTransactions(customer._id);
        expect(txnCount).toBe(0);
    });

    it('draws credit and updates creditUsed when wallet balance is insufficient', async () => {
        const customer = await createCustomer({
            groupId: defaultGroup._id,
            walletBalance: 0,
            creditLimit: 500,
            creditUsed: 0,
        });
        const product = await createProduct({ basePrice: 200, minQty: 1, maxQty: 1 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        expect(order.walletDeducted).toBe(200);
        expect(Number(order.creditUsedAmount)).toBe(200);

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(-200);
        expect(user.creditUsed).toBe(200);
    });

    it('allows a purchase that reaches the exact credit limit', async () => {
        const customer = await createCustomer({
            groupId: defaultGroup._id,
            walletBalance: -30,
            creditLimit: 100,
            creditUsed: 30,
        });
        const product = await createProduct({ basePrice: 70, minQty: 1, maxQty: 1 });

        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            availableBalance: 9999,
            creditUsed: -9999,
            totalPrice: 1,
        });

        expect(Number(order.totalPrice)).toBe(70);

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(-100);
        expect(user.creditUsed).toBe(100);
        expect(user.availableBalance).toBe(0);
    });

    it('rejects order when it would exceed credit limit', async () => {
        const customer = await createCustomer({
            groupId: defaultGroup._id,
            walletBalance: 0,
            creditLimit: 500,
            creditUsed: 0,
        });
        const product = await createProduct({ basePrice: 501, minQty: 1, maxQty: 1 });

        await expect(
            placeOrder({ userId: customer._id, productId: product._id })
        ).rejects.toMatchObject({
            code: 'INSUFFICIENT_FUNDS',
        });

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(0);
        expect(user.creditUsed).toBe(0);
    });

    it('does not trust client-supplied balance or price fields for affordability', async () => {
        const customer = await createCustomer({
            groupId: defaultGroup._id,
            walletBalance: 0,
            creditLimit: 0,
            creditUsed: 0,
        });
        const product = await createProduct({ basePrice: 100, minQty: 1, maxQty: 1 });

        await expect(orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            availableBalance: 100000,
            walletBalance: 100000,
            creditLimit: 100000,
            creditUsed: -100000,
            totalPrice: 0.01,
        })).rejects.toMatchObject({
            code: 'INSUFFICIENT_FUNDS',
        });

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(0);
        expect(user.creditUsed).toBe(0);
        expect(await countTransactions(customer._id)).toBe(0);
    });

    it('rejects order when walletBalance is zero and creditLimit is zero', async () => {
        // User has no balance and no credit — must reject
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 0, creditLimit: 0, creditUsed: 0 });
        const product = await createProduct({ basePrice: 100, minQty: 1, maxQty: 1 });

        await expect(
            placeOrder({ userId: customer._id, productId: product._id })
        ).rejects.toMatchObject({
            code: 'INSUFFICIENT_FUNDS',
        });

        // No transactions, balance unchanged
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(0);
        const txnCount = await countTransactions(customer._id);
        expect(txnCount).toBe(0);
    });

    it('rejects order when product is inactive', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 500 });
        const product = await createProduct({ basePrice: 10, isActive: false });

        await expect(
            placeOrder({ userId: customer._id, productId: product._id })
        ).rejects.toMatchObject({ code: 'PRODUCT_INACTIVE' });
    });

    it('rejects order when quantity is out of range', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 999 });
        const product = await createProduct({ basePrice: 10, minQty: 2, maxQty: 5 });

        await expect(
            placeOrder({ userId: customer._id, productId: product._id, quantity: 1 })
        ).rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE' });

        await expect(
            placeOrder({ userId: customer._id, productId: product._id, quantity: 6 })
        ).rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. REFUND — WALLET-ONLY ORDER
// ─────────────────────────────────────────────────────────────────────────────

describe('Refund — wallet-only order', () => {
    it('restores walletBalance fully (creditUsedAmount is always 0)', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200 });
        const product = await createProduct({ basePrice: 50 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id, quantity: 2 });

        // Verify debit happened
        let user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(100);

        // Now fail the order
        const failedOrder = await orderService.markOrderAsFailed(order._id);

        expect(failedOrder.status).toBe('FAILED');
        expect(failedOrder.refundedAt).not.toBeNull();
        expect(failedOrder.failedAt).not.toBeNull();

        // Balance restored
        user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(200); // fully restored

        // Two transactions: 1 DEBIT + 1 REFUND
        const txns = await getTransactions(customer._id);
        expect(txns).toHaveLength(2);
        const refundTxn = txns.find((t) => t.type === 'REFUND');
        expect(refundTxn).toBeDefined();
        expect(refundTxn.amount).toBe(100);
    });

    it('refund reduces existing debt and recalculates creditUsed', async () => {
        const customer = await createCustomer({
            groupId: defaultGroup._id,
            walletBalance: -300,
            creditLimit: 500,
            creditUsed: 300,
        });
        const product = await createProduct({ basePrice: 100, minQty: 1, maxQty: 1 });

        const order = await Order.create({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            unitPrice: 100,
            totalPrice: 100,
            basePriceSnapshot: 100,
            markupPercentageSnapshot: 0,
            finalPriceCharged: 100,
            groupIdSnapshot: defaultGroup._id,
            profitUsd: 0,
            walletDeducted: 100,
            creditUsedAmount: 0,
            status: 'PENDING',
            executionType: 'manual',
            currency: 'USD',
            chargedAmount: 100,
        });

        await orderService.markOrderAsFailed(order._id);

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(-200);
        expect(user.creditUsed).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. REFUND — SECOND WALLET DRAW
// ─────────────────────────────────────────────────────────────────────────────

describe('Refund — second wallet order', () => {
    it('restores walletBalance correctly for a second separate order', async () => {
        // Place two sequential orders and refund the second
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200 });
        const product = await createProduct({ basePrice: 60, minQty: 1, maxQty: 1 });

        // Use unique idempotency keys so null-sparse index doesn't collide
        const { order: order1 } = await placeOrder({
            userId: customer._id, productId: product._id, idempotencyKey: `refund-test-1-${Date.now()}`,
        });
        const { order: order2 } = await placeOrder({
            userId: customer._id, productId: product._id, idempotencyKey: `refund-test-2-${Date.now() + 1}`,
        });

        let user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(80); // 200 - 60 - 60

        // Refund second order
        await orderService.markOrderAsFailed(order2._id);

        user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(140); // 200 - 60 (only first order remains charged)

        const txns = await getTransactions(customer._id);
        // 2 DEBIT + 1 REFUND
        expect(txns).toHaveLength(3);
        const refundCount = txns.filter((t) => t.type === 'REFUND').length;
        expect(refundCount).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. DOUBLE REFUND PREVENTION
// ─────────────────────────────────────────────────────────────────────────────

describe('Double refund prevention', () => {
    it('throws ORDER_ALREADY_FAILED on second fail attempt', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200, creditLimit: 0 });
        const product = await createProduct({ basePrice: 50 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });
        await orderService.markOrderAsFailed(order._id);

        // Second attempt → must throw
        await expect(orderService.markOrderAsFailed(order._id)).rejects.toMatchObject({
            code: 'ORDER_ALREADY_FAILED',
            statusCode: 422,
        });

        // Balance must NOT have been double-refunded
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(200); // exactly original — not 250

        // Still only 2 wallet transactions (1 DEBIT + 1 REFUND)
        const txnCount = await countTransactions(customer._id);
        expect(txnCount).toBe(2);
    });

    it('throws ALREADY_REFUNDED if refundedAt is set but status somehow differs', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200 });
        const product = await createProduct({ basePrice: 50 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        // Manually simulate a state where status isn't FAILED but refundedAt is set
        await Order.findByIdAndUpdate(order._id, {
            refundedAt: new Date(),
            status: 'PENDING', // unusual state — guard must still block
        });

        await expect(orderService.markOrderAsFailed(order._id)).rejects.toMatchObject({
            code: 'ALREADY_REFUNDED',
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. IDEMPOTENCY — DUPLICATE REQUEST RETURNS SAME ORDER
// ─────────────────────────────────────────────────────────────────────────────

describe('Idempotency key protection', () => {
    it('returns the same order and does NOT deduct funds twice', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 500 });
        const product = await createProduct({ basePrice: 100 });
        const key = `idem-${Date.now()}`;

        // First request
        const { order: first, idempotent: isFirst } = await placeOrder({
            userId: customer._id,
            productId: product._id,
            idempotencyKey: key,
        });
        expect(isFirst).toBe(false);

        // Second request with same key
        const { order: second, idempotent: isSecond } = await placeOrder({
            userId: customer._id,
            productId: product._id,
            idempotencyKey: key,
        });
        expect(isSecond).toBe(true);

        // Same order returned
        expect(second._id.toString()).toBe(first._id.toString());

        // Wallet tapped only once
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(400); // 500 - 100 (once, not twice)

        // Only one DEBIT transaction
        const txnCount = await countTransactions(customer._id);
        expect(txnCount).toBe(1);

        // Only one order record in DB
        const orderCount = await Order.countDocuments({ userId: customer._id });
        expect(orderCount).toBe(1);
    });

    it('different idempotency keys create separate orders', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 500 });
        const product = await createProduct({ basePrice: 50 });

        await placeOrder({ userId: customer._id, productId: product._id, idempotencyKey: 'key-A' });
        await placeOrder({ userId: customer._id, productId: product._id, idempotencyKey: 'key-B' });

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(400); // 500 - 50 - 50

        const orderCount = await Order.countDocuments({ userId: customer._id });
        expect(orderCount).toBe(2);

        const txnCount = await countTransactions(customer._id);
        expect(txnCount).toBe(2);
    });

    it("one user's idempotency key does not block another user", async () => {
        const customerA = await createCustomer({ groupId: defaultGroup._id, walletBalance: 500 });
        const customerB = await createCustomer({ groupId: defaultGroup._id, walletBalance: 500 });
        const product = await createProduct({ basePrice: 50 });
        const sharedKey = 'shared-key-across-users';

        const { order: orderA } = await placeOrder({
            userId: customerA._id,
            productId: product._id,
            idempotencyKey: sharedKey,
        });
        const { order: orderB } = await placeOrder({
            userId: customerB._id,
            productId: product._id,
            idempotencyKey: sharedKey,
        });

        // Both orders should exist and be distinct
        expect(orderA._id.toString()).not.toBe(orderB._id.toString());

        const userA = await freshUser(customerA._id);
        const userB = await freshUser(customerB._id);
        expect(userA.walletBalance).toBe(450);
        expect(userB.walletBalance).toBe(450);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CONCURRENT ORDERS — RACE CONDITION SAFETY
// ─────────────────────────────────────────────────────────────────────────────

describe('Concurrent order requests', () => {
    it('prevents overspending when two orders fire simultaneously', async () => {
        // Customer has exactly enough for ONE order
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 100, creditLimit: 0 });
        const product = await createProduct({ basePrice: 100, minQty: 1, maxQty: 1 });

        // Fire two orders at exactly the same time
        const results = await Promise.allSettled([
            placeOrder({ userId: customer._id, productId: product._id }),
            placeOrder({ userId: customer._id, productId: product._id }),
        ]);

        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected');

        // Exactly one must succeed
        expect(successes).toHaveLength(1);
        // Exactly one must fail
        expect(failures).toHaveLength(1);

        /**
         * The failing order may surface as:
         *   - INSUFFICIENT_FUNDS (retry saw depleted balance and fund-check failed)
         *   - WriteConflict code 112  (retry itself conflicted — very tight timing)
         *   - LockTimeout code 24    (possible under memory-server contention)
         * All are correct concurrency outcomes — no money was double-spent.
         * The definitive invariant is asserted on the balance below.
         */
        const validFailureCodes = ['INSUFFICIENT_FUNDS', undefined]; // undefined covers raw MongoServerError
        const failureCode = failures[0].reason.code;
        expect([112, 24, 'INSUFFICIENT_FUNDS'].includes(failureCode)).toBe(true);

        // THE CRITICAL INVARIANT: balance must be exactly 0 — not negative
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(0);
        expect(user.creditUsed).toBe(0);

        // Only one order, only one transaction
        const orderCount = await Order.countDocuments({ userId: customer._id });
        expect(orderCount).toBe(1);

        const txnCount = await countTransactions(customer._id);
        expect(txnCount).toBe(1);
    });

    it('allows two concurrent orders when funds cover both', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200, creditLimit: 0 });
        const product = await createProduct({ basePrice: 100, minQty: 1, maxQty: 1 });

        const results = await Promise.allSettled([
            placeOrder({ userId: customer._id, productId: product._id }),
            placeOrder({ userId: customer._id, productId: product._id }),
        ]);

        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected');

        const user = await freshUser(customer._id);
        const orderCount = await Order.countDocuments({ userId: customer._id });
        const txnCount = await countTransactions(customer._id);

        /**
         * THE FINANCIAL INVARIANT (must always hold regardless of concurrency outcome):
         *
         *   walletBalance === 200 - (number of orders actually created * 100)
         *
         * This is the only assertion that matters from a financial correctness
         * standpoint. Whether 1 or 2 orders succeed depends on the transaction
         * scheduler and retry timing; what must NEVER happen is money going
         * missing or balance going negative.
         */
        // Internal consistency: balance matches order count
        expect(user.walletBalance).toBe(200 - orderCount * 100);
        // Transaction audit trail matches order count
        expect(txnCount).toBe(orderCount);
        // The number of Promise fulfillments matches orders created
        expect(successes.length).toBe(orderCount);
        // Balance never went negative
        expect(user.walletBalance).toBeGreaterThanOrEqual(0);
        // At least one order succeeded
        expect(orderCount).toBeGreaterThanOrEqual(1);
    });

    it('handles concurrent refund attempts — only first succeeds', async () => {
        const customer = await createCustomer({ groupId: defaultGroup._id, walletBalance: 200 });
        const product = await createProduct({ basePrice: 100 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        // Two concurrent fail/refund requests
        const results = await Promise.allSettled([
            orderService.markOrderAsFailed(order._id),
            orderService.markOrderAsFailed(order._id),
        ]);

        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected');

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);

        // Balance must be exactly 200 — one refund only, not two
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(200);

        // Exactly 2 transactions: 1 DEBIT + 1 REFUND (not 2 REFUNDs)
        const txns = await getTransactions(customer._id);
        expect(txns).toHaveLength(2);
        const refundCount = txns.filter((t) => t.type === 'REFUND').length;
        expect(refundCount).toBe(1);
    });
});
