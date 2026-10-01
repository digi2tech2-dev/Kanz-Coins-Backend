'use strict';

/**
 * admin.catalog.routes.js
 *
 * Admin-only routes for the provider catalog system.
 *
 * All routes require:
 *   - Authentication  (authenticate middleware)
 *   - Admin role      (authorize('ADMIN') middleware)
 *
 * Route map:
 *
 * ── Sync ──────────────────────────────────────────────────────────────────────
 *   POST  /admin/catalog/sync                     → syncAll
 *   POST  /admin/catalog/sync/:providerId         → syncProvider
 *
 * ── Raw Provider Products (Layer 2) ──────────────────────────────────────────
 *   GET   /admin/provider-products                → listAllProviderProducts
 *   GET   /admin/provider-products/:providerId    → listProviderProducts
 *   GET   /admin/provider-products/item/:id       → getProviderProduct
 *   PATCH /admin/provider-products/item/:id/translated-name → setTranslatedName
 *
 * ── Platform Products (Layer 3) ───────────────────────────────────────────────
 *   GET   /admin/products                         → listProducts
 *   POST  /admin/products/from-provider           → createProductFromProvider
 *   PATCH /admin/products/:id                     → updateProduct
 *   PATCH /admin/products/:id/toggle              → toggleProduct
 */

const express = require('express');
const  authenticate  = require('../../shared/middlewares/authenticate');
const  authorize  = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const { validateBody, schemas } = require('./admin.validation');
const {
    syncProvider,
    syncAll,
    listAllProviderProducts,
    listProviderProducts,
    getProviderProduct,
    getProviderProductPrice,
    setTranslatedName,
    listProducts,
    createProduct,
    createProductFromProvider,
    updateProduct,
    toggleProduct,
    deleteProduct,
    listProductProviderOffers,
    createProductProviderOffer,
    updateProductProviderOffer,
    deleteProductProviderOffer,
} = require('./admin.catalog.controller');

const router = express.Router();

// All admin routes require authentication and ADMIN role
router.use(authenticate);
router.use(authorize('ADMIN', 'SUPERVISOR'));

// ── Sync ──────────────────────────────────────────────────────────────────────

router.post('/catalog/sync', requirePermission('MANAGE_SUPPLIERS'), syncAll);
router.post('/catalog/sync/:providerId', requirePermission('MANAGE_SUPPLIERS'), syncProvider);

// ── Layer 2 — Raw Provider Products ──────────────────────────────────────────
//
// NOTE: /item/:id must be defined BEFORE /:providerId to avoid Express
// treating "item" as a providerId param value.

router.get('/provider-products', requirePermission('MANAGE_PRODUCTS'), listAllProviderProducts);
router.get('/provider-products/item/:id', requirePermission('MANAGE_PRODUCTS'), getProviderProduct);
router.get('/provider-products/item/:id/price', requirePermission('MANAGE_PRODUCTS'), getProviderProductPrice);
router.patch('/provider-products/item/:id/translated-name', requirePermission('MANAGE_PRODUCTS'), setTranslatedName);
router.get('/provider-products/:providerId', requirePermission('MANAGE_PRODUCTS'), listProviderProducts);

// ── Layer 3 — Platform Products ───────────────────────────────────────────────
//
// NOTE: /from-provider must be defined BEFORE /:id to avoid param conflict.

router.use('/products', requirePermission('MANAGE_PRODUCTS'));
router.get('/products', requirePermission('MANAGE_PRODUCTS'), listProducts);
router.post('/products', requirePermission('MANAGE_PRODUCTS'), validateBody(schemas.createAdminProduct), createProduct);                   // manual product creation
router.post('/products/from-provider', requirePermission('MANAGE_PRODUCTS'), createProductFromProvider);
// ProductProviderOffer routes must precede /products/:id.
router.get('/products/:productId/provider-offers', requirePermission('MANAGE_PRODUCTS'), listProductProviderOffers);
router.post('/products/:productId/provider-offers', requirePermission('MANAGE_PRODUCTS'), validateBody(schemas.createProductProviderOffer), createProductProviderOffer);
router.patch('/product-provider-offers/:offerId', requirePermission('MANAGE_PRODUCTS'), validateBody(schemas.updateProductProviderOffer), updateProductProviderOffer);
router.delete('/product-provider-offers/:offerId', requirePermission('MANAGE_PRODUCTS'), deleteProductProviderOffer);
router.patch('/products/:id/toggle', requirePermission('MANAGE_PRODUCTS'), toggleProduct);
router.delete('/products/:id', requirePermission('MANAGE_PRODUCTS'), deleteProduct);
router.patch('/products/:id', requirePermission('MANAGE_PRODUCTS'), validateBody(schemas.updateAdminProduct), updateProduct);

module.exports = router;
