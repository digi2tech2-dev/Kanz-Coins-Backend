'use strict';

const http = require('http');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
    freshUser,
    countTransactions,
    USER_STATUS,
} = require('./testHelpers');
const { Category } = require('../modules/categories/category.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { mapProduct } = require('../modules/clientCompat/clientCompat.mappers');

let app;
let server;
let baseUrl;

const rawGet = (path, headers = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method: 'GET', headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            body += chunk;
        });
        res.on('end', () => {
            let json = null;
            try {
                json = body ? JSON.parse(body) : null;
            } catch (err) {
                return reject(err);
            }

            return resolve({
                status: res.statusCode,
                headers: res.headers,
                body: json,
                raw: body,
            });
        });
    });

    req.on('error', reject);
    req.end();
});

const authHeaders = (token, header = 'api-token') => {
    if (header === 'authorization') {
        return { Authorization: `Bearer ${token}` };
    }
    return { [header]: token };
};

const createApiReseller = async ({
    token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userOverrides = {},
    groupOverrides = {},
} = {}) => {
    const { customer, group } = await createCustomerWithGroup(
        {
            apiToken: token,
            isApiEnabled: true,
            walletBalance: 100,
            creditLimit: 0,
            creditUsed: 0,
            currency: 'USD',
            ...userOverrides,
        },
        {
            percentage: 0,
            isActive: true,
            ...groupOverrides,
        }
    );

    return { reseller: customer, group, token };
};

const createCompatCategory = (overrides = {}) => Category.create({
    name: `Category-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    image: 'images/category/test.webp',
    ...overrides,
});

const createCompatProduct = (overrides = {}) => createProduct({
    name: `Compat Product ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    basePrice: '10',
    minQty: 1,
    maxQty: 1,
    executionType: 'manual',
    orderFields: [
        {
            id: 'player',
            key: 'player_id',
            label: 'Player ID',
            type: 'text',
            required: true,
            isActive: true,
        },
    ],
    ...overrides,
});

const CUSTOMER_PRICE_FIELDS = ['price', 'cost', 'rate', 'api_price', 'provider_price'];
const BASE_PRICE_FIELDS = ['base_price', 'original_price'];
const MINIMAL_PRODUCT_FIELDS = [
    'id',
    'name',
    ...CUSTOMER_PRICE_FIELDS,
    ...BASE_PRICE_FIELDS,
    'currency',
];
const HEAVY_PRODUCT_FIELDS = [
    'params',
    'category_img',
    'category_name',
    'available',
    'qty_values',
    'product_type',
    'parent_id',
    'min',
    'max',
    'minQty',
    'maxQty',
    'min_quantity',
    'max_quantity',
];

const expectNumericPriceFields = (product, { price, basePrice, currency = 'USD' } = {}) => {
    for (const field of CUSTOMER_PRICE_FIELDS) {
        expect(typeof product[field]).toBe('number');
        expect(Number.isFinite(product[field])).toBe(true);
        if (price !== undefined) expect(product[field]).toBe(price);
    }

    for (const field of BASE_PRICE_FIELDS) {
        expect(typeof product[field]).toBe('number');
        expect(Number.isFinite(product[field])).toBe(true);
        if (basePrice !== undefined) expect(product[field]).toBe(basePrice);
    }

    expect(product.currency).toBe(currency);
};

const expectMinimalProductShape = (product) => {
    expect(Object.keys(product)).toEqual(MINIMAL_PRODUCT_FIELDS);
    for (const field of HEAVY_PRODUCT_FIELDS) {
        expect(product).not.toHaveProperty(field);
    }
};

beforeAll(async () => {
    await connectTestDB();
    app = require('../app');
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('Client compatibility API authentication and profile', () => {
    test('returns compatibility auth error codes', async () => {
        let res = await rawGet('/client/api/profile');
        expect(res.status).toBe(401);
        expect(res.body).toEqual({
            status: 'ERROR',
            code: 120,
            message: 'API Token is required',
        });

        res = await rawGet('/client/api/profile', authHeaders('bad-token'));
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(121);

        const { token } = await createApiReseller({
            token: 'disabled-token',
            userOverrides: { isApiEnabled: false },
        });
        res = await rawGet('/client/api/profile', authHeaders(token));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(122);

        const inactive = await createApiReseller({
            token: 'inactive-token',
            userOverrides: { status: USER_STATUS.REJECTED },
        });
        res = await rawGet('/client/api/profile', authHeaders(inactive.token));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(122);
    });

    test('accepts supported token headers and returns flat profile shape', async () => {
        const { reseller, token } = await createApiReseller({
            token: 'profile-token',
            userOverrides: {
                walletBalance: 100,
                creditLimit: 50,
                creditUsed: 10,
            },
        });

        for (const header of ['api-token', 'x-api-key', 'authorization']) {
            const res = await rawGet('/client/api/profile', authHeaders(token, header));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                balance: '150',
                email: reseller.email,
            });
        }

        const aliasRes = await rawGet('/api/client/api/profile', authHeaders(token));
        expect(aliasRes.status).toBe(200);
        expect(aliasRes.body).toEqual({
            balance: '150',
            email: reseller.email,
        });
    });
});

