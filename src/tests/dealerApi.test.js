'use strict';

jest.mock('axios', () => ({
    create: jest.fn(),
}));

const axios = require('axios');
const {
    DealerApiAdapter,
    KARAK_DYNAMIC_PRODUCT_ID,
    buildKarakDynamicProductDto,
    isKarakProvider,
    getDealerDynamicApp,
    getDealerDynamicProduct,
    isDealerDynamicProvider,
} = require('../modules/providers/adapters/dealerApi.service');
const { normalizeProviderDecimalPrice } = require('../shared/utils/decimalPrecision');

const makeFakeAxios = (overrides = {}) => ({
    get: overrides.get ?? jest.fn(),
    post: overrides.post ?? jest.fn(),
    interceptors: {
        response: {
            use: jest.fn(),
        },
    },
});

const makeProvider = (overrides = {}) => ({
    name: 'Dealer API',
    slug: 'dealer-api',
    baseUrl: 'https://dealer.example.test',
    apiToken: 'test-secret',
    ...overrides,
});

const makeAdapter = (providerOverrides = {}, clientOverrides = {}) => {
    const client = makeFakeAxios(clientOverrides);
    axios.create.mockReturnValueOnce(client);

    const adapter = new DealerApiAdapter(makeProvider(providerOverrides));
    adapter._client = client;

    return { adapter, client };
};

const expectedDynamicProduct = (
    id,
    name,
    { price = '0.00001', maxQty = 5000000 } = {}
) => ({
    id,
    name,
    externalProductId: id,
    rawName: name,
    price,
    rawPrice: price,
    costPrice: price,
    providerPrice: price,
    minQty: 1,
    maxQty,
    isActive: true,
    rawPayload: {
        id,
        product_id: id,
        name,
        product_name: name,
        price,
        product_price: price,
        minQty: 1,
        maxQty,
        currency: 'USD',
    },
});

describe('normalizeProviderDecimalPrice', () => {
    it('preserves plain tiny decimal strings', () => {
        expect(normalizeProviderDecimalPrice('0.00000001')).toBe('0.00000001');
    });

    it('normalizes tiny decimal numbers without returning 18', () => {
        const normalized = normalizeProviderDecimalPrice(0.00000001);

        expect(normalized).toBe('0.00000001');
        expect(normalized).not.toBe('18');
    });

    it('expands scientific notation safely', () => {
        expect(normalizeProviderDecimalPrice('1e-8')).toBe('0.00000001');
    });
});

describe('DealerApiAdapter dynamic products', () => {
    beforeEach(() => {
        axios.create.mockReset();
        axios.create.mockImplementation(() => makeFakeAxios());
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it.each([
        ['slug: karak', { slug: 'karak' }],
        ['slug: karak-chat', { slug: 'karak-chat' }],
        ['name: Karak Chat', { slug: '', name: 'Karak Chat' }],
    ])('returns Karak dynamic product for %s', async (_label, providerOverrides) => {
        const { adapter, client } = makeAdapter(providerOverrides);

        const products = await adapter.getProducts();

        expect(products).toEqual([
            expect.objectContaining(expectedDynamicProduct(
                'karak_dynamic_coins',
                'Karak Dynamic Coins (Any Amount)'
            )),
        ]);
        expect(client.get).not.toHaveBeenCalled();
    });

    it.each([
        ['slug: ibulala', { slug: 'ibulala' }],
        ['slug: ibulala-chat', { slug: 'ibulala-chat' }],
        ['name: Ibulala Chat', { slug: '', name: 'Ibulala Chat' }],
    ])('returns Ibulala dynamic product for %s', async (_label, providerOverrides) => {
        const { adapter, client } = makeAdapter(providerOverrides);

        const products = await adapter.getProducts();

        expect(products).toEqual([
            expect.objectContaining(expectedDynamicProduct(
                'ibulala_dynamic_coins',
                'Ibulala Dynamic Coins (Any Amount)',
                { price: '0.00000000001', maxQty: 500000000 }
            )),
        ]);
        expect(client.get).not.toHaveBeenCalled();
    });

    it('returns an empty product list for unknown Dealer API providers', async () => {
        const { adapter } = makeAdapter({ slug: 'dealer-api', name: 'Unknown Dealer App' });

        await expect(adapter.getProducts()).resolves.toEqual([]);
    });

    it('keeps isKarakProvider backward compatible and Karak-only', () => {
        expect(KARAK_DYNAMIC_PRODUCT_ID).toBe('karak_dynamic_coins');
        expect(isKarakProvider({ slug: 'karak' })).toBe(true);
        expect(isKarakProvider({ slug: 'karak-chat' })).toBe(true);
        expect(isKarakProvider({ name: 'Karak Chat' })).toBe(true);
        expect(isKarakProvider({ slug: 'ibulala' })).toBe(false);
        expect(isKarakProvider({ name: 'Ibulala Chat' })).toBe(false);
        expect(buildKarakDynamicProductDto()).toEqual(expect.objectContaining(
            expectedDynamicProduct('karak_dynamic_coins', 'Karak Dynamic Coins (Any Amount)')
        ));
    });

    it('detects both Karak and Ibulala with generic helpers', () => {
        expect(getDealerDynamicApp({ providerCode: 'Karak Chat' })?.key).toBe('karak');
        expect(getDealerDynamicApp({ code: 'ibulalachat' })?.key).toBe('ibulala');
        expect(getDealerDynamicProduct({ slug: 'ibulala-chat' })?.id).toBe('ibulala_dynamic_coins');
        expect(getDealerDynamicProduct({ slug: 'ibulala-chat' })?.price).toBe('0.00000000001');
        expect(isDealerDynamicProvider({ name: 'Ibulala Chat' })).toBe(true);
        expect(isDealerDynamicProvider({ name: 'Unknown Dealer App' })).toBe(false);
    });

    it('uses processSale successfully for the Karak dynamic product', async () => {
        const { adapter, client } = makeAdapter({ slug: 'karak', name: 'Karak Chat' });
        client.post.mockResolvedValueOnce({ data: { code: '200', data: { saleId: 'S-1' } } });

        const result = await adapter.placeOrder({
            providerProductId: 'karak_dynamic_coins',
            quantity: '2500',
            playerId: '123456',
            referenceId: 'ORDER-1',
        });

        expect(result.success).toBe(true);
        expect(client.post).toHaveBeenCalledWith('/dealer/sale', null, {
            params: {
                secretKey: 'test-secret',
                toUserId: 123456,
                coins: 2500,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
    });

    it('uses processSale successfully for the Ibulala dynamic product', async () => {
        const { adapter, client } = makeAdapter({
            slug: 'ibulala-chat',
            name: 'Ibulala Chat',
            apiToken: 'ibulala-secret',
        });
        client.post.mockResolvedValueOnce({ data: { code: '200', data: { saleId: 'S-2' } } });

        const result = await adapter.placeOrder({
            providerProductId: 'ibulala_dynamic_coins',
            quantity: '1200',
            uid: '98765',
            referenceId: 'ORDER-2',
        });

        expect(result.success).toBe(true);
        expect(client.post).toHaveBeenCalledWith('/dealer/sale', null, {
            params: {
                secretKey: 'ibulala-secret',
                toUserId: 98765,
                coins: 1200,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
    });
});
