'use strict';

const originalSafeMode = process.env.SAFE_LOCAL_PRODUCTION_MODE;
const originalMongoUri = process.env.MONGO_URI;
const originalJwtSecret = process.env.JWT_SECRET;

const restoreEnvironment = () => {
    if (originalSafeMode === undefined) delete process.env.SAFE_LOCAL_PRODUCTION_MODE;
    else process.env.SAFE_LOCAL_PRODUCTION_MODE = originalSafeMode;

    if (originalMongoUri === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = originalMongoUri;

    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
};

const loadConfig = (safeMode) => {
    jest.resetModules();
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/safe-mode-test';
    process.env.JWT_SECRET = 'safe-mode-test-secret';
    if (safeMode === undefined) delete process.env.SAFE_LOCAL_PRODUCTION_MODE;
    else process.env.SAFE_LOCAL_PRODUCTION_MODE = safeMode;
    return require('../config/config');
};

const startupDependencies = () => ({
    appInstance: {
        listen: jest.fn((_port, callback) => {
            callback();
            return { close: jest.fn() };
        }),
    },
    connectDatabase: jest.fn().mockResolvedValue(),
    fulfillment: { start: jest.fn(), stop: jest.fn() },
    providerSync: { start: jest.fn(), stop: jest.fn() },
    whatsapp: {
        initializeWhatsAppClient: jest.fn().mockResolvedValue(),
        destroyWhatsAppClient: jest.fn().mockResolvedValue(),
    },
    registerProcessHandlers: false,
});

afterEach(() => {
    jest.resetModules();
    jest.dontMock('../app');
    jest.dontMock('nodemailer');
    jest.dontMock('whatsapp-web.js');
    restoreEnvironment();
});

afterAll(() => restoreEnvironment());

describe('SAFE_LOCAL_PRODUCTION_MODE configuration', () => {
    test.each([
        ['true', true],
        ['false', false],
        ['TRUE', false],
        ['1', false],
        [undefined, false],
    ])('only the literal string %p enables safe mode', (value, expected) => {
        const config = loadConfig(value);
        expect(config.safeLocalProductionMode).toBe(expected);
    });
});

describe('safe local startup', () => {
    const loadServer = () => {
        jest.resetModules();
        jest.doMock('../app', () => ({ listen: jest.fn() }));
        return require('../server');
    };

    test('does not start schedulers or WhatsApp when enabled', async () => {
        const { startServer } = loadServer();
        const config = require('../config/config');
        config.safeLocalProductionMode = true;
        const dependencies = startupDependencies();

        await startServer(dependencies);

        expect(dependencies.connectDatabase).toHaveBeenCalledTimes(1);
        expect(dependencies.fulfillment.start).not.toHaveBeenCalled();
        expect(dependencies.providerSync.start).not.toHaveBeenCalled();
        expect(dependencies.whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('keeps normal startup behavior when disabled', async () => {
        const { startServer } = loadServer();
        const config = require('../config/config');
        config.safeLocalProductionMode = false;
        const dependencies = startupDependencies();

        await startServer(dependencies);

        expect(dependencies.fulfillment.start).toHaveBeenCalledTimes(1);
        expect(dependencies.providerSync.start).toHaveBeenCalledTimes(1);
        expect(dependencies.whatsapp.initializeWhatsAppClient).toHaveBeenCalledTimes(1);
    });
});

describe('safe local startup seeding', () => {
    test('does not invoke default setting seeding when enabled', () => {
        const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');
        const seed = jest.fn().mockResolvedValue();

        expect(startDefaultSettingsSeed({ safeLocalProductionMode: true, seed })).toBe(false);
        expect(seed).not.toHaveBeenCalled();
    });

    test('preserves default setting seeding when disabled', async () => {
        const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');
        const seed = jest.fn().mockResolvedValue();

        expect(startDefaultSettingsSeed({ safeLocalProductionMode: false, seed })).toBe(true);
        await Promise.resolve();
        expect(seed).toHaveBeenCalledTimes(1);
    });
});

describe('safe local outbound communications', () => {
    test('does not create an SMTP transport or send email when enabled', async () => {
        jest.resetModules();
        const sendMail = jest.fn().mockResolvedValue();
        const createTransport = jest.fn(() => ({ sendMail }));
        jest.doMock('nodemailer', () => ({ createTransport }));
        const config = require('../config/config');
        config.safeLocalProductionMode = true;
        const { sendEmail } = require('../services/email.service');

        await sendEmail({ to: 'test@example.com', subject: 'Safe mode', html: '<p>safe</p>' });

        expect(createTransport).not.toHaveBeenCalled();
        expect(sendMail).not.toHaveBeenCalled();
    });

    test('keeps SMTP delivery behavior when safe mode is disabled', async () => {
        jest.resetModules();
        const sendMail = jest.fn().mockResolvedValue();
        const createTransport = jest.fn(() => ({ sendMail }));
        jest.doMock('nodemailer', () => ({ createTransport }));
        const config = require('../config/config');
        config.safeLocalProductionMode = false;
        config.env = 'development';
        const { sendEmail } = require('../services/email.service');

        await sendEmail({ to: 'test@example.com', subject: 'Normal mode', html: '<p>normal</p>' });

        expect(createTransport).toHaveBeenCalledTimes(1);
        expect(sendMail).toHaveBeenCalledTimes(1);
    });

    test('does not initialize or send WhatsApp messages when enabled', async () => {
        jest.resetModules();
        const initialize = jest.fn().mockResolvedValue();
        const Client = jest.fn(() => ({ on: jest.fn(), initialize }));
        const LocalAuth = jest.fn();
        jest.doMock('whatsapp-web.js', () => ({ Client, LocalAuth }));
        const config = require('../config/config');
        config.safeLocalProductionMode = true;
        const whatsapp = require('../modules/whatsapp/whatsapp.service');

        const status = await whatsapp.initializeWhatsAppClient();
        const sent = await whatsapp.sendAdminNotification('must not send');

        expect(status.state).toBe('IDLE');
        expect(Client).not.toHaveBeenCalled();
        expect(initialize).not.toHaveBeenCalled();
        expect(sent).toBeNull();
    });
});
