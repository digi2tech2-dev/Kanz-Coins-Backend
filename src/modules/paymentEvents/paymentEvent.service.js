'use strict';

const crypto = require('crypto');
const Decimal = require('decimal.js');
const mongoose = require('mongoose');
const config = require('../../config/config');
const { AppError } = require('../../shared/errors/AppError');
const { DepositRequest, DEPOSIT_STATUS } = require('../deposits/deposit.model');
const { getPaymentSettings } = require('../admin/admin.settings.service');
const depositService = require('../deposits/deposit.service');
const {
    PaymentEvent,
    PAYMENT_EVENT_PROVIDERS,
    PAYMENT_EVENT_SOURCE_TYPES,
    PAYMENT_EVENT_PARSE_STATUS,
    PAYMENT_EVENT_MATCH_STATUS,
} = require('./paymentEvent.model');
const {
    classifyAndParseSms,
    normalizeEgyptianPhone,
} = require('./vodafoneSms.parser');

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000001');
const MAX_SMS_TEXT_LENGTH = 5000;

const isDuplicateKeyError = (err) => err?.code === 11000;

const maskValue = (value) => {
    const text = String(value || '');
    if (text.length <= 6) return text ? '***' : '';
    return `${text.slice(0, 4)}******${text.slice(-2)}`;
};

const normalizeSenderName = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

const isTrustedSmsSender = (value) => normalizeSenderName(value) === 'vfcash';

const parseSmsTimestamp = (value, fieldName) => {
    if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
        return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        throw new AppError(`${fieldName} is invalid.`, 400, 'INVALID_SMS_TIMESTAMP');
    }
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
        throw new AppError(`${fieldName} is invalid.`, 400, 'INVALID_SMS_TIMESTAMP');
    }
    return date;
};

const buildDeliveryFingerprint = ({ bridgeId, sender, receivedStamp, rawMessage }) => {
    return crypto
        .createHash('sha256')
        .update(String(bridgeId || ''))
        .update('|')
        .update(String(sender || ''))
        .update('|')
        .update(String(receivedStamp || ''))
        .update('|')
        .update(String(rawMessage || ''))
        .digest('hex');
};

const parseSignatureHeader = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    const withoutPrefix = trimmed.toLowerCase().startsWith('sha256=')
        ? trimmed.slice(7)
        : trimmed;
    if (!/^[a-f0-9]{64}$/i.test(withoutPrefix)) return null;
    return Buffer.from(withoutPrefix, 'hex');
};

const verifyHmacSignature = ({ rawBody, signature, secret }) => {
    const provided = parseSignatureHeader(signature);
    if (!provided) return false;

    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest();

    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
};

const assertBridgeAuth = ({ headers, rawBody }) => {
    const bridgeConfig = config.vodafoneSmsBridge;
    if (!bridgeConfig.enabled) {
        throw new AppError('Vodafone SMS bridge is disabled.', 503, 'SMS_BRIDGE_DISABLED');
    }
    if (!bridgeConfig.hmacSecret) {
        throw new AppError('Vodafone SMS bridge is not configured.', 503, 'SMS_BRIDGE_NOT_CONFIGURED');
    }

    const bridgeId = String(headers['x-bridge-id'] || headers['X-Bridge-Id'] || '').trim();
    if (!bridgeId || bridgeId !== bridgeConfig.deviceId) {
        throw new AppError('Bridge authentication failed.', 401, 'SMS_BRIDGE_ID_INVALID');
    }

    const signature = headers['x-signature'] || headers['X-Signature'];
    if (!signature) {
        throw new AppError('Bridge signature is required.', 401, 'SMS_SIGNATURE_REQUIRED');
    }

    if (!verifyHmacSignature({ rawBody, signature, secret: bridgeConfig.hmacSecret })) {
        throw new AppError('Bridge signature is invalid.', 401, 'SMS_SIGNATURE_INVALID');
    }

    return bridgeId;
};

const parseRawJson = (rawBody) => {
    try {
        return JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
        throw new AppError('Invalid JSON payload.', 400, 'INVALID_JSON');
    }
};

const validatePayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AppError('Payload must be a JSON object.', 400, 'INVALID_SMS_PAYLOAD');
    }

    const smsSender = String(payload.from || '').trim();
    const rawMessage = String(payload.text || '');
    if (!smsSender) {
        throw new AppError('SMS sender is required.', 400, 'SMS_SENDER_REQUIRED');
    }
    if (!isTrustedSmsSender(smsSender)) {
        throw new AppError('SMS sender is not accepted.', 422, 'SMS_SENDER_UNSUPPORTED');
    }
    if (!rawMessage.trim()) {
        throw new AppError('SMS text is required.', 400, 'SMS_TEXT_REQUIRED');
    }
    if (rawMessage.length > MAX_SMS_TEXT_LENGTH) {
        throw new AppError('SMS text is too long.', 413, 'SMS_TEXT_TOO_LONG');
    }

    const smsSentAt = parseSmsTimestamp(payload.sentStamp, 'sentStamp');
    const smsReceivedAt = parseSmsTimestamp(payload.receivedStamp, 'receivedStamp');

    return { smsSender, rawMessage, smsSentAt, smsReceivedAt };
};

const getEventEffectiveReceivedAt = (event) =>
    event.smsReceivedAt || event.smsSentAt || event.serverReceivedAt || event.createdAt;

const isEventTooOldForAutoApproval = (event) => {
    const maxMinutes = Number(config.vodafoneSmsBridge.maxEventAgeMinutes) || 1440;
    if (maxMinutes <= 0) return true;
    const receivedAt = getEventEffectiveReceivedAt(event);
    if (!receivedAt) return false;
    return Date.now() - new Date(receivedAt).getTime() > maxMinutes * 60 * 1000;
};

const normalizeMethodToken = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');

const looksLikeVodafoneMethod = (method = {}) => {
    const haystack = [
        method.id,
        method.name,
        method.nameAr,
        method.label,
        method.type,
        method.kind,
    ].map(normalizeMethodToken).join(' ');

    return haystack.includes('vodafone')
        || haystack.includes('vf cash')
        || haystack.includes('فودافون');
};

const getVodafonePaymentMethodIds = async () => {
    const ids = new Set(['vodafone', 'vodafone cash', 'vodafone_cash', 'vf cash']);
    try {
        const settings = await getPaymentSettings();
        for (const group of settings.paymentGroups || []) {
            for (const method of group.methods || []) {
                if (looksLikeVodafoneMethod(method) && method.id) {
                    ids.add(String(method.id));
                }
            }
        }
    } catch (_) {
        // Payment settings are best-effort for matching. String fallback still applies.
    }
    return [...ids];
};

const amountEquals = (left, right) => {
    try {
        return new Decimal(left ?? 0).toDecimalPlaces(2).eq(
            new Decimal(right ?? 0).toDecimalPlaces(2)
        );
    } catch (_) {
        return false;
    }
};

const getDepositTransactionId = (deposit) => {
    return String(
        deposit.paymentTransactionId
        || deposit.senderDetails?.transactionNumber
        || deposit.senderDetails?.transactionId
        || ''
    ).trim();
};

const getDepositSenderPhone = (deposit) => {
    const value = deposit.senderDetails?.value || '';
    return normalizeEgyptianPhone(value);
};

const isPhoneCompatible = (deposit, event) => {
    const depositPhone = getDepositSenderPhone(deposit);
    const eventPhone = normalizeEgyptianPhone(event.senderPhone);
    if (!depositPhone || !eventPhone) return true;
    return depositPhone === eventPhone;
};

const buildVodafoneDepositFilter = async () => {
    const methodIds = await getVodafonePaymentMethodIds();
    const escaped = methodIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return {
        status: DEPOSIT_STATUS.PENDING,
        $or: [
            { paymentMethodId: { $in: methodIds } },
            { paymentMethodId: { $regex: new RegExp(`^(${escaped.join('|')})$`, 'i') } },
            { paymentMethodId: { $regex: /vodafone|vf cash|فودافون/i } },
        ],
    };
};

