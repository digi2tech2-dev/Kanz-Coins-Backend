'use strict';

const crypto = require('crypto');

const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 10;
const REFERRAL_CODE_PATTERN = /^[A-Z0-9]{6,32}$/;

const generateReferralCode = (length = REFERRAL_CODE_LENGTH) => {
    let code = '';
    for (let i = 0; i < length; i += 1) {
        code += REFERRAL_CODE_ALPHABET[crypto.randomInt(0, REFERRAL_CODE_ALPHABET.length)];
    }
    return code;
};

const normalizeReferralCode = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    return REFERRAL_CODE_PATTERN.test(normalized) ? normalized : '';
};

const isDuplicateReferralCodeError = (err) => (
    err?.code === 11000
    && (
        err?.keyPattern?.referralCode
        || Object.prototype.hasOwnProperty.call(err?.keyValue || {}, 'referralCode')
    )
);

module.exports = {
    REFERRAL_CODE_ALPHABET,
    REFERRAL_CODE_LENGTH,
    REFERRAL_CODE_PATTERN,
    generateReferralCode,
    normalizeReferralCode,
    isDuplicateReferralCodeError,
};
