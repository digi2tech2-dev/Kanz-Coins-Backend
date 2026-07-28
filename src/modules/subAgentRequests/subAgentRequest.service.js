'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { SubAgentRequest, SUB_AGENT_REQUEST_STATUS } = require('./subAgentRequest.model');
const { User, USER_STATUS, RESELLER_STATUS } = require('../users/user.model');
const Group = require('../groups/group.model');
const { ReferralCommission } = require('../referrals/referralCommission.model');
const { createAuditLog } = require('../audit/audit.service');
const {
    SUB_AGENT_REQUEST_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { BusinessRuleError, NotFoundError, AuthorizationError } = require('../../shared/errors/AppError');

const PROOF_FIELD = 'proofImage';
const PROOF_UPLOAD_CATEGORY = 'sub-agent-proofs';
const MAX_PROOF_SIZE_BYTES = 5 * 1024 * 1024;

const ALLOWED_PROOF_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
]);

const ALLOWED_PROOF_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const TEST_HOOK_ERROR = 'Sub-agent request test hooks are only available in NODE_ENV=test.';

const runTestHook = async (hook, payload) => {
    if (!hook) return;
    if (process.env.NODE_ENV !== 'test') {
        throw new Error(TEST_HOOK_ERROR);
    }
    await hook(payload);
};

const isDuplicateKeyError = (err) => err?.code === 11000;

const normalizeStatus = (status) => {
    if (!status) return null;
    const normalized = String(status).trim().toUpperCase();
    if (!Object.values(SUB_AGENT_REQUEST_STATUS).includes(normalized)) {
        throw new BusinessRuleError('Invalid sub-agent request status filter.', 'SUB_AGENT_REQUEST_STATUS_INVALID');
    }
    return normalized;
};

const normalizeNotes = (input) => {
    if (input === null || input === undefined || Array.isArray(input) || typeof input === 'object') {
        throw new BusinessRuleError('Sub-agent request message is required.', 'SUB_AGENT_NOTES_REQUIRED');
    }
    const notes = String(input).trim();
    if (!notes) {
        throw new BusinessRuleError('Sub-agent request message is required.', 'SUB_AGENT_NOTES_REQUIRED');
    }
    if (notes.length > 1000) {
        throw new BusinessRuleError('Sub-agent request message cannot exceed 1000 characters.', 'SUB_AGENT_NOTES_TOO_LONG');
    }
    return notes;
};

const normalizeRejectionReason = (input) => {
    if (input === null || input === undefined || Array.isArray(input) || typeof input === 'object') {
        throw new BusinessRuleError('Rejection reason is required.', 'SUB_AGENT_REJECTION_REASON_REQUIRED');
    }
    const reason = String(input).trim();
    if (!reason) {
        throw new BusinessRuleError('Rejection reason is required.', 'SUB_AGENT_REJECTION_REASON_REQUIRED');
    }
    if (reason.length > 500) {
        throw new BusinessRuleError('Rejection reason cannot exceed 500 characters.', 'SUB_AGENT_REJECTION_REASON_TOO_LONG');
    }
    return reason;
};

const resolveProofUrl = (proofPath) => {
    if (!proofPath) return null;
    const safe = String(proofPath).replace(/^\/+/, '');
    return `/${safe}`;
};

const safeGroup = (group) => {
    if (!group) return null;
    return {
        id: group._id?.toString?.() || group.id || null,
        name: group.name || null,
        percentage: group.percentage ?? null,
        billingMode: group.billingMode || 'standard',
        isActive: group.isActive !== false,
    };
};

const safeUser = (user) => {
    if (!user) return null;
    return {
        id: user._id?.toString?.() || user.id || null,
        name: user.name || null,
        email: user.email || null,
        avatar: user.avatar || null,
        group: safeGroup(user.groupId),
        groupId: user.groupId?._id?.toString?.() || user.groupId?.toString?.() || null,
        resellerStatus: user.resellerStatus || RESELLER_STATUS.NONE,
        resellerApprovedAt: user.resellerApprovedAt || null,
    };
};

