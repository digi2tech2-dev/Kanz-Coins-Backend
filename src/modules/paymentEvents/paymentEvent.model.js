'use strict';

const mongoose = require('mongoose');

const PAYMENT_EVENT_PROVIDERS = Object.freeze({
    VODAFONE_CASH: 'VODAFONE_CASH',
});

const PAYMENT_EVENT_SOURCE_TYPES = Object.freeze({
    VODAFONE_WALLET: 'VODAFONE_WALLET',
    INSTAPAY: 'INSTAPAY',
});

const SMS_CLASSIFICATIONS = Object.freeze({
    VODAFONE_WALLET_TRANSFER: 'VODAFONE_WALLET_TRANSFER',
    INSTAPAY_TRANSFER: 'INSTAPAY_TRANSFER',
    NON_PAYMENT_MESSAGE: 'NON_PAYMENT_MESSAGE',
    UNSUPPORTED_PAYMENT_FORMAT: 'UNSUPPORTED_PAYMENT_FORMAT',
});

const PAYMENT_EVENT_PARSE_STATUS = Object.freeze({
    PARSED: 'PARSED',
    IGNORED: 'IGNORED',
    FAILED: 'FAILED',
});

const PAYMENT_EVENT_MATCH_STATUS = Object.freeze({
    UNMATCHED: 'UNMATCHED',
    MATCHED: 'MATCHED',
    AMBIGUOUS: 'AMBIGUOUS',
    MISMATCH: 'MISMATCH',
    PROCESSED: 'PROCESSED',
});

const paymentEventSchema = new mongoose.Schema(
    {
        provider: {
            type: String,
            enum: Object.values(PAYMENT_EVENT_PROVIDERS),
            required: true,
            index: true,
        },
        sourceType: {
            type: String,
            enum: Object.values(PAYMENT_EVENT_SOURCE_TYPES),
            default: null,
            index: true,
        },
        bridgeId: {
            type: String,
            required: true,
            trim: true,
            maxlength: 128,
        },
        smsSender: {
            type: String,
            required: true,
            trim: true,
            maxlength: 128,
        },
        transactionId: {
            type: String,
            trim: true,
            default: null,
            maxlength: 64,
        },
        amount: {
            type: Number,
            default: null,
            min: 0,
        },
        amountText: {
            type: String,
            trim: true,
            default: null,
            maxlength: 32,
        },
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            default: 'EGP',
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'],
        },
        senderPhone: {
            type: String,
            trim: true,
            default: null,
            maxlength: 32,
            index: true,
        },
        smsSentAt: {
            type: Date,
            default: null,
        },
        smsReceivedAt: {
            type: Date,
            default: null,
        },
        serverReceivedAt: {
            type: Date,
            required: true,
            default: Date.now,
        },
        rawMessage: {
            type: String,
            required: true,
            maxlength: 5000,
        },
        rawPayload: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
        deliveryFingerprint: {
            type: String,
            required: true,
            trim: true,
            maxlength: 128,
        },
        classification: {
            type: String,
            enum: Object.values(SMS_CLASSIFICATIONS),
            required: true,
            index: true,
        },
        parseStatus: {
            type: String,
            enum: Object.values(PAYMENT_EVENT_PARSE_STATUS),
            required: true,
            index: true,
        },
        matchStatus: {
            type: String,
            enum: Object.values(PAYMENT_EVENT_MATCH_STATUS),
            default: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED,
            index: true,
        },
        matchedDepositId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'DepositRequest',
            default: null,
            index: true,
        },
        matchedUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },
        processedAt: {
            type: Date,
            default: null,
        },
        autoApprovalAttemptedAt: {
            type: Date,
            default: null,
        },
        autoApprovalError: {
            type: String,
            trim: true,
            default: null,
            maxlength: 256,
        },
        errorCode: {
            type: String,
            trim: true,
            default: null,
            maxlength: 64,
        },
        errorMessage: {
            type: String,
            trim: true,
            default: null,
            maxlength: 256,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

paymentEventSchema.index(
    { provider: 1, sourceType: 1, transactionId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            parseStatus: PAYMENT_EVENT_PARSE_STATUS.PARSED,
            transactionId: { $type: 'string' },
        },
        name: 'unique_parsed_payment_event_transaction',
    }
);

paymentEventSchema.index(
    { deliveryFingerprint: 1 },
    {
        unique: true,
        name: 'unique_payment_event_delivery_fingerprint',
    }
);

paymentEventSchema.index({ parseStatus: 1, matchStatus: 1, createdAt: -1 });

const PaymentEvent = mongoose.model('PaymentEvent', paymentEventSchema);

module.exports = {
    PaymentEvent,
    PAYMENT_EVENT_PROVIDERS,
    PAYMENT_EVENT_SOURCE_TYPES,
    SMS_CLASSIFICATIONS,
    PAYMENT_EVENT_PARSE_STATUS,
    PAYMENT_EVENT_MATCH_STATUS,
};
