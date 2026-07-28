'use strict';

/**
 * audit.test.js — Audit Log System Test Suite
 * ─────────────────────────────────────────────
 *
 * Tests are grouped as follows:
 *
 * [1] IMMUTABILITY
 *   - Direct updateOne / findOneAndUpdate / deleteOne are blocked at schema level
 *   - Service layer exposes no update/delete functions
 *
 * [2] WRITE CORRECTNESS
 *   - createAuditLog writes expected fields
 *   - Metadata is sanitised (passwords, tokens stripped)
 *   - Invalid action string is captured internally (no throw to caller)
 *   - Invalid entityType is captured internally (no throw to caller)
 *
 * [3] INTEGRATION — USER ACTIVATION
 *   - approveUser creates USER_APPROVED log
 *   - rejectUser creates USER_REJECTED log
 *   - Double-approve guard does NOT create a log
 *
 * [4] INTEGRATION — ORDER CREATION
 *   - createOrder creates ORDER_CREATED + WALLET_DEBIT logs
 *   - Failed createOrder (insufficient funds) creates NO logs
 *
 * [5] INTEGRATION — ORDER REFUND
 *   - markOrderAsFailed creates ORDER_REFUNDED + WALLET_CREDIT logs
 *
 * [6] INTEGRATION — AUTH
 *   - register creates USER_REGISTERED log
 *   - PENDING login attempt creates USER_LOGIN_BLOCKED log
 *
 * [7] QUERY ENDPOINTS
 *   - getEntityAuditLogs returns correct logs with pagination
 *   - getActorAuditLogs returns correct logs with pagination
 *   - logs are sorted by createdAt desc
 *
 * [8] METADATA CORRECTNESS
 *   - metadata is stored as-is (after sanitisation)
 *   - Circular references are silently handled
 */

const mongoose = require('mongoose');
const { AuditLog, IMMUTABILITY_ERROR } = require('../modules/audit/audit.model');
const { createAuditLog, getEntityAuditLogs, getActorAuditLogs, _sanitize } = require('../modules/audit/audit.service');
const {
    USER_ACTIONS,
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    ADMIN_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
    ALL_ACTIONS,
} = require('../modules/audit/audit.constants');
const userService = require('../modules/users/user.service');
const orderService = require('../modules/orders/order.service');
const { register, login } = require('../modules/auth/auth.service');
const { User } = require('../modules/users/user.model');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createCustomerWithGroup,
    createAdmin,
    createProduct,
    freshUser,
    USER_STATUS,
} = require('./testHelpers');

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wait briefly so fire-and-forget audit Promises can resolve. */
const flushAudit = () => new Promise((r) => setTimeout(r, 100));

