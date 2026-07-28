'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { AppError } = require('../../shared/errors/AppError');
const { normalizeReferralCode } = require('../../shared/utils/referralCode');
const OAuthStateNonce = require('./oauthStateNonce.model');

const OAUTH_STATE_PURPOSE = 'google-oauth';
const OAUTH_STATE_TTL = '10m';

const normalizeIntent = (value) => (
    String(value || '').trim().toLowerCase() === 'signup' ? 'signup' : 'login'
);

const createGoogleOAuthState = ({ referralCode, intent } = {}, options = {}) => {
    const payload = {
        purpose: OAUTH_STATE_PURPOSE,
        nonce: crypto.randomBytes(16).toString('hex'),
        intent: normalizeIntent(intent),
    };

    const normalizedReferralCode = normalizeReferralCode(referralCode);
    if (normalizedReferralCode) payload.referralCode = normalizedReferralCode;

    return jwt.sign(payload, config.jwt.secret, {
        expiresIn: options.expiresIn || OAUTH_STATE_TTL,
        issuer: 'kanz-coins-api',
        audience: 'google-oauth',
    });
};

const consumeGoogleOAuthState = async (state) => {
    if (!state) {
        throw new AppError('OAuth state is required.', 400, 'OAUTH_STATE_INVALID');
    }

    let decoded;
    try {
        decoded = jwt.verify(state, config.jwt.secret, {
            issuer: 'kanz-coins-api',
            audience: 'google-oauth',
        });
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw new AppError('OAuth state has expired.', 400, 'OAUTH_STATE_EXPIRED');
        }
        throw new AppError('OAuth state is invalid.', 400, 'OAUTH_STATE_INVALID');
    }

    if (
        decoded.purpose !== OAUTH_STATE_PURPOSE
        || !decoded.nonce
        || !['login', 'signup'].includes(decoded.intent)
    ) {
        throw new AppError('OAuth state is invalid.', 400, 'OAUTH_STATE_INVALID');
    }

    const expiresAt = typeof decoded.exp === 'number'
        ? decoded.exp * 1000
        : Date.now() + 10 * 60 * 1000;

    try {
        await OAuthStateNonce.create({
            nonce: decoded.nonce,
            expiresAt: new Date(expiresAt),
        });
    } catch (err) {
        if (err?.code === 11000) {
            throw new AppError('OAuth state is invalid.', 400, 'OAUTH_STATE_INVALID');
        }
        throw new AppError('OAuth state could not be verified.', 503, 'OAUTH_STATE_INVALID');
    }

    return {
        nonce: decoded.nonce,
        intent: decoded.intent,
        referralCode: normalizeReferralCode(decoded.referralCode),
    };
};

const clearUsedOAuthStateNoncesForTests = async () => {
    await OAuthStateNonce.deleteMany({});
};

module.exports = {
    createGoogleOAuthState,
    consumeGoogleOAuthState,
    clearUsedOAuthStateNoncesForTests,
};
