'use strict';

const mongoose = require('mongoose');

/**
 * Wallet transaction types.
 */
const TRANSACTION_TYPES = Object.freeze({
    CREDIT: 'CREDIT',
    DEBIT: 'DEBIT',
    REFUND: 'REFUND',
    DEBT_ADJUSTMENT: 'DEBT_ADJUSTMENT',
});

/**
 * Transaction status values.
 */
const TRANSACTION_STATUS = Object.freeze({
    PENDING: 'PENDING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const WALLET_TRANSACTION_SOURCE_TYPES = Object.freeze({
    ORDER: 'ORDER',
    DEPOSIT: 'DEPOSIT',
    REFERRAL_PAYOUT: 'REFERRAL_PAYOUT',
    ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
});

const walletTransactionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'User ID is required'],
            index: true,
        },

        type: {
            type: String,
            enum: Object.values(TRANSACTION_TYPES),
            required: [true, 'Transaction type is required'],
        },

        amount: {
            type: Number,
            required: [true, 'Amount is required'],
            min: [0.01, 'Amount must be greater than 0'],
        },

        balanceBefore: {
            type: Number,
            required: [true, 'Balance before is required'],
        },

        balanceAfter: {
            type: Number,
            required: [true, 'Balance after is required'],
        },

        reference: {
            // Typically references an Order ID
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
        },

        sourceType: {
            type: String,
            enum: Object.values(WALLET_TRANSACTION_SOURCE_TYPES),
            default: null,
            index: true,
        },

        sourceId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },

        sourceKey: {
            type: String,
            trim: true,
            default: null,
            maxlength: [160, 'sourceKey cannot exceed 160 characters'],
        },

        status: {
            type: String,
            enum: Object.values(TRANSACTION_STATUS),
            default: TRANSACTION_STATUS.COMPLETED,
        },

        description: {
            type: String,
            trim: true,
            maxlength: 255,
        },
    },
    {
        timestamps: true,
    }
);

// Compound index for efficient user transaction history queries
walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ reference: 1 });
walletTransactionSchema.index(
    { sourceKey: 1 },
    {
        unique: true,
        partialFilterExpression: { sourceKey: { $type: 'string' } },
        name: 'unique_wallet_transaction_source_key',
    }
);

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);

module.exports = {
    WalletTransaction,
    TRANSACTION_TYPES,
    TRANSACTION_STATUS,
    WALLET_TRANSACTION_SOURCE_TYPES,
};
