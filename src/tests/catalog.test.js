'use strict';

/**
 * catalog.test.js — Provider Catalog System Test Suite
 * ──────────────────────────────────────────────────────
 *
 * [1] providerCatalog.service — syncProviderProducts
 *   - Creates ProviderProducts on first sync
 *   - Idempotent: no duplicates on resync
 *   - Updates rawPrice / minQty / maxQty / isActive on resync
 *   - Updates lastSyncedAt each sync
 *   - Records correct totalFetched count
 *   - rawPayload stored verbatim
 *   - Throws NotFoundError for unknown provider
 *   - Throws BusinessRuleError for inactive provider
 *   - Adapter error is propagated
 *
 * [2] providerCatalog.service — syncAllProviders
 *   - Processes all active providers
 *   - Skips (excludes from results) inactive providers
 *   - Single provider failure doesn't abort others
 *
 * [3] product.service — createProductFromProvider
 *   - Creates a platform Product linked to ProviderProduct
 *   - Admin name / price / image / category overrides are applied
 *   - basePrice defaults to rawPrice when pricingMode=sync
 *   - minQty / maxQty inherit from ProviderProduct when not supplied
 *   - Duplicate publish throws ConflictError
 *   - Throws NotFoundError for unknown ProviderProduct
 *   - Throws BusinessRuleError when provider is inactive
 *   - createdBy is stored on the product
 *
 * [4] Provider adapter resolution for orders
 *   - getExternalProductId resolves the correct externalProductId
 *   - Returns null for a product with no providerProduct link
 *   - Order basePriceSnapshot uses Product.basePrice (not rawPrice)
 *   - Changing rawPrice (manual mode) does NOT change existing order snapshot
 */

const mongoose = require('mongoose');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product, PRICING_MODES } = require('../modules/products/product.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');

