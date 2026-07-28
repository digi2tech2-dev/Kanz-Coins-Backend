'use strict';

const mongoose = require('mongoose');
const referralDashboardService = require('../modules/referrals/referralDashboard.service');
const { Setting } = require('../modules/admin/setting.model');
const {
    ReferralCommission,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_COMMISSION_SOURCE_TYPES,
} = require('../modules/referrals/referralCommission.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
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

const createCommission = async ({
    referrer,
    referred,
    amount = '5.000000',
    currency = 'USD',
    status = REFERRAL_COMMISSION_STATUS.AVAILABLE,
} = {}) => ReferralCommission.create({
    referrerUserId: referrer._id,
    referredUserId: referred._id,
    sourceType: REFERRAL_COMMISSION_SOURCE_TYPES.DEPOSIT_APPROVAL,
    sourceId: new mongoose.Types.ObjectId(),
    idempotencyKey: `frontend-integration:${new mongoose.Types.ObjectId()}`,
    originalAmount: '500.000000',
    originalCurrency: currency,
    commissionPercentSnapshot: '1.000000',
    commissionAmountOriginalCurrency: amount,
    referrerCurrency: currency,
    commissionAmountReferrerCurrency: amount,
    sourcePlatformRateSnapshot: '1.000000',
    targetPlatformRateSnapshot: '1.000000',
    effectiveFxRateSnapshot: '1.000000',
    convertedAt: new Date(),
    status,
    referralStartedAt: new Date(Date.now() - 60_000),
    eligibleUntil: new Date(Date.now() + 86_400_000),
    sourceCompletedAt: new Date(),
});

describe('Referral frozen-frontend aggregation contracts', () => {
    it('returns customer dashboard data scoped to the authenticated referrer only', async () => {
        const { customer: referrer } = await createCustomerWithGroup({ currency: 'USD' });
        const { customer: invited } = await createCustomerWithGroup({
            currency: 'USD',
            referredBy: referrer._id,
            referredAt: new Date('2026-07-01T00:00:00.000Z'),
            referralEligibleUntil: new Date('2026-07-31T00:00:00.000Z'),
        });
        const { customer: otherReferrer } = await createCustomerWithGroup({ currency: 'USD' });
        const { customer: otherInvited } = await createCustomerWithGroup({
            referredBy: otherReferrer._id,
            referredAt: new Date('2026-07-02T00:00:00.000Z'),
        });
        await createCommission({ referrer, referred: invited, amount: '7.500000' });
        await createCommission({ referrer: otherReferrer, referred: otherInvited, amount: '99.000000' });

        const dashboard = await referralDashboardService.getCustomerReferralDashboard(referrer._id);

        expect(dashboard.referralCode).toBe(referrer.referralCode);
        expect(dashboard.referralCount).toBe(1);
        expect(dashboard.invitedUsers).toHaveLength(1);
        expect(dashboard.invitedUsers[0].id).toBe(invited._id.toString());
        expect(dashboard.invitedUsers[0].password).toBeUndefined();
        expect(dashboard.invitedUsers[0].apiToken).toBeUndefined();
        expect(dashboard.availableEarnings.USD).toBe('7.500000');
        expect(dashboard.displayAvailableEarnings).toBe('7.500000');
    });

    it('groups admin referral-agent totals by currency and supports search', async () => {
        const { customer: referrer } = await createCustomerWithGroup({
            name: 'Agent Search Match',
            email: 'agent-search@example.test',
            currency: 'USD',
        });
        const { customer: invited } = await createCustomerWithGroup({
            referredBy: referrer._id,
            referredAt: new Date(),
        });
        await createCommission({ referrer, referred: invited, amount: '3.250000', currency: 'USD' });
        await createCommission({ referrer, referred: invited, amount: '2.000000', currency: 'EUR' });

        const result = await referralDashboardService.listAdminReferralAgents({ search: 'search match' });
        const agent = result.agents.find((entry) => entry.id === referrer._id.toString());

        expect(agent).toBeTruthy();
        expect(agent.email).toBe('agent-search@example.test');
        expect(agent.commissionSummary).toEqual(expect.arrayContaining([
            expect.objectContaining({ currency: 'USD', available: '3.250000' }),
            expect.objectContaining({ currency: 'EUR', available: '2.000000' }),
        ]));
        expect(agent.earnings).toBe('3.250000');
    });

    it('normalizes referral payout methods and returns only active methods for customers', async () => {
        await Setting.create({
            key: referralDashboardService.REFERRAL_PAYOUT_METHODS_SETTING_KEY,
            value: [
                { id: 'wallet', name: 'Wallet', enabled: true, requiresAccount: false, discountPercent: 0 },
                { id: 'vodafone', name: 'Vodafone', enabled: false, requiresAccount: true, discountPercent: 5 },
                { id: 'instapay', name: 'InstaPay', enabled: true, requiresAccount: true, discountPercent: 2.5 },
            ],
        });

        const active = await referralDashboardService.getReferralPayoutMethods({ activeOnly: true });

        expect(active.map((method) => method.id)).toEqual(['wallet', 'instapay']);
        expect(active.find((method) => method.id === 'wallet').kind).toBe('wallet_credit');
        expect(active.find((method) => method.id === 'instapay').kind).toBe('manual_external');
    });
});
