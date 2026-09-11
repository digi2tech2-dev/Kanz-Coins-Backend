'use strict';

const { Setting } = require('../admin/setting.model');
const { ERROR_CODES } = require('./clientCompat.errors');

/**
 * The existing maintenanceMode setting explicitly describes blocking new
 * orders. Apply it only to compatibility order-creation routes so profile,
 * catalogue and order-status access remain available during maintenance.
 */
const requireCompatOrderingAvailable = async (_req, res, next) => {
    try {
        const maintenance = await Setting.findOne({ key: 'maintenanceMode' })
            .select('value')
            .lean();

        if (maintenance?.value === true) {
            return res.status(503).json({
                status: 'ERROR',
                code: 130,
                message: 'Site is under maintenance',
            });
        }

        return next();
    } catch (err) {
        return res.status(500).json({
            status: 'ERROR',
            code: ERROR_CODES.INTERNAL,
            message: 'Unknown internal error',
        });
    }
};

module.exports = { requireCompatOrderingAvailable };
