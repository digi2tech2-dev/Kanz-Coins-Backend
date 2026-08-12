'use strict';

const express = require('express');
const paymentEventController = require('./paymentEvent.controller');

const router = express.Router();

router.post(
    '/vodafone-cash',
    express.raw({ type: 'application/json', limit: '128kb' }),
    paymentEventController.receiveVodafoneCashSms
);

module.exports = router;
