'use strict';

const { body, param, query } = require('express-validator');
const { PRICING_MODES, MARKUP_TYPES, EXECUTION_TYPES, DYNAMIC_FIELD_TYPES } = require('../products/product.model');
const { isPositive } = require('../../shared/utils/decimalPrecision');

const isPositiveDecimalString = (value) => {
    if (value == null || value === '') return false;
    const n = Number(value);
    if (isNaN(n)) return false;
    return isPositive(value);
};

const emptyStringToZero = (value) => (value === '' ? 0 : value);

const validateDynamicFields = (fields = []) => {
    if (!Array.isArray(fields)) return true;

    const names = new Set();
    for (const field of fields) {
        if (!field || typeof field !== 'object') {
            throw new Error('Each dynamicFields item must be an object');
        }
        const normalizedName = String(field.name || '').trim().toLowerCase();
        if (!normalizedName) {
            throw new Error('dynamicFields[].name is required');
        }
        if (names.has(normalizedName)) {
            throw new Error('dynamicFields names must be unique');
        }
        names.add(normalizedName);
    }

    return true;
};

// ─── Provider CRUD ────────────────────────────────────────────────────────────

const createProviderValidation = [
    body('name')
        .notEmpty().withMessage('name is required')
        .isString().trim()
        .isLength({ min: 2, max: 100 }).withMessage('name must be 2–100 characters'),

    body('slug')
        .optional()
        .isString().trim().toLowerCase()
        .matches(/^[a-z0-9-]+$/).withMessage('slug must be lowercase alphanumeric with hyphens'),

    body('adapterType')
        .optional({ nullable: true })
        .isString().trim().toLowerCase()
        .isLength({ max: 64 }),

    body('baseUrl')
        .notEmpty().withMessage('baseUrl is required')
        .isURL().withMessage('baseUrl must be a valid URL'),

    body('apiToken')
        .optional({ nullable: true })
        .isString().trim(),

    body('apiKey')
        .optional({ nullable: true })
        .isString().trim(),

    body('syncInterval')
        .optional()
        .isInt({ min: 0 }).withMessage('syncInterval must be a non-negative integer'),

    body('isActive')
        .optional()
        .isBoolean().withMessage('isActive must be a boolean'),

    body('supportedFeatures')
        .optional()
        .isArray().withMessage('supportedFeatures must be an array'),
];

const updateProviderValidation = [
    param('id').isMongoId().withMessage('Invalid provider ID'),

    body('name')
        .optional().isString().trim().isLength({ min: 2, max: 100 }),

    body('slug')
        .optional()
        .isString().trim().toLowerCase()
        .matches(/^[a-z0-9-]+$/).withMessage('slug must be lowercase alphanumeric with hyphens'),

    body('adapterType')
        .optional({ nullable: true })
        .isString().trim().toLowerCase()
        .isLength({ max: 64 }),

    body('baseUrl')
        .optional().isURL(),

    body('apiToken')
        .optional({ nullable: true }).isString(),

    body('apiKey')
        .optional({ nullable: true }).isString(),

    body('syncInterval')
        .optional().isInt({ min: 0 }),

    body('isActive')
        .optional().isBoolean(),

    body('supportedFeatures')
        .optional().isArray(),
];

const providerIdParamValidation = [
    param('id').isMongoId().withMessage('Invalid provider ID'),
];

// ─── Provider Products (raw) ──────────────────────────────────────────────────

const providerProductListValidation = [
    param('id').isMongoId().withMessage('Invalid provider ID'),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('includeInactive').optional().isBoolean(),
    query('search').optional().isString().trim(),
];

const setTranslatedNameValidation = [
    param('id').isMongoId().withMessage('Invalid provider ID'),
    param('productId').isMongoId().withMessage('Invalid ProviderProduct ID'),
    body('translatedName')
        .optional({ nullable: true })
        .isString().trim()
        .isLength({ max: 200 }).withMessage('translatedName cannot exceed 200 characters'),
];

// ─── Platform Products (publish / update) ────────────────────────────────────

