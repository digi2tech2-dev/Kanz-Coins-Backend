'use strict';

/**
 * auth.service.js
 *
 * Authentication business logic:
 *   - register          : email+password registration with email verification
 *   - login             : credential check + status + verification gate + 2FA gate
 *   - verifyEmail       : consume email token, mark verified
 *   - resendVerification: re-issue + re-send the verification email
 *   - loginWithGoogle   : called after successful passport OAuth callback
 *   - generate2FASecret : send email OTP before enabling 2FA
 *   - enable2FA         : confirm setup OTP and activate email OTP 2FA
 *   - disable2FA        : deactivate 2FA
 *   - verify2FA         : consume temp token + email OTP code to issue full JWT
 *
 * Security design:
 *   - Email verification tokens are stored as SHA-256 hashes (never raw)
 *   - Tokens expire in 24 hours
 *   - Password is never stored in raw form (bcrypt via model pre-save hook)
 *   - JWT is only issued when account is ACTIVE (approved by admin)
 *   - If 2FA is enabled, login issues a short-lived temp token (5 min)
 *     that must be exchanged via /verify-2fa for the full JWT
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { User, ROLES, USER_STATUS } = require('../users/user.model');
const Group = require('../groups/group.model');
const { getHighestPercentageGroup } = require('../groups/group.service');
const { Currency } = require('../currency/currency.model');
const emailService = require('../../services/email.service');
const {
    AppError,
    AuthenticationError,
    ConflictError,
    BusinessRuleError,
    NotFoundError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { USER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const {
    normalizeIncomingReferralCode,
    resolveReferralOwnerForNewUser,
    buildReferralAssignment,
    createUserWithReferralCodeRetry,
} = require('../referrals/referral.service');

// ─── Private Helpers ──────────────────────────────────────────────────────────

const TWO_FACTOR_OTP_EXPIRY_MS = 5 * 60 * 1000;
const PROFILE_COMPLETION_EXPIRY_MS = 15 * 60 * 1000;

/** Sign full-session JWT for a user. */
const signToken = (userId, role) =>
    jwt.sign({ id: userId, role }, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn,
    });

/**
 * Sign a short-lived temporary JWT for 2FA-pending sessions.
 * This token CANNOT be used to access authenticated routes —
 * the authenticate middleware rejects tokens with purpose '2fa-pending'.
 */
const signTempToken = (userId) =>
    jwt.sign({ id: userId, purpose: '2fa-pending' }, config.jwt.secret, {
        expiresIn: '5m',
    });

/**
 * Generate a cryptographically random token and its SHA-256 hash.
 *
 * @returns {{ rawToken: string, hashedToken: string }}
 */
const _generateVerificationToken = () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');
    return { rawToken, hashedToken };
};

/** Hash an incoming raw token for DB lookup. */
const _hashToken = (raw) =>
    crypto.createHash('sha256').update(raw).digest('hex');

const _hashOtp = (raw) =>
    crypto.createHmac('sha256', config.jwt.secret).update(raw).digest('hex');

const _generateTwoFactorOtp = () =>
    crypto.randomInt(0, 1000000).toString().padStart(6, '0');

const _normalizeCountry = (country) => {
    const value = String(country || '').trim().toUpperCase();
    if (!value) return null;
    if (!/^[A-Z]{2}$/.test(value)) {
        throw new AppError('Country must be a 2-letter country code.', 400, 'COUNTRY_INVALID');
    }
    return value;
};

const _normalizeCurrency = async (currency, { required = false } = {}) => {
    const value = String(currency || '').trim().toUpperCase();
    if (!value) {
        if (required) {
            throw new AppError('Currency is required.', 400, 'CURRENCY_INVALID');
        }
        return null;
    }

    if (!/^[A-Z]{3}$/.test(value)) {
        throw new AppError('Currency must be a 3-letter ISO code.', 400, 'CURRENCY_INVALID');
    }

    const currencyDoc = await Currency.findOne({ code: value });
    if (!currencyDoc) {
        throw new AppError('Currency is invalid.', 400, 'CURRENCY_INVALID');
    }

    if (!currencyDoc.isActive) {
        throw new AppError('Currency is inactive.', 400, 'CURRENCY_INACTIVE');
    }

    return currencyDoc.code;
};

const _assertActiveGroup = async (groupId) => {
    const group = await Group.findById(groupId);
    if (!group || !group.isActive) {
        throw new BusinessRuleError(
            'No active pricing group is assigned to this account. Please contact an administrator.',
            'GROUP_INACTIVE'
        );
    }
    return group;
};

