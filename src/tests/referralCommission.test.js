'use strict';

const mongoose = require('mongoose');
const { DepositRequest, DEPOSIT_STATUS, REFERRAL_COMMISSION_PROCESSING_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const { ReferralCommission } = require('../modules/referrals/referralCommission.model');
const referralCommissionService = require('../modules/referrals/referralCommission.service');
const { backfillReferralEligibility } = require('../modules/referrals/referralBackfill.service');
const { calculateReferralEligibleUntil } = require('../modules/referrals/referral.service');
const { Currency } = require('../modules/currency/currency.model');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    delete process.env.REFERRAL_DEFAULT_COMMISSION_PERCENT;
});

const createCurrency = (code, platformRate) => Currency.create({
    code,
    name: `Currency ${code}`,
    symbol: code,
    platformRate,
    marketRate: platformRate,
    isActive: true,
});

const createPendingDeposit = (userId, overrides = {}) => DepositRequest.create({
    userId,
    paymentMethodId: new mongoose.Types.ObjectId().toString(),
    requestedAmount: 1000,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 1000,
    receiptImage: 'uploads/deposits/referral-receipt.jpg',
    ...overrides,
});

const createReferralPair = async ({
    referredAt = new Date(),
    referrerOverrides = {},
    referredOverrides = {},
} = {}) => {
    const { customer: referrer } = await createCustomerWithGroup({
        walletBalance: 0,
        currency: 'USD',
        ...referrerOverrides,
    });
    const { customer: referred } = await createCustomerWithGroup({
        walletBalance: 0,
        currency: 'USD',
        referredBy: referrer._id,
        referredAt,
        referralEligibleUntil: calculateReferralEligibleUntil(referredAt),
        ...referredOverrides,
    });
    return { referrer, referred };
};

const expectAbortedApprovalState = async (depositId, userId) => {
    const deposit = await DepositRequest.findById(depositId);
    const user = await User.findById(userId);
    expect(deposit.status).toBe(DEPOSIT_STATUS.PENDING);
    expect(deposit.reviewedAt).toBeNull();
    expect(deposit.reviewedBy).toBeNull();
    expect(deposit.referralCommissionProcessingStatus).toBe(REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE);
    expect(user.walletBalance).toBe(0);
    expect(user.creditUsed).toBe(0);
    expect(await WalletTransaction.countDocuments({ userId })).toBe(0);
    expect(await ReferralCommission.countDocuments()).toBe(0);
};

const throwingHook = (message) => async () => {
    throw new Error(message);
};

