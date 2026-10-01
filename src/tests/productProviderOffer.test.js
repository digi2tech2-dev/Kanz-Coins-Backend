'use strict';

const mongoose = require('mongoose');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
    countTransactions,
} = require('./testHelpers');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Currency } = require('../modules/currency/currency.model');
const { Order } = require('../modules/orders/order.model');
const { ProductProviderOffer } = require('../modules/products/productProviderOffer.model');
const { getComparableProviderCost, selectProviderOfferForOrder } = require('../modules/products/providerOfferRouting.service');
const { backfillLegacyProductProviderOffers } = require('../modules/products/productProviderOfferBackfill.service');
const { updateProduct } = require('../modules/products/product.service');
const { createOrder } = require('../modules/orders/order.service');
const { executeOrder } = require('../modules/orders/orderFulfillment.service');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const { registerAdapter } = require('../modules/providers/adapters/adapter.factory');
const { BaseProviderAdapter } = require('../modules/providers/adapters/base.adapter');

beforeAll(() => connectTestDB());
afterAll(() => disconnectTestDB());
beforeEach(() => clearCollections());

const makeProvider = (suffix, overrides = {}) => Provider.create({
    name: `Routing Provider ${suffix}-${Date.now()}-${Math.random()}`,
    slug: `routing-${suffix}-${Math.random().toString(36).slice(2)}`,
    adapterType: 'mock',
    baseUrl: 'https://mock.test',
    isActive: true,
    ...overrides,
});

const makeProviderProduct = (provider, overrides = {}) => ProviderProduct.create({
    provider: provider._id,
    externalProductId: `remote-${Math.random().toString(36).slice(2)}`,
    rawName: 'Equivalent supplier offer',
    rawPrice: '5',
    minQty: 1,
    maxQty: 100,
    isActive: true,
    lastSyncedAt: new Date(),
    ...overrides,
});

const automaticMetadata = (overrides = {}) => ({
    enabled: true,
    allowAutomaticRouting: true,
    priceSemantics: 'PER_UNIT',
    supplierCurrency: 'USD',
    maxPriceAgeMs: 60 * 60 * 1000,
    ...overrides,
});

const makeOffer = async (product, provider, providerProduct, overrides = {}) => ProductProviderOffer.create({
    product: product._id,
    provider: provider._id,
    providerProduct: providerProduct._id,
    ...automaticMetadata(overrides),
});

