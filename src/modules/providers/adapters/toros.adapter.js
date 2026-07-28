'use strict';

/**
 * toros.adapter.js — TorosfonAdapter
 *
 * HTTP adapter for the **Torosfon Store** external provider.
 *
 * Torosfon's API is an exact clone of the Royal Crown API.
 *
 * ─── API Overview ─────────────────────────────────────────────────────────────
 *  Base URL    : provider.baseUrl  (e.g. https://torosfon.com)
 *  Auth        : api-token: <token>
 *
 *  GET  /api/AllProducts                       — fetch product catalogue
 *  GET  /api/PlaceOrder/{productId}/data
 *             ?amount={amount}
 *             &player_Id={playerId}
 *             &referenceId={referenceId}       — place an order
 *  GET  /api/CheckOrder?order_id={orderId}     — check single order
 *  GET  /api/CheckListOrders?orders=[1,2,3]    — batch check
 *  GET  /api/GetMyInfo                         — account / balance info
 *
 * ─── Normalised DTO shapes ────────────────────────────────────────────────────
 *  getProducts()  → ProviderProductDTO[]
 *  placeOrder()   → PlaceOrderResult   { success, providerOrderId, providerStatus, rawResponse, errorMessage }
 *  checkOrder()   → OrderStatusResult  { providerOrderId, providerStatus, rawResponse }
 *  checkOrders()  → OrderStatusResult[]
 *  getBalance()   → Object
 *
 * Status mapping (provider → platform):
 *   Completed  → 'Completed'
 *   Pending    → 'Pending'
 *   Cancelled  → 'Cancelled'
 *
 * The adapter NEVER throws for placeOrder() — all failures return { success: false }.
 */

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const { extractTargetId } = require('./providerParams.helper');

const DEFAULT_TIMEOUT_MS = 180_000;

const _normaliseTorosStatus = (status) => {
    switch (String(status ?? '').toLowerCase().trim()) {
        case 'completed':
        case 'complete':
        case 'success':
        case 'done':
        case 'ok':
        case 'delivered':
            return 'Completed';
        case 'pending':
        case 'processing':
        case 'queued':
        case 'wait':
        case 'waiting':
        case 'in_process':
            return 'Pending';
        case 'cancelled':
        case 'canceled':
        case 'cancel':
        case 'failed':
        case 'fail':
        case 'error':
        case 'reject':
        case 'rejected':
            return 'Cancelled';
        default:
            return 'Pending';
    }
};

// ─── HTTP client factory ──────────────────────────────────────────────────────

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
            const message = body?.message ?? body?.error ?? err.message ?? 'Unknown Toros error';
            const wrapped = new Error(`[Toros] HTTP ${status ?? 'NETWORK'}: ${message}`);
            wrapped.statusCode = status ?? null;
            wrapped.providerBody = body ?? null;
            return Promise.reject(wrapped);
        }
    );

    return client;
};

// ─── TorosfonAdapter ──────────────────────────────────────────────────────────

class TorosfonAdapter extends BaseProviderAdapter {
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
        if (!provider.baseUrl) throw new Error('[Toros] provider.baseUrl is required');
        if (!token) throw new Error('[Toros] api token (apiToken / apiKey) is required');

