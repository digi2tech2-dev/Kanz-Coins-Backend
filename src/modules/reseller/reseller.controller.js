'use strict';

const { Product } = require('../products/product.model');
const { Order } = require('../orders/order.model');
const orderService = require('../orders/order.service');
const { calculateFinalPrice } = require('../orders/pricing.service');
const { convertUsdToUserCurrency } = require('../../services/currencyConverter.service');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { buildPublicWalletSummary } = require('../../shared/utils/walletSummary');

const toPublicProduct = async (product, reseller) => {
    const percentage = Number(reseller.groupId?.percentage || 0);
    const priceUsd = calculateFinalPrice(product.basePrice, percentage);
    const userCurrency = String(reseller.currency || 'USD').toUpperCase();
    const converted = await convertUsdToUserCurrency(Number(priceUsd), userCurrency);

    return {
        id: product._id.toString(),
        name: product.name,
        description: product.description || null,
        image: product.image || null,
        category: product.category || null,
        minQty: product.minQty,
        maxQty: product.maxQty,
        priceUsd,
        price: Number(converted.finalAmount),
        currency: converted.currency,
        rate: converted.rate,
        fields: (Array.isArray(product.orderFields) && product.orderFields.length > 0
            ? product.orderFields
            : product.dynamicFields
        ).filter((field) => field?.isActive !== false).map((field) => ({
            key: field.key || field.name || field.id,
            label: field.label || field.name || field.key,
            type: field.type || 'text',
            required: field.required !== false,
            options: Array.isArray(field.options) ? field.options : [],
            isVerifiable: field.isVerifiable === true,
        })),
    };
};

const buildOrderFields = ({ playerId, orderFieldsValues, dynamicFields, customInputs }) => {
    const fields = {};

    for (const source of [orderFieldsValues, dynamicFields, customInputs]) {
        if (source && typeof source === 'object' && !Array.isArray(source)) {
            Object.assign(fields, source);
        }
    }

    if (playerId !== undefined && playerId !== null && String(playerId).trim()) {
        fields.playerId = String(playerId).trim();
        if (!fields.player_id) fields.player_id = String(playerId).trim();
        if (!fields.userId) fields.userId = String(playerId).trim();
    }

    return Object.keys(fields).length > 0 ? fields : null;
};

const getBalance = catchAsync(async (req, res) => {
    const reseller = req.reseller;
    const walletSummary = buildPublicWalletSummary(reseller);

    sendSuccess(res, {
        email: reseller.email || req.user?.email || null,
        balance: walletSummary.availableBalance,
        walletBalance: walletSummary.walletBalance,
        creditLimit: walletSummary.creditLimit,
        creditUsed: walletSummary.creditUsed,
        availableCredit: walletSummary.availableCredit,
        availableBalance: walletSummary.availableBalance,
        currency: walletSummary.currency,
    });
});

const listProducts = catchAsync(async (req, res) => {
    if (!req.reseller.groupId || req.reseller.groupId.isActive === false) {
        return res.status(400).json({
            success: false,
            message: 'Reseller pricing group is missing or inactive.',
        });
    }

    const products = await Product.find({ isActive: true, deletedAt: null })
        .select('name description image category minQty maxQty basePrice orderFields dynamicFields displayOrder')
        .sort({ displayOrder: 1, name: 1 })
        .lean();

    const data = await Promise.all(products.map((product) => toPublicProduct(product, req.reseller)));
    sendSuccess(res, data, 'Products retrieved successfully.');
});

const createOrder = catchAsync(async (req, res) => {
    const {
        productId,
        quantity,
        playerId,
        orderFieldsValues,
        dynamicFields,
        customInputs,
        idempotencyKey: bodyIdempotencyKey,
    } = req.body;

    const idempotencyKey = String(bodyIdempotencyKey || req.get('idempotency-key') || '').trim();
    if (!idempotencyKey) {
        return res.status(400).json({
            success: false,
            message: 'idempotencyKey is required.',
        });
    }

    const { order, idempotent } = await orderService.createOrder({
        userId: req.reseller._id,
        productId,
        quantity: parseInt(quantity, 10),
        idempotencyKey,
        orderFieldsValues: buildOrderFields({ playerId, orderFieldsValues, dynamicFields, customInputs }),
        auditContext: req.auditContext,
    });

    const payload = {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        idempotencyKey,
        idempotent,
    };

    return idempotent
        ? sendSuccess(res, payload, 'Order already exists.')
        : sendCreated(res, payload, 'Order created successfully.');
});

const getOrderByIdempotencyKey = catchAsync(async (req, res) => {
    const order = await Order.findOne({
        userId: req.reseller._id,
        idempotencyKey: req.params.idempotencyKey,
    }).populate('productId', 'name');

    if (!order) {
        return res.status(404).json({
            success: false,
            message: 'Order not found.',
        });
    }

    sendSuccess(res, {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        productId: order.productId?._id?.toString() || order.productId,
        productName: order.productId?.name || null,
        quantity: order.quantity,
        status: order.status,
        providerStatus: order.providerStatus || null,
        providerOrderId: order.providerOrderId || null,
        idempotencyKey: order.idempotencyKey,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
    });
});

module.exports = {
    getBalance,
    listProducts,
    createOrder,
    getOrderByIdempotencyKey,
};
