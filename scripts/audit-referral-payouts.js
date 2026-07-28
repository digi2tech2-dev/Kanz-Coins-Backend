'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../src/config/config');
const { auditReferralPayouts } = require('../src/modules/referralPayouts/referralPayout.service');

require('../src/modules/referralPayouts/referralPayout.model');
require('../src/modules/referrals/referralCommission.model');
require('../src/modules/wallet/walletTransaction.model');
require('../src/modules/users/user.model');

const main = async () => {
    await mongoose.connect(config.db.uri);
    const result = await auditReferralPayouts();

    console.log('Referral payout audit');
    console.log(`Locked commissions missing payout: ${result.lockedCommissionsMissingPayout}`);
    console.log(`Pending payout commission mismatches: ${result.pendingPayoutCommissionStateMismatches}`);
    console.log(`Paid payout commission mismatches: ${result.paidPayoutCommissionStateMismatches}`);
    console.log(`Rejected payouts with locked commissions: ${result.rejectedPayoutsWithLockedCommissions}`);
    console.log(`Wallet-paid payouts missing wallet transaction: ${result.walletPaidPayoutsMissingWalletTransaction}`);
    console.log(`Duplicate wallet payout references: ${result.duplicateWalletPayoutReferences}`);
    console.log(`Payout amount mismatches: ${result.payoutAmountMismatches}`);
    console.log(`Payout currency mismatches: ${result.payoutCurrencyMismatches}`);
    console.log('Read-only audit. No payout, commission, wallet, or user records were modified.');

    const totalIssues = Object.values(result).reduce((sum, value) => sum + Number(value || 0), 0);
    if (totalIssues > 0) {
        process.exitCode = 1;
    }
};

main()
    .catch((err) => {
        console.error('Referral payout audit failed:', err.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
