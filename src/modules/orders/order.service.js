'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const { Product, computeFinalPrice, PROVIDER_ROUTING_MODES } = require('../products/product.model');
const { Provider } = require('../providers/provider.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('./order.model');
const { debitWalletAtomic, refundWalletAtomic } = require('../wallet/wallet.service');
const { calculateUserPrice } = require('./pricing.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { validateOrderFields } = require('./orderFields.validator');
const {
    NotFoundError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    PROVIDER_ACTIONS,
    ADMIN_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { convertUsdToUserCurrency } = require('../../services/currencyConverter.service');
const { User } = require('../users/user.model');
const Group = require('../groups/group.model');
const { getLivePrice, invalidate: invalidatePriceCache } = require('../providers/providerPriceCache');
const { selectProviderOfferForOrder, toPlainMapping } = require('../products/providerOfferRouting.service');
const { toDecimal, toStr, toFiat, multiply, subtract, add, isPositive, compare } = require('../../shared/utils/decimalPrecision');
const { notifyNewManualOrder, notifyOrderCompleted, notifyOrderFailed } = require('../notifications/notification.service');
const whatsappService = require('../whatsapp/whatsapp.service');

const TRANSACTION_UNSUPPORTED_PATTERN = /Transaction numbers are only allowed|replica set member|mongos|transaction.*not supported/i;
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_NUMBER_LENGTH = 8;
const ORDER_NUMBER_MAX_ATTEMPTS = 20;

const buildRoutingSnapshot = (selection, selectedAt) => {
    if (!selection) return {};
    const { offer, provider, providerProduct, cost } = selection;
    return {
        selectedProviderOffer: offer._id,
        providerIdSnapshot: provider._id,
        providerProductIdSnapshot: providerProduct._id,
        providerExternalProductIdSnapshot: cost.externalProductId,
        providerCostSnapshot: cost.supplierCost,
        providerCostCurrencySnapshot: cost.supplierCurrency,
        providerNormalizedCostSnapshot: cost.normalizedCost,
        providerNormalizedCurrencySnapshot: cost.normalizedCurrency,
        providerNormalizationRateSnapshot: cost.normalizationRate ?? null,
        providerPriceSemanticsSnapshot: cost.priceSemantics,
        providerQuantitySnapshot: cost.providerQuantity,
        providerMappingSnapshot: toPlainMapping(offer.providerMapping),
        providerSelectedAt: selectedAt,
    };
};

const isTransactionUnsupportedError = (err) => {
    const message = `${err?.message || ''} ${err?.errmsg || ''}`;
    return TRANSACTION_UNSUPPORTED_PATTERN.test(message);
};

const shouldUseOrderTransactions = () => {
    const override = String(process.env.ORDER_CREATION_TRANSACTIONS || '').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(override)) return false;
    if (['true', '1', 'on', 'yes'].includes(override)) return true;

    const topologyType = mongoose.connection?.client?.topology?.description?.type;
    if (!topologyType) return process.env.NODE_ENV === 'production';

    return !['Single', 'Unknown'].includes(topologyType);
};

const generateOrderNumberCandidate = () => {
    let code = '';
    for (let i = 0; i < ORDER_NUMBER_LENGTH; i += 1) {
        code += ORDER_NUMBER_ALPHABET[crypto.randomInt(ORDER_NUMBER_ALPHABET.length)];
    }
    return code;
};

const generateUniqueOrderNumber = async () => {
    for (let attempt = 0; attempt < ORDER_NUMBER_MAX_ATTEMPTS; attempt += 1) {
        const candidate = generateOrderNumberCandidate();
        const exists = await Order.exists({ orderNumber: candidate });
        if (!exists) return candidate;
    }

    throw new Error('Unable to generate a unique order number.');
};

const isDuplicateOrderNumberError = (err) => (
    err?.code === 11000
    && (
        err?.keyPattern?.orderNumber
        || err?.keyValue?.orderNumber
        || /orderNumber/.test(String(err?.message || ''))
    )
);

const abortTransactionQuietly = async (session) => {
    if (!session?.inTransaction?.()) return;
    try {
        await session.abortTransaction();
    } catch (err) {
        console.error('[Order] abortTransaction failed:', err.message);
    }
};

const endSessionQuietly = (session) => {
    try {
        session?.endSession?.();
    } catch (_) {
        // already ended
    }
};

const humanizeOrderFieldKey = (key) => String(key || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const toPlainFieldMap = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value.entries());
    if (typeof value.toObject === 'function') return value.toObject();
    if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
    return {};
};

const stringifyOrderFieldValue = (value) => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(stringifyOrderFieldValue).filter(Boolean).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).trim();
};

const getOrderFieldLabel = (key, order, product) => {
    const candidates = [
        ...(Array.isArray(order?.customerInput?.fieldsSnapshot) ? order.customerInput.fieldsSnapshot : []),
        ...(Array.isArray(product?.orderFields) ? product.orderFields : []),
        ...(Array.isArray(product?.dynamicFields) ? product.dynamicFields : []),
    ];

    const field = candidates.find((item) => (
        String(item?.key || item?.name || item?.id || '').trim() === key
    ));

    return String(
        field?.labelAr
        || field?.label
        || field?.nameAr
        || field?.name
        || humanizeOrderFieldKey(key)
    ).trim();
};

const buildOrderFieldsNotificationBlock = (order, product = null) => {
    const values = {
        ...toPlainFieldMap(order?.orderFieldsValues),
        ...toPlainFieldMap(order?.customerInput?.values),
        ...toPlainFieldMap(order?.customInputs),
    };

    const lines = Object.entries(values)
        .map(([rawKey, rawValue]) => {
            const key = String(rawKey || '').trim();
            const value = stringifyOrderFieldValue(rawValue);
            if (!key || !value) return null;
            return `${getOrderFieldLabel(key, order, product)}: ${value}`;
        })
        .filter(Boolean);

    return lines.length > 0 ? `\n\n*بيانات الطلب:*\n${lines.join('\n')}` : '';
};

const notifyAdminOrderCreated = ({ order, userId, productName, quantity, product = null }) => {
    try {
        (async () => {
            const user = await User.findById(userId).select('name email').lean();
            const orderRef = order?.displayId || order?.orderNumber || order?._id;
            const userName = user?.name || user?.email || userId;
            const orderFieldsBlock = buildOrderFieldsNotificationBlock(order, product || order?.productId);

            await whatsappService.sendAdminNotification(
                `📦 *طلب جديد!*\nرقم: ${orderRef}\nالمستخدم: ${userName}\nالمنتج: ${productName}\nالكمية: ${quantity}${orderFieldsBlock}`
            );
        })().catch((err) => {
            console.error('WhatsApp Notification failed:', err.message);
        });
    } catch (err) {
        console.error('WhatsApp Notification failed:', err.message);
    }
};

