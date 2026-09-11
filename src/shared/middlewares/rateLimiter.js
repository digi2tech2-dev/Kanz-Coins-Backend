'use strict';

/**
 * Rate Limiting Middleware
 *
 * Provides two pre-configured limiters:
 *
 * 1. apiLimiter     — general protection for all /api routes
 *                      500 requests per 15-minute window per IP
 *
 * 2. authLimiter    — strict limiter for sensitive endpoints
 *                      (login, register, password reset, resend-verification)
 *                      10 requests per 15-minute window per IP
 *
 * Both return standard JSON responses that match the project's error format.
 */

const rateLimit = require('express-rate-limit');

// ── General API Rate Limiter ──────────────────────────────────────────────────

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutes
    max: 1000,                     // 500 requests per window per IP
    standardHeaders: true,        // Return rate limit info in RateLimit-* headers
    legacyHeaders: false,         // Disable X-RateLimit-* headers
    message: {
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests from this IP. Please try again after 15 minutes.',
    },
});

// Compatibility clients use a numeric error contract. Keep the same limits and
// headers as the general API limiter, but return their documented response shape.
const compatRateLimitHandler = (_req, res) => res.status(429).json({
    status: 'ERROR',
    code: 111,
    message: 'Try again later',
});

const compatApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    handler: compatRateLimitHandler,
});

// ── Strict Auth Rate Limiter ──────────────────────────────────────────────────

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutes
    max: 10,                      // 10 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'AUTH_RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts. Please try again after 15 minutes.',
    },
});

// ── Wallet Mutation Rate Limiter ──────────────────────────────────────────────

const walletLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutes
    max: 20,                      // 20 wallet mutations per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'WALLET_RATE_LIMIT_EXCEEDED',
        message: 'Too many wallet operations. Please try again after 15 minutes.',
    },
});

module.exports = { apiLimiter, compatApiLimiter, compatRateLimitHandler, authLimiter, walletLimiter };
