'use strict';

/**
 * adapters.test.js — Multi-provider Adapter Test Suite
 * ─────────────────────────────────────────────────────
 *
 * Tests the full Provider Adapter Layer without making any real HTTP calls.
 * axios is mocked at the module level so every test is fully deterministic.
 *
 * Test groups:
 *
 *  [1] TorosfonAdapter — getProducts()
 *  [2] TorosfonAdapter — placeOrder()
 *  [3] TorosfonAdapter — checkOrder() / checkOrders()
 *  [4] AlkasrVipAdapter — getProducts()
 *  [5] AlkasrVipAdapter — placeOrder()
 *  [6] AlkasrVipAdapter — checkOrder() / checkOrders()
 *  [7] statusMapper — Toros + Alkasr vocabulary
 *  [8] adapter.factory — slug/name resolution
 *  [9] getProducts + getBalance coverage
 */

jest.mock('axios');

const axios = require('axios');

// ─── Shared mock parts ────────────────────────────────────────────────────────

/**
 * Build a lightweight fake axios instance.
 * Tests override _get / _post per test-case.
 */
const makeFakeAxios = (overrides = {}) => ({
    get: overrides.get ?? jest.fn(),
    post: overrides.post ?? jest.fn(),
    interceptors: {
        response: {
            use: jest.fn((onFulfilled) => { /* store but don't invoke */ }),
        },
    },
});

// axios.create() → return our fake
beforeEach(() => {
    axios.create = jest.fn(() => makeFakeAxios());
});

afterEach(() => {
    jest.clearAllMocks();
});

// ─── Adapter imports ──────────────────────────────────────────────────────────

const { TorosfonAdapter } = require('../modules/providers/adapters/toros.adapter');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { RoyalCrownAdapter } = require('../modules/providers/adapters/royalCrown.adapter');
const { DealerApiAdapter } = require('../modules/providers/adapters/dealerApi.service');
const { getProviderAdapter, registerAdapter } = require('../modules/providers/adapters/adapter.factory');
const { toInternalStatus, isTerminal, requiresRefund } = require('../modules/providers/statusMapper');

// ─── Provider document stubs ──────────────────────────────────────────────────

const torosProvider = {
    name: 'Torosfon Store',
    slug: 'toros',
    baseUrl: 'https://torosfon.example.com',
    apiToken: 'toros-secret',
};

const alkasrProvider = {
    name: 'Alkasr VIP',
    slug: 'alkasr-vip',
    baseUrl: 'https://alkasr.example.com',
    apiToken: 'alkasr-secret',
};

const royalProvider = {
    name: 'Royal Crown',
    slug: 'royal-crown',
    baseUrl: 'https://royal.example.com',
    apiToken: 'royal-secret',
};

const karakProvider = {
    name: 'Karak Chat',
    slug: 'karak',
    baseUrl: 'https://karak.example.com',
    apiToken: 'karak-secret',
};

// Helper: build adapter with a controlled axios client
const makeTorosAdapter = (clientOverrides = {}) => {
    const client = makeFakeAxios(clientOverrides);
    axios.create.mockReturnValueOnce(client);
    const adapter = new TorosfonAdapter(torosProvider);
    adapter._client = client;
    return { adapter, client };
};

const makeAlkasrAdapter = (clientOverrides = {}) => {
    const client = makeFakeAxios(clientOverrides);
    axios.create.mockReturnValueOnce(client);
    const adapter = new AlkasrVipAdapter(alkasrProvider);
    adapter._client = client;
    return { adapter, client };
};

const makeDealerAdapter = (provider = karakProvider, clientOverrides = {}) => {
    const client = makeFakeAxios(clientOverrides);
    axios.create.mockReturnValueOnce(client);
    const adapter = new DealerApiAdapter(provider);
    adapter._client = client;
    return { adapter, client };
};

// ═════════════════════════════════════════════════════════════════════════════
// [1] TorosfonAdapter — getProducts()
// ═════════════════════════════════════════════════════════════════════════════

