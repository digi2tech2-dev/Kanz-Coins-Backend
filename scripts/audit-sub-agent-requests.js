'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../src/config/config');
const { auditSubAgentRequestIndexes } = require('../src/modules/subAgentRequests/subAgentRequest.service');
require('../src/modules/subAgentRequests/subAgentRequest.model');

const main = async () => {
    await mongoose.connect(config.db.uri);
    const result = await auditSubAgentRequestIndexes();

    console.log('Sub-agent request index audit');
    console.log(`Duplicate pending user groups: ${result.duplicatePendingUserGroups}`);

    if (result.duplicatePendingUserGroups > 0) {
        process.exitCode = 1;
    }
};

main()
    .catch((err) => {
        console.error('Sub-agent request audit failed:', err.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
