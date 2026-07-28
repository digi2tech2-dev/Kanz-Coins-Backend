'use strict';

/**
 * pricing.test.js — Pricing Engine + Snapshot Immutability Test Suite
 * ──────────────────────────────────────────────────────────────────────
 * Tests cover:
 *
 *   PART A — calculateFinalPrice (pure function, no DB)
 *   1.  Zero markup → price equals basePrice
 *   2.  Standard markup: 100 + 15% = 115
 *   3.  Fractional result is rounded to 2 decimal places
 *   4.  Large percentage: 50 + 200% = 150
 *   5.  Large basePrice × large percentage
 *   6.  Zero basePrice → finalPrice = 0 (no markup on nothing)
 *   7.  Negative basePrice → BusinessRuleError (INVALID_BASE_PRICE)
 *   8.  Negative percentage → BusinessRuleError (INVALID_PERCENTAGE)
 *   9.  Non-number basePrice → BusinessRuleError
 *   10. Non-number percentage → BusinessRuleError
 *
 *   PART B — calculateUserPrice (DB-backed)
 *   11. Returns correct tuple for a user with an active group
 *   12. Applies markup correctly to basePrice
 *   13. User not found → NotFoundError
 *   14. User has inactive group → BusinessRuleError (GROUP_INACTIVE)
 *
 *   PART C — Snapshot Immutability (integration with order creation)
 *   15. Order stores all four snapshot fields on creation
 *   16. basePriceSnapshot = product.basePrice (before any markup)
 *   17. markupPercentageSnapshot matches group.percentage at order time
 *   18. finalPriceCharged = basePrice + (basePrice × % / 100)
 *   19. Updating group percentage AFTER order → snapshot fields unchanged
 *   20. Changing user's group AFTER order → groupIdSnapshot unchanged
 *   21. finalPriceCharged is used as the deduction basis (totalPrice = finalPrice × qty)
 */

const { calculateFinalPrice, calculateUserPrice } = require('../modules/orders/pricing.service');
const orderService = require('../modules/orders/order.service');
const groupService = require('../modules/groups/group.service');
const { Order } = require('../modules/orders/order.model');
const { User } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createCustomerWithGroup,
    createProduct,
    freshUser,
} = require('./testHelpers');

// ─── Suite Lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

// ─── Helper: place order using the full service stack ────────────────────────

const placeOrder = ({ userId, productId, quantity = 1, idempotencyKey = null }) =>
    orderService.createOrder({ userId, productId, quantity, idempotencyKey });

