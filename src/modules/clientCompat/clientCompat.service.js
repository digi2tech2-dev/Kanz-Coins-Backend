'use strict';

const crypto = require('crypto');
const { Product } = require('../products/product.model');
const { Category } = require('../categories/category.model');
const { Order } = require('../orders/order.model');
const orderService = require('../orders/order.service');
const { calculateFinalPrice } = require('../orders/pricing.service');
const { convertUsdToUserCurrency } = require('../../services/currencyConverter.service');
const { getNextSequence } = require('../orders/counter.model');
const { ClientCompatError, ERROR_CODES } = require('./clientCompat.errors');
const {
    getActiveFields,
    getFieldKey,
    getFieldLabel,
    getCategoryForProduct,
    mapProduct,
    mapCreatedOrder,
    mapCheckedOrder,
    parseProductIds,
    extractOrderFieldsFromQuery,
} = require('./clientCompat.mappers');
const {
    isTargetAliasKey,
    normalizeTargetAliasKey,
} = require('../providers/adapters/providerParams.helper');
const { buildWalletSummary } = require('../../shared/utils/walletSummary');

const PRODUCT_SELECT = [
    'compatProductId',
    'name',
    'description',
    'image',
    'category',
    'minQty',
    'maxQty',
    'basePrice',
    'orderFields',
    'dynamicFields',
    'displayOrder',
    'isActive',
    'deletedAt',
].join(' ');

const normalizeAlias = normalizeTargetAliasKey;

const toBalanceString = (value) => {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return '0';
    return Number(numeric.toFixed(6)).toString();
};

const getProfile = async (reseller) => {
    const walletSummary = buildWalletSummary(reseller);
    return {
        balance: toBalanceString(walletSummary.availableBalance),
        email: reseller.email || null,
    };
};

const ensureProductCompatId = async (product) => {
    if (product.compatProductId) return product.compatProductId;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const nextId = await getNextSequence('compatProductId', 999);
        try {
            const updated = await Product.findOneAndUpdate(
                {
                    _id: product._id,
                    $or: [
                        { compatProductId: null },
                        { compatProductId: { $exists: false } },
                    ],
                },
                { $set: { compatProductId: nextId } },
                { new: true, lean: true }
            );
            if (updated?.compatProductId) return updated.compatProductId;

            const existing = await Product.findById(product._id).select('compatProductId').lean();
            if (existing?.compatProductId) return existing.compatProductId;
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }

    throw new ClientCompatError('Unable to assign product compatibility ID', ERROR_CODES.INTERNAL, 500);
};

const ensureCategoryCompatId = async (category) => {
    if (!category || category.compatCategoryId) return category?.compatCategoryId || 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const nextId = await getNextSequence('compatCategoryId', 1);
        try {
            const updated = await Category.findOneAndUpdate(
                {
                    _id: category._id,
                    $or: [
                        { compatCategoryId: null },
                        { compatCategoryId: { $exists: false } },
                    ],
                },
                { $set: { compatCategoryId: nextId } },
                { new: true, lean: true }
            );
            if (updated?.compatCategoryId) return updated.compatCategoryId;

            const existing = await Category.findById(category._id).select('compatCategoryId').lean();
            if (existing?.compatCategoryId) return existing.compatCategoryId;
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }

    throw new ClientCompatError('Unable to assign category compatibility ID', ERROR_CODES.INTERNAL, 500);
};

const ensureCompatIds = async (products, categories) => {
    for (const category of categories) {
        if (!category.compatCategoryId) {
            category.compatCategoryId = await ensureCategoryCompatId(category);
        }
    }

    for (const product of products) {
        if (!product.compatProductId) {
            product.compatProductId = await ensureProductCompatId(product);
        }
    }
};

const loadCategories = async () => Category.find({ isActive: true })
    .sort({ sortOrder: 1, name: 1 })
    .lean();

const buildCategoryMaps = (categories) => {
    const byId = new Map();
    const byCompatId = new Map();

    for (const category of categories) {
        byId.set(String(category._id), category);
        if (category.compatCategoryId) {
            byCompatId.set(Number(category.compatCategoryId), category);
        }
    }

    return { byId, byCompatId };
};

const priceProduct = async (product, reseller) => {
    const percentage = Number(reseller.groupId?.percentage || 0);
    const priceUsd = calculateFinalPrice(product.basePrice, percentage);
    const userCurrency = String(reseller.currency || 'USD').toUpperCase();
    const converted = await convertUsdToUserCurrency(Number(priceUsd), userCurrency);

    return {
        priceUsd,
        price: Number(converted.finalAmount),
        currency: userCurrency,
    };
};

