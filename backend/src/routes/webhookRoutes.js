const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// The Apple Pay endpoint was removed once bank/card sync landed — an Apple Pay
// purchase is a credit-card purchase, so the card connection already imports it with
// the real merchant name, and logging both double-counted every transaction.
// Existing 'apple_pay' expenses are kept; the bot's /clean_applepay clears duplicates.
router.post('/telegram', webhookController.handleTelegram);

module.exports = router;
