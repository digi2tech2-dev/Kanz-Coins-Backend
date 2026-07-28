'use strict';

/**
 * group.test.js — Group-Based Pricing Foundation Test Suite
 * ──────────────────────────────────────────────────────────
 * Tests cover:
 *
 *   GROUP SERVICE
 *   1. Create group — happy path
 *   2. Create group — duplicate name rejected (case-insensitive)
 *   3. Create group — negative percentage rejected
 *   4. Create group — missing percentage rejected
 *   5. List groups — sorted by percentage descending
 *   6. List groups — inactive groups excluded by default
 *   7. List groups — includeInactive flag works
 *   8. Get group by ID — happy path
 *   9. Get group by ID — not found throws error
 *   10. Update percentage — happy path
 *   11. Update percentage — negative rejected
 *   12. Update percentage — non-existent group throws
 *
 *   AUTO-ASSIGN ON REGISTRATION
 *   13. Register assigns group with HIGHEST percentage
 *   14. Register fails when no active groups exist (NO_GROUPS_AVAILABLE)
 *   15. Register assigns correct group among multiple groups
 *
 *   CHANGE USER GROUP (ADMIN)
 *   16. Change user group — happy path
 *   17. Change user group — target group not found
 *   18. Change user group — inactive group rejected
 *   19. Change user group — user not found
 *
 *   EDGE CASES
 *   20. getHighestPercentageGroup — returns only active groups
 *   21. Updating percentage does NOT affect existing orders (forward-only contract)
 */

const mongoose = require('mongoose');
const groupService = require('../modules/groups/group.service');
const { register } = require('../modules/auth/auth.service');
const Group = require('../modules/groups/group.model');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomerWithGroup,
    freshUser,
    freshGroup,
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

// ─── Helper: unique email generator ──────────────────────────────────────────

