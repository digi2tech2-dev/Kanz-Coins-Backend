'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const {
    listProviderProducts,
    getProviderProductById,
} = require('../modules/providers/providerProduct.service');
const { syncProviderProducts } = require('../modules/providers/sync.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const makeProvider = (overrides = {}) => Provider.create({
    name: `DealerProvider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    baseUrl: 'https://dealer.example.test',
    apiKey: 'test-secret',
    isActive: true,
    ...overrides,
});

describe('Dealer dynamic provider product selection', () => {
    it('auto-upserts Ibulala dynamic product for admin provider-product listing', async () => {
        const provider = await makeProvider({
            name: 'Ibulala Chat',
            slug: 'ibulala-chat',
        });

        const result = await listProviderProducts({ provider: provider._id });

        expect(result.products).toHaveLength(1);
        expect(result.products[0]).toMatchObject({
            externalProductId: 'ibulala_dynamic_coins',
            rawName: 'Ibulala Dynamic Coins (Any Amount)',
            rawPrice: '0.00000000001',
            price: '0.00000000001',
            minQty: 1,
            maxQty: 500000000,
            isActive: true,
            rawPayload: expect.objectContaining({
                product_id: 'ibulala_dynamic_coins',
                product_name: 'Ibulala Dynamic Coins (Any Amount)',
                product_price: '0.00000000001',
                currency: 'USD',
            }),
        });

        const persisted = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: 'ibulala_dynamic_coins',
        });
        expect(persisted).toBeTruthy();
    });

    it('keeps Karak dynamic product ID and normalized fields unchanged', async () => {
        const provider = await makeProvider({
            name: 'Karak Chat',
            slug: 'karak',
        });

        const result = await listProviderProducts({ provider: provider._id });

        expect(result.products[0]).toMatchObject({
            externalProductId: 'karak_dynamic_coins',
            rawName: 'Karak Dynamic Coins (Any Amount)',
            rawPrice: '0.00001',
            minQty: 1,
            maxQty: 5000000,
            isActive: true,
        });

        const persisted = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: 'karak_dynamic_coins',
        });
        const detail = await getProviderProductById(persisted._id);

        expect(detail).toMatchObject({
            externalProductId: 'karak_dynamic_coins',
            rawName: 'Karak Dynamic Coins (Any Amount)',
            rawPayload: expect.objectContaining({
                product_id: 'karak_dynamic_coins',
                product_price: '0.00001',
            }),
        });
    });

    it('sync/upsert preserves Ibulala tiny price as a plain decimal string', async () => {
        const provider = await makeProvider({
            name: 'Ibulala Chat',
            slug: 'ibulala-chat',
        });

        const syncResult = await syncProviderProducts(provider._id);
        const persisted = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: 'ibulala_dynamic_coins',
        }).lean();

        expect(syncResult.totalFetched).toBe(1);
        expect(persisted).toMatchObject({
            externalProductId: 'ibulala_dynamic_coins',
            rawName: 'Ibulala Dynamic Coins (Any Amount)',
            rawPrice: '0.00000000001',
            minQty: 1,
            maxQty: 500000000,
            rawPayload: expect.objectContaining({
                price: '0.00000000001',
                product_price: '0.00000000001',
            }),
        });
        expect(persisted.rawPrice).not.toBe('18');
        expect(persisted.rawPayload.product_price).not.toBe('18');
    });

    it('sync/upsert preserves Karak product ID and price', async () => {
        const provider = await makeProvider({
            name: 'Karak Chat',
            slug: 'karak',
        });

        await syncProviderProducts(provider._id);
        const persisted = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: 'karak_dynamic_coins',
        }).lean();

        expect(persisted).toMatchObject({
            externalProductId: 'karak_dynamic_coins',
            rawPrice: '0.00001',
            rawPayload: expect.objectContaining({
                product_price: '0.00001',
            }),
        });
    });

    it('does not auto-upsert a product for unknown Dealer API providers', async () => {
        const provider = await makeProvider({
            name: 'Unknown Dealer App',
            slug: 'unknown-dealer-app',
        });

        const result = await listProviderProducts({ provider: provider._id });

        expect(result.products).toEqual([]);
        await expect(ProviderProduct.countDocuments({ provider: provider._id })).resolves.toBe(0);
    });
});
