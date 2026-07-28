'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const subAgentRequestService = require('./subAgentRequest.service');

const getUploadedProofFile = (req) => {
    if (req.file) return req.file;
    if (!req.files) return null;
    return req.files.proofImage?.[0] || req.files.proof?.[0] || req.files.attachment?.[0] || null;
};

const createMyRequest = catchAsync(async (req, res) => {
    const proofFile = getUploadedProofFile(req);
    try {
        const request = await subAgentRequestService.createSubAgentRequest({
            userId: req.user._id,
            notes: req.body.notes ?? req.body.message,
            proofFile,
        });
        sendCreated(res, { request }, 'Sub-agent request submitted successfully. Pending admin review.');
    } catch (err) {
        await subAgentRequestService.cleanupProofFile(proofFile);
        throw err;
    }
});

const getMyCurrentRequest = catchAsync(async (req, res) => {
    const result = await subAgentRequestService.getCurrentRequestForUser(req.user._id);
    sendSuccess(res, result, 'Current sub-agent request retrieved.');
});

const listMyRequests = catchAsync(async (req, res) => {
    const result = await subAgentRequestService.listRequestsForUser(req.user._id, req.query);
    sendPaginated(res, result.requests, result.pagination, 'Sub-agent requests retrieved.');
});

const listAdminRequests = catchAsync(async (req, res) => {
    const result = await subAgentRequestService.listSubAgentRequestsForAdmin(req.query);
    sendPaginated(res, result.requests, result.pagination, 'Sub-agent requests retrieved.');
});

const approveRequest = catchAsync(async (req, res) => {
    const request = await subAgentRequestService.approveSubAgentRequest({
        requestId: req.params.id,
        groupId: req.body.groupId,
        adminId: req.user._id,
        auditContext: req.auditContext,
    });
    sendSuccess(res, { request }, 'Sub-agent request approved.');
});

const rejectRequest = catchAsync(async (req, res) => {
    const request = await subAgentRequestService.rejectSubAgentRequest({
        requestId: req.params.id,
        reason: req.body.reason ?? req.body.rejectionReason ?? req.body.adminNotes,
        adminId: req.user._id,
        auditContext: req.auditContext,
    });
    sendSuccess(res, { request }, 'Sub-agent request rejected.');
});

module.exports = {
    createMyRequest,
    getMyCurrentRequest,
    listMyRequests,
    listAdminRequests,
    approveRequest,
    rejectRequest,
};
