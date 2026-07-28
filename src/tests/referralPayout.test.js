'use strict';

const mongoose = require('mongoose');
const referralPayoutService = require('../modules/referralPayouts/referralPayout.service');
const {
    ReferralPayout,
    REFERRAL_PAYOUT_METHODS,
    REFERRAL_PAYOUT_STATUS,
} = require('../modules/referralPayouts/referralPayout.model');
const {
    ReferralCommission,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_COMMISSION_SOURCE_TYPES,
} = require('../modules/referrals/referralCommission.model');
const {
    WalletTransaction,
    WALLET_TRANSACTION_SOURCE_TYPES,
} = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const throwingHook = (message) => async () => {
    throw new Error(message);
};

const createPayoutActors = async (overrides = {}) => {
    const { customer: referrer } = await createCustomerWithGroup({
        walletBalance: 25,
        currency: 'USD',
        ...overrides.referrer,
    });
    const { customer: referred } = await createCustomerWithGroup({
        walletBalance: 0,
        currency: 'USD',
        ...overrides.referred,
    });
    const admin = await createAdmin();
    return { referrer, referred, admin };
};

const createCommission = async ({
    referrer,
    referred,
    amount = '10.000000',
    currency = 'USD',
    status = REFERRAL_COMMISSION_STATUS.AVAILABLE,
    payoutRequestId = null,
    sourceCompletedAt = new Date(),
    overrides = {},
}) => ReferralCommission.create({
    referrerUserId: referrer._id,
    referredUserId: referred._id,
    sourceType: REFERRAL_COMMISSION_SOURCE_TYPES.DEPOSIT_APPROVAL,
    sourceId: new mongoose.Types.ObjectId(),
    idempotencyKey: `test:${new mongoose.Types.ObjectId()}`,
    originalAmount: '100.000000',
    originalCurrency: currency,
    commissionPercentSnapshot: '10.000000',
    commissionAmountOriginalCurrency: amount,
    referrerCurrency: currency,
    commissionAmountReferrerCurrency: amount,
    sourcePlatformRateSnapshot: '1.000000',
    targetPlatformRateSnapshot: '1.000000',
    effectiveFxRateSnapshot: '1.000000',
    convertedAt: new Date(),
    status,
    payoutRequestId,
    referralStartedAt: new Date(Date.now() - 60_000),
    eligibleUntil: new Date(Date.now() + 86_400_000),
    sourceCompletedAt,
    ...overrides,
});

const createWalletPayout = async ({ referrer, commissionIds, body = {} }) =>
    referralPayoutService.createReferralPayout({
        userId: referrer._id,
        body: {
            method: 'wallet',
            currency: 'USD',
            commissionIds: commissionIds.map((id) => id.toString()),
            ...body,
        },
    });

const expectLocked = async (commissionIds, payoutId) => {
    const count = await ReferralCommission.countDocuments({
        _id: { $in: commissionIds },
        status: REFERRAL_COMMISSION_STATUS.LOCKED,
        payoutRequestId: payoutId,
    });
    expect(count).toBe(commissionIds.length);
};