const serializeRequest = (request, { admin = false } = {}) => {
    if (!request) return null;
    const obj = typeof request.toObject === 'function' ? request.toObject() : request;
    const status = String(obj.status || SUB_AGENT_REQUEST_STATUS.PENDING);
    const serialized = {
        id: obj._id?.toString?.() || obj.id,
        userId: obj.userId?._id?.toString?.() || obj.userId?.toString?.() || null,
        status: status.toLowerCase(),
        statusCode: status,
        notes: obj.notes || '',
        message: obj.notes || '',
        proofUrl: resolveProofUrl(obj.proofPath),
        proofImage: resolveProofUrl(obj.proofPath),
        proofFileName: obj.proofFileName || null,
        proofMimeType: obj.proofMimeType || null,
        proofSize: obj.proofSize || 0,
        approvedGroup: safeGroup(obj.approvedGroupId),
        approvedGroupId: obj.approvedGroupId?._id?.toString?.() || obj.approvedGroupId?.toString?.() || null,
        rejectionReason: obj.rejectionReason || null,
        createdAt: obj.createdAt || null,
        updatedAt: obj.updatedAt || null,
        reviewedAt: obj.reviewedAt || null,
    };

    if (admin) {
        serialized.user = safeUser(obj.userId);
        serialized.name = obj.userId?.name || null;
        serialized.email = obj.userId?.email || null;
        serialized.currentGroup = safeGroup(obj.userId?.groupId);
        serialized.reviewedBy = obj.reviewedBy
            ? {
                id: obj.reviewedBy._id?.toString?.() || obj.reviewedBy.toString?.(),
                name: obj.reviewedBy.name || null,
                email: obj.reviewedBy.email || null,
            }
            : null;
    }

    return serialized;
};

const readProofBytes = async (proofFile) => {
    if (Buffer.isBuffer(proofFile?.buffer)) return proofFile.buffer;
    if (proofFile?.path) return fs.promises.readFile(proofFile.path);
    return null;
};

const assertImageSignature = (buffer, mimeType) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        throw new BusinessRuleError('Sub-agent proof file is invalid.', 'SUB_AGENT_PROOF_INVALID');
    }
    if (mimeType === 'image/jpeg') {
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return;
    }
    if (mimeType === 'image/png') {
        if (buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return;
    }
    if (mimeType === 'image/webp') {
        if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return;
    }
    throw new BusinessRuleError('Sub-agent proof file is invalid.', 'SUB_AGENT_PROOF_INVALID');
};

const validateProofFile = async (proofFile) => {
    if (!proofFile) {
        throw new BusinessRuleError('Sub-agent proof image is required.', 'SUB_AGENT_PROOF_REQUIRED');
    }

    const mimeType = String(proofFile.mimetype || '').toLowerCase();
    const originalName = String(proofFile.originalname || proofFile.filename || '').trim();
    const extension = path.extname(originalName).toLowerCase();
    const size = Number(proofFile.size || 0);

    if (!ALLOWED_PROOF_MIME_TYPES.has(mimeType) || !ALLOWED_PROOF_EXTENSIONS.has(extension)) {
        throw new BusinessRuleError('Sub-agent proof must be a JPEG, PNG, or WebP image.', 'SUB_AGENT_PROOF_INVALID');
    }

    if (!Number.isFinite(size) || size <= 0 || size > MAX_PROOF_SIZE_BYTES) {
        throw new BusinessRuleError('Sub-agent proof file is too large or empty.', 'SUB_AGENT_PROOF_INVALID');
    }

    const bytes = await readProofBytes(proofFile);
    assertImageSignature(bytes, mimeType);
};

const buildProofMetadata = (proofFile) => ({
    proofPath: `uploads/${PROOF_UPLOAD_CATEGORY}/${proofFile.filename}`,
    proofFileName: proofFile.filename,
    proofMimeType: String(proofFile.mimetype || '').toLowerCase(),
    proofSize: Number(proofFile.size || 0),
});

const cleanupProofFile = async (proofFile) => {
    if (!proofFile?.path) return;
    try {
        await fs.promises.unlink(proofFile.path);
    } catch (_) {
        // The primary request error should remain primary.
    }
};

const assertCustomerCanRequest = async (userId, session = null) => {
    const user = await User.findById(userId)
        .select('+subAgentRequestPending status deletedAt resellerStatus resellerApprovedAt groupId referralCommissionStoppedAt')
        .session(session);
    if (!user || user.deletedAt) throw new NotFoundError('User');
    if (user.status !== USER_STATUS.ACTIVE) {
        throw new AuthorizationError('Only active users can submit sub-agent requests.');
    }
    if (user.resellerStatus === RESELLER_STATUS.APPROVED) {
        throw new BusinessRuleError('User is already an approved reseller.', 'USER_ALREADY_RESELLER');
    }
    return user;
};

