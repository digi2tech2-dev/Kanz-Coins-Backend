'use strict';

/**
 * Centralized application configuration.
 * All environment variable access should go through this file.
 */
const parseBoolean = (value, defaultValue = false) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const parseNumber = (value, defaultValue) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : defaultValue;
};

const DEFAULT_RECEIPT_OCR_KEYWORDS = [
    'تم',
    'نجاح',
    'فودافون',
    'vodafone',
    'cash',
    'كاش',
    'تحويل',
];

const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,

    db: {
        uri: process.env.MONGO_URI,
    },

    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },

    bcrypt: {
        rounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    },

    // ── Google OAuth ────────────────────────────────────────────────────────────
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: process.env.GOOGLE_CALLBACK_URL ||
            `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`,
    },

    // ── Email / SMTP ────────────────────────────────────────────────────────────
    email: {
        host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.EMAIL_FROM || 'noreply@platform.com',
        // Base URL for verification links (server-side)
        appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`,
    },

    // ── Frontend ────────────────────────────────────────────────────────────────
    frontend: {
        url: process.env.FRONTEND_URL || 'http://localhost:3000',
        verifyRedirectUrl: process.env.FRONTEND_VERIFY_REDIRECT_URL ||
            `${process.env.FRONTEND_URL || 'http://localhost:3000'}/email-verified`,
    },

    // ── CORS ────────────────────────────────────────────────────────────────────
    cors: {
        allowedOrigins: process.env.ALLOWED_ORIGINS || 'http://localhost:3000',
    },

    // ── Receipt Analyzer (anti-fraud checks for deposit receipts) ──────────────
    receiptAnalyzer: {
        enableOcr: parseBoolean(process.env.RECEIPT_ANALYZER_ENABLE_OCR, false),
        minEntropy: parseNumber(process.env.RECEIPT_ANALYZER_MIN_ENTROPY, 1.0),
        blackMeanMax: parseNumber(process.env.RECEIPT_ANALYZER_BLACK_MEAN_MAX, 8),
        whiteMeanMin: parseNumber(process.env.RECEIPT_ANALYZER_WHITE_MEAN_MIN, 247),
        solidStdDevMax: parseNumber(process.env.RECEIPT_ANALYZER_SOLID_STDDEV_MAX, 2.5),
        lowEntropyStdDevMax: parseNumber(process.env.RECEIPT_ANALYZER_LOW_ENTROPY_STDDEV_MAX, 3.2),
        maxInputPixels: parseNumber(process.env.RECEIPT_ANALYZER_MAX_INPUT_PIXELS, 40_000_000),
        ocrTimeoutMs: parseNumber(process.env.RECEIPT_ANALYZER_OCR_TIMEOUT_MS, 3500),
        ocrResizeWidth: parseNumber(process.env.RECEIPT_ANALYZER_OCR_RESIZE_WIDTH, 1200),
        ocrMinKeywordMatches: parseNumber(process.env.RECEIPT_ANALYZER_OCR_MIN_KEYWORD_MATCHES, 1),
        ocrKeywords: String(process.env.RECEIPT_ANALYZER_OCR_KEYWORDS || '')
            .split(',')
            .map((keyword) => keyword.trim())
            .filter(Boolean)
            .length
            ? String(process.env.RECEIPT_ANALYZER_OCR_KEYWORDS || '')
                .split(',')
                .map((keyword) => keyword.trim())
                .filter(Boolean)
            : DEFAULT_RECEIPT_OCR_KEYWORDS,
    },

    vodafoneSmsBridge: {
        enabled: parseBoolean(process.env.VODAFONE_SMS_BRIDGE_ENABLED, false),
        hmacSecret: process.env.VODAFONE_SMS_HMAC_SECRET || '',
        autoApprove: parseBoolean(process.env.VODAFONE_SMS_AUTO_APPROVE, false),
        instapayAutoApprove: parseBoolean(process.env.VODAFONE_SMS_INSTAPAY_AUTO_APPROVE, false),
        deviceId: process.env.VODAFONE_SMS_DEVICE_ID || 'kanz-vf-01',
        maxEventAgeMinutes: parseNumber(process.env.VODAFONE_SMS_MAX_EVENT_AGE_MINUTES, 1440),
    },
};

// Guard: fail fast if critical configs are missing
const required = ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = config;