describe('Client compatibility API products and content', () => {
    test('lists, filters, and minimizes products with numeric compatibility IDs', async () => {
        const { token } = await createApiReseller({ token: 'products-token' });
        const category = await createCompatCategory({
            name: 'PUBG Global ID UC',
            image: 'images/category/1710948113.webp',
        });
        const packageProduct = await createCompatProduct({
            name: 'UC 60',
            category: category._id.toString(),
        });
        const amountProduct = await createCompatProduct({
            name: 'UC Custom Amount',
            category: category._id.toString(),
            minQty: 1,
            maxQty: 50,
        });
        await createCompatProduct({
            name: 'Hidden Product',
            isActive: false,
        });

        const res = await rawGet('/client/api/products', authHeaders(token));
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);

        const mappedPackage = res.body.find((item) => item.name === 'UC 60');
        expect(Number.isInteger(mappedPackage.id)).toBe(true);
        expect(mappedPackage.id).toBe(packageProduct.compatProductId);
        expect(mappedPackage.price).toBe(10);
        expect(mappedPackage.cost).toBe(10);
        expect(mappedPackage.rate).toBe(10);
        expect(mappedPackage.api_price).toBe(10);
        expect(mappedPackage.provider_price).toBe(10);
        expectNumericPriceFields(mappedPackage, { price: 10, basePrice: 10 });
        expect(mappedPackage.params).toEqual(['Player ID']);
        expect(mappedPackage.category_name).toBe('PUBG Global ID UC');
        expect(mappedPackage.available).toBe(true);
        expect(mappedPackage.qty_values).toBeNull();
        expect(mappedPackage.product_type).toBe('package');
        expect(mappedPackage.parent_id).toBe(category.compatCategoryId);
        expect(mappedPackage.base_price).toBe(10);
        expect(mappedPackage.original_price).toBe(10);
        expect(mappedPackage.currency).toBe('USD');
        expect(mappedPackage.category_img).toBe('images/category/1710948113.webp');
        expect(mappedPackage).toMatchObject({
            min: 1,
            max: 1,
            minQty: 1,
            maxQty: 1,
            min_quantity: 1,
            max_quantity: 1,
        });

        const mappedAmount = res.body.find((item) => item.name === 'UC Custom Amount');
        expect(mappedAmount.id).toBe(amountProduct.compatProductId);
        expect(mappedAmount.qty_values).toEqual({ min: '1', max: '50' });
        expect(mappedAmount.product_type).toBe('amount');
        expect(mappedAmount).toMatchObject({
            min: 1,
            max: 50,
            minQty: 1,
            maxQty: 50,
            min_quantity: 1,
            max_quantity: 50,
        });

        const filtered = await rawGet(
            `/client/api/products?products_id=${amountProduct.compatProductId},,bad`,
            authHeaders(token)
        );
        expect(filtered.status).toBe(200);
        expect(filtered.body).toHaveLength(1);
        expect(filtered.body[0].id).toBe(amountProduct.compatProductId);

        const minimal = await rawGet(
            `/client/api/products?products_id=${packageProduct.compatProductId}&base=1`,
            authHeaders(token)
        );
        expect(minimal.status).toBe(200);
        expect(minimal.body).toEqual([
            {
                id: packageProduct.compatProductId,
                name: 'UC 60',
                price: 10,
                cost: 10,
                rate: 10,
                api_price: 10,
                provider_price: 10,
                base_price: 10,
                original_price: 10,
                currency: 'USD',
            },
        ]);
        expectMinimalProductShape(minimal.body[0]);
        expectNumericPriceFields(minimal.body[0], { price: 10, basePrice: 10 });

        const minimalFiltered = await rawGet(
            `/client/api/products?base=1&products_id=${packageProduct.compatProductId},${amountProduct.compatProductId}`,
            authHeaders(token)
        );
        expect(minimalFiltered.status).toBe(200);
        expect(minimalFiltered.body).toHaveLength(2);
        expect(minimalFiltered.body.map((item) => item.id).sort((a, b) => a - b)).toEqual([
            packageProduct.compatProductId,
            amountProduct.compatProductId,
        ].sort((a, b) => a - b));
        for (const product of minimalFiltered.body) {
            expectMinimalProductShape(product);
            expectNumericPriceFields(product, { price: 10, basePrice: 10 });
        }

        const aliasMinimal = await rawGet(
            `/api/client/api/products?base=1&products_id=${packageProduct.compatProductId}`,
            authHeaders(token)
        );
        expect(aliasMinimal.status).toBe(200);
        expect(aliasMinimal.body).toEqual(minimal.body);
    });

    test('returns root and category content without exposing legacy /api/client behavior', async () => {
        const { token } = await createApiReseller({ token: 'content-token' });
        const category = await createCompatCategory({ name: 'Root Category' });
        const rootProduct = await createCompatProduct({
            name: 'Root Product',
            basePrice: '12',
            minQty: 2,
            maxQty: 25,
        });
        const product = await createCompatProduct({
            name: 'Category Product',
            category: category._id.toString(),
        });

        const root = await rawGet('/client/api/content/0', authHeaders(token));
        expect(root.status).toBe(200);
        expect(root.body.status).toBe('OK');
        expect(root.body.data.categories).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: category.compatCategoryId,
                name: 'Root Category',
                parent_id: 0,
                available: true,
            }),
        ]));
        expect(root.body.data.products).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: rootProduct.compatProductId,
                name: 'Root Product',
                price: 12,
                cost: 12,
                rate: 12,
                api_price: 12,
                provider_price: 12,
                base_price: 12,
                original_price: 12,
                currency: 'USD',
                qty_values: { min: '2', max: '25' },
                min: 2,
                max: 25,
                minQty: 2,
                maxQty: 25,
                min_quantity: 2,
                max_quantity: 25,
            }),
        ]));

        const categoryContent = await rawGet(
            `/client/api/content/${category.compatCategoryId}`,
            authHeaders(token)
        );
        expect(categoryContent.status).toBe(200);
        expect(categoryContent.body.data.products).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: product.compatProductId,
                name: 'Category Product',
                parent_id: category.compatCategoryId,
                cost: 10,
                rate: 10,
                api_price: 10,
                provider_price: 10,
                original_price: 10,
                currency: 'USD',
            }),
        ]));

        const legacy = await rawGet('/api/client/products', authHeaders(token));
        expect(legacy.status).toBe(200);
        expect(legacy.body.success).toBe(true);
        expect(Array.isArray(legacy.body.data)).toBe(true);
        expect(typeof legacy.body.data[0].id).toBe('string');
    });

    test('mapper keeps fixed quantity lists and adds list aliases', () => {
        const mapped = mapProduct({
            product: {
                compatProductId: 365,
                name: 'Fixed List Product',
                isActive: true,
                qty_values: [100, 500, 1000],
            },
            category: null,
            price: '1.2345678',
            priceUsd: '1.1',
            currency: 'egp',
        });

        expect(mapped.qty_values).toEqual([100, 500, 1000]);
        expect(mapped.allowed_quantities).toEqual([100, 500, 1000]);
        expect(mapped.quantities).toEqual([100, 500, 1000]);
        expect(mapped.price).toBe(1.234568);
        expect(mapped.cost).toBe(1.234568);
        expect(mapped.original_price).toBe(1.1);
        expect(mapped.currency).toBe('EGP');
    });

    test('mapper keeps minimal product price aliases numeric and finite', () => {
        const mapped = mapProduct({
            product: {
                compatProductId: 366,
                name: 'Invalid Price Product',
            },
            category: null,
            price: 'not-a-number',
            priceUsd: undefined,
            currency: '',
            minimal: true,
        });

        expect(mapped).toEqual({
            id: 366,
            name: 'Invalid Price Product',
            price: 0,
            cost: 0,
            rate: 0,
            api_price: 0,
            provider_price: 0,
            base_price: 0,
            original_price: 0,
            currency: 'USD',
        });
        expectMinimalProductShape(mapped);
        expectNumericPriceFields(mapped, { price: 0, basePrice: 0 });
    });
});