describe('Referral payout creation and locking', () => {
    it('creates a pending wallet payout and atomically locks only selected available commissions', async () => {
        const { referrer, referred } = await createPayoutActors();
        const first = await createCommission({ referrer, referred, amount: '7.500000' });
        const second = await createCommission({ referrer, referred, amount: '2.250000' });

        const payout = await createWalletPayout({ referrer, commissionIds: [first._id, second._id] });

        expect(payout.method).toBe(REFERRAL_PAYOUT_METHODS.WALLET_CREDIT);
        expect(payout.statusCode).toBe(REFERRAL_PAYOUT_STATUS.PENDING);
        expect(payout.amount).toBe('9.750000');
        await expectLocked([first._id, second._id], payout.id);
    });

    it('supports amount-only compatibility by locking exact oldest whole commissions only', async () => {
        const { referrer, referred } = await createPayoutActors();
        const older = new Date(Date.now() - 10_000);
        const newer = new Date(Date.now() - 5_000);
        const first = await createCommission({ referrer, referred, amount: '4.000000', sourceCompletedAt: older });
        const second = await createCommission({ referrer, referred, amount: '6.000000', sourceCompletedAt: newer });

        const payout = await referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: { method: 'wallet', currency: 'USD', amount: '10.000000' },
        });

        expect(payout.amount).toBe('10.000000');
        await expectLocked([first._id, second._id], payout.id);

        await expect(referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: { method: 'wallet', currency: 'USD', amount: '1.000000' },
        })).rejects.toMatchObject({ code: 'PAYOUT_AMOUNT_REQUIRES_COMMISSION_SELECTION' });
    });

    it('rejects cross-user, unavailable, mixed-currency, and wallet-currency-mismatch requests', async () => {
        const { referrer, referred } = await createPayoutActors();
        const { referrer: otherReferrer } = await createPayoutActors();
        const own = await createCommission({ referrer, referred, amount: '3.000000' });
        const other = await createCommission({ referrer: otherReferrer, referred, amount: '3.000000' });
        const eur = await createCommission({ referrer, referred, amount: '3.000000', currency: 'EUR' });

        await expect(createWalletPayout({ referrer, commissionIds: [own._id, other._id] }))
            .rejects.toThrow('You can only request payout for your own referral commissions.');
        await expect(createWalletPayout({ referrer, commissionIds: [own._id, eur._id] }))
            .rejects.toMatchObject({ code: 'PAYOUT_CURRENCY_MISMATCH' });
        await expect(referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: { method: 'wallet', currency: 'EUR', commissionIds: [eur._id.toString()] },
        })).rejects.toMatchObject({ code: 'PAYOUT_WALLET_CURRENCY_MISMATCH' });
    });

    it('rolls back locked commissions if payout creation fails after the commission claim', async () => {
        const { referrer, referred } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred });

        await expect(referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: { method: 'wallet', currency: 'USD', commissionIds: [commission._id.toString()] },
            testHooks: { afterCommissionLockBeforePayoutCreate: throwingHook('create abort') },
        })).rejects.toThrow('create abort');

        expect(await ReferralPayout.countDocuments()).toBe(0);
        const reloaded = await ReferralCommission.findById(commission._id);
        expect(reloaded.status).toBe(REFERRAL_COMMISSION_STATUS.AVAILABLE);
        expect(reloaded.payoutRequestId).toBeNull();
    });

    it('scopes idempotency to user and rejects same-key different payloads', async () => {
        const { referrer, referred } = await createPayoutActors();
        const { referrer: otherReferrer, referred: otherReferred } = await createPayoutActors();
        const first = await createCommission({ referrer, referred, amount: '5.000000' });
        const second = await createCommission({ referrer, referred, amount: '6.000000' });
        const other = await createCommission({ referrer: otherReferrer, referred: otherReferred, amount: '5.000000' });

        const body = {
            method: 'wallet',
            currency: 'USD',
            commissionIds: [first._id.toString()],
            idempotencyKey: 'payout-key-001',
        };
        const created = await referralPayoutService.createReferralPayout({ userId: referrer._id, body });
        const replay = await referralPayoutService.createReferralPayout({ userId: referrer._id, body });
        expect(replay.id).toBe(created.id);
        expect(await ReferralPayout.countDocuments({ userId: referrer._id })).toBe(1);

        await expect(referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: { ...body, commissionIds: [second._id.toString()] },
        })).rejects.toMatchObject({ code: 'PAYOUT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });

        const otherPayout = await referralPayoutService.createReferralPayout({
            userId: otherReferrer._id,
            body: { ...body, commissionIds: [other._id.toString()] },
        });
        expect(otherPayout.id).not.toBe(created.id);
    });

    it('allows multiple requests without an idempotency key and treats blank keys as missing', async () => {
        const { referrer, referred } = await createPayoutActors();
        const first = await createCommission({ referrer, referred, amount: '2.000000' });
        const second = await createCommission({ referrer, referred, amount: '3.000000' });

        await createWalletPayout({ referrer, commissionIds: [first._id], body: { idempotencyKey: '   ' } });
        await createWalletPayout({ referrer, commissionIds: [second._id] });

        expect(await ReferralPayout.countDocuments({ userId: referrer._id })).toBe(2);
    });
});

describe('Referral payout rejection', () => {
    it('rejects a pending payout and releases locked commissions without wallet credit', async () => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });

        const rejected = await referralPayoutService.rejectReferralPayout({
            payoutId: payout.id,
            reason: 'Invalid payout details',
            adminId: admin._id,
        });

        expect(rejected.statusCode).toBe(REFERRAL_PAYOUT_STATUS.REJECTED);
        const reloaded = await ReferralCommission.findById(commission._id);
        expect(reloaded.status).toBe(REFERRAL_COMMISSION_STATUS.AVAILABLE);
        expect(reloaded.payoutRequestId).toBeNull();
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(0);
    });

    it('rolls back payout rejection and commission release if the transaction aborts', async () => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });

        await expect(referralPayoutService.rejectReferralPayout({
            payoutId: payout.id,
            reason: 'No account',
            adminId: admin._id,
            testHooks: { afterCommissionReleaseBeforeCommit: throwingHook('reject abort') },
        })).rejects.toThrow('reject abort');

        const reloadedPayout = await ReferralPayout.findById(payout.id);
        const reloadedCommission = await ReferralCommission.findById(commission._id);
        expect(reloadedPayout.status).toBe(REFERRAL_PAYOUT_STATUS.PENDING);
        expect(reloadedCommission.status).toBe(REFERRAL_COMMISSION_STATUS.LOCKED);
        expect(reloadedCommission.payoutRequestId.toString()).toBe(payout.id);
    });
});