const DYNAMIC_INPUT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeCustomInputsPayload = (customInputs) => {
    if (!customInputs) return {};

    if (Array.isArray(customInputs)) {
        return customInputs.reduce((acc, item) => {
            if (!item || typeof item !== 'object') return acc;

            const fieldKey = String(
                item.key ?? item.name ?? item.label ?? item.field ?? item.id ?? ''
            ).trim();
            if (!fieldKey) return acc;

            const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
            const resolvedValue = hasValue
                ? item.value
                : (item.input ?? item.answer ?? item.data);

            if (resolvedValue !== undefined) {
                acc[fieldKey] = resolvedValue;
            }

            return acc;
        }, {});
    }

    if (typeof customInputs === 'object') {
        return { ...customInputs };
    }

    return {};
};

const normalizeOrderInputPayload = (orderFieldsValues, customInputs) => {
    const normalizedOrderFields = (
        orderFieldsValues
        && typeof orderFieldsValues === 'object'
        && !Array.isArray(orderFieldsValues)
    )
        ? orderFieldsValues
        : {};

    return {
        ...normalizedOrderFields,
        ...normalizeCustomInputsPayload(customInputs),
    };
};

const validateDynamicFieldsInput = (dynamicFields = [], submittedValues = {}) => {
    const normalizedSubmitted = (
        submittedValues
        && typeof submittedValues === 'object'
        && !Array.isArray(submittedValues)
    )
        ? submittedValues
        : {};

    const aliasMap = new Map();
    const activeFields = (Array.isArray(dynamicFields) ? dynamicFields : []).filter(Boolean);
    const errors = [];

    for (const field of activeFields) {
        const canonicalKey = String(field.name || field.label || '').trim();
        if (!canonicalKey) continue;

        const aliases = [field.name, field.label]
            .map((alias) => String(alias || '').trim().toLowerCase())
            .filter(Boolean);

        for (const alias of aliases) {
            if (!aliasMap.has(alias)) {
                aliasMap.set(alias, { field, canonicalKey });
            }
        }
    }

    const mappedValues = {};
    const unknownKeys = [];

    for (const [submittedKey, rawValue] of Object.entries(normalizedSubmitted)) {
        const normalizedKey = String(submittedKey || '').trim().toLowerCase();
        const matched = aliasMap.get(normalizedKey);
        if (!matched) {
            unknownKeys.push(submittedKey);
            continue;
        }

        mappedValues[matched.canonicalKey] = rawValue;
    }

    if (unknownKeys.length > 0) {
        throw new BusinessRuleError(
            `Unknown custom input field(s): ${unknownKeys.map((key) => `'${key}'`).join(', ')}.`,
            'INVALID_ORDER_FIELDS'
        );
    }

    for (const field of activeFields) {
        const canonicalKey = String(field.name || field.label || '').trim();
        if (!canonicalKey) continue;

        const rawValue = mappedValues[canonicalKey];
        const isMissing = rawValue === undefined || rawValue === null || rawValue === '';
        const isRequired = field.required !== false;

        if (isRequired && isMissing) {
            errors.push(`'${field.label || canonicalKey}' (key: '${canonicalKey}') is required.`);
            continue;
        }

        if (isMissing) continue;

        const fieldType = String(field.type || 'text').toLowerCase();
        if (fieldType === 'number') {
            const numericValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
            if (!Number.isFinite(numericValue)) {
                errors.push(`'${field.label || canonicalKey}' must be a valid number.`);
                continue;
            }
            mappedValues[canonicalKey] = numericValue;
            continue;
        }

        if (fieldType === 'email') {
            const emailValue = String(rawValue || '').trim();
            if (!emailValue || !DYNAMIC_INPUT_EMAIL_REGEX.test(emailValue)) {
                errors.push(`'${field.label || canonicalKey}' must be a valid email.`);
                continue;
            }
            mappedValues[canonicalKey] = emailValue;
            continue;
        }

        const textValue = String(rawValue || '').trim();
        if (!textValue) {
            errors.push(`'${field.label || canonicalKey}' must be a non-empty value.`);
            continue;
        }
        mappedValues[canonicalKey] = textValue;
    }

    if (errors.length > 0) {
        throw new BusinessRuleError(
            `Order field validation failed: ${errors.join(' ')}`,
            'INVALID_ORDER_FIELDS'
        );
    }

    const fieldsSnapshot = activeFields
        .map((field) => {
            const name = String(field.name || '').trim();
            const label = String(field.label || '').trim();
            if (!name || !label) return null;
            return {
                name,
                label,
                type: String(field.type || 'text').toLowerCase(),
                required: field.required !== false,
            };
        })
        .filter(Boolean);

    return { values: mappedValues, fieldsSnapshot };
};

const remapOrderFieldsInputByAliases = (orderFields = [], submittedValues = {}) => {
    const normalizedSubmitted = (
        submittedValues
        && typeof submittedValues === 'object'
        && !Array.isArray(submittedValues)
    )
        ? submittedValues
        : {};

    const aliasToKey = new Map();
    for (const field of (Array.isArray(orderFields) ? orderFields : [])) {
        const canonicalKey = String(field?.key || '').trim();
        if (!canonicalKey) continue;

        const aliases = [field?.key, field?.label, field?.id]
            .map((alias) => String(alias || '').trim().toLowerCase())
            .filter(Boolean);

        for (const alias of aliases) {
            if (!aliasToKey.has(alias)) {
                aliasToKey.set(alias, canonicalKey);
            }
        }
    }

    const remapped = {};
    for (const [submittedKey, rawValue] of Object.entries(normalizedSubmitted)) {
        const normalizedKey = String(submittedKey || '').trim().toLowerCase();
        const canonicalKey = aliasToKey.get(normalizedKey) || submittedKey;
        remapped[canonicalKey] = rawValue;
    }

    return remapped;
};

