'use strict';

const { buildWalletSummary } = require('../shared/utils/walletSummary');

describe('canonical wallet summary', () => {
    test.each([
        ['positive wallet, no credit', { walletBalance: 100, creditLimit: 0 }, {
            walletBalance: 100,
            creditLimit: 0,
            creditUsed: 0,
            availableCredit: 0,
            availableBalance: 100,
            rawAvailableBalance: 100,
        }],
        ['positive wallet with credit', { walletBalance: 100, creditLimit: 50 }, {
            walletBalance: 100,
            creditLimit: 50,
            creditUsed: 0,
            availableCredit: 50,
            availableBalance: 150,
            rawAvailableBalance: 150,
        }],
        ['zero wallet with credit', { walletBalance: 0, creditLimit: 100 }, {
            walletBalance: 0,
            creditLimit: 100,
            creditUsed: 0,
            availableCredit: 100,
            availableBalance: 100,
            rawAvailableBalance: 100,
        }],
        ['partially used credit', { walletBalance: -30, creditLimit: 100 }, {
            walletBalance: -30,
            creditLimit: 100,
            creditUsed: 30,
            availableCredit: 70,
            availableBalance: 70,
            rawAvailableBalance: 70,
        }],
        ['fully used credit', { walletBalance: -100, creditLimit: 100 }, {
            walletBalance: -100,
            creditLimit: 100,
            creditUsed: 100,
            availableCredit: 0,
            availableBalance: 0,
            rawAvailableBalance: 0,
        }],
        ['legacy overdrawn data is clamped externally without mutation', { walletBalance: -120, creditLimit: 100 }, {
            walletBalance: -120,
            creditLimit: 100,
            creditUsed: 100,
            availableCredit: 0,
            availableBalance: 0,
            rawAvailableBalance: -20,
        }],
        ['decimal precision rounds wallet fields half up', { walletBalance: '10.005', creditLimit: '99.999' }, {
            walletBalance: 10.01,
            creditLimit: 100,
            creditUsed: 0,
            availableCredit: 100,
            availableBalance: 110.01,
            rawAvailableBalance: 110.01,
        }],
        ['negative wallet decimal precision', { walletBalance: '-0.10', creditLimit: '0.20' }, {
            walletBalance: -0.1,
            creditLimit: 0.2,
            creditUsed: 0.1,
            availableCredit: 0.1,
            availableBalance: 0.1,
            rawAvailableBalance: 0.1,
        }],
    ])('%s', (_label, input, expected) => {
        expect(buildWalletSummary(input)).toMatchObject(expected);
    });

    it('does not trust a stale supplied creditUsed value', () => {
        expect(buildWalletSummary({
            walletBalance: -30,
            creditLimit: 100,
            creditUsed: 90,
        })).toMatchObject({
            creditUsed: 30,
            availableCredit: 70,
            availableBalance: 70,
        });
    });

    it('normalizes invalid and negative credit limits to zero', () => {
        expect(buildWalletSummary({
            walletBalance: -10,
            creditLimit: -50,
        })).toMatchObject({
            creditLimit: 0,
            creditUsed: 0,
            availableCredit: 0,
            availableBalance: 0,
            rawAvailableBalance: -10,
        });
    });
});
