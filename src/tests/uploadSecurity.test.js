'use strict';

const {
    validateUploadedFileSignature,
} = require('../shared/middlewares/upload');

describe('upload signature validation', () => {
    it('accepts valid public image signatures', async () => {
        await expect(validateUploadedFileSignature({
            mimetype: 'image/png',
            buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        })).resolves.toBeUndefined();

        await expect(validateUploadedFileSignature({
            mimetype: 'image/jpeg',
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        })).resolves.toBeUndefined();

        await expect(validateUploadedFileSignature({
            mimetype: 'image/webp',
            buffer: Buffer.from('RIFFxxxxWEBPVP8 ', 'ascii'),
        })).resolves.toBeUndefined();
    });

    it('rejects renamed non-image bytes even when MIME claims image', async () => {
        await expect(validateUploadedFileSignature({
            mimetype: 'image/png',
            buffer: Buffer.from('MZ executable bytes'),
        })).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    });

    it('allows PDF signatures only when explicitly enabled', async () => {
        const pdfFile = {
            mimetype: 'application/pdf',
            buffer: Buffer.from('%PDF-1.7\n'),
        };

        await expect(validateUploadedFileSignature(pdfFile)).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
        await expect(validateUploadedFileSignature(pdfFile, { allowPdf: true })).resolves.toBeUndefined();
    });
});
