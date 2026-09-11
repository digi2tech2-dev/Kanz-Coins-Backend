'use strict';

/**
 * CanonicalB2BAdapter
 *
 * Adapter for another deployment of this platform's public Canonical B2B API.
 * provider.baseUrl is the complete API base (for example,
 * https://site.example/client/api), not a backend origin.
 */

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');

const DEFAULT_TIMEOUT_MS = 180_000;
const SECRET_KEY = /token|api[_-]?key|authorization|password|secret/i;

const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;

    return Object.entries(value).reduce((safe, [key, item]) => {
        safe[key] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item);
        return safe;
    }, {});
};

const normaliseBaseUrl = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

const getErrorDetails = (error) => ({
    httpStatus: error?.response?.status ?? error?.statusCode ?? null,
    body: sanitize(error?.response?.data ?? error?.providerBody ?? null),
    message: String(error?.message || 'Provider request failed'),
    code: error?.code || null,
});

const isUncertainPlacementError = (error) => {
    const { httpStatus, body, code, message } = getErrorDetails(error);
    const numericCode = Number(body?.code);
    if (numericCode === 111 || numericCode === 130) return false;
    if (httpStatus && httpStatus < 500) return false;
    if (httpStatus >= 500) return true;
    if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'ECONNREFUSED'].includes(code)) return true;
    return /timeout|timed out|socket|network|connection reset/i.test(message);
};

const makeFailureResult = ({ status = 'reject', message, rawResponse }) => ({
    success: false,
    providerOrderId: null,
    providerStatus: status,
    rawResponse: sanitize(rawResponse),
    errorMessage: message,
});