const publishProductValidation = [
    body('providerProductId')
        .notEmpty().withMessage('providerProductId is required')
        .isMongoId().withMessage('Invalid providerProductId'),

    body('name')
        .notEmpty().withMessage('name is required')
        .isString().trim()
        .isLength({ min: 2, max: 200 }),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .optional({ nullable: true })
        .custom((v) => v == null || isPositiveDecimalString(v)).withMessage('basePrice must be > 0'),

    body('costPrice')
        .customSanitizer(emptyStringToZero)
        .optional()
        .isFloat({ min: 0 }).withMessage('costPrice must be >= 0'),

    body('minQty')
        .optional()
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .optional()
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1'),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isString().withMessage('image must be a string'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean(),

    body('pricingMode')
        .optional()
        .isIn(Object.values(PRICING_MODES))
        .withMessage(`pricingMode must be one of: ${Object.values(PRICING_MODES).join(', ')}`),

    body('markupType')
        .optional()
        .isIn(Object.values(MARKUP_TYPES))
        .withMessage(`markupType must be one of: ${Object.values(MARKUP_TYPES).join(', ')}`),

    body('markupValue')
        .optional()
        .isFloat({ min: 0 }).withMessage('markupValue must be >= 0'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),

    body('dynamicFields')
        .optional()
        .isArray().withMessage('dynamicFields must be an array')
        .custom(validateDynamicFields),

    body('dynamicFields.*.name')
        .optional()
        .isString().withMessage('dynamicFields[].name must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].name is required'),

    body('dynamicFields.*.label')
        .optional()
        .isString().withMessage('dynamicFields[].label must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].label is required'),

    body('dynamicFields.*.type')
        .optional()
        .isIn(DYNAMIC_FIELD_TYPES)
        .withMessage(`dynamicFields[].type must be one of: ${DYNAMIC_FIELD_TYPES.join(', ')}`),

    body('dynamicFields.*.required')
        .optional()
        .isBoolean().withMessage('dynamicFields[].required must be a boolean'),
];

const updatePublishedProductValidation = [
    param('productId').isMongoId().withMessage('Invalid product ID'),

    body('name').optional().isString().trim().isLength({ min: 2, max: 200 }),
    body('description').optional({ nullable: true }).isString().trim(),
    body('basePrice').optional().custom((v) => v == null || isPositiveDecimalString(v)),
    body('costPrice')
        .customSanitizer(emptyStringToZero)
        .optional()
        .isFloat({ min: 0 }).withMessage('costPrice must be >= 0'),
    body('minQty').optional().isInt({ min: 1 }),
    body('maxQty').optional().isInt({ min: 1 }),
    body('category').optional({ nullable: true }).isString().trim(),
    body('image').optional({ nullable: true }).isString(),
    body('displayOrder').optional().isInt(),
    body('isActive').optional().isBoolean(),
    body('pricingMode').optional().isIn(Object.values(PRICING_MODES)),
    body('markupType').optional().isIn(Object.values(MARKUP_TYPES)),
    body('markupValue').optional().isFloat({ min: 0 }),
    body('executionType').optional().isIn(Object.values(EXECUTION_TYPES)),
    body('dynamicFields')
        .optional()
        .isArray().withMessage('dynamicFields must be an array')
        .custom(validateDynamicFields),
    body('dynamicFields.*.name')
        .optional()
        .isString().withMessage('dynamicFields[].name must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].name is required'),
    body('dynamicFields.*.label')
        .optional()
        .isString().withMessage('dynamicFields[].label must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].label is required'),
    body('dynamicFields.*.type')
        .optional()
        .isIn(DYNAMIC_FIELD_TYPES)
        .withMessage(`dynamicFields[].type must be one of: ${DYNAMIC_FIELD_TYPES.join(', ')}`),
    body('dynamicFields.*.required')
        .optional()
        .isBoolean().withMessage('dynamicFields[].required must be a boolean'),
];

module.exports = {
    createProviderValidation,
    updateProviderValidation,
    providerIdParamValidation,
    providerProductListValidation,
    setTranslatedNameValidation,
    publishProductValidation,
    updatePublishedProductValidation,
};