const listProducts = async (reseller, { productsId = '', base = false } = {}) => {
    if (!reseller.groupId || reseller.groupId.isActive === false) {
        throw new ClientCompatError('Not allowed to use API', 122, 403);
    }

    const filter = { isActive: true, deletedAt: null };
    const productIds = parseProductIds(productsId);
    if (productIds.length > 0) {
        filter.compatProductId = { $in: productIds };
    }

    const [products, categories] = await Promise.all([
        Product.find(filter)
            .select(PRODUCT_SELECT)
            .sort({ displayOrder: 1, name: 1 })
            .lean(),
        loadCategories(),
    ]);

    await ensureCompatIds(products, categories);
    const { byId: categoryById } = buildCategoryMaps(categories);

    const mapped = [];
    for (const product of products) {
        const category = getCategoryForProduct(product, categoryById);
        const priced = await priceProduct(product, reseller);
        mapped.push(mapProduct({
            product,
            category,
            price: priced.price,
            priceUsd: priced.priceUsd,
            currency: priced.currency,
            minimal: base,
        }));
    }

    return mapped;
};

const mapCategory = (category) => ({
    id: Number(category.compatCategoryId || 0),
    name: category.name || '',
    parent_id: 0,
    image: category.image || '',
    available: category.isActive !== false,
});

const getContent = async (reseller, parentId) => {
    const numericParentId = Number(parentId);
    if (!Number.isInteger(numericParentId) || numericParentId < 0) {
        throw new ClientCompatError('Validation error', ERROR_CODES.VALIDATION, 400);
    }

    const [allProducts, categories] = await Promise.all([
        Product.find({ isActive: true, deletedAt: null })
            .select(PRODUCT_SELECT)
            .sort({ displayOrder: 1, name: 1 })
            .lean(),
        loadCategories(),
    ]);

    await ensureCompatIds(allProducts, categories);
    const { byId: categoryById, byCompatId: categoryByCompatId } = buildCategoryMaps(categories);
    const parentCategory = numericParentId === 0 ? null : categoryByCompatId.get(numericParentId) || null;
    const parentMongoId = parentCategory ? String(parentCategory._id) : null;

    const childCategories = categories
        .filter((category) => {
            const currentParent = category.parentCategory ? String(category.parentCategory) : null;
            return numericParentId === 0 ? !currentParent : currentParent === parentMongoId;
        })
        .map((category) => ({
            ...mapCategory(category),
            parent_id: numericParentId,
        }));

    const products = [];
    for (const product of allProducts) {
        const productCategoryId = String(product.category || '').trim();
        const include = numericParentId === 0
            ? !productCategoryId
            : productCategoryId === parentMongoId;
        if (!include) continue;

        const category = getCategoryForProduct(product, categoryById);
        const priced = await priceProduct(product, reseller);
        products.push(mapProduct({
            product,
            category,
            price: priced.price,
            priceUsd: priced.priceUsd,
            currency: priced.currency,
        }));
    }

    return {
        status: 'OK',
        data: {
            categories: childCategories,
            products,
        },
    };
};

const findProductByCompatId = async (compatProductId) => {
    const numericId = Number(compatProductId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new ClientCompatError('Product deleted or not found', ERROR_CODES.PRODUCT_NOT_FOUND, 404);
    }

    const product = await Product.findOne({ compatProductId: numericId }).select(PRODUCT_SELECT);
    if (!product || product.deletedAt) {
        throw new ClientCompatError('Product deleted or not found', ERROR_CODES.PRODUCT_NOT_FOUND, 404);
    }
    if (product.isActive === false) {
        throw new ClientCompatError('Product not available now', ERROR_CODES.PRODUCT_NOT_AVAILABLE, 400);
    }
    return product;
};

const normalizeOrderFieldsForProduct = (product, fields) => {
    const activeFields = getActiveFields(product);

    const aliasMap = new Map();
    const targetLikeRequiredFields = [];

    for (const field of activeFields) {
        const key = getFieldKey(field);
        const label = getFieldLabel(field);
        const canonical = key || field.name || field.id || label;
        const aliases = [key, label, field.name, field.id, field.labelAr, field.placeholder, field.placeholderAr];

        if (
            field?.required !== false
            && aliases.some((alias) => isTargetAliasKey(alias))
            && canonical
        ) {
            targetLikeRequiredFields.push(canonical);
        }

        for (const alias of aliases) {
            const normalized = normalizeAlias(alias);
            if (normalized && canonical && !aliasMap.has(normalized)) {
                aliasMap.set(normalized, canonical);
            }
        }
    }

    const uniqueTargetFieldKeys = [...new Set(targetLikeRequiredFields)];
    const targetFieldKey = uniqueTargetFieldKeys.length === 1
        ? uniqueTargetFieldKeys[0]
        : null;

    const normalizedFields = {};
    for (const [key, value] of Object.entries(fields || {})) {
        const mappedKey = aliasMap.get(normalizeAlias(key))
            || (isTargetAliasKey(key) ? (targetFieldKey || 'playerId') : key);
        normalizedFields[mappedKey] = value;
    }
    return normalizedFields;
};

