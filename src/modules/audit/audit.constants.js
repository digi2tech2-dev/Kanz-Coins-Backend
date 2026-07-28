'use strict';

/**
 * audit.constants.js
 *
 * Single source of truth for all auditable business events.
 * Import these constants wherever an audit log is written — never hardcode strings.
 *
 * ─── Naming convention ───────────────────────────────────────────────────────
 *   <ENTITY>_<PAST_TENSE_VERB>
 *
 * Frozen objects prevent accidental mutation at runtime.
 */

/** Actions performed on or by a User account. */
const USER_ACTIONS = Object.freeze({
    REGISTERED: 'USER_REGISTERED',
    APPROVED: 'USER_APPROVED',
    REJECTED: 'USER_REJECTED',
    LOGIN_SUCCESS: 'USER_LOGIN_SUCCESS',
    LOGIN_BLOCKED: 'USER_LOGIN_BLOCKED',
    GROUP_CHANGED: 'USER_GROUP_CHANGED',
    TWO_FACTOR_ENABLED: 'USER_2FA_ENABLED',
    TWO_FACTOR_DISABLED: 'USER_2FA_DISABLED',
});

/** Actions on the Order lifecycle. */
const ORDER_ACTIONS = Object.freeze({
    CREATED: 'ORDER_CREATED',
    COMPLETED: 'ORDER_COMPLETED',
    FAILED: 'ORDER_FAILED',
    CANCELED: 'ORDER_CANCELED',             // ← NEW: provider canceled
    PARTIAL_REFUNDED: 'ORDER_PARTIAL_REFUNDED', // ← NEW: partial delivery refund
    REFUNDED: 'ORDER_REFUNDED',
    PROCESSING: 'ORDER_PROCESSING',
});

/** Actions on the Wallet / financial layer. */
const WALLET_ACTIONS = Object.freeze({
    DEBIT: 'WALLET_DEBIT',
    CREDIT: 'WALLET_CREDIT',
});

/** Actions on Pricing Groups. */
const GROUP_ACTIONS = Object.freeze({
    CREATED: 'GROUP_CREATED',
    UPDATED: 'GROUP_UPDATED',
    PERCENTAGE_CHANGED: 'GROUP_PERCENTAGE_CHANGED',
    DEACTIVATED: 'GROUP_DEACTIVATED',
});

/** Actions on Deposit Requests. */
const DEPOSIT_ACTIONS = Object.freeze({
    REQUESTED: 'DEPOSIT_REQUESTED',
    APPROVED: 'DEPOSIT_APPROVED',
    REJECTED: 'DEPOSIT_REJECTED',
    UPDATED: 'DEPOSIT_UPDATED',
});

/**
 * Actions on the Provider Fulfillment layer.
 * These are emitted by the fulfillment service and the cron polling job.
 */
const PROVIDER_ACTIONS = Object.freeze({
    ORDER_PLACED: 'PROVIDER_ORDER_PLACED',        // provider accepted the order
    ORDER_PLACE_FAILED: 'PROVIDER_ORDER_PLACE_FAILED',  // provider rejected at placement
    STATUS_UPDATED: 'PROVIDER_STATUS_UPDATED',      // cron updated order status
    ORDER_COMPLETED: 'PROVIDER_ORDER_COMPLETED',     // provider reports Completed
    ORDER_CANCELLED: 'PROVIDER_ORDER_CANCELLED',     // provider reports Cancelled → triggers refund
    RETRY_LIMIT_EXCEEDED: 'PROVIDER_RETRY_LIMIT_EXCEEDED',// order exceeded max retries
});

/** Internal system events (bootstrapping, migrations, background jobs). */
const SYSTEM_ACTIONS = Object.freeze({
    ERROR: 'SYSTEM_ERROR',
    INFO: 'SYSTEM_INFO',
});

/** Admin dashboard actions (manual adjustments, overrides). */
const ADMIN_ACTIONS = Object.freeze({
    WALLET_ADJUSTED: 'ADMIN_WALLET_ADJUSTED',
    DEBT_ADJUSTED: 'ADMIN_DEBT_ADJUSTED',
    ORDER_REFUNDED: 'ADMIN_ORDER_REFUNDED',
    ORDER_RETRIED: 'ADMIN_ORDER_RETRIED',
    USER_UPDATED: 'ADMIN_USER_UPDATED',
    USER_DELETED: 'ADMIN_USER_DELETED',
    USER_ROLE_CHANGED: 'ADMIN_USER_ROLE_CHANGED',
    USER_PASSWORD_RESET: 'ADMIN_USER_PASSWORD_RESET',
    USER_AVATAR_UPDATED: 'ADMIN_USER_AVATAR_UPDATED',
    USER_PERMISSIONS_UPDATED: 'ADMIN_USER_PERMISSIONS_UPDATED',
    ORDER_COMPLETED: 'ADMIN_ORDER_COMPLETED',
    SETTING_UPDATED: 'ADMIN_SETTING_UPDATED',
    PROVIDER_CREATED: 'ADMIN_PROVIDER_CREATED',
    PROVIDER_UPDATED: 'ADMIN_PROVIDER_UPDATED',
    PROVIDER_DELETED: 'ADMIN_PROVIDER_DELETED',
    PROVIDER_TOGGLED: 'ADMIN_PROVIDER_TOGGLED',
});

