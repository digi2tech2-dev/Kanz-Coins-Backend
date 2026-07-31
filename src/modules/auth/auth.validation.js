'use strict';

const { body } = require('express-validator');

const registerValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('Name is required')
        .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

    body('email')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('password')
        .notEmpty().withMessage('Password is required')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),

    body('currency')
        .optional()
        .trim()
        .isLength({ min: 3, max: 3 }).withMessage('Currency code must be 3 characters'),

    body('country')
        .optional()
        .trim()
        .isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters'),

    body('phone')
        .optional()
        .trim()
        .isLength({ max: 30 }),

    body('username')
        .optional()
        .trim()
        .isLength({ max: 100 }),

    body(['referralCode', 'refCode', 'ref', 'inviteCode'])
        .optional({ checkFalsy: true })
        .trim()
        .isLength({ min: 6, max: 32 }).withMessage('Invitation code must be between 6 and 32 characters')
        .matches(/^[A-Za-z0-9]+$/).withMessage('Invitation code must contain letters and numbers only'),
];

const loginValidation = [
    body('email')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('password')
        .notEmpty().withMessage('Password is required'),
];

// ─── 2FA Validation ───────────────────────────────────────────────────────────

const enable2FAValidation = [
    body('code')
        .trim()
        .notEmpty().withMessage('2FA code is required')
        .isLength({ min: 6, max: 6 }).withMessage('2FA code must be exactly 6 digits')
        .isNumeric().withMessage('2FA code must contain only digits'),
];

const disable2FAValidation = [
    body('password')
        .optional()
        .isString().withMessage('Password must be a string'),
];

const verify2FAValidation = [
    body('tempToken')
        .notEmpty().withMessage('Temporary token is required')
        .isString().withMessage('Temporary token must be a string'),

    body('code')
        .trim()
        .notEmpty().withMessage('2FA code is required')
        .isLength({ min: 6, max: 6 }).withMessage('2FA code must be exactly 6 digits')
        .isNumeric().withMessage('2FA code must contain only digits'),
];

const completeGoogleProfileValidation = [
    body('completionToken')
        .notEmpty().withMessage('Profile completion token is required')
        .isString().withMessage('Profile completion token must be a string'),

    body('country')
        .trim()
        .notEmpty().withMessage('Country is required')
        .isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters'),

    body('currency')
        .trim()
        .notEmpty().withMessage('Currency is required')
        .isLength({ min: 3, max: 3 }).withMessage('Currency code must be 3 characters'),
];

module.exports = {
    registerValidation,
    loginValidation,
    enable2FAValidation,
    disable2FAValidation,
    verify2FAValidation,
    completeGoogleProfileValidation,
};
