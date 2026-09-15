const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pushController = require('../controllers/pushController');

router.post('/push/subscriptions', auth, pushController.subscribe);
router.delete('/push/subscriptions', pushController.unsubscribe);
router.post('/push/test', auth, pushController.sendTest);

module.exports = router;
