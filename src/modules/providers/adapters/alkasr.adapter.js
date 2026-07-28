'use strict';

/**
 * alkasr.adapter.js — AlkasrVipAdapter
 *
 * HTTP adapter for the **Alkasr VIP** external provider.
 *
 * ─── API Overview ─────────────────────────────────────────────────────────────
 *  Base URL    : provider.baseUrl  (e.g. https://alkasr-vip.com)
 *  Auth        : api-token: <token>  header on every request
 *
 *  GET  /client/api/products                         — fetch product catalogue
 *  GET  /client/api/newOrder/{productId}/params
 *             ?qty={amount}
 *             &playerId={playerId}
 *             &order_uuid={uuidv4}                   — place a new order (idempotent)
 *  GET  /client/api/check?orders=[id1,id2]           — check order status (single or batch)
 *  GET  /client/api/profile                          — account info + balance
 *
 * ─── Status Vocabulary ────────────────────────────────────────────────────────
 *  Alkasr      → Internal platform canonical
 *  accept      → Completed
 *  accepted    → Completed
 *  success     → Completed
 *  done        → Completed
 *  OK          → Completed  (placeOrder success indicator)
 *
 *  wait        → Pending
 *  waiting     → Pending
 *  processing  → Pending
 *  pending     → Pending
 *  in_process  → Pending
 *
 *  reject      → Cancelled
 *  rejected    → Cancelled
 *  failed      → Cancelled
 *  error       → Cancelled
 *  cancelled   → Cancelled
 *  cancel      → Cancelled
 *
 * ─── Normalised DTO shapes ────────────────────────────────────────────────────
 *  getProducts()  → ProviderProductDTO[]
 *  placeOrder()   → PlaceOrderResult   { success, providerOrderId, providerStatus, rawResponse, errorMessage }
 *  checkOrder()   → OrderStatusResult  { providerOrderId, providerStatus, rawResponse }
 *  checkOrders()  → OrderStatusResult[]
 *  getBalance()   → Object
 *
 * The adapter NEVER throws for placeOrder() — all failures return { success: false }.
 */

const axios = require('axios');
const crypto = require('crypto');
const { BaseProviderAdapter } = require('./base.adapter');
const { extractTargetId } = require('./providerParams.helper');

const DEFAULT_TIMEOUT_MS = 180_000;

// ─── Status normaliser (Alkasr → internal canonical) ─────────────────────────

/**
 * Map Alkasr-specific status strings to the canonical platform vocabulary
 * understood by statusMapper.js → ORDER_STATUS.
 *
 * @param {string} alkasrStatus
 * @returns {'Completed'|'Pending'|'Cancelled'}
 */
const _normaliseAlkasrStatus = (alkasrStatus) => {
    switch (String(alkasrStatus ?? '').toLowerCase().trim()) {
        case 'accept':
        case 'accepted':
        case 'success':
        case 'ok':
        case 'done':
        case 'complete':
        case 'completed':
            return 'Completed';

        case 'wait':
        case 'waiting':
        case 'processing':
        case 'pending':
        case 'in_process':
        case 'in_progress':
        case 'queued':
            return 'Pending';

        case 'reject':
        case 'rejected':
        case 'failed':
        case 'error':
        case 'cancelled':
        case 'canceled':
        case 'cancel':
        default:
            return 'Cancelled';
    }
};

// ─── Axios client factory ─────────────────────────────────────────────────────

const _buildClient = (baseURL, token, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const client = axios.create({
        baseURL,
        timeout: timeoutMs,
        headers: {
            'api-token': token,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    });

    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const status = err.response?.status;
            const body = err.response?.data;
            const message = body?.message ?? body?.error ?? body?.msg ?? err.message ?? 'Unknown Alkasr error';
            const wrapped = new Error(`[AlkasrVip] HTTP ${status ?? 'NETWORK'}: ${message}`);
            wrapped.statusCode = status ?? null;
            wrapped.providerBody = body ?? null;
            return Promise.reject(wrapped);
        }
    );

    return client;
};

// ─── AlkasrVipAdapter ─────────────────────────────────────────────────────────

class AlkasrVipAdapter extends BaseProviderAdapter {
    /**
     * @param {Object} provider
     * @param {string} provider.baseUrl
     * @param {string} [provider.apiToken]
     * @param {string} [provider.apiKey]   — legacy alias
     * @param {Object} [options]
     * @param {number} [options.timeoutMs]
     */
    constructor(provider, options = {}) {
        super(provider, options);

        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[AlkasrVip] provider.baseUrl is required');
        if (!token) throw new Error('[AlkasrVip] api token (apiToken / apiKey) is required');

        this._client = _buildClient(provider.baseUrl, token, options.timeoutMs);
    }

    // ── Product Catalogue ─────────────────────────────────────────────────────

    /**
     * GET /client/api/products
     *
     * Response is an array of products:
     *   [ { id, name, price, qty_values: { min, max } }, ... ]
     *
     * @returns {Promise<ProviderProductDTO[]>}
     */
    async getProducts() {
        const { data } = await this._client.get('/client/api/products');
        const list = Array.isArray(data)
            ? data
            : (data.data ?? data.products ?? data.services ?? []);

        return list.map((item) => this._validateDTO({
            externalProductId: String(item.id ?? item.product_id ?? item.service_id ?? item.code),
            rawName: String(item.name ?? item.product_name ?? item.service_name ?? item.title ?? 'Unknown'),
            rawPrice: String(item.price ?? item.cost ?? item.rate ?? item.cost_per_unit ?? 0),
            minQty: parseInt(item.qty_values?.min ?? item.min ?? item.min_quantity ?? 1, 10),
            maxQty: parseInt(item.qty_values?.max ?? item.max ?? item.max_quantity ?? 9999, 10),
            isActive: item.is_active !== false
                && item.active !== false
                && item.available !== false
                && item.status !== 'inactive',
            rawPayload: item,
        }));
    }

