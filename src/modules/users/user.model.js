'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../../config/config');
const { generateReferralCode } = require('../../shared/utils/referralCode');
const { buildPublicWalletSummary, buildWalletSummary } = require('../../shared/utils/walletSummary');

/**
 * User roles enum — single source of truth.
 */
const ROLES = Object.freeze({
    ADMIN: 'ADMIN',
    SUPERVISOR: 'SUPERVISOR',
    CUSTOMER: 'CUSTOMER',
});

/**
 * User status lifecycle enum.
 *
 * PENDING  → registered, awaiting admin approval (default for new registrations)
 * ACTIVE   → approved by admin; full platform access
 * REJECTED → denied by admin; cannot log in
 *
 * Transitions allowed:
 *   PENDING  → ACTIVE    (admin approval)
 *   PENDING  → REJECTED  (admin rejection)
 *   ACTIVE   → REJECTED  (admin revoke)
 *   REJECTED → ACTIVE    (admin re-approve)
 */
const USER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    REJECTED: 'REJECTED',
});

const RESELLER_STATUS = Object.freeze({
    NONE: 'NONE',
    APPROVED: 'APPROVED',
});

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
            minlength: [2, 'Name must be at least 2 characters'],
            maxlength: [100, 'Name cannot exceed 100 characters'],
        },

        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
        },

        referralCode: {
            type: String,
            unique: true,
            sparse: true,
            uppercase: true,
            trim: true,
            immutable: true,
            match: [/^[A-Z0-9]{6,32}$/, 'referralCode must be 6-32 uppercase letters or digits'],
        },

        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            immutable: true,
            index: true,
        },

        referredAt: {
            type: Date,
            default: null,
            immutable: true,
        },

        referralEligibleUntil: {
            type: Date,
            default: null,
            immutable: true,
            index: true,
        },

        referralCommissionPercentOverride: {
            type: Number,
            default: null,
            min: [0, 'Referral commission override cannot be negative'],
            max: [50, 'Referral commission override cannot exceed 50%'],
            validate: {
                validator(value) {
                    return value === null || value === undefined || Number.isFinite(value);
                },
                message: 'Referral commission override must be a finite number',
            },
        },

        referralCommissionStoppedAt: {
            type: Date,
            default: null,
        },

        resellerStatus: {
            type: String,
            enum: {
                values: Object.values(RESELLER_STATUS),
                message: 'resellerStatus must be NONE or APPROVED',
            },
            default: RESELLER_STATUS.NONE,
            index: true,
        },

        resellerApprovedAt: {
            type: Date,
            default: null,
        },

        subAgentRequestPending: {
            type: Boolean,
            default: false,
            select: false,
        },

        password: {
            type: String,
            // Not required for OAuth users (Google sign-in never sets a password)
            minlength: [8, 'Password must be at least 8 characters'],
            select: false, // Never return password in queries by default
        },

        // ── OAuth ────────────────────────────────────────────────────────────
        /**
         * Google OAuth sub (subject identifier).
         * Null for email/password accounts.
         * Used by the Google passport strategy to find/link accounts.
         */
        googleId: {
            type: String,
            unique: true,
            sparse: true,   // only indexes documents where googleId is set
            // NOTE: no default — absent field is what sparse indexes expect
        },

        // ── Email Verification ────────────────────────────────────────────────
        /**
         * true  — user has clicked the verification link
         * false — fresh email/password registration (default)
         * Google OAuth users are auto-verified (set to true at creation).
         */
        verified: {
            type: Boolean,
            default: false,
        },

        /**
         * Canonical profile-completion marker.
         * Email/password registrations set this immediately because the signup
         * form already collects the required profile fields. New Google users
         * start with null and complete through the profile-completion flow.
         */
        profileCompletedAt: {
            type: Date,
            default: null,
        },

        /**
         * One-time Google profile-completion token state.
         * Raw tokens are only sent to the browser during the OAuth redirect;
         * the database stores a SHA-256 hash and short expiry.
         */
        profileCompletionToken: {
            type: String,
            select: false,
            default: null,
        },

        profileCompletionTokenExpires: {
            type: Date,
            select: false,
            default: null,
        },

        /**
         * SHA-256 hash of the raw token sent in the verification email.
         * Raw token is NEVER stored here — only the hash.
         * Null once verified.
         */
        emailVerificationToken: {
            type: String,
            select: false,
            default: null,
        },

        /** Token expires 24 hours after issuance. */
        emailVerificationExpires: {
            type: Date,
            select: false,
            default: null,
        },

        role: {
            type: String,
            enum: Object.values(ROLES),
            default: ROLES.CUSTOMER,
        },

        // ── Activation Lifecycle ─────────────────────────────────────────────
        /**
         * status governs platform access.
         * New registrations default to PENDING — admin must approve before the
         * user can log in, place orders, or use their wallet.
         *
         * Backwards-compatibility: the `isActive` virtual below delegates to
         * this field so any code that already reads `user.isActive` continues
         * to work without modification.
         */
        status: {
            type: String,
            enum: {
                values: Object.values(USER_STATUS),
                message: 'status must be PENDING, ACTIVE, or REJECTED',
            },
            default: USER_STATUS.PENDING,
            index: true,
        },

        /** Admin who approved the account (null until approved). */
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        approvedAt: {
            type: Date,
            default: null,
        },

        /** Admin who rejected the account (null until rejected). */
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        rejectedAt: {
            type: Date,
            default: null,
        },

        // ── Pricing Group ────────────────────────────────────────────────────
        groupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            required: [true, 'A user must belong to a pricing group'],
            default: null,
        },

        // ── Dynamic RBAC Permissions ─────────────────────────────────────────
        /**
         * Fine-grained permissions for SUPERVISOR (or any) role.
         * Admins bypass permission checks entirely.
         * Example: ['MANAGE_DEPOSITS', 'VIEW_ORDERS']
         */
        permissions: {
            type: [String],
            default: [],
        },

        // ── Two-Factor Authentication ────────────────────────────────────────
        /**
         * Hashed email OTP for pending 2FA login challenges.
         * Raw OTP codes are never stored.
         */
        twoFactorOtp: {
            type: String,
            select: false,
            default: null,
        },

        /** Expiration timestamp for the pending 2FA email OTP. */
        twoFactorOtpExpires: {
            type: Date,
            select: false,
            default: null,
        },

        /** Whether the user must complete email OTP verification to log in. */
        isTwoFactorEnabled: {
            type: Boolean,
            default: false,
        },

        // ── Wallet ───────────────────────────────────────────────────────────
        /**
         * User's wallet balance in their local currency.
         * CAN be negative when a user spends against their creditLimit.
         * Minimum effective balance = -(creditLimit).
         */
        walletBalance: {
            type: Number,
            default: 0,
        },

        creditLimit: {
            type: Number,
            default: 0,
            min: [0, 'Credit limit cannot be negative'],
        },

        /**
         * creditUsed: the amount of the credit line currently drawn.
         *
         * Real spendable formula:
         *   available = walletBalance + creditLimit
         *
         * creditUsed is a derived reporting mirror:
         *   walletBalance < 0 ? min(abs(walletBalance), creditLimit) : 0
         *
         * On order creation:
         *   - wallet is used first
         *   - remaining goes against credit → creditUsed increases
         *
         * On refund:
         *   - creditUsed decreases first (credit is "returned")
         *   - then walletBalance is restored
         */
        creditUsed: {
            type: Number,
            default: 0,
            min: [0, 'Credit used cannot be negative'],
        },

        // ── Quantity-Only Billing ─────────────────────────────────────────────
        /**
         * Maximum cumulative quantity this user can order under quantity_only billing.
         * Only meaningful when user.group.billingMode === 'quantity_only'.
         * Managed by admin. Does NOT affect wallet/credit logic.
         */
        quantityLimit: {
            type: Number,
            default: 0,
            min: [0, 'Quantity limit cannot be negative'],
        },

        /**
         * Cumulative quantity consumed so far under quantity_only billing.
         * Incremented atomically on each order. Reset by admin after offline settlement.
         */
        quantityUsed: {
            type: Number,
            default: 0,
            min: [0, 'Quantity used cannot be negative'],
        },

        isApiEnabled: {
            type: Boolean,
            default: false,
        },

        apiToken: {
            type: String,
            select: false,
            index: true,
            default: null,
        },

        apiSecret: {
            type: String,
            select: false,
            default: null,
        },

        whitelistIps: {
            type: [String],
            default: [],
        },

        webhookUrl: {
            type: String,
            trim: true,
            default: null,
            match: [/^https?:\/\//, 'webhookUrl must start with http:// or https://'],
        },

        // ── Currency ──────────────────────────────────────────────────────────
        /**
         * The ISO 4217 currency code for this user's wallet.
         * Wallet balances, order charges, and refunds are all denominated in this currency.
         * Products are priced in USD internally; the currency converter applies
         * the platform exchange rate at order creation time.
         *
         * Default: "USD" — no conversion needed.
         */
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            default: 'USD',
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code (e.g. USD, SAR)'],
        },

        country: {
            type: String,
            uppercase: true,
            trim: true,
            default: null,
            match: [/^[A-Z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code'],
        },

        // ── Avatar ───────────────────────────────────────────────────────────
        /**
         * URL to the user's profile picture.
         * Can be an absolute URL (external host) or a relative path (local uploads).
         */
        avatar: {
            type: String,
            trim: true,
            default: null,
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// Note: email already has a unique index from unique:true in the field definition
userSchema.index({ role: 1 });
userSchema.index({ groupId: 1 });
userSchema.index({ deletedAt: 1 }, { sparse: true });  // fast filter for non-deleted users
// status index defined inline above

// ─── Virtuals ────────────────────────────────────────────────────────────────

/**
 * Backwards-compatibility shim.
 * Any code that reads `user.isActive` continues to work correctly.
 * Source of truth is now `status`.
 */
userSchema.virtual('isActive').get(function () {
    return this.status === USER_STATUS.ACTIVE;
});

/**
 * Total spendable amount = wallet balance + credit limit.
 * This is the maximum amount the user can spend in a single order.
 * walletBalance may be negative (up to -creditLimit) after credit usage.
 */
userSchema.virtual('availableBalance').get(function () {
    return buildWalletSummary(this).availableBalance;
});

/** How much credit remains available (undrawn). */
userSchema.virtual('availableCredit').get(function () {
    return buildWalletSummary(this).availableCredit;
});

/** Remaining quantity quota for quantity_only billing. */
userSchema.virtual('quantityRemaining').get(function () {
    return Math.max(0, (this.quantityLimit || 0) - (this.quantityUsed || 0));
});

userSchema.virtual('missingProfileFields').get(function () {
    const missing = [];
    if (!this.country) missing.push('country');
    if (!this.currency) missing.push('currency');
    return missing;
});

userSchema.virtual('isProfileComplete').get(function () {
    if (this.profileCompletedAt) return true;
    if (!this.googleId) return true;

    // Legacy Google users created before profileCompletedAt existed should keep
    // access when they already have the required fields.
    return this.missingProfileFields.length === 0;
});

userSchema.virtual('profileCompletionRequired').get(function () {
    return Boolean(this.googleId && !this.isProfileComplete);
});

// ─── Pre-save Hook: Hash Password ────────────────────────────────────────────
userSchema.pre('validate', function (next) {
    if (this.isNew && !this.referralCode) {
        this.referralCode = generateReferralCode();
    }
    next();
});

userSchema.pre('save', async function (next) {
    // Skip if no password set (OAuth users) or password not modified
    if (!this.password || !this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, config.bcrypt.rounds);
    next();
});

userSchema.pre('save', async function (next) {
    if (!this.apiToken || !this.isModified('apiToken')) return next();
    if (/^\$2[aby]\$\d{2}\$/.test(this.apiToken)) return next();
    this.apiToken = await bcrypt.hash(this.apiToken, config.bcrypt.rounds);
    next();
});

userSchema.pre('findOneAndUpdate', async function (next) {
    const update = this.getUpdate() || {};
    const nextToken = update.apiToken ?? update.$set?.apiToken;
    if (!nextToken || /^\$2[aby]\$\d{2}\$/.test(String(nextToken))) return next();

    const hashed = await bcrypt.hash(String(nextToken), config.bcrypt.rounds);
    if (update.$set?.apiToken) {
        update.$set.apiToken = hashed;
    } else {
        update.apiToken = hashed;
    }
    this.setUpdate(update);
    return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.compareApiToken = async function (candidateToken) {
    if (!this.apiToken || !candidateToken) return false;
    return bcrypt.compare(candidateToken, this.apiToken);
};

/**
 * Strip sensitive fields when serializing.
 */
userSchema.methods.toSafeObject = function () {
    const obj = this.toObject();
    const walletSummary = buildPublicWalletSummary(obj);
    Object.assign(obj, {
        walletBalance: walletSummary.walletBalance,
        creditLimit: walletSummary.creditLimit,
        creditUsed: walletSummary.creditUsed,
        availableCredit: walletSummary.availableCredit,
        availableBalance: walletSummary.availableBalance,
        currency: walletSummary.currency,
        coins: walletSummary.walletBalance,
        balance: walletSummary.walletBalance,
    });
    delete obj.password;
    delete obj.twoFactorOtp;
    delete obj.twoFactorOtpExpires;
    delete obj.profileCompletionToken;
    delete obj.profileCompletionTokenExpires;
    delete obj.apiToken;
    delete obj.apiSecret;
    return obj;
};

const User = mongoose.model('User', userSchema);

module.exports = { User, ROLES, USER_STATUS, RESELLER_STATUS };
module.exports.User = User; // CommonJS default export convenience
