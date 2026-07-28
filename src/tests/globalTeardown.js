'use strict';

const fs = require('fs');

module.exports = async () => {
    const dbPaths = global.__MONGOD_DBPATHS__ || [];
    if (global.__MONGOD__) {
        await global.__MONGOD__.stop({ doCleanup: false, force: false });
    }
    await Promise.all(
        dbPaths.map((dbPath) =>
            fs.promises.rm(dbPath, { recursive: true, force: true }).catch(() => {})
        )
    );
};
