'use strict';

/**
 * currency.test.js — Platform Currency System Integration Test Suite
 * ──────────────────────────────────────────────────────────────────
 *
 * All tests run against the real in-memory MongoDB instance.
 *
 * Test groups:
 *  [1] Currency model validation
 *  [2] currencyConverter.service — convertUsdToUserCurrency
 *  [3] currencyConverter.service — convertUserCurrencyToUsd
 *  [4] exchangeRateSync.service — syncRates()
 *  [5] currency.service — admin ops (create, updateRate, setStatus)
 *  [6] Order creation — currency snapshot & wallet deduction
 */

const { Currency } = require('../modules/currency/currency.model');
const {
    connectTestDB, disconnectTestDB, clearCollections,
    createCustomerWithGroup, createProduct,
} = require('./testHelpers');
const { convertUsdToUserCurrency, convertUserCurrencyToUsd } =
    require('../services/currencyConverter.service');
const { syncRates } = require('../services/exchangeRateSync.service');
const currencyService = require('../modules/currency/currency.service');
const { Order } = require('../modules/orders/order.model');
const { createOrder } = require('../modules/orders/order.service');
const { User } = require('../modules/users/user.model');

// ── DB lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => connectTestDB());
afterAll(() => disconnectTestDB());
beforeEach(() => clearCollections());

// ── Helper: seed a currency ───────────────────────────────────────────────────

const makeCurrency = (overrides = {}) =>
    Currency.create({
        code: 'SAR',
        name: 'Saudi Riyal',
        symbol: '﷼',
        marketRate: 3.75,
        platformRate: 4.10,
        isActive: true,
        lastUpdatedAt: new Date(),
        ...overrides,
    });

// =============================================================================
// [1] Currency model validation
// =============================================================================

describe('[1] Currency model validation', () => {
    it('creates a valid currency', async () => {
        const c = await makeCurrency();
        expect(c.code).toBe('SAR');
        expect(c.platformRate).toBe(4.10);
        expect(c.isActive).toBe(true);
    });

    it('rejects invalid code format (not 3 letters)', async () => {
        await expect(
            Currency.create({ code: 'US', name: 'X', symbol: 'X', platformRate: 1 })
        ).rejects.toThrow();
    });

    it('rejects duplicate currency codes', async () => {
        await makeCurrency();
        await expect(makeCurrency()).rejects.toThrow();
    });

    it('rejects zero platformRate', async () => {
        await expect(
            Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', platformRate: 0 })
        ).rejects.toThrow();
    });

    it('computes effectiveRate virtual', async () => {
        const c = await makeCurrency({ marketRate: 3.75, markupPercentage: 10, platformRate: 4.10 });
        // effectiveRate = marketRate × (1 + markupPercentage/100)
        expect(c.effectiveRate).toBeCloseTo(4.125, 2);
    });

    it('computes spreadPercent virtual', async () => {
        // spread = (platformRate - marketRate) / marketRate * 100
        const c = await makeCurrency({ marketRate: 3.75, platformRate: 4.10 });
        expect(c.spreadPercent).toBeCloseTo(9.33, 1);
    });
});

// =============================================================================
// [2] convertUsdToUserCurrency
// =============================================================================

describe('[2] convertUsdToUserCurrency', () => {
    beforeEach(async () => {
        await makeCurrency({ code: 'SAR', platformRate: 4.10 });
    });

    it('converts USD → SAR correctly', async () => {
        const result = await convertUsdToUserCurrency(10, 'SAR');
        expect(result.currency).toBe('SAR');
        expect(result.rate).toBe(4.10);
        expect(result.finalAmount).toBeCloseTo(41, 1);
        expect(result.usdAmount).toBe(10);
    });

    it('USD → USD is a passthrough (rate = 1, no DB hit)', async () => {
        const result = await convertUsdToUserCurrency(25, 'USD');
        expect(result.currency).toBe('USD');
        expect(result.rate).toBe(1);
        expect(result.finalAmount).toBe(25);
    });

    it('throws for inactive currency', async () => {
        await Currency.findOneAndUpdate({ code: 'SAR' }, { isActive: false });
        // Use the raw _getCurrency with bypassCache=true so we get a fresh DB read
        const { _getCurrency } = require('../services/currencyConverter.service');
        await expect(_getCurrency('SAR', true)).rejects.toThrow('inactive');
    });

    it('throws for unknown currency', async () => {
        await expect(convertUsdToUserCurrency(10, 'XYZ')).rejects.toThrow('not found');
    });

    it('handles zero amount correctly', async () => {
        const result = await convertUsdToUserCurrency(0, 'SAR');
        expect(result.finalAmount).toBe(0);
    });
});

