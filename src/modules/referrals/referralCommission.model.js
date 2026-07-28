'use strict';

const mongoose = require('mongoose');

const REFERRAL_COMMISSION_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    LOCKED: 'LOCKED',
    PAID: 'PAID',
    CANCELLED: 'CANCELLED',
});

const REFERRAL_COMMISSION_SOURCE_TYPES = Object.freeze({
    DEPOSIT_APPROVAL: 'DEPOSIT_APPROVAL',
});

const referralCommissionSchema = new mongoose.Schema(
    {
        referrerUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        referredUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        sourceType: {
            type: String,
            required: true,
            enum: Object.values(REFERRAL_COMMISSION_SOURCE_TYPES),
            index: true,
        },
        sourceId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            index: true,
        },
        idempotencyKey: {
            type: String,
            required: true,
            trim: true,
            unique: true,
        },
        originalAmount: {
            type: String,
            required: true,
        },
        originalCurrency: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            match: [/^[A-Z]{3}$/, 'originalCurrency must be a 3-letter ISO code'],
        },
        commissionPercentSnapshot: {
            type: String,
            required: true,
        },
        commissionAmountOriginalCurrency: {
            type: String,
            required: true,
        },
        referrerCurrency: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            match: [/^[A-Z]{3}$/, 'referrerCurrency must be a 3-letter ISO code'],
        },
        commissionAmountReferrerCurrency: {
            type: String,
            required: true,
        },
        sourcePlatformRateSnapshot: {
            type: String,
            required: true,
        },
        targetPlatformRateSnapshot: {
            type: String,
            required: true,
        },
        effectiveFxRateSnapshot: {
            type: String,
            required: true,
        },
        conversionBaseCurrency: {
            type: String,
            default: 'USD',
            uppercase: true,
            trim: true,
        },
        convertedAt: {
            type: Date,
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(REFERRAL_COMMISSION_STATUS),
            default: REFERRAL_COMMISSION_STATUS.AVAILABLE,
            index: true,
        },
        payoutRequestId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ReferralPayout',
            default: null,
        },
        referralStartedAt: {
            type: Date,
            required: true,
        },
        eligibleUntil: {
            type: Date,
            required: true,
        },
        sourceCompletedAt: {
            type: Date,
            required: true,
            index: true,
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

referralCommissionSchema.index(
    { sourceType: 1, sourceId: 1, referrerUserId: 1 },
    { unique: true }
);
referralCommissionSchema.index({ referrerUserId: 1, status: 1, createdAt: -1 });
referralCommissionSchema.index({ referredUserId: 1, sourceCompletedAt: -1 });
referralCommissionSchema.index({ payoutRequestId: 1 });

referralCommissionSchema.set('toJSON', {
    transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret.__v;
        return ret;
    },
});

const ReferralCommission = mongoose.model('ReferralCommission', referralCommissionSchema);

module.exports = {
    ReferralCommission,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_COMMISSION_SOURCE_TYPES,
};
