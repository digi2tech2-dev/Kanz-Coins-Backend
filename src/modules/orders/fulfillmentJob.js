'use strict';

/**
 * fulfillmentJob.js
 *
 * Background cron job that polls PROCESSING orders every minute.
 *
 * Lifecycle:
 *   start()   — schedule the job (called once from server.js after DB connects)
 *   stop()    — graceful shutdown (called on SIGTERM/SIGINT)
 *   runOnce() — execute one polling cycle (also useful for admin triggers / tests)
 *
 * Design:
 *   - Uses node-cron (lightweight, no extra services required)
 *   - Jobs are serialised: if a run is still in progress when the next tick
 *     fires, the tick is skipped (_running flag)
 *   - No job is started in test environments (NODE_ENV === 'test')
 *   - pollProcessingOrders() now owns the grouping — it reads order.providerCode
 *     (snapshotted immutably at order creation) and resolves the provider doc
 *     itself.  This means fulfillmentJob no longer needs to iterate providers.
 *   - providerOverride is kept for single-provider test injection
 */

const cron = require('node-cron');
const { pollProcessingOrders } = require('../orders/orderFulfillment.service');

// ── State ─────────────────────────────────────────────────────────────────────

let _task = null;   // node-cron ScheduledTask
let _running = false;  // execution lock — prevents overlapping runs

// ── Job logic ─────────────────────────────────────────────────────────────────

/**
 * Execute one polling cycle.
 * Safe to call manually (e.g. in integration tests or admin triggers).
 *
 * When providerOverride is passed, the poll is run using that single adapter
 * (test mode — all PROCESSING orders go through it regardless of providerCode).
 * In production (providerOverride = null), pollProcessingOrders groups orders
 * by their providerCode snapshot and resolves each adapter independently.
 *
 * @param {Object|null} [providerOverride]  - inject a single mock provider (tests)
 * @returns {Promise<Object|null>}          - stats from pollProcessingOrders
 */
const runOnce = async (providerOverride = null) => {
    if (_running) {
        console.log('[FulfillmentJob] Skipping tick — previous run still in progress.');
        return null;
    }

    _running = true;
    const startedAt = Date.now();

    try {
        // pollProcessingOrders handles everything:
        //   • groups orders by order.providerCode (immutable snapshot)
        //   • resolves provider doc from DB by slug (not by product)
        //   • calls checkOrders() per provider group
        //   • processes each result, refunds on cancellation, retries on transient errors
        const stats = await pollProcessingOrders(providerOverride ?? null);
        const elapsed = Date.now() - startedAt;
        console.log(`[FulfillmentJob] Poll completed in ${elapsed}ms:`, stats);
        return stats;

    } catch (err) {
        console.error('[FulfillmentJob] Unhandled error in polling cycle:', err.message);
        return null;
    } finally {
        _running = false;
    }
};

// ── Schedule ──────────────────────────────────────────────────────────────────

/**
 * Start the cron scheduler.
 * Call once from server.js after the DB connection is established.
 *
 * @param {string} [schedule='* * * * *']  - cron expression (default: every minute)
 * @param {Object} [providerOverride]          - inject single provider (tests only)
 */
const start = (schedule = '* * * * *', providerOverride = null) => {
    if (process.env.NODE_ENV === 'test') {
        console.log('[FulfillmentJob] Skipped in test environment.');
        return;
    }

    if (_task) {
        console.warn('[FulfillmentJob] Already started — ignoring duplicate start().');
        return;
    }

    console.log(`[FulfillmentJob] Scheduling fulfillment poll: '${schedule}'`);

    _task = cron.schedule(schedule, async () => {
        await runOnce(providerOverride);
    });

    console.log('[FulfillmentJob] Fulfillment cron job started.');
};

/**
 * Stop the cron scheduler.
 * Called during graceful shutdown.
 */
const stop = () => {
    if (_task) {
        _task.stop();
        _task = null;
        console.log('[FulfillmentJob] Fulfillment cron job stopped.');
    }
};


module.exports = { start, stop, runOnce };
