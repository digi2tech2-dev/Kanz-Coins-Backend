'use strict';

/**
 * deposit.test.js — Deposit Request System Test Suite
 * ─────────────────────────────────────────────────────
 *
 * [1] Model Validation
 *   - Required fields enforced
 *   - Status enum validated
 *   - requestedAmount > 0
 *   - Virtuals: isApproved, isRejected, isPending
 *
 * [2] createDepositRequest
 *   - Creates PENDING deposit
 *   - Creates DEPOSIT_REQUESTED audit log
 *   - Returns correct fields
 *
 * [3] approveDeposit
 *   - PENDING → APPROVED success
 *   - Wallet gets credited (walletBalance increases)
 *   - WalletTransaction record created
 *   - DEPOSIT_APPROVED + WALLET_CREDIT audit logs created
 *   - admin override amount is used when provided
 *   - Cannot approve an already APPROVED deposit (DEPOSIT_ALREADY_APPROVED)
 *   - Cannot approve a REJECTED deposit (DEPOSIT_ALREADY_REJECTED)
 *
 * [4] rejectDeposit
 *   - PENDING → REJECTED success
 *   - Wallet is NOT credited
 *   - DEPOSIT_REJECTED audit log created
 *   - Cannot reject an already REJECTED deposit
 *   - Cannot reject an already APPROVED deposit
 *
 * [5] Concurrency
 *   - Two concurrent approve calls: only first succeeds
 *   - Wallet credited exactly once
 *
 * [6] listDeposits / listMyDeposits
 *   - Admin sees all deposits
 *   - Status filter works
 *   - Pagination works
 *
 * [7] getDepositById
 *   - Returns correct deposit
 *   - Throws NotFoundError for unknown ID
 *   - Customer ownership guard works
 *
 * [8] Audit correctness
 *   - Metadata does NOT contain sensitive tokens
 *   - Correct entityType, entityId, action on each event
 */

const mongoose = require('mongoose');
jest.mock('../shared/services/receiptAnalyzer.service', () => ({
    analyzeReceiptBuffer: jest.fn(),
}));

const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const depositController = require('../modules/deposits/deposit.controller');
const { AuditLog } = require('../modules/audit/audit.model');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES } = require('../modules/audit/audit.constants');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Currency } = require('../modules/currency/currency.model');
const { Setting } = require('../modules/admin/setting.model');
const { invalidateSettingsCache } = require('../modules/admin/admin.settings.service');
const { analyzeReceiptBuffer } = require('../shared/services/receiptAnalyzer.service');
const { isAutomatedPaymentMethod } = require('../modules/deposits/paymentMethodAutomation.service');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
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

const flushAudit = () => new Promise((r) => setTimeout(r, 100));

const VALID_DEPOSIT = {
    paymentMethodId: new mongoose.Types.ObjectId(),
    requestedAmount: 500,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 500,
    receiptImage: 'uploads/deposits/receipt.jpg',
};

const seedPaymentMethods = async () => {
    await Setting.updateOne(
        { key: 'paymentGroups' },
        {
            $set: {
                key: 'paymentGroups',
                value: [{
                    id: 'egp-methods',
                    name: 'EGP methods',
                    currency: 'EGP',
                    isActive: true,
                    methods: [
                        {
                            id: 'vodafone-automated',
                            name: 'Mobile Wallet',
                            type: 'mobile_wallet',
                            accountNumber: '01000000000',
                            isActive: true,
                        },
                        {
                            id: 'mobile-wallet-automated',
                            name: 'فودافون كاش',
                            type: 'mobile_wallet',
                            isActive: true,
                        },
                        { id: 'usdt-automated', name: 'USDT', type: 'crypto', accountNumber: 'TAbc123', isActive: true },
                        { id: 'orange-cash-manual', name: 'Orange Cash', type: 'mobile_wallet', accountNumber: '01234567890', isActive: true },
                        { id: 'bank-transfer-manual', name: 'Bank Transfer', type: 'bank', accountNumber: '123456789', isActive: true },
                    ],
                }],
            },
        },
        { upsert: true }
    );
    invalidateSettingsCache('paymentGroups');
};

const invokeCreateDeposit = (req) => new Promise((resolve) => {
    const res = {
        status: jest.fn(() => res),
        json: jest.fn((body) => resolve({ body, res })),
    };
    depositController.createDeposit(req, res, (error) => resolve({ error, res }));
});