describe('Wallet referral payout review', () => {
    it('credits the wallet exactly once, writes a source-keyed ledger entry, and marks commissions paid', async () => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred, amount: '12.345000' });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });

        const paid = await referralPayoutService.payWalletReferralPayout({
            payoutId: payout.id,
            adminId: admin._id,
        });

        expect(paid.statusCode).toBe(REFERRAL_PAYOUT_STATUS.PAID);
        const user = await User.findById(referrer._id);
        expect(user.walletBalance).toBe(37.35);
        const transaction = await WalletTransaction.findOne({ userId: referrer._id });
        expect(transaction).not.toBeNull();
        expect(transaction.amount).toBe(12.35);
        expect(transaction.sourceType).toBe(WALLET_TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT);
        expect(transaction.sourceKey).toBe(`referral:payout:${payout.id}:wallet-credit`);
        const reloadedCommission = await ReferralCommission.findById(commission._id);
        expect(reloadedCommission.status).toBe(REFERRAL_COMMISSION_STATUS.PAID);

        await expect(referralPayoutService.payWalletReferralPayout({
            payoutId: payout.id,
            adminId: admin._id,
        })).rejects.toMatchObject({ code: 'PAYOUT_ALREADY_REVIEWED' });
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(1);
    });

    it.each([
        ['after wallet mutation before ledger', { wallet: { afterWalletMutationBeforeLedger: throwingHook('wallet mutation abort') } }],
        ['after wallet ledger before commissions paid', { wallet: { afterWalletLedgerCreation: throwingHook('wallet ledger abort') } }],
        ['after wallet credit before commissions paid', { afterWalletCreditBeforeCommissionPaid: throwingHook('post credit abort') }],
        ['after commissions paid before final payout update', { afterCommissionPaidBeforePayoutFinal: throwingHook('final abort') }],
    ])('rolls back financial writes when payout payment fails %s', async (_label, testHooks) => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred, amount: '8.000000' });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });

        await expect(referralPayoutService.payWalletReferralPayout({
            payoutId: payout.id,
            adminId: admin._id,
            testHooks,
        })).rejects.toThrow(/abort/);

        const user = await User.findById(referrer._id);
        const reloadedPayout = await ReferralPayout.findById(payout.id);
        const reloadedCommission = await ReferralCommission.findById(commission._id);
        expect(user.walletBalance).toBe(25);
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(0);
        expect(reloadedPayout.status).toBe(REFERRAL_PAYOUT_STATUS.PENDING);
        expect(reloadedPayout.walletTransactionId).toBeNull();
        expect(reloadedCommission.status).toBe(REFERRAL_COMMISSION_STATUS.LOCKED);
        expect(reloadedCommission.payoutRequestId.toString()).toBe(payout.id);
    });

    it('handles concurrent wallet payment attempts with one successful credit', async () => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred, amount: '9.000000' });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });

        const results = await Promise.allSettled([
            referralPayoutService.payWalletReferralPayout({ payoutId: payout.id, adminId: admin._id }),
            referralPayoutService.payWalletReferralPayout({ payoutId: payout.id, adminId: admin._id }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const user = await User.findById(referrer._id);
        expect(user.walletBalance).toBe(34);
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(1);
        expect(await ReferralCommission.countDocuments({ status: REFERRAL_COMMISSION_STATUS.PAID })).toBe(1);
    });

    it('does not roll back a committed wallet payout when a post-commit side effect fails', async () => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred, amount: '4.000000' });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });

        await referralPayoutService.payWalletReferralPayout({
            payoutId: payout.id,
            adminId: admin._id,
            testHooks: { afterCommit: throwingHook('notification abort') },
        });

        const user = await User.findById(referrer._id);
        const reloadedPayout = await ReferralPayout.findById(payout.id);
        expect(user.walletBalance).toBe(29);
        expect(reloadedPayout.status).toBe(REFERRAL_PAYOUT_STATUS.PAID);
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(1);
    });
});

