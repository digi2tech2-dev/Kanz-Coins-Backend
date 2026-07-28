'use strict';

/**
 * upload.js — Centralized Multer middleware factory for file uploads.
 *
 * Creates category-specific upload instances that store files to:
 *   /uploads/<category>/<timestamp>-<random>.<ext>
 *
 * Supported categories: avatars, products, categories, payments, deposits, targets, target-apps
 *
 * Usage:
 *   const { createUpload } = require('../../shared/middlewares/upload');
 *   const avatarUpload = createUpload('avatars');
 *   router.patch('/me/avatar', avatarUpload.single('avatar'), handler);
 *
 * Legacy default export (backward-compatible for deposits):
 *   const upload = require('../../shared/middlewares/upload');
 *   router.post('/deposits', upload.single('screenshotProof'), handler);
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { BusinessRuleError } = require('../errors/AppError');

// ── Constants ─────────────────────────────────────────────────────────────────

const UPLOADS_ROOT = path.join(__dirname, '..', '..', '..', 'uploads');

/** Max file size: 20 MB */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Allowed MIME types for image uploads.
 * Deposits additionally allow PDFs (receipts).
 */
const IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Deposits also accept PDFs */
const DEPOSIT_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, 'application/pdf']);
const DEPOSIT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf']);

const readUploadedBytes = async (file) => {
    if (Buffer.isBuffer(file?.buffer)) return file.buffer;
    if (file?.path) return fsp.readFile(file.path);
    return null;
};

const hasValidSignature = (buffer, mimeType) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
    if (mimeType === 'image/jpeg') {
        return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimeType === 'image/png') {
        return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mimeType === 'image/webp') {
        return buffer.length >= 12
            && buffer.slice(0, 4).toString('ascii') === 'RIFF'
            && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    }
    if (mimeType === 'application/pdf') {
        return buffer.slice(0, 5).toString('ascii') === '%PDF-';
    }
    return false;
};

const validateUploadedFileSignature = async (file, {
    allowPdf = false,
    code = 'INVALID_FILE_TYPE',
    message = 'Uploaded file content does not match its declared type.',
} = {}) => {
    const mimeType = String(file?.mimetype || '').toLowerCase();
    const allowedMimes = allowPdf ? DEPOSIT_MIME_TYPES : IMAGE_MIME_TYPES;
    if (!allowedMimes.has(mimeType)) {
        throw new BusinessRuleError(message, code);
    }
    if (!hasValidSignature(await readUploadedBytes(file), mimeType)) {
        throw new BusinessRuleError(message, code);
    }
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a configured multer instance for a specific upload category.
 *
 * @param {'avatars'|'products'|'categories'|'payments'|'deposits'|'targets'|'target-apps'} category
 * @returns {multer.Multer} A multer instance ready to use as middleware
 */
const createUpload = (category) => {
    const uploadDir = path.join(UPLOADS_ROOT, category);

    // Ensure directory exists
    fs.mkdirSync(uploadDir, { recursive: true });

    // Storage: disk with collision-proof filenames
    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => {
            const timestamp = Date.now();
            const random = crypto.randomBytes(8).toString('hex');
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${timestamp}-${random}${ext}`);
        },
    });

    // File filter: deposits allow PDFs, everything else is images-only
    const isDeposit = category === 'deposits';
    const allowedMimes = isDeposit ? DEPOSIT_MIME_TYPES : IMAGE_MIME_TYPES;
    const allowedExts = isDeposit ? DEPOSIT_EXTENSIONS : IMAGE_EXTENSIONS;

    const fileFilter = (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const mimeOk = allowedMimes.has(file.mimetype);
        const extOk = allowedExts.has(ext);

        if (!mimeOk || !extOk) {
            const accepted = isDeposit
                ? 'JPG, JPEG, PNG, WebP, and PDF'
                : 'JPG, JPEG, PNG, and WebP';
            return cb(
                new BusinessRuleError(
                    `Only ${accepted} files are accepted.`,
                    'INVALID_FILE_TYPE'
                )
            );
        }
        cb(null, true);
    };

    return multer({
        storage,
        fileFilter,
        limits: {
            fileSize: MAX_FILE_SIZE,
            files: 1,
        },
    });
};

// ── Exports ───────────────────────────────────────────────────────────────────

// Factory for creating category-specific uploaders
module.exports = createUpload('deposits');   // backward-compatible default
module.exports.createUpload = createUpload;
module.exports.validateUploadedFileSignature = validateUploadedFileSignature;
module.exports._test = {
    hasValidSignature,
};
