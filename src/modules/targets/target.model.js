'use strict';

const mongoose = require('mongoose');

const TARGET_ORDER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
});

const targetAppSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'name is required'],
            trim: true,
            maxlength: [120, 'name cannot exceed 120 characters'],
        },
        unitPrice: {
            type: Number,
            required: [true, 'unitPrice is required'],
            min: [0.000001, 'unitPrice must be greater than 0'],
        },
        image: {
            type: String,
            trim: true,
            maxlength: [2048, 'image path cannot exceed 2048 characters'],
            default: null,
        },
        targetAccountId: {
            type: String,
            trim: true,
            maxlength: [128, 'targetAccountId cannot exceed 128 characters'],
            default: '',
        },
        allowedPaymentMethods: {
            type: [String],
            required: [true, 'allowedPaymentMethods is required'],
            validate: {
                validator: (methods) => Array.isArray(methods) && methods.length > 0,
                message: 'allowedPaymentMethods must include at least one method',
            },
            set: (methods) => Array.isArray(methods)
                ? methods.map((method) => String(method).trim()).filter(Boolean)
                : methods,
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

targetAppSchema.index({ isActive: 1, name: 1 });

const targetOrderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'userId is required'],
            index: true,
        },
        coinAmount: {
            type: Number,
            required: [true, 'coinAmount is required'],
            min: [1, 'coinAmount must be at least 1'],
        },
        appId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TargetApp',
            required: [true, 'appId is required'],
            index: true,
        },
        appNameSnapshot: {
            type: String,
            required: [true, 'appNameSnapshot is required'],
            trim: true,
            maxlength: [120, 'appNameSnapshot cannot exceed 120 characters'],
        },
        senderId: {
            type: String,
            required: [true, 'senderId is required'],
            trim: true,
            maxlength: [64, 'senderId cannot exceed 64 characters'],
        },
        paymentMethod: {
            type: String,
            required: [true, 'paymentMethod is required'],
            trim: true,
            maxlength: [64, 'paymentMethod cannot exceed 64 characters'],
        },
        paymentMethodIdSnapshot: {
            type: String,
            trim: true,
            maxlength: [64, 'paymentMethodIdSnapshot cannot exceed 64 characters'],
            default: null,
        },
        paymentMethodNameSnapshot: {
            type: String,
            trim: true,
            maxlength: [120, 'paymentMethodNameSnapshot cannot exceed 120 characters'],
            default: null,
        },
        paymentMethodTypeSnapshot: {
            type: String,
            trim: true,
            maxlength: [64, 'paymentMethodTypeSnapshot cannot exceed 64 characters'],
            default: null,
        },
        targetAccountIdSnapshot: {
            type: String,
            trim: true,
            maxlength: [128, 'targetAccountIdSnapshot cannot exceed 128 characters'],
            default: null,
        },
        transferNumber: {
            type: String,
            required: [true, 'transferNumber is required'],
            trim: true,
            maxlength: [64, 'transferNumber cannot exceed 64 characters'],
        },
        transactionNumber: {
            type: String,
            required: [true, 'transactionNumber is required'],
            trim: true,
            maxlength: [64, 'transactionNumber cannot exceed 64 characters'],
        },
        screenshotProof: {
            type: String,
            required: [true, 'screenshotProof is required'],
            trim: true,
            maxlength: [2048, 'screenshotProof path cannot exceed 2048 characters'],
        },
        totalPrice: {
            type: Number,
            required: [true, 'totalPrice is required'],
            min: [0, 'totalPrice cannot be negative'],
        },
        unitPriceSnapshot: {
            type: Number,
            required: [true, 'unitPriceSnapshot is required'],
            min: [0, 'unitPriceSnapshot cannot be negative'],
        },
        status: {
            type: String,
            enum: {
                values: Object.values(TARGET_ORDER_STATUS),
                message: `status must be one of: ${Object.values(TARGET_ORDER_STATUS).join(', ')}`,
            },
            default: TARGET_ORDER_STATUS.PENDING,
            index: true,
        },
        adminNotes: {
            type: String,
            trim: true,
            maxlength: [500, 'adminNotes cannot exceed 500 characters'],
            default: null,
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
        idempotencyKey: {
            type: String,
            trim: true,
            maxlength: [128, 'idempotencyKey cannot exceed 128 characters'],
            default: undefined,
        },
        idempotencyFingerprint: {
            type: String,
            trim: true,
            maxlength: [128, 'idempotencyFingerprint cannot exceed 128 characters'],
            default: undefined,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

targetOrderSchema.index({ status: 1, createdAt: 1 });
targetOrderSchema.index({ userId: 1, createdAt: -1 });
targetOrderSchema.index({ appId: 1, createdAt: -1 });
targetOrderSchema.index(
    { userId: 1, idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        name: 'unique_target_user_idempotency_key',
    }
);

targetOrderSchema.virtual('isApproved').get(function () {
    return this.status === TARGET_ORDER_STATUS.APPROVED;
});

targetOrderSchema.virtual('isRejected').get(function () {
    return this.status === TARGET_ORDER_STATUS.REJECTED;
});

targetOrderSchema.virtual('isPending').get(function () {
    return this.status === TARGET_ORDER_STATUS.PENDING;
});

const TargetApp = mongoose.model('TargetApp', targetAppSchema);
const TargetOrder = mongoose.model('TargetOrder', targetOrderSchema);

module.exports = { TargetApp, TargetOrder, TARGET_ORDER_STATUS };
