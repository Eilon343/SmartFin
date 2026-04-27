const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

router.post('/apple-pay', webhookController.handleApplePay);

module.exports = router;