const uniqueEmail = () =>
    `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

// ─────────────────────────────────────────────────────────────────────────────
// 1–4. CREATE GROUP
// ─────────────────────────────────────────────────────────────────────────────

describe('createGroup', () => {
    it('creates a group with valid name and percentage', async () => {
        const group = await groupService.createGroup({ name: 'Gold', percentage: 20 });

        expect(group._id).toBeDefined();
        expect(group.name).toBe('Gold');
        expect(group.percentage).toBe(20);
        expect(group.isActive).toBe(true);
        expect(group.createdAt).toBeDefined();
    });

    it('creates a group with percentage = 0 (valid boundary)', async () => {
        const group = await groupService.createGroup({ name: 'Standard', percentage: 0 });
        expect(group.percentage).toBe(0);
    });

    it('rejects duplicate group name (case-insensitive)', async () => {
        await groupService.createGroup({ name: 'Gold', percentage: 10 });

        await expect(
            groupService.createGroup({ name: 'GOLD', percentage: 20 })
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects negative percentage', async () => {
        await expect(
            groupService.createGroup({ name: 'Invalid', percentage: -1 })
        ).rejects.toThrow();
        // Mongoose min validator fires before the service-level check
        const count = await Group.countDocuments();
        expect(count).toBe(0);
    });

    it('rejects missing percentage', async () => {
        await expect(
            groupService.createGroup({ name: 'NoPercentage' })
        ).rejects.toThrow(); // Mongoose required validator
        const count = await Group.countDocuments();
        expect(count).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–7. LIST GROUPS
// ─────────────────────────────────────────────────────────────────────────────

describe('listGroups', () => {
    it('returns groups sorted by percentage descending', async () => {
        await groupService.createGroup({ name: 'Bronze', percentage: 5 });
        await groupService.createGroup({ name: 'Gold', percentage: 20 });
        await groupService.createGroup({ name: 'Silver', percentage: 10 });

        const groups = await groupService.listGroups();

        expect(groups).toHaveLength(3);
        expect(groups[0].percentage).toBe(20); // Gold first
        expect(groups[1].percentage).toBe(10); // Silver second
        expect(groups[2].percentage).toBe(5);  // Bronze last
    });

    it('excludes inactive groups by default', async () => {
        await groupService.createGroup({ name: 'Active', percentage: 10 });
        await Group.create({ name: 'Inactive', percentage: 5, isActive: false });

        const groups = await groupService.listGroups();

        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('Active');
    });

    it('includes inactive groups when includeInactive = true', async () => {
        await groupService.createGroup({ name: 'Active', percentage: 10 });
        await Group.create({ name: 'Inactive', percentage: 5, isActive: false });

        const groups = await groupService.listGroups({ includeInactive: true });

        expect(groups).toHaveLength(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8–9. GET GROUP BY ID
// ─────────────────────────────────────────────────────────────────────────────

describe('getGroupById', () => {
    it('returns a group by its ID', async () => {
        const created = await groupService.createGroup({ name: 'VIP', percentage: 25 });
        const found = await groupService.getGroupById(created._id);

        expect(found._id.toString()).toBe(created._id.toString());
        expect(found.name).toBe('VIP');
    });

    it('throws NotFoundError for non-existent ID', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(
            groupService.getGroupById(fakeId)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10–12. UPDATE PERCENTAGE
// ─────────────────────────────────────────────────────────────────────────────

describe('updateGroupPercentage', () => {
    it('updates the percentage of an existing group', async () => {
        const group = await groupService.createGroup({ name: 'Basic', percentage: 5 });

        const updated = await groupService.updateGroupPercentage(group._id, 15);

        expect(updated.percentage).toBe(15);
        // Verify persisted
        const fresh = await freshGroup(group._id);
        expect(fresh.percentage).toBe(15);
    });

    it('accepts percentage = 0 as a valid update', async () => {
        const group = await groupService.createGroup({ name: 'Free', percentage: 10 });
        const updated = await groupService.updateGroupPercentage(group._id, 0);
        expect(updated.percentage).toBe(0);
    });

    it('rejects negative percentage on update', async () => {
        const group = await groupService.createGroup({ name: 'Basic', percentage: 5 });
        await expect(
            groupService.updateGroupPercentage(group._id, -5)
        ).rejects.toMatchObject({ code: 'INVALID_PERCENTAGE' });

        // Original value must be untouched
        const fresh = await freshGroup(group._id);
        expect(fresh.percentage).toBe(5);
    });

    it('throws NotFoundError for non-existent group', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(
            groupService.updateGroupPercentage(fakeId, 20)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13–15. AUTO-ASSIGN HIGHEST-PERCENTAGE GROUP ON REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Auto-assign highest percentage group on registration', () => {
    it('assigns the group with the highest percentage to a new user', async () => {
        // Create two groups — registration must pick Gold (20 %)
        await groupService.createGroup({ name: 'Silver', percentage: 10 });
        const gold = await groupService.createGroup({ name: 'Gold', percentage: 20 });

        const { user } = await register({
            name: 'New User',
            email: uniqueEmail(),
            password: 'ValidPass@1',
        });

        // Fetch with groupId populated
        const dbUser = await User.findById(user._id).populate('groupId');
        expect(dbUser.groupId._id.toString()).toBe(gold._id.toString());
        expect(dbUser.groupId.percentage).toBe(20);
    });

    it('assigns the single existing group when only one exists', async () => {
        const only = await groupService.createGroup({ name: 'Only', percentage: 5 });

        const { user } = await register({
            name: 'Lone User',
            email: uniqueEmail(),
            password: 'ValidPass@1',
        });

        const dbUser = await User.findById(user._id);
        expect(dbUser.groupId.toString()).toBe(only._id.toString());
    });

    it('selects the highest among three groups correctly', async () => {
        const g5 = await groupService.createGroup({ name: 'Tier5', percentage: 5 });
        const g30 = await groupService.createGroup({ name: 'Tier30', percentage: 30 });
        const g15 = await groupService.createGroup({ name: 'Tier15', percentage: 15 });

        const { user } = await register({
            name: 'Picker',
            email: uniqueEmail(),
            password: 'ValidPass@1',
        });

        const dbUser = await User.findById(user._id);
        expect(dbUser.groupId.toString()).toBe(g30._id.toString());
    });

    it('throws NO_GROUPS_AVAILABLE when no active groups exist', async () => {
        // No groups seeded — clearCollections ran in beforeEach
        await expect(
            register({ name: 'Ghost', email: uniqueEmail(), password: 'ValidPass@1' })
        ).rejects.toMatchObject({
            code: 'NO_GROUPS_AVAILABLE',
            statusCode: 422,
        });

        // No user must have been created
        const count = await User.countDocuments();
        expect(count).toBe(0);
    });

    it('does NOT assign user when all groups are inactive', async () => {
        // Create a group and deactivate it
        await Group.create({ name: 'Dormant', percentage: 10, isActive: false });

        await expect(
            register({ name: 'Ghost', email: uniqueEmail(), password: 'ValidPass@1' })
        ).rejects.toMatchObject({ code: 'NO_GROUPS_AVAILABLE' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16–19. CHANGE USER GROUP
// ─────────────────────────────────────────────────────────────────────────────

describe('changeUserGroup', () => {
    it('moves a user to a different group successfully', async () => {
        const { customer, group: originalGroup } = await createCustomerWithGroup({}, { name: 'Original', percentage: 5 });
        const newGroup = await groupService.createGroup({ name: 'Upgraded', percentage: 25 });

        const updatedUser = await groupService.changeUserGroup(customer._id, newGroup._id);

        expect(updatedUser.groupId._id.toString()).toBe(newGroup._id.toString());

        // Verify persisted in DB
        const fresh = await freshUser(customer._id);
        expect(fresh.groupId.toString()).toBe(newGroup._id.toString());
    });

    it('returns populated group data in the response', async () => {
        const { customer } = await createCustomerWithGroup();
        const target = await groupService.createGroup({ name: 'Target', percentage: 40 });

        const updatedUser = await groupService.changeUserGroup(customer._id, target._id);

        // groupId should be populated (object, not ObjectId string)
        expect(updatedUser.groupId).toMatchObject({
            name: 'Target',
            percentage: 40,
        });
    });

    it('throws NotFoundError when user does not exist', async () => {
        const fakeUserId = new mongoose.Types.ObjectId();
        const group = await groupService.createGroup({ name: 'Any', percentage: 10 });

        await expect(
            groupService.changeUserGroup(fakeUserId, group._id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws NotFoundError when target group does not exist', async () => {
        const { customer } = await createCustomerWithGroup();
        const fakeGroupId = new mongoose.Types.ObjectId();

        await expect(
            groupService.changeUserGroup(customer._id, fakeGroupId)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws GROUP_INACTIVE when target group is inactive', async () => {
        const { customer } = await createCustomerWithGroup();
        const inactiveGroup = await Group.create({
            name: 'Inactive',
            percentage: 99,
            isActive: false,
        });

        await expect(
            groupService.changeUserGroup(customer._id, inactiveGroup._id)
        ).rejects.toMatchObject({ code: 'GROUP_INACTIVE' });

        // User's group must remain unchanged
        const fresh = await freshUser(customer._id);
        expect(fresh.groupId.toString()).not.toBe(inactiveGroup._id.toString());
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20–21. EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge cases', () => {
    it('getHighestPercentageGroup ignores inactive groups', async () => {
        // Inactive group has higher percentage — must NOT be selected
        await Group.create({ name: 'HighButDead', percentage: 100, isActive: false });
        const active = await groupService.createGroup({ name: 'Modest', percentage: 15 });

        const highest = await groupService.getHighestPercentageGroup();

        expect(highest._id.toString()).toBe(active._id.toString());
        expect(highest.percentage).toBe(15);
    });

    it('updating group percentage does not retroactively change existing order unitPrice', async () => {
        /**
         * Verifies the forward-only contract:
         *   • Order snapshot fields are written once at creation time
         *   • Updating the group's percentage afterwards has no effect on them
         *
         * The full snapshot immutability suite is in pricing.test.js.
         * This test confirms the contract from the group-service perspective.
         */
        const group = await groupService.createGroup({ name: 'Mutable', percentage: 10 });

        const { customer } = await createCustomerWithGroup({ walletBalance: 500 }, { name: 'G1', percentage: 10 });
        const { Product } = require('../modules/products/product.model');
        const { Order, ORDER_STATUS } = require('../modules/orders/order.model');

        const product = await Product.create({
            name: 'TestProduct',
            basePrice: 100,
            minQty: 1,
            maxQty: 10,
            isActive: true,
            executionType: 'manual',
        });

        // Create an order directly with snapshotted values
        // (bypasses wallet — we only care about snapshot immutability)
        const order = await Order.create({
            userId: customer._id,
            productId: product._id,
            orderNumber: `GRP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            quantity: 1,
            unitPrice: 110,                   // basePrice(100) + 10% = 110
            totalPrice: 110,
            walletDeducted: 110,
            creditUsedAmount: 0,
            status: ORDER_STATUS.PENDING,
            executionType: 'manual',
            // Required snapshot fields — written at creation, never changed
            basePriceSnapshot: 100,
            markupPercentageSnapshot: 10,
            finalPriceCharged: 110,
            groupIdSnapshot: group._id,
        });

        // Admin updates the group percentage
        await groupService.updateGroupPercentage(group._id, 50);

        // All order snapshot fields must be unchanged
        const freshOrder = await Order.findById(order._id);
        expect(freshOrder.unitPrice).toBe('110');            // unchanged
        expect(freshOrder.basePriceSnapshot).toBe('100');    // unchanged
        expect(freshOrder.markupPercentageSnapshot).toBe(10); // unchanged — still 10, not 50
        expect(freshOrder.finalPriceCharged).toBe('110');    // unchanged

        // Group has the new percentage (only affects future orders)
        const freshGrp = await freshGroup(group._id);
        expect(freshGrp.percentage).toBe(50);
    });

    it('two groups with the same percentage — either can be chosen (non-determinism is acceptable)', async () => {
        await groupService.createGroup({ name: 'TiedA', percentage: 20 });
        await groupService.createGroup({ name: 'TiedB', percentage: 20 });

        // Must return one of them, not throw
        const highest = await groupService.getHighestPercentageGroup();
        expect(highest.percentage).toBe(20);
        expect(['TiedA', 'TiedB']).toContain(highest.name);
    });
});