const throwCreateEligibilityError = async (userId, session = null) => {
    const user = await User.findById(userId)
        .select('+subAgentRequestPending status deletedAt resellerStatus')
        .session(session)
        .lean();
    if (!user || user.deletedAt) throw new NotFoundError('User');
    if (user.status !== USER_STATUS.ACTIVE) {
        throw new AuthorizationError('Only active users can submit sub-agent requests.');
    }
    if (user.resellerStatus === RESELLER_STATUS.APPROVED) {
        throw new BusinessRuleError('User is already an approved reseller.', 'USER_ALREADY_RESELLER');
    }
    const existingPending = await SubAgentRequest.exists({
        userId,
        status: SUB_AGENT_REQUEST_STATUS.PENDING,
    }).session(session);
    if (existingPending || user.subAgentRequestPending) {
        throw new BusinessRuleError('A pending sub-agent request already exists.', 'SUB_AGENT_REQUEST_ALREADY_PENDING');
    }
    throw new BusinessRuleError('Unable to submit sub-agent request.', 'SUB_AGENT_REQUEST_UNAVAILABLE');
};

const claimPendingRequestSlot = async (userId, session = null) => {
    const result = await User.updateOne(
        {
            _id: userId,
            deletedAt: null,
            status: USER_STATUS.ACTIVE,
            resellerStatus: { $ne: RESELLER_STATUS.APPROVED },
            subAgentRequestPending: { $ne: true },
        },
        { $set: { subAgentRequestPending: true } },
        { session }
    );

    if (result.matchedCount !== 1) {
        await throwCreateEligibilityError(userId, session);
    }
};

const createSubAgentRequest = async ({ userId, notes, proofFile, testHooks = {} }) => {
    const session = await mongoose.startSession();
    let requestId = null;
    let committed = false;
    try {
        await validateProofFile(proofFile);
        const normalizedNotes = normalizeNotes(notes);

        await session.withTransaction(async () => {
            await assertCustomerCanRequest(userId, session);

            const existingPending = await SubAgentRequest.findOne({
                userId,
                status: SUB_AGENT_REQUEST_STATUS.PENDING,
            }).session(session).lean();
            if (existingPending) {
                throw new BusinessRuleError('A pending sub-agent request already exists.', 'SUB_AGENT_REQUEST_ALREADY_PENDING');
            }

            await claimPendingRequestSlot(userId, session);
            await runTestHook(testHooks.beforeCreate, { userId });

            const [request] = await SubAgentRequest.create([{
                userId,
                status: SUB_AGENT_REQUEST_STATUS.PENDING,
                notes: normalizedNotes,
                ...buildProofMetadata(proofFile),
            }], { session });
            requestId = request._id;
        });
        committed = true;

        createAuditLog({
            actorId: userId,
            actorRole: ACTOR_ROLES.CUSTOMER,
            action: SUB_AGENT_REQUEST_ACTIONS.CREATED,
            entityType: ENTITY_TYPES.SUB_AGENT_REQUEST,
            entityId: requestId,
            metadata: {
                userId: userId.toString(),
                proofMimeType: String(proofFile.mimetype || '').toLowerCase(),
                proofSize: Number(proofFile.size || 0),
            },
        });

        return serializeRequest(await findRequestForUser(requestId, userId));
    } catch (err) {
        if (!committed) {
            await cleanupProofFile(proofFile);
        }
        if (isDuplicateKeyError(err)) {
            throw new BusinessRuleError('A pending sub-agent request already exists.', 'SUB_AGENT_REQUEST_ALREADY_PENDING');
        }
        throw err;
    } finally {
        await session.endSession();
    }
};

const findRequestForUser = async (requestId, userId) => {
    const request = await SubAgentRequest.findOne({ _id: requestId, userId })
        .populate('approvedGroupId', 'name percentage billingMode isActive')
        .lean();
    if (!request) throw new NotFoundError('SubAgentRequest');
    return request;
};

const getCurrentRequestForUser = async (userId) => {
    const [request, user] = await Promise.all([
        SubAgentRequest.findOne({ userId })
            .sort({ createdAt: -1, _id: -1 })
            .populate('approvedGroupId', 'name percentage billingMode isActive')
            .lean(),
        User.findById(userId).select('resellerStatus resellerApprovedAt referralCommissionStoppedAt groupId').populate('groupId', 'name percentage billingMode isActive').lean(),
    ]);

    return {
        request: serializeRequest(request),
        resellerStatus: user?.resellerStatus || RESELLER_STATUS.NONE,
        resellerApprovedAt: user?.resellerApprovedAt || null,
        referralCommissionStoppedAt: user?.referralCommissionStoppedAt || null,
        currentGroup: safeGroup(user?.groupId),
    };
};