// ─────────────────────────────────────────────────────────────────────────────
// JIT PRICE AUTO-UPDATE HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget: update the product's providerPrice, basePrice, and
 * finalPrice when a JIT check detects the provider has raised the price.
 *
 * Uses the same formula as the sync engine (providerProductSync.service.js)
 * so prices remain consistent.
 *
 * Runs OUTSIDE any transaction — it is OK if this fails; the next sync
 * cycle will correct it anyway. The important thing is that the ORDER
 * was already aborted.
 *
 * @param {ObjectId}           productId
 * @param {number}             newProviderPrice   - live rawPrice from provider
 * @param {'percentage'|'fixed'} markupType
 * @param {number}             markupValue
 * @private
 */
const _autoUpdateProductPrice = (productId, newProviderPrice, markupType, markupValue) => {
    // Intentionally NOT awaited — fire-and-forget
    (async () => {
        try {
            const safeProviderPrice = String(newProviderPrice);
            const newFinalPrice = computeFinalPrice(safeProviderPrice, markupType, markupValue);
            const newBasePrice = newFinalPrice ?? safeProviderPrice;

            await Product.findByIdAndUpdate(productId, {
                $set: {
                    providerPrice: safeProviderPrice,
                    finalPrice: newFinalPrice,
                    basePrice: newBasePrice,
                },
            });
        } catch (err) {
            // Swallow — the sync engine will correct this on its next run.
            // A failed auto-update must never crash the process.
        }
    })();
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new order with full financial safety.
 *
 * For AUTOMATIC products (linked to a provider):
 *   - Order lands in PROCESSING status after the financial transaction commits.
 *   - executeOrder() is called fire-and-forget, so the HTTP response is
 *     returned to the client immediately with PROCESSING status.
 *   - The fulfillment engine handles provider call + result handling + refund.
 *
 * For MANUAL products:
 *   - Behaviour unchanged. Order lands in PENDING status (admin fulfils manually).
 *
 * @param {Object}      params
 * @param {ObjectId}    params.userId
 * @param {ObjectId}    params.productId
 * @param {number}      params.quantity
 * @param {string|null} params.idempotencyKey
 * @param {Object|null} params.auditContext
 * @param {Object|null} params.orderFieldsValues  - dynamic field values submitted by customer
 * @param {Object|Array|null} params.customInputs - frontend custom inputs payload (object or array)
 * @param {Object|null} params.provider           - adapter instance (injected for testability)
 */
const createOrder = async ({
    userId,
    productId,
    quantity,
    idempotencyKey = null,
    auditContext = null,
    orderFieldsValues = null,
    customInputs = null,
    provider = null,   // ← injected; null = auto-resolve from factory
}) => {
    const normalizedOrderInput = normalizeOrderInputPayload(orderFieldsValues, customInputs);

    // ── Pre-transaction: Idempotency Check ───────────────────────────────────
    if (idempotencyKey) {
        const existing = await Order.findOne({ userId, idempotencyKey })
            .populate('productId', 'name basePrice executionType providerProduct');
        if (existing) {
            return { order: existing, idempotent: true };
        }
    }

    // ── Auto-resolve provider adapter (production flow) ──────────────────────
    // If no adapter was injected (i.e. called from HTTP controller), resolve
    // the adapter from the factory using the product's linked Provider doc.
    // Tests always inject their own mock, so this branch is never reached
    // in test runs.
    let resolvedProvider = provider;

    // providerCode is the canonical slug/name snapshot written to the Order.
    // The cron uses this field — NOT the product — so a later admin provider
    // swap cannot corrupt in-flight PROCESSING orders.
    let providerCode = null;

    if (!resolvedProvider) {
        try {
            const prod = await Product.findById(productId)
                .select('executionType provider providerRoutingMode')
                .populate('provider');
            if (
                prod?.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC &&
                prod?.providerRoutingMode !== PROVIDER_ROUTING_MODES.MULTI_PROVIDER &&
                prod?.provider?._id
            ) {
                const providerDoc = prod.provider.toObject
                    ? prod.provider
                    : await Provider.findById(prod.provider);

                // ── Snapshot the provider code UNCONDITIONALLY ──────────────
                // providerCode must be captured even when the provider is
                // inactive — the code identifies which provider the order
                // belongs to for admin review / DLQ.  The adapter is only
                // obtained when the provider is active.
                if (providerDoc) {
                    providerCode = String(providerDoc.slug || providerDoc.name || '')
                        .toLowerCase().trim() || null;
                }

                if (providerDoc?.isActive) {
                    resolvedProvider = getProviderAdapter(providerDoc);
                } else {
                    console.warn(`[Order] Provider ${prod.provider._id} is INACTIVE — fulfillment will self-resolve.`);
                }
            }
        } catch (resolveErr) {
            // Log instead of silently swallowing — critical for debugging
            console.error(`[Order] Provider resolution failed for product ${productId}:`, resolveErr.message);
            // resolvedProvider stays null — executeOrder will self-resolve
            // providerCode may have been set before the error; if not, the
            // fallback inside _attemptCreateOrder will try again.
        }
    }

    return _attemptCreateOrder({
        userId,
        productId,
        quantity,
        idempotencyKey,
        auditContext,
        orderFieldsValues: normalizedOrderInput,
        provider: resolvedProvider,
        providerCode,
    });

};

/**
 * Internal helper — executes the transactional order creation.
 * Retried once on WriteConflict (code 112) or lock timeout (code 24).
 * @private
 */
const _attemptCreateOrder = async (
    { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider, providerCode = null },
    isRetry = false,
    forceStandalone = false,
    orderNumberRetryCount = 0
) => {

    const useTransaction = !forceStandalone && shouldUseOrderTransactions();
    const session = useTransaction ? await mongoose.startSession() : null;

    // 0. Assign short random order number (outside txn)
    // Random identifiers are generated outside the transaction so the
    // uniqueness check sees committed orders.
    const orderNumber = await generateUniqueOrderNumber();

    try {
        if (session) {
            session.startTransaction({
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority' },
            });
        }

        // ── 1. Load & Validate Product ─────────────────────────────────────────
        const product = await Product.findById(productId).session(session);
        if (!product) throw new NotFoundError('Product');
        if (!product.isActive) {
            throw new BusinessRuleError('This product is currently unavailable.', 'PRODUCT_INACTIVE');
        }

        // ── 2. Validate Quantity Bounds ────────────────────────────────────────
        const qty = parseInt(quantity, 10);
        if (qty < product.minQty || qty > product.maxQty) {
            throw new BusinessRuleError(
                `Quantity must be between ${product.minQty} and ${product.maxQty}.`,
                'QUANTITY_OUT_OF_RANGE'
            );
        }

        // ── 2b. Validate / capture dynamic order fields ─────────────────────────
        // Runs BEFORE any financial mutation so a bad field value costs nothing.
        //
        // If the product defines formal orderFields, validate against them.
        // Else if dynamicFields are defined, validate against the lightweight
        // dynamic schema.
        // Otherwise, pass through raw values so that link/target/etc. still
        // reach the provider (critical for SMM-panel services).
        let customerInput = null;
        const hasSubmittedValues = (
            orderFieldsValues
            && typeof orderFieldsValues === 'object'
            && !Array.isArray(orderFieldsValues)
            && Object.keys(orderFieldsValues).length > 0
        );

        if (product.orderFields && product.orderFields.length > 0) {
            const normalizedFieldValues = remapOrderFieldsInputByAliases(
                product.orderFields,
                orderFieldsValues
            );
            // validateOrderFields throws BusinessRuleError on invalid input
            const { values, fieldsSnapshot } = validateOrderFields(
                product.orderFields,
                normalizedFieldValues
            );
            customerInput = { values, fieldsSnapshot };
        } else if (product.dynamicFields && product.dynamicFields.length > 0) {
            const { values, fieldsSnapshot } = validateDynamicFieldsInput(
                product.dynamicFields,
                orderFieldsValues
            );
            customerInput = { values, fieldsSnapshot };
        } else if (hasSubmittedValues) {
            // No formal schema — save raw values so the fulfillment engine
            // can forward them to the provider (e.g. { link: '...' }).
            customerInput = { values: orderFieldsValues, fieldsSnapshot: [] };
        }

        // ── 2c. Multi-provider selection (before any debit/quota mutation) ──
        // Routing mode is explicit. LEGACY ignores ProductProviderOffer records
        // (including enabled backfilled mappings) and preserves scalar routing.
        // MULTI_PROVIDER never falls back to Product.provider/providerProduct.
        let routingSelection = null;
        if (
            product.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC
            && product.providerRoutingMode === PROVIDER_ROUTING_MODES.MULTI_PROVIDER
        ) {
            const selection = await selectProviderOfferForOrder({
                product,
                quantity: qty,
                customerInput: customerInput?.values ?? {},
                asOf: new Date(),
                session,
            });
            if (!selection.selected) {
                throw new BusinessRuleError(
                    'No eligible provider offer is available for this order.',
                    'NO_ELIGIBLE_PROVIDER_OFFER'
                );
            }
            routingSelection = selection.selected;
            providerCode = String(routingSelection.provider.slug || routingSelection.provider.name || '')
                .toLowerCase().trim() || null;
            // Selection already performs strict, no-network adapter validation.
            // Use the selected adapter for immediate fulfillment only; the Order
            // snapshot remains the source of truth for later execution/retries.
            provider = getProviderAdapter(routingSelection.provider, { strict: true });
        }

        // ── 2d. Legacy JIT Provider Price Verification ─────────────────────────
        //
        // If this product is linked to a provider, verify the provider's live
        // price hasn't increased since the last catalog sync.  This prevents
        // selling at a loss when a provider raises prices between sync cycles.
        //
        // Performance: uses an in-memory cache (5-min TTL) so the full catalog
        // is fetched at most once per provider per TTL window.
        //
        // Fault-tolerant: if the provider API is unreachable, the order
        // proceeds with the cached DB price.  A transient outage should NOT
        // block legitimate orders.
        //
        if (!routingSelection && product.provider && product.providerProduct && provider) {
            try {
                // Look up the externalProductId from the linked ProviderProduct
                const ppDoc = await ProviderProduct.findById(product.providerProduct)
                    .select('externalProductId')
                    .lean();

                if (ppDoc?.externalProductId) {
                    const livePrice = await getLivePrice(
                        String(product.provider),
                        ppDoc.externalProductId,
                        provider
                    );

                    if (livePrice !== null && product.providerPrice != null) {
                        // Use decimal.js for lossless comparison (prices are 50dp strings)
                        if (compare(String(livePrice), String(product.providerPrice)) > 0) {
                            // ── Price increased — abort order, auto-update DB ──
                            _autoUpdateProductPrice(product._id, livePrice, product.markupType, product.markupValue);
                            invalidatePriceCache(String(product.provider));

                            throw new BusinessRuleError(
                                'The provider has increased the price for this service. ' +
                                'The catalog has been automatically updated. ' +
                                'Please refresh and review the new price before ordering.',
                                'PROVIDER_PRICE_INCREASED'
                            );
                        }
                    }
                }
            } catch (jitErr) {
                // Re-throw our own BusinessRuleError (price increase abort)
                if (jitErr.code === 'PROVIDER_PRICE_INCREASED') throw jitErr;
                // Swallow all other errors (API timeout, network failure, etc.)
                // — proceed with the cached DB price rather than blocking the order.
            }
        }

        const routingSnapshot = buildRoutingSnapshot(routingSelection, new Date());

        // ── 2e. Quantity-Only Billing Mode Branch ────────────────────────────
        // If the user's group uses quantity_only billing, bypass all pricing,
        // currency conversion, and wallet debit. Instead, atomically increment
        // quantityUsed and create an order with zero financial fields.
        const userGroupDoc = await Group.findById(
            (await User.findById(userId).select('groupId').session(session || null))?.groupId
        ).select('billingMode').session(session || null);

        const isQuantityOnly = userGroupDoc?.billingMode === 'quantity_only';

        if (isQuantityOnly) {
            const quotaUser = await User.findById(userId)
                .select('quantityUsed quantityLimit')
                .session(session || null);
            const currentQuantityUsed = Number(quotaUser?.quantityUsed || 0);
            const currentQuantityLimit = Number(quotaUser?.quantityLimit || 0);

            if (currentQuantityUsed + qty > currentQuantityLimit) {
                throw new BusinessRuleError('الكمية المطلوبة أكبر من الكوتا المتبقية لك.', 'QUOTA_EXCEEDED');
            }

            // ── Atomic quota enforcement via $inc + filter guard ─────────────
            const updateFilter = {
                _id: userId,
                $expr: { $lte: [{ $add: ['$quantityUsed', qty] }, '$quantityLimit'] },
            };
            const updateOp = { $inc: { quantityUsed: qty } };

            const updatedUser = session
                ? await User.findOneAndUpdate(updateFilter, updateOp, { new: true, session })
                : await User.findOneAndUpdate(updateFilter, updateOp, { new: true });

            if (!updatedUser) {
                throw new BusinessRuleError(
                    `Insufficient quantity quota. Requested ${qty}, but the remaining quota would be exceeded.`,
                    'QUANTITY_LIMIT_EXCEEDED'
                );
            }

            // ── Determine execution type & initial status ────────────────────
            const isAutomatic = product.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC;
            const initialStatus = isAutomatic ? ORDER_STATUS.PROCESSING : ORDER_STATUS.PENDING;

            const orderId = new mongoose.Types.ObjectId();

            // ── Create order with zero financial fields ──────────────────────
            const orderData = {
                _id: orderId,
                userId,
                productId: product._id,
                orderNumber,
                quantity: qty,
                basePriceSnapshot: '0',
                markupPercentageSnapshot: 0,
                finalPriceCharged: '0',
                groupIdSnapshot: userGroupDoc?._id ?? null,
                profitUsd: '0',
                unitPrice: '0',
                totalPrice: '0',
                walletDeducted: 0,
                creditUsedAmount: '0',
                status: initialStatus,
                executionType: product.executionType,
                customerInput,
                customInputs: customerInput?.values ?? null,
                providerCode: providerCode ?? null,
                ...routingSnapshot,
                currency: 'USD',
                rateSnapshot: 1,
                usdAmount: '0',
                chargedAmount: 0,
            };
            if (idempotencyKey) orderData.idempotencyKey = idempotencyKey;

            let order;
            try {
                if (session) {
                    [order] = await Order.create([orderData], { session });
                } else {
                    order = await Order.create(orderData);
                }
            } catch (createErr) {
                if (isDuplicateOrderNumberError(createErr) && orderNumberRetryCount < ORDER_NUMBER_MAX_ATTEMPTS) {
                    await User.findByIdAndUpdate(userId, { $inc: { quantityUsed: -qty } }, session ? { session } : {}).catch(() => {});
                    await abortTransactionQuietly(session);
                    endSessionQuietly(session);
                    return _attemptCreateOrder(
                        { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider, providerCode },
                        isRetry,
                        forceStandalone,
                        orderNumberRetryCount + 1
                    );
                }
                if (createErr.code === 11000 && idempotencyKey) {
                    // Duplicate — reverse the quantity increment
                    await User.findByIdAndUpdate(userId, { $inc: { quantityUsed: -qty } }, session ? { session } : {}).catch(() => {});
                    await abortTransactionQuietly(session);
                    endSessionQuietly(session);
                    const existing = await Order.findOne({ userId, idempotencyKey })
                        .populate('productId', 'name basePrice executionType providerProduct');
                    return { order: existing, idempotent: true };
                }
                // Non-duplicate failure — reverse the quantity increment
                if (!session) {
                    await User.findByIdAndUpdate(userId, { $inc: { quantityUsed: -qty } }).catch(() => {});
                }
                throw createErr;
            }

            // ── Commit ───────────────────────────────────────────────────────
            if (session) {
                await session.commitTransaction();
            }

            await order.populate([{ path: 'productId', select: 'name basePrice executionType providerProduct' }]);

            // ── Audit — fire-and-forget ──────────────────────────────────────
            createAuditLog({
                actorId: auditContext?.actorId ?? userId,
                actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
                ipAddress: auditContext?.ipAddress ?? null,
                userAgent: auditContext?.userAgent ?? null,
                action: ORDER_ACTIONS.CREATED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: {
                    userId,
                    productId: product._id,
                    quantity: qty,
                    billingMode: 'quantity_only',
                    quantityUsed: updatedUser.quantityUsed,
                    quantityLimit: updatedUser.quantityLimit,
                    status: initialStatus,
                },
            });

            // ── Fulfillment — fire-and-forget (same as standard path) ────────
            if (!isAutomatic) {
                notifyNewManualOrder(order);
            }

            notifyAdminOrderCreated({
                order,
                userId,
                productName: product.name,
                quantity: qty,
                product,
            });

            if (isAutomatic) {
                createAuditLog({
                    actorId: auditContext?.actorId ?? userId,
                    actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
                    ipAddress: auditContext?.ipAddress ?? null,
                    userAgent: auditContext?.userAgent ?? null,
                    action: ORDER_ACTIONS.PROCESSING,
                    entityType: ENTITY_TYPES.ORDER,
                    entityId: order._id,
                    metadata: { orderId: order._id.toString(), status: ORDER_STATUS.PROCESSING },
                });

                const { executeOrder } = require('./orderFulfillment.service');
                executeOrder(order._id, provider, auditContext).catch((err) => {
                    console.error(`[Order] executeOrder failed for ${order._id}:`, err.message);
                });
            }

            return { order, idempotent: false };
        }
        // ── END Quantity-Only Branch ─────────────────────────────────────────

        // ── 3. Pricing Engine (USD) ────────────────────────────────────────────
        const pricing = await calculateUserPrice(userId, product.basePrice, session);
        const usdTotalPrice = multiply(pricing.finalPrice, String(qty));

        // ── 3a. Profit Calculation (USD) ────────────────────────────────────────
        // Manual products can define costPrice explicitly. For provider-linked
        // products, keep using pricing.basePrice as the cost basis.
        const numericCostPrice = Number(product.costPrice);
        const effectiveUnitCost = (
            !product.provider
            && Number.isFinite(numericCostPrice)
            && numericCostPrice > 0
        )
            ? String(numericCostPrice)
            : pricing.basePrice;
        const profitUsd = routingSelection
            ? subtract(usdTotalPrice, routingSelection.cost.normalizedCost)
            : multiply(subtract(pricing.finalPrice, effectiveUnitCost), String(qty));

        // ── 3b. Currency Conversion ────────────────────────────────────────────
        // Fetch the user's preferred currency (within the session for consistency).
        // For USD users this is a no-op (rate = 1, finalAmount = usdTotalPrice).
        const userDoc = await User.findById(userId).select('currency').session(session);
        const userCurrency = userDoc?.currency ?? 'USD';
        const conversion = await convertUsdToUserCurrency(Number(toDecimal(usdTotalPrice).toNumber()), userCurrency);
        // ── FINAL ROUNDING — only place we round to 2dp ────────────────────
        const chargedAmount = toFiat(conversion.finalAmount);
        const rateSnapshot = conversion.rate;

        // ── 3c. FINAL PRICE GUARD ──────────────────────────────────────────────
        // Prevent NaN / Infinity / zero from reaching the wallet debit.
        if (!Number.isFinite(chargedAmount) || chargedAmount <= 0) {
            throw new BusinessRuleError(
                'Invalid order price calculation. The final charged amount must be a positive number. ' +
                `(basePrice=${pricing.basePrice}, markup=${pricing.markupPercentage}%, ` +
                `usdTotal=${usdTotalPrice}, currency=${userCurrency}, rate=${rateSnapshot}, ` +
                `chargedAmount=${chargedAmount})`,
                'INVALID_PRICE_CALCULATION'
            );
        }

        const orderId = new mongoose.Types.ObjectId();

        // ── 4. Atomic Debit (in user currency) ────────────────────────────────
        const { walletDeducted, creditUsedAmount } = await debitWalletAtomic({
            userId,
            amount: chargedAmount,     // ← wallet always in user currency
            reference: orderId,
            description: `Payment for: ${product.name} x${qty}`,
            session,
        });

        // ── 5. Determine initial status & execution type ───────────────────────
        // An AUTOMATIC product → PROCESSING (fulfillment attempted post-commit)
        // Any other case        → PENDING   (admin handles manually)
        const isAutomatic = product.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC;
        const initialStatus = isAutomatic ? ORDER_STATUS.PROCESSING : ORDER_STATUS.PENDING;

        // ── 6. Create Order ────────────────────────────────────────────────────
        const orderData = {
            _id: orderId,
            userId,
            productId: product._id,
            orderNumber,
            quantity: qty,
            basePriceSnapshot: pricing.basePrice,
            markupPercentageSnapshot: pricing.markupPercentage,
            finalPriceCharged: pricing.finalPrice,
            groupIdSnapshot: pricing.groupId,
            profitUsd: profitUsd,
            unitPrice: pricing.finalPrice,
            totalPrice: String(chargedAmount),   // legacy field — now equals chargedAmount
            walletDeducted,
            creditUsedAmount,
            status: initialStatus,
            executionType: product.executionType,
            customerInput,
            customInputs: customerInput?.values ?? null,
            // ── Provider code snapshot (immutable — cron uses this, not product.provider) ──
            providerCode: providerCode ?? null,
            ...routingSnapshot,
            // ── Currency snapshot ────────────────────────────────────────────
            currency: userCurrency,
            rateSnapshot,
            usdAmount: usdTotalPrice,
            chargedAmount,
        };
        if (idempotencyKey) orderData.idempotencyKey = idempotencyKey;

        let order;
        try {
            if (session) {
                [order] = await Order.create([orderData], { session });
            } else {
                order = await Order.create(orderData);
            }
        } catch (createErr) {
            if (isDuplicateOrderNumberError(createErr) && orderNumberRetryCount < ORDER_NUMBER_MAX_ATTEMPTS) {
                if (!session) {
                    await refundWalletAtomic({
                        userId,
                        walletDeducted,
                        creditUsedAmount: Number(creditUsedAmount) || 0,
                        reference: orderId,
                        description: `Reversal for duplicate order number retry: ${product.name} x${qty}`,
                    }).catch((refundErr) => {
                        console.error(`[Order] standalone duplicate order number compensation failed for ${orderId}:`, refundErr.message);
                    });
                }
                await abortTransactionQuietly(session);
                endSessionQuietly(session);
                return _attemptCreateOrder(
                    { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider, providerCode },
                    isRetry,
                    forceStandalone,
                    orderNumberRetryCount + 1
                );
            }
            if (createErr.code === 11000 && idempotencyKey) {
                if (!session) {
                    await refundWalletAtomic({
                        userId,
                        walletDeducted,
                        creditUsedAmount: Number(creditUsedAmount) || 0,
                        reference: orderId,
                        description: `Reversal for duplicate order request: ${product.name} x${qty}`,
                    }).catch((refundErr) => {
                        console.error(`[Order] standalone duplicate compensation failed for ${orderId}:`, refundErr.message);
                    });
                }
                await abortTransactionQuietly(session);
                endSessionQuietly(session);
                const existing = await Order.findOne({ userId, idempotencyKey })
                    .populate('productId', 'name basePrice executionType providerProduct');
                return { order: existing, idempotent: true };
            }
            if (!session) {
                await refundWalletAtomic({
                    userId,
                    walletDeducted,
                    creditUsedAmount: Number(creditUsedAmount) || 0,
                    reference: orderId,
                    description: `Reversal for failed order creation: ${product.name} x${qty}`,
                }).catch((refundErr) => {
                    console.error(`[Order] standalone create compensation failed for ${orderId}:`, refundErr.message);
                });
            }
            throw createErr;
        }

        // ── 8. Commit ──────────────────────────────────────────────────────────
        if (session) {
            await session.commitTransaction();
        }

        await order.populate([{ path: 'productId', select: 'name basePrice executionType providerProduct' }]);

        // ── 9. Audit: AFTER commit — fire-and-forget ───────────────────────────
        const actorId = auditContext?.actorId ?? userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.CREATED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId,
                productId: product._id,
                quantity: qty,
                usdAmount: usdTotalPrice,
                currency: userCurrency,
                rateSnapshot,
                chargedAmount,
                walletDeducted,
                creditUsedAmount,
                basePriceSnapshot: pricing.basePrice,
                markupPercentageSnapshot: pricing.markupPercentage,
                finalPriceCharged: pricing.finalPrice,
                status: initialStatus,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.DEBIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: userId,
            metadata: {
                orderId: order._id,
                usdAmount: usdTotalPrice,
                currency: userCurrency,
                rateSnapshot,
                chargedAmount,
                walletDeducted,
                creditUsedAmount,
            },
        });

        // ── 10. Trigger provider fulfillment (fire-and-forget) ──────────────────
        // Always fires for AUTOMATIC products. executeOrder self-resolves the
        // provider adapter if none was pre-resolved, and handles all failures
        // (marks FAILED + refunds the wallet).
        if (!isAutomatic) {
            notifyNewManualOrder(order);
        }

        notifyAdminOrderCreated({
            order,
            userId,
            productName: product.name,
            quantity: qty,
            product,
        });

        if (isAutomatic) {
            createAuditLog({
                actorId, actorRole, ipAddress, userAgent,
                action: ORDER_ACTIONS.PROCESSING,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: { orderId: order._id.toString(), status: ORDER_STATUS.PROCESSING },
            });

            // Lazy-require to avoid circular dependency issues
            const { executeOrder } = require('./orderFulfillment.service');

            // Fire-and-forget — client gets PROCESSING response immediately.
            // Pass provider if we have one; executeOrder self-resolves if null.
            executeOrder(order._id, provider, auditContext).catch((err) => {
                console.error(`[Order] executeOrder failed for ${order._id}:`, err.message);
            });
        }

        return { order, idempotent: false };

    } catch (err) {
        await abortTransactionQuietly(session);

        if (session && isTransactionUnsupportedError(err)) {
            endSessionQuietly(session);
            console.warn('[Order] MongoDB transactions are unavailable; retrying order creation without a session.');
            return _attemptCreateOrder(
                { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider, providerCode },
                true,
                true,
                orderNumberRetryCount
            );
        }

        if ((err.code === 112 || err.code === 24) && !isRetry) {
            endSessionQuietly(session);
            await new Promise((r) => setTimeout(r, 10));
            return _attemptCreateOrder(
                { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider, providerCode },
                true,
                forceStandalone,
                orderNumberRetryCount
            );

        }

        throw err;
    } finally {
        endSessionQuietly(session);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// MARK ORDER AS FAILED (REFUND) — manual admin action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark an order as FAILED and issue a REFUND.
 *
 * CROSS-CURRENCY SAFE:
 *   The refund uses order.usdAmount (the USD truth frozen at order time)
 *   and converts it to the user's CURRENT currency rate. This prevents
 *   the bug where a currency change between order and refund causes
 *   the wrong numeric amount to be credited.
 *
 * Double-refund prevention via TWO independent guards:
 *   Guard 1 — status check:    order.status === 'FAILED'  → already failed
 *   Guard 2 — timestamp check: order.refundedAt !== null  → already refunded
 */
const markOrderAsFailed = async (orderId, auditContext = null) => {
    let session = null;
    try {
        session = await mongoose.startSession();
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });
    } catch (_sessionErr) {
        // Standalone MongoDB — transactions unavailable, proceed without session.
        session = null;
    }

    try {
        const order = session
            ? await Order.findById(orderId).session(session)
            : await Order.findById(orderId);
        if (!order) throw new NotFoundError('Order');

        if (order.status === ORDER_STATUS.FAILED) {
            throw new BusinessRuleError(
                'This order has already been marked as failed.',
                'ORDER_ALREADY_FAILED'
            );
        }

        if (order.refundedAt !== null) {
            throw new BusinessRuleError(
                'A refund has already been issued for this order.',
                'ALREADY_REFUNDED'
            );
        }

        // ── Refund amount — use the EXACT amounts originally deducted ────────
        // NEVER do a live currency conversion here. Exchange rates fluctuate.
        // The user must receive back exactly what was taken from their wallet.
        //
        // Source of truth (frozen at order creation):
        //   walletDeducted   – amount debited from the net wallet balance
        //   creditUsedAmount – informational credit drawn by that debit
        //   chargedAmount    – total fallback for legacy orders
        const walletPortion = Number(order.walletDeducted || 0);
        const creditPortion = Number(order.creditUsedAmount || 0);
        const chargedPortion = Number(order.chargedAmount || 0);
        const isLegacySplitRefund = walletPortion > 0
            && creditPortion > 0
            && chargedPortion > 0
            && Math.abs((walletPortion + creditPortion) - chargedPortion) < 0.01;

        // Fallback: support legacy orders that only recorded chargedAmount,
        // or a legacy split where creditUsedAmount carried the refundable value.
        const refundWallet = walletPortion > 0
            ? (isLegacySplitRefund ? walletPortion + creditPortion : walletPortion)
            : (creditPortion > 0 ? creditPortion : Number(order.chargedAmount || 0));
        const refundCredit = creditPortion;
        const totalRefund = refundWallet;

        // ── Quantity-Only Billing: quantity refund instead of wallet ──────
        // For quantity_only orders, all financial fields are 0. The "refund"
        // is decrementing quantityUsed so the user gets their quota back.
        const isQuantityOnlyOrder = totalRefund <= 0 && order.quantity > 0;
        const orderUserGroup = isQuantityOnlyOrder
            ? await Group.findById(
                  (await User.findById(order.userId).select('groupId').session(session || null))?.groupId
              ).select('billingMode').session(session || null)
            : null;
        const isQuantityOnlyRefund = orderUserGroup?.billingMode === 'quantity_only';

        if (totalRefund <= 0 && !isQuantityOnlyRefund) {
            throw new BusinessRuleError(
                'Order has no charged amount to refund.',
                'NO_REFUNDABLE_AMOUNT'
            );
        }

        // ── Update order status ──────────────────────────────────────────────
        order.status = ORDER_STATUS.FAILED;
        order.failedAt = new Date();
        order.refundedAt = new Date();
        order.refunded = true;
        await order.save(session ? { session } : {});

        if (isQuantityOnlyRefund) {
            // Decrement quantityUsed — symmetric to the $inc at order creation
            const decOp = { $inc: { quantityUsed: -order.quantity } };
            if (session) {
                await User.findByIdAndUpdate(order.userId, decOp, { session });
            } else {
                await User.findByIdAndUpdate(order.userId, decOp);
            }
        } else {
            // ── Credit the wallet with the exact original amounts ────────────
            await refundWalletAtomic({
                userId: order.userId,
                walletDeducted: refundWallet,
                creditUsedAmount: refundCredit,
                reference: order._id,
                description: `Refund for failed order #${order.orderNumber || order._id} (${totalRefund} ${order.currency || 'USD'})`,
                session: session || undefined,
            });
        }

        if (session) {
            await session.commitTransaction();
        }

        // ── Audit — AFTER commit ─────────────────────────────────────────────
        const actorId = auditContext?.actorId ?? order.userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId: order.userId,
                currency: order.currency,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                originalChargedAmount: order.chargedAmount,
                originalWalletDeducted: order.walletDeducted,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                currency: order.currency,
            },
        });

        // Notification: fire-and-forget
        notifyOrderFailed(order);

        return order;
    } catch (err) {
        if (session?.inTransaction?.()) {
            await session.abortTransaction();
        }
        throw err;
    } finally {
        try { session?.endSession?.(); } catch (_) { /* already ended */ }
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS ORDER REFUND — CANCELED (full) & PARTIAL (proportional)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a refund for an order that was CANCELED or PARTIAL.
 *
 * FULL REFUND (remains === 0, status CANCELED):
 *   refundAmount = order.chargedAmount
 *
 * PARTIAL REFUND (remains > 0, status PARTIAL):
 *   refundAmount = Math.floor((remains / order.quantity) * order.chargedAmount)
 *
 * Uses the ORIGINAL chargedAmount (what the user paid at order time) —
 * NOT live USD conversion. If they paid 100 EGP, max refund is 100 EGP.
 *
 * Idempotency: if order.refunded === true, throws ALREADY_REFUNDED.
 *
 * @param {string|ObjectId} orderId
 * @param {number}          remains      - undelivered units (0 = full refund)
 * @param {Object|null}     auditContext - { actorId, actorRole, ipAddress?, userAgent? }
 * @returns {Promise<Order>}
 */
const processOrderRefund = async (orderId, remains = 0, auditContext = null) => {
    let session = null;
    try {
        session = await mongoose.startSession();
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });
    } catch (_sessionErr) {
        // Standalone MongoDB — transactions unavailable, proceed without session.
        session = null;
    }

    try {
        const order = session
            ? await Order.findById(orderId).session(session)
            : await Order.findById(orderId);
        if (!order) throw new NotFoundError('Order');

        // ── Idempotency guard ────────────────────────────────────────────────
        if (order.refunded === true) {
            throw new BusinessRuleError(
                'A refund has already been issued for this order.',
                'ALREADY_REFUNDED'
            );
        }

        // ── Calculate refund amount ──────────────────────────────────────────
        const chargedAmount = Number(order.chargedAmount || order.walletDeducted || 0);

        // ── Quantity-Only Billing: quantity refund instead of wallet ──────
        const isQuantityOnlyCandidate = chargedAmount <= 0 && order.quantity > 0;
        const refundUserGroup = isQuantityOnlyCandidate
            ? await Group.findById(
                  (await User.findById(order.userId).select('groupId').session(session || null))?.groupId
              ).select('billingMode').session(session || null)
            : null;
        const isQuantityOnlyRefund = refundUserGroup?.billingMode === 'quantity_only';

        if (chargedAmount <= 0 && !isQuantityOnlyRefund) {
            throw new BusinessRuleError(
                'Order has no charged amount to refund.',
                'NO_REFUNDABLE_AMOUNT'
            );
        }

        const remainsCount = Math.max(0, parseInt(remains, 10) || 0);
        const isPartial = remainsCount > 0 && remainsCount < order.quantity;

        let refundAmount;
        if (isPartial) {
            // Proportional refund based on undelivered quantity
            refundAmount = Math.floor((remainsCount / order.quantity) * chargedAmount);
        } else {
            // Full refund
            refundAmount = chargedAmount;
        }

        if (refundAmount <= 0 && !isQuantityOnlyRefund) {
            throw new BusinessRuleError(
                'Calculated refund amount is zero or negative.',
                'INVALID_REFUND_AMOUNT'
            );
        }

        // ── Update order state (before wallet, for idempotency) ──────────────
        order.refunded = true;
        order.refundedAt = new Date();
        if (isPartial) {
            order.remains = remainsCount;
        }
        await order.save(session ? { session } : {});

        if (isQuantityOnlyRefund) {
            // Quantity refund: decrement quantityUsed by the appropriate amount
            const qtyToReturn = isPartial ? remainsCount : order.quantity;
            const decOp = { $inc: { quantityUsed: -qtyToReturn } };
            if (session) {
                await User.findByIdAndUpdate(order.userId, decOp, { session });
            } else {
                await User.findByIdAndUpdate(order.userId, decOp);
            }
        } else {
            // ── Atomic wallet refund ─────────────────────────────────────────
            const description = isPartial
                ? `Partial refund for Order #${order.orderNumber} (Remains: ${remainsCount}/${order.quantity})`
                : `Full refund for Order #${order.orderNumber}`;

            await refundWalletAtomic({
                userId: order.userId,
                walletDeducted: refundAmount,
                creditUsedAmount: 0,
                reference: order._id,
                description,
                session: session || undefined,
            });
        }

        if (session) {
            await session.commitTransaction();
        }

        // ── Audit — AFTER commit (fire-and-forget) ──────────────────────────
        const actorId = auditContext?.actorId ?? order.userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.SYSTEM;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        const auditAction = isPartial
            ? ORDER_ACTIONS.PARTIAL_REFUNDED
            : ORDER_ACTIONS.REFUNDED;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: auditAction,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId: order.userId,
                orderNumber: order.orderNumber,
                chargedAmount,
                refundAmount,
                remains: remainsCount,
                quantity: order.quantity,
                isPartial,
                currency: order.currency,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                refundAmount,
                currency: order.currency,
                reason: isPartial ? 'PARTIAL_DELIVERY' : 'ORDER_CANCELED',
            },
        });

        return order;

    } catch (err) {
        if (session?.inTransaction?.()) {
            await session.abortTransaction();
        }
        throw err;
    } finally {
        try { session?.endSession?.(); } catch (_) { /* already ended */ }
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// MARK ORDER AS COMPLETED
// ─────────────────────────────────────────────────────────────────────────────

const markOrderAsCompleted = async (orderId, auditContext = null) => {
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    if (order.status !== ORDER_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot complete an order with status '${order.status}'.`,
            'INVALID_STATUS_TRANSITION'
        );
    }

    order.status = ORDER_STATUS.COMPLETED;
    await order.save();

    const actorId = auditContext?.actorId ?? order.userId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: ADMIN_ACTIONS.ORDER_COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            userId: order.userId,
            orderNumber: order.orderNumber,
            previousStatus: ORDER_STATUS.PENDING,
            newStatus: ORDER_STATUS.COMPLETED,
            executionType: order.executionType,
        },
    });

    // Notification: fire-and-forget
    notifyOrderCompleted(order);

    return order;
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

const listOrdersForUser = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice executionType'),
        Order.countDocuments({ userId }),
    ]);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const listAllOrders = async ({ page = 1, limit = 20, status } = {}) => {
    const filter = status ? { status } : {};
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice')
            .populate('userId', 'name email'),
        Order.countDocuments(filter),
    ]);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const getOrderById = async (orderId, userId = null) => {
    const filter = { _id: orderId };
    if (userId) filter.userId = userId;

    const order = await Order.findOne(filter)
        .populate('productId', 'name basePrice minQty maxQty executionType')
        .populate('userId', 'name email');

    if (!order) throw new NotFoundError('Order');
    return order;
};

module.exports = {
    createOrder,
    markOrderAsFailed,
    processOrderRefund,
    markOrderAsCompleted,
    listOrdersForUser,
    listAllOrders,
    getOrderById,
};