class CanonicalB2BAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);

        const token = this._resolveToken();
        const baseURL = normaliseBaseUrl(provider.baseUrl);
        if (!baseURL) throw new Error('[CanonicalB2B] provider.baseUrl is required');
        if (!token) throw new Error('[CanonicalB2B] api token (apiToken / apiKey) is required');

        this._client = options.httpClient || axios.create({
            baseURL,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            headers: {
                'api-token': token,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        });
    }

    async getBalance() {
        const { data } = await this._client.get('/profile');
        return {
            balance: data?.balance,
            currency: data?.currency,
            email: data?.email,
            rawResponse: sanitize(data),
        };
    }

    async getProducts() {
        const { data } = await this._client.get('/products');
        const products = Array.isArray(data) ? data : (data?.data?.products ?? data?.products ?? []);
        if (!Array.isArray(products)) {
            throw new Error('[CanonicalB2B] GET /products returned an invalid product list');
        }

        return products.map((product) => {
            const currency = product.currency == null ? null : String(product.currency).trim().toUpperCase();
            if (currency && currency !== 'USD') {
                throw new Error(
                    `[CanonicalB2B] Product ${product.id ?? '<unknown>'} declares ${currency}; ` +
                    'the provider price pipeline supports USD only.'
                );
            }

            const qty = product.qty_values;
            const hasRange = qty && typeof qty === 'object' && !Array.isArray(qty)
                && Number.isFinite(Number(qty.min)) && Number.isFinite(Number(qty.max));

            return this._validateDTO({
                externalProductId: String(product.id),
                rawName: String(product.name || 'Unknown'),
                rawPrice: String(product.price),
                minQty: hasRange ? Number(qty.min) : 1,
                maxQty: hasRange ? Number(qty.max) : 1,
                isActive: product.available !== false,
                rawPayload: sanitize(product),
            });
        });
    }

    _readCheckItems(data) {
        if (Array.isArray(data?.data)) return data.data;
        if (Array.isArray(data)) return data;
        return [];
    }

    _normaliseCheckItem(item) {
        if (!item || item.order_id == null) return null;
        return {
            providerOrderId: item.order_id,
            providerStatus: item.status ?? 'wait',
            rawResponse: sanitize(item),
        };
    }

    async checkOrderByReference(referenceId) {
        if (!referenceId) throw new Error('[CanonicalB2B] referenceId is required for reference lookup');
        const { data } = await this._client.get('/check', { params: { uuids: String(referenceId) } });
        const item = this._readCheckItems(data)
            .find((candidate) => String(candidate?.order_uuid || '') === String(referenceId));
        const normalized = this._normaliseCheckItem(item);
        return normalized ? { found: true, ...normalized } : { found: false, rawResponse: sanitize(data) };
    }

    async _recoverUncertainPlacement(referenceId, placementError) {
        try {
            const recovered = await this.checkOrderByReference(referenceId);
            if (recovered.found) {
                return {
                    success: true,
                    providerOrderId: recovered.providerOrderId,
                    providerStatus: recovered.providerStatus,
                    rawResponse: recovered.rawResponse,
                    errorMessage: null,
                };
            }
            return {
                success: true,
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
                rawResponse: {
                    placement: 'uncertain',
                    recovery: 'not_found',
                    httpStatus: getErrorDetails(placementError).httpStatus,
                },
                errorMessage: null,
            };
        } catch (recoveryError) {
            return {
                success: true,
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
                rawResponse: {
                    placement: 'uncertain',
                    recovery: 'lookup_failed',
                    httpStatus: getErrorDetails(placementError).httpStatus,
                    recoveryHttpStatus: getErrorDetails(recoveryError).httpStatus,
                },
                errorMessage: null,
            };
        }
    }

    async placeOrder(params = {}) {
        const externalProductId = String(params.externalProductId ?? params.providerProductId ?? '').trim();
        const quantity = params.quantity;
        const referenceId = String(params.referenceId ?? '').trim();
        if (!/^\d+$/.test(externalProductId) || Number(externalProductId) <= 0) {
            return makeFailureResult({
                message: 'Canonical B2B product ID must be a positive numeric compatibility ID',
                rawResponse: { validation: 'invalid_product_id' },
            });
        }
        if (!referenceId) {
            return makeFailureResult({
                message: 'Canonical B2B referenceId is required',
                rawResponse: { validation: 'missing_reference_id' },
            });
        }

        const { externalProductId: _externalProductId, providerProductId: _providerProductId,
            quantity: _quantity, amount: _amount, productId: _productId, referenceId: _referenceId,
            price: _price, basePrice: _basePrice, providerPrice: _providerPrice,
            walletBalance: _walletBalance, balance: _balance, currency: _currency,
            ...mappedFields } = params;
        const payload = {
            product_id: Number(externalProductId),
            qty: quantity,
            order_uuid: referenceId,
            params: mappedFields,
        };

        try {
            const { data } = await this._client.post('/orders', payload);
            const order = data?.data;
            if (data?.status !== 'OK' || !order?.order_id) {
                return makeFailureResult({
                    message: order?.message ?? data?.message ?? 'Canonical B2B provider rejected the order',
                    rawResponse: data,
                });
            }
            return {
                success: true,
                providerOrderId: order.order_id,
                providerStatus: order.status ?? 'wait',
                rawResponse: sanitize(data),
                errorMessage: null,
            };
        } catch (error) {
            if (isUncertainPlacementError(error)) {
                return this._recoverUncertainPlacement(referenceId, error);
            }
            const details = getErrorDetails(error);
            return makeFailureResult({
                message: details.body?.message ?? details.message,
                rawResponse: {
                    httpStatus: details.httpStatus,
                    code: details.body?.code ?? null,
                    message: details.body?.message ?? details.message,
                },
            });
        }
    }

    async checkOrders(orderIds) {
        if (!Array.isArray(orderIds) || orderIds.length === 0) return [];
        const { data } = await this._client.get('/check', { params: { orders: orderIds.join(',') } });
        const requested = new Set(orderIds.map(String));
        return this._readCheckItems(data)
            .map((item) => this._normaliseCheckItem(item))
            .filter((item) => item && requested.has(String(item.providerOrderId)));
    }

    async checkOrder(orderId) {
        const results = await this.checkOrders([orderId]);
        return results.find((result) => String(result.providerOrderId) === String(orderId)) || null;
    }
}

module.exports = { CanonicalB2BAdapter, sanitize, normaliseBaseUrl };
