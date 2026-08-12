'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const paymentEventService = require('./paymentEvent.service');

const receiveVodafoneCashSms = catchAsync(async (req, res) => {
    const result = await paymentEventService.processVodafoneCashWebhook({
        headers: req.headers,
        rawBody: req.body,
    });

    sendSuccess(res, result, 'Vodafone Cash SMS event received.');
});

module.exports = {
    receiveVodafoneCashSms,
};
