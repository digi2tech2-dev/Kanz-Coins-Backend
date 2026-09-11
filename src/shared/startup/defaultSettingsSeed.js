'use strict';

const config = require('../../config/config');
const { seedDefaultSettings } = require('../../modules/admin/setting.model');

/**
 * Startup-only seeding. Safe local production mode must not make any implicit
 * writes to a remote database merely by loading the application.
 */
const startDefaultSettingsSeed = ({
    safeLocalProductionMode = config.safeLocalProductionMode,
    seed = seedDefaultSettings,
} = {}) => {
    if (safeLocalProductionMode) return false;

    Promise.resolve(seed()).catch(() => {});
    return true;
};

module.exports = { startDefaultSettingsSeed };
