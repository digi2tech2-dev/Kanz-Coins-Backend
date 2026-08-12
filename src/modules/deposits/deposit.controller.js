'use strict';

const fs = require('fs');
const { Currency } = require('../currency/currency.model');
const depositService = require('./deposit.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { AppError, BusinessRuleError } = require('../../shared/errors/AppError');
const { analyzeReceiptBuffer } = require('../../shared/services/receiptAnalyzer.service');

const INVALID_RECEIPT_MESSAGE = 'صورة إيصال غير صالحة أو غير واضحة. يرجى رفع إيصال حقيقي.';
const IMAGE_MIME_TYPE_PREFIX = 'image/';

const cleanupUploadedFile = async (filePath) => {
    if (!filePath) return;
    try {
        await fs.promises.unlink(filePath);
    } catch (_) {
        // Ignore cleanup failures so validation errors remain primary.
    }
};

const validateReceiptUpload = async (file) => {
    if (!file) return;

    const mimeType = String(file.mimetype || '').toLowerCase();
    const shouldAnalyzeImage = mimeType.startsWith(IMAGE_MIME_TYPE_PREFIX);

    // Keep existing PDF receipt support untouched; anti-fraud checks currently apply to images only.
    if (!shouldAnalyzeImage) {
        return;
    }

    let imageBuffer;
    const memoryBuffer = Buffer.isBuffer(file.buffer) ? file.buffer : null;
    const filePath = String(file.path || '').trim();

    if (memoryBuffer) {
        imageBuffer = memoryBuffer;
    } else {
        if (!filePath) {
            throw new AppError(INVALID_RECEIPT_MESSAGE, 400, 'INVALID_RECEIPT_IMAGE');
        }

        try {
            imageBuffer = await fs.promises.readFile(filePath);
        } catch (_) {
            await cleanupUploadedFile(filePath);
            throw new AppError(INVALID_RECEIPT_MESSAGE, 400, 'INVALID_RECEIPT_IMAGE');
        }
    }

    let analysisResult;
    try {
        analysisResult = await analyzeReceiptBuffer(imageBuffer, {
            mimeType: file.mimetype,
            originalName: file.originalname,
        });
    } catch (_) {
        await cleanupUploadedFile(filePath);
        throw new AppError(INVALID_RECEIPT_MESSAGE, 400, 'INVALID_RECEIPT_IMAGE');
    }

    if (!analysisResult.isValid) {
        await cleanupUploadedFile(filePath);
        throw new AppError(INVALID_RECEIPT_MESSAGE, 400, 'INVALID_RECEIPT_IMAGE');
    }
};

const analyzeReceiptUpload = catchAsync(async (req, _res, next) => {
    if (!req.file) return next();
    await validateReceiptUpload(req.file);
    req.receiptAnalysisValidated = true;
    next();
});

/**
 * POST /api/deposits
 * Customer creates a deposit request with receipt upload.
 *
 * Multer middleware (createUpload('deposits').single('receipt')) runs
 * BEFORE this handler — req.file is populated on success.
 */
const createDeposit = catchAsync(async (req, res) => {
    // ── Validate file upload ─────────────────────────────────────────────
    if (!req.file) {
        throw new BusinessRuleError(
            'Receipt image is required. Please upload a file.',
            'RECEIPT_REQUIRED'
        );
    }

    if (!req.receiptAnalysisValidated) {
        await validateReceiptUpload(req.file);
    }

    const { requestedAmount, currency, paymentMethodId, notes } = req.body;
    const senderDetails = depositService.normalizeSenderDetails(req.body);
    const paymentTransactionId = req.body.transactionId
        || req.body.transactionNumber
        || req.body.paymentReference
        || senderDetails?.transactionNumber
        || null;

    // ── Fetch current exchange rate ──────────────────────────────────────
    const currencyDoc = await Currency.findOne({
        code: currency.toUpperCase(),
        isActive: true,
    });

    if (!currencyDoc) {
        throw new BusinessRuleError(
            `Currency '${currency}' is not supported or is inactive.`,
            'INVALID_CURRENCY'
        );
    }

    const exchangeRate = currencyDoc.platformRate;

    // ── Calculate USD equivalent ─────────────────────────────────────────
    const parsedAmount = parseFloat(requestedAmount);
    const amountUsd = Number((parsedAmount / exchangeRate).toFixed(2));

    // ── Build relative receipt path ──────────────────────────────────────
    // req.file.path is absolute; we store only the relative part.
    const receiptImage = `uploads/deposits/${req.file.filename}`;

    // ── Persist ──────────────────────────────────────────────────────────
    const deposit = await depositService.createDepositRequest({
        userId: req.user._id,
        paymentMethodId,
        requestedAmount: parsedAmount,
        currency: currency.toUpperCase(),
        exchangeRate,
        amountUsd,
        receiptImage,
        notes: notes || null,
        senderDetails,
        paymentTransactionId,
        auditContext: req.auditContext,
    });

    sendCreated(res, deposit, 'Deposit request submitted successfully. Pending admin review.');
});

/**
 * GET /api/deposits
 * Admin: list all deposit requests (optional ?status= filter + pagination).
 * Customer: list only their own deposit requests.
 */
const listDeposits = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { status } = req.query;

    let result;
    if (req.user.role === 'ADMIN') {
        result = await depositService.listDeposits({ page, limit, status });
    } else {
        result = await depositService.listMyDeposits(req.user._id, { page, limit, status });
    }

    sendPaginated(res, result.deposits, result.pagination, 'Deposit requests retrieved.');
});

/**
 * PATCH /api/deposits/:id/approve
 * Admin: approve a deposit and credit the customer's wallet.
 */
const approveDeposit = catchAsync(async (req, res) => {
    const { id } = req.params;

    const deposit = await depositService.approveDeposit(
        id,
        req.user._id,
        {},
        req.auditContext
    );

    sendSuccess(res, deposit, 'Deposit approved and wallet credited successfully.');
});

/**
 * PATCH /api/deposits/:id/reject
 * Admin: reject a deposit request.
 */
const rejectDeposit = catchAsync(async (req, res) => {
    const { adminNotes } = req.body;

    const deposit = await depositService.rejectDeposit(
        req.params.id,
        req.user._id,
        adminNotes || null,
        req.auditContext
    );

    sendSuccess(res, deposit, 'Deposit request rejected.');
});

/**
 * PATCH /api/admin/deposits/:id/review
 * Admin: unified review endpoint — approve or reject a deposit.
 * Body: { status: 'APPROVED' | 'REJECTED', adminNotes?: string }
 */
const reviewDeposit = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    let deposit;

    if (status === 'APPROVED') {
        deposit = await depositService.approveDeposit(
            id,
            req.user._id,
            {},
            req.auditContext
        );
        sendSuccess(res, deposit, 'Deposit approved and wallet credited successfully.');
    } else if (status === 'REJECTED') {
        deposit = await depositService.rejectDeposit(
            id,
            req.user._id,
            adminNotes || null,
            req.auditContext
        );
        sendSuccess(res, deposit, 'Deposit request rejected.');
    } else {
        throw new BusinessRuleError(
            'status must be APPROVED or REJECTED.',
            'INVALID_REVIEW_STATUS'
        );
    }
});

module.exports = { analyzeReceiptUpload, createDeposit, listDeposits, approveDeposit, rejectDeposit, reviewDeposit };
