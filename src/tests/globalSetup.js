'use strict';

/**
 * globalSetup.js — runs ONCE before all test suites in a separate process.
 *
 * Spins up an in-memory MongoDB replica set (required for multi-document
 * transactions). The URI is written to an env var so individual test files
 * can connect with mongoose.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const fs = require('fs');
const path = require('path');

module.exports = async () => {
    const dbPath = path.resolve(
        __dirname,
        '../../.tmp',
        `mongo-memory-${process.pid}-${Date.now()}`
    );
    await fs.promises.mkdir(dbPath, { recursive: true });

    // one-node replica set is enough for transactions
    const replSet = await MongoMemoryReplSet.create({
        instanceOpts: [{ launchTimeout: 30000, dbPath }],
        replSet: { count: 1, storageEngine: 'wiredTiger' },
    });

    await replSet.waitUntilRunning();

    const uri = replSet.getUri();

    // Store on process.env so Jest workers inherit it
    process.env.MONGO_TEST_URI = uri;
    process.env.JWT_SECRET = 'test-jwt-secret-for-tests-only';
    process.env.JWT_EXPIRES_IN = '1h';
    process.env.BCRYPT_ROUNDS = '1'; // fast hashing in tests
    process.env.MONGO_URI = uri;     // config.js reads this

    // Attach to global so globalTeardown can stop it
    global.__MONGOD__ = replSet;
    global.__MONGOD_DBPATHS__ = [dbPath];
};
