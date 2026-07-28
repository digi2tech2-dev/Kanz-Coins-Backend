'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Currency } = require('../modules/currency/currency.model');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { register, login } = require('../modules/auth/auth.service');
const {
    createGoogleOAuthState,
    consumeGoogleOAuthState,
    clearUsedOAuthStateNoncesForTests,
} = require('../modules/auth/oauthState.service');
const { resolveGoogleUser } = require('../modules/auth/googleOAuth.service');
const { createUserWithReferralCodeRetry } = require('../modules/referrals/referral.service');
const { backfillReferralCodes } = require('../modules/referrals/referralBackfill.service');
const userService = require('../modules/users/user.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    await clearUsedOAuthStateNoncesForTests();
});

afterEach(() => {
    jest.restoreAllMocks();
});

const seedCurrency = (overrides = {}) => Currency.create({
    code: overrides.code || 'USD',
    name: overrides.name || 'US Dollar',
    symbol: overrides.symbol || '$',
    platformRate: overrides.platformRate || 1,
    isActive: overrides.isActive !== false,
});

const googleProfile = (overrides = {}) => ({
    id: overrides.id || `google-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    displayName: overrides.displayName || 'Google User',
    emails: [{ value: overrides.email || `google-${Date.now()}@example.com` }],
});

describe('referral identity', () => {
    it('assigns a stable referral code to a new email user', async () => {
        await seedCurrency();
        await createGroup({ name: 'Default', percentage: 0 });

        const result = await register({
            name: 'Alice',
            email: `alice-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            currency: 'USD',
            country: 'us',
        });

        const dbUser = await User.findById(result.user._id);
        expect(dbUser.referralCode).toMatch(/^[A-Z0-9]{10}$/);
        expect(dbUser.country).toBe('US');

        const originalCode = dbUser.referralCode;
        await userService.updateMyProfile(dbUser._id, { name: 'Alice Updated' });
        const updated = await User.findById(dbUser._id);
        expect(updated.referralCode).toBe(originalCode);
    });

    it('assigns a stable referral code to a new Google user and keeps it on repeated login', async () => {
        await createGroup({ name: 'GoogleDefault', percentage: 0 });

        const profile = googleProfile({ email: `google-stable-${Date.now()}@example.com` });
        const first = await resolveGoogleUser(profile, { intent: 'login' });
        const firstCode = first.user.referralCode;

        const second = await resolveGoogleUser(profile, {
            intent: 'signup',
            referralCode: 'IGNORED1',
        });

        expect(first.isNewUser).toBe(true);
        expect(firstCode).toMatch(/^[A-Z0-9]{10}$/);
        expect(second.isNewUser).toBe(false);
        expect(second.user.referralCode).toBe(firstCode);
        expect(second.user.referredBy).toBeFalsy();
    });

    it('retries referral-code collisions during generated user creation', async () => {
        const group = await createGroup({ name: 'CollisionGroup', percentage: 0 });
        await User.create({
            name: 'Existing',
            email: `existing-${Date.now()}@example.com`,
            groupId: group._id,
            role: 'CUSTOMER',
            status: USER_STATUS.ACTIVE,
            verified: true,
            referralCode: 'AAAAAAAAAA',
        });

        let calls = 0;
        jest.spyOn(crypto, 'randomInt').mockImplementation(() => {
            calls += 1;
            return calls <= 10 ? 0 : 1;
        });

        const user = await createUserWithReferralCodeRetry({
            name: 'Retry User',
            email: `retry-${Date.now()}@example.com`,
            groupId: group._id,
            role: 'CUSTOMER',
            status: USER_STATUS.ACTIVE,
            verified: true,
        });

        expect(user.referralCode).toBe('BBBBBBBBBB');
    });

    it('backfill skips existing codes and dry-run performs no writes', async () => {
        const group = await createGroup({ name: 'BackfillGroup', percentage: 0 });
        const now = new Date();
        await User.collection.insertOne({
            name: 'Legacy User',
            email: `legacy-${Date.now()}@example.com`,
            groupId: group._id,
            role: 'CUSTOMER',
            status: USER_STATUS.ACTIVE,
            verified: true,
            currency: 'USD',
            walletBalance: 0,
            creditLimit: 0,
            creditUsed: 0,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
        });

        const dryRun = await backfillReferralCodes({ dryRun: true, batchSize: 2 });
        expect(dryRun.missing).toBe(1);
        expect(dryRun.updated).toBe(0);
        expect(await User.countDocuments({ referralCode: { $exists: true } })).toBe(0);

        const writeRun = await backfillReferralCodes({ dryRun: false, batchSize: 2 });
        expect(writeRun.updated).toBe(1);
        const legacy = await User.findOne({ email: /^legacy-/ });
        expect(legacy.referralCode).toMatch(/^[A-Z0-9]{10}$/);
    });
});

