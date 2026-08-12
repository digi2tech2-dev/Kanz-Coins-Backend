'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config/config');
const { Currency } = require('../modules/currency/currency.model');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const { PaymentEvent, PAYMENT_EVENT_MATCH_STATUS } = require('../modules/paymentEvents/paymentEvent.model');
const paymentEventService = require('../modules/paymentEvents/paymentEvent.service');
const { classifyAndParseSms } = require('../modules/paymentEvents/vodafoneSms.parser');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

const SECRET = 'test-vodafone-sms-secret';
const DEVICE_ID = 'kanz-vf-01';

const sign = (rawBody) => crypto
    .createHmac('sha256', SECRET)
    .update(rawBody)
    .digest('hex');

const headersFor = (rawBody, overrides = {}) => ({
    'x-bridge-id': DEVICE_ID,
    'x-signature': sign(rawBody),
    ...overrides,
});

const postSms = (payload, overrides = {}) => {
    const rawBody = Buffer.from(
        overrides.rawJson || JSON.stringify(payload),
        'utf8'
    );
    return paymentEventService.processVodafoneCashWebhook({
        headers: headersFor(rawBody, overrides.headers || {}),
        rawBody,
    });
};

const vodafoneText = ({
    amount = '500',
    phone = '01012572681',
    transactionId = '022494991382',
} = {}) =>
    `تم استلام مبلغ ${amount} جنيه من رقم ${phone} تاريخ العملية: 01/01/2026 رقم العملية: ${transactionId}`;

const instapayText = ({
    amount = '200',
    phone = '00201140058636',
    transactionId = '019184724786',
} = {}) =>
    `Received EGP${amount} from ${phone} to Mobile Account Number 7991. Ref: ${transactionId} Available Balance: EGP1000`;

const payloadFor = (text, receivedStamp = 1770000000000) => ({
    from: 'VF-Cash',
    text,
    sentStamp: receivedStamp - 1000,
    receivedStamp,
    sim: '0',
    version: 'x',
    battery: 80,
    network: 'wifi',
});

const createVodafoneDeposit = async ({
    userId,
    amount = 500,
    transactionId = '022494991382',
    phone = '01012572681',
    paymentMethodId = 'vodafone',
} = {}) => depositService.createDepositRequest({
    userId,
    paymentMethodId,
    requestedAmount: amount,
    currency: 'EGP',
    exchangeRate: 1,
    amountUsd: amount,
    receiptImage: 'uploads/deposits/receipt.jpg',
    senderDetails: {
        methodType: 'mobile_wallet',
        field: 'senderWalletNumber',
        label: 'Sender wallet',
        value: phone,
        transactionNumber: transactionId,
    },
    paymentTransactionId: transactionId,
});

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    config.vodafoneSmsBridge.enabled = true;
    config.vodafoneSmsBridge.hmacSecret = SECRET;
    config.vodafoneSmsBridge.deviceId = DEVICE_ID;
    config.vodafoneSmsBridge.autoApprove = false;
    config.vodafoneSmsBridge.instapayAutoApprove = false;
    config.vodafoneSmsBridge.maxEventAgeMinutes = 1440;
    await Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'EGP', platformRate: 1, isActive: true });
});

describe('Vodafone SMS bridge security', () => {
    test('missing HMAC is rejected', async () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor(vodafoneText())));
        await expect(paymentEventService.processVodafoneCashWebhook({
            headers: { 'x-bridge-id': DEVICE_ID },
            rawBody,
        })).rejects.toMatchObject({ code: 'SMS_SIGNATURE_REQUIRED' });
    });

    test('invalid HMAC is rejected', async () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor(vodafoneText())));
        await expect(paymentEventService.processVodafoneCashWebhook({
            headers: { 'x-bridge-id': DEVICE_ID, 'x-signature': 'a'.repeat(64) },
            rawBody,
        })).rejects.toMatchObject({ code: 'SMS_SIGNATURE_INVALID' });
    });

    test('wrong bridge ID is rejected', async () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor(vodafoneText())));
        await expect(paymentEventService.processVodafoneCashWebhook({
            headers: headersFor(rawBody, { 'x-bridge-id': 'wrong-device' }),
            rawBody,
        })).rejects.toMatchObject({ code: 'SMS_BRIDGE_ID_INVALID' });
    });

    test('valid HMAC over raw body is accepted', async () => {
        const result = await postSms(payloadFor(vodafoneText()));
        expect(result.success).toBe(true);
        expect(result.parsed).toBe(true);
    });

    test('HMAC uses raw body bytes rather than reconstructed JSON', async () => {
        const rawJson = `{
  "from": "VF-Cash",
  "text": "${vodafoneText()}",
  "sentStamp": 1770000000000,
  "receivedStamp": 1770000001000
}`;
        const result = await postSms(null, { rawJson });
        expect(result.success).toBe(true);
        expect(result.parsed).toBe(true);
    });

    test('disabled bridge rejects safely', async () => {
        config.vodafoneSmsBridge.enabled = false;
        const rawBody = Buffer.from(JSON.stringify(payloadFor(vodafoneText())));
        await expect(paymentEventService.processVodafoneCashWebhook({
            headers: headersFor(rawBody),
            rawBody,
        })).rejects.toMatchObject({ code: 'SMS_BRIDGE_DISABLED' });
    });
});