const makeSnapshotOrder = async ({ customer, group, product, offer, provider, providerProduct, overrides = {} }) => Order.create({
    userId: customer._id,
    productId: product._id,
    orderNumber: `ROUTE${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
    quantity: 1,
    unitPrice: '10',
    totalPrice: '10',
    basePriceSnapshot: '10',
    markupPercentageSnapshot: 0,
    finalPriceCharged: '10',
    groupIdSnapshot: group._id,
    status: 'PROCESSING',
    executionType: 'automatic',
    selectedProviderOffer: offer._id,
    providerIdSnapshot: provider._id,
    providerProductIdSnapshot: providerProduct._id,
    providerExternalProductIdSnapshot: providerProduct.externalProductId,
    providerCostSnapshot: providerProduct.rawPrice,
    providerCostCurrencySnapshot: 'USD',
    providerNormalizedCostSnapshot: providerProduct.rawPrice,
    providerNormalizedCurrencySnapshot: 'USD',
    providerNormalizationRateSnapshot: '1',
    providerPriceSemanticsSnapshot: 'FIXED_OFFER',
    providerQuantitySnapshot: 1,
    providerMappingSnapshot: {},
    providerSelectedAt: new Date(),
    customerInput: { values: {}, fieldsSnapshot: [] },
    providerCode: provider.slug,
    walletDeducted: 0,
    creditUsedAmount: '0',
    currency: 'USD',
    rateSnapshot: 1,
    usdAmount: '10',
    chargedAmount: 0,
    ...overrides,
});

describe('ProductProviderOffer model', () => {
    it('defaults existing and newly-created Products to LEGACY routing', async () => {
        const product = await createProduct();
        expect(product.providerRoutingMode).toBe('LEGACY');
    });
    it('allows one Product to map equivalent offers from multiple Providers', async () => {
        const product = await createProduct();
        const providerA = await makeProvider('a');
        const providerB = await makeProvider('b');
        const ppA = await makeProviderProduct(providerA);
        const ppB = await makeProviderProduct(providerB);

        await makeOffer(product, providerA, ppA);
        await makeOffer(product, providerB, ppB);

        await expect(ProductProviderOffer.countDocuments({ product: product._id })).resolves.toBe(2);
    });

    it('rejects duplicate mappings and provider/product mismatches', async () => {
        const product = await createProduct();
        const providerA = await makeProvider('a');
        const providerB = await makeProvider('b');
        const ppA = await makeProviderProduct(providerA);

        await makeOffer(product, providerA, ppA);
        await expect(makeOffer(product, providerA, ppA)).rejects.toMatchObject({ code: 11000 });
        await expect(makeOffer(product, providerB, ppA)).rejects.toThrow(/must belong to provider/i);
    });

    it('requires explicit safe metadata when automatic routing is enabled', async () => {
        const product = await createProduct();
        const provider = await makeProvider('a');
        const pp = await makeProviderProduct(provider);

        await expect(ProductProviderOffer.create({
            product: product._id,
            provider: provider._id,
            providerProduct: pp._id,
            allowAutomaticRouting: true,
        })).rejects.toThrow(/supplierCurrency.*required|maxPriceAgeMs.*required|priceSemantics/i);
    });
});

describe('comparable provider costs', () => {
    it('calculates FIXED_OFFER and PER_UNIT costs', async () => {
        const product = await createProduct();
        const provider = await makeProvider('cost');
        const pp = await makeProviderProduct(provider, { rawPrice: '2.5' });
        const fixed = await makeOffer(product, provider, pp, { priceSemantics: 'FIXED_OFFER' });
        const perUnit = await makeOffer(product, provider, await makeProviderProduct(provider, { rawPrice: '2.5' }), { priceSemantics: 'PER_UNIT' });

        const fixedCost = await getComparableProviderCost({ offer: fixed, provider, providerProduct: pp, platformQuantity: 3 });
        const perUnitCost = await getComparableProviderCost({ offer: perUnit, provider, providerProduct: await ProviderProduct.findById(perUnit.providerProduct), platformQuantity: 3 });
        expect(fixedCost).toMatchObject({ eligible: true, supplierCost: '2.5', normalizedCost: '2.5' });
        expect(perUnitCost).toMatchObject({ eligible: true, supplierCost: '7.5', normalizedCost: '7.5' });
    });

    it('routes USD at rate 1 and rejects every non-USD supplier currency', async () => {
        const product = await createProduct();
        const provider = await makeProvider('currency');
        const pp = await makeProviderProduct(provider, { rawPrice: '15' });
        await Currency.create({ code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', platformRate: 3.75, isActive: true });
        const sarOffer = await makeOffer(product, provider, pp, { priceSemantics: 'FIXED_OFFER', supplierCurrency: 'SAR' });
        const sarCost = await getComparableProviderCost({ offer: sarOffer, provider, providerProduct: pp, platformQuantity: 1 });
        expect(sarCost).toMatchObject({ eligible: false, reason: 'UNSUPPORTED_SUPPLIER_CURRENCY' });

        const usdOffer = await makeOffer(product, provider, await makeProviderProduct(provider), { supplierCurrency: 'USD' });
        const usdCost = await getComparableProviderCost({ offer: usdOffer, provider, providerProduct: await ProviderProduct.findById(usdOffer.providerProduct), platformQuantity: 1 });
        expect(usdCost).toMatchObject({ eligible: true, normalizedCurrency: 'USD', normalizationRate: '1' });
    });

    it('does not let Currency.platformRate influence supplier selection', async () => {
        const product = await createProduct({ executionType: 'automatic' });
        const provider = await makeProvider('platform-rate');
        const usdPP = await makeProviderProduct(provider, { rawPrice: '5' });
        const sarPP = await makeProviderProduct(provider, { rawPrice: '1' });
        const usdOffer = await makeOffer(product, provider, usdPP, { supplierCurrency: 'USD' });
        await makeOffer(product, provider, sarPP, { supplierCurrency: 'SAR' });
        await Currency.create({ code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', platformRate: 0.01, isActive: true });

        const selection = await selectProviderOfferForOrder({ product, quantity: 1 });
        expect(selection.selected.offer._id.toString()).toBe(usdOffer._id.toString());
        await Currency.updateOne({ code: 'SAR' }, { $set: { platformRate: 999999 } });
        const afterRateChange = await selectProviderOfferForOrder({ product, quantity: 1 });
        expect(afterRateChange.selected.offer._id.toString()).toBe(usdOffer._id.toString());
    });

    it('rejects invalid price, stale catalog data, inactive entities, and out-of-range quantity', async () => {
        const product = await createProduct();
        const provider = await makeProvider('reject');
        const pp = await makeProviderProduct(provider, { rawPrice: '0', lastSyncedAt: new Date(Date.now() - 10_000) });
        const offer = await makeOffer(product, provider, pp, { maxPriceAgeMs: 1 });
        expect((await getComparableProviderCost({ offer, provider, providerProduct: pp, platformQuantity: 1 })).reason).toBe('INVALID_RAW_PRICE');

        pp.rawPrice = '5';
        await pp.save();
        expect((await getComparableProviderCost({ offer, provider, providerProduct: pp, platformQuantity: 1 })).reason).toBe('STALE_PROVIDER_PRICE');
        pp.lastSyncedAt = new Date();
        pp.minQty = 2;
        await pp.save();
        expect((await getComparableProviderCost({ offer, provider, providerProduct: pp, platformQuantity: 1 })).reason).toBe('PROVIDER_QUANTITY_OUT_OF_RANGE');
        provider.isActive = false;
        await provider.save();
        expect((await getComparableProviderCost({ offer, provider, providerProduct: pp, platformQuantity: 2 })).reason).toBe('PROVIDER_INACTIVE');
    });
});

describe('offer selection and order snapshots', () => {
    it('keeps LEGACY scalar routing when backfilled-style offers exist', async () => {
        const { customer } = await createCustomerWithGroup();
        const provider = await makeProvider('legacy-routing');
        const pp = await makeProviderProduct(provider, { externalProductId: 'legacy-route-id' });
        const product = await createProduct({
            executionType: 'automatic', provider: provider._id, providerProduct: pp._id,
        });
        await ProductProviderOffer.create({
            product: product._id,
            provider: provider._id,
            providerProduct: pp._id,
            enabled: true,
            allowAutomaticRouting: false,
        });

        const { order } = await createOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        expect(order.selectedProviderOffer).toBeNull();
        expect(order.providerCode).toBe(provider.slug);
        expect(order.providerExternalProductIdSnapshot).toBeNull();
    });

    it('requires a USD automatic offer before an automatic Product can enter MULTI_PROVIDER mode', async () => {
        const product = await createProduct({ executionType: 'automatic' });
        await expect(updateProduct(product._id, { providerRoutingMode: 'MULTI_PROVIDER' }))
            .rejects.toMatchObject({ code: 'MULTI_PROVIDER_ROUTING_NOT_CONFIGURED' });

        const provider = await makeProvider('mode-config');
        const pp = await makeProviderProduct(provider);
        const offer = await makeOffer(product, provider, pp, { supplierCurrency: 'SAR' });
        await expect(updateProduct(product._id, { providerRoutingMode: 'MULTI_PROVIDER' }))
            .rejects.toMatchObject({ code: 'MULTI_PROVIDER_ROUTING_NOT_CONFIGURED' });

        offer.supplierCurrency = 'USD';
        await offer.save();
        const updated = await updateProduct(product._id, { providerRoutingMode: 'MULTI_PROVIDER' });
        expect(updated.providerRoutingMode).toBe('MULTI_PROVIDER');
    });

    it('skips disabled, stale, and unsupported-currency offers before selecting the cheapest eligible one', async () => {
        const product = await createProduct({ executionType: 'automatic' });
        const provider = await makeProvider('select');
        const disabledPP = await makeProviderProduct(provider, { rawPrice: '1' });
        const stalePP = await makeProviderProduct(provider, { rawPrice: '2', lastSyncedAt: new Date(Date.now() - 10_000) });
        const eurPP = await makeProviderProduct(provider, { rawPrice: '3' });
        const eligiblePP = await makeProviderProduct(provider, { rawPrice: '4' });
        const disabled = await makeOffer(product, provider, disabledPP, { enabled: false });
        const stale = await makeOffer(product, provider, stalePP, { maxPriceAgeMs: 1 });
        const unsupportedCurrency = await makeOffer(product, provider, eurPP, { supplierCurrency: 'EUR' });
        const selectedOffer = await makeOffer(product, provider, eligiblePP);

        const selection = await selectProviderOfferForOrder({ product, quantity: 1 });
        expect(selection.hasOffers).toBe(true);
        expect(selection.selected.offer._id.toString()).toBe(selectedOffer._id.toString());
        expect(selection.candidates.find((candidate) => candidate.offer._id.equals(disabled._id)).cost.reason).toBe('OFFER_DISABLED');
        expect(selection.candidates.find((candidate) => candidate.offer._id.equals(stale._id)).cost.reason).toBe('STALE_PROVIDER_PRICE');
        expect(selection.candidates.find((candidate) => candidate.offer._id.equals(unsupportedCurrency._id)).cost.reason).toBe('UNSUPPORTED_SUPPLIER_CURRENCY');
    });

    it('uses priority and then ObjectId as deterministic tie-breakers', async () => {
        const product = await createProduct({ executionType: 'automatic' });
        const provider = await makeProvider('tie');
        const ppA = await makeProviderProduct(provider, { rawPrice: '2' });
        const ppB = await makeProviderProduct(provider, { rawPrice: '2' });
        await makeOffer(product, provider, ppA, { priority: 10 });
        const preferred = await makeOffer(product, provider, ppB, { priority: 1 });

        const selection = await selectProviderOfferForOrder({ product, quantity: 1 });
        expect(selection.selected.offer._id.toString()).toBe(preferred._id.toString());
    });

    it('rejects MULTI_PROVIDER before wallet debit when no offer is eligible and never falls back to scalar linkage', async () => {
        const { customer } = await createCustomerWithGroup();
        const scalarProvider = await makeProvider('legacy-scalar');
        const scalarPP = await makeProviderProduct(scalarProvider);
        const product = await createProduct({
            executionType: 'automatic', basePrice: 10,
            providerRoutingMode: 'MULTI_PROVIDER', provider: scalarProvider._id, providerProduct: scalarPP._id,
        });
        const provider = await makeProvider('no-eligible');
        const pp = await makeProviderProduct(provider);
        await makeOffer(product, provider, pp, { enabled: false });

        await expect(createOrder({ userId: customer._id, productId: product._id, quantity: 1 }))
            .rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER_OFFER' });
        expect((await mongoose.model('User').findById(customer._id)).walletBalance).toBe(100);
        await expect(Order.countDocuments({ userId: customer._id })).resolves.toBe(0);
    });

    it('rejects MULTI_PROVIDER with no mappings before wallet debit instead of using scalar linkage', async () => {
        const { customer } = await createCustomerWithGroup();
        const scalarProvider = await makeProvider('no-mapping-scalar');
        const scalarPP = await makeProviderProduct(scalarProvider);
        const product = await createProduct({
            executionType: 'automatic', basePrice: 10,
            providerRoutingMode: 'MULTI_PROVIDER', provider: scalarProvider._id, providerProduct: scalarPP._id,
        });

        await expect(createOrder({ userId: customer._id, productId: product._id, quantity: 1 }))
            .rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER_OFFER' });
        expect((await mongoose.model('User').findById(customer._id)).walletBalance).toBe(100);
        await expect(Order.countDocuments({ userId: customer._id })).resolves.toBe(0);
    });

    it('persists the selected offer and immutable supplier dispatch snapshots', async () => {
        const { customer } = await createCustomerWithGroup();
        const product = await createProduct({ executionType: 'automatic', basePrice: 10, providerRoutingMode: 'MULTI_PROVIDER' });
        const provider = await makeProvider('snapshot');
        const pp = await makeProviderProduct(provider, { externalProductId: 'snapshot-remote', rawPrice: '2' });
        const offer = await makeOffer(product, provider, pp, { providerMapping: { player_id: 'playerId' } });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 2,
            orderFieldsValues: { player_id: '123' },
        });
        const persisted = await Order.findById(order._id);
        expect(persisted).toMatchObject({
            selectedProviderOffer: offer._id,
            providerIdSnapshot: provider._id,
            providerProductIdSnapshot: pp._id,
            providerExternalProductIdSnapshot: 'snapshot-remote',
            providerCostSnapshot: '4',
            providerNormalizedCostSnapshot: '4',
            providerPriceSemanticsSnapshot: 'PER_UNIT',
            providerQuantitySnapshot: 2,
            providerMappingSnapshot: { player_id: 'playerId' },
            providerNormalizationRateSnapshot: '1',
        });
        expect(await countTransactions(customer._id)).toBe(1);
    });

    it('fulfills a routed order from its snapshot after Product linkage changes', async () => {
        const { customer, group } = await createCustomerWithGroup();
        const legacyProvider = await makeProvider('legacy');
        const mutatedProductProvider = await makeProvider('mutated-product');
        const selectedProvider = await makeProvider('selected');
        const legacyPP = await makeProviderProduct(legacyProvider, { externalProductId: 'legacy-remote' });
        const mutatedProductPP = await makeProviderProduct(mutatedProductProvider, { externalProductId: 'mutated-product-remote' });
        const selectedPP = await makeProviderProduct(selectedProvider, { externalProductId: 'selected-remote' });
        const product = await createProduct({
            executionType: 'automatic',
            providerRoutingMode: 'MULTI_PROVIDER',
            provider: legacyProvider._id,
            providerProduct: legacyPP._id,
        });
        const offer = await makeOffer(product, selectedProvider, selectedPP);
        const order = await Order.create({
            userId: customer._id,
            productId: product._id,
            orderNumber: `SNAP${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
            quantity: 1,
            unitPrice: '10',
            totalPrice: '10',
            basePriceSnapshot: '10',
            markupPercentageSnapshot: 0,
            finalPriceCharged: '10',
            groupIdSnapshot: group._id,
            status: 'PROCESSING',
            executionType: 'automatic',
            selectedProviderOffer: offer._id,
            providerIdSnapshot: selectedProvider._id,
            providerProductIdSnapshot: selectedPP._id,
            providerExternalProductIdSnapshot: 'selected-remote',
            providerCostSnapshot: '2',
            providerCostCurrencySnapshot: 'USD',
            providerNormalizedCostSnapshot: '2',
            providerNormalizedCurrencySnapshot: 'USD',
            providerPriceSemanticsSnapshot: 'FIXED_OFFER',
            providerQuantitySnapshot: 1,
            providerMappingSnapshot: { player_id: 'playerId' },
            providerSelectedAt: new Date(),
            customerInput: { values: { player_id: '123' }, fieldsSnapshot: [] },
            providerCode: selectedProvider.slug,
            walletDeducted: 0,
            creditUsedAmount: '0',
            currency: 'USD',
            rateSnapshot: 1,
            usdAmount: '10',
            chargedAmount: 0,
        });

        product.provider = mutatedProductProvider._id;
        product.providerProduct = mutatedProductPP._id;
        await product.save();
        selectedPP.rawPrice = '999';
        selectedPP.externalProductId = 'mutated-remote';
        await selectedPP.save();
        await ProductProviderOffer.findByIdAndUpdate(offer._id, {
            $set: { enabled: false, providerMapping: { player_id: 'changedPlayerId' } },
        });

        await executeOrder(order._id);
        const dispatched = await Order.findById(order._id);
        expect(dispatched.providerRawResponse.params).toMatchObject({
            externalProductId: 'selected-remote',
            providerProductId: 'selected-remote',
            quantity: 1,
            playerId: '123',
        });
        expect(dispatched.providerCostSnapshot).toBe('2');
        expect(dispatched.selectedProviderOffer.toString()).toBe(offer._id.toString());
    });

    it('does not let provider catalog sync overwrite offer routing metadata', async () => {
        const product = await createProduct();
        const provider = await makeProvider('sync');
        const pp = await makeProviderProduct(provider, { externalProductId: 'sync-product', rawPrice: '2' });
        const offer = await makeOffer(product, provider, pp, {
            supplierCurrency: 'USD',
            priceSemantics: 'PER_UNIT',
            providerMapping: { player_id: 'playerId' },
            priority: 7,
        });

        await syncProviderProducts(provider._id, {
            products: [{
                externalProductId: 'sync-product', rawName: 'Updated catalog product', rawPrice: '9',
                minQty: 1, maxQty: 100, isActive: true,
            }],
        });

        const unchanged = await ProductProviderOffer.findById(offer._id);
        expect(unchanged).toMatchObject({
            allowAutomaticRouting: true,
            supplierCurrency: 'USD',
            priceSemantics: 'PER_UNIT',
            priority: 7,
        });
        expect(unchanged.providerMapping.get('player_id')).toBe('playerId');
        expect((await ProviderProduct.findById(pp._id)).rawPrice).toBe('9');
    });
});

