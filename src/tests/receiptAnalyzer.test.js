'use strict';

const DEFAULT_ANALYZER_CONFIG = {
    enableOcr: false,
    minEntropy: 1.0,
    blackMeanMax: 8,
    whiteMeanMin: 247,
    solidStdDevMax: 2.5,
    lowEntropyStdDevMax: 3.2,
    maxInputPixels: 40_000_000,
    ocrTimeoutMs: 3500,
    ocrResizeWidth: 1200,
    ocrMinKeywordMatches: 1,
    ocrKeywords: ['تم', 'نجاح', 'فودافون', 'vodafone', 'cash', 'كاش', 'تحويل'],
};

const createSharpMock = ({ metadata, stats, throwOnCreate = false, throwOnStats = false }) => {
    return jest.fn(() => {
        if (throwOnCreate) {
            throw new Error('INVALID_IMAGE');
        }

        return {
            metadata: jest.fn(async () => metadata),
            stats: jest.fn(async () => {
                if (throwOnStats) {
                    throw new Error('BROKEN_IMAGE');
                }
                return stats;
            }),
            resize: jest.fn().mockReturnThis(),
            grayscale: jest.fn().mockReturnThis(),
            normalize: jest.fn().mockReturnThis(),
            png: jest.fn().mockReturnThis(),
            toBuffer: jest.fn(async () => Buffer.from('prepared')),
        };
    });
};

const loadAnalyzerService = ({ config = {}, sharpMock, sharpThrows = false } = {}) => {
    jest.resetModules();

    jest.doMock('../config/config', () => ({
        receiptAnalyzer: { ...DEFAULT_ANALYZER_CONFIG, ...config },
    }));

    if (sharpThrows) {
        jest.doMock(
            'sharp',
            () => {
                throw new Error('MODULE_NOT_FOUND');
            }
        );
    } else if (sharpMock) {
        jest.doMock('sharp', () => sharpMock);
    }

    return require('../shared/services/receiptAnalyzer.service');
};

describe('receiptAnalyzer.service', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('rejects empty buffers', async () => {
        const service = loadAnalyzerService({
            sharpMock: createSharpMock({
                metadata: { format: 'png', width: 100, height: 100 },
                stats: { entropy: 5, channels: [{ mean: 120, stdev: 10 }, { mean: 125, stdev: 10 }, { mean: 130, stdev: 10 }] },
            }),
        });

        const result = await service.analyzeReceiptBuffer(Buffer.alloc(0));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('EMPTY_OR_INVALID_BUFFER');
    });

    it('rejects solid black images', async () => {
        const service = loadAnalyzerService({
            sharpMock: createSharpMock({
                metadata: { format: 'jpeg', width: 800, height: 600 },
                stats: { entropy: 0.1, channels: [{ mean: 0, stdev: 0 }, { mean: 0, stdev: 0 }, { mean: 0, stdev: 0 }] },
            }),
        });

        const result = await service.analyzeReceiptBuffer(Buffer.from('image-bytes'));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('SOLID_BLACK_IMAGE');
    });

    it('rejects solid white images', async () => {
        const service = loadAnalyzerService({
            sharpMock: createSharpMock({
                metadata: { format: 'jpeg', width: 800, height: 600 },
                stats: { entropy: 0.2, channels: [{ mean: 255, stdev: 0 }, { mean: 255, stdev: 0 }, { mean: 255, stdev: 0 }] },
            }),
        });

        const result = await service.analyzeReceiptBuffer(Buffer.from('image-bytes'));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('SOLID_WHITE_IMAGE');
    });

    it('rejects low-entropy blank-like images', async () => {
        const service = loadAnalyzerService({
            sharpMock: createSharpMock({
                metadata: { format: 'png', width: 1000, height: 700 },
                stats: { entropy: 0.5, channels: [{ mean: 120, stdev: 1 }, { mean: 122, stdev: 1 }, { mean: 121, stdev: 1 }] },
            }),
        });

        const result = await service.analyzeReceiptBuffer(Buffer.from('image-bytes'));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('LOW_ENTROPY_IMAGE');
    });

    it('accepts non-blank valid images', async () => {
        const service = loadAnalyzerService({
            sharpMock: createSharpMock({
                metadata: { format: 'webp', width: 1200, height: 900 },
                stats: { entropy: 3.5, channels: [{ mean: 90, stdev: 25 }, { mean: 128, stdev: 30 }, { mean: 170, stdev: 28 }] },
            }),
        });

        const result = await service.analyzeReceiptBuffer(Buffer.from('image-bytes'));
        expect(result.isValid).toBe(true);
        expect(result.metadata).toEqual({ format: 'webp', width: 1200, height: 900 });
    });

    it('marks image invalid when sharp is unavailable', async () => {
        const service = loadAnalyzerService({ sharpThrows: true });

        const result = await service.analyzeReceiptBuffer(Buffer.from('image-bytes'));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('SHARP_NOT_AVAILABLE');
    });
});