describe('Vodafone SMS bridge parsing', () => {
    test('parses Arabic Vodafone wallet incoming transfer and preserves leading zero transaction ID', () => {
        const parsed = classifyAndParseSms(vodafoneText());
        expect(parsed.sourceType).toBe('VODAFONE_WALLET');
        expect(parsed.amountText).toBe('500.00');
        expect(parsed.senderPhone).toBe('01012572681');
        expect(parsed.transactionId).toBe('022494991382');
    });

    test('parses InstaPay incoming transfer', () => {
        const parsed = classifyAndParseSms(instapayText());
        expect(parsed.sourceType).toBe('INSTAPAY');
        expect(parsed.amountText).toBe('200.00');
        expect(parsed.senderPhone).toBe('01140058636');
        expect(parsed.transactionId).toBe('019184724786');
    });

    test.each([
        'عرض خاص من فودافون كاش',
        'Transaction failed. Please try again.',
        'Available Balance: EGP 1000',
        'تم دفع فاتورة الكهرباء بنجاح',
        'تم شحن كارت بقيمة 50 جنيه',
    ])('does not parse non-deposit SMS: %s', (text) => {
        const parsed = classifyAndParseSms(text);
        expect(parsed.parseStatus).not.toBe('PARSED');
    });
});

describe('Vodafone SMS bridge idempotency and matching', () => {
    let customer;

    beforeEach(async () => {
        const group = await createGroup({ percentage: 0 });
        customer = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'EGP' });
    });

    test('exact amount, transaction ID, and phone matches a pending deposit without approval in observe mode', async () => {
        const deposit = await createVodafoneDeposit({ userId: customer._id });

        const result = await postSms(payloadFor(vodafoneText()));
        const event = await PaymentEvent.findOne({ transactionId: '022494991382' });
        const freshDeposit = await DepositRequest.findById(deposit._id);
        const freshUser = await User.findById(customer._id);

        expect(result.matched).toBe(true);
        expect(result.autoApproved).toBe(false);
        expect(event.matchStatus).toBe(PAYMENT_EVENT_MATCH_STATUS.MATCHED);
        expect(event.matchedDepositId.toString()).toBe(deposit._id.toString());
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    test('same SMS delivered repeatedly creates one PaymentEvent record', async () => {
        const payload = payloadFor(vodafoneText());
        const first = await postSms(payload);
        const second = await postSms(payload);

        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        expect(await PaymentEvent.countDocuments()).toBe(1);
    });

    test('correct amount with wrong transaction ID remains unmatched', async () => {
        await createVodafoneDeposit({ userId: customer._id, transactionId: '022494991382' });
        const result = await postSms(payloadFor(vodafoneText({ transactionId: '022494991383' })));
        expect(result.matchStatus).toBe(PAYMENT_EVENT_MATCH_STATUS.UNMATCHED);
    });

    test('correct transaction ID with wrong amount is a mismatch', async () => {
        await createVodafoneDeposit({ userId: customer._id, amount: 500 });
        const result = await postSms(payloadFor(vodafoneText({ amount: '600' })));
        expect(result.matchStatus).toBe(PAYMENT_EVENT_MATCH_STATUS.MISMATCH);
    });

    test('no pending deposit remains unmatched', async () => {
        const result = await postSms(payloadFor(vodafoneText()));
        expect(result.matchStatus).toBe(PAYMENT_EVENT_MATCH_STATUS.UNMATCHED);
    });

    test('SMS first can match a later deposit', async () => {
        await postSms(payloadFor(vodafoneText()));
        const deposit = await createVodafoneDeposit({ userId: customer._id });

        await paymentEventService.matchExistingUnmatchedPaymentForDeposit(deposit._id);
        const event = await PaymentEvent.findOne({ transactionId: '022494991382' });

        expect(event.matchStatus).toBe(PAYMENT_EVENT_MATCH_STATUS.MATCHED);
        expect(event.matchedDepositId.toString()).toBe(deposit._id.toString());
    });

    test('multiple matching candidates are ambiguous', async () => {
        const other = await createCustomer({
            groupId: customer.groupId,
            walletBalance: 0,
            currency: 'EGP',
            email: `other-${Date.now()}@test.com`,
        });
        await createVodafoneDeposit({ userId: customer._id });
        await createVodafoneDeposit({ userId: other._id });

        const result = await postSms(payloadFor(vodafoneText()));
        expect(result.matchStatus).toBe(PAYMENT_EVENT_MATCH_STATUS.AMBIGUOUS);
    });
});

describe('Vodafone SMS bridge auto approval guardrails', () => {
    test('auto approval enabled calls canonical approval once for exact Vodafone wallet match', async () => {
        config.vodafoneSmsBridge.autoApprove = true;
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'EGP' });
        const deposit = await createVodafoneDeposit({ userId: customer._id });
        const payload = payloadFor(vodafoneText(), Date.now());

        const first = await postSms(payload);
        const second = await postSms(payload);

        const freshDeposit = await DepositRequest.findById(deposit._id);
        const freshUser = await User.findById(customer._id);
        const ledgerCount = await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' });

        expect(first.autoApproved).toBe(true);
        expect(second.duplicate).toBe(true);
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshDeposit.reviewSource).toBe('VODAFONE_SMS_AUTO');
        expect(freshUser.walletBalance).toBe(500);
        expect(ledgerCount).toBe(1);
    });
});