describe('routing-mode backfill compatibility', () => {
    it('keeps dry-run read-only and apply creates a non-automatic mapping without activating MULTI_PROVIDER', async () => {
        const provider = await makeProvider('backfill');
        const pp = await makeProviderProduct(provider);
        const product = await createProduct({
            executionType: 'automatic', provider: provider._id, providerProduct: pp._id,
        });

        const dryRun = await backfillLegacyProductProviderOffers({ dryRun: true, batchSize: 1 });
        expect(dryRun).toMatchObject({ productsInspected: 1, mappingsWouldCreate: 1, mappingsCreated: 0 });
        expect(await ProductProviderOffer.countDocuments()).toBe(0);

        const applied = await backfillLegacyProductProviderOffers({ dryRun: false, batchSize: 1 });
        expect(applied).toMatchObject({ mappingsCreated: 1 });
        const mapping = await ProductProviderOffer.findOne({ product: product._id });
        expect(mapping).toMatchObject({ enabled: true, allowAutomaticRouting: false });
        expect((await mongoose.model('Product').findById(product._id)).providerRoutingMode).toBe('LEGACY');
    });
});

describe('routed fulfillment never fails over', () => {
    it('does not place Provider B after Provider A returns a hard failure', async () => {
        let providerACalls = 0;
        let providerBCalls = 0;
        class HardFailureAdapter extends BaseProviderAdapter {
            async placeOrder() {
                providerACalls += 1;
                return { success: false, providerOrderId: null, providerStatus: 'Cancelled', rawResponse: { rejected: true }, errorMessage: 'rejected' };
            }
        }
        class AlternateAdapter extends BaseProviderAdapter {
            async placeOrder() { providerBCalls += 1; return { success: true, providerOrderId: 'B-1', providerStatus: 'Pending', rawResponse: {} }; }
        }
        registerAdapter('route-hard-failure', HardFailureAdapter);
        registerAdapter('route-alternate-hard', AlternateAdapter);

        const { customer, group } = await createCustomerWithGroup({ walletBalance: 90 });
        const providerA = await makeProvider('hard-a', { adapterType: 'route-hard-failure' });
        const providerB = await makeProvider('hard-b', { adapterType: 'route-alternate-hard' });
        const ppA = await makeProviderProduct(providerA, { rawPrice: '2' });
        const ppB = await makeProviderProduct(providerB, { rawPrice: '3' });
        const product = await createProduct({ executionType: 'automatic', providerRoutingMode: 'MULTI_PROVIDER' });
        const offerA = await makeOffer(product, providerA, ppA);
        await makeOffer(product, providerB, ppB);
        const order = await makeSnapshotOrder({ customer, group, product, offer: offerA, provider: providerA, providerProduct: ppA, overrides: { walletDeducted: 10, chargedAmount: 10 } });

        await executeOrder(order._id);
        await executeOrder(order._id);
        const persisted = await Order.findById(order._id);
        expect(providerACalls).toBe(1);
        expect(providerBCalls).toBe(0);
        expect(persisted.selectedProviderOffer.toString()).toBe(offerA._id.toString());
        expect(persisted.refunded).toBe(true);
        expect((await mongoose.model('User').findById(customer._id)).walletBalance).toBe(100);
        expect(await countTransactions(customer._id)).toBe(1);
    });

    it('does not place Provider B after Provider A has an ambiguous transient failure', async () => {
        let providerACalls = 0;
        let providerBCalls = 0;
        class TransientAdapter extends BaseProviderAdapter {
            async placeOrder() {
                providerACalls += 1;
                const error = new Error('timeout');
                error.code = 'ETIMEDOUT';
                throw error;
            }
        }
        class AlternateAdapter extends BaseProviderAdapter {
            async placeOrder() { providerBCalls += 1; return { success: true, providerOrderId: 'B-2', providerStatus: 'Pending', rawResponse: {} }; }
        }
        registerAdapter('route-transient-failure', TransientAdapter);
        registerAdapter('route-alternate-transient', AlternateAdapter);

        const { customer, group } = await createCustomerWithGroup();
        const providerA = await makeProvider('transient-a', { adapterType: 'route-transient-failure' });
        const providerB = await makeProvider('transient-b', { adapterType: 'route-alternate-transient' });
        const ppA = await makeProviderProduct(providerA, { rawPrice: '2' });
        const ppB = await makeProviderProduct(providerB, { rawPrice: '3' });
        const product = await createProduct({ executionType: 'automatic', providerRoutingMode: 'MULTI_PROVIDER' });
        const offerA = await makeOffer(product, providerA, ppA);
        await makeOffer(product, providerB, ppB);
        const order = await makeSnapshotOrder({ customer, group, product, offer: offerA, provider: providerA, providerProduct: ppA });

        await executeOrder(order._id);
        const persisted = await Order.findById(order._id);
        expect(providerACalls).toBe(1);
        expect(providerBCalls).toBe(0);
        expect(persisted.status).toBe('PROCESSING');
        expect(persisted.selectedProviderOffer.toString()).toBe(offerA._id.toString());
    });

    it('continues to fulfill a legacy Order without routing snapshots through scalar Product linkage', async () => {
        const { customer, group } = await createCustomerWithGroup();
        const provider = await makeProvider('legacy-fulfillment');
        const pp = await makeProviderProduct(provider, { externalProductId: 'legacy-dispatch-id' });
        const product = await createProduct({ executionType: 'automatic', provider: provider._id, providerProduct: pp._id });
        const order = await Order.create({
            userId: customer._id,
            productId: product._id,
            orderNumber: `LEGACY${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
            quantity: 1,
            unitPrice: '10', totalPrice: '10', basePriceSnapshot: '10', markupPercentageSnapshot: 0,
            finalPriceCharged: '10', groupIdSnapshot: group._id, status: 'PROCESSING', executionType: 'automatic',
            providerCode: provider.slug, walletDeducted: 0, creditUsedAmount: '0', currency: 'USD', rateSnapshot: 1, usdAmount: '10', chargedAmount: 0,
        });

        await executeOrder(order._id);
        const persisted = await Order.findById(order._id);
        expect(persisted.selectedProviderOffer).toBeNull();
        expect(persisted.providerRawResponse.params.externalProductId).toBe('legacy-dispatch-id');
    });
});