const matchParsedPaymentEvent = async (event) => {
    if (event.parseStatus !== PAYMENT_EVENT_PARSE_STATUS.PARSED || !event.transactionId) {
        return {
            matchStatus: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED,
            matchedDepositId: null,
            matchedUserId: null,
            deposit: null,
        };
    }

    const filter = await buildVodafoneDepositFilter();
    const deposits = await DepositRequest.find(filter).lean();
    const sameTransaction = deposits.filter((deposit) =>
        getDepositTransactionId(deposit) === event.transactionId
    );

    if (sameTransaction.length > 0) {
        const exact = sameTransaction.filter((deposit) =>
            amountEquals(deposit.requestedAmount, event.amount)
            && normalizeMethodToken(deposit.currency || 'EGP') === normalizeMethodToken(event.currency || 'EGP')
            && isPhoneCompatible(deposit, event)
        );

        if (exact.length === 1) {
            return {
                matchStatus: PAYMENT_EVENT_MATCH_STATUS.MATCHED,
                matchedDepositId: exact[0]._id,
                matchedUserId: exact[0].userId,
                deposit: exact[0],
            };
        }
        if (exact.length > 1) {
            return {
                matchStatus: PAYMENT_EVENT_MATCH_STATUS.AMBIGUOUS,
                matchedDepositId: null,
                matchedUserId: null,
                deposit: null,
            };
        }

        return {
            matchStatus: PAYMENT_EVENT_MATCH_STATUS.MISMATCH,
            matchedDepositId: null,
            matchedUserId: null,
            deposit: null,
        };
    }

    return {
        matchStatus: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED,
        matchedDepositId: null,
        matchedUserId: null,
        deposit: null,
    };
};

const canAutoApproveEvent = (event) => {
    if (!config.vodafoneSmsBridge.autoApprove) return false;
    if (event.sourceType === PAYMENT_EVENT_SOURCE_TYPES.INSTAPAY
        && !config.vodafoneSmsBridge.instapayAutoApprove) {
        return false;
    }
    if (isEventTooOldForAutoApproval(event)) return false;
    return event.sourceType === PAYMENT_EVENT_SOURCE_TYPES.VODAFONE_WALLET
        || (event.sourceType === PAYMENT_EVENT_SOURCE_TYPES.INSTAPAY && config.vodafoneSmsBridge.instapayAutoApprove);
};

const applyMatchResult = async (event, matchResult) => {
    event.matchStatus = matchResult.matchStatus;
    event.matchedDepositId = matchResult.matchedDepositId || null;
    event.matchedUserId = matchResult.matchedUserId || null;
    await event.save();

    if (matchResult.matchStatus !== PAYMENT_EVENT_MATCH_STATUS.MATCHED) {
        return { event, autoApproved: false };
    }

    console.info('[PaymentEvent] Matched SMS payment event', {
        eventId: event._id.toString(),
        sourceType: event.sourceType,
        transactionId: maskValue(event.transactionId),
        senderPhone: maskValue(event.senderPhone),
        depositId: matchResult.matchedDepositId.toString(),
        autoApprove: config.vodafoneSmsBridge.autoApprove,
    });

    if (!canAutoApproveEvent(event)) {
        return { event, autoApproved: false };
    }

    event.autoApprovalAttemptedAt = new Date();
    await event.save();

    try {
        await depositService.approveDeposit(
            matchResult.matchedDepositId,
            null,
            {
                reviewSource: 'VODAFONE_SMS_AUTO',
                paymentEventId: event._id,
                autoVerifiedAt: new Date(),
            },
            {
                actorId: SYSTEM_ACTOR_ID,
                actorRole: 'SYSTEM',
                ipAddress: null,
                userAgent: 'vodafone-sms-bridge',
            }
        );

        event.matchStatus = PAYMENT_EVENT_MATCH_STATUS.PROCESSED;
        event.processedAt = new Date();
        event.autoApprovalError = null;
        await event.save();

        return { event, autoApproved: true };
    } catch (err) {
        event.autoApprovalError = String(err.code || err.message || 'AUTO_APPROVAL_FAILED').slice(0, 256);
        await event.save();
        throw err;
    }
};

const findDuplicateEvent = async ({ deliveryFingerprint, parsed }) => {
    const byFingerprint = await PaymentEvent.findOne({ deliveryFingerprint });
    if (byFingerprint) return byFingerprint;

    if (parsed.parseStatus === PAYMENT_EVENT_PARSE_STATUS.PARSED && parsed.transactionId) {
        return PaymentEvent.findOne({
            provider: PAYMENT_EVENT_PROVIDERS.VODAFONE_CASH,
            sourceType: parsed.sourceType,
            transactionId: parsed.transactionId,
        });
    }
    return null;
};