describe('email signup referral relationship', () => {
    it('signs up without referral', async () => {
        await seedCurrency();
        await createGroup({ name: 'NoReferralGroup', percentage: 0 });

        const result = await register({
            name: 'No Referral',
            email: `no-referral-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            currency: 'USD',
            country: 'EG',
        });

        const user = await User.findById(result.user._id);
        expect(user.referralCode).toMatch(/^[A-Z0-9]{10}$/);
        expect(user.referredBy).toBeNull();
        expect(user.referredAt).toBeNull();
    });

    it('links a valid referral without changing default group or creating commissions', async () => {
        await seedCurrency();
        const defaultGroup = await createGroup({ name: 'DefaultPricing', percentage: 10 });
        const referrerGroup = await createGroup({ name: 'ReferrerPricing', percentage: 1 });
        const referrer = await createCustomer({
            groupId: referrerGroup._id,
            email: `referrer-${Date.now()}@example.com`,
        });

        const result = await register({
            name: 'Referred User',
            email: `referred-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            currency: 'USD',
            country: 'SA',
            referralCode: referrer.referralCode,
        });

        const user = await User.findById(result.user._id);
        expect(String(user.referredBy)).toBe(String(referrer._id));
        expect(user.referredAt).toBeInstanceOf(Date);
        expect(String(user.groupId)).toBe(String(defaultGroup._id));
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
    });

    it('rejects invalid, inactive, deleted, and self referral codes', async () => {
        await seedCurrency();
        const group = await createGroup({ name: 'RejectReferralGroup', percentage: 0 });
        const inactive = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
            email: `inactive-${Date.now()}@example.com`,
        });
        const deleted = await createCustomer({
            groupId: group._id,
            deletedAt: new Date(),
            email: `deleted-${Date.now()}@example.com`,
        });
        const self = await createCustomer({
            groupId: group._id,
            email: `self-${Date.now()}@example.com`,
        });

        await expect(register({
            name: 'Invalid',
            email: `invalid-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            currency: 'USD',
            referralCode: 'BADCODE',
        })).rejects.toMatchObject({ code: 'REFERRAL_CODE_INVALID' });

        await expect(register({
            name: 'Inactive',
            email: `inactive-target-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            currency: 'USD',
            referralCode: inactive.referralCode,
        })).rejects.toMatchObject({ code: 'REFERRAL_OWNER_INACTIVE' });

        await expect(register({
            name: 'Deleted',
            email: `deleted-target-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            currency: 'USD',
            referralCode: deleted.referralCode,
        })).rejects.toMatchObject({ code: 'REFERRAL_CODE_INVALID' });

        await expect(register({
            name: 'Self',
            email: self.email,
            password: 'SecurePass@1',
            currency: 'USD',
            referralCode: self.referralCode,
        })).rejects.toMatchObject({ code: 'SELF_REFERRAL_NOT_ALLOWED' });
    });
});

describe('Google OAuth referral preservation', () => {
    it('creates and consumes signed OAuth state once', async () => {
        const state = createGoogleOAuthState({ referralCode: 'abc123', intent: 'signup' });
        const consumed = await consumeGoogleOAuthState(state);

        expect(consumed.intent).toBe('signup');
        expect(consumed.referralCode).toBe('ABC123');
        expect(consumed.nonce).toBeTruthy();
        await expect(consumeGoogleOAuthState(state)).rejects.toThrow(/OAuth state is invalid/);
    });

    it('rejects tampered and expired OAuth state', async () => {
        const state = createGoogleOAuthState({ referralCode: 'ABC123', intent: 'signup' });
        const tampered = `${state.slice(0, -1)}x`;
        await expect(consumeGoogleOAuthState(tampered)).rejects.toThrow(/OAuth state is invalid/);

        const expired = createGoogleOAuthState({ intent: 'signup' }, { expiresIn: -1 });
        await expect(consumeGoogleOAuthState(expired)).rejects.toThrow(/OAuth state has expired/);
    });

    it('rejects OAuth state replay after service re-instantiation', async () => {
        const state = createGoogleOAuthState({ intent: 'signup', referralCode: 'ABC123' });
        await expect(consumeGoogleOAuthState(state)).resolves.toMatchObject({
            intent: 'signup',
            referralCode: 'ABC123',
        });

        const modulePath = require.resolve('../modules/auth/oauthState.service');
        delete require.cache[modulePath];
        const reloaded = require('../modules/auth/oauthState.service');

        await expect(reloaded.consumeGoogleOAuthState(state))
            .rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    });

    it('links a new Google user to a valid referral once', async () => {
        const group = await createGroup({ name: 'GoogleReferralGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `google-referrer-${Date.now()}@example.com`,
        });

        const profile = googleProfile({ email: `new-google-${Date.now()}@example.com` });
        const result = await resolveGoogleUser(profile, {
            intent: 'signup',
            referralCode: referrer.referralCode,
        });

        expect(result.isNewUser).toBe(true);
        expect(String(result.user.referredBy)).toBe(String(referrer._id));

        const again = await resolveGoogleUser(profile, {
            intent: 'signup',
            referralCode: referrer.referralCode,
        });
        expect(again.isNewUser).toBe(false);
        expect(String(again.user.referredBy)).toBe(String(referrer._id));
    });

    it('does not assign a new referrer to existing Google or email-linked users', async () => {
        const group = await createGroup({ name: 'ExistingGoogleGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `existing-referrer-${Date.now()}@example.com`,
        });
        const existingGoogle = await createCustomer({
            groupId: group._id,
            googleId: 'existing-google-id',
            email: `existing-google-${Date.now()}@example.com`,
        });
        const existingEmail = await createCustomer({
            groupId: group._id,
            email: `existing-email-${Date.now()}@example.com`,
        });

        const googleLogin = await resolveGoogleUser(
            googleProfile({ id: existingGoogle.googleId, email: existingGoogle.email }),
            { intent: 'signup', referralCode: referrer.referralCode }
        );
        expect(googleLogin.user.referredBy).toBeFalsy();

        const linked = await resolveGoogleUser(
            googleProfile({ id: 'new-google-link-id', email: existingEmail.email }),
            { intent: 'signup', referralCode: referrer.referralCode }
        );
        expect(linked.linkedExistingEmailUser).toBe(true);
        expect(linked.user.referredBy).toBeFalsy();
    });
});

describe('Google profile completion', () => {
    it('completes country/currency for an OAuth-referred user without changing safe fields', async () => {
        await seedCurrency();
        const group = await createGroup({ name: 'CompletionGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `completion-referrer-${Date.now()}@example.com`,
        });
        const { user: googleUser } = await resolveGoogleUser(googleProfile({
            email: `needs-completion-${Date.now()}@example.com`,
            id: 'needs-completion-google',
        }), {
            intent: 'signup',
            referralCode: referrer.referralCode,
        });
        const originalReferralCode = googleUser.referralCode;

        expect(googleUser.profileCompletionRequired).toBe(true);
        expect(String(googleUser.referredBy)).toBe(String(referrer._id));

        const updated = await userService.updateMyProfile(googleUser._id, {
            country: 'eg',
            currency: 'usd',
            referralCode: referrer.referralCode,
            referredBy: new mongoose.Types.ObjectId(),
            referredAt: new Date(),
            role: 'ADMIN',
            status: USER_STATUS.REJECTED,
            groupId: new mongoose.Types.ObjectId(),
            walletBalance: 999999,
            referralCodeGenerated: 'SHOULDNOTMATTER',
        });

        expect(updated.country).toBe('EG');
        expect(updated.currency).toBe('USD');
        expect(updated.referralCode).toBe(originalReferralCode);
        expect(String(updated.referredBy)).toBe(String(referrer._id));
        expect(updated.role).toBe('CUSTOMER');
        expect(updated.status).toBe(USER_STATUS.ACTIVE);
        expect(String(updated.groupId)).toBe(String(group._id));
        expect(updated.walletBalance).not.toBe(999999);

        const duplicate = await userService.updateMyProfile(googleUser._id, {
            referralCode: referrer.referralCode,
        });
        expect(String(duplicate.referredBy)).toBe(String(referrer._id));
    });

    it('does not let a normal email user assign a referral through profile update', async () => {
        await seedCurrency();
        const group = await createGroup({ name: 'EmailExploitGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `profile-referrer-${Date.now()}@example.com`,
        });
        const emailUser = await createCustomer({
            groupId: group._id,
            email: `email-profile-${Date.now()}@example.com`,
            referredBy: null,
            referredAt: null,
        });

        await expect(userService.updateMyProfile(emailUser._id, {
            country: 'EG',
            currency: 'USD',
            referralCode: referrer.referralCode,
        })).rejects.toMatchObject({ code: 'REFERRAL_ALREADY_ASSIGNED' });

        const fresh = await User.findById(emailUser._id);
        expect(fresh.referredBy).toBeNull();
        expect(fresh.referredAt).toBeNull();
    });

    it('does not let missing country/currency or an old Google account authorize referral assignment', async () => {
        await seedCurrency();
        const group = await createGroup({ name: 'OldGoogleExploitGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `old-google-referrer-${Date.now()}@example.com`,
        });
        const oldGoogle = await User.create({
            name: 'Old Google',
            email: `old-google-${Date.now()}@example.com`,
            googleId: 'old-google-no-referrer',
            role: 'CUSTOMER',
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            country: null,
            currency: 'USD',
        });

        await expect(userService.updateMyProfile(oldGoogle._id, {
            country: 'EG',
            currency: 'USD',
            referralCode: referrer.referralCode,
        })).rejects.toMatchObject({ code: 'REFERRAL_ALREADY_ASSIGNED' });

        const fresh = await User.findById(oldGoogle._id);
        expect(fresh.referredBy).toBeNull();
        expect(fresh.country).toBeNull();
    });

    it('rejects browser substitution of a different referral code during completion', async () => {
        await seedCurrency();
        const group = await createGroup({ name: 'SubstitutionGroup', percentage: 0 });
        const originalReferrer = await createCustomer({
            groupId: group._id,
            email: `original-referrer-${Date.now()}@example.com`,
        });
        const attackerReferrer = await createCustomer({
            groupId: group._id,
            email: `attacker-referrer-${Date.now()}@example.com`,
        });

        const { user: googleUser } = await resolveGoogleUser(googleProfile({
            email: `substitution-google-${Date.now()}@example.com`,
            id: 'substitution-google-id',
        }), {
            intent: 'signup',
            referralCode: originalReferrer.referralCode,
        });

        await expect(userService.updateMyProfile(googleUser._id, {
            country: 'EG',
            currency: 'USD',
            referralCode: attackerReferrer.referralCode,
        })).rejects.toMatchObject({ code: 'REFERRAL_ALREADY_ASSIGNED' });

        const fresh = await User.findById(googleUser._id);
        expect(String(fresh.referredBy)).toBe(String(originalReferrer._id));
    });

    it('does not regenerate referralCode on repeated save or allow profile mutation of referral identity', async () => {
        const group = await createGroup({ name: 'ImmutabilityGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `immutability-referrer-${Date.now()}@example.com`,
        });
        const user = await createCustomer({
            groupId: group._id,
            email: `immutability-user-${Date.now()}@example.com`,
            referredBy: referrer._id,
            referredAt: new Date(),
        });
        const originalCode = user.referralCode;
        const originalReferredBy = String(user.referredBy);
        const originalReferredAt = user.referredAt.getTime();

        user.name = 'Still Same Referral';
        await user.save();
        await userService.updateMyProfile(user._id, {
            name: 'Still Safe',
            referralCode: referrer.referralCode,
            referredBy: new mongoose.Types.ObjectId(),
            referredAt: new Date(Date.now() + 100000),
        });

        const fresh = await User.findById(user._id);
        expect(fresh.referralCode).toBe(originalCode);
        expect(String(fresh.referredBy)).toBe(originalReferredBy);
        expect(fresh.referredAt.getTime()).toBe(originalReferredAt);
    });

    it('concurrent completion cannot overwrite referral data', async () => {
        await seedCurrency();
        const group = await createGroup({ name: 'ConcurrentCompletionGroup', percentage: 0 });
        const firstReferrer = await createCustomer({
            groupId: group._id,
            email: `first-concurrent-referrer-${Date.now()}@example.com`,
        });
        const secondReferrer = await createCustomer({
            groupId: group._id,
            email: `second-concurrent-referrer-${Date.now()}@example.com`,
        });
        const { user: googleUser } = await resolveGoogleUser(googleProfile({
            email: `concurrent-google-${Date.now()}@example.com`,
            id: 'concurrent-google-id',
        }), {
            intent: 'signup',
            referralCode: firstReferrer.referralCode,
        });

        const results = await Promise.allSettled([
            userService.updateMyProfile(googleUser._id, { country: 'EG', currency: 'USD', referralCode: firstReferrer.referralCode }),
            userService.updateMyProfile(googleUser._id, { country: 'SA', currency: 'USD', referralCode: secondReferrer.referralCode }),
        ]);

        expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
        const fresh = await User.findById(googleUser._id);
        expect(String(fresh.referredBy)).toBe(String(firstReferrer._id));
    });

    it('rejects inactive currency and keeps existing referral immutable', async () => {
        await seedCurrency({ code: 'USD' });
        await seedCurrency({ code: 'EUR', symbol: 'EUR', name: 'Euro', isActive: false });
        const group = await createGroup({ name: 'InactiveCurrencyGroup', percentage: 0 });
        const referrer = await createCustomer({
            groupId: group._id,
            email: `immutable-referrer-${Date.now()}@example.com`,
        });
        const otherReferrer = await createCustomer({
            groupId: group._id,
            email: `other-referrer-${Date.now()}@example.com`,
        });
        const googleUser = await User.create({
            name: 'Immutable Referral',
            email: `immutable-google-${Date.now()}@example.com`,
            googleId: 'immutable-google-id',
            role: 'CUSTOMER',
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            referredBy: referrer._id,
            referredAt: new Date(),
        });

        await expect(userService.updateMyProfile(googleUser._id, {
            country: 'US',
            currency: 'EUR',
        })).rejects.toMatchObject({ code: 'CURRENCY_INACTIVE' });

        await expect(userService.updateMyProfile(googleUser._id, {
            referralCode: otherReferrer.referralCode,
        })).rejects.toMatchObject({ code: 'REFERRAL_ALREADY_ASSIGNED' });
    });

    it('keeps existing email login working', async () => {
        const group = await createGroup({ name: 'LoginRegressionGroup', percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            email: `login-regression-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            verified: true,
            status: USER_STATUS.ACTIVE,
        });
        const fresh = await User.findById(user._id);
        fresh.password = 'SecurePass@1';
        await fresh.save();

        const result = await login({ email: fresh.email, password: 'SecurePass@1' });
        expect(result.token).toBeDefined();
        expect(result.user.referralCode).toBe(fresh.referralCode);
    });
});