/** Product lifecycle actions. */
const PRODUCT_ACTIONS = Object.freeze({
    CREATED: 'PRODUCT_CREATED',
    UPDATED: 'PRODUCT_UPDATED',
    DELETED: 'PRODUCT_DELETED',
    TOGGLED: 'PRODUCT_TOGGLED',
    PROVIDER_CHANGED: 'PRODUCT_PROVIDER_CHANGED',
});

/** Category lifecycle actions. */
const CATEGORY_ACTIONS = Object.freeze({
    CREATED: 'CATEGORY_CREATED',
    UPDATED: 'CATEGORY_UPDATED',
    DELETED: 'CATEGORY_DELETED',
});

/** Target Order lifecycle actions (Vodafone Cash coin purchases). */
const TARGET_ORDER_ACTIONS = Object.freeze({
    REQUESTED: 'TARGET_ORDER_REQUESTED',
    APPROVED: 'TARGET_ORDER_APPROVED',
    REJECTED: 'TARGET_ORDER_REJECTED',
});

/** Sub-agent / reseller approval workflow actions. */
const SUB_AGENT_REQUEST_ACTIONS = Object.freeze({
    CREATED: 'SUB_AGENT_REQUEST_CREATED',
    APPROVED: 'SUB_AGENT_REQUEST_APPROVED',
    REJECTED: 'SUB_AGENT_REQUEST_REJECTED',
});

/** Referral payout workflow actions. */
const REFERRAL_PAYOUT_ACTIONS = Object.freeze({
    CREATED: 'REFERRAL_PAYOUT_CREATED',
    REJECTED: 'REFERRAL_PAYOUT_REJECTED',
    WALLET_PAID: 'REFERRAL_PAYOUT_WALLET_PAID',
    MANUAL_PAID: 'REFERRAL_PAYOUT_MANUAL_PAID',
});

/**
 * Flat set of ALL valid action strings — used by the model enum validator
 * and the service-layer guard.
 */
const ALL_ACTIONS = Object.freeze([
    ...Object.values(USER_ACTIONS),
    ...Object.values(ORDER_ACTIONS),
    ...Object.values(WALLET_ACTIONS),
    ...Object.values(GROUP_ACTIONS),
    ...Object.values(DEPOSIT_ACTIONS),
    ...Object.values(PROVIDER_ACTIONS),
    ...Object.values(SYSTEM_ACTIONS),
    ...Object.values(ADMIN_ACTIONS),
    ...Object.values(PRODUCT_ACTIONS),
    ...Object.values(CATEGORY_ACTIONS),
    ...Object.values(TARGET_ORDER_ACTIONS),
    ...Object.values(SUB_AGENT_REQUEST_ACTIONS),
    ...Object.values(REFERRAL_PAYOUT_ACTIONS),
]);

/** Entity types that can be the subject of an audit event. */
const ENTITY_TYPES = Object.freeze({
    USER: 'USER',
    ORDER: 'ORDER',
    WALLET: 'WALLET',
    GROUP: 'GROUP',
    DEPOSIT: 'DEPOSIT',
    PROVIDER: 'PROVIDER',
    PRODUCT: 'PRODUCT',
    CATEGORY: 'CATEGORY',
    SETTING: 'SETTING',
    SYSTEM: 'SYSTEM',
    TARGET_ORDER: 'TARGET_ORDER',
    SUB_AGENT_REQUEST: 'SUB_AGENT_REQUEST',
    REFERRAL_PAYOUT: 'REFERRAL_PAYOUT',
});

/** Actor roles recorded in each audit log. */
const ACTOR_ROLES = Object.freeze({
    ADMIN: 'ADMIN',
    SUPERVISOR: 'SUPERVISOR',
    CUSTOMER: 'CUSTOMER',
    RESELLER: 'RESELLER',
    SYSTEM: 'SYSTEM',
});

module.exports = {
    USER_ACTIONS,
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    GROUP_ACTIONS,
    DEPOSIT_ACTIONS,
    PROVIDER_ACTIONS,
    SYSTEM_ACTIONS,
    ADMIN_ACTIONS,
    PRODUCT_ACTIONS,
    CATEGORY_ACTIONS,
    TARGET_ORDER_ACTIONS,
    SUB_AGENT_REQUEST_ACTIONS,
    REFERRAL_PAYOUT_ACTIONS,
    ALL_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
};