describe('Manual external referral payout review', () => {
    it('records external payment proof and reference without wallet crediting', async () => {
        const { referrer, referred, admin } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred, amount: '11.000000' });
        const payout = await referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: {
                method: 'vodafone',
                currency: 'USD',
                commissionIds: [commission._id.toString()],
                name: 'Account Holder',
                phone: '01012345678',
            },
        });

        const receipt = {
            buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]),
            mimetype: 'image/png',
            originalname: 'receipt.png',
            filename: 'receipt-test.png',
            size: 13,
        };
        const paid = await referralPayoutService.markManualReferralPayoutPaid({
            payoutId: payout.id,
            externalTransactionReference: 'manual-reference-123456',
            receiptFile: receipt,
            adminId: admin._id,
        });

        expect(paid.statusCode).toBe(REFERRAL_PAYOUT_STATUS.PAID);
        expect(paid.paymentProofUrl).toBe('/uploads/referral-payout-receipts/receipt-test.png');
        expect(paid.externalTransactionReference).toContain('***');
        const user = await User.findById(referrer._id);
        expect(user.walletBalance).toBe(25);
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(0);
        const reloadedCommission = await ReferralCommission.findById(commission._id);
        expect(reloadedCommission.status).toBe(REFERRAL_COMMISSION_STATUS.PAID);
    });

    it('rejects external details with forbidden fields or missing destinations', async () => {
        const { referrer, referred } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred });

        await expect(referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: {
                method: 'vodafone',
                currency: 'USD',
                commissionIds: [commission._id.toString()],
                externalDetails: { accountName: 'Holder', token: 'secret', phoneNumber: '0101' },
            },
        })).rejects.toMatchObject({ code: 'PAYOUT_EXTERNAL_DETAILS_FORBIDDEN' });

        await expect(referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: {
                method: 'vodafone',
                currency: 'USD',
                commissionIds: [commission._id.toString()],
                externalDetails: { accountName: 'Holder' },
            },
        })).rejects.toMatchObject({ code: 'PAYOUT_EXTERNAL_DETAILS_REQUIRED' });
    });
});

describe('Referral payout summaries, privacy, and audits', () => {
    it('summarizes available, locked, and paid earnings by currency', async () => {
        const { referrer, referred } = await createPayoutActors();
        const available = await createCommission({ referrer, referred, amount: '1.250000' });
        const locked = await createCommission({
            referrer,
            referred,
            amount: '2.500000',
            status: REFERRAL_COMMISSION_STATUS.LOCKED,
            payoutRequestId: new mongoose.Types.ObjectId(),
        });
        await createCommission({ referrer, referred, amount: '3.750000', status: REFERRAL_COMMISSION_STATUS.PAID });
        await createCommission({ referrer, referred, amount: '100.000000', status: REFERRAL_COMMISSION_STATUS.CANCELLED });

        const summary = await referralPayoutService.buildSummaryGroups(referrer._id);
        expect(summary.availableEarnings.USD).toBe('1.250000');
        expect(summary.lockedEarnings.USD).toBe('2.500000');
        expect(summary.paidEarnings.USD).toBe('3.750000');
        expect(summary.availableEarnings.EUR).toBeUndefined();

        expect(await ReferralCommission.findById(available._id)).not.toBeNull();
        expect(await ReferralCommission.findById(locked._id)).not.toBeNull();
    });

    it('does not expose another customer payout and returns masked admin/customer list fields', async () => {
        const { referrer, referred } = await createPayoutActors();
        const { referrer: other } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred });
        const payout = await referralPayoutService.createReferralPayout({
            userId: referrer._id,
            body: {
                method: 'instapay',
                currency: 'USD',
                commissionIds: [commission._id.toString()],
                name: 'Recipient',
                phone: '01098765432',
            },
        });

        await expect(referralPayoutService.findPayoutForUser(payout.id, other._id))
            .rejects.toMatchObject({ statusCode: 404 });

        const customerList = await referralPayoutService.listPayoutsForUser(referrer._id);
        expect(customerList.payouts[0].externalPaymentDetails).toBeUndefined();
        expect(customerList.payouts[0].externalPaymentSummary.phoneNumber).toContain('***');

        const adminList = await referralPayoutService.listPayoutsForAdmin({ search: referrer.email });
        expect(adminList.payouts).toHaveLength(1);
        expect(adminList.payouts[0].ownerEmail).toBe(referrer.email);
    });

    it('detects payout integrity mismatches without modifying data', async () => {
        const { referrer, referred } = await createPayoutActors();
        const commission = await createCommission({ referrer, referred });
        const payout = await createWalletPayout({ referrer, commissionIds: [commission._id] });
        await ReferralCommission.updateOne({ _id: commission._id }, { $set: { status: REFERRAL_COMMISSION_STATUS.AVAILABLE } });

        const audit = await referralPayoutService.auditReferralPayouts();
        expect(audit.pendingPayoutCommissionStateMismatches).toBe(1);
        const reloadedPayout = await ReferralPayout.findById(payout.id);
        expect(reloadedPayout.status).toBe(REFERRAL_PAYOUT_STATUS.PENDING);
    });
});