let _group;
const ensureGroup = async () => {
    if (!_group) _group = await createGroup({ name: 'Default', percentage: 0 });
    return _group;
};
beforeEach(() => { _group = null; });

// ─────────────────────────────────────────────────────────────────────────────
// [1] MODEL VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] Model validation', () => {
    let userId;

    beforeEach(async () => {
        const group = await ensureGroup();
        const customer = await createCustomer({ groupId: group._id });
        userId = customer._id;
    });

    it('creates a valid deposit request with all required fields', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc._id).toBeDefined();
        expect(doc.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(doc.reviewedBy).toBeNull();
        expect(doc.reviewedAt).toBeNull();
    });

    it('rejects when userId is missing', async () => {
        await expect(
            DepositRequest.create({ ...VALID_DEPOSIT })
        ).rejects.toThrow(/userId is required/);
    });

    it('rejects when requestedAmount is missing', async () => {
        await expect(
            DepositRequest.create({
                userId,
                paymentMethodId: new mongoose.Types.ObjectId(),
                currency: 'USD',
                exchangeRate: 1,
                amountUsd: 100,
                receiptImage: 'uploads/deposits/receipt.jpg',
            })
        ).rejects.toThrow(/requestedAmount is required/);
    });

    it('rejects when requestedAmount <= 0', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, requestedAmount: 0 })
        ).rejects.toThrow(/greater than 0/);
    });

    it('allows a null receiptImage so automated deposits can be persisted', async () => {
        const deposit = await DepositRequest.create({
            userId,
            paymentMethodId: new mongoose.Types.ObjectId(),
            requestedAmount: 100,
            currency: 'USD',
            exchangeRate: 1,
            amountUsd: 100,
        });
        expect(deposit.receiptImage).toBeNull();
    });

    it('rejects when paymentMethodId is missing', async () => {
        await expect(
            DepositRequest.create({
                userId,
                requestedAmount: 100,
                currency: 'USD',
                exchangeRate: 1,
                amountUsd: 100,
                receiptImage: 'uploads/deposits/receipt.jpg',
            })
        ).rejects.toThrow(/paymentMethodId is required/);
    });

    it('rejects invalid status value', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, status: 'INVALID_STATUS' })
        ).rejects.toThrow();
    });

    it('virtual isApproved returns true for APPROVED status', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT, status: DEPOSIT_STATUS.APPROVED });
        expect(doc.isApproved).toBe(true);
        expect(doc.isRejected).toBe(false);
        expect(doc.isPending).toBe(false);
    });

    it('virtual isRejected returns true for REJECTED status', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT, status: DEPOSIT_STATUS.REJECTED });
        expect(doc.isRejected).toBe(true);
        expect(doc.isApproved).toBe(false);
        expect(doc.isPending).toBe(false);
    });

    it('virtual isPending returns true for PENDING status', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc.isPending).toBe(true);
        expect(doc.isApproved).toBe(false);
        expect(doc.isRejected).toBe(false);
    });

    it('default status is PENDING', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc.status).toBe(DEPOSIT_STATUS.PENDING);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] createDepositRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] createDepositRequest', () => {
    let customer;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id });
    });

    it('creates a PENDING deposit request with correct fields', async () => {
        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });

        expect(deposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(deposit.userId.toString()).toBe(customer._id.toString());
        expect(deposit.requestedAmount).toBe(500);
        expect(deposit.reviewedBy).toBeNull();
    });

    it('persists to the database', async () => {
        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });

        const found = await DepositRequest.findById(deposit._id);
        expect(found).not.toBeNull();
        expect(found.status).toBe(DEPOSIT_STATUS.PENDING);
    });

    it('creates DEPOSIT_REQUESTED audit log (fire-and-forget)', async () => {
        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });

        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.metadata.requestedAmount).toBe(500);
    });

    it('allows a user to submit multiple pending requests', async () => {
        await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
            requestedAmount: 200,
            amountUsd: 200,
        });

        const count = await DepositRequest.countDocuments({ userId: customer._id });
        expect(count).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2b] Receipt policy for automated payment methods
// ─────────────────────────────────────────────────────────────────────────────

