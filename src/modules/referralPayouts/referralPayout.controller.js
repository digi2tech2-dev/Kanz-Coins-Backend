'use strict';

const referralPayoutService = require('./referralPayout.service');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');

const pickReceiptFile = (req) => {
    if (req.file) return req.file;
    const files = req.files || {};
    return files.receiptImage?.[0] || files.receipt?.[0] || files.paymentProof?.[0] || null;
};

const createMyPayout = async (req, res) => {
    const payout = await referralPayoutService.createReferralPayout({
        userId: req.user._id,
        body: req.body,
    });
    return sendCreated(res, { payout }, 'Referral payout request created.');
};

const listMyPayouts = async (req, res) => {
    const result = await referralPayoutService.listPayoutsForUser(req.user._id, req.query);
    return res.status(200).json({
        success: true,
        message: 'Referral payouts retrieved.',
        data: result.payouts,
        pagination: result.pagination,
    });
};

const getMyPayout = async (req, res) => {
    const payout = await referralPayoutService.findPayoutForUser(req.params.id, req.user._id, { fullDetails: true });
    return sendSuccess(res, { payout }, 'Referral payout retrieved.');
};

const listAdminPayouts = async (req, res) => {
    const result = await referralPayoutService.listPayoutsForAdmin(req.query);
    return res.status(200).json({
        success: true,
        message: 'Referral payouts retrieved.',
        data: result.payouts,
        pagination: result.pagination,
    });
};

const getAdminPayout = async (req, res) => {
    const payout = await referralPayoutService.getAdminPayoutById(req.params.id);
    return sendSuccess(res, { payout }, 'Referral payout retrieved.');
};

const rejectPayout = async (req, res) => {
    const payout = await referralPayoutService.rejectReferralPayout({
        payoutId: req.params.id,
        reason: req.body.reason || req.body.rejectionReason || req.body.adminNotes,
        adminId: req.user._id,
        auditContext: {
            actorId: req.user._id,
            actorRole: req.user.role,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
        },
    });
    return sendSuccess(res, { payout }, 'Referral payout rejected.');
};

const payWalletPayout = async (req, res) => {
    const payout = await referralPayoutService.payWalletReferralPayout({
        payoutId: req.params.id,
        adminId: req.user._id,
        auditContext: {
            actorId: req.user._id,
            actorRole: req.user.role,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
        },
    });
    return sendSuccess(res, { payout }, 'Referral wallet payout paid.');
};

const markManualPayoutPaid = async (req, res, next) => {
    const receiptFile = pickReceiptFile(req);
    try {
        const payout = await referralPayoutService.markManualReferralPayoutPaid({
            payoutId: req.params.id,
            externalTransactionReference: req.body.externalTransactionReference
                || req.body.reference
                || req.body.transactionReference
                || req.body.transactionId,
            receiptFile,
            adminId: req.user._id,
            auditContext: {
                actorId: req.user._id,
                actorRole: req.user.role,
                ipAddress: req.ip,
                userAgent: req.get('User-Agent'),
            },
        });
        return sendSuccess(res, { payout }, 'Referral manual payout marked paid.');
    } catch (err) {
        await referralPayoutService.cleanupReceiptFile(receiptFile);
        return next(err);
    }
};

module.exports = {
    createMyPayout,
    listMyPayouts,
    getMyPayout,
    listAdminPayouts,
    getAdminPayout,
    rejectPayout,
    payWalletPayout,
    markManualPayoutPaid,
};