// ─────────────────────────────────────────────────────────────────────────────
// PART A — calculateFinalPrice (pure, no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateFinalPrice — pure function', () => {
    it('returns basePrice unchanged when percentage = 0', () => {
        expect(calculateFinalPrice(100, 0)).toBe('100');
        expect(calculateFinalPrice(29.99, 0)).toBe('29.99');
    });

    it('applies 15% markup correctly: 100 × 1.15 = 115', () => {
        expect(calculateFinalPrice(100, 15)).toBe('115');
    });

    it('preserves arbitrary precision until wallet charging', () => {
        // 9.99 × 1.15 = 11.4885; chargedAmount is rounded later.
        expect(calculateFinalPrice(9.99, 15)).toBe('11.4885');
        expect(calculateFinalPrice(10, 33.333)).toBe('13.3333');
    });

    it('applies 200% markup: 50 + 100 = 150', () => {
        expect(calculateFinalPrice(50, 200)).toBe('150');
    });

    it('handles large values accurately', () => {
        expect(calculateFinalPrice(99999.99, 25)).toBe('124999.9875');
    });

    it('returns 0 when basePrice = 0 (no markup on nothing)', () => {
        expect(calculateFinalPrice(0, 50)).toBe('0');
    });

    it('throws INVALID_BASE_PRICE for negative basePrice', () => {
        expect(() => calculateFinalPrice(-1, 10)).toThrow(
            expect.objectContaining({ code: 'INVALID_BASE_PRICE' })
        );
    });

    it('throws INVALID_PERCENTAGE for negative percentage', () => {
        expect(() => calculateFinalPrice(100, -5)).toThrow(
            expect.objectContaining({ code: 'INVALID_PERCENTAGE' })
        );
    });

    it('accepts numeric string basePrice and rejects null basePrice', () => {
        expect(calculateFinalPrice('100', 10)).toBe('110');
        expect(() => calculateFinalPrice(null, 10)).toThrow(
            expect.objectContaining({ code: 'INVALID_BASE_PRICE' })
        );
    });

    it('accepts numeric string percentage and rejects missing percentage', () => {
        expect(calculateFinalPrice(100, '10')).toBe('110');
        expect(() => calculateFinalPrice(100, undefined)).toThrow(
            expect.objectContaining({ code: 'INVALID_PERCENTAGE' })
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART B — calculateUserPrice (DB-backed)
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateUserPrice — DB-backed', () => {
    it('returns correct pricing tuple for a user with an active group', async () => {
        const group = await createGroup({ name: 'Silver', percentage: 20 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 999 });

        const result = await calculateUserPrice(customer._id, 100);

        expect(result).toMatchObject({
            basePrice: '100',
            markupPercentage: 20,
            finalPrice: '120',        // 100 + 20%
            groupId: group._id,
        });
    });

    it('correctly applies the group markup to basePrice', async () => {
        const group = await createGroup({ name: 'Gold', percentage: 15 });
        const customer = await createCustomer({ groupId: group._id });

        const { finalPrice } = await calculateUserPrice(customer._id, 9.99);

        // 9.99 × 1.15 = 11.4885 → rounds to 11.49
        expect(finalPrice).toBe('11.4885');
    });

    it('returns finalPrice = basePrice when group percentage = 0', async () => {
        const group = await createGroup({ name: 'Standard', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id });

        const { finalPrice, markupPercentage } = await calculateUserPrice(customer._id, 50);

        expect(markupPercentage).toBe(0);
        expect(finalPrice).toBe('50');
    });

    it('throws NotFoundError for a non-existent userId', async () => {
        const mongoose = require('mongoose');
        const fakeId = new mongoose.Types.ObjectId();

        await expect(
            calculateUserPrice(fakeId, 100)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws GROUP_INACTIVE when user belongs to an inactive group', async () => {
        const inactiveGroup = await Group.create({
            name: 'Dormant',
            percentage: 10,
            isActive: false,
        });
        const customer = await createCustomer({ groupId: inactiveGroup._id });

        await expect(
            calculateUserPrice(customer._id, 100)
        ).rejects.toMatchObject({ code: 'GROUP_INACTIVE' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART C — Snapshot Immutability (integrated with order creation)
// ─────────────────────────────────────────────────────────────────────────────

describe('Order snapshot fields', () => {
    it('stores all four snapshot fields on order creation', async () => {
        const group = await createGroup({ name: 'Platinum', percentage: 25 });
        const customer = await createCustomer({
            groupId: group._id,
            walletBalance: 999,
        });
        const product = await createProduct({ basePrice: 100 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        expect(order.basePriceSnapshot).toBeDefined();
        expect(order.markupPercentageSnapshot).toBeDefined();
        expect(order.finalPriceCharged).toBeDefined();
        expect(order.groupIdSnapshot).toBeDefined();
    });

    it('basePriceSnapshot equals product.basePrice (pre-markup)', async () => {
        const group = await createGroup({ name: 'G1', percentage: 20 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 999 });
        const product = await createProduct({ basePrice: 50 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        expect(order.basePriceSnapshot).toBe('50');
    });

    it('markupPercentageSnapshot equals group.percentage at order time', async () => {
        const group = await createGroup({ name: 'G2', percentage: 30 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 999 });
        const product = await createProduct({ basePrice: 100 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        expect(order.markupPercentageSnapshot).toBe(30);
    });

    it('finalPriceCharged = basePrice + (basePrice × percentage / 100)', async () => {
        const group = await createGroup({ name: 'G3', percentage: 10 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 999 });
        const product = await createProduct({ basePrice: 200 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        // 200 + 10% = 220
        expect(order.finalPriceCharged).toBe('220');
        expect(order.unitPrice).toBe('220');   // unitPrice is an alias for finalPriceCharged
    });

    it('groupIdSnapshot equals the group ID at order time', async () => {
        const group = await createGroup({ name: 'G4', percentage: 5 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 999 });
        const product = await createProduct({ basePrice: 40 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        expect(order.groupIdSnapshot.toString()).toBe(group._id.toString());
    });

    it('totalPrice = finalPriceCharged × quantity (not basePrice × qty)', async () => {
        const group = await createGroup({ name: 'G5', percentage: 20 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 9999 });
        const product = await createProduct({ basePrice: 10, maxQty: 10 });

        const { order } = await placeOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 5,
        });

        // finalPriceCharged = 10 + 20% = 12
        // totalPrice = 12 × 5 = 60
        expect(order.finalPriceCharged).toBe('12');
        expect(order.totalPrice).toBe('60');

        // Wallet was also debited by finalPrice, not basePrice
        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(9999 - 60);
    });

    it('updating group percentage AFTER order → snapshot fields are UNCHANGED', async () => {
        const group = await createGroup({ name: 'MutableGroup', percentage: 10 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 9999 });
        const product = await createProduct({ basePrice: 100 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        // Captured values at order time
        const origMarkup = order.markupPercentageSnapshot; // 10
        const origFinal = order.finalPriceCharged;        // 110
        const origBase = order.basePriceSnapshot;        // 100

        // Admin changes percentage dramatically
        await groupService.updateGroupPercentage(group._id, 99);

        // Re-fetch the Order from DB directly to bypass any cache
        const freshOrder = await Order.findById(order._id);

        expect(freshOrder.markupPercentageSnapshot).toBe(origMarkup); // still 10
        expect(freshOrder.finalPriceCharged).toBe(origFinal);         // still 110
        expect(freshOrder.basePriceSnapshot).toBe(origBase);          // still 100
    });

    it('changing user group AFTER order → groupIdSnapshot is UNCHANGED', async () => {
        const originalGroup = await createGroup({ name: 'Original', percentage: 5 });
        const newGroup = await createGroup({ name: 'NewGroup', percentage: 50 });
        const customer = await createCustomer({ groupId: originalGroup._id, walletBalance: 9999 });
        const product = await createProduct({ basePrice: 100 });

        const { order } = await placeOrder({ userId: customer._id, productId: product._id });

        const originalGroupIdSnapshot = order.groupIdSnapshot.toString();

        // Admin moves user to a different group
        await groupService.changeUserGroup(customer._id, newGroup._id);

        // Re-fetch the Order from DB
        const freshOrder = await Order.findById(order._id);

        // The snapshot must still point to the ORIGINAL group
        expect(freshOrder.groupIdSnapshot.toString()).toBe(originalGroupIdSnapshot);
        expect(freshOrder.groupIdSnapshot.toString()).toBe(originalGroup._id.toString());

        // Current user group is now newGroup — but that's irrelevant to this order
        const currentUser = await freshUser(customer._id);
        expect(currentUser.groupId.toString()).toBe(newGroup._id.toString());
    });
});