describe('[1] TorosfonAdapter — getProducts()', () => {
    it('returns normalised DTOs from a plain array response', async () => {
        const raw = [
            { id: 'T1', name: 'Widget', price: 5.50, min_order: 1, max_order: 100, active: true },
            { id: 'T2', name: 'Gadget', price: 12.0, min_order: 2, max_order: 50, active: false },
        ];
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: raw });

        const products = await adapter.getProducts();

        expect(products).toHaveLength(2);
        expect(products[0]).toMatchObject({
            externalProductId: 'T1',
            rawName: 'Widget',
            rawPrice: '5.5',
            minQty: 1,
            maxQty: 100,
            isActive: true,
        });
        expect(products[1].isActive).toBe(false);
    });

    it('unwraps { data: [...] } envelope', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({
            data: {
                data: [{ id: 'TD1', name: 'X', price: 1, min_order: 1, max_order: 10, active: true }],
            },
        });
        const products = await adapter.getProducts();
        expect(products[0].externalProductId).toBe('TD1');
    });

    it('unwraps { products: [...] } envelope', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({
            data: {
                products: [{ id: 'TP1', name: 'Y', price: 2, min_order: 1, max_order: 20, active: true }],
            },
        });
        const products = await adapter.getProducts();
        expect(products[0].externalProductId).toBe('TP1');
    });

    it('getProducts() calls /api/AllProducts', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: [] });
        await adapter.getProducts();
        expect(client.get).toHaveBeenCalledWith('/api/AllProducts');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [2] TorosfonAdapter — placeOrder()
// ═════════════════════════════════════════════════════════════════════════════