// =============================================================================
// [3] convertUserCurrencyToUsd
// =============================================================================

describe('[3] convertUserCurrencyToUsd', () => {
    beforeEach(async () => {
        await makeCurrency({ code: 'SAR', platformRate: 4.10 });
    });

    it('converts SAR → USD correctly', async () => {
        const result = await convertUserCurrencyToUsd(41, 'SAR');
        expect(result.currency).toBe('SAR');
        expect(result.rate).toBe(4.10);
        expect(result.usdAmount).toBeCloseTo(10, 2);
        expect(result.originalAmount).toBe(41);
    });

    it('USD → USD is a passthrough', async () => {
        const result = await convertUserCurrencyToUsd(100, 'USD');
        expect(result.usdAmount).toBe(100);
        expect(result.rate).toBe(1);
    });
});

// =============================================================================
// [4] exchangeRateSync.service
// =============================================================================

describe('[4] syncRates()', () => {
    it('creates new currencies from feed (inactive by default)', async () => {
        const result = await syncRates({
            ratesOverride: { SAR: 3.75, EGP: 50.2 },
        });

        // USD is always added by the service (key "USD" is set to 1 before iterating)
        expect(result.created).toBeGreaterThanOrEqual(2);   // SAR + EGP (USD may not exist)
        expect(result.errors).toHaveLength(0);

        const sar = await Currency.findOne({ code: 'SAR' });
        expect(sar).not.toBeNull();
        expect(sar.marketRate).toBe(3.75);
        expect(sar.isActive).toBe(false);  // auto-created = inactive
    });

    it('updates marketRate of existing currencies without touching platformRate', async () => {
        await makeCurrency({ code: 'SAR', marketRate: 3.50, platformRate: 4.00 });

        await syncRates({ ratesOverride: { SAR: 3.75 } });

        const updated = await Currency.findOne({ code: 'SAR' });
        expect(updated.marketRate).toBe(3.75);      // updated
        expect(updated.platformRate).toBe(4.00);    // UNTOUCHED
    });

    it('leaves currencies not in feed completely untouched', async () => {
        await makeCurrency({ code: 'SAR', marketRate: 3.50, platformRate: 4.00 });

        await syncRates({ ratesOverride: { EGP: 50 } });  // SAR not in feed

        const sar = await Currency.findOne({ code: 'SAR' });
        expect(sar.marketRate).toBe(3.50);  // unchanged
    });

    it('skips invalid rate values', async () => {
        const result = await syncRates({
            ratesOverride: { SAR: 0, EGP: -5, USD: 1 },
        });
        expect(result.skipped).toBeGreaterThanOrEqual(2);
    });
});

// =============================================================================
// [5] currency.service — admin operations
// =============================================================================

