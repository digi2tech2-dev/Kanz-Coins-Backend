'use strict';

const mongoose = require('mongoose');

const oauthStateNonceSchema = new mongoose.Schema(
    {
        nonce: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 },
        },
    },
    {
        timestamps: true,
    }
);

const OAuthStateNonce = mongoose.model('OAuthStateNonce', oauthStateNonceSchema);

module.exports = OAuthStateNonce;