const _safeCompareHash = (candidateHash, storedHash) => {
    if (!candidateHash || !storedHash) return false;

    const candidateBuffer = Buffer.from(candidateHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    return (
        candidateBuffer.length === storedBuffer.length &&
        crypto.timingSafeEqual(candidateBuffer, storedBuffer)
    );
};

// ─── register ─────────────────────────────────────────────────────────────────

/**
 * Register a new customer account.
 *
 * Business rules:
 *  1. Email must be unique.
 *  2. Assigned to the group with the highest markup percentage.
 *  3. Status starts as ACTIVE — no admin approval required.
 *  4. verified = false — user must click email link before login is allowed.
 *  5. A verification email is dispatched (fire-and-forget safe).
 */
const register = async ({
    name,
    email,
    password,
    currency,
    country,
    phone,
    username,
    referralCode,
    refCode,
    ref,
    inviteCode,
}) => {
    // ── 1. Prevent duplicate accounts ─────────────────────────────────────────
    const normalizedReferralCode = normalizeIncomingReferralCode(referralCode, refCode, ref, inviteCode);
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
        if (normalizedReferralCode && existing.referralCode === normalizedReferralCode) {
            throw new AppError('You cannot use your own invitation code.', 400, 'SELF_REFERRAL_NOT_ALLOWED');
        }
        throw new ConflictError('email already exists');
    }

    if (username) {
        const existingUsername = await User.findOne({ username: username.toLowerCase() });
        if (existingUsername) {
            throw new ConflictError('username already exists');
        }
    }

    // ── 2. Pricing group ──────────────────────────────────────────────────────
    const group = await getHighestPercentageGroup();
    const normalizedCurrency = currency
        ? await _normalizeCurrency(currency)
        : 'USD';
    const normalizedCountry = _normalizeCountry(country);
    const referralOwner = normalizedReferralCode
        ? await resolveReferralOwnerForNewUser(normalizedReferralCode, email)
        : null;

    // ── 3. Verification token ─────────────────────────────────────────────────
    const { rawToken, hashedToken } = _generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);  // +24 h

    // ── 4. Create user ────────────────────────────────────────────────────────
    const user = await createUserWithReferralCodeRetry({
        name,
        email,
        password,
        role: ROLES.CUSTOMER,
        groupId: group._id,
        status: USER_STATUS.ACTIVE,
        verified: false,
        emailVerificationToken: hashedToken,
        emailVerificationExpires: expiresAt,
        profileCompletedAt: new Date(),
        currency: normalizedCurrency,
        ...(normalizedCountry ? { country: normalizedCountry } : {}),
        ...(phone ? { phone } : {}),
        ...(username ? { username } : {}),
        ...buildReferralAssignment(referralOwner),
    });

    // ── 5. Audit (fire-and-forget) ────────────────────────────────────────────
    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES.CUSTOMER,
        action: USER_ACTIONS.REGISTERED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, name: user.name, groupId: user.groupId },
    });

    // ── 6. Send verification email (fire-and-forget — never block registration) ──
    const baseUrl = process.env.APP_URL || 'http://localhost:5000';
    const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}`;

    emailService.sendVerificationEmail(user, rawToken).catch((err) => {
        console.error('[Auth] Failed to send verification email:', err.message);
    });

    return {
        user: user.toSafeObject(),
        message:
            'Registration successful! Please check your email to verify your account. ' +
            'Once verified, you can start using the platform immediately.',
    };
};

// ─── login ────────────────────────────────────────────────────────────────────

/**
 * Authenticate an existing user and issue a JWT.
 *
 * Gate order:
 *   1. User must exist
 *   2. Email must be verified
 *   3. Status must be ACTIVE (not PENDING / REJECTED)
 *   4. Password must match
 */
const login = async ({ email, password }) => {
    const user = await User.findOne({ email: email.toLowerCase() })
        .select('+password +verified');

    if (!user) {
        throw new AuthenticationError('Invalid email or password.');
    }

    // ── Gate 1: Email verification ────────────────────────────────────────────
    if (!user.verified) {
        throw new AuthenticationError(
            'Please verify your email address before logging in. ' +
            'Check your inbox for the verification link.'
        );
    }

    // ── Gate 2: Admin approval status ─────────────────────────────────────────
    if (user.status === USER_STATUS.PENDING) {
        createAuditLog({
            actorId: user._id,
            actorRole: ACTOR_ROLES[user.role] ?? user.role,
            action: USER_ACTIONS.LOGIN_BLOCKED,
            entityType: ENTITY_TYPES.USER,
            entityId: user._id,
            metadata: { reason: 'PENDING', email: user.email },
        });

        throw new AuthenticationError(
            'Your account is awaiting admin approval. Please check back later.'
        );
    }

    if (user.status === USER_STATUS.REJECTED) {
        createAuditLog({
            actorId: user._id,
            actorRole: ACTOR_ROLES[user.role] ?? user.role,
            action: USER_ACTIONS.LOGIN_BLOCKED,
            entityType: ENTITY_TYPES.USER,
            entityId: user._id,
            metadata: { reason: 'REJECTED', email: user.email },
        });

        throw new AuthenticationError(
            'Your account was rejected by an administrator. Please contact support.'
        );
    }

    // ── Gate 3: Password match ────────────────────────────────────────────────
    // Google OAuth users have no password — block password login for them
    if (!user.password) {
        throw new AuthenticationError(
            'This account uses Google Sign-In. Please log in with Google.'
        );
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw new AuthenticationError('Invalid email or password.');
    }

    // ── Gate 4: Two-Factor Authentication ─────────────────────────────────────
    if (user.isTwoFactorEnabled) {
        const plainOtp = _generateTwoFactorOtp();
        const tempToken = signTempToken(user._id);

        user.twoFactorOtp = _hashOtp(plainOtp);
        user.twoFactorOtpExpires = new Date(Date.now() + TWO_FACTOR_OTP_EXPIRY_MS);
        await user.save();

        await emailService.sendTwoFactorOtpEmail(user, plainOtp);

        createAuditLog({
            actorId: user._id,
            actorRole: ACTOR_ROLES[user.role] ?? user.role,
            action: USER_ACTIONS.LOGIN_SUCCESS,
            entityType: ENTITY_TYPES.USER,
            entityId: user._id,
            metadata: { email: user.email, twoFactorPending: true },
        });

        return { requires2FA: true, tempToken, email: user.email };
    }

    // ── 5. Issue full JWT ──────────────────────────────────────────────────────
    const token = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return { token, user: user.toSafeObject() };
};

// ─── verifyEmail ──────────────────────────────────────────────────────────────

/**
 * Consume an email verification token.
 *
 * @param {string} rawToken  — token from query string (un-hashed)
 * @returns {{ redirectUrl: string }}
 */
const verifyEmail = async (rawToken) => {
    if (!rawToken) {
        throw new BusinessRuleError('Verification token is required.', 'MISSING_TOKEN');
    }

    const hashedToken = _hashToken(rawToken);

    const user = await User.findOne({
        emailVerificationToken: hashedToken,
        emailVerificationExpires: { $gt: new Date() },
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) {
        throw new BusinessRuleError(
            'Verification link is invalid or has expired. Please request a new one.',
            'INVALID_OR_EXPIRED_TOKEN'
        );
    }

    // Mark as verified and clear token fields
    user.verified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    return { redirectUrl: config.frontend.verifyRedirectUrl };
};

// ─── resendVerification ───────────────────────────────────────────────────────

/**
 * Re-issue and re-send a verification email.
 * Rate-limit is applied at the route level (express-rate-limit).
 *
 * @param {string} email
 */
const resendVerification = async (email) => {
    const user = await User.findOne({ email: email.toLowerCase() })
        .select('+emailVerificationToken +emailVerificationExpires +verified');

    if (!user) {
        // Avoid user enumeration — return same message as success
        return { message: 'If that email exists, a verification link has been sent.' };
    }

    if (user.verified) {
        throw new BusinessRuleError(
            'This account is already verified.',
            'ALREADY_VERIFIED'
        );
    }

    const { rawToken, hashedToken } = _generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    user.emailVerificationToken = hashedToken;
    user.emailVerificationExpires = expiresAt;
    await user.save();

    emailService.sendVerificationEmail(user, rawToken).catch((err) => {
        console.error('[Auth] Failed to resend verification email:', err.message);
    });

    return { message: 'If that email exists, a verification link has been sent.' };
};

// ─── loginWithGoogle ──────────────────────────────────────────────────────────

/**
 * Called by the Google OAuth callback route after Passport succeeds.
 * Issues a JWT for complete Google users, or a one-time profile-completion
 * token when country/currency still need to be collected.
 *
 * Note: Google OAuth users bypass the email verification gate
 * because Google has already verified the email. They still need
 * admin approval (PENDING → ACTIVE) before accessing the platform.
 *
 * @param {Object} user  — User document from Passport strategy
 * @returns {{ status: string, token?: string, completionToken?: string, user: Object, message?: string }}
 */
const issueGoogleProfileCompletionToken = async (user) => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    user.profileCompletionToken = _hashToken(rawToken);
    user.profileCompletionTokenExpires = new Date(Date.now() + PROFILE_COMPLETION_EXPIRY_MS);
    await user.save();
    return rawToken;
};

const loginWithGoogle = async (user) => {
    if (user.status === USER_STATUS.PENDING) {
        // Return a token-less response so the frontend can show the approval message.
        // Some frontends prefer a token even for pending users; adjust as needed.
        return {
            token: null,
            user: user.toSafeObject(),
            message: 'Your account is awaiting admin approval. You will be notified once activated.',
        };
    }

    if (user.status === USER_STATUS.REJECTED) {
        throw new AuthenticationError(
            'Your account was rejected by an administrator. Please contact support.'
        );
    }

    if (user.profileCompletionRequired) {
        const completionToken = await issueGoogleProfileCompletionToken(user);
        return {
            status: 'PROFILE_COMPLETION_REQUIRED',
            completionToken,
            user: user.toSafeObject(),
            message: 'Profile completion is required.',
        };
    }

    const token = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, method: 'google-oauth' },
    });

    return { status: 'LOGIN_COMPLETE', token, user: user.toSafeObject() };
};

const completeGoogleProfile = async ({ completionToken, country, currency }) => {
    if (!completionToken) {
        throw new AuthenticationError('Profile completion token is required.');
    }

    const hashedToken = _hashToken(completionToken);
    const user = await User.findOne({ profileCompletionToken: hashedToken })
        .select('+profileCompletionToken +profileCompletionTokenExpires');

    if (!user) {
        throw new AuthenticationError('Profile completion token is invalid.');
    }

    if (!user.profileCompletionTokenExpires || user.profileCompletionTokenExpires.getTime() <= Date.now()) {
        user.profileCompletionToken = null;
        user.profileCompletionTokenExpires = null;
        await user.save();
        throw new AuthenticationError('Profile completion token has expired.');
    }

    if (!user.googleId) {
        throw new AuthenticationError('Profile completion token is invalid.');
    }

    if (user.status !== USER_STATUS.ACTIVE) {
        throw new AuthenticationError('Your account is not active. Contact an administrator.');
    }

    await _assertActiveGroup(user.groupId);

    user.country = _normalizeCountry(country);
    if (!user.country) {
        throw new AppError('Country is required.', 400, 'COUNTRY_INVALID');
    }

    user.currency = await _normalizeCurrency(currency, { required: true });

    user.profileCompletedAt = new Date();
    user.profileCompletionToken = null;
    user.profileCompletionTokenExpires = null;
    await user.save();

    const token = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, method: 'google-profile-completion' },
    });

    return { status: 'LOGIN_COMPLETE', token, user: user.toSafeObject() };
};

// ─── generate2FASecret ────────────────────────────────────────────────────────

/**
 * Request email OTP verification before enabling 2FA.
 *
 * @param {string|ObjectId} userId
 * @returns {{ message: string }}
 */
const generate2FASecret = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    if (user.isTwoFactorEnabled) {
        throw new BusinessRuleError(
            '2FA is already enabled on this account.',
            'ALREADY_2FA_ENABLED'
        );
    }

    const plainOtp = _generateTwoFactorOtp();
    user.twoFactorOtp = _hashOtp(plainOtp);
    user.twoFactorOtpExpires = new Date(Date.now() + TWO_FACTOR_OTP_EXPIRY_MS);
    await user.save();

    await emailService.sendTwoFactorOtpEmail(user, plainOtp);

    return { message: 'Verification code sent to email' };
};

// ─── enable2FA ────────────────────────────────────────────────────────────────

/**
 * Confirm email OTP and activate 2FA for a user.
 *
 * @param {string|ObjectId} userId
 * @param {string} code
 */
const enable2FA = async (userId, code) => {
    const user = await User.findById(userId).select('+twoFactorOtp +twoFactorOtpExpires');
    if (!user) throw new NotFoundError('User');

    if (user.isTwoFactorEnabled) {
        throw new BusinessRuleError(
            '2FA is already enabled on this account.',
            'ALREADY_2FA_ENABLED'
        );
    }

    if (
        !user.twoFactorOtp ||
        !user.twoFactorOtpExpires ||
        user.twoFactorOtpExpires.getTime() <= Date.now()
    ) {
        user.twoFactorOtp = null;
        user.twoFactorOtpExpires = null;
        await user.save();

        throw new AuthenticationError(
            '2FA setup verification has expired. Please request a new code.'
        );
    }

    const isValid = _safeCompareHash(
        _hashOtp(String(code).trim()),
        user.twoFactorOtp
    );

    if (!isValid) {
        throw new AuthenticationError('Invalid 2FA setup code. Please try again.');
    }

    user.isTwoFactorEnabled = true;
    user.twoFactorOtp = null;
    user.twoFactorOtpExpires = null;
    await user.save();

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.TWO_FACTOR_ENABLED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return { message: '2FA has been successfully enabled.' };
};

// ─── disable2FA ───────────────────────────────────────────────────────────────

/**
 * Disable 2FA for a user. Requires a valid password to prevent unauthorized disabling.
 *
 * @param {string|ObjectId} userId
 * @param {{ password?: string }} credentials
 */
const disable2FA = async (userId, { password } = {}) => {
    const user = await User.findById(userId).select('+password');
    if (!user) throw new NotFoundError('User');

    if (!user.isTwoFactorEnabled) {
        throw new BusinessRuleError(
            '2FA is not currently enabled on this account.',
            'NOT_2FA_ENABLED'
        );
    }

    // Require at least one proof of identity
    let verified = false;

    if (password && user.password) {
        verified = await user.comparePassword(password);
    }

    if (!verified) {
        throw new AuthenticationError(
            'Invalid credentials. Provide a valid password to disable 2FA.'
        );
    }

    user.isTwoFactorEnabled = false;
    user.twoFactorOtp = null;
    user.twoFactorOtpExpires = null;
    await user.save();

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.TWO_FACTOR_DISABLED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return { message: '2FA has been successfully disabled.' };
};

// ─── verify2FA ────────────────────────────────────────────────────────────────

/**
 * Exchange a 2FA-pending temp token + email OTP code for a full auth JWT.
 *
 * @param {string} tempToken — short-lived JWT from login() when 2FA is enabled
 * @param {string} code      — 6-digit email OTP
 * @returns {{ token: string, user: Object }}
 */
const verify2FA = async (tempToken, code) => {
    // 1. Verify the temp token
    let decoded;
    try {
        decoded = jwt.verify(tempToken, config.jwt.secret);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw new AuthenticationError(
                '2FA verification has expired. Please log in again.'
            );
        }
        throw new AuthenticationError('Invalid temporary token.');
    }

    // Must be a 2FA-pending token
    if (decoded.purpose !== '2fa-pending') {
        throw new AuthenticationError('Invalid temporary token.');
    }

    // 2. Load user + pending email OTP
    const user = await User.findById(decoded.id).select('+twoFactorOtp +twoFactorOtpExpires');
    if (!user) {
        throw new AuthenticationError('The user belonging to this token no longer exists.');
    }

    if (user.status !== USER_STATUS.ACTIVE) {
        throw new AuthenticationError('Your account is not active. Contact an administrator.');
    }

    if (!user.isTwoFactorEnabled) {
        throw new AuthenticationError('2FA is not enabled for this account.');
    }

    if (
        !user.twoFactorOtp ||
        !user.twoFactorOtpExpires ||
        user.twoFactorOtpExpires.getTime() <= Date.now()
    ) {
        user.twoFactorOtp = null;
        user.twoFactorOtpExpires = null;
        await user.save();

        throw new AuthenticationError(
            '2FA verification has expired. Please log in again.'
        );
    }

    // 3. Verify email OTP code
    const isValid = _safeCompareHash(
        _hashOtp(String(code).trim()),
        user.twoFactorOtp
    );

    if (!isValid) {
        throw new AuthenticationError('Invalid 2FA code. Please try again.');
    }

    user.twoFactorOtp = null;
    user.twoFactorOtpExpires = null;
    await user.save();

    // 4. Issue full JWT
    const fullToken = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, twoFactorVerified: true },
    });

    return { token: fullToken, user: user.toSafeObject() };
};

module.exports = {
    register,
    login,
    verifyEmail,
    resendVerification,
    loginWithGoogle,
    completeGoogleProfile,
    generate2FASecret,
    enable2FA,
    disable2FA,
    verify2FA,
};