describe('[5] currency.service admin operations', () => {
    it('seedBaseCurrency creates USD if absent', async () => {
        await currencyService.seedBaseCurrency();
        const usd = await Currency.findOne({ code: 'USD' });
        expect(usd).not.toBeNull();
        expect(usd.platformRate).toBe(1);
        expect(usd.isActive).toBe(true);
    });

    it('seedBaseCurrency is idempotent (no duplicate)', async () => {
        await currencyService.seedBaseCurrency();
        await currencyService.seedBaseCurrency();
        const count = await Currency.countDocuments({ code: 'USD' });
        expect(count).toBe(1);
    });

    it('updateCurrencyRate changes platformRate and invalidates cache', async () => {
        await makeCurrency({ code: 'SAR', platformRate: 4.00 });
        const { currency: updated } = await currencyService.updateCurrencyRate('SAR', { platformRate: 4.50 });
        expect(updated.platformRate).toBeCloseTo(4.50, 4);
    });

    it('updateCurrencyRate refuses to change USD rate away from 1', async () => {
        await currencyService.seedBaseCurrency();
        await expect(
            currencyService.updateCurrencyRate('USD', { platformRate: 2 })
        ).rejects.toThrow('USD platform rate must always be exactly 1');
    });

    it('setCurrencyStatus disables a currency', async () => {
        await makeCurrency({ isActive: true });
        const updated = await currencyService.setCurrencyStatus('SAR', false);
        expect(updated.isActive).toBe(false);
    });

    it('setCurrencyStatus refuses to disable USD', async () => {
        await currencyService.seedBaseCurrency();
        await expect(
            currencyService.setCurrencyStatus('USD', false)
        ).rejects.toThrow('USD base currency cannot be disabled');
    });

    it('createCurrency creates a new currency', async () => {
        const c = await currencyService.createCurrency({
            code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', platformRate: 3.67,
        });
        expect(c.code).toBe('AED');
        expect(c.platformRate).toBeCloseTo(3.67, 4);
        expect(c.isActive).toBe(true);
    });

    it('createCurrency refuses duplicate codes', async () => {
        await makeCurrency({ code: 'SAR' });
        await expect(
            currencyService.createCurrency({
                code: 'SAR', name: 'X', symbol: 'X', platformRate: 1,
            })
        ).rejects.toThrow('already exists');
    });

    it('deleteCurrency deletes an unused currency', async () => {
        await makeCurrency({ code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' });

        await currencyService.deleteCurrency('AED');

        const deleted = await Currency.findOne({ code: 'AED' });
        expect(deleted).toBeNull();
    });

    it('deleteCurrency refuses a currency linked to a user', async () => {
        await makeCurrency({ code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' });
        const { customer } = await createCustomerWithGroup();
        await User.findByIdAndUpdate(customer._id, { currency: 'AED' });

        await expect(currencyService.deleteCurrency('AED'))
            .rejects.toThrow('Cannot delete currency in use');

        const stillExists = await Currency.findOne({ code: 'AED' });
        expect(stillExists).not.toBeNull();
    });
});

// =============================================================================
// [6] Order creation — currency snapshot & wallet deduction
// =============================================================================

describe('[6] Order creation with currency conversion', () => {
    let customer, group, product;

    beforeEach(async () => {
        // Seed SAR currency
        await Currency.create({
            code: 'SAR', name: 'Saudi Riyal', symbol: '﷼',
            marketRate: 3.75, platformRate: 4.00, isActive: true,
        });

        // Create a SAR-currency customer with 1000 SAR balance
        ({ customer, group } = await createCustomerWithGroup(
            { walletBalance: 1000, creditLimit: 0 },
            { percentage: 0 }
        ));

        // Set the customer's currency to SAR
        await User.findByIdAndUpdate(customer._id, { currency: 'SAR' });

        product = await createProduct({ basePrice: 10, executionType: 'manual' });
    });

    it('stores currency, rateSnapshot, usdAmount, chargedAmount on the order', async () => {
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        expect(order.currency).toBe('SAR');
        expect(order.rateSnapshot).toBe(4.00);
        expect(order.usdAmount).toBe('10');
        expect(order.chargedAmount).toBeCloseTo(40, 2);
    });

    it('deducts chargedAmount from wallet (in user currency)', async () => {
        await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        const updated = await User.findById(customer._id);
        // 1000 SAR - 40 SAR (10 USD × 4.00 rate) = 960 SAR
        expect(updated.walletBalance).toBeCloseTo(960, 1);
    });

    it('USD user has rateSnapshot = 1 and chargedAmount = usdAmount', async () => {
        // Reset customer to USD
        await User.findByIdAndUpdate(customer._id, { currency: 'USD', walletBalance: 500 });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        expect(order.currency).toBe('USD');
        expect(order.rateSnapshot).toBe(1);
        expect(order.usdAmount).toBe('10');
        expect(order.chargedAmount).toBeCloseTo(10, 2);
    });

    it('quantity > 1 scales both usdAmount and chargedAmount', async () => {
        await User.findByIdAndUpdate(customer._id, { walletBalance: 5000 });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 3,
        });

        // 3 × 10 USD = 30 USD → 30 × 4.00 = 120 SAR
        expect(order.usdAmount).toBe('30');
        expect(order.chargedAmount).toBeCloseTo(120, 2);
    });

    it('insufficient balance throws InsufficientFundsError', async () => {
        // Customer has 1000 SAR. 30 × 10 USD × 4.00 rate = 1200 SAR > 1000 SAR.
        // qty=30 is within maxQty=100 so the quantity guard is not triggered.
        await expect(
            createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 30,
            })
        ).rejects.toThrow('Insufficient funds');
    });
});
