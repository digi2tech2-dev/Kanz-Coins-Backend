'use strict';

const { body } = require('express-validator');

const updateUserValidation = [
    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

    body('groupId')
        .optional({ nullable: true })
        .custom((value) => {
            if (value === null) return true;
            const mongoose = require('mongoose');
            if (!mongoose.Types.ObjectId.isValid(value)) {
                throw new Error('Invalid group ID format');
            }
            return true;
        }),

    body('creditLimit')
        .optional()
        .isFloat({ min: 0 }).withMessage('Credit limit must be a non-negative number'),

    body('isActive')
        .optional()
        .isBoolean().withMessage('isActive must be a boolean'),
];

const updateMyProfileValidation = [
    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

    body('email')
        .optional()
        .trim()
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('phone')
        .optional()
        .trim()
        .isLength({ max: 30 }),

    body('username')
        .optional()
        .trim()
        .isLength({ max: 100 }),

    body('password')
        .optional()
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),

    body('country')
        .optional({ nullable: true })
        .trim()
        .isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters'),

    body('currency')
        .optional({ nullable: true })
        .trim()
        .isLength({ min: 3, max: 3 }).withMessage('Currency code must be 3 characters'),

    body(['referralCode', 'refCode', 'ref', 'inviteCode'])
        .optional({ checkFalsy: true })
        .trim()
        .isLength({ min: 6, max: 32 }).withMessage('Invitation code must be between 6 and 32 characters')
        .matches(/^[A-Za-z0-9]+$/).withMessage('Invitation code must contain letters and numbers only'),
];

module.exports = { updateUserValidation, updateMyProfileValidation };