const generateCompatOrderId = () => `ID_${crypto.randomBytes(8).toString('hex')}`;

const ensureCompatOrderId = async (orderOrId) => {
    const orderId = orderOrId?._id || orderOrId;
    if (orderOrId?.compatOrderId) return orderOrId.compatOrderId;

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const compatOrderId = generateCompatOrderId();
        try {
            const updated = await Order.findOneAndUpdate(
                {
                    _id: orderId,
                    $or: [
                        { compatOrderId: null },
                        { compatOrderId: { $exists: false } },
                    ],
                },
                { $set: { compatOrderId } },
                { new: true }
            );
            if (updated?.compatOrderId) return updated.compatOrderId;

            const existing = await Order.findById(orderId).select('compatOrderId');
            if (existing?.compatOrderId) return existing.compatOrderId;
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }

    throw new ClientCompatError('Unable to assign order compatibility ID', ERROR_CODES.INTERNAL, 500);
};

const populateOrderForCompat = async (orderId) => Order.findById(orderId)
    .populate('productId', 'name')
    .lean();

const placeOrder = async (reseller, compatProductId, query, auditContext) => {
    const product = await findProductByCompatId(compatProductId);
    const quantity = Number(query.qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new ClientCompatError('Quantity not allowed', ERROR_CODES.QUANTITY_NOT_ALLOWED, 400);
    }
    if (quantity < Number(product.minQty || 1)) {
        throw new ClientCompatError('Quantity is too small', ERROR_CODES.QUANTITY_TOO_SMALL, 400);
    }
    if (quantity > Number(product.maxQty || quantity)) {
        throw new ClientCompatError('Quantity is too large', ERROR_CODES.QUANTITY_TOO_LARGE, 400);
    }

    const idempotencyKey = String(query.order_uuid || '').trim();
    if (!idempotencyKey) {
        throw new ClientCompatError('order_uuid is required', ERROR_CODES.VALIDATION, 400);
    }

    const orderFieldsValues = normalizeOrderFieldsForProduct(
        product,
        extractOrderFieldsFromQuery(query)
    );

    const { order } = await orderService.createOrder({
        userId: reseller._id,
        productId: product._id,
        quantity,
        idempotencyKey,
        orderFieldsValues,
        auditContext,
    });

    await ensureCompatOrderId(order);
    const freshOrder = await populateOrderForCompat(order._id);
    return {
        status: 'OK',
        data: mapCreatedOrder(freshOrder),
    };
};

const listOrders = async (reseller, ids, { byUuid = false } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new ClientCompatError('Validation error', ERROR_CODES.VALIDATION, 400);
    }

    const filter = byUuid
        ? { userId: reseller._id, idempotencyKey: { $in: ids } }
        : {
            userId: reseller._id,
            $or: [
                { compatOrderId: { $in: ids } },
                { orderNumber: { $in: ids.map((id) => String(id).toUpperCase()) } },
            ],
        };

    const orders = await Order.find(filter)
        .populate('productId', 'name')
        .lean();

    for (const order of orders) {
        if (!order.compatOrderId) {
            order.compatOrderId = await ensureCompatOrderId(order._id);
        }
    }

    const orderByKey = new Map();
    for (const order of orders) {
        if (byUuid && order.idempotencyKey) orderByKey.set(order.idempotencyKey, order);
        if (order.compatOrderId) orderByKey.set(order.compatOrderId, order);
        if (order.orderNumber) orderByKey.set(String(order.orderNumber).toUpperCase(), order);
    }

    const ordered = ids
        .map((id) => orderByKey.get(byUuid ? id : String(id).toUpperCase()) || orderByKey.get(id))
        .filter(Boolean);

    return {
        status: 'OK',
        data: ordered.map(mapCheckedOrder),
    };
};

module.exports = {
    getProfile,
    listProducts,
    getContent,
    placeOrder,
    listOrders,
    ensureProductCompatId,
    ensureCategoryCompatId,
    ensureCompatOrderId,
};