describe('[2b] automated deposit receipt policy', () => {
    let customer;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, currency: 'EGP' });
        await Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'EGP', platformRate: 1, isActive: true });
        await seedPaymentMethods();
        analyzeReceiptBuffer.mockReset();
    });

    const baseRequest = (overrides = {}) => ({
        user: { _id: customer._id },
        body: {
            requestedAmount: '500',
            currency: 'EGP',
            paymentMethodId: 'vodafone-automated',
            transactionId: '022494991382',
            senderWalletNumber: '01012572681',
            ...overrides,
        },
    });

    it('treats configured Vodafone methods as automated regardless of destination account number', async () => {
        await expect(isAutomatedPaymentMethod('vodafone-automated')).resolves.toBe(true);
        await expect(isAutomatedPaymentMethod('mobile-wallet-automated')).resolves.toBe(true);
    });

    it('keeps configured USDT automated and fails closed for non-automated or unknown methods', async () => {
        await expect(isAutomatedPaymentMethod('usdt-automated')).resolves.toBe(true);
        await expect(isAutomatedPaymentMethod('orange-cash-manual')).resolves.toBe(false);
        await expect(isAutomatedPaymentMethod('bank-transfer-manual')).resolves.toBe(false);
        await expect(isAutomatedPaymentMethod('unknown-vodafone-method')).resolves.toBe(false);
    });

    it('creates a receiptless automated Vodafone deposit with a destination account as PENDING', async () => {
        const result = await invokeCreateDeposit(baseRequest());

        expect(result.error).toBeUndefined();
        expect(result.res.status).toHaveBeenCalledWith(201);
        expect(result.body.data.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(result.body.data.receiptImage).toBeNull();
        expect(analyzeReceiptBuffer).not.toHaveBeenCalled();
    });

    it('accepts a valid receipt for an automated Vodafone deposit', async () => {
        analyzeReceiptBuffer.mockResolvedValue({ isValid: true });
        const request = baseRequest();
        request.file = {
            buffer: Buffer.from('valid-image'),
            filename: 'automated.png',
            mimetype: 'image/png',
            originalname: 'automated.png',
        };

        const result = await invokeCreateDeposit(request);

        expect(result.error).toBeUndefined();
        expect(result.body.data.receiptImage).toBe('uploads/deposits/automated.png');
        expect(analyzeReceiptBuffer).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['manual non-Vodafone mobile wallet', 'orange-cash-manual'],
        ['manual bank transfer', 'bank-transfer-manual'],
        ['unknown payment method', 'unknown-vodafone-method'],
    ])('rejects a receiptless %s deposit', async (_label, paymentMethodId) => {
        const result = await invokeCreateDeposit(baseRequest({ paymentMethodId }));
        expect(result.error).toMatchObject({ code: 'RECEIPT_REQUIRED' });
    });

    it('defends the service boundary against a receiptless manual deposit', async () => {
        await expect(depositService.createDepositRequest({
            userId: customer._id,
            paymentMethodId: 'orange-cash-manual',
            requestedAmount: 500,
            currency: 'EGP',
            exchangeRate: 1,
            amountUsd: 500,
            receiptImage: null,
        })).rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' });
    });

    it('retains invalid-image rejection for manual deposits', async () => {
        analyzeReceiptBuffer.mockResolvedValue({ isValid: false });
        const request = baseRequest({ paymentMethodId: 'orange-cash-manual' });
        request.file = {
            buffer: Buffer.from('not-a-receipt'),
            filename: 'invalid.png',
            mimetype: 'image/png',
            originalname: 'invalid.png',
        };

        const result = await invokeCreateDeposit(request);

        expect(result.error).toMatchObject({ code: 'INVALID_RECEIPT_IMAGE' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] approveDeposit
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] approveDeposit', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();

        deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });
    });

    it('transitions status PENDING → APPROVED', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.status).toBe(DEPOSIT_STATUS.APPROVED);
    });

    it('sets reviewedBy and reviewedAt on approval', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
    });

    it('credits the user wallet by requestedAmount', async () => {
        const before = await User.findById(customer._id);
        expect(before.walletBalance).toBe(0);

        await depositService.approveDeposit(deposit._id, admin._id);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(500);
    });

    it('repays partial debt and recalculates creditUsed', async () => {
        await User.findByIdAndUpdate(customer._id, {
            walletBalance: -500,
            creditLimit: 500,
            creditUsed: 500,
        });

        const debtDeposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
            requestedAmount: 200,
            amountUsd: 200,
        });

        await depositService.approveDeposit(debtDeposit._id, admin._id);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(-300);
        expect(after.creditUsed).toBe(300);
    });

    it('clears debt when deposit overpays and leaves positive balance', async () => {
        await User.findByIdAndUpdate(customer._id, {
            walletBalance: -500,
            creditLimit: 500,
            creditUsed: 500,
        });

        const debtDeposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
            requestedAmount: 700,
            amountUsd: 700,
        });

        await depositService.approveDeposit(debtDeposit._id, admin._id);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(200);
        expect(after.creditUsed).toBe(0);
    });

    it('creates a WalletTransaction CREDIT record', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const tx = await WalletTransaction.findOne({ userId: customer._id, type: 'CREDIT' });
        expect(tx).not.toBeNull();
        expect(tx.amount).toBe(500);
        expect(tx.balanceBefore).toBe(0);
        expect(tx.balanceAfter).toBe(500);
    });

    it('uses override amount instead of requestedAmount when provided', async () => {
        await depositService.approveDeposit(deposit._id, admin._id, { amount: 300 });

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.requestedAmount).toBe(300);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(300);
    });

    it('creates DEPOSIT_APPROVED and WALLET_CREDIT audit logs', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        await flushAudit();

        const approveLog = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        expect(approveLog).not.toBeNull();
        expect(approveLog.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(approveLog.metadata.finalAmount).toBe(500);

        const walletLog = await AuditLog.findOne({ action: WALLET_ACTIONS.CREDIT }).lean();
        expect(walletLog).not.toBeNull();
        expect(walletLog.entityType).toBe(ENTITY_TYPES.WALLET);
        expect(walletLog.entityId.toString()).toBe(customer._id.toString());
    });

    it('throws DEPOSIT_ALREADY_APPROVED when approving a second time', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
    });

    it('throws DEPOSIT_ALREADY_REJECTED when approving a rejected deposit', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(
            depositService.approveDeposit(fakeId, admin._id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('wallet is NOT credited when approval fails (transaction rollback)', async () => {
        // First approval succeeds
        await depositService.approveDeposit(deposit._id, admin._id);
        const balanceAfterFirst = (await User.findById(customer._id)).walletBalance;

        // Second approval throws — wallet must not change
        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toBeDefined();

        const balanceAfterSecond = (await User.findById(customer._id)).walletBalance;
        expect(balanceAfterSecond).toBe(balanceAfterFirst);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] rejectDeposit
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] rejectDeposit', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();

        deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });
    });

    it('transitions status PENDING → REJECTED', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.status).toBe(DEPOSIT_STATUS.REJECTED);
    });

    it('sets reviewedBy and reviewedAt on rejection', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
    });

    it('does NOT credit the wallet on rejection', async () => {
        const before = (await User.findById(customer._id)).walletBalance;
        await depositService.rejectDeposit(deposit._id, admin._id);
        const after = (await User.findById(customer._id)).walletBalance;

        expect(after).toBe(before);
    });

    it('does NOT create a WalletTransaction on rejection', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        const count = await WalletTransaction.countDocuments({ userId: customer._id });
        expect(count).toBe(0);
    });

    it('creates DEPOSIT_REJECTED audit log', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.actorId.toString()).toBe(admin._id.toString());
    });

    it('throws DEPOSIT_ALREADY_REJECTED when rejecting a second time', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(
            depositService.rejectDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
    });

    it('throws DEPOSIT_ALREADY_APPROVED when rejecting an approved deposit', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        await expect(
            depositService.rejectDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(
            depositService.rejectDeposit(new mongoose.Types.ObjectId(), admin._id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [5] CONCURRENCY
// ─────────────────────────────────────────────────────────────────────────────

describe('[5] Concurrency', () => {
    it('two concurrent approve calls: only one succeeds, wallet credited once', async () => {
        const group = await ensureGroup();
        const customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        const admin = await createAdmin();

        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,  // requestedAmount: 500
        });

        // Fire two approvals simultaneously
        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Exactly one succeeds
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.code).toBe('DEPOSIT_ALREADY_APPROVED');

        // Wallet credited exactly once
        const user = await User.findById(customer._id);
        expect(user.walletBalance).toBe(500);

        // Only one CREDIT transaction
        const txCount = await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' });
        expect(txCount).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [6] LIST QUERIES
// ─────────────────────────────────────────────────────────────────────────────

describe('[6] listDeposits / listMyDeposits', () => {
    let customerA;
    let customerB;
    let admin;

    beforeEach(async () => {
        const group = await ensureGroup();
        customerA = await createCustomer({ groupId: group._id });
        customerB = await createCustomer({ groupId: group._id });
        admin = await createAdmin();

        // 3 deposits for customerA (2 pending, 1 approved)
        const d1 = await depositService.createDepositRequest({ userId: customerA._id, ...VALID_DEPOSIT });
        await depositService.approveDeposit(d1._id, admin._id);
        await depositService.createDepositRequest({
            userId: customerA._id,
            ...VALID_DEPOSIT,
            requestedAmount: 200,
            amountUsd: 200,
        });
        await depositService.createDepositRequest({
            userId: customerA._id,
            ...VALID_DEPOSIT,
            requestedAmount: 300,
            amountUsd: 300,
        });

        // 1 deposit for customerB
        await depositService.createDepositRequest({
            userId: customerB._id,
            ...VALID_DEPOSIT,
            requestedAmount: 100,
            amountUsd: 100,
        });
    });

    it('listDeposits returns all deposits for admin', async () => {
        const result = await depositService.listDeposits();
        expect(result.deposits.length).toBe(4);
        expect(result.pagination.total).toBe(4);
    });

    it('listDeposits filters by status=PENDING', async () => {
        const result = await depositService.listDeposits({ status: DEPOSIT_STATUS.PENDING });
        expect(result.deposits.every(d => d.status === DEPOSIT_STATUS.PENDING)).toBe(true);
        expect(result.deposits.length).toBe(3);
    });

    it('listDeposits filters by status=APPROVED', async () => {
        const result = await depositService.listDeposits({ status: DEPOSIT_STATUS.APPROVED });
        expect(result.deposits.every(d => d.status === DEPOSIT_STATUS.APPROVED)).toBe(true);
        expect(result.deposits.length).toBe(1);
    });

    it('listMyDeposits returns only the requesting user deposits', async () => {
        const result = await depositService.listMyDeposits(customerA._id);
        expect(result.deposits.length).toBe(3);
        result.deposits.forEach(d => expect(d.userId.toString()).toBe(customerA._id.toString()));
    });

    it('listDeposits paginates correctly', async () => {
        const page1 = await depositService.listDeposits({ page: 1, limit: 2 });
        const page2 = await depositService.listDeposits({ page: 2, limit: 2 });

        expect(page1.deposits).toHaveLength(2);
        expect(page2.deposits).toHaveLength(2);
        expect(page1.pagination.total).toBe(4);
        expect(page1.pagination.pages).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [7] getDepositById
// ─────────────────────────────────────────────────────────────────────────────

describe('[7] getDepositById', () => {
    let customer;
    let otherCustomer;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id });
        otherCustomer = await createCustomer({ groupId: group._id });

        deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });
    });

    it('returns the correct deposit when called without userId restriction', async () => {
        const found = await depositService.getDepositById(deposit._id);
        expect(found._id.toString()).toBe(deposit._id.toString());
    });

    it('returns the deposit when requestingUserId matches', async () => {
        const found = await depositService.getDepositById(deposit._id, customer._id);
        expect(found._id.toString()).toBe(deposit._id.toString());
    });

    it('throws AuthorizationError when requestingUserId does not match', async () => {
        await expect(
            depositService.getDepositById(deposit._id, otherCustomer._id)
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(
            depositService.getDepositById(new mongoose.Types.ObjectId())
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [8] AUDIT CORRECTNESS
// ─────────────────────────────────────────────────────────────────────────────

describe('[8] Audit log correctness', () => {
    let customer;
    let admin;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();
    });

    it('DEPOSIT_REQUESTED log does not contain sensitive token fields', async () => {
        await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log.metadata.password).toBeUndefined();
        expect(log.metadata.token).toBeUndefined();
        expect(log.metadata.accessToken).toBeUndefined();
    });

    it('DEPOSIT_REQUESTED log entityId matches the deposit _id', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
    });

    it('DEPOSIT_APPROVED log records finalAmount in metadata', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await depositService.approveDeposit(deposit._id, admin._id, { amount: 450 });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        expect(log.metadata.finalAmount).toBe(450);
        expect(log.metadata.originalRequestedAmount).toBe(500);
    });

    it('DEPOSIT_REJECTED log records the admin reviewer', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log.actorId.toString()).toBe(admin._id.toString());
        expect(log.metadata.reviewedBy.toString()).toBe(admin._id.toString());
    });

    it('no DEPOSIT_APPROVED or WALLET_CREDIT logs when approval fails', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });

        // Manually REJECT the deposit so approval will throw
        await DepositRequest.findByIdAndUpdate(deposit._id, { status: DEPOSIT_STATUS.REJECTED });

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toBeDefined();

        await flushAudit();

        const approveCount = await AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED });
        const creditCount = await AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT });

        expect(approveCount).toBe(0);
        expect(creditCount).toBe(0);
    });
});