describe('[2] TorosfonAdapter — placeOrder()', () => {
    it('returns success result when provider responds with id and status=processing', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({
            data: { id: 500, status: 'processing', product_id: 'T1', quantity: 2 },
        });

        const result = await adapter.placeOrder({
            productId: 'T1',
            amount: 2,
            playerId: 'user123',
            referenceId: 'ref-abc',
        });

        expect(result.success).toBe(true);
        expect(result.providerOrderId).toBe(500);
        expect(result.providerStatus).toBe('Pending');   // normalised
        expect(result.errorMessage).toBeNull();
    });

    it('returns success=true and Completed when status=completed', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: { id: 501, status: 'completed' } });
        const result = await adapter.placeOrder({ productId: 'T1', amount: 1, playerId: 'user123' });
        expect(result.success).toBe(true);
        expect(result.providerStatus).toBe('Completed');
    });

    it('accepts legacy externalProductId + quantity aliases', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: { id: 502, status: 'pending' } });
        const result = await adapter.placeOrder({ externalProductId: 'T99', quantity: 3, playerId: 'user123' });
        expect(result.success).toBe(true);
        expect(result.providerOrderId).toBe(502);
    });

    it('returns success=false when provider responds with success:false', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({
            data: { success: false, message: 'Out of stock' },
        });
        const result = await adapter.placeOrder({ productId: 'T1', amount: 1, playerId: 'user123' });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/out of stock/i);
        expect(result.providerOrderId).toBeNull();
    });

    it('returns success=false when provider returns no order id', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: { status: 'success' } });   // no id
        const result = await adapter.placeOrder({ productId: 'T1', amount: 1, playerId: 'user123' });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/no order id/i);
    });

    it('returns success=false on network error (never throws)', async () => {
        const { adapter, client } = makeTorosAdapter();
        const networkErr = new Error('ECONNREFUSED');
        networkErr.providerBody = null;
        client.get.mockRejectedValueOnce(networkErr);
        const result = await adapter.placeOrder({ productId: 'T1', amount: 1, playerId: 'user123' });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/ECONNREFUSED/);
    });

    it('sends correct GET request to /api/PlaceOrder/{productId}/data', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: { id: 505, status: 'pending' } });
        await adapter.placeOrder({
            productId: 'T2',
            amount: 5,
            playerId: 'player99',
            referenceId: 'ref-xyz',
        });

        expect(client.get).toHaveBeenCalledWith('/api/PlaceOrder/T2/data', {
            params: {
                amount: 5,
                player_Id: 'player99',
                referenceId: 'ref-xyz',
            },
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [3] TorosfonAdapter — checkOrder() / checkOrders()
// ═════════════════════════════════════════════════════════════════════════════

describe('[3] TorosfonAdapter — checkOrder() / checkOrders()', () => {
    it('checkOrder() calls /api/orders/:id and normalises status', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: { id: 600, status: 'completed' } });
        const result = await adapter.checkOrder(600);
        expect(result.providerOrderId).toBe(600);
        expect(result.providerStatus).toBe('Completed');
        expect(client.get).toHaveBeenCalledWith('/api/CheckOrder', { params: { order_id: 600 } });
    });

    it('checkOrder() maps toros "failed" → Cancelled', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({ data: { id: 601, status: 'failed' } });
        const result = await adapter.checkOrder(601);
        expect(result.providerStatus).toBe('Cancelled');
    });

    it('checkOrders() POSTs to /api/orders/batch-status and returns array', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({
            data: {
                700: { status: 'completed' },
                701: { status: 'processing' },
            },
        });

        const results = await adapter.checkOrders([700, 701]);
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ providerOrderId: 700, providerStatus: 'Completed' });
        expect(results[1]).toMatchObject({ providerOrderId: 701, providerStatus: 'Pending' });
        expect(client.get).toHaveBeenCalledWith('/api/CheckListOrders', { params: { orders: JSON.stringify([700, 701]) } });
    });

    it('checkOrders() returns [] for empty input', async () => {
        const { adapter } = makeTorosAdapter();
        const results = await adapter.checkOrders([]);
        expect(results).toEqual([]);
    });

    it('checkOrders() unwraps { orders: [...] } envelope', async () => {
        const { adapter, client } = makeTorosAdapter();
        client.get.mockResolvedValueOnce({
            data: { orders: [{ id: 800, status: 'done' }] },
        });
        const results = await adapter.checkOrders([800]);
        expect(results[0].providerStatus).toBe('Completed');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [4] AlkasrVipAdapter — getProducts()
// ═════════════════════════════════════════════════════════════════════════════

describe('[4] AlkasrVipAdapter — getProducts()', () => {
    it('returns normalised DTOs from { services: [...] } response', async () => {
        const raw = {
            services: [
                {
                    service_id: 'A1',
                    service_name: 'Alkasr Package',
                    cost_per_unit: 7.25,
                    min: 1,
                    max: 200,
                    is_active: true,
                },
            ],
        };
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: raw });

        const products = await adapter.getProducts();
        expect(products).toHaveLength(1);
        expect(products[0]).toMatchObject({
            externalProductId: 'A1',
            rawName: 'Alkasr Package',
            rawPrice: '7.25',
            minQty: 1,
            maxQty: 200,
            isActive: true,
        });
    });

    it('returns normalised DTOs from a plain array', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({
            data: [{ service_id: 'A2', service_name: 'X', cost_per_unit: 1, min: 1, max: 50 }],
        });
        const products = await adapter.getProducts();
        expect(products[0].externalProductId).toBe('A2');
    });

    it('calls GET /client/api/products', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: [] });
        await adapter.getProducts();
        expect(client.get).toHaveBeenCalledWith('/client/api/products');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [5] AlkasrVipAdapter — placeOrder()
// ═════════════════════════════════════════════════════════════════════════════

