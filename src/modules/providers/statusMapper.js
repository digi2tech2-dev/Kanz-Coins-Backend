'use strict';

/**
 * statusMapper.js
 *
 * Translates raw provider status strings into internal ORDER_STATUS values.
 *
 * ─── Provider vocabulary → Internal platform status ───────────────────────────
 *
 * Royal Crown / Torosfon Store (canonical)
 *   "Completed"            →  COMPLETED
 *   "Pending"              →  PROCESSING
 *   "Cancelled"            →  FAILED
 *
 * Torosfon-specific raw values (adapter normalises these, listed here as fallback)
 *   "completed", "success", "done"               →  COMPLETED
 *   "processing", "pending", "queued"             →  PROCESSING
 *   "failed", "rejected", "error", "cancelled"   →  FAILED
 *
 * Alkasr VIP-specific raw values (adapter normalises too; listed as fallback)
 *   "accept", "accepted"               →  COMPLETED
 *   "wait", "waiting", "in_process"    →  PROCESSING
 *   "reject", "rejected"               →  FAILED
 *
 * Case-insensitive lookup so minor API inconsistencies don't crash the engine.
 */

const { ORDER_STATUS } = require('../orders/order.model');

/**
 * Raw strings the provider may return for order status.
 * These are the CANONICAL values that all adapters must normalise to.
 */
const PROVIDER_STATUS = Object.freeze({
    COMPLETED: 'Completed',
    PENDING: 'Pending',
    CANCELLED: 'Cancelled',
});

/**
 * Map keyed by lowercase provider status → internal ORDER_STATUS.
 *
 * Includes canonical values (Completed / Pending / Cancelled) plus
 * provider-specific raw strings from Royal Crown, Toros, and Alkasr
 * as defensive aliases.
 *
 * @private
 */
const _MAP = {
    // ── COMPLETED ────────────────────────────────────────────────────────────
    completed:   ORDER_STATUS.COMPLETED,
    complete:    ORDER_STATUS.COMPLETED,
    success:     ORDER_STATUS.COMPLETED,
    done:        ORDER_STATUS.COMPLETED,
    accept:      ORDER_STATUS.COMPLETED,
    accepted:    ORDER_STATUS.COMPLETED,
    ok:          ORDER_STATUS.COMPLETED,
    delivered:   ORDER_STATUS.COMPLETED,
    fulfilled:   ORDER_STATUS.COMPLETED,

    // ── PROCESSING (still in-flight, keep polling) ──────────────────────────
    processing:    ORDER_STATUS.PROCESSING,
    in_progress:   ORDER_STATUS.PROCESSING,
    'in progress': ORDER_STATUS.PROCESSING,
    inprogress:    ORDER_STATUS.PROCESSING,
    in_process:    ORDER_STATUS.PROCESSING,
    running:       ORDER_STATUS.PROCESSING,
    active:        ORDER_STATUS.PROCESSING,

    // ── PENDING (queued, not started yet) ────────────────────────────────────
    pending:   ORDER_STATUS.PROCESSING,   // providers say "Pending" when they mean "working on it"
    queued:    ORDER_STATUS.PROCESSING,
    wait:      ORDER_STATUS.PROCESSING,
    waiting:   ORDER_STATUS.PROCESSING,
    awaiting:  ORDER_STATUS.PROCESSING,
    new:       ORDER_STATUS.PROCESSING,
    created:   ORDER_STATUS.PROCESSING,
    placement_uncertain: ORDER_STATUS.PROCESSING,

    // ── PARTIAL (provider delivered partial quantity → partial refund) ────────
    partial:              ORDER_STATUS.PARTIAL,
    partially_completed:  ORDER_STATUS.PARTIAL,
    partial_complete:     ORDER_STATUS.PARTIAL,

    // ── CANCELED (provider explicitly canceled → full refund) ────────────────
    cancelled:  ORDER_STATUS.CANCELED,
    canceled:   ORDER_STATUS.CANCELED,
    cancel:     ORDER_STATUS.CANCELED,

    // ── FAILED (internal failures, rejected by provider) ────────────────────
    failed:     ORDER_STATUS.FAILED,
    fail:       ORDER_STATUS.FAILED,
    error:      ORDER_STATUS.FAILED,
    rejected:   ORDER_STATUS.FAILED,
    reject:     ORDER_STATUS.FAILED,
    refunded:   ORDER_STATUS.FAILED,
    expired:    ORDER_STATUS.FAILED,
};

/**
 * Convert a provider status string to the internal ORDER_STATUS constant.
 *
 * Defensive: if the status is not recognised, logs a warning and
 * falls back to PROCESSING (so the order keeps getting polled rather
 * than crashing the pipeline).
 *
 * @param {string} providerStatus   - raw string from the provider API
 * @returns {string}                - one of ORDER_STATUS values
 */
const toInternalStatus = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    const internal = _MAP[key];
    if (!internal) {
        console.warn(`[statusMapper] Unknown provider status: '${providerStatus}' — defaulting to PROCESSING`);
        return ORDER_STATUS.PROCESSING;
    }
    return internal;
};

/**
 * Returns true when the provider status means the order is definitively finished
 * (either successfully or cancelled) and no more polling is needed.
 *
 * @param {string} providerStatus
 * @returns {boolean}
 */
const isTerminal = (providerStatus) => {
    const mapped = toInternalStatus(providerStatus);
    return mapped === ORDER_STATUS.COMPLETED
        || mapped === ORDER_STATUS.FAILED
        || mapped === ORDER_STATUS.CANCELED
        || mapped === ORDER_STATUS.PARTIAL;
};

/**
 * Returns true when the provider status requires issuing a wallet refund.
 * Includes both full refunds (cancelled) and partial refunds (partial delivery).
 *
 * @param {string} providerStatus
 * @returns {boolean}
 */
const requiresRefund = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    // Full refund triggers
    if (key === 'cancelled' || key === 'canceled' || key === 'cancel'
        || key === 'failed'    || key === 'fail'     || key === 'error'
        || key === 'reject'    || key === 'rejected'  || key === 'refunded'
        || key === 'expired') {
        return true;
    }
    // Partial refund triggers
    if (key === 'partial' || key === 'partially_completed' || key === 'partial_complete') {
        return true;
    }
    return false;
};

module.exports = { PROVIDER_STATUS, toInternalStatus, isTerminal, requiresRefund };
