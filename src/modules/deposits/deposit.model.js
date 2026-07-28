'use strict';

const mongoose = require('mongoose');

/**
 * Deposit request status lifecycle.
 *
 *  PENDING  → APPROVED   (admin approves, wallet is credited with amountUsd)
 *  PENDING  → REJECTED   (admin rejects, wallet unchanged)
 *
 * Status transitions are one-way — you cannot un-approve or un-reject.
 * Further state changes (re-submission, appeals) require a new deposit request.
 */
const DEPOSIT_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
});

const REFERRAL_COMMISSION_PROCESSING_STATUS = Object.freeze({
    NOT_APPLICABLE: 'NOT_APPLICABLE',
    PENDING: 'PENDING',
    PROCESSED: 'PROCESSED',
    FAILED: 'FAILED',
});

const depositRequestSchema = new mongoose.Schema(
    {
        /** Customer who created this request. */
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'userId is required'],
            index: true,
        },

        /**
         * ID of the dynamic payment method the customer selected.
         * References the admin-configured payment methods stored in settings.
         */
        paymentMethodId: {
            type: String,
            required: [true, 'paymentMethodId is required'],
            trim: true,
        },

        /**
         * Amount the customer claims to have transferred, in the local currency.
         * Must be a positive number. Stored as-is in the request.
         */
        requestedAmount: {
            type: Number,
            required: [true, 'requestedAmount is required'],
            min: [0.01, 'requestedAmount must be greater than 0'],
        },

        /**
         * ISO 4217 currency code the deposit was made in.
         * e.g. 'EGP', 'USD', 'SAR'
         */
        currency: {
            type: String,
            required: [true, 'currency is required'],
            uppercase: true,
            trim: true,
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code (e.g. USD, EGP)'],
        },

        /**
         * The platformRate of the currency at the time of request.
         * Frozen at creation time so future rate changes don't affect
         * the value of this pending deposit.
         * Convention: 1 USD = exchangeRate units of this currency.
         */
        exchangeRate: {
            type: Number,
            required: [true, 'exchangeRate is required'],
            min: [0.000001, 'exchangeRate must be positive'],
        },

        /**
         * USD equivalent: requestedAmount / exchangeRate.
         * This is the amount that will be credited to the user's wallet on approval.
         * Wallet balances are always denominated in USD.
         */
        amountUsd: {
            type: Number,
            required: [true, 'amountUsd is required'],
            min: [0.01, 'amountUsd must be greater than 0'],
        },

        /**
         * Relative path to the uploaded receipt image/PDF.
         * Stored by multer via createUpload('deposits').
         * e.g. 'uploads/deposits/1679580000000-abcdef01.jpg'
         */
        receiptImage: {
            type: String,
            required: [true, 'receiptImage is required'],
            trim: true,
            maxlength: [2048, 'receiptImage path cannot exceed 2048 characters'],
        },

        /** Optional customer notes. */
        notes: {
            type: String,
            trim: true,
            maxlength: [500, 'notes cannot exceed 500 characters'],
            default: null,
        },

        /** Sender wallet number/address supplied by the customer for manual verification. */
        senderDetails: {
            methodType: {
                type: String,
                trim: true,
                maxlength: [64, 'sender method type cannot exceed 64 characters'],
                default: null,
            },
            field: {
                type: String,
                trim: true,
                maxlength: [64, 'sender detail field cannot exceed 64 characters'],
                default: null,
            },
            label: {
                type: String,
                trim: true,
                maxlength: [128, 'sender detail label cannot exceed 128 characters'],
                default: null,
            },
            value: {
                type: String,
                trim: true,
                maxlength: [200, 'sender detail value cannot exceed 200 characters'],
                default: null,
            },
        },

        /** Current lifecycle status. */
        status: {
            type: String,
            enum: {
                values: Object.values(DEPOSIT_STATUS),
                message: `status must be one of: ${Object.values(DEPOSIT_STATUS).join(', ')}`,
            },
            default: DEPOSIT_STATUS.PENDING,
            index: true,
        },

        /** Admin reasoning for rejection (optional). */
        adminNotes: {
            type: String,
            trim: true,
            maxlength: [500, 'adminNotes cannot exceed 500 characters'],
            default: null,
        },

        /** Admin who reviewed this request (null while PENDING). */
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        /** Timestamp of the admin review decision. */
        reviewedAt: {
            type: Date,
            default: null,
        },

        referralCommissionProcessingStatus: {
            type: String,
            enum: Object.values(REFERRAL_COMMISSION_PROCESSING_STATUS),
            default: REFERRAL_COMMISSION_PROCESSING_STATUS.NOT_APPLICABLE,
            index: true,
        },

        referralCommissionOutcome: {
            type: String,
            trim: true,
            default: null,
            maxlength: 128,
        },

        referralCommissionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ReferralCommission',
            default: null,
        },

        referralCommissionProcessedAt: {
            type: Date,
            default: null,
        },

        referralCommissionError: {
            type: String,
            trim: true,
            default: null,
            maxlength: 256,
        },
    },
    {
        timestamps: true,  // createdAt + updatedAt
        versionKey: false,  // no __v
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Admin dashboard: fetch all PENDING requests sorted by submission time.
 */
depositRequestSchema.index({ status: 1, createdAt: 1 });

/**
 * Customer: list their own deposit history.
 */
depositRequestSchema.index({ userId: 1, createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

depositRequestSchema.virtual('isApproved').get(function () {
    return this.status === DEPOSIT_STATUS.APPROVED;
});

depositRequestSchema.virtual('isRejected').get(function () {
    return this.status === DEPOSIT_STATUS.REJECTED;
});

depositRequestSchema.virtual('isPending').get(function () {
    return this.status === DEPOSIT_STATUS.PENDING;
});

// ─── Model ────────────────────────────────────────────────────────────────────

const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);

module.exports = {
    DepositRequest,
    DEPOSIT_STATUS,
    REFERRAL_COMMISSION_PROCESSING_STATUS,
};