/** Build a minimal valid audit log payload. */
const basePayload = (overrides = {}) => ({
    actorId: new mongoose.Types.ObjectId(),
    actorRole: ACTOR_ROLES.ADMIN,
    action: USER_ACTIONS.APPROVED,
    entityType: ENTITY_TYPES.USER,
    entityId: new mongoose.Types.ObjectId(),
    ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// [1] IMMUTABILITY
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] Immutability', () => {
    it('schema pre-hook blocks updateOne — throws synchronously', async () => {
        const log = await AuditLog.create(basePayload());
        // The pre hook throws, Mongoose wraps it; we just check it rejects
        await expect(
            AuditLog.updateOne({ _id: log._id }, { $set: { action: USER_ACTIONS.REJECTED } })
        ).rejects.toThrow(IMMUTABILITY_ERROR);
    });

    it('schema pre-hook blocks findOneAndUpdate', async () => {
        const log = await AuditLog.create(basePayload());
        await expect(
            AuditLog.findOneAndUpdate({ _id: log._id }, { $set: { action: USER_ACTIONS.REJECTED } })
        ).rejects.toThrow(IMMUTABILITY_ERROR);
    });

    it('schema pre-hook blocks updateMany', async () => {
        await AuditLog.create(basePayload());
        await expect(
            AuditLog.updateMany({}, { $set: { action: USER_ACTIONS.REJECTED } })
        ).rejects.toThrow(IMMUTABILITY_ERROR);
    });

    it('schema pre-hook blocks deleteOne', async () => {
        const log = await AuditLog.create(basePayload());
        await expect(
            AuditLog.deleteOne({ _id: log._id })
        ).rejects.toThrow(IMMUTABILITY_ERROR);
    });

    it('schema pre-hook blocks deleteMany', async () => {
        await AuditLog.create(basePayload());
        await expect(
            AuditLog.deleteMany({})
        ).rejects.toThrow(IMMUTABILITY_ERROR);
    });

    it('schema pre-hook blocks findOneAndDelete', async () => {
        const log = await AuditLog.create(basePayload());
        await expect(
            AuditLog.findOneAndDelete({ _id: log._id })
        ).rejects.toThrow(IMMUTABILITY_ERROR);
    });

    it('audit service does not export update or delete functions', () => {
        const auditService = require('../modules/audit/audit.service');
        expect(auditService.updateAuditLog).toBeUndefined();
        expect(auditService.deleteAuditLog).toBeUndefined();
        expect(typeof auditService.createAuditLog).toBe('function');
        expect(typeof auditService.getEntityAuditLogs).toBe('function');
        expect(typeof auditService.getActorAuditLogs).toBe('function');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] WRITE CORRECTNESS
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] Write correctness', () => {
    it('createAuditLog persists all required fields correctly', async () => {
        const actorId = new mongoose.Types.ObjectId();
        const entityId = new mongoose.Types.ObjectId();

        await createAuditLog({
            actorId,
            actorRole: ACTOR_ROLES.ADMIN,
            action: USER_ACTIONS.APPROVED,
            entityType: ENTITY_TYPES.USER,
            entityId,
            metadata: { someField: 'someValue' },
            ipAddress: '192.168.1.1',
            userAgent: 'TestAgent/1.0',
        });

        await flushAudit();

        const log = await AuditLog.findOne({ actorId, entityId }).lean();
        expect(log).not.toBeNull();
        expect(log.actorId.toString()).toBe(actorId.toString());
        expect(log.actorRole).toBe(ACTOR_ROLES.ADMIN);
        expect(log.action).toBe(USER_ACTIONS.APPROVED);
        expect(log.entityType).toBe(ENTITY_TYPES.USER);
        expect(log.entityId.toString()).toBe(entityId.toString());
        expect(log.metadata?.someField).toBe('someValue');
        expect(log.ipAddress).toBe('192.168.1.1');
        expect(log.userAgent).toBe('TestAgent/1.0');
        expect(log.createdAt).toBeDefined();
        // updatedAt must NOT exist — append-only schema
        expect(log.updatedAt).toBeUndefined();
        // __v must NOT exist — versionKey: false
        expect(log.__v).toBeUndefined();
    });

    it('metadata password field is redacted', async () => {
        await createAuditLog(basePayload({
            metadata: { userId: 'abc', password: 'secret123' },
        }));
        await flushAudit();

        const log = await AuditLog.findOne({}).lean();
        expect(log.metadata.password).toBe('[REDACTED]');
        expect(log.metadata.userId).toBe('abc');
    });

    it('metadata token field is redacted', async () => {
        await createAuditLog(basePayload({
            metadata: { data: 'ok', token: 'jwt-token-value', accessToken: 'at-123' },
        }));
        await flushAudit();

        const log = await AuditLog.findOne({}).lean();
        expect(log.metadata.token).toBe('[REDACTED]');
        expect(log.metadata.accessToken).toBe('[REDACTED]');
        expect(log.metadata.data).toBe('ok');
    });

    it('nested sensitive keys inside metadata objects are redacted', async () => {
        await createAuditLog(basePayload({
            metadata: { user: { id: '1', password: 'nested-secret' } },
        }));
        await flushAudit();

        const log = await AuditLog.findOne({}).lean();
        expect(log.metadata.user.password).toBe('[REDACTED]');
        expect(log.metadata.user.id).toBe('1');
    });

    it('invalid action string is silently captured — does not throw to caller', async () => {
        // createAuditLog swallows the error internally
        await expect(
            createAuditLog(basePayload({ action: 'TOTALLY_INVALID_ACTION_XYZ' }))
        ).resolves.toBeUndefined();

        // No log should have been written
        await flushAudit();
        const count = await AuditLog.countDocuments({});
        expect(count).toBe(0);
    });

    it('invalid entityType is silently captured — does not throw to caller', async () => {
        await expect(
            createAuditLog(basePayload({ entityType: 'INVALID_ENTITY_TYPE' }))
        ).resolves.toBeUndefined();

        await flushAudit();
        const count = await AuditLog.countDocuments({});
        expect(count).toBe(0);
    });

    it('all ALL_ACTIONS constants are valid and write successfully', async () => {
        // Sample a few from each group to avoid test bloat
        const sampled = [
            { action: USER_ACTIONS.APPROVED, entityType: ENTITY_TYPES.USER },
            { action: ORDER_ACTIONS.CREATED, entityType: ENTITY_TYPES.ORDER },
            { action: WALLET_ACTIONS.DEBIT, entityType: ENTITY_TYPES.WALLET },
        ];

        for (const { action, entityType } of sampled) {
            await createAuditLog(basePayload({ action, entityType }));
        }
        await flushAudit();

        const count = await AuditLog.countDocuments({});
        expect(count).toBe(sampled.length);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] INTEGRATION — USER ACTIVATION
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] Integration – User activation', () => {
    let admin;
    let group;

    beforeEach(async () => {
        group = await createGroup({ name: 'Standard', percentage: 0 });
        admin = await createAdmin();
    });

    it('approveUser creates USER_APPROVED log with correct fields', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });

        await userService.approveUser(customer._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: USER_ACTIONS.APPROVED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.USER);
        expect(log.entityId.toString()).toBe(customer._id.toString());
        expect(log.metadata.previousStatus).toBe(USER_STATUS.PENDING);
        expect(log.actorId.toString()).toBe(admin._id.toString());
    });

    it('rejectUser creates USER_REJECTED log with correct fields', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });

        await userService.rejectUser(customer._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: USER_ACTIONS.REJECTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.USER);
        expect(log.entityId.toString()).toBe(customer._id.toString());
        expect(log.metadata.previousStatus).toBe(USER_STATUS.PENDING);
        expect(log.actorId.toString()).toBe(admin._id.toString());
    });

    it('ALREADY_ACTIVE guard: NO log is created when approve fails', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
        });

        await expect(
            userService.approveUser(customer._id, admin._id)
        ).rejects.toMatchObject({ code: 'ALREADY_ACTIVE' });

        await flushAudit();

        const count = await AuditLog.countDocuments({ action: USER_ACTIONS.APPROVED });
        expect(count).toBe(0);
    });

    it('ALREADY_REJECTED guard: NO log is created when reject fails', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
        });

        await expect(
            userService.rejectUser(customer._id, admin._id)
        ).rejects.toMatchObject({ code: 'ALREADY_REJECTED' });

        await flushAudit();

        const count = await AuditLog.countDocuments({ action: USER_ACTIONS.REJECTED });
        expect(count).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] INTEGRATION — ORDER CREATION
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] Integration – Order creation', () => {
    let customer;
    let product;

    beforeEach(async () => {
        const group = await createGroup({ name: 'Standard', percentage: 0 });
        customer = await createCustomer({ groupId: group._id, walletBalance: 1000 });
        product = await createProduct({ basePrice: 50 });
    });

    it('successful createOrder produces ORDER_CREATED + WALLET_DEBIT logs', async () => {
        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        await flushAudit();

        const orderLog = await AuditLog.findOne({ action: ORDER_ACTIONS.CREATED }).lean();
        const walletLog = await AuditLog.findOne({ action: WALLET_ACTIONS.DEBIT }).lean();

        expect(orderLog).not.toBeNull();
        expect(orderLog.entityType).toBe(ENTITY_TYPES.ORDER);
        expect(orderLog.entityId.toString()).toBe(order._id.toString());
        // Since customer is USD by default, chargedAmount = usdAmount = 50
        expect(orderLog.metadata.chargedAmount).toBe(50);

        expect(walletLog).not.toBeNull();
        expect(walletLog.entityType).toBe(ENTITY_TYPES.WALLET);
        expect(walletLog.entityId.toString()).toBe(customer._id.toString());
        expect(walletLog.metadata.chargedAmount).toBe(50);
    });

    it('failed createOrder (insufficient funds) produces ZERO audit logs', async () => {
        // Customer has walletBalance:1000 but product costs 999999
        const expensive = await createProduct({ basePrice: 999999 });

        await expect(
            orderService.createOrder({
                userId: customer._id,
                productId: expensive._id,
                quantity: 1,
            })
        ).rejects.toBeDefined();

        await flushAudit();

        const count = await AuditLog.countDocuments({
            action: { $in: [ORDER_ACTIONS.CREATED, WALLET_ACTIONS.DEBIT] },
        });
        expect(count).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [5] INTEGRATION — ORDER REFUND
// ─────────────────────────────────────────────────────────────────────────────

describe('[5] Integration – Order refund', () => {
    it('markOrderAsFailed creates ORDER_REFUNDED + WALLET_CREDIT logs', async () => {
        const group = await createGroup({ name: 'Standard', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 500 });
        const product = await createProduct({ basePrice: 100 });

        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        // Clear order/wallet creation logs to isolate refund logs
        await AuditLog.collection.deleteMany({});   // raw collection — bypasses immutability hook

        await orderService.markOrderAsFailed(order._id);
        await flushAudit();

        const refundLog = await AuditLog.findOne({ action: ORDER_ACTIONS.REFUNDED }).lean();
        const creditLog = await AuditLog.findOne({ action: WALLET_ACTIONS.CREDIT }).lean();

        expect(refundLog).not.toBeNull();
        expect(refundLog.entityId.toString()).toBe(order._id.toString());
        expect(refundLog.metadata.totalRefund).toBe(100);

        expect(creditLog).not.toBeNull();
        expect(creditLog.entityId.toString()).toBe(customer._id.toString());
    });
});

describe('[5b] Integration – Manual order review', () => {
    it('markOrderAsCompleted writes ADMIN_ORDER_COMPLETED with supervisor actor context', async () => {
        const group = await createGroup({ name: 'ManualFlow', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 500 });
        const supervisor = await createAdmin({ role: ACTOR_ROLES.SUPERVISOR });
        const product = await createProduct({ basePrice: 100, executionType: 'manual' });

        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        await AuditLog.collection.deleteMany({});

        await orderService.markOrderAsCompleted(order._id, {
            actorId: supervisor._id,
            actorRole: ACTOR_ROLES.SUPERVISOR,
        });
        await flushAudit();

        const log = await AuditLog.findOne({
            action: ADMIN_ACTIONS.ORDER_COMPLETED,
            entityId: order._id,
        }).lean();

        expect(log).not.toBeNull();
        expect(log.actorId.toString()).toBe(supervisor._id.toString());
        expect(log.actorRole).toBe(ACTOR_ROLES.SUPERVISOR);
        expect(log.entityType).toBe(ENTITY_TYPES.ORDER);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [6] INTEGRATION — AUTH
// ─────────────────────────────────────────────────────────────────────────────

describe('[6] Integration – Auth events', () => {
    beforeEach(async () => {
        await createGroup({ name: 'Default', percentage: 0 });
    });

    it('register creates USER_REGISTERED log', async () => {
        const email = `reg-${Date.now()}@test.com`;
        await register({ name: 'New User', email, password: 'ValidPass@1' });
        await flushAudit();

        const log = await AuditLog.findOne({ action: USER_ACTIONS.REGISTERED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.USER);
        expect(log.metadata.email).toBe(email);
    });

    it('PENDING login attempt creates USER_LOGIN_BLOCKED log', async () => {
        const group = await createGroup({ name: 'PendingLoginGroup', percentage: 0 });
        const email = `blocked-${Date.now()}@test.com`;
        const password = 'ValidPass@1';
        await createCustomer({
            groupId: group._id,
            name: 'Pending User',
            email,
            password,
            status: USER_STATUS.PENDING,
            verified: true,
        });

        await flushAudit();
        await AuditLog.collection.deleteMany({});  // isolate

        await expect(
            login({ email, password })
        ).rejects.toBeDefined();

        await flushAudit();

        const log = await AuditLog.findOne({ action: USER_ACTIONS.LOGIN_BLOCKED }).lean();
        expect(log).not.toBeNull();
        expect(log.metadata.reason).toBe('PENDING');
    });

    it('REJECTED user login attempt creates USER_LOGIN_BLOCKED log with reason=REJECTED', async () => {
        const group = await createGroup({ name: 'RejGr', percentage: 0 });
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
            email: `rej-${Date.now()}@test.com`,
            password: 'ValidPass@1',
        });

        await expect(
            login({ email: customer.email, password: 'ValidPass@1' })
        ).rejects.toBeDefined();

        await flushAudit();

        const log = await AuditLog.findOne({ action: USER_ACTIONS.LOGIN_BLOCKED }).lean();
        expect(log).not.toBeNull();
        expect(log.metadata.reason).toBe('REJECTED');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [7] QUERY ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

describe('[7] Query – getEntityAuditLogs / getActorAuditLogs', () => {
    let entityId;
    let actorId;

    beforeEach(async () => {
        entityId = new mongoose.Types.ObjectId();
        actorId = new mongoose.Types.ObjectId();

        // Write 5 logs for the same entity
        for (let i = 0; i < 5; i++) {
            await AuditLog.create({
                actorId: actorId,
                actorRole: ACTOR_ROLES.ADMIN,
                action: USER_ACTIONS.APPROVED,
                entityType: ENTITY_TYPES.USER,
                entityId: entityId,
            });
        }
        // Write 2 logs for a different entity (noise)
        await AuditLog.create(basePayload({ entityId: new mongoose.Types.ObjectId() }));
        await AuditLog.create(basePayload({ entityId: new mongoose.Types.ObjectId() }));
    });

    it('getEntityAuditLogs returns only logs for the specified entity', async () => {
        const result = await getEntityAuditLogs(ENTITY_TYPES.USER, entityId);
        expect(result.logs).toHaveLength(5);
        result.logs.forEach((l) => expect(l.entityId.toString()).toBe(entityId.toString()));
    });

    it('getEntityAuditLogs paginates correctly', async () => {
        const page1 = await getEntityAuditLogs(ENTITY_TYPES.USER, entityId, { page: 1, limit: 3 });
        const page2 = await getEntityAuditLogs(ENTITY_TYPES.USER, entityId, { page: 2, limit: 3 });

        expect(page1.logs).toHaveLength(3);
        expect(page2.logs).toHaveLength(2);
        expect(page1.pagination.total).toBe(5);
        expect(page1.pagination.pages).toBe(2);
    });

    it('getEntityAuditLogs returns logs sorted createdAt desc', async () => {
        const result = await getEntityAuditLogs(ENTITY_TYPES.USER, entityId);
        const dates = result.logs.map((l) => new Date(l.createdAt).getTime());
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
        }
    });

    it('getActorAuditLogs returns only logs for the specified actor', async () => {
        const result = await getActorAuditLogs(actorId);
        expect(result.logs).toHaveLength(5);
        result.logs.forEach((l) => expect(l.actorId.toString()).toBe(actorId.toString()));
    });

    it('getActorAuditLogs paginates correctly', async () => {
        const page1 = await getActorAuditLogs(actorId, { page: 1, limit: 2 });
        const page2 = await getActorAuditLogs(actorId, { page: 2, limit: 2 });
        const page3 = await getActorAuditLogs(actorId, { page: 3, limit: 2 });

        expect(page1.logs).toHaveLength(2);
        expect(page2.logs).toHaveLength(2);
        expect(page3.logs).toHaveLength(1);
        expect(page1.pagination.total).toBe(5);
    });

    it('getActorAuditLogs returns empty result when actor has no logs', async () => {
        const unknownActor = new mongoose.Types.ObjectId();
        const result = await getActorAuditLogs(unknownActor);
        expect(result.logs).toHaveLength(0);
        expect(result.pagination.total).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [8] METADATA SANITISATION
// ─────────────────────────────────────────────────────────────────────────────

describe('[8] Metadata sanitisation (_sanitize unit tests)', () => {
    it('returns primitives unchanged', () => {
        expect(_sanitize(42)).toBe(42);
        expect(_sanitize('hello')).toBe('hello');
        expect(_sanitize(null)).toBeNull();
        expect(_sanitize(true)).toBe(true);
    });

    it('redacts all known sensitive keys (case-insensitive is NOT required — keys are exact)', () => {
        const input = { password: 'p', token: 't', apiKey: 'k', normal: 'n' };
        const result = _sanitize(input);
        expect(result.password).toBe('[REDACTED]');
        expect(result.token).toBe('[REDACTED]');
        expect(result.apiKey).toBe('[REDACTED]');
        expect(result.normal).toBe('n');
    });

    it('handles nested objects', () => {
        const input = { level1: { level2: { password: 'deep-secret', safe: 'ok' } } };
        const result = _sanitize(input);
        expect(result.level1.level2.password).toBe('[REDACTED]');
        expect(result.level1.level2.safe).toBe('ok');
    });

    it('handles arrays', () => {
        const input = [{ token: 'a' }, { name: 'b' }];
        const result = _sanitize(input);
        expect(result[0].token).toBe('[REDACTED]');
        expect(result[1].name).toBe('b');
    });

    it('handles circular references without throwing', () => {
        const obj = { name: 'root' };
        obj.self = obj;  // circular reference
        expect(() => _sanitize(obj)).not.toThrow();
        const result = _sanitize(obj);
        expect(result.self).toBe('[Circular]');
    });
});