describe('Client compatibility API orders', () => {
    test('creates orders through GET and idempotent retries do not double debit', async () => {
        const { reseller, token } = await createApiReseller({ token: 'order-token' });
        const product = await createCompatProduct({
            name: 'Order Product',
            minQty: 1,
            maxQty: 5,
            orderFields: [
                {
                    id: 'player',
                    key: 'player_id',
                    label: 'Player ID',
                    type: 'text',
                    required: true,
                    isActive: true,
                },
                {
                    id: 'server',
                    key: 'server',
                    label: 'Server',
                    type: 'text',
                    required: false,
                    isActive: true,
                },
            ],
        });

        const path = `/client/api/newOrder/${product.compatProductId}/params?qty=1&playerId=test-player&server=EU&order_uuid=uuid-order-1`;
        const first = await rawGet(path, authHeaders(token));
        expect(first.status).toBe(200);
        expect(first.headers['cache-control']).toContain('no-store');
        expect(first.body.status).toBe('OK');
        expect(first.body.data.order_id).toMatch(/^ID_[a-f0-9]{16}$/);
        expect(first.body.data.status).toBe('wait');
        expect(first.body.data.price).toBe(10);
        expect(first.body.data.data).toEqual({
            player_id: 'test-player',
            server: 'EU',
        });
        expect(first.body.data.replay_api).toBeNull();

        const second = await rawGet(path, authHeaders(token));
        expect(second.status).toBe(200);
        expect(second.body.data.order_id).toBe(first.body.data.order_id);

        const reloaded = await freshUser(reseller._id);
        expect(reloaded.walletBalance).toBe(90);
        expect(await countTransactions(reseller._id)).toBe(1);
        expect(await Order.countDocuments({ userId: reseller._id })).toBe(1);
    });

    test('maps Arabic display target key to player_id and ignores reseller metadata', async () => {
        const { reseller, token } = await createApiReseller({ token: 'arabic-playerid-token' });
        const product = await createCompatProduct({
            name: 'Arabic PlayerId Product',
            basePrice: '0.00001',
            minQty: 1,
            maxQty: 500000,
            orderFields: [
                {
                    id: 'player',
                    key: 'player_id',
                    label: 'Player ID',
                    type: 'text',
                    required: true,
                    isActive: true,
                },
            ],
        });

        const path = `/client/api/newOrder/${product.compatProductId}/params`
            + `?qty=150000&${encodeURIComponent('ايدي المستخدم')}=10026`
            + '&ourPriceApi=1.515&order_uuid=uuid-arabic-playerid';
        const res = await rawGet(path, authHeaders(token));

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('OK');
        expect(res.body.data.data).toEqual({ player_id: '10026' });

        const order = await Order.findOne({ userId: reseller._id, idempotencyKey: 'uuid-arabic-playerid' }).lean();
        expect(order.customerInput.values).toEqual({ player_id: '10026' });
        expect(order.customInputs).toEqual({ player_id: '10026' });
        expect(order.customerInput.values).not.toHaveProperty('ourPriceApi');
        expect(order.customInputs).not.toHaveProperty('ourPriceApi');
    });

    test('maps Arabic معرف المستخدم display key to the real product field key', async () => {
        const { reseller, token } = await createApiReseller({ token: 'arabic-userid-token' });
        const product = await createCompatProduct({
            name: 'Arabic UserId Product',
            orderFields: [
                {
                    id: 'user',
                    key: 'user_id',
                    label: 'User ID',
                    type: 'text',
                    required: true,
                    isActive: true,
                },
            ],
        });

        const path = `/client/api/newOrder/${product.compatProductId}/params`
            + `?qty=1&${encodeURIComponent('معرف المستخدم')}=10026`
            + '&ourPriceApi=1.515&order_uuid=uuid-arabic-user-id';
        const res = await rawGet(path, authHeaders(token));

        expect(res.status).toBe(200);
        expect(res.body.data.data).toEqual({ user_id: '10026' });

        const order = await Order.findOne({ userId: reseller._id, idempotencyKey: 'uuid-arabic-user-id' }).lean();
        expect(order.customerInput.values).toEqual({ user_id: '10026' });
        expect(order.customInputs).not.toHaveProperty('ourPriceApi');
    });

    test('maps English display target key to the real product field key', async () => {
        const { reseller, token } = await createApiReseller({ token: 'english-display-token' });
        const product = await createCompatProduct({
            name: 'English Display Product',
            orderFields: [
                {
                    id: 'account',
                    key: 'account_id',
                    label: 'Account ID',
                    type: 'text',
                    required: true,
                    isActive: true,
                },
            ],
        });

        const res = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=1&Player%20ID=10026&order_uuid=uuid-player-id-display`,
            authHeaders(token)
        );

        expect(res.status).toBe(200);
        expect(res.body.data.data).toEqual({ account_id: '10026' });

        const order = await Order.findOne({ userId: reseller._id, idempotencyKey: 'uuid-player-id-display' }).lean();
        expect(order.customerInput.values).toEqual({ account_id: '10026' });
    });

    test('falls back Arabic display target key to playerId when product has no formal fields', async () => {
        const { reseller, token } = await createApiReseller({ token: 'fallback-playerid-token' });
        const product = await createCompatProduct({
            name: 'Fallback Target Product',
            orderFields: [],
        });

        const path = `/client/api/newOrder/${product.compatProductId}/params`
            + `?qty=1&${encodeURIComponent('رقم اللاعب')}=10026`
            + '&ourPriceApi=1.515&price=10&token=external-token&order_uuid=uuid-fallback-playerid';
        const res = await rawGet(path, authHeaders(token));

        expect(res.status).toBe(200);
        expect(res.body.data.data).toEqual({ playerId: '10026' });

        const order = await Order.findOne({ userId: reseller._id, idempotencyKey: 'uuid-fallback-playerid' }).lean();
        expect(order.customerInput.values).toEqual({ playerId: '10026' });
        expect(order.customInputs).toEqual({ playerId: '10026' });
        expect(order.customerInput.values).not.toHaveProperty('ourPriceApi');
        expect(order.customerInput.values).not.toHaveProperty('price');
        expect(order.customerInput.values).not.toHaveProperty('token');
    });

    test('maps order creation validation failures to compatibility codes', async () => {
        const { token } = await createApiReseller({
            token: 'error-token',
            userOverrides: { walletBalance: 100 },
        });
        const product = await createCompatProduct({
            minQty: 2,
            maxQty: 5,
            orderFields: [],
        });

        let res = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=2`,
            authHeaders(token)
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(123);

        res = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=nope&order_uuid=bad-qty`,
            authHeaders(token)
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(106);

        res = await rawGet(
            '/client/api/newOrder/999999/params?qty=1&order_uuid=missing-product',
            authHeaders(token)
        );
        expect(res.status).toBe(404);
        expect(res.body.code).toBe(109);

        const inactive = await createCompatProduct({ isActive: false, orderFields: [] });
        res = await rawGet(
            `/client/api/newOrder/${inactive.compatProductId}/params?qty=1&order_uuid=inactive-product`,
            authHeaders(token)
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(110);

        res = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=1&order_uuid=too-small`,
            authHeaders(token)
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(112);

        res = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=6&order_uuid=too-large`,
            authHeaders(token)
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(113);

        const broke = await createApiReseller({
            token: 'broke-token',
            userOverrides: { walletBalance: 1, creditLimit: 0 },
        });
        res = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=2&order_uuid=no-money`,
            authHeaders(broke.token)
        );
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(100);
    });

    test('batch checks by compat order ID and order_uuid while enforcing ownership', async () => {
        const { token } = await createApiReseller({ token: 'check-token' });
        const product = await createCompatProduct({
            name: 'Check Product',
            orderFields: [],
        });

        const created = await rawGet(
            `/client/api/newOrder/${product.compatProductId}/params?qty=1&playerId=test&order_uuid=uuid-check-1`,
            authHeaders(token)
        );
        expect(created.status).toBe(200);
        const compatOrderId = created.body.data.order_id;

        const order = await Order.findOne({ idempotencyKey: 'uuid-check-1' });
        order.status = ORDER_STATUS.COMPLETED;
        await order.save();

        const byCompat = await rawGet(
            `/client/api/check?orders=[${compatOrderId},ID_missing]`,
            authHeaders(token)
        );
        expect(byCompat.status).toBe(200);
        expect(byCompat.headers['cache-control']).toContain('no-store');
        expect(byCompat.body.status).toBe('OK');
        expect(byCompat.body.data).toHaveLength(1);
        expect(byCompat.body.data[0]).toEqual(expect.objectContaining({
            order_id: compatOrderId,
            quantity: 1,
            product_name: 'Check Product',
            status: 'accept',
            replay_api: null,
        }));
        expect(byCompat.body.data[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

        const byUuid = await rawGet(
            '/client/api/check?orders=[uuid-check-1]&uuid=1',
            authHeaders(token)
        );
        expect(byUuid.status).toBe(200);
        expect(byUuid.body.data).toHaveLength(1);
        expect(byUuid.body.data[0].order_id).toBe(compatOrderId);

        const other = await createApiReseller({ token: 'other-check-token' });
        const forbidden = await rawGet(
            `/client/api/check?orders=${compatOrderId}`,
            authHeaders(other.token)
        );
        expect(forbidden.status).toBe(200);
        expect(forbidden.body).toEqual({
            status: 'OK',
            data: [],
        });
    });
});
