'use strict';

const { getPaymentSettings } = require('../admin/admin.settings.service');

const normalizeToken = (value) => String(value || '').trim().toLowerCase();

const hasVodafoneIdentity = (method = {}) => {
    const token = `${method.id || ''} ${method.name || ''}`.toLowerCase();
    return token.includes('vodafone') || token.includes('فودافون');
};

const hasUsdtIdentity = (method = {}) => {
    const token = `${method.id || ''} ${method.name || ''} ${method.type || ''}`.toLowerCase();
    const type = normalizeToken(method.type);
    return token.includes('usdt')
        || token.includes('tether')
        || token.includes('يو اس دي تي')
        || type === 'usdt'
        || type === 'crypto';
};

/**
 * Mirrors the customer payment form's automation contract.
 *
 * A configured Vodafone method is automated by its Vodafone identity. Its
 * accountNumber is the customer-facing destination wallet/account and does
 * not change the automation classification. USDT remains automated by its
 * existing frontend type/identity rule.
 */
const isAutomatedPaymentMethodDefinition = (method = {}) => {
    return hasUsdtIdentity(method) || hasVodafoneIdentity(method);
};

const findConfiguredPaymentMethod = (settings, paymentMethodId) => {
    const normalizedId = String(paymentMethodId || '').trim();
    if (!normalizedId) return null;

    for (const group of settings?.paymentGroups || []) {
        for (const method of group?.methods || []) {
            if (String(method?.id || '').trim() === normalizedId) return method;
        }
    }

    return null;
};

/**
 * Resolves automation from the active server-side payment settings. Unknown
 * methods fail closed, so callers cannot omit a manual receipt by inventing a
 * Vodafone-looking method ID.
 */
const isAutomatedPaymentMethod = async (paymentMethodId) => {
    const settings = await getPaymentSettings();
    const method = findConfiguredPaymentMethod(settings, paymentMethodId);
    return isAutomatedPaymentMethodDefinition(method || {});
};

module.exports = {
    isAutomatedPaymentMethod,
    isAutomatedPaymentMethodDefinition,
    findConfiguredPaymentMethod,
};
