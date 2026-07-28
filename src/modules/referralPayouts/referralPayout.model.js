'use strict';

const mongoose = require('mongoose');

const REFERRAL_PAYOUT_METHODS = Object.freeze({
    WALLET_CREDIT: 'WALLET_CREDIT',
    MANUAL_EXTERNAL: 'MANUAL_EXTERNAL',
});

const REFERRAL_PAYOUT_STATUS = Object.freeze({
    PENDING: 'PENDING',
    PAID: 'PAID',
    REJECTED: 'REJECTED',
});

const referralPayoutSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        method: {
            type: String,
            required: true,
            enum: Object.values(REFERRAL_PAYOUT_METHODS),
            immutable: true,
            index: true,
        },
        currency: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            immutable: true,
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code'],
            index: true,
        },
        amount: {
            type: String,
            required: true,
            immutable: true,
        },
        status: {
            type: String,
            enum: Object.values(REFERRAL_PAYOUT_STATUS),
            default: REFERRAL_PAYOUT_STATUS.PENDING,
            index: true,
        },
        commissionIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ReferralCommission',
            immutable: true,
        }],
        commissionCount: {
            type: Number,
            required: true,
            min: 1,
            immutable: true,
        },
        externalPaymentDetails: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        externalPaymentSummary: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        externalTransactionReference: {
            type: String,
            trim: true,
            maxlength: 160,
            default: null,
        },
        walletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            default: null,
        },
        paymentProofPath: {
            type: String,
            trim: true,
            default: null,
        },
        paymentProofFileName: {
            type: String,
            trim: true,
            default: null,
        },
        paymentProofMimeType: {
            type: String,
            trim: true,
            default: null,
        },
        paymentProofSize: {
            type: Number,
            default: 0,
            min: 0,
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        paidAt: {
            type: Date,
            default: null,
        },
        rejectionReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },
        idempotencyKey: {
            type: String,
            trim: true,
            maxlength: 128,
            default: undefined,
        },
        idempotencyFingerprint: {
            type: String,
            trim: true,
            maxlength: 128,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

referralPayoutSchema.index({ userId: 1, createdAt: -1 });
referralPayoutSchema.index({ status: 1, createdAt: -1 });
referralPayoutSchema.index({ method: 1, status: 1, createdAt: -1 });
referralPayoutSchema.index(
    { userId: 1, idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        name: 'unique_referral_payout_user_idempotency_key',
    }
);
referralPayoutSchema.index(
    { walletTransactionId: 1 },
    {
        unique: true,
        partialFilterExpression: { walletTransactionId: { $type: 'objectId' } },
        name: 'unique_referral_payout_wallet_transaction',
    }
);

referralPayoutSchema.set('toJSON', {
    transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret.__v;
        return ret;
    },
});

const ReferralPayout = mongoose.model('ReferralPayout', referralPayoutSchema);

module.exports = {
    ReferralPayout,
    REFERRAL_PAYOUT_METHODS,
    REFERRAL_PAYOUT_STATUS,
};
