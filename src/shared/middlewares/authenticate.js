'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { AuthenticationError } = require('../errors/AppError');
const catchAsync = require('../utils/catchAsync');
const { User, USER_STATUS } = require('../../modules/users/user.model');
const { ACTOR_ROLES } = require('../../modules/audit/audit.constants');

/**
 * Verifies the JWT in the Authorization header.
 * Attaches the full user document to req.user.
 *
 * Status enforcement:
 *   Only ACTIVE users pass this middleware.
 *   PENDING and REJECTED users receive 401 Unauthorized.
 *   (Business routes additionally use requireActiveUser for defence-in-depth.)
 */
const authenticate = catchAsync(async (req, res, next) => {
    // 1. Extract token
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        throw new AuthenticationError('No token provided. Please log in.');
    }

    // 2. Verify signature
    const decoded = jwt.verify(token, config.jwt.secret);

    // 2b. Reject 2FA-pending tokens — these must be consumed via /verify-2fa only
    if (decoded.purpose === '2fa-pending') {
        throw new AuthenticationError(
            '2FA verification required. Please complete login via the /verify-2fa endpoint.'
        );
    }

    // 3. Confirm user still exists
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
        throw new AuthenticationError('The user belonging to this token no longer exists.');
    }

    // 4. Status gate — only ACTIVE users can use authenticated routes
    if (currentUser.status !== USER_STATUS.ACTIVE) {
        // Use a generic message; do not expose the exact status to token holders
        throw new AuthenticationError(
            'Your account is not active. Contact an administrator.'
        );
    }

    if (currentUser.profileCompletionRequired) {
        throw new AuthenticationError(
            'Profile completion is required before accessing the platform.'
        );
    }

    // 5. Attach to request
    req.user = currentUser;

    /**
     * Audit context — available to any controller or service that receives `req`.
     * Services accept this as an optional parameter so they remain testable
     * without an HTTP request object.
     *
     * actorRole maps the Mongoose role string to the ACTOR_ROLES enum so we
     * have a single source of truth in audit.constants.js.
     */
    req.auditContext = {
        actorId: currentUser._id,
        actorRole: ACTOR_ROLES[currentUser.role] ?? currentUser.role,
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
    };

    next();
});

module.exports = authenticate;