const processVodafoneCashWebhook = async ({ headers, rawBody }) => {
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
    const bridgeId = assertBridgeAuth({ headers, rawBody: bodyBuffer });
    const payload = parseRawJson(bodyBuffer);
    const { smsSender, rawMessage, smsSentAt, smsReceivedAt } = validatePayload(payload);
    const parsed = classifyAndParseSms(rawMessage);
    const deliveryFingerprint = buildDeliveryFingerprint({
        bridgeId,
        sender: smsSender,
        receivedStamp: payload.receivedStamp,
        rawMessage,
    });

    const duplicate = await findDuplicateEvent({ deliveryFingerprint, parsed });
    if (duplicate) {
        return {
            success: true,
            duplicate: true,
            parsed: duplicate.parseStatus === PAYMENT_EVENT_PARSE_STATUS.PARSED,
            sourceType: duplicate.sourceType || undefined,
            matched: [
                PAYMENT_EVENT_MATCH_STATUS.MATCHED,
                PAYMENT_EVENT_MATCH_STATUS.PROCESSED,
            ].includes(duplicate.matchStatus),
            autoApproved: duplicate.matchStatus === PAYMENT_EVENT_MATCH_STATUS.PROCESSED,
        };
    }

    let event;
    try {
        event = await PaymentEvent.create({
            provider: PAYMENT_EVENT_PROVIDERS.VODAFONE_CASH,
            sourceType: parsed.sourceType || null,
            bridgeId,
            smsSender,
            transactionId: parsed.transactionId || null,
            amount: parsed.amount ?? null,
            amountText: parsed.amountText || null,
            currency: parsed.currency || 'EGP',
            senderPhone: parsed.senderPhone || null,
            smsSentAt,
            smsReceivedAt,
            serverReceivedAt: new Date(),
            rawMessage,
            rawPayload: payload,
            deliveryFingerprint,
            classification: parsed.classification,
            parseStatus: parsed.parseStatus,
            matchStatus: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED,
            errorCode: parsed.errorCode || null,
            errorMessage: parsed.errorMessage || null,
        });
    } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        return { success: true, duplicate: true };
    }

    let autoApproved = false;
    if (event.parseStatus === PAYMENT_EVENT_PARSE_STATUS.PARSED) {
        const matchResult = await matchParsedPaymentEvent(event);
        const applied = await applyMatchResult(event, matchResult);
        event = applied.event;
        autoApproved = applied.autoApproved;
    }

    return {
        success: true,
        duplicate: false,
        parsed: event.parseStatus === PAYMENT_EVENT_PARSE_STATUS.PARSED,
        sourceType: event.sourceType || undefined,
        matched: [
            PAYMENT_EVENT_MATCH_STATUS.MATCHED,
            PAYMENT_EVENT_MATCH_STATUS.PROCESSED,
        ].includes(event.matchStatus),
        matchStatus: event.matchStatus,
        autoApproved,
    };
};

const matchExistingUnmatchedPaymentForDeposit = async (depositId) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit || deposit.status !== DEPOSIT_STATUS.PENDING) return null;

    const transactionId = getDepositTransactionId(deposit);
    if (!transactionId) return null;

    const events = await PaymentEvent.find({
        provider: PAYMENT_EVENT_PROVIDERS.VODAFONE_CASH,
        parseStatus: PAYMENT_EVENT_PARSE_STATUS.PARSED,
        matchStatus: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED,
        transactionId,
    }).sort({ createdAt: 1 });

    for (const event of events) {
        if (!amountEquals(deposit.requestedAmount, event.amount)
            || normalizeMethodToken(deposit.currency || 'EGP') !== normalizeMethodToken(event.currency || 'EGP')
            || !isPhoneCompatible(deposit, event)) {
            continue;
        }

        const matchResult = await matchParsedPaymentEvent(event);
        const applied = await applyMatchResult(event, matchResult);
        return applied.event;
    }

    return null;
};

module.exports = {
    processVodafoneCashWebhook,
    matchExistingUnmatchedPaymentForDeposit,
    matchParsedPaymentEvent,
    verifyHmacSignature,
    buildDeliveryFingerprint,
    maskValue,
};
