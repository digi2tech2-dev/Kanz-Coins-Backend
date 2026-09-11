'use strict';

class ClientCompatError extends Error {
    constructor(message, code = 500, statusCode = 400) {
        super(message);
        this.name = 'ClientCompatError';
        this.compatCode = code;
        this.statusCode = statusCode;
        this.isOperational = true;
    }
}

const ERROR_CODES = Object.freeze({
    INSUFFICIENT_BALANCE: 100,
    QUANTITY_NOT_AVAILABLE: 105,
    QUANTITY_NOT_ALLOWED: 106,
    PRODUCT_NOT_FOUND: 109,
    PRODUCT_NOT_AVAILABLE: 110,
    RATE_LIMITED: 111,
    QUANTITY_TOO_SMALL: 112,
    QUANTITY_TOO_LARGE: 113,
    ORDER_CREATE_UNKNOWN: 114,
    IP_FORBIDDEN: 123,
    VALIDATION: 124,
    MAINTENANCE: 130,
    INTERNAL: 500,
});

const mapErrorToCompat = (err) => {
    if (err instanceof ClientCompatError) {
        return {
            statusCode: err.statusCode || 400,
            code: err.compatCode || ERROR_CODES.INTERNAL,
            message: err.message || 'Unknown internal error',
        };
    }

    const internalCode = String(err?.code || '').toUpperCase();
    const message = String(err?.message || 'Unknown internal error');

    if (internalCode === 'INSUFFICIENT_FUNDS') {
        return { statusCode: 422, code: ERROR_CODES.INSUFFICIENT_BALANCE, message: 'Insufficient balance' };
    }

    if (internalCode === 'PRODUCT_INACTIVE' || /unavailable/i.test(message)) {
        return { statusCode: 400, code: ERROR_CODES.PRODUCT_NOT_AVAILABLE, message: 'Product not available now' };
    }

    if (internalCode === 'NOT_FOUND' && /product/i.test(message)) {
        return { statusCode: 404, code: ERROR_CODES.PRODUCT_NOT_FOUND, message: 'Product deleted or not found' };
    }

    if (internalCode === 'QUANTITY_OUT_OF_RANGE') {
        return { statusCode: 400, code: ERROR_CODES.QUANTITY_NOT_ALLOWED, message: 'Quantity not allowed' };
    }

    if (internalCode === 'QUANTITY_NOT_AVAILABLE') {
        return { statusCode: 400, code: ERROR_CODES.QUANTITY_NOT_AVAILABLE, message: 'Quantity not available' };
    }

    if (internalCode === 'INVALID_ORDER_FIELDS') {
        return { statusCode: 400, code: ERROR_CODES.VALIDATION, message };
    }

    if (internalCode === 'RATE_LIMIT_EXCEEDED') {
        return { statusCode: 429, code: ERROR_CODES.RATE_LIMITED, message: 'Try again later' };
    }

    return {
        statusCode: err?.statusCode && err.statusCode < 500 ? err.statusCode : 500,
        code: err?.statusCode && err.statusCode < 500 ? ERROR_CODES.ORDER_CREATE_UNKNOWN : ERROR_CODES.INTERNAL,
        message: err?.statusCode && err.statusCode < 500 ? message : 'Unknown internal error',
    };
};

const sendCompatError = (res, err) => {
    const mapped = mapErrorToCompat(err);
    return res.status(mapped.statusCode).json({
        status: 'ERROR',
        code: mapped.code,
        message: mapped.message,
    });
};

const catchCompat = (handler) => async (req, res) => {
    try {
        await handler(req, res);
    } catch (err) {
        sendCompatError(res, err);
    }
};

module.exports = {
    ClientCompatError,
    ERROR_CODES,
    mapErrorToCompat,
    sendCompatError,
    catchCompat,
};
