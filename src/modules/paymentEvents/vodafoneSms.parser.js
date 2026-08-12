'use strict';

const Decimal = require('decimal.js');
const {
    PAYMENT_EVENT_SOURCE_TYPES,
    SMS_CLASSIFICATIONS,
    PAYMENT_EVENT_PARSE_STATUS,
} = require('./paymentEvent.model');

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const normalizeDigits = (value) => String(value || '')
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_ARABIC_DIGITS.indexOf(digit)));

const normalizeWhitespace = (value) => normalizeDigits(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();

const normalizeAmountText = (value) => {
    const cleaned = normalizeDigits(value)
        .replace(/,/g, '')
        .trim();
    const decimal = new Decimal(cleaned);
    if (!decimal.isFinite() || decimal.lessThanOrEqualTo(0)) return null;
    return decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
};

const normalizeEgyptianPhone = (value) => {
    const digits = normalizeDigits(value).replace(/[^\d]/g, '');
    if (!digits) return null;

    if (/^01\d{9}$/.test(digits)) return digits;
    if (/^201\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
    if (/^00201\d{9}$/.test(digits)) return `0${digits.slice(4)}`;

    return digits;
};

const hasIncomingVodafonePhrase = (text) => /تم\s*استلام\s*مبلغ/u.test(text);
const hasIncomingInstapayPhrase = (text) => /\bReceived\s+EGP\s*/i.test(text);

const isClearlyNonIncomingPayment = (text) => {
    const normalized = normalizeWhitespace(text).toLowerCase();

    if (hasIncomingVodafonePhrase(normalized) || hasIncomingInstapayPhrase(normalized)) {
        return false;
    }

    return [
        /فشل|فشلت|لم\s+تتم|مرفوض|تم\s+رفض|failed|declined|unsuccessful/i,
        /رصيدك|الرصيد|available\s+balance|balance\s+is/i,
        /فاتورة|bill\s+payment|bill\s+paid|سداد/i,
        /شحن|كارت|recharge|top\s*up/i,
        /عرض|خصم|اعلان|promo|offer|advert/i,
    ].some((pattern) => pattern.test(normalized));
};

const parseVodafoneWalletTransfer = (rawText) => {
    const text = normalizeWhitespace(rawText);
    if (!hasIncomingVodafonePhrase(text)) return null;

    const amountMatch = text.match(/تم\s*استلام\s*مبلغ\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:جنيه|ج\.?م|egp)/iu);
    const phoneMatch = text.match(/من\s*رقم\s*(\+?0?0?2?01\d{9})/iu);
    const transactionMatch = text.match(/رقم\s*العملية\s*[:：]?\s*([0-9]{8,20})/iu);

    if (!amountMatch || !phoneMatch || !transactionMatch) {
        return {
            classification: SMS_CLASSIFICATIONS.UNSUPPORTED_PAYMENT_FORMAT,
            parseStatus: PAYMENT_EVENT_PARSE_STATUS.FAILED,
            errorCode: 'VODAFONE_WALLET_PARSE_FAILED',
            errorMessage: 'Incoming Vodafone wallet SMS did not contain all required fields.',
        };
    }

    const amountText = normalizeAmountText(amountMatch[1]);
    if (!amountText) {
        return {
            classification: SMS_CLASSIFICATIONS.UNSUPPORTED_PAYMENT_FORMAT,
            parseStatus: PAYMENT_EVENT_PARSE_STATUS.FAILED,
            errorCode: 'VODAFONE_WALLET_AMOUNT_INVALID',
            errorMessage: 'Incoming Vodafone wallet SMS amount is invalid.',
        };
    }

    return {
        classification: SMS_CLASSIFICATIONS.VODAFONE_WALLET_TRANSFER,
        parseStatus: PAYMENT_EVENT_PARSE_STATUS.PARSED,
        sourceType: PAYMENT_EVENT_SOURCE_TYPES.VODAFONE_WALLET,
        amountText,
        amount: Number(amountText),
        currency: 'EGP',
        senderPhone: normalizeEgyptianPhone(phoneMatch[1]),
        transactionId: String(transactionMatch[1]),
    };
};

const parseInstapayTransfer = (rawText) => {
    const text = normalizeWhitespace(rawText);
    if (!hasIncomingInstapayPhrase(text)) return null;

    const paymentMatch = text.match(/\bReceived\s+EGP\s*([0-9]+(?:[.,][0-9]{1,2})?)\s+from\s+([+0-9]{11,16})\b/i);
    const refMatch = text.match(/\bRef\s*[:：]?\s*([0-9]{8,20})\b/i);

    if (!paymentMatch || !refMatch) {
        return {
            classification: SMS_CLASSIFICATIONS.UNSUPPORTED_PAYMENT_FORMAT,
            parseStatus: PAYMENT_EVENT_PARSE_STATUS.FAILED,
            errorCode: 'INSTAPAY_PARSE_FAILED',
            errorMessage: 'Incoming InstaPay SMS did not contain all required fields.',
        };
    }

    const amountText = normalizeAmountText(paymentMatch[1]);
    if (!amountText) {
        return {
            classification: SMS_CLASSIFICATIONS.UNSUPPORTED_PAYMENT_FORMAT,
            parseStatus: PAYMENT_EVENT_PARSE_STATUS.FAILED,
            errorCode: 'INSTAPAY_AMOUNT_INVALID',
            errorMessage: 'Incoming InstaPay SMS amount is invalid.',
        };
    }

    return {
        classification: SMS_CLASSIFICATIONS.INSTAPAY_TRANSFER,
        parseStatus: PAYMENT_EVENT_PARSE_STATUS.PARSED,
        sourceType: PAYMENT_EVENT_SOURCE_TYPES.INSTAPAY,
        amountText,
        amount: Number(amountText),
        currency: 'EGP',
        senderPhone: normalizeEgyptianPhone(paymentMatch[2]),
        transactionId: String(refMatch[1]),
    };
};

const classifyAndParseSms = (rawText) => {
    const text = String(rawText || '');
    const vodafone = parseVodafoneWalletTransfer(text);
    if (vodafone) return vodafone;

    const instapay = parseInstapayTransfer(text);
    if (instapay) return instapay;

    if (isClearlyNonIncomingPayment(text)) {
        return {
            classification: SMS_CLASSIFICATIONS.NON_PAYMENT_MESSAGE,
            parseStatus: PAYMENT_EVENT_PARSE_STATUS.IGNORED,
            errorCode: 'NON_PAYMENT_MESSAGE',
            errorMessage: 'SMS is not an incoming payment notification.',
        };
    }

    return {
        classification: SMS_CLASSIFICATIONS.NON_PAYMENT_MESSAGE,
        parseStatus: PAYMENT_EVENT_PARSE_STATUS.IGNORED,
        errorCode: 'UNRECOGNIZED_SMS',
        errorMessage: 'SMS does not match supported incoming payment formats.',
    };
};

module.exports = {
    classifyAndParseSms,
    normalizeDigits,
    normalizeWhitespace,
    normalizeAmountText,
    normalizeEgyptianPhone,
};