const listRequestsForUser = async (userId, { page = 1, limit = 20 } = {}) => {
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = { userId };

    const [requests, total] = await Promise.all([
        SubAgentRequest.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .populate('approvedGroupId', 'name percentage billingMode isActive')
            .lean(),
        SubAgentRequest.countDocuments(filter),
    ]);

    return {
        requests: requests.map((request) => serializeRequest(request)),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listSubAgentRequestsForAdmin = async ({
    status,
    search = '',
    page = 1,
    limit = 20,
    from,
    to,
} = {}) => {
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const filter = {};
    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus) filter.status = normalizedStatus;
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    const term = String(search || '').trim();
    if (term) {
        const users = await User.find({
            $or: [
                { name: { $regex: escapeRegex(term), $options: 'i' } },
                { email: { $regex: escapeRegex(term), $options: 'i' } },
            ],
        }).select('_id').limit(100).lean();
        filter.userId = { $in: users.map((user) => user._id) };
    }

    const skip = (normalizedPage - 1) * normalizedLimit;
    const [requests, total] = await Promise.all([
        SubAgentRequest.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .populate({
                path: 'userId',
                select: 'name email avatar groupId resellerStatus resellerApprovedAt',
                populate: { path: 'groupId', select: 'name percentage billingMode isActive' },
            })
            .populate('approvedGroupId', 'name percentage billingMode isActive')
            .populate('reviewedBy', 'name email')
            .lean(),
        SubAgentRequest.countDocuments(filter),
    ]);

    return {
        requests: requests.map((request) => serializeRequest(request, { admin: true })),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

const throwReviewedConflict = async (requestId, session = null) => {
    const existing = await SubAgentRequest.findById(requestId).session(session);
    if (!existing) throw new BusinessRuleError('Sub-agent request not found.', 'SUB_AGENT_REQUEST_NOT_FOUND');
    throw new BusinessRuleError('Sub-agent request has already been reviewed.', 'SUB_AGENT_REQUEST_ALREADY_REVIEWED');
};

const approveSubAgentRequest = async ({
    requestId,
    groupId,
    adminId,
    auditContext = {},
    testHooks = {},
}) => {
    const session = await mongoose.startSession();
    let approvedRequest;
    let previousGroupId = null;
    let previousResellerStatus = RESELLER_STATUS.NONE;
    const reviewedAt = new Date();

    try {
        await session.withTransaction(async () => {
            const request = await SubAgentRequest.findById(requestId).session(session);
            if (!request) throw new BusinessRuleError('Sub-agent request not found.', 'SUB_AGENT_REQUEST_NOT_FOUND');
            if (request.status !== SUB_AGENT_REQUEST_STATUS.PENDING) {
                throw new BusinessRuleError('Sub-agent request has already been reviewed.', 'SUB_AGENT_REQUEST_ALREADY_REVIEWED');
            }

            const [group, user] = await Promise.all([
                Group.findById(groupId).session(session),
                User.findById(request.userId).session(session),
            ]);

            if (!group || group.deletedAt) {
                throw new BusinessRuleError('Selected pricing group was not found.', 'SUB_AGENT_GROUP_NOT_FOUND');
            }
            if (group.isActive === false) {
                throw new BusinessRuleError('Selected pricing group is inactive.', 'SUB_AGENT_GROUP_INACTIVE');
            }
            if (!user || user.deletedAt) throw new NotFoundError('User');
            if (user.status !== USER_STATUS.ACTIVE) {
                throw new BusinessRuleError('Target user is not active.', 'SUB_AGENT_USER_INACTIVE');
            }
            if (user.resellerStatus === RESELLER_STATUS.APPROVED) {
                throw new BusinessRuleError('User is already an approved reseller.', 'USER_ALREADY_RESELLER');
            }

            previousGroupId = user.groupId?.toString?.() || null;
            previousResellerStatus = user.resellerStatus || RESELLER_STATUS.NONE;

            approvedRequest = await SubAgentRequest.findOneAndUpdate(
                { _id: requestId, status: SUB_AGENT_REQUEST_STATUS.PENDING },
                {
                    $set: {
                        status: SUB_AGENT_REQUEST_STATUS.APPROVED,
                        approvedGroupId: group._id,
                        reviewedBy: adminId,
                        reviewedAt,
                        rejectionReason: null,
                    },
                },
                { new: true, session }
            );

            if (!approvedRequest) {
                await throwReviewedConflict(requestId, session);
            }

            await runTestHook(testHooks.afterRequestClaim, { request: approvedRequest });

            const userUpdate = await User.updateOne(
                { _id: approvedRequest.userId, deletedAt: null, resellerStatus: { $ne: RESELLER_STATUS.APPROVED } },
                {
                    $set: {
                        groupId: group._id,
                        resellerStatus: RESELLER_STATUS.APPROVED,
                        resellerApprovedAt: reviewedAt,
                        referralCommissionStoppedAt: reviewedAt,
                        subAgentRequestPending: false,
                    },
                },
                { session }
            );

            if (userUpdate.matchedCount !== 1) {
                throw new BusinessRuleError('User is already an approved reseller.', 'USER_ALREADY_RESELLER');
            }

            await runTestHook(testHooks.afterUserUpdateBeforeCommit, { request: approvedRequest, group, reviewedAt });
        });
    } finally {
        await session.endSession();
    }

    createAuditLog({
        actorId: auditContext.actorId || adminId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        action: SUB_AGENT_REQUEST_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.SUB_AGENT_REQUEST,
        entityId: approvedRequest._id,
        metadata: {
            requestId: approvedRequest._id.toString(),
            targetUserId: approvedRequest.userId.toString(),
            previousGroupId,
            newGroupId: groupId.toString(),
            previousResellerStatus,
            newResellerStatus: RESELLER_STATUS.APPROVED,
            approvalTimestamp: reviewedAt.toISOString(),
            commissionStopTimestamp: reviewedAt.toISOString(),
        },
    });

    await runPostCommitHook(testHooks.afterCommit, { request: approvedRequest });
    return getAdminRequestById(approvedRequest._id);
};

const rejectSubAgentRequest = async ({
    requestId,
    reason,
    adminId,
    auditContext = {},
    testHooks = {},
}) => {
    const rejectionReason = normalizeRejectionReason(reason);
    const reviewedAt = new Date();
    const session = await mongoose.startSession();
    let request;

    try {
        await session.withTransaction(async () => {
            request = await SubAgentRequest.findOneAndUpdate(
                { _id: requestId, status: SUB_AGENT_REQUEST_STATUS.PENDING },
                {
                    $set: {
                        status: SUB_AGENT_REQUEST_STATUS.REJECTED,
                        reviewedBy: adminId,
                        reviewedAt,
                        rejectionReason,
                    },
                },
                { new: true, session }
            );

            if (!request) {
                await throwReviewedConflict(requestId, session);
            }

            await User.updateOne(
                { _id: request.userId },
                { $set: { subAgentRequestPending: false } },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    createAuditLog({
        actorId: auditContext.actorId || adminId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        action: SUB_AGENT_REQUEST_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.SUB_AGENT_REQUEST,
        entityId: request._id,
        metadata: {
            requestId: request._id.toString(),
            targetUserId: request.userId.toString(),
            rejectionReason: rejectionReason.slice(0, 500),
            reviewTimestamp: reviewedAt.toISOString(),
        },
    });

    await runPostCommitHook(testHooks.afterCommit, { request });
    return getAdminRequestById(request._id);
};

const runPostCommitHook = async (hook, payload) => {
    if (!hook) return;
    try {
        await runTestHook(hook, payload);
    } catch (err) {
        if (err.message === TEST_HOOK_ERROR) throw err;
        console.error('Sub-agent request post-commit side effect failed:', err.message);
    }
};

const getAdminRequestById = async (requestId) => {
    const request = await SubAgentRequest.findById(requestId)
        .populate({
            path: 'userId',
            select: 'name email avatar groupId resellerStatus resellerApprovedAt',
            populate: { path: 'groupId', select: 'name percentage billingMode isActive' },
        })
        .populate('approvedGroupId', 'name percentage billingMode isActive')
        .populate('reviewedBy', 'name email')
        .lean();
    if (!request) throw new BusinessRuleError('Sub-agent request not found.', 'SUB_AGENT_REQUEST_NOT_FOUND');
    return serializeRequest(request, { admin: true });
};

const auditSubAgentRequestIndexes = async ({ model = SubAgentRequest } = {}) => {
    const duplicatePending = await model.aggregate([
        { $match: { status: SUB_AGENT_REQUEST_STATUS.PENDING } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: 'groups' },
    ]);

    return {
        duplicatePendingUserGroups: duplicatePending[0]?.groups || 0,
    };
};

module.exports = {
    PROOF_FIELD,
    PROOF_UPLOAD_CATEGORY,
    MAX_PROOF_SIZE_BYTES,
    ALLOWED_PROOF_MIME_TYPES,
    ALLOWED_PROOF_EXTENSIONS,
    SUB_AGENT_REQUEST_STATUS,
    createSubAgentRequest,
    getCurrentRequestForUser,
    listRequestsForUser,
    listSubAgentRequestsForAdmin,
    approveSubAgentRequest,
    rejectSubAgentRequest,
    getAdminRequestById,
    validateProofFile,
    cleanupProofFile,
    serializeRequest,
    auditSubAgentRequestIndexes,
    runTestHook,
};
