'use strict';

const { body, query, param } = require('express-validator');
const { DEPOSIT_STATUS } = require('./deposit.model');

/**
 * POST /api/deposits — Customer submits a new deposit request.
 *
 * The receipt file is handled by multer middleware (not express-validator).
 * These validations cover the text fields sent alongside the file.
 */
const createDepositValidation = [
    body('requestedAmount')
        .notEmpty().withMessage('requestedAmount is required')
        .isFloat({ gt: 0 }).withMessage('requestedAmount must be a positive number'),

    body('currency')
        .notEmpty().withMessage('currency is required')
        .isString().withMessage('currency must be a string')
        .trim()
        .isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter ISO 4217 code')
        .toUpperCase(),

    body('paymentMethodId')
        .notEmpty().withMessage('paymentMethodId is required')
        .isString().withMessage('paymentMethodId must be a string')
        .trim(),

    body('notes')
        .optional()
        .isString().withMessage('notes must be a string')
        .trim()
        .isLength({ max: 500 }).withMessage('notes cannot exceed 500 characters'),

    body('senderDetails')
        .optional()
        .custom((value) => typeof value === 'string' || (value && typeof value === 'object'))
        .withMessage('senderDetails must be an object or JSON string'),

    body('senderWalletNumber')
        .optional()
        .isString().withMessage('senderWalletNumber must be a string')
        .trim()
        .isLength({ max: 200 }).withMessage('senderWalletNumber cannot exceed 200 characters'),

    body('senderWalletAddress')
        .optional()
        .isString().withMessage('senderWalletAddress must be a string')
        .trim()
        .isLength({ max: 200 }).withMessage('senderWalletAddress cannot exceed 200 characters'),

    body('transferredFromNumber')
        .optional()
        .isString().withMessage('transferredFromNumber must be a string')
        .trim()
        .isLength({ max: 200 }).withMessage('transferredFromNumber cannot exceed 200 characters'),

    body('transactionId')
        .optional()
        .isString().withMessage('transactionId must be a string')
        .trim()
        .isLength({ max: 64 }).withMessage('transactionId cannot exceed 64 characters'),

    body('transactionNumber')
        .optional()
        .isString().withMessage('transactionNumber must be a string')
        .trim()
        .isLength({ max: 64 }).withMessage('transactionNumber cannot exceed 64 characters'),

    body('paymentReference')
        .optional()
        .isString().withMessage('paymentReference must be a string')
        .trim()
        .isLength({ max: 64 }).withMessage('paymentReference cannot exceed 64 characters'),
];

/**
 * PATCH /api/deposits/:id/approve
 */
const approveDepositValidation = [
    param('id')
        .isMongoId().withMessage('Invalid deposit request ID'),
];

/**
 * PATCH /api/deposits/:id/reject
 */
const rejectDepositValidation = [
    param('id')
        .isMongoId().withMessage('Invalid deposit request ID'),

    body('adminNotes')
        .optional()
        .isString().withMessage('adminNotes must be a string')
        .trim()
        .isLength({ max: 500 }).withMessage('adminNotes cannot exceed 500 characters'),
];

/**
 * GET /api/deposits — List with optional filters.
 */
const listDepositsValidation = [
    query('status')
        .optional()
        .isIn(Object.values(DEPOSIT_STATUS))
        .withMessage(`status must be one of: ${Object.values(DEPOSIT_STATUS).join(', ')}`),

    query('page')
        .optional()
        .isInt({ min: 1 }).withMessage('page must be a positive integer'),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
];

module.exports = {
    createDepositValidation,
    approveDepositValidation,
    rejectDepositValidation,
    listDepositsValidation,
};
