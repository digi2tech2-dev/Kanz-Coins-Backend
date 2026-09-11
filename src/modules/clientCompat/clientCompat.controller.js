'use strict';

const clientCompatService = require('./clientCompat.service');
const { parseOrdersQuery } = require('./clientCompat.mappers');

const setNoStore = (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
};

const getProfile = async (req, res) => {
    const payload = await clientCompatService.getProfile(req.reseller);
    res.json(payload);
};

const listProducts = async (req, res) => {
    const payload = await clientCompatService.listProducts(req.reseller, {
        productsId: req.query.products_id,
        base: String(req.query.base || '') === '1',
    });
    res.json(payload);
};

const getContent = async (req, res) => {
    const payload = await clientCompatService.getContent(req.reseller, req.params.parentId);
    res.json(payload);
};

const placeOrder = async (req, res) => {
    setNoStore(res);
    const payload = await clientCompatService.placeOrder(
        req.reseller,
        req.params.productId,
        req.query,
        req.auditContext
    );
    res.json(payload);
};

const placeCanonicalOrder = async (req, res) => {
    setNoStore(res);
    const payload = await clientCompatService.placeCanonicalOrder(
        req.reseller,
        req.body || {},
        req.auditContext
    );
    res.json(payload);
};

const checkOrders = async (req, res) => {
    setNoStore(res);
    const canonicalUuids = req.query.uuids;
    const ids = parseOrdersQuery(canonicalUuids || req.query.orders);
    const payload = await clientCompatService.listOrders(req.reseller, ids, {
        byUuid: canonicalUuids !== undefined || String(req.query.uuid || '') === '1',
    });
    res.json(payload);
};

module.exports = {
    getProfile,
    listProducts,
    getContent,
    placeOrder,
    placeCanonicalOrder,
    checkOrders,
};
