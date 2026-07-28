'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { SubAgentRequest, SUB_AGENT_REQUEST_STATUS } = require('../modules/subAgentRequests/subAgentRequest.model');
const subAgentService = require('../modules/subAgentRequests/subAgentRequest.service');
const { User, RESELLER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const { ReferralCommission, REFERRAL_COMMISSION_STATUS } = require('../modules/referrals/referralCommission.model');
const referralCommissionService = require('../modules/referrals/referralCommission.service');
const { calculateReferralEligibleUntil } = require('../modules/referrals/referral.service');
const { Currency } = require('../modules/currency/currency.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
    createGroup,
    USER_STATUS,
} = require('./testHelpers');

const uploadsDir = path.resolve(__dirname, '../../uploads/sub-agent-proofs');
let proofPaths = [];

const pngBuffer = () => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24),
]);

const jpegBuffer = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const webpBuffer = () => Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(12),
]);

const createProofFile = async ({
    mimeType = 'image/png',
    ext = '.png',
    buffer = pngBuffer(),
    track = true,
} = {}) => {
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    const filename = `test-proof-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, buffer);
    if (track) proofPaths.push(filePath);
    return {
        path: filePath,
        filename,
        originalname: `proof${ext}`,
        mimetype: mimeType,
        size: buffer.length,
    };
};

const exists = async (filePath) => {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch (_) {
        return false;
    }
};

const createCurrency = (code, platformRate = 1) => Currency.create({
    code,
    name: `Currency ${code}`,
    symbol: code,
    platformRate,
    marketRate: platformRate,
    isActive: true,
});

const createPendingDeposit = (userId, overrides = {}) => DepositRequest.create({
    userId,
    paymentMethodId: new mongoose.Types.ObjectId().toString(),
    requestedAmount: 1000,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 1000,
    receiptImage: 'uploads/deposits/sub-agent-regression.jpg',
    ...overrides,
});

const createReferralPair = async (overrides = {}) => {
    const referredAt = overrides.referredAt || new Date();
    const { customer: referrer } = await createCustomerWithGroup({
        walletBalance: 0,
        currency: 'USD',
        ...overrides.referrerOverrides,
    });
    const { customer: referred, group } = await createCustomerWithGroup({
        walletBalance: 0,
        currency: 'USD',
        referredBy: referrer._id,
        referredAt,
        referralEligibleUntil: calculateReferralEligibleUntil(referredAt),
        ...overrides.referredOverrides,
    });
    return { referrer, referred, group };
};

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    proofPaths = [];
    await clearCollections();
});

afterEach(async () => {
    await Promise.all(proofPaths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
});

describe('Sub-agent request system', () => {
    it('creates a valid pending request with proof and leaves user group/referral stop unchanged', async () => {
        const { customer, group } = await createCustomerWithGroup({ referralCommissionStoppedAt: null });
        const proof = await createProofFile();

        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'I have recurring customers.',
            proofFile: proof,
            status: 'APPROVED',
            approvedGroupId: new mongoose.Types.ObjectId(),
        });

        expect(request.status).toBe('pending');
        expect(request.message).toBe('I have recurring customers.');
        expect(request.proofImage).toMatch(/^\/uploads\/sub-agent-proofs\/test-proof-/);
        expect(request.proofImage).not.toContain(path.resolve(__dirname, '../..'));

        const fresh = await User.findById(customer._id).select('+subAgentRequestPending');
        expect(String(fresh.groupId)).toBe(String(group._id));
        expect(fresh.referralCommissionStoppedAt).toBeNull();
        expect(fresh.resellerStatus).toBe(RESELLER_STATUS.NONE);
        expect(fresh.subAgentRequestPending).toBe(true);
    });

    it('validates proof and notes, including invalid MIME and oversized files', async () => {
        const { customer } = await createCustomerWithGroup();
        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'ok',
            proofFile: null,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_PROOF_REQUIRED' });

        const badProof = await createProofFile({ mimeType: 'image/gif', ext: '.gif', buffer: Buffer.from('GIF89a') });
        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'ok',
            proofFile: badProof,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_PROOF_INVALID' });
        expect(await exists(badProof.path)).toBe(false);

        const largeProof = await createProofFile({ buffer: Buffer.alloc(subAgentService.MAX_PROOF_SIZE_BYTES + 1), ext: '.png' });
        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'ok',
            proofFile: largeProof,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_PROOF_INVALID' });
        expect(await exists(largeProof.path)).toBe(false);

        const validProof = await createProofFile({ buffer: jpegBuffer(), mimeType: 'image/jpeg', ext: '.jpg' });
        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'x'.repeat(1001),
            proofFile: validProof,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_NOTES_TOO_LONG' });
        expect(await exists(validProof.path)).toBe(false);
    });

    it('blocks duplicate pending requests, cleans duplicate proof, and allows reapply after rejection', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();
        const firstProof = await createProofFile({ buffer: webpBuffer(), mimeType: 'image/webp', ext: '.webp' });
        const first = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'first',
            proofFile: firstProof,
        });

        const duplicateProof = await createProofFile();
        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'duplicate',
            proofFile: duplicateProof,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_REQUEST_ALREADY_PENDING' });
        expect(await exists(duplicateProof.path)).toBe(false);

        await subAgentService.rejectSubAgentRequest({
            requestId: first.id,
            reason: 'Need more evidence',
            adminId: admin._id,
        });

        const reapplyProof = await createProofFile();
        const second = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'second',
            proofFile: reapplyProof,
        });
        expect(second.status).toBe('pending');
        expect(await SubAgentRequest.countDocuments({ userId: customer._id })).toBe(2);
    });

    it('allows only one pending request under concurrent creation and cleans the losing proof', async () => {
        const { customer } = await createCustomerWithGroup();
        const proofA = await createProofFile();
        const proofB = await createProofFile();

        const results = await Promise.allSettled([
            subAgentService.createSubAgentRequest({ userId: customer._id, notes: 'A', proofFile: proofA }),
            subAgentService.createSubAgentRequest({ userId: customer._id, notes: 'B', proofFile: proofB }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(await SubAgentRequest.countDocuments({ userId: customer._id, status: SUB_AGENT_REQUEST_STATUS.PENDING })).toBe(1);
        const existingFiles = await Promise.all([exists(proofA.path), exists(proofB.path)]);
        expect(existingFiles.filter(Boolean)).toHaveLength(1);
    });

    it('cleans uploaded proof when database creation fails', async () => {
        const { customer } = await createCustomerWithGroup();
        const proof = await createProofFile();

        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'will fail',
            proofFile: proof,
            testHooks: { beforeCreate: async () => { throw new Error('injected failure'); } },
        })).rejects.toThrow('injected failure');

        expect(await exists(proof.path)).toBe(false);
        expect(await SubAgentRequest.countDocuments()).toBe(0);
    });

    it('customer reads only own current request and history without reviewer private data', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();
        const { customer: other } = await createCustomerWithGroup();
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'mine',
            proofFile: await createProofFile(),
        });

        await subAgentService.rejectSubAgentRequest({
            requestId: request.id,
            reason: 'Not enough proof',
            adminId: admin._id,
        });

        const current = await subAgentService.getCurrentRequestForUser(customer._id);
        expect(current.request.status).toBe('rejected');
        expect(current.request.rejectionReason).toBe('Not enough proof');
        expect(current.request.reviewedBy).toBeUndefined();

        const otherHistory = await subAgentService.listRequestsForUser(other._id);
        expect(otherHistory.requests).toHaveLength(0);
    });

    it('admin list filters status, search, and serializes safe user/group summaries', async () => {
        const { customer } = await createCustomerWithGroup({ name: 'Applicant One', email: 'applicant@example.com' });
        await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'admin list',
            proofFile: await createProofFile(),
        });

        const result = await subAgentService.listSubAgentRequestsForAdmin({
            status: 'pending',
            search: 'applicant@example.com',
            page: 1,
            limit: 500,
        });

        expect(result.pagination.limit).toBe(100);
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0].user.email).toBe('applicant@example.com');
        expect(result.requests[0].currentGroup.name).toBeTruthy();
        await expect(subAgentService.listSubAgentRequestsForAdmin({ status: 'bogus' }))
            .rejects.toMatchObject({ code: 'SUB_AGENT_REQUEST_STATUS_INVALID' });
    });

    it('approves a pending request transactionally and uses one timestamp for review, reseller, and commission stop', async () => {
        const admin = await createAdmin();
        const original = await createGroup({ percentage: 5 });
        const target = await createGroup({ percentage: 25 });
        const { customer } = await createCustomerWithGroup({ groupId: original._id, walletBalance: 123 });
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'approve me',
            proofFile: await createProofFile(),
        });

        const approved = await subAgentService.approveSubAgentRequest({
            requestId: request.id,
            groupId: target._id,
            adminId: admin._id,
        });

        expect(approved.status).toBe('approved');
        expect(approved.approvedGroup.id).toBe(String(target._id));

        const user = await User.findById(customer._id).select('+subAgentRequestPending');
        const storedRequest = await SubAgentRequest.findById(request.id);
        expect(String(user.groupId)).toBe(String(target._id));
        expect(user.resellerStatus).toBe(RESELLER_STATUS.APPROVED);
        expect(user.role).toBe('CUSTOMER');
        expect(user.walletBalance).toBe(123);
        expect(user.subAgentRequestPending).toBe(false);
        expect(user.resellerApprovedAt.getTime()).toBe(storedRequest.reviewedAt.getTime());
        expect(user.referralCommissionStoppedAt.getTime()).toBe(storedRequest.reviewedAt.getTime());
    });

    it('rejects unknown or inactive approval groups and leaves the request pending', async () => {
        const admin = await createAdmin();
        const inactive = await createGroup({ isActive: false });
        const { customer, group } = await createCustomerWithGroup();
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'approve me',
            proofFile: await createProofFile(),
        });

        await expect(subAgentService.approveSubAgentRequest({
            requestId: request.id,
            groupId: new mongoose.Types.ObjectId(),
            adminId: admin._id,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_GROUP_NOT_FOUND' });

        await expect(subAgentService.approveSubAgentRequest({
            requestId: request.id,
            groupId: inactive._id,
            adminId: admin._id,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_GROUP_INACTIVE' });

        const storedRequest = await SubAgentRequest.findById(request.id);
        const user = await User.findById(customer._id);
        expect(storedRequest.status).toBe(SUB_AGENT_REQUEST_STATUS.PENDING);
        expect(String(user.groupId)).toBe(String(group._id));
        expect(user.resellerApprovedAt).toBeNull();
    });

    it('rolls back approval request and user changes when transactional stages fail', async () => {
        const admin = await createAdmin();
        const target = await createGroup({ percentage: 30 });
        const { customer, group } = await createCustomerWithGroup();
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'rollback',
            proofFile: await createProofFile(),
        });

        await expect(subAgentService.approveSubAgentRequest({
            requestId: request.id,
            groupId: target._id,
            adminId: admin._id,
            testHooks: { afterUserUpdateBeforeCommit: async () => { throw new Error('rollback approval'); } },
        })).rejects.toThrow('rollback approval');

        const storedRequest = await SubAgentRequest.findById(request.id);
        const user = await User.findById(customer._id);
        expect(storedRequest.status).toBe(SUB_AGENT_REQUEST_STATUS.PENDING);
        expect(storedRequest.reviewedAt).toBeNull();
        expect(String(user.groupId)).toBe(String(group._id));
        expect(user.resellerStatus).toBe(RESELLER_STATUS.NONE);
        expect(user.referralCommissionStoppedAt).toBeNull();
    });

    it('concurrent approvals and approve/reject races produce one terminal result', async () => {
        const admin = await createAdmin();
        const target = await createGroup({ percentage: 30 });
        const { customer } = await createCustomerWithGroup();
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'race',
            proofFile: await createProofFile(),
        });

        const approvalResults = await Promise.allSettled([
            subAgentService.approveSubAgentRequest({ requestId: request.id, groupId: target._id, adminId: admin._id }),
            subAgentService.approveSubAgentRequest({ requestId: request.id, groupId: target._id, adminId: admin._id }),
        ]);
        expect(approvalResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(approvalResults.filter((result) => result.status === 'rejected')).toHaveLength(1);

        const { customer: secondCustomer } = await createCustomerWithGroup();
        const second = await subAgentService.createSubAgentRequest({
            userId: secondCustomer._id,
            notes: 'race two',
            proofFile: await createProofFile(),
        });
        const mixed = await Promise.allSettled([
            subAgentService.approveSubAgentRequest({ requestId: second.id, groupId: target._id, adminId: admin._id }),
            subAgentService.rejectSubAgentRequest({ requestId: second.id, reason: 'No', adminId: admin._id }),
        ]);
        expect(mixed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(mixed.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const storedSecond = await SubAgentRequest.findById(second.id);
        expect(['APPROVED', 'REJECTED']).toContain(storedSecond.status);
    });

    it('rejection leaves user group and referral commission stop untouched and requires bounded reason', async () => {
        const admin = await createAdmin();
        const { customer, group } = await createCustomerWithGroup();
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'reject me',
            proofFile: await createProofFile(),
        });

        await expect(subAgentService.rejectSubAgentRequest({ requestId: request.id, reason: '', adminId: admin._id }))
            .rejects.toMatchObject({ code: 'SUB_AGENT_REJECTION_REASON_REQUIRED' });

        const rejected = await subAgentService.rejectSubAgentRequest({
            requestId: request.id,
            reason: 'Not enough proof',
            adminId: admin._id,
        });
        expect(rejected.status).toBe('rejected');

        const user = await User.findById(customer._id).select('+subAgentRequestPending');
        expect(String(user.groupId)).toBe(String(group._id));
        expect(user.resellerApprovedAt).toBeNull();
        expect(user.subAgentRequestPending).toBe(false);
        expect(user.referralCommissionStoppedAt).toBeNull();

        await expect(subAgentService.rejectSubAgentRequest({
            requestId: request.id,
            reason: 'again',
            adminId: admin._id,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_REQUEST_ALREADY_REVIEWED' });
    });

    it('approved reseller cannot reapply and inactive/deleted users are blocked', async () => {
        const admin = await createAdmin();
        const target = await createGroup({ percentage: 40 });
        const { customer } = await createCustomerWithGroup();
        const request = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'approve',
            proofFile: await createProofFile(),
        });
        await subAgentService.approveSubAgentRequest({ requestId: request.id, groupId: target._id, adminId: admin._id });

        await expect(subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'again',
            proofFile: await createProofFile(),
        })).rejects.toMatchObject({ code: 'USER_ALREADY_RESELLER' });

        const { customer: pendingUser } = await createCustomerWithGroup({ status: USER_STATUS.PENDING });
        await expect(subAgentService.createSubAgentRequest({
            userId: pendingUser._id,
            notes: 'inactive',
            proofFile: await createProofFile(),
        })).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR' });
    });

    it('post-commit notification/test hook failure does not roll back approval or rejection', async () => {
        const admin = await createAdmin();
        const target = await createGroup({ percentage: 30 });
        const { customer } = await createCustomerWithGroup();
        const approvalRequest = await subAgentService.createSubAgentRequest({
            userId: customer._id,
            notes: 'post commit',
            proofFile: await createProofFile(),
        });

        await expect(subAgentService.approveSubAgentRequest({
            requestId: approvalRequest.id,
            groupId: target._id,
            adminId: admin._id,
            testHooks: { afterCommit: async () => { throw new Error('notify failed'); } },
        })).resolves.toMatchObject({ status: 'approved' });

        const { customer: rejectCustomer } = await createCustomerWithGroup();
        const rejectionRequest = await subAgentService.createSubAgentRequest({
            userId: rejectCustomer._id,
            notes: 'post reject',
            proofFile: await createProofFile(),
        });
        await expect(subAgentService.rejectSubAgentRequest({
            requestId: rejectionRequest.id,
            reason: 'No',
            adminId: admin._id,
            testHooks: { afterCommit: async () => { throw new Error('notify failed'); } },
        })).resolves.toMatchObject({ status: 'rejected' });
    });

    it('reseller approval stops future commissions from this user but preserves historical and own-referrer earnings', async () => {
        await createCurrency('USD', 1);
        const admin = await createAdmin();
        const resellerGroup = await createGroup({ percentage: 35 });
        const { referrer, referred } = await createReferralPair();

        const beforeApprovalDeposit = await createPendingDeposit(referred._id, { requestedAmount: 200, amountUsd: 200 });
        const beforeReviewedAt = new Date(Date.now() - 1000);
        beforeApprovalDeposit.status = DEPOSIT_STATUS.APPROVED;
        beforeApprovalDeposit.reviewedAt = beforeReviewedAt;
        await beforeApprovalDeposit.save();
        await referralCommissionService.processDepositReferralCommission({
            deposit: beforeApprovalDeposit,
            sourceAmount: 200,
            sourceCurrency: 'USD',
            sourceCompletedAt: beforeReviewedAt,
        });
        const historical = await ReferralCommission.findOne({ sourceId: beforeApprovalDeposit._id });
        expect(historical.status).toBe(REFERRAL_COMMISSION_STATUS.AVAILABLE);

        const request = await subAgentService.createSubAgentRequest({
            userId: referred._id,
            notes: 'become reseller',
            proofFile: await createProofFile(),
        });
        await subAgentService.approveSubAgentRequest({ requestId: request.id, groupId: resellerGroup._id, adminId: admin._id });
        const approvedUser = await User.findById(referred._id);
        const stopAt = approvedUser.referralCommissionStoppedAt;

        const exactDeposit = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        exactDeposit.status = DEPOSIT_STATUS.APPROVED;
        exactDeposit.reviewedAt = stopAt;
        await exactDeposit.save();
        const exactOutcome = await referralCommissionService.processDepositReferralCommission({
            deposit: exactDeposit,
            sourceAmount: 100,
            sourceCurrency: 'USD',
            sourceCompletedAt: stopAt,
        });
        expect(exactOutcome.outcome).toBe('STOPPED');

        const afterDeposit = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        const afterStop = new Date(stopAt.getTime() + 1);
        afterDeposit.status = DEPOSIT_STATUS.APPROVED;
        afterDeposit.reviewedAt = afterStop;
        await afterDeposit.save();
        const afterOutcome = await referralCommissionService.processDepositReferralCommission({
            deposit: afterDeposit,
            sourceAmount: 100,
            sourceCurrency: 'USD',
            sourceCompletedAt: afterStop,
        });
        expect(afterOutcome.outcome).toBe('STOPPED');

        const unchanged = await ReferralCommission.findById(historical._id);
        expect(unchanged.status).toBe(REFERRAL_COMMISSION_STATUS.AVAILABLE);

        const { customer: ownInvitee } = await createCustomerWithGroup({
            walletBalance: 0,
            currency: 'USD',
            referredBy: referred._id,
            referredAt: new Date(),
            referralEligibleUntil: calculateReferralEligibleUntil(new Date()),
        });
        const ownInviteeDeposit = await createPendingDeposit(ownInvitee._id, { requestedAmount: 300, amountUsd: 300 });
        ownInviteeDeposit.status = DEPOSIT_STATUS.APPROVED;
        ownInviteeDeposit.reviewedAt = new Date();
        await ownInviteeDeposit.save();
        const ownOutcome = await referralCommissionService.processDepositReferralCommission({
            deposit: ownInviteeDeposit,
            sourceAmount: 300,
            sourceCurrency: 'USD',
            sourceCompletedAt: ownInviteeDeposit.reviewedAt,
        });
        expect(ownOutcome.outcome).toBe('CREATED');
        expect(String(ownOutcome.commission.referrerUserId)).toBe(String(referred._id));
        expect(await ReferralCommission.countDocuments({ referrerUserId: referrer._id })).toBe(1);
    });

    it('pending, rejected, and reapplication states do not stop referral commissions', async () => {
        await createCurrency('USD', 1);
        const admin = await createAdmin();
        const { referred } = await createReferralPair();

        const pendingRequest = await subAgentService.createSubAgentRequest({
            userId: referred._id,
            notes: 'pending',
            proofFile: await createProofFile(),
        });
        const pendingDeposit = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        pendingDeposit.status = DEPOSIT_STATUS.APPROVED;
        pendingDeposit.reviewedAt = new Date();
        await pendingDeposit.save();
        expect((await referralCommissionService.processDepositReferralCommission({
            deposit: pendingDeposit,
            sourceAmount: 100,
            sourceCurrency: 'USD',
            sourceCompletedAt: pendingDeposit.reviewedAt,
        })).outcome).toBe('CREATED');

        await subAgentService.rejectSubAgentRequest({
            requestId: pendingRequest.id,
            reason: 'No',
            adminId: admin._id,
        });
        const userAfterReject = await User.findById(referred._id);
        expect(userAfterReject.referralCommissionStoppedAt).toBeNull();

        const reapply = await subAgentService.createSubAgentRequest({
            userId: referred._id,
            notes: 'reapply',
            proofFile: await createProofFile(),
        });
        expect(reapply.status).toBe('pending');
        const reapplyUser = await User.findById(referred._id);
        expect(reapplyUser.referralCommissionStoppedAt).toBeNull();
    });

    it('test-only hooks are not enabled outside test mode', async () => {
        const original = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            await expect(subAgentService.runTestHook(async () => {}, {}))
                .rejects.toThrow('only available in NODE_ENV=test');
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    it('audit script helper reports duplicate pending groups safely', async () => {
        const fakeModel = {
            aggregate: jest.fn().mockResolvedValue([{ groups: 1 }]),
        };

        const audit = await subAgentService.auditSubAgentRequestIndexes({ model: fakeModel });
        expect(audit.duplicatePendingUserGroups).toBe(1);
        expect(fakeModel.aggregate).toHaveBeenCalledWith([
            { $match: { status: SUB_AGENT_REQUEST_STATUS.PENDING } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $count: 'groups' },
        ]);
    });
});