    // ── Order Placement ───────────────────────────────────────────────────────

    /**
     * GET /client/api/newOrder/{productId}/params
     *       ?qty={amount}
     *       &playerId={playerId}
     *       &order_uuid={uuidv4}
     *
     * A UUIDv4 is generated and appended as `order_uuid` query parameter
     * to ensure idempotency.
     *
     * Success response: { status: "OK", data: { order_id, status, ... } }
     *
     * placeOrder() NEVER throws — all failures surface as { success: false }.
     *
     * @param {Object}        params
     * @param {string|number} params.productId         — provider's externalProductId
     * @param {number}        params.amount             — quantity
     * @param {string}        [params.playerId]         — player / uid on provider side
     * @param {string}        [params.referenceId]
     * @param {string|number} [params.externalProductId] — alias (compat)
     * @param {number}        [params.quantity]           — alias (compat)
     * @returns {Promise<PlaceOrderResult>}
     */
    async placeOrder(params) {
        const productId = params.productId ?? params.externalProductId;
        const amount = params.amount ?? params.quantity;
        const playerId = extractTargetId(params);
        const orderUuid = crypto.randomUUID();

        if (!playerId) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: {
                    status: 'ERROR',
                    msg: 'Missing provider target/player ID',
                },
                errorMessage: 'Missing provider target/player ID',
            };
        }

        try {
            const { data } = await this._client.get(
                `/client/api/newOrder/${encodeURIComponent(productId)}/params`,
                {
                    params: {
                        qty: amount,
                        playerId,
                        order_uuid: orderUuid,
                    },
                }
            );

            // Check for explicit API-level failure
            const topStatus = String(data.status ?? '').toUpperCase();
            if (topStatus !== 'OK' && data.success === false) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: data.message ?? data.error ?? data.msg ?? 'AlkasrVip rejected the order',
                };
            }

            // Extract order ID from data.order_id
            const innerData = data.data ?? data;
            const normalizedStatus = _normaliseAlkasrStatus(innerData.status ?? data.status);
            if (normalizedStatus === 'Cancelled') {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: innerData.message ?? data.message ?? innerData.error ?? data.error ?? innerData.msg ?? data.msg ?? 'AlkasrVip rejected the order',
                };
            }

            const providerOrderId = innerData.order_id ?? innerData.id ?? innerData.orderId ?? null;

            if (!providerOrderId) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: 'AlkasrVip returned no order id',
                };
            }

            return {
                success: true,
                providerOrderId: String(providerOrderId),
                providerStatus: normalizedStatus,
                rawResponse: data,
                errorMessage: null,
            };

        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: err.providerBody ?? { message: err.message },
                errorMessage: err.message,
            };
        }
    }

    // ── Order Status ──────────────────────────────────────────────────────────

    /**
     * GET /client/api/check?orders=[orderId]
     *
     * Note: IDs must be enclosed in brackets in the query string.
     *
     * @param {number|string} orderId
     * @returns {Promise<OrderStatusResult>}
     */
    async checkOrder(orderId) {
        const endpoint = '/client/api/check';
        const params = { orders: JSON.stringify([orderId]) };



        const { data } = await this._client.get(endpoint, { params });



        // Response may be an array, object map, or wrapped in .data
        const result = Array.isArray(data)
            ? data[0]
            : (data.data?.[0] ?? data[String(orderId)] ?? data);

        const providerStatus = _normaliseAlkasrStatus(result?.status);
        return {
            providerOrderId: String(result?.order_id ?? orderId),
            providerStatus,
            unifiedStatus: this.toUnifiedStatus(result?.status),
            rawResponse: data,
        };
    }

    /**
     * GET /client/api/check?orders=[id1,id2,id3]
     *
     * Note: IDs must be enclosed in brackets in the query string.
     *
     * @param {Array<number|string>} orderIds
     * @returns {Promise<OrderStatusResult[]>}
     */
    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];

        const { data } = await this._client.get('/client/api/check', {
            params: { orders: JSON.stringify(orderIds) },
        });

        // Response may be an array or object map
        if (Array.isArray(data)) {
            return data.map((item) => ({
                providerOrderId: String(item.order_id ?? item.id),
                providerStatus: _normaliseAlkasrStatus(item.status),
                rawResponse: item,
            }));
        }

        const list = data.data ?? data;
        if (Array.isArray(list)) {
            return list.map((item) => ({
                providerOrderId: String(item.order_id ?? item.id),
                providerStatus: _normaliseAlkasrStatus(item.status),
                rawResponse: item,
            }));
        }

        // Object map: { "123": { status: "..." }, ... }
        return Object.entries(list).map(([id, item]) => ({
            providerOrderId: String(id),
            providerStatus: _normaliseAlkasrStatus(item.status),
            rawResponse: item,
        }));
    }

    // ── Account / Balance ─────────────────────────────────────────────────────

    /**
     * GET /client/api/profile
     *
     * Returns account details / balance info.
     *
     * @returns {Promise<Object>} raw provider response data
     */
    async getBalance() {
        const { data } = await this._client.get('/client/api/profile');
        return data;
    }
}

module.exports = { AlkasrVipAdapter };