describe('[5] AlkasrVipAdapter — placeOrder()', () => {
    it('returns success=true when Alkasr status=wait (→ Pending / still processing)', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({
            data: { order_id: 1001, status: 'wait' },
        });

        const result = await adapter.placeOrder({
            productId: 'A1',
            amount: 3,
            playerId: 'uid999',
            referenceId: 'our-ref-1',
        });

        expect(result.success).toBe(true);
        expect(result.providerOrderId).toBe('1001');
        expect(result.providerStatus).toBe('Pending');   // wait → Pending
        expect(result.errorMessage).toBeNull();
    });

    it('returns success=true when Alkasr status=accept (→ Completed)', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: { order_id: 1002, status: 'accept' } });
        const result = await adapter.placeOrder({ productId: 'A1', amount: 1, playerId: 'uid999' });
        expect(result.success).toBe(true);
        expect(result.providerStatus).toBe('Completed');
    });

    it('returns success=false when Alkasr status=reject', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({
            data: { status: 'reject', message: 'Invalid uid' },
        });
        const result = await adapter.placeOrder({ productId: 'A1', amount: 1, playerId: 'bad' });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/Invalid uid/);
        expect(result.providerOrderId).toBeNull();
    });

    it('returns success=false when order_id is absent from response', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: { status: 'wait' } });   // no order_id
        const result = await adapter.placeOrder({ productId: 'A1', amount: 1, playerId: 'uid999' });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/no order id/i);
    });

    it('returns success=false on network error (never throws)', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        const err = new Error('Timeout');
        err.providerBody = null;
        client.get.mockRejectedValueOnce(err);
        const result = await adapter.placeOrder({ productId: 'A1', amount: 1, playerId: 'uid999' });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/Timeout/);
    });

    it('sends correct GET params to /client/api/newOrder/{productId}/params', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: { order_id: 1005, status: 'wait' } });

        await adapter.placeOrder({
            productId: 'A3',
            amount: 7,
            playerId: 'uid555',
            referenceId: 'ref-7',
        });

        expect(client.get).toHaveBeenCalledWith('/client/api/newOrder/A3/params', {
            params: expect.objectContaining({
                qty: 7,
                playerId: 'uid555',
            }),
        });
    });

    it('refuses to call provider when playerId is absent', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        const result = await adapter.placeOrder({ productId: 'A4', amount: 2 });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/Missing provider target/);
        expect(client.get).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [6] AlkasrVipAdapter — checkOrder() / checkOrders()
// ═════════════════════════════════════════════════════════════════════════════

