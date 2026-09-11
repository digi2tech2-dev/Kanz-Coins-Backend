'use strict';

jest.mock('axios');

const axios = require('axios');
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');

const provider = {
    name: 'Canonical Site',
    slug: 'canonical-site',
    adapterType: 'canonical-b2b',
    baseUrl: 'https://site.example/client/api/',
    apiToken: 'test-provider-token',
};

const makeClient = () => ({ get: jest.fn(), post: jest.fn() });
const makeAdapter = () => {
    const client = makeClient();
    return { adapter: new CanonicalB2BAdapter(provider, { httpClient: client }), client };
};

describe('CanonicalB2BAdapter', () => {
    beforeEach(() => jest.clearAllMocks());

    test('uses the complete configured canonical base URL and api-token header', () => {
        axios.create.mockReturnValue(makeClient());
        new CanonicalB2BAdapter(provider);
        expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'https://site.example/client/api',
            headers: expect.objectContaining({ 'api-token': 'test-provider-token' }),
        }));
    });

    test('gets and normalizes profile balance', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: { balance: '8788.683', email: 'p@example.com', currency: 'USD' } });
        await expect(adapter.getBalance()).resolves.toEqual(expect.objectContaining({
            balance: '8788.683', email: 'p@example.com', currency: 'USD',
        }));
        expect(client.get).toHaveBeenCalledWith('/profile');
    });

    test('maps canonical products with range/fixed quantities and keeps fields in rawPayload', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: [
            { id: 1000, name: 'Range', price: 1.5, currency: 'USD', available: true,
                qty_values: { min: 2, max: 50 }, fields: [{ key: 'player_id' }] },
            { id: 1001, name: 'Package', price: 2, available: false, qty_values: null },
        ] });
        const products = await adapter.getProducts();
        expect(products).toEqual(expect.arrayContaining([
            expect.objectContaining({ externalProductId: '1000', rawName: 'Range', rawPrice: '1.5', minQty: 2, maxQty: 50, isActive: true }),
            expect.objectContaining({ externalProductId: '1001', minQty: 1, maxQty: 1, isActive: false }),
        ]));
        expect(products[0].rawPayload.fields).toEqual([{ key: 'player_id' }]);
        expect(client.get).toHaveBeenCalledWith('/products');
    });

    test('rejects explicit non-USD upstream provider prices', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: [{ id: 1000, name: 'EUR', price: 1, currency: 'EUR' }] });
        await expect(adapter.getProducts()).rejects.toThrow(/USD only/);
    });

    test('posts only canonical purchase fields and reuses the supplied reference', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockResolvedValue({ data: { status: 'OK', data: { order_id: 'ID-1', status: 'wait' } } });
        const result = await adapter.placeOrder({ externalProductId: '1000', quantity: 2, referenceId: 'LOCAL-1', player_id: '123', price: 9, walletBalance: 99 });
        expect(result).toMatchObject({ success: true, providerOrderId: 'ID-1', providerStatus: 'wait' });
        expect(client.post).toHaveBeenCalledWith('/orders', {
            product_id: 1000, qty: 2, order_uuid: 'LOCAL-1', params: { player_id: '123' },
        });
    });

    test('never generates a missing reference ID', async () => {
        const { adapter, client } = makeAdapter();
        const result = await adapter.placeOrder({ externalProductId: '1000', quantity: 1 });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/referenceId/);
        expect(client.post).not.toHaveBeenCalled();
    });

    test('treats deterministic API rejection as a normal failed placement', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockResolvedValue({ data: { status: 'ERROR', code: 100, message: 'Insufficient balance' } });
        const result = await adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'LOCAL-2' });
        expect(result).toMatchObject({ success: false, providerStatus: 'reject', errorMessage: 'Insufficient balance' });
    });

    test('checks known remote IDs without assigning missing results by position', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: { status: 'OK', data: [{ order_id: 'ID-2', status: 'accept' }] } });
        const results = await adapter.checkOrders(['ID-1', 'ID-2']);
        expect(results).toEqual([expect.objectContaining({ providerOrderId: 'ID-2', providerStatus: 'accept' })]);
        expect(client.get).toHaveBeenCalledWith('/check', { params: { orders: 'ID-1,ID-2' } });
    });

    test('recovers an uncertain POST using the same UUID without another POST', async () => {
        const { adapter, client } = makeAdapter();
        const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        client.post.mockRejectedValue(timeout);
        client.get.mockResolvedValue({ data: { status: 'OK', data: [{ order_id: 'ID-9', order_uuid: 'LOCAL-9', status: 'wait' }] } });
        const result = await adapter.placeOrder({ externalProductId: 1000, quantity: 1, referenceId: 'LOCAL-9', player_id: 'x' });
        expect(result).toMatchObject({ success: true, providerOrderId: 'ID-9', providerStatus: 'wait' });
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith('/check', { params: { uuids: 'LOCAL-9' } });
    });

    test('keeps a timeout with no immediate UUID match in explicit uncertain state', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockRejectedValue(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
        client.get.mockResolvedValue({ data: { status: 'OK', data: [] } });
        const result = await adapter.placeOrder({ externalProductId: 1000, quantity: 1, referenceId: 'LOCAL-10' });
        expect(result).toMatchObject({ success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' });
        expect(client.post).toHaveBeenCalledTimes(1);
    });
});
