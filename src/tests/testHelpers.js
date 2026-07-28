'use strict';

/**
 * testHelpers.js
 *
 * Shared factories for creating test fixtures.
 * All helpers can optionally accept overrides for flexibility.
 */

const mongoose = require('mongoose');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Product } = require('../modules/products/product.model');
const { Order } = require('../modules/orders/order.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
// Provider module — imported so models are registered before clearCollections()
require('../modules/providers/provider.model');
require('../modules/providers/providerProduct.model');
// Currency module — ensure model is registered + indexes synced before tests
require('../modules/currency/currency.model');
require('../modules/referrals/referralCommission.model');
require('../modules/referralPayouts/referralPayout.model');
require('../modules/subAgentRequests/subAgentRequest.model');

// ─── DB Lifecycle ─────────────────────────────────────────────────────────────

const connectTestDB = async () => {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_TEST_URI);
    }

    /**
     * CRITICAL: Increase the MongoDB transaction lock timeout.
     * The in-memory server defaults to 5 ms — far too short when async
     * index builds are still running when the first test opens a session.
     * 10 000 ms is safe for a test environment; production uses the default.
     */
    try {
        await mongoose.connection.db.admin().command({
            setParameter: 1,
            maxTransactionLockRequestTimeoutMillis: 10000,
        });
    } catch (_) {
        // Non-fatal — command may not be available in all configurations
    }

    /**
     * Ensure all model indexes are fully built before any test runs.
     * Without this, the first 1-2 tests can collide with background
     * index creation and get spurious LockTimeout errors.
     */
    await Promise.all(
        Object.values(mongoose.models).map((model) =>
            model.syncIndexes().catch(() => {
                /* ignore individual index errors in test env */
            })
        )
    );
};

const disconnectTestDB = async () => {
    await mongoose.disconnect();
};

/**
 * Delete all documents from every collection.
 * Runs sequentially to avoid concurrent lock contention during cleanup.
 */
const clearCollections = async () => {
    const collections = mongoose.connection.collections;
    for (const col of Object.values(collections)) {
        await col.deleteMany({});
    }
};

// ─── Factories ────────────────────────────────────────────────────────────────

/**
 * Create a Group with a randomised name to avoid unique-index collisions.
 */
const createGroup = async (overrides = {}) => {
    return Group.create({
        name: `Group-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        percentage: 10,
        isActive: true,
        ...overrides,
    });
};

/**
 * Create a Customer user.
 * NOTE: groupId is required on the schema. Either pass a groupId override or
 *       call createGroup() first and pass its _id.
 *
 * status defaults to ACTIVE so that existing tests (which immediately place
 * orders after creating a customer) continue to work without any changes.
 * Tests that need PENDING or REJECTED users pass { status: USER_STATUS.PENDING }
 * or { status: USER_STATUS.REJECTED } as an override.
 */
const createCustomer = async (overrides = {}) => {
    return User.create({
        name: 'Test Customer',
        // Randomised email avoids unique-constraint collisions across tests
        email: `customer-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
        password: 'HashedPass@1',
        role: ROLES.CUSTOMER,
        status: USER_STATUS.ACTIVE,   // ← default ACTIVE for test fixture convenience
        verified: true,               // ← default verified so login gate passes in tests
        walletBalance: 100,
        creditLimit: 0,
        creditUsed: 0,
        ...overrides,
    });
};

/**
 * Creates a Group and a Customer assigned to it in one call.
 * Useful when the test cares about group pricing but the exact group doesn't matter.
 */
const createCustomerWithGroup = async (customerOverrides = {}, groupOverrides = {}) => {
    const group = await createGroup(groupOverrides);
    const customer = await createCustomer({ groupId: group._id, ...customerOverrides });
    return { customer, group };
};

const createProduct = async (overrides = {}) => {
    return Product.create({
        name: `Product-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        basePrice: 10,
        minQty: 1,
        maxQty: 100,
        isActive: true,
        executionType: 'manual',
        ...overrides,
    });
};

/**
 * Create an Admin user (for testing admin endpoints).
 * Admins are always ACTIVE — they are created by seeding, not by registration.
 */
const createAdmin = async (overrides = {}) => {
    // Admin does not need a groupId (group pricing applies to customers only)
    // but the schema requires it, so we find or create a group.
    let groupId = overrides.groupId;
    if (!groupId) {
        const g = await createGroup({ name: `AdminGroup-${Date.now()}`, percentage: 0 });
        groupId = g._id;
    }
    return User.create({
        name: 'Test Admin',
        email: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
        password: 'AdminPass@1',
        role: ROLES.ADMIN,
        status: USER_STATUS.ACTIVE,
        verified: true,
        groupId,
        ...overrides,
    });
};

// ─── Assertion Helpers ────────────────────────────────────────────────────────

/**
 * Fetch the latest user state from DB (bypasses any cached Mongoose document).
 */
const freshUser = (userId) => User.findById(userId);

/**
 * Fetch a fresh group document.
 */
const freshGroup = (groupId) => Group.findById(groupId);

/**
 * Count wallet transactions for a user.
 */
const countTransactions = (userId) => WalletTransaction.countDocuments({ userId });

/**
 * Fetch all wallet transactions for a user (latest first).
 */
const getTransactions = (userId) =>
    WalletTransaction.find({ userId }).sort({ createdAt: -1 });

module.exports = {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createCustomerWithGroup,
    createAdmin,
    createProduct,
    freshUser,
    freshGroup,
    countTransactions,
    getTransactions,
    USER_STATUS,  // re-exported for convenient use in test files
    ROLES,
};
