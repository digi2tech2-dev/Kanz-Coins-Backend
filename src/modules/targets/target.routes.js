'use strict';

const { Router } = require('express');
const targetCtrl = require('./target.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const { createUpload, validateUploadedFileSignature } = require('../../shared/middlewares/upload');
const { validateBody, validateQuery, schemas } = require('./target.validation');
const { BusinessRuleError } = require('../../shared/errors/AppError');

const targetUpload = createUpload('targets');

const router = Router();

const validateTargetProofSignature = async (req, _res, next) => {
    try {
        if (req.file) {
            await validateUploadedFileSignature(req.file, {
                code: 'SCREENSHOT_INVALID',
                message: 'Screenshot proof file is invalid.',
            });
        }
        next();
    } catch (err) {
        if (req.file?.path) {
            await require('fs/promises').unlink(req.file.path).catch(() => {});
        }
        next(err instanceof BusinessRuleError ? err : new BusinessRuleError('Screenshot proof file is invalid.', 'SCREENSHOT_INVALID'));
    }
};

router.use(authenticate, requireActiveUser);

router.get('/apps', targetCtrl.getActiveTargetApps);

router.post(
    '/',
    targetUpload.single('screenshotProof'),
    validateTargetProofSignature,
    validateBody(schemas.createTargetOrder),
    targetCtrl.createTargetOrder
);

router.get(
    '/',
    validateQuery(schemas.listMyTargetOrders),
    targetCtrl.getMyTargetOrders
);

module.exports = router;
