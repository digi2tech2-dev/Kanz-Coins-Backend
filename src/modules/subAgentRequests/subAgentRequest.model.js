'use strict';

const mongoose = require('mongoose');

const SUB_AGENT_REQUEST_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
});

const subAgentRequestSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'userId is required'],
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(SUB_AGENT_REQUEST_STATUS),
            default: SUB_AGENT_REQUEST_STATUS.PENDING,
            required: true,
        },

        notes: {
            type: String,
            trim: true,
            required: [true, 'notes are required'],
            minlength: [1, 'notes cannot be empty'],
            maxlength: [1000, 'notes cannot exceed 1000 characters'],
        },

        proofPath: {
            type: String,
            trim: true,
            required: [true, 'proofPath is required'],
        },
        proofFileName: {
            type: String,
            trim: true,
            required: [true, 'proofFileName is required'],
        },
        proofMimeType: {
            type: String,
            trim: true,
            required: [true, 'proofMimeType is required'],
        },
        proofSize: {
            type: Number,
            required: [true, 'proofSize is required'],
            min: [1, 'proofSize must be positive'],
        },

        requestedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },
        approvedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },

        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        rejectionReason: {
            type: String,
            trim: true,
            maxlength: [500, 'rejectionReason cannot exceed 500 characters'],
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

subAgentRequestSchema.index(
    { userId: 1, status: 1 },
    {
        unique: true,
        partialFilterExpression: { status: SUB_AGENT_REQUEST_STATUS.PENDING },
    }
);
subAgentRequestSchema.index({ status: 1, createdAt: -1 });
subAgentRequestSchema.index({ reviewedAt: -1 });

subAgentRequestSchema.set('toJSON', {
    transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret.__v;
        return ret;
    },
});

const SubAgentRequest = mongoose.model('SubAgentRequest', subAgentRequestSchema);

module.exports = {
    SubAgentRequest,
    SUB_AGENT_REQUEST_STATUS,
};