describe('[6] AlkasrVipAdapter — checkOrder() / checkOrders()', () => {
    it('checkOrder() maps "accepted" → Completed', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: { order_id: 2001, status: 'accepted' } });
        const result = await adapter.checkOrder(2001);
        expect(result.providerOrderId).toBe('2001');
        expect(result.providerStatus).toBe('Completed');
        expect(client.get).toHaveBeenCalledWith('/client/api/check', { params: { orders: JSON.stringify([2001]) } });
    });

    it('checkOrder() maps "waiting" → Pending', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: { order_id: 2002, status: 'waiting' } });
        const result = await adapter.checkOrder(2002);
        expect(result.providerStatus).toBe('Pending');
    });

    it('checkOrder() maps "rejected" → Cancelled', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({ data: { order_id: 2003, status: 'rejected' } });
        const result = await adapter.checkOrder(2003);
        expect(result.providerStatus).toBe('Cancelled');
    });

    it('checkOrders() GETs /client/api/check', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        client.get.mockResolvedValueOnce({
            data: [
                { order_id: 3001, status: 'accept' },
                { order_id: 3002, status: 'reject' },
            ],
        });
        const results = await adapter.checkOrders([3001, 3002]);
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ providerOrderId: '3001', providerStatus: 'Completed' });
        expect(results[1]).toMatchObject({ providerOrderId: '3002', providerStatus: 'Cancelled' });
        expect(client.get).toHaveBeenCalledWith('/client/api/check', { params: { orders: JSON.stringify([3001, 3002]) } });
    });

    it('checkOrders() returns [] for empty input', async () => {
        const { adapter } = makeAlkasrAdapter();
        expect(await adapter.checkOrders([])).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('DealerApiAdapter - Karak dynamic coins', () => {
    it('returns the mocked dynamic coins product for Karak without an HTTP catalog request', async () => {
        const { adapter, client } = makeDealerAdapter();

        const products = await adapter.getProducts();

        expect(products).toEqual([expect.objectContaining({
            externalProductId: 'karak_dynamic_coins',
            rawName: 'Karak Dynamic Coins (Any Amount)',
            rawPrice: '0.00001',
            price: '0.00001',
            costPrice: '0.00001',
            minQty: 1,
            maxQty: 5000000,
            isActive: true,
            rawPayload: expect.objectContaining({
                id: 'karak_dynamic_coins',
                name: 'Karak Dynamic Coins (Any Amount)',
                price: '0.00001',
                product_price: '0.00001',
                currency: 'USD',
            }),
        })]);
        expect(client.get).not.toHaveBeenCalled();
    });

    it('maps the dynamic product quantity to sale coins and sends query params', async () => {
        const { adapter, client } = makeDealerAdapter();
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
                secretKey: 'karak-secret',
                toUserId: 123456,
                coins: 2500,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
    });
});

// [7] statusMapper — full vocabulary (Toros + Alkasr + canonical)
// ═════════════════════════════════════════════════════════════════════════════

describe('[7] statusMapper — Toros + Alkasr + canonical vocabulary', () => {
    // ── toInternalStatus ──────────────────────────────────────────────────────

    const COMPLETED = 'COMPLETED';
    const PROCESSING = 'PROCESSING';
    const FAILED = 'FAILED';
    const CANCELED = 'CANCELED';

    it.each([
        ['Completed', COMPLETED],
        ['completed', COMPLETED],
        ['success', COMPLETED],
        ['done', COMPLETED],
        ['accept', COMPLETED],
        ['accepted', COMPLETED],
    ])('"%s" → COMPLETED', (status, expected) => {
        expect(toInternalStatus(status)).toBe(expected);
    });

    it.each([
        ['Pending', PROCESSING],
        ['pending', PROCESSING],
        ['processing', PROCESSING],
        ['in_progress', PROCESSING],
        ['in_process', PROCESSING],
        ['queued', PROCESSING],
        ['wait', PROCESSING],
        ['waiting', PROCESSING],
    ])('"%s" → PROCESSING', (status, expected) => {
        expect(toInternalStatus(status)).toBe(expected);
    });

    it.each([
        ['Cancelled', CANCELED],
        ['cancelled', CANCELED],
        ['canceled', CANCELED],
        ['cancel', CANCELED],
    ])('"%s" → CANCELED', (status, expected) => {
        expect(toInternalStatus(status)).toBe(expected);
    });

    it.each([
        ['failed', FAILED],
        ['rejected', FAILED],
        ['error', FAILED],
        ['reject', FAILED],
    ])('"%s" → FAILED', (status, expected) => {
        expect(toInternalStatus(status)).toBe(expected);
    });

    it('defaults completely unknown status to PROCESSING for retry safety', () => {
        expect(toInternalStatus('ZOMBIE_STATUS')).toBe(PROCESSING);
    });

    // ── isTerminal ────────────────────────────────────────────────────────────

    it.each(['Completed', 'Cancelled', 'failed', 'accept', 'rejected', 'success', 'done', 'error'])(
        'isTerminal("%s") is true', (s) => expect(isTerminal(s)).toBe(true)
    );

    it.each(['Pending', 'pending', 'processing', 'wait', 'waiting', 'queued', 'in_process'])(
        'isTerminal("%s") is false', (s) => expect(isTerminal(s)).toBe(false)
    );

    // ── requiresRefund ────────────────────────────────────────────────────────

    it.each(['Cancelled', 'canceled', 'failed', 'reject', 'rejected', 'cancel', 'error'])(
        'requiresRefund("%s") is true', (s) => expect(requiresRefund(s)).toBe(true)
    );

    it.each(['Completed', 'success', 'done', 'accept', 'Pending', 'wait'])(
        'requiresRefund("%s") is false', (s) => expect(requiresRefund(s)).toBe(false)
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// [8] adapter.factory — slug/name resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('[8] adapter.factory — resolution', () => {
    const makeAxiosForFactory = () => {
        const client = makeFakeAxios();
        axios.create.mockReturnValue(client);
    };

    beforeEach(() => makeAxiosForFactory());

    it('resolves TorosfonAdapter by slug "toros"', () => {
        const adapter = getProviderAdapter({
            slug: 'toros', name: 'Torosfon Store',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(TorosfonAdapter);
    });

    it('resolves TorosfonAdapter by slug "torosfon"', () => {
        const adapter = getProviderAdapter({
            slug: 'torosfon', name: 'Torosfon Store',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(TorosfonAdapter);
    });

    it('resolves TorosfonAdapter by name "torosfon store" (no slug)', () => {
        const adapter = getProviderAdapter({
            slug: '', name: 'Torosfon Store',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(TorosfonAdapter);
    });

    it('resolves AlkasrVipAdapter by slug "alkasr-vip"', () => {
        const adapter = getProviderAdapter({
            slug: 'alkasr-vip', name: 'Alkasr VIP',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(AlkasrVipAdapter);
    });

    it('resolves AlkasrVipAdapter by slug "alkasr"', () => {
        const adapter = getProviderAdapter({
            slug: 'alkasr', name: 'Alkasr VIP',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(AlkasrVipAdapter);
    });

    it('resolves AlkasrVipAdapter by name "alkasr vip" (no slug)', () => {
        const adapter = getProviderAdapter({
            slug: '', name: 'Alkasr VIP',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(AlkasrVipAdapter);
    });

    it('resolves RoyalCrownAdapter by slug "royal-crown"', () => {
        const adapter = getProviderAdapter({
            slug: 'royal-crown', name: 'Royal Crown',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(RoyalCrownAdapter);
    });

    it('resolves DealerApiAdapter by Karak slug', () => {
        const adapter = getProviderAdapter({
            slug: 'karak', name: 'Karak Chat',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(DealerApiAdapter);
    });

    it('falls back to MockProviderAdapter for unknown slug (non-strict)', () => {
        const { MockProviderAdapter } = require('../modules/providers/adapters/mock.adapter');
        const adapter = getProviderAdapter({ slug: 'unknown-x', name: 'Random', baseUrl: 'https://x.com', apiToken: 'tok' });
        expect(adapter).toBeInstanceOf(MockProviderAdapter);
    });

    it('throws UNSUPPORTED_PROVIDER in strict mode for unknown provider', () => {
        expect(() =>
            getProviderAdapter(
                { slug: 'ghost', name: 'Ghost', baseUrl: 'https://x.com', apiToken: 'tok' },
                { strict: true }
            )
        ).toThrow(/UNSUPPORTED_PROVIDER/);
    });

    it('registerAdapter() adds a new provider at runtime', () => {
        const { MockProviderAdapter } = require('../modules/providers/adapters/mock.adapter');
        registerAdapter('custom-provider', MockProviderAdapter);
        const adapter = getProviderAdapter({
            slug: 'custom-provider', name: 'Custom',
            baseUrl: 'https://x.com', apiToken: 'tok',
        });
        expect(adapter).toBeInstanceOf(MockProviderAdapter);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [9] getBalance coverage
// ═════════════════════════════════════════════════════════════════════════════

describe('[9] getBalance()', () => {
    it('TorosfonAdapter.getBalance() calls /api/GetMyInfo', async () => {
        const { adapter, client } = makeTorosAdapter();
        const balanceData = { balance: 500.00, currency: 'USD' };
        client.get.mockResolvedValueOnce({ data: balanceData });
        const result = await adapter.getBalance();
        expect(result).toEqual(balanceData);
        expect(client.get).toHaveBeenCalledWith('/api/GetMyInfo');
    });

    it('AlkasrVipAdapter.getBalance() calls /client/api/profile', async () => {
        const { adapter, client } = makeAlkasrAdapter();
        const info = { balance: 1000, username: 'alkasrvip_user' };
        client.get.mockResolvedValueOnce({ data: info });
        const result = await adapter.getBalance();
        expect(result).toEqual(info);
        expect(client.get).toHaveBeenCalledWith('/client/api/profile');
    });
});