describe('Referral commission engine', () => {
    it('creates one available commission when an eligible referred deposit is approved', async () => {
        const admin = await createAdmin();
        const { referrer, referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 500, amountUsd: 500 });

        await depositService.approveDeposit(deposit._id, admin._id);

        const commission = await ReferralCommission.findOne({ referrerUserId: referrer._id });
        expect(commission).not.toBeNull();
        expect(commission.referredUserId.toString()).toBe(referred._id.toString());
        expect(commission.sourceId.toString()).toBe(deposit._id.toString());
        expect(commission.commissionPercentSnapshot).toBe('1.000000');
        expect(commission.commissionAmountOriginalCurrency).toBe('5.000000');
        expect(commission.commissionAmountReferrerCurrency).toBe('5.000000');

        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.referralCommissionProcessingStatus).toBe(REFERRAL_COMMISSION_PROCESSING_STATUS.PROCESSED);
        expect(updatedDeposit.referralCommissionOutcome).toBe('CREATED');
        expect(updatedDeposit.referralCommissionId.toString()).toBe(commission._id.toString());
    });

    it('marks deposits from non-referred users as not applicable and creates no commission', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup({ walletBalance: 0 });
        const deposit = await createPendingDeposit(customer._id, { requestedAmount: 250, amountUsd: 250 });

        await depositService.approveDeposit(deposit._id, admin._id);

        expect(await ReferralCommission.countDocuments()).toBe(0);
        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.referralCommissionProcessingStatus).toBe(REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE);
        expect(updatedDeposit.referralCommissionOutcome).toBe('NOT_REFERRED');
    });

    it('does not create a commission after the 30-day eligibility window', async () => {
        const admin = await createAdmin();
        const referredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        const { referred } = await createReferralPair({ referredAt });
        const deposit = await createPendingDeposit(referred._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        expect(await ReferralCommission.countDocuments()).toBe(0);
        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.referralCommissionOutcome).toBe('EXPIRED');
    });

    it('applies eligibility boundary as reviewedAt <= referralEligibleUntil', async () => {
        const referredAt = new Date('2026-01-01T00:00:00.000Z');
        const eligibleUntil = calculateReferralEligibleUntil(referredAt);
        const { referred } = await createReferralPair({ referredAt });
        const cases = [
            { offsetMs: -1, expected: 'CREATED' },
            { offsetMs: 0, expected: 'CREATED' },
            { offsetMs: 1, expected: 'EXPIRED' },
        ];

        for (const item of cases) {
            const completedAt = new Date(eligibleUntil.getTime() + item.offsetMs);
            const deposit = await DepositRequest.create({
                userId: referred._id,
                paymentMethodId: new mongoose.Types.ObjectId().toString(),
                requestedAmount: 100,
                currency: 'USD',
                exchangeRate: 1,
                amountUsd: 100,
                receiptImage: 'uploads/deposits/boundary.jpg',
                status: DEPOSIT_STATUS.APPROVED,
                reviewedAt: completedAt,
            });

            const outcome = await referralCommissionService.processDepositReferralCommission({
                deposit,
                sourceAmount: 100,
                sourceCurrency: 'USD',
                sourceCompletedAt: completedAt,
            });
            expect(outcome.outcome).toBe(item.expected);
        }
    });

    it('treats referralCommissionStoppedAt equality as stopped', async () => {
        const stopAt = new Date('2026-01-15T00:00:00.000Z');
        const { referred } = await createReferralPair({
            referredAt: new Date('2026-01-01T00:00:00.000Z'),
            referredOverrides: { referralCommissionStoppedAt: stopAt },
        });
        const cases = [
            { offsetMs: -1, expected: 'CREATED' },
            { offsetMs: 0, expected: 'STOPPED' },
            { offsetMs: 1, expected: 'STOPPED' },
        ];

        for (const item of cases) {
            const completedAt = new Date(stopAt.getTime() + item.offsetMs);
            const deposit = await DepositRequest.create({
                userId: referred._id,
                paymentMethodId: new mongoose.Types.ObjectId().toString(),
                requestedAmount: 100,
                currency: 'USD',
                exchangeRate: 1,
                amountUsd: 100,
                receiptImage: 'uploads/deposits/stop-boundary.jpg',
                status: DEPOSIT_STATUS.APPROVED,
                reviewedAt: completedAt,
            });

            const outcome = await referralCommissionService.processDepositReferralCommission({
                deposit,
                sourceAmount: 100,
                sourceCurrency: 'USD',
                sourceCompletedAt: completedAt,
            });
            expect(outcome.outcome).toBe(item.expected);
        }
    });

    it('honors explicit zero percent override without creating a commission record', async () => {
        const admin = await createAdmin();
        const { referrer, referred } = await createReferralPair({
            referrerOverrides: { referralCommissionPercentOverride: 0 },
        });
        const deposit = await createPendingDeposit(referred._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        expect(await ReferralCommission.countDocuments({ referrerUserId: referrer._id })).toBe(0);
        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.referralCommissionProcessingStatus).toBe(REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE);
        expect(updatedDeposit.referralCommissionOutcome).toBe('ZERO_PERCENT');
    });

    it('preserves explicit zero percent variants and null falls back to default', async () => {
        const zeroNumber = referralCommissionService.validateCommissionPercent(0);
        const zeroString = referralCommissionService.validateCommissionPercent('0');
        expect(zeroNumber.isZero()).toBe(true);
        expect(zeroString.isZero()).toBe(true);
        expect(referralCommissionService.validateCommissionPercent(null, { allowNull: true })).toBeNull();
        expect(referralCommissionService.validateCommissionPercent(undefined, { allowNull: true })).toBeNull();

        const admin = await createAdmin();
        const { referred } = await createReferralPair({
            referrerOverrides: { referralCommissionPercentOverride: null },
        });
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(deposit._id, admin._id);
        const commission = await ReferralCommission.findOne();
        expect(commission.commissionPercentSnapshot).toBe('1.000000');
    });

    it('uses per-referrer positive override instead of the default percent', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair({
            referrerOverrides: { referralCommissionPercentOverride: 2.5 },
        });
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 400, amountUsd: 400 });

        await depositService.approveDeposit(deposit._id, admin._id);

        const commission = await ReferralCommission.findOne();
        expect(commission.commissionPercentSnapshot).toBe('2.500000');
        expect(commission.commissionAmountOriginalCurrency).toBe('10.000000');
    });

    it('converts commission through active platform rates into referrer wallet currency', async () => {
        await createCurrency('EGP', 50);
        await createCurrency('SAR', 4);
        const admin = await createAdmin();
        const { referrer, referred } = await createReferralPair({
            referrerOverrides: { currency: 'SAR' },
            referredOverrides: { currency: 'USD' },
        });
        const deposit = await createPendingDeposit(referred._id, {
            requestedAmount: 1000,
            currency: 'EGP',
            exchangeRate: 50,
            amountUsd: 20,
        });

        await depositService.approveDeposit(deposit._id, admin._id);

        const commission = await ReferralCommission.findOne({ referrerUserId: referrer._id });
        expect(commission.originalCurrency).toBe('EGP');
        expect(commission.referrerCurrency).toBe('SAR');
        expect(commission.commissionAmountOriginalCurrency).toBe('10.000000');
        expect(commission.commissionAmountReferrerCurrency).toBe('0.800000');
        expect(commission.sourcePlatformRateSnapshot).toBe('50.000000');
        expect(commission.targetPlatformRateSnapshot).toBe('4.000000');
    });

    it('proves FX direction for EGP to USD and preserves same-currency snapshots', async () => {
        await createCurrency('EGP', 50);

        const egpToUsd = await referralCommissionService.buildFxCommissionSnapshot({
            originalAmount: 1000,
            originalCurrency: 'EGP',
            referrerCurrency: 'USD',
            commissionPercent: referralCommissionService.validateCommissionPercent(2),
        });
        expect(egpToUsd.commissionAmountOriginalCurrency).toBe('20.000000');
        expect(egpToUsd.commissionAmountReferrerCurrency).toBe('0.400000');
        expect(egpToUsd.effectiveFxRateSnapshot).toBe('0.020000000000');

        const egpToEgp = await referralCommissionService.buildFxCommissionSnapshot({
            originalAmount: 1000,
            originalCurrency: 'EGP',
            referrerCurrency: 'EGP',
            commissionPercent: referralCommissionService.validateCommissionPercent(2),
        });
        expect(egpToEgp.commissionAmountOriginalCurrency).toBe('20.000000');
        expect(egpToEgp.commissionAmountReferrerCurrency).toBe('20.000000');
        expect(egpToEgp.effectiveFxRateSnapshot).toBe('1.000000000000');
    });

    it('keeps six-decimal precision for small and repeating-decimal commissions', async () => {
        await createCurrency('KWD', 0.307);
        await createCurrency('JPY', 155);

        const tiny = await referralCommissionService.buildFxCommissionSnapshot({
            originalAmount: '0.20',
            originalCurrency: 'USD',
            referrerCurrency: 'USD',
            commissionPercent: referralCommissionService.validateCommissionPercent('0.1'),
        });
        expect(tiny.commissionAmountOriginalCurrency).toBe('0.000200');
        expect(tiny.commissionAmountReferrerCurrency).toBe('0.000200');

        const kwd = await referralCommissionService.buildFxCommissionSnapshot({
            originalAmount: 10,
            originalCurrency: 'KWD',
            referrerCurrency: 'USD',
            commissionPercent: referralCommissionService.validateCommissionPercent('1.333333'),
        });
        expect(kwd.commissionAmountOriginalCurrency).toBe('0.133333');
        expect(kwd.commissionAmountReferrerCurrency).toBe('0.434309');

        const jpy = await referralCommissionService.buildFxCommissionSnapshot({
            originalAmount: 1000,
            originalCurrency: 'JPY',
            referrerCurrency: 'USD',
            commissionPercent: referralCommissionService.validateCommissionPercent(1),
        });
        expect(jpy.commissionAmountOriginalCurrency).toBe('10.000000');
        expect(jpy.commissionAmountReferrerCurrency).toBe('0.064516');
    });

    it('marks commission processing failed when the referrer currency has no active FX configuration', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair({
            referrerOverrides: { currency: 'EGP' },
        });
        const deposit = await createPendingDeposit(referred._id, {
            requestedAmount: 100,
            currency: 'USD',
            exchangeRate: 1,
            amountUsd: 100,
        });

        await depositService.approveDeposit(deposit._id, admin._id);

        expect(await ReferralCommission.countDocuments()).toBe(0);
        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.referralCommissionProcessingStatus).toBe(REFERRAL_COMMISSION_PROCESSING_STATUS.FAILED);
        expect(updatedDeposit.referralCommissionOutcome).toBe('FAILED_CONFIGURATION');
        expect(updatedDeposit.referralCommissionError).toBe('TARGET_CURRENCY_CONFIGURATION_MISSING');
    });

    it('reconciles failed FX processing after currency configuration is added without touching wallet balance', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair({
            referrerOverrides: { currency: 'EGP' },
        });
        const deposit = await createPendingDeposit(referred._id, {
            requestedAmount: 100,
            currency: 'USD',
            exchangeRate: 1,
            amountUsd: 100,
        });
        await depositService.approveDeposit(deposit._id, admin._id);
        const walletAfterApproval = (await User.findById(referred._id)).walletBalance;

        await createCurrency('EGP', 50);
        const dryRun = await referralCommissionService.reconcileReferralCommissions({ dryRun: true, depositId: deposit._id });
        expect(dryRun.candidates).toBe(1);
        expect(dryRun.processed).toBe(0);

        const writeRun = await referralCommissionService.reconcileReferralCommissions({ dryRun: false, depositId: deposit._id });
        expect(writeRun.created).toBe(1);
        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.referralCommissionProcessingStatus).toBe(REFERRAL_COMMISSION_PROCESSING_STATUS.PROCESSED);
        expect(updatedDeposit.referralCommissionOutcome).toBe('CREATED');
        expect(updatedDeposit.referralCommissionError).toBeNull();
        expect((await User.findById(referred._id)).walletBalance).toBe(walletAfterApproval);

        const secondRun = await referralCommissionService.reconcileReferralCommissions({ dryRun: false, depositId: deposit._id, failedOnly: false });
        expect(secondRun.alreadyExists).toBe(1);
        expect(await ReferralCommission.countDocuments()).toBe(1);
    });

    it('concurrent reconciliation attempts create only one commission and do not alter wallet balance', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair({
            referrerOverrides: { currency: 'EGP' },
        });
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 200, amountUsd: 200 });
        await depositService.approveDeposit(deposit._id, admin._id);
        const walletAfterApproval = (await User.findById(referred._id)).walletBalance;
        await createCurrency('EGP', 50);

        await Promise.all([
            referralCommissionService.reconcileReferralCommissions({ dryRun: false, depositId: deposit._id }),
            referralCommissionService.reconcileReferralCommissions({ dryRun: false, depositId: deposit._id }),
        ]);

        expect(await ReferralCommission.countDocuments()).toBe(1);
        expect((await User.findById(referred._id)).walletBalance).toBe(walletAfterApproval);
    });

    it('reconciliation skips non-approved and deterministic non-commission deposits', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair({
            referrerOverrides: { referralCommissionPercentOverride: 0 },
        });
        const pending = await createPendingDeposit(referred._id);
        const zeroDeposit = await createPendingDeposit(referred._id);
        await depositService.approveDeposit(zeroDeposit._id, admin._id);

        const result = await referralCommissionService.reconcileReferralCommissions({
            dryRun: false,
            failedOnly: false,
        });

        expect(result.scanned).toBe(1);
        expect(result.processed).toBe(1);
        expect(await ReferralCommission.countDocuments()).toBe(0);
        expect((await DepositRequest.findById(pending._id)).status).toBe(DEPOSIT_STATUS.PENDING);
    });

    it('creates only one commission when two approval attempts race', async () => {
        const admin = await createAdmin();
        const { referrer, referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id);

        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(await ReferralCommission.countDocuments({ referrerUserId: referrer._id })).toBe(1);
    });

    it('approval and rejection attempted concurrently leave exactly one terminal state', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id);

        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.rejectDeposit(deposit._id, admin._id),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

        const finalDeposit = await DepositRequest.findById(deposit._id);
        const walletTxCount = await WalletTransaction.countDocuments({ userId: referred._id });
        if (finalDeposit.status === DEPOSIT_STATUS.APPROVED) {
            expect(walletTxCount).toBe(1);
            expect(await ReferralCommission.countDocuments()).toBe(1);
        } else {
            expect(finalDeposit.status).toBe(DEPOSIT_STATUS.REJECTED);
            expect(walletTxCount).toBe(0);
            expect(await ReferralCommission.countDocuments()).toBe(0);
        }
    });

    it('rolls back all financial writes when failures are injected before wallet update', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id, {}, null, {
            beforeWalletUpdate: throwingHook('before wallet'),
        })).rejects.toThrow('before wallet');

        await expectAbortedApprovalState(deposit._id, referred._id);
    });

    it('rolls back all financial writes when failure occurs after wallet mutation before ledger', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id, {}, null, {
            wallet: { afterWalletMutationBeforeLedger: throwingHook('after wallet mutation') },
        })).rejects.toThrow('after wallet mutation');

        await expectAbortedApprovalState(deposit._id, referred._id);
    });

    it('rolls back all financial writes when failure occurs after ledger before commission', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id, {}, null, {
            wallet: { afterWalletLedgerCreation: throwingHook('after ledger') },
        })).rejects.toThrow('after ledger');

        await expectAbortedApprovalState(deposit._id, referred._id);
    });

    it('rolls back all financial writes when failure occurs after commission creation before marker update', async () => {
        const admin = await createAdmin();
        const { referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id, {}, null, {
            commission: { afterCommissionCreationBeforeMarker: throwingHook('after commission') },
        })).rejects.toThrow('after commission');

        await expectAbortedApprovalState(deposit._id, referred._id);
    });

    it('commits financial writes when post-commit notification fails', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const admin = await createAdmin();
        const { referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 300, amountUsd: 300 });

        await expect(depositService.approveDeposit(deposit._id, admin._id, {}, null, {
            notifyDepositApproved: () => {
                throw new Error('notification down');
            },
        })).resolves.toBeDefined();

        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.APPROVED);
        expect((await User.findById(referred._id)).walletBalance).toBe(300);
        expect(await WalletTransaction.countDocuments({ userId: referred._id })).toBe(1);
        expect(await ReferralCommission.countDocuments()).toBe(1);
        consoleSpy.mockRestore();
    });

    it('handles duplicate commission creation as already existing with invariant validation', async () => {
        const admin = await createAdmin();
        const { referrer, referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(deposit._id, admin._id);

        const approvedDeposit = await DepositRequest.findById(deposit._id);
        const outcome = await referralCommissionService.processDepositReferralCommission({
            deposit: approvedDeposit,
            sourceAmount: approvedDeposit.requestedAmount,
            sourceCurrency: approvedDeposit.currency,
            sourceCompletedAt: approvedDeposit.reviewedAt,
        });
        expect(outcome.outcome).toBe('ALREADY_EXISTS');
        expect(await ReferralCommission.countDocuments({ referrerUserId: referrer._id })).toBe(1);

        await expect(referralCommissionService.processDepositReferralCommission({
            deposit: approvedDeposit,
            sourceAmount: 999,
            sourceCurrency: approvedDeposit.currency,
            sourceCompletedAt: approvedDeposit.reviewedAt,
        })).rejects.toMatchObject({ code: 'REFERRAL_COMMISSION_IDEMPOTENCY_CONFLICT' });
    });

    it('summarizes customer commissions by referrer currency', async () => {
        const admin = await createAdmin();
        const { referrer, referred } = await createReferralPair();
        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 200, amountUsd: 200 });
        await depositService.approveDeposit(deposit._id, admin._id);

        const summary = await referralCommissionService.getReferralCommissionSummaryForReferrer(referrer._id);
        expect(summary).toHaveLength(1);
        expect(summary[0]).toMatchObject({
            currency: 'USD',
            available: '2.000000',
            total: '2.000000',
            count: 1,
        });
    });

    it('lists only the authenticated referrer commissions and rejects invalid status filters', async () => {
        const admin = await createAdmin();
        const first = await createReferralPair();
        const second = await createReferralPair();
        await depositService.approveDeposit((await createPendingDeposit(first.referred._id))._id, admin._id);
        await depositService.approveDeposit((await createPendingDeposit(second.referred._id))._id, admin._id);

        const result = await referralCommissionService.listReferralCommissionsForReferrer(first.referrer._id, {
            limit: 500,
            status: 'available',
        });
        expect(result.commissions).toHaveLength(1);
        expect(result.pagination.limit).toBe(100);
        expect(result.commissions[0].referrerUserId.toString()).toBe(first.referrer._id.toString());

        await expect(referralCommissionService.listReferralCommissionsForReferrer(first.referrer._id, {
            status: 'UNKNOWN',
        })).rejects.toMatchObject({ code: 'REFERRAL_COMMISSION_STATUS_INVALID' });
    });

    it('updates, clears, and validates admin referral commission overrides', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();

        const updated = await referralCommissionService.setReferralCommissionOverride({
            userId: customer._id,
            percent: 3,
            adminId: admin._id,
        });
        expect(updated.referralCommissionPercentOverride).toBe(3);

        const cleared = await referralCommissionService.setReferralCommissionOverride({
            userId: customer._id,
            percent: null,
            adminId: admin._id,
        });
        expect(cleared.referralCommissionPercentOverride).toBeNull();

        await expect(referralCommissionService.setReferralCommissionOverride({
            userId: customer._id,
            percent: 60,
            adminId: admin._id,
        })).rejects.toMatchObject({ code: 'REFERRAL_COMMISSION_PERCENT_TOO_HIGH' });
    });

    it('backfills referral eligibility in dry-run and explicit write mode', async () => {
        const referredAt = new Date('2026-01-01T00:00:00.000Z');
        const { referrer } = await createReferralPair();
        const { customer: referred } = await createCustomerWithGroup({
            referredBy: referrer._id,
            referredAt,
            referralEligibleUntil: null,
        });

        const dryRun = await backfillReferralEligibility({ dryRun: true, batchSize: 2 });
        expect(dryRun.eligible).toBeGreaterThanOrEqual(1);
        expect(dryRun.updated).toBe(0);
        expect((await User.findById(referred._id)).referralEligibleUntil).toBeNull();

        const writeRun = await backfillReferralEligibility({ dryRun: false, batchSize: 2 });
        expect(writeRun.updated).toBeGreaterThanOrEqual(1);
        const updated = await User.findById(referred._id);
        expect(updated.referralEligibleUntil.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    });
});