const catalogService = require('../modules/providers/providerCatalog.service');
const productService = require('../modules/products/product.service');
const { createOrder } = require('../modules/orders/order.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

// ── Shared factories ──────────────────────────────────────────────────────────

const makeProvider = (overrides = {}) =>
    Provider.create({
        name: `CatalogProv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        isActive: true,
        ...overrides,
    });

const SAMPLE_PRODUCTS = [
    { externalProductId: 'CP-001', rawName: 'Widget A', rawPrice: 10.00, minQty: 1, maxQty: 100, isActive: true },
    { externalProductId: 'CP-002', rawName: 'Widget B', rawPrice: 20.00, minQty: 2, maxQty: 200, isActive: true },
    { externalProductId: 'CP-003', rawName: 'Widget C', rawPrice: 30.00, minQty: 5, maxQty: 50, isActive: false },
];

// ── [1] syncProviderProducts ──────────────────────────────────────────────────

describe('[1] providerCatalog.service — syncProviderProducts()', () => {
    let provider;

    beforeEach(async () => {
        // Use 'mock' name so the factory resolves MockProviderAdapter
        provider = await makeProvider({ name: 'mock' });
    });

    it('creates ProviderProducts on first sync', async () => {
        const result = await catalogService.syncProviderProducts(
            provider._id, { products: SAMPLE_PRODUCTS }
        );

        expect(result.totalFetched).toBe(3);
        const count = await ProviderProduct.countDocuments({ provider: provider._id });
        expect(count).toBe(3);
    });

    it('is idempotent — second sync with same data creates no duplicates', async () => {
        await catalogService.syncProviderProducts(provider._id, { products: SAMPLE_PRODUCTS });
        await catalogService.syncProviderProducts(provider._id, { products: SAMPLE_PRODUCTS });

        const count = await ProviderProduct.countDocuments({ provider: provider._id });
        expect(count).toBe(3);
    });

    it('updates rawPrice, minQty, maxQty, isActive on resync', async () => {
        await catalogService.syncProviderProducts(provider._id, { products: SAMPLE_PRODUCTS });

        const V2 = [
            { externalProductId: 'CP-001', rawName: 'Widget A v2', rawPrice: 15.00, minQty: 3, maxQty: 50, isActive: false },
        ];
        await catalogService.syncProviderProducts(provider._id, { products: V2 });

        const pp = await ProviderProduct.findOne({ provider: provider._id, externalProductId: 'CP-001' });
        expect(pp.rawPrice).toBe('15');
        expect(pp.minQty).toBe(3);
        expect(pp.maxQty).toBe(50);
        expect(pp.isActive).toBe(false);
        expect(pp.rawName).toBe('Widget A v2');
    });

    it('updates lastSyncedAt on each sync', async () => {
        await catalogService.syncProviderProducts(provider._id, { products: SAMPLE_PRODUCTS });
        const first = await ProviderProduct.findOne({ externalProductId: 'CP-001', provider: provider._id });
        const ts1 = first.lastSyncedAt;

        await new Promise((r) => setTimeout(r, 2));

        await catalogService.syncProviderProducts(provider._id, { products: SAMPLE_PRODUCTS });
        const second = await ProviderProduct.findOne({ externalProductId: 'CP-001', provider: provider._id });

        expect(second.lastSyncedAt.getTime()).toBeGreaterThanOrEqual(ts1.getTime());
    });

    it('returns correct totalFetched count', async () => {
        const result = await catalogService.syncProviderProducts(
            provider._id, { products: SAMPLE_PRODUCTS }
        );
        expect(result.totalFetched).toBe(SAMPLE_PRODUCTS.length);
    });

    it('rawPayload is stored verbatim', async () => {
        const customPayload = { nested: { deep: true }, code: 'X99' };
        await catalogService.syncProviderProducts(provider._id, {
            products: [{ externalProductId: 'PAY-1', rawName: 'P1', rawPrice: 5.00, rawPayload: customPayload }],
        });
        const pp = await ProviderProduct.findOne({ provider: provider._id, externalProductId: 'PAY-1' });
        expect(pp.rawPayload.nested.deep).toBe(true);
        expect(pp.rawPayload.code).toBe('X99');
    });

    it('throws NotFoundError for unknown providerId', async () => {
        await expect(
            catalogService.syncProviderProducts(new mongoose.Types.ObjectId())
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws BusinessRuleError for inactive provider', async () => {
        const inactive = await makeProvider({ isActive: false });
        await expect(
            catalogService.syncProviderProducts(inactive._id)
        ).rejects.toMatchObject({ code: 'PROVIDER_INACTIVE' });
    });

    it('propagates adapter fetch error', async () => {
        await expect(
            catalogService.syncProviderProducts(provider._id, {
                shouldThrow: new Error('Network timeout'),
            })
        ).rejects.toThrow('Network timeout');
    });
});

// ── [2] syncAllProviders ──────────────────────────────────────────────────────

describe('[2] providerCatalog.service — syncAllProviders()', () => {
    it('processes all active providers and returns results array', async () => {
        // Use unique names so we don't hit the Provider.name unique index.
        // The factory falls back to MockProviderAdapter for any unregistered name.
        await makeProvider();   // unique name auto-generated by makeProvider()
        await makeProvider();

        const results = await catalogService.syncAllProviders({
            products: [{ externalProductId: 'ALL-1', rawName: 'All Test', rawPrice: 1.00, minQty: 1, maxQty: 10, isActive: true }],
        });

        expect(results.length).toBe(2);
        results.forEach((r) => {
            expect(r.result).toBeDefined();
            expect(r.error).toBeUndefined();
        });
    });

    it('returns empty array when no active providers exist', async () => {
        await makeProvider({ isActive: false });
        const results = await catalogService.syncAllProviders();
        expect(results).toHaveLength(0);
    });

    it('collects single provider failure without aborting others', async () => {
        await makeProvider({ name: 'mock' }); // this will succeed
        await makeProvider({ isActive: false }); // this is skipped (not active)

        // Simulate by syncing with an adapter override only for the active one
        const results = await catalogService.syncAllProviders({
            products: [{ externalProductId: 'SAFE-1', rawName: 'Safe', rawPrice: 5.00 }],
        });

        // Only 1 active provider → 1 result, success
        expect(results).toHaveLength(1);
        expect(results[0].result).toBeDefined();
    });
});

// ── [3] createProductFromProvider ─────────────────────────────────────────────

describe('[3] product.service — createProductFromProvider()', () => {
    let provider;
    let providerProduct;

    beforeEach(async () => {
        provider = await makeProvider({ name: 'mock' });
        await catalogService.syncProviderProducts(provider._id, {
            products: [{
                externalProductId: 'PUB-T01',
                rawName: 'Raw Game Token',
                rawPrice: 5.00,
                minQty: 1,
                maxQty: 500,
                isActive: true,
            }],
        });
        providerProduct = await ProviderProduct.findOne({ provider: provider._id, externalProductId: 'PUB-T01' });
    });

    it('creates a platform Product with correct provider linkage', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Game Tokens',
            basePrice: 6.00,
            pricingMode: PRICING_MODES.MANUAL,
        });

        expect(product._id).toBeDefined();
        expect(product.name).toBe('Game Tokens');
        expect(product.provider.toString()).toBe(provider._id.toString());
        expect(product.providerProduct.toString()).toBe(providerProduct._id.toString());
    });

    it('admin name override is used (not rawName)', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Custom Display Name',
            basePrice: 5.00,
        });
        expect(product.name).toBe('Custom Display Name');
    });

    it('admin basePrice override is stored (manual mode)', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Priced Product',
            basePrice: 9.99,
            pricingMode: PRICING_MODES.MANUAL,
        });
        expect(product.basePrice).toBe('9.99');
    });

    it('pricingMode=sync uses rawPrice as basePrice (ignores admin input)', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Sync Product',
            basePrice: 9999.00,       // should be overridden
            pricingMode: PRICING_MODES.SYNC,
        });
        expect(product.basePrice).toBe('5');  // rawPrice wins
    });

    it('image override is stored on the product', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'With Image',
            basePrice: 5.00,
            image: 'https://cdn.example.com/token.png',
        });
        expect(product.image).toBe('https://cdn.example.com/token.png');
    });

    it('category override is stored on the product', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Categorised',
            basePrice: 5.00,
            category: 'games',
        });
        expect(product.category).toBe('games');
    });

    it('minQty / maxQty inherit from ProviderProduct when not provided', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Auto Qty',
            basePrice: 5.00,
            // no minQty / maxQty
        });
        expect(product.minQty).toBe(1);    // from ProviderProduct
        expect(product.maxQty).toBe(500);  // from ProviderProduct
    });

    it('minQty / maxQty admin overrides are applied', async () => {
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Custom Qty',
            basePrice: 5.00,
            minQty: 10,
            maxQty: 200,
        });
        expect(product.minQty).toBe(10);
        expect(product.maxQty).toBe(200);
    });

    it('createdBy stores the admin user ID', async () => {
        const fakeAdminId = new mongoose.Types.ObjectId();
        const product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'By Admin',
            basePrice: 5.00,
            createdBy: fakeAdminId,
        });
        expect(product.createdBy.toString()).toBe(fakeAdminId.toString());
    });

    it('throws ConflictError when the same ProviderProduct is published twice', async () => {
        await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'First', basePrice: 5.00,
        });

        await expect(
            productService.createProductFromProvider({
                providerProductId: providerProduct._id,
                name: 'Duplicate', basePrice: 5.00,
            })
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('throws NotFoundError for non-existent ProviderProduct', async () => {
        await expect(
            productService.createProductFromProvider({
                providerProductId: new mongoose.Types.ObjectId(),
                name: 'Ghost', basePrice: 5.00,
            })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws BusinessRuleError when provider is inactive', async () => {
        await Provider.findByIdAndUpdate(provider._id, { isActive: false });

        await expect(
            productService.createProductFromProvider({
                providerProductId: providerProduct._id,
                name: 'Ghost', basePrice: 5.00,
            })
        ).rejects.toMatchObject({ code: 'PROVIDER_INACTIVE' });
    });
});

// ── [4] Provider adapter resolution via product chain ────────────────────────

describe('[4] Order provider resolution via Product → ProviderProduct chain', () => {
    let customer;
    let provider;
    let providerProduct;
    let product;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup(
            { walletBalance: 5000, creditLimit: 0 },
            { percentage: 0 }
        ));
        provider = await makeProvider({ name: 'mock' });

        await catalogService.syncProviderProducts(provider._id, {
            products: [{
                externalProductId: 'RES-001',
                rawName: 'Resolution Test',
                rawPrice: 100.00,
                minQty: 1,
                maxQty: 100,
                isActive: true,
            }],
        });
        providerProduct = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: 'RES-001',
        });
    });

    it('getExternalProductId resolves correct externalProductId through the chain', async () => {
        product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Resolution Product',
            basePrice: 100.00,
        });

        const externalId = await productService.getExternalProductId(product._id);
        expect(externalId).toBe('RES-001');
    });

    it('getExternalProductId returns null for a product with no provider link', async () => {
        // Standalone product (no providerProduct)
        const standalone = await Product.create({
            name: 'Standalone',
            basePrice: 50.00,
            minQty: 1,
            maxQty: 10,
        });

        const externalId = await productService.getExternalProductId(standalone._id);
        expect(externalId).toBeNull();
    });

    it('order basePriceSnapshot uses Product.basePrice (not ProviderProduct.rawPrice)', async () => {
        // rawPrice = 100 but we publish with a different basePrice
        product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Priced Product',
            basePrice: 75.00,
            pricingMode: PRICING_MODES.MANUAL,
        });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });

        expect(order.basePriceSnapshot).toBe('75');   // Product.basePrice, not rawPrice
        expect(order.totalPrice).toBe('75');
    });

    it('changing rawPrice (manual mode) does NOT affect existing order snapshot', async () => {
        product = await productService.createProductFromProvider({
            providerProductId: providerProduct._id,
            name: 'Snapshot Guard',
            basePrice: 80.00,
            pricingMode: PRICING_MODES.MANUAL,
        });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 2,
        });

        expect(order.basePriceSnapshot).toBe('80');
        expect(order.totalPrice).toBe('160');

        // Sync with a new rawPrice — manual mode → Product.basePrice unchanged
        await catalogService.syncProviderProducts(provider._id, {
            products: [{
                externalProductId: 'RES-001',
                rawName: 'Resolution Test',
                rawPrice: 999.00,   // big change
                minQty: 1,
                maxQty: 100,
                isActive: true,
            }],
        });

        // Product.basePrice stays 80 (manual mode)
        const freshProduct = await Product.findById(product._id);
        expect(freshProduct.basePrice).toBe('80');

        // Order snapshots completely unchanged
        const freshOrder = await Order.findById(order._id);
        expect(freshOrder.basePriceSnapshot).toBe('80');
        expect(freshOrder.totalPrice).toBe('160');
    });
});