        this._client = _buildClient(provider.baseUrl, token, options.timeoutMs);
    }

    // ── Product Catalogue ─────────────────────────────────────────────────────

    /**
     * GET /api/AllProducts
     *
     * Returns normalised ProviderProductDTOs.
     *
     * Expected response shapes:
     *   [ { id, product_name, product_price, min, max }, ... ]  – plain array
     *   { data: [...] }                                          – wrapped in .data
     *   { products: [...] }                                      – wrapped in .products
     *
     * @returns {Promise<ProviderProductDTO[]>}
     */
    async getProducts() {
        const { data } = await this._client.get('/api/AllProducts');
        const list = Array.isArray(data)
            ? data
            : (data.data ?? data.products ?? data.services ?? []);

        return list.map((item) => this._validateDTO({
            externalProductId: String(item.id ?? item.product_id ?? item.service ?? item.code),
            rawName: String(item.product_name ?? item.name ?? item.product_name_translated ?? item.title ?? item.service_name ?? 'Unknown'),
            rawPrice: String(item.product_price ?? item.rate ?? item.price ?? item.cost ?? 0),
            minQty: parseInt(item.min ?? item.min_qty ?? item.min_quantity ?? item.min_order ?? 1, 10),
            maxQty: parseInt(item.max ?? item.max_qty ?? item.max_quantity ?? item.max_order ?? 9999, 10),
            isActive: item.active !== false && item.is_active !== false && item.status !== 'inactive' && item.status !== 'Inactive',
            rawPayload: item,
        }));
    }

    // ── Order Placement ───────────────────────────────────────────────────────

    /**
     * GET /api/PlaceOrder/{productId}/data
     *       ?amount={amount}
     *       &player_Id={playerId}
     *       &referenceId={referenceId}
     *
     * placeOrder() NEVER throws — failures are returned as { success: false }.
     *
     * @param {Object}        params
     * @param {string|number} params.productId        - provider's product ID
     * @param {number}        params.amount            - order quantity / units
     * @param {string}        [params.playerId]        - player / account ID
     * @param {string}        [params.referenceId]     - our internal reference
     * @param {string|number} [params.externalProductId] - alias for productId
     * @param {number}        [params.quantity]           - alias for amount
     *
     * @returns {Promise<PlaceOrderResult>}
     */
    async placeOrder(params) {
        const productId = params.productId ?? params.externalProductId;
        const amount = params.amount ?? params.quantity;
        const playerId = extractTargetId(params);
        const referenceId = params.referenceId ?? '';

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
                `/api/PlaceOrder/${encodeURIComponent(productId)}/data`,
                {
                    params: {
                        amount,
                        player_Id: playerId,
                        referenceId,
                    },
                }
            );

            // ── Normalise response structure ────────────────────────────────
            // Some providers wrap everything inside a `data` sub-object:
            //   { success: true, data: { order_id: 301069, order_status: 'Completed' } }
            // Others return flat:
            //   { order: 123, status: 'Pending' }
            // We handle both by checking nested first, then flat.
            const nested = data.data ?? {};

            // ── Success check ────────────────────────────────────────────────
            const isSuccess = data.success !== false && nested.success !== false;

            if (!isSuccess) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: nested.message ?? data.message ?? nested.error ?? data.error ?? 'Provider rejected the order',
                };
            }

            // ── Extract order ID ─────────────────────────────────────────────
            const providerOrderId =
                nested.order_id ?? nested.orderId ?? nested.order ?? nested.id ??
                data.order_id   ?? data.orderId   ?? data.order   ?? data.id   ??
                null;

            if (!providerOrderId) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: nested.error ?? data.error ?? nested.message ?? data.message ?? 'Provider returned no order ID',
                };
            }

            // ── Extract status ───────────────────────────────────────────────
            const providerStatus =
                nested.order_status ?? nested.status ??
                data.order_status   ?? data.status   ??
                'Pending';

            return {
                success: true,
                providerOrderId: parseInt(String(providerOrderId), 10),
                providerStatus: _normaliseTorosStatus(providerStatus),
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
     * GET /api/CheckOrder?order_id={orderId}
     *
     * Checks the current status of a single provider order.
     *
     * @param {number|string} orderId
     * @returns {Promise<OrderStatusResult>}
     */
    async checkOrder(orderId) {
        const endpoint = '/api/CheckOrder';
        const params = { order_id: orderId };



        const { data } = await this._client.get(endpoint, { params });



        // ── Normalise nested response ────────────────────────────────────
        const nested = data.data ?? {};

        const providerStatus =
            nested.order_status ?? nested.status ??
            data.order_status   ?? data.status   ??
            'Pending';

        const resolvedOrderId =
            nested.order_id ?? nested.orderId ??
            data.order_id   ?? data.orderId   ??
            orderId;

        return {
            providerOrderId: parseInt(String(resolvedOrderId), 10),
            providerStatus: _normaliseTorosStatus(providerStatus),
            unifiedStatus: this.toUnifiedStatus(providerStatus),
            rawResponse: data,
        };
    }

    /**
     * GET /api/CheckListOrders?orders=[1,2,3]
     *
     * Batch status check — more efficient than N×checkOrder().
     *
     * Expected response shape (object map):
     *   {
     *     "12345": { status: "Completed", charge: "2.00", ... },
     *     "12346": { status: "Pending",   charge: "1.50", ... }
     *   }
     *
     * @param {Array<number|string>} orderIds
     * @returns {Promise<OrderStatusResult[]>}
     */
    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];

        const { data } = await this._client.get('/api/CheckListOrders', {
            params: { orders: JSON.stringify(orderIds) },
        });

        // Normalise object-map → array
        const payload = data.orders ?? data.data ?? data;
        const list = Array.isArray(payload)
            ? payload.map((item) => [item.id ?? item.order_id, item])
            : Object.entries(payload);

        return list.map(([id, item]) => ({
            providerOrderId: parseInt(id, 10),
            providerStatus: _normaliseTorosStatus(item.status ?? item.order_status ?? 'Pending'),
            rawResponse: item,
        }));
    }

    // ── Account / Balance ─────────────────────────────────────────────────────

    /**
     * GET /api/GetMyInfo
     *
     * Returns account details (balance, plan, username, etc.).
     *
     * @returns {Promise<Object>} raw provider response body
     */
    async getBalance() {
        const { data } = await this._client.get('/api/GetMyInfo');
        return data;
    }
}

module.exports = { TorosfonAdapter };
