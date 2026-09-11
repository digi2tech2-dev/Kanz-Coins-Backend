'use strict';

require('dotenv').config();

const app = require('./app');
const config = require('./config/config');
const connectDB = require('./config/database');
const fulfillmentJob = require('./modules/orders/fulfillmentJob');
const syncProvidersJob = require('./modules/providers/syncProvidersJob');
const whatsappService = require('./modules/whatsapp/whatsapp.service');


const startServer = async ({
    appInstance = app,
    connectDatabase = connectDB,
    fulfillment = fulfillmentJob,
    providerSync = syncProvidersJob,
    whatsapp = whatsappService,
    registerProcessHandlers = true,
} = {}) => {
    try {
        // 1. Connect to MongoDB first
        await connectDatabase();

        // 2. Then start listening
        const server = appInstance.listen(config.port, () => {
            console.log('');
            console.log('═══════════════════════════════════════════════════════');
            console.log(`  🚀  Coins Store`);
            console.log(`  🌍  Environment : ${config.env}`);
            console.log(`  📡  Port        : ${config.port}`);
            console.log(`  🔗  Base URL    : http://localhost:${config.port}/api`);
            console.log('═══════════════════════════════════════════════════════');
            console.log('');
        });

        // 3. Start background integrations unless this is controlled local
        // inspection against a remote/production-like database.
        if (config.safeLocalProductionMode) {
            console.warn('');
            console.warn('====================================================');
            console.warn('SAFE LOCAL PRODUCTION MODE ENABLED');
            console.warn('Background jobs, startup seeding, WhatsApp initialization,');
            console.warn('and outbound notifications are disabled.');
            console.warn('====================================================');
            console.warn('');
        } else {
            fulfillment.start();
            providerSync.start();
            whatsapp.initializeWhatsAppClient().catch((err) => {
                console.error('[WhatsApp] startup initialization failed:', err.message);
            });
        }

        // ── Graceful Shutdown ─────────────────────────────────────────────────────
        const gracefulShutdown = (signal) => {
            console.log(`\n⚠️  Received ${signal}. Shutting down gracefully...`);

            // Stop both cron jobs before closing HTTP
            fulfillment.stop();
            providerSync.stop();
            whatsapp.destroyWhatsAppClient().catch((err) => {
                console.warn('[WhatsApp] shutdown cleanup failed:', err.message);
            });

            server.close(async () => {
                console.log('✅ HTTP server closed.');
                const mongoose = require('mongoose');
                await mongoose.connection.close();
                console.log('✅ MongoDB connection closed.');
                process.exit(0);
            });

            // Force exit after 10s if graceful shutdown stalls
            setTimeout(() => {
                console.error('❌ Graceful shutdown timed out. Forcing exit.');
                process.exit(1);
            }, 10_000);
        };

        if (registerProcessHandlers) {
            process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
            process.on('SIGINT', () => gracefulShutdown('SIGINT'));

            // ── Unhandled Rejections / Exceptions ─────────────────────────────────
            process.on('unhandledRejection', (reason) => {
                console.error('💥 Unhandled Promise Rejection:', reason);
                gracefulShutdown('unhandledRejection');
            });

            process.on('uncaughtException', (error) => {
                console.error('💥 Uncaught Exception:', error);
                process.exit(1);
            });
        }

        return server;
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        process.exit(1);
    }
};

if (require.main === module) {
    startServer();
}

module.exports = { startServer };
